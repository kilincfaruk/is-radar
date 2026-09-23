export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const MONTHS = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara']

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

function hm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "Bugün 11:02" · "Dün 20:31" · "12 Eyl 14:00" */
export function fmtWhen(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return '–'
  const now = new Date()
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return `Bugün ${hm(d)}`
  if (diff === 1) return `Dün ${hm(d)}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm(d)}`
}

/** "az önce" · "3 sa önce" · "5 gün önce" · "12 Eyl" */
export function rel(iso: string | null | undefined): string {
  const d = parse(iso)
  if (!d) return '–'
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 90) return 'az önce'
  if (s < 3600) return `${Math.round(s / 60)} dk önce`
  if (s < 86_400) return `${Math.round(s / 3600)} sa önce`
  const days = Math.round(s / 86_400)
  if (days <= 30) return `${days} gün önce`
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

export function fmtDate(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : '–'
}

export function daysSince(iso: string | null | undefined): number {
  const d = parse(iso)
  return d ? (Date.now() - d.getTime()) / 86_400_000 : 999
}

export function durationText(startIso: string, endIso: string | null): string {
  const a = parse(startIso)
  const b = parse(endIso)
  if (!a || !b) return ''
  const m = Math.round((b.getTime() - a.getTime()) / 60_000)
  return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa ${m % 60} dk`
}
