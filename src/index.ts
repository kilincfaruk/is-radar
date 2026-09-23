import { loadEnv, env, initFiles } from './config.ts'
import { profileProblems } from './pipeline/profile.ts'
import { openDb, stats, clearPrescreens, backupDb, clearScores, clearTexts, clearAll, bumpUsage } from './db.ts'
import { onClaudeUsage } from './pipeline/claude-cli.ts'
import { collectRound } from './run.ts'
import { runScoring, runTopScoring, runPrescreen } from './pipeline/score.ts'
import { runResearch } from './pipeline/research.ts'
import { importBackup } from './import-backup.ts'
import { doctor } from './doctor.ts'
import { cvReview, criteriaReview } from './pipeline/cv.ts'
import { applyRadarConfig } from './radar.ts'
import { writeReport } from './report.ts'
import { loadSearches } from './config.ts'
import { log } from './log.ts'

loadEnv()
const [cmd = 'help', ...rest] = process.argv.slice(2)
const flag = (name: string, def?: string) => {
  const i = rest.indexOf('--' + name)
  if (i === -1) return def
  const v = rest[i + 1]
  return v === undefined || v.startsWith('--') ? 'true' : v
}
const has = (name: string) => rest.includes('--' + name)

async function main() {
  // scoring needs the personal profile; fail early with a clear message instead of mid-run
  if (['run', 'serve', 'score', 'doctor', 'cv-review'].includes(cmd) && env('SCORER', 'claude-cli') !== 'none') {
    const problems = profileProblems()
    if (problems.length) {
      for (const p of problems) log.error(p)
      process.exit(1)
    }
  }
  if (!['init', 'help', 'doctor'].includes(cmd)) {
    openDb()
    applyRadarConfig(loadSearches())
    onClaudeUsage(bumpUsage) // all-time cost/call counter in the db
  }
  switch (cmd) {
    case 'init': {
      const created = initFiles()
      if (created.length === 0) log.info('her şey yerinde: .env, searches.yaml, profile/cv.md, profile/criteria.md')
      else log.info(`oluşturuldu: ${created.join(', ')}\n  → profile/cv.md dosyasına kendi CV'ni yaz, profile/criteria.md ve searches.yaml dosyalarını kendine göre düzenle, sonra: npm run build && npm run serve`)
      break
    }
    case 'run': {
      await collectRound({
        maxSearches: flag('max-searches') ? Number(flag('max-searches')) : undefined,
        pages: flag('pages') ? Number(flag('pages')) : undefined,
        details: flag('details') ? Number(flag('details')) : undefined,
        score: !has('no-score'),
        research: !has('no-research'),
        scoreBudget: flag('score-budget') ? Number(flag('score-budget')) : undefined,
        mode: has('full') ? 'full' : has('incremental') ? 'incremental' : undefined,
      })
      break
    }
    case 'score': {
      openDb()
      runPrescreen()
      const r = has('top') ? await runTopScoring(Number(flag('limit', '20'))) : await runScoring(Number(flag('limit', '20')), has('include-rejects'))
      log.info(`skorlandı ${r.scored}, hata ${r.failed}`)
      break
    }
    case 'research': {
      openDb()
      const n = await runResearch(Number(flag('min-score', env('RESEARCH_MIN_SCORE', '70'))), Number(flag('limit', '5')))
      log.info(`araştırıldı ${n}`)
      break
    }
    case 'prescreen': {
      openDb()
      if (has('recompute')) clearPrescreens()
      log.info(`ön eleme: ${runPrescreen()} ilan`)
      break
    }
    case 'import': {
      const file = rest.find((a) => !a.startsWith('--'))
      if (!file) throw new Error('kullanım: npm run import -- <backup.json>')
      openDb()
      importBackup(file)
      runPrescreen()
      break
    }
    case 'reset': {
      openDb()
      const before = stats()
      const file = backupDb()
      log.info(`yedek alındı: ${file} (${before.total} ilan)`)
      if (has('all')) {
        clearAll()
        log.info('tüm ilanlar ve tur geçmişi silindi; sonraki tur sıfırdan toplar')
      } else {
        if (has('scores') || has('texts')) {
          clearScores()
          log.info('LLM skorları ve ön eleme silindi (ilanlar, metinler, notlar duruyor)')
        }
        if (has('texts')) {
          clearTexts()
          log.info('ilan metinleri silindi; sonraki turda yeniden çekilir')
        }
        if (!has('scores') && !has('texts')) log.info('sadece yedek alındı; sıfırlamak için --scores, --texts veya --all ver')
      }
      console.log(stats())
      break
    }
    case 'cv-review': {
      openDb()
      const r = await cvReview(Number(flag('limit', '15')), Number(flag('min-score', '0')))
      if (!r.ok) throw new Error(r.error)
      console.log(r.md)
      break
    }
    case 'criteria-review': {
      const r = await criteriaReview(Number(flag('limit', '40')))
      if (!r.ok) throw new Error(r.error)
      console.log(r.md)
      break
    }
    case 'doctor': {
      await doctor()
      break
    }
    case 'report': {
      const r = writeReport()
      log.info(`rapor yazıldı: ${r.file}\n  aynısı: ${r.latest}\n  ${r.counts.newThisRound} yeni iyi · ${r.counts.worth} bakmaya değer · ${r.counts.near} eşiğe yakın · ${r.counts.pursued} takipte`)
      break
    }
    case 'stats': {
      openDb()
      console.log(stats())
      break
    }
    case 'serve': {
      const { serve } = await import('./web/server.ts')
      await serve()
      break
    }
    default:
      console.log(`İş Radar
  npm run init         (ilk kurulum: .env, searches.yaml, profile/*.md şablonlardan kopyalanır)
  npm run build        (dashboard -> public/; serve bunu sunar)
  npm run run       -- [--full | --incremental] [--max-searches N] [--pages N] [--details N] [--no-score] [--no-research] [--score-budget N]
  npm run score     -- [--limit N] [--include-rejects] [--top]   (--top: skor ≥ TOP_MIN_SCORE olanları CLAUDE_MODEL_TOP ile yeniden)
  npm run research  -- [--min-score N] [--limit N]
  npm run cv-review -- [--limit N] [--min-score N]   (en iyi N ilana göre CV incelemesi → data/cv-review.md)
  npm run criteria-review -- [--limit N]             (kararlarına göre kriter/about önerileri → data/criteria-review.md)
  npm run import    -- <is-radar-backup.json>
  npm run serve        (zamanlayıcı + http://localhost:${env('PORT', '4545')})
  npm run reset     -- [--scores | --texts | --all]   (önce data/backups/ altına .db yedeği alır)
  npm run report       (tek dosyalık HTML rapor → data/reports/; her tur sonunda da otomatik yazılır)
  npm run doctor       (claude cli teşhisi: sürüm, ortam, hook'lar, örnek skorlama ham çıktısı)
  node --experimental-strip-types src/index.ts prescreen --recompute | stats`)
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.stack || e.message : e)
  process.exit(1)
})
