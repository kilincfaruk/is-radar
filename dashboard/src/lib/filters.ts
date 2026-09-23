/** Inbox filters: text + facets. Counts are computed per facet with the other facets applied (standard faceted search). */
import type { Job, RoleFit } from './types'
import type { CityClass, WorkplaceKind } from './workplace'
import type { JobView } from './model'
import { HOME_CITIES } from './prescreen'

export type DateRange = 'any' | '24h' | '7d' | '30d'
export type Filters = {
  q: string
  wp: Array<WorkplaceKind | 'unknown'>
  city: CityClass[]
  date: DateRange
  role: RoleFit[]
  good: boolean
  scoredOnly: boolean
  flagged: boolean
  easy: boolean
  unread: boolean
  /** Calibration matrix cell: [rule verdict idx (reject/review/candidate), LLM band idx (<40 / mid / ≥thr)]. */
  cell: [number, number] | null
  /** 'fp' = LLM ≥ threshold but ignored/rejected; 'fn' = LLM < 40 but shortlisted/applied/interviewing. */
  decision: 'fp' | 'fn' | null
}
export const EMPTY_FILTERS: Filters = { q: '', wp: [], city: [], date: 'any', role: [], good: false, scoredOnly: false, flagged: false, easy: false, unread: false, cell: null, decision: null }
export const RULE_IDX = { reject: 0, review: 1, candidate: 2 } as const
export function llmBand(score: number | null, threshold: number): number | null {
  return score == null ? null : score < 40 ? 0 : score < threshold ? 1 : 2
}
export type FacetKey = keyof Filters

const DATE_DAYS: Record<DateRange, number> = { '24h': 1, '7d': 7, '30d': 30, any: 1e9 }

export type Ctx = { view: (j: Job) => JobView; threshold: number }

export function passes(j: Job, f: Filters, ctx: Ctx, skip?: FacetKey): boolean {
  const v = ctx.view(j)
  if (skip !== 'q' && f.q) {
    const n = f.q.toLocaleLowerCase('tr-TR')
    if (![j.title, j.company, j.location, j.searchKeywords].some((t) => (t || '').toLocaleLowerCase('tr-TR').includes(n))) return false
  }
  if (skip !== 'wp' && f.wp.length && !f.wp.includes(v.wp.kind)) return false
  if (skip !== 'city' && f.city.length && !f.city.includes(v.wp.cityClass)) return false
  if (skip !== 'date' && f.date !== 'any' && v.days > DATE_DAYS[f.date]) return false
  if (skip !== 'role' && f.role.length && !f.role.includes(v.role)) return false
  if (skip !== 'good' && f.good && !(v.score != null && v.score >= ctx.threshold)) return false
  if (skip !== 'scoredOnly' && f.scoredOnly && v.score == null) return false
  if (skip !== 'flagged' && f.flagged && !v.flagged) return false
  if (skip !== 'easy' && f.easy && !j.easyApply) return false
  if (skip !== 'unread' && f.unread && j.viewedAt) return false
  if (skip !== 'cell' && f.cell && (RULE_IDX[v.pre.verdict] !== f.cell[0] || llmBand(v.score, ctx.threshold) !== f.cell[1])) return false
  if (skip !== 'decision' && f.decision) {
    if (v.score == null) return false
    const pos = ['shortlist', 'applied', 'interviewing'].includes(j.status)
    const neg = j.status === 'ignored' || j.status === 'rejected'
    if (f.decision === 'fp' && !(neg && v.score >= ctx.threshold)) return false
    if (f.decision === 'fn' && !(pos && v.score < 40)) return false
  }
  return true
}

export function filterCount(f: Filters): number {
  return (f.q ? 1 : 0) + f.wp.length + f.city.length + (f.date !== 'any' ? 1 : 0) + f.role.length + [f.good, f.scoredOnly, f.flagged, f.easy, f.unread].filter(Boolean).length + (f.cell ? 1 : 0) + (f.decision ? 1 : 0)
}

export type FacetOption = { label: string; on: boolean; count: number; title?: string; toggle: (f: Filters) => Filters }
export type Facet = { key: string; label: string; opts: FacetOption[] }

function toggleIn<K extends 'wp' | 'city' | 'role'>(key: K, v: Filters[K][number]) {
  return (f: Filters): Filters => {
    const cur = f[key] as Array<Filters[K][number]>
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]
    return { ...f, [key]: next }
  }
}

