/**
 * Polite HTTP client for the login-free LinkedIn guest endpoints.
 * - real browser UA, Turkish Accept-Language, nothing else (no cookies ever)
 * - 5-11 s random gap between requests, global (one queue)
 * - 429 / 999: counted over the last hour, not reset by one lucky request. 1st → 5 min, 2nd → 15 min,
 *   3rd → give up LinkedIn for this round (cooldown). A throttled IP lets a request through now and then; treating
 *   that as recovery kept a round crawling for hours and the IP flagged.
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
  /** 429s within an hour that end the round (default 3). */
  maxLimitHits?: number
  /** Told until when LinkedIn should be left alone (epoch ms), so a restart does not walk straight back in. */
  onRateLimit?: (until: number) => void
  sleep?: (ms: number) => Promise<void>
}

export type HttpStats = { requests: number; rateLimited: number; errors: number; lastStatus: number | null }

export class PoliteHttp {
  stats: HttpStats = { requests: 0, rateLimited: 0, errors: 0, lastStatus: null }
  private lastAt = 0
  private hourWindow: number[] = []
  private backoffLevel = 0
  /** Times of 429/999 answers in the last hour. */
  private limitHits: number[] = []
  /** Multiplies the inter-request gap after each 429 in this instance (×2 per hit, capped ×4). */
  private slowFactor = 1
  private queue: Promise<unknown> = Promise.resolve()
  private opts: HttpOptions
  constructor(opts: HttpOptions = {}) {
    this.opts = opts
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
        const now = Date.now()
        this.limitHits = this.limitHits.filter((t) => now - t < 3_600_000)
        this.limitHits.push(now)
        const n = this.limitHits.length
        if (n >= (this.opts.maxLimitHits ?? 3)) {
          this.opts.onRateLimit?.(now + COOLDOWN_MIN * 60_000)
          throw new RateLimitedError(`LinkedIn son 1 saatte ${n}. kez ${status} verdi: bu IP kısılmış. LinkedIn bu tur bırakıldı, ${COOLDOWN_MIN} dk dokunmuyorum`)
        }
        const min = n === 1 ? 5 : 15
        this.slowFactor = Math.min(4, this.slowFactor * 2)
        this.opts.onRateLimit?.(now + min * 60_000)
        log.warn(`HTTP ${status} (son 1 saatte ${n}.) → ${min} dk geri çekilme, sonra istek aralığı ×${this.slowFactor}`)
        await this.wait(min * 60_000)
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
      return { status, text }
    }
  }
}

/** Minutes LinkedIn is left alone after the round gave up on 429s. */
export const COOLDOWN_MIN = 60

export class RateLimitedError extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
