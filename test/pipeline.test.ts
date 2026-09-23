import { planRound, recordYield, runEvery, searchKey, pruneStats, emptyYield, type SearchStats } from '../src/search-plan.ts'
import { buildScoringSystem, buildScoringUserBatch, SCORE_BATCH_JSON_SCHEMA } from '../src/shared/prompt.ts'
import { tipsToMarkdown } from '../src/pipeline/cv.ts'
import { detectClosed, parseDetailPage } from '../src/sources/linkedin-guest.ts'
import { configurePrescreen, HOME_CITIES, matchHomeCity, detectRole, titleGate, phrasesToRegex, prescreen, THRESHOLDS, verdictFor } from '../src/shared/prescreen.ts'
import { scoringSystemPrompt } from '../src/shared/prompt.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, extra?: unknown) => {
  cond ? pass++ : fail++
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
}

// ---- search rotation
const S = [
  { keywords: 'business analyst', location: 'Ankara, Türkiye' },
  { keywords: 'product owner', location: 'Ankara, Türkiye' },
  { keywords: 'iş analisti', location: 'Manisa, Türkiye' },
  { keywords: 'product manager', location: 'Aydın, Türkiye' },
]
check('runEvery: fresh/1 empty → every round', runEvery(0) === 1 && runEvery(1) === 1)
check('runEvery: 2,3 empty → every 2nd/3rd; capped at 4', runEvery(2) === 2 && runEvery(3) === 3 && runEvery(9) === 4)
let st: SearchStats = {}
st = recordYield(st, S[2], 0)
st = recordYield(st, S[2], 0)
st = recordYield(st, S[2], 0)
st = recordYield(st, S[3], 0)
st = recordYield(st, S[3], 0)
st = recordYield(st, S[0], 5)
check('recordYield tracks streaks and totals', st[searchKey(S[2])].zeroStreak === 3 && st[searchKey(S[3])].zeroStreak === 2 && st[searchKey(S[0])].totalNew === 5 && st[searchKey(S[0])].zeroStreak === 0, st)
check('a hit resets the streak', recordYield(st, S[2], 1)[searchKey(S[2])].zeroStreak === 0)
check('full round runs everything', planRound(S, st, 7, 'full').run.length === 4)
const rounds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => planRound(S, st, n, 'incremental'))
check('fresh searches run every incremental round', rounds.every((r) => r.run.some((x) => x.keywords === 'business analyst') && r.run.some((x) => x.keywords === 'product owner')))
const manisaRuns = rounds.filter((r) => r.run.some((x) => x.location.startsWith('Manisa'))).length
const aydinRuns = rounds.filter((r) => r.run.some((x) => x.location.startsWith('Aydın'))).length
check('3× empty search runs 4 of 12 rounds, 2× empty runs 6 of 12', manisaRuns === 4 && aydinRuns === 6, { manisaRuns, aydinRuns })
check('skipped entries carry the cadence', rounds.some((r) => r.skipped.some((x) => x.every === 3)))
check('pruneStats drops removed searches', Object.keys(pruneStats(st, S.slice(0, 2))).length === 1)
check('emptyYield shape', JSON.stringify(emptyYield()) === JSON.stringify({ runs: 0, zeroStreak: 0, lastNew: 0, lastRunAt: null, totalNew: 0 }))

// ---- prompt: about block + batch
const sysNoAbout = buildScoringSystem('CV', 'KRIT')
const sysAbout = buildScoringSystem('CV', 'KRIT', 'Ben şuyum')
check('about block only when given', !sysNoAbout.includes('ADAY HAKKINDA (kendi') && sysAbout.includes('=== ADAY HAKKINDA (kendi sözleriyle) ===\nBen şuyum'))
const job = { title: 'PO', company: 'X', location: 'Ankara, Türkiye', workplaceType: 'unknown', postedText: null, applicantCount: null, descriptionMd: 'metin' }
const batch = buildScoringUserBatch([
  { id: '111', job },
  { id: '222', job: { ...job, title: 'BA' } },
])
check('batch prompt carries ids and both ads', batch.includes('id=111') && batch.includes('id=222') && batch.includes('Başlık: PO') && batch.includes('Başlık: BA') && batch.includes('2 ilanı'))
check('batch prompt drops per-ad trailing instruction', (batch.match(/SADECE JSON döndür/g) || []).length === 1)
const items = SCORE_BATCH_JSON_SCHEMA.properties.results.items
check('batch schema requires id per item', items.required.includes('id') && items.required.includes('fit') && 'id' in items.properties)

