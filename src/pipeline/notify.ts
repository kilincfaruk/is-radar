import { env } from '../config.ts'
import { log } from '../log.ts'
import type { JobRow } from '../db.ts'

const WP: Record<string, string> = { remote: 'remote', hybrid: 'hibrit', onsite: 'ofis', unknown: '' }

function arr(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** One ad → a few Telegram lines: score, title/company, workplace, the model's one-line summary and its top pro/con. */
export function telegramLine(j: JobRow): string {
  const wp = [WP[j.workplace_llm ?? j.workplace_type] ?? '', j.workplace_detail ?? j.location ?? ''].filter(Boolean).join(' · ')
  const pro = arr(j.pros_json)[0]
  const con = arr(j.cons_json)[0] ?? arr(j.red_flags_json)[0]
  const out = [`*${j.score}* ${escape(j.title)} — ${escape(j.company ?? '?')}${wp ? ` (${escape(wp)})` : ''}`]
  if (j.summary) out.push(`  ${escape(j.summary.slice(0, 160))}`)
  if (pro) out.push(`  ✅ ${escape(pro.slice(0, 120))}`)
  if (con) out.push(`  ⚠️ ${escape(con.slice(0, 120))}`)
  out.push(`  ${j.url}`)
  return out.join('\n')
}

export async function notifyTelegram(jobs: JobRow[]): Promise<void> {
  const token = env('TELEGRAM_BOT_TOKEN')
  const chat = env('TELEGRAM_CHAT_ID')
  if (!token || !chat || jobs.length === 0) return
  const sorted = [...jobs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const head = `İş Radar: ${jobs.length} yeni yüksek skorlu ilan`
  // Telegram caps a message at 4096 chars: send in chunks, header only on the first
  const chunks: string[] = []
  let cur = head
  for (const j of sorted) {
    const line = telegramLine(j)
    if (cur.length + line.length + 2 > 3900) {
      chunks.push(cur)
      cur = line
    } else cur += '\n\n' + line
  }
  chunks.push(cur)
  for (const text of chunks) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
      })
      if (!res.ok) log.warn('telegram', res.status, (await res.text()).slice(0, 120))
    } catch (e) {
      log.warn('telegram', e instanceof Error ? e.message : e)
    }
  }
}

function escape(s: string): string {
  return s.replace(/[_*`[]/g, '\\$&')
}
