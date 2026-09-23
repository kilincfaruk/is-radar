/** SQLite via node:sqlite (built in, no native build on Windows). One DB, one file. */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.ts'
import { dupKey } from './shared/jobs.ts'
import { computeScore, type Facts } from './shared/scoring.ts'

export type JobRow = {
  linkedin_job_id: string
  url: string
  title: string
  company: string | null
  company_url: string | null
  location: string | null
  workplace_type: 'remote' | 'hybrid' | 'onsite' | 'unknown'
  posted_text: string | null
  posted_at: string | null
  easy_apply: number
  applicant_count: number | null
  source: string
  search_keywords: string | null
  criteria_seniority: string | null
  criteria_employment: string | null
  criteria_function: string | null
  criteria_industry: string | null
  description_md: string | null
  description_fetched_at: string | null
  first_seen_at: string
  last_seen_at: string
  seen_count: number
  pre_verdict: string | null
  pre_score: number | null
  pre_json: string | null
  score: number | null
  remote_verified: number | null
  workplace_llm: string | null
  seniority_fit: string | null
  role_fit: string | null
  summary: string | null
  pros_json: string
  cons_json: string
  red_flags_json: string
  scored_at: string | null
  score_model: string | null
  score_error: string | null
  workplace_detail: string | null
  salary_note: string | null
  english_level: string | null
  ai_usage: number | null
  company_research_md: string | null
  company_research_at: string | null
  status: string
  notes: string | null
  applied_at: string | null
  manual_exported_at: string | null
  cv_tips_md?: string | null
  cv_tips_at?: string | null
  closed_at?: string | null
  closed_reason?: string | null
  checked_at?: string | null
  decision_reason?: string | null
  viewed_at?: string | null
  score_profile?: string | null
  decided_at?: string | null
  dup_of?: string | null
  updated_at?: string | null
  facts_json?: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  linkedin_job_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT, company_url TEXT, location TEXT,
  workplace_type TEXT NOT NULL DEFAULT 'unknown',
  posted_text TEXT, posted_at TEXT,
  easy_apply INTEGER NOT NULL DEFAULT 0,
  applicant_count INTEGER,
  source TEXT NOT NULL DEFAULT 'linkedin-guest',
  search_keywords TEXT,
  criteria_seniority TEXT, criteria_employment TEXT, criteria_function TEXT, criteria_industry TEXT,
  description_md TEXT, description_fetched_at TEXT,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1,
  pre_verdict TEXT, pre_score INTEGER, pre_json TEXT,
  score INTEGER, remote_verified INTEGER, workplace_llm TEXT, seniority_fit TEXT, role_fit TEXT, summary TEXT,
  pros_json TEXT NOT NULL DEFAULT '[]', cons_json TEXT NOT NULL DEFAULT '[]', red_flags_json TEXT NOT NULL DEFAULT '[]',
  scored_at TEXT, score_model TEXT, score_error TEXT,
  company_research_md TEXT, company_research_at TEXT,
  status TEXT NOT NULL DEFAULT 'new', notes TEXT, applied_at TEXT, manual_exported_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_score ON jobs(score);
CREATE INDEX IF NOT EXISTS jobs_pre_score ON jobs(pre_score);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen_at);
CREATE INDEX IF NOT EXISTS jobs_needs_desc ON jobs(description_fetched_at);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL, finished_at TEXT,
  kind TEXT NOT NULL DEFAULT 'collect',
  searches INTEGER DEFAULT 0, cards INTEGER DEFAULT 0, new_jobs INTEGER DEFAULT 0,
  details INTEGER DEFAULT 0, scored INTEGER DEFAULT 0, researched INTEGER DEFAULT 0,
  requests INTEGER DEFAULT 0, rate_limited INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
  note TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

let db: DatabaseSync | null = null

/** Tests: close the singleton so another file can be opened. */
export function closeDb(): void {
  db?.close()
  db = null
}