// ---- deterministic score
const { computeScore, configureScoring, WEIGHTS, scoreLine } = await import('../src/shared/scoring.ts')
const F = { fit: 80, role_fit: 'core', seniority_fit: 'match', people_manager: false, workplace: 'remote', remote_verified: true, english: 'written', salary_below_min: null, employment: 'full_time', agency: false, shift: false, ai_usage: false } as const
check('score: remote adds bonus', computeScore({ ...F }).score === 90)
check('score: same facts → same score', computeScore({ ...F }).score === computeScore({ ...F }).score)
check('score: stretch + spoken english', computeScore({ ...F, seniority_fit: 'stretch', english: 'spoken_daily' }).score === 90 - 10 - 12)
check('score: onsite elsewhere capped at 25', computeScore({ ...F, workplace: 'onsite_other', fit: 95 }).score === 25)
check('score: accepted-city office capped at 70 unless fit ≥ 85', computeScore({ ...F, workplace: 'onsite_home', fit: 80 }).score === 70 && computeScore({ ...F, workplace: 'onsite_home', fit: 90 }).score === 90)
check('score: silent workplace, country vs city cap', computeScore({ ...F, workplace: 'unknown', fit: 85 }, { location: 'Türkiye' }).score === 70 && computeScore({ ...F, workplace: 'unknown', fit: 85 }, { location: 'Ankara, Türkiye' }).score === 60)
check('score: agency removes remote bonus and costs 10', computeScore({ ...F, agency: true }).score === 70)
check('score: tightest cap wins, others shown unapplied', (() => { const r = computeScore({ ...F, employment: 'part_time', role_fit: 'mismatch' }); return r.score === 25 && r.parts.filter((p) => p.kind === 'cap').length === 2 && r.parts.filter((p) => p.kind === 'cap' && p.applied).length === 1 })())
check('score: clamp 0..100', computeScore({ ...F, fit: 100, ai_usage: true }).score === 100 && computeScore({ ...F, fit: 5, workplace: 'hybrid_other', seniority_fit: 'over' }).score === 0)
configureScoring({ remote: 20, stretch: 0 })
check('score: yaml weights override', computeScore({ ...F }).score === 100 && computeScore({ ...F, fit: 60, seniority_fit: 'stretch' }).score === 80)
configureScoring(null)
check('score: weights reset', WEIGHTS.remote === 10 && computeScore({ ...F }).score === 90)
check('score line readable', scoreLine(computeScore({ ...F, seniority_fit: 'stretch' })) === '80 içerik uyumu · +10 tam remote · −10 kıdem biraz üstünde')

// ---- consensus of reads
const { mergeReads } = await import('../src/shared/scoring.ts')
const r1 = { ...F, fit: 70, workplace: 'onsite_other', seniority_fit: 'match' } as const
const r2 = { ...F, fit: 80, workplace: 'unknown', seniority_fit: 'stretch' } as const
const r3 = { ...F, fit: 75, workplace: 'unknown', seniority_fit: 'match' } as const
const m3 = mergeReads([r1, r2, r3] as never)
check('merge: fit = mean, facts = majority', m3.fit === 75 && m3.workplace === 'unknown' && m3.seniority_fit === 'match' && m3.reads?.length === 3)
check('merge: tie → the value the rule engine agrees with', mergeReads([r2, r1] as never, { remote: 'unknown' }).workplace === 'unknown' && mergeReads([r2, r1] as never, { remote: 'onsite' }).workplace === 'onsite_other')
check('merge: tie without rule hint → latest read', mergeReads([r1, r2] as never).workplace === 'unknown' && mergeReads([r2, r1] as never).workplace === 'onsite_other')

