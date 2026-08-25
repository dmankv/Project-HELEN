import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export type AccessMode = 'read_logs' | 'write_secrets'
export type LogService =
  | 'api'
  | 'branch-action'
  | 'postgres'
  | 'edge-function'
  | 'edge-function-runtime'
  | 'auth'
  | 'storage'
  | 'realtime'

type ServiceClient = ReturnType<typeof createClient>

interface RuntimeConfig {
  supabaseUrl: string
  serviceRoleKey: string
  anonKey: string
}

interface OAuthConfig {
  clientId: string
  clientSecret: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  revocationEndpoint: string | null
  redirectUri: string
  scopes: string
}

interface OAuthState {
  state_hash: string
  user_id: string
  project_ref: string
  access_mode: AccessMode
  oauth_client_id: string
  oauth_authorization_endpoint: string
  oauth_token_endpoint: string
  oauth_revocation_endpoint: string | null
  code_verifier_ciphertext: string
  redirect_uri: string
  expires_at: string
}

export interface ProjectConnection {
  id: string
  user_id: string
  project_ref: string
  access_mode: AccessMode
  oauth_client_id: string
  oauth_token_endpoint: string
  oauth_revocation_endpoint: string | null
  refresh_token_ciphertext: string
  connected_at: string
  last_used_at: string | null
}

interface OAuthTokenResponse {
  access_token?: unknown
  refresh_token?: unknown
}

interface McpResponse {
  payload: unknown
  sessionId: string | null
}

export interface ValidatedLogRequest {
  service: LogService
  limit: number
  startAt: string
  endAt: string
}

export interface SanitizedLogResult {
  entries: unknown[]
  redactionApplied: true
  untrusted: true
  startAt: string
  endAt: string
  service: LogService
}

export const PROJECT_ACCESS_FUNCTION_NAME = 'supabase-project-access'
export const SECRET_WRITE_FUNCTION_NAME = 'supabase-project-secret-write'
export const MCP_HOSTED_URL = 'https://mcp.supabase.com/mcp'
export const MCP_PROTOCOL_VERSION = Deno.env.get('SUPABASE_MCP_PROTOCOL_VERSION') ?? '2025-11-25'
export const LOG_SERVICES = new Set<LogService>([
  'api',
  'branch-action',
  'postgres',
  'edge-function',
  'edge-function-runtime',
  'auth',
  'storage',
  'realtime',
])

const ALLOWED_ORIGINS = new Set(['https://dmankv.github.io'])
const MAX_LOG_WINDOW_MS = 60 * 60 * 1000
const DEFAULT_LOG_WINDOW_MS = 15 * 60 * 1000
const MAX_LOG_LIMIT = 100
const DEFAULT_LOG_LIMIT = 50
const MAX_MCP_RESPONSE_BYTES = 256 * 1024
const MAX_LOG_TEXT_LENGTH = 4_096
const MAX_LOG_DEPTH = 5
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const MCP_REQUEST_TIMEOUT_MS = 25_000
const LOG_RATE_LIMIT_MAX = 10
const SECRET_WRITE_RATE_LIMIT_MAX = 3
const RATE_LIMIT_WINDOW_MS = 60_000
const REQUIRED_GATEWAY_SECRETS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DAEMON_PROVIDER',
  'DAEMON_MODEL',
] as const

export type ProjectAccessErrorCode =
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
  | 'PROJECT_ACCESS_DENIED'
  | 'MCP_UNAVAILABLE'
  | 'MCP_INVALID_RESPONSE'
  | 'SECRET_WRITE_DISABLED'
  | 'INTERNAL_ERROR'

export class ProjectAccessError extends Error {
  constructor(
    readonly code: ProjectAccessErrorCode,
    readonly status: number,
  ) {
    super(code)
  }
}

export function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (!requestOrigin) return null
  if (ALLOWED_ORIGINS.has(requestOrigin)) return requestOrigin
  if (/^http:\/\/localhost(:\d+)?$/.test(requestOrigin)) return requestOrigin
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(requestOrigin)) return requestOrigin
  return null
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function jsonResponse(
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

export function safeErrorMessage(code: ProjectAccessErrorCode): string {
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
    case 'CONNECTION_NOT_FOUND':
      return 'Project connection not found.'
    case 'PROJECT_ACCESS_DENIED':
      return 'Access to that project was denied.'
    case 'OAUTH_DENIED':
      return 'Project authorization was denied or expired.'
    case 'SECRET_WRITE_DISABLED':
      return 'Secret writes require a separate confirmed write connection.'
    case 'FUNCTION_CONFIG_ERROR':
    case 'OAUTH_UNAVAILABLE':
    case 'MCP_UNAVAILABLE':
    case 'MCP_INVALID_RESPONSE':
    case 'INTERNAL_ERROR':
    default:
      return 'Project access is temporarily unavailable.'
  }
}

