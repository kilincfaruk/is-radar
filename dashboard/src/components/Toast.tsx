export type ToastAction = { label: string; onClick: () => void }
export type ToastMsg = { text: string; undo?: () => void; kind?: 'info' | 'error'; actions?: ToastAction[]; hint?: string }

export function Toast({ toast }: { toast: ToastMsg | null }) {
  if (!toast) return null
  return (
    <div className={['toast', toast.kind === 'error' && 'err', toast.actions?.length && 'wide'].filter(Boolean).join(' ')} role="status" style={{ flexWrap: 'wrap', justifyContent: 'center' }}>
      <span>{toast.text}</span>
      {toast.actions && toast.actions.length > 0 && (
        <span style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {toast.hint && <span style={{ fontSize: 11.5, color: 'var(--dim)', marginRight: 2 }}>{toast.hint}</span>}
          {toast.actions.map((a) => (
            <button key={a.label} className="chip" onClick={a.onClick} style={{ padding: '2px 8px', fontSize: 11.5 }}>
              {a.label}
            </button>
          ))}
        </span>
      )}
      {toast.undo && (
        <button className="link" style={{ fontSize: 13 }} onClick={toast.undo}>
          Geri al
        </button>
      )}
    </div>
  )
}
