import { LEGACY_STORAGE_KEYS, loadMigratedStorageItem } from '../services/daemonStorageMigration'

export const SIDEBAR_OPEN_KEY = 'daemon_sidebar_open'

function getSidebarPreferenceStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return (globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> }).localStorage
  } catch {
    return undefined
  }
}

export function loadSidebarOpen(): boolean {
  try {
    const raw = loadMigratedStorageItem(SIDEBAR_OPEN_KEY, LEGACY_STORAGE_KEYS.sidebarOpen)
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