export function errorResponse(
  error: unknown,
  headers: Record<string, string>,
): Response {
  if (error instanceof ProjectAccessError) {
    return jsonResponse(
      { code: error.code, error: safeErrorMessage(error.code) },
      error.status,
      headers,
    )
  }
  safeDiagnostic('internal_error')
  return jsonResponse(
    { code: 'INTERNAL_ERROR', error: safeErrorMessage('INTERNAL_ERROR') },
    500,
    headers,
  )
}

export function safeDiagnostic(event: string, metadata: Record<string, string | number | boolean> = {}): void {
  console.warn('[supabase-project-access]', JSON.stringify({ event, ...metadata }))
}

function runtimeConfig(): RuntimeConfig {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  }
  return { supabaseUrl, serviceRoleKey, anonKey }
}

function serviceClient(): ServiceClient {
  const config = runtimeConfig()
  return createClient(config.supabaseUrl, config.serviceRoleKey)
}

export async function authenticateRequest(req: Request): Promise<{
  userId: string
  service: ServiceClient
}> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    throw new ProjectAccessError('AUTH_REQUIRED', 401)
  }

  const config = runtimeConfig()
  const userClient = createClient(config.supabaseUrl, config.anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data, error } = await userClient.auth.getUser()
  if (error || !data.user) {
    throw new ProjectAccessError('INVALID_TOKEN', 401)
  }
  return { userId: data.user.id, service: serviceClient() }
}

export function assertProjectRef(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9]{1,64}$/.test(value)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  return value
}

function assertConnectionId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  return value
}

function assertAccessMode(value: unknown): AccessMode {
  if (value === 'read_logs' || value === 'write_secrets') return value
  throw new ProjectAccessError('BAD_REQUEST', 400)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
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

async function encryptionKey(): Promise<CryptoKey> {
  const configured = Deno.env.get('SUPABASE_PROJECT_ACCESS_ENCRYPTION_KEY') ?? ''
  const bytes = base64UrlDecode(configured)
  if (bytes.byteLength !== 32) throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  try {
    return await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } catch {
    throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  }
}

export async function encryptServerSecret(value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey()
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value)),
  )
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(encrypted)}`
}

export async function decryptServerSecret(value: string): Promise<string> {
  const [version, ivEncoded, ciphertextEncoded, extra] = value.split('.')
  if (version !== 'v1' || !ivEncoded || !ciphertextEncoded || extra) {
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  try {
    const key = await encryptionKey()
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivEncoded) },
      key,
      base64UrlDecode(ciphertextEncoded),
    )
    return new TextDecoder().decode(decrypted)
  } catch (error) {
    if (error instanceof ProjectAccessError) throw error
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
}

function trustedSupabaseUrl(value: string | undefined): string {
  if (!value) throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      !(host === 'supabase.com' || host.endsWith('.supabase.com'))
    ) {
      throw new Error('untrusted host')
    }
    return url.toString()
  } catch {
    throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  }
}

function callbackUri(): string {
  const configured = Deno.env.get('SUPABASE_PROJECT_ACCESS_REDIRECT_URI')
  if (configured) return trustedSupabaseUrl(configured)
  const { supabaseUrl } = runtimeConfig()
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/${PROJECT_ACCESS_FUNCTION_NAME}`
}

