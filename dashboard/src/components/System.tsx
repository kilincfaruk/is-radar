import { useEffect, useState } from 'react'
import { server } from '@/lib/platform'
import type { RunRow, ServerStats } from '@/lib/platform'
import { LogPanel } from './LogPanel'
import { jobLine } from './Header'
import { durationText, fmtWhen } from '@/lib/utils'
import { MIN_DECISIONS, MIN_PER_CLASS, type LearnedModel } from '@shared/learn'
import { MIN_CALIB_ROWS, type Calibration, type ScoreFunnel, type ThresholdSuggestion } from '@/lib/model'
import { Button } from '@/components/ui/button'

type Props = {
  stats: ServerStats | null
  runs: RunRow[]
  funnel: ScoreFunnel
  calib: Calibration
  threshold: number
  thresholds: { review: number; candidate: number }
  suggestion: ThresholdSuggestion | null
  onCell: (rule: number, llm: number) => void
  onDecision: (d: 'fp' | 'fn') => void
  onApplyThresholds: (t: { review: number; candidate: number }) => void
  untriaged: number
  suspects: number
  onRun: (mode?: 'full' | 'incremental') => void
  onScore: () => void
  /** Scores near/above the threshold made with an older cv/criteria/about. */
  staleCount: number
  onRescoreStale: () => void
  learned: LearnedModel | null
  decisions: number
}

function runTone(r: RunRow, live: boolean): { color: string; note: string } {
  if (!r.finished_at) return live ? { color: 'var(--accent)', note: 'Devam ediyor' } : { color: 'var(--red)', note: 'Yarım kaldı (collector kapandı)' }
  if (r.note && /429|bırak|yarım/i.test(r.note)) return { color: 'var(--red)', note: r.note }
  if (r.rate_limited > 0 || r.errors > 0) return { color: 'var(--amber)', note: r.note ?? `${r.rate_limited}×429, ${r.errors} hata` }
  return { color: 'var(--accent)', note: r.note ?? 'Sağlıklı' }
}

function linkedinState(runs: RunRow[]): { label: string; color: string; sub: string } {
  const recent = runs.slice(0, 3)
  const rl = recent.reduce((a, r) => a + r.rate_limited, 0)
  const last = runs[0]
  if (!last) return { label: 'Bilinmiyor', color: 'var(--dim)', sub: 'Daha hiç tur atmadım.' }
  if (last.note && /429/.test(last.note) && last.rate_limited >= 3) return { label: 'Geri çekildim', color: 'var(--red)', sub: `${fmtWhen(last.started_at)} turu: ${last.note}` }
  if (rl > 0) return { label: 'Temkinli', color: 'var(--amber)', sub: `Son 3 turda ${rl}×429. Tempoyu kendim düşürüyorum; gerekirse aramaları azalt.` }
  return { label: 'Sağlıklı', color: 'var(--accent)', sub: `Son ${recent.length} turda 429 yok · ${last.requests} istek/tur` }
}

