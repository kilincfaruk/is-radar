/** Everything the UI derives from a Job: rule/LLM views, workplace verdict, agreement, facts, description blocks. */
import type { Job, JobStatus, RoleFit, SeniorityFit } from './types'
import { prescreen, type PreScreen } from './prescreen'
import { resolveWorkplace, type CityClass, type WorkplaceKind } from './workplace'
import { daysSince, fmtWhen, rel } from './utils'
import { pickThresholds } from '@shared/calibrate'

export type Tone = 'ok' | 'warn' | 'bad' | 'dim' | 'text'
export const TONE: Record<Tone, string> = { ok: 'var(--accent)', warn: 'var(--amber)', bad: 'var(--red)', dim: 'var(--dim)', text: 'var(--text)' }

export const STATUS_LABEL: Record<JobStatus, [string, string]> = {
  new: ['yeni', 'var(--text)'],
  shortlist: ['shortlist', 'var(--accent)'],
  applied: ['başvurdum', 'var(--accent)'],
  interviewing: ['görüşme', 'var(--blue)'],
  ignored: ['yoksaydın', 'var(--dim)'],
  rejected: ['reddettin', 'var(--red)'],
}
export const ROLE_TR: Record<RoleFit, string> = { core: 'hedef', adjacent: 'yakın', bridge: 'köprü', mismatch: 'uyumsuz' }
export const SENIORITY_TR: Record<SeniorityFit | 'unknown', string> = { under: 'altında', match: 'uygun', stretch: 'biraz üstünde', over: 'fazla üst', unknown: 'belirsiz' }

/** Server-side rule result wins; otherwise compute locally; otherwise a neutral placeholder (text not fetched yet). */
export function preOf(j: Job): PreScreen {
  const p = (j.pre as PreScreen | null | undefined) ?? prescreen(j)
  if (p) return p
  return { verdict: 'review', score: 0, remote: 'unknown', homeCity: false, role: 'core', seniority: 'unknown', flags: [], reasons: ['metni daha çekmedim'], bonuses: [] }
}

export function scoreOf(j: Job): number | null {
  return j.scoredAt !== null && j.score !== null ? j.score : null
}

export function bucket(score: number | null, threshold: number): { label: string; color: string } {
  if (score == null) return { label: 'skor yok', color: 'var(--dim)' }
  if (score >= threshold + 10) return { label: 'güçlü', color: 'var(--accent)' }
  if (score >= threshold) return { label: 'bakmaya değer', color: 'var(--accent)' }
  if (score >= 40) return { label: 'orta', color: 'var(--amber)' }
  return { label: 'zayıf', color: 'var(--dim)' }
}

export type WorkplaceView = { kind: WorkplaceKind | 'unknown'; label: string; detail: string; tone: Tone; color: string; cityClass: CityClass; verified: boolean }

export function workplaceView(j: Job, pre: PreScreen): WorkplaceView {
  const wp = resolveWorkplace(j, pre)
  const kind: WorkplaceKind | 'unknown' = wp.kind ?? 'unknown'
  let label: string
  let tone: Tone
  if (kind === 'remote') {
    label = 'Remote · Türkiye'
    tone = 'ok'
  } else if (kind === 'hybrid') {
    label = 'Hibrit · ' + (wp.city ?? 'şehirsiz')
    tone = wp.cityClass === 'other' ? 'bad' : wp.cityClass === 'none' ? 'warn' : 'ok'
  } else if (kind === 'onsite') {
    label = 'Ofis · ' + (wp.city ?? 'şehirsiz')
    tone = wp.cityClass === 'other' ? 'bad' : 'warn'
  } else {
    label = 'Belirsiz'
    tone = 'warn'
  }
  const detail = [wp.detail, kind === 'unknown' ? wp.why : wp.verified ? 'metinden' : 'yalnız etiketten'].filter(Boolean).join(' · ')
  return { kind, label, detail, tone, color: TONE[tone], cityClass: wp.cityClass, verified: wp.verified }
}