function oauthConfig(): OAuthConfig {
  const clientId = Deno.env.get('SUPABASE_MCP_OAUTH_CLIENT_ID') ?? ''
  if (!clientId || clientId.length > 512) {
    throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  }
  const scopes = Deno.env.get('SUPABASE_MCP_OAUTH_SCOPES') ?? 'offline_access'
  if (scopes.length > 512) throw new ProjectAccessError('FUNCTION_CONFIG_ERROR', 503)
  return {
    clientId,
    clientSecret: Deno.env.get('SUPABASE_MCP_OAUTH_CLIENT_SECRET') || null,
    authorizationEndpoint: trustedSupabaseUrl(Deno.env.get('SUPABASE_MCP_OAUTH_AUTHORIZATION_ENDPOINT')),
    tokenEndpoint: trustedSupabaseUrl(Deno.env.get('SUPABASE_MCP_OAUTH_TOKEN_ENDPOINT')),
    revocationEndpoint: Deno.env.get('SUPABASE_MCP_OAUTH_REVOCATION_ENDPOINT')
      ? trustedSupabaseUrl(Deno.env.get('SUPABASE_MCP_OAUTH_REVOCATION_ENDPOINT'))
      : null,
    redirectUri: callbackUri(),
    scopes,
  }
}

function mcpUrl(projectRef: string, accessMode: AccessMode): string {
  const url = new URL(MCP_HOSTED_URL)
  url.searchParams.set('project_ref', projectRef)
  if (accessMode === 'read_logs') {
    url.searchParams.set('read_only', 'true')
    url.searchParams.set('features', 'debugging')
  } else {
    // Write access is deliberately isolated from the normal read-only
    // connection and requires a new OAuth consent flow.
    url.searchParams.set('features', 'functions')
  }
  return url.toString()
}

function isValidOAuthCode(value: string | null): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 4096)
}

