import { LEGACY_STORAGE_KEYS, loadMigratedStorageItem } from './daemonStorageMigration'

/**
 * Daemon Memory Service
 *
 * Provides a two-tier memory model:
 *   1. Short-term (conversation context) – cleared when the user starts a new chat.
 *   2. Durable memories – explicitly remembered by the user; persist in localStorage
 *      unless the user explicitly forgets them.
 *
 * Commands handled by the DaemonInterface (not here):
 *   "remember this: <text>"   → saveMemory(text)
 *   "forget this"             → removeLastMemory()
 *   "forget: <text>"          → forgetByText(text)
 *   "what do you remember?"   → listMemories()
 *
 * Production upgrade path:
 *   Replace `localStorage` calls with calls to a REST API backed by
 *   PostgreSQL/pgvector, Pinecone, Qdrant, or a compatible vector store.
 *   The interface exposed here stays the same.
 */

export interface DurableMemory {
  id: string
  text: string
  createdAt: string        // ISO-8601
  tags?: string[]
}

const DURABLE_KEY = 'daemon_durable_memories'

// ---------------------------------------------------------------------------
// Persistence (localStorage adapter – swap for REST calls in production)
// ---------------------------------------------------------------------------

function loadDurable(): DurableMemory[] {
  try {
    const raw = loadMigratedStorageItem(DURABLE_KEY, LEGACY_STORAGE_KEYS.durableMemories)
    return raw ? (JSON.parse(raw) as DurableMemory[]) : []
  } catch {
    return []
  }
}

function saveDurable(memories: DurableMemory[]): void {
  try {
    localStorage.setItem(DURABLE_KEY, JSON.stringify(memories))
  } catch { /* quota exceeded – best effort */ }
}

// ---------------------------------------------------------------------------
// ID generator – uses crypto.randomUUID when available to prevent collisions
// across concurrent tabs; falls back to timestamp + random for older runtimes.
// ---------------------------------------------------------------------------

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback: generate a compliant v4 UUID from random bytes
  const hex = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  )
  hex[6] = ((parseInt(hex[6], 16) & 0x0f) | 0x40).toString(16).padStart(2, '0')
  hex[8] = ((parseInt(hex[8], 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10).join('')}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Persist a new durable memory. Returns the created entry. */
export function saveMemory(text: string): DurableMemory {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('Memory text must not be empty')
  const mem: DurableMemory = {
    id: genId(),
    text: trimmed,
    createdAt: new Date().toISOString(),
  }
  const existing = loadDurable()
  saveDurable([...existing, mem])
  return mem
}

/** Return all durable memories, most-recent first. */
export function listMemories(): DurableMemory[] {
  return loadDurable().slice().reverse()
}

/** Remove a memory by its id. Returns true if removed.
 * @todo Not yet called from any UI path. Reserved for a future "manage memories" panel
 *       that lets users delete individual entries by id.
 */
export function forgetById(id: string): boolean {
  const existing = loadDurable()
  const filtered = existing.filter(m => m.id !== id)
  if (filtered.length === existing.length) return false
  saveDurable(filtered)
  return true
}

/** Remove the most-recently added memory. Returns the removed entry or null. */
export function forgetLast(): DurableMemory | null {
  const existing = loadDurable()
  if (existing.length === 0) return null
  const last = existing[existing.length - 1]
  saveDurable(existing.slice(0, -1))
  return last ?? null
}

/** Remove memories whose text contains the given phrase (case-insensitive). */
export function forgetByText(phrase: string): DurableMemory[] {
  const lower = phrase.toLowerCase().trim()
  const existing = loadDurable()
  const removed: DurableMemory[] = []
  const kept: DurableMemory[] = []
  for (const m of existing) {
    if (m.text.toLowerCase().includes(lower)) {
      removed.push(m)
    } else {
      kept.push(m)
    }
  }
  saveDurable(kept)
  return removed
}

/** Erase ALL durable memories. Call only on explicit user request. */
export function forgetAll(): void {
  saveDurable([])
}

/**
 * Deterministic relevance retrieval (no embeddings required).
 * Returns up to `limit` memories sorted by keyword overlap with `query`.
 *
 * Production upgrade: replace with vector similarity search.
 */
export function retrieveRelevant(query: string, limit = 5): DurableMemory[] {
  const tokens = query.toLowerCase().split(/\W+/).filter(t => t.length > 2)
  if (tokens.length === 0) return listMemories().slice(0, limit)

  const scored = loadDurable().map(m => {
    const lower = m.text.toLowerCase()
    const score = tokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0)
    return { mem: m, score }
  })

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.mem.createdAt.localeCompare(a.mem.createdAt))
    .slice(0, limit)
    .map(({ mem }) => mem)
}

/** Format memories as a short readable list for Daemon's context. */
export function formatMemoriesForContext(memories: DurableMemory[]): string {
  if (memories.length === 0) return 'No memories stored yet.'
  return memories
    .map((m, i) => `${i + 1}. ${m.text} (${new Date(m.createdAt).toLocaleDateString()})`)
    .join('\n')
}
