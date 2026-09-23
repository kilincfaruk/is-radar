import { Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
            <Button key={a.label} variant="outline" size="xs" className="rounded-full font-normal" onClick={a.onClick}>
              {a.label}
            </Button>
          ))}
        </span>
      )}
      {toast.undo && (
        <Button variant="link" size="xs" className="px-0 text-[13px] font-semibold" onClick={toast.undo}>
          <Undo2 /> Geri al
        </Button>
      )}
    </div>
  )
}
