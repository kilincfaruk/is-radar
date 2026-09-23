import type { ServerStats } from '@/lib/platform'
import { Command, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export type View = 'inbox' | 'shortlist' | 'system' | 'settings'

type Props = {
  view: View
  onView: (v: View) => void
  counts: { inbox: number; shortlist: number }
  stats: ServerStats | null
  dark: boolean
  onTheme: () => void
  onCommand: () => void
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

export function Header({ view, onView, counts, stats, dark, onTheme, onCommand }: Props) {
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
      <Tabs value={view} onValueChange={(v) => onView(v as View)} className="min-w-0 flex-1">
        <TabsList className="bg-secondary/60">
          {tabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-2 px-3 text-[13.5px] data-[state=active]:bg-background">
              {t.label}
              {t.count !== undefined && <span className="rounded-full bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground">{t.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Button variant="outline" size="sm" className="text-muted-foreground" onClick={onCommand}>
        <Command /> Komut <Kbd>Ctrl K</Kbd>
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="sm" className="rounded-full text-muted-foreground" onClick={() => onView('system')}>
            <span className="inline-block size-[7px] rounded-full" style={{ background: jl.busy ? 'var(--accent)' : 'var(--dim)' }} />
            <span className="font-mono text-xs">{jl.text}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sistem sekmesi: turlar, log, kalibrasyon</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="rounded-full" onClick={onTheme} aria-label="Tema">
            {dark ? <Moon /> : <Sun />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{dark ? 'Açık temaya geç' : 'Koyu temaya geç'}</TooltipContent>
      </Tooltip>
    </header>
  )
}
