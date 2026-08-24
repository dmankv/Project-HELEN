type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const LEGACY_STORAGE_KEYS = {
  messages: 'helen_messages',
  conversations: 'helen_conversations',
  sidebarOpen: 'helen_sidebar_open',
  durableMemories: 'helen_durable_memories',
  learningData: 'helen_learning_data',
} as const

function getBrowserStorage(): BrowserStorage | undefined {
  try {
    return (globalThis as { localStorage?: BrowserStorage }).localStorage
  } catch {
    return undefined
  }
}

/**
 * Returns the current value when present, otherwise copies a legacy value to
 * the current key before returning it. Failed best-effort writes do not make
 * the legacy value unreadable.
 */
export function loadMigratedStorageItem(currentKey: string, legacyKey: string): string | null {
  const storage = getBrowserStorage()
  if (!storage) return null

  try {
    const current = storage.getItem(currentKey)
    if (current !== null) return current

    const legacy = storage.getItem(legacyKey)
    if (legacy === null) return null

    try {
      storage.setItem(currentKey, legacy)
      storage.removeItem(legacyKey)
    } catch {
      // The legacy value remains available when localStorage writes are blocked.
    }

    return legacy
  } catch {
    return null
  }
}
