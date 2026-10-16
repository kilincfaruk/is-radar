/**
 * Polite HTTP client for the login-free LinkedIn guest endpoints.
 * - real browser UA, Turkish Accept-Language, nothing else (no cookies ever)
 * - random gap between requests (default 5-11 s; LinkedIn rounds use LINKEDIN_GAP_SEC), global (one queue)
 * - 429 / 999: LinkedIn's guest throttle is probabilistic — measured 2026-10 at a 30 s gap: 4 of 12 requests got
 *   429, scattered between 200s, and the very next try usually passed. So a 429 means "retry this request in about a
 *   minute" (1 → 3 → 8 min while they come back to back), and only a streak of 4 in a row ends LinkedIn for the
 *   round (cooldown). The caller's per-round request cap counts every attempt, so a round cannot crawl for hours.
 * - 503 / network error: consecutive backoff 5 → 15 → 45 min, then give up
 * - per-hour cap
 */
import { log } from './log.ts'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export type HttpOptions = {
  minGapMs?: number
  maxGapMs?: number
  perHour?: number
  timeoutMs?: number
  /** Minutes to wait after the 1st, 2nd, … 429 in a row; one more in a row ends the round. */
  limitWaitsMin?: number[]
  /** Told until when LinkedIn should be left alone (epoch ms), so a restart does not walk straight back in. */
  onRateLimit?: (until: number) => void
  /** Starting gap multiplier (carried over from earlier rounds). */
  slowFactor?: number
  sleep?: (ms: number) => Promise<void>
}

export type HttpStats = { requests: number; rateLimited: number; errors: number; lastStatus: number | null }

export class PoliteHttp {
  stats: HttpStats = { requests: 0, rateLimited: 0, errors: 0, lastStatus: null }
  private lastAt = 0
  private hourWindow: number[] = []
  private backoffLevel = 0
  /** 429/999 answers in a row (a 200 resets it). */
  private limitStreak = 0
  /** Successful answers in a row since the last slow-down; enough of them ease the gap back. */
  private okStreak = 0
  private basePace = 1
  /** Multiplies the inter-request gap; starts at the carried-over pace, ×1.5 per 429 streak (capped ×4), back /1.5 after 8 clean answers. */
  private slowFactor = 1
  private queue: Promise<unknown> = Promise.resolve()
  private opts: HttpOptions
  constructor(opts: HttpOptions = {}) {
    this.opts = opts
    this.slowFactor = Math.max(1, opts.slowFactor ?? 1)
    this.basePace = this.slowFactor
  }

  get minGap() {
    return this.opts.minGapMs ?? 5000
  }
  get maxGap() {
    return this.opts.maxGapMs ?? 11000
  }
  get perHour() {
    return this.opts.perHour ?? 250
  }

