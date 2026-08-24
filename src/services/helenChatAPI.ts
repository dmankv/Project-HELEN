/**
 * HELEN Chat API Client
 *
 * Calls the configured backend when VITE_HELEN_API_URL is set.
 * Falls back to null (caller uses local brain) when not configured or on error.
 *
 * Environment variable (frontend):
 *   VITE_HELEN_API_URL   e.g. https://api.example.com
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

const BASE_URL: string = import.meta.env.VITE_HELEN_API_URL ?? ''
const API_TOKEN: string = import.meta.env.VITE_HELEN_API_TOKEN ?? ''

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
      headers: {
        'Content-Type': 'application/json',
        ...(API_TOKEN ? { 'X-HELEN-API-TOKEN': API_TOKEN } : {}),
      },
      body: JSON.stringify({ messages }),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.error(`[helen-api] Auth error: ${res.status}`)
        return { reason: 'auth', status: res.status }
      }
      console.warn(`[helen-api] Request failed: ${res.status}`)
      return { reason: 'error', status: res.status }
    }

    const data = (await res.json()) as APIResponse
    return data.message ?? null
  } catch (err) {
    clearTimeout(timeoutId)
    if ((err as Error).name === 'AbortError') {
      console.warn('[helen-api] Request aborted')
      return { reason: 'aborted' }
    }
    console.warn('[helen-api] Request error:', (err as Error).message)
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
