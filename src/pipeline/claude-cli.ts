/**
 * Runs Claude through the locally installed Claude Code CLI (`claude -p`), i.e.
 * on the user's Max subscription. No API key. Long texts go through stdin and
 * temp files; only short flags on the command line (Windows-safe).
 */
import { spawn, spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { env } from '../config.ts'
import { log } from '../log.ts'

export type ClaudeJsonResult<T> = { ok: true; data: T; raw: string; costUsd: number | null } | { ok: false; error: string; raw: string }

/** Process-wide Claude usage counters (every `claude -p` call). Rounds snapshot/diff these; the db keeps an all-time total. */
export type ClaudeUsage = { calls: number; failures: number; costUsd: number; ms: number }
export const claudeUsage: ClaudeUsage = { calls: 0, failures: 0, costUsd: 0, ms: 0 }
export function snapshotUsage(): ClaudeUsage {
  return { ...claudeUsage }
}
export function usageSince(a: ClaudeUsage): ClaudeUsage {
  return { calls: claudeUsage.calls - a.calls, failures: claudeUsage.failures - a.failures, costUsd: +(claudeUsage.costUsd - a.costUsd).toFixed(4), ms: claudeUsage.ms - a.ms }
}
let usageListener: ((delta: ClaudeUsage) => void) | null = null
/** Called after every call with that call's usage (cost may be 0 when the CLI reports none). */
export function onClaudeUsage(fn: ((delta: ClaudeUsage) => void) | null): void {
  usageListener = fn
}
function account<T>(res: ClaudeJsonResult<T>, t0: number, model: string, label?: string): ClaudeJsonResult<T> {
  const ms = Date.now() - t0
  const cost = res.ok && res.costUsd ? res.costUsd : 0
  claudeUsage.calls += 1
  claudeUsage.ms += ms
  claudeUsage.costUsd += cost
  if (!res.ok) claudeUsage.failures += 1
  log.info(`claude (${model}${label ? ', ' + label : ''}) ${res.ok ? 'bitti' : 'başarısız'}: ${Math.round(ms / 1000)} sn${cost ? `, $${cost.toFixed(3)}` : ''}`)
  try {
    usageListener?.({ calls: 1, failures: res.ok ? 0 : 1, costUsd: cost, ms })
  } catch {
    /* listener must not break a call */
  }
  return res
}

let resolved: { cmd: string; args: string[] } | null = null

/** Find a way to launch the CLI without a shell: `claude` binary, `claude.exe`, or `node cli.js`. */
function resolveClaude(): { cmd: string; args: string[] } {
  if (resolved) return resolved
  const custom = env('CLAUDE_CLI', 'claude')
  const candidates: Array<{ cmd: string; args: string[] }> = []
  if (custom.endsWith('.js')) candidates.push({ cmd: process.execPath, args: [custom] })
  else {
    candidates.push({ cmd: custom, args: [] })
    if (process.platform === 'win32') {
      candidates.push({ cmd: custom + '.exe', args: [] })
      candidates.push({ cmd: path.join(os.homedir(), '.local', 'bin', 'claude.exe'), args: [] })
    }
    try {
      const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const cli = path.join(root, '@anthropic-ai', 'claude-code', 'cli.js')
      if (fs.existsSync(cli)) candidates.push({ cmd: process.execPath, args: [cli] })
    } catch {
      /* npm not available */
    }
  }
  for (const c of candidates) {
    try {
      const r = spawnSyncSafe(c.cmd, [...c.args, '--version'])
      if (r.ok) {
        resolved = c
        log.info('claude cli:', c.cmd, c.args.join(' '), '→', r.out.trim().slice(0, 40))
        return c
      }
    } catch {
      /* try next */
    }
  }
  throw new Error('Claude Code CLI bulunamadı. `claude --version` çalışıyor mu? .env içinde CLAUDE_CLI=<tam yol> ver (npm ile kurulduysa …/@anthropic-ai/claude-code/cli.js).')
}

function spawnSyncSafe(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000, windowsHide: true })
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') }
}

export type ClaudeOpts = {
  system: string
  user: string
  /** Short label for the log ("3 ilan", "araştırma: X"); a heartbeat line is written while the call is still running. */
  label?: string
  schema?: unknown
  model?: string
  tools?: string[] // [] = no tools
  maxTurns?: number
  timeoutMs?: number
}

