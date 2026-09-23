/** Applies the searches.yaml `radar:` block (cities, role dictionaries) to the rule engine and prompts; a change invalidates stored prescreens. */
import { configurePrescreen, HOME_CITIES, THRESHOLDS } from './shared/prescreen.ts'
import { clearPrescreens, getSetting, setSetting, recomputeScores } from './db.ts'
import { configureScoring } from './shared/scoring.ts'
import { log } from './log.ts'
import type { SearchesConfig } from './config.ts'

let announced: string | null = null

export function applyRadarConfig(cfg: SearchesConfig): void {
  configurePrescreen(cfg.radar)
  configureScoring(cfg.radar?.score_weights)
  const hash = JSON.stringify(cfg.radar ?? {})
  const prev = getSetting('radarHash')
  if (prev !== null && prev !== hash) {
    clearPrescreens()
    const n = recomputeScores()
    log.info(`radar ayarı değişti; ön elemeler bir sonraki turda yeniden hesaplanır${n ? `, ${n} skor yeni ağırlıklarla güncellendi (LLM çağrısı yok)` : ''}`)
  }
  if (prev !== hash) setSetting('radarHash', hash)
  if (announced === hash) return // same process, same config: don't repeat the summary line
  announced = hash
  log.info(`kabul edilen şehirler: ${HOME_CITIES.join(', ')} · eşikler review ≥ ${THRESHOLDS.review}, candidate ≥ ${THRESHOLDS.candidate}${cfg.radar?.roles ? ' · rol sözlükleri yaml\'dan' : ''}`)
}
