export const SIDEBAR_OPEN_KEY = 'helen_sidebar_open'

function getSidebarPreferenceStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // Ignore storage access failures and fall back safely.
  }

  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function loadSidebarOpen(): boolean {
  try {
    const raw = getSidebarPreferenceStorage()?.getItem(SIDEBAR_OPEN_KEY)
    if (raw === null || raw === undefined) return true
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // Ignore malformed or unreadable storage and fall back safely.
  }

  return true
}

export function saveSidebarOpen(sidebarOpen: boolean): void {
  try {
    getSidebarPreferenceStorage()?.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen))
  } catch {
    // Persisting this UI preference is best effort only.
  }
}
