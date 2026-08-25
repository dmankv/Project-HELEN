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

describe('createGitHubIssue behavioral boundaries', () => {
  const sharedFunction = fs.readFileSync(
    path.join(path.resolve(process.cwd()), 'supabase/functions/_shared/githubWriteAccess.ts'),
    'utf8',
  )

  it('scopes connection lookup to the requesting user (ownership validation)', () => {
    // getOwnedGitHubConnection must filter by both connection id and user_id so one
    // user cannot access another user's connection even if they know the UUID.
    const fn = sharedFunction.slice(sharedFunction.indexOf('async function getOwnedGitHubConnection('))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain(".eq('user_id', userId)")
    expect(body).toContain(".eq('id', connectionId)")
    // Connection ownership error must not leak whether the row exists.
    expect(body).toContain("'CONNECTION_NOT_FOUND'")
  })

  it('rejects expired authorizations before any write operation (expiry validation)', () => {
    // requireCurrentGitHubAuthorization must compare the stored expiry against
    // the current time and throw REPOSITORY_AUTHORIZATION_EXPIRED when elapsed.
    const fn = sharedFunction.slice(sharedFunction.indexOf('function requireCurrentGitHubAuthorization('))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('Date.parse(connection.authorization_expires_at)')
    expect(body).toContain('Date.now()')
    expect(body).toContain("'REPOSITORY_AUTHORIZATION_EXPIRED'")
    // The check must be a strict <=, not just <, so tokens expiring at this exact
    // millisecond are also rejected.
    expect(body).toMatch(/expiresAt\s*<=\s*Date\.now\(\)/)
    // createGitHubIssue must call requireCurrentGitHubAuthorization before any
    // database write or GitHub API call.
    const createFn = sharedFunction.slice(sharedFunction.indexOf('export async function createGitHubIssue('))
    const createBody = createFn.slice(0, createFn.indexOf('\n}') + 2)
    const authCheckPos = createBody.indexOf('requireCurrentGitHubAuthorization(connection)')
    const firstWritePos = Math.min(
      createBody.includes('enforceRateLimit') ? createBody.indexOf('enforceRateLimit') : Infinity,
      createBody.includes('claimIdempotency') ? createBody.indexOf('claimIdempotency') : Infinity,
      createBody.includes('mintInstallationToken') ? createBody.indexOf('mintInstallationToken') : Infinity,
    )
    expect(authCheckPos).toBeGreaterThanOrEqual(0)
    expect(authCheckPos).toBeLessThan(firstWritePos)
  })

  it('re-verifies repository identity via installation token, not only the cached name (repository re-verification)', () => {
    // verifyInstallationRepository must call the GitHub API using the installation
    // token to confirm the repository ID matches, then compare the live full_name
    // against confirmRepository rather than trusting the cached value alone.
    const fn = sharedFunction.slice(sharedFunction.indexOf('async function verifyInstallationRepository('))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain('/repositories/')
    expect(body).toContain('repository.full_name')
    expect(body).toContain('repository.id')
    // The live ID must be compared to the stored repositoryId, not accepted blindly.
    expect(body).toContain('!== repositoryId')

    // createGitHubIssue must call verifyInstallationRepository *after* minting the
    // token and then compare the returned name against confirmRepository.
    const createFn = sharedFunction.slice(sharedFunction.indexOf('export async function createGitHubIssue('))
    const createBody = createFn.slice(0, createFn.indexOf('\n}') + 2)
    const mintPos = createBody.indexOf('mintInstallationToken(connection)')
    const verifyPos = createBody.indexOf('verifyInstallationRepository(service, connection, installationToken)')
    const repoCheckPos = createBody.indexOf('repositoryFullName !== request.confirmRepository')
    expect(mintPos).toBeGreaterThanOrEqual(0)
    expect(verifyPos).toBeGreaterThan(mintPos)
    expect(repoCheckPos).toBeGreaterThan(verifyPos)
  })

  it('handles concurrent idempotency claims without double-submitting (idempotency)', () => {
    // claimIdempotency must attempt an insert; when a conflict occurs (another
    // concurrent request already inserted the same key) it reads back the existing
    // record and returns it as a previous result rather than retrying the issue
    // creation.  A null previous means this caller won the race and should proceed.
    const fn = sharedFunction.slice(sharedFunction.indexOf('async function claimIdempotency('))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain(".insert(")
    expect(body).toContain('findIdempotency(')
    expect(body).toContain('previous: null')
    expect(body).toContain('previous: idempotencyResult(')

    // createGitHubIssue must short-circuit when the claim returns a previous result
    // (the racing request already completed) without calling mintInstallationToken.
    const createFn = sharedFunction.slice(sharedFunction.indexOf('export async function createGitHubIssue('))
    const createBody = createFn.slice(0, createFn.indexOf('\n}') + 2)
    const claimPos = createBody.indexOf('claimIdempotency(')
    const previousCheckPos = createBody.indexOf('if (claim.previous) return claim.previous')
    const mintPos = createBody.indexOf('mintInstallationToken(connection)')
    expect(previousCheckPos).toBeGreaterThan(claimPos)
    expect(mintPos).toBeGreaterThan(previousCheckPos)
  })

  it('marks idempotency as unknown on failure and never as a terminal error (success/unknown transitions)', () => {
    // A failed issue creation must leave the idempotency record as 'unknown' so that
    // a retry can detect the ambiguous state and surface IDEMPOTENCY_CONFLICT rather
    // than silently re-submitting.  The record must never be deleted or left as
    // 'pending' after an error.
    const fn = sharedFunction.slice(sharedFunction.indexOf('async function markIdempotencyUnknown('))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    expect(body).toContain("status: 'unknown'")
    expect(body).not.toContain("status: 'failed'")

    // completeIdempotency must write 'succeeded' plus the real issue metadata.
    const completeFn = sharedFunction.slice(sharedFunction.indexOf('async function completeIdempotency('))
    const completeBody = completeFn.slice(0, completeFn.indexOf('\n}') + 2)
    expect(completeBody).toContain("status: 'succeeded'")
    expect(completeBody).toContain('issue.issueNumber')
    expect(completeBody).toContain('issue.issueUrl')

    // createGitHubIssue catch block must call markIdempotencyUnknown, not delete.
    const createFn = sharedFunction.slice(sharedFunction.indexOf('export async function createGitHubIssue('))
    const createBody = createFn.slice(0, createFn.indexOf('\n}') + 2)
    const catchPos = createBody.indexOf('} catch (error) {')
    const unknownCallPos = createBody.indexOf('markIdempotencyUnknown(', catchPos)
    expect(catchPos).toBeGreaterThanOrEqual(0)
    expect(unknownCallPos).toBeGreaterThan(catchPos)
    // The catch block must not call .delete() on the idempotency record.
    const catchBody = createBody.slice(catchPos)
    expect(catchBody).not.toMatch(/from\('github_write_idempotency'\)[\s\S]*?\.delete\(\)/)
  })
})
