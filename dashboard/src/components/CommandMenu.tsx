import { useMemo } from 'react'
import { BarChart3, Download, FileText, Inbox, ListChecks, Moon, Play, RefreshCw, Settings as SettingsIcon, Sparkles, Star } from 'lucide-react'
import type { Job } from '@/lib/types'
import type { View } from './Header'
import type { QueueKey } from './Inbox'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'

type Props = {
  open: boolean
  onOpenChange: (v: boolean) => void
  jobs: Job[]
  onView: (v: View) => void
  onQueue: (q: QueueKey) => void
  onOpenJob: (id: string) => void
  onRun: (mode?: 'full' | 'incremental') => void
  onScore: () => void
  onRescoreStale: (() => void) | null
  onTheme: () => void
}

const QUEUES: Array<{ key: QueueKey; label: string; n: string }> = [
  { key: 'new', label: 'Bakmaya değer', n: '1' },
  { key: 'suspect', label: 'Çelişkili', n: '2' },
  { key: 'rejected', label: 'Elenen', n: '3' },
  { key: 'decided', label: 'Karar verdiklerin', n: '4' },
  { key: 'all', label: 'Tümü', n: '5' },
]

/** Ctrl/Cmd+K: jump anywhere, run anything, find any ad by title or company. */
export function CommandMenu(p: Props) {
  // best first; reposts out. cmdk filters on `value`, so title + company + id are searchable
  const list = useMemo(() => p.jobs.filter((j) => !j.dupOf).sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 400), [p.jobs])
  const run = (fn: () => void) => () => {
    p.onOpenChange(false)
    fn()
  }
  return (
    <CommandDialog open={p.open} onOpenChange={p.onOpenChange} title="Komut paleti" description="Bir görünüme git, bir işlem başlat ya da ilan ara">
      <CommandInput placeholder="Ne yapalım? İlan, şirket, komut…" />
      <CommandList>
        <CommandEmpty>Bir şey bulamadım.</CommandEmpty>
        <CommandGroup heading="Git">
          <CommandItem onSelect={run(() => p.onView('inbox'))}><Inbox />Gelenler</CommandItem>
          <CommandItem onSelect={run(() => p.onView('shortlist'))}><Star />Shortlist</CommandItem>
          <CommandItem onSelect={run(() => p.onView('system'))}><BarChart3 />Sistem</CommandItem>
          <CommandItem onSelect={run(() => p.onView('settings'))}><SettingsIcon />Ayarlar</CommandItem>
          {QUEUES.map((q) => (
            <CommandItem key={q.key} value={`kuyruk ${q.label}`} onSelect={run(() => p.onQueue(q.key))}>
              <ListChecks />Kuyruk: {q.label}
              <CommandShortcut>{q.n}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Yap">
          <CommandItem onSelect={run(() => p.onRun())}><Play />Tur başlat</CommandItem>
          <CommandItem onSelect={run(() => p.onRun('full'))}><Play />Tam tur (30 gün)</CommandItem>
          <CommandItem onSelect={run(p.onScore)}><Sparkles />Birikeni skorla</CommandItem>
          {p.onRescoreStale && <CommandItem onSelect={run(p.onRescoreStale)}><RefreshCw />Eski profille skorlananları yeniden skorla</CommandItem>}
          <CommandItem onSelect={run(() => window.open('/api/report', '_blank', 'noopener'))}><FileText />HTML raporu aç</CommandItem>
          <CommandItem onSelect={run(() => (window.location.href = '/api/report?download=1'))}><Download />HTML raporu indir</CommandItem>
          <CommandItem onSelect={run(p.onTheme)}><Moon />Temayı değiştir</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="İlanlar">
          {list.map((j) => (
            <CommandItem key={j.linkedinJobId} value={`${j.title} ${j.company ?? ''} ${j.linkedinJobId}`} onSelect={run(() => p.onOpenJob(j.linkedinJobId))}>
              <span className="w-7 text-right font-mono text-xs" style={{ color: (j.score ?? 0) >= 70 ? 'var(--accent)' : 'var(--dim)' }}>{j.score ?? '–'}</span>
              <span className="min-w-0 truncate">{j.title}</span>
              <span className="ml-auto max-w-[40%] truncate text-xs text-muted-foreground">{j.company}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
