/**
 * Supabase Project Access Edge Function
 *
 * Provides a server-side OAuth callback and a narrowly scoped proxy for the
 * hosted Supabase MCP debugging tools. Browser clients receive only redacted,
 * bounded, on-demand log data; OAuth tokens and management credentials never
 * enter the browser bundle or a client-readable table.
 */

import {
  authenticateRequest,
  corsHeaders,
  disconnectProject,
  errorResponse,
  getAllowedOrigin,
  getProjectSecretHealth,
  handleOAuthCallback,
  jsonResponse,
  listConnections,
  ProjectAccessError,
  readProjectLogs,
  startOAuthConnection,
} from '../_shared/supabaseProjectAccess.ts'

function parseAction(body: unknown): { action: string; request: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectAccessError('BAD_REQUEST', 400)
  }
  const request = body as Record<string, unknown>
  if (typeof request.action !== 'string') throw new ProjectAccessError('BAD_REQUEST', 400)
  return { action: request.action, request }
}

Deno.serve(async (req: Request) => {
  // OAuth redirects do not carry the application's Supabase JWT. The callback
  // is authenticated by a one-time, server-stored state value instead.
  if (req.method === 'GET') return handleOAuthCallback(req)

  const allowedOrigin = getAllowedOrigin(req.headers.get('origin'))
  if (req.method === 'OPTIONS') {
    if (!allowedOrigin) {
      return jsonResponse(
        { code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed.' },
        403,
        {},
      )
    }
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) })
  }
  if (!allowedOrigin) {
    return jsonResponse(
      { code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed.' },
      403,
      {},
    )
  }

  const headers = corsHeaders(allowedOrigin)
  if (req.method !== 'POST') {
    return jsonResponse(
      { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' },
      405,
      headers,
    )
  }

  try {
    const body = await req.json()
    const { action, request } = parseAction(body)
    const { userId, service } = await authenticateRequest(req)

    switch (action) {
      case 'connect': {
        const result = await startOAuthConnection(service, userId, {
          ...request,
          accessMode: 'read_logs',
        })
        return jsonResponse(result, 200, headers)
      }
      case 'start-secret-write': {
        if (request.writeConsent !== true || request.writeConfirmation !== 'ALLOW_SECRET_WRITES') {
          throw new ProjectAccessError('BAD_REQUEST', 400)
        }
        const result = await startOAuthConnection(service, userId, {
          ...request,
          accessMode: 'write_secrets',
        })
        return jsonResponse(result, 200, headers)
      }
      case 'status': {
        const connections = await listConnections(service, userId)
        return jsonResponse({ connections }, 200, headers)
      }
      case 'logs': {
        const logs = await readProjectLogs(service, userId, request.connectionId, request)
        return jsonResponse({ logs }, 200, headers)
      }
      case 'secret-health': {
        const health = await getProjectSecretHealth(service, userId, request.connectionId)
        return jsonResponse({ health }, 200, headers)
      }
      case 'disconnect': {
        await disconnectProject(service, userId, request.connectionId)
        return jsonResponse({ disconnected: true }, 200, headers)
      }
      default:
        throw new ProjectAccessError('BAD_REQUEST', 400)
    }
  } catch (error) {
    return errorResponse(error, headers)
  }
})