/** Facet definitions with live counts over `raw` (the current queue before filtering). */
export function facets(raw: Job[], f: Filters, ctx: Ctx): Facet[] {
  const cnt = (skip: FacetKey, pred: (j: Job, v: JobView) => boolean) => raw.filter((j) => passes(j, f, ctx, skip) && pred(j, ctx.view(j))).length
  const multi = <K extends 'wp' | 'city' | 'role'>(key: K, label: string, opts: Array<[Filters[K][number], string, string?]>, of: (v: JobView) => string): Facet => ({
    key,
    label,
    opts: opts.map(([v, l, title]) => ({ label: l, title, on: (f[key] as string[]).includes(v as string), count: cnt(key, (_j, jv) => of(jv) === v), toggle: toggleIn(key, v) })),
  })
  const flag = (key: 'good' | 'scoredOnly' | 'flagged' | 'easy' | 'unread', label: string, pred: (j: Job, v: JobView) => boolean, title?: string): FacetOption => ({
    label,
    title,
    on: f[key],
    count: cnt(key, pred),
    toggle: (x) => ({ ...x, [key]: !x[key] }),
  })
  return [
    multi('wp', 'Çalışma', [['remote', 'Remote'], ['hybrid', 'Hibrit'], ['onsite', 'Ofis'], ['unknown', 'Belirsiz', 'Metin çalışma şeklini söylemiyor']], (v) => v.wp.kind),
    multi('city', 'Şehir', [['ankara', HOME_CITIES[0] ?? 'Ankara'], ['home', 'Kabul edilen', HOME_CITIES.slice(1).join(' / ') || 'diğer kabul edilen şehirler'], ['other', 'Başka şehir'], ['none', 'Şehirsiz', 'Lokasyonu sadece Türkiye; genelde remote']], (v) => v.wp.cityClass),
    multi('role', 'Rol', [['core', 'Hedef'], ['adjacent', 'Yakın'], ['bridge', 'Köprü'], ['mismatch', 'Uyumsuz']], (v) => v.role),
    {
      key: 'date',
      label: 'Tarih',
      opts: (['24h', '7d', '30d', 'any'] as DateRange[]).map((v) => ({ label: { '24h': '24 sa', '7d': '7 gün', '30d': '30 gün', any: 'hepsi' }[v], on: f.date === v, count: cnt('date', (_j, jv) => jv.days <= DATE_DAYS[v]), toggle: (x) => ({ ...x, date: v }) })),
    },
    {
      key: 'other',
      label: 'Diğer',
      opts: [
        flag('good', `≥ ${ctx.threshold}`, (_j, v) => (v.score ?? -1) >= ctx.threshold, 'LLM skoru eşik ve üstü'),
        flag('scoredOnly', 'skorlu', (_j, v) => v.score != null, 'LLM henüz okumadıysa gizle'),
        flag('flagged', '⚑ bayraklı', (_j, v) => v.flagged, 'Kırmızı bayrak ya da çelişki olanlar'),
        flag('easy', 'Easy Apply', (j) => j.easyApply),
        flag('unread', 'görülmemiş', (j) => !j.viewedAt, 'Detayını hiç açmadıkların'),
      ],
    },
  ]
}

/** Active filters as removable chips (shown when the panel is collapsed). */
export function summary(f: Filters, threshold: number): Array<{ label: string; remove: (f: Filters) => Filters }> {
  const L: Record<string, Record<string, string>> = {
    wp: { remote: 'Remote', hybrid: 'Hibrit', onsite: 'Ofis', unknown: 'Belirsiz' },
    city: { ankara: HOME_CITIES[0] ?? 'Ankara', home: 'Kabul edilen', other: 'Başka şehir', none: 'Şehirsiz' },
    role: { core: 'Hedef', adjacent: 'Yakın', bridge: 'Köprü', mismatch: 'Uyumsuz' },
    date: { '24h': '24 sa', '7d': '7 gün', '30d': '30 gün' },
  }
  const out: Array<{ label: string; remove: (f: Filters) => Filters }> = []
  for (const k of ['wp', 'city', 'role'] as const) for (const v of f[k]) out.push({ label: L[k][v], remove: toggleIn(k, v as never) })
  if (f.date !== 'any') out.push({ label: L.date[f.date], remove: (x) => ({ ...x, date: 'any' }) })
  if (f.good) out.push({ label: `≥ ${threshold}`, remove: (x) => ({ ...x, good: false }) })
  if (f.scoredOnly) out.push({ label: 'skorlu', remove: (x) => ({ ...x, scoredOnly: false }) })
  if (f.flagged) out.push({ label: '⚑ bayraklı', remove: (x) => ({ ...x, flagged: false }) })
  if (f.easy) out.push({ label: 'Easy Apply', remove: (x) => ({ ...x, easy: false }) })
  if (f.unread) out.push({ label: 'görülmemiş', remove: (x) => ({ ...x, unread: false }) })
  if (f.decision) out.push({ label: f.decision === 'fp' ? `LLM ≥ ${threshold}, sen geçtin` : 'LLM < 40, sen beğendin', remove: (x) => ({ ...x, decision: null }) })
  if (f.cell) out.push({ label: `kural ${['reject', 'review', 'candidate'][f.cell[0]]} · LLM ${['< 40', `40–${threshold - 1}`, `≥ ${threshold}`][f.cell[1]]}`, remove: (x) => ({ ...x, cell: null }) })
  return out
}
