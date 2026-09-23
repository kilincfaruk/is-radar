/**
 * Learns from the user's own decisions. Positive = shortlist / applied / interviewing, negative = ignored / rejected.
 * Model: logistic regression on the deterministic score plus a handful of binary facts. The score term carries the
 * current rules; the binary terms are L2-shrunk toward 0, so with few decisions the model is just "the score, as a
 * probability", and it only deviates where the user's clicks consistently disagree with the weights
 * (e.g. office jobs rejected even at 70). Evaluated with k-fold cross-validated AUC against the raw score.
 */
import type { Job } from './types.ts'

export const MIN_DECISIONS = 30
export const MIN_PER_CLASS = 8
const POS = new Set(['shortlist', 'applied', 'interviewing'])
const NEG = new Set(['ignored', 'rejected'])

type FeatureDef = { key: string; label: string; get: (j: Job) => number }

const wp = (j: Job) => (j.facts as { workplace?: string } | null | undefined)?.workplace ?? j.workplaceLlm ?? 'unknown'
const fact = <T,>(j: Job, k: string): T | undefined => (j.facts as Record<string, T> | null | undefined)?.[k]

export const FEATURES: FeatureDef[] = [
  { key: 'remote', label: 'tam remote', get: (j) => Number(wp(j) === 'remote') },
  { key: 'hybrid_home', label: 'hibrit, kabul edilen şehir', get: (j) => Number(wp(j) === 'hybrid_ankara' || wp(j) === 'hybrid_home') },
  { key: 'office_home', label: 'tam ofis, kabul edilen şehir', get: (j) => Number(wp(j) === 'onsite_ankara' || wp(j) === 'onsite_home') },
  { key: 'elsewhere', label: 'başka şehir', get: (j) => Number(wp(j) === 'hybrid_other' || wp(j) === 'onsite_other') },
  { key: 'wp_unknown', label: 'çalışma şekli belirsiz', get: (j) => Number(wp(j) === 'unknown') },
  { key: 'stretch', label: 'kıdem biraz üstünde', get: (j) => Number(j.seniorityFit === 'stretch') },
  { key: 'over', label: 'kıdem fazla üstünde', get: (j) => Number(j.seniorityFit === 'over') },
  { key: 'adjacent', label: 'yakın rol', get: (j) => Number(j.roleFit === 'adjacent') },
  { key: 'bridge', label: 'köprü rol', get: (j) => Number(j.roleFit === 'bridge') },
  { key: 'english_spoken', label: 'günlük sözlü İngilizce', get: (j) => Number(j.englishLevel === 'spoken_daily') },
  { key: 'ai_usage', label: 'AI araçları', get: (j) => Number(!!j.aiUsage) },
  { key: 'salary_known', label: 'maaş yazıyor', get: (j) => Number(!!j.salaryNote) },
  { key: 'agency_shift', label: 'ajans / vardiya', get: (j) => Number(!!fact<boolean>(j, 'agency') || !!fact<boolean>(j, 'shift')) },
]

export type LearnedModel = {
  bias: number
  wScore: number
  w: number[]
  n: number
  pos: number
  neg: number
  /** Cross-validated AUC of this model and of the raw score on the same folds (null when too few rows per fold). */
  auc: number | null
  aucScore: number | null
  /** The model ranks better than the score alone: only then use it for sorting. */
  useful: boolean
  /** Features ordered by effect size, for the explanation. */
  effects: Array<{ key: string; label: string; weight: number; count: number }>
}

export function label(j: Job): 0 | 1 | null {
  if (j.scoredAt == null || j.score == null) return null
  if (POS.has(j.status)) return 1
  if (NEG.has(j.status)) return 0
  return null
}

const sig = (z: number) => 1 / (1 + Math.exp(-z))
const scoreX = (s: number) => (s - 60) / 20

type Row = { x: number[]; s: number; y: number }

function rowOf(j: Job): Row {
  return { x: FEATURES.map((f) => f.get(j)), s: scoreX(j.score ?? 0), y: label(j) ?? 0 }
}

function fit(rows: Row[], lambda = 1.5, iters = 1500, lr = 0.15): { bias: number; wScore: number; w: number[] } {
  const k = FEATURES.length
  let bias = 0
  let wScore = 1
  const w = new Array<number>(k).fill(0)
  const n = rows.length
  for (let it = 0; it < iters; it++) {
    let gb = 0
    let gs = 0
    const gw = new Array<number>(k).fill(0)
    for (const r of rows) {
      let z = bias + wScore * r.s
      for (let i = 0; i < k; i++) z += w[i] * r.x[i]
      const e = sig(z) - r.y
      gb += e
      gs += e * r.s
      for (let i = 0; i < k; i++) gw[i] += e * r.x[i]
    }
    bias -= (lr * gb) / n
    wScore -= (lr * gs) / n
    // L2 toward 0 on the fact terms only: they must earn their weight from the data
    for (let i = 0; i < k; i++) w[i] -= lr * (gw[i] / n + (lambda * w[i]) / n)
  }
  return { bias, wScore, w }
}

function predictRow(m: { bias: number; wScore: number; w: number[] }, r: Row): number {
  let z = m.bias + m.wScore * r.s
  for (let i = 0; i < m.w.length; i++) z += m.w[i] * r.x[i]
  return sig(z)
}

/** Mann-Whitney AUC: probability a random positive outranks a random negative. */
export function auc(scores: number[], ys: number[]): number | null {
  const pos = scores.filter((_, i) => ys[i] === 1)
  const neg = scores.filter((_, i) => ys[i] === 0)
  if (!pos.length || !neg.length) return null
  let wins = 0
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0
  return wins / (pos.length * neg.length)
}

export function learn(jobs: Job[], folds = 5): LearnedModel | null {
  const labelled = jobs.filter((j) => label(j) !== null)
  const rows = labelled.map(rowOf)
  const pos = rows.filter((r) => r.y === 1).length
  const neg = rows.length - pos
  if (rows.length < MIN_DECISIONS || pos < MIN_PER_CLASS || neg < MIN_PER_CLASS) return null
  // deterministic folds (stable across reloads): interleave by index
  const predM: number[] = new Array(rows.length).fill(0)
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => i % folds !== f)
    const m = fit(train)
    rows.forEach((r, i) => {
      if (i % folds === f) predM[i] = predictRow(m, r)
    })
  }
  const ys = rows.map((r) => r.y)
  const aucM = auc(predM, ys)
  const aucS = auc(rows.map((r) => r.s), ys)
  const m = fit(rows)
  const effects = FEATURES.map((f, i) => ({ key: f.key, label: f.label, weight: m.w[i], count: rows.filter((r) => r.x[i] === 1).length }))
    .filter((e) => e.count > 0)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  return { ...m, n: rows.length, pos, neg, auc: aucM, aucScore: aucS, useful: aucM != null && aucS != null && aucM > aucS + 0.02, effects }
}

/** Probability the user would pursue this ad, 0..1 (null without a score). */
export function predict(m: LearnedModel, j: Job): number | null {
  if (j.score == null || j.scoredAt == null) return null
  return predictRow(m, rowOf(j))
}
