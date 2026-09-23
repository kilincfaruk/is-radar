/** One collection round: searches → cards → details → prescreen → (score) → (research) → (notify). */
import { loadSearches, ensureDirs, env, type RunMode } from './config.ts'
import { PoliteHttp, RateLimitedError, sleep } from './http.ts'
import { parseSearchPage, parseDetailPage, searchUrl, detailUrl, saveSample } from './sources/linkedin-guest.ts'
import { upsertCard, applyDetail, markDescriptionMissing, jobsNeedingDescription, startRun, updateRun, openDb, allJobs, getSetting, setSetting, knownJobIds, lastCompletedFullSearch, markClosed, markChecked, jobsNeedingLivenessCheck, linkDuplicates, closeMissingFromBoard, skippedJobs, releaseSkipped, type JobRow } from './db.ts'
import { fetchBoard, atsId, atsSource } from './sources/ats.ts'
import { runPrescreen, runScoringWhile, runTopScoring } from './pipeline/score.ts'
import { titleGate, detectRole } from './shared/prescreen.ts'
import { planRound, pruneStats, recordYield, type SearchStats } from './search-plan.ts'
import { setPrescreen, markDescriptionSkipped } from './db.ts'
import { runResearch } from './pipeline/research.ts'
import { notifyTelegram } from './pipeline/notify.ts'
import { snapshotUsage, usageSince } from './pipeline/claude-cli.ts'
import { log } from './log.ts'

export type RunOptions = {
  maxSearches?: number
  pages?: number
  details?: number
  score?: boolean
  research?: boolean
  scoreBudget?: number
  http?: PoliteHttp
  /** 'full' = 30-day deep sweep, 'incremental' = only what appeared since the last tick, undefined = auto (full once, then incremental). */
  mode?: RunMode
}

export type RunProgress = { phase: string; detail: string }
let current: RunProgress | null = null
export function currentProgress(): RunProgress | null {
  return current
}

/** Re-fetch one ad's guest page and record whether it still accepts applications. */
export async function checkLiveness(http: PoliteHttp, id: string): Promise<{ closed: boolean; reason: string }> {
  const res = await http.get(detailUrl(id))
  if (res.status === 404 || res.status === 410) {
    markClosed(id, `ilan kaldırılmış (${res.status})`)
    return { closed: true, reason: `kaldırılmış (${res.status})` }
  }
  if (res.status !== 200) return { closed: false, reason: `HTTP ${res.status}` }
  const d = parseDetailPage(res.text, id)
  if (d?.closed) {
    markClosed(id, 'başvuru kapalı')
    return { closed: true, reason: 'başvuru kapalı' }
  }
  markChecked(id)
  return { closed: false, reason: 'açık' }
}

