import { z } from 'zod'
import { buildScoringSystem, buildScoringUser, buildScoringUserBatch, SCORE_BATCH_JSON_SCHEMA, SCORE_JSON_SCHEMA } from '../shared/prompt.ts'
import { prescreen, PRESCREEN_VERSION } from '../shared/prescreen.ts'
import { computeScore, scoreLine, mergeReads, type Facts, type StoredFacts } from '../shared/scoring.ts'
import { runClaude } from './claude-cli.ts'
import { readCv, readCriteria, readAbout, profileHash } from './profile.ts'
import { env, SAMPLES_DIR } from '../config.ts'
import { log } from '../log.ts'
import fs from 'node:fs'
import path from 'node:path'
import { jobsNeedingPrescreen, jobsNeedingScore, jobsNeedingTopScore, setPrescreen, setScore, setScoreError, type JobRow } from '../db.ts'

const ScoreSchema = z.object({
  fit: z.number().min(0).max(100),
  role_fit: z.enum(['core', 'adjacent', 'bridge', 'mismatch']),
  seniority_fit: z.enum(['under', 'match', 'stretch', 'over']),
  people_manager: z.boolean().optional().default(false),
  workplace: z.enum(['remote', 'hybrid_home', 'hybrid_ankara', 'hybrid_other', 'onsite_home', 'onsite_ankara', 'onsite_other', 'unknown']).optional().default('unknown'),
  remote_verified: z.boolean().nullable(),
  workplace_detail: z.string().optional(),
  english: z.enum(['none', 'written', 'spoken_daily', 'unknown']).optional().default('unknown'),
  salary: z.string().optional(),
  salary_below_min: z.boolean().nullable().optional().default(null),
  employment: z.enum(['full_time', 'contract', 'part_time', 'freelance', 'internship', 'unknown']).optional().default('unknown'),
  agency: z.boolean().optional().default(false),
  shift: z.boolean().optional().default(false),
  ai_usage: z.boolean().optional().default(false),
  summary: z.string().min(1),
  reasons: z.object({ pros: z.array(z.string()), cons: z.array(z.string()) }),
  red_flags: z.array(z.string()),
})

/** Structured output sometimes returns a literal '""' or '-' for "empty"; treat those as null. */
function cleanText(v: string | undefined): string | null {
  const t = (v ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!t || /^(-|yok|none|null|n\/a|belirtilmemiş)$/i.test(t)) return null
  return t
}

export function rowToPromptJob(r: JobRow) {
  return {
    title: r.title,
    company: r.company,
    location: r.location,
    workplaceType: r.workplace_type,
    postedText: r.posted_text,
    applicantCount: r.applicant_count,
    descriptionMd: r.description_md,
    criteria: { seniority: r.criteria_seniority, employment: r.criteria_employment, func: r.criteria_function, industry: r.criteria_industry },
  }
}

/** Rule-based pass over every job that has text but no (or an outdated) pre_json. */
export function runPrescreen(): number {
  let n = 0
  for (const r of jobsNeedingPrescreen(PRESCREEN_VERSION)) {
    const p = prescreen({ title: r.title, descriptionMd: r.description_md, workplaceType: r.workplace_type, location: r.location })
    if (!p) continue
    setPrescreen(r.linkedin_job_id, p.verdict, p.score, p)
    n++
  }
  return n
}

/** The scoring system prompt: CV + criteria + (optional) about.md. */
let activeProfile: string | null = null
export function scoringSystem(): string {
  activeProfile = profileHash()
  return buildScoringSystem(readCv(), readCriteria(), readAbout())
}

export function batchSize(): number {
  return Math.max(1, Math.min(6, Number(env('SCORE_BATCH', '3')) || 1))
}

export function topModel(): string {
  return env('CLAUDE_MODEL_TOP', '') || env('CLAUDE_MODEL', 'sonnet')
}

type Applied = { ok: true } | { ok: false; reason: string; retryable: boolean }

