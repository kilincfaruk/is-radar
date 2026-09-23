import { mdBlocks, type Inline } from '@/lib/model'

function Run({ parts, strong }: { parts: Inline[]; strong?: string }) {
  return (
    <>
      {parts.map((x, k) =>
        x.b ? (
          <b key={k} style={{ color: strong ?? 'var(--text)' }}>{x.t}</b>
        ) : x.s ? (
          <s key={k} style={{ opacity: 0.7 }}>{x.t}</s>
        ) : x.i ? (
          <i key={k} style={{ color: 'var(--dim)' }}>{x.t}</i>
        ) : (
          <span key={k}>{x.t}</span>
        ),
      )}
    </>
  )
}

/** Small markdown subset: headings, bullets, paragraphs, tables, **bold**, ~~strike~~, _em_. `hot` underlines bullets matching a regex (workplace lines in ads). */
export function Markdown({ md, className, size = 14, hot }: { md: string; className?: string; size?: number; hot?: boolean }) {
  return (
    <div className={className} style={{ fontSize: size, lineHeight: 1.6, color: 'var(--muted)' }}>
      {mdBlocks(md).map((bl, i) => {
        if (bl.kind === 'table')
          return (
            <div key={i} style={{ overflowX: 'auto', margin: '8px 0 12px' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: size - 1 }}>
                <tbody>
                  {bl.rows.map((r, ri) => (
                    <tr key={ri} style={{ borderBottom: '1px solid var(--line)' }}>
                      {r.map((c, ci) => {
                        const Tag = bl.header && ri === 0 ? 'th' : 'td'
                        return (
                          <Tag key={ci} style={{ textAlign: 'left', padding: '6px 10px 6px 0', verticalAlign: 'top', fontWeight: bl.header && ri === 0 ? 600 : 400, color: bl.header && ri === 0 ? 'var(--text)' : undefined }}>
                            <Run parts={c} />
                          </Tag>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        if (bl.kind === 'h')
          return (
            <div key={i} style={{ fontWeight: 600, color: 'var(--text)', fontSize: (bl.level ?? 3) <= 2 ? size + 1 : size, margin: `${i ? 16 : 0}px 0 6px` }}>
              {bl.parts.map((x) => x.t).join('')}
            </div>
          )
        if (bl.kind === 'li')
          return (
            <div key={i} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
              <span className="dim">–</span>
              <span className={hot && bl.hot ? 'hot' : undefined}>
                <Run parts={bl.parts} />
              </span>
            </div>
          )
        return (
          <p key={i} style={{ margin: '0 0 10px' }}>
            <Run parts={bl.parts} />
          </p>
        )
      })}
    </div>
  )
}
