import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: getSessionMock,
    },
  })),
}))

describe('admin diagnostics status research handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'token-123',
        },
      },
    })
  })

  it('preserves unavailable research status without synthesizing placeholder counters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        evolutionStatus: 'unavailable',
        evolution: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        diagnostics_status: 'unavailable',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    vi.stubGlobal('fetch', fetchMock)

    const { getAdminDiagnosticsStatus } = await import('../src/services/adminDaemonPersistence')
    const status = await getAdminDiagnosticsStatus()

    expect(status.researchStatus).toBe('unavailable')
    expect(status.research).toBeNull()
  })
})
