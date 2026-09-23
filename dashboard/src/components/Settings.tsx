import { DEFAULT_WEIGHTS, type ScoreWeights } from '@shared/scoring'
import { useEffect, useState } from 'react'
import { server, type ServerSettings } from '@/lib/platform'
import { Markdown } from './Markdown'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'

const WEIGHT_LABEL: Record<keyof ScoreWeights, string> = {
  remote: 'tam remote bonusu',
  hybrid_primary: 'birincil şehirde hibrit',
  hybrid_home: 'diğer şehirde hibrit',
  hybrid_other: 'başka şehirde hibrit',
  onsite_home_cap: 'tam ofis tavanı',
  onsite_primary: 'birincil şehirde ofis',
  onsite_home_cap_unless_fit: 'tavanı aşan uyum',
  onsite_other_cap: 'başka şehir ofis tavanı',
  unknown_country_cap: 'şekil yok, lokasyon ülke',
  unknown_city_cap: 'şekil yok, kabul edilen şehir',
  unknown_other_city_cap: 'şekil yok, başka şehir',
  under: 'kıdem altında',
  stretch: 'kıdem biraz üstünde',
  over: 'kıdem fazla üstünde',
  people_manager_cap: 'ekip yöneticiliği tavanı',
  english_spoken: 'günlük sözlü İngilizce',
  salary_below: 'maaş alt sınır altında',
  contract: 'sözleşmeli',
  part_time_cap: 'yarı zamanlı tavanı',
  internship_cap: 'staj tavanı',
  mismatch_cap: 'uyumsuz rol tavanı',
  agency: 'ajans üzerinden',
  shift: 'vardiya / nöbet',
  ai_usage: 'AI araçları bonusu',
}

type Props = { threshold: number; onThreshold: (n: number) => void; onToast: (text: string, kind?: 'info' | 'error') => void; busy: boolean; notify: boolean; onToggleNotify: () => void; onRadarSaved: () => Promise<void> }
const TIERS: Array<['core' | 'adjacent' | 'bridge' | 'mismatch', string, string]> = [
  ['core', 'Hedef roller', 'başlıkta geçerse core: en yüksek rol puanı'],
  ['adjacent', 'Yakın roller', 'adjacent: orta puan'],
  ['bridge', 'Köprü roller', 'bridge: düşük puan ama yine de okurum'],
  ['mismatch', 'Elenen roller', 'mismatch: başlık kapısında elerim, metnini çekmem'],
]
const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)

