/**
 * LinkedIn's login-free "jobs-guest" endpoints (the ones the public job pages use).
 * No cookies, no account. Selectors observed 2026-09-16; on breakage the HTML is
 * saved to data/samples/ and the round continues.
 */
import * as cheerio from 'cheerio'
import fs from 'node:fs'
import path from 'node:path'
import { SAMPLES_DIR } from '../config.ts'
import { htmlToMarkdown } from '../markdown.ts'
import { log } from '../log.ts'
import type { CardInput, DetailInput } from '../db.ts'

export const WT_LABEL: Record<number, CardInput['workplace_type']> = { 1: 'onsite', 2: 'remote', 3: 'hybrid' }

/**
 * Only keywords/location/f_TPR/start are sent. The guest endpoint ignores every other filter
 * (verified 2026-09-20 with identical result sets): f_WT (workplace), f_E (experience level),
 * f_JT (job type) and sortBy=DD (date order). Relevance order is all we get, so incremental
 * pagination can only stop on a page made entirely of known ids.
 */
export function searchUrl(p: { keywords: string; location: string; f_TPR: string; start: number }): string {
  const q = new URLSearchParams({ keywords: p.keywords, location: p.location, f_TPR: p.f_TPR, start: String(p.start) })
  return 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' + q.toString()
}

export function detailUrl(id: string): string {
  return 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/' + id
}

function clean(s: string | undefined | null): string | null {
  if (!s) return null
  const t = s.replace(/\s+/g, ' ').trim()
  return t || null
}

function idFromUrn(urn: string | undefined): string | null {
  const m = (urn || '').match(/(\d{6,})/)
  return m ? m[1] : null
}

function stripCompanyUrl(href: string | undefined): string | null {
  if (!href) return null
  try {
    const u = new URL(href)
    u.search = ''
    return u.toString()
  } catch {
    return null
  }
}

export function parseSearchPage(html: string, ctx: { workplace: CardInput['workplace_type']; keywords: string }): CardInput[] {
  const $ = cheerio.load(html)
  const out: CardInput[] = []
  $('[data-entity-urn*="jobPosting"]').each((_, el) => {
    const $el = $(el)
    const id = idFromUrn($el.attr('data-entity-urn'))
    if (!id) return
    const title = clean($el.find('.base-search-card__title').first().text()) || clean($el.find('a.base-card__full-link .sr-only').first().text())
    if (!title) return
    const companyEl = $el.find('.base-search-card__subtitle a').first()
    const company = clean(companyEl.text()) || clean($el.find('.base-search-card__subtitle').first().text())
    const company_url = stripCompanyUrl(companyEl.attr('href'))
    const location = clean($el.find('.job-search-card__location').first().text())
    const timeEl = $el.find('time').first()
    const dt = timeEl.attr('datetime') || null
    const posted_text = clean(timeEl.text())
    const posted_at = dt && /^\d{4}-\d{2}-\d{2}/.test(dt) ? new Date(dt.slice(0, 10) + 'T00:00:00Z').toISOString() : null
    const benefits = clean($el.find('.job-posting-benefits__text').text()) || ''
    out.push({
      linkedin_job_id: id,
      url: 'https://www.linkedin.com/jobs/view/' + id + '/',
      title,
      company,
      company_url,
      location,
      workplace_type: ctx.workplace,
      posted_text,
      posted_at,
      easy_apply: /kolay başvuru|easy apply/i.test(benefits),
      applicant_count: null,
      source: 'linkedin-guest',
      search_keywords: ctx.keywords,
    })
  })
  return out
}

export type ParsedDetail = DetailInput & { workplace_hint: CardInput['workplace_type'] | null; closed: boolean }

/**
 * "No longer accepting applications" / "Artık başvuru kabul etmiyor": LinkedIn renders it as
 * <figcaption class="closed-job__flavor--closed"> in the top card. Closed ads also disappear from guest
 * search, so this is only seen on detail re-fetches. Removed ads answer 404/410 instead (handled by the caller).
 */
export function detectClosed(html: string): boolean {
  if (/closed-job__flavor--closed|class="[^"]*closed-job[^"]*"/i.test(html)) return true
  return /artık başvuru kabul etmiyor|no longer accepting applications|başvurular kapandı/i.test(html)
}

export function parseDetailPage(html: string, id: string): ParsedDetail | null {
  const $ = cheerio.load(html)
  const closed = detectClosed(html)
  const descEl = $('.show-more-less-html__markup').first()
  let descHtml = descEl.html()
  if (!descHtml || descHtml.trim().length < 40) {
    // fallback: the description container
    descHtml = $('.description__text, .decorated-job-posting__details, section.description').first().html() || ''
  }
  const description_md = htmlToMarkdown(descHtml || '')
  if (description_md.length < 40) return null
  const title = clean($('.top-card-layout__title, h1.topcard__title, h2.topcard__title').first().text())
  const orgLink = $('.topcard__org-name-link').first()
  const company = clean(orgLink.text()) || clean($('.topcard__flavor').first().text())
  const company_url = stripCompanyUrl(orgLink.attr('href'))
  const location = clean($('.topcard__flavor--bullet').first().text())
  const posted_text = clean($('.posted-time-ago__text').first().text())
  const applicantsTxt = clean($('.num-applicants__caption').first().text())
  let applicant_count: number | null = null
  if (applicantsTxt) {
    const m = applicantsTxt.replace(/\./g, '').match(/(\d+)/)
    if (m) applicant_count = parseInt(m[1], 10)
  }
  const criteria: NonNullable<DetailInput['criteria']> = {}
  $('.description__job-criteria-item').each((_, li) => {
    const k = clean($(li).find('.description__job-criteria-subheader').text()) || ''
    const v = clean($(li).find('.description__job-criteria-text').text())
    if (!v) return
    const kf = k.toLocaleLowerCase('tr-TR')
    if (/kıdem|seniority/.test(kf)) criteria.seniority = v
    else if (/istihdam|employment/.test(kf)) criteria.employment = v
    else if (/görev|function/.test(kf)) criteria.func = v
    else if (/sektör|industr/.test(kf)) criteria.industry = v
  })
  // workplace hint from the page text near the top card (rarely present on guest pages)
  const top = clean($('.top-card-layout__entity-info, .topcard__content-left').first().text()) || ''
  const workplace_hint = /uzaktan|remote/i.test(top) ? 'remote' : /hibrit|hybrid/i.test(top) ? 'hybrid' : /iş yerinde|on-site/i.test(top) ? 'onsite' : null
  return { linkedin_job_id: id, title, company, company_url, location, posted_text, applicant_count, criteria, description_md, workplace_hint, closed }
}

export function saveSample(kind: string, id: string, html: string): void {
  try {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true })
    const f = path.join(SAMPLES_DIR, `${kind}-${id}-${Date.now()}.html`)
    fs.writeFileSync(f, html)
    log.warn(`selector tutmadı (${kind} ${id}); HTML örneği: ${f}`)
  } catch {
    /* ignore */
  }
}
