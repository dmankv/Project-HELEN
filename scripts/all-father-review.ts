import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  ALL_FATHER_DECISIONS,
  evaluateAllFatherReview,
} from '../supabase/functions/_shared/allFatherReviewPolicy'

const REPO_ROOT = process.cwd()
const DIFF_BASE_REF = 'origin/main'
const DIFF_RANGE = `${DIFF_BASE_REF}...HEAD`
const TEST_FILE_PATTERN = /(?:^|\/)(?:tests\/.+|.+\.test\.(?:ts|tsx|js|jsx|mjs|cjs))$/

function execGit(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trimEnd()
}

function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.resolve(REPO_ROOT, relativePath))
}

function readFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8')
}

function includesAll(source: string, required: readonly string[]): boolean {
  return required.every(value => source.includes(value))
}

function changedFilesFromGit(): string[] {
  ensureDiffBaseRef()
  const output = execGit(['diff', '--name-only', '--no-renames', DIFF_RANGE])
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function diffFromGit(): string {
  ensureDiffBaseRef()
  return execGit(['diff', '--no-ext-diff', '--unified=0', '--no-renames', DIFF_RANGE])
}

function ensureDiffBaseRef(): void {
  try {
    execGit(['rev-parse', '--verify', DIFF_BASE_REF])
  } catch {
    execGit(['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'])
  }
}

function rollbackControlsRemainPresent(): boolean {
  const evolutionInfrastructureSql = readFile('supabase/migrations/20260926221000_evolution_infrastructure.sql')
  const liveEvalWorkflow = readFile('.github/workflows/live-eval.yml')

  return includesAll(evolutionInfrastructureSql, [
    "'rollback_completed'",
    "'run_finished'",
    "'canary_decision'",
    'to service_role',
  ]) && includesAll(liveEvalWorkflow, [
    'const protectedPaths = [',
    'function classifyPath(',
    "'write_sandbox'",
    'Promotion-bound candidate diff violates immutable sandbox policy:',
  ])
}

function autoHasTests(changedFiles: string[]): boolean {
  return changedFiles.some(filePath => TEST_FILE_PATTERN.test(filePath))
}

function main(): number {
  const changedFiles = changedFilesFromGit()
  const diff = diffFromGit()
  const auditMigrationExists = fileExists('supabase/migrations/20260928100000_all_father_reviews.sql')
  const reviewEndpointExists = fileExists('supabase/functions/all-father-review/index.ts')
  const hasTests = autoHasTests(changedFiles)
  const rollbackAssured = rollbackControlsRemainPresent()

  const result = evaluateAllFatherReview({
    targetBranch: 'main',
    changedFiles,
    diff,
    assurances: {
      hasTests,
      securityAssured: true,
      auditAssured: auditMigrationExists && reviewEndpointExists,
      rollbackAssured,
    },
  })

  console.log(JSON.stringify({
    ...result,
    checks: {
      diffRange: DIFF_RANGE,
      auditMigrationExists,
      reviewEndpointExists,
      rollbackControlsRemainPresent: rollbackAssured,
    },
  }, null, 2))

  return result.decision === ALL_FATHER_DECISIONS.REJECTED ? 1 : 0
}

try {
  process.exit(main())
} catch (error) {
  console.error(JSON.stringify({
    decision: ALL_FATHER_DECISIONS.REJECTED,
    error: error instanceof Error ? error.message : 'ALL-FATHER review runner failed.',
  }, null, 2))
  process.exit(1)
}
