/**
 * Isolated GitHub App write boundary.
 *
 * This function performs only one mutation: an explicitly confirmed create-
 * issue request for a user-owned, server-verified repository connection.
 */

import {
  authenticateGitHubWriteRequest,
  createGitHubIssue,
  getAllowedGitHubWriteOrigin,
  githubWriteCorsHeaders,
  githubWriteErrorResponse,
  githubWriteJsonResponse,
} from '../_shared/githubWriteAccess.ts'

Deno.serve(async (req: Request) => {
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
    // Authenticate before reading the issue content, which is never logged.
    const { userId, service } = await authenticateGitHubWriteRequest(req)
    const body: unknown = await req.json()
    const issue = await createGitHubIssue(service, userId, body)
    return githubWriteJsonResponse({
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
    }, 200, headers)
  } catch (error) {
    return githubWriteErrorResponse(error, headers)
  }
})
