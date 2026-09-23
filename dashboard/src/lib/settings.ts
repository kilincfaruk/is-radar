/** Browser-side preferences (localStorage). Scoring settings live on the server (.env); this is only what the UI needs. */
export type Settings = {
  /** "iyi ilan" eşiği: StatsBar ve satır vurgusu. Sunucuda da saklanır (settings tablosu). */
  scoreThreshold: number
}

const KEY = 'is-radar-settings'
export const DEFAULT_SETTINGS: Settings = { scoreThreshold: 70 }

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = localStorage.getItem(KEY)
    return { ...DEFAULT_SETTINGS, ...(raw ? (JSON.parse(raw) as Partial<Settings>) : {}) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  localStorage.setItem(KEY, JSON.stringify(s))
  window.dispatchEvent(new CustomEvent('is-radar-settings'))
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const h = () => void loadSettings().then(cb)
  window.addEventListener('is-radar-settings', h)
  return () => window.removeEventListener('is-radar-settings', h)
}
