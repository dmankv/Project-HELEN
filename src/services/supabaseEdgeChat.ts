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

export type EdgeChatFailureCategory =
  | 'not-configured'
  | 'not-signed-in'
  | 'auth'
  | 'rate-limited'
  | 'not-found'
  | 'provider'
  | 'server'
  | 'timeout'
  | 'network'
  | 'aborted'

export type SafeEdgeFunctionErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'RATE_LIMITED'
  | 'FUNCTION_CONFIG_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'ORIGIN_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR'

export interface EdgeChatFailure extends APIFailure {
  category: EdgeChatFailureCategory
  safeCode?: SafeEdgeFunctionErrorCode
}

const SAFE_EDGE_FUNCTION_ERROR_CODES = new Set<SafeEdgeFunctionErrorCode>([
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'RATE_LIMITED',
  'FUNCTION_CONFIG_ERROR',
  'PROVIDER_UNAVAILABLE',
  'BAD_REQUEST',
  'ORIGIN_NOT_ALLOWED',
  'METHOD_NOT_ALLOWED',
  'INTERNAL_ERROR',
])

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

function isSafeEdgeFunctionErrorCode(value: unknown): value is SafeEdgeFunctionErrorCode {
  return typeof value === 'string' && SAFE_EDGE_FUNCTION_ERROR_CODES.has(value as SafeEdgeFunctionErrorCode)
}

async function readSafeErrorCode(res: Response): Promise<SafeEdgeFunctionErrorCode | undefined> {
  try {
    const data = await res.json() as { code?: unknown }
    return isSafeEdgeFunctionErrorCode(data?.code) ? data.code : undefined
  } catch {
    return undefined
  }
}

export function createEdgeChatFailure(
  category: EdgeChatFailureCategory,
  options: { status?: number; safeCode?: SafeEdgeFunctionErrorCode } = {},
): EdgeChatFailure {
  return {
    reason: category === 'aborted' ? 'aborted' : category === 'auth' || category === 'not-signed-in' ? 'auth' : 'error',
    category,
    status: options.status,
    safeCode: options.safeCode,
  }
}

export function isEdgeChatFailure(result: string | APIFailure | null): result is EdgeChatFailure {
  return result !== null && typeof result === 'object' && 'category' in result
}

export function getSafeEdgeFallbackMessage(failure: EdgeChatFailure | null | undefined): string | null {
  switch (failure?.category) {
    case 'not-configured':
      return 'Cloud chat is not configured in this build. I used local mode for this response.'
    case 'not-signed-in':
      return 'Cloud chat is available after you sign in. I used local mode for this response.'
    case 'auth':
      return 'Cloud chat rejected the current session. I used local mode for this response.'
    case 'rate-limited':
      return 'Cloud chat is temporarily rate-limited. I used local mode for this response.'
    case 'not-found':
      return 'Cloud chat is not deployed or this build points at the wrong project. I used local mode for this response.'
    case 'provider':
      return 'Cloud chat is temporarily unavailable. I used local mode for this response.'
    case 'server':
      return 'Cloud chat had a temporary server error. I used local mode for this response.'
    case 'timeout':
      return 'Cloud chat timed out. I used local mode for this response.'
    case 'network':
      return 'Cloud chat could not be reached from this browser. I used local mode for this response.'
    case 'aborted':
    default:
      return null
  }
}

export function classifyEdgeStatusFailure(
  status: number,
  safeCode?: SafeEdgeFunctionErrorCode,
): EdgeChatFailure {
  if (status === 401 || status === 403) {
    return createEdgeChatFailure('auth', { status, safeCode })
  }
  if (status === 429) {
    return createEdgeChatFailure('rate-limited', { status, safeCode })
  }
  if (status === 404) {
    return createEdgeChatFailure('not-found', { status, safeCode })
  }
  if (status === 502 || status === 503) {
    return createEdgeChatFailure('provider', { status, safeCode })
  }
  return createEdgeChatFailure('server', { status, safeCode })
}

export function classifyEdgeTransportFailure(
  err: unknown,
  options: { timedOut?: boolean } = {},
): EdgeChatFailure {
  if ((err as Error).name === 'AbortError') {
    return createEdgeChatFailure(options.timedOut ? 'timeout' : 'aborted')
  }
  return createEdgeChatFailure('network')
}

/**
 * Call the daemon-chat Supabase Edge Function.
 * Returns the assistant reply or a typed safe failure classification.
 */
export async function callEdgeFunction(
  messages: APIMessage[],
  signal?: AbortSignal,
  metadata?: EdgeChatMetadata,
  diagnosticContext?: string,
): Promise<string | EdgeChatFailure> {
  const client = getClient()
  if (!client) return createEdgeChatFailure('not-configured')

  // Check for authenticated session
  const { data: sessionData } = await client.auth.getSession()
  const session = sessionData?.session
  if (!session) return createEdgeChatFailure('not-signed-in')

  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, EDGE_TIMEOUT_MS)

  if (signal?.aborted) {
    clearTimeout(timeoutId)
    return createEdgeChatFailure('aborted')
  }
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
        ...(diagnosticContext ? { diagnosticContext } : {}),
      }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      const safeCode = await readSafeErrorCode(res)
      const failure = classifyEdgeStatusFailure(res.status, safeCode)
      console.warn('[edge-chat] request failed', { category: failure.category, status: failure.status, safeCode: failure.safeCode })
      return failure
    }

    const data = (await res.json()) as { message?: string }
    if (typeof data.message !== 'string' || data.message.length === 0) {
      return createEdgeChatFailure('server', { status: 502, safeCode: 'INTERNAL_ERROR' })
    }
    return data.message
  } catch (err) {
    clearTimeout(timeoutId)
    const failure = classifyEdgeTransportFailure(err, { timedOut })
    console.warn(
      failure.category === 'network' ? '[edge-chat] request error' : '[edge-chat] request aborted',
      { category: failure.category },
    )
    return failure
  }
}