/** Validate one model verdict and write it. `raw` is kept for the placeholder sample file. */
function applyScore(r: JobRow, data: unknown, model: string, raw: string, attempt: number, merge = false): Applied {
  const parsed = ScoreSchema.safeParse(data)
  if (!parsed.success) return { ok: false, reason: 'şema: ' + parsed.error.issues[0]?.message, retryable: true }
  const d = parsed.data
  // placeholder guard: a real evaluation never looks like "Test summary." / ["a","b"]
  const items = [...d.reasons.pros, ...d.reasons.cons]
  const tiny = items.filter((x) => x.trim().length <= 2).length
  const suspicious = d.summary.trim().length < 40 || /^test\b/i.test(d.summary.trim()) || (items.length > 0 && tiny >= Math.ceil(items.length / 2))
  if (suspicious) {
    try {
      fs.mkdirSync(SAMPLES_DIR, { recursive: true })
      fs.writeFileSync(path.join(SAMPLES_DIR, `claude-${r.linkedin_job_id}-${attempt}.json`), raw, 'utf8')
    } catch {
      /* ignore */
    }
    log.warn(`şüpheli LLM çıktısı (placeholder gibi), ham yanıt data/samples/claude-${r.linkedin_job_id}-${attempt}.json`, r.linkedin_job_id, JSON.stringify(d).slice(0, 160))
    return { ok: false, reason: 'şüpheli çıktı: özet/madde placeholder gibi (bkz. data/samples)', retryable: true }
  }
  const read: Facts = {
    fit: Math.round(d.fit),
    role_fit: d.role_fit,
    seniority_fit: d.seniority_fit,
    people_manager: d.people_manager,
    workplace: d.workplace,
    remote_verified: d.remote_verified,
    english: d.english,
    salary_below_min: d.salary_below_min,
    employment: d.employment,
    agency: d.agency,
    shift: d.shift,
    ai_usage: d.ai_usage,
  }
  // second read: merge with the earlier read(s) of this ad instead of replacing them
  let prior: Facts[] = []
  if (merge && r.facts_json) {
    try {
      const f = JSON.parse(r.facts_json) as StoredFacts
      prior = f.reads?.length ? f.reads : [f]
    } catch {
      prior = []
    }
  }
  let rule: { remote?: 'verified' | 'hybrid' | 'onsite' | 'unknown' } | null = null
  try {
    rule = r.pre_json ? (JSON.parse(r.pre_json) as { remote?: 'verified' | 'hybrid' | 'onsite' | 'unknown' }) : null
  } catch {
    rule = null
  }
  const facts = mergeReads([...prior.map(({ fit, role_fit, seniority_fit, people_manager, workplace, remote_verified, english, salary_below_min, employment, agency, shift, ai_usage }) => ({ fit, role_fit, seniority_fit, people_manager, workplace, remote_verified, english, salary_below_min, employment, agency, shift, ai_usage })), read], rule)
  const res = computeScore(facts, { location: r.location })
  setScore(r.linkedin_job_id, {
    score: res.score,
    remote_verified: facts.remote_verified,
    workplace: facts.workplace,
    seniority_fit: facts.seniority_fit,
    role_fit: facts.role_fit,
    summary: d.summary,
    pros: d.reasons.pros,
    cons: d.reasons.cons,
    red_flags: d.red_flags,
    workplace_detail: cleanText(d.workplace_detail),
    salary_note: cleanText(d.salary),
    english_level: facts.english,
    ai_usage: facts.ai_usage,
    model: 'claude-cli/' + model,
    profile: activeProfile,
    facts,
  })
  log.info(`skor ${res.score} (${model}${facts.reads && facts.reads.length > 1 ? `, ${facts.reads.length} okuma birleşti` : ''}) · ${scoreLine(res)} · ${r.title.slice(0, 50)} @ ${r.company ?? '?'}`)
  return { ok: true }
}

/**
 * Several ads per call (SCORE_BATCH, default 3): one process, one system prompt, N verdicts.
 * Ads the model skipped or answered badly fall back to scoreOne. Returns per-id success.
 */