// ---- learning from decisions
const { learn, predict, auc } = await import('../src/shared/learn.ts')
check('auc: perfect / reversed / tie', auc([3, 2, 1], [1, 1, 0]) === 1 && auc([1, 2, 3], [1, 1, 0]) === 0 && auc([1, 1], [1, 0]) === 0.5)
const mk = (i: number, score: number, wpl: string, status: string) => ({ linkedinJobId: String(i), score, scoredAt: 'x', status, workplaceLlm: wpl, roleFit: 'core', seniorityFit: 'match', englishLevel: 'written', aiUsage: false, salaryNote: null, facts: null }) as never
// the user pursues remote/hybrid ads by score, but rejects every office ad however high it scored
const J: never[] = []
let rnd = 7
const r01 = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648)
for (let i = 0; i < 90; i++) {
  const office = i % 3 === 0
  const score = Math.round(40 + r01() * 50)
  const status = office ? 'ignored' : score >= 62 ? 'shortlist' : 'ignored'
  J.push(mk(i, score, office ? 'onsite_ankara' : i % 3 === 1 ? 'remote' : 'hybrid_ankara', status))
}
check('learn: needs enough decisions', learn(J.slice(0, 10)) === null)
const LM = learn(J)
check('learn: office learned as negative', !!LM && LM.effects.find((e) => e.key === 'office_home')!.weight < -0.5, LM?.effects.slice(0, 3))
check('learn: beats raw score (cv auc)', !!LM && LM.useful && (LM.auc ?? 0) > (LM.aucScore ?? 1), { auc: LM?.auc, aucScore: LM?.aucScore })
const J2: never[] = []
for (let i = 0; i < 90; i++) {
  const score = Math.round(40 + r01() * 50)
  J2.push(mk(i, score, i % 3 === 0 ? 'onsite_ankara' : 'remote', score >= 62 ? 'shortlist' : 'ignored'))
}
check('learn: decisions that follow the score → not marked useful', learn(J2)?.useful === false, { auc: learn(J2)?.auc, aucScore: learn(J2)?.aucScore })
check('learn: office at 85 below remote at 70', !!LM && predict(LM, mk(1000, 85, 'onsite_ankara', 'new'))! < predict(LM, mk(1001, 70, 'remote', 'new'))!)

// ---- company boards (ATS)
const { parseBoard, locationOk, titleOk, atsId } = await import('../src/sources/ats.ts')
const gh = parseBoard({ name: 'Acme', ats: 'greenhouse', board: 'acme' }, JSON.stringify({ jobs: [{ id: 42, title: 'Business Analyst', absolute_url: 'https://x/42', company_name: 'Acme', location: { name: 'Ankara, Türkiye' }, first_published: '2026-09-01T10:00:00Z', content: '&lt;p&gt;Analiz &lt;strong&gt;yaparsın&lt;/strong&gt;, gereksinim yazarsın, paydaşlarla çalışırsın.&lt;/p&gt;' }] }))
check('greenhouse: escaped html decoded to markdown', gh[0].description_md.includes('**yaparsın**') && !gh[0].description_md.includes('&lt;'), gh[0].description_md)
check('greenhouse: id / location / date', gh[0].id === 'greenhouse-acme-42' && gh[0].location === 'Ankara, Türkiye' && gh[0].posted_at === '2026-09-01T10:00:00.000Z')
const lv = parseBoard({ name: 'Acme', ats: 'lever', board: 'acme' }, JSON.stringify([{ id: 'ab-12', text: 'Product Owner', hostedUrl: 'https://jobs.lever.co/acme/ab-12', categories: { location: 'Istanbul / Maslak' }, workplaceType: 'hybrid', createdAt: 1789895890007, description: '<p>Ürün backlog</p>', lists: [{ text: 'Requirements', content: '<li>3+ yıl</li>' }], additional: '' }]))
check('lever: lists become a section, workplace from field', lv[0].description_md.includes('Requirements') && lv[0].description_md.includes('3+ yıl') && lv[0].workplace === 'hybrid' && lv[0].id === 'lever-acme-ab-12')
const ab = parseBoard({ name: 'Acme', ats: 'ashby', board: 'acme' }, JSON.stringify({ jobs: [{ id: 'u1', title: 'Product Manager', jobUrl: 'https://jobs.ashbyhq.com/acme/u1', location: 'Remote - EMEA', isRemote: true, workplaceType: 'Remote', publishedAt: '2026-09-10', descriptionHtml: '<p>Roadmap sahibi</p>', isListed: true }, { id: 'u2', title: 'Hidden', isListed: false }] }))
check('ashby: unlisted dropped, remote flag', ab.length === 1 && ab[0].workplace === 'remote')
check('location: Turkey / accepted city / remote EMEA ok; Berlin office no', locationOk('Istanbul / Maslak', 'hybrid') && locationOk('Ankara', 'onsite') && locationOk('Remote - EMEA', 'remote') && !locationOk('Berlin', 'onsite') && !locationOk('Remote - US', 'remote') && !locationOk('Remote - European Union', 'remote') && locationOk('Remote', 'remote'))
check('title: role family only', titleOk('Senior Business Analyst') && titleOk('Ürün Yöneticisi') && !titleOk('Abuse Investigator') && !titleOk('Software Engineer'))
check('atsId safe', atsId('lever', 'Acme Co', 'X/1') === 'lever-acme-co-x-1')