/** Rule engine and LLM disagree, or the LinkedIn label contradicts the text. */
export function suspectWhy(j: Job, pre: PreScreen): string | null {
  const s = scoreOf(j)
  if (pre.verdict === 'reject' && s != null && s >= 60) return `Kural motoru eledi (${pre.flags[0] || pre.reasons[0] || 'sebep yok'}), LLM ${s} verdi.`
  if (pre.verdict === 'candidate' && s != null && s < 40) return `Kural motoru aday dedi (${pre.score}), LLM ${s} verdi — ${j.redFlags[0] || j.cons[0] || 'sebep yazmadı'}.`
  if (pre.remoteSource === 'text') {
    if (j.workplaceType === 'remote' && pre.remote !== 'verified') return 'LinkedIn etiketi "Uzaktan", metin başka söylüyor.'
    if (j.workplaceType === 'onsite' && pre.remote === 'hybrid') return 'LinkedIn etiketi "Ofis", metin hibrit diyor.'
  }
  return null
}

export function isFlagged(j: Job, pre: PreScreen): boolean {
  return pre.flags.length > 0 || j.redFlags.length > 0 || !!suspectWhy(j, pre)
}

/** Everything derived from one job, computed once per data load (filters, facets and rows all read this). */
export type JobView = { pre: PreScreen; score: number | null; wp: WorkplaceView; role: RoleFit; flagged: boolean; suspect: string | null; days: number }
export function jobView(j: Job): JobView {
  const pre = preOf(j)
  return { pre, score: scoreOf(j), wp: workplaceView(j, pre), role: (j.roleFit ?? pre.role) as RoleFit, flagged: isFlagged(j, pre), suspect: suspectWhy(j, pre), days: postedDays(j) }
}

/** Rule verdict × LLM band over scored ads: how often the two opinions agree, and where they clash. */
export const DECISION_REASONS = ['rol', 'şehir/ofis', 'maaş', 'şirket', 'kıdem', 'ilan dili', 'kapanmış', 'diğer'] as const
export type DecisionCalib = { pos: number; neg: number; posAvg: number | null; negAvg: number | null; fp: number; fn: number; fpReasons: Array<[string, number]> }
export type Calibration = { scored: number; agree: number; ruleRejectLlmGood: number; ruleCandLlmBad: number; matrix: number[][]; avgByVerdict: Record<'reject' | 'review' | 'candidate', number | null>; decisions: DecisionCalib }
export function calibration(jobs: Job[], view: (j: Job) => JobView, threshold: number): Calibration {
  const matrix = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ] // rows: rule reject/review/candidate · cols: llm <40 / 40..thr / ≥thr
  const sums: Record<string, { n: number; s: number }> = { reject: { n: 0, s: 0 }, review: { n: 0, s: 0 }, candidate: { n: 0, s: 0 } }
  let scored = 0
  let agree = 0
  let ruleRejectLlmGood = 0
  let ruleCandLlmBad = 0
  for (const j of jobs) {
    const v = view(j)
    if (v.score == null) continue
    scored++
    const r = v.pre.verdict === 'reject' ? 0 : v.pre.verdict === 'review' ? 1 : 2
    const l = v.score < 40 ? 0 : v.score < threshold ? 1 : 2
    matrix[r][l]++
    if (r === l) agree++
    if (r === 0 && v.score >= 60) ruleRejectLlmGood++
    if (r === 2 && v.score < 40) ruleCandLlmBad++
    sums[v.pre.verdict].n++
    sums[v.pre.verdict].s += v.score
  }
  const avg = (k: string) => (sums[k].n ? Math.round(sums[k].s / sums[k].n) : null)
  // the user's own decisions against the LLM: false positives (LLM liked, user passed) and false negatives
  const dec: DecisionCalib = { pos: 0, neg: 0, posAvg: null, negAvg: null, fp: 0, fn: 0, fpReasons: [] }
  let ps = 0
  let ns = 0
  const reasons = new Map<string, number>()
  for (const j of jobs) {
    const s = view(j).score
    if (s == null) continue
    if (['shortlist', 'applied', 'interviewing'].includes(j.status)) {
      dec.pos++
      ps += s
      if (s < 40) dec.fn++
    } else if (j.status === 'ignored' || j.status === 'rejected') {
      dec.neg++
      ns += s
      if (s >= threshold) {
        dec.fp++
        const r = j.decisionReason ?? 'sebep yok'
        reasons.set(r, (reasons.get(r) ?? 0) + 1)
      }
    }
  }
  dec.posAvg = dec.pos ? Math.round(ps / dec.pos) : null
  dec.negAvg = dec.neg ? Math.round(ns / dec.neg) : null
  dec.fpReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1])
  return { scored, agree, ruleRejectLlmGood, ruleCandLlmBad, matrix, avgByVerdict: { reject: avg('reject'), review: avg('review'), candidate: avg('candidate') }, decisions: dec }
}

