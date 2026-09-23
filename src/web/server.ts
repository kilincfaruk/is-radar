/** Local HTTP server: JSON API for the dashboard + static dashboard + scheduler. No auth (localhost only). */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_DIR, SEARCHES_FILE, env, loadSearches } from '../config.ts'
import YAML from 'yaml'
import type { RadarConfig } from '../shared/prescreen.ts'
import { allJobs, getJob, updateUserFields, deleteJob, stats, recentRuns, openDb, resetScore, setScore, setSetting, getSetting, type JobRow, nowIso, clearScoreErrors, jobsNeedingScore, closeStaleRuns, jobsChangedSince, staleScoredJobs, linkDuplicates } from '../db.ts'
import { collectRound, currentProgress, checkLiveness } from '../run.ts'
import { PoliteHttp } from '../http.ts'
import { topModel, runScoring, runPrescreen, scoreOne, scoringSystem, scoreRows } from '../pipeline/score.ts'
import { cvTipsOne, cvReview, readCvReview, criteriaReview, readCriteriaReview } from '../pipeline/cv.ts'
import { researchOne } from '../pipeline/research.ts'
import { coverLetterSystem } from '../shared/prompt.ts'
import { applyRadarConfig } from '../radar.ts'
import { buildReport, listReports, REPORTS_DIR } from '../report.ts'
import { computeScore, DEFAULT_WEIGHTS, type Facts } from '../shared/scoring.ts'
import { HOME_CITIES, THRESHOLDS } from '../shared/prescreen.ts'
import { runClaudeText } from '../pipeline/claude-cli.ts'
import { readCv, readAbout, profileHash } from '../pipeline/profile.ts'
import { log, logLines } from '../log.ts'

/** Row -> the v2 dashboard's Job shape (camelCase) + v3 extras. */
export function rowToJob(r: JobRow) {
  const pre = r.pre_json ? JSON.parse(r.pre_json) : null
  return {
    linkedinJobId: r.linkedin_job_id,
    url: r.url,
    title: r.title,
    company: r.company,
    companyUrl: r.company_url,
    location: r.location,
    workplaceType: r.workplace_type,
    postedText: r.posted_text,
    postedAt: r.posted_at,
    easyApply: !!r.easy_apply,
    applicantCount: r.applicant_count,
    descriptionMd: r.description_md,
    descriptionFetchedAt: r.description_fetched_at && !/^(failed|skipped):/.test(r.description_fetched_at) ? r.description_fetched_at : null,
    descriptionSkipped: r.description_fetched_at && r.description_fetched_at.startsWith('skipped:') ? r.description_fetched_at.slice(8) : null,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    seenCount: r.seen_count,
    score: r.score,
    remoteVerified: r.remote_verified === null ? null : !!r.remote_verified,
    seniorityFit: r.seniority_fit,
    roleFit: r.role_fit,
    summary: r.summary,
    pros: JSON.parse(r.pros_json || '[]'),
    cons: JSON.parse(r.cons_json || '[]'),
    redFlags: JSON.parse(r.red_flags_json || '[]'),
    scoredAt: r.scored_at,
    scoreModel: r.score_model,
    scoreError: r.score_error,
    status: r.status,
    notes: r.notes,
    appliedAt: r.applied_at,
    manualExportedAt: r.manual_exported_at,
    postedAtSource: r.posted_at ? 'exact' : null,
    // v3 extras
    source: r.source,
    searchKeywords: r.search_keywords,
    criteria: { seniority: r.criteria_seniority, employment: r.criteria_employment, func: r.criteria_function, industry: r.criteria_industry },
    workplaceLlm: r.workplace_llm,
    workplaceDetail: r.workplace_detail ?? null,
    salaryNote: r.salary_note ?? null,
    englishLevel: r.english_level ?? null,
    aiUsage: r.ai_usage === null || r.ai_usage === undefined ? null : !!r.ai_usage,
    pre,
    companyResearchMd: r.company_research_md,
    companyResearchAt: r.company_research_at,
    cvTipsMd: r.cv_tips_md ?? null,
    cvTipsAt: r.cv_tips_at ?? null,
    decisionReason: r.decision_reason ?? null,
    viewedAt: r.viewed_at ?? null,
    closedAt: r.closed_at ?? null,
    closedReason: r.closed_reason ?? null,
    checkedAt: r.checked_at ?? null,
    scoreProfile: r.score_profile ?? null,
    decidedAt: r.decided_at ?? null,
    dupOf: r.dup_of ?? null,
    updatedAt: r.updated_at ?? null,
    facts: r.facts_json ? JSON.parse(r.facts_json) : null,
    scoreParts: r.facts_json ? computeScore(JSON.parse(r.facts_json) as Facts, { location: r.location }).parts : null,
  }
}