export async function scoreBatch(rows: JobRow[], system: string, model = env('CLAUDE_MODEL', 'sonnet')): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (rows.length === 1) {
    out.set(rows[0].linkedin_job_id, await scoreOne(rows[0], system, model))
    return out
  }
  const user = buildScoringUserBatch(rows.map((r) => ({ id: r.linkedin_job_id, job: rowToPromptJob(r) })))
  log.info(`toplu skor başladı: ${rows.length} ilan → ${model} (${rows.map((r) => r.title.slice(0, 28)).join(' | ')})`)
  const res = await runClaude<{ results?: Array<{ id?: string } & Record<string, unknown>> }>({ system, user, schema: SCORE_BATCH_JSON_SCHEMA, tools: [], timeoutMs: 360_000, model, label: `${rows.length} ilan` })
  const byId = new Map<string, Record<string, unknown>>()
  if (!res.ok) log.warn('toplu skor hatası, tek tek denenecek:', res.error.slice(0, 120))
  else if (Array.isArray(res.data?.results)) for (const x of res.data.results) if (x && typeof x.id === 'string') byId.set(x.id.trim(), x)
  const leftovers: JobRow[] = []
  for (const r of rows) {
    const d = byId.get(r.linkedin_job_id)
    if (!d) {
      leftovers.push(r)
      continue
    }
    const a = applyScore(r, d, model, res.ok ? res.raw : '', 0)
    if (a.ok) out.set(r.linkedin_job_id, true)
    else leftovers.push(r)
  }
  if (leftovers.length && leftovers.length < rows.length) log.info(`toplu skor: ${leftovers.length}/${rows.length} ilan tek tek yeniden`)
  for (const r of leftovers) out.set(r.linkedin_job_id, await scoreOne(r, system, model))
  return out
}

export async function scoreOne(r: JobRow, system: string, model = env('CLAUDE_MODEL', 'sonnet'), merge = false): Promise<boolean> {
  const user = buildScoringUser(rowToPromptJob(r))
  for (let attempt = 0; attempt < 2; attempt++) {
    // attempt 0: structured output (--json-schema); attempt 1: plain JSON in the text, the prompt already demands JSON only.
    // Claude Code's structured mode occasionally fills the text fields with placeholders ('test', 'a', 'b'); the plain path does not.
    const res = await runClaude<unknown>({ system, user, schema: attempt === 0 ? SCORE_JSON_SCHEMA : undefined, tools: [], timeoutMs: 240_000, model, label: r.title.slice(0, 30) })
    if (!res.ok) {
      if (attempt === 1) {
        setScoreError(r.linkedin_job_id, res.error)
        log.warn('skor hatası', r.linkedin_job_id, res.error.slice(0, 120))
        return false
      }
      continue
    }
    const a = applyScore(r, res.data, model, res.raw, attempt, merge)
    if (a.ok) return true
    if (attempt === 1) {
      setScoreError(r.linkedin_job_id, a.reason)
      return false
    }
  }
  return false
}

export async function runScoring(limit: number, includeRejects = false, onProgress?: (done: number, total: number) => void): Promise<{ scored: number; failed: number }> {
  const scorer = env('SCORER', 'claude-cli')
  if (scorer === 'none') return { scored: 0, failed: 0 }
  const rows = jobsNeedingScore(limit || 100000, includeRejects)
  if (rows.length === 0) return { scored: 0, failed: 0 }
  log.info(`skorlama: ${rows.length} ilan (${scorer}, ${Math.max(1, Number(env('SCORE_CONCURRENCY', '3')))} paralel × ${batchSize()} ilan/çağrı)`)
  return scoreRows(rows, onProgress)
}