/**
 * Grid-search the rule-score cut-offs that agree most with the LLM bands over the scored ads.
 * Returns null with fewer than MIN_CALIB_ROWS scored ads (too noisy to tune on).
 */
export const MIN_CALIB_ROWS = 20
export type ThresholdSuggestion = { review: number; candidate: number; agree: number; missed: number; current: { review: number; candidate: number; agree: number; missed: number }; scored: number; good: number }
export function suggestThresholds(jobs: Job[], view: (j: Job) => JobView, llmThreshold: number, current: { review: number; candidate: number }): ThresholdSuggestion | null {
  const rows = jobs.filter((j) => view(j).score != null).map((j) => ({ rule: view(j).pre.score, llm: view(j).score as number }))
  if (rows.length < MIN_CALIB_ROWS) return null
  const r = pickThresholds(rows, llmThreshold, current)
  return { ...r.best, current: r.current, scored: rows.length, good: rows.filter((x) => x.llm >= llmThreshold - 10).length }
}

export function postedDays(j: Job): number {
  return daysSince(j.postedAt ?? j.firstSeenAt)
}

export function agreement(pre: PreScreen, score: number | null, threshold: number): { text: string; color: string; bg: string } {
  const ruleB = pre.verdict === 'reject' ? 0 : pre.verdict === 'review' ? 1 : 2
  const llmB = score == null ? null : score < 40 ? 0 : score < threshold ? 1 : 2
  let text: string
  let color = 'var(--accent)'
  if (llmB == null) {
    text = 'LLM henüz okumadı'
    color = 'var(--dim)'
  } else if (ruleB === llmB) text = 'Hemfikir'
  else if (Math.abs(ruleB - llmB) === 1) {
    text = 'Hafif fark — LLM daha ' + (llmB > ruleB ? 'iyimser' : 'temkinli')
    color = 'var(--amber)'
  } else {
    text = 'Çelişki — ' + (ruleB < llmB ? 'kural eledi, LLM beğendi. Eleme sebebine bak, puana değil.' : 'kural beğendi, LLM eledi. Metin başlıktan farklı olabilir.')
    color = 'var(--red)'
  }
  return { text, color, bg: color === 'var(--accent)' ? 'transparent' : `color-mix(in oklab, ${color} 8%, transparent)` }
}

export type Fact = { k: string; v: string; color: string | null }

export function facts(j: Job, pre: PreScreen): Fact[] {
  const wp = workplaceView(j, pre)
  const out: Fact[] = [{ k: wp.label, v: wp.detail, color: wp.color }]
  const sen = (j.seniorityFit ?? pre.seniority) as SeniorityFit | 'unknown'
  out.push({ k: 'Kıdem', v: SENIORITY_TR[sen] ?? 'belirsiz', color: sen === 'over' ? 'var(--red)' : sen === 'stretch' || sen === 'under' ? 'var(--amber)' : null })
  const role = (j.roleFit ?? pre.role) as RoleFit
  if (role !== 'core') out.push({ k: 'Rol', v: ROLE_TR[role], color: role === 'mismatch' ? 'var(--red)' : 'var(--amber)' })
  if (j.englishLevel && j.englishLevel !== 'unknown') {
    const en = ({ none: 'gerekmez', written: 'yazılı', spoken_daily: 'günlük konuşma' } as Record<string, string>)[j.englishLevel] ?? j.englishLevel
    out.push({ k: 'İngilizce', v: en, color: j.englishLevel === 'spoken_daily' ? 'var(--amber)' : null })
  }
  if (pre.salaryTl) out.push({ k: '₺', v: pre.salaryTl.toLocaleString('tr-TR') + ' brüt', color: 'var(--accent)' })
  else if (j.salaryNote && !/belirtilmemiş|yok|none/i.test(j.salaryNote)) out.push({ k: '₺', v: j.salaryNote, color: 'var(--accent)' })
  if (j.aiUsage) out.push({ k: 'AI', v: 'ilanda geçiyor', color: 'var(--blue)' })
  if (j.easyApply) out.push({ k: 'Easy Apply', v: '', color: null })
  return out
}

