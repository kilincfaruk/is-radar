/** DB migrations, change stamps, round bookkeeping, request guard. Runs against a throwaway SQLite file. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.SCORER = 'none'
process.env.TELEGRAM_BOT_TOKEN = ''
const { openDb, closeDb, LATEST_MIGRATION, upsertCard, closeStaleRuns, startRun, recentRuns, getJob, updateUserFields, linkDuplicates, markClosed, jobsChangedSince, staleScoredJobs, setScore, jobsNeedingScore, applyDetail } = await import('../src/db.ts')
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
