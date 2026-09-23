import { useEffect, useRef, useState } from 'react'
import { server, type LogLine } from '@/lib/platform'
import { cx } from '@/lib/utils'

const POLL_MS = 2000
const KEEP = 500

/** Live tail of the collector's console (same lines as the terminal). */
export function LogPanel({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [follow, setFollow] = useState(true)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const lastId = useRef(0)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    const pull = async () => {
      try {
        const fresh = await server.log(lastId.current)
        if (!alive || fresh.length === 0) return
        lastId.current = fresh[fresh.length - 1].id
        setLines((cur) => [...cur, ...fresh].slice(-KEEP))
      } catch {
        /* server down */
      }
    }
    void pull()
    const t = window.setInterval(() => void pull(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [open])

  useEffect(() => {
    if (open && follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines, open, follow])

  const shown = onlyProblems ? lines.filter((l) => l.level !== 'info') : lines
  const problems = lines.filter((l) => l.level !== 'info').length

  return (
    <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: open ? '1px solid var(--line)' : 'none' }}>
        <button className="link" style={{ color: 'var(--text)', fontWeight: 600, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }} onClick={onToggle}>
          <span style={{ fontSize: 10, opacity: 0.7 }}>{open ? '▾' : '▸'}</span> Canlı log
          <span className="mono" style={{ fontSize: 11, color: 'var(--dim)', fontWeight: 400 }}>{lines.length ? `${lines.length} satır${problems ? ` · ${problems} uyarı/hata` : ''}` : 'collector konsolu'}</span>
        </button>
        {open && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            <button className={cx('chip', onlyProblems && 'on')} onClick={() => setOnlyProblems((v) => !v)}>sadece sorunlar</button>
            <button className={cx('chip', follow && 'on')} onClick={() => setFollow((v) => !v)} title="Yeni satır gelince en alta kay">takip</button>
          </div>
        )}
      </div>
      {open && (
        <div ref={box} className="mono" style={{ maxHeight: 360, overflow: 'auto', padding: '8px 12px', fontSize: 12, lineHeight: 1.55, background: 'var(--bg)' }} onScroll={(e) => { const el = e.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24) }}>
          {shown.length === 0 && <div style={{ color: 'var(--dim)', padding: '12px 0' }}>{lines.length ? 'Uyarı/hata yok.' : 'Daha satır yok; collector yeni açıldıysa ilk turla dolar.'}</div>}
          {shown.map((l) => (
            <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0,1fr)', gap: 10, color: l.level === 'error' ? 'var(--red)' : l.level === 'warn' ? 'var(--amber)' : 'var(--muted)' }}>
              <span style={{ color: 'var(--dim)' }}>{l.at.slice(11, 19)}</span>
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
