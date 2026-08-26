import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import ts from 'typescript'
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

async function loadGitHubWriteServerModule() {
  vi.resetModules()
  const srcPath = path.join(
    path.resolve(process.cwd()),
    'supabase/functions/_shared/githubWriteAccess.ts',
  )
  const source = fs.readFileSync(srcPath, 'utf8').replace(
    "import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'",
    'const { createClient } = globalThis.__githubWriteTestDeps',
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const dataUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  return import(dataUrl)
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
        credentials: 'include',
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
    expect(migration).toContain('before update on public.github_write_audit')
    expect(migration).toContain("allowed_actions = array['create_issue']::text[]")
    expect(migration).toContain('authorization_expires_at')
    expect(migration).toContain("'connection-mutate'")
    expect(migration).toContain('increment_github_write_rate_limit')
    expect(migration).toContain('returning public.github_write_rate_limits.request_count into v_count;')
  })

  it('uses an atomic OAuth state, PKCE, GitHub API allowlisting, and installation narrowing', () => {
    expect(sharedFunction).toContain("GITHUB_API_ORIGIN = 'https://api.github.com'")
    expect(sharedFunction).toContain("GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'")
    expect(sharedFunction).toContain("code_challenge_method', 'S256'")
    expect(sharedFunction).toContain('code_verifier_ciphertext')
    expect(sharedFunction).toContain('OAUTH_BINDING_COOKIE_NAME')
    expect(sharedFunction).toContain('readCookie(req.headers.get(\'cookie\'), OAUTH_BINDING_COOKIE_NAME)')
    expect(sharedFunction).toContain('Set-Cookie')
    expect(sharedFunction).toContain('GITHUB_WRITE_ACCESS_ENCRYPTION_KEY')
    expect(sharedFunction).toContain(".from('github_write_oauth_states')")
    expect(sharedFunction).toContain('.delete()')
    expect(sharedFunction).toContain('repository_ids: [Number(repositoryId)]')
    expect(sharedFunction).toContain('verifyInstallationRepository')
  })

  it('only exposes issue creation and protects retries with an idempotency record', () => {
    expect(sharedFunction).toContain("confirmation !== 'CREATE_GITHUB_ISSUE'")
    expect(sharedFunction).toContain("action: 'create_issue'")
    expect(sharedFunction).toContain("action: 'repository_connected', connection: refreshedConnection")
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

  it('derives the write CORS origin from the dedicated app URL', () => {
    expect(sharedFunction).toContain("Deno.env.get('GITHUB_WRITE_ACCESS_APP_URL')")
    expect(sharedFunction).toContain("url.hostname.endsWith('.github.io')")
    expect(sharedFunction).not.toContain("https://dmankv.github.io")
  })
})

