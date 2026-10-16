/** DB migrations, change stamps, round bookkeeping, request guard. Runs against a throwaway SQLite file. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SCORER = 'none'
process.env.TELEGRAM_BOT_TOKEN = ''
const { openDb, closeDb, LATEST_MIGRATION, upsertCard, closeStaleRuns, startRun, recentRuns, getJob, updateUserFields, linkDuplicates, markClosed, jobsChangedSince, staleScoredJobs, setScore, jobsNeedingScore, applyDetail, clearScores, recomputeScores } = await import('../src/db.ts')
const { dupKey } = await import('../src/shared/jobs.ts')
const { requestAllowed } = await import('../src/web/server.ts')

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, extra?: unknown) => {
  cond ? pass++ : fail++
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'is-radar-test-'))
const file = path.join(tmp, 't.db')
const mig = () => (openDb(file).prepare("SELECT value FROM settings WHERE key='migration'").get() as { value: string }).value

// ---- migrations: the version only moves forward and lands on LATEST in one open
check('fresh db → latest migration', mig() === String(LATEST_MIGRATION), mig())
closeDb()
check('reopen keeps latest (no regression)', mig() === String(LATEST_MIGRATION), mig())
const cols = new Set((openDb(file).prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name))
check('v8 columns exist', ['score_profile', 'decided_at', 'dup_of', 'updated_at', 'facts_json'].every((c) => cols.has(c)))
// a db whose counter regressed to 3 (old bug) migrates forward without errors
openDb(file).prepare("UPDATE settings SET value='3' WHERE key='migration'").run()
closeDb()
check('regressed counter re-runs idempotently', mig() === String(LATEST_MIGRATION))

// ---- change stamp trigger
const card = { linkedin_job_id: '4000000001', url: 'u', title: 'Business Analyst', company: 'Acme', company_url: null, location: 'Ankara', workplace_type: 'unknown' as const, posted_text: null, posted_at: null, source: 'linkedin-guest' }
upsertCard(card)
const t0 = getJob(card.linkedin_job_id)?.updated_at
check('insert stamps updated_at', !!t0, t0)
await new Promise((r) => setTimeout(r, 15))
updateUserFields(card.linkedin_job_id, { notes: 'x' })
const t1 = getJob(card.linkedin_job_id)?.updated_at
check('update bumps updated_at', !!t1 && !!t0 && t1 > t0, { t0, t1 })

// ---- stale runs
startRun('collect')
check('stale run closed', closeStaleRuns() === 1 && !!recentRuns(1)[0].finished_at && /yarım/.test(recentRuns(1)[0].note ?? ''))

// ---- a round that crashes still closes its row (scheduler would otherwise start one every minute)
if (fs.existsSync(path.join(import.meta.dirname, '..', 'searches.yaml'))) {
  const { collectRound } = await import('../src/run.ts')
  const fake = { stats: { requests: 0, rateLimited: 0, errors: 0, lastStatus: null }, get: async () => { throw new Error('boom') } }
  const id = await collectRound({ http: fake as never, research: false, maxSearches: 1 })
  const r = openDb(file).prepare('SELECT * FROM runs WHERE id = ?').get(id) as { finished_at: string | null; note: string | null }
  check('crashed round has finished_at + error note', !!r.finished_at && /boom/.test(r.note ?? ''), r)
} else console.log('SKIP crashed round (searches.yaml yok)')

// ---- 429s: counted over the hour (one lucky request does not reset), the 3rd ends LinkedIn for the round
{
  const { PoliteHttp, RateLimitedError, COOLDOWN_MIN } = await import('../src/http.ts')
  const realFetch = globalThis.fetch
  const statuses = [429, 200, 429, 200, 429, 200]
  let calls = 0
  globalThis.fetch = (async () => new Response('x', { status: statuses[calls++] ?? 200 })) as typeof fetch
  const waits: number[] = []
  const until: number[] = []
  const h = new PoliteHttp({ minGapMs: 0, maxGapMs: 0, sleep: async (ms) => void waits.push(ms), onRateLimit: (u) => void until.push(u) })
  const got: Array<number | string> = []
  try {
    for (let i = 0; i < 4; i++) got.push((await h.get('https://x/' + i)).status)
  } catch (e) {
    got.push(e instanceof RateLimitedError ? 'gave-up' : String(e))
  }
  const big = waits.filter((w) => w >= 60_000).map((w) => w / 60_000)
  check('429: waits 5 then 15 min, 3rd within the hour gives up', JSON.stringify(got) === '[200,200,"gave-up"]' && JSON.stringify(big) === '[5,15]', { got, big })
  check('429: cooldown reported for the restart guard', until.length === 3 && until[2] - Date.now() > (COOLDOWN_MIN - 1) * 60_000, until.map((u) => Math.round((u - Date.now()) / 60_000)))
  calls = 0
  statuses.splice(0, statuses.length, 503, 200)
  const h2 = new PoliteHttp({ minGapMs: 0, maxGapMs: 0, sleep: async () => {} })
  const r2 = await h2.get('https://x/503')
  check('503: retried, not counted as rate limit', r2.status === 200 && h2.stats.rateLimited === 0)
  globalThis.fetch = realFetch
}

// ---- a round during the cooldown sends nothing to LinkedIn
if (fs.existsSync(path.join(import.meta.dirname, '..', 'searches.yaml'))) {
  const { collectRound, linkedinCooldownLeft } = await import('../src/run.ts')
  const { setSetting } = await import('../src/db.ts')
  setSetting('linkedinCooldownUntil', new Date(Date.now() + 30 * 60_000).toISOString())
  let sent = 0
  const fake = { stats: { requests: 0, rateLimited: 0, errors: 0, lastStatus: null }, get: async () => (sent++, { status: 200, text: '' }) }
  const id = await collectRound({ http: fake as never, research: false, maxSearches: 1, score: false })
  const r = openDb(file).prepare('SELECT * FROM runs WHERE id = ?').get(id) as { finished_at: string | null; note: string | null }
  check('cooldown: no LinkedIn request, round closed with a note', sent === 0 && !!r.finished_at && /soğumada/.test(r.note ?? '') && linkedinCooldownLeft() === 30, { sent, r })
  setSetting('linkedinCooldownUntil', '')
  check('cooldown: cleared value means none', linkedinCooldownLeft() === 0)
} else console.log('SKIP cooldown round (searches.yaml yok)')

// ---- pace carried across rounds: a 429 round doubles the gap, clean rounds ease it back
{
  const { nextPace, PoliteHttp } = await import('../src/http.ts')
  check('pace: 429 round doubles (floor 2, cap 4)', nextPace(1, 40, 1) === 2 && nextPace(1.5, 40, 2) === 3 && nextPace(3, 5, 1) === 4)
  check('pace: clean round eases 20 %, never below 1', nextPace(2, 40, 0) === 1.6 && nextPace(1.1, 40, 0) === 1)
  check('pace: idle round keeps it', nextPace(4, 3, 0) === 4)
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('x', { status: 200 })) as typeof fetch
  const gaps: number[] = []
  const h = new PoliteHttp({ minGapMs: 1000, maxGapMs: 1000, slowFactor: 3, sleep: async (ms) => void gaps.push(ms) })
  await h.get('https://x/a')
  await h.get('https://x/b')
  globalThis.fetch = realFetch
  check('pace: starting factor stretches the gap', gaps.length > 0 && gaps.every((g) => g > 2000 && g <= 3000), gaps)
}

{
  const { linkedinGap } = await import('../src/run.ts')
  const g = (r: string) => JSON.stringify(linkedinGap(r))
  check('gap: "20-40" / "30" / junk', g('20-40') === '{"minGapMs":20000,"maxGapMs":40000}' && g('30') === '{"minGapMs":30000,"maxGapMs":30000}' && g('hızlı') === '{"minGapMs":25000,"maxGapMs":45000}' && g('40-20') === '{"minGapMs":40000,"maxGapMs":40000}')
}

// ---- reposts
check('dupKey: repost prefix and punctuation ignored', dupKey('Acme', 'Business Analyst', 'Ankara, Türkiye') === dupKey('ACME', 'Business Analyst (Yeniden yayınlandı)', 'Ankara'))
check('dupKey: other city is another job', dupKey('Acme', 'Business Analyst', 'Ankara') !== dupKey('Acme', 'Business Analyst', 'İstanbul'))
check('dupKey: no company → null', dupKey(null, 'Business Analyst', 'Ankara') === null)
const repost = { ...card, linkedin_job_id: '4000000002', title: 'Business Analyst' }
const otherCity = { ...card, linkedin_job_id: '4000000003', location: 'İstanbul' }
upsertCard(repost)
upsertCard(otherCity)
check('linkDuplicates links the repost only', linkDuplicates() === 1 && getJob('4000000002')?.dup_of === card.linkedin_job_id && !getJob('4000000003')?.dup_of)
check('linkDuplicates is idempotent', linkDuplicates() === 0)
applyDetail({ linkedin_job_id: card.linkedin_job_id, description_md: 'x'.repeat(200) })
applyDetail({ linkedin_job_id: '4000000002', description_md: 'x'.repeat(200) })
check('repost not queued for scoring', !jobsNeedingScore(100).some((r) => r.linkedin_job_id === '4000000002') && jobsNeedingScore(100).some((r) => r.linkedin_job_id === card.linkedin_job_id))
markClosed(card.linkedin_job_id, 'başvuru kapalı')
check('original closes → repost released', getJob('4000000002')?.dup_of === null)

// ---- delta + stale profile
await new Promise((r) => setTimeout(r, 10))
const mark = new Date().toISOString()
await new Promise((r) => setTimeout(r, 5))
updateUserFields('4000000003', { notes: 'delta' })
const changed = jobsChangedSince(mark).map((r) => r.linkedin_job_id)
check('jobsChangedSince returns only the changed row', changed.includes('4000000003') && !changed.includes(card.linkedin_job_id), changed)
applyDetail({ linkedin_job_id: '4000000003', description_md: 'y'.repeat(200) })
setScore('4000000003', { score: 75, remote_verified: null, workplace: null, seniority_fit: 'match', role_fit: 'core', summary: 's', pros: [], cons: [], red_flags: [], model: 't', profile: 'old' })
check('stale profile found', staleScoredJobs('new', 60, 10).some((r) => r.linkedin_job_id === '4000000003'))
check('current profile not stale', !staleScoredJobs('old', 60, 10).some((r) => r.linkedin_job_id === '4000000003'))

// ---- standalone HTML report
const { buildReport } = await import('../src/report.ts')
const xss = { ...card, linkedin_job_id: '4000000009', title: '<script>alert(1)</script> Analyst', company: 'Evil "Co"', url: 'javascript:alert(1)', location: 'Ankara' }
upsertCard(xss)
applyDetail({ linkedin_job_id: '4000000009', description_md: '**Görev** <img src=x onerror=alert(1)>\n- madde bir\n- madde iki' })
setScore('4000000009', { score: 88, remote_verified: true, workplace: 'remote', seniority_fit: 'match', role_fit: 'core', summary: 'İyi "rol" <b>x</b>', pros: ['artı <i>'], cons: [], red_flags: [], model: 't', profile: 'p' })
const rep = buildReport({ run: { id: 1, started_at: '2000-01-01T00:00:00.000Z', finished_at: null, kind: 'collect', searches: 0, cards: 0, new_jobs: 1, details: 0, scored: 1, researched: 0, requests: 0, rate_limited: 0, errors: 0, note: null, cost_usd: 0.12, claude_calls: 1, claude_ms: 1 }, threshold: 70 })
check('report: ad text is escaped, no live markup', !rep.html.includes('<script>alert') && !rep.html.includes('<img src=x') && !rep.html.includes('<i>') && rep.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
check('report: non-http link dropped', !rep.html.includes('javascript:alert'))
check('report: description markdown rendered safely', rep.html.includes('<b>Görev</b>') && rep.html.includes('<li>madde bir</li>'))
check('report: new good ad counted, repost hidden', rep.counts.newThisRound >= 1 && !rep.html.includes('id="4000000002"'))
check('report: standalone (no external resources)', !/<(link|script)[^>]+(href|src)=/i.test(rep.html) && rep.html.includes('Claude $0.12'))

// ---- score reset keeps the user's decisions and does not resurrect scores from stored facts
upsertCard({ ...card, linkedin_job_id: '4000000020', title: 'Product Owner' })
const facts = { fit: 80, role_fit: 'core', seniority_fit: 'match', people_manager: false, workplace: 'remote', remote_verified: true, english: 'none', salary_below_min: null, employment: 'full_time', agency: false, shift: false, ai_usage: false }
setScore('4000000020', { score: 90, remote_verified: true, workplace: 'remote', seniority_fit: 'match', role_fit: 'core', summary: 's', pros: [], cons: [], red_flags: [], model: 't', profile: 'p', facts: facts as never })
updateUserFields('4000000020', { status: 'applied', notes: 'mülakat salı' })
clearScores()
const cleared = getJob('4000000020')!
check('reset: status and notes stay', cleared.status === 'applied' && cleared.notes === 'mülakat salı', cleared)
check('reset: score, facts and profile dropped', cleared.score === null && cleared.scored_at === null && cleared.facts_json === null && cleared.score_profile === null)
recomputeScores()
check('reset: weight change does not bring the old score back', getJob('4000000020')!.score === null)

// ---- request guard
check('guard: dashboard GET', requestAllowed({ host: 'localhost:4545' }, 'GET', 4545))
check('guard: same-origin POST', requestAllowed({ host: 'localhost:4545', origin: 'http://localhost:4545', 'sec-fetch-site': 'same-origin' }, 'POST', 4545))
check('guard: 127.0.0.1 origin', requestAllowed({ host: '127.0.0.1:4545', origin: 'http://127.0.0.1:4545' }, 'POST', 4545))
check('guard: curl (no origin) POST', requestAllowed({ host: 'localhost:4545' }, 'POST', 4545))
check('guard: rebinding host refused', !requestAllowed({ host: 'evil.example:4545' }, 'GET', 4545))
check('guard: cross-site POST refused', !requestAllowed({ host: 'localhost:4545', origin: 'https://evil.example' }, 'POST', 4545))
check('guard: sec-fetch-site cross-site refused', !requestAllowed({ host: 'localhost:4545', 'sec-fetch-site': 'cross-site' }, 'POST', 4545))
check('guard: other port refused', !requestAllowed({ host: 'localhost:9999' }, 'GET', 4545))

closeDb()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass}/${pass + fail} passed`)
if (fail) process.exit(1)
