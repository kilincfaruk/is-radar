import { useMemo, type RefObject } from 'react'
import type { Job } from '@/lib/types'
import type { ServerStats } from '@/lib/platform'
import { bucket, STATUS_LABEL, type JobView, type ScoreFunnel } from '@/lib/model'
import { EMPTY_FILTERS, facets, filterCount, summary, type Ctx, type Filters } from '@/lib/filters'
import { cx, fmtWhen, rel } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Separator } from '@/components/ui/separator'

export type QueueKey = 'new' | 'suspect' | 'rejected' | 'decided' | 'all'

type Props = {
  stats: ServerStats | null
  funnel: ScoreFunnel
  queue: QueueKey
  queueCounts: Record<QueueKey, number>
  onQueue: (q: QueueKey) => void
  raw: Job[]
  rows: Job[]
  view: (j: Job) => JobView
  threshold: number
  selectedId: string | null
  onSelect: (id: string) => void
  filters: Filters
  onFilters: (f: Filters) => void
  filtersOpen: boolean
  onFiltersOpen: (v: boolean) => void
  searchRef: RefObject<HTMLInputElement | null>
  /** ISO start of the last completed round: ads first seen after it get the "yeni" pill. */
  lastRoundAt: string | null
  unreadCount: number
  /** Probability from the model learned on your decisions (only when it ranks better than the score). */
  youOf: ((j: Job) => number | null) | null
  sortBy: 'score' | 'you'
  /** null until there are enough decisions to learn from. */
  onSortBy: ((s: 'score' | 'you') => void) | null
}

const QUEUES: Array<{ key: QueueKey; label: string }> = [
  { key: 'new', label: 'Bakmaya değer' },
  { key: 'suspect', label: 'Çelişkili' },
  { key: 'rejected', label: 'Elenen' },
  { key: 'decided', label: 'Karar verdiklerin' },
  { key: 'all', label: 'Tümü' },
]

/** Rich hover card for a list row: the model's one-liner, score breakdown, top pros/cons and what the rule engine saw. */
function RowPreview({ j, v, you }: { j: Job; v: JobView; you: number | null }) {
  const parts = (j.scoreParts ?? []).filter((x) => x.applied)
  const cons = [...j.redFlags, ...j.cons].slice(0, 3)
  const rule = [...v.pre.flags, ...v.pre.bonuses, ...v.pre.reasons].slice(0, 3).join(' · ')
  return (
    <div className="flex flex-col gap-2 text-[13px] leading-snug">
      <div>
        <div className="font-semibold">{j.title}</div>
        <div className="text-muted-foreground">{j.company ?? '–'} · {v.wp.label}</div>
      </div>
      {parts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {parts.map((x, i) => (
            <Badge key={i} variant="outline" className="font-mono text-[11px] font-normal" style={{ color: x.kind === 'base' ? undefined : x.kind === 'cap' ? 'var(--amber)' : x.value > 0 ? 'var(--accent)' : 'var(--red)' }}>
              {x.kind === 'base' ? `${x.value} ${x.label}` : x.kind === 'cap' ? `≤${x.value} ${x.label}` : `${x.value > 0 ? '+' : '−'}${Math.abs(x.value)} ${x.label}`}
            </Badge>
          ))}
        </div>
      )}
      {j.summary ? <p>{j.summary}</p> : <p className="text-muted-foreground">{j.scoredAt ? 'Özet yok.' : 'Claude henüz okumadı.'}</p>}
      {(j.pros.length > 0 || cons.length > 0) && (
        <ul className="flex flex-col gap-0.5">
          {j.pros.slice(0, 3).map((x, i) => (
            <li key={'p' + i} className="flex gap-1.5"><span className="text-primary">+</span><span>{x}</span></li>
          ))}
          {cons.map((x, i) => (
            <li key={'c' + i} className="flex gap-1.5"><span style={{ color: 'var(--amber)' }}>−</span><span>{x}</span></li>
          ))}
        </ul>
      )}
      <Separator />
      <div className="font-mono text-[11.5px] text-muted-foreground">
        kural {v.pre.verdict} ({v.pre.score}){rule ? ` · ${rule}` : ''}
        {you != null && <span style={{ color: 'var(--blue)' }}> · sana göre %{Math.round(you * 100)}</span>}
        {j.decisionReason && <> · sebep: {j.decisionReason}</>}
      </div>
    </div>
  )
}

function sinceLine(stats: ServerStats | null): string {
  const r = stats?.lastRun
  if (!r) return 'Daha hiç tur atmadım'
  return `Son tur ${fmtWhen(r.finished_at ?? r.started_at).toLowerCase()} · ${r.new_jobs} yeni · ${r.scored} skor${r.rate_limited ? ` · ${r.rate_limited}×429` : ''}`
}

