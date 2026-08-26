/**
 * Supabase Persistence Service for Daemon data
 *
 * Provides authenticated cloud persistence for conversations, messages,
 * durable memories, and learning interactions. Only activates when both
 * Supabase configuration and an authenticated user session are present.
 *
 * Falls back gracefully to local-only mode when:
 *   - VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set
 *   - No authenticated user session exists
 *   - Network or server errors occur
 *
 * Never exposes service-role keys. Uses only the anon key protected by RLS.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types matching DaemonInterface local storage shapes
// ---------------------------------------------------------------------------

export interface CloudMessage {
  id: string
  conversation_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  position: number
  created_at: string
}

export interface CloudConversation {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface CloudDurableMemory {
  id: string
  user_id: string
  text: string
  tags: string[]
  created_at: string
}

export interface CloudLearningInteraction {
  id: string
  user_id: string
  input: string
  response: string
  intent: string
  confidence: number
  ambiguity: number
  memory_used: number
  plan_complexity: 'simple' | 'moderate' | 'complex'
  feedback_rating?: 'helpful' | 'neutral' | 'unhelpful'
  feedback_comment?: string
  feedback_at?: string
  created_at: string
}

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'offline' | 'unconfigured'

// ---------------------------------------------------------------------------
// Supabase client (anon key only, protected by RLS)
// ---------------------------------------------------------------------------

const SUPABASE_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

/** True when Supabase environment config is present at build time. */
export function isPersistenceConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (!isPersistenceConfigured()) return null
  if (_client) return _client
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  return _client
}

/** Returns the current authenticated user ID, or null if not signed in. */
async function getCurrentUserId(): Promise<string | null> {
  const client = getClient()
  if (!client) return null
  const { data } = await client.auth.getSession()
  return data.session?.user?.id ?? null
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function listConversations(): Promise<CloudConversation[] | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('conversations')
    .select('*')
    .order('updated_at', { ascending: false })
  if (error) { console.warn('[daemon-persistence] listConversations:', error.message); return null }
  return (data ?? []) as CloudConversation[]
}

export async function upsertConversation(
  conv: { id: string; title: string; createdAt: string },
): Promise<CloudConversation | null> {
  const client = getClient()
  if (!client) return null
  const userId = await getCurrentUserId()
  if (!userId) return null
  const { data, error } = await client
    .from('conversations')
    .upsert({ id: conv.id, user_id: userId, title: conv.title, created_at: conv.createdAt })
    .select()
    .maybeSingle<CloudConversation>()
  if (error) { console.warn('[daemon-persistence] upsertConversation:', error.message); return null }
  return data
}

export async function deleteCloudConversation(id: string): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const { error } = await client.from('conversations').delete().eq('id', id)
  if (error) { console.warn('[daemon-persistence] deleteCloudConversation:', error.message); return false }
  return true
}

/**
 * Delete all conversations for the authenticated user in one operation. The
 * user-ID filter narrows the operation; Supabase row-level security
 * independently enforces ownership.
 */
export async function deleteAllCloudConversations(): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const userId = await getCurrentUserId()
  if (!userId) return false
  const { error } = await client
    .from('conversations')
    .delete()
    .eq('user_id', userId)
  if (error) { console.warn('[daemon-persistence] deleteAllCloudConversations:', error.message); return false }
  return true
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(conversationId: string): Promise<CloudMessage[] | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: true })
  if (error) { console.warn('[daemon-persistence] listMessages:', error.message); return null }
  return (data ?? []) as CloudMessage[]
}

export async function insertMessage(
  msg: { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; position: number; createdAt: string },
): Promise<CloudMessage | null> {
  const client = getClient()
  if (!client) return null
  const userId = await getCurrentUserId()
  if (!userId) return null
  const { data, error } = await client
    .from('messages')
    .insert({
      id: msg.id,
      conversation_id: msg.conversationId,
      user_id: userId,
      role: msg.role,
      content: msg.content,
      position: msg.position,
      created_at: msg.createdAt,
    })
    .select()
    .maybeSingle<CloudMessage>()
  if (error) { console.warn('[daemon-persistence] insertMessage:', error.message); return null }
  return data
}

