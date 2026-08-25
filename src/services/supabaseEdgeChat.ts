/**
 * Supabase Edge Function Chat Client
 *
 * Routes chat requests through the daemon-chat Supabase Edge Function
 * when both Supabase config and an authenticated user session are present.
 *
 * Falls back gracefully to null (caller uses local brain) when:
 *   - Supabase is not configured
 *   - User is not authenticated
 *   - Edge function is unavailable or returns an error
 *
 * The static bundle never contains OpenAI/Anthropic API keys.
 * Only the public Supabase anon key is used on the client side.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { APIMessage, APIFailure } from './daemonChatAPI'

const SUPABASE_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

const EDGE_TIMEOUT_MS = 30_000

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  if (_client) return _client
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  return _client
}

/** True when the edge function path is available (Supabase configured + user signed in will be checked at call time). */
export function hasEdgeFunction(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

/** Optional adaptive metadata forwarded to the edge function for this turn. */
export interface EdgeChatMetadata {
  /** Approved response strategy selected locally (daemonResponsePolicy). */
  strategy?: string
  /** "intent:mood" key the strategy was selected for. */
  contextKey?: string
  /** Local interaction id, echoed back so feedback can be attributed. */
  interactionId?: string
}

/**
 * Call the daemon-chat Supabase Edge Function.
 * Returns the assistant reply, an APIFailure, or null (not configured / user not signed in).
 */
export async function callEdgeFunction(
  messages: APIMessage[],
  signal?: AbortSignal,
  metadata?: EdgeChatMetadata,
): Promise<string | APIFailure | null> {
  const client = getClient()
  if (!client) return null

  // Check for authenticated session
  const { data: sessionData } = await client.auth.getSession()
  const session = sessionData?.session
  if (!session) return null

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), EDGE_TIMEOUT_MS)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  const functionUrl = SUPABASE_URL + '/functions/v1/daemon-chat'

  try {
    const res = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({
        messages,
        ...(metadata?.strategy ? { strategy: metadata.strategy } : {}),
        ...(metadata?.contextKey ? { context_key: metadata.contextKey } : {}),
        ...(metadata?.interactionId ? { interaction_id: metadata.interactionId } : {}),
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (res.status === 429) {
      console.warn('[edge-chat] Rate limit exceeded')
      return { reason: 'error', status: 429 }
    }
    if (res.status === 401 || res.status === 403) {
      console.warn('[edge-chat] Auth error:', res.status)
      return { reason: 'auth', status: res.status }
    }
    if (!res.ok) {
      console.warn('[edge-chat] Request failed:', res.status)
      return { reason: 'error', status: res.status }
    }

    const data = (await res.json()) as { message?: string }
    return data.message ?? null
  } catch (err) {
    clearTimeout(timeoutId)
    if ((err as Error).name === 'AbortError') {
      console.warn('[edge-chat] Request aborted')
      return { reason: 'aborted' }
    }
    console.warn('[edge-chat] Request error:', (err as Error).message)
    return { reason: 'error' }
  }
}
