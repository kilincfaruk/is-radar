/** Console logger + in-memory ring buffer so the dashboard can show the same lines (/api/log). */
export type LogLevel = 'info' | 'warn' | 'error'
export type LogLine = { id: number; at: string; level: LogLevel; text: string }

const MAX = 600
const buf: LogLine[] = []
let seq = 0

function fmt(a: unknown[]): string {
  return a.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
}

function push(level: LogLevel, a: unknown[]): void {
  const line: LogLine = { id: ++seq, at: new Date().toISOString(), level, text: fmt(a) }
  buf.push(line)
  if (buf.length > MAX) buf.splice(0, buf.length - MAX)
}

const t = () => new Date().toISOString().slice(11, 19)
export const log = {
  info: (...a: unknown[]) => {
    push('info', a)
    console.log(t(), '[radar]', ...a)
  },
  warn: (...a: unknown[]) => {
    push('warn', a)
    console.warn(t(), '[radar] !', ...a)
  },
  error: (...a: unknown[]) => {
    push('error', a)
    console.error(t(), '[radar] !!', ...a)
  },
}

/** Lines after `sinceId` (0 = everything kept), newest last. */
export function logLines(sinceId = 0, limit = MAX): LogLine[] {
  const out = sinceId > 0 ? buf.filter((l) => l.id > sinceId) : buf
  return out.slice(-limit)
}
