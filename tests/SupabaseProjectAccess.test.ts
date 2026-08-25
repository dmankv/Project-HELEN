import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: mockGetSession,
    },
  })),
}))

async function loadModule() {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://gateway.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key')
  return import('../src/services/supabaseProjectAccess')
}

describe('Supabase project access browser client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubGlobal('fetch', vi.fn())
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'user-session-token' } },
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not make a connection request without explicit consent', async () => {
    const { beginProjectAccessConnection } = await loadModule()

    const result = await beginProjectAccessConnection('abcdefghijklmnopqrst', false)

    expect(result).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects invalid project references before a request is made', async () => {
    const { beginProjectAccessConnection } = await loadModule()

    const result = await beginProjectAccessConnection('not-a-valid-project-ref!', true)

    expect(result).toEqual({ ok: false, code: 'BAD_REQUEST' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses the signed-in user token only to start a consented connection', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: 'https://oauth.example.test/authorize',
      expiresAt: '2026-08-25T09:00:00.000Z',
    }), { status: 200 }))
    const { beginProjectAccessConnection } = await loadModule()

    const result = await beginProjectAccessConnection('abcdefghijklmnopqrst', true)

    expect(result).toEqual({
      ok: true,
      data: {
        authorizationUrl: 'https://oauth.example.test/authorize',
        expiresAt: '2026-08-25T09:00:00.000Z',
      },
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.supabase.co/functions/v1/supabase-project-access',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: ['Bearer', 'user-session-token'].join(' '),
        }),
      }),
    )
  })

  it('redacts and labels data again before it can be used as Daemon context', async () => {
    const { formatLogsForDaemon } = await loadModule()

    const context = formatLogsForDaemon({
      entries: [{
        authorization: 'credential-value',
        message: 'access_token=example-token-value contact user@example.com',
      }],
      redactionApplied: true,
      untrusted: true,
      service: 'edge-function-runtime',
      startAt: '2026-08-25T08:00:00.000Z',
      endAt: '2026-08-25T08:15:00.000Z',
    })

    expect(context).toContain('"trust":"untrusted"')
    expect(context).toContain('[REDACTED]')
    expect(context).not.toContain('example-token-value')
    expect(context).not.toContain('user@example.com')
  })
})

describe('Supabase project access server boundaries', () => {
  const repoRoot = path.resolve(process.cwd())
  const migration = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260825083000_supabase_project_access.sql'),
    'utf8',
  )
  const sharedFunction = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/_shared/supabaseProjectAccess.ts'),
    'utf8',
  )
  const secretWriteFunction = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/supabase-project-secret-write/index.ts'),
    'utf8',
  )

  it('keeps OAuth state, connection ciphertext, rate limits, and audit records private', () => {
    const normalized = migration.toLowerCase()
    for (const table of [
      'supabase_mcp_connections',
      'supabase_mcp_oauth_states',
      'supabase_mcp_rate_limits',
      'supabase_mcp_access_audit',
    ]) {
      expect(normalized).toContain(`alter table public.${table} enable row level security;`)
      expect(normalized).toContain(`revoke all on table public.${table} from authenticated;`)
    }
    expect(migration).toContain('supabase MCP connection owner is immutable')
    expect(migration).toContain('supabase MCP audit records are append-only')
    expect(migration).toContain('grant execute on function public.increment_supabase_mcp_rate_limit')
  })

  it('hard-codes hosted MCP to a project-scoped read-only debugging connection', () => {
    expect(sharedFunction).toContain("url.searchParams.set('read_only', 'true')")
    expect(sharedFunction).toContain("url.searchParams.set('features', 'debugging')")
    expect(sharedFunction).toContain('MAX_LOG_WINDOW_MS = 60 * 60 * 1000')
    expect(sharedFunction).toContain('MAX_LOG_LIMIT = 100')
    expect(sharedFunction).toContain('SUPABASE_MCP_SECRET_WRITE_CLIENT_ID')
    expect(sharedFunction).toContain('clientId === readClientId')
    expect(sharedFunction).toContain("action: 'logs_read'")
  })

  it('does not use a secret-list read endpoint and discards secret-write responses', () => {
    expect(sharedFunction).not.toMatch(/method:\s*'GET'[\s\S]{0,300}\/secrets/)
    expect(sharedFunction).toContain('await response.body?.cancel()')
    expect(sharedFunction).toContain("action: 'secret_write_succeeded'")
  })

  it('authenticates secret-write callers before reading the request body', () => {
    expect(secretWriteFunction.indexOf('authenticateRequest(req)')).toBeLessThan(
      secretWriteFunction.indexOf('await req.json()'),
    )
  })
})
