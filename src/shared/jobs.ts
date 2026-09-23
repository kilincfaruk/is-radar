/** Pure helpers over the dashboard's Job shape. Shared by the collector (server side) and the dashboard. */
import type { Job, Stats } from './types.ts'

/** "3 gün önce" / "2 weeks ago" -> ISO date. Unparseable -> null. */
export function parsePostedText(text: string | null, now: Date = new Date()): string | null {
  if (!text) return null
  // Content script appends the <time datetime> value as "[YYYY-MM-DD]" when available.
  const iso = text.match(/\[(\d{4}-\d{2}-\d{2})(?:T[^\]]*)?\]/)
  if (iso) {
    const d = new Date(iso[1] + 'T00:00:00Z')
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  const t = text.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim()
  // LinkedIn often prefixes with "Yeniden yayınlandı" / "Reposted"
  const m = t.match(/(\d+)\s*(dakika|dk|saat|sa|gün|hafta|ay|minute|min|hour|hr|day|week|month)/)
  if (!m) {
    if (/az önce|şimdi|just now|moments? ago/.test(t)) return now.toISOString()
    return null
  }
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n)) return null
  const unit = m[2]
  let days = 0
  if (/^(dakika|dk|saat|sa|minute|min|hour|hr)/.test(unit)) days = 0
  else if (/^(gün|day)/.test(unit)) days = n
  else if (/^(hafta|week)/.test(unit)) days = 7 * n
  else if (/^(ay|month)/.test(unit)) days = 30 * n
  const d = new Date(now.getTime() - days * 86_400_000)
  return d.toISOString()
}

export function hasDescription(j: Job): boolean {
  return !!(j.descriptionMd && j.descriptionMd.trim())
}

export function needsScore(j: Job): boolean {
  return hasDescription(j) && j.scoredAt === null
}

export function computeStats(jobs: Job[], lastCollectedAt: string | null): Stats {
  let scored = 0
  let above70 = 0
  let needsDescription = 0
  let needsScoreCount = 0
  for (const j of jobs) {
    if (j.scoredAt !== null && j.score !== null) {
      scored++
      if (j.score >= 70) above70++
    }
    if (!hasDescription(j)) needsDescription++
    else if (j.scoredAt === null) needsScoreCount++
  }
  return { total: jobs.length, scored, above70, needsDescription, needsScore: needsScoreCount, lastCollectedAt }
}

function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/yeniden yayınlandı|reposted/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * Same company + same title + same city = the same posting published again under a new id (LinkedIn reposts).
 * The city matters: "BA · Ankara" and "BA · İstanbul" are two jobs. Null without a company (can't tell).
 */
export function dupKey(company: string | null | undefined, title: string, location: string | null | undefined): string | null {
  const c = norm(company)
  const t = norm(title)
  if (!c || !t) return null
  const city = norm((location ?? '').split(',')[0])
  return `${c}|${t}|${city}`
}
