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
  return import('../src/services/githubWriteAccess')
}

describe('GitHub write browser client', () => {
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

  it('does not start GitHub authorization without explicit consent', async () => {
    const { beginGitHubWriteAuthorization } = await loadModule()

    const result = await beginGitHubWriteAuthorization(false)

    expect(result).toEqual({ ok: false, code: 'WRITE_NOT_CONFIRMED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not submit an issue without final confirmation', async () => {
    const { createGitHubIssue } = await loadModule()

    const result = await createGitHubIssue({
      connectionId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
      title: 'Reviewed issue',
      body: 'Body',
      confirmRepository: 'dmankv/Project-HELEN',
      confirmed: false,
    })

    expect(result).toEqual({ ok: false, code: 'WRITE_NOT_CONFIRMED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('uses only the signed-in Supabase token to begin consented authorization', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      expiresAt: '2026-08-25T17:00:00.000Z',
    }), { status: 200 }))
    const { beginGitHubWriteAuthorization } = await loadModule()

    const result = await beginGitHubWriteAuthorization(true)

    expect(result).toEqual({
      ok: true,
      data: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        expiresAt: '2026-08-25T17:00:00.000Z',
      },
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.supabase.co/functions/v1/github-write-access',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: ['Bearer', 'user-session-token'].join(' '),
        }),
      }),
    )
  })

  it('does not surface unrecognized server failure codes', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: 'INTERNAL_ERROR',
      error: 'sensitive implementation detail',
    }), { status: 500 }))
    const { beginGitHubWriteAuthorization } = await loadModule()

    const result = await beginGitHubWriteAuthorization(true)

    expect(result).toEqual({ ok: false, code: 'unavailable' })
  })

  it('preserves the safe repository-authorization-expired failure code', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: 'REPOSITORY_AUTHORIZATION_EXPIRED',
    }), { status: 403 }))
    const { beginGitHubWriteAuthorization } = await loadModule()

    const result = await beginGitHubWriteAuthorization(true)

    expect(result).toEqual({ ok: false, code: 'REPOSITORY_AUTHORIZATION_EXPIRED' })
  })
})

describe('GitHub write server boundaries', () => {
  const repoRoot = path.resolve(process.cwd())
  const migration = fs.readFileSync(
    path.join(repoRoot, 'supabase/migrations/20260825162000_github_write_access.sql'),
    'utf8',
  )
  const sharedFunction = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/_shared/githubWriteAccess.ts'),
    'utf8',
  )
  const accessFunction = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/github-write-access/index.ts'),
    'utf8',
  )
  const writeFunction = fs.readFileSync(
    path.join(repoRoot, 'supabase/functions/github-write/index.ts'),
    'utf8',
  )
  const browserClient = fs.readFileSync(
    path.join(repoRoot, 'src/services/githubWriteAccess.ts'),
    'utf8',
  )

  it('keeps GitHub authorization, connections, limits, idempotency, and audit data private', () => {
    const normalized = migration.toLowerCase()
    for (const table of [
      'github_write_oauth_states',
      'github_write_eligible_repositories',
      'github_write_connections',
      'github_write_rate_limits',
      'github_write_idempotency',
      'github_write_audit',
    ]) {
      expect(normalized).toContain(`alter table public.${table} enable row level security;`)
      expect(normalized).toContain(`revoke all on table public.${table} from authenticated;`)
    }
    expect(migration).toContain('GitHub write connection identity is immutable')
    expect(migration).toContain('GitHub write audit records are append-only')
    expect(migration).toContain("allowed_actions = array['create_issue']::text[]")
    expect(migration).toContain('authorization_expires_at')
    expect(migration).toContain("'connection-mutate'")
    expect(migration).toContain('increment_github_write_rate_limit')
  })

  it('uses an atomic OAuth state, PKCE, GitHub API allowlisting, and installation narrowing', () => {
    expect(sharedFunction).toContain("GITHUB_API_ORIGIN = 'https://api.github.com'")
    expect(sharedFunction).toContain("GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'")
    expect(sharedFunction).toContain("code_challenge_method', 'S256'")
    expect(sharedFunction).toContain('code_verifier_ciphertext')
    expect(sharedFunction).toContain('GITHUB_WRITE_ACCESS_ENCRYPTION_KEY')
    expect(sharedFunction).toContain(".from('github_write_oauth_states')")
    expect(sharedFunction).toContain('.delete()')
    expect(sharedFunction).toContain('repository_ids: [Number(repositoryId)]')
    expect(sharedFunction).toContain('verifyInstallationRepository')
  })

  it('only exposes issue creation and protects retries with an idempotency record', () => {
    expect(sharedFunction).toContain("confirmation !== 'CREATE_GITHUB_ISSUE'")
    expect(sharedFunction).toContain("action: 'create_issue'")
    expect(sharedFunction).toContain("status: 'pending'")
    expect(sharedFunction).toContain("status: 'succeeded'")
    expect(sharedFunction).toContain("status: 'unknown'")
    expect(sharedFunction).toContain('hmacSha256Hex')
    expect(sharedFunction).toContain('requireCurrentGitHubAuthorization')
    expect(sharedFunction).toContain('IDEMPOTENCY_RETENTION_MS')
    expect(sharedFunction).not.toContain("'/pulls")
    expect(sharedFunction).not.toContain("'/contents")
  })

  it('authenticates access and issue-write callers before reading browser input', () => {
    expect(accessFunction.indexOf('authenticateGitHubWriteRequest(req)')).toBeLessThan(
      accessFunction.indexOf('await req.json()'),
    )
    expect(writeFunction.indexOf('authenticateGitHubWriteRequest(req)')).toBeLessThan(
      writeFunction.indexOf('await req.json()'),
    )
  })

  it('keeps GitHub App credentials and OAuth endpoints out of the browser client', () => {
    expect(browserClient).not.toContain('GITHUB_APP_PRIVATE_KEY')
    expect(browserClient).not.toContain('GITHUB_APP_CLIENT_SECRET')
    expect(browserClient).not.toContain('github.com/login/oauth')
    expect(browserClient).toContain("confirmation: 'CREATE_GITHUB_ISSUE'")
  })
})