export function Settings(p: Props) {
  const [s, setS] = useState<ServerSettings | null>(null)
  const [yaml, setYaml] = useState('')
  const [thr, setThr] = useState(p.threshold)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [review, setReview] = useState<string | null>(null)
  const [cities, setCities] = useState('')
  const [hybrid, setHybrid] = useState(true)
  const [tRev, setTRev] = useState(35)
  const [tCand, setTCand] = useState(60)
  const [roles, setRoles] = useState<Record<string, string>>({ core: '', adjacent: '', bridge: '', mismatch: '' })
  const [radarSaving, setRadarSaving] = useState(false)
  const [weights, setWeights] = useState<ScoreWeights>({ ...DEFAULT_WEIGHTS })
  const [reviewBusy, setReviewBusy] = useState(false)
  const [crit, setCrit] = useState<string | null>(null)
  const [critBusy, setCritBusy] = useState(false)

  useEffect(() => {
    server.cvReview().then((r) => setReview(r.md)).catch(() => {})
    server.criteriaReview().then((r) => setCrit(r.md)).catch(() => {})
  }, [p.busy])
  useEffect(() => {
    server
      .getSettings()
      .then((x) => {
        setS(x)
        setYaml(x.searchesYaml)
        setThr(x.scoreThreshold)
        setCities(x.homeCities.join(', '))
        setHybrid(x.radar?.accept_hybrid ?? true)
        setTRev(x.thresholds?.review ?? 35)
        setTCand(x.thresholds?.candidate ?? 60)
        setWeights({ ...DEFAULT_WEIGHTS, ...(x.radar?.score_weights ?? {}) })
        setRoles({ core: (x.radar?.roles?.core ?? []).join(', '), adjacent: (x.radar?.roles?.adjacent ?? []).join(', '), bridge: (x.radar?.roles?.bridge ?? []).join(', '), mismatch: (x.radar?.roles?.mismatch ?? []).join(', ') })
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      await server.saveSettings({ searchesYaml: yaml, scoreThreshold: thr })
      p.onThreshold(thr)
      const fresh = await server.getSettings()
      setS(fresh)
      p.onToast(`Kaydettim · ${fresh.searchCount} arama, sonraki turda devreye girer`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  async function saveRadar() {
    setRadarSaving(true)
    setErr(null)
    try {
      await server.saveRadar({
        home_cities: splitList(cities),
        accept_hybrid: hybrid,
        thresholds: { review: tRev, candidate: tCand },
        roles: { core: splitList(roles.core), adjacent: splitList(roles.adjacent), bridge: splitList(roles.bridge), mismatch: splitList(roles.mismatch) },
        score_weights: weights,
      })
      const fresh = await server.getSettings()
      setS(fresh)
      setYaml(fresh.searchesYaml)
      await p.onRadarSaved()
      p.onToast('Radar ayarını kaydettim; ön elemeyi baştan hesapladım')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRadarSaving(false)
    }
  }

  async function startCriteria() {
    setCritBusy(true)
    try {
      await server.startCriteriaReview()
      p.onToast('Kriter incelemesine başladım; kararlarını okuyorum, bir iki dakika sürer. Bitince buraya koyarım.')
    } catch (e) {
      p.onToast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setCritBusy(false)
    }
  }

  async function startReview() {
    setReviewBusy(true)
    try {
      await server.startCvReview(15)
      p.onToast('CV incelemesine başladım; en iyi 15 ilanı okuyorum, birkaç dakika sürer. Bitince buraya koyarım.')
    } catch (e) {
      p.onToast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setReviewBusy(false)
    }
  }

  const info: Array<[string, string]> = s
    ? [
        ['Skorlama motoru', s.scorer],
        ['Birinci okuma', s.model],
        [`İkinci görüş (≥${s.topMinScore})`, s.modelTop || 'kapalı'],
        ['Şirket araştırması', s.researchMinScore > 0 ? `skor ≥ ${s.researchMinScore}` : 'kapalı'],
        ['Telegram', s.telegram ? `skor ≥ ${s.notifyMinScore}` : 'kapalı'],
        ['Zamanlayıcı', `her ${s.schedule.every_minutes} dk · ${String(s.schedule.active_hours[0]).padStart(2, '0')}–${String(s.schedule.active_hours[1]).padStart(2, '0')}`],
      ]
    : []

  return (
    <main className="page">
      <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Ayarlar</h1>
        <section className="card" style={{ padding: 20, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600 }}>“İyi ilan” eşiği</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>Bu skorun üstünü listede yeşil gösteririm; +10 üstü “güçlü”. Araştırma ve Telegram eşikleri .env’de.</div>
          </div>
          <input type="number" className="input mono" value={thr} min={0} max={100} onChange={(e) => setThr(Number(e.target.value))} style={{ width: 84, fontSize: 16, textAlign: 'center', borderColor: 'var(--line2)' }} />
        </section>
        <section className="card" style={{ padding: 20, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 16, alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Masaüstü bildirimi</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>Sekme arka plandayken eşiği geçen yeni bir ilan skorlarsam tarayıcıdan haber veririm. Sadece bu tarayıcıda çalışır.</div>
          </div>
          <Switch checked={p.notify} onCheckedChange={p.onToggleNotify} aria-label="Masaüstü bildirimi" />
        </section>
        <section className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600 }}>Radar: şehirler, roller, eşikler</div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>Kural motoru ve LLM prompt'u bunları kullanıyor. Kaydedince <span className="mono">searches.yaml</span>'daki <span className="mono">radar:</span> bloğuna yazarım, ön elemeyi de hemen baştan hesaplarım.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 14 }}>
            <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              <span className="eyebrow">Kabul edilen şehirler <span style={{ textTransform: 'none', letterSpacing: 0 }}>· ilki birincil</span></span>
              <input className="input" value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Ankara, İzmir, Manisa, Aydın" />
            </label>
            <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
              <span className="eyebrow">Kural eşikleri</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="muted">review ≥</span>
                <input className="input mono" type="number" min={5} max={85} value={tRev} onChange={(e) => setTRev(Number(e.target.value))} style={{ width: 64, textAlign: 'center' }} />
                <span className="muted">candidate ≥</span>
                <input className="input mono" type="number" min={15} max={95} value={tCand} onChange={(e) => setTCand(Number(e.target.value))} style={{ width: 64, textAlign: 'center' }} />
                <Label className="gap-2 text-[13px] font-normal text-muted-foreground" title="Hibrite açık mısın">
                  <Switch checked={hybrid} onCheckedChange={setHybrid} /> hibrit olur
                </Label>
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 14 }}>
            {TIERS.map(([k, label, hint]) => (
              <label key={k} style={{ display: 'grid', gap: 6, fontSize: 13 }}>
                <span className="eyebrow">{label}</span>
                <textarea className="textarea" rows={3} value={roles[k]} onChange={(e) => setRoles({ ...roles, [k]: e.target.value })} placeholder="boş = yerleşik sözlük; virgülle ayır" style={{ fontSize: 13, minHeight: 64 }} />
                <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>{hint}</span>
              </label>
            ))}
          </div>
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13.5, fontWeight: 600 }}>Skor ağırlıkları</summary>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '6px 0 10px' }}>
              Claude ilanın içeriğine 0-100 arası uyum puanı verir, bunlar onun üstüne eklenir ya da tavan koyar. Değiştirip kaydedince eski skorları
              Claude'a sormadan baştan hesaplarım. Varsayılana eşit olanları yaml'a yazmam.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '6px 14px' }}>
              {(Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoreWeights>).map((k) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12.5 }}>
                  <span style={{ color: weights[k] !== DEFAULT_WEIGHTS[k] ? 'var(--accent)' : 'var(--muted)' }}>{WEIGHT_LABEL[k]}</span>
                  <input className="input mono" type="number" value={weights[k]} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} style={{ width: 64, textAlign: 'center', padding: '3px 6px' }} />
                </label>
              ))}
            </div>
            <button className="link" style={{ fontSize: 12, marginTop: 8 }} onClick={() => setWeights({ ...DEFAULT_WEIGHTS })}>Varsayılana dön</button>
          </details>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button size="sm" onClick={saveRadar} disabled={radarSaving || !s}>{radarSaving ? 'Kaydediyorum…' : 'Radar ayarını kaydet'}</Button>
          </div>
        </section>
        <section className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 600 }}>Aramalar</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--dim)' }}>{s ? `${s.searchCount} arama · anahtar kelime × lokasyon` : '…'}</div>
          </div>
          <textarea className="textarea mono" value={yaml} onChange={(e) => setYaml(e.target.value)} spellCheck={false} style={{ minHeight: 320, marginTop: 12 }} />
          {err && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--red)' }}>{err}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <Button size="sm" onClick={save} disabled={saving || !s}>{saving ? 'Kaydediyorum…' : 'Kaydet'}</Button>
          </div>
        </section>
        <section className="card" style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          {info.map(([k, v]) => (
            <div key={k}>
              <div className="eyebrow">{k}</div>
              <div className="mono" style={{ marginTop: 6, fontSize: 14 }}>{v}</div>
            </div>
          ))}
          {!s && !err && <div style={{ fontSize: 13, color: 'var(--dim)' }}>yüklüyorum…</div>}
        </section>
        <section className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600 }}>Kriter incelemesi</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>Shortlist / yoksay / reddet kararlarını (ve sebeplerini) LLM skorlarıyla karşılaştırıp criteria.md ve about.md için somut değişiklik öneririm. En az 10 karar lazım.</div>
            </div>
            <Button variant="outline" size="sm" onClick={startCriteria} disabled={critBusy || p.busy}>{critBusy || p.busy ? <span className="spin" /> : null}{crit ? 'Yeniden incele' : 'İncele'}</Button>
          </div>
          {crit && (
            <div style={{ marginTop: 16 }}>
              <Markdown md={crit} size={14} />
            </div>
          )}
        </section>
        <section className="card" style={{ padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontWeight: 600 }}>CV incelemesi</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3 }}>En yüksek puanlı ilanlara toplu bakıp CV’nin seni nerede eksik sattığını söylerim. Uydurma tecrübe önermem; olanı yeniden konumlandırırım.</div>
            </div>
            <Button variant="outline" size="sm" onClick={startReview} disabled={reviewBusy || p.busy}>{reviewBusy || p.busy ? <span className="spin" /> : null}{review ? 'Yeniden incele' : 'İncele'}</Button>
          </div>
          {review && (
            <div style={{ marginTop: 16 }}>
              <Markdown md={review} size={14} />
            </div>
          )}
        </section>
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>Model, bütçe ve bildirim ayarları <span className="mono">.env</span> dosyasında; CV ve kriterler <span className="mono">profile/</span> altında. Değiştirince collector’ı yeniden başlat.</div>
      </div>
    </main>
  )
}