function callbackRedirect(outcome: 'connected' | 'denied' | 'failed'): Response {
  const configured = Deno.env.get('SUPABASE_PROJECT_ACCESS_APP_URL') ?? 'https://dmankv.github.io/Project-HELEN/'
  let location = 'https://dmankv.github.io/Project-HELEN/#/?supabase_project_access=failed'
  try {
    const url = new URL(configured)
    const host = url.hostname.toLowerCase()
    const allowed =
      url.protocol === 'https:' && host === 'dmankv.github.io' ||
      url.protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1')
    if (allowed) {
      url.hash = `/?supabase_project_access=${outcome}`
      location = url.toString()
    }
  } catch {
    // Use the fixed safe fallback above.
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

async function writeAudit(
  service: ServiceClient,
  event: {
    userId: string
    projectRef: string
    action:
      | 'read_consent_requested'
      | 'write_consent_requested'
      | 'oauth_connected'
      | 'oauth_denied'
      | 'logs_read'
      | 'secret_health_checked'
      | 'connection_revoked'
      | 'secret_write_requested'
      | 'secret_write_succeeded'
      | 'secret_write_failed'
    connectionId?: string
    logService?: LogService
    logCount?: number
    windowStart?: string
    windowEnd?: string
    secretName?: string
  },
): Promise<void> {
  const { error } = await service.from('supabase_mcp_access_audit').insert({
    user_id: event.userId,
    connection_id: event.connectionId ?? null,
    project_ref: event.projectRef,
    action: event.action,
    log_service: event.logService ?? null,
    log_count: event.logCount ?? null,
    window_start: event.windowStart ?? null,
    window_end: event.windowEnd ?? null,
    secret_name: event.secretName ?? null,
  })
  if (error) safeDiagnostic('audit_write_failed')
}

export async function startOAuthConnection(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const request = body as Record<string, unknown>
  if (request.consent !== true) throw new ProjectAccessError('BAD_REQUEST', 400)
  const projectRef = assertProjectRef(request.projectRef)
  const accessMode = assertAccessMode(request.accessMode ?? 'read_logs')
  const config = oauthConfig()
  const state = randomToken(32)
  const verifier = randomToken(48)
  const challenge = base64UrlEncode(await sha256(verifier))
  const stateHash = await sha256Hex(state)
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString()

  await service.from('supabase_mcp_oauth_states').delete().lt('expires_at', new Date().toISOString())

  const { error } = await service.from('supabase_mcp_oauth_states').insert({
    state_hash: stateHash,
    user_id: userId,
    project_ref: projectRef,
    access_mode: accessMode,
    oauth_client_id: config.clientId,
    oauth_authorization_endpoint: config.authorizationEndpoint,
    oauth_token_endpoint: config.tokenEndpoint,
    oauth_revocation_endpoint: config.revocationEndpoint,
    code_verifier_ciphertext: await encryptServerSecret(verifier),
    redirect_uri: config.redirectUri,
    expires_at: expiresAt,
  })
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)

  await writeAudit(service, {
    userId,
    projectRef,
    action: accessMode === 'read_logs' ? 'read_consent_requested' : 'write_consent_requested',
  })

  const authorizationUrl = new URL(config.authorizationEndpoint)
  authorizationUrl.searchParams.set('response_type', 'code')
  authorizationUrl.searchParams.set('client_id', config.clientId)
  authorizationUrl.searchParams.set('redirect_uri', config.redirectUri)
  authorizationUrl.searchParams.set('code_challenge_method', 'S256')
  authorizationUrl.searchParams.set('code_challenge', challenge)
  authorizationUrl.searchParams.set('state', state)
  authorizationUrl.searchParams.set('resource', mcpUrl(projectRef, accessMode))
  if (config.scopes) authorizationUrl.searchParams.set('scope', config.scopes)

  return { authorizationUrl: authorizationUrl.toString(), expiresAt }
}

async function exchangeOAuthCode(
  state: OAuthState,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const verifier = await decryptServerSecret(state.code_verifier_ciphertext)
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: state.redirect_uri,
    client_id: state.oauth_client_id,
    code_verifier: verifier,
  })
  const clientSecret = Deno.env.get('SUPABASE_MCP_OAUTH_CLIENT_SECRET')
  if (clientSecret) params.set('client_secret', clientSecret)
  let response: Response
  try {
    response = await fetch(state.oauth_token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ProjectAccessError('OAUTH_UNAVAILABLE', 503)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  let data: OAuthTokenResponse
  try {
    data = await response.json() as OAuthTokenResponse
  } catch {
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token }
}

export async function handleOAuthCallback(req: Request): Promise<Response> {
  const callbackUrl = new URL(req.url)
  const stateValue = callbackUrl.searchParams.get('state')
  if (!stateValue || stateValue.length > 256 || !/^[A-Za-z0-9_-]+$/.test(stateValue)) {
    return callbackRedirect('failed')
  }

  let service: ServiceClient
  try {
    service = serviceClient()
  } catch {
    return callbackRedirect('failed')
  }

  const stateHash = await sha256Hex(stateValue)
  const { data, error } = await service
    .from('supabase_mcp_oauth_states')
    .select('*')
    .eq('state_hash', stateHash)
    .maybeSingle()
  const state = data as OAuthState | null
  if (error || !state || Date.parse(state.expires_at) <= Date.now()) {
    if (state) await service.from('supabase_mcp_oauth_states').delete().eq('state_hash', stateHash)
    return callbackRedirect('failed')
  }

  const suppliedError = callbackUrl.searchParams.get('error')
  const code = callbackUrl.searchParams.get('code')
  if (suppliedError || !isValidOAuthCode(code)) {
    await service.from('supabase_mcp_oauth_states').delete().eq('state_hash', stateHash)
    await writeAudit(service, {
      userId: state.user_id,
      projectRef: state.project_ref,
      action: 'oauth_denied',
    })
    return callbackRedirect('denied')
  }

  try {
    const tokens = await exchangeOAuthCode(state, code)
    const { error: upsertError } = await service.from('supabase_mcp_connections').upsert(
      {
        user_id: state.user_id,
        project_ref: state.project_ref,
        access_mode: state.access_mode,
        oauth_client_id: state.oauth_client_id,
        oauth_token_endpoint: state.oauth_token_endpoint,
        oauth_revocation_endpoint: state.oauth_revocation_endpoint,
        refresh_token_ciphertext: await encryptServerSecret(tokens.refreshToken),
        connected_at: new Date().toISOString(),
        last_used_at: null,
      },
      { onConflict: 'user_id,project_ref,access_mode' },
    )
    if (upsertError) throw new ProjectAccessError('INTERNAL_ERROR', 500)
    await service.from('supabase_mcp_oauth_states').delete().eq('state_hash', stateHash)
    await writeAudit(service, {
      userId: state.user_id,
      projectRef: state.project_ref,
      action: 'oauth_connected',
    })
    return callbackRedirect('connected')
  } catch {
    await service.from('supabase_mcp_oauth_states').delete().eq('state_hash', stateHash)
    await writeAudit(service, {
      userId: state.user_id,
      projectRef: state.project_ref,
      action: 'oauth_denied',
    })
    return callbackRedirect('failed')
  }
}

export async function listConnections(
  service: ServiceClient,
  userId: string,
): Promise<Array<Pick<ProjectConnection, 'id' | 'project_ref' | 'access_mode' | 'connected_at' | 'last_used_at'>>> {
  const { data, error } = await service
    .from('supabase_mcp_connections')
    .select('id, project_ref, access_mode, connected_at, last_used_at')
    .eq('user_id', userId)
    .order('connected_at', { ascending: false })
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)
  return (data ?? []) as Array<Pick<ProjectConnection, 'id' | 'project_ref' | 'access_mode' | 'connected_at' | 'last_used_at'>>
}

