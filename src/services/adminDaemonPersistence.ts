/**
 * Admin Daemon Persistence Service
 *
 * Provides authenticated cloud persistence for Admin Daemon data using
 * dedicated tables (admin_conversations, admin_messages, admin_durable_memories,
 * admin_learning_interactions) that are completely isolated from the public
 * Daemon tables.
 *
 * Uses only the anon key protected by RLS + is_admin() server-side check.
 * Never uses service-role credentials.
 *
 * Falls back gracefully when:
 *   - Supabase is not configured
 *   - No authenticated user session
 *   - Network or server errors occur
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type AdminEvolutionStatusModel,
} from './daemonEvolutionFoundation'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminConversation {
  id: string
  user_id: string
  title: string
  created_at: string
  updated_at: string
}

export interface AdminMessage {
  id: string
  conversation_id: string
  user_id: string
  role: 'user' | 'assistant'
  content: string
  position: number
  created_at: string
}

export interface AdminDurableMemory {
  id: string
  user_id: string
  text: string
  tags: string[]
  created_at: string
}

export type AdminPersistenceStatus =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'error'
  | 'offline'
  | 'unconfigured'

// ---------------------------------------------------------------------------
// Supabase client (anon key only, protected by RLS + is_admin())
// ---------------------------------------------------------------------------

const SUPABASE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

export function isAdminPersistenceConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (!isAdminPersistenceConfigured()) return null
  if (_client) return _client
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  })
  return _client
}

/** Returns the authenticated client with the active session token, or null. */
async function getAuthedClient(): Promise<SupabaseClient | null> {
  const client = getClient()
  if (!client) return null
  const { data } = await client.auth.getSession()
  if (!data.session) return null
  return client
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function listAdminConversations(
  limit = 50,
): Promise<AdminConversation[]> {
  const client = await getAuthedClient()
  if (!client) return []
  const { data, error } = await client
    .from('admin_conversations')
    .select('id, user_id, title, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data ?? []) as AdminConversation[]
}

export async function upsertAdminConversation(
  id: string,
  title: string,
): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { data: { session } } = await client.auth.getSession()
  if (!session?.user.id) return false
  const { error } = await client.from('admin_conversations').upsert(
    { id, user_id: session.user.id, title, updated_at: new Date().toISOString() },
    { onConflict: 'id' },
  )
  return !error
}

export async function deleteAdminConversation(id: string): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { error } = await client
    .from('admin_conversations')
    .delete()
    .eq('id', id)
  return !error
}

export async function deleteAllAdminConversations(): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { data: { session } } = await client.auth.getSession()
  if (!session?.user.id) return false
  const { error } = await client
    .from('admin_conversations')
    .delete()
    .eq('user_id', session.user.id)
  return !error
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listAdminMessages(
  conversationId: string,
  limit = 200,
): Promise<AdminMessage[] | null> {
  const client = await getAuthedClient()
  if (!client) return []
  const { data, error } = await client
    .from('admin_messages')
    .select('id, conversation_id, user_id, role, content, position, created_at')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: false })
    .limit(limit)
  if (error) return null
  return ((data ?? []) as AdminMessage[]).reverse()
}

async function getNextAdminMessagePosition(
  client: SupabaseClient,
  conversationId: string,
  fallbackPosition: number,
): Promise<number> {
  const { data, error } = await client
    .from('admin_messages')
    .select('position')
    .eq('conversation_id', conversationId)
    .order('position', { ascending: false })
    .limit(1)
    .maybeSingle<{ position: number }>()

  if (error || typeof data?.position !== 'number') return fallbackPosition
  return Math.max(fallbackPosition, data.position + 1)
}

export async function insertAdminMessage(msg: {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  position: number
}): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { data: { session } } = await client.auth.getSession()
  if (!session?.user.id) return false
  const nextPosition = await getNextAdminMessagePosition(
    client,
    msg.conversation_id,
    msg.position,
  )
  const { error } = await client.from('admin_messages').insert({
    id: msg.id,
    conversation_id: msg.conversation_id,
    user_id: session.user.id,
    role: msg.role,
    content: msg.content,
    position: nextPosition,
  })
  return !error
}

export async function deleteAdminMessagesForConversation(
  conversationId: string,
): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { error } = await client
    .from('admin_messages')
    .delete()
    .eq('conversation_id', conversationId)
  return !error
}

// ---------------------------------------------------------------------------
// Durable memories
// ---------------------------------------------------------------------------

export async function listAdminMemories(limit = 200): Promise<AdminDurableMemory[]> {
  const client = await getAuthedClient()
  if (!client) return []
  const { data, error } = await client
    .from('admin_durable_memories')
    .select('id, user_id, text, tags, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return (data ?? []) as AdminDurableMemory[]
}

export async function insertAdminMemory(id: string, text: string, tags: string[] = []): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { data: { session } } = await client.auth.getSession()
  if (!session?.user.id) return false
  const { error } = await client.from('admin_durable_memories').insert({
    id,
    user_id: session.user.id,
    text,
    tags,
  })
  return !error
}

export async function deleteAdminMemory(id: string): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { error } = await client.from('admin_durable_memories').delete().eq('id', id)
  return !error
}

