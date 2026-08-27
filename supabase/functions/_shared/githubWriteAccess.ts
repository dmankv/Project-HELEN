/**
 * Server-side GitHub App access for one intentionally narrow mutation:
 * creating an issue in a user-approved, App-installed repository.
 *
 * GitHub OAuth user tokens, GitHub App JWTs, installation tokens, private keys,
 * and client secrets never enter the browser, audit tables,
 * logs, or conversation state. User-supplied issue bodies and one-time
 * authorization URLs enter the browser transiently but are not persisted or logged.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

type ServiceClient = ReturnType<typeof createClient>
type GitHubRateScope = 'connect' | 'connection-mutate' | 'issue-create'
const OAUTH_STATE_OR_BINDING = /^[A-Za-z0-9_-]{16,256}$/
const ELIGIBLE_REPOSITORY_PAGE_SIZE = 20

interface SupabaseRuntimeConfig {
  supabaseUrl: string
  serviceRoleKey: string
  anonKey: string
}

interface OAuthStateSecret {
  verifier: string
  browserBinding: string
}

function encodeOAuthStateSecret(verifier: string, browserBinding: string): string {
  return JSON.stringify({ verifier, browserBinding })
}

function decodeOAuthStateSecret(value: string): OAuthStateSecret {
  if (!value.startsWith('{')) throw new GitHubWriteError('OAUTH_DENIED', 401)
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      typeof parsed.verifier === 'string'
      && typeof parsed.browserBinding === 'string'
      && OAUTH_STATE_OR_BINDING.test(parsed.browserBinding)
    ) {
      return { verifier: parsed.verifier, browserBinding: parsed.browserBinding }
    }
  } catch {
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
  throw new GitHubWriteError('OAUTH_DENIED', 401)
}

interface GitHubAppRuntimeConfig extends SupabaseRuntimeConfig {
  appId: string
  clientId: string
  clientSecret: string
  privateKey: string
}

interface OAuthState {
  state_hash: string
  user_id: string
  code_verifier_ciphertext: string
  expires_at: string
}

interface GitHubWriteConnection {
  id: string
  user_id: string
  github_user_id: string | number
  installation_id: string | number
  repository_id: string | number
  repository_full_name: string
  allowed_actions: unknown
  authorization_expires_at: string
  connected_at: string
  last_used_at: string | null
}

interface EligibleRepository {
  user_id: string
  github_user_id: string
  installation_id: string
  repository_id: string
  repository_full_name: string
  expires_at: string
}

interface IdempotencyRecord {
  request_hash: string
  status: 'pending' | 'succeeded' | 'unknown'
  issue_number: number | null
  issue_url: string | null
}

interface CreateIssueRequest {
  connectionId: string
  idempotencyKey: string
  title: string
  body: string
  confirmRepository: string
}

interface GitHubIssueMetadata {
  issueNumber: number
  issueUrl: string
}

export interface GitHubWriteConnectionSummary {
  id: string
  repositoryFullName: string
  allowedActions: ['create_issue']
  authorizationExpiresAt: string
  connectedAt: string
  lastUsedAt: string | null
}

export interface GitHubEligibleRepositorySummary {
  repositoryId: string
  repositoryFullName: string
  expiresAt: string
}

export type GitHubWriteErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'ORIGIN_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'FUNCTION_CONFIG_ERROR'
  | 'OAUTH_UNAVAILABLE'
  | 'OAUTH_DENIED'
  | 'CONNECTION_NOT_FOUND'
  | 'REPOSITORY_NOT_ELIGIBLE'
  | 'REPOSITORY_AUTHORIZATION_EXPIRED'
  | 'WRITE_NOT_CONFIRMED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_PENDING'
  | 'GITHUB_ACCESS_DENIED'
  | 'ISSUE_REJECTED'
  | 'GITHUB_UNAVAILABLE'
  | 'GITHUB_INVALID_RESPONSE'
  | 'INTERNAL_ERROR'

export class GitHubWriteError extends Error {
  constructor(
    readonly code: GitHubWriteErrorCode,
    readonly status: number,
  ) {
    super(code)
  }
}

export const GITHUB_WRITE_ACCESS_FUNCTION_NAME = 'github-write-access'
export const GITHUB_WRITE_FUNCTION_NAME = 'github-write'

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_ORIGIN = 'https://api.github.com'
const GITHUB_API_VERSION = '2022-11-28'
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const RATE_LIMIT_WINDOW_MS = 60_000
const CONNECT_RATE_LIMIT_MAX = 5
const CONNECTION_MUTATION_RATE_LIMIT_MAX = 10
const ISSUE_CREATE_RATE_LIMIT_MAX = 3
const GITHUB_REQUEST_TIMEOUT_MS = 20_000
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024
const MAX_ELIGIBLE_INSTALLATIONS = 20
const MAX_ELIGIBLE_REPOSITORIES = 100
const MAX_ISSUE_TITLE_BYTES = 256
const MAX_ISSUE_BODY_BYTES = 16 * 1024
const CONNECTION_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_GITHUB_ID = 9_007_199_254_740_991n
const REPOSITORY_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function configuredGitHubWriteAppUrl(): URL | null {
  const configured = Deno.env.get('GITHUB_WRITE_ACCESS_APP_URL')
  if (!configured) return null
  try {
    const url = new URL(configured)
    const isConfiguredLocalhost = (
      url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    )
    const isDedicatedHttpsOrigin = (
      url.protocol === 'https:'
      && url.hostname !== 'github.io'
      && !url.hostname.endsWith('.github.io')
    )
    if ((!isConfiguredLocalhost && !isDedicatedHttpsOrigin) || url.username || url.password) {
      return null
    }
    return url
  } catch {
    return null
  }
}

export function getAllowedGitHubWriteOrigin(requestOrigin: string | null): string | null {
  const appUrl = configuredGitHubWriteAppUrl()
  return requestOrigin && appUrl?.origin === requestOrigin ? requestOrigin : null
}

export function githubWriteCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function githubWriteJsonResponse(
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

export function safeGitHubWriteErrorMessage(code: GitHubWriteErrorCode): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Authentication required.'
    case 'INVALID_TOKEN':
      return 'Invalid or expired token.'
    case 'RATE_LIMITED':
      return 'Rate limit exceeded.'
    case 'BAD_REQUEST':
      return 'Invalid request.'
    case 'ORIGIN_NOT_ALLOWED':
      return 'Origin not allowed.'
    case 'METHOD_NOT_ALLOWED':
      return 'Method not allowed.'
    case 'OAUTH_DENIED':
      return 'GitHub authorization was denied or expired.'
    case 'CONNECTION_NOT_FOUND':
      return 'GitHub repository connection not found.'
    case 'REPOSITORY_NOT_ELIGIBLE':
      return 'That repository is not eligible for this GitHub App connection.'
    case 'REPOSITORY_AUTHORIZATION_EXPIRED':
      return 'GitHub authorization for that repository expired. Authorize and reconnect it again.'
    case 'WRITE_NOT_CONFIRMED':
      return 'Explicit issue-creation confirmation is required.'
    case 'IDEMPOTENCY_CONFLICT':
      return 'This issue request was already attempted. Create a new confirmed request to try again.'
    case 'GITHUB_ACCESS_DENIED':
      return 'GitHub denied access to that repository.'
    case 'ISSUE_REJECTED':
      return 'GitHub rejected the issue request.'
    case 'FUNCTION_CONFIG_ERROR':
    case 'OAUTH_UNAVAILABLE':
    case 'GITHUB_UNAVAILABLE':
    case 'GITHUB_INVALID_RESPONSE':
    case 'INTERNAL_ERROR':
    default:
      return 'GitHub issue access is temporarily unavailable.'
  }
}

export function githubWriteErrorResponse(
  error: unknown,
  headers: Record<string, string>,
): Response {
  if (error instanceof GitHubWriteError) {
    return githubWriteJsonResponse(
      { code: error.code, error: safeGitHubWriteErrorMessage(error.code) },
      error.status,
      headers,
    )
  }
  safeGitHubWriteDiagnostic('internal_error')
  return githubWriteJsonResponse(
    { code: 'INTERNAL_ERROR', error: safeGitHubWriteErrorMessage('INTERNAL_ERROR') },
    500,
    headers,
  )
}

export function safeGitHubWriteDiagnostic(
  event: string,
  metadata: Record<string, string | number | boolean> = {},
): void {
  console.warn('[github-write]', JSON.stringify({ event, ...metadata }))
}

function supabaseRuntimeConfig(): SupabaseRuntimeConfig {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  return { supabaseUrl, serviceRoleKey, anonKey }
}

function githubAppRuntimeConfig(): GitHubAppRuntimeConfig {
  const supabase = supabaseRuntimeConfig()
  const appId = Deno.env.get('GITHUB_APP_ID') ?? ''
  const clientId = Deno.env.get('GITHUB_APP_CLIENT_ID') ?? ''
  const clientSecret = Deno.env.get('GITHUB_APP_CLIENT_SECRET') ?? ''
  const privateKey = Deno.env.get('GITHUB_APP_PRIVATE_KEY') ?? ''
  if (
    !/^[0-9]{1,20}$/.test(appId) ||
    clientId.length === 0 ||
    clientId.length > 512 ||
    clientSecret.length === 0 ||
    clientSecret.length > 2048 ||
    privateKey.length === 0 ||
    privateKey.length > 32_768
  ) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  return {
    ...supabase,
    appId,
    clientId,
    clientSecret,
    privateKey,
  }
}

function serviceClient(): ServiceClient {
  const config = supabaseRuntimeConfig()
  return createClient(config.supabaseUrl, config.serviceRoleKey)
}

export async function authenticateGitHubWriteRequest(req: Request): Promise<{
  userId: string
  service: ServiceClient
}> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new GitHubWriteError('AUTH_REQUIRED', 401)
  }
  const config = supabaseRuntimeConfig()
  const userClient = createClient(config.supabaseUrl, config.anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) {
    throw new GitHubWriteError('INVALID_TOKEN', 401)
  }
  return { userId: data.user.id, service: serviceClient() }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return base64UrlEncode(bytes)
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

async function sha256Hex(value: string): Promise<string> {
  return Array.from(await sha256(value))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

function githubWriteEncryptionKeyBytes(): Uint8Array {
  const configured = Deno.env.get('GITHUB_WRITE_ACCESS_ENCRYPTION_KEY') ?? ''
  let bytes: Uint8Array
  try {
    bytes = base64UrlDecode(configured)
  } catch {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  if (bytes.byteLength !== 32) throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  return bytes
}

async function githubWriteEncryptionKey(): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'raw',
      githubWriteEncryptionKeyBytes(),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
}

async function encryptGitHubWriteState(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await githubWriteEncryptionKey()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)),
  )
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`
}

async function decryptGitHubWriteState(value: string): Promise<string> {
  const [version, ivEncoded, ciphertextEncoded, extra] = value.split('.')
  if (version !== 'v1' || !ivEncoded || !ciphertextEncoded || extra) {
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
  try {
    const key = await githubWriteEncryptionKey()
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivEncoded) },
      key,
      base64UrlDecode(ciphertextEncoded),
    )
    return new TextDecoder().decode(plaintext)
  } catch (error) {
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
}

async function hmacSha256Hex(value: string): Promise<string> {
  try {
    const label = new TextEncoder().encode('project-helen/github-write/idempotency/v1')
    const master = githubWriteEncryptionKeyBytes()
    const material = new Uint8Array(label.byteLength + master.byteLength)
    material.set(label)
    material.set(master, label.byteLength)
    const derived = await crypto.subtle.digest('SHA-256', material)
    const key = await crypto.subtle.importKey(
      'raw',
      derived,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)),
    )
    return Array.from(signature)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch (error) {
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
}

function callbackUri(): string {
  const config = supabaseRuntimeConfig()
  const expected = new URL(`/functions/v1/${GITHUB_WRITE_ACCESS_FUNCTION_NAME}`, config.supabaseUrl)
  const configured = Deno.env.get('GITHUB_WRITE_ACCESS_REDIRECT_URI')
  if (!configured) return expected.toString()
  try {
    const candidate = new URL(configured)
    if (
      candidate.origin !== expected.origin ||
      candidate.pathname !== expected.pathname ||
      candidate.search ||
      candidate.hash
    ) {
      throw new Error('unexpected callback URL')
    }
    return expected.toString()
  } catch {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
}

function callbackRedirect(
  outcome: 'complete' | 'denied' | 'failed',
  parameters: Record<string, string> = {},
): Response {
  const url = configuredGitHubWriteAppUrl()
  if (!url) {
    return new Response(null, {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    })
  }
  url.hash = `/?${new URLSearchParams({ github_write: outcome, ...parameters }).toString()}`
  return new Response(null, {
    status: 303,
    headers: {
      Location: url.toString(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function asRecord(value: unknown, code: GitHubWriteErrorCode): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubWriteError(code, 502)
  }
  return value as Record<string, unknown>
}

function assertGitHubId(value: unknown, code: GitHubWriteErrorCode = 'BAD_REQUEST'): string {
  const raw = typeof value === 'number'
    ? (Number.isSafeInteger(value) && value > 0 ? String(value) : '')
    : typeof value === 'string' ? value : ''
  if (!/^[1-9][0-9]{0,15}$/.test(raw)) throw new GitHubWriteError(code, 400)
  try {
    if (BigInt(raw) > MAX_GITHUB_ID) throw new Error('out of range')
  } catch {
    throw new GitHubWriteError(code, 400)
  }
  return raw
}

function assertConnectionId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  return value
}

function assertRepositoryFullName(value: unknown, code: GitHubWriteErrorCode = 'BAD_REQUEST'): string {
  if (typeof value !== 'string' || !REPOSITORY_FULL_NAME.test(value)) {
    throw new GitHubWriteError(code, 400)
  }
  return value
}

function assertIssueTitle(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  const title = value.trim()
  if (
    title.length === 0 ||
    /[\u0000-\u001F\u007F]/.test(title) ||
    new TextEncoder().encode(title).byteLength > MAX_ISSUE_TITLE_BYTES
  ) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  return title
}

function assertIssueBody(value: unknown): string {
  if (value === undefined) return ''
  if (
    typeof value !== 'string' ||
    value.includes('\u0000') ||
    new TextEncoder().encode(value).byteLength > MAX_ISSUE_BODY_BYTES
  ) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  return value
}

function assertIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  return value
}

function assertConfirmedObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  return body as Record<string, unknown>
}

function parseCreateIssueRequest(body: unknown): CreateIssueRequest {
  const request = assertConfirmedObject(body)
  if (request.confirmed !== true || request.confirmation !== 'CREATE_GITHUB_ISSUE') {
    throw new GitHubWriteError('WRITE_NOT_CONFIRMED', 403)
  }
  return {
    connectionId: assertConnectionId(request.connectionId),
    idempotencyKey: assertIdempotencyKey(request.idempotencyKey),
    title: assertIssueTitle(request.title),
    body: assertIssueBody(request.body),
    confirmRepository: assertRepositoryFullName(request.confirmRepository),
  }
}

async function cleanupExpiredRecords(service: ServiceClient): Promise<void> {
  const now = new Date().toISOString()
  const idempotencyCutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_MS).toISOString()
  const [states, eligible, idempotency] = await Promise.all([
    service.from('github_write_oauth_states').delete().lt('expires_at', now),
    service.from('github_write_eligible_repositories').delete().lt('expires_at', now),
    service.from('github_write_idempotency').delete().lt('created_at', idempotencyCutoff),
  ])
  if (states.error || eligible.error || idempotency.error) {
    safeGitHubWriteDiagnostic('expired_record_cleanup_failed')
  }
}

async function enforceRateLimit(
  service: ServiceClient,
  userId: string,
  scope: GitHubRateScope,
): Promise<void> {
  const max = scope === 'connect'
    ? CONNECT_RATE_LIMIT_MAX
    : scope === 'connection-mutate'
      ? CONNECTION_MUTATION_RATE_LIMIT_MAX
      : ISSUE_CREATE_RATE_LIMIT_MAX
  const { data, error } = await service.rpc('increment_github_write_rate_limit', {
    p_user_id: userId,
    p_scope: scope,
    p_window_ms: RATE_LIMIT_WINDOW_MS,
    p_max_count: max,
  })
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.allowed) throw new GitHubWriteError('RATE_LIMITED', 429)
}

type AuditAction =
  | 'oauth_requested'
  | 'oauth_denied'
  | 'oauth_authorized'
  | 'repository_connected'
  | 'connection_revoked'
  | 'issue_create_requested'
  | 'issue_create_succeeded'
  | 'issue_create_failed'

interface AuditEvent {
  userId: string
  action: AuditAction
  connection?: GitHubWriteConnection
  idempotencyKey?: string
  issue?: GitHubIssueMetadata
  githubUserId?: string
}

async function writeAudit(service: ServiceClient, event: AuditEvent): Promise<void> {
  const connection = event.connection
  const { error } = await service.from('github_write_audit').insert({
    user_id: event.userId,
    connection_id: connection?.id ?? null,
    github_user_id: event.githubUserId ?? connection?.github_user_id ?? null,
    installation_id: connection?.installation_id ?? null,
    repository_id: connection?.repository_id ?? null,
    repository_full_name: connection?.repository_full_name ?? null,
    action: event.action,
    idempotency_key: event.idempotencyKey ?? null,
    issue_number: event.issue?.issueNumber ?? null,
    issue_url: event.issue?.issueUrl ?? null,
  })
  if (error) safeGitHubWriteDiagnostic('audit_write_failed')
}

export async function startGitHubWriteAuthorization(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<{ authorizationUrl: string; expiresAt: string; browserBinding: string }> {
  const request = assertConfirmedObject(body)
  if (request.consent !== true) throw new GitHubWriteError('WRITE_NOT_CONFIRMED', 403)
  await enforceRateLimit(service, userId, 'connect')
  await cleanupExpiredRecords(service)

  const config = githubAppRuntimeConfig()
  const state = randomToken(32)
  const verifier = randomToken(48)
  const browserBinding = randomToken(32)
  const stateHash = await sha256Hex(state)
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()
  const challenge = base64UrlEncode(await sha256(verifier))
  const { error } = await service.from('github_write_oauth_states').insert({
    state_hash: stateHash,
    user_id: userId,
    code_verifier_ciphertext: await encryptGitHubWriteState(
      encodeOAuthStateSecret(verifier, browserBinding),
    ),
    expires_at: expiresAt,
  })
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)

  await writeAudit(service, { userId, action: 'oauth_requested' })
  const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL)
  authorizationUrl.searchParams.set('client_id', config.clientId)
  authorizationUrl.searchParams.set('redirect_uri', callbackUri())
  authorizationUrl.searchParams.set('state', state)
  authorizationUrl.searchParams.set('code_challenge_method', 'S256')
  authorizationUrl.searchParams.set('code_challenge', challenge)
  return { authorizationUrl: authorizationUrl.toString(), expiresAt, browserBinding }
}

function validAuthorizationCode(value: string | null): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 4096 && /^[A-Za-z0-9._~-]+$/.test(value))
}

function validOAuthStateOrBinding(value: unknown): value is string {
  return typeof value === 'string' && OAUTH_STATE_OR_BINDING.test(value)
}

async function readBoundedJson(
  response: Response,
  failureCode: GitHubWriteErrorCode,
): Promise<unknown> {
  if (!response.body) throw new GitHubWriteError(failureCode, 502)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  const chunks: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_GITHUB_RESPONSE_BYTES) {
        await reader.cancel()
        throw new GitHubWriteError(failureCode, 502)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return JSON.parse(chunks.join(''))
  } catch (error) {
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError(failureCode, 502)
  } finally {
    reader.releaseLock()
  }
}

async function exchangeGitHubAuthorizationCode(verifier: string, code: string): Promise<string> {
  const config = githubAppRuntimeConfig()
  let response: Response
  try {
    response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUri(),
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new GitHubWriteError('OAUTH_UNAVAILABLE', 503)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
  const payload = asRecord(await readBoundedJson(response, 'OAUTH_DENIED'), 'OAUTH_DENIED')
  if (typeof payload.access_token !== 'string' || payload.access_token.length < 8 || payload.access_token.length > 4096) {
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
  return payload.access_token
}

function githubApiUrl(path: string): string {
  const url = new URL(path, GITHUB_API_ORIGIN)
  if (url.origin !== GITHUB_API_ORIGIN || !url.pathname.startsWith('/')) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  return url.toString()
}

function githubApiHeaders(token: string): Record<string, string> {
  return {
    Authorization: ['Bearer', token].join(' '),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  }
}

async function githubApiFetch(
  path: string,
  token: string,
  options: Omit<RequestInit, 'headers'> = {},
): Promise<Response> {
  try {
    return await fetch(githubApiUrl(path), {
      ...options,
      headers: {
        ...githubApiHeaders(token),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new GitHubWriteError('GITHUB_UNAVAILABLE', 503)
  }
}

async function githubUserJson(path: string, userToken: string): Promise<Record<string, unknown>> {
  const response = await githubApiFetch(path, userToken)
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubWriteError('OAUTH_DENIED', 401)
  }
  return asRecord(await readBoundedJson(response, 'OAUTH_DENIED'), 'OAUTH_DENIED')
}

function eligibleInstallations(payload: Record<string, unknown>): string[] {
  const installations = payload.installations
  if (!Array.isArray(installations)) throw new GitHubWriteError('OAUTH_DENIED', 401)
  const ids: string[] = []
  for (const installation of installations.slice(0, MAX_ELIGIBLE_INSTALLATIONS)) {
    const record = asRecord(installation, 'OAUTH_DENIED')
    const permissions = record.permissions
    const permissionRecord = permissions && typeof permissions === 'object' && !Array.isArray(permissions)
      ? permissions as Record<string, unknown>
      : null
    if (permissionRecord?.issues !== 'write') continue
    ids.push(assertGitHubId(record.id, 'OAUTH_DENIED'))
  }
  return ids
}

async function findEligibleRepositories(
  userId: string,
  userToken: string,
): Promise<{ githubUserId: string; repositories: EligibleRepository[] }> {
  const user = await githubUserJson('/user', userToken)
  const githubUserId = assertGitHubId(user.id, 'OAUTH_DENIED')
  const installations = eligibleInstallations(await githubUserJson('/user/installations?per_page=100', userToken))
  const seen = new Set<string>()
  const repositories: EligibleRepository[] = []
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()

  for (const installationId of installations) {
    if (repositories.length >= MAX_ELIGIBLE_REPOSITORIES) break
    for (let page = 1; repositories.length < MAX_ELIGIBLE_REPOSITORIES; page += 1) {
      const payload = await githubUserJson(
        `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=${ELIGIBLE_REPOSITORY_PAGE_SIZE}&page=${page}`,
        userToken,
      )
      const values = payload.repositories
      if (!Array.isArray(values)) throw new GitHubWriteError('OAUTH_DENIED', 401)
      for (const value of values) {
        if (repositories.length >= MAX_ELIGIBLE_REPOSITORIES) break
        const repository = asRecord(value, 'OAUTH_DENIED')
        const repositoryId = assertGitHubId(repository.id, 'OAUTH_DENIED')
        if (seen.has(repositoryId)) continue
        seen.add(repositoryId)
        repositories.push({
          user_id: userId,
          github_user_id: githubUserId,
          installation_id: installationId,
          repository_id: repositoryId,
          repository_full_name: assertRepositoryFullName(repository.full_name, 'OAUTH_DENIED'),
          expires_at: expiresAt,
        })
      }
      if (values.length < ELIGIBLE_REPOSITORY_PAGE_SIZE) break
    }
  }
  return { githubUserId, repositories }
}

async function replaceEligibleRepositories(
  service: ServiceClient,
  userId: string,
  repositories: EligibleRepository[],
): Promise<void> {
  const { error: deleteError } = await service
    .from('github_write_eligible_repositories')
    .delete()
    .eq('user_id', userId)
  if (deleteError) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  if (repositories.length === 0) return
  const { error: insertError } = await service
    .from('github_write_eligible_repositories')
    .insert(repositories)
  if (insertError) throw new GitHubWriteError('INTERNAL_ERROR', 500)
}

export async function handleGitHubWriteOAuthCallback(req: Request): Promise<Response> {
  const callbackUrl = new URL(req.url)
  const stateValue = callbackUrl.searchParams.get('state')
  if (!validOAuthStateOrBinding(stateValue)) {
    return callbackRedirect('failed')
  }

  const suppliedError = callbackUrl.searchParams.get('error')
  const code = callbackUrl.searchParams.get('code')
  if (suppliedError || !validAuthorizationCode(code)) {
    return callbackRedirect('denied')
  }
  return callbackRedirect('complete', {
    github_write_state: stateValue,
    github_write_code: code,
  })
}

export async function completeGitHubWriteAuthorization(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<void> {
  const request = assertConfirmedObject(body)
  const stateValue = request.state
  const authorizationCode = typeof request.code === 'string' ? request.code : null
  const browserBinding = request.browserBinding
  if (
    !validOAuthStateOrBinding(stateValue)
    || !validOAuthStateOrBinding(browserBinding)
    || !validAuthorizationCode(authorizationCode)
  ) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }

  await cleanupExpiredRecords(service)
  const stateHash = await sha256Hex(stateValue)
  const now = new Date().toISOString()
  const { data, error } = await service
    .from('github_write_oauth_states')
    .select('*')
    .eq('state_hash', stateHash)
    .eq('user_id', userId)
    .gt('expires_at', now)
    .maybeSingle()
  const state = data as OAuthState | null
  if (error || !state) throw new GitHubWriteError('OAUTH_DENIED', 401)

  try {
    const secret = decodeOAuthStateSecret(await decryptGitHubWriteState(state.code_verifier_ciphertext))
    if (secret.browserBinding !== browserBinding) throw new GitHubWriteError('OAUTH_DENIED', 401)
    const { data: consumed, error: consumeError } = await service
      .from('github_write_oauth_states')
      .delete()
      .eq('state_hash', stateHash)
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .select('*')
      .maybeSingle()
    if (consumeError || !consumed) throw new GitHubWriteError('OAUTH_DENIED', 401)

    const userToken = await exchangeGitHubAuthorizationCode(secret.verifier, authorizationCode)
    const eligible = await findEligibleRepositories(state.user_id, userToken)
    await replaceEligibleRepositories(service, state.user_id, eligible.repositories)
    await writeAudit(service, {
      userId: state.user_id,
      action: 'oauth_authorized',
      githubUserId: eligible.githubUserId,
    })
  } catch (error) {
    await writeAudit(service, { userId: state.user_id, action: 'oauth_denied' })
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError('INTERNAL_ERROR', 500)
  }
}

export async function listEligibleGitHubRepositories(
  service: ServiceClient,
  userId: string,
): Promise<GitHubEligibleRepositorySummary[]> {
  await cleanupExpiredRecords(service)
  const { data, error } = await service
    .from('github_write_eligible_repositories')
    .select('repository_id, repository_full_name, expires_at')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('repository_full_name', { ascending: true })
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  return (data ?? []).map(value => {
    const record = value as Record<string, unknown>
    return {
      repositoryId: assertGitHubId(record.repository_id, 'INTERNAL_ERROR'),
      repositoryFullName: assertRepositoryFullName(record.repository_full_name, 'INTERNAL_ERROR'),
      expiresAt: typeof record.expires_at === 'string' ? record.expires_at : '',
    }
  })
}

function toConnectionSummary(connection: GitHubWriteConnection): GitHubWriteConnectionSummary {
  if (!Array.isArray(connection.allowed_actions) || connection.allowed_actions.length !== 1 || connection.allowed_actions[0] !== 'create_issue') {
    throw new GitHubWriteError('INTERNAL_ERROR', 500)
  }
  if (!Number.isFinite(Date.parse(connection.authorization_expires_at))) {
    throw new GitHubWriteError('INTERNAL_ERROR', 500)
  }
  return {
    id: assertConnectionId(connection.id),
    repositoryFullName: assertRepositoryFullName(connection.repository_full_name, 'INTERNAL_ERROR'),
    allowedActions: ['create_issue'],
    authorizationExpiresAt: connection.authorization_expires_at,
    connectedAt: connection.connected_at,
    lastUsedAt: connection.last_used_at,
  }
}

export async function listGitHubWriteConnections(
  service: ServiceClient,
  userId: string,
): Promise<GitHubWriteConnectionSummary[]> {
  const { data, error } = await service
    .from('github_write_connections')
    .select('id, repository_full_name, allowed_actions, authorization_expires_at, connected_at, last_used_at')
    .eq('user_id', userId)
    .order('connected_at', { ascending: false })
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  return (data ?? []).map(value => toConnectionSummary(value as GitHubWriteConnection))
}

function nextConnectionAuthorizationExpiry(): string {
  return new Date(Date.now() + CONNECTION_AUTHORIZATION_TTL_MS).toISOString()
}

export async function connectEligibleGitHubRepository(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<GitHubWriteConnectionSummary> {
  const request = assertConfirmedObject(body)
  if (request.consent !== true || request.confirmation !== 'CONNECT_GITHUB_REPOSITORY') {
    throw new GitHubWriteError('WRITE_NOT_CONFIRMED', 403)
  }
  await cleanupExpiredRecords(service)
  const repositoryId = assertGitHubId(request.repositoryId)
  const { data, error } = await service
    .from('github_write_eligible_repositories')
    .select('*')
    .eq('user_id', userId)
    .eq('repository_id', repositoryId)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  if (!data) throw new GitHubWriteError('REPOSITORY_NOT_ELIGIBLE', 403)
  const eligible = data as EligibleRepository
  await enforceRateLimit(service, userId, 'connection-mutate')
  const authorizationExpiresAt = nextConnectionAuthorizationExpiry()

  const { data: existingData, error: existingError } = await service
    .from('github_write_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('repository_id', repositoryId)
    .maybeSingle()
  if (existingError) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  const existing = existingData as GitHubWriteConnection | null
  if (existing) {
    if (
      String(existing.github_user_id) !== eligible.github_user_id ||
      String(existing.installation_id) !== eligible.installation_id
    ) {
      throw new GitHubWriteError('REPOSITORY_NOT_ELIGIBLE', 403)
    }
    const { data: updated, error: updateError } = await service
      .from('github_write_connections')
      .update({
        repository_full_name: eligible.repository_full_name,
        authorization_expires_at: authorizationExpiresAt,
      })
      .eq('id', existing.id)
      .eq('user_id', userId)
      .select('*')
      .maybeSingle()
    if (updateError || !updated) throw new GitHubWriteError('INTERNAL_ERROR', 500)
    const refreshedConnection = updated as GitHubWriteConnection
    await writeAudit(service, { userId, action: 'repository_connected', connection: refreshedConnection })
    return toConnectionSummary(refreshedConnection)
  }

  const { data: created, error: createError } = await service
    .from('github_write_connections')
    .insert({
      user_id: userId,
      github_user_id: eligible.github_user_id,
      installation_id: eligible.installation_id,
      repository_id: eligible.repository_id,
      repository_full_name: eligible.repository_full_name,
      allowed_actions: ['create_issue'],
      authorization_expires_at: authorizationExpiresAt,
    })
    .select('*')
    .maybeSingle()
  if (createError || !created) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  const connection = created as GitHubWriteConnection
  await writeAudit(service, { userId, action: 'repository_connected', connection })
  return toConnectionSummary(connection)
}

async function getOwnedGitHubConnection(
  service: ServiceClient,
  userId: string,
  connectionIdValue: unknown,
): Promise<GitHubWriteConnection> {
  const connectionId = assertConnectionId(connectionIdValue)
  const { data, error } = await service
    .from('github_write_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  if (!data) throw new GitHubWriteError('CONNECTION_NOT_FOUND', 404)
  const connection = data as GitHubWriteConnection
  if (!Array.isArray(connection.allowed_actions) || !connection.allowed_actions.includes('create_issue')) {
    throw new GitHubWriteError('GITHUB_ACCESS_DENIED', 403)
  }
  return connection
}

function requireCurrentGitHubAuthorization(connection: GitHubWriteConnection): void {
  const expiresAt = Date.parse(connection.authorization_expires_at)
  if (!Number.isFinite(expiresAt)) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  if (expiresAt <= Date.now()) {
    throw new GitHubWriteError('REPOSITORY_AUTHORIZATION_EXPIRED', 403)
  }
}

export async function disconnectGitHubWriteConnection(
  service: ServiceClient,
  userId: string,
  connectionIdValue: unknown,
): Promise<void> {
  const connection = await getOwnedGitHubConnection(service, userId, connectionIdValue)
  await enforceRateLimit(service, userId, 'connection-mutate')
  const { error } = await service
    .from('github_write_connections')
    .delete()
    .eq('id', connection.id)
    .eq('user_id', userId)
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  const { error: eligibleError } = await service
    .from('github_write_eligible_repositories')
    .delete()
    .eq('user_id', userId)
    .eq('repository_id', String(connection.repository_id))
  if (eligibleError) safeGitHubWriteDiagnostic('eligible_repository_cleanup_failed')
  await writeAudit(service, { userId, action: 'connection_revoked', connection })
}

function pemToPkcs8Bytes(value: string): Uint8Array {
  const normalized = value.replace(/\\n/g, '\n').trim()
  const header = '-----BEGIN PRIVATE KEY-----'
  const footer = '-----END PRIVATE KEY-----'
  if (!normalized.startsWith(header) || !normalized.endsWith(footer)) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  const base64 = normalized.slice(header.length, -footer.length).replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch {
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
}

async function githubAppJwt(): Promise<string> {
  const config = githubAppRuntimeConfig()
  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToPkcs8Bytes(config.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  } catch (error) {
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError('FUNCTION_CONFIG_ERROR', 503)
  }
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: config.appId,
  })))
  const unsigned = `${header}.${payload}`
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      privateKey,
      new TextEncoder().encode(unsigned),
    ),
  )
  return `${unsigned}.${base64UrlEncode(signature)}`
}

async function mintInstallationToken(connection: GitHubWriteConnection): Promise<string> {
  const installationId = assertGitHubId(connection.installation_id, 'INTERNAL_ERROR')
  const repositoryId = assertGitHubId(connection.repository_id, 'INTERNAL_ERROR')
  const appJwt = await githubAppJwt()
  const response = await githubApiFetch(
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt,
    {
      method: 'POST',
      body: JSON.stringify({ repository_ids: [Number(repositoryId)] }),
    },
  )
  if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_ACCESS_DENIED', 403)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_UNAVAILABLE', 503)
  }
  const payload = asRecord(await readBoundedJson(response, 'GITHUB_INVALID_RESPONSE'), 'GITHUB_INVALID_RESPONSE')
  if (typeof payload.token !== 'string' || payload.token.length < 8 || payload.token.length > 4096) {
    throw new GitHubWriteError('GITHUB_INVALID_RESPONSE', 502)
  }
  return payload.token
}

function verifiedIssueUrl(value: unknown, repositoryFullName: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new GitHubWriteError('GITHUB_INVALID_RESPONSE', 502)
  }
  try {
    const url = new URL(value)
    const expectedPrefix = `/${repositoryFullName}/issues/`
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPrefix)) {
      throw new Error('unexpected issue URL')
    }
    return url.toString()
  } catch {
    throw new GitHubWriteError('GITHUB_INVALID_RESPONSE', 502)
  }
}

async function verifyInstallationRepository(
  service: ServiceClient,
  connection: GitHubWriteConnection,
  installationToken: string,
): Promise<string> {
  const repositoryId = assertGitHubId(connection.repository_id, 'INTERNAL_ERROR')
  const response = await githubApiFetch(`/repositories/${encodeURIComponent(repositoryId)}`, installationToken)
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_ACCESS_DENIED', 403)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_UNAVAILABLE', 503)
  }
  const repository = asRecord(
    await readBoundedJson(response, 'GITHUB_INVALID_RESPONSE'),
    'GITHUB_INVALID_RESPONSE',
  )
  if (assertGitHubId(repository.id, 'GITHUB_INVALID_RESPONSE') !== repositoryId) {
    throw new GitHubWriteError('GITHUB_ACCESS_DENIED', 403)
  }
  const fullName = assertRepositoryFullName(repository.full_name, 'GITHUB_INVALID_RESPONSE')
  const { error } = await service
    .from('github_write_connections')
    .update({
      repository_full_name: fullName,
      last_used_at: new Date().toISOString(),
    })
    .eq('id', connection.id)
    .eq('user_id', connection.user_id)
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  return fullName
}

function idempotencyResult(
  existing: IdempotencyRecord,
  requestHash: string,
  repositoryFullName: string,
): GitHubIssueMetadata {
  if (existing.request_hash !== requestHash) throw new GitHubWriteError('IDEMPOTENCY_CONFLICT', 409)
  if (existing.status === 'succeeded' && Number.isInteger(existing.issue_number) && existing.issue_number > 0 && existing.issue_url) {
    return {
      issueNumber: existing.issue_number,
      issueUrl: verifiedIssueUrl(existing.issue_url, repositoryFullName),
    }
  }
  throw new GitHubWriteError(
    existing.status === 'pending' ? 'IDEMPOTENCY_PENDING' : 'IDEMPOTENCY_CONFLICT',
    409,
  )
}

async function findIdempotency(
  service: ServiceClient,
  userId: string,
  connection: GitHubWriteConnection,
  idempotencyKey: string,
): Promise<IdempotencyRecord | null> {
  const { data, error } = await service
    .from('github_write_idempotency')
    .select('request_hash, status, issue_number, issue_url')
    .eq('user_id', userId)
    .eq('connection_id', connection.id)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  return data as IdempotencyRecord | null
}

async function claimIdempotency(
  service: ServiceClient,
  userId: string,
  connection: GitHubWriteConnection,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ previous: GitHubIssueMetadata | null }> {
  const { error } = await service.from('github_write_idempotency').insert({
    user_id: userId,
    connection_id: connection.id,
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    status: 'pending',
  })
  if (!error) return { previous: null }

  const existing = await findIdempotency(service, userId, connection, idempotencyKey)
  if (!existing) throw new GitHubWriteError('INTERNAL_ERROR', 500)
  return { previous: idempotencyResult(existing, requestHash, connection.repository_full_name) }
}

async function completeIdempotency(
  service: ServiceClient,
  userId: string,
  connectionId: string,
  idempotencyKey: string,
  issue: GitHubIssueMetadata,
): Promise<void> {
  const { error } = await service
    .from('github_write_idempotency')
    .update({
      status: 'succeeded',
      issue_number: issue.issueNumber,
      issue_url: issue.issueUrl,
    })
    .eq('user_id', userId)
    .eq('connection_id', connectionId)
    .eq('idempotency_key', idempotencyKey)
  if (error) throw new GitHubWriteError('INTERNAL_ERROR', 500)
}

async function markIdempotencyUnknown(
  service: ServiceClient,
  userId: string,
  connectionId: string,
  idempotencyKey: string,
): Promise<void> {
  const { error } = await service
    .from('github_write_idempotency')
    .update({ status: 'unknown' })
    .eq('user_id', userId)
    .eq('connection_id', connectionId)
    .eq('idempotency_key', idempotencyKey)
  if (error) safeGitHubWriteDiagnostic('idempotency_update_failed')
}

async function createIssueWithInstallationToken(
  repositoryFullName: string,
  token: string,
  request: CreateIssueRequest,
): Promise<GitHubIssueMetadata> {
  const [owner, repository] = repositoryFullName.split('/')
  const response = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({ title: request.title, body: request.body }),
    },
  )
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_ACCESS_DENIED', 403)
  }
  if (response.status === 422) {
    await response.body?.cancel()
    throw new GitHubWriteError('ISSUE_REJECTED', 422)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new GitHubWriteError('GITHUB_UNAVAILABLE', 503)
  }
  const issue = asRecord(
    await readBoundedJson(response, 'GITHUB_INVALID_RESPONSE'),
    'GITHUB_INVALID_RESPONSE',
  )
  if (!Number.isInteger(issue.number) || (issue.number as number) <= 0) {
    throw new GitHubWriteError('GITHUB_INVALID_RESPONSE', 502)
  }
  return {
    issueNumber: issue.number as number,
    issueUrl: verifiedIssueUrl(issue.html_url, repositoryFullName),
  }
}

export async function createGitHubIssue(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<GitHubIssueMetadata> {
  const request = parseCreateIssueRequest(body)
  const connection = await getOwnedGitHubConnection(service, userId, request.connectionId)
  requireCurrentGitHubAuthorization(connection)
  if (request.confirmRepository !== connection.repository_full_name) {
    throw new GitHubWriteError('WRITE_NOT_CONFIRMED', 403)
  }
  // Store an opaque keyed digest rather than title/body content or a raw
  // deterministic hash, which also prevents offline guessing of short drafts.
  const requestHash = await hmacSha256Hex(JSON.stringify({
    action: 'create_issue',
    connectionId: connection.id,
    repositoryId: String(connection.repository_id),
    title: request.title,
    body: request.body,
  }))
  const existing = await findIdempotency(service, userId, connection, request.idempotencyKey)
  if (existing) return idempotencyResult(existing, requestHash, connection.repository_full_name)
  await enforceRateLimit(service, userId, 'issue-create')
  const claim = await claimIdempotency(service, userId, connection, request.idempotencyKey, requestHash)
  if (claim.previous) return claim.previous

  await writeAudit(service, {
    userId,
    action: 'issue_create_requested',
    connection,
    idempotencyKey: request.idempotencyKey,
  })
  try {
    const installationToken = await mintInstallationToken(connection)
    const repositoryFullName = await verifyInstallationRepository(service, connection, installationToken)
    if (repositoryFullName !== request.confirmRepository) {
      throw new GitHubWriteError('WRITE_NOT_CONFIRMED', 403)
    }
    const issue = await createIssueWithInstallationToken(repositoryFullName, installationToken, request)
    await completeIdempotency(service, userId, connection.id, request.idempotencyKey, issue)
    await writeAudit(service, {
      userId,
      action: 'issue_create_succeeded',
      connection: { ...connection, repository_full_name: repositoryFullName },
      idempotencyKey: request.idempotencyKey,
      issue,
    })
    return issue
  } catch (error) {
    await markIdempotencyUnknown(service, userId, connection.id, request.idempotencyKey)
    await writeAudit(service, {
      userId,
      action: 'issue_create_failed',
      connection,
      idempotencyKey: request.idempotencyKey,
    })
    if (error instanceof GitHubWriteError) throw error
    throw new GitHubWriteError('GITHUB_UNAVAILABLE', 503)
  }
}