export async function getOwnedConnection(
  service: ServiceClient,
  userId: string,
  connectionIdValue: unknown,
  accessMode?: AccessMode,
): Promise<ProjectConnection> {
  const connectionId = assertConnectionId(connectionIdValue)
  let query = service
    .from('supabase_mcp_connections')
    .select('*')
    .eq('id', connectionId)
    .eq('user_id', userId)
  if (accessMode) query = query.eq('access_mode', accessMode)
  const { data, error } = await query.maybeSingle()
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)
  if (!data) throw new ProjectAccessError('CONNECTION_NOT_FOUND', 404)
  return data as ProjectConnection
}

async function refreshAccessToken(
  service: ServiceClient,
  connection: ProjectConnection,
): Promise<string> {
  const refreshToken = await decryptServerSecret(connection.refresh_token_ciphertext)
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: connection.oauth_client_id,
  })
  const clientSecret = Deno.env.get('SUPABASE_MCP_OAUTH_CLIENT_SECRET')
  if (clientSecret) params.set('client_secret', clientSecret)
  let response: Response
  try {
    response = await fetch(connection.oauth_token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ProjectAccessError('OAUTH_UNAVAILABLE', 503)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  let data: OAuthTokenResponse
  try {
    data = await response.json() as OAuthTokenResponse
  } catch {
    throw new ProjectAccessError('OAUTH_DENIED', 401)
  }
  if (typeof data.access_token !== 'string') throw new ProjectAccessError('OAUTH_DENIED', 401)

  const updates: Record<string, string> = { last_used_at: new Date().toISOString() }
  if (typeof data.refresh_token === 'string' && data.refresh_token.length > 0) {
    updates.refresh_token_ciphertext = await encryptServerSecret(data.refresh_token)
  }
  const { error } = await service
    .from('supabase_mcp_connections')
    .update(updates)
    .eq('id', connection.id)
    .eq('user_id', connection.user_id)
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)
  return data.access_token
}

async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    reader.releaseLock()
  }
}

function parseMcpPayload(contentType: string | null, text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    if (contentType?.includes('text/event-stream')) {
      const dataLines = trimmed
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(Boolean)
      if (dataLines.length === 0) throw new Error('missing event data')
      return JSON.parse(dataLines[dataLines.length - 1])
    }
    return JSON.parse(trimmed)
  } catch {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
}

async function mcpRequest(
  endpoint: string,
  accessToken: string,
  body: Record<string, unknown>,
  sessionId?: string | null,
): Promise<McpResponse> {
  const headers: Record<string, string> = {
    Authorization: ['Bearer', accessToken].join(' '),
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new ProjectAccessError('MCP_UNAVAILABLE', 503)
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new ProjectAccessError('PROJECT_ACCESS_DENIED', 403)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProjectAccessError('MCP_UNAVAILABLE', 503)
  }
  const text = await readResponseText(response, MAX_MCP_RESPONSE_BYTES)
  return {
    payload: parseMcpPayload(response.headers.get('content-type'), text),
    sessionId: response.headers.get('mcp-session-id'),
  }
}

function mcpResult(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
  const record = payload as Record<string, unknown>
  if (record.error) throw new ProjectAccessError('MCP_UNAVAILABLE', 503)
  const result = record.result
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content) || content.length === 0) {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
  const first = content[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
  const text = (first as Record<string, unknown>).text
  if (typeof text !== 'string' || text.length > MAX_MCP_RESPONSE_BYTES) {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ProjectAccessError('MCP_INVALID_RESPONSE', 502)
  }
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, '******')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|passwd|secret|service[_-]?role)[\s"'=:]+)([^\s,"'}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
}

