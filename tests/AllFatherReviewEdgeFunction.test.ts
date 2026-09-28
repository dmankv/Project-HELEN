import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const edgeFunctionPath = path.resolve(
  process.cwd(),
  'supabase/functions/all-father-review/index.ts',
)

describe('ALL-FATHER review edge function source', () => {
  const src = fs.readFileSync(edgeFunctionPath, 'utf8')

  it('validates bearer tokens and checks admin role server-side', () => {
    expect(src).toContain("authHeader?.startsWith('Bearer ')")
    expect(src).toContain('userClient.auth.getUser()')
    expect(src).toContain("from('profiles')")
    expect(src).toContain(".select('role')")
    expect(src).toContain("return data.role === 'admin'")
    expect(src).toContain("createClient(supabaseUrl, serviceRoleKey)")
  })

  it('enforces strict payload bounds before executing the shared policy', () => {
    expect(src).toContain('MAX_CHANGED_FILES = 500')
    expect(src).toContain('MAX_CHANGED_FILE_LENGTH = 255')
    expect(src).toContain('MAX_DIFF_CHARS = 1_000_000')
    expect(src).toContain("if (payload.targetBranch !== 'main')")
    expect(src).toContain('evaluateAllFatherReview(payload)')
  })

  it('writes append-only audit rows and fails closed when persistence fails', () => {
    expect(src).toContain("from('all_father_reviews')")
    expect(src).toContain('.insert({')
    expect(src).toContain('auditFailureFinding()')
    expect(src).toContain("decision: ALL_FATHER_DECISIONS.REQUIRES_HUMAN_REVIEW")
    expect(src).toContain('const status = persistedResult.decision === ALL_FATHER_DECISIONS.APPROVED ? 200 : 409')
  })

  it('allows only approved browser origins and POST requests', () => {
    expect(src).toContain('https://dmankv.github.io')
    expect(src).toContain("/^http:\\/\\/localhost(:\\d+)?$/")
    expect(src).toContain("/^http:\\/\\/127\\.0\\.0\\.1(:\\d+)?$/")
    expect(src).toContain("if (req.method === 'OPTIONS')")
    expect(src).toContain("if (req.method !== 'POST')")
  })
})
