import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: mockGetSession,
    },
  })),
}))

async function loadModule(_tag: string) {
  vi.resetModules()
  return import('../src/services/supabaseEdgeChat')
}

function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

describe('supabaseEdgeChat diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('maps every failure category to a safe user-facing message', async () => {
    const { createEdgeChatFailure, getSafeEdgeFallbackMessage } = await loadModule('safe-messages')

    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('not-configured'))).toMatch(/not configured in this build/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('not-signed-in'))).toMatch(/after you sign in/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('auth'))).toMatch(/rejected the current session/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('rate-limited'))).toMatch(/temporarily rate-limited/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('not-found'))).toMatch(/not deployed or this build points at the wrong project/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('provider'))).toMatch(/temporarily unavailable/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('server'))).toMatch(/temporary server error/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('timeout'))).toMatch(/timed out/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('network'))).toMatch(/could not be reached from this browser/i)
    expect(getSafeEdgeFallbackMessage(createEdgeChatFailure('aborted'))).toBeNull()
  })

  it('classifies not-configured builds without making a request', async () => {
    const { callEdgeFunction, isEdgeChatFailure, getSafeEdgeFallbackMessage } = await loadModule('not-configured')
    const result = await callEdgeFunction([{ role: 'user', content: 'hello' }])
    expect(isEdgeChatFailure(result)).toBe(true)
    if (!isEdgeChatFailure(result)) return
    expect(result.category).toBe('not-configured')
    expect(getSafeEdgeFallbackMessage(result)).toMatch(/not configured/i)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('classifies missing sessions as not-signed-in', async () => {
    const { createEdgeChatFailure } = await loadModule('not-signed-in')
    expect(createEdgeChatFailure('not-signed-in')).toMatchObject({
      reason: 'auth',
      category: 'not-signed-in',
    })
  })

  it('classifies auth failures and ignores raw response text', async () => {
    const { classifyEdgeStatusFailure, getSafeEdgeFallbackMessage } = await loadModule('auth')
    const result = classifyEdgeStatusFailure(401, 'INVALID_TOKEN')
    expect(result.category).toBe('auth')
    expect(result.safeCode).toBe('INVALID_TOKEN')
    expect(getSafeEdgeFallbackMessage(result)).not.toContain('secret-token-should-not-leak')
  })

  it('classifies rate limits', async () => {
    const { classifyEdgeStatusFailure } = await loadModule('rate-limit')
    const result = classifyEdgeStatusFailure(429, 'RATE_LIMITED')
    expect(result.category).toBe('rate-limited')
    expect(result.safeCode).toBe('RATE_LIMITED')
  })

  it('classifies missing functions as not-found', async () => {
    const { classifyEdgeStatusFailure } = await loadModule('not-found')
    const result = classifyEdgeStatusFailure(404, 'METHOD_NOT_ALLOWED')
    expect(result.category).toBe('not-found')
  })

  it('classifies safe provider/config failures without leaking raw bodies', async () => {
    const { classifyEdgeStatusFailure, getSafeEdgeFallbackMessage } = await loadModule('provider')
    const result = classifyEdgeStatusFailure(503, 'FUNCTION_CONFIG_ERROR')
    expect(result.category).toBe('provider')
    expect(result.safeCode).toBe('FUNCTION_CONFIG_ERROR')
    expect(getSafeEdgeFallbackMessage(result)).not.toContain('OPENAI_API_KEY')
  })

  it('classifies other server errors', async () => {
    const { classifyEdgeStatusFailure } = await loadModule('server')
    const result = classifyEdgeStatusFailure(500, 'INTERNAL_ERROR')
    expect(result.category).toBe('server')
  })

  it('classifies browser timeouts separately from user aborts', async () => {
    const { classifyEdgeTransportFailure } = await loadModule('timeout')
    const result = classifyEdgeTransportFailure(abortError(), { timedOut: true })
    expect(result.category).toBe('timeout')
  })

  it('treats explicit user cancellation as aborted and shows no fallback message', async () => {
    const { classifyEdgeTransportFailure, getSafeEdgeFallbackMessage } = await loadModule('aborted')
    const result = classifyEdgeTransportFailure(abortError())
    expect(result.category).toBe('aborted')
    expect(getSafeEdgeFallbackMessage(result)).toBeNull()
  })

  it('classifies fetch connectivity failures as network errors', async () => {
    const { classifyEdgeTransportFailure, getSafeEdgeFallbackMessage } = await loadModule('network')
    const result = classifyEdgeTransportFailure(new TypeError('Failed to fetch secret-token'))
    expect(result.category).toBe('network')
    expect(getSafeEdgeFallbackMessage(result)).not.toContain('secret-token')
  })
})
