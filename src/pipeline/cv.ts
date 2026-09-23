/** CV tooling on top of the same claude -p path: per-ad tailoring tips and a cross-cutting review over the best ads. */
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { CV_REVIEW_SYSTEM, CV_TIPS_JSON_SCHEMA, CV_TIPS_SYSTEM, CRITERIA_REVIEW_SYSTEM } from '../shared/prompt.ts'
import { runClaude, runClaudeText } from './claude-cli.ts'
import { readAbout, readCriteria, readCv } from './profile.ts'
import { topModel } from './score.ts'
import { DATA_DIR } from '../config.ts'
import { setCvTips, topScoredJobs, decidedScoredJobs, type JobRow } from '../db.ts'
import { log } from '../log.ts'

const TipsSchema = z.object({
  fit_line: z.string().min(10),
  foreground: z.array(z.string()),
  rewrites: z.array(z.object({ original: z.string(), suggested: z.string(), why: z.string() })),
  missing: z.array(z.string()),
  avoid: z.array(z.string()),
})

export function tipsToMarkdown(t: z.infer<typeof TipsSchema>): string {
  const li = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
  return [
    `**Konumlanma:** ${t.fit_line}`,
    t.foreground.length ? `**Öne çek**\n${li(t.foreground)}` : '',
    t.rewrites.length ? `**Yeniden yaz**\n${t.rewrites.map((r) => `- ~~${r.original}~~\n  → ${r.suggested}\n  _${r.why}_`).join('\n')}` : '',
    t.missing.length ? `**İlanda var, CV'de yok**\n${li(t.missing)}` : '',
    t.avoid.length ? `**Geri çek**\n${li(t.avoid)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function cvTipsOne(r: JobRow): Promise<{ ok: true; md: string } | { ok: false; error: string }> {
  if (!r.description_md) return { ok: false, error: 'ilan metni yok' }
  const about = readAbout()
  const user = `=== ADAYIN CV'Sİ ===\n${readCv().trim()}${about ? `\n\n=== ADAY HAKKINDA ===\n${about.trim()}` : ''}\n\n=== İLAN ===\nBaşlık: ${r.title}\nŞirket: ${r.company ?? '(bilinmiyor)'}\nLokasyon: ${r.location ?? '-'}\n\n${r.description_md.trim()}\n\nCV'yi bu ilana göre uyarlamak için JSON döndür.`
  const res = await runClaude<unknown>({ system: CV_TIPS_SYSTEM, user, schema: CV_TIPS_JSON_SCHEMA, tools: [], timeoutMs: 240_000, model: topModel(), label: 'CV ipuçları' })
  if (!res.ok) return { ok: false, error: res.error }
  const p = TipsSchema.safeParse(res.data)
  if (!p.success) return { ok: false, error: 'şema: ' + p.error.issues[0]?.message }
  const md = tipsToMarkdown(p.data)
  setCvTips(r.linkedin_job_id, md)
  log.info(`CV ipuçları: ${r.title.slice(0, 50)} @ ${r.company ?? '?'}`)
  return { ok: true, md }
}

export const CV_REVIEW_FILE = path.join(DATA_DIR, 'cv-review.md')

/** One call over the top N ads; writes data/cv-review.md and returns it. */
export async function cvReview(limit = 15, minScore = 0): Promise<{ ok: true; md: string; jobs: number } | { ok: false; error: string }> {
  const rows = topScoredJobs(limit, minScore)
  if (rows.length < 3) return { ok: false, error: `yeterli skorlu ilan yok (${rows.length}); önce skorla` }
  const about = readAbout()
  const ads = rows.map((r, i) => `##### İLAN ${i + 1} · skor ${r.score} · ${r.title} @ ${r.company ?? '?'} · ${r.location ?? '-'}\n${(r.description_md ?? '').trim().slice(0, 3500)}`).join('\n\n')
  const user = `=== ADAYIN CV'Sİ ===\n${readCv().trim()}\n\n=== KRİTERLER ===\n${readCriteria().trim()}${about ? `\n\n=== ADAY HAKKINDA ===\n${about.trim()}` : ''}\n\n=== EN YÜKSEK PUANLI ${rows.length} İLAN ===\n${ads}\n\nCV incelemesini yaz; markdown'ı JSON içinde text alanına koy.`
  const res = await runClaudeText({ system: CV_REVIEW_SYSTEM, user, tools: [], timeoutMs: 420_000, model: topModel(), label: 'CV incelemesi' })
  if (!res.ok) return res
  const md = `# CV incelemesi · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${rows.length} ilan\n\n${res.text.trim()}\n`
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CV_REVIEW_FILE, md, 'utf8')
  log.info(`CV incelemesi yazıldı: ${CV_REVIEW_FILE} (${rows.length} ilan)`)
  return { ok: true, md, jobs: rows.length }
}