// ---- cv tips markdown
const md = tipsToMarkdown({ fit_line: 'x', foreground: ['a'], rewrites: [{ original: 'o', suggested: 's', why: 'w' }], missing: [], avoid: ['z'] })
check('tips markdown sections', md.includes('**Konumlanma:** x') && md.includes('~~o~~') && md.includes('→ s') && !md.includes('İlanda var') && md.includes('**Geri çek**'))

// ---- closed ads
const here = path.dirname(fileURLToPath(import.meta.url))
const openHtml = fs.readFileSync(path.join(here, 'fixtures/guest_detail.html'), 'utf8')
check('open ad: not closed', !detectClosed(openHtml) && parseDetailPage(openHtml, '4462279004')?.closed === false)
const closedHtml = openHtml.replace('<div class="top-card-layout__entity-info-container', '<figcaption class="closed-job__flavor--closed">Artık başvuru kabul etmiyor</figcaption><div class="top-card-layout__entity-info-container')
check('closed marker detected (class)', closedHtml !== openHtml && detectClosed(closedHtml) && parseDetailPage(closedHtml, '4462279004')?.closed === true)
check('closed marker detected (text only)', detectClosed('<p>No longer accepting applications</p>') && detectClosed('<span>Artık başvuru kabul etmiyor</span>') && !detectClosed('<p>accepting applications</p>'))

// ---- radar config: cities + role dictionaries
check('phrasesToRegex folds and allows flexible spaces', phrasesToRegex(['Product  Owner', 'İş Analisti']).test('senior product owner') && phrasesToRegex(['İş Analisti']).test('kıdemli iş analisti') && !phrasesToRegex([]).test('anything'))
configurePrescreen({ home_cities: ['Bursa', 'İstanbul'], roles: { core: ['yazılım geliştirici', 'software developer'], mismatch: ['iş analisti'] } })
check('cities replaced in place', HOME_CITIES[0] === 'Bursa' && matchHomeCity('İstanbul, Türkiye', HOME_CITIES) === 'İstanbul' && matchHomeCity('Ankara, Türkiye', HOME_CITIES) === null)
check('prompt reads live cities', scoringSystemPrompt().includes("Aday Bursa'da yaşıyor") && scoringSystemPrompt().includes('İstanbul'))
check('role dictionaries replaced', detectRole('Software Developer', '').role === 'core' && detectRole('İş Analisti', '').role === 'mismatch' && titleGate('Software Developer') === null && titleGate('İş Analisti') !== null)
const bursaRow = prescreen({ title: 'Software Developer', workplaceType: 'unknown', location: 'Bursa, Türkiye', descriptionMd: 'Haftada 2 gün ofis. 3 yıl tecrübe. Jira.' })
check('prescreen uses configured primary city', !!bursaRow && bursaRow.homeCity && bursaRow.homeCityName === 'Bursa' && bursaRow.role === 'core', bursaRow)
configurePrescreen({ thresholds: { review: 45, candidate: 75 } })
check('verdict thresholds configurable', THRESHOLDS.review === 45 && THRESHOLDS.candidate === 75 && verdictFor(44) === 'reject' && verdictFor(45) === 'review' && verdictFor(75) === 'candidate')
configurePrescreen({ thresholds: { review: 50, candidate: 40 } })
check('candidate below review is corrected', THRESHOLDS.review === 50 && THRESHOLDS.candidate === 60)
configurePrescreen({})
check('thresholds reset to defaults', THRESHOLDS.review === 35 && THRESHOLDS.candidate === 60)
check('empty config restores defaults', HOME_CITIES[0] === 'Ankara' && HOME_CITIES.length === 4 && detectRole('İş Analisti', '').role === 'core' && detectRole('Software Developer', '').role === 'mismatch')

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
