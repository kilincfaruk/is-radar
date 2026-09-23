/**
 * Standalone HTML report: one self-contained file (inline CSS + a few lines of JS, no network), written after every
 * round to data/reports/ and on demand from the dashboard / CLI. Meant to be opened offline, mailed or sent to
 * someone who does not run the radar. Every piece of ad text is HTML-escaped; links are http(s) only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, env } from './config.ts'
import { allJobs, getSetting, recentRuns, type JobRow, type RunRow } from './db.ts'
import { computeScore, scoreLine, type Facts } from './shared/scoring.ts'
import { HOME_CITIES } from './shared/prescreen.ts'
import { PROFILE_DIR } from './pipeline/profile.ts'

export const REPORTS_DIR = path.join(DATA_DIR, 'reports')

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null)
const arr = (s: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(s || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}
const fmt = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const days = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return n <= 0 ? 'bugün' : n === 1 ? 'dün' : `${n} gün önce`
}

const WP: Record<string, string> = {
  remote: 'Remote',
  hybrid_ankara: `Hibrit · ${HOME_CITIES[0] ?? ''}`,
  hybrid_home: 'Hibrit · kabul edilen şehir',
  hybrid_other: 'Hibrit · başka şehir',
  onsite_ankara: `Ofis · ${HOME_CITIES[0] ?? ''}`,
  onsite_home: 'Ofis · kabul edilen şehir',
  onsite_other: 'Ofis · başka şehir',
  unknown: 'çalışma şekli yazmıyor',
}
const STATUS: Record<string, string> = { new: 'yeni', shortlist: 'shortlist', applied: 'başvurdun', interviewing: 'görüşme', ignored: 'geçtin', rejected: 'reddettin' }

/** Tiny markdown → HTML for ad texts: headings, bullets, bold, paragraphs. Input is escaped first. */
function mdToHtml(md: string): string {
  const out: string[] = []
  let list = false
  const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    const li = line.match(/^(?:[-*•·]|\d+[.)])\s+(.*)$/)
    if (li) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    if (list) {
      out.push('</ul>')
      list = false
    }
    if (!line) continue
    const h = line.match(/^#{1,4}\s+(.*)$/) ?? line.match(/^\*\*(.+)\*\*:?$/)
    out.push(h ? `<h5>${inline(h[1].replace(/\*\*/g, ''))}</h5>` : `<p>${inline(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('')
}

/** "Mert Sarıkaya" from "# Mert Sarıkaya — Kalite Kontrol Mühendisi"; null for the untouched template. */
export function profileName(): string | null {
  try {
    const first = fs.readFileSync(path.join(PROFILE_DIR, 'cv.md'), 'utf8').split('\n').find((l) => l.startsWith('# '))
    const name = first?.replace(/^#\s+/, '').split(/\s+[—–-]\s+/)[0].trim()
    return name && !/^ad soyad$/i.test(name) ? name : null
  } catch {
    return null
  }
}

function card(j: JobRow, threshold: number, isNew: boolean): string {
  const facts = j.facts_json ? (JSON.parse(j.facts_json) as Facts) : null
  const res = facts ? computeScore(facts, { location: j.location }) : null
  const s = j.score
  const tone = s == null ? 'dim' : s >= threshold + 10 ? 'hi' : s >= threshold ? 'ok' : s >= 40 ? 'mid' : 'dim'
  const pros = arr(j.pros_json)
  const cons = arr(j.cons_json)
  const flags = arr(j.red_flags_json)
  const url = safeUrl(j.url)
  const meta = [j.company, j.location, WP[j.workplace_llm ?? ''] ?? null, j.workplace_detail, days(j.posted_at ?? j.first_seen_at), j.salary_note ? `₺ ${j.salary_note}` : null].filter(Boolean)
  const badges = [
    isNew ? '<span class="b new">bu turda geldi</span>' : '',
    j.status !== 'new' ? `<span class="b st">${esc(STATUS[j.status] ?? j.status)}</span>` : '',
    j.closed_at ? '<span class="b closed">kapandı</span>' : '',
    j.source?.startsWith('ats:') ? '<span class="b src">şirket panosu</span>' : '',
  ].join('')
  const text = [j.title, j.company, j.location, j.summary, ...pros, ...cons].join(' ').toLocaleLowerCase('tr-TR')
  return `<article class="job${isNew ? ' is-new' : ''}" data-text="${esc(text)}" data-new="${isNew ? 1 : 0}">
  <div class="score ${tone}">${s ?? '–'}</div>
  <div class="body">
    <h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a>` : esc(j.title)} ${badges}</h3>
    <div class="meta">${meta.map(esc).join(' · ')}</div>
    ${res ? `<div class="parts">${esc(scoreLine(res))}</div>` : ''}
    ${j.summary ? `<p class="sum">${esc(j.summary)}</p>` : ''}
    ${pros.length || cons.length || flags.length ? `<ul class="pc">${pros.map((x) => `<li class="p">${esc(x)}</li>`).join('')}${cons.map((x) => `<li class="c">${esc(x)}</li>`).join('')}${flags.map((x) => `<li class="f">${esc(x)}</li>`).join('')}</ul>` : ''}
    ${j.notes ? `<p class="note">Not: ${esc(j.notes)}</p>` : ''}
    ${j.description_md ? `<details><summary>İlan metni</summary><div class="desc">${mdToHtml(j.description_md)}</div></details>` : ''}
  </div>
</article>`
}

export type ReportData = { html: string; counts: { newThisRound: number; worth: number; near: number; pursued: number } }

export function buildReport(o: { run?: RunRow | null; threshold?: number } = {}): ReportData {
  const threshold = o.threshold ?? Number(getSetting('scoreThreshold') ?? '70')
  const run = o.run === undefined ? recentRuns(1)[0] ?? null : o.run
  const jobs = allJobs().filter((j) => !j.dup_of)
  const byScore = (a: JobRow, b: JobRow) => (b.score ?? -1) - (a.score ?? -1)
  const since = run?.started_at ?? null
  const isNew = (j: JobRow) => !!since && j.first_seen_at >= since
  const open = (j: JobRow) => j.status === 'new' && !j.closed_at && j.score != null
  const newGood = jobs.filter((j) => isNew(j) && open(j) && (j.score ?? 0) >= threshold - 10).sort(byScore)
  const worth = jobs.filter((j) => open(j) && (j.score ?? 0) >= threshold && !isNew(j)).sort(byScore)
  const near = jobs.filter((j) => open(j) && (j.score ?? 0) >= threshold - 10 && (j.score ?? 0) < threshold && !isNew(j)).sort(byScore)
  const pursued = jobs.filter((j) => ['shortlist', 'applied', 'interviewing'].includes(j.status)).sort((a, b) => ['interviewing', 'applied', 'shortlist'].indexOf(a.status) - ['interviewing', 'applied', 'shortlist'].indexOf(b.status) || byScore(a, b))
  const name = profileName()
  const now = new Date().toISOString()
  const scored = jobs.filter((j) => j.score != null).length
  const section = (id: string, title: string, hint: string, list: JobRow[], empty: string) =>
    `<section id="${id}"><h2>${esc(title)} <span class="n">${list.length}</span></h2><p class="hint">${esc(hint)}</p>${list.length ? list.map((j) => card(j, threshold, isNew(j))).join('\n') : `<p class="empty">${esc(empty)}</p>`}</section>`
  const runLine = run
    ? `Tur ${fmt(run.started_at)}${run.finished_at ? ` · ${Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 60_000))} dk` : ''} · ${run.new_jobs} yeni ilan · ${run.scored} skor${run.cost_usd ? ` · Claude $${run.cost_usd.toFixed(2)}` : ''}${run.note ? ` · ${run.note}` : ''}`
    : 'Henüz tur yok'
  const title = `İş Radar${name ? ` · ${name}` : ''} · ${new Date(now).toLocaleDateString('tr-TR')}`
  const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#fbfaf7;--card:#fff;--text:#1d1d1b;--muted:#5d5d58;--dim:#8b8b85;--line:#e6e3dc;--accent:#12805c;--amber:#b26b00;--red:#c0392b;--blue:#2563eb;--chip:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#121311;--card:#1a1b19;--text:#ecebe6;--muted:#b3b2ab;--dim:#85847e;--line:#2c2d2a;--accent:#4fd1a1;--amber:#f0b44c;--red:#f07167;--blue:#7aa7ff;--chip:#242522}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 16px 64px}
