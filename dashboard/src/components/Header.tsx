import type { ServerStats } from '@/lib/platform'
import { cx } from '@/lib/utils'

export type View = 'inbox' | 'shortlist' | 'system' | 'settings'

type Props = {
  view: View
  onView: (v: View) => void
  counts: { inbox: number; shortlist: number }
  stats: ServerStats | null
  dark: boolean
  onTheme: () => void
}

export function jobLine(stats: ServerStats | null): { busy: boolean; text: string } {
  if (!stats) return { busy: false, text: 'bağlanıyor…' }
  if (stats.collecting) return { busy: true, text: `Tur · ${stats.progress?.phase ?? 'başlıyor'}` }
  if (stats.task) return { busy: true, text: `${stats.task.kind} ${stats.task.done}/${stats.task.total}` }
  const n = stats.schedule?.nextRunAt
  if (n) {
    const d = new Date(n)
    return { busy: false, text: `Boşta · sonraki tur ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  }
  return { busy: false, text: 'Boşta' }
}

export function Header({ view, onView, counts, stats, dark, onTheme }: Props) {
  const jl = jobLine(stats)
  const tabs: Array<{ key: View; label: string; count?: number }> = [
    { key: 'inbox', label: 'Gelenler', count: counts.inbox },
    { key: 'shortlist', label: 'Shortlist', count: counts.shortlist },
    { key: 'system', label: 'Sistem' },
    { key: 'settings', label: 'Ayarlar' },
  ]
  return (
    <header className="hdr">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, letterSpacing: '.01em', fontSize: 15 }}>
        <span style={{ width: 9, height: 9, borderRadius: 99, background: jl.busy ? 'var(--accent)' : 'var(--dim)', display: 'inline-block', animation: jl.busy ? 'pulse 1.6s ease-in-out infinite' : 'none' }} />
        <span>İş Radar</span>
      </div>
      <nav style={{ display: 'flex', gap: 4, flex: 1, minWidth: 0, overflow: 'auto' }}>
        {tabs.map((t) => (
          <button key={t.key} className={cx('tab', view === t.key && 'on')} onClick={() => onView(t.key)}>
            <span>{t.label}</span>
            {t.count !== undefined && <span className="n">{t.count}</span>}
          </button>
        ))}
      </nav>
      <button className="btn ghost sm" onClick={() => onView('system')} title="Sistem">
        <span style={{ width: 7, height: 7, borderRadius: 99, background: jl.busy ? 'var(--accent)' : 'var(--dim)' }} />
        <span className="mono">{jl.text}</span>
      </button>
      <button className="btn ghost" onClick={onTheme} title="Tema" aria-label="Tema" style={{ width: 32, height: 32, padding: 0, justifyContent: 'center' }}>
        {dark ? '☾' : '☀'}
      </button>
    </header>
  )
}