  /** Serialised: only one request in flight, human-ish pacing. */
  get(url: string): Promise<{ status: number; text: string }> {
    const run = async () => {
      await this.pace()
      return this.fetchWithBackoff(url)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  private async pace(): Promise<void> {
    const now = Date.now()
    this.hourWindow = this.hourWindow.filter((t) => now - t < 3_600_000)
    if (this.hourWindow.length >= this.perHour) {
      const wait = 3_600_000 - (now - this.hourWindow[0]) + 1000
      if (wait >= 60_000) log.warn(`saatlik tavan (${this.perHour}) doldu, ${Math.round(wait / 60000)} dk bekleniyor`)
      await this.wait(wait)
    }
    const gap = (this.minGap + Math.floor(Math.random() * (this.maxGap - this.minGap + 1))) * this.slowFactor
    const since = Date.now() - this.lastAt
    if (since < gap) await this.wait(gap - since)
  }

  private wait(ms: number): Promise<void> {
    return (this.opts.sleep ?? sleep)(ms)
  }

  private async fetchWithBackoff(url: string): Promise<{ status: number; text: string }> {
    for (;;) {
      this.lastAt = Date.now()
      this.hourWindow.push(this.lastAt)
      this.stats.requests++
      let status = 0
      let text = ''
      try {
        const ctrl = new AbortController()
        const to = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 30000)
        const res = await fetch(url, {
          headers: {
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'cache-control': 'no-cache',
          },
          redirect: 'follow',
          signal: ctrl.signal,
        })
        clearTimeout(to)
        status = res.status
        text = await res.text()
      } catch (e) {
        this.stats.errors++
        status = 0
        text = ''
        log.warn('ağ hatası', url.slice(0, 90), e instanceof Error ? e.message : e)
      }
      this.stats.lastStatus = status
      if (status === 429 || status === 999) {
        this.stats.rateLimited++
        this.limitStreak++
        this.okStreak = 0
        const waits = this.opts.limitWaitsMin ?? [1, 3, 8]
        if (this.limitStreak > waits.length) {
          this.opts.onRateLimit?.(Date.now() + COOLDOWN_MIN * 60_000)
          throw new RateLimitedError(`LinkedIn üst üste ${this.limitStreak} kez ${status} verdi: bu IP şu an kısılmış. LinkedIn bu tur bırakıldı, ${COOLDOWN_MIN} dk dokunmuyorum`)
        }
        // jitter so retries do not land on a fixed rhythm
        const ms = Math.round(waits[this.limitStreak - 1] * 60_000 * (1 + Math.random() * 0.5))
        // a scattered 429 is normal at any pace (the next round's pace learns from the rate); a streak means too fast
        if (this.limitStreak >= 2) this.slowFactor = Math.min(MAX_PACE, this.slowFactor * 1.5)
        this.opts.onRateLimit?.(Date.now() + ms)
        log.warn(`HTTP ${status} (üst üste ${this.limitStreak}.) → ${Math.round(ms / 1000)} sn bekleyip aynı isteği tekrar deniyorum${this.limitStreak >= 2 ? `, aralık ×${fmtPace(this.slowFactor)}` : ''}`)
        await this.wait(ms)
        continue
      }
      if (status === 503 || status === 0) {
        const waits = [5, 15, 45]
        if (this.backoffLevel >= waits.length) throw new RateLimitedError(`LinkedIn ${status}: üç geri çekilmeden sonra da devam ediyor, tur bırakıldı`)
        const min = waits[this.backoffLevel++]
        log.warn(`HTTP ${status} → ${min} dk geri çekilme`)
        await this.wait(min * 60_000)
        continue
      }
      this.backoffLevel = 0
      this.limitStreak = 0
      // a slow-down after a 429 streak is not forever: 8 clean answers in a row take a step back toward the base
      if (++this.okStreak >= 8 && this.slowFactor > this.basePace) {
        this.slowFactor = Math.max(this.basePace, this.slowFactor / 1.5)
        this.okStreak = 0
        log.info(`LinkedIn 8 istektir sorunsuz, aralık ×${fmtPace(this.slowFactor)}'e indi`)
      }
      return { status, text }
    }
  }
}

export const MAX_PACE = 4

export function fmtPace(f: number): string {
  return String(Math.round(f * 10) / 10)
}

/**
 * Pace for the next round from this round's 429 rate: above 25 % the gap grows ×1.5, below 10 % it eases 15 %.
 * The gap settles where this IP gets mostly 200s, instead of starting from the base every round.
 */
export function nextPace(pace: number, requests: number, rateLimited: number): number {
  if (requests < 5) return rateLimited > 0 ? Math.min(MAX_PACE, Math.max(1.5, pace * 1.5)) : pace
  const rate = rateLimited / requests
  if (rate > 0.25) return Math.min(MAX_PACE, Math.round(Math.max(1.5, pace * 1.5) * 100) / 100)
  if (rate < 0.1) return Math.max(1, Math.round(pace * 0.85 * 100) / 100)
  return pace
}

/** Minutes LinkedIn is left alone after the round gave up on 429s. */
export const COOLDOWN_MIN = 30

export class RateLimitedError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
