import { LEGACY_STORAGE_KEYS, loadMigratedStorageItem } from '../services/daemonStorageMigration'

export const SIDEBAR_OPEN_KEY = 'daemon_sidebar_open'

function getSidebarPreferenceStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return (globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> }).localStorage
  } catch {
    return undefined
  }
}

export function parseSidebarOpenPreference(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true
  if (raw === 'true') return true
  if (raw === 'false') return false
  return true
}

export function loadSidebarOpenForKey(storageKey: string): boolean {
  try {
    return parseSidebarOpenPreference(getSidebarPreferenceStorage()?.getItem(storageKey))
  } catch {
    return true
  }
}

export function loadSidebarOpen(): boolean {
  try {
    const raw = loadMigratedStorageItem(SIDEBAR_OPEN_KEY, LEGACY_STORAGE_KEYS.sidebarOpen)
    return parseSidebarOpenPreference(raw)
  } catch {
    // Ignore malformed or unreadable storage and fall back safely.
  }

  return true
}

export function saveSidebarOpenForKey(storageKey: string, sidebarOpen: boolean): void {
  try {
    getSidebarPreferenceStorage()?.setItem(storageKey, String(sidebarOpen))
  } catch {
    // Persisting this UI preference is best effort only.
  }
}

export function saveSidebarOpen(sidebarOpen: boolean): void {
  saveSidebarOpenForKey(SIDEBAR_OPEN_KEY, sidebarOpen)
}