header h1{font-size:22px;margin:0 0 4px}header .sub{color:var(--muted);font-size:13.5px}
.stats{display:flex;gap:18px;flex-wrap:wrap;margin:18px 0 10px}.stat b{display:block;font:600 24px/1.1 ui-monospace,Menlo,Consolas,monospace}.stat span{font-size:12px;color:var(--muted)}
nav{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:16px 0 8px;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:1;border-bottom:1px solid var(--line)}
nav a{color:var(--muted);text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:99px}
nav input[type=search]{flex:1;min-width:180px;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);font:inherit}
nav label{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center}
section{margin-top:26px}h2{font-size:16px;margin:0}h2 .n{font:500 12px ui-monospace,monospace;color:var(--dim);margin-left:6px}.hint{color:var(--dim);font-size:12.5px;margin:2px 0 10px}.empty{color:var(--dim);font-size:13.5px}
.job{display:grid;grid-template-columns:52px minmax(0,1fr);gap:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px}
.job.is-new{border-color:color-mix(in oklab,var(--accent) 45%,var(--line))}
.score{font:600 24px/1 ui-monospace,Menlo,Consolas,monospace;text-align:right;padding-top:2px}.score.hi,.score.ok{color:var(--accent)}.score.mid{color:var(--amber)}.score.dim{color:var(--dim)}
h3{font-size:15.5px;margin:0 0 3px;line-height:1.35}h3 a{color:inherit;text-decoration:none}h3 a:hover{text-decoration:underline}
.meta{color:var(--muted);font-size:13px}.parts{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--dim);margin-top:6px}
.sum{margin:8px 0 6px}.pc{list-style:none;padding:0;margin:6px 0;font-size:13.5px}.pc li{padding-left:16px;position:relative;margin:2px 0}
.pc li:before{position:absolute;left:0;font-weight:700}.pc .p:before{content:"+";color:var(--accent)}.pc .c:before{content:"−";color:var(--amber)}.pc .f:before{content:"⚑";color:var(--red);font-size:11px}
.note{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding-left:8px}
.b{font:600 10.5px/1 system-ui,sans-serif;padding:3px 7px;border-radius:99px;margin-left:4px;vertical-align:2px;background:var(--chip);color:var(--muted)}.b.new{background:var(--accent);color:var(--bg)}.b.closed{color:var(--red)}.b.src{color:var(--blue)}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:13px}.desc{font-size:13.5px;color:var(--muted);margin-top:6px}.desc h5{font-size:13.5px;color:var(--text);margin:10px 0 2px}.desc p{margin:4px 0}.desc ul{margin:4px 0;padding-left:20px}
footer{margin-top:40px;color:var(--dim);font-size:12px}
@media (max-width:560px){.job{grid-template-columns:40px minmax(0,1fr);gap:10px}.score{font-size:20px}}
@media print{nav,details{display:none}.job{break-inside:avoid}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(runLine)}</div>
  <div class="stats">
    <div class="stat"><b>${newGood.length}</b><span>bu turda gelen iyi ilan</span></div>
    <div class="stat"><b>${worth.length}</b><span>bakmaya değer (≥ ${threshold})</span></div>
    <div class="stat"><b>${pursued.length}</b><span>takipteki</span></div>
    <div class="stat"><b>${scored}</b><span>skorlanan / ${jobs.length} ilan</span></div>
  </div>