export function readCvReview(): string | null {
  return fs.existsSync(CV_REVIEW_FILE) ? fs.readFileSync(CV_REVIEW_FILE, 'utf8') : null
}

export const CRITERIA_REVIEW_FILE = path.join(DATA_DIR, 'criteria-review.md')

/** Reads the user's decisions (with one-tap reasons) against the LLM's scores and proposes edits to criteria.md / about.md. */
export async function criteriaReview(limit = 40): Promise<{ ok: true; md: string; jobs: number } | { ok: false; error: string }> {
  const rows = decidedScoredJobs(limit)
  const pos = rows.filter((r) => ['shortlist', 'applied', 'interviewing'].includes(r.status))
  const neg = rows.filter((r) => ['ignored', 'rejected'].includes(r.status))
  if (rows.length < 10 || pos.length < 2 || neg.length < 2) return { ok: false, error: `yeterli karar yok (${rows.length} karar, ${pos.length} olumlu, ${neg.length} olumsuz); en az 10 karar, 2'şer olumlu/olumsuz` }
  const line = (r: JobRow) =>
    `- [${r.status}${r.decision_reason ? ' · sebep: ' + r.decision_reason : ''}] LLM ${r.score} · ${r.title} @ ${r.company ?? '?'} · ${r.location ?? '-'} · ${r.workplace_llm ?? '?'}\n  özet: ${(r.summary ?? '').slice(0, 220)}${r.notes ? `\n  not: ${r.notes.slice(0, 160)}` : ''}`
  const about = readAbout()
  const user = `=== KRİTERLER (profile/criteria.md) ===\n${readCriteria().trim()}\n\n=== ADAY HAKKINDA (profile/about.md) ===\n${about.trim() || '(boş)'}\n\n=== CV (özet için) ===\n${readCv().trim().slice(0, 2500)}\n\n=== ADAYIN OLUMLU KARARLARI (${pos.length}) ===\n${pos.map(line).join('\n')}\n\n=== ADAYIN OLUMSUZ KARARLARI (${neg.length}) ===\n${neg.map(line).join('\n')}\n\nİncelemeyi yaz; markdown'ı JSON içinde text alanına koy.`
  const res = await runClaudeText({ system: CRITERIA_REVIEW_SYSTEM, user, tools: [], timeoutMs: 420_000, model: topModel(), label: 'kriter incelemesi' })
  if (!res.ok) return res
  const md = `# Kriter incelemesi · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${rows.length} karar (${pos.length} olumlu, ${neg.length} olumsuz)\n\n${res.text.trim()}\n`
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CRITERIA_REVIEW_FILE, md, 'utf8')
  log.info(`kriter incelemesi yazıldı: ${CRITERIA_REVIEW_FILE} (${rows.length} karar)`)
  return { ok: true, md, jobs: rows.length }
}

export function readCriteriaReview(): string | null {
  return fs.existsSync(CRITERIA_REVIEW_FILE) ? fs.readFileSync(CRITERIA_REVIEW_FILE, 'utf8') : null
}
