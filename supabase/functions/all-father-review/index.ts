import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  ALL_FATHER_DECISIONS,
  evaluateAllFatherReview,
  type AllFatherReviewAssurances,
  type AllFatherReviewFinding,
} from '../_shared/allFatherReviewPolicy.ts'

const ALLOWED_ORIGINS = new Set([
  'https://dmankv.github.io',
])

const MAX_CHANGED_FILES = 500
const MAX_CHANGED_FILE_LENGTH = 255
const MAX_DIFF_CHARS = 1_000_000

type SafeErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'FORBIDDEN'
  | 'FUNCTION_CONFIG_ERROR'
  | 'BAD_REQUEST'
  | 'ORIGIN_NOT_ALLOWED'
  | 'METHOD_NOT_ALLOWED'
  | 'AUDIT_WRITE_FAILED'
  | 'INTERNAL_ERROR'

function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (!requestOrigin) return null
  if (ALLOWED_ORIGINS.has(requestOrigin)) return requestOrigin
  if (/^http:\/\/localhost(:\d+)?$/.test(requestOrigin)) return requestOrigin
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(requestOrigin)) return requestOrigin
  return null
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function safeErrorMessage(code: SafeErrorCode): string {
  switch (code) {
    case 'AUTH_REQUIRED':
      return 'Authentication required.'
    case 'INVALID_TOKEN':
      return 'Invalid or expired token.'
    case 'FORBIDDEN':
      return 'Access denied.'
    case 'FUNCTION_CONFIG_ERROR':
      return 'Service is temporarily unavailable.'
    case 'BAD_REQUEST':
      return 'Bad request.'
    case 'ORIGIN_NOT_ALLOWED':
      return 'Origin not allowed.'
    case 'METHOD_NOT_ALLOWED':
      return 'Method not allowed.'
    case 'AUDIT_WRITE_FAILED':
      return 'Review audit could not be persisted.'
    case 'INTERNAL_ERROR':
    default:
      return 'An internal error occurred.'
  }
}

function jsonResponse(body: Record<string, unknown>, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...headers,
    },
  })
}

function jsonErrorResponse(code: SafeErrorCode, status: number, headers: Record<string, string>): Response {
  return jsonResponse({ code, error: safeErrorMessage(code) }, status, headers)
}

async function verifyAdmin(
  serviceClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<boolean> {
  const { data, error } = await serviceClient
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle<{ role: string }>()

  if (error || !data) return false
  return data.role === 'admin'
}

function normalizeChangedFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CHANGED_FILES) {
    throw new Error('changed_files')
  }
  const normalizedFiles = value.map(entry => {
    if (typeof entry !== 'string') throw new Error('changed_files')
    const normalized = entry.replace(/\\/g, '/').replace(/^\.\//, '').trim()
    if (!normalized || normalized.length > MAX_CHANGED_FILE_LENGTH) {
      throw new Error('changed_files')
    }
    return normalized
  })
  return Array.from(new Set(normalizedFiles))
}

function assuranceFlag(value: unknown): boolean {
  return value === true
}

function validatePayload(body: unknown): {
  targetBranch: string
  changedFiles: string[]
  diff: string
  assurances: AllFatherReviewAssurances
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body')
  }
  const payload = body as Record<string, unknown>
  if (payload.targetBranch !== 'main') {
    throw new Error('targetBranch')
  }
  if (typeof payload.diff !== 'string' || payload.diff.length > MAX_DIFF_CHARS) {
    throw new Error('diff')
  }

  return {
    targetBranch: 'main',
    changedFiles: normalizeChangedFiles(payload.changedFiles),
    diff: payload.diff,
    assurances: {
      hasTests: assuranceFlag(payload.hasTests),
      securityAssured: assuranceFlag(payload.securityAssured),
      auditAssured: assuranceFlag(payload.auditAssured),
      rollbackAssured: assuranceFlag(payload.rollbackAssured),
    },
  }
}

function auditFailureFinding(): AllFatherReviewFinding {
  return {
    code: 'audit_write_failed',
    severity: 'review',
    message: 'Audit persistence failed; result requires human review.',
  }
}

Deno.serve(async (req: Request) => {
  const allowedOrigin = getAllowedOrigin(req.headers.get('origin'))
  if (req.method === 'OPTIONS') {
    if (!allowedOrigin) {
      return new Response(JSON.stringify({ code: 'ORIGIN_NOT_ALLOWED', error: safeErrorMessage('ORIGIN_NOT_ALLOWED') }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) })
  }
  if (!allowedOrigin) {
    return new Response(JSON.stringify({ code: 'ORIGIN_NOT_ALLOWED', error: safeErrorMessage('ORIGIN_NOT_ALLOWED') }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const headers = corsHeaders(allowedOrigin)
  if (req.method !== 'POST') {
    return jsonErrorResponse('METHOD_NOT_ALLOWED', 405, headers)
  }

  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonErrorResponse('AUTH_REQUIRED', 401, headers)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return jsonErrorResponse('FUNCTION_CONFIG_ERROR', 503, headers)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return jsonErrorResponse('INVALID_TOKEN', 401, headers)
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const isAdmin = await verifyAdmin(serviceClient, user.id)
  if (!isAdmin) {
    return jsonErrorResponse('FORBIDDEN', 403, headers)
  }

  let payload: ReturnType<typeof validatePayload>
  try {
    payload = validatePayload(await req.json())
  } catch {
    return jsonErrorResponse('BAD_REQUEST', 400, headers)
  }

  const result = evaluateAllFatherReview(payload)

  const { error: insertError } = await serviceClient
    .from('all_father_reviews')
    .insert({
      reviewer_user_id: user.id,
      target_branch: payload.targetBranch,
      decision: result.decision,
      changed_files: payload.changedFiles,
      proposal_diff: payload.diff,
      findings: result.findings,
      has_tests: result.assurances.hasTests,
      security_assured: result.assurances.securityAssured,
      audit_assured: result.assurances.auditAssured,
      rollback_assured: result.assurances.rollbackAssured,
    })

  if (insertError) {
    return jsonResponse({
      code: 'AUDIT_WRITE_FAILED',
      error: safeErrorMessage('AUDIT_WRITE_FAILED'),
      decision: ALL_FATHER_DECISIONS.REQUIRES_HUMAN_REVIEW,
      findings: [...result.findings, auditFailureFinding()],
    }, 409, headers)
  }

  const status = result.decision === ALL_FATHER_DECISIONS.APPROVED ? 200 : 409
  return jsonResponse(result, status, headers)
})
