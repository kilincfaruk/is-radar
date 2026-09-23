/**
 * Rule-based pre-screening. Deterministic, no API, runs instantly on every job
 * with a description. It implements the parts of the spec's elimination rules
 * that are regex-able (TR + EN): hybrid/on-site wording, title -> role type,
 * "X+ yıl" seniority, red flags, domain bonuses. The LLM pass is for what
 * survives; this never replaces it, it just removes the obvious rejects.
 */
import { ROLE_FIT_LABEL, SENIORITY_LABEL, type Job, type RoleFit, type SeniorityFit } from './types.ts'

export type PreVerdict = 'reject' | 'review' | 'candidate'
export type PreRemote = 'verified' | 'hybrid' | 'onsite' | 'unknown'
/** Where the workplace verdict came from: the ad text (verified) or only LinkedIn's label. */
export type PreRemoteSource = 'text' | 'label'
/** Bump when rules change so stored pre_json rows get recomputed by the collector. */
export const PRESCREEN_VERSION = 7

/**
 * Cities where hybrid/onsite is acceptable without relocating; the first one is the primary (highest bonus).
 * Single source of truth for the rule engine, the LLM prompts and the dashboard. Mutable on purpose:
 * configurePrescreen() (searches.yaml → radar.home_cities) replaces the contents in place.
 */
export const HOME_CITIES: string[] = ['Ankara', 'İzmir', 'Manisa', 'Aydın']
export type PreOptions = { homeCities: readonly string[]; acceptHybrid: boolean }
export const DEFAULT_PRE_OPTIONS: PreOptions = { homeCities: HOME_CITIES, acceptHybrid: true }

/** User-level tuning from searches.yaml (`radar:`). Everything optional; absent = built-in defaults. */
export type RadarConfig = {
  home_cities?: string[]
  accept_hybrid?: boolean
  /** Rule score cut-offs: below `review` = reject, below `candidate` = review. Tune from the calibration card. */
  thresholds?: { review?: number; candidate?: number }
  /** Title phrases per role tier. A non-empty list REPLACES the built-in dictionary for that tier. */
  roles?: { core?: string[]; adjacent?: string[]; bridge?: string[]; mismatch?: string[] }
  /** Overrides for the deterministic score weights (src/shared/scoring.ts DEFAULT_WEIGHTS). */
  score_weights?: Record<string, number>
}

/** Verdict cut-offs on the rule score (mutable via configurePrescreen). */
export const THRESHOLDS = { review: 35, candidate: 60 }
const DEFAULT_THRESHOLDS = { ...THRESHOLDS }
export function verdictFor(score: number, t: { review: number; candidate: number } = THRESHOLDS): PreVerdict {
  return score < t.review ? 'reject' : score < t.candidate ? 'review' : 'candidate'
}

/** "product owner" → /product\s*owner/ etc.; matched against the case-folded title. */
export function phrasesToRegex(phrases: string[]): RegExp {
  const alts = phrases
    .map((x) => fold(x).trim())
    .filter(Boolean)
    .map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
  return new RegExp(alts.length ? alts.join('|') : '(?!)', 'i')
}

/** Apply user config. Safe to call repeatedly (settings save); restores a tier's default when its list is emptied. */
export function configurePrescreen(cfg: RadarConfig | null | undefined): void {
  const cities = (cfg?.home_cities ?? []).map((c) => String(c).trim()).filter(Boolean)
  HOME_CITIES.splice(0, HOME_CITIES.length, ...(cities.length ? cities : DEFAULT_HOME_CITIES))
  DEFAULT_PRE_OPTIONS.acceptHybrid = cfg?.accept_hybrid ?? true
  const tr = Number(cfg?.thresholds?.review)
  const tc = Number(cfg?.thresholds?.candidate)
  THRESHOLDS.review = Number.isFinite(tr) && tr > 0 ? tr : DEFAULT_THRESHOLDS.review
  THRESHOLDS.candidate = Number.isFinite(tc) && tc > THRESHOLDS.review ? tc : Math.max(DEFAULT_THRESHOLDS.candidate, THRESHOLDS.review + 10)
  for (const tier of ['core', 'adjacent', 'bridge', 'mismatch'] as const) {
    const list = cfg?.roles?.[tier]
    ROLE[tier] = list && list.length ? phrasesToRegex(list) : DEFAULT_ROLE[tier]
  }
}
const DEFAULT_HOME_CITIES = [...HOME_CITIES]

export type PreScreen = {
  verdict: PreVerdict
  score: number
  remote: PreRemote
  remoteSource?: PreRemoteSource
  homeCity: boolean
  /** Which accepted city matched the location, when homeCity is true. */
  homeCityName?: string
  /** "haftada 2 gün ofis" etc. when the text spells the hybrid pattern out. */
  hybridDetail?: string
  /** Highest TL salary figure found in the text, if any. */
  salaryTl?: number
  role: RoleFit
  seniority: SeniorityFit | 'unknown'
  flags: string[]
  reasons: string[]
  bonuses: string[]
  v?: number
}

