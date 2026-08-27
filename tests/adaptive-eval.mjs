import process from 'node:process'
// Runs under `npx tsx` so this TypeScript module import is supported in CI/local scripts.
import { runEvaluationSuite } from '../src/services/daemonEvaluation.ts'

const EXPECTED_TOTAL = 20
const EXPECTED_COUNTS = {
  strategy: 4,
  'preference-precedence': 3,
  safety: 4,
  memory: 3,
  routing: 6,
}

try {
  const result = runEvaluationSuite()
  const categoryCounts = Object.fromEntries(Object.keys(EXPECTED_COUNTS).map(key => [key, 0]))
  const unexpectedCategories = new Set()

  for (const testCase of result.cases) {
    if (!(testCase.category in EXPECTED_COUNTS)) unexpectedCategories.add(testCase.category)
    categoryCounts[testCase.category] = (categoryCounts[testCase.category] ?? 0) + 1
  }

  if (result.total !== EXPECTED_TOTAL) {
    console.error(`Adaptive evaluation check failed: expected ${EXPECTED_TOTAL} assertions, got ${result.total}.`)
    process.exit(1)
  }

  for (const [category, expected] of Object.entries(EXPECTED_COUNTS)) {
    if (categoryCounts[category] !== expected) {
      console.error(
        `Adaptive evaluation check failed: category "${category}" expected ${expected}, got ${categoryCounts[category]}.`,
      )
      process.exit(1)
    }
  }

  if (unexpectedCategories.size) {
    console.error(
      `Adaptive evaluation check failed: unexpected category(s): ${Array.from(unexpectedCategories).sort().join(', ')}.`,
    )
    process.exit(1)
  }

  if (!result.allPassed) {
    const failed = result.cases.filter(testCase => !testCase.passed)
    console.error('Adaptive evaluation check failed: fixture assertions failed:')
    for (const testCase of failed) {
      console.error(`- [${testCase.category}] ${testCase.name}: ${testCase.detail}`)
    }
    process.exit(1)
  }
  
  console.log(`Adaptive evaluation suite passed (${result.passed}/${result.total}, policy v${result.policyVersion}).`)
} catch (error) {
  console.error(`Adaptive evaluation check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