describe('GitHub write issue creation behavior', () => {
  const serverEnvironment: Record<string, string> = {}

  type Connection = {
    id: string
    user_id: string
    github_user_id: string
    installation_id: string
    repository_id: string
    repository_full_name: string
    allowed_actions: string[]
    authorization_expires_at: string
    connected_at: string
    last_used_at: string | null
  }

  type Idempotency = {
    user_id: string
    connection_id: string
    idempotency_key: string
    request_hash: string
    status: 'pending' | 'succeeded' | 'unknown'
    issue_number: number | null
    issue_url: string | null
  }

  class MockService {
    connection: Connection
    idempotency = new Map<string, Idempotency>()
    auditActions: string[] = []
    concurrentClaim = false

    constructor(connection: Connection) {
      this.connection = { ...connection }
    }

    private key(userId: string, connectionId: string, idempotencyKey: string): string {
      return `${userId}:${connectionId}:${idempotencyKey}`
    }

    rpc() {
      return Promise.resolve({ data: [{ allowed: true }], error: null })
    }

    from(table: string) {
      const state = {
        filters: new Map<string, unknown>(),
        updatePayload: null as Record<string, unknown> | null,
      }
      const execute = async () => {
        if (table === 'github_write_audit') {
          return { error: null }
        }
        if (table === 'github_write_connections' && state.updatePayload) {
          if (typeof state.updatePayload.repository_full_name === 'string') {
            this.connection.repository_full_name = state.updatePayload.repository_full_name
          }
          if (typeof state.updatePayload.last_used_at === 'string') {
            this.connection.last_used_at = state.updatePayload.last_used_at
          }
          return { error: null }
        }
        if (table === 'github_write_idempotency' && state.updatePayload) {
          const key = this.key(
            String(state.filters.get('user_id')),
            String(state.filters.get('connection_id')),
            String(state.filters.get('idempotency_key')),
          )
          const current = this.idempotency.get(key)
          if (current) {
            this.idempotency.set(key, {
              ...current,
              ...state.updatePayload,
            } as Idempotency)
          }
          return { error: null }
        }
        return { error: null }
      }

      const builder = {
        select: () => builder,
        insert: (payload: Record<string, unknown>) => {
          if (table === 'github_write_audit') {
            this.auditActions.push(String(payload.action ?? ''))
            return Promise.resolve({ error: null })
          }
          if (table === 'github_write_idempotency') {
            const userId = String(payload.user_id)
            const connectionId = String(payload.connection_id)
            const idempotencyKey = String(payload.idempotency_key)
            const key = this.key(userId, connectionId, idempotencyKey)
            if (this.concurrentClaim && !this.idempotency.has(key)) {
              this.idempotency.set(key, {
                user_id: userId,
                connection_id: connectionId,
                idempotency_key: idempotencyKey,
                request_hash: String(payload.request_hash),
                status: 'succeeded',
                issue_number: 44,
                issue_url: `https://github.com/${this.connection.repository_full_name}/issues/44`,
              })
              return Promise.resolve({ error: { code: '23505' } })
            }
            this.idempotency.set(key, {
              user_id: userId,
              connection_id: connectionId,
              idempotency_key: idempotencyKey,
              request_hash: String(payload.request_hash),
              status: String(payload.status) as Idempotency['status'],
              issue_number: null,
              issue_url: null,
            })
            return Promise.resolve({ error: null })
          }
          return Promise.resolve({ error: null })
        },
        delete: () => builder,
        update: (payload: Record<string, unknown>) => {
          state.updatePayload = payload
          return builder
        },
        eq: (column: string, value: unknown) => {
          state.filters.set(column, value)
          return builder
        },
        lt: () => builder,
        gt: () => builder,
        maybeSingle: async () => {
          if (table === 'github_write_connections') {
            const id = state.filters.get('id')
            const userId = state.filters.get('user_id')
            if (id === this.connection.id && userId === this.connection.user_id) {
              return { data: this.connection, error: null }
            }
            return { data: null, error: null }
          }
          if (table === 'github_write_idempotency') {
            const key = this.key(
              String(state.filters.get('user_id')),
              String(state.filters.get('connection_id')),
              String(state.filters.get('idempotency_key')),
            )
            return { data: this.idempotency.get(key) ?? null, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
          execute().then(resolve, reject),
      }
      return builder
    }
  }

  const connection: Connection = {
    id: '00000000-0000-4000-8000-000000000111',
    user_id: '00000000-0000-4000-8000-000000000999',
    github_user_id: '123',
    installation_id: '456',
    repository_id: '789',
    repository_full_name: 'dmankv/Project-HELEN',
    allowed_actions: ['create_issue'],
    authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
    connected_at: '2026-08-25T00:00:00.000Z',
    last_used_at: null,
  }

  function issueRequest() {
    return {
      connectionId: connection.id,
      idempotencyKey: '00000000-0000-4000-8000-000000000123',
      title: 'Behavioral test issue',
      body: 'Body',
      confirmRepository: 'dmankv/Project-HELEN',
      confirmed: true,
      confirmation: 'CREATE_GITHUB_ISSUE',
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    const encryptionKey = Buffer.alloc(32, 7).toString('base64url')
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString()
    Object.assign(serverEnvironment, {
      SUPABASE_URL: 'https://project-helen.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role',
      SUPABASE_ANON_KEY: 'anon-key',
      GITHUB_WRITE_ACCESS_ENCRYPTION_KEY: encryptionKey,
      GITHUB_APP_ID: '1',
      GITHUB_APP_CLIENT_ID: 'client-id',
      GITHUB_APP_CLIENT_SECRET: 'client-secret',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_WRITE_ACCESS_APP_URL: 'https://github-write.example.com/',
    })
    vi.stubGlobal('Deno', {
      env: {
        get: (key: string) => serverEnvironment[key] ?? '',
      },
    })
    vi.stubGlobal('__githubWriteTestDeps', { createClient: vi.fn() })
    vi.stubGlobal('fetch', vi.fn())
  })

  it('allows only the configured dedicated browser origin', async () => {
    const { getAllowedGitHubWriteOrigin } = await loadGitHubWriteServerModule()
    expect(getAllowedGitHubWriteOrigin('https://github-write.example.com')).toBe(
      'https://github-write.example.com',
    )
    expect(getAllowedGitHubWriteOrigin('https://dmankv.github.io')).toBeNull()
    expect(getAllowedGitHubWriteOrigin('https://other-project.github.io')).toBeNull()

    serverEnvironment.GITHUB_WRITE_ACCESS_APP_URL = 'http://localhost:5173/'
    const localhostOriginModule = await loadGitHubWriteServerModule()
    expect(localhostOriginModule.getAllowedGitHubWriteOrigin('http://localhost:5173')).toBe(
      'http://localhost:5173',
    )
    expect(localhostOriginModule.getAllowedGitHubWriteOrigin('http://localhost:4173')).toBeNull()

    serverEnvironment.GITHUB_WRITE_ACCESS_APP_URL = 'https://dmankv.github.io/Project-HELEN/'
    const invalidOriginModule = await loadGitHubWriteServerModule()
    expect(invalidOriginModule.getAllowedGitHubWriteOrigin('https://dmankv.github.io')).toBeNull()

    serverEnvironment.GITHUB_WRITE_ACCESS_APP_URL = ''
    const missingOriginModule = await loadGitHubWriteServerModule()
    expect(missingOriginModule.getAllowedGitHubWriteOrigin('https://github-write.example.com')).toBeNull()
  })

  it('enforces ownership and current authorization before creating issues', async () => {
    const { createGitHubIssue } = await loadGitHubWriteServerModule()
    const unauthorizedService = new MockService(connection)

    await expect(createGitHubIssue(unauthorizedService, 'other-user', issueRequest()))
      .rejects.toMatchObject({ code: 'CONNECTION_NOT_FOUND' })

    const expiredService = new MockService({
      ...connection,
      authorization_expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    await expect(createGitHubIssue(expiredService, connection.user_id, issueRequest()))
      .rejects.toMatchObject({ code: 'REPOSITORY_AUTHORIZATION_EXPIRED' })
  })

  it('re-verifies the repository before issue creation', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token-1234' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: Number(connection.repository_id),
        full_name: 'dmankv/Other-Repo',
      }), { status: 200 }))
    const { createGitHubIssue } = await loadGitHubWriteServerModule()
    const service = new MockService(connection)

    await expect(createGitHubIssue(service, connection.user_id, issueRequest()))
      .rejects.toMatchObject({ code: 'WRITE_NOT_CONFIRMED' })
  })

  it('returns the concurrent idempotency winner result', async () => {
    const { createGitHubIssue } = await loadGitHubWriteServerModule()
    const service = new MockService(connection)
    service.concurrentClaim = true

    const issue = await createGitHubIssue(service, connection.user_id, issueRequest())

    expect(issue).toEqual({
      issueNumber: 44,
      issueUrl: 'https://github.com/dmankv/Project-HELEN/issues/44',
    })
  })

  it('stores succeeded on success and unknown on downstream failure', async () => {
    const { createGitHubIssue } = await loadGitHubWriteServerModule()
    const successService = new MockService(connection)
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token-1234' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: Number(connection.repository_id),
        full_name: connection.repository_full_name,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 51,
        html_url: 'https://github.com/dmankv/Project-HELEN/issues/51',
      }), { status: 201 }))

    const successIssue = await createGitHubIssue(successService, connection.user_id, issueRequest())
    expect(successIssue.issueNumber).toBe(51)
    expect(Array.from(successService.idempotency.values())[0]?.status).toBe('succeeded')

    vi.mocked(fetch).mockReset()
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token-1234' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: Number(connection.repository_id),
        full_name: connection.repository_full_name,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))

    const failureService = new MockService(connection)
    await expect(createGitHubIssue(failureService, connection.user_id, {
      ...issueRequest(),
      idempotencyKey: '00000000-0000-4000-8000-000000000124',
    })).rejects.toMatchObject({ code: 'GITHUB_UNAVAILABLE' })
    const failureRecord = Array.from(failureService.idempotency.values())[0]
    expect(failureRecord?.status).toBe('unknown')
  })
})
