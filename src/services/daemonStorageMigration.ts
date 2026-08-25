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

// ---------------------------------------------------------------------------
// UUID helpers (no dependency on external libs)
// ---------------------------------------------------------------------------

/** Returns true if s is a valid RFC 4122 UUID (case-insensitive). */
export function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/** Generate a UUID v4 without any prefix. */
export function genUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0')
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10).join('')}`
}

// ---------------------------------------------------------------------------
// One-time legacy ID migration
//
// Older builds stored IDs as "daemon-<ts>-<n>", "mem-<uuid>", or
// "interaction-<ts>-<rand>".  These cannot be inserted into UUID database
// columns.  This migration runs once per browser profile, maps each old ID to
// a stable UUID, and rewrites all cross-references so message↔conversation
// and interaction records remain linked.
//
// Safety guarantees:
//   • Idempotent: the completion flag prevents a second run.
//   • Non-destructive: writes are best-effort; read failures skip silently so
//     data already in the valid format is never discarded.
//   • Malformed JSON is skipped; valid entries with already-UUID IDs pass through
//     unchanged.
// ---------------------------------------------------------------------------

const UUID_MIGRATION_DONE_KEY = 'daemon_uuid_migration_done'

export function isLegacyIdMigrationDone(): boolean {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage?.getItem(UUID_MIGRATION_DONE_KEY) === '1'
  } catch {
    return false
  }
}

function markLegacyIdMigrationDone(): void {
  try {
    ;(globalThis as { localStorage?: Storage }).localStorage?.setItem(UUID_MIGRATION_DONE_KEY, '1')
  } catch { /* ignore */ }
}

interface LegacyMessage { id: string; role: string; content: string; timestamp: string }
interface LegacyConversation { id: string; title: string; messages: LegacyMessage[]; createdAt: string }
interface LegacyDurableMemory { id: string; text: string; createdAt: string; tags?: string[] }
interface LegacyInteractionRecord {
  id: string
  input: string
  response: string
  metadata: Record<string, unknown>
  feedback?: Record<string, unknown>
}
interface LegacyLearningData { history: LegacyInteractionRecord[]; stats: Record<string, unknown> }

/**
 * Run the one-time legacy-ID migration.  Safe to call on every app start; it
 * checks the completion flag first and exits early if already done.
 */
export function runLegacyIdMigration(): void {
  if (isLegacyIdMigrationDone()) return

  const storage = getBrowserStorage()
  if (!storage) {
    markLegacyIdMigrationDone()
    return
  }

  try {
    _migrateConversationsAndMessages(storage)
  } catch { /* malformed data – skip */ }

  try {
    _migrateDurableMemories(storage)
  } catch { /* malformed data – skip */ }

  try {
    _migrateLearningData(storage)
  } catch { /* malformed data – skip */ }

  markLegacyIdMigrationDone()
}

function _migrateConversationsAndMessages(storage: BrowserStorage): void {
  // Both daemon_messages and daemon_conversations share ID space.
  const CONV_KEY = 'daemon_conversations'
  const MSG_KEY = 'daemon_messages'

  const rawConvs = storage.getItem(CONV_KEY)
  if (!rawConvs) return

  let convs: LegacyConversation[]
  try { convs = JSON.parse(rawConvs) as LegacyConversation[] } catch { return }
  if (!Array.isArray(convs)) return

  // Build a stable old-id → new-UUID map, reusing UUIDs for IDs already valid.
  const convIdMap = new Map<string, string>()
  const msgIdMap = new Map<string, string>()

  const migratedConvs: LegacyConversation[] = convs.map(conv => {
    if (!conv || typeof conv !== 'object') return conv
    const newConvId = isUUID(conv.id) ? conv.id : convIdMap.get(conv.id) ?? (() => { const u = genUUID(); convIdMap.set(conv.id, u); return u })()
    const migratedMessages = Array.isArray(conv.messages)
      ? conv.messages.map((msg: LegacyMessage) => {
          if (!msg || typeof msg !== 'object') return msg
          const newMsgId = isUUID(msg.id) ? msg.id : msgIdMap.get(msg.id) ?? (() => { const u = genUUID(); msgIdMap.set(msg.id, u); return u })()
          return { ...msg, id: newMsgId }
        })
      : conv.messages
    return { ...conv, id: newConvId, messages: migratedMessages }
  })

  try { storage.setItem(CONV_KEY, JSON.stringify(migratedConvs)) } catch { /* quota – best effort */ }

  // Also migrate the flat messages list if present
  const rawMsgs = storage.getItem(MSG_KEY)
  if (rawMsgs) {
    try {
      const msgs = JSON.parse(rawMsgs) as LegacyMessage[]
      if (Array.isArray(msgs)) {
        const migratedMsgs = msgs.map(msg => {
          if (!msg || typeof msg !== 'object') return msg
          const newId = isUUID(msg.id) ? msg.id : msgIdMap.get(msg.id) ?? (() => { const u = genUUID(); msgIdMap.set(msg.id, u); return u })()
          return { ...msg, id: newId }
        })
        try { storage.setItem(MSG_KEY, JSON.stringify(migratedMsgs)) } catch { /* quota – best effort */ }
      }
    } catch { /* malformed – skip */ }
  }
}

function _migrateDurableMemories(storage: BrowserStorage): void {
  const KEY = 'daemon_durable_memories'
  const raw = storage.getItem(KEY)
  if (!raw) return
  let mems: LegacyDurableMemory[]
  try { mems = JSON.parse(raw) as LegacyDurableMemory[] } catch { return }
  if (!Array.isArray(mems)) return
  const migrated = mems.map(m => {
    if (!m || typeof m !== 'object') return m
    const newId = isUUID(m.id) ? m.id : genUUID()
    return { ...m, id: newId }
  })
  try { storage.setItem(KEY, JSON.stringify(migrated)) } catch { /* quota – best effort */ }
}

function _migrateLearningData(storage: BrowserStorage): void {
  const KEY = 'daemon_learning_data'
  const raw = storage.getItem(KEY)
  if (!raw) return
  let data: LegacyLearningData
  try { data = JSON.parse(raw) as LegacyLearningData } catch { return }
  if (!data || !Array.isArray(data.history)) return
  const idMap = new Map<string, string>()
  const migratedHistory = data.history.map((r: LegacyInteractionRecord) => {
    if (!r || typeof r !== 'object') return r
    const newId = isUUID(r.id) ? r.id : idMap.get(r.id) ?? (() => { const u = genUUID(); idMap.set(r.id, u); return u })()
    return { ...r, id: newId }
  })
  try { storage.setItem(KEY, JSON.stringify({ ...data, history: migratedHistory })) } catch { /* quota – best effort */ }
}
