import { runEvaluationSuite } from '../src/services/daemonEvaluation.ts'

const result = runEvaluationSuite()

if (!result.allPassed) {
  for (const evaluation of result.cases.filter(({ passed }) => !passed)) {
    console.error(`${evaluation.name}: ${evaluation.detail}`)
  }
  process.exitCode = 1
}