export async function deleteMessagesForConversation(conversationId: string): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const { error } = await client.from('messages').delete().eq('conversation_id', conversationId)
  if (error) { console.warn('[daemon-persistence] deleteMessagesForConversation:', error.message); return false }
  return true
}

// ---------------------------------------------------------------------------
// Durable memories
// ---------------------------------------------------------------------------

export async function listCloudMemories(): Promise<CloudDurableMemory[] | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('durable_memories')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) { console.warn('[daemon-persistence] listCloudMemories:', error.message); return null }
  return (data ?? []) as CloudDurableMemory[]
}

async function insertCloudMemoryForUser(
  client: SupabaseClient,
  userId: string,
  mem: { id: string; text: string; tags?: string[]; createdAt: string },
): Promise<{ memory: CloudDurableMemory | null; succeeded: boolean }> {
  const { data, error } = await client
    .from('durable_memories')
    .insert({ id: mem.id, user_id: userId, text: mem.text, tags: mem.tags ?? [], created_at: mem.createdAt })
    .select()
    .maybeSingle<CloudDurableMemory>()
  if (error) {
    console.warn('[daemon-persistence] insertCloudMemory:', error.message)
    return { memory: null, succeeded: false }
  }
  return { memory: data, succeeded: true }
}

export async function insertCloudMemory(
  mem: { id: string; text: string; tags?: string[]; createdAt: string },
): Promise<CloudDurableMemory | null> {
  const client = getClient()
  if (!client) return null
  const userId = await getCurrentUserId()
  if (!userId) return null
  return (await insertCloudMemoryForUser(client, userId, mem)).memory
}

export async function deleteCloudMemory(id: string): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const { error } = await client.from('durable_memories').delete().eq('id', id)
  if (error) { console.warn('[daemon-persistence] deleteCloudMemory:', error.message); return false }
  return true
}

// ---------------------------------------------------------------------------
// Learning interactions
// ---------------------------------------------------------------------------

export async function insertLearningInteraction(
  record: {
    id: string
    input: string
    response: string
    intent: string
    confidence: number
    ambiguity: number
    memoryUsed: number
    planComplexity: 'simple' | 'moderate' | 'complex'
    createdAt: string
  },
): Promise<CloudLearningInteraction | null> {
  const client = getClient()
  if (!client) return null
  const userId = await getCurrentUserId()
  if (!userId) return null
  const { data, error } = await client
    .from('learning_interactions')
    .insert({
      id: record.id,
      user_id: userId,
      input: record.input,
      response: record.response,
      intent: record.intent,
      confidence: record.confidence,
      ambiguity: record.ambiguity,
      memory_used: record.memoryUsed,
      plan_complexity: record.planComplexity,
      created_at: record.createdAt,
    })
    .select()
    .maybeSingle<CloudLearningInteraction>()
  if (error) { console.warn('[daemon-persistence] insertLearningInteraction:', error.message); return null }
  return data
}

export async function updateLearningFeedback(
  id: string,
  rating: 'helpful' | 'neutral' | 'unhelpful',
  comment?: string,
): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const { error } = await client
    .from('learning_interactions')
    .update({ feedback_rating: rating, feedback_comment: comment ?? null, feedback_at: new Date().toISOString() })
    .eq('id', id)
  if (error) { console.warn('[daemon-persistence] updateLearningFeedback:', error.message); return false }
  return true
}

export async function listLearningInteractions(): Promise<CloudLearningInteraction[] | null> {
  const client = getClient()
  if (!client) return null
  const { data, error } = await client
    .from('learning_interactions')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) { console.warn('[daemon-persistence] listLearningInteractions:', error.message); return null }
  return (data ?? []) as CloudLearningInteraction[]
}

// ---------------------------------------------------------------------------
// Cloud memory deletion mirrors
// ---------------------------------------------------------------------------

/** Delete the most recently added cloud memory (mirrors forgetLast). */
export async function deleteLastCloudMemory(): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const userId = await getCurrentUserId()
  if (!userId) return false
  const { data, error } = await client
    .from('durable_memories')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !data || data.length === 0) return false
  const { error: delError } = await client.from('durable_memories').delete().eq('id', data[0].id)
  if (delError) { console.warn('[daemon-persistence] deleteLastCloudMemory:', delError.message); return false }
  return true
}

