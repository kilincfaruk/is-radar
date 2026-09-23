import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import type { RadarConfig } from './shared/prescreen.ts'
import { ATS_KINDS, type CompanySpec } from './sources/ats.ts'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const SAMPLES_DIR = path.join(DATA_DIR, 'samples')
export const PUBLIC_DIR = path.join(ROOT, 'public')

export type SearchSpec = {
  keywords: string
  location: string
  f_TPR?: string
  max_pages?: number
}

export type RunMode = 'full' | 'incremental'
export type ModeSpec = { f_TPR: string; max_pages: number }
export type SearchesConfig = {
  defaults: { f_TPR: string; max_pages: number; detail_budget: number }
  /** Full sweep (first run / --full) vs. the cheap incremental sweep every schedule tick. */
  modes: { full: ModeSpec; incremental: ModeSpec }
  searches: SearchSpec[]
  schedule: { every_minutes: number; active_hours: [number, number] }
  /** Cities / role dictionaries for the rule engine and prompts (optional `radar:` block). */
  radar: RadarConfig
  /** Company career boards on public ATS APIs (optional `companies:` block). */
  companies: CompanySpec[]
}

export function loadEnv(): void {
  const p = path.join(ROOT, '.env')
  if (!fs.existsSync(p)) return
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

export function env(name: string, fallback = ''): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

export const SEARCHES_FILE = path.join(ROOT, 'searches.yaml')

export function loadSearches(): SearchesConfig {
  const p = SEARCHES_FILE
  if (!fs.existsSync(p)) throw new Error('searches.yaml yok. `npm run init` çalıştır (searches.example.yaml kopyalanır), sonra aramaları kendine göre düzenle.')
  const raw = YAML.parse(fs.readFileSync(p, 'utf8')) as Partial<SearchesConfig> & { modes?: Partial<Record<RunMode, Partial<ModeSpec>>> }
  const defaults = { f_TPR: 'r604800', max_pages: 4, detail_budget: 120, ...(raw.defaults || {}) }
  const schedule = { every_minutes: 180, active_hours: [7, 23] as [number, number], ...(raw.schedule || {}) }
  // incremental window: 'auto' = 2× the schedule interval (never below 3 h) so a late/skipped tick still catches everything
  const autoTpr = 'r' + Math.max(3 * 3600, 2 * schedule.every_minutes * 60)
  const inc = { f_TPR: 'auto', max_pages: 3, ...(raw.modes?.incremental || {}) }
  const modes = {
    full: { f_TPR: defaults.f_TPR, max_pages: defaults.max_pages, ...(raw.modes?.full || {}) },
    incremental: { ...inc, f_TPR: inc.f_TPR === 'auto' ? autoTpr : inc.f_TPR },
  }
  const searches = (raw.searches || []).map((s) => ({
    keywords: String(s.keywords),
    location: String(s.location || 'Türkiye'),
    // per-search overrides only when written in the yaml; otherwise the run mode decides
    f_TPR: s.f_TPR || undefined,
    max_pages: s.max_pages || undefined,
  }))
  const rr = (raw as { radar?: RadarConfig }).radar ?? {}
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)) : undefined)
  const radar: RadarConfig = {
    home_cities: list(rr.home_cities),
    accept_hybrid: typeof rr.accept_hybrid === 'boolean' ? rr.accept_hybrid : undefined,
    roles: rr.roles ? { core: list(rr.roles.core), adjacent: list(rr.roles.adjacent), bridge: list(rr.roles.bridge), mismatch: list(rr.roles.mismatch) } : undefined,
    bonus: list(rr.bonus),
    salary_min_tl: rr.salary_min_tl === undefined ? undefined : Number(rr.salary_min_tl),
    onsite_ok: typeof rr.onsite_ok === 'boolean' ? rr.onsite_ok : undefined,
    score_weights: rr.score_weights && typeof rr.score_weights === 'object' ? Object.fromEntries(Object.entries(rr.score_weights).map(([k, v]) => [k, Number(v)])) : undefined,
    thresholds: rr.thresholds ? { review: rr.thresholds.review === undefined ? undefined : Number(rr.thresholds.review), candidate: rr.thresholds.candidate === undefined ? undefined : Number(rr.thresholds.candidate) } : undefined,
  }
  const rawCompanies = (raw as { companies?: unknown }).companies
  const companies: CompanySpec[] = []
  for (const c of Array.isArray(rawCompanies) ? rawCompanies : []) {
    const o = (c ?? {}) as Record<string, unknown>
    const ats = String(o.ats ?? '').toLowerCase()
    const board = String(o.board ?? '').trim()
    if (!board) throw new Error(`companies: "${String(o.name ?? '?')}" için board yok`)
    if (!ATS_KINDS.includes(ats as CompanySpec['ats'])) throw new Error(`companies: "${String(o.name ?? board)}" için ats şunlardan biri olmalı: ${ATS_KINDS.join(', ')}`)
    companies.push({ name: String(o.name ?? board), ats: ats as CompanySpec['ats'], board })
  }
  return { defaults, modes, searches, schedule, radar, companies }
}

export function ensureDirs(): void {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true })
}

/** First-run setup: copies every *.example file that has no real counterpart yet. Returns what it created. */
export function initFiles(): string[] {
  const pairs: Array<[string, string]> = [
    ['.env.example', '.env'],
    ['searches.example.yaml', 'searches.yaml'],
    [path.join('profile', 'cv.example.md'), path.join('profile', 'cv.md')],
    [path.join('profile', 'criteria.example.md'), path.join('profile', 'criteria.md')],
    [path.join('profile', 'about.example.md'), path.join('profile', 'about.md')],
  ]
  const created: string[] = []
  for (const [from, to] of pairs) {
    const dst = path.join(ROOT, to)
    if (fs.existsSync(dst)) continue
    fs.copyFileSync(path.join(ROOT, from), dst)
    created.push(to)
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  return created
}
