import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Job, JobStatus } from '@/lib/types'
import type { PreScreen } from '@/lib/prescreen'
import { agreement, bucket, DECISION_REASONS, eyebrow, facts, modelLine, ROLE_TR, scoreOf, SENIORITY_TR, suspectWhy, wordCount, workplaceView } from '@/lib/model'
import { Markdown } from './Markdown'
import { cx, fmtWhen } from '@/lib/utils'

type Props = {
  job: Job
  pre: PreScreen
  /** Current cv/criteria/about hash; a score made under another one is flagged "eski profil". */
  profileHash: string | null
  /** Later postings of the same ad (same company + title + city). */
  reposts: Job[]
  /** Probability from the model learned on your decisions; null when there are too few decisions. */
  you: number | null
  threshold: number
  inline: boolean
  posLine: string
  cover: { text?: string; busy?: boolean; error?: string } | undefined
  busy: { rescore?: boolean; research?: boolean; cvTips?: boolean; check?: boolean }
  noteRef: RefObject<HTMLTextAreaElement | null>
  onStatus: (s: JobStatus) => void
  onNotes: (notes: string | null) => Promise<void>
  onRescore: () => void
  onResearch: () => void
  onCover: () => void
  onCvTips: () => void
  onCheck: () => void
  onReason: (reason: string | null) => void
  onDelete: () => void
  onClose: () => void
}

const STATUS_BTNS: Array<{ st: JobStatus; label: string; key?: string }> = [
  { st: 'shortlist', label: 'Shortlist', key: 'S' },
  { st: 'applied', label: 'Başvurdum' },
  { st: 'interviewing', label: 'Görüşme' },
  { st: 'ignored', label: 'Yoksay', key: 'I' },
  { st: 'rejected', label: 'Reddet', key: 'R' },
]

function Eyebrow({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
      <span className="eyebrow">{children}</span>
      {right}
    </div>
  )
}

