import { runEvaluationSuite } from '../src/services/daemonEvaluation.ts'

const result = runEvaluationSuite()

if (!result.allPassed || result.total !== 20) {
  if (result.total !== 20) {
    console.error(`Expected 20 evaluation cases, got ${result.total}`)
  }
  for (const evaluation of result.cases.filter(({ passed }) => !passed)) {
    console.error(`${evaluation.name}: ${evaluation.detail}`)
  }
  process.exitCode = 1
}
