/** Imports a v2 extension backup JSON (is-radar-backup-*.json) into SQLite. User fields win over existing rows only when the row is untouched. */
import fs from 'node:fs'
import { openDb, nowIso } from './db.ts'
import { log } from './log.ts'

type V2Job = Record<string, unknown> & { linkedinJobId: string }

export function importBackup(file: string): { inserted: number; updated: number } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { app?: string; jobs?: V2Job[] }
  if (raw.app !== 'is-radar' || !Array.isArray(raw.jobs)) throw new Error('is-radar yedeği değil')
  const d = openDb()
  let inserted = 0
  let updated = 0
  const ins = d.prepare(`INSERT INTO jobs (linkedin_job_id,url,title,company,company_url,location,workplace_type,posted_text,posted_at,easy_apply,applicant_count,source,description_md,description_fetched_at,first_seen_at,last_seen_at,seen_count,score,remote_verified,seniority_fit,role_fit,summary,pros_json,cons_json,red_flags_json,scored_at,score_model,score_error,status,notes,applied_at,manual_exported_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const upd = d.prepare(`UPDATE jobs SET description_md = COALESCE(description_md, ?), description_fetched_at = COALESCE(description_fetched_at, ?),
    status = CASE WHEN status = 'new' AND notes IS NULL THEN ? ELSE status END, notes = COALESCE(notes, ?), applied_at = COALESCE(applied_at, ?),
    seen_count = MAX(seen_count, ?), first_seen_at = MIN(first_seen_at, ?) WHERE linkedin_job_id = ?`)
  const s = (v: unknown) => (typeof v === 'string' ? v : null)
  const n = (v: unknown) => (typeof v === 'number' ? v : null)
  const arr = (v: unknown) => JSON.stringify(Array.isArray(v) ? v : [])
  const tx = d.prepare('SELECT 1 FROM jobs WHERE linkedin_job_id = ?')
  d.exec('BEGIN')
  try {
    for (const j of raw.jobs) {
      if (!j.linkedinJobId) continue
      const exists = tx.get(j.linkedinJobId)
      const desc = s(j.descriptionMd)
      if (!exists) {
        ins.run(
          j.linkedinJobId, s(j.url) ?? `https://www.linkedin.com/jobs/view/${j.linkedinJobId}/`, s(j.title) ?? '(başlık yok)', s(j.company), s(j.companyUrl), s(j.location),
          s(j.workplaceType) ?? 'unknown', s(j.postedText), s(j.postedAt), j.easyApply ? 1 : 0, n(j.applicantCount), 'extension',
          desc, desc ? (s(j.descriptionFetchedAt) ?? nowIso()) : null, s(j.firstSeenAt) ?? nowIso(), s(j.lastSeenAt) ?? nowIso(), n(j.seenCount) ?? 1,
          n(j.score), j.remoteVerified === null || j.remoteVerified === undefined ? null : j.remoteVerified ? 1 : 0, s(j.seniorityFit), s(j.roleFit), s(j.summary),
          arr(j.pros), arr(j.cons), arr(j.redFlags), s(j.scoredAt), s(j.scoreModel), s(j.scoreError), s(j.status) ?? 'new', s(j.notes), s(j.appliedAt), s(j.manualExportedAt),
        )
        inserted++
      } else {
        upd.run(desc, desc ? (s(j.descriptionFetchedAt) ?? nowIso()) : null, s(j.status) ?? 'new', s(j.notes), s(j.appliedAt), n(j.seenCount) ?? 1, s(j.firstSeenAt) ?? nowIso(), j.linkedinJobId)
        updated++
      }
    }
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  log.info(`import: ${inserted} yeni, ${updated} güncellendi`)
  return { inserted, updated }
}
