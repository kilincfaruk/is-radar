/**
 * Rule-threshold suggestion from scored ads. Plain "maximise agreement" is degenerate on this data: most scored ads
 * are weak (LLM < 40), so rejecting nearly everything maximises agreement while throwing away the good ones, and a
 * rule reject is never read by the LLM again. So: an ad the LLM rated near/above the threshold must not be rejected
 * by the rules more often than it is today, and review stays ≤ 50 (the rules are a coarse filter, the LLM decides).
 */
export type CalibRow = { rule: number; llm: number }
export type ThresholdPick = { review: number; candidate: number; agree: number; missed: number }

export const MAX_REVIEW = 50

export function pickThresholds(rows: CalibRow[], llmThreshold: number, current: { review: number; candidate: number }): { best: ThresholdPick; current: ThresholdPick } {
  const band = (s: number) => (s < 40 ? 0 : s < llmThreshold ? 1 : 2)
  const good = rows.filter((r) => r.llm >= llmThreshold - 10)
  const evalAt = (a: number, b: number): ThresholdPick => ({
    review: a,
    candidate: b,
    agree: rows.filter((r) => (r.rule < a ? 0 : r.rule < b ? 1 : 2) === band(r.llm)).length,
    missed: good.filter((r) => r.rule < a).length,
  })
  const cur = evalAt(current.review, current.candidate)
  // never suggest something that loses more good ads than today; with today's setting already too strict, only looser ones qualify
  const allowedMissed = Math.min(cur.missed, good.filter((r) => r.rule < Math.min(current.review, MAX_REVIEW)).length)
  let best: ThresholdPick | null = null
  for (let a = 15; a <= MAX_REVIEW; a += 5)
    for (let b = a + 10; b <= 90; b += 5) {
      const p = evalAt(a, b)
      if (p.missed > allowedMissed) continue
      if (!best || p.agree > best.agree || (p.agree === best.agree && p.missed < best.missed)) best = p
    }
  return { best: best ?? cur, current: cur }
}