function sensitiveKey(key: string): boolean {
  return /(authorization|token|password|passwd|secret|api[_-]?key|service[_-]?role|cookie)/i.test(key)
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_LOG_DEPTH) return '[TRUNCATED]'
  if (typeof value === 'string') return redactText(value).slice(0, MAX_LOG_TEXT_LENGTH)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 25).map(item => sanitizeLogValue(item, depth + 1))
  if (!value || typeof value !== 'object') return '[UNSUPPORTED]'
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    result[key] = sensitiveKey(key) ? '[REDACTED]' : sanitizeLogValue(item, depth + 1)
  }
  return result
}

function logEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return [value]
  const record = value as Record<string, unknown>
  if (Array.isArray(record.result)) return record.result
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.logs)) return record.logs
  return [record]
}

export function sanitizeMcpLogs(
  result: unknown,
  request: ValidatedLogRequest,
): SanitizedLogResult {
  return {
    entries: logEntries(result).slice(0, request.limit).map(entry => sanitizeLogValue(entry)),
    redactionApplied: true,
    untrusted: true,
    startAt: request.startAt,
    endAt: request.endAt,
    service: request.service,
  }
}

export function validateLogRequest(body: unknown): ValidatedLogRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const request = body as Record<string, unknown>
  if (typeof request.service !== 'string' || !LOG_SERVICES.has(request.service as LogService)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const end = typeof request.endAt === 'string' ? Date.parse(request.endAt) : Date.now()
  const start = typeof request.startAt === 'string' ? Date.parse(request.startAt) : end - DEFAULT_LOG_WINDOW_MS
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > MAX_LOG_WINDOW_MS) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const rawLimit = request.limit === undefined ? DEFAULT_LOG_LIMIT : request.limit
  if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > MAX_LOG_LIMIT) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  return {
    service: request.service as LogService,
    limit: rawLimit as number,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
  }
}

async function enforceRateLimit(
  service: ServiceClient,
  userId: string,
  scope: 'logs' | 'secret-write',
): Promise<void> {
  const max = scope === 'logs' ? LOG_RATE_LIMIT_MAX : SECRET_WRITE_RATE_LIMIT_MAX
  const { data, error } = await service.rpc('increment_supabase_mcp_rate_limit', {
    p_user_id: userId,
    p_scope: scope,
    p_window_ms: RATE_LIMIT_WINDOW_MS,
    p_max_count: max,
  })
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.allowed) throw new ProjectAccessError('RATE_LIMITED', 429)
}

export async function readProjectLogs(
  service: ServiceClient,
  userId: string,
  connectionId: unknown,
  body: unknown,
): Promise<SanitizedLogResult> {
  const request = validateLogRequest(body)
  await enforceRateLimit(service, userId, 'logs')
  const connection = await getOwnedConnection(service, userId, connectionId, 'read_logs')
  const accessToken = await refreshAccessToken(service, connection)
  const endpoint = mcpUrl(connection.project_ref, 'read_logs')

  const initialization = await mcpRequest(endpoint, accessToken, {
    jsonrpc: '2.0',
    id: randomToken(12),
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'project-helen', version: '1.0.0' },
    },
  })
  if (initialization.payload && typeof initialization.payload === 'object') {
    const initRecord = initialization.payload as Record<string, unknown>
    if (initRecord.error) throw new ProjectAccessError('MCP_UNAVAILABLE', 503)
  }

  const response = await mcpRequest(
    endpoint,
    accessToken,
    {
      jsonrpc: '2.0',
      id: randomToken(12),
      method: 'tools/call',
      params: {
        name: 'get_logs',
        arguments: {
          service: request.service,
          iso_timestamp_start: request.startAt,
          iso_timestamp_end: request.endAt,
        },
      },
    },
    initialization.sessionId,
  )
  const sanitized = sanitizeMcpLogs(mcpResult(response.payload), request)
  await writeAudit(service, {
    userId,
    projectRef: connection.project_ref,
    action: 'logs_read',
    connectionId: connection.id,
    logService: request.service,
    logCount: sanitized.entries.length,
    windowStart: request.startAt,
    windowEnd: request.endAt,
  })
  return sanitized
}

function ownProjectRef(): string | null {
  try {
    const host = new URL(runtimeConfig().supabaseUrl).hostname
    const match = /^([a-z0-9]{1,64})\.supabase\.co$/i.exec(host)
    return match?.[1]?.toLowerCase() ?? null
  } catch {
    return null
  }
}

