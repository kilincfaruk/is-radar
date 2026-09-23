/**
 * Company career boards on public ATS APIs: no login, no scraping, JSON as the company publishes it.
 * Verified formats (2026-09-23): Greenhouse boards-api, Lever postings API, Ashby posting-api.
 * Only titles in the target role family and locations the user can work from are kept; the rest never enters the db.
 * A posting that disappears from the board is marked closed on the next poll.
 */
import * as cheerio from 'cheerio'
import { htmlToMarkdown } from '../markdown.ts'
import { titleGate, titleInRoleFamily, matchHomeCity, HOME_CITIES } from '../shared/prescreen.ts'
import type { PoliteHttp } from '../http.ts'

export type AtsKind = 'greenhouse' | 'lever' | 'ashby'
export type CompanySpec = { name: string; ats: AtsKind; board: string }
export type AtsJob = {
  id: string
  url: string
  title: string
  company: string
  location: string | null
  workplace: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  posted_at: string | null
  description_md: string
}

export const ATS_KINDS: AtsKind[] = ['greenhouse', 'lever', 'ashby']

export function atsSource(kind: AtsKind): string {
  return `ats:${kind}`
}

/** Stable local id: "lever-trendyol-13a35217-…" (the jobs table key is text; LinkedIn ids stay numeric). */
export function atsId(kind: AtsKind, board: string, id: string | number): string {
  return `${kind}-${board}-${id}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

export function boardUrl(c: CompanySpec): string {
  const b = encodeURIComponent(c.board)
  if (c.ats === 'greenhouse') return `https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`
  if (c.ats === 'lever') return `https://api.lever.co/v0/postings/${b}?mode=json`
  return `https://api.ashbyhq.com/posting-api/job-board/${b}?includeCompensation=true`
}

const TR = /türkiye|turkey|istanbul|i̇stanbul|ankara|izmir|i̇zmir|bursa|kocaeli|antalya|manisa|aydın|aydin/i
/** Plain "Remote" or a region Turkey belongs to; EU-only / US / other country remotes are out (residency required). */
const REMOTE_PLAIN = /^\s*(remote|uzaktan|anywhere|worldwide|global)\s*$/i
const REMOTE_REGION = /\b(türkiye|turkey|emea|europe|worldwide|anywhere|global)\b/i
const REMOTE_EXCLUDED = /european union|\beu\b|\bus\b|usa|united states|canada|\buk\b|united kingdom|germany|india/i

/** Can the candidate work from here: Turkey, an accepted city, or a remote role open to Turkey-ish regions. */
export function locationOk(loc: string | null, workplace: AtsJob['workplace']): boolean {
  const l = (loc ?? '').trim()
  if (!l) return workplace === 'remote'
  if (TR.test(l) || matchHomeCity(l, HOME_CITIES)) return true
  return workplace === 'remote' && (REMOTE_PLAIN.test(l) || (REMOTE_REGION.test(l) && !REMOTE_EXCLUDED.test(l)))
}

/** Only the role family the radar looks for (core/adjacent/bridge titles, not gated). */
export function titleOk(title: string): boolean {
  if (titleGate(title)) return false
  return titleInRoleFamily(title)
}

function wpOf(v: unknown, remoteFlag?: boolean): AtsJob['workplace'] {
  const s = String(v ?? '').toLowerCase()
  if (remoteFlag || /remote/.test(s)) return 'remote'
  if (/hybrid/.test(s)) return 'hybrid'
  if (/on-?site|office/.test(s)) return 'onsite'
  return 'unknown'
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Parse one board response into jobs (all of them; filtering is separate so tests can see both). */
export function parseBoard(c: CompanySpec, body: string): AtsJob[] {
  const data = JSON.parse(body) as unknown
  if (c.ats === 'greenhouse') {
    const jobs = (data as { jobs?: Array<Record<string, unknown>> }).jobs ?? []
    return jobs.map((j) => {
      // Greenhouse ships the description HTML-escaped (&lt;p&gt;…): decode once, then convert
      const html = cheerio.load(`<div>${String(j.content ?? '')}</div>`)('div').first().text()
      const loc = (j.location as { name?: string } | undefined)?.name ?? null
      return { id: atsId('greenhouse', c.board, String(j.id)), url: String(j.absolute_url ?? ''), title: String(j.title ?? '').trim(), company: String(j.company_name ?? c.name), location: loc, workplace: wpOf(loc), posted_at: iso(j.first_published ?? j.updated_at), description_md: htmlToMarkdown(html) }
    })
  }
  if (c.ats === 'lever') {
    const jobs = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>
    return jobs.map((j) => {
      const cat = (j.categories ?? {}) as { location?: string; allLocations?: string[] }
      const lists = ((j.lists ?? []) as Array<{ text?: string; content?: string }>).map((l) => `<h3>${l.text ?? ''}</h3><ul>${l.content ?? ''}</ul>`).join('')
      const html = `${String(j.opening ?? '')}${String(j.description ?? '')}${lists}${String(j.additional ?? '')}`
      return { id: atsId('lever', c.board, String(j.id)), url: String(j.hostedUrl ?? ''), title: String(j.text ?? '').trim(), company: c.name, location: cat.location ?? null, workplace: wpOf(j.workplaceType), posted_at: iso(j.createdAt), description_md: htmlToMarkdown(html) }
    })
  }
  const jobs = ((data as { jobs?: Array<Record<string, unknown>> }).jobs ?? []).filter((j) => j.isListed !== false)
  return jobs.map((j) => ({ id: atsId('ashby', c.board, String(j.id)), url: String(j.jobUrl ?? ''), title: String(j.title ?? '').trim(), company: c.name, location: (j.location as string | undefined) ?? null, workplace: wpOf(j.workplaceType, j.isRemote === true), posted_at: iso(j.publishedAt), description_md: htmlToMarkdown(String(j.descriptionHtml ?? '')) }))
}

export type BoardResult = { ok: true; all: number; kept: AtsJob[] } | { ok: false; error: string }

export async function fetchBoard(c: CompanySpec, http: PoliteHttp): Promise<BoardResult> {
  const res = await http.get(boardUrl(c))
  if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}${res.status === 404 ? ' (pano adı yanlış olabilir)' : ''}` }
  try {
    const all = parseBoard(c, res.text)
    return { ok: true, all: all.length, kept: all.filter((j) => j.title && titleOk(j.title) && locationOk(j.location, j.workplace)) }
  } catch (e) {
    return { ok: false, error: 'yanıt okunamadı: ' + (e instanceof Error ? e.message : String(e)) }
  }
}
