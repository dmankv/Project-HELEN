/**
 * Admin Daemon Edge Function source tests
 *
 * Covers requirement 7 from the problem statement:
 * - Role validated server-side (from profiles table, not JWT claims)
 * - Generic 403 FORBIDDEN on non-admin
 * - Input/origin/rate-limit protection present
 * - No service-role / provider secret leakage to browser
 * - No SQL/shell/deployment capability
 * - Provider keys only in Deno.env
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const edgeFnPath = path.resolve(
  process.cwd(),
  'supabase/functions/admin-daemon/index.ts',
)

describe('Admin Daemon Edge Function source', () => {
  const src = fs.readFileSync(edgeFnPath, 'utf8')
  const normalizedSrc = src.toLowerCase()

  // ---------------------------------------------------------------------------
  // Server-side role check
  // ---------------------------------------------------------------------------

  it('fetches role from profiles table server-side (not from JWT claims)', () => {
    expect(src).toContain("from('profiles')")
    expect(src).toContain(".select('role')")
    expect(src).toContain(".eq('id', userId)")
    expect(src).toContain("data.role === 'admin'")
  })

  it('verifyAdmin function is called before processing', () => {
    expect(src).toContain('verifyAdmin(')
    expect(src).toContain('isAdmin')
  })

  it('does not use JWT claims for role (no app_metadata role check)', () => {
    expect(src).not.toContain('app_metadata')
    expect(src).not.toContain('user_metadata')
    expect(src).not.toContain("claims['role']")
    expect(src).not.toContain('claims.role')
  })

  // ---------------------------------------------------------------------------
  // Generic 403 for non-admin
  // ---------------------------------------------------------------------------

  it("returns 403 FORBIDDEN with generic message for non-admin", () => {
    expect(src).toContain("'FORBIDDEN'")
    expect(src).toContain('403')
    expect(src).toContain("'Access denied.'")
  })

  it('does not leak admin capability in 403 response', () => {
    // The 403 message must be generic — no mention of "admin", "capability", etc.
    const forbiddenHandler = src.match(/'FORBIDDEN'[\s\S]{0,200}/)?.[0] ?? ''
    expect(forbiddenHandler).not.toMatch(/admin capability|admin section|endpoint exists/i)
  })

  // ---------------------------------------------------------------------------
  // Origin protection
  // ---------------------------------------------------------------------------

  it('validates origin against an explicit allowlist', () => {
    expect(src).toContain('ALLOWED_ORIGINS')
    expect(src).toContain('getAllowedOrigin(')
    expect(src).toContain('ORIGIN_NOT_ALLOWED')
  })

  it('does not allow wildcard CORS', () => {
    expect(src).not.toContain("'*'")
    expect(src).not.toContain('"*"')
  })

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  it('applies rate limiting via increment_rate_limit RPC', () => {
    expect(src).toContain('checkRateLimit(')
    expect(src).toContain('increment_rate_limit')
    expect(src).toContain('RATE_LIMITED')
  })

  it('rate limit for admin endpoint is stricter than public (max <= 60)', () => {
    const rateLimitMatch = src.match(/RATE_LIMIT_MAX\s*=\s*(\d+)/)
    expect(rateLimitMatch).not.toBeNull()
    const maxRequests = parseInt(rateLimitMatch![1], 10)
    expect(maxRequests).toBeLessThanOrEqual(60)
    // Admin is more restricted — should be 30 or less
    expect(maxRequests).toBeLessThanOrEqual(30)
  })

  // ---------------------------------------------------------------------------
  // Input validation
  // ---------------------------------------------------------------------------

  it('validates messages schema before processing', () => {
    expect(src).toContain('validateMessages(')
    expect(src).toContain('MAX_MESSAGES')
    expect(src).toContain('MAX_CONTENT_BYTES')
    expect(src).toContain('BAD_REQUEST')
  })

  it('validates strategy against explicit allowlist', () => {
    expect(src).toContain('ALLOWED_STRATEGIES')
    expect(src).toContain('validateStrategyMetadata(')
  })

  it('requires Content-Type application/json (POST only)', () => {
    expect(src).toContain("req.method !== 'POST'")
    expect(src).toContain('METHOD_NOT_ALLOWED')
  })

  // ---------------------------------------------------------------------------
  // No service-role / provider secret leakage to browser
  // ---------------------------------------------------------------------------

  it('provider keys are accessed only via Deno.env', () => {
    expect(src).toContain("Deno.env.get('OPENAI_API_KEY')")
    // No literal API key patterns
    expect(src).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/)
    expect(src).not.toMatch(/sk-ant-[A-Za-z0-9_-]{20,}/)
  })

  it('does not expose service-role key to response body', () => {
    // service role key must only be used internally, never serialised
    expect(src).not.toContain('JSON.stringify(serviceRoleKey)')
    expect(src).not.toContain('JSON.stringify(Deno.env')
  })

  it('does not return Deno.env values in responses', () => {
    expect(src).not.toMatch(/return new Response\([^)]*Deno\.env/s)
  })

  // ---------------------------------------------------------------------------
  // No SQL/shell/deployment capability
  // ---------------------------------------------------------------------------

  it('does not execute arbitrary raw SQL (rate limit RPC is permitted)', () => {
    // The rate limit increment RPC is permitted as an exception.
    // Arbitrary SQL execution, exec/query RPCs, and shell access are not.
    expect(src).not.toContain('supabase.sql')
    expect(src).not.toContain("rpc('exec")
    expect(src).not.toContain("rpc('query")
    expect(src).not.toContain("rpc('run")
  })

  it('does not execute shell commands', () => {
    expect(src).not.toContain('Deno.run(')
    expect(src).not.toContain('Deno.Command(')
    expect(src).not.toContain('subprocess')
    expect(src).not.toContain('shell(')
  })

  it('does not have deployment capability references', () => {
    expect(src).not.toContain('deploy(')
    expect(src).not.toContain('SUPABASE_ACCESS_TOKEN')
    expect(src).not.toContain('management API')
  })

  // ---------------------------------------------------------------------------
  // Audit logging — no raw content or secrets
  // ---------------------------------------------------------------------------

  it('uses structured audit logging (logAudit) instead of raw console.log', () => {
    expect(src).toContain('logAudit(')
    expect(src).toContain('admin_chat')
  })

  it('audit log does not include raw message content', () => {
    // The logAudit call for admin_chat must only log bounded metadata
    const auditCall = src.match(/logAudit\('admin_chat'[\s\S]{0,300}?\)/)?.[0] ?? ''
    expect(auditCall).not.toContain('content')
    expect(auditCall).not.toContain('messages')
    expect(auditCall).not.toContain('body')
  })

  // ---------------------------------------------------------------------------
  // Body size / request limits
  // ---------------------------------------------------------------------------

  it('enforces body size limits via MAX_MESSAGES and MAX_CONTENT_BYTES', () => {
    const maxMsgMatch = src.match(/MAX_MESSAGES\s*=\s*(\d+)/)
    expect(maxMsgMatch).not.toBeNull()
    const maxMsg = parseInt(maxMsgMatch![1], 10)
    expect(maxMsg).toBeLessThanOrEqual(40)

    const maxBytesMatch = src.match(/MAX_CONTENT_BYTES\s*=\s*(\d+)/)
    expect(maxBytesMatch).not.toBeNull()
    const maxBytes = parseInt(maxBytesMatch![1], 10)
    expect(maxBytes).toBeLessThanOrEqual(8000)
  })
})
