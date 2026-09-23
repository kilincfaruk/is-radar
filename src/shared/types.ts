export type WorkplaceType = 'remote' | 'hybrid' | 'onsite' | 'unknown'
export type SeniorityFit = 'under' | 'match' | 'stretch' | 'over'
export type RoleFit = 'core' | 'adjacent' | 'bridge' | 'mismatch'
export type JobStatus = 'new' | 'shortlist' | 'applied' | 'interviewing' | 'rejected' | 'ignored'

export const JOB_STATUSES: JobStatus[] = ['new', 'shortlist', 'applied', 'interviewing', 'rejected', 'ignored']
export const ROLE_FITS: RoleFit[] = ['core', 'adjacent', 'bridge', 'mismatch']
export const SENIORITY_FITS: SeniorityFit[] = ['under', 'match', 'stretch', 'over']

export const ROLE_FIT_LABEL: Record<RoleFit, string> = { core: 'hedef rol', adjacent: 'yakın rol', bridge: 'köprü rol', mismatch: 'uyumsuz' }
export const SENIORITY_LABEL: Record<SeniorityFit, string> = { under: 'junior', match: 'uygun', stretch: 'biraz üstü', over: 'çok üstü' }
export const ROLE_FIT_HINT: Record<RoleFit, string> = {
  core: 'Business Analyst, Product Owner, Product Manager, Product Analyst',
  adjacent: 'Technical BA, Solution/Implementation Consultant, Sistem Analisti',
  bridge: 'analiz/ürün sorumluluğu var ama ağırlık destek',
  mismatch: 'saf support, çağrı merkezi, satış, QA, dev vb.',
}
export const SENIORITY_HINT: Record<SeniorityFit, string> = { under: 'stajyer / yeni mezun', match: '1-4 yıl', stretch: '5-7 yıl (başvurulabilir)', over: '8+ yıl / yöneticilik' }

export type Job = {
  linkedinJobId: string
  url: string
  title: string
  company: string | null
  companyUrl: string | null
  location: string | null
  workplaceType: WorkplaceType
  postedText: string | null
  postedAt: string | null
  easyApply: boolean
  applicantCount: number | null

  descriptionMd: string | null
  descriptionFetchedAt: string | null

  firstSeenAt: string
  lastSeenAt: string
  seenCount: number

  score: number | null
  remoteVerified: boolean | null
  seniorityFit: SeniorityFit | null
  roleFit: RoleFit | null
  summary: string | null
  pros: string[]
  cons: string[]
  redFlags: string[]
  scoredAt: string | null
  scoreModel: string | null
  scoreError: string | null

  status: JobStatus
  notes: string | null
  appliedAt: string | null

  /** Set when the job was included in a manual (chat) scoring export. */
  manualExportedAt?: string | null
  /** 'exact' = timestamp from LinkedIn's own data (listedAt); 'derived' = parsed from "3 gün önce". */
  postedAtSource?: 'exact' | 'derived' | null

  // ---- v3 collector extras (present only in web mode) ----
  source?: string
  searchKeywords?: string | null
  criteria?: { seniority?: string | null; employment?: string | null; func?: string | null; industry?: string | null } | null
  workplaceLlm?: string | null
  /** LLM extras (collector): hybrid pattern, salary text, english need, AI usage. */
  workplaceDetail?: string | null
  salaryNote?: string | null
  englishLevel?: 'none' | 'written' | 'spoken_daily' | 'unknown' | string | null
  aiUsage?: boolean | null
  companyResearchMd?: string | null
  companyResearchAt?: string | null
  /** Per-ad CV advice (collector). */
  cvTipsMd?: string | null
  cvTipsAt?: string | null
  /** First time the user opened the ad in the dashboard (collector); null = unread. */
  viewedAt?: string | null
  /** One-tap reason for ignore/reject (collector). */
  decisionReason?: string | null
  /** Liveness (collector): set when the posting stopped accepting applications or was removed. */
  closedAt?: string | null
  closedReason?: string | null
  checkedAt?: string | null
  /** Server-side rule result (collector); when present it wins over the local computation. */
  pre?: unknown
  /** Title gate reason: text was deliberately not fetched. */
  descriptionSkipped?: string | null
  /** Hash of cv/criteria/about the score was made with (collector); differs from stats.profileHash = scored with an older profile. */
  scoreProfile?: string | null
  /** When the status last left 'new' (collector). */
  decidedAt?: string | null
  /** Set when this ad is a repost of another one (its id); reposts are hidden from the queues. */
  dupOf?: string | null
  updatedAt?: string | null
  /** Structured facts + fit the score was computed from (collector, deterministic scoring). */
  facts?: unknown
  /** Score breakdown computed from facts with the current weights (collector). */
  scoreParts?: Array<{ label: string; kind: 'base' | 'delta' | 'cap'; value: number; applied: boolean }> | null
}

export type Stats = {
  total: number
  scored: number
  above70: number
  needsDescription: number
  needsScore: number
  lastCollectedAt: string | null
}