export async function runClaude<T = unknown>(o: ClaudeOpts): Promise<ClaudeJsonResult<T>> {
  const { cmd, args: baseArgs } = resolveClaude()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'is-radar-'))
  const sysFile = path.join(tmp, 'system.txt')
  fs.writeFileSync(sysFile, o.system, 'utf8')
  const args = [...baseArgs, '-p', '--output-format', 'json', '--no-session-persistence', '--model', o.model || env('CLAUDE_MODEL', 'sonnet')]
  // long system prompt via file when supported, else via flag (still not shell-quoted: no shell)
  args.push('--system-prompt-file', sysFile)
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema))
  const tools = o.tools ?? []
  args.push('--tools', tools.join(','))
  if (tools.length) args.push('--allowedTools', tools.join(','), '--permission-mode', 'bypassPermissions')
  if (o.maxTurns) args.push('--max-turns', String(o.maxTurns))

  let raw = ''
  let err = ''
  const t0 = Date.now()
  const model = o.model || env('CLAUDE_MODEL', 'sonnet')
  const beat = setInterval(() => log.info(`claude (${model}${o.label ? ', ' + o.label : ''}) ${Math.round((Date.now() - t0) / 1000)} sn'dir çalışıyor…`), 60_000)
  const code = await new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
    const timer = setTimeout(() => {
      log.warn(`claude (${model}${o.label ? ', ' + o.label : ''}) ${Math.round((o.timeoutMs ?? 240_000) / 1000)} sn'de bitmedi, süreç öldürüldü`)
      child.kill('SIGKILL')
    }, o.timeoutMs ?? 240_000)
    child.stdout.on('data', (d) => (raw += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      err += String(e)
      clearTimeout(timer)
      resolve(-1)
    })
    child.on('close', (c) => {
      clearTimeout(timer)
      resolve(c ?? -1)
    })
    child.stdin.end(o.user, 'utf8')
  })
  clearInterval(beat)
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  if (!raw.trim()) {
    // older CLI without --system-prompt-file: retry with inline flag
    if (/system-prompt-file|unknown option/i.test(err)) {
      return account(await runClaudeInlineSystem<T>(o, cmd, baseArgs), t0, model, o.label)
    }
    return account<T>({ ok: false, error: `claude çıktı vermedi (exit ${code}): ${err.trim().slice(0, 300)}`, raw }, t0, model, o.label)
  }
  return account(parseResult<T>(raw, err, code), t0, model, o.label)
}

async function runClaudeInlineSystem<T>(o: ClaudeOpts, cmd: string, baseArgs: string[]): Promise<ClaudeJsonResult<T>> {
  const args = [...baseArgs, '-p', '--output-format', 'json', '--no-session-persistence', '--model', o.model || env('CLAUDE_MODEL', 'sonnet'), '--system-prompt', o.system]
  if (o.schema) args.push('--json-schema', JSON.stringify(o.schema))
  const tools = o.tools ?? []
  args.push('--tools', tools.join(','))
  if (tools.length) args.push('--allowedTools', tools.join(','), '--permission-mode', 'bypassPermissions')
  if (o.maxTurns) args.push('--max-turns', String(o.maxTurns))
  let raw = ''
  let err = ''
  const code = await new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 240_000)
    child.stdout.on('data', (d) => (raw += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', () => resolve(-1))
    child.on('close', (c) => {
      clearTimeout(timer)
      resolve(c ?? -1)
    })
    child.stdin.end(o.user, 'utf8')
  })
  if (!raw.trim()) return { ok: false, error: `claude çıktı vermedi (exit ${code}): ${err.trim().slice(0, 300)}`, raw }
  return parseResult<T>(raw, err, code)
}

function parseResult<T>(raw: string, err: string, code: number): ClaudeJsonResult<T> {
  let j: { result?: string; structured_output?: unknown; is_error?: boolean; subtype?: string; total_cost_usd?: number }
  try {
    j = JSON.parse(raw)
  } catch {
    // stream noise before JSON? take last {...}
    const i = raw.lastIndexOf('\n{')
    try {
      j = JSON.parse(raw.slice(i + 1))
    } catch {
      return { ok: false, error: `claude JSON çıktısı parse edilemedi (exit ${code}): ${raw.slice(0, 200)} ${err.slice(0, 200)}`, raw }
    }
  }
  if (j.is_error) return { ok: false, error: `claude hata: ${String(j.result || j.subtype || '').slice(0, 300)}`, raw }
  if (j.structured_output !== undefined && j.structured_output !== null) return { ok: true, data: j.structured_output as T, raw, costUsd: j.total_cost_usd ?? null }
  const text = String(j.result || '')
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s !== -1 && e > s) {
    try {
      return { ok: true, data: JSON.parse(text.slice(s, e + 1)) as T, raw, costUsd: j.total_cost_usd ?? null }
    } catch {
      /* fallthrough */
    }
  }
  return { ok: false, error: 'claude yanıtında JSON yok: ' + text.slice(0, 200), raw }
}

/** Plain text answer (cover letter etc.). */
export async function runClaudeText(o: Omit<ClaudeOpts, 'schema'>): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const r = await runClaude<{ text: string }>({ ...o, schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } })
  if (!r.ok) return r
  return { ok: true, text: String((r.data as { text?: string }).text ?? '') }
}