export function Inbox(p: Props) {
  const ctx: Ctx = useMemo(() => ({ view: p.view, threshold: p.threshold }), [p.view, p.threshold])
  const fc = filterCount(p.filters)
  const hidden = p.raw.length - p.rows.length
  const line = fc ? `${p.rows.length} ilan · ${hidden} gizli` : `${p.rows.length} ilan`
  const fx = useMemo(() => facets(p.raw, p.filters, ctx), [p.raw, p.filters, ctx])
  const sum = summary(p.filters, p.threshold)

  return (
    <aside className="aside">
      <div style={{ padding: '14px 16px 10px', borderBottom: '1px solid var(--line)' }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 10 }}>
          {sinceLine(p.stats)}
          {p.unreadCount > 0 && <span style={{ color: 'var(--text)' }}> · {p.unreadCount} görülmemiş</span>}
          {p.funnel.queued > 0 && <span style={{ color: 'var(--accent)' }}> · {p.funnel.queued} skor sırada</span>}
          {p.funnel.noText > 0 && <span style={{ color: 'var(--amber)' }}> · {p.funnel.noText} metinsiz</span>}
        </div>
        {p.onSortBy && (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 8, fontSize: 12 }}>
            <span style={{ color: 'var(--dim)' }}>Sırala:</span>
            <button className={cx('chip', p.sortBy === 'score' && 'on')} onClick={() => p.onSortBy?.('score')}>skor</button>
            <button className={cx('chip', p.sortBy === 'you' && 'on')} onClick={() => p.onSortBy?.('you')} title="Shortlist/yoksay kararlarından öğrendiğim modele göre">sana göre</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {QUEUES.map((q, i) => (
            <button key={q.key} className={cx('pill', p.queue === q.key && 'on')} onClick={() => p.onQueue(q.key)} title={`${i + 1}`}>
              {q.label} <span className="n">{p.queueCounts[q.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <input ref={p.searchRef} className="input" value={p.filters.q} onChange={(e) => p.onFilters({ ...p.filters, q: e.target.value })} placeholder="Başlık, şirket, anahtar kelime…" style={{ paddingRight: 30 }} data-testid="search" />
            {p.filters.q ? (
              <button onClick={() => p.onFilters({ ...p.filters, q: '' })} title="Temizle" style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: 'var(--dim)', fontSize: 14, lineHeight: 1, padding: '2px 4px' }}>
                ×
              </button>
            ) : (
              <kbd className="k" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--dim)' }}>/</kbd>
            )}
          </div>
          <button
            onClick={() => p.onFiltersOpen(!p.filtersOpen)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, background: p.filtersOpen ? 'var(--chip)' : 'none', border: `1px solid ${fc ? 'color-mix(in oklab, var(--accent) 40%, transparent)' : 'var(--line)'}`, borderRadius: 8, padding: '7px 10px', fontSize: 12.5, fontWeight: 600, color: fc ? 'var(--accent)' : 'var(--muted)' }}
          >
            <span>Filtre</span>
            {fc > 0 && <span className="mono" style={{ fontSize: 11, padding: '0 6px', borderRadius: 99, background: 'var(--accent)', color: 'var(--accent-ink)' }}>{fc}</span>}
            <span style={{ fontSize: 10, opacity: 0.7 }}>{p.filtersOpen ? '▴' : '▾'}</span>
          </button>
        </div>
        {p.filtersOpen && (
          <div className="rise" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {fx.map((f) => (
              <div key={f.key} style={{ display: 'grid', gridTemplateColumns: '56px minmax(0,1fr)', gap: 5, alignItems: 'start' }}>
                <span className="eyebrow" style={{ letterSpacing: '.04em', fontSize: 10.5, lineHeight: '24px' }}>{f.label}</span>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {f.opts.map((o) => (
                    <button key={o.label} className={cx('chip', o.on && 'on', !o.on && o.count === 0 && 'zero')} title={o.title} onClick={() => p.onFilters(o.toggle(p.filters))}>
                      {o.label}
                      <span className="n">{o.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
              <span>{line}</span>
              {fc > 0 && (
                <button className="link" style={{ fontSize: 11.5 }} onClick={() => p.onFilters(EMPTY_FILTERS)}>
                  Temizle
                </button>
              )}
            </div>
          </div>
        )}
        {!p.filtersOpen && fc > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {sum.map((s) => (
              <button key={s.label} className="chip on" title="Kaldır" onClick={() => p.onFilters(s.remove(p.filters))} style={{ padding: '2px 8px', fontSize: 11.5, fontWeight: 600, gap: 5 }}>
                {s.label}
                <span style={{ opacity: 0.7 }}>×</span>
              </button>
            ))}
            <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginLeft: 'auto' }}>{line}</span>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 6 }}>
        {p.rows.map((j) => {
          const v = p.view(j)
          const s = v.score
          const wp = v.wp
          const on = j.linkedinJobId === p.selectedId
          const st = STATUS_LABEL[j.status]
          return (
            <HoverCard key={j.linkedinJobId} openDelay={550} closeDelay={60}>
            <HoverCardTrigger asChild>
            <div className={cx('row', on && 'on', j.status !== 'new' && p.queue !== 'decided' && 'done', !j.viewedAt && j.status === 'new' && 'unread')} onClick={() => p.onSelect(j.linkedinJobId)} data-id={j.linkedinJobId}>
              <div className="score" style={{ color: bucket(s, p.threshold).color }}>
                {s == null ? '—' : s}
                {p.youOf && s != null && (() => {
                  const y = p.youOf(j)
                  return y == null ? null : <div title="Kararlarına göre ilgilenme ihtimalin" style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--blue)', marginTop: 1 }}>%{Math.round(y * 100)}</div>
                })()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                  {!j.viewedAt && j.status === 'new' && <span className="dot" title="Henüz açmadın" />}
                  <span className="t" style={{ color: j.status !== 'new' ? 'var(--muted)' : j.viewedAt ? 'var(--muted)' : 'var(--text)' }}>{j.title}</span>
                  {p.lastRoundAt && j.firstSeenAt >= p.lastRoundAt && j.status === 'new' && <span className="pill-new">yeni</span>}
                  {v.flagged && <span style={{ color: 'var(--red)', fontSize: 12, flexShrink: 0 }}>⚑</span>}
                </div>
                <div className="s">
                  {j.company ?? '–'} <span className="dim">·</span> <span style={{ color: wp.color }}>{wp.label}</span>
                </div>
                <div className="m">
                  <span>{rel(j.postedAt ?? j.firstSeenAt)}</span>
                  <span style={{ color: v.pre.verdict === 'reject' ? 'var(--red)' : v.pre.verdict === 'candidate' ? 'var(--accent)' : undefined }}>kural {v.pre.verdict}</span>
                  {j.status !== 'new' && <span style={{ color: st[1] }}>{st[0]}</span>}
                  {j.source?.startsWith('ats:') && <span style={{ color: 'var(--blue)' }} title={j.searchKeywords ?? 'şirket panosu'}>şirket panosu</span>}
                  {j.closedAt && <span style={{ color: 'var(--red)', fontWeight: 600 }}>kapandı</span>}
                  {j.scoreError && <span style={{ color: 'var(--red)' }}>skor hatası</span>}
                </div>
              </div>
            </div>
            </HoverCardTrigger>
            <HoverCardContent side="right" align="start" sideOffset={10} className="w-96">
              <RowPreview j={j} v={v} you={p.youOf ? p.youOf(j) : null} />
            </HoverCardContent>
            </HoverCard>
          )
        })}
        {p.rows.length === 0 && (
          <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--muted)' }}>
            <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              {p.raw.length ? 'Filtreye uyan ilan yok.' : p.queue === 'new' ? 'Hepsini hallettin.' : p.queue === 'suspect' ? 'Çelişki kalmadı.' : p.queue === 'all' ? 'Daha hiç ilan yok.' : 'Boş.'}
            </div>
            <div style={{ fontSize: 13 }}>
              {p.raw.length ? `${p.raw.length} ilan filtrenin arkasında kaldı.` : p.queue === 'new' ? `${p.queueCounts.suspect ? p.queueCounts.suspect + ' çelişkili ilan bekliyor.' : 'Sonraki turda yenilerini getiririm.'}` : p.queue === 'suspect' ? 'Kural motoru ile LLM şimdilik hemfikir.' : ''}
              {p.raw.length > 0 && (
                <>
                  {' '}
                  <button className="link" onClick={() => p.onFilters(EMPTY_FILTERS)}>
                    Temizle
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mono" style={{ padding: '10px 16px', borderTop: '1px solid var(--line)', display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--dim)' }}>
        <span><kbd className="k">J</kbd>/<kbd className="k">K</kbd> gez</span>
        <span><kbd className="k">S</kbd> shortlist</span>
        <span><kbd className="k">A</kbd> başvurdum</span>
        <span><kbd className="k">G</kbd> görüşme</span>
        <span><kbd className="k">I</kbd> yoksay</span>
        <span><kbd className="k">R</kbd> reddet</span>
        <span><kbd className="k">Z</kbd> geri al</span>
        <span><kbd className="k">/</kbd> ara</span>
        <span><kbd className="k">F</kbd> filtre</span>
        <span><kbd className="k">O</kbd> aç</span>
        <span><kbd className="k">Ctrl K</kbd> komut</span>
      </div>
    </aside>
  )
}