type Task = { kind: string; startedAt: string; done: number; total: number; note?: string }
/** One polite client for manual checks from the dashboard (keeps the LinkedIn pacing even outside a round). */
const liveHttp = new PoliteHttp({ minGapMs: 3000, maxGapMs: 6000 })
let task: Task | null = null
let collecting = false

async function runTask<T>(kind: string, total: number, fn: (progress: (done: number, total?: number) => void) => Promise<T>): Promise<void> {
  if (task) throw new Error(`zaten çalışan bir iş var: ${task.kind}`)
  task = { kind, startedAt: nowIso(), done: 0, total }
  const t = task
  void fn((done, tot) => {
    t.done = done
    if (tot !== undefined) t.total = tot
  })
    .catch((e) => {
      t.note = e instanceof Error ? e.message : String(e)
      log.error(kind, t.note)
    })
    .finally(() => {
      if (task === t) task = null
    })
}

/**
 * DNS-rebinding / CSRF guard. The API has no auth because it only listens on 127.0.0.1, but a web page in the
 * same browser can still send requests to it: a rebinding attack arrives with a foreign Host header, a
 * cross-site form/fetch arrives with a foreign Origin (or Sec-Fetch-Site: cross-site). Both are refused.
 */
export function requestAllowed(h: { host?: string; origin?: string; 'sec-fetch-site'?: string }, method: string, port: number): boolean {
  const okHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
  if (!h.host || !okHosts.has(h.host.toLowerCase())) return false
  if (method === 'GET' || method === 'HEAD') return true
  if (h['sec-fetch-site'] && !['same-origin', 'none'].includes(h['sec-fetch-site'])) return false
  if (h.origin && !okHosts.has(h.origin.toLowerCase().replace(/^https?:\/\//, ''))) return false
  return true
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const s = Buffer.concat(chunks).toString('utf8')
  return s ? JSON.parse(s) : {}
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): void {
  let p = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath))
  if (!p.startsWith(PUBLIC_DIR)) return void json(res, 403, { error: 'forbidden' })
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(PUBLIC_DIR, 'index.html')
  if (!fs.existsSync(p)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return void res.end('<meta charset="utf-8"><h1>İş Radar collector çalışıyor</h1><p>Dashboard build edilmemiş: <code>npm run build</code>. API: <a href="/api/stats">/api/stats</a></p>')
  }
  const ext = path.extname(p)
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' })
  fs.createReadStream(p).pipe(res)
}

const USER_FIELDS = new Set(['status', 'notes', 'appliedAt', 'manualExportedAt', 'decisionReason', 'viewedAt'])
const SCORE_FIELDS = new Set(['score', 'remoteVerified', 'seniorityFit', 'roleFit', 'summary', 'pros', 'cons', 'redFlags', 'scoredAt', 'scoreModel', 'scoreError'])

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const m = req.method || 'GET'
  const p = url.pathname
  const id = (re: RegExp) => p.match(re)?.[1]

  if (m === 'GET' && p === '/api/jobs') {
    // ?since=<iso>: delta sync. `now` is taken before the query and handed back minus a small margin, so a write
    // landing in the same millisecond is sent twice rather than never (the client merges by id).
    const since = url.searchParams.get('since')
    if (since === null) return json(res, 200, allJobs().map(rowToJob))
    const now = new Date(Date.now() - 2000).toISOString()
    const rows = since ? jobsChangedSince(since) : allJobs()
    return json(res, 200, { now, full: !since, jobs: rows.map(rowToJob) })
  }
  if (m === 'GET' && p === '/api/stats') {
    const s = stats()
    return json(res, 200, { ...s, profileHash: profileHash(), task, progress: currentProgress(), collecting, schedule: scheduleInfo(s.lastRun?.finished_at ?? null) })
  }
  if (m === 'GET' && p === '/api/runs') return json(res, 200, recentRuns(30))
  if (m === 'GET' && p === '/api/report') {
    // fresh report of the current state; ?download=1 saves it as a file instead of opening it
    const r = buildReport()
    const name = `is-radar-${new Date().toISOString().slice(0, 10)}.html`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(url.searchParams.get('download') ? { 'content-disposition': `attachment; filename="${name}"` } : {}) })
    return void res.end(r.html)
  }
  if (m === 'GET' && p === '/api/reports') return json(res, 200, listReports())
  const repName = id(/^\/api\/reports\/((?:is-radar-[\d-]+|latest)\.html)$/)
  if (m === 'GET' && repName) {
    const f = path.join(REPORTS_DIR, repName)
    if (!fs.existsSync(f)) return json(res, 404, { error: 'Bu raporu bulamadım' })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(url.searchParams.get('download') ? { 'content-disposition': `attachment; filename="${repName}"` } : {}) })
    return void fs.createReadStream(f).pipe(res)
  }
  if (m === 'GET' && p === '/api/log') return json(res, 200, logLines(Number(url.searchParams.get('since') || 0), Number(url.searchParams.get('limit') || 300)))
  if (m === 'GET' && p === '/api/settings') {
    const cfg = loadSearches()
    return json(res, 200, {
      searchesYaml: fs.readFileSync(SEARCHES_FILE, 'utf8'),
      searchCount: cfg.searches.length,
      scorer: env('SCORER', 'claude-cli'),
      model: env('CLAUDE_MODEL', 'sonnet'),
      modelTop: env('CLAUDE_MODEL_TOP', ''),
      topMinScore: Number(env('TOP_MIN_SCORE', '60')),
      researchMinScore: Number(env('RESEARCH_MIN_SCORE', '70')),
      notifyMinScore: Number(env('NOTIFY_MIN_SCORE', '80')),
      telegram: !!env('TELEGRAM_BOT_TOKEN'),
      schedule: cfg.schedule,
      radar: cfg.radar,
      homeCities: [...HOME_CITIES],
      thresholds: { ...THRESHOLDS },
      scoreThreshold: Number(getSetting('scoreThreshold') ?? '70'),
    })
  }
  if (m === 'PUT' && p === '/api/settings') {
    const b = (await readBody(req)) as { searchesYaml?: string; scoreThreshold?: number; radar?: RadarConfig }
    if (b.radar && typeof b.radar === 'object') {
      // form-based edit: patch only the given radar keys, keep the file's comments and everything else
      const prev = fs.readFileSync(SEARCHES_FILE, 'utf8')
      const doc = YAML.parseDocument(prev)
      const r = b.radar
      if (r.home_cities) doc.setIn(['radar', 'home_cities'], r.home_cities.map((c) => String(c).trim()).filter(Boolean))
      if (typeof r.accept_hybrid === 'boolean') doc.setIn(['radar', 'accept_hybrid'], r.accept_hybrid)
      if (r.thresholds) {
        if (r.thresholds.review !== undefined) doc.setIn(['radar', 'thresholds', 'review'], Number(r.thresholds.review))
        if (r.thresholds.candidate !== undefined) doc.setIn(['radar', 'thresholds', 'candidate'], Number(r.thresholds.candidate))
      }
      if (r.score_weights && typeof r.score_weights === 'object') {
        // only keys that differ from the built-in default are written, the yaml stays short
        for (const [k, v] of Object.entries(r.score_weights)) {
          if (!(k in DEFAULT_WEIGHTS) || !Number.isFinite(Number(v))) continue
          if (Number(v) === DEFAULT_WEIGHTS[k as keyof typeof DEFAULT_WEIGHTS]) doc.deleteIn(['radar', 'score_weights', k])
          else doc.setIn(['radar', 'score_weights', k], Number(v))
        }
        const sw = doc.getIn(['radar', 'score_weights']) as { items?: unknown[] } | undefined
        if (sw && Array.isArray(sw.items) && sw.items.length === 0) doc.deleteIn(['radar', 'score_weights'])
      }
      if (r.roles) {
        for (const tier of ['core', 'adjacent', 'bridge', 'mismatch'] as const) {
          const v = r.roles[tier]
          if (v === undefined) continue
          if (v.length) doc.setIn(['radar', 'roles', tier], v)
          else doc.deleteIn(['radar', 'roles', tier])
        }
      }
      fs.writeFileSync(SEARCHES_FILE, doc.toString(), 'utf8')
      try {
        applyRadarConfig(loadSearches())
      } catch (e) {
        fs.writeFileSync(SEARCHES_FILE, prev, 'utf8')
        return json(res, 400, { error: `Radar ayarında bir sorun var: ${e instanceof Error ? e.message : String(e)}` })
      }
      runPrescreen()
    }
    if (typeof b.searchesYaml === 'string') {
      const prev = fs.readFileSync(SEARCHES_FILE, 'utf8')
      fs.writeFileSync(SEARCHES_FILE, b.searchesYaml, 'utf8')
      try {
        applyRadarConfig(loadSearches()) // validate + apply radar block (cities/roles)
      } catch (e) {
        fs.writeFileSync(SEARCHES_FILE, prev, 'utf8')
        return json(res, 400, { error: `searches.yaml’ı okuyamadım: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    if (typeof b.scoreThreshold === 'number') setSetting('scoreThreshold', String(b.scoreThreshold))
    return json(res, 200, { ok: true })
  }
  const jid = id(/^\/api\/jobs\/([\w-]+)$/)
  if (jid && m === 'GET') {
    const r = getJob(jid)
    return r ? json(res, 200, rowToJob(r)) : json(res, 404, { error: 'Bu ilanı bulamadım' })
  }
  if (jid && m === 'PATCH') {
    const b = (await readBody(req)) as Record<string, unknown>
    const cur = getJob(jid)
    if (!cur) return json(res, 404, { error: 'Bu ilanı bulamadım' })
    const uf: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(b)) {
      if (USER_FIELDS.has(k)) uf[{ status: 'status', notes: 'notes', appliedAt: 'applied_at', manualExportedAt: 'manual_exported_at', decisionReason: 'decision_reason', viewedAt: 'viewed_at' }[k]!] = v as string | null
    }
    // decision time: when the status leaves 'new' (or changes between decisions); back to 'new' clears it
    if (typeof uf.status === 'string' && uf.status !== cur.status) uf.decided_at = uf.status === 'new' ? null : nowIso()
    if (Object.keys(uf).length) updateUserFields(jid, uf)
    if ([...SCORE_FIELDS].some((k) => k in b)) {
      if (b.score === null && b.scoredAt === null) resetScore(jid)
      else if (typeof b.score === 'number') {
        setScore(jid, {
          score: b.score,
          remote_verified: (b.remoteVerified as boolean | null) ?? null,
          workplace: null,
          seniority_fit: String(b.seniorityFit ?? ''),
          role_fit: String(b.roleFit ?? ''),
          summary: String(b.summary ?? ''),
          pros: (b.pros as string[]) ?? [],
          cons: (b.cons as string[]) ?? [],
          red_flags: (b.redFlags as string[]) ?? [],
          model: String(b.scoreModel ?? 'manual'),
        })
      }
    }
    return json(res, 200, rowToJob(getJob(jid)!))
  }
  if (jid && m === 'DELETE') {
    deleteJob(jid)
    return json(res, 200, { ok: true })
  }
  const rescoreId = id(/^\/api\/jobs\/([\w-]+)\/rescore$/)
  if (rescoreId && m === 'POST') {
    const r = getJob(rescoreId)
    if (!r) return json(res, 404, { error: 'Bu ilanı bulamadım' })
    resetScore(rescoreId)
    await runTask('rescore', 1, async (progress) => {
      await scoreOne(getJob(rescoreId)!, scoringSystem())
      progress(1)
    })
    return json(res, 202, { ok: true })
  }
  const researchId = id(/^\/api\/jobs\/([\w-]+)\/research$/)
  if (researchId && m === 'POST') {
    const r = getJob(researchId)
    if (!r) return json(res, 404, { error: 'Bu ilanı bulamadım' })
    await runTask('research', 1, async (progress) => {
      await researchOne(r)
      progress(1)
    })
    return json(res, 202, { ok: true })
  }
  const letterId = id(/^\/api\/jobs\/([\w-]+)\/cover-letter$/)
  if (letterId && m === 'POST') {
    const r = getJob(letterId)
    if (!r || !r.description_md) return json(res, 404, { error: 'Bu ilanı ya da metnini bulamadım' })
    const about = readAbout()
    const user = `=== ADAYIN CV'Sİ ===\n${readCv().trim()}${about ? `\n\n=== ADAY HAKKINDA (kendi sözleriyle) ===\n${about.trim()}` : ''}\n\n=== İLAN ===\nBaşlık: ${r.title}\nŞirket: ${r.company ?? '(bilinmiyor)'}\nLokasyon: ${r.location ?? '(bilinmiyor)'} · ${r.workplace_type}\n\n${r.description_md.trim()}\n\nBu ilan için ön yazıyı yaz; JSON içinde text alanına koy.`
    const out = await runClaudeText({ system: coverLetterSystem(), user, tools: [], timeoutMs: 240_000, model: topModel() })
    return out.ok ? json(res, 200, { text: out.text }) : json(res, 500, { error: out.error })
  }
  const checkId = id(/^\/api\/jobs\/([\w-]+)\/check$/)
  if (checkId && m === 'POST') {
    const r = getJob(checkId)
    if (!r) return json(res, 404, { error: 'Bu ilanı bulamadım' })
    if (r.source !== 'linkedin-guest') return json(res, 200, { closed: !!r.closed_at, reason: r.closed_at ? r.closed_reason ?? 'kapalı' : 'şirket panosu her turda kontrol ediliyor', job: rowToJob(r) })
    if (collecting) return json(res, 409, { error: 'Şu an tur dönüyor, LinkedIn kuyruğu dolu. Tur bitince bir daha dene.' })
    const out = await checkLiveness(liveHttp, checkId)
    return json(res, 200, { ...out, job: rowToJob(getJob(checkId)!) })
  }
  const tipsId = id(/^\/api\/jobs\/([\w-]+)\/cv-tips$/)
  if (tipsId && m === 'POST') {
    const r = getJob(tipsId)
    if (!r || !r.description_md) return json(res, 404, { error: 'Bu ilanı ya da metnini bulamadım' })
    const out = await cvTipsOne(r)
    return out.ok ? json(res, 200, { md: out.md, job: rowToJob(getJob(tipsId)!) }) : json(res, 500, { error: out.error })
  }
  if (m === 'GET' && p === '/api/cv-review') return json(res, 200, { md: readCvReview() })
  if (m === 'GET' && p === '/api/criteria-review') return json(res, 200, { md: readCriteriaReview() })
  if (m === 'POST' && p === '/api/criteria-review') {
    if (task) return json(res, 409, { error: `Elimde zaten bir iş var (${task.kind}), önce o bitsin.` })
    await runTask('kriter incelemesi', 1, async (progress) => {
      const out = await criteriaReview()
      if (!out.ok) throw new Error(out.error)
      progress(1)
    })
    return json(res, 202, { ok: true })
  }
  if (m === 'POST' && p === '/api/cv-review') {
    if (task) return json(res, 409, { error: `Elimde zaten bir iş var (${task.kind}), önce o bitsin.` })
    const b = (await readBody(req).catch(() => ({}))) as { limit?: number; minScore?: number }
    await runTask('cv incelemesi', 1, async (progress) => {
      const out = await cvReview(b.limit ?? 15, b.minScore ?? 0)
      if (!out.ok) throw new Error(out.error)
      progress(1)
    })
    return json(res, 202, { ok: true })
  }
  if (m === 'POST' && p === '/api/score') {
    const b = (await readBody(req)) as { limit?: number; includeRejects?: boolean; retryErrors?: boolean }
    if (task) return json(res, 409, { error: `Elimde zaten bir iş var (${task.kind}), önce o bitsin.` })
    runPrescreen()
    const retried = b.retryErrors ? clearScoreErrors() : 0
    const limit = b.limit ?? 40
    const queued = jobsNeedingScore(limit, !!b.includeRejects).length
    if (queued === 0) {
      const errors = (openDb().prepare('SELECT COUNT(*) n FROM jobs WHERE score_error IS NOT NULL AND scored_at IS NULL').get() as { n: number }).n
      const rejects = (openDb().prepare("SELECT COUNT(*) n FROM jobs WHERE pre_verdict = 'reject' AND scored_at IS NULL AND description_md IS NOT NULL").get() as { n: number }).n
      return json(res, 200, { ok: false, queued: 0, errors, rejects, retried })
    }
    await runTask('score', queued, (progress) => runScoring(limit, !!b.includeRejects, progress))
    return json(res, 202, { ok: true, queued, retried })
  }
  if (m === 'POST' && p === '/api/run') {
    if (collecting) return json(res, 409, { error: 'Zaten bir tur dönüyor.' })
    const b = (await readBody(req).catch(() => ({}))) as { mode?: 'full' | 'incremental' }
    collecting = true
    void collectRound({ score: env('SCORER', 'claude-cli') !== 'none', mode: b.mode === 'full' || b.mode === 'incremental' ? b.mode : undefined })
      .catch((e) => log.error('tur', e instanceof Error ? e.message : e))
      .finally(() => (collecting = false))
    return json(res, 202, { ok: true })
  }
  if (m === 'POST' && p === '/api/rescore-stale') {
    // scores made under an older cv/criteria/about: re-read the ones that matter (near or above the threshold)
    if (task) return json(res, 409, { error: `Elimde zaten bir iş var (${task.kind}), önce o bitsin.` })
    const b = (await readBody(req).catch(() => ({}))) as { minScore?: number; limit?: number }
    const prof = profileHash()
    if (!prof) return json(res, 400, { error: 'Profil dosyalarını okuyamadım.' })
    const minScore = b.minScore ?? Math.max(0, Number(getSetting('scoreThreshold') ?? '70') - 10)
    const rows = staleScoredJobs(prof, minScore, b.limit ?? 40)
    if (!rows.length) return json(res, 200, { ok: false, queued: 0 })
    log.info(`eski profille skorlanmış ${rows.length} ilan yeniden skorlanıyor (skor ≥ ${minScore})`)
    await runTask('yeniden skor', rows.length, (progress) => scoreRows(rows, progress))
    return json(res, 202, { ok: true, queued: rows.length })
  }
  if (m === 'POST' && p === '/api/prescreen') {
    return json(res, 200, { updated: runPrescreen() })
  }
  json(res, 404, { error: 'Böyle bir API yolu yok.' })
}

/** What the scheduler will do next, for the dashboard: interval, active hours, next tick (null while running / outside hours). */
function scheduleInfo(lastFinished: string | null): { everyMinutes: number; activeHours: [number, number]; nextRunAt: string | null } {
  let cfg
  try {
    cfg = loadSearches().schedule
  } catch {
    return { everyMinutes: 0, activeHours: [0, 24], nextRunAt: null }
  }
  const everyMs = Math.max(30, cfg.every_minutes) * 60_000
  const [h0, h1] = cfg.active_hours
  let t = Math.max(Date.now(), (lastFinished ? Date.parse(lastFinished) : 0) + everyMs)
  // push into the active window (local time), at most a day ahead
  for (let i = 0; i < 48; i++) {
    const d = new Date(t)
    const h = d.getHours()
    if (h >= h0 && h < h1) break
    d.setMinutes(0, 0, 0)
    d.setHours(h < h0 ? h0 : 24 + h0)
    t = d.getTime()
  }
  return { everyMinutes: cfg.every_minutes, activeHours: [h0, h1], nextRunAt: collecting ? null : new Date(t).toISOString() }
}

export async function serve(): Promise<void> {
  openDb()
  applyRadarConfig(loadSearches())
  const stale = closeStaleRuns()
  if (stale) log.info(`${stale} yarım tur kapatıldı (önceki süreç tur ortasında kapanmış)`)
  const dups = linkDuplicates()
  if (dups) log.info(`tekrar yayın: ${dups} ilan eski ilanla eşleşti`)
  const port = Number(env('PORT', '4545'))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname.startsWith('/api/')) {
      if (!requestAllowed(req.headers as Record<string, string>, req.method || 'GET', port)) return json(res, 403, { error: 'Sadece bu makinedeki dashboard’a cevap veriyorum.' })
      handleApi(req, res, url).catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }))
      return
    }
    serveStatic(req, res, url.pathname)
  })
  server.listen(port, '127.0.0.1', () => {
    const idx = path.join(PUBLIC_DIR, 'index.html')
    const built = fs.existsSync(idx) ? fs.statSync(idx).mtime.toISOString().slice(0, 16).replace('T', ' ') : 'YOK (`npm run build` çalıştır)'
    log.info(`dashboard: http://localhost:${port} · build: ${built}`)
  })

  // scheduler: interval and active hours are read on every tick, so a change in Ayarlar applies without a restart
  let sched = loadSearches().schedule
  const tick = async () => {
    if (collecting) return
    try {
      sched = loadSearches().schedule
    } catch {
      /* keep the last valid schedule while the yaml is being edited */
    }
    const everyMs = Math.max(30, sched.every_minutes) * 60_000
    const [h0, h1] = sched.active_hours
    const last = recentRuns(1)[0]
    const lastEnd = last?.finished_at ? Date.parse(last.finished_at) : 0
    const hour = new Date().getHours()
    if (hour < h0 || hour >= h1) return
    if (Date.now() - lastEnd < everyMs) return
    collecting = true
    try {
      await collectRound({ score: env('SCORER', 'claude-cli') !== 'none' })
    } catch (e) {
      log.error('tur', e instanceof Error ? e.message : e)
    } finally {
      collecting = false
    }
  }
  setInterval(tick, 60_000)
  setTimeout(tick, 5_000)
  log.info(`zamanlayıcı: her ${sched.every_minutes} dk, ${sched.active_hours[0]}:00-${sched.active_hours[1]}:00 arası`)
}
