/**
 * Deterministic scoring. The LLM reads the ad and returns facts (workplace, seniority, english, salary, employment,
 * agency/shift) plus one judgement: `fit`, how well the role's content matches the candidate. Everything that is a
 * rule (remote bonus, seniority penalty, caps…) is applied here, so the same facts always give the same score, the
 * breakdown is visible, and changing a weight re-computes stored scores without another LLM call.
 */
import { HOME_CITIES } from './prescreen.ts'
import type { RoleFit, SeniorityFit } from './types.ts'

export type Workplace = 'remote' | 'hybrid_ankara' | 'hybrid_home' | 'hybrid_other' | 'onsite_ankara' | 'onsite_home' | 'onsite_other' | 'unknown'
export type English = 'none' | 'written' | 'spoken_daily' | 'unknown'
export type Employment = 'full_time' | 'contract' | 'part_time' | 'freelance' | 'internship' | 'unknown'

export type Facts = {
  /** 0-100: role content × candidate background/goals × ad/company quality. Excludes everything below. */
  fit: number
  role_fit: RoleFit
  seniority_fit: SeniorityFit
  people_manager: boolean
  workplace: Workplace
  remote_verified: boolean | null
  english: English
  salary_below_min: boolean | null
  employment: Employment
  agency: boolean
  shift: boolean
  ai_usage: boolean
}

export const DEFAULT_WEIGHTS = {
  remote: 10,
  hybrid_primary: 5,
  hybrid_home: 3,
  hybrid_other: -15,
  /** full office in an accepted city: no bonus, capped unless the fit is outstanding */
  onsite_home_cap: 70,
  onsite_home_cap_unless_fit: 85,
  onsite_other_cap: 25,
  /** text silent on workplace: location is only the country (likely remote) vs a city (likely office) */
  unknown_country_cap: 70,
  unknown_city_cap: 60,
  under: -5,
  stretch: -10,
  over: -20,
  people_manager_cap: 40,
  english_spoken: -12,
  salary_below: -15,
  contract: -5,
  part_time_cap: 25,
  internship_cap: 25,
  mismatch_cap: 35,
  agency: -10,
  shift: -10,
  ai_usage: 3,
}
export type ScoreWeights = typeof DEFAULT_WEIGHTS

/** Live weights; searches.yaml → radar.score_weights overrides any key. */
export const WEIGHTS: ScoreWeights = { ...DEFAULT_WEIGHTS }
export function configureScoring(over: Partial<Record<keyof ScoreWeights, number>> | null | undefined): void {
  Object.assign(WEIGHTS, DEFAULT_WEIGHTS)
  for (const [k, v] of Object.entries(over ?? {})) if (k in WEIGHTS && Number.isFinite(Number(v))) WEIGHTS[k as keyof ScoreWeights] = Number(v)
}

export type ScorePart = { label: string; kind: 'base' | 'delta' | 'cap'; value: number; applied: boolean }
export type ScoreResult = { score: number; parts: ScorePart[] }

function countryOnly(location: string | null | undefined): boolean {
  const l = (location ?? '').toLocaleLowerCase('tr-TR').trim()
  return !l || /^(türkiye|turkey|tr)$/.test(l)
}

