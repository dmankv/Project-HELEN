/**
 * Browser client for the server-side Supabase project-access Edge Functions.
 *
 * This module uses only the public Supabase URL/anon key and the signed-in
 * user's JWT. OAuth and management credentials stay inside Edge Functions.
 * Log results are intentionally kept in memory by callers and are never
 * persisted to localStorage or the conversation store.
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
const ACCESS_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/supabase-project-access`
const SECRET_WRITE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/supabase-project-secret-write`
const MAX_AGENT_CONTEXT_BYTES = 64_000

export type ProjectLogService =
  | 'api'
  | 'branch-action'
  | 'postgres'
  | 'edge-function'
  | 'edge-function-runtime'
  | 'auth'
  | 'storage'
  | 'realtime'

export interface ProjectConnectionSummary {
  id: string
  project_ref: string
  access_mode: 'read_logs' | 'write_secrets'
  connected_at: string
  last_used_at: string | null
}

export interface ProjectLogs {
  entries: unknown[]
  redactionApplied: true
  untrusted: true
  startAt: string
  endAt: string
  service: ProjectLogService
}

export interface ProjectSecretHealth {
  projectRef: string
  scope: 'gateway-project' | 'unavailable'
  secrets: Array<{
    name: string
    status: 'configured' | 'missing' | 'unavailable'
  }>
}

export type ProjectAccessFailureCode =
  | 'not-configured'
  | 'not-signed-in'
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'CONNECTION_NOT_FOUND'
  | 'PROJECT_ACCESS_DENIED'
  | 'OAUTH_DENIED'
  | 'SECRET_WRITE_DISABLED'
  | 'unavailable'

export interface ProjectAccessFailure {
  ok: false
  code: ProjectAccessFailureCode
}

export interface ProjectAccessSuccess<T> {
  ok: true
  data: T
}

export type ProjectAccessResult<T> = ProjectAccessSuccess<T> | ProjectAccessFailure

const SAFE_FAILURE_CODES = new Set<ProjectAccessFailureCode>([
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'RATE_LIMITED',
  'BAD_REQUEST',
  'CONNECTION_NOT_FOUND',
  'PROJECT_ACCESS_DENIED',
  'OAUTH_DENIED',
  'SECRET_WRITE_DISABLED',
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

export function isProjectAccessConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

function safeCode(value: unknown): ProjectAccessFailureCode {
  return typeof value === 'string' && SAFE_FAILURE_CODES.has(value as ProjectAccessFailureCode)
    ? value as ProjectAccessFailureCode
    : 'unavailable'
}

async function invoke<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<ProjectAccessResult<T>> {
  const supabase = getClient()
  if (!supabase) return { ok: false, code: 'not-configured' }
  const { data } = await supabase.auth.getSession()
  const accessToken = data.session?.access_token
  if (!accessToken) return { ok: false, code: 'not-signed-in' }

  try {
    const response = await fetch(url, {
      method: 'POST',
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

function validProjectRef(value: string): boolean {
  return /^[a-z0-9]{1,64}$/.test(value)
}

export async function beginProjectAccessConnection(
  projectRef: string,
  consent: boolean,
): Promise<ProjectAccessResult<{ authorizationUrl: string; expiresAt: string }>> {
  if (!consent || !validProjectRef(projectRef)) return { ok: false, code: 'BAD_REQUEST' }
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'connect',
    projectRef,
    consent: true,
  })
}

export async function beginSecretWriteConnection(
  projectRef: string,
  consent: boolean,
): Promise<ProjectAccessResult<{ authorizationUrl: string; expiresAt: string }>> {
  if (!consent || !validProjectRef(projectRef)) return { ok: false, code: 'BAD_REQUEST' }
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'start-secret-write',
    projectRef,
    consent: true,
    writeConsent: true,
    writeConfirmation: 'ALLOW_SECRET_WRITES',
  })
}

export async function getProjectAccessConnections(): Promise<ProjectAccessResult<{
  connections: ProjectConnectionSummary[]
}>> {
  return invoke(ACCESS_FUNCTION_URL, { action: 'status' })
}

export async function getProjectLogs(
  connectionId: string,
  options: {
    service: ProjectLogService
    startAt?: string
    endAt?: string
    limit?: number
  },
): Promise<ProjectAccessResult<{ logs: ProjectLogs }>> {
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'logs',
    connectionId,
    ...options,
  })
}

export async function getProjectSecretHealth(
  connectionId: string,
): Promise<ProjectAccessResult<{ health: ProjectSecretHealth }>> {
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'secret-health',
    connectionId,
  })
}

export async function disconnectProjectAccess(
  connectionId: string,
): Promise<ProjectAccessResult<{ disconnected: true }>> {
  return invoke(ACCESS_FUNCTION_URL, {
    action: 'disconnect',
    connectionId,
  })
}

/**
 * Secret values are passed only to the isolated write endpoint after an
 * explicit confirmation. The function returns only a success/failure status.
 */
export async function writeProjectSecret(
  request: {
    connectionId: string
    secretName: string
    confirmSecretName: string
    secretValue: string
    confirmed: boolean
  },
): Promise<ProjectAccessResult<{ written: true }>> {
  return invoke(SECRET_WRITE_FUNCTION_URL, request)
}

function redactAgentContext(value: string): string {
  // This is a second, best-effort defense. The server already redacts logs and
  // labels them untrusted; this client never treats the output as safe content.
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
    .replace(/\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi, '[REDACTED_IP]')
}

/**
 * Produces a one-request context for the Edge Function. Results are labeled as
 * untrusted and redacted a second time before they can be sent to an AI.
 */
export function formatLogsForDaemon(logs: ProjectLogs): string {
  const context = JSON.stringify({
    source: 'Supabase MCP read-only logs',
    trust: 'untrusted',
    redactionApplied: true,
    service: logs.service,
    startAt: logs.startAt,
    endAt: logs.endAt,
    entries: logs.entries,
  })
  return redactAgentContext(context).slice(0, MAX_AGENT_CONTEXT_BYTES)
}