export function secretHealth(projectRef: string): {
  projectRef: string
  scope: 'gateway-project' | 'unavailable'
  secrets: Array<{ name: string; status: 'configured' | 'missing' | 'unavailable' }>
} {
  const sameProject = ownProjectRef() === projectRef
  return {
    projectRef,
    scope: sameProject ? 'gateway-project' : 'unavailable',
    secrets: REQUIRED_GATEWAY_SECRETS.map(name => ({
      name,
      status: sameProject
        ? (Deno.env.get(name) ? 'configured' : 'missing')
        : 'unavailable',
    })),
  }
}

export async function getProjectSecretHealth(
  service: ServiceClient,
  userId: string,
  connectionId: unknown,
): Promise<ReturnType<typeof secretHealth>> {
  const connection = await getOwnedConnection(service, userId, connectionId, 'read_logs')
  const result = secretHealth(connection.project_ref)
  await writeAudit(service, {
    userId,
    projectRef: connection.project_ref,
    action: 'secret_health_checked',
    connectionId: connection.id,
  })
  return result
}

async function revokeOAuthToken(connection: ProjectConnection): Promise<void> {
  if (!connection.oauth_revocation_endpoint) return
  try {
    const refreshToken = await decryptServerSecret(connection.refresh_token_ciphertext)
    const params = new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: connection.oauth_client_id,
    })
    const clientSecret = Deno.env.get('SUPABASE_MCP_OAUTH_CLIENT_SECRET')
    if (clientSecret) params.set('client_secret', clientSecret)
    const response = await fetch(connection.oauth_revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
    })
    await response.body?.cancel()
  } catch {
    // Local deletion still removes all application access immediately.
    safeDiagnostic('oauth_revocation_remote_failed')
  }
}

export async function disconnectProject(
  service: ServiceClient,
  userId: string,
  connectionId: unknown,
): Promise<void> {
  const connection = await getOwnedConnection(service, userId, connectionId)
  await revokeOAuthToken(connection)
  const { error } = await service
    .from('supabase_mcp_connections')
    .delete()
    .eq('id', connection.id)
    .eq('user_id', userId)
  if (error) throw new ProjectAccessError('INTERNAL_ERROR', 500)
  await writeAudit(service, {
    userId,
    projectRef: connection.project_ref,
    action: 'connection_revoked',
    connectionId: connection.id,
  })
}

function assertSecretName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(value) ||
    value.startsWith('SUPABASE_')
  ) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  return value
}

function assertSecretValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > 16_384) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  return value
}

export async function writeProjectSecret(
  service: ServiceClient,
  userId: string,
  body: unknown,
): Promise<void> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const request = body as Record<string, unknown>
  if (request.confirmed !== true) throw new ProjectAccessError('SECRET_WRITE_DISABLED', 403)
  const secretName = assertSecretName(request.secretName)
  if (request.confirmSecretName !== secretName) throw new ProjectAccessError('BAD_REQUEST', 400)
  const secretValue = assertSecretValue(request.secretValue)
  const connection = await getOwnedConnection(
    service,
    userId,
    request.connectionId,
    'write_secrets',
  )
  await enforceRateLimit(service, userId, 'secret-write')
  await writeAudit(service, {
    userId,
    projectRef: connection.project_ref,
    action: 'secret_write_requested',
    connectionId: connection.id,
    secretName,
  })

  try {
    const accessToken = await refreshAccessToken(service, connection)
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${encodeURIComponent(connection.project_ref)}/secrets`,
      {
        method: 'POST',
        headers: {
          Authorization: ['Bearer', accessToken].join(' '),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([{ name: secretName, value: secretValue }]),
        signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
      },
    )
    // Never inspect a management API response body: a secret value must never
    // become application data, a response, or a log entry.
    await response.body?.cancel()
    if (!response.ok) throw new ProjectAccessError('PROJECT_ACCESS_DENIED', 403)
    await writeAudit(service, {
      userId,
      projectRef: connection.project_ref,
      action: 'secret_write_succeeded',
      connectionId: connection.id,
      secretName,
    })
  } catch (error) {
    await writeAudit(service, {
      userId,
      projectRef: connection.project_ref,
      action: 'secret_write_failed',
      connectionId: connection.id,
      secretName,
    })
    if (error instanceof ProjectAccessError) throw error
    throw new ProjectAccessError('MCP_UNAVAILABLE', 503)
  }
}