export function eyebrow(j: Job): string {
  const posted = j.postedAt ? rel(j.postedAt) + (j.postedAtSource === 'derived' ? ' (yaklaşık)' : '') : 'ilk görülme ' + rel(j.firstSeenAt)
  return [STATUS_LABEL[j.status][0], posted, j.applicantCount != null ? `${j.applicantCount} başvuru` : null, j.seenCount > 1 ? `${j.seenCount} turda gördüm` : 'ilk kez'].filter(Boolean).join('  ·  ')
}

export function modelLine(j: Job): string {
  if (!j.scoredAt) return 'okumadım'
  return `${j.scoreModel ?? 'model ?'} · ${fmtWhen(j.scoredAt)}`
}

// ---- description markdown → blocks (headings, bullets, paragraphs; **bold** inline)
export type Inline = { t: string; b?: boolean; s?: boolean; i?: boolean }
export type Block = { kind: 'h' | 'li' | 'p'; parts: Inline[]; hot?: boolean; level?: number } | { kind: 'table'; rows: Inline[][][]; header: boolean }

const HOT = /ofis|remote|uzaktan|hibrit|hybrid|kampüs|on-site|onsite|office|ikamet|lokasyon|çalışma (şekli|modeli|düzeni)/i

function inline(t: string): Inline[] {
  const out: Inline[] = []
  const re = /\*\*(.+?)\*\*|~~(.+?)~~|_(.+?)_(?![\wğüşıöçĞÜŞİÖÇ])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    if (m.index > last) out.push({ t: t.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: m[1], b: true })
    else if (m[2] !== undefined) out.push({ t: m[2], s: true })
    else out.push({ t: m[3], i: true })
    last = m.index + m[0].length
  }
  if (last < t.length) out.push({ t: t.slice(last) })
  return out
}

export function mdBlocks(md: string): Block[] {
  const out: Block[] = []
  let para: string[] = []
  let table: Inline[][][] | null = null
  const flush = () => {
    if (para.length) out.push({ kind: 'p', parts: inline(para.join(' ')) })
    para = []
    if (table) out.push({ kind: 'table', rows: table, header: table.length > 1 })
    table = null
  }
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('|')) {
      if (/^\|?\s*:?-{2,}/.test(line)) continue // separator row
      const cells = line.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      if (para.length) flush()
      ;(table ??= []).push(cells)
      continue
    }
    if (table) flush()
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    const boldOnly = line.match(/^\*\*(.+)\*\*:?$/)
    const li = line.match(/^(?:[-*•·]|\d+[.)])\s+(.*)$/)
    if (h || boldOnly) {
      flush()
      out.push({ kind: 'h', parts: [{ t: (h ? h[2] : boldOnly![1]).replace(/\*\*/g, '') }], level: h ? h[1].length : 3 })
    } else if (li) {
      flush()
      out.push({ kind: 'li', parts: inline(li[1]), hot: HOT.test(li[1]) })
    } else para.push(line)
  }
  flush()
  return out
}

export function wordCount(md: string | null | undefined): number {
  return md ? md.trim().split(/\s+/).length : 0
}

/** Why a job has no LLM score yet, one bucket per job; `queued` is exactly what the server will score next. */
export type ScoreFunnel = { total: number; scored: number; queued: number; errored: number; ruleReject: number; noText: number; skipped: number; decided: number }
export function scoreFunnel(jobs: Job[], pre: (j: Job) => PreScreen): ScoreFunnel {
  const f: ScoreFunnel = { total: jobs.length, scored: 0, queued: 0, errored: 0, ruleReject: 0, noText: 0, skipped: 0, decided: 0 }
  for (const j of jobs) {
    if (j.scoredAt) f.scored++
    else if (!j.descriptionMd) {
      if (j.descriptionSkipped) f.skipped++
      else f.noText++
    } else if (j.status === 'rejected' || j.status === 'ignored') f.decided++
    else if (j.scoreError) f.errored++
    else if (pre(j).verdict === 'reject') f.ruleReject++
    else f.queued++
  }
  return f
}