export async function collectRound(o: RunOptions = {}): Promise<number> {
  ensureDirs()
  openDb()
  const cfg = loadSearches()
  const http = o.http ?? new PoliteHttp()
  // a full sweep whose search phase finished but which was killed later (e.g. during scoring) still counts
  if (!getSetting('lastFullRunAt')) {
    const done = lastCompletedFullSearch(cfg.searches.length)
    if (done) {
      setSetting('lastFullRunAt', done.started_at)
      setSetting('lastRunStartedAt', done.started_at)
      log.info(`önceki tam turun arama fazı tamamlanmıştı (${done.started_at}), tekrar edilmiyor`)
    }
  }
  const mode: RunMode = o.mode ?? (getSetting('lastFullRunAt') ? 'incremental' : 'full')
  const spec = cfg.modes[mode]
  const known = mode === 'incremental' ? knownJobIds() : new Set<string>()
  // incremental window: everything since the last completed round started (+1 h slack), never below the
  // configured window, capped at 30 days — covers the night gap when the scheduler is silent
  const lastStarted = getSetting('lastRunStartedAt')
  const cfgSecs = Number(String(spec.f_TPR).replace(/^r/, '')) || 3 * 3600
  const sinceSecs = lastStarted ? Math.round((Date.now() - new Date(lastStarted).getTime()) / 1000) + 3600 : cfgSecs
  const incrementalTpr = 'r' + Math.min(30 * 86400, Math.max(cfgSecs, sinceSecs))
  const startedIso = new Date().toISOString()
  const runId = startRun(mode === 'full' ? 'collect-full' : 'collect')
  const usage0 = snapshotUsage()
  let aborted = false
  let crashed: unknown = null
  log.info(`tur modu: ${mode} (f_TPR=${mode === 'full' ? spec.f_TPR : incrementalTpr}, max ${spec.max_pages} sayfa)`)
  const t0 = Date.now()
  let cards = 0
  let newJobs = 0
  let details = 0
  let searchesDone = 0
  const seenThisRound = new Set<string>()
  const scoredBefore = new Set(allJobs().filter((j) => j.scored_at).map((j) => j.linkedin_job_id))
  // two phases can run at once (details ‖ scoring): the progress line shows both
  const parts = new Map<string, string>()
  const set = (phase: string, detail: string) => {
    parts.set(phase, detail)
    const others = [...parts].filter(([k]) => k !== phase).map(([k, v]) => `${k} ${v}`)
    current = { phase, detail: others.length ? `${detail} · ${others.join(' · ')}` : detail }
    log.info(`[${phase}] ${detail}`)
  }
  const clear = (phase: string) => parts.delete(phase)
  let detailsDone = false
  let scored = 0
  let researched = 0
  // scoring starts as soon as the search phase ends and keeps draining while details are fetched
  const scoreBudget = o.score !== false && env('SCORER', 'claude-cli') !== 'none' ? (o.scoreBudget ?? Number(env('SCORE_BUDGET_PER_RUN', '60'))) : 0
  let scoring: Promise<{ scored: number; failed: number }> | null = null

  try {
    // rotation: searches that kept coming back empty run every 2nd/3rd/4th incremental round
    const roundNo = Number(getSetting('roundNo') ?? '0') + 1
    setSetting('roundNo', String(roundNo))
    let yieldStats: SearchStats = pruneStats(JSON.parse(getSetting('searchStats') ?? '{}') as SearchStats, cfg.searches)
    const all = cfg.searches.slice(0, o.maxSearches ?? cfg.searches.length)
    const plan = planRound(all, yieldStats, roundNo, mode)
    if (plan.skipped.length) log.info(`rotasyon: ${plan.skipped.length} düşük verimli arama bu tur atlandı (${plan.skipped.map((x) => `${x.spec.keywords} · ${x.spec.location} → ${x.every} turda bir`).join('; ')})`)
    const searches = plan.run
    for (const sp of searches) {
      const newBefore = newJobs
      // guest search has no workplace filter and no workplace label: every card starts as 'unknown',
      // the ad text (rules + LLM) decides remote/hybrid/onsite later
      const workplace = 'unknown' as const
      // full: per-search override (if written in the yaml) else modes.full; incremental: always the mode's window
      const maxPages = o.pages ?? (mode === 'full' ? sp.max_pages ?? spec.max_pages : spec.max_pages)
      const tpr = mode === 'full' ? sp.f_TPR ?? spec.f_TPR : incrementalTpr
      let start = 0
      for (let page = 0; page < maxPages; page++) {
        set('arama', `${sp.keywords} · ${sp.location} · sayfa ${page + 1}${mode === 'incremental' ? ' (artımlı)' : ''}`)
        const url = searchUrl({ keywords: sp.keywords, location: sp.location, f_TPR: tpr, start })
        const res = await http.get(url)
        if (res.status !== 200) {
          log.warn(`arama HTTP ${res.status}`, url.slice(0, 100))
          break
        }
        const parsed = parseSearchPage(res.text, { workplace, keywords: sp.keywords })
        if (parsed.length === 0) {
          if (page === 0 && res.text.length > 5000) saveSample('search', `${sp.keywords}`.replace(/\W+/g, '_'), res.text)
          break
        }
        let unknownOnPage = 0
        for (const c of parsed) {
          if (!known.has(c.linkedin_job_id)) unknownOnPage++
          const isNew = upsertCard(c, !seenThisRound.has(c.linkedin_job_id))
          seenThisRound.add(c.linkedin_job_id)
          cards++
          if (isNew) newJobs++
        }
        start += parsed.length
        if (parsed.length < 10) break
        // incremental: a page made only of ids we already had means the rest is old too
        if (mode === 'incremental' && unknownOnPage === 0) break
      }
      searchesDone++
      yieldStats = recordYield(yieldStats, sp, newJobs - newBefore)
      setSetting('searchStats', JSON.stringify(yieldStats))
      updateRun(runId, { searches: searchesDone, cards, new_jobs: newJobs, requests: http.stats.requests, rate_limited: http.stats.rateLimited, errors: http.stats.errors })
    }

    // company career boards (searches.yaml → companies): JSON, cheap, independent of LinkedIn's rate limit
    if (cfg.companies.length) {
      const atsHttp = new PoliteHttp({ minGapMs: 1500, maxGapMs: 3000, perHour: 600 })
      for (const c of cfg.companies) {
        set('şirket panosu', `${c.name} (${c.ats})`)
        const r = await fetchBoard(c, atsHttp).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
        if (!r.ok) {
          log.warn(`şirket panosu ${c.name}: ${r.error}`)
          continue
        }
        let fresh = 0
        for (const j of r.kept) {
          const isNew = upsertCard({ linkedin_job_id: j.id, url: j.url, title: j.title, company: j.company, company_url: null, location: j.location, workplace_type: j.workplace, posted_text: null, posted_at: j.posted_at, source: atsSource(c.ats), search_keywords: `şirket: ${c.name}` }, !seenThisRound.has(j.id))
          seenThisRound.add(j.id)
          if (j.description_md.length >= 40) applyDetail({ linkedin_job_id: j.id, description_md: j.description_md })
          cards++
          if (isNew) {
            newJobs++
            fresh++
          }
        }
        const closed = closeMissingFromBoard(atsId(c.ats, c.board, ''), new Set(r.kept.map((j) => j.id)))
        log.info(`şirket panosu ${c.name}: ${r.all} ilan, ${r.kept.length} hedef rol + uygun lokasyon, ${fresh} yeni${closed ? `, ${closed} panodan kalktı` : ''}`)
      }
      clear('şirket panosu')
    }

    // reposts found this round point at their original and skip the detail/score budget
    const dups = linkDuplicates()
    if (dups) log.info(`tekrar yayın: ${dups} ilan eski ilanla eşleşti (metin çekilmez, skorlanmaz)`)
    // search phase done: record it now, so a kill during details/scoring does not force another sweep
    setSetting('lastRunStartedAt', startedIso)
    if (mode === 'full') setSetting('lastFullRunAt', new Date().toISOString())
    if (scoreBudget !== 0) scoring = runScoringWhile(() => detailsDone, scoreBudget, (done, total) => set('skor', `${done}/${total}`))

    // details
    const budget = o.details ?? cfg.defaults.detail_budget
    // titles skipped earlier get another look: the gate or the yaml role dictionaries may have changed since
    let released = 0
    for (const j of skippedJobs()) {
      if (titleGate(j.title)) continue
      releaseSkipped(j.linkedin_job_id)
      released++
    }
    if (released) log.info(`başlık kapısı: daha önce atlanan ${released} ilan artık hedefte, metni çekilecek`)
    // title gate: obviously irrelevant titles never spend a request
    let gated = 0
    for (const j of jobsNeedingDescription(100000)) {
      const why = titleGate(j.title)
      if (!why) continue
      setPrescreen(j.linkedin_job_id, 'reject', 10, { verdict: 'reject', score: 10, remote: 'unknown', homeCity: false, role: 'mismatch', seniority: 'unknown', flags: [], reasons: ['metin çekilmedi, ' + why], bonuses: [] })
      markDescriptionSkipped(j.linkedin_job_id, why)
      gated++
    }
    if (gated) log.info(`başlık kapısı: ${gated} ilan elendi (metin çekilmedi)`)
    // budget is spent on the most promising titles first (core > adjacent > bridge > rest), newest first within a tier
    const tier: Record<string, number> = { core: 0, adjacent: 1, bridge: 2, mismatch: 3 }
    const need = jobsNeedingDescription(100000)
      .map((j) => ({ j, t: tier[detectRole(j.title, '').role] ?? 3 }))
      .sort((a, b) => a.t - b.t || (b.j.posted_at ?? b.j.first_seen_at).localeCompare(a.j.posted_at ?? a.j.first_seen_at))
      .slice(0, budget)
      .map((x) => x.j)
    for (let i = 0; i < need.length; i++) {
      const j = need[i]
      set('detay', `${i + 1}/${need.length} · ${j.title.slice(0, 50)}`)
      // breather every 25 details: bursts of hundreds of detail fetches are what draw the 429
      if (i > 0 && i % 25 === 0) await sleep(45_000 + Math.floor(Math.random() * 45_000))
      const res = await http.get(detailUrl(j.linkedin_job_id))
      if (res.status === 404 || res.status === 410) {
        markDescriptionMissing(j.linkedin_job_id, `ilan kaldırılmış (${res.status})`)
        continue
      }
      if (res.status !== 200) {
        log.warn(`detay HTTP ${res.status}`, j.linkedin_job_id)
        continue
      }
      const d = parseDetailPage(res.text, j.linkedin_job_id)
      if (!d) {
        saveSample('detail', j.linkedin_job_id, res.text)
        markDescriptionMissing(j.linkedin_job_id, 'description parse edilemedi')
        continue
      }
      applyDetail(d)
      if (d.closed) markClosed(j.linkedin_job_id, 'başvuru kapalı')
      details++
      if (i % 5 === 4) updateRun(runId, { details, requests: http.stats.requests, rate_limited: http.stats.rateLimited, errors: http.stats.errors })
    }

    // liveness: ads being pursued (shortlist/applied/interviewing) and good unread ones get re-fetched every few days,
    // so a closed posting stops looking open in the dashboard
    const liveBudget = Number(env('LIVENESS_BUDGET_PER_RUN', '15'))
    const liveMin = Number(env('LIVENESS_MIN_SCORE', env('RESEARCH_MIN_SCORE', '70')))
    const stale = jobsNeedingLivenessCheck(liveBudget, liveMin)
    let closedNow = 0
    for (let i = 0; i < stale.length; i++) {
      const j = stale[i]
      set('tazelik', `${i + 1}/${stale.length} · ${j.title.slice(0, 50)}`)
      const r = await checkLiveness(http, j.linkedin_job_id)
      if (r.closed) {
        closedNow++
        log.info(`ilan kapandı: ${j.title.slice(0, 50)} @ ${j.company ?? '?'} (${r.reason})`)
      }
    }
    clear('tazelik')
    if (stale.length) log.info(`tazelik kontrolü: ${stale.length} ilan, ${closedNow} kapanmış`)
  } catch (e) {
    aborted = true
    if (e instanceof RateLimitedError) {
      log.error(e.message)
      updateRun(runId, { note: e.message })
    } else {
      // any other failure still closes the round below: an unfinished row would make the scheduler start a new one every minute
      crashed = e
      const msg = e instanceof Error ? e.message : String(e)
      log.error('tur hatası:', msg)
      updateRun(runId, { note: `hata: ${msg.slice(0, 180)}` })
    }
  }

  clear('detay')
  detailsDone = true
  let pre = 0
  try {
    set('ön eleme', 'kural motoru')
    pre = runPrescreen()
    clear('ön eleme')

    // aborted before the search phase ended (429): scoring never started, still score what already has text
    if (!scoring && !crashed && scoreBudget !== 0) scoring = runScoringWhile(() => true, scoreBudget, (done, total) => set('skor', `${done}/${total}`))
    await finishRound()
  } catch (e) {
    crashed ??= e
    log.error('tur hatası (skor/araştırma):', e instanceof Error ? e.message : String(e))
    updateRun(runId, { note: `hata: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}` })
  } finally {
    const used = usageSince(usage0)
    updateRun(runId, {
      finished_at: new Date().toISOString(),
      cost_usd: used.costUsd,
      claude_calls: used.calls,
      claude_ms: used.ms,
      searches: searchesDone,
      cards,
      new_jobs: newJobs,
      details,
      scored,
      researched,
      requests: http.stats.requests,
      rate_limited: http.stats.rateLimited,
      errors: http.stats.errors,
    })
    current = null
    log.info(`tur bitti (${mode}, ${Math.round((Date.now() - t0) / 1000)} sn): ${searchesDone} arama, ${cards} kart, ${newJobs} yeni, ${details} metin, ${pre} ön eleme, ${scored} skor, ${researched} araştırma, ${http.stats.requests} istek, ${http.stats.rateLimited} 429${used.calls ? `, claude ${used.calls} çağrı${used.costUsd ? ` $${used.costUsd.toFixed(2)}` : ''}` : ''}${crashed ? ' · HATAYLA bitti' : ''}`)
  }
  return runId

  async function finishRound(): Promise<void> {
    if (scoring) {
      const r = await scoring
      scored = r.scored
      clear('skor')
      const topBudget = Number(env('TOP_BUDGET_PER_RUN', '15'))
      if (topBudget > 0) {
        const t = await runTopScoring(topBudget, (done, total) => set('ikinci görüş', `${done}/${total}`))
        scored += t.scored
        clear('ikinci görüş')
      }
    }

    if (o.research !== false) {
      const min = Number(env('RESEARCH_MIN_SCORE', '70'))
      if (min > 0) {
        set('araştırma', `skor ≥ ${min}`)
        researched = await runResearch(min, 10)
      }
    }

    // notify on newly scored high ones
    const minNotify = Number(env('NOTIFY_MIN_SCORE', '80'))
    const fresh = allJobs().filter((j) => j.scored_at && !scoredBefore.has(j.linkedin_job_id) && (j.score ?? 0) >= minNotify)
    await notifyTelegram(fresh as JobRow[])

    if (aborted && mode === 'full') log.warn('tam tur yarım kaldı; arama fazı bitmediyse bir sonraki tur yine tam tur olur')
  }
}
