/**
 * Daemon Chat API Client
 *
 * Calls the configured backend when VITE_DAEMON_API_URL is set.
 * Falls back to null (caller uses local brain) when not configured or on error.
 *
 * Environment variable (frontend):
 *   VITE_DAEMON_API_URL   e.g. https://api.example.com
 *                        Leave unset to always use the local brain.
 */

export interface APIMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface APIResponse {
  message: string
}

/** Reason the API call did not return a message. */
export type APIFailureReason = 'auth' | 'error' | 'aborted'

/** Structured result returned when the backend call does not produce a message. */
export interface APIFailure {
  reason: APIFailureReason
  /** HTTP status code when available (e.g. 401, 403, 502). */
  status?: number
}

const env = (import.meta as { env?: Record<string, string> }).env ?? {}
const BASE_URL: string = env.VITE_DAEMON_API_URL ?? env.VITE_HELEN_API_URL ?? ''

const API_TIMEOUT_MS = 8_000

/**
 * Call the backend /api/chat endpoint.
 * Returns the assistant reply on success, or an APIFailure describing why it failed.
 * Returns null when the backend is not configured (local-brain mode with no failure).
 */
export async function callChatAPI(
  messages: APIMessage[],
  signal?: AbortSignal,
): Promise<string | APIFailure | null> {
  if (!BASE_URL) return null

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
  // Forward external cancellation into our internal controller
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.error(`[daemon-api] Auth error: ${res.status}`)
        return { reason: 'auth', status: res.status }
      }
      console.warn(`[daemon-api] Request failed: ${res.status}`)
      return { reason: 'error', status: res.status }
    }

    const data = (await res.json()) as APIResponse
    return data.message ?? null
  } catch (err) {
    clearTimeout(timeoutId)
    if ((err as Error).name === 'AbortError') {
      console.warn('[daemon-api] Request aborted')
      return { reason: 'aborted' }
    }
    console.warn('[daemon-api] Request error:', (err as Error).message)
    return { reason: 'error' }
  }
}

/** True when a backend URL is configured. */
export function hasBackend(): boolean {
  return BASE_URL.length > 0
}

/** Type guard: check if a callChatAPI result is a failure. */
export function isAPIFailure(result: string | APIFailure | null): result is APIFailure {
  return result !== null && typeof result === 'object'
}
