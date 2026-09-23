/** Everything the dashboard asks the collector for, over /api on the same origin. */

export type ServerTask = { kind: string; startedAt: string; done: number; total: number; note?: string } | null
export type LogLine = { id: number; at: string; level: 'info' | 'warn' | 'error'; text: string }
export type RunRow = { id: number; started_at: string; finished_at: string | null; kind: string; searches: number; cards: number; new_jobs: number; details: number; scored: number; researched: number; requests: number; rate_limited: number; errors: number; note: string | null; cost_usd: number | null; claude_calls: number | null; claude_ms: number | null }
export type ServerStats = {
  total: number
  withDescription: number
  scored: number
  preCandidates: number
  preRejects: number
  lastRun: RunRow | null
  profileHash: string | null
  usage: { calls: number; failures: number; costUsd: number; ms: number; since: string }
  usage7d: { costUsd: number; calls: number; runs: number }
  task: ServerTask
  progress: { phase: string; detail: string } | null
  collecting: boolean
  schedule: { everyMinutes: number; activeHours: [number, number]; nextRunAt: string | null }
}
export type ServerSettings = {
  searchesYaml: string
  searchCount: number
  scorer: string
  model: string
  modelTop: string
  topMinScore: number
  researchMinScore: number
  notifyMinScore: number
  telegram: boolean
  schedule: { every_minutes: number; active_hours: [number, number] }
  radar?: { home_cities?: string[]; accept_hybrid?: boolean; roles?: { core?: string[]; adjacent?: string[]; bridge?: string[]; mismatch?: string[] }; score_weights?: Record<string, number> }
  homeCities: string[]
  thresholds: { review: number; candidate: number }
  scoreThreshold: number
}
export type RadarPatch = { home_cities?: string[]; accept_hybrid?: boolean; thresholds?: { review?: number; candidate?: number }; roles?: { core?: string[]; adjacent?: string[]; bridge?: string[]; mismatch?: string[] }; score_weights?: Record<string, number> }

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = ((await res.json()) as { error?: string }).error || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export const server = {
  stats: () => j<ServerStats>('/api/stats'),
  runs: () => j<RunRow[]>('/api/runs'),
  log: (since = 0, limit = 300) => j<LogLine[]>(`/api/log?since=${since}&limit=${limit}`),
  startRun: async (mode?: 'full' | 'incremental') => void (await j('/api/run', { method: 'POST', body: JSON.stringify(mode ? { mode } : {}) })),
  startScoring: (limit: number, includeRejects: boolean, retryErrors = true) =>
    j<{ ok: boolean; queued: number; errors?: number; rejects?: number; retried?: number }>('/api/score', { method: 'POST', body: JSON.stringify({ limit, includeRejects, retryErrors }) }),
  rescore: async (id: string) => void (await j(`/api/jobs/${id}/rescore`, { method: 'POST' })),
  research: async (id: string) => void (await j(`/api/jobs/${id}/research`, { method: 'POST' })),
  coverLetter: async (id: string): Promise<string> => {
    const r = await j<{ text?: string }>(`/api/jobs/${id}/cover-letter`, { method: 'POST' })
    if (!r.text) throw new Error('Boş cevap geldi, bir daha dene.')
    return r.text
  },
  check: (id: string) => j<{ closed: boolean; reason: string }>(`/api/jobs/${id}/check`, { method: 'POST' }),
  cvTips: (id: string) => j<{ md: string }>(`/api/jobs/${id}/cv-tips`, { method: 'POST' }),
  cvReview: () => j<{ md: string | null }>('/api/cv-review'),
  criteriaReview: () => j<{ md: string | null }>('/api/criteria-review'),
  startCriteriaReview: () => j<{ ok: boolean }>('/api/criteria-review', { method: 'POST' }),
  startCvReview: (limit = 15) => j<{ ok: boolean }>('/api/cv-review', { method: 'POST', body: JSON.stringify({ limit }) }),
  getSettings: () => j<ServerSettings>('/api/settings'),
  saveSettings: async (s: { searchesYaml?: string; scoreThreshold?: number }) => void (await j('/api/settings', { method: 'PUT', body: JSON.stringify(s) })),
  saveRadar: async (radar: RadarPatch) => void (await j('/api/settings', { method: 'PUT', body: JSON.stringify({ radar }) })),
  reports: () => j<Array<{ name: string; at: string; bytes: number }>>('/api/reports'),
  rescoreStale: () => j<{ ok: boolean; queued: number }>('/api/rescore-stale', { method: 'POST', body: '{}' }),
  prescreenNow: () => j<{ updated: number }>('/api/prescreen', { method: 'POST' }),
}