/** Last rounds, oldest → newest: three mini bar rows (duration, Claude cost, new ads). */
function RunChart({ runs }: { runs: RunRow[] }) {
  const done = runs.filter((r) => r.finished_at).slice(0, 14).reverse()
  if (done.length < 2) return null
  const mins = (r: RunRow) => Math.max(0, Math.round((new Date(r.finished_at!).getTime() - new Date(r.started_at).getTime()) / 60_000))
  const rows: Array<{ label: string; val: (r: RunRow) => number; fmt: (n: number) => string; color: string }> = [
    { label: 'süre', val: mins, fmt: (n) => `${n} dk`, color: 'var(--blue)' },
    { label: 'claude', val: (r) => r.cost_usd ?? 0, fmt: (n) => `$${n.toFixed(2)}`, color: 'var(--amber)' },
    { label: 'yeni ilan', val: (r) => r.new_jobs, fmt: (n) => String(n), color: 'var(--accent)' },
  ]
  return (
    <div className="card" style={{ padding: '12px 16px', borderRadius: 12, marginBottom: 10 }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>Son {done.length} tur · eskiden yeniye</div>
      {rows.map((m) => {
        const vals = done.map(m.val)
        const max = Math.max(...vals, 0.0001)
        const sum = vals.reduce((a, b) => a + b, 0)
        return (
          <div key={m.label} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr) 110px', gap: 10, alignItems: 'end', height: 30, marginBottom: 6 }}>
            <span className="eyebrow" style={{ fontSize: 10.5, alignSelf: 'center' }}>{m.label}</span>
            <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 26 }}>
              {done.map((r, i) => (
                <div key={r.id} title={`${fmtWhen(r.started_at)} · ${m.fmt(vals[i])}${r.rate_limited ? ` · ${r.rate_limited}×429` : ''}`} style={{ flex: 1, height: Math.max(2, Math.round((vals[i] / max) * 26)), background: r.rate_limited ? 'var(--red)' : m.color, opacity: i === done.length - 1 ? 1 : 0.55, borderRadius: 2 }} />
              ))}
            </div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right', alignSelf: 'center' }} title="son tur · toplam">
              {m.fmt(vals[vals.length - 1])} <span style={{ color: 'var(--dim)' }}>/ {m.label === 'süre' ? `${Math.round(sum / vals.length)} dk ort.` : m.fmt(sum)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function usageLine(s: ServerStats | null): string | null {
  const u = s?.usage
  if (!u || u.calls === 0) return null
  const hours = u.ms / 3_600_000
  const w = s.usage7d
  return `Claude: ${u.calls} çağrı · $${u.costUsd.toFixed(2)} · ${hours >= 1 ? `${hours.toFixed(1)} sa` : `${Math.round(u.ms / 60_000)} dk`} model süresi (${fmtWhen(u.since).toLowerCase()}'dan beri)${w && w.runs ? ` · son 7 gün: ${w.runs} tur, $${w.costUsd.toFixed(2)}` : ''}${u.failures ? ` · ${u.failures} başarısız` : ''}`
}

function FunnelRow({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '36px minmax(0,1fr)', gap: 8, color: n === 0 ? 'var(--dim)' : tone ?? 'var(--muted)' }}>
      <span style={{ textAlign: 'right' }}>{n}</span>
      <span>{label}</span>
    </div>
  )
}

export function System(p: Props) {
  const f = p.funnel
  const [reports, setReports] = useState<Array<{ name: string; at: string; bytes: number }>>([])
  const lastRunKey = `${p.runs[0]?.id ?? 0}:${p.runs[0]?.finished_at ?? ''}`
  useEffect(() => {
    server.reports().then(setReports).catch(() => {})
  }, [lastRunKey])
  const [logOpen, setLogOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('isradar.logOpen') === '1'
    } catch {
      return false
    }
  })
  const toggleLog = () => {
    setLogOpen((v) => {
      try {
        localStorage.setItem('isradar.logOpen', v ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !v
    })
  }
  const jl = jobLine(p.stats)
  const task = p.stats?.task
  const pct = task && task.total > 0 ? Math.round((task.done / task.total) * 100) : p.stats?.collecting ? 0 : 0
  const sch = p.stats?.schedule
  const li = linkedinState(p.runs)
  const busy = !!(p.stats?.collecting || p.stats?.task)
  const sub = p.stats?.collecting ? [p.stats.progress?.phase, p.stats.progress?.detail].filter(Boolean).join(' · ') || 'tur çalışıyor' : task ? task.note ?? `${task.done}/${task.total}` : sch?.nextRunAt ? `Sıradaki turu ${fmtWhen(sch.nextRunAt).toLowerCase()} atacağım` : 'Bu saatlerde tur atmıyorum'

  return (
    <main className="page">
      <div style={{ width: '100%', maxWidth: 860 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: 26 }}>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Şu an</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{jl.text}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{sub}</div>
            <div style={{ height: 4, background: 'var(--chip)', borderRadius: 99, marginTop: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: 'var(--accent)', width: `${pct}%`, transition: 'width .6s ease' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <Button variant="outline" size="sm" onClick={() => p.onRun()} disabled={busy}>Tur başlat</Button>
              <Button variant="outline" size="sm" onClick={() => p.onRun('full')} disabled={busy} title="30 günlük tam tarama">Tam tur</Button>
              <Button variant="outline" size="sm" onClick={p.onScore} disabled={busy || (p.funnel.queued === 0 && p.funnel.errored === 0)} title={p.funnel.errored ? `${p.funnel.errored} hatalı ilanı da yeniden denerim` : undefined}>
                Birikeni skorla{p.funnel.queued + p.funnel.errored > 0 ? ` (${p.funnel.queued + p.funnel.errored})` : ''}
              </Button>
            </div>
          </div>
          <div className="card">
            <div className="eyebrow" style={{ marginBottom: 10 }}>Skor durumu · {f.total} ilan</div>
            <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
              <div><div className="mono" style={{ fontSize: 28, color: f.queued ? 'var(--accent)' : 'var(--text)' }}>{f.queued}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>sırada</div></div>
              <div><div className="mono" style={{ fontSize: 28 }}>{p.untriaged}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>elenmemiş</div></div>
              <div><div className="mono" style={{ fontSize: 28, color: p.suspects ? 'var(--amber)' : 'var(--text)' }}>{p.suspects}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>çelişki</div></div>
            </div>
            <div className="mono" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 12, color: 'var(--muted)' }}>
              <FunnelRow n={f.scored} label="skorladım" />
              <FunnelRow n={f.queued} label="sırada · metni var, sonraki skorlamada okurum" tone={f.queued ? 'var(--accent)' : undefined} />
              <FunnelRow n={f.errored} label="hatalı · “Birikeni skorla” yeniden dener" tone={f.errored ? 'var(--red)' : undefined} />
              <FunnelRow n={f.ruleReject} label="kural eledi · LLM bütçesini harcamıyorum" />
              <FunnelRow n={f.decided} label="sen eledin · yoksay/reddet" />
              <FunnelRow n={f.noText} label="metni yok · sonraki turda çekerim" tone={f.noText ? 'var(--amber)' : undefined} />
              <FunnelRow n={f.skipped} label="başlık kapısı · metni bilerek çekmedim" />
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12 }}>
              {sch ? `Her ${sch.everyMinutes} dk, ${String(sch.activeHours[0]).padStart(2, '0')}–${String(sch.activeHours[1]).padStart(2, '0')}` : '—'}
            </div>
          </div>
          <div className="card" style={{ borderColor: `color-mix(in oklab, ${li.color} 40%, transparent)` }}>
            <div className="eyebrow" style={{ marginBottom: 10 }}>LinkedIn</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: li.color }}>{li.label}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>{li.sub}</div>
          </div>
        </div>

        {p.staleCount > 0 && (
          <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', borderColor: 'color-mix(in oklab, var(--amber) 40%, transparent)' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 13.5 }}>
              <b style={{ color: 'var(--amber)' }}>{p.staleCount} iyi ilan eski profilinle skorlanmış.</b>{' '}
              <span style={{ color: 'var(--muted)' }}>CV'n, kriterlerin ya da about.md sonradan değişti. Bunları güncel halinle bir daha okuyayım, sıralama kaymasın.</span>
            </div>
            <Button variant="outline" size="sm" onClick={p.onRescoreStale} disabled={busy}>Yeniden skorla</Button>
          </div>
        )}
        <div className="card" style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Kalibrasyon · kural motoru ile LLM · {p.calib.scored} skorlu ilan</div>
          {p.calib.scored < 5 ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Bunun için en az 5 skorlu ilan lazım.</div>
          ) : (
            <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                <div><div className="mono" style={{ fontSize: 28 }}>{Math.round((p.calib.agree / p.calib.scored) * 100)}%</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>hemfikir</div></div>
                <div><div className="mono" style={{ fontSize: 28, color: p.calib.ruleRejectLlmGood ? 'var(--amber)' : 'var(--text)' }}>{p.calib.ruleRejectLlmGood}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>kural eledi, LLM ≥ 60</div></div>
                <div><div className="mono" style={{ fontSize: 28, color: p.calib.ruleCandLlmBad ? 'var(--amber)' : 'var(--text)' }}>{p.calib.ruleCandLlmBad}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>kural aday, LLM &lt; 40</div></div>
              </div>
              <table className="mono" style={{ borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: 'var(--dim)' }}>
                    <th style={{ textAlign: 'left', fontWeight: 400, padding: '2px 10px 6px 0' }}>kural \ LLM</th>
                    <th style={{ fontWeight: 400, padding: '2px 10px' }}>&lt; 40</th>
                    <th style={{ fontWeight: 400, padding: '2px 10px' }}>40–{p.threshold - 1}</th>
                    <th style={{ fontWeight: 400, padding: '2px 10px' }}>≥ {p.threshold}</th>
                    <th style={{ fontWeight: 400, padding: '2px 0 2px 10px' }}>ort.</th>
                  </tr>
                </thead>
                <tbody>
                  {(['reject', 'review', 'candidate'] as const).map((k, ri) => (
                    <tr key={k} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '5px 10px 5px 0', color: k === 'reject' ? 'var(--red)' : k === 'review' ? 'var(--amber)' : 'var(--accent)' }}>{k}</td>
                      {p.calib.matrix[ri].map((n, ci) => (
                        <td key={ci} style={{ padding: '5px 10px', textAlign: 'right' }}>
                          <button className="link" onClick={() => n && p.onCell(ri, ci)} disabled={!n} title={n ? 'Bu hücredeki ilanları aç' : undefined} style={{ color: ri === ci ? 'var(--text)' : n ? 'var(--amber)' : 'var(--dim)', fontWeight: ri === ci ? 600 : 400, fontFamily: 'inherit', fontSize: 'inherit', cursor: n ? 'pointer' : 'default' }}>
                            {n}
                          </button>
                        </td>
                      ))}
                      <td style={{ padding: '5px 0 5px 10px', textAlign: 'right', color: 'var(--muted)' }}>{p.calib.avgByVerdict[k] ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 260 }}>Köşegen = hemfikir; sayıya tıkla, o ilanları açayım. Sağ üst (kural eledi, LLM beğendi) büyükse kural motoru fazla sert; sol alt büyükse fazla cömert.</div>
            </div>
          )}
          {p.calib.decisions.pos + p.calib.decisions.neg > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Kararların vs LLM · {p.calib.decisions.pos} olumlu, {p.calib.decisions.neg} olumsuz</div>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div><div className="mono" style={{ fontSize: 24 }}>{p.calib.decisions.posAvg ?? '—'}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>beğendiklerinin ort. skoru</div></div>
                <div><div className="mono" style={{ fontSize: 24 }}>{p.calib.decisions.negAvg ?? '—'}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>geçtiklerinin ort. skoru</div></div>
                <div>
                  <button className="link mono" style={{ fontSize: 24, color: p.calib.decisions.fp ? 'var(--amber)' : 'var(--text)' }} onClick={() => p.calib.decisions.fp && p.onDecision('fp')} disabled={!p.calib.decisions.fp}>{p.calib.decisions.fp}</button>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>LLM ≥ {p.threshold}, sen geçtin</div>
                  {p.calib.decisions.fpReasons.length > 0 && <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>{p.calib.decisions.fpReasons.map(([r, n]) => `${r} ${n}`).join(' · ')}</div>}
                </div>
                <div>
                  <button className="link mono" style={{ fontSize: 24, color: p.calib.decisions.fn ? 'var(--amber)' : 'var(--text)' }} onClick={() => p.calib.decisions.fn && p.onDecision('fn')} disabled={!p.calib.decisions.fn}>{p.calib.decisions.fn}</button>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>LLM &lt; 40, sen beğendin</div>
                </div>
                <div style={{ fontSize: 12, color: 'var(--dim)', maxWidth: 300 }}>Asıl doğru senin kararın. Bu iki sayı büyükse Ayarlar → "Kriter incelemesi"ni çalıştır; kararlarından criteria.md / about.md için değişiklik çıkarırım.</div>
              </div>
            </div>
          )}
          {p.calib.scored >= 5 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line)', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <span className="mono" style={{ color: 'var(--muted)' }}>eşikler: reject &lt; {p.thresholds.review} · review &lt; {p.thresholds.candidate} · candidate ≥ {p.thresholds.candidate}</span>
              {p.suggestion ? (
                p.suggestion.agree - p.suggestion.current.agree >= Math.max(2, Math.ceil(p.suggestion.scored * 0.05)) || p.suggestion.missed < p.suggestion.current.missed ? (
                  <>
                    {p.suggestion.current.missed > 0 && (
                      <span style={{ color: 'var(--red)', flexBasis: '100%' }}>
                        Şu anki eşiklerle Claude'un {p.threshold - 10}+ verdiği {p.suggestion.current.missed} ilanı kural motoru eliyor; bunlar bir daha okunmaz.
                      </span>
                    )}
                    <span style={{ color: 'var(--accent)' }}>
                      Öneri: review ≥ {p.suggestion.review}, candidate ≥ {p.suggestion.candidate} → hemfikir %{Math.round((p.suggestion.agree / p.suggestion.scored) * 100)} (şu an %{Math.round((p.suggestion.current.agree / p.suggestion.scored) * 100)}), elenen iyi ilan {p.suggestion.missed}
                    </span>
                    <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => p.onApplyThresholds({ review: p.suggestion!.review, candidate: p.suggestion!.candidate })}>Uygula</Button>
                  </>
                ) : (
                  <span style={{ color: 'var(--dim)' }}>Eşikler bu veriyle zaten en iyi noktada.</span>
                )
              ) : (
                <span style={{ color: 'var(--dim)' }}>Eşik önerebilmem için en az {MIN_CALIB_ROWS} skorlu ilan lazım ({p.calib.scored}/{MIN_CALIB_ROWS}).</span>
              )}
            </div>
          )}
        </div>

        <div className="card" style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Kararlarından öğrendiklerim</div>
          {!p.learned ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>
              Şimdilik {p.decisions} karar var. En az {MIN_DECISIONS} karar lazım, en az {MIN_PER_CLASS}'i beğendiğin (shortlist / başvurdum / görüşme), {MIN_PER_CLASS}'i geçtiğin
              (yoksay / reddet) olsun. Sonra skoru senin tercihlerine göre düzeltip "sana göre" sıralamayı açarım.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
                <div><div className="mono" style={{ fontSize: 28 }}>{p.learned.n}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>karar ({p.learned.pos} beğendin, {p.learned.neg} geçtin)</div></div>
                <div><div className="mono" style={{ fontSize: 28, color: p.learned.useful ? 'var(--accent)' : 'var(--text)' }}>{p.learned.auc != null ? p.learned.auc.toFixed(2) : '—'}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>öğrendiğim model (AUC)</div></div>
                <div><div className="mono" style={{ fontSize: 28 }}>{p.learned.aucScore != null ? p.learned.aucScore.toFixed(2) : '—'}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>sadece skor (AUC)</div></div>
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 10 }}>
                {p.learned.useful
                  ? 'Model senin kararlarını skordan daha iyi tahmin ediyor. Listede skorun altında "%" olarak gösteriyorum, "sana göre" sıralaması da bunu kullanıyor.'
                  : 'Kararların şimdilik skorla uyumlu; model skordan belirgin iyi değil, o yüzden listede göstermiyorum.'}{' '}
                AUC: rastgele bir beğendiğin ilanın geçtiğin bir ilandan önde sıralanma ihtimali, 5 katlı çapraz doğrulamayla.
              </div>
              <div className="mono" style={{ fontSize: 12, lineHeight: 1.8, marginTop: 10 }}>
                {p.learned.effects.filter((e) => Math.abs(e.weight) >= 0.25).slice(0, 6).map((e) => (
                  <div key={e.key} style={{ color: e.weight > 0 ? 'var(--accent)' : 'var(--red)' }}>
                    {e.weight > 0 ? '▲' : '▼'} {e.label}: skorun söylediğinden {e.weight > 0 ? 'daha çok seviyorsun' : 'daha az seviyorsun'} <span style={{ color: 'var(--dim)' }}>({e.count} ilan)</span>
                  </div>
                ))}
                {p.learned.effects.every((e) => Math.abs(e.weight) < 0.25) && <div style={{ color: 'var(--dim)' }}>Ağırlıklardan belirgin sapma yok.</div>}
              </div>
            </>
          )}
        </div>

        <div style={{ marginBottom: 26 }}>
          <LogPanel open={logOpen} onToggle={toggleLog} />
        </div>

        <div className="card" style={{ marginBottom: 26 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>HTML rapor</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>
            Her tur bitince tek dosyalık bir rapor yazıyorum: bu turda gelen iyi ilanlar, bakmaya değerler, eşiğe yakınlar ve takiptekiler.
            İnternetsiz açılır, istediğine gönderebilirsin.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button asChild variant="outline" size="sm"><a href="/api/report" target="_blank" rel="noreferrer">Şimdiki durumu aç</a></Button>
            <Button asChild variant="outline" size="sm"><a href="/api/report?download=1">İndir (.html)</a></Button>
            {reports.length > 0 && <a className="link" href="/api/reports/latest.html" target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>son tur raporu</a>}
          </div>
          {reports.length > 1 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>Önceki raporlar ({reports.length})</summary>
              <div className="mono" style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8, fontSize: 12 }}>
                {reports.map((r) => (
                  <span key={r.name}>
                    <a className="link" href={`/api/reports/${r.name}`} target="_blank" rel="noreferrer">{fmtWhen(r.at)}</a>
                    <span style={{ color: 'var(--dim)' }}> · {Math.round(r.bytes / 1024)} KB · </span>
                    <a className="link" href={`/api/reports/${r.name}?download=1`}>indir</a>
                  </span>
                ))}
              </div>
            </details>
          )}
        </div>

        <div className="hr" style={{ marginBottom: 10 }}>
          <span className="eyebrow">Son turlar</span>
        </div>
        {usageLine(p.stats) && <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>{usageLine(p.stats)}</div>}
        <RunChart runs={p.runs} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {p.runs.length === 0 && <div style={{ fontSize: 13, color: 'var(--dim)' }}>Daha hiç tur yok.</div>}
          {p.runs.map((r, i) => {
            const t = runTone(r, i === 0 && !!p.stats?.collecting)
            return (
              <div key={r.id} className="card" style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr) auto', gap: 16, alignItems: 'center', padding: '12px 16px', borderRadius: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 99, background: t.color }} />
                  <span className="mono" style={{ fontSize: 13 }}>{fmtWhen(r.started_at)}</span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    {r.cards} kart · {r.new_jobs} yeni · {r.details} metin{r.kind && r.kind !== 'collect' ? ` · ${r.kind}` : ''}
                  </div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 2 }}>
                    {r.searches} arama · {r.scored} skor · {r.researched} araştırma · {r.requests} istek · {r.rate_limited}×429{r.finished_at ? ` · ${durationText(r.started_at, r.finished_at)}` : ''}{r.claude_calls ? ` · claude ${r.claude_calls} çağrı${r.cost_usd ? ` $${r.cost_usd.toFixed(2)}` : ''}` : ''}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: t.color, textAlign: 'right', maxWidth: 220 }}>{t.note}</div>
              </div>
            )
          })}
        </div>
      </div>
    </main>
  )
}
