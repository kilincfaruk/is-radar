import type { Job } from '@/lib/types'
import { HOME_CITIES, fold, type PreScreen } from '@/lib/prescreen'

export type WorkplaceKind = 'remote' | 'hybrid' | 'onsite'
export const WORKPLACE_LABEL: Record<WorkplaceKind, string> = { remote: 'remote', hybrid: 'hibrit', onsite: 'ofis' }

/** 'ankara' = primary city, 'home' = another accepted city, 'other' = elsewhere, 'none' = no city / remote. */
export type CityClass = 'ankara' | 'home' | 'other' | 'none'
export type Workplace = { kind: WorkplaceKind | null; verified: boolean; city: string | null; cityClass: CityClass; detail: string | null; why: string }

export function cityClassOf(location: string | null | undefined): CityClass {
  const city = cityOf(location)
  if (!city) return 'none'
  const f = fold(city)
  if (f === fold(HOME_CITIES[0])) return 'ankara'
  if (HOME_CITIES.some((c) => fold(c) === f)) return 'home'
  return 'other'
}


/** "Ankara, Türkiye" → "Ankara"; bare "Türkiye"/"Turkey" → null. */
export function cityOf(location: string | null | undefined): string | null {
  if (!location) return null
  const first = location.split(',')[0]?.trim() ?? ''
  if (!first || /^t[üu]rkiye$/i.test(first) || /^turkey$/i.test(first)) return null
  return first
}

/**
 * One answer for "how does this job work": the kind (remote / hybrid / onsite) and whether it was
 * confirmed from the ad text (LLM or rule engine) or only comes from LinkedIn's label.
 */
export function resolveWorkplace(job: Job, pre: PreScreen | null | undefined): Workplace {
  const llm = job.workplaceLlm
  if (llm && llm !== 'unknown') {
    const kind: WorkplaceKind = llm === 'remote' ? 'remote' : llm.startsWith('hybrid') ? 'hybrid' : 'onsite'
    const city = kind === 'remote' ? null : cityOf(job.location)
    return { kind, verified: true, city, cityClass: kind === 'remote' ? 'none' : cityClassOf(job.location), detail: job.workplaceDetail ?? null, why: 'LLM ilan metninden doğruladı' }
  }
  if (job.remoteVerified === true) return { kind: 'remote', verified: true, city: null, cityClass: 'none', detail: null, why: 'LLM ilan metninden doğruladı' }
  if (pre && pre.remote !== 'unknown') {
    const kind: WorkplaceKind = pre.remote === 'verified' ? 'remote' : pre.remote
    // rows written before remoteSource existed: "metin sessiz" in the reasons means label-only
    const source = pre.remoteSource ?? (pre.reasons.some((r) => /metin sessiz/.test(r)) ? 'label' : 'text')
    const verified = source === 'text'
    return {
      kind,
      verified,
      city: kind === 'remote' ? null : cityOf(job.location),
      cityClass: kind === 'remote' ? 'none' : cityClassOf(job.location),
      detail: pre.hybridDetail ?? null,
      why: verified ? 'kural motoru ilan metninde buldu' : 'sadece LinkedIn etiketi, metin sessiz',
    }
  }
  if (job.workplaceType === 'remote' || job.workplaceType === 'hybrid' || job.workplaceType === 'onsite') {
    return {
      kind: job.workplaceType,
      verified: false,
      city: job.workplaceType === 'remote' ? null : cityOf(job.location),
      cityClass: job.workplaceType === 'remote' ? 'none' : cityClassOf(job.location),
      detail: null,
      why: job.remoteVerified === false ? 'LLM metinde doğrulayamadı, sadece LinkedIn etiketi' : 'sadece LinkedIn etiketi, metinden daha doğrulamadım',
    }
  }
  const countryOnly = !job.location || /^(türkiye|turkey|turkiye)\s*$/i.test(job.location.trim())
  return { kind: null, verified: false, city: countryOnly ? 'Türkiye geneli' : null, cityClass: 'none', detail: null, why: countryOnly ? 'çalışma şekli metinde yok; lokasyon şehirsiz, muhtemelen remote (misafir arama etiket vermez)' : 'çalışma şekli metinde yok (misafir arama etiket vermez)' }
}
