/**
 * Adaptive Intelligence Evaluation Runner
 *
 * Invokes the deterministic fixture suite from daemonEvaluation.ts and exits
 * non-zero if any assertion fails.  This runs entirely locally with no network
 * access, no API keys, and no real user data — suitable for CI on every PR.
 *
 * Usage:
 *   node tests/adaptive-eval.mjs
 *   npx tsx tests/adaptive-eval.mjs   (TypeScript source, dev only)
 */

import { runEvaluationSuite } from '../src/services/daemonEvaluation.js'

const result = runEvaluationSuite()

console.log(`\nAdaptive evaluation suite  (policy v${result.policyVersion})`)
console.log(`  Total:  ${result.total}`)
console.log(`  Passed: ${result.passed}`)
console.log(`  Failed: ${result.failed}`)

for (const c of result.cases) {
  const icon = c.passed ? '✅' : '❌'
  console.log(`  ${icon} [${c.category}] ${c.name}` + (c.passed ? '' : `  — ${c.detail}`))
}

if (!result.allPassed) {
  console.error(`\n${result.failed} adaptive evaluation fixture(s) failed.`)
  process.exit(1)
}

console.log('\nAll adaptive evaluation fixtures passed.')
