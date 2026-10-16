/**
 * Search rotation for incremental rounds. Every search keeps a yield record (how many new jobs it
 * produced, how many rounds in a row it produced none). A search that keeps coming back empty is
 * run less often: after 2 empty rounds every 2nd round, after 3 every 3rd, capped at every 4th.
 * Full rounds always run everything. Pure functions; the caller persists the JSON.
 */
import type { SearchSpec } from './config.ts'

export type SearchYield = { runs: number; zeroStreak: number; lastNew: number; lastRunAt: string | null; totalNew: number }
export type SearchStats = Record<string, SearchYield>

export const MAX_SKIP_EVERY = 4

export function searchKey(s: Pick<SearchSpec, 'keywords' | 'location'>): string {
  return `${s.keywords.trim().toLocaleLowerCase('tr-TR')}|${s.location.trim().toLocaleLowerCase('tr-TR')}`
}

export function emptyYield(): SearchYield {
  return { runs: 0, zeroStreak: 0, lastNew: 0, lastRunAt: null, totalNew: 0 }
}

/** How often (in rounds) a search with this streak should run: 1 = every round. */
export function runEvery(zeroStreak: number): number {
  if (zeroStreak < 2) return 1
  return Math.min(MAX_SKIP_EVERY, zeroStreak)
}

/** Which searches to run in this incremental round, and which to skip with the reason. */
export function planRound(searches: SearchSpec[], stats: SearchStats, roundNo: number, mode: 'full' | 'incremental'): { run: SearchSpec[]; skipped: Array<{ spec: SearchSpec; every: number }> } {
  if (mode === 'full') return { run: searches, skipped: [] }
  const run: SearchSpec[] = []
  const skipped: Array<{ spec: SearchSpec; every: number }> = []
  for (const s of searches) {
    const y = stats[searchKey(s)] ?? emptyYield()
    const every = runEvery(y.zeroStreak)
    // spread skipped searches across rounds instead of piling them all onto the same one
    const phase = hash(searchKey(s)) % every
    if (every === 1 || roundNo % every === phase) run.push(s)
    else skipped.push({ spec: s, every })
  }
  return { run, skipped }
}

export function recordYield(stats: SearchStats, s: SearchSpec, newJobs: number, at = new Date().toISOString()): SearchStats {
  const k = searchKey(s)
  const y = stats[k] ?? emptyYield()
  return { ...stats, [k]: { runs: y.runs + 1, zeroStreak: newJobs > 0 ? 0 : y.zeroStreak + 1, lastNew: newJobs, lastRunAt: at, totalNew: y.totalNew + newJobs } }
}

/** Drop records for searches that no longer exist in the yaml. */
export function pruneStats(stats: SearchStats, searches: SearchSpec[]): SearchStats {
  const keep = new Set(searches.map(searchKey))
  return Object.fromEntries(Object.entries(stats).filter(([k]) => keep.has(k)))
}

export type SearchGroup = { spec: SearchSpec; members: SearchSpec[] }

/**
 * LinkedIn's guest search understands `"a" OR "b"` (checked 2026-10), so plain searches that share a location (and
 * the same yaml overrides) are sent as one query of up to `size` terms, in yaml order: synonyms written next to each
 * other end up together. Every query is at least one request per round and LinkedIn throttles on request count, so
 * this cuts the search phase by about `size`×. Keep `size` small: at 8-9 terms LinkedIn loosens the match and
 * unrelated ads (Data Analyst, …) fill the pages. Searches already written with OR or quotes are left alone.
 */
export function groupSearches(searches: SearchSpec[], size: number): SearchGroup[] {
  const out: SearchGroup[] = []
  const open = new Map<string, SearchGroup>()
  for (const s of searches) {
    if (size < 2 || /\bOR\b|"/.test(s.keywords)) {
      out.push({ spec: s, members: [s] })
      continue
    }
    const k = `${s.location.trim().toLocaleLowerCase('tr-TR')}|${s.f_TPR ?? ''}|${s.max_pages ?? ''}`
    let g = open.get(k)
    if (!g || g.members.length >= size) {
      g = { spec: s, members: [] }
      open.set(k, g)
      out.push(g)
    }
    g.members.push(s)
  }
  for (const g of out) if (g.members.length > 1) g.spec = { ...g.members[0], keywords: g.members.map((m) => `"${m.keywords.trim()}"`).join(' OR ') }
  return out
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}