export function openDb(file = path.join(DATA_DIR, 'is-radar.db')): DatabaseSync {
  if (db) return db
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** One-shot data migrations, tracked in settings.migration. */
/** Schema version this code expects. Each block below is idempotent (column checks), so a re-run is harmless. */
export const LATEST_MIGRATION = 8

function addColumns(d: DatabaseSync, table: string, cols: Array<[string, string]>): void {
  const have = new Set((d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
  for (const [name, type] of cols) if (!have.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}

/** One-shot data migrations, tracked in settings.migration (written once, at the end, as LATEST_MIGRATION). */
function migrate(d: DatabaseSync): void {
  const row = d.prepare("SELECT value FROM settings WHERE key = 'migration'").get() as { value: string } | undefined
  const v = row ? Number(row.value) : 0
  if (v >= LATEST_MIGRATION) return
  if (v < 1) {
    // v1: the guest search ignores f_WT, so every workplace label we stored from it was noise.
    // Reset labels; where the text was silent (remote_verified NULL) the LLM's workplace came from that label too.
    d.exec(`UPDATE jobs SET workplace_type = 'unknown' WHERE source = 'linkedin-guest';
            UPDATE jobs SET workplace_llm = 'unknown' WHERE source = 'linkedin-guest' AND remote_verified IS NULL AND workplace_llm IS NOT NULL;`)
  }
  // v2: LLM extras (hybrid pattern, salary, english level, AI usage)
  if (v < 2) addColumns(d, 'jobs', [['workplace_detail', 'TEXT'], ['salary_note', 'TEXT'], ['english_level', 'TEXT'], ['ai_usage', 'INTEGER']])
  // v3: per-ad CV advice
  if (v < 3) addColumns(d, 'jobs', [['cv_tips_md', 'TEXT'], ['cv_tips_at', 'TEXT']])
  // v4: liveness (closed / last checked)
  if (v < 4) addColumns(d, 'jobs', [['closed_at', 'TEXT'], ['closed_reason', 'TEXT'], ['checked_at', 'TEXT']])
  // v5: why the user ignored/rejected an ad (one-tap reason)
  if (v < 5) addColumns(d, 'jobs', [['decision_reason', 'TEXT']])
  // v6: when the user first opened the ad in the dashboard (unread marker)
  if (v < 6) addColumns(d, 'jobs', [['viewed_at', 'TEXT']])
  // v7: Claude usage per round (cost as the CLI reports it, calls, wall time)
  if (v < 7) addColumns(d, 'runs', [['cost_usd', 'REAL'], ['claude_calls', 'INTEGER'], ['claude_ms', 'INTEGER']])
  if (v < 8) {
    // v8: profile version per score, decision time, repost link, change stamp (dashboard delta sync), structured LLM facts
    addColumns(d, 'jobs', [['score_profile', 'TEXT'], ['decided_at', 'TEXT'], ['dup_of', 'TEXT'], ['updated_at', 'TEXT'], ['facts_json', 'TEXT']])
    d.exec(`UPDATE jobs SET decided_at = COALESCE(applied_at, viewed_at, last_seen_at) WHERE status != 'new' AND decided_at IS NULL;
            UPDATE jobs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE updated_at IS NULL;
            CREATE INDEX IF NOT EXISTS jobs_updated ON jobs(updated_at);
            CREATE INDEX IF NOT EXISTS jobs_dup ON jobs(dup_of);
            CREATE TRIGGER IF NOT EXISTS jobs_touch_upd AFTER UPDATE ON jobs FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at
              BEGIN UPDATE jobs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE linkedin_job_id = NEW.linkedin_job_id; END;
            CREATE TRIGGER IF NOT EXISTS jobs_touch_ins AFTER INSERT ON jobs FOR EACH ROW WHEN NEW.updated_at IS NULL
              BEGIN UPDATE jobs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE linkedin_job_id = NEW.linkedin_job_id; END;`)
  }
  d.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('migration', ?)").run(String(LATEST_MIGRATION))
}

export function nowIso(): string {
  return new Date().toISOString()
}

// ---------- jobs ----------

export type CardInput = {
  linkedin_job_id: string
  url: string
  title: string
  company: string | null
  company_url: string | null
  location: string | null
  workplace_type: JobRow['workplace_type']
  posted_text: string | null
  posted_at: string | null
  easy_apply?: boolean
  applicant_count?: number | null
  source: string
  search_keywords?: string | null
}

/** Insert or refresh a card. Returns true when the row is new. User fields are never touched. */
export function upsertCard(c: CardInput, bumpSeen = true): boolean {
  const d = openDb()
  const now = nowIso()
  const existing = d.prepare('SELECT linkedin_job_id, workplace_type, posted_at FROM jobs WHERE linkedin_job_id = ?').get(c.linkedin_job_id) as
    | { workplace_type: string; posted_at: string | null }
    | undefined
  if (!existing) {
    d.prepare(
      `INSERT INTO jobs (linkedin_job_id,url,title,company,company_url,location,workplace_type,posted_text,posted_at,easy_apply,applicant_count,source,search_keywords,first_seen_at,last_seen_at,seen_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      c.linkedin_job_id, c.url, c.title, c.company, c.company_url, c.location, c.workplace_type, c.posted_text, c.posted_at,
      c.easy_apply ? 1 : 0, c.applicant_count ?? null, c.source, c.search_keywords ?? null, now, now, bumpSeen ? 1 : 0,
    )
    return true
  }
  // workplace label: a specific label (extension DOM) beats 'unknown' (guest search); the text-based rules/LLM decide the truth later
  const rank: Record<string, number> = { unknown: 0, onsite: 1, hybrid: 2, remote: 3 }
  const wt = (rank[c.workplace_type] ?? 0) > (rank[existing.workplace_type] ?? 0) ? c.workplace_type : existing.workplace_type
  d.prepare(
    `UPDATE jobs SET
       title = CASE WHEN ? != '' THEN ? ELSE title END,
       company = COALESCE(?, company), company_url = COALESCE(?, company_url), location = COALESCE(?, location),
       workplace_type = ?, posted_text = COALESCE(?, posted_text), posted_at = COALESCE(?, posted_at),
       easy_apply = MAX(easy_apply, ?), applicant_count = COALESCE(?, applicant_count),
       search_keywords = COALESCE(search_keywords, ?),
       last_seen_at = CASE WHEN ? THEN ? ELSE last_seen_at END,
       seen_count = seen_count + ?
     WHERE linkedin_job_id = ?`,
  ).run(
    c.title, c.title, c.company, c.company_url, c.location, wt, c.posted_text, c.posted_at, c.easy_apply ? 1 : 0, c.applicant_count ?? null,
    c.search_keywords ?? null, bumpSeen ? 1 : 0, now, bumpSeen ? 1 : 0, c.linkedin_job_id,
  )
  return false
}

export type DetailInput = {
  linkedin_job_id: string
  title?: string | null
  company?: string | null
  company_url?: string | null
  location?: string | null
  posted_text?: string | null
  applicant_count?: number | null
  criteria?: { seniority?: string | null; employment?: string | null; func?: string | null; industry?: string | null }
  description_md: string
}

/** Description written only when empty (or job unscored and new text ≥20% longer). First fill resets LLM fields. */
export function applyDetail(dt: DetailInput): boolean {
  const d = openDb()
  const row = d.prepare('SELECT description_md, scored_at FROM jobs WHERE linkedin_job_id = ?').get(dt.linkedin_job_id) as { description_md: string | null; scored_at: string | null } | undefined
  if (!row) return false
  const cur = row.description_md?.trim() || ''
  const inc = dt.description_md.trim()
  const c = dt.criteria || {}
  d.prepare(
    `UPDATE jobs SET title = COALESCE(NULLIF(?, ''), title), company = COALESCE(?, company), company_url = COALESCE(?, company_url),
       location = COALESCE(?, location), posted_text = COALESCE(?, posted_text), applicant_count = COALESCE(?, applicant_count),
       criteria_seniority = COALESCE(?, criteria_seniority), criteria_employment = COALESCE(?, criteria_employment),
       criteria_function = COALESCE(?, criteria_function), criteria_industry = COALESCE(?, criteria_industry)
     WHERE linkedin_job_id = ?`,
  ).run(dt.title ?? '', dt.company ?? null, dt.company_url ?? null, dt.location ?? null, dt.posted_text ?? null, dt.applicant_count ?? null,
    c.seniority ?? null, c.employment ?? null, c.func ?? null, c.industry ?? null, dt.linkedin_job_id)
  const replaceLonger = cur && !row.scored_at && inc.length > cur.length * 1.2
  if (!cur || replaceLonger) {
    d.prepare(
      `UPDATE jobs SET description_md = ?, description_fetched_at = ?,
         score = NULL, scored_at = NULL, summary = NULL, pros_json = '[]', cons_json = '[]', red_flags_json = '[]',
         remote_verified = NULL, workplace_llm = NULL, seniority_fit = NULL, role_fit = NULL, score_error = NULL, score_model = NULL,
         facts_json = NULL, score_profile = NULL, pre_verdict = NULL, pre_score = NULL, pre_json = NULL
       WHERE linkedin_job_id = ?`,
    ).run(inc, nowIso(), dt.linkedin_job_id)
    return true
  }
  return false
}

export function markDescriptionMissing(id: string, reason: string): void {
  // remember the attempt so we don't retry every round; keep the reason in score_error-like field
  openDb().prepare(`UPDATE jobs SET description_fetched_at = ?, description_md = NULL, score_error = ? WHERE linkedin_job_id = ?`).run('failed:' + nowIso(), reason, id)
}

export function jobsNeedingDescription(limit: number): JobRow[] {
  return openDb()
    .prepare(`SELECT * FROM jobs WHERE dup_of IS NULL AND source = 'linkedin-guest' AND (description_md IS NULL OR description_md = '') AND (description_fetched_at IS NULL OR (description_fetched_at NOT LIKE 'failed:%' AND description_fetched_at NOT LIKE 'skipped:%')) ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?`)
    .all(limit) as unknown as JobRow[]
}

/** Rows the title gate skipped (title only), so a later gate / dictionary change can release them. */
export function skippedJobs(): Array<{ linkedin_job_id: string; title: string }> {
  return openDb().prepare(`SELECT linkedin_job_id, title FROM jobs WHERE description_fetched_at LIKE 'skipped:%'`).all() as Array<{ linkedin_job_id: string; title: string }>
}
export function releaseSkipped(id: string): void {
  openDb().prepare(`UPDATE jobs SET description_fetched_at = NULL, pre_verdict = NULL, pre_score = NULL, pre_json = NULL WHERE linkedin_job_id = ?`).run(id)
}

/** Title gate decided not to spend a request on this one. Reversible: clear description_fetched_at. */
export function markDescriptionSkipped(id: string, reason: string): void {
  openDb().prepare(`UPDATE jobs SET description_fetched_at = ? WHERE linkedin_job_id = ?`).run('skipped:' + reason, id)
}

/** Rows with text but no prescreen, or a prescreen computed by an older rule version. */
export function jobsNeedingPrescreen(version = 0): JobRow[] {
  return openDb()
    .prepare(
      `SELECT * FROM jobs WHERE description_md IS NOT NULL AND description_md != ''
         AND (pre_json IS NULL OR COALESCE(json_extract(pre_json, '$.v'), 0) < ?)`,
    )
    .all(version) as unknown as JobRow[]
}

/** Every id in the table (cheap: ids only). Used by incremental sweeps to stop paging early. */
/** Most recent full sweep (last 3 days) that got through all searches, finished or not. */
export function lastCompletedFullSearch(searchCount: number): RunRow | null {
  return (openDb()
    .prepare(`SELECT * FROM runs WHERE kind = 'collect-full' AND searches >= ? AND started_at > datetime('now', '-3 days') ORDER BY id DESC LIMIT 1`)
    .get(Math.max(1, searchCount)) as unknown as RunRow | undefined) ?? null
}

export function knownJobIds(): Set<string> {
  return new Set((openDb().prepare('SELECT linkedin_job_id FROM jobs').all() as Array<{ linkedin_job_id: string }>).map((r) => r.linkedin_job_id))
}

/** Scored ≥ minScore by a model other than `topTag` (e.g. 'claude-cli/opus'), newest score first. */
export function jobsNeedingTopScore(minScore: number, topTag: string, limit: number, maxScore = 100): JobRow[] {
  return openDb()
    .prepare(`SELECT * FROM jobs WHERE dup_of IS NULL AND score IS NOT NULL AND score <= ? AND (score >= ? OR COALESCE(json_extract(facts_json, '$.fit'), 0) >= ?) AND (score_model IS NULL OR score_model != ?) AND score_error IS NULL AND closed_at IS NULL AND status NOT IN ('rejected','ignored') ORDER BY score DESC, scored_at DESC LIMIT ?`)
    .all(maxScore, minScore, minScore + 10, topTag, limit) as unknown as JobRow[]
}

export function jobsNeedingScore(limit: number, includeRejects = false): JobRow[] {
  const where = includeRejects ? '' : "AND (pre_verdict IS NULL OR pre_verdict != 'reject')"
  return openDb()
    .prepare(`SELECT * FROM jobs WHERE dup_of IS NULL AND description_md IS NOT NULL AND description_md != '' AND scored_at IS NULL AND (score_error IS NULL) AND status NOT IN ('rejected','ignored') ${where} ORDER BY COALESCE(pre_score, 0) DESC, COALESCE(posted_at, first_seen_at) DESC LIMIT ?`)
    .all(limit) as unknown as JobRow[]
}

export function jobsNeedingResearch(minScore: number, limit: number): JobRow[] {
  return openDb()
    .prepare(`SELECT * FROM jobs WHERE dup_of IS NULL AND score IS NOT NULL AND score >= ? AND company_research_md IS NULL AND status NOT IN ('rejected','ignored') ORDER BY score DESC LIMIT ?`)
    .all(minScore, limit) as unknown as JobRow[]
}

export function setPrescreen(id: string, verdict: string, score: number, json: unknown): void {
  openDb().prepare(`UPDATE jobs SET pre_verdict = ?, pre_score = ?, pre_json = ? WHERE linkedin_job_id = ?`).run(verdict, score, JSON.stringify(json), id)
}

/** Consistent copy of the live DB (WAL-safe) into data/backups/. Returns the file path. */
export function backupDb(): string {
  const d = openDb()
  const dir = path.join(DATA_DIR, 'backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
  const file = path.join(dir, `is-radar-${stamp}.db`)
  d.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  return file
}

/** Drop every LLM result and rule verdict; jobs, texts, status and notes stay. */
export function clearScores(): void {
  openDb().exec(`UPDATE jobs SET score = NULL, scored_at = NULL, score_model = NULL, score_error = NULL, summary = NULL,
    pros_json = '[]', cons_json = '[]', red_flags_json = '[]', remote_verified = NULL, workplace_llm = NULL,
    seniority_fit = NULL, role_fit = NULL, workplace_detail = NULL, salary_note = NULL, english_level = NULL, ai_usage = NULL`)
  // rule verdicts are recomputed from the text; rows the title gate rejected without text keep theirs
  openDb().exec(`UPDATE jobs SET pre_verdict = NULL, pre_score = NULL, pre_json = NULL WHERE description_md IS NOT NULL AND description_md != ''`)
}

/** Also forget the fetched texts (they will be re-fetched, request budget permitting). */
export function clearTexts(): void {
  openDb().exec(`UPDATE jobs SET description_md = NULL, description_fetched_at = NULL`)
}

/** Empty the jobs and runs tables (settings/migration flags stay). */
export function clearAll(): void {
  openDb().exec(`DELETE FROM jobs; DELETE FROM runs; DELETE FROM settings WHERE key IN ('lastFullRunAt', 'lastRunStartedAt');`)
}

export function clearPrescreens(): void {
  openDb().exec(`UPDATE jobs SET pre_verdict = NULL, pre_score = NULL, pre_json = NULL`)
}

export function setScore(
  id: string,
  s: { score: number; remote_verified: boolean | null; workplace: string | null; seniority_fit: string; role_fit: string; summary: string; pros: string[]; cons: string[]; red_flags: string[]; model: string; workplace_detail?: string | null; salary_note?: string | null; english_level?: string | null; ai_usage?: boolean | null; profile?: string | null; facts?: unknown },
): void {
  openDb()
    .prepare(
      `UPDATE jobs SET score=?, remote_verified=?, workplace_llm=?, seniority_fit=?, role_fit=?, summary=?, pros_json=?, cons_json=?, red_flags_json=?, scored_at=?, score_model=?, score_error=NULL,
         workplace_detail=?, salary_note=?, english_level=?, ai_usage=?, score_profile=?, facts_json=? WHERE linkedin_job_id=?`,
    )
    .run(s.score, s.remote_verified === null ? null : s.remote_verified ? 1 : 0, s.workplace, s.seniority_fit, s.role_fit, s.summary, JSON.stringify(s.pros), JSON.stringify(s.cons), JSON.stringify(s.red_flags), nowIso(), s.model,
      s.workplace_detail ?? null, s.salary_note ?? null, s.english_level ?? null, s.ai_usage === null || s.ai_usage === undefined ? null : s.ai_usage ? 1 : 0, s.profile ?? null, s.facts === undefined ? null : JSON.stringify(s.facts), id)
}

/** Forget standing score errors so those rows re-enter the scoring queue. Returns how many. */
export function clearScoreErrors(): number {
  const d = openDb()
  const n = (d.prepare('SELECT COUNT(*) n FROM jobs WHERE score_error IS NOT NULL AND scored_at IS NULL').get() as { n: number }).n
  d.exec('UPDATE jobs SET score_error = NULL WHERE score_error IS NOT NULL AND scored_at IS NULL')
  return n
}

export function setScoreError(id: string, err: string): void {
  openDb().prepare(`UPDATE jobs SET score_error = ? WHERE linkedin_job_id = ?`).run(err, id)
}

export function resetScore(id: string): void {
  openDb().prepare(`UPDATE jobs SET score=NULL, scored_at=NULL, score_error=NULL WHERE linkedin_job_id = ?`).run(id)
}

export function markClosed(id: string, reason: string): void {
  const d = openDb()
  d.prepare(`UPDATE jobs SET closed_at = COALESCE(closed_at, ?), closed_reason = ?, checked_at = ? WHERE linkedin_job_id = ?`).run(nowIso(), reason, nowIso(), id)
  // the original closed: its reposts are live postings in their own right now
  d.prepare(`UPDATE jobs SET dup_of = NULL WHERE dup_of = ?`).run(id)
}
export function markChecked(id: string): void {
  openDb().prepare(`UPDATE jobs SET checked_at = ?, closed_at = NULL, closed_reason = NULL WHERE linkedin_job_id = ?`).run(nowIso(), id)
}
/**
 * Ads worth re-checking for closure: anything the user is pursuing (shortlist/applied/interviewing) or an
 * unread-but-good one (new, score ≥ minScore). Never checked, or checked more than `staleDays` ago, oldest first.
 */
export function jobsNeedingLivenessCheck(limit: number, minScore: number, staleDays = 3): JobRow[] {
  const cutoff = new Date(Date.now() - staleDays * 86_400_000).toISOString()
  return openDb()
    .prepare(
      `SELECT * FROM jobs WHERE dup_of IS NULL AND source = 'linkedin-guest' AND closed_at IS NULL AND (checked_at IS NULL OR checked_at < ?)
         AND (status IN ('shortlist','applied','interviewing') OR (status = 'new' AND score IS NOT NULL AND score >= ?))
       ORDER BY CASE status WHEN 'interviewing' THEN 0 WHEN 'applied' THEN 1 WHEN 'shortlist' THEN 2 ELSE 3 END, COALESCE(checked_at, '') ASC LIMIT ?`,
    )
    .all(cutoff, minScore, limit) as unknown as JobRow[]
}

/** Scored ads the user decided on (positives and negatives), newest decision first-ish, for the criteria review. */
export function decidedScoredJobs(limit: number): JobRow[] {
  return openDb().prepare(`SELECT * FROM jobs WHERE scored_at IS NOT NULL AND status != 'new' ORDER BY COALESCE(decided_at, applied_at, last_seen_at) DESC LIMIT ?`).all(limit) as unknown as JobRow[]
}

export function setCvTips(id: string, md: string): void {
  openDb().prepare(`UPDATE jobs SET cv_tips_md = ?, cv_tips_at = ? WHERE linkedin_job_id = ?`).run(md, nowIso(), id)
}

/** Best-scoring ads with text, for the cross-cutting CV review. */
export function topScoredJobs(limit: number, minScore = 0): JobRow[] {
  return openDb().prepare(`SELECT * FROM jobs WHERE scored_at IS NOT NULL AND score >= ? AND description_md IS NOT NULL AND status NOT IN ('rejected','ignored') ORDER BY score DESC LIMIT ?`).all(minScore, limit) as unknown as JobRow[]
}

export function setResearch(id: string, md: string): void {
  openDb().prepare(`UPDATE jobs SET company_research_md = ?, company_research_at = ? WHERE linkedin_job_id = ?`).run(md, nowIso(), id)
}

export function getJob(id: string): JobRow | undefined {
  return openDb().prepare('SELECT * FROM jobs WHERE linkedin_job_id = ?').get(id) as unknown as JobRow | undefined
}

export function allJobs(): JobRow[] {
  return openDb().prepare('SELECT * FROM jobs ORDER BY COALESCE(posted_at, first_seen_at) DESC').all() as unknown as JobRow[]
}

export function updateUserFields(id: string, f: { status?: string; notes?: string | null; applied_at?: string | null; manual_exported_at?: string | null; decision_reason?: string | null; viewed_at?: string | null; decided_at?: string | null }): JobRow | undefined {
  const d = openDb()
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  if (sets.length) {
    vals.push(id)
    d.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE linkedin_job_id = ?`).run(...(vals as (string | null)[]))
  }
  return getJob(id)
}

/**
 * Link reposts: within the last 60 days, open ads sharing company + title + city form a group; the ad the user already
 * acted on (else the first seen) is the original, the other untouched ones point at it via dup_of and drop out of every
 * work queue (no detail request, no scoring). Returns how many were newly linked.
 */
export function linkDuplicates(): number {
  const d = openDb()
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString()
  const rows = d
    .prepare(`SELECT linkedin_job_id id, company, title, location, status, first_seen_at, dup_of FROM jobs WHERE closed_at IS NULL AND first_seen_at > ? ORDER BY first_seen_at ASC`)
    .all(since) as Array<{ id: string; company: string | null; title: string; location: string | null; status: string; first_seen_at: string; dup_of: string | null }>
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = dupKey(r.company, r.title, r.location)
    if (!k) continue
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const set = d.prepare('UPDATE jobs SET dup_of = ? WHERE linkedin_job_id = ?')
  let n = 0
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const original = g.find((r) => r.status !== 'new') ?? g.find((r) => !r.dup_of) ?? g[0]
    for (const r of g) {
      if (r.id === original.id) {
        if (r.dup_of) set.run(null, r.id)
        continue
      }
      if (r.status !== 'new' || r.dup_of === original.id) continue
      set.run(original.id, r.id)
      n++
    }
  }
  return n
}

/** Board poll succeeded: postings of this board that are no longer listed get closed. Returns how many. */
export function closeMissingFromBoard(idPrefix: string, listed: Set<string>): number {
  const d = openDb()
  const rows = d.prepare(`SELECT linkedin_job_id id FROM jobs WHERE linkedin_job_id LIKE ? AND closed_at IS NULL`).all(idPrefix + '%') as Array<{ id: string }>
  let n = 0
  for (const r of rows) {
    if (listed.has(r.id)) continue
    markClosed(r.id, 'şirket panosundan kalktı')
    n++
  }
  return n
}

/** Scored ads whose score came from another profile (or before profiles were tracked), best first. */
export function staleScoredJobs(profile: string, minScore: number, limit: number): JobRow[] {
  return openDb()
    .prepare(`SELECT * FROM jobs WHERE dup_of IS NULL AND closed_at IS NULL AND scored_at IS NOT NULL AND score >= ? AND status IN ('new','shortlist') AND description_md IS NOT NULL AND (score_profile IS NULL OR score_profile != ?) ORDER BY score DESC LIMIT ?`)
    .all(minScore, profile, limit) as unknown as JobRow[]
}

/** Re-apply the current weights to every score that has stored facts (no LLM call). Returns how many changed. */
export function recomputeScores(): number {
  const d = openDb()
  const rows = d.prepare('SELECT linkedin_job_id id, facts_json, location, score FROM jobs WHERE facts_json IS NOT NULL').all() as Array<{ id: string; facts_json: string; location: string | null; score: number | null }>
  const set = d.prepare('UPDATE jobs SET score = ? WHERE linkedin_job_id = ?')
  let n = 0
  for (const r of rows) {
    try {
      const s = computeScore(JSON.parse(r.facts_json) as Facts, { location: r.location }).score
      if (s !== r.score) {
        set.run(s, r.id)
        n++
      }
    } catch {
      /* malformed facts: leave the stored score */
    }
  }
  return n
}

/** Rows changed at or after `since` (updated_at is kept by triggers), for the dashboard's delta sync. */
export function jobsChangedSince(since: string): JobRow[] {
  return openDb().prepare('SELECT * FROM jobs WHERE updated_at >= ? ORDER BY COALESCE(posted_at, first_seen_at) DESC').all(since) as unknown as JobRow[]
}

export function deleteJob(id: string): void {
  openDb().prepare('DELETE FROM jobs WHERE linkedin_job_id = ?').run(id)
}

export type UsageTotal = { calls: number; failures: number; costUsd: number; ms: number; since: string }

/** All-time Claude usage (rounds + dashboard actions), kept in settings. */
export function usageTotal(): UsageTotal {
  const raw = getSetting('claudeUsage')
  if (raw) {
    try {
      const u = JSON.parse(raw) as Partial<UsageTotal>
      return { calls: u.calls ?? 0, failures: u.failures ?? 0, costUsd: u.costUsd ?? 0, ms: u.ms ?? 0, since: u.since ?? nowIso() }
    } catch {
      /* fallthrough */
    }
  }
  return { calls: 0, failures: 0, costUsd: 0, ms: 0, since: nowIso() }
}

export function bumpUsage(delta: { calls: number; failures: number; costUsd: number; ms: number }): void {
  const u = usageTotal()
  u.calls += delta.calls
  u.failures += delta.failures
  u.costUsd = +(u.costUsd + delta.costUsd).toFixed(4)
  u.ms += delta.ms
  setSetting('claudeUsage', JSON.stringify(u))
}

export function stats(): { total: number; withDescription: number; scored: number; preCandidates: number; preRejects: number; lastRun: RunRow | null; usage: UsageTotal; usage7d: { costUsd: number; calls: number; runs: number } } {
  const d = openDb()
  const one = (sql: string) => (d.prepare(sql).get() as { c: number }).c
  const week = d.prepare("SELECT COALESCE(SUM(cost_usd), 0) cost, COALESCE(SUM(claude_calls), 0) calls, COUNT(*) runs FROM runs WHERE started_at > datetime('now', '-7 days')").get() as { cost: number; calls: number; runs: number }
  return {
    usage: usageTotal(),
    usage7d: { costUsd: +Number(week.cost).toFixed(4), calls: Number(week.calls), runs: Number(week.runs) },
    total: one('SELECT COUNT(*) c FROM jobs'),
    withDescription: one("SELECT COUNT(*) c FROM jobs WHERE description_md IS NOT NULL AND description_md != ''"),
    scored: one('SELECT COUNT(*) c FROM jobs WHERE scored_at IS NOT NULL'),
    preCandidates: one("SELECT COUNT(*) c FROM jobs WHERE pre_verdict = 'candidate'"),
    preRejects: one("SELECT COUNT(*) c FROM jobs WHERE pre_verdict = 'reject'"),
    lastRun: (d.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as unknown as RunRow) ?? null,
  }
}

// ---------- runs ----------

export type RunRow = {
  id: number
  started_at: string
  finished_at: string | null
  kind: string
  searches: number
  cards: number
  new_jobs: number
  details: number
  scored: number
  researched: number
  requests: number
  rate_limited: number
  errors: number
  note: string | null
  cost_usd: number | null
  claude_calls: number | null
  claude_ms: number | null
}

export function startRun(kind: string): number {
  const r = openDb().prepare('INSERT INTO runs (started_at, kind) VALUES (?, ?)').run(nowIso(), kind)
  return Number(r.lastInsertRowid)
}

export function updateRun(id: number, patch: Partial<RunRow>): void {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || v === undefined) continue
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  if (!sets.length) return
  vals.push(id)
  openDb().prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as (string | number | null)[]))
}

/** Rounds left open by a process that died mid-round: close them so they stop looking "in progress". */
export function closeStaleRuns(): number {
  const r = openDb().prepare(`UPDATE runs SET finished_at = started_at, note = COALESCE(note, 'yarım kaldı (collector kapandı)') WHERE finished_at IS NULL`).run()
  return Number(r.changes)
}

export function recentRuns(limit = 20): RunRow[] {
  return openDb().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit) as unknown as RunRow[]
}

// ---------- settings ----------

export function getSetting(key: string): string | null {
  const r = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return r ? r.value : null
}

export function setSetting(key: string, value: string): void {
  openDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
