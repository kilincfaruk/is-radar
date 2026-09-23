import type { Job, JobStatus } from '@/lib/types'
import type { PreScreen } from '@/lib/prescreen'
import { bucket, scoreOf, workplaceView } from '@/lib/model'
import { fmtDate, fmtWhen, rel } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const GROUPS: Array<{ st: JobStatus; label: string; empty: string }> = [
  { st: 'interviewing', label: 'Görüşme', empty: 'Görüşmede olduğun ilan yok.' },
  { st: 'applied', label: 'Başvurdum', empty: 'Daha hiçbir başvuruyu işaretlemedin.' },
  { st: 'shortlist', label: 'Shortlist', empty: 'Daha boş; Gelenler’den S ile ekleyebilirsin.' },
]

function exportMarkdown(jobs: Job[], pre: (j: Job) => PreScreen, threshold: number): void {
  const lines: string[] = [`# Shortlist · ${new Date().toLocaleDateString('tr-TR')}`, '']
  for (const g of GROUPS) {
    const items = jobs.filter((j) => j.status === g.st).sort((a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1))
    if (!items.length) continue
    lines.push(`## ${g.label} (${items.length})`, '')
    lines.push('| Skor | İlan | Şirket | Çalışma | Tarih | Not |', '|---:|---|---|---|---|---|')
    for (const j of items) {
      const s = scoreOf(j)
      const wp = workplaceView(j, pre(j))
      const when = j.appliedAt ? `başvuru ${fmtDate(j.appliedAt)}` : fmtDate(j.postedAt ?? j.firstSeenAt)
      const note = (j.notes ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
      lines.push(`| ${s == null ? '—' : s}${s != null && s >= threshold ? ' ✓' : ''} | [${j.title}](${j.url})${j.closedAt ? ' **(kapandı)**' : ''} | ${j.company ?? '—'} | ${wp.label} | ${when} | ${note} |`)
    }
    lines.push('')
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `is-radar-shortlist-${new Date().toISOString().slice(0, 10)}.md`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

type Props = {
  jobs: Job[]
  pre: (j: Job) => PreScreen
  threshold: number
  onOpen: (id: string) => void
  onStatus: (id: string, s: JobStatus) => void
}


export function Shortlist(p: Props) {
  return (
    <main className="page">
      <div style={{ width: '100%', maxWidth: 860 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Shortlist</h1>
          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--dim)' }}>Döneceğin yer burası: tam metin, şirket notu, ön yazı.</div>
            <Button asChild variant="outline" size="sm" className="h-7 px-2.5 text-xs"><a href="/api/report?download=1" title="Takiptekiler, bakmaya değerler ve yeni gelenler; tek dosya, internetsiz açılır">HTML rapor</a></Button>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => exportMarkdown(p.jobs, p.pre, p.threshold)} disabled={p.jobs.length === 0} title="Markdown tablo olarak indir, Notion/Obsidian'a yapıştırabilirsin">Dışa aktar (.md)</Button>
          </div>
        </div>
        {GROUPS.map((g) => {
          const items = p.jobs.filter((j) => j.status === g.st).sort((a, b) => (scoreOf(b) ?? -1) - (scoreOf(a) ?? -1))
          return (
            <section key={g.st} style={{ marginBottom: 26 }}>
              <div className="hr" style={{ marginBottom: 10 }}>
                <span className="eyebrow">{g.label}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{items.length}</span>
              </div>
              {items.length === 0 && <div style={{ fontSize: 13, color: 'var(--dim)', padding: '8px 2px' }}>{g.empty}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((j) => {
                  const pre = p.pre(j)
                  const s = scoreOf(j)
                  const wp = workplaceView(j, pre)
                  return (
                    <div key={j.linkedinJobId} className="card" onClick={() => p.onOpen(j.linkedinJobId)} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0,1fr) auto', gap: 16, alignItems: 'center', padding: '14px 16px', borderRadius: 12, cursor: 'pointer' }}>
                      <div className="mono" style={{ fontSize: 22, color: bucket(s, p.threshold).color }}>{s == null ? '—' : s}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          {j.title}
                          {j.closedAt && <span className="mono" style={{ fontSize: 10.5, padding: '1px 7px', borderRadius: 99, background: 'color-mix(in oklab, var(--red) 14%, transparent)', color: 'var(--red)' }}>KAPANDI</span>}
                        </div>
                        <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
                          {j.company ?? '–'} · {wp.label}
                          {pre.salaryTl ? ` · ₺${pre.salaryTl.toLocaleString('tr-TR')}` : ''}
                        </div>
                        {j.notes && <div style={{ fontSize: 13, color: 'var(--dim)', marginTop: 6, fontStyle: 'italic' }}>✎ {j.notes.split('\n')[0]}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span className="mono" style={{ fontSize: 11, color: 'var(--dim)' }}>{j.appliedAt ? 'başvuru ' + fmtWhen(j.appliedAt) : rel(j.postedAt ?? j.firstSeenAt)}</span>
                        {g.st === 'shortlist' && (
                          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={(e) => { e.stopPropagation(); p.onStatus(j.linkedinJobId, 'applied') }}>Başvurdum</Button>
                        )}
                        {g.st === 'applied' && (
                          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={(e) => { e.stopPropagation(); p.onStatus(j.linkedinJobId, 'interviewing') }} style={{ borderColor: 'var(--line2)' }}>Görüşme</Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </main>
  )
}