</header>
<nav>
  <a href="#yeni">Yeni</a><a href="#deger">Bakmaya değer</a><a href="#yakin">Eşiğe yakın</a><a href="#takip">Takipte</a>
  <input id="q" type="search" placeholder="Başlık, şirket, kelime…" aria-label="Ara">
  <label><input id="onlyNew" type="checkbox"> sadece bu tur</label>
</nav>
${section('yeni', 'Bu turda gelenler', `Son turda ilk kez görülen ve skoru ${threshold - 10} ve üstü olanlar.`, newGood, 'Bu turda eşiğe yakın yeni ilan gelmedi.')}
${section('deger', 'Bakmaya değer', `Henüz karar vermediğin, skoru ${threshold} ve üstü açık ilanlar.`, worth, 'Şu an eşik üstünde bekleyen ilan yok.')}
${section('yakin', 'Eşiğe yakın', `Skoru ${threshold - 10}–${threshold - 1} arası; bir göz atmaya değebilir.`, near, 'Eşiğe yakın ilan yok.')}
${section('takip', 'Takipte', 'Shortlist, başvurdun ve görüşme aşamasındakiler.', pursued, 'Henüz takipte ilan yok.')}
<footer>İş Radar · ${esc(fmt(now))} · Skor = Claude'un içerik uyumu + kurallar (çalışma şekli, kıdem, dil, maaş). Bu dosya internetsiz açılır.</footer>
</div>
<script>
(function(){var q=document.getElementById('q'),o=document.getElementById('onlyNew'),cards=[].slice.call(document.querySelectorAll('.job'));
function f(){var t=(q.value||'').toLocaleLowerCase('tr-TR').trim();cards.forEach(function(c){var ok=(!t||c.getAttribute('data-text').indexOf(t)>=0)&&(!o.checked||c.getAttribute('data-new')==='1');c.style.display=ok?'':'none'})}
q.addEventListener('input',f);o.addEventListener('change',f)})();
</script>
</body>
</html>
`
  return { html, counts: { newThisRound: newGood.length, worth: worth.length, near: near.length, pursued: pursued.length } }
}

/** Write the report to data/reports/<stamp>.html and latest.html; keep the newest REPORT_KEEP (default 30). */
export function writeReport(o: { run?: RunRow | null; threshold?: number } = {}): { file: string; latest: string; counts: ReportData['counts'] } {
  const r = buildReport(o)
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)
  const file = path.join(REPORTS_DIR, `is-radar-${stamp}.html`)
  fs.writeFileSync(file, r.html, 'utf8')
  const latest = path.join(REPORTS_DIR, 'latest.html')
  fs.writeFileSync(latest, r.html, 'utf8')
  const keep = Math.max(1, Number(env('REPORT_KEEP', '30')) || 30)
  const old = listReports().slice(keep)
  for (const x of old) fs.rmSync(path.join(REPORTS_DIR, x.name), { force: true })
  return { file, latest, counts: r.counts }
}

/** Saved reports, newest first (latest.html excluded). */
export function listReports(): Array<{ name: string; at: string; bytes: number }> {
  if (!fs.existsSync(REPORTS_DIR)) return []
  return fs
    .readdirSync(REPORTS_DIR)
    .filter((n) => /^is-radar-[\d-]+\.html$/.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(REPORTS_DIR, n))
      return { name: n, at: st.mtime.toISOString(), bytes: st.size }
    })
    .sort((a, b) => b.name.localeCompare(a.name))
}
