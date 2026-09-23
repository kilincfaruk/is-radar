import { z } from 'zod'
import { researchSystem, RESEARCH_JSON_SCHEMA } from '../shared/prompt.ts'
import { runClaude } from './claude-cli.ts'
import { topModel } from './score.ts'
import { log } from '../log.ts'
import { jobsNeedingResearch, setResearch, type JobRow } from '../db.ts'

const Schema = z.object({
  summary_md: z.string().min(20),
  home_office: z.enum(['yes', 'no', 'unknown']),
  remote_policy: z.enum(['remote', 'hybrid', 'onsite', 'mixed', 'unknown']),
  sources: z.array(z.string()),
})

export async function researchOne(r: JobRow): Promise<boolean> {
  const user = `Şirket: ${r.company ?? '(bilinmiyor)'}
Şirket LinkedIn URL'si (AÇMA, sadece isim doğrulaması için): ${r.company_url ?? '-'}
İlan başlığı: ${r.title}
Lokasyon: ${r.location ?? '-'} · Çalışma şekli etiketi: ${r.workplace_type}
Sektör (LinkedIn): ${r.criteria_industry ?? '-'}

İlan metninin ilk 1500 karakteri:
${(r.description_md ?? '').slice(0, 1500)}

Araştır ve JSON döndür.`
  const res = await runClaude<unknown>({ system: researchSystem(), user, schema: RESEARCH_JSON_SCHEMA, tools: ['WebSearch', 'WebFetch'], maxTurns: 12, timeoutMs: 420_000, model: topModel(), label: `araştırma: ${r.company ?? '?'}` })
  if (!res.ok) {
    log.warn('araştırma hatası', r.company, res.error.slice(0, 150))
    return false
  }
  const p = Schema.safeParse(res.data)
  if (!p.success) {
    log.warn('araştırma şema hatası', r.company, p.error.issues[0]?.message)
    return false
  }
  const md = `${p.data.summary_md.trim()}\n\n_Kabul edilen şehirlerde ofis: ${p.data.home_office} · Çalışma politikası: ${p.data.remote_policy}_\n\nKaynaklar:\n${p.data.sources.slice(0, 6).map((s) => '- ' + s).join('\n')}`
  setResearch(r.linkedin_job_id, md)
  log.info(`araştırıldı: ${r.company} (${p.data.remote_policy}, ev şehri ofisi ${p.data.home_office})`)
  return true
}

export async function runResearch(minScore: number, limit: number): Promise<number> {
  if (minScore <= 0) return 0
  const rows = jobsNeedingResearch(minScore, limit)
  let n = 0
  for (const r of rows) if (await researchOne(r)) n++
  return n
}
