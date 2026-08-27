/**
 * Browser client for the narrow, server-side GitHub App issue-write channel.
 *
 * This module only uses the public Supabase URL/anon key and a signed-in
 * user's Supabase JWT. GitHub OAuth credentials, App keys, JWTs, and
 * installation tokens never enter the browser bundle or local storage.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

function publicEnvironment(name: string): string {
  const viteEnvironment = (import.meta as { env?: Record<string, string> }).env
  const nodeEnvironment = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> }
  }).process?.env
  return viteEnvironment?.[name] || nodeEnvironment?.[name] || ''
}

const SUPABASE_URL = publicEnvironment('VITE_SUPABASE_URL')
const SUPABASE_ANON_KEY = publicEnvironment('VITE_SUPABASE_ANON_KEY')
const GITHUB_WRITE_ACCESS_ENABLED = publicEnvironment('VITE_GITHUB_WRITE_ACCESS_ENABLED') === 'true'
const ACCESS_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/github-write-access`
const WRITE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/github-write`
const REPOSITORY_ID = /^[1-9][0-9]{0,15}$/
const REPOSITORY_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OAUTH_STATE_OR_BINDING = /^[A-Za-z0-9_-]{16,256}$/
const OAUTH_AUTHORIZATION_CODE = /^[A-Za-z0-9._~-]{8,4096}$/
const OAUTH_BINDING_STORAGE_PREFIX = 'project-helen-github-write-oauth-binding:'

export interface GitHubWriteConnectionSummary {
  id: string
  repositoryFullName: string
  allowedActions: ['create_issue']
  authorizationExpiresAt: string
  connectedAt: string
  lastUsedAt: string | null
}

export interface GitHubEligibleRepository {
  repositoryId: string
  repositoryFullName: string
  expiresAt: string
}

export interface GitHubIssueResult {
  issueNumber: number
  issueUrl: string
}

export type GitHubWriteFailureCode =
  | 'not-configured'
  | 'not-signed-in'
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'OAUTH_DENIED'
  | 'CONNECTION_NOT_FOUND'
  | 'REPOSITORY_NOT_ELIGIBLE'
  | 'REPOSITORY_AUTHORIZATION_EXPIRED'
  | 'WRITE_NOT_CONFIRMED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_PENDING'
  | 'GITHUB_ACCESS_DENIED'
  | 'ISSUE_REJECTED'
  | 'unavailable'

export interface GitHubWriteFailure {
  ok: false
  code: GitHubWriteFailureCode
}

export interface GitHubWriteSuccess<T> {
  ok: true
  data: T
}

export type GitHubWriteResult<T> = GitHubWriteSuccess<T> | GitHubWriteFailure

const SAFE_FAILURE_CODES = new Set<GitHubWriteFailureCode>([
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'RATE_LIMITED',
  'BAD_REQUEST',
  'OAUTH_DENIED',
  'CONNECTION_NOT_FOUND',
  'REPOSITORY_NOT_ELIGIBLE',
  'REPOSITORY_AUTHORIZATION_EXPIRED',
  'WRITE_NOT_CONFIRMED',
  'IDEMPOTENCY_CONFLICT',
  'GITHUB_ACCESS_DENIED',
  'ISSUE_REJECTED',
])

let client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null
  if (client) return client
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  return client
}

export function isGitHubWriteAccessConfigured(): boolean {
  return GITHUB_WRITE_ACCESS_ENABLED && SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

function safeCode(value: unknown): GitHubWriteFailureCode {
  return typeof value === 'string' && SAFE_FAILURE_CODES.has(value as GitHubWriteFailureCode)
    ? value as GitHubWriteFailureCode
    : 'unavailable'
}

async function invoke<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<GitHubWriteResult<T>> {
  const supabase = getClient()
  if (!supabase) return { ok: false, code: 'not-configured' }
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) return { ok: false, code: 'not-signed-in' }

  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        Authorization: ['Bearer', accessToken].join(' '),
      },
      body: JSON.stringify(body),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = payload && typeof payload === 'object'
        ? safeCode((payload as Record<string, unknown>).code)
        : 'unavailable'
      return { ok: false, code }
    }
    return { ok: true, data: payload as T }
  } catch {
    return { ok: false, code: 'unavailable' }
  }
}

function storeOAuthBrowserBinding(authorizationUrl: string, browserBinding: unknown): boolean {
  if (typeof browserBinding !== 'string' || !OAUTH_STATE_OR_BINDING.test(browserBinding)) return false
  let state: string | null
  try {
    state = new URL(authorizationUrl).searchParams.get('state')
  } catch {
    return false
  }
  if (!state || !OAUTH_STATE_OR_BINDING.test(state)) return false
  try {
    sessionStorage.setItem(`${OAUTH_BINDING_STORAGE_PREFIX}${state}`, browserBinding)
    return true
  } catch {
    return false
  }
}

function takeOAuthBrowserBinding(state: string): string | null {
  try {
    const key = `${OAUTH_BINDING_STORAGE_PREFIX}${state}`
    const binding = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return binding && OAUTH_STATE_OR_BINDING.test(binding) ? binding : null
  } catch {
    return null
  }
}

interface GitHubWriteAuthorizationResponse {
  authorizationUrl: string
  expiresAt: string
  browserBinding: string
}

export async function beginGitHubWriteAuthorization(
  consent: boolean,
): Promise<GitHubWriteResult<{ authorizationUrl: string; expiresAt: string }>> {
  if (!consent) return { ok: false, code: 'WRITE_NOT_CONFIRMED' }
  const result = await invoke<GitHubWriteAuthorizationResponse>(
    ACCESS_FUNCTION_URL,
    { action: 'authorize', consent: true },
  )
  if (!result.ok) return result
  if (!storeOAuthBrowserBinding(result.data.authorizationUrl, result.data.browserBinding)) {
    return { ok: false, code: 'unavailable' }
  }
  return {
    ok: true,
    data: {
      authorizationUrl: result.data.authorizationUrl,
      expiresAt: result.data.expiresAt,
    },
  }
}

export async function completeGitHubWriteAuthorization(
  state: string,
  code: string,
): Promise<GitHubWriteResult<{ authorized: true }>> {
  if (!OAUTH_STATE_OR_BINDING.test(state) || !OAUTH_AUTHORIZATION_CODE.test(code)) {
    return { ok: false, code: 'BAD_REQUEST' }
  }
  const browserBinding = takeOAuthBrowserBinding(state)
  if (!browserBinding) return { ok: false, code: 'OAUTH_DENIED' }
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'complete-authorization',
    state,
    code,
    browserBinding,
  })
}

export async function getEligibleGitHubRepositories(): Promise<GitHubWriteResult<{
  repositories: GitHubEligibleRepository[]
}>> {
  return invoke(ACCESS_FUNCTION_URL, { action: 'eligible-repositories' })
}

export async function connectGitHubWriteRepository(
  repositoryId: string,
  consent: boolean,
): Promise<GitHubWriteResult<{ connection: GitHubWriteConnectionSummary }>> {
  if (!consent || !REPOSITORY_ID.test(repositoryId)) {
    return { ok: false, code: 'WRITE_NOT_CONFIRMED' }
  }
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'connect',
    repositoryId,
    consent: true,
    confirmation: 'CONNECT_GITHUB_REPOSITORY',
  })
}

export async function getGitHubWriteConnections(): Promise<GitHubWriteResult<{
  connections: GitHubWriteConnectionSummary[]
}>> {
  return invoke(ACCESS_FUNCTION_URL, { action: 'status' })
}

export async function disconnectGitHubWriteConnection(
  connectionId: string,
): Promise<GitHubWriteResult<{ disconnected: true }>> {
  if (!UUID_V4.test(connectionId)) return { ok: false, code: 'BAD_REQUEST' }
  return invoke(ACCESS_FUNCTION_URL, { action: 'disconnect', connectionId })
}

export async function createGitHubIssue(
  request: {
    connectionId: string
    idempotencyKey: string
    title: string
    body: string
    confirmRepository: string
    confirmed: boolean
  },
): Promise<GitHubWriteResult<GitHubIssueResult>> {
  if (
    !request.confirmed ||
    !UUID_V4.test(request.connectionId) ||
    !UUID_V4.test(request.idempotencyKey) ||
    !REPOSITORY_FULL_NAME.test(request.confirmRepository) ||
    request.title.trim().length === 0
  ) {
    return { ok: false, code: 'WRITE_NOT_CONFIRMED' }
  }
  return invoke(WRITE_FUNCTION_URL, {
    ...request,
    confirmation: 'CREATE_GITHUB_ISSUE',
    confirmed: true,
  })
}
