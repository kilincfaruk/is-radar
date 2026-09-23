import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT } from '../config.ts'

/** profile/cv.md + profile/criteria.md: personal, gitignored. `npm run init` copies the *.example.md templates. */
export const PROFILE_DIR = path.join(ROOT, 'profile')

function readProfileFile(name: string): string {
  const p = path.join(PROFILE_DIR, name)
  if (!fs.existsSync(p)) throw new Error(`profile/${name} yok. \`npm run init\` çalıştır, sonra profile/${name} dosyasını kendine göre doldur.`)
  const text = fs.readFileSync(p, 'utf8')
  if (!text.trim()) throw new Error(`profile/${name} boş.`)
  return text
}

export function readCv(): string {
  return readProfileFile('cv.md')
}
export function readCriteria(): string {
  return readProfileFile('criteria.md')
}
/** Optional: the candidate in their own words (profile/about.md). Empty string when absent or still the template. */
export function readAbout(): string {
  const p = path.join(PROFILE_DIR, 'about.md')
  if (!fs.existsSync(p)) return ''
  const t = fs.readFileSync(p, 'utf8')
  // the template is all questions; count it as empty until at least one answer line exists
  const answered = t.split('\n').some((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.trim().endsWith('?') && !l.startsWith('- ?'))
  return answered ? t : ''
}

/** Missing/empty profile files, for startup checks. */
export function profileProblems(): string[] {
  const out: string[] = []
  for (const name of ['cv.md', 'criteria.md']) {
    try {
      readProfileFile(name)
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e))
    }
  }
  return out
}

/** Short hash of everything the scoring prompt knows about the candidate. A score made under another hash is "old profile". */
export function profileHash(): string | null {
  try {
    const t = [readCv(), readCriteria(), readAbout()].map((x) => x.replace(/\s+/g, ' ').trim()).join('\n---\n')
    return crypto.createHash('sha1').update(t).digest('hex').slice(0, 10)
  } catch {
    return null
  }
}