export function computeScore(f: Facts, ctx: { location?: string | null } = {}, w: ScoreWeights = WEIGHTS): ScoreResult {
  const primary = HOME_CITIES[0] ?? 'Ankara'
  const fit = Math.max(0, Math.min(100, Math.round(Number(f.fit) || 0)))
  const parts: ScorePart[] = [{ label: 'içerik uyumu', kind: 'base', value: fit, applied: true }]
  const caps: Array<[string, number]> = []
  const delta = (label: string, v: number) => v !== 0 && parts.push({ label, kind: 'delta', value: v, applied: true })

  switch (f.workplace) {
    case 'remote':
      if (f.agency || f.shift) delta('remote (ajans/vardiya: bonus yok)', 0)
      else delta('tam remote', w.remote)
      break
    case 'hybrid_ankara':
      delta(`hibrit · ${primary}`, w.hybrid_primary)
      break
    case 'hybrid_home':
      delta('hibrit · kabul edilen şehir', w.hybrid_home)
      break
    case 'hybrid_other':
      delta('hibrit · başka şehir (taşınma)', w.hybrid_other)
      break
    case 'onsite_ankara':
    case 'onsite_home':
      if (fit < w.onsite_home_cap_unless_fit) caps.push(['tam ofis', w.onsite_home_cap])
      break
    case 'onsite_other':
      caps.push(['başka şehirde tam ofis', w.onsite_other_cap])
      break
    default:
      caps.push(countryOnly(ctx.location) ? ['çalışma şekli yazmıyor (lokasyon ülke)', w.unknown_country_cap] : ['çalışma şekli yazmıyor (lokasyon şehir)', w.unknown_city_cap])
  }
  if (f.seniority_fit === 'under') delta('kıdem altında', w.under)
  if (f.seniority_fit === 'stretch') delta('kıdem biraz üstünde', w.stretch)
  if (f.seniority_fit === 'over') delta('kıdem fazla üstünde', w.over)
  if (f.people_manager) caps.push(['ekip yöneticiliği', w.people_manager_cap])
  if (f.english === 'spoken_daily') delta('günlük sözlü İngilizce', w.english_spoken)
  if (f.salary_below_min) delta('maaş alt sınırın altında', w.salary_below)
  if (f.employment === 'contract') delta('sözleşmeli', w.contract)
  if (f.employment === 'part_time' || f.employment === 'freelance') caps.push(['yarı zamanlı / freelance', w.part_time_cap])
  if (f.employment === 'internship') caps.push(['staj', w.internship_cap])
  if (f.role_fit === 'mismatch') caps.push(['rol uyumsuz', w.mismatch_cap])
  if (f.agency) delta('ajans üzerinden istihdam', w.agency)
  if (f.shift) delta('vardiya / nöbet', w.shift)
  if (f.ai_usage) delta('AI araçları aktif', w.ai_usage)

  let score = parts.reduce((a, p) => a + (p.kind === 'delta' ? p.value : p.kind === 'base' ? p.value : 0), 0)
  // the tightest cap wins; the others are shown but marked as not applied
  const tight = caps.length ? Math.min(...caps.map((c) => c[1])) : Infinity
  for (const [label, cap] of caps) {
    const applied = cap === tight && score > cap
    parts.push({ label, kind: 'cap', value: cap, applied })
  }
  if (score > tight) score = tight
  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, parts }
}

/** "78 içerik · +10 tam remote · −10 kıdem · ≤70 tam ofis" */
export function scoreLine(r: ScoreResult): string {
  return r.parts
    .filter((p) => p.applied)
    .map((p) => (p.kind === 'base' ? `${p.value} ${p.label}` : p.kind === 'cap' ? `≤${p.value} ${p.label}` : `${p.value > 0 ? '+' : '−'}${Math.abs(p.value)} ${p.label}`))
    .join(' · ')
}

/** A stored facts record may carry the individual reads it was aggregated from. */
export type StoredFacts = Facts & { reads?: Facts[] }

type RuleHint = { remote?: 'verified' | 'hybrid' | 'onsite' | 'unknown' } | null | undefined

function workplaceClass(w: Workplace): string {
  return w === 'remote' ? 'verified' : w.startsWith('hybrid') ? 'hybrid' : w.startsWith('onsite') ? 'onsite' : 'unknown'
}

/**
 * Consensus of several reads of the same ad. A single LLM read swings ±8 points on fit and flips borderline facts
 * (measured: 3 reads of 13 relevant ads, max-min ≈ 15 points); averaging reads and voting on facts is the cheapest
 * way to steady it. fit = mean; each categorical fact = majority; a tie goes to the value the rule engine's own
 * reading of the text agrees with (workplace), else to the latest read.
 */
export function mergeReads(reads: Facts[], rule?: RuleHint): StoredFacts {
  const last = reads[reads.length - 1]
  if (reads.length === 1) return { ...last, reads }
  const vote = <K extends keyof Facts>(k: K, prefer?: (v: Facts[K]) => boolean): Facts[K] => {
    const counts = new Map<string, { v: Facts[K]; n: number; at: number }>()
    reads.forEach((r, i) => {
      const key = JSON.stringify(r[k])
      const c = counts.get(key)
      if (c) {
        c.n++
        c.at = i
      } else counts.set(key, { v: r[k], n: 1, at: i })
    })
    const top = Math.max(...[...counts.values()].map((c) => c.n))
    const tied = [...counts.values()].filter((c) => c.n === top)
    if (tied.length === 1) return tied[0].v
    const preferred = prefer ? tied.filter((c) => prefer(c.v)) : []
    const pool = preferred.length ? preferred : tied
    return pool.sort((a, b) => b.at - a.at)[0].v
  }
  const ruleClass = rule?.remote
  return {
    fit: Math.round(reads.reduce((a, r) => a + (Number(r.fit) || 0), 0) / reads.length),
    role_fit: vote('role_fit'),
    seniority_fit: vote('seniority_fit'),
    people_manager: vote('people_manager'),
    workplace: vote('workplace', ruleClass ? (w) => workplaceClass(w) === ruleClass : undefined),
    remote_verified: vote('remote_verified'),
    english: vote('english'),
    salary_below_min: vote('salary_below_min'),
    employment: vote('employment'),
    agency: vote('agency'),
    shift: vote('shift'),
    ai_usage: vote('ai_usage'),
    reads,
  }
}
