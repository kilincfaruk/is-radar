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

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}
