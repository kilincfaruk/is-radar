import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Job, JobStatus } from '@/lib/types'
import { syncJobs, updateJob, deleteJob } from '@/lib/db'
import { server, type RunRow, type ServerStats } from '@/lib/platform'
import { loadSettings, saveSettings } from '@/lib/settings'
import { calibration, DECISION_REASONS, jobView, scoreFunnel, suggestThresholds, type JobView } from '@/lib/model'
import { EMPTY_FILTERS, passes, type Filters } from '@/lib/filters'
import { configurePrescreen } from '@/lib/prescreen'
import { learn, predict, label as decisionLabel, type LearnedModel } from '@shared/learn'
import { Header, type View } from '@/components/Header'
import { Inbox, type QueueKey } from '@/components/Inbox'
import { Detail } from '@/components/Detail'
import { Shortlist } from '@/components/Shortlist'
import { System } from '@/components/System'
import { Settings } from '@/components/Settings'
import { Toast, type ToastMsg } from '@/components/Toast'

const STATS_POLL_MS = 4000
const VIEWS: View[] = ['inbox', 'shortlist', 'system', 'settings']
const QUEUES: QueueKey[] = ['new', 'suspect', 'rejected', 'decided', 'all']

/** #view/queue/jobId — enough to deep-link a job or come back where you were. */
function readHash(): { view: View; queue: QueueKey; job: string | null } {
  const [v, q, j] = location.hash.replace(/^#\/?/, '').split('/')
  return { view: VIEWS.includes(v as View) ? (v as View) : 'inbox', queue: QUEUES.includes(q as QueueKey) ? (q as QueueKey) : 'new', job: j || null }
}
type Cover = { text?: string; busy?: boolean; error?: string }

function readLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function writeLS(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* ignore */
  }
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [stats, setStats] = useState<ServerStats | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])
  const initial = useRef(readHash())
  const [view, setView] = useState<View>(initial.current.view)
  const [queue, setQueue] = useState<QueueKey>(initial.current.queue)
  const [selectedId, setSelectedId] = useState<string | null>(initial.current.view === 'inbox' ? initial.current.job : null)
  const [detailId, setDetailId] = useState<string | null>(initial.current.view !== 'inbox' ? initial.current.job : null) // overlay outside inbox
  const [notify, setNotify] = useState<boolean>(() => readLS('isradar.notify', false))
  const [thresholds, setThresholds] = useState<{ review: number; candidate: number }>({ review: 35, candidate: 60 })
  const undoStack = useRef<Array<{ id: string; prev: { status: JobStatus; appliedAt: string | null } }>>([])
  const seenScored = useRef<Set<string> | null>(null)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => readLS('isradar.filtersOpen', false))
  const [threshold, setThreshold] = useState(70)
  const [sortBy, setSortBy] = useState<'score' | 'you'>(() => readLS('isradar.sortBy', 'score'))
  const [dark, setDark] = useState<boolean>(() => readLS('isradar.theme', 'dark') === 'dark')
  const [toast, setToast] = useState<ToastMsg | null>(null)
  const [covers, setCovers] = useState<Record<string, Cover>>({})
  const [busy, setBusy] = useState<Record<string, { rescore?: boolean; research?: boolean; cvTips?: boolean; check?: boolean }>>({})
  const toastT = useRef<number | null>(null)
  const lastKey = useRef<string | null>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // ---- theme / prefs
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    writeLS('isradar.theme', dark ? 'dark' : 'light')
  }, [dark])
  useEffect(() => writeLS('isradar.filtersOpen', filtersOpen), [filtersOpen])

  const showToast = useCallback((text: string, opts?: { undo?: () => void; kind?: 'info' | 'error'; actions?: ToastMsg['actions']; hint?: string; ms?: number }) => {
    if (toastT.current) window.clearTimeout(toastT.current)
    const t: ToastMsg = { text, undo: opts?.undo, kind: opts?.kind, actions: opts?.actions, hint: opts?.hint }
    setToast(t)
    toastT.current = window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), opts?.ms ?? (opts?.kind === 'error' ? 7000 : opts?.actions ? 7000 : 3600))
  }, [])

  // ---- data
  // delta sync: only rows changed since the last pull; a full pull on start and every 10 min (catches deletes from the CLI)
  const sync = useRef<{ since: string; fullAt: number }>({ since: '', fullAt: 0 })
  const reload = useCallback(async (full = false) => {
    try {
      const wantFull = full || !sync.current.since || Date.now() - sync.current.fullAt > 600_000
      const r = await syncJobs(wantFull ? '' : sync.current.since)
      sync.current.since = r.now
      if (r.full) {
        sync.current.fullAt = Date.now()
        setJobs(r.jobs)
      } else if (r.jobs.length) {
        const byId = new Map(r.jobs.map((j) => [j.linkedinJobId, j]))
        setJobs((cur) => {
          const next = cur.map((j) => byId.get(j.linkedinJobId) ?? j)
          const known = new Set(cur.map((j) => j.linkedinJobId))
          for (const j of r.jobs) if (!known.has(j.linkedinJobId)) next.unshift(j)
          return next
        })
      }
    } catch (e) {
      showToast(`Sunucuya ulaşamadım (${e instanceof Error ? e.message : String(e)}). serve açık mı?`, { kind: 'error' })
    }
  }, [showToast])

  const pollStats = useCallback(async () => {
    try {
      const s = await server.stats()
      setStats(s)
      const key = `${s.lastRun?.id ?? 0}:${s.lastRun?.finished_at ?? ''}:${s.task?.kind ?? ''}:${s.task?.done ?? ''}:${s.collecting}`
      if (lastKey.current !== null && key !== lastKey.current) void reload()
      lastKey.current = key
    } catch {
      /* server down; keep last */
    }
  }, [reload])

  useEffect(() => {
    void reload()
    void pollStats()
    void loadSettings().then((s) => setThreshold(s.scoreThreshold))
    server
      .getSettings()
      .then((s) => {
        configurePrescreen(s.radar) // same cities / role dictionaries as the server, for client-side fallbacks
        if (s.thresholds) setThresholds(s.thresholds)
        setThreshold(s.scoreThreshold)
        void saveSettings({ scoreThreshold: s.scoreThreshold })
        void reload()
      })
      .catch(() => {})
    const t = window.setInterval(() => void pollStats(), STATS_POLL_MS)
    return () => window.clearInterval(t)
  }, [reload, pollStats])

  useEffect(() => {
    if (view !== 'system') return
    server.runs().then(setRuns).catch(() => {})
  }, [view, stats?.lastRun?.id, stats?.lastRun?.finished_at, stats?.collecting])

  // ---- derived
  const viewMap = useMemo(() => {
    const m = new Map<string, JobView>()
    for (const j of jobs) m.set(j.linkedinJobId, jobView(j))
    return m
  }, [jobs])
  const view$ = useCallback((j: Job) => viewMap.get(j.linkedinJobId) ?? jobView(j), [viewMap])
  const pre = useCallback((j: Job) => view$(j).pre, [view$])

  // model learned from your decisions; retrained only when a decision or a decided ad's score changes
  const decisionKey = useMemo(() => jobs.filter((j) => decisionLabel(j) !== null).map((j) => `${j.linkedinJobId}:${j.status}:${j.score}:${j.workplaceLlm}`).join('|'), [jobs])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const learned = useMemo<LearnedModel | null>(() => learn(jobs), [decisionKey])
  const youOf = useCallback((j: Job) => (learned ? predict(learned, j) : null), [learned])
  useEffect(() => writeLS('isradar.sortBy', sortBy), [sortBy])
  const byScore = useCallback(
    (a: Job, b: Job) => {
      const va = view$(a)
      const vb = view$(b)
      if (sortBy === 'you' && learned) {
        const d = (youOf(b) ?? -1) - (youOf(a) ?? -1)
        if (d) return d
      }
      return (vb.score ?? -1) - (va.score ?? -1) || vb.pre.score - va.pre.score || (b.postedAt ?? b.firstSeenAt).localeCompare(a.postedAt ?? a.firstSeenAt)
    },
    [view$, sortBy, learned, youOf],
  )
  const queues = useMemo<Record<QueueKey, Job[]>>(() => {
    // reposts (dupOf) stay out of the triage queues; the original carries them
    const fresh = jobs.filter((j) => j.status === 'new' && !j.dupOf)
    return {
      new: fresh.filter((j) => !j.closedAt && view$(j).pre.verdict !== 'reject').sort(byScore),
      suspect: fresh.filter((j) => !j.closedAt && view$(j).suspect).sort(byScore),
      rejected: fresh.filter((j) => j.closedAt || view$(j).pre.verdict === 'reject').sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt) || view$(b).pre.score - view$(a).pre.score),
      decided: jobs.filter((j) => j.status !== 'new').sort(byScore),
      all: [...jobs].sort(byScore),
    }
  }, [jobs, view$, byScore])
  const queueCounts = useMemo(() => ({ new: queues.new.length, suspect: queues.suspect.length, rejected: queues.rejected.length, decided: queues.decided.length, all: queues.all.length }), [queues])
  const raw = queues[queue]
  const rows = useMemo(() => raw.filter((j) => passes(j, filters, { view: view$, threshold })), [raw, filters, view$, threshold])
  const current = useMemo(() => (rows.length ? rows.find((j) => j.linkedinJobId === selectedId) ?? rows[0] : null), [rows, selectedId])
  const shortlisted = useMemo(() => jobs.filter((j) => ['shortlist', 'applied', 'interviewing'].includes(j.status)), [jobs])
  const funnel = useMemo(() => scoreFunnel(jobs, pre), [jobs, pre])
  const calib = useMemo(() => calibration(jobs, view$, threshold), [jobs, view$, threshold])
  const suggestion = useMemo(() => suggestThresholds(jobs, view$, threshold, thresholds), [jobs, view$, threshold, thresholds])
  const reposts = useMemo(() => {
    const m = new Map<string, Job[]>()
    for (const j of jobs) if (j.dupOf) m.set(j.dupOf, [...(m.get(j.dupOf) ?? []), j])
    return m
  }, [jobs])
  // scores made with an older cv/criteria/about that still matter (near/above the threshold, not decided against)
  const staleCount = useMemo(() => {
    const ph = stats?.profileHash
    if (!ph) return 0
    return jobs.filter((j) => j.scoredAt && !j.dupOf && !j.closedAt && ['new', 'shortlist'].includes(j.status) && (j.score ?? 0) >= threshold - 10 && j.scoreProfile !== ph).length
  }, [jobs, stats?.profileHash, threshold])
  const detailJob = view === 'inbox' ? current : detailId ? jobs.find((j) => j.linkedinJobId === detailId) ?? null : null

  // browser back/forward and pasted links: follow the hash
  useEffect(() => {
    const onHash = () => {
      const h = readHash()
      setView(h.view)
      setQueue(h.queue)
      if (h.view === 'inbox') {
        setSelectedId(h.job)
        setDetailId(null)
      } else setDetailId(h.job)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // URL hash mirrors view/queue/job; tab title carries the inbox count and the busy dot
  useEffect(() => {
    const id = view === 'inbox' ? current?.linkedinJobId : detailId
    const h = `#${view}/${queue}${id ? '/' + id : ''}`
    if (location.hash !== h) history.replaceState(null, '', h)
  }, [view, queue, current, detailId])
  useEffect(() => {
    const busy = !!(stats?.collecting || stats?.task)
    document.title = `${busy ? '● ' : ''}İş Radar${queueCounts.new ? ` · ${queueCounts.new}` : ''}`
  }, [stats?.collecting, stats?.task, queueCounts.new])

  // desktop notification for freshly scored ads at or above the threshold (opt-in, Settings)
  useEffect(() => {
    if (jobs.length === 0) return
    const scoredNow = new Set(jobs.filter((j) => j.scoredAt).map((j) => j.linkedinJobId))
    if (seenScored.current === null) {
      seenScored.current = scoredNow
      return
    }
    const fresh = jobs.filter((j) => j.scoredAt && !seenScored.current!.has(j.linkedinJobId) && (j.score ?? 0) >= threshold && j.status === 'new')
    seenScored.current = scoredNow
    if (!fresh.length || !notify || typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.hasFocus()) return
    const top = fresh.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
    const n = new Notification(fresh.length === 1 ? `${top.score} · ${top.title}` : `${fresh.length} yeni iyi ilan buldum · en yükseği ${top.score}`, { body: fresh.length === 1 ? `${top.company ?? ''} · ${top.location ?? ''}` : fresh.map((j) => `${j.score} ${j.title}`).slice(0, 4).join('\n'), tag: 'is-radar' })
    n.onclick = () => {
      window.focus()
      setView('inbox')
      setQueue('new')
      setSelectedId(top.linkedinJobId)
      n.close()
    }
  }, [jobs, threshold, notify])
  const toggleNotify = useCallback(async () => {
    if (notify) {
      setNotify(false)
      writeLS('isradar.notify', false)
      return
    }
    if (typeof Notification === 'undefined') return showToast('Bu tarayıcı bildirim göstermiyor', { kind: 'error' })
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    if (perm !== 'granted') return showToast('Bildirim iznini vermedin, o yüzden açamadım', { kind: 'error' })
    setNotify(true)
    writeLS('isradar.notify', true)
    showToast('Bildirimler açık: sekme arkadayken eşiği geçen yeni ilanları masaüstüne atarım')
  }, [notify, showToast])

  // ---- mutations
  const patchLocal = useCallback((id: string, p: Partial<Job>) => setJobs((cur) => cur.map((j) => (j.linkedinJobId === id ? { ...j, ...p } : j))), [])

  // unread marker: an ad counts as seen after it stayed open ~0.8 s (J/K skimming does not mark)
  useEffect(() => {
    const j = detailJob
    if (!j || j.viewedAt) return
    const t = window.setTimeout(() => {
      const at = new Date().toISOString()
      patchLocal(j.linkedinJobId, { viewedAt: at })
      void updateJob(j.linkedinJobId, () => ({ viewedAt: at })).catch(() => {})
    }, 800)
    return () => window.clearTimeout(t)
  }, [detailJob, patchLocal])
  const lastRoundAt = useMemo(() => {
    const r = stats?.lastRun
    return r && r.finished_at ? r.started_at : null
  }, [stats?.lastRun])
  const unreadCount = useMemo(() => queues.new.filter((j) => !j.viewedAt).length, [queues.new])


  const setStatus = useCallback(
    async (j: Job, status: JobStatus, opts?: { advance?: boolean }) => {
      const prev = { status: j.status, appliedAt: j.appliedAt }
      const appliedAt = status === 'applied' && !j.appliedAt ? new Date().toISOString() : j.appliedAt
      // advance selection before the row leaves the queue
      if (opts?.advance && view === 'inbox' && queue !== 'decided') {
        const i = rows.findIndex((x) => x.linkedinJobId === j.linkedinJobId)
        const next = rows[i + 1] ?? rows[i - 1]
        setSelectedId(next ? next.linkedinJobId : null)
      } else setSelectedId(j.linkedinJobId)
      const clearReason = status !== 'ignored' && status !== 'rejected' && j.decisionReason ? { decisionReason: null } : {}
      patchLocal(j.linkedinJobId, { status, appliedAt, ...clearReason })
      if (clearReason.decisionReason === null) void updateJob(j.linkedinJobId, () => ({ decisionReason: null })).catch(() => {})
      undoStack.current = [...undoStack.current.slice(-19), { id: j.linkedinJobId, prev }]
      const label = { shortlist: 'Shortlist’e ekledim', ignored: 'Geçtim', rejected: 'Reddettim', applied: 'Başvurdun, not aldım', interviewing: 'Görüşmeye aldım', new: 'Yenilere geri aldım' }[status]
      // a pass on an ad the LLM liked is calibration gold: ask why, one tap, optional
      const askWhy = (status === 'ignored' || status === 'rejected') && (j.score ?? 0) >= threshold - 10 && !j.decisionReason
      showToast(`${label} — ${j.company ?? j.title}`, {
        undo: () => void undo(),
        hint: askWhy ? 'neden geçtin?' : undefined,
        actions: askWhy ? DECISION_REASONS.map((r) => ({ label: r, onClick: () => void setReason(j.linkedinJobId, r) })) : undefined,
      })
      try {
        await updateJob(j.linkedinJobId, () => ({ status, appliedAt }))
      } catch (e) {
        patchLocal(j.linkedinJobId, prev)
        showToast(`Kaydedemedim: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' })
      }
    },
    [view, queue, rows, patchLocal, showToast, threshold],
  )

  const setReason = useCallback(
    async (id: string, reason: string | null) => {
      patchLocal(id, { decisionReason: reason })
      setToast(null)
      try {
        await updateJob(id, () => ({ decisionReason: reason }))
        if (reason) showToast(`Sebebi not aldım: ${reason}`)
      } catch (e) {
        showToast(String(e), { kind: 'error' })
      }
    },
    [patchLocal, showToast],
  )

  const openDecision = useCallback((d: 'fp' | 'fn') => {
    setFilters({ ...EMPTY_FILTERS, decision: d })
    setFiltersOpen(false)
    setQueue('all')
    setSelectedId(null)
    setView('inbox')
  }, [])

  /** Pops the last decision (Z or the toast link); the stack keeps the last 20 so Z Z Z walks back. */
  const undo = useCallback(async () => {
    const last = undoStack.current.pop()
    if (!last) return showToast('Geri alacak bir şey yok')
    patchLocal(last.id, last.prev)
    setSelectedId(last.id)
    setToast(null)
    try {
      await updateJob(last.id, () => last.prev)
    } catch (e) {
      showToast(String(e), { kind: 'error' })
    }
  }, [patchLocal, showToast])

  const applyThresholds = useCallback(
    async (t: { review: number; candidate: number }) => {
      try {
        await server.saveRadar({ thresholds: t })
        setThresholds(t)
        configurePrescreen({ ...(await server.getSettings()).radar })
        await reload()
        showToast(`Eşikleri uyguladım: review ≥ ${t.review}, candidate ≥ ${t.candidate}; ön elemeyi baştan hesapladım`)
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      }
    },
    [reload, showToast],
  )

  const openCell = useCallback((r: number, l: number) => {
    setFilters({ ...EMPTY_FILTERS, cell: [r, l] })
    setFiltersOpen(false)
    setQueue('all')
    setSelectedId(null)
    setView('inbox')
  }, [])

  const saveNotes = useCallback(
    async (j: Job, notes: string | null) => {
      patchLocal(j.linkedinJobId, { notes })
      try {
        await updateJob(j.linkedinJobId, () => ({ notes }))
      } catch (e) {
        showToast(`Notu kaydedemedim: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' })
      }
    },
    [patchLocal, showToast],
  )

  const rescore = useCallback(
    async (j: Job) => {
      setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], rescore: true } }))
      try {
        await server.rescore(j.linkedinJobId)
        showToast('Yeniden okuyorum; bitince skoru güncellerim.')
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      } finally {
        window.setTimeout(() => setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], rescore: false } })), 4000)
      }
    },
    [showToast],
  )
  const research = useCallback(
    async (j: Job) => {
      setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], research: true } }))
      try {
        await server.research(j.linkedinJobId)
        showToast(`Araştırmaya başladım — ${j.company ?? ''}. Bir dakika sürer.`)
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      } finally {
        window.setTimeout(() => setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], research: false } })), 4000)
      }
    },
    [showToast],
  )
  const cover = useCallback(async (j: Job) => {
    setCovers((c) => ({ ...c, [j.linkedinJobId]: { ...c[j.linkedinJobId], busy: true, error: undefined } }))
    try {
      const text = await server.coverLetter(j.linkedinJobId)
      setCovers((c) => ({ ...c, [j.linkedinJobId]: { text, busy: false } }))
    } catch (e) {
      setCovers((c) => ({ ...c, [j.linkedinJobId]: { busy: false, error: e instanceof Error ? e.message : String(e) } }))
    }
  }, [])
  const checkLive = useCallback(
    async (j: Job) => {
      setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], check: true } }))
      try {
        const r = await server.check(j.linkedinJobId)
        patchLocal(j.linkedinJobId, { closedAt: r.closed ? new Date().toISOString() : null, closedReason: r.closed ? r.reason : null, checkedAt: new Date().toISOString() })
        showToast(r.closed ? `Baktım, ilan kapanmış: ${r.reason}` : 'Baktım, ilan hâlâ açık')
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      } finally {
        setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], check: false } }))
      }
    },
    [patchLocal, showToast],
  )
  const cvTips = useCallback(
    async (j: Job) => {
      setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], cvTips: true } }))
      try {
        const r = await server.cvTips(j.linkedinJobId)
        patchLocal(j.linkedinJobId, { cvTipsMd: r.md, cvTipsAt: new Date().toISOString() })
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      } finally {
        setBusy((b) => ({ ...b, [j.linkedinJobId]: { ...b[j.linkedinJobId], cvTips: false } }))
      }
    },
    [patchLocal, showToast],
  )
  const remove = useCallback(
    async (j: Job) => {
      if (!confirm('Bu ilanı sileyim mi? LinkedIn’de yine çıkarsa geri eklerim.')) return
      setJobs((cur) => cur.filter((x) => x.linkedinJobId !== j.linkedinJobId))
      setDetailId(null)
      try {
        await deleteJob(j.linkedinJobId)
        showToast('Sildim; LinkedIn’de yine çıkarsa geri gelir')
      } catch (e) {
        showToast(String(e), { kind: 'error' })
        void reload()
      }
    },
    [showToast, reload],
  )
  const startRun = useCallback(
    async (mode?: 'full' | 'incremental') => {
      try {
        await server.startRun(mode)
        showToast(mode === 'full' ? 'Tam turu başlattım' : 'Turu başlattım')
        void pollStats()
      } catch (e) {
        showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
      }
    },
    [showToast, pollStats],
  )
  const rescoreStale = useCallback(async () => {
    try {
      const r = await server.rescoreStale()
      showToast(r.ok ? `${r.queued} ilanı güncel profilinle yeniden okuyorum` : 'Yeniden okuyacak eski ilan kalmamış')
      void pollStats()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
    }
  }, [showToast, pollStats])
  const startScore = useCallback(async () => {
    try {
      const r = await server.startScoring(500, false, true)
      if (r.ok) showToast(`${r.queued} ilanı skorluyorum${r.retried ? `, ${r.retried} hatalıyı da yeniden deneyeceğim` : ''}`)
      else showToast(`Skorlayacak ilan bulamadım: ${r.rejects ?? 0} ilanı ön elemede eledim, ${r.errors ?? 0} tanesi hatalı.`, { kind: 'error' })
      void pollStats()
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { kind: 'error' })
    }
  }, [showToast, pollStats])

  // ---- keyboard
  const move = useCallback(
    (d: number) => {
      if (!rows.length) return
      const i = current ? rows.findIndex((x) => x.linkedinJobId === current.linkedinJobId) : -1
      const n = Math.max(0, Math.min(rows.length - 1, (i === -1 ? 0 : i) + d))
      setSelectedId(rows[n].linkedinJobId)
      document.querySelector(`[data-id="${rows[n].linkedinJobId}"]`)?.scrollIntoView({ block: 'nearest' })
    },
    [rows, current],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = (t?.tagName || '').toLowerCase()
      if (tag === 'input' && e.key === 'Escape') {
        ;(t as HTMLInputElement).blur()
        return
      }
      if (tag === 'textarea' || tag === 'input' || tag === 'select' || t?.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key.toLowerCase()
      const target = detailJob
      if (view !== 'inbox') {
        if (!detailId) return
        if (k === 'escape') setDetailId(null)
        else if (target && k === 's') void setStatus(target, 'shortlist')
        else if (target && k === 'a') void setStatus(target, 'applied')
        else if (target && k === 'g') void setStatus(target, 'interviewing')
        else if (target && k === 'i') void setStatus(target, 'ignored')
        else if (target && k === 'r') void setStatus(target, 'rejected')
        else if (k === 'z') void undo()
        return
      }
      if (k === 'j' || k === 'arrowdown') { e.preventDefault(); move(1) }
      else if (k === 'k' || k === 'arrowup') { e.preventDefault(); move(-1) }
      else if (target && k === 's') void setStatus(target, 'shortlist', { advance: true })
      else if (target && k === 'i') void setStatus(target, 'ignored', { advance: true })
      else if (target && k === 'r') void setStatus(target, 'rejected', { advance: true })
      else if (target && k === 'a') void setStatus(target, 'applied')
      else if (target && k === 'g') void setStatus(target, 'interviewing')
      else if (k === 'z') void undo()
      else if (target && (k === 'o' || k === 'enter')) window.open(target.url, '_blank', 'noopener')
      else if (k === 'n') { e.preventDefault(); noteRef.current?.focus() }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select() }
      else if (k === 'f') setFiltersOpen((v) => !v)
      else if (k >= '1' && k <= '5') { setQueue(QUEUES[Number(k) - 1]); setSelectedId(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, detailId, detailJob, move, setStatus, undo])

  const posLine = useMemo(() => {
    if (view !== 'inbox' || !current) return detailJob ? `${detailJob.title} · ${detailJob.company ?? ''}` : ''
    const i = rows.findIndex((x) => x.linkedinJobId === current.linkedinJobId)
    const why = queue === 'new' ? `${queueCounts.rejected} ilanı kural motorunda eledim` : queue === 'suspect' ? 'kural ile LLM anlaşamadı' : queue === 'rejected' ? 'kural motoru eledi, LLM’e okutmadım' : queue === 'all' ? 'tüm ilanlar' : 'kararların'
    return `${i + 1} / ${rows.length}  ·  ${why}`
  }, [view, current, detailJob, rows, queue, queueCounts.rejected])

  const onThreshold = (n: number) => {
    setThreshold(n)
    void saveSettings({ scoreThreshold: n })
  }

  return (
    <div className="app">
      <Header view={view} onView={(v) => { setView(v); setDetailId(null) }} counts={{ inbox: queueCounts.new, shortlist: shortlisted.length }} stats={stats} dark={dark} onTheme={() => setDark((v) => !v)} />

      {view === 'inbox' && (
        <main className="inbox">
          <Inbox
            stats={stats}
            funnel={funnel}
            queue={queue}
            queueCounts={queueCounts}
            onQueue={(q) => { setQueue(q); setSelectedId(null) }}
            raw={raw}
            rows={rows}
            view={view$}
            threshold={threshold}
            selectedId={current?.linkedinJobId ?? null}
            onSelect={setSelectedId}
            filters={filters}
            onFilters={(f) => { setFilters(f); setSelectedId(null) }}
            filtersOpen={filtersOpen}
            onFiltersOpen={setFiltersOpen}
            searchRef={searchRef}
            lastRoundAt={lastRoundAt}
            unreadCount={unreadCount}
            youOf={learned?.useful ? youOf : null}
            sortBy={sortBy}
            onSortBy={learned ? setSortBy : null}
          />
          {!current && jobs.length > 0 && (
            <div className="detail-inline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dim)', fontSize: 13, padding: 24, textAlign: 'center' }}>
              Bu kuyrukta sana gösterecek ilan yok.
            </div>
          )}
          {!current && jobs.length === 0 && (
            <div className="detail-inline" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
              <div className="card" style={{ maxWidth: 520 }}>
                <div className="eyebrow" style={{ marginBottom: 10 }}>İlk çalıştırma</div>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Daha hiç ilan yok.</div>
                <ol style={{ margin: '0 0 14px 18px', padding: 0, fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.7 }}>
                  <li><span className="mono">profile/cv.md</span>, <span className="mono">criteria.md</span>, <span className="mono">about.md</span> dolu mu? Skorlarken bunlara bakıyorum.</li>
                  <li><span className="mono">searches.yaml</span>'daki aramalar ve <span className="mono">radar.home_cities</span> sana göre mi? Ayarlar sekmesinden düzenleyebilirsin.</li>
                  <li>Tam turu başlat: son 30 güne bakarım, ~1 saat sürer. Sonra her 3 saatte bir artımlı tur atarım.</li>
                </ol>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn primary" onClick={() => void startRun('full')} disabled={!!stats?.collecting}>{stats?.collecting ? 'Tur dönüyor…' : 'Tam tur başlat'}</button>
                  <button className="btn" onClick={() => setView('settings')}>Ayarlar</button>
                </div>
              </div>
            </div>
          )}
        </main>
      )}
      {view === 'shortlist' && <Shortlist jobs={shortlisted} pre={pre} threshold={threshold} onOpen={setDetailId} onStatus={(id, s) => { const j = jobs.find((x) => x.linkedinJobId === id); if (j) void setStatus(j, s) }} />}
      {view === 'system' && <System stats={stats} runs={runs} funnel={funnel} calib={calib} threshold={threshold} thresholds={thresholds} suggestion={suggestion} onCell={openCell} onDecision={openDecision} onApplyThresholds={(t) => void applyThresholds(t)} untriaged={queueCounts.new} suspects={queueCounts.suspect} onRun={startRun} onScore={startScore} staleCount={staleCount} onRescoreStale={() => void rescoreStale()} learned={learned} decisions={jobs.filter((j) => decisionLabel(j) !== null).length} />}
      {view === 'settings' && <Settings threshold={threshold} onThreshold={onThreshold} onToast={(t, kind) => showToast(t, { kind })} busy={!!stats?.task} notify={notify} onToggleNotify={() => void toggleNotify()} onRadarSaved={async () => { configurePrescreen((await server.getSettings()).radar); const s = await server.getSettings(); if (s.thresholds) setThresholds(s.thresholds); await reload() }} />}

      {detailJob && (
        <Detail
          job={detailJob}
          pre={pre(detailJob)}
          profileHash={stats?.profileHash ?? null}
          you={learned ? youOf(detailJob) : null}
          reposts={reposts.get(detailJob.linkedinJobId) ?? []}
          threshold={threshold}
          inline={view === 'inbox'}
          posLine={posLine}
          cover={covers[detailJob.linkedinJobId]}
          busy={busy[detailJob.linkedinJobId] ?? {}}
          noteRef={noteRef}
          onStatus={(s) => void setStatus(detailJob, s, { advance: view === 'inbox' && ['shortlist', 'ignored', 'rejected'].includes(s) })}
          onNotes={(n) => saveNotes(detailJob, n)}
          onRescore={() => void rescore(detailJob)}
          onResearch={() => void research(detailJob)}
          onCover={() => void cover(detailJob)}
          onCvTips={() => void cvTips(detailJob)}
          onCheck={() => void checkLive(detailJob)}
          onReason={(r) => void setReason(detailJob.linkedinJobId, r)}
          onDelete={() => void remove(detailJob)}
          onClose={() => setDetailId(null)}
        />
      )}
      <Toast toast={toast} />
    </div>
  )
}
