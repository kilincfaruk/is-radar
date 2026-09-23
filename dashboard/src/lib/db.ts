/** Dashboard data access: the collector's REST API on the same origin. Pure helpers re-exported from shared. */
import type { Job } from './types'
export { hasDescription, needsScore, computeStats, parsePostedText } from '@shared/jobs'

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

export async function getAllJobs(): Promise<Job[]> {
  return j<Job[]>('/api/jobs')
}

/** Delta sync: `since` = '' → everything; otherwise only rows changed since then. `now` is the next `since`. */
export async function syncJobs(since: string): Promise<{ now: string; full: boolean; jobs: Job[] }> {
  return j(`/api/jobs?since=${encodeURIComponent(since)}`)
}

export async function getJob(id: string): Promise<Job | undefined> {
  try {
    return await j<Job>(`/api/jobs/${id}`)
  } catch {
    return undefined
  }
}

const PATCHABLE = ['status', 'notes', 'appliedAt', 'manualExportedAt', 'decisionReason', 'viewedAt', 'score', 'remoteVerified', 'seniorityFit', 'roleFit', 'summary', 'pros', 'cons', 'redFlags', 'scoredAt', 'scoreModel', 'scoreError'] as const

export async function updateJob(id: string, patch: (current: Job) => Partial<Job>): Promise<Job | undefined> {
  const cur = await getJob(id)
  if (!cur) return undefined
  const p = patch(cur)
  const body: Record<string, unknown> = {}
  for (const k of PATCHABLE) if (k in p) body[k] = (p as Record<string, unknown>)[k]
  return j<Job>(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export async function deleteJob(id: string): Promise<void> {
  await j(`/api/jobs/${id}`, { method: 'DELETE' })
}
