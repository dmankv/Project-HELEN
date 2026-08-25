/**
 * GitHub App OAuth connection boundary.
 *
 * Browser POSTs require a Supabase session. The only unauthenticated request is
 * GitHub's OAuth callback, which consumes a one-time, server-stored state.
 */

import {
  authenticateGitHubWriteRequest,
  connectEligibleGitHubRepository,
  disconnectGitHubWriteConnection,
  getAllowedGitHubWriteOrigin,
  githubWriteCorsHeaders,
  githubWriteErrorResponse,
  githubWriteJsonResponse,
  GitHubWriteError,
  handleGitHubWriteOAuthCallback,
  listEligibleGitHubRepositories,
  listGitHubWriteConnections,
  startGitHubWriteAuthorization,
} from '../_shared/githubWriteAccess.ts'

function parseAction(body: unknown): { action: string; request: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new GitHubWriteError('BAD_REQUEST', 400)
  }
  const request = body as Record<string, unknown>
  if (typeof request.action !== 'string') throw new GitHubWriteError('BAD_REQUEST', 400)
  return { action: request.action, request }
}

Deno.serve(async (req: Request) => {
  // GitHub's redirect cannot carry the application's Supabase JWT. The callback
  // is instead authenticated by an atomic, one-time state record.
  if (req.method === 'GET') return handleGitHubWriteOAuthCallback(req)

  const allowedOrigin = getAllowedGitHubWriteOrigin(req.headers.get('origin'))
  if (req.method === 'OPTIONS') {
    if (!allowedOrigin) {
      return githubWriteJsonResponse(
        { code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed.' },
        403,
        {},
      )
    }
    return new Response(null, { status: 204, headers: githubWriteCorsHeaders(allowedOrigin) })
  }
  if (!allowedOrigin) {
    return githubWriteJsonResponse(
      { code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed.' },
      403,
      {},
    )
  }
  const headers = githubWriteCorsHeaders(allowedOrigin)
  if (req.method !== 'POST') {
    return githubWriteJsonResponse(
      { code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed.' },
      405,
      headers,
    )
  }

  try {
    // Authenticate before inspecting browser-provided data.
    const { userId, service } = await authenticateGitHubWriteRequest(req)
    const body: unknown = await req.json()
    const { action, request } = parseAction(body)
    switch (action) {
      case 'authorize': {
        const result = await startGitHubWriteAuthorization(service, userId, request)
        return githubWriteJsonResponse(result, 200, headers)
      }
      case 'eligible-repositories': {
        const repositories = await listEligibleGitHubRepositories(service, userId)
        return githubWriteJsonResponse({ repositories }, 200, headers)
      }
      case 'connect': {
        const connection = await connectEligibleGitHubRepository(service, userId, request)
        return githubWriteJsonResponse({ connection }, 200, headers)
      }
      case 'status': {
        const connections = await listGitHubWriteConnections(service, userId)
        return githubWriteJsonResponse({ connections }, 200, headers)
      }
      case 'disconnect': {
        await disconnectGitHubWriteConnection(service, userId, request.connectionId)
        return githubWriteJsonResponse({ disconnected: true }, 200, headers)
      }
      default:
        throw new GitHubWriteError('BAD_REQUEST', 400)
    }
  } catch (error) {
    return githubWriteErrorResponse(error, headers)
  }
})