const RX1 = {
  // --- hybrid wording ---
  hybrid: [
    /haftada\s*\d+\s*(gün|gun)\s*(ofis|ofise|ofiste|ofisten|iş\s*yer)/i,
    /\d+\s*(gün|gun)\s*ofis/i,
    /(\d+|bir|iki|üç|uc)\s*(day|days)\s*(a|per)?\s*week\s*(in|at|from)\s*(the\s*)?office/i,
    /\d+\s*days?\s*(in|at|from)\s*(the\s*)?office/i,
    /\bhibrit\b|\bhybrid\b|\bhibrid\b/i,
    /gerektiğinde\s*ofis|zaman\s*zaman\s*ofis|belirli\s*günler(de)?\s*ofis|ofise\s*gelme/i,
  ],
  // --- office-only wording ---
  onsite: [
    /\bon-?site\b|\bin-?office\b|\boffice-?based\b/i,
    /iş\s*yerinde|işyerinde|ofisten\s*çalış|ofiste\s*çalış|ofis\s*ortamında|\bofisten\b|\bofiste\b|\bofis\s*(çalışma|çalışması)\b/i,
    /ofise\s*(yakın|gelebil|ulaşabil|gidebil)|ofis\s*(içi|bazlı)/i,
    /(istanbul|ankara|izmir|bursa|kocaeli|antalya)['’]?(da|de)\s*(ikamet|yaşayan|oturan)/i,
    /relocat/i,
  ],
  notRemote: [
    /haftada\s*\d+\s*(gün|gun)\s*(ofis|ofise|ofiste|ofisten|iş\s*yer)/i,
    /\d+\s*(gün|gun)\s*ofis/i,
    /(\d+|bir|iki|üç|uc)\s*(day|days)\s*(a|per)?\s*week\s*(in|at|from)\s*(the\s*)?office/i,
    /\d+\s*days?\s*(in|at|from)\s*(the\s*)?office/i,
    /\bhibrit\b|\bhybrid\b|\bhibrid\b/i,
    /\bon-?site\b|\bin-?office\b|\boffice-?based\b/i,
    /iş\s*yerinde|işyerinde|ofisten\s*çalış|ofiste\s*çalış|ofis\s*ortamında|\bofisten\b|\bofiste\b|\bofis\s*(çalışma|çalışması)\b/i,
    /ofise\s*(yakın|gelebil|ulaşabil|gidebil)|ofis\s*(içi|bazlı)/i,
    /(istanbul|ankara|izmir|bursa|kocaeli|antalya)['’]?(da|de)\s*(ikamet|yaşayan|oturan)/i,
    /gerektiğinde\s*ofis|zaman\s*zaman\s*ofis|belirli\s*günler(de)?\s*ofis|ofise\s*gelme/i,
    /relocat/i,
  ],
  // --- remote positives (only counts if no negative) ---
  remote: [
    /tamamen\s*uzaktan|tam\s*(zamanlı\s*)?uzaktan|%\s*100\s*uzaktan|100\s*%\s*uzaktan/i,
    /full(y)?[\s-]*remote|100\s*%\s*remote|remote[\s-]*first|remote[\s-]*only|work\s*from\s*anywhere/i,
    /türkiye['’]?nin\s*her\s*yerinden|türkiye\s*geneli(nden)?\s*(uzaktan|remote)?/i,
    /uzaktan\s*çalış(ma|abilir)|remote\s*çalış/i,
    /\bremote\b/i,
    /\buzaktan\b/i,
  ],
  // --- title -> role ---
}

const DEFAULT_ROLE = {
  mismatch:
    /technical\s*support|teknik\s*destek|destek\s*(uzman|mühendis|temsilci)|support\s*(engineer|specialist|representative|agent)|call\s*cent(er|re)|çağrı\s*merkezi|müşteri\s*temsilci|customer\s*(support|service|care)|müşteri\s*(hizmet|destek)|help\s*desk|helpdesk|service\s*desk|saha\s*(destek|servis)|field\s*(support|service)|\bsatış\b|\bsales\b|account\s*executive|yazılım\s*(geliştirici|mühendisi|uzmanı)|software\s*(developer|engineer)|\bdeveloper\b|\bdevops\b|data\s*engineer|veri\s*mühendisi|sistem\s*(yöneticisi|uzmanı)|system\s*admin|network|ağ\s*uzman|siber|security|güvenlik|\bit\s*(support|destek|specialist|uzman)/i,
  adjacent:
    /proje\s*(yöneticisi|sorumlusu|uzmanı|koordinatörü|lideri)|project\s*(manager|coordinator|specialist|lead)|technical\s*business\s*analyst|teknik\s*iş\s*analisti|solution(s)?\s*(consultant|specialist)|çözüm\s*(danışman|uzman)|implementation\s*(consultant|specialist|manager)|uygulama\s*danışman|product\s*support\s*analyst|sistem\s*analisti|system(s)?\s*analyst|proje\s*analisti|project\s*analyst|erp\s*(analyst|analisti|danışman|consultant)|sap\s*(analyst|analisti|danışman|consultant)|functional\s*(analyst|consultant)|pre-?sales\s*(consultant|specialist|analyst|danışman)|satış\s*öncesi\s*(danışman|uzman)|customer\s*success|müşteri\s*başarı/i,
  core:
    /business\s*analyst|iş\s*analisti|is\s*analisti|iş\s*analiz|product\s*owner|ürün\s*sahibi|product\s*manager|ürün\s*yöneticisi|ürün\s*müdürü|product\s*analyst|ürün\s*analisti|product\s*specialist|ürün\s*uzmanı|business\s*process\s*(analyst|analisti|uzman)|iş\s*süreç(leri)?\s*(analisti|uzmanı)|requirements?\s*(analyst|engineer)/i,
  bridge: /\bqa\b|quality\s*assurance|test\s*(engineer|uzman|mühendis|analyst|analisti|automation|specialist)|\btester\b|data\s*analyst|veri\s*analisti|bi\s*analyst|business\s*intelligence|raporlama|reporting\s*analyst|operations?\s*analyst|operasyon\s*analisti|analyst|analisti|uzman|specialist|koordinatör|coordinator/i,
}
/** Live role dictionaries (see configurePrescreen). */
const ROLE: { core: RegExp; adjacent: RegExp; bridge: RegExp; mismatch: RegExp } = { ...DEFAULT_ROLE }

const RX2 = {
  // hidden support: support-heavy description under an analyst title
  supportWords: /\bticket|çağrı|destek\s*talebi|support\s*request|\bsla\b|vardiya|nöbet|escalat|eskalasyon|helpdesk|help\s*desk|arıza|incident|l1\b|l2\b|1\.\s*seviye|2\.\s*seviye|first[\s-]*line|second[\s-]*line/gi,
  analystWords: /gereksinim|requirement|backlog|user\s*stor|roadmap|paydaş|stakeholder|\bprd\b|analiz|analysis|süreç\s*(tasarım|iyileştir)|process\s*(design|improvement)|ürün\s*(ekibi|yönetimi)|product\s*team|sprint|prioriti|öncelik/gi,
  // --- seniority ---
  years: /(\d{1,2})\s*(\+|artı)?\s*(?:-|–|to|ila|ve)?\s*(\d{1,2})?\s*\+?\s*(yıl|yil|years?|yrs?)/gi,
  yearsCtx: /en\s*az|minimum|min\.?|at\s*least|tecrübe|deneyim|experience|\+/i,
  intern: /stajyer|intern(ship)?|yeni\s*mezun|new\s*grad/i,
  junior: /stajyer|intern(ship)?|yeni\s*mezun|new\s*grad|entry[\s-]*level|junior|başlangıç\s*seviye/i,
  managerial: /team\s*lead|tech\s*lead|chapter\s*lead|\bhead\b|director|direktör|\bmüdür|group\s*manager|ekip\s*(kur|yönet|lider)|manage\s*a\s*team|people\s*management|yönetici(lik)?\s*(deneyim|tecrübe)|\bvp\b|chief|c-level/i,
  /** Product Manager / Ürün Müdürü is the core role, not people management, whatever "müdür" says. */
  pmTitle: /product\s*manager|ürün\s*(yöneticisi|müdürü)/i,
  // --- red flags ---
  shift: /vardiya|\bshift\b|7\s*\/\s*24|24\s*\/\s*7|24x7|nöbet|on-?call|gece\s*çalışma/i,
  agency: /outsourc|danışmanlık\s*(firması|şirketi)\s*(bünyesinde|üzerinden|olarak)|bordro(lu|su)|ajans|staffing|recruitment\s*agency|müşterimiz\s*(için|adına)|for\s*our\s*client|on\s*behalf\s*of\s*our\s*client|client\s*site|müşteri\s*lokasyon/i,
  flexHours: /esnek\s*çalışma\s*saat|flexible\s*(working\s*)?hours/i,
  englishHard:
    /(ileri|çok\s*iyi|advanced|fluent|akıcı|native|profesyonel|business|c1|c2|upper[\s-]*intermediate)\s*(düzey(de)?|seviye(de)?|level)?\s*(de\s*)?(ingilizce|english)|(ingilizce|english)\s*(bilgisi\s*)?(ileri|çok\s*iyi|akıcı|fluent|advanced|c1|c2)|english\s*(is\s*)?(a\s*)?must|working\s*language\s*(is\s*)?english|iş\s*dili\s*ingilizce|fluency\s*in\s*english|excellent\s*(command\s*of\s*)?english|international\s*(team|clients?|customers?|stakeholders?)|global\s*(team|clients?|customers?)|yurt\s*dışı(ndaki)?\s*(ekip|müşteri|paydaş)/i,
  cultureHype: /dinamik\s*(ekip|takım)|genç\s*(ve\s*)?(dinamik|enerjik)|aile\s*(ortamı|gibi)|like\s*a\s*family|work\s*hard\s*play\s*hard|rock\s*?star|ninja|hustle/i,
  salary: /maaş|salary|ücret|brüt|net\s*\d|₺|\btl\b|\$|€|eur\b|usd\b|compensation|yan\s*hak/i,
  multiRole: /(hem\s+.+\s+hem\s+.+\s+hem)|(\/\s*[a-zçğıöşü]+\s*\/\s*[a-zçğıöşü]+\s*\/)/i,
  partTime: /yarı\s*zamanlı|part[\s-]*time|\bfreelance\b|serbest\s*çalışan|saatlik\s*ücret/i,
  contract: /sözleşmeli|belirli\s*süreli|\bcontractor\b|contract\s*(basis|role|position)|fixed[\s-]*term|proje\s*bazlı/i,
  ai: /yapay\s*zek[aâ]|\bai\b|\bllm\b|chatgpt|copilot|\bclaude\b|\bgpt|generative|üretken\s*yapay/i,
  hybridDetail: [
    /haftada\s*(\d|bir|iki|üç|dört)\s*(gün|gun)\s*(ofis(te|ten|e)?|iş\s*yerinde|evden|uzaktan)/i,
    /(\d|bir|iki|üç|dört)\s*(gün|gun)\s*(ofis(te|ten|e)?|iş\s*yerinde)/i,
    /(\d|one|two|three|four)\s*days?\s*(a|per)?\s*week\s*(in|at|from)\s*(the\s*)?office/i,
    /(\d|one|two|three|four)\s*days?\s*(in|at|from)\s*(the\s*)?office/i,
    /(iki|2)\s*haftada\s*(bir|1)\s*(gün)?\s*(ofis)?/i,
    /ayda\s*(\d|bir|iki|üç|dört)\s*(gün|kez|defa)\s*(ofis)?/i,
    /(\d)\s*\/\s*(\d)\s*(ofis|remote|uzaktan|hibrit)/i,
  ],
  // --- bonuses ---
  bonus: [
    { rx: /\bb2b\b/i, label: 'B2B' },
    { rx: /\bsaas\b/i, label: 'SaaS' },
    { rx: /call\s*cent(er|re)\s*(yazılım|teknoloji|platform|software|solution)|contact\s*cent(er|re)|çağrı\s*merkezi\s*(yazılım|teknoloji|çözüm)|\bccaas\b|\bivr\b/i, label: 'call center teknolojisi' },
    { rx: /enerji\s*(sektör|şirket|dağıtım|piyasa|santral)|energy\s*(sector|company|industry|market|utility|utilities)|elektrik\s*(dağıtım|perakende|üretim)|\bedaş\b|\butilit(y|ies)\s*(company|sector|industry)|\boms\b|\bwfm\b|scada|akıllı\s*sayaç|smart\s*meter|doğalgaz\s*dağıtım/i, label: 'enerji/utility' },
    { rx: /\bjira\b/i, label: 'Jira' },
    { rx: /\bfigma\b/i, label: 'Figma' },
    { rx: /\bsql\b|postgres|bigquery/i, label: 'SQL' },
    { rx: /confluence/i, label: 'Confluence' },
  ],
}
const RX = { ...RX1, ...RX2 }

/** Turkish-safe case folding: JS /i cannot match "İstanbul" against "istanbul". */
export function fold(s: string): string {
  return (s || '').replace(/İ/g, 'i').replace(/I/g, 'i').toLowerCase()
}

function count(rx: RegExp, s: string): number {
  const m = s.match(rx)
  return m ? m.length : 0
}

function turkishRatio(s: string): number {
  const tr = (s.match(/[çğıöşüÇĞİÖŞÜ]/g) || []).length
  const letters = (s.match(/[a-zA-ZçğıöşüÇĞİÖŞÜ]/g) || []).length
  return letters === 0 ? 0 : tr / letters
}

/**
 * Title gate: decides from the title alone whether an ad is worth fetching text for.
 * LinkedIn's guest search is keyword-loose ("business analyst" in Ankara returns
 * sales, SEO, purchasing…). Returns null = fetch, or a short reason to skip.
 */
export function titleGate(titleIn: string): string | null {
  const t = fold(titleIn)
  if (!t) return null
  // "Bangkok-based", "Dubai-based": the job sits abroad whatever the LinkedIn location says
  if (/\b(?!(ankara|izmir|manisa|aydın|istanbul|türkiye|turkey|remote|home|tr)-)[a-zçğıöşü]+-based\b/.test(t)) return 'başlık: yurt dışı lokasyon'
  if (/\b(bangkok|dubai|riyadh|riyad|doha|cairo|kahire|berlin|london|londra|amsterdam|paris|warsaw|varşova|bucharest|bükreş|singapore|singapur)\b/.test(t)) return 'başlık: yurt dışı lokasyon'
  // always keep the target roles, whatever else the title says
  if (ROLE.core.test(t) || ROLE.adjacent.test(t)) {
    if (RX.managerial.test(t) && !RX.pmTitle.test(t)) return 'başlık yöneticilik'
    if (RX.intern.test(t)) return 'başlık stajyer/yeni mezun'
    // "product" titles that are really sales reps: pharma/medical product specialists, machinery/automotive product managers
    const salesDomain = /tıbbi|medikal|medical|onkoloji|oncolog|cerrahi|surgical|ilaç|pharma|road\s*machinery|iş\s*makine|otomotiv|automotive|tanıtım/i
    if (salesDomain.test(t)) return 'başlık: ' + (t.match(salesDomain)?.[0] ?? 'satış temsilcisi alanı')
    // adjacent role in an unrelated functional domain (SAP Payroll consultant, ERP Finance consultant, insurance underwriter)
    const domain = /payroll|bordro|\bhcm\b|\bhr\b|insan\s*kaynak|finance|finans|muhasebe|accounting|\btax\b|vergi|underwrit|sigorta|insurance|treasury|hazine|üretim|manufactur|inşaat|construction|şantiye|elektrik|mekanik|mechanical|electrical|altyapı|infrastructure|enerji\s*santral|\bges\b|\bres\b/i
    if (!ROLE.core.test(t) && domain.test(t)) return 'başlık: ' + (t.match(domain)?.[0] ?? 'alakasız alan')
    return null
  }
  if (ROLE.mismatch.test(t)) return 'başlık: ' + (t.match(ROLE.mismatch)?.[0] ?? 'alakasız rol')
  if (RX.managerial.test(t)) return 'başlık yöneticilik'
  if (RX.intern.test(t)) return 'başlık stajyer/yeni mezun'
  const junk =
    /mühendis|engineer|muhasebe|accountant|finans|finance|hukuk|legal|avukat|insan\s*kaynak|\bhr\b|recruit|pazarlama|marketing|\bseo\b|sosyal\s*medya|grafik|tasarım|designer|operatör|operator|şoför|driver|depo|warehouse|satın\s*alma|purchasing|procurement|lojistik|logistic|supply\s*chain|tedarik|ihracat|export|ithalat|import|mağaza|store|kasiyer|garson|aşçı|temizlik|güvenlik|security|hemşire|doktor|eczac|öğretmen|teacher|editör|editor|yazar|writer|çevirmen|translator|part[\s-]*time|lisansüstü|doktora|phd|research\s*assistant|araştırma\s*görevlisi|elektrik|mekanik|inşaat|civil|\bmimar(ı|i)?\b|architect\b(?!ure)|makine|database|\bdba\b|administrator|kimya|physics|fizik|biyolog|scientist|veeva|clinical|medical\s*device|sales|satış|account\s*manager|business\s*development|customer\s*development|iş\s*geliştirme|customer\s*success|müşteri\s*başarı|çağrı|call\s*cent|müşteri\s*temsilci|destek|fp&a|\behs\b|\bhse\b|\bisg\b|financial|finansal|credit|kredi|\brisk\b|fraud|audit|denetim|\btax\b|vergi|kalite|quality|trainer|eğitmen|annotat|freelance|catalog|katalog|e-?commerce|e-?ticaret|content|içerik|copywrit|brand|marka|category|kategori|merchandis|revenue|pricing|fiyatlandırma|treasury|hazine|payroll|bordro|compliance|\bkyc\b|\baml\b|idari\s*işler|administrative|inventory|envanter|\bstok\b|underwrit|patient|hasta|\btekniker|yarı\s*zamanlı|tıbbi|medikal|medical|onkoloji|oncolog|cerrahi|surgical|ilaç|pharma|tanıtım\s*(sorumlusu|uzmanı|temsilcisi)|road\s*machinery|iş\s*makine|\babap\b|geliştirme\s*uzmanı|teşvik|sourcing|ceo\s*office|trade\s*operations/i
  const m = t.match(junk)
  if (m) return 'başlık: ' + m[0]
  // not a target role and not obviously junk: fetch only if the title smells like analysis / product / process work
  const plausible =
    /analyst|analisti|analiz|product|ürün|süreç|process|raporlama|reporting|requirement|gereksinim|scrum|agile|çevik|proje\s*(analist|uzman)|project\s*(analyst|specialist)|sistem|system|bilgi\s*(sistem|işlem)|transformation|dönüşüm|business\s*(system|process|intelligence|analy)|\bbi\b|\bdata\b|\bveri\b|\bcrm\b|\berp\b|\bsap\b|owner|sahibi|improvement|iyileştirme/i
  if (!plausible.test(t)) return 'başlık hedef dışı'
  return null
}

/** True when the title explicitly hits a core / adjacent / bridge phrase (detectRole falls back to 'bridge' for anything). */
export function titleInRoleFamily(titleIn: string): boolean {
  const t = fold(titleIn)
  if (ROLE.mismatch.test(t) && !ROLE.core.test(t)) return false
  return ROLE.core.test(t) || ROLE.adjacent.test(t) || ROLE.bridge.test(t)
}

export function detectRole(titleIn: string, descriptionIn: string): { role: RoleFit; hiddenSupport: boolean } {
  const t = fold(titleIn)
  const description = fold(descriptionIn)
  let role: RoleFit
  if (ROLE.core.test(t) && !/technical\s*business\s*analyst|teknik\s*iş\s*analisti/i.test(t)) role = 'core'
  else if (ROLE.adjacent.test(t)) role = 'adjacent'
  else if (ROLE.mismatch.test(t)) role = 'mismatch'
  else if (ROLE.bridge.test(t)) role = 'bridge'
  else role = 'bridge'
  // "Business Analyst" title, ticket-resolving job
  let hiddenSupport = false
  if (role === 'core' || role === 'adjacent') {
    const sup = count(RX.supportWords, description)
    const ana = count(RX.analystWords, description)
    if (sup >= 4 && sup >= ana * 1.5) {
      hiddenSupport = true
      role = 'bridge'
    }
  }
  return { role, hiddenSupport }
}

export function detectRemote(description: string, workplaceType: Job['workplaceType']): { remote: PreRemote; source: PreRemoteSource | null; reason: string | null } {
  const d = fold(description)
  for (const rx of RX.hybrid) {
    const m = d.match(rx)
    if (m) return { remote: 'hybrid', source: 'text', reason: `metinde "${m[0].trim().slice(0, 40)}"` }
  }
  for (const rx of RX.onsite) {
    const m = d.match(rx)
    if (m) return { remote: 'onsite', source: 'text', reason: `metinde "${m[0].trim().slice(0, 40)}"` }
  }
  for (const rx of RX.remote) {
    const m = d.match(rx)
    if (m) return { remote: 'verified', source: 'text', reason: `metinde "${m[0].trim().slice(0, 40)}"` }
  }
  if (workplaceType === 'hybrid') return { remote: 'hybrid', source: 'label', reason: 'LinkedIn etiketi hibrit, metin sessiz' }
  if (workplaceType === 'onsite') return { remote: 'onsite', source: 'label', reason: 'LinkedIn etiketi ofis, metin sessiz' }
  return { remote: 'unknown', source: null, reason: null }
}

/** Returns the accepted city found in the location, or null. */
export function matchHomeCity(location: string | null | undefined, homeCities: readonly string[]): string | null {
  if (!location) return null
  const loc = fold(location)
  for (const c of homeCities) if (loc.includes(fold(c))) return c
  return null
}

/** "Türkiye" / "Turkey" / empty: no city at all — on LinkedIn that usually means a country-wide (remote) posting. */
export function isCountryOnly(location: string | null | undefined): boolean {
  if (!location) return true
  const l = fold(location).replace(/[.\s]+$/, '')
  return /^(türkiye|turkiye|turkey|tr)$/.test(l)
}

export function isHomeCity(location: string | null | undefined, homeCities: readonly string[] | string): boolean {
  return matchHomeCity(location, typeof homeCities === 'string' ? [homeCities] : homeCities) !== null
}

/** Salary figures in TL; returns the highest amount found (in TL) and the matched text. USD/EUR figures are ignored. */
export function detectSalary(descriptionIn: string): { maxTl: number | null; text: string | null } {
  const d = fold(descriptionIn)
  let maxTl: number | null = null
  let text: string | null = null
  const salaryCtx = /maaş|ücret|salary|brüt|\bnet\b|compensation|pay\b|kazanç|gelir/
  // amount followed by a TL marker, or a "k/bin" figure that sits next to salary wording (so "50k+ kullanıcı" is not a salary)
  const rxs: Array<{ rx: RegExp; needCtx: boolean }> = [
    { rx: /(\d{2,3})[.,](\d{3})\s*(?:tl\b|₺|try\b)/g, needCtx: false },
    { rx: /(\d{2,3})\s*(?:k|bin)\s*(?:tl\b|₺|try\b)/g, needCtx: false },
    { rx: /(?:tl|₺)\s*(\d{2,3})[.,](\d{3})/g, needCtx: false },
    { rx: /(\d{2,3})\s*(?:k|bin)\b/g, needCtx: true },
    { rx: /(\d{2,3})[.,](\d{3})\b/g, needCtx: true },
  ]
  for (const { rx, needCtx } of rxs) {
    let m: RegExpExecArray | null
    while ((m = rx.exec(d))) {
      if (needCtx && !salaryCtx.test(d.slice(Math.max(0, m.index - 60), m.index + m[0].length + 20))) continue
      const n = m[2] ? parseInt(m[1] + m[2], 10) : parseInt(m[1], 10) * 1000
      if (!Number.isFinite(n) || n < 15_000 || n > 1_000_000) continue
      if (maxTl === null || n > maxTl) {
        maxTl = n
        text = m[0].trim()
      }
    }
  }
  return { maxTl, text }
}

/** "haftada 2 gün ofis", "3 days in office", "2 haftada bir" — the hybrid arrangement when the ad spells it out. */
export function detectHybridDetail(descriptionIn: string): string | null {
  const d = fold(descriptionIn)
  for (const rx of RX.hybridDetail) {
    const m = d.match(rx)
    if (m) return m[0].trim().replace(/\s+/g, ' ').slice(0, 40)
  }
  return null
}

export function detectSeniority(titleIn: string, descriptionIn: string): { seniority: SeniorityFit | 'unknown'; years: number | null; reason: string | null } {
  const t = fold(titleIn)
  const d = fold(descriptionIn)
  if (RX.managerial.test(t) && !RX.pmTitle.test(t)) return { seniority: 'over', years: null, reason: `başlık yöneticilik: "${t.match(RX.managerial)?.[0]}"` }
  if (RX.junior.test(t)) return { seniority: 'under', years: null, reason: 'başlık stajyer/junior' }
  let maxMin: number | null = null
  let ctxHit: string | null = null
  const rx = new RegExp(RX.years.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = rx.exec(d))) {
    const around = d.slice(Math.max(0, m.index - 30), m.index + m[0].length + 15)
    if (!RX.yearsCtx.test(around)) continue
    let n = parseInt(m[1], 10)
    if (!Number.isFinite(n) || n > 20) continue
    // "0-2 yıl" / "0–2 years": a range starting at zero is not an intern ad, judge by its upper bound
    const upper = m[3] ? parseInt(m[3], 10) : NaN
    if (n === 0 && Number.isFinite(upper) && upper > 0) n = upper
    if (maxMin === null || n > maxMin) {
      maxMin = n
      ctxHit = m[0].trim()
    }
  }
  if (maxMin === null) {
    if (/\bsenior\b|kıdemli|\bsr\.?\b/i.test(t)) return { seniority: 'stretch', years: null, reason: 'başlık senior, yıl belirtilmemiş' }
    if (RX.junior.test(d)) return { seniority: 'under', years: null, reason: 'metin stajyer/yeni mezun' }
    return { seniority: 'unknown', years: null, reason: null }
  }
  const seniority: SeniorityFit = maxMin <= 0 ? 'under' : maxMin <= 4 ? 'match' : maxMin <= 7 ? 'stretch' : 'over'
  return { seniority, years: maxMin, reason: `en az ${maxMin} yıl ("${ctxHit}")` }
}

export function prescreen(job: Pick<Job, 'title' | 'descriptionMd' | 'workplaceType'> & { location?: string | null }, opts: PreOptions = DEFAULT_PRE_OPTIONS): PreScreen | null {
  const rawDesc = (job.descriptionMd || '').trim()
  if (rawDesc.length < 40) return null
  const desc = fold(rawDesc)
  const title = fold(job.title || '')
  const flags: string[] = []
  const reasons: string[] = []
  const bonuses: string[] = []
  let score = 50

  const homeCityName = matchHomeCity(job.location, opts.homeCities)
  const home = homeCityName !== null
  const rem = detectRemote(desc, job.workplaceType)
  const remLabel = rem.remote === 'verified' ? 'remote' : rem.remote === 'hybrid' ? 'hibrit' : rem.remote === 'onsite' ? 'ofis' : 'belirsiz'
  if (rem.reason) reasons.push(`çalışma şekli ${remLabel}: ${rem.reason}`)
  if (rem.remote === 'hybrid' || rem.remote === 'onsite') reasons.push(home ? `${homeCityName} lokasyonu (kabul edilen şehir)` : `kabul edilen şehirler dışı (${job.location ?? 'lokasyon yok'})`)

  const { role, hiddenSupport } = detectRole(title, desc)
  if (hiddenSupport) flags.push('gizli support rolü')
  reasons.push(`rol: ${ROLE_FIT_LABEL[role]} (başlıktan)`)
  if (role === 'core') score += 25
  else if (role === 'adjacent') score += 10
  else if (role === 'bridge') score += 0

  const sen = detectSeniority(title, desc)
  if (sen.reason) reasons.push(`kıdem: ${sen.seniority === 'unknown' ? 'belirsiz' : SENIORITY_LABEL[sen.seniority]}, ${sen.reason}`)
  if (sen.seniority === 'match') score += 10
  else if (sen.seniority === 'stretch') score -= 10
  else if (sen.seniority === 'under') score -= 5
  else if (sen.seniority === 'over') score -= 20 // "denenir": senior asks cost points, they are not an elimination

  if (RX.shift.test(desc)) flags.push('vardiya/nöbet')
  if (RX.agency.test(desc)) flags.push('ajans/danışmanlık üzerinden')
  if (RX.flexHours.test(desc) && rem.remote !== 'verified') flags.push('"esnek saat" ≠ remote')
  if (RX.englishHard.test(desc + ' ' + title)) flags.push('günlük/sözlü İngilizce olabilir')
  else if (turkishRatio(desc) < 0.01 && desc.length > 300) reasons.push('ilan İngilizce yazılmış (ceza yok; LLM müşteri/iş diline bakar)')
  if (RX.cultureHype.test(desc) && !RX.salary.test(desc)) flags.push('kültür dili, maaş yok')
  if (RX.partTime.test(desc + ' ' + title)) flags.push('yarı zamanlı / freelance')
  if (RX.contract.test(desc + ' ' + title)) flags.push('sözleşmeli')
  score -= flags.filter((f) => !['günlük/sözlü İngilizce olabilir', 'sözleşmeli', 'yarı zamanlı / freelance'].includes(f)).length * 10
  if (flags.includes('günlük/sözlü İngilizce olabilir')) score -= 5
  if (flags.includes('sözleşmeli')) score -= 5

  for (const b of RX.bonus) if (b.rx.test(desc)) bonuses.push(b.label)
  if (RX.multiRole.test(title)) bonuses.push('geniş rol') // BA + proje + test karışımı: tercih, ceza değil
  if (RX.ai.test(desc)) bonuses.push('AI kullanımı')
  const salary = detectSalary(desc)
  if (salary.maxTl !== null) {
    if (salary.maxTl < 90_000) {
      flags.push(`maaş 90k altı (${salary.text})`)
      score -= 15
    } else bonuses.push(`maaş yazılı ${Math.round(salary.maxTl / 1000)}k`)
  }
  score += Math.min(20, bonuses.length * 5)

  const hybridDetail = rem.remote === 'hybrid' ? detectHybridDetail(desc) : null
  if (hybridDetail) reasons.push(`hibrit düzeni: "${hybridDetail}"`)

  // workplace rules (v3.2): remote first (+10); hybrid in an accepted city next (Ankara +5, others +3);
  // office in an accepted city is tolerated (0), elsewhere = relocation / out
  const primary = fold(homeCityName ?? '') === fold(opts.homeCities[0] ?? '')
  if (rem.remote === 'verified') {
    // remote is the first preference, but it does not rescue shift work or agency payroll
    if (!flags.some((f) => /vardiya|ajans/.test(f))) {
      score += 10
      bonuses.push('tam remote (birinci tercih)')
    }
  } else if (rem.remote === 'hybrid') {
    if (!opts.acceptHybrid) score = Math.min(score, 25)
    else if (home) score += primary ? 5 : 3
    else {
      score -= 15
      score = Math.min(score, 60)
    }
  } else if (rem.remote === 'onsite') {
    if (home) score += 0
    else score = Math.min(score, 25)
  } else if (rem.remote === 'unknown') {
    // text silent. A real label (extension DOM) stands in with a mild cap; the guest collector has NO label
    // (its search filter is ignored by LinkedIn), so only the location gives a hint.
    if (job.workplaceType === 'remote' || (job.workplaceType === 'hybrid' && home)) score = Math.min(score, 70)
    else if (job.workplaceType === 'hybrid') score = Math.min(score - 10, 60)
    else if (job.workplaceType === 'onsite') score = Math.min(score, home ? 55 : 45)
    else if (isCountryOnly(job.location)) {
      score = Math.min(score, 65)
      reasons.push('çalışma şekli metinde yok; lokasyon şehirsiz (Türkiye geneli), muhtemelen remote')
    } else if (home) {
      // stays "bak": a city location with silent text is usually office/hybrid, worth a look but not a candidate yet
      score = Math.min(score, 58)
      reasons.push(`çalışma şekli metinde yok; lokasyon ${homeCityName}, ofis/hibrit olabilir`)
    } else {
      score = Math.min(score, 50)
      reasons.push(`çalışma şekli metinde yok; lokasyon ${job.location} (kabul edilen şehir dışı)`)
    }
  }
  if (flags.includes('yarı zamanlı / freelance')) score = Math.min(score, 25)
  if (RX.managerial.test(title) && !RX.pmTitle.test(title)) score = Math.min(score, 40)
  if (role === 'mismatch') score = Math.min(score, 30)
  // rows whose text was fetched before the title gate got stricter: same rule, applied late
  const gate = titleGate(job.title || '')
  if (gate) {
    flags.push('başlık kapısı: ' + gate)
    score = Math.min(score, 25)
  }
  score = Math.max(0, Math.min(100, Math.round(score)))

  const verdict: PreVerdict = verdictFor(score)
  return { verdict, score, remote: rem.remote, remoteSource: rem.source ?? undefined, homeCity: home, homeCityName: homeCityName ?? undefined, hybridDetail: hybridDetail ?? undefined, salaryTl: salary.maxTl ?? undefined, role, seniority: sen.seniority, flags, reasons, bonuses, v: PRESCREEN_VERSION }
}
