import { describe, expect, it } from 'vitest'
import {
  ALL_FATHER_DECISIONS,
  evaluateAllFatherReview,
} from '../supabase/functions/_shared/allFatherReviewPolicy'

const assured = {
  hasTests: true,
  securityAssured: true,
  auditAssured: true,
  rollbackAssured: true,
}

describe('ALL-FATHER review policy', () => {
  it('approves bounded non-protected changes with assurances present', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/components/StatusBadge.tsx', 'tests/StatusBadge.test.ts'],
      diff: `
diff --git a/src/components/StatusBadge.tsx b/src/components/StatusBadge.tsx
index 1111111..2222222 100644
--- a/src/components/StatusBadge.tsx
+++ b/src/components/StatusBadge.tsx
@@ -1,2 +1,3 @@
 export function StatusBadge() {
+  return 'ready'
 }
`,
      assurances: assured,
    })

    expect(result.decision).toBe(ALL_FATHER_DECISIONS.APPROVED)
    expect(result.findings).toEqual([])
  })

  it('requires human review for protected infrastructure path changes', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['scripts/all-father-review.ts'],
      diff: `
diff --git a/scripts/all-father-review.ts b/scripts/all-father-review.ts
--- a/scripts/all-father-review.ts
+++ b/scripts/all-father-review.ts
@@ -1 +1,2 @@
+console.log('updated')
`,
      assurances: assured,
    })

    expect(result.decision).toBe(ALL_FATHER_DECISIONS.REQUIRES_HUMAN_REVIEW)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'protected_path_change',
      path: 'scripts/all-father-review.ts',
    }))
  })

  it('rejects added secret literals but ignores removed ones', () => {
    const secretToken = ['ghp_', 'abcdefghijklmnopqrstuvwxyz123456'].join('')
    const rejected = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/config.ts', 'tests/config.test.ts'],
      diff: `
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +1,2 @@
+export const token = '${secretToken}'
`,
      assurances: assured,
    })

    const removedOnly = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/config.ts', 'tests/config.test.ts'],
      diff: `
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +0,0 @@
-export const token = '${secretToken}'
`,
      assurances: assured,
    })

    expect(rejected.decision).toBe(ALL_FATHER_DECISIONS.REJECTED)
    expect(rejected.findings).toContainEqual(expect.objectContaining({
      code: 'secret_literal_added',
      path: 'src/config.ts',
      lineNumber: 1,
    }))
    expect(removedOnly.decision).toBe(ALL_FATHER_DECISIONS.APPROVED)
  })

  it('scans all-father policy diffs and redacts assignment secrets in excerpts', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['supabase/functions/_shared/allFatherReviewPolicy.ts'],
      diff: `
diff --git a/supabase/functions/_shared/allFatherReviewPolicy.ts b/supabase/functions/_shared/allFatherReviewPolicy.ts
--- a/supabase/functions/_shared/allFatherReviewPolicy.ts
+++ b/supabase/functions/_shared/allFatherReviewPolicy.ts
@@ -1 +1,2 @@
+const API_KEY = "abcdefgh"
`,
      assurances: assured,
    })

    const finding = result.findings.find(item => item.code === 'secret_literal_added')
    expect(result.decision).toBe(ALL_FATHER_DECISIONS.REJECTED)
    expect(finding).toEqual(expect.objectContaining({
      path: 'supabase/functions/_shared/allFatherReviewPolicy.ts',
      excerpt: 'const API_KEY = "[REDACTED_SECRET]"',
    }))
  })

  it('rejects sensitive data literals with redacted excerpts', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/config.ts'],
      diff: `
diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -1 +1,2 @@
+const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----'
`,
      assurances: assured,
    })

    expect(result.decision).toBe(ALL_FATHER_DECISIONS.REJECTED)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'sensitive_data_literal_added',
      excerpt: "const PRIVATE_KEY = '[REDACTED_PRIVATE_KEY]'",
    }))
  })

  it('records multiple finding codes for a single added line when patterns overlap', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['.github/workflows/build.yml'],
      diff: `
diff --git a/.github/workflows/build.yml b/.github/workflows/build.yml
--- a/.github/workflows/build.yml
+++ b/.github/workflows/build.yml
@@ -1 +1,2 @@
+permissions: write-all # API_KEY = "abcdefgh"
`,
      assurances: assured,
    })

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'secret_literal_added' }),
      expect.objectContaining({ code: 'privileged_control_plane_change_added' }),
    ]))
  })

  it('rejects added auth bypass markers', () => {
    const bypassMarker = ['allow', 'unauthenticated'].join('_')
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/routes.ts', 'tests/routes.test.ts'],
      diff: `
diff --git a/src/routes.ts b/src/routes.ts
--- a/src/routes.ts
+++ b/src/routes.ts
@@ -1 +1,2 @@
+const ${bypassMarker} = true
`,
      assurances: assured,
    })

    expect(result.decision).toBe(ALL_FATHER_DECISIONS.REJECTED)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'auth_bypass_added',
    }))
  })

  it('requires human review when test assurance is missing', () => {
    const result = evaluateAllFatherReview({
      targetBranch: 'main',
      changedFiles: ['src/components/StatusBadge.tsx'],
      diff: `
diff --git a/src/components/StatusBadge.tsx b/src/components/StatusBadge.tsx
--- a/src/components/StatusBadge.tsx
+++ b/src/components/StatusBadge.tsx
@@ -1 +1,2 @@
+export const statusBadge = 'ready'
`,
      assurances: {
        ...assured,
        hasTests: false,
      },
    })

    expect(result.decision).toBe(ALL_FATHER_DECISIONS.REQUIRES_HUMAN_REVIEW)
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'missing_tests_assurance',
    }))
  })
})
