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

async function loadModule(enabled = true) {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://gateway.supabase.co')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-test-key')
  vi.stubEnv('VITE_GITHUB_WRITE_ACCESS_ENABLED', enabled ? 'true' : 'false')
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
    sessionStorage.clear()
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

  it('requires the dedicated-origin capability flag', async () => {
    const { isGitHubWriteAccessConfigured } = await loadModule(false)

    expect(isGitHubWriteAccessConfigured()).toBe(false)
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

  it('stores a session-only binding before beginning consented authorization', async () => {
    const state = 'oauth-state-token-for-browser-binding-123456'
    const browserBinding = 'oauth-browser-binding-token-for-session-123'
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: `https://github.com/login/oauth/authorize?state=${state}`,
      expiresAt: '2026-08-25T17:00:00.000Z',
      browserBinding,
    }), { status: 200 }))
    const { beginGitHubWriteAuthorization } = await loadModule()

    const result = await beginGitHubWriteAuthorization(true)

    expect(result).toEqual({
      ok: true,
      data: {
        authorizationUrl: `https://github.com/login/oauth/authorize?state=${state}`,
        expiresAt: '2026-08-25T17:00:00.000Z',
      },
    })
    expect(sessionStorage.getItem(`project-helen-github-write-oauth-binding:${state}`)).toBe(browserBinding)
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.supabase.co/functions/v1/github-write-access',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        headers: expect.objectContaining({
          Authorization: ['Bearer', 'user-session-token'].join(' '),
        }),
      }),
    )
  })

  it('completes authorization with and removes the session-only binding', async () => {
    const state = 'oauth-state-token-for-browser-binding-123456'
    const code = 'github-authorization-code-123456'
    const browserBinding = 'oauth-browser-binding-token-for-session-123'
    sessionStorage.setItem(`project-helen-github-write-oauth-binding:${state}`, browserBinding)
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      authorized: true,
    }), { status: 200 }))
    const { completeGitHubWriteAuthorization } = await loadModule()

    const result = await completeGitHubWriteAuthorization(state, code)

    expect(result).toEqual({ ok: true, data: { authorized: true } })
    expect(sessionStorage.getItem(`project-helen-github-write-oauth-binding:${state}`)).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.supabase.co/functions/v1/github-write-access',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify({
          action: 'complete-authorization',
          state,
          code,
          browserBinding,
        }),
      }),
    )
  })

  it('rejects an OAuth callback that has no session-only binding', async () => {
    const { completeGitHubWriteAuthorization } = await loadModule()

    const result = await completeGitHubWriteAuthorization(
      'oauth-state-token-for-browser-binding-123456',
      'github-authorization-code-123456',
    )

    expect(result).toEqual({ ok: false, code: 'OAUTH_DENIED' })
    expect(fetch).not.toHaveBeenCalled()
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
    expect(sharedFunction).toContain('browserBinding')
    expect(sharedFunction).toContain('completeGitHubWriteAuthorization')
    expect(sharedFunction).not.toContain('OAUTH_BINDING_COOKIE_NAME')
    expect(sharedFunction).not.toContain('SameSite=None')
    expect(accessFunction).toContain("case 'complete-authorization'")
    expect(browserClient).toContain('sessionStorage')
    expect(browserClient).toContain("credentials: 'omit'")
    const completionStart = sharedFunction.indexOf('export async function completeGitHubWriteAuthorization')
    const completionEnd = sharedFunction.indexOf('export async function listEligibleGitHubRepositories', completionStart)
    const completion = sharedFunction.slice(completionStart, completionEnd)
    expect(completion).toContain(".eq('user_id', userId)")
    expect(completion).toContain('secret.browserBinding !== browserBinding')
    expect(completion.indexOf('.select(')).toBeLessThan(completion.indexOf('.delete()'))
    expect(completion).toContain(".gt('expires_at', now)")
    expect(completion).toContain(".gt('expires_at', new Date().toISOString())")
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

  type OAuthStateRow = {
    state_hash: string
    user_id: string
    code_verifier_ciphertext: string
    expires_at: string
  }

  type EligibleRepositoryRow = {
    user_id: string
    github_user_id: string
    installation_id: string
    repository_id: string
    repository_full_name: string
    expires_at: string
  }

  class OAuthMockService {
    oauthStates = new Map<string, OAuthStateRow>()
    eligibleRepositories: EligibleRepositoryRow[] = []
    auditActions: string[] = []

    rpc() {
      return Promise.resolve({ data: [{ allowed: true }], error: null })
    }

    from(table: string) {
      const filters = new Map<string, unknown>()
      let operation: 'delete' | null = null
      let before: { column: string; value: string } | null = null
      let after: { column: string; value: string } | null = null

      const rows = (): Array<OAuthStateRow | EligibleRepositoryRow> => {
        if (table === 'github_write_oauth_states') return Array.from(this.oauthStates.values())
        if (table === 'github_write_eligible_repositories') return this.eligibleRepositories
        return []
      }
      const matches = (row: OAuthStateRow | EligibleRepositoryRow): boolean => {
        const record = row as unknown as Record<string, unknown>
        for (const [column, value] of filters) {
          if (record[column] !== value) return false
        }
        if (before && !(String(record[before.column]) < before.value)) return false
        if (after && !(String(record[after.column]) > after.value)) return false
        return true
      }
      const matchingRows = () => rows().filter(matches)
      const removeRows = () => {
        const matching = new Set(matchingRows())
        if (table === 'github_write_oauth_states') {
          for (const [key, row] of this.oauthStates) {
            if (matching.has(row)) this.oauthStates.delete(key)
          }
        } else if (table === 'github_write_eligible_repositories') {
          this.eligibleRepositories = this.eligibleRepositories.filter(row => !matching.has(row))
        }
        return matchingRows()
      }
      const execute = async () => {
        if (operation === 'delete') removeRows()
        return { data: null, error: null }
      }
      const builder = {
        select: () => builder,
        insert: (payload: unknown) => {
          const records = Array.isArray(payload) ? payload : [payload]
          for (const record of records) {
            if (!record || typeof record !== 'object') continue
            const row = record as Record<string, unknown>
            if (table === 'github_write_oauth_states') {
              const state = row as unknown as OAuthStateRow
              this.oauthStates.set(state.state_hash, state)
            } else if (table === 'github_write_eligible_repositories') {
              this.eligibleRepositories.push(row as unknown as EligibleRepositoryRow)
            } else if (table === 'github_write_audit' && typeof row.action === 'string') {
              this.auditActions.push(row.action)
            }
          }
          return Promise.resolve({ error: null })
        },
        delete: () => {
          operation = 'delete'
          return builder
        },
        eq: (column: string, value: unknown) => {
          filters.set(column, value)
          return builder
        },
        lt: (column: string, value: string) => {
          before = { column, value }
          return builder
        },
        gt: (column: string, value: string) => {
          after = { column, value }
          return builder
        },
        maybeSingle: async () => {
          const row = matchingRows()[0] ?? null
          if (operation === 'delete' && row) {
            if (table === 'github_write_oauth_states') {
              this.oauthStates.delete((row as OAuthStateRow).state_hash)
            } else if (table === 'github_write_eligible_repositories') {
              this.eligibleRepositories = this.eligibleRepositories.filter(candidate => candidate !== row)
            }
          }
          return { data: row, error: null }
        },
        then: (
          resolve: (value: { data: null; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => execute().then(resolve, reject),
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

  it('returns OAuth callback values only in a fragment for authenticated completion', async () => {
    const { handleGitHubWriteOAuthCallback } = await loadGitHubWriteServerModule()
    const state = 'oauth-state-token-for-browser-binding-123456'
    const code = 'github-authorization-code-123456'

    const response = await handleGitHubWriteOAuthCallback(new Request(
      `https://project-helen.supabase.co/functions/v1/github-write-access?state=${state}&code=${code}`,
    ))

    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toBeNull()
    const redirect = new URL(response.headers.get('location') ?? '')
    expect(redirect.search).toBe('')
    const parameters = new URLSearchParams(redirect.hash.slice(redirect.hash.indexOf('?') + 1))
    expect(parameters.get('github_write')).toBe('complete')
    expect(parameters.get('github_write_state')).toBe(state)
    expect(parameters.get('github_write_code')).toBe(code)
  })

  it('returns an actionable message when an idempotent issue request is pending', async () => {
    const { safeGitHubWriteErrorMessage } = await loadGitHubWriteServerModule()

    expect(safeGitHubWriteErrorMessage('IDEMPOTENCY_PENDING')).toBe(
      'This issue request is still being processed. Retry shortly.',
    )
  })

  it('consumes OAuth state once, exchanges the code, and replaces eligible repositories', async () => {
    const {
      startGitHubWriteAuthorization,
      completeGitHubWriteAuthorization,
    } = await loadGitHubWriteServerModule()
    const service = new OAuthMockService()
    service.eligibleRepositories = [{
      user_id: connection.user_id,
      github_user_id: 'old-user',
      installation_id: 'old-installation',
      repository_id: 'old-repository',
      repository_full_name: 'owner/old-repository',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]
    const authorization = await startGitHubWriteAuthorization(
      service,
      connection.user_id,
      { consent: true },
    )
    const state = new URL(authorization.authorizationUrl).searchParams.get('state')
    if (!state) throw new Error('expected OAuth state')
    const code = 'github-authorization-code-123456'
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'github-user-token-1234' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 123 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        installations: [{ id: 456, permissions: { issues: 'write' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        repositories: [{ id: 789, full_name: 'dmankv/Project-HELEN' }],
      }), { status: 200 }))

    await completeGitHubWriteAuthorization(service, connection.user_id, {
      state,
      code,
      browserBinding: authorization.browserBinding,
    })

    const [, tokenRequest] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(JSON.parse(String(tokenRequest?.body))).toMatchObject({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code,
      code_verifier: expect.any(String),
    })
    expect(service.oauthStates.size).toBe(0)
    expect(service.eligibleRepositories).toEqual([{
      user_id: connection.user_id,
      github_user_id: '123',
      installation_id: '456',
      repository_id: '789',
      repository_full_name: 'dmankv/Project-HELEN',
      expires_at: expect.any(String),
    }])

    await expect(completeGitHubWriteAuthorization(service, connection.user_id, {
      state,
      code,
      browserBinding: authorization.browserBinding,
    })).rejects.toMatchObject({ code: 'OAUTH_DENIED' })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('rejects an OAuth completion whose browser binding does not match', async () => {
    const {
      startGitHubWriteAuthorization,
      completeGitHubWriteAuthorization,
    } = await loadGitHubWriteServerModule()
    const service = new OAuthMockService()
    const authorization = await startGitHubWriteAuthorization(
      service,
      connection.user_id,
      { consent: true },
    )
    const state = new URL(authorization.authorizationUrl).searchParams.get('state')
    if (!state) throw new Error('expected OAuth state')

    await expect(completeGitHubWriteAuthorization(service, connection.user_id, {
      state,
      code: 'github-authorization-code-123456',
      browserBinding: 'different-browser-binding-token-123456',
    })).rejects.toMatchObject({ code: 'OAUTH_DENIED' })

    expect(service.oauthStates.size).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an expired OAuth state before exchanging its authorization code', async () => {
    const {
      startGitHubWriteAuthorization,
      completeGitHubWriteAuthorization,
    } = await loadGitHubWriteServerModule()
    const service = new OAuthMockService()
    const authorization = await startGitHubWriteAuthorization(
      service,
      connection.user_id,
      { consent: true },
    )
    const state = new URL(authorization.authorizationUrl).searchParams.get('state')
    if (!state) throw new Error('expected OAuth state')
    const storedState = Array.from(service.oauthStates.values())[0]
    if (!storedState) throw new Error('expected stored OAuth state')
    storedState.expires_at = new Date(Date.now() - 60_000).toISOString()

    await expect(completeGitHubWriteAuthorization(service, connection.user_id, {
      state,
      code: 'github-authorization-code-123456',
      browserBinding: authorization.browserBinding,
    })).rejects.toMatchObject({ code: 'OAUTH_DENIED' })

    expect(service.oauthStates.size).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
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

  it('retains a pending idempotency key while the original request completes', async () => {
    const { createGitHubIssue } = await loadGitHubWriteServerModule()
    const service = new MockService(connection)
    const request = issueRequest()
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'installation-token-1234' }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: Number(connection.repository_id),
        full_name: connection.repository_full_name,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        number: 52,
        html_url: 'https://github.com/dmankv/Project-HELEN/issues/52',
      }), { status: 201 }))
    await createGitHubIssue(service, connection.user_id, request)
    const existing = Array.from(service.idempotency.values())[0]
    if (!existing) throw new Error('expected idempotency record')
    existing.status = 'pending'
    existing.issue_number = null
    existing.issue_url = null

    await expect(createGitHubIssue(service, connection.user_id, request))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_PENDING' })
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
