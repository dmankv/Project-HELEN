/**
 * Isolated Supabase project secret-write Edge Function.
 *
 * This function accepts a secret only for the duration of one confirmed write
 * request. It uses a separately consented write connection, never reads a
 * secret inventory or a response body, and never persists or logs the value.
 */

import {
  authenticateRequest,
  corsHeaders,
  errorResponse,
  getAllowedOrigin,
  jsonResponse,
  ProjectAccessError,
  writeProjectSecret,
} from '../_shared/supabaseProjectAccess.ts'

Deno.serve(async (req: Request) => {
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
    const { userId, service } = await authenticateRequest(req)
    const body: unknown = await req.json()
    await writeProjectSecret(service, userId, body)
    return jsonResponse({ written: true }, 200, headers)
  } catch (error) {
    return errorResponse(error, headers)
  }
})