/** Delete cloud memories whose text contains phrase (mirrors forgetByText). */
export async function deleteCloudMemoriesByText(phrase: string): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const userId = await getCurrentUserId()
  if (!userId) return false
  // Use ilike for case-insensitive text match
  const { error } = await client
    .from('durable_memories')
    .delete()
    .eq('user_id', userId)
    .ilike('text', `%${phrase}%`)
  if (error) { console.warn('[daemon-persistence] deleteCloudMemoriesByText:', error.message); return false }
  return true
}

/** Delete all cloud memories for the authenticated user (mirrors forgetAll). */
export async function deleteAllCloudMemories(): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const userId = await getCurrentUserId()
  if (!userId) return false
  const { error } = await client
    .from('durable_memories')
    .delete()
    .eq('user_id', userId)
  if (error) { console.warn('[daemon-persistence] deleteAllCloudMemories:', error.message); return false }
  return true
}

// ---------------------------------------------------------------------------
// One-time local-to-cloud migration
// Uploads current localStorage data to Supabase on first authenticated use.
// Idempotent: tracks completion in localStorage keyed by user UUID so that
// signing in as a different account does not inherit another account's flag.
// ---------------------------------------------------------------------------

function migrationDoneKey(userId: string): string {
  return `daemon_cloud_migration_done_${userId}`
}

export function isCloudMigrationDone(userId?: string): boolean {
  try {
    const key = userId ? migrationDoneKey(userId) : 'daemon_cloud_migration_done'
    return localStorage.getItem(key) === '1'
  } catch { return false }
}

function markCloudMigrationDone(userId: string): void {
  try { localStorage.setItem(migrationDoneKey(userId), '1') } catch { /* ignore */ }
}

/**
 * Migrate local durable memories to Supabase. Only runs once per browser
 * profile per user account (tracked via per-user localStorage flag).
 * Errors are non-fatal.
 */
export async function migrateLocalMemoriesToCloud(
  localMemories: Array<{ id: string; text: string; tags?: string[]; createdAt: string }>,
): Promise<void> {
  const client = getClient()
  if (!client) return
  const userId = await getCurrentUserId()
  if (!userId) return
  if (isCloudMigrationDone(userId)) return

  // Check if user already has cloud memories (don't duplicate)
  const { data: existing } = await client
    .from('durable_memories')
    .select('id')
    .limit(1)
  if (existing && existing.length > 0) {
    markCloudMigrationDone(userId)
    return
  }

  for (const mem of localMemories) {
    if (await getCurrentUserId() !== userId) return
    if (!(await insertCloudMemoryForUser(client, userId, mem)).succeeded) return
  }
  markCloudMigrationDone(userId)
}

// ---------------------------------------------------------------------------
// Cloud hydration — restore all user data from Supabase after sign-in
// ---------------------------------------------------------------------------

export interface HydratedDaemonData {
  conversations: CloudConversation[]
  messagesByConversation: Record<string, CloudMessage[]>
  memories: CloudDurableMemory[]
  learningInteractions: CloudLearningInteraction[]
}

/**
 * Load all user data from Supabase after sign-in. Returns null when
 * unauthenticated or unconfigured. Partial failures return whatever data
 * was successfully fetched.
 */
export async function hydrateFromCloud(): Promise<HydratedDaemonData | null> {
  const client = getClient()
  if (!client) return null
  const userId = await getCurrentUserId()
  if (!userId) return null

  const [conversations, memories, learningInteractions] = await Promise.all([
    listConversations(),
    listCloudMemories(),
    listLearningInteractions(),
  ])

  const messagesByConversation: Record<string, CloudMessage[]> = {}
  if (conversations) {
    await Promise.all(
      conversations.map(async conv => {
        const msgs = await listMessages(conv.id)
        if (msgs) messagesByConversation[conv.id] = msgs
      }),
    )
  }

  return {
    conversations: conversations ?? [],
    messagesByConversation,
    memories: memories ?? [],
    learningInteractions: learningInteractions ?? [],
  }
}
