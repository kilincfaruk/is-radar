import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSearchPage, parseDetailPage } from '../src/sources/linkedin-guest.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
const check = (name: string, cond: boolean, extra?: unknown) => {
  cond ? pass++ : fail++
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
}

const search = fs.readFileSync(path.join(here, 'fixtures/guest_search.html'), 'utf8')
const cards = parseSearchPage(search, { workplace: 'remote', keywords: 'business analyst' })
check('search page yields 10+ cards', cards.length >= 10, cards.length)
const c0 = cards[0]
check('card fields', !!c0 && /^\d{8,}$/.test(c0.linkedin_job_id) && c0.title === 'Kıdemli İş Analisti' && c0.company === 'English Home' && c0.location === 'İstanbul, Türkiye' && c0.posted_at === '2026-09-10T00:00:00.000Z' && c0.workplace_type === 'remote' && !!c0.company_url && !c0.company_url.includes('?'), c0)
check('all cards have title+id', cards.every((c) => c.title && c.linkedin_job_id))

const detail = fs.readFileSync(path.join(here, 'fixtures/guest_detail.html'), 'utf8')
const d = parseDetailPage(detail, '4462279004')
check('detail parsed', !!d && d.title === 'Information Technology Analyst' && d.company === 'Hedef Filo' && d.location === 'Kağıthane' && d.posted_text === '1 hafta önce' && d.applicant_count === 200, d && { t: d.title, c: d.company, l: d.location, p: d.posted_text, a: d.applicant_count })
check('detail criteria', !!d && d.criteria?.seniority === 'Uzman' && d.criteria?.employment === 'Tam Zamanlı' && d.criteria?.func === 'Bilgi Teknolojisi' && d.criteria?.industry === 'Finansal Hizmetler', d?.criteria)
check('detail description markdown', !!d && d.description_md.includes('QUALIFICATIONS') && d.description_md.includes('At least 3 years') && d.description_md.length > 1000, d?.description_md.slice(0, 200))
check('no script/button noise in description', !!d && !/daha fazla göster|show more/i.test(d.description_md))

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