export async function deleteAllAdminMemories(): Promise<boolean> {
  const client = await getAuthedClient()
  if (!client) return false
  const { data: { session } } = await client.auth.getSession()
  if (!session?.user.id) return false
  const { error } = await client
    .from('admin_durable_memories')
    .delete()
    .eq('user_id', session.user.id)
  return !error
}

// ---------------------------------------------------------------------------
// Safe diagnostics status — no secret values
// ---------------------------------------------------------------------------

export interface AdminDiagnosticsStatus {
  persistenceConfigured: boolean
  sessionActive: boolean
  supabaseUrl: string
  evolution: AdminEvolutionStatusModel | null
  evolutionStatus: 'available' | 'unavailable' | 'error'
  researchStatus: 'available' | 'unavailable' | 'error'
  research: {
    mode: 'denied' | 'configured'
    dnsPinningConfigured: boolean
    searchProviderConfigured: boolean
    searchEndpointConfigured: boolean
    fetchedSources: number
    blockedEvents: number
    blockedReasons: Array<{ reason: string; count: number }>
    quarantinedInsights: number
    expiredInsights: number
  } | null
}

export async function getAdminDiagnosticsStatus(): Promise<AdminDiagnosticsStatus> {
  const configured = isAdminPersistenceConfigured()
  const client = configured ? getClient() : null
  let sessionActive = false
  let accessToken: string | null = null
  if (client) {
    const { data } = await client.auth.getSession()
    sessionActive = Boolean(data.session)
    accessToken = data.session?.access_token ?? null
  }
  // Show only the hostname, not the full URL, to avoid leaking project details.
  let urlHost = ''
  try {
    if (SUPABASE_URL) urlHost = new URL(SUPABASE_URL).hostname
  } catch { /* best-effort */ }

  let evolution: AdminEvolutionStatusModel | null = null
  let evolutionStatus: 'available' | 'unavailable' | 'error' = 'unavailable'
  let research: AdminDiagnosticsStatus['research'] = null
  let researchStatus: 'available' | 'unavailable' | 'error' = 'unavailable'
  let evolutionResolved = false
  let researchResolved = false

  if (configured && sessionActive && accessToken) {
    const endpoint = `${SUPABASE_URL}/functions/v1/admin-daemon`
    try {
      const [evolutionRes, researchRes] = await Promise.allSettled([
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + accessToken,
          },
          body: JSON.stringify({ request_type: 'evolution_status' }),
        }),
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + accessToken,
          },
          body: JSON.stringify({ request_type: 'research_status' }),
        }),
      ])

      if (evolutionRes.status === 'fulfilled' && evolutionRes.value.ok) {
        const evolutionData = await evolutionRes.value.json() as {
          evolution?: AdminEvolutionStatusModel | null
          evolutionStatus?: 'available' | 'unavailable' | 'error'
        }
        evolution = evolutionData.evolution ?? null
        evolutionStatus = evolutionData.evolutionStatus ?? 'unavailable'
        evolutionResolved = true
      } else {
        evolutionStatus = 'error'
        evolutionResolved = true
      }

      if (researchRes.status === 'fulfilled' && researchRes.value.ok) {
        const researchData = await researchRes.value.json() as {
          diagnostics_status?: 'available' | 'unavailable' | 'error'
          configuration?: {
            mode?: 'denied' | 'configured'
            dns_pinning_configured?: boolean
            search_provider_configured?: boolean
            search_endpoint_configured?: boolean
          }
          counters?: {
            fetched_sources?: number
            blocked_events?: number
            quarantined_insights?: number
            expired_insights?: number
          }
          blocked_reasons?: Array<{ reason?: unknown; count?: unknown }>
        }
        researchStatus = researchData.diagnostics_status ?? 'unavailable'
        if (researchStatus === 'available') {
          research = {
            mode: researchData.configuration?.mode === 'configured' ? 'configured' : 'denied',
            dnsPinningConfigured: Boolean(researchData.configuration?.dns_pinning_configured),
            searchProviderConfigured: Boolean(researchData.configuration?.search_provider_configured),
            searchEndpointConfigured: Boolean(researchData.configuration?.search_endpoint_configured),
            fetchedSources: Number(researchData.counters?.fetched_sources ?? 0),
            blockedEvents: Number(researchData.counters?.blocked_events ?? 0),
            blockedReasons: (researchData.blocked_reasons ?? [])
              .flatMap(entry => {
                const reason = typeof entry.reason === 'string' ? entry.reason : ''
                const count = entry.count
                if (reason.length === 0 || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return []
                return [{ reason, count }]
              }),
            quarantinedInsights: Number(researchData.counters?.quarantined_insights ?? 0),
            expiredInsights: Number(researchData.counters?.expired_insights ?? 0),
          }
        } else {
          research = null
        }
        researchResolved = true
      } else {
        researchStatus = 'error'
        research = null
        researchResolved = true
      }
    } catch {
      // Preserve independent statuses where available; fail closed only for
      // any still-unknown diagnostics channel.
      if (!evolutionResolved && evolutionStatus === 'unavailable' && !evolution) evolutionStatus = 'error'
      if (!researchResolved && researchStatus === 'unavailable') researchStatus = 'error'
      if (researchStatus === 'unavailable') researchStatus = 'error'
    }
  }

  return {
    persistenceConfigured: configured,
    sessionActive,
    supabaseUrl: urlHost,
    evolution,
    evolutionStatus,
    researchStatus,
    research,
  }
}
