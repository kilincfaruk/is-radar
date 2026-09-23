/** `npm run doctor`: shows why `claude -p` might answer with placeholders on this machine. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env, SAMPLES_DIR, ROOT } from './config.ts'
import { runClaude } from './pipeline/claude-cli.ts'
import { buildScoringUser, SCORE_JSON_SCHEMA } from './shared/prompt.ts'
import { scoringSystem } from './pipeline/score.ts'

const SAMPLE_JOB = {
  title: 'Business Analyst',
  company: 'Örnek Yazılım A.Ş.',
  location: 'Ankara, Türkiye',
  workplaceType: 'unknown',
  postedText: '2 gün önce',
  applicantCount: 40,
  descriptionMd:
    'B2B SaaS ürünümüz için İş Analisti arıyoruz. Müşteri ihtiyaçlarını gereksinim dokümanına çevirecek, user story ve kabul kriterleri yazacak, ' +
    'geliştirme ekibi ile ürün ekibi arasında köprü olacak. Jira/Confluence, SQL bilgisi, UAT deneyimi beklenir. En az 2 yıl deneyim. ' +
    'Haftada 2 gün Ankara ofisi, 3 gün uzaktan çalışma.',
  criteria: { seniority: 'Uzman', employment: 'Tam zamanlı', func: 'Bilgi Teknolojileri', industry: 'Yazılım Geliştirme' },
}

function line(k: string, v: unknown) {
  console.log(`${k.padEnd(28)} ${v}`)
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function doctor(): Promise<void> {
  console.log('=== İş Radar doctor ===')
  line('node', process.version + ' ' + process.platform)
  line('cwd', process.cwd())
  line('CLAUDE_CLI', env('CLAUDE_CLI', 'claude'))
  line('CLAUDE_MODEL', env('CLAUDE_MODEL', 'sonnet'))
  line('SCORER', env('SCORER', 'claude-cli'))
  for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'HTTPS_PROXY', 'HTTP_PROXY']) {
    const v = process.env[k]
    if (v) line(k, k.includes('KEY') || k.includes('TOKEN') ? `(dolu, ${v.length} karakter)` : v)
  }
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  line('claude config dir', cfgDir)
  for (const f of ['settings.json', 'settings.local.json']) {
    const j = readJson(path.join(cfgDir, f))
    if (!j) continue
    const hooks = j.hooks && typeof j.hooks === 'object' ? Object.keys(j.hooks as object) : []
    line(f, `hooks: ${hooks.length ? hooks.join(', ') : 'yok'}${j.model ? ` · model: ${String(j.model)}` : ''}${j.outputStyle ? ` · outputStyle: ${String(j.outputStyle)}` : ''}${j.env ? ` · env: ${Object.keys(j.env as object).join(',')}` : ''}`)
  }
  for (const f of [path.join(cfgDir, 'CLAUDE.md'), path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, '..', 'CLAUDE.md'), path.join(process.cwd(), 'CLAUDE.md')]) {
    if (fs.existsSync(f)) line('CLAUDE.md', `${f} (${fs.statSync(f).size} bayt) — claude -p bunu okur!`)
  }
  for (const f of [path.join(ROOT, '.claude', 'settings.json'), path.join(ROOT, '..', '.claude', 'settings.json')]) {
    const j = readJson(f)
    if (j) line('proje settings', `${f} hooks: ${j.hooks ? Object.keys(j.hooks as object).join(', ') : 'yok'}`)
  }

  console.log('\n--- örnek skorlama (gerçek CV + kriterler, sahte ilan) ---')
  const system = scoringSystem()
  const user = buildScoringUser(SAMPLE_JOB)
  line('system prompt', `${system.length} karakter`)
  line('user prompt', `${user.length} karakter`)
  const t0 = Date.now()
  const res = await runClaude<Record<string, unknown>>({ system, user, schema: SCORE_JSON_SCHEMA, tools: [], timeoutMs: 180_000 })
  line('süre', `${Math.round((Date.now() - t0) / 1000)} sn`)
  fs.mkdirSync(SAMPLES_DIR, { recursive: true })
  const out = path.join(SAMPLES_DIR, 'claude-doctor.json')
  fs.writeFileSync(out, res.ok ? res.raw : res.raw || res.error, 'utf8')
  line('ham çıktı', out)
  if (!res.ok) {
    console.log('HATA:', res.error)
    return
  }
  const d = res.data
  line('score', d.score)
  line('workplace', d.workplace)
  line('summary', JSON.stringify(d.summary))
  line('pros', JSON.stringify((d.reasons as { pros?: unknown })?.pros))
  line('cons', JSON.stringify((d.reasons as { cons?: unknown })?.cons))
  const summary = String(d.summary ?? '')
  if (summary.length < 40 || /^test/i.test(summary)) {
    console.log('\nSONUÇ: placeholder çıktı. Kod aynı, sorun bu makinedeki claude ortamında. Ham çıktıya bak; hook, CLAUDE.md, outputStyle veya ANTHROPIC_BASE_URL satırlarını kontrol et.')
  } else {
    console.log('\nSONUÇ: skorlama sağlıklı.')
  }
}