/** Score exactly these rows (batched, parallel). Existing scores are overwritten only on success. */
export async function scoreRows(rows: JobRow[], onProgress?: (done: number, total: number) => void): Promise<{ scored: number; failed: number }> {
  if (env('SCORER', 'claude-cli') === 'none' || rows.length === 0) return { scored: 0, failed: 0 }
  const system = scoringSystem()
  let scored = 0
  let failed = 0
  let done = 0
  let idx = 0
  const concurrency = Math.max(1, Number(env('SCORE_CONCURRENCY', '3')))
  const bs = batchSize()
  const worker = async () => {
    while (idx < rows.length) {
      const chunk = rows.slice(idx, idx + bs)
      idx += chunk.length
      const res = await scoreBatch(chunk, system)
      for (const ok of res.values()) ok ? scored++ : failed++
      done += chunk.length
      onProgress?.(done, rows.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker))
  return { scored, failed }
}

/**
 * Streaming scorer: keeps pulling jobs that have text but no score, in parallel with the
 * detail fetcher, until `isDone()` says the fetcher finished and the queue is empty.
 * Runs the rule engine before each pull so freshly fetched texts are pre-screened first.
 */
export async function runScoringWhile(
  isDone: () => boolean,
  budget: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ scored: number; failed: number }> {
  const scorer = env('SCORER', 'claude-cli')
  if (scorer === 'none' || budget === 0) return { scored: 0, failed: 0 }
  const system = scoringSystem()
  const concurrency = Math.max(1, Number(env('SCORE_CONCURRENCY', '3')))
  const bs = batchSize()
  const max = budget > 0 ? budget : 100000
  const inFlight = new Set<string>()
  let scored = 0
  let failed = 0
  let done = 0
  let started = 0
  const worker = async () => {
    for (;;) {
      if (started >= max) return
      runPrescreen()
      const chunk = jobsNeedingScore(concurrency * bs * 3, false)
        .filter((r) => !inFlight.has(r.linkedin_job_id))
        .slice(0, Math.min(bs, max - started))
      if (chunk.length === 0) {
        if (isDone()) return
        await new Promise((r) => setTimeout(r, 10_000))
        continue
      }
      for (const r of chunk) inFlight.add(r.linkedin_job_id)
      started += chunk.length
      const res = await scoreBatch(chunk, system)
      for (const r of chunk) inFlight.delete(r.linkedin_job_id)
      for (const ok of res.values()) ok ? scored++ : failed++
      done += chunk.length
      onProgress?.(done, Math.min(max, done + jobsNeedingScore(100000, false).length))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return { scored, failed }
}

/**
 * Second opinion with the stronger model: everything the first pass put at ≥ TOP_MIN_SCORE
 * is re-read by CLAUDE_MODEL_TOP and its verdict replaces the first one. No-op when the
 * top model equals the base model.
 */
export async function runTopScoring(limit: number, onProgress?: (done: number, total: number) => void): Promise<{ scored: number; failed: number }> {
  const top = topModel()
  if (env('SCORER', 'claude-cli') === 'none' || top === env('CLAUDE_MODEL', 'sonnet')) return { scored: 0, failed: 0 }
  // only the borderline band gets the second read, which is merged with the first (see mergeReads): clear yes
  // (> TOP_MAX_SCORE) stays; below TOP_MIN_SCORE only ads whose content fit is high but a fact pulled them down
  const min = Number(env('TOP_MIN_SCORE', '60'))
  const max = Number(env('TOP_MAX_SCORE', '84'))
  const rows = jobsNeedingTopScore(min, 'claude-cli/' + top, limit || 100000, max)
  if (rows.length === 0) return { scored: 0, failed: 0 }
  const system = scoringSystem()
  log.info(`ikinci görüş: ${rows.length} ilan (skor ${min}-${max}) → ${top}`)
  let scored = 0
  let failed = 0
  let done = 0
  let idx = 0
  const concurrency = Math.max(1, Math.min(3, Number(env('SCORE_CONCURRENCY', '3'))))
  const worker = async () => {
    while (idx < rows.length) {
      const r = rows[idx++]
      const ok = await scoreOne(r, system, top, true)
      ok ? scored++ : failed++
      done++
      onProgress?.(done, rows.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker))
  return { scored, failed }
}