export function Detail(p: Props) {
  const { job: j, pre } = p
  const s = scoreOf(j)
  const b = bucket(s, p.threshold)
  const wp = workplaceView(j, pre)
  const agree = agreement(pre, s, p.threshold)
  const suspect = suspectWhy(j, pre)
  const isAts = !!j.source?.startsWith('ats:')
  const liWp = ({ remote: 'Uzaktan', hybrid: 'Hibrit', onsite: 'Ofis', unknown: '—' } as Record<string, string>)[j.workplaceType] ?? '—'
  const llmWp = j.workplaceLlm
  const llmWpLabel = !j.scoredAt ? '—' : !llmWp || llmWp === 'unknown' ? 'Belirsiz' : ({ remote: 'Remote', hybrid_ankara: 'Hibrit · Ankara', hybrid_home: 'Hibrit · kabul edilen şehir', hybrid_other: 'Hibrit · başka şehir', onsite_ankara: 'Ofis · Ankara', onsite_home: 'Ofis · kabul edilen şehir', onsite_other: 'Ofis · başka şehir' } as Record<string, string>)[llmWp] ?? llmWp
  const llmWpColor = !j.scoredAt ? 'var(--dim)' : !llmWp || llmWp === 'unknown' || llmWp === 'hybrid_other' || llmWp === 'onsite_other' ? 'var(--amber)' : 'var(--text)'
  const sources = [
    isAts ? { src: 'Şirket panosu', val: liWp, detail: 'şirketin kendi bilgisi', color: 'var(--muted)' } : { src: 'LinkedIn etiketi', val: liWp, detail: 'güvenilmez, sadece ipucu', color: 'var(--muted)' },
    { src: 'Metin (kural)', val: { verified: 'Remote', hybrid: 'Hibrit', onsite: 'Ofis', unknown: 'Belirsiz' }[pre.remote], detail: pre.hybridDetail || (pre.remoteSource === 'text' ? 'metinde geçiyor' : 'metinde ipucu yok'), color: wp.color },
    { src: 'LLM okuması', val: llmWpLabel, detail: j.scoredAt ? j.workplaceDetail || '' : 'skor yok', color: llmWpColor },
  ]

  // notes: local draft, saved on blur / after typing pause
  const [notes, setNotes] = useState(j.notes ?? '')
  const saveT = useRef<number | null>(null)
  useEffect(() => {
    setNotes(j.notes ?? '')
  }, [j.linkedinJobId, j.notes])
  const scheduleSave = (v: string) => {
    setNotes(v)
    if (saveT.current) window.clearTimeout(saveT.current)
    saveT.current = window.setTimeout(() => void p.onNotes(v.trim() ? v : null), 700)
  }
  const flushSave = () => {
    if (saveT.current) window.clearTimeout(saveT.current)
    if ((j.notes ?? '') !== notes) void p.onNotes(notes.trim() ? notes : null)
  }

  const [copied, setCopied] = useState(false)
  const copyCover = async () => {
    if (!p.cover?.text) return
    try {
      await navigator.clipboard.writeText(p.cover.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard denied */
    }
  }

  return (
    <div className={p.inline ? 'detail-inline' : 'detail-overlay'} key={j.linkedinJobId}>
      <div style={{ position: 'sticky', top: 0, background: 'var(--bg)', borderBottom: '1px solid var(--line)', zIndex: 2 }}>
        <div style={{ padding: '10px 24px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {!p.inline && (
            <button className="btn ghost sm" onClick={p.onClose}>
              ← Geri <kbd className="k">Esc</kbd>
            </button>
          )}
          <div className="mono ell" style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--dim)' }}>{p.posLine}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_BTNS.map((sb) => (
              <button key={sb.st} className={cx('btn', j.status === sb.st && 'on')} onClick={() => p.onStatus(sb.st)}>
                {sb.key && <kbd className="mono" style={{ fontSize: 10.5, opacity: 0.7 }}>{sb.key}</kbd>}
                {sb.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 24px 80px', display: 'flex', flexWrap: 'wrap', gap: '20px 28px', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 100%', minWidth: 0 }}>
          <div className="eyebrow" style={{ letterSpacing: '.04em', marginBottom: 8 }}>{eyebrow(j)}</div>
          <h1 style={{ margin: '0 0 4px', fontSize: 26, lineHeight: 1.15, fontWeight: 600, letterSpacing: '-.01em', textWrap: 'pretty' }}>{j.title}</h1>
          <div style={{ display: 'flex', gap: '8px 12px', flexWrap: 'wrap', alignItems: 'center', marginTop: 6 }}>
            <div style={{ fontSize: 14.5, color: 'var(--muted)' }}>
              {j.companyUrl ? (
                <a href={j.companyUrl} target="_blank" rel="noreferrer">
                  {j.company ?? '–'}
                </a>
              ) : (
                <span>{j.company ?? '–'}</span>
              )}{' '}
              <span className="dim">·</span> {j.location ?? 'lokasyon yok'} <span className="dim">·</span>{' '}
              <a href={j.url} target="_blank" rel="noreferrer">
                {isAts ? 'Şirket sayfasında aç ↗' : 'LinkedIn’de aç ↗'}
              </a>
            </div>
            {facts(j, pre).map((f, i) => (
              <div key={i} className="fact" style={{ color: f.color ?? 'var(--text)', borderColor: f.color ? `color-mix(in oklab, ${f.color} 35%, transparent)` : 'transparent' }}>
                <b>{f.k}</b>
                {f.v && <span>{f.v}</span>}
              </div>
            ))}
          </div>
          {(j.status === 'ignored' || j.status === 'rejected') && (
            <div style={{ marginTop: 12, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 }}>
              <span className="eyebrow" style={{ letterSpacing: '.04em' }}>{j.status === 'ignored' ? 'yoksaydın' : 'reddettin'} · sebep</span>
              {DECISION_REASONS.map((r) => (
                <button key={r} className={cx('chip', j.decisionReason === r && 'on')} onClick={() => p.onReason(j.decisionReason === r ? null : r)}>
                  {r}
                </button>
              ))}
            </div>
          )}
          {j.closedAt && (
            <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--red)', background: 'color-mix(in oklab, var(--red) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--red) 35%, transparent)', borderRadius: 10, padding: '8px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <b>İlan kapandı</b> <span style={{ opacity: 0.85 }}>{j.closedReason ?? 'başvuru kabul etmiyor'} · {fmtWhen(j.closedAt)}</span>
              <button className="link" style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--red)' }} onClick={p.onCheck} disabled={p.busy.check}>{p.busy.check ? 'bakıyorum…' : 'Tekrar kontrol et'}</button>
            </div>
          )}
          {p.reposts.length > 0 && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--muted)', border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px' }}>
              Bu ilan {p.reposts.length} kez daha yayınlandı:{' '}
              {p.reposts.map((r, i) => (
                <span key={r.linkedinJobId}>
                  {i > 0 && ', '}
                  <a href={r.url} target="_blank" rel="noreferrer" className="link">{fmtWhen(r.firstSeenAt).toLowerCase()}</a>
                </span>
              ))}
              . Listede tek satır görürsün, skor ve kararın bunun üzerinden gider.
            </div>
          )}
          {suspect && <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--amber)', background: 'color-mix(in oklab, var(--amber) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--amber) 35%, transparent)', borderRadius: 10, padding: '8px 12px' }}>⚑ {suspect}</div>}
          {j.scoreError && <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--red)', background: 'color-mix(in oklab, var(--red) 10%, transparent)', borderRadius: 10, padding: '8px 12px' }}>Skor hatası: {j.scoreError}</div>}
        </div>

        <div style={{ flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section style={{ border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: agree.bg }}>
              <span className="eyebrow">İki görüş</span>
              <span style={{ fontSize: 13, color: agree.color, fontWeight: 600 }}>{agree.text}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
              <div style={{ padding: '16px 18px', borderRight: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>Kural motoru</span>
                  <span className="mono" style={{ fontSize: 22, color: pre.verdict === 'reject' ? 'var(--red)' : pre.verdict === 'review' ? 'var(--amber)' : 'var(--accent)' }}>{pre.verdict}</span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 2 }}>
                  kural puanı {pre.score} · rol {ROLE_TR[pre.role]} · kıdem {SENIORITY_TR[pre.seniority]}
                </div>
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {pre.reasons.map((r, i) => (
                    <div key={i} className="li"><span className="dim">·</span><span>{r}</span></div>
                  ))}
                  {pre.bonuses.map((r, i) => (
                    <div key={'b' + i} className="li" style={{ color: 'var(--accent)' }}><span>+</span><span>{r}</span></div>
                  ))}
                  {pre.flags.map((r, i) => (
                    <div key={'f' + i} className="li" style={{ color: 'var(--red)' }}><span>⚑</span><span>{r}</span></div>
                  ))}
                </div>
              </div>
              <div style={{ padding: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>LLM</span>
                  <span className="mono" style={{ fontSize: 22, color: b.color }}>{s == null ? '—' : s}</span>
                </div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--dim)', marginTop: 2 }}>
                  {modelLine(j)}
                  {j.scoredAt && p.profileHash && j.scoreProfile !== p.profileHash && (
                    <span style={{ color: 'var(--amber)' }} title="CV’n, kriterlerin ya da about.md bu skordan sonra değişti. “Yeniden skorla” de, güncel profilinle bir daha okuyayım.">
                      {' '}· eski profille
                    </span>
                  )}
                </div>
                {p.you != null && (
                  <div style={{ fontSize: 13, marginTop: 8, color: 'var(--blue)' }} title="Shortlist / başvurdum / görüşme ve yoksay / reddet kararlarından öğrendiğim model">
                    Kararlarına bakınca bununla ilgilenme ihtimalin <b>%{Math.round(p.you * 100)}</b>
                  </div>
                )}
                {j.scoreParts && j.scoreParts.length > 0 && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 10 }} title="Skoru böyle hesapladım: LLM içerik uyumunu verir, gerisini kurallar ekler/çıkarır. Ağırlıklar searches.yaml → radar.score_weights’te.">
                    {j.scoreParts.map((pt, i) => (
                      <span
                        key={i}
                        className="mono"
                        style={{
                          fontSize: 11.5,
                          padding: '2px 7px',
                          borderRadius: 6,
                          border: '1px solid var(--line)',
                          opacity: pt.applied ? 1 : 0.45,
                          textDecoration: pt.applied ? undefined : 'line-through',
                          color: pt.kind === 'base' ? 'var(--text)' : pt.kind === 'cap' ? 'var(--amber)' : pt.value > 0 ? 'var(--accent)' : 'var(--red)',
                        }}
                      >
                        {pt.kind === 'base' ? `${pt.value} ${pt.label}` : pt.kind === 'cap' ? `en fazla ${pt.value} · ${pt.label}` : `${pt.value > 0 ? '+' : '−'}${Math.abs(pt.value)} ${pt.label}`}
                      </span>
                    ))}
                  </div>
                )}
                {j.scoredAt ? (
                  <>
                    <p style={{ fontSize: 14, lineHeight: 1.55, margin: '12px 0 0' }}>{j.summary}</p>
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {j.pros.map((r, i) => (
                        <div key={i} className="li"><span style={{ color: 'var(--accent)' }}>+</span><span>{r}</span></div>
                      ))}
                      {j.cons.map((r, i) => (
                        <div key={'c' + i} className="li"><span style={{ color: 'var(--amber)' }}>−</span><span>{r}</span></div>
                      ))}
                      {j.redFlags.map((r, i) => (
                        <div key={'f' + i} className="li" style={{ color: 'var(--red)' }}><span>⚑</span><span>{r}</span></div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--muted)' }}>
                    {!j.descriptionMd ? 'Metin yok; önce metni çekeceğim, sonra okurum.' : pre.verdict === 'reject' ? 'Kural motoru eledi, LLM bütçesini bu ilana harcamadım. İstersen “Yeniden skorla” de.' : 'Sıradaki skorlama turunda okuyacağım.'}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section style={{ border: '1px solid var(--line)', borderRadius: 14, padding: 18 }}>
            <Eyebrow right={<span style={{ fontWeight: 600, color: wp.color }}>{wp.label}{wp.detail ? ' — ' + wp.detail : ''}</span>}>Çalışma şekli — gerçekte ne?</Eyebrow>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {sources.map((ws) => (
                <div key={ws.src} className="panel">
                  <div className="eyebrow" style={{ letterSpacing: '.06em' }}>{ws.src}</div>
                  <div style={{ fontWeight: 600, marginTop: 6, color: ws.color }}>{ws.val}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3 }}>{ws.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="hr" style={{ marginBottom: 14 }}>
              <span className="eyebrow">İlan metni</span>
            </div>
            {j.descriptionMd ? (
              <>
                <div className="mono" style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 10 }}>
                  {wordCount(j.descriptionMd)} kelime · {pre.remoteSource === 'text' ? 'çalışma yeri metinden' : 'çalışma yeri etiketten'}
                  {j.criteria && (j.criteria.seniority || j.criteria.employment || j.criteria.func || j.criteria.industry) && <> · LinkedIn: {[j.criteria.seniority, j.criteria.employment, j.criteria.func, j.criteria.industry].filter(Boolean).join(' · ')}</>}
                </div>
                <Markdown md={j.descriptionMd} className="desc" size={14.5} hot />
              </>
            ) : (
              <div className="panel" style={{ fontSize: 14, color: 'var(--muted)', padding: 14 }}>{j.descriptionSkipped ? `Metni bilerek çekmedim — ${j.descriptionSkipped}.` : 'Metni daha çekmedim; sıradaki turda alırım.'}</div>
            )}
          </section>
        </div>

        <aside style={{ flex: '1 1 260px', maxWidth: 340, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button className="btn sm" onClick={p.onRescore} disabled={!j.descriptionMd || p.busy.rescore}>{p.busy.rescore ? <span className="spin" /> : null}Yeniden skorla</button>
            <button className="btn sm" onClick={p.onResearch} disabled={!j.descriptionMd || p.busy.research}>{p.busy.research ? <span className="spin" /> : null}Şirketi araştır</button>
            <button className="btn sm" onClick={p.onCover} disabled={!j.descriptionMd || p.cover?.busy}>{p.cover?.busy ? <span className="spin" /> : null}Ön yazı üret</button>
            <button className="btn sm" onClick={p.onCvTips} disabled={!j.descriptionMd || p.busy.cvTips} title="CV’ni bu ilana göre nasıl uyarlayacağını söylerim">{p.busy.cvTips ? <span className="spin" /> : null}{j.cvTipsMd ? 'CV ipuçlarını yenile' : 'CV ipuçları'}</button>
            <button className="btn sm" onClick={p.onCheck} disabled={p.busy.check} title={j.checkedAt ? `Son kontrol ${fmtWhen(j.checkedAt)}` : 'LinkedIn sayfasını yeniden çekip hâlâ başvuru alıyor mu bakarım'}>{p.busy.check ? <span className="spin" /> : null}İlan açık mı?</button>
            <button className="btn sm danger" onClick={p.onDelete}>Sil</button>
          </div>
          <section className="card" style={{ padding: 16 }}>
            <Eyebrow right={(j.notes ?? '') !== notes ? <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>kaydediyorum…</span> : undefined}>Notlarım</Eyebrow>
            <textarea ref={p.noteRef} className="textarea" value={notes} onChange={(e) => scheduleSave(e.target.value)} onBlur={flushSave} placeholder="Bu ilanla ilgili aklında kalsın istediğin…" style={{ minHeight: 96 }} />
          </section>
          <section className="card">
            <Eyebrow right={<span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{j.companyResearchAt ? fmtWhen(j.companyResearchAt) : ''}</span>}>Şirket notu</Eyebrow>
            {j.companyResearchMd ? (
              <Markdown md={j.companyResearchMd} size={14} />
            ) : (
              <div style={{ fontSize: 13.5, color: 'var(--muted)' }}>
                Daha araştırmadım.{' '}
                <button className="link" style={{ fontWeight: 500 }} onClick={p.onResearch} disabled={!j.descriptionMd || p.busy.research}>
                  Şimdi araştır
                </button>{' '}
                — bir dakika sürer, bitince buraya koyarım.
              </div>
            )}
          </section>
          {j.cvTipsMd && (
            <section className="card">
              <Eyebrow right={<span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{fmtWhen(j.cvTipsAt)}</span>}>CV’yi bu ilana göre</Eyebrow>
              <Markdown md={j.cvTipsMd} size={13.5} />
            </section>
          )}
          {(p.cover?.text || p.cover?.error) && (
            <section className="card">
              <Eyebrow right={p.cover.text ? <button className="link" style={{ fontSize: 12 }} onClick={copyCover}>{copied ? 'Kopyaladım' : 'Kopyala'}</button> : undefined}>Ön yazı</Eyebrow>
              {p.cover.error ? <div style={{ fontSize: 13.5, color: 'var(--red)' }}>{p.cover.error}</div> : <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{p.cover.text}</div>}
            </section>
          )}
          <section className="mono" style={{ fontSize: 12, color: 'var(--dim)', lineHeight: 1.8, padding: '0 4px' }}>
            <div>ilk görülme {fmtWhen(j.firstSeenAt)}</div>
            <div>son görülme {fmtWhen(j.lastSeenAt)} · {j.seenCount} turda</div>
            {j.searchKeywords && <div>arama: {j.searchKeywords}</div>}
            {j.appliedAt && <div>başvuru {fmtWhen(j.appliedAt)}</div>}
            {j.checkedAt && <div>son kontrol {fmtWhen(j.checkedAt)} · {j.closedAt ? 'kapalı' : 'açık'}</div>}
            <div>id {j.linkedinJobId}</div>
          </section>
        </aside>
      </div>
    </div>
  )
}
