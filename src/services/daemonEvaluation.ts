/**
 * Daemon Adaptive Evaluation
 *
 * Local-only, deterministic evaluation of the adaptive layer. Computes
 * privacy-safe aggregate metrics from data that already exists on the device
 * and runs a fixed fixture suite that asserts the safety and precedence rules
 * still hold.
 *
 * Nothing here sends data anywhere, and no metric contains message content.
 */

import type { InteractionRecord } from './daemon_learning_integration'
import type { StrategyScore, ResponseStrategy } from './daemonResponsePolicy'
import {
  RESPONSE_STRATEGIES,
  allowedStrategiesFor,
  buildContextKey,
  selectStrategy,
  scoreValue,
} from './daemonResponsePolicy'
import type { AdaptiveProfile, AdaptivePreference } from './daemonAdaptiveProfile'
import { ADAPTIVE_POLICY_VERSION, isValidAdaptiveValue } from './daemonAdaptiveProfile'
import { retrieveRelevantMemories, containsForbiddenContent } from './daemonMemoryRetrieval'
import type { DurableMemory } from './daemonMemory'
import { classifyComplexity, routeRequest } from './daemonCapabilityRouter'
import type { RoutingContext } from './daemonCapabilityRouter'

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface EvalMetrics {
  feedbackRates: Record<string, { helpful: number; unhelpful: number; total: number }>
  preferenceOverrideCount: number
  memoryRetrievalUsage: number
  strategyDistribution: Record<ResponseStrategy, number>
  latencyCategory: 'fast' | 'medium' | 'slow'
  errorCount: number
}

function emptyStrategyDistribution(): Record<ResponseStrategy, number> {
  const dist = {} as Record<ResponseStrategy, number>
  for (const strategy of RESPONSE_STRATEGIES) dist[strategy] = 0
  return dist
}

/** Interactions per second thresholds are not measured here; complexity is a proxy. */
const SLOW_COMPLEX_RATIO = 0.5
const FAST_SIMPLE_RATIO = 0.6

/**
 * Aggregates local interaction history and strategy scores into
 * content-free metrics suitable for display or debugging.
 */
export function computeLocalMetrics(
  interactions: InteractionRecord[],
  strategyScores: StrategyScore[],
): EvalMetrics {
  const feedbackRates: Record<string, { helpful: number; unhelpful: number; total: number }> = {}
  const strategyDistribution = emptyStrategyDistribution()
  let memoryRetrievalUsage = 0
  let errorCount = 0
  let simple = 0
  let complex = 0

  for (const record of interactions ?? []) {
    if (!record || !record.metadata) {
      errorCount++
      continue
    }
    const intent = record.metadata.intent || 'unknown'
    const bucket = feedbackRates[intent] ?? { helpful: 0, unhelpful: 0, total: 0 }
    bucket.total++
    if (record.feedback?.rating === 'helpful') bucket.helpful++
    if (record.feedback?.rating === 'unhelpful') bucket.unhelpful++
    feedbackRates[intent] = bucket

    if ((record.metadata.memoryUsed ?? 0) > 0) memoryRetrievalUsage++
    if (record.metadata.planComplexity === 'simple') simple++
    if (record.metadata.planComplexity === 'complex') complex++

    const strategy = record.metadata.strategy
    if (strategy && (RESPONSE_STRATEGIES as readonly string[]).includes(strategy)) {
      strategyDistribution[strategy as ResponseStrategy]++
    }
  }

  let preferenceOverrideCount = 0
  for (const score of strategyScores ?? []) {
    if (!score) continue
    // Each unhelpful rating is the user overriding the approach Daemon chose.
    preferenceOverrideCount += score.unhelpful
  }

  const total = (interactions ?? []).length
  let latencyCategory: EvalMetrics['latencyCategory'] = 'medium'
  if (total > 0) {
    if (complex / total >= SLOW_COMPLEX_RATIO) latencyCategory = 'slow'
    else if (simple / total >= FAST_SIMPLE_RATIO) latencyCategory = 'fast'
  }

  return {
    feedbackRates,
    preferenceOverrideCount,
    memoryRetrievalUsage,
    strategyDistribution,
    latencyCategory,
    errorCount,
  }
}

/** Aggregate helpfulness per context key, useful for a debug panel. */
export function summarizeStrategyScores(scores: StrategyScore[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const score of scores ?? []) {
    out[`${score.contextKey}|${score.strategy}`] = Math.round(scoreValue(score) * 1000) / 1000
  }
  return out
}

// ---------------------------------------------------------------------------
// Deterministic fixture suite
// ---------------------------------------------------------------------------

export interface EvalCaseResult {
  name: string
  category: 'strategy' | 'preference-precedence' | 'memory' | 'safety' | 'routing'
  passed: boolean
  detail: string
}

export interface EvalSuiteResult {
  cases: EvalCaseResult[]
  passed: number
  failed: number
  total: number
  allPassed: boolean
  policyVersion: number
}

function fixtureProfile(preferences: AdaptivePreference[] = []): AdaptiveProfile {
  return {
    userId: 'local',
    preferences,
    learningEnabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    policyVersion: ADAPTIVE_POLICY_VERSION,
  }
}

function fixtureRoutingContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    intent: 'answer',
    mood: 'neutral',
    complexity: 'simple',
    isAuthenticated: true,
    isOnline: true,
    cloudAvailable: true,
    privacyOptOut: false,
    taskKeywords: [],
    ...overrides,
  }
}

const FIXTURE_MEMORIES: DurableMemory[] = [
  { id: 'a1b2c3d4-0000-4000-8000-000000000001', text: 'I am building a TypeScript React dashboard', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'a1b2c3d4-0000-4000-8000-000000000002', text: 'My favourite hiking trail is near the coast', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'a1b2c3d4-0000-4000-8000-000000000003', text: 'My password is hunter2 for the staging server', createdAt: '2026-01-01T00:00:00.000Z' },
]

/**
 * Runs the fixed evaluation fixtures. Assertions depend only on the
 * allowlists and precedence rules, so the result is stable regardless of any
 * feedback scores stored on the device.
 */
export function runEvaluationSuite(): EvalSuiteResult {
  const cases: EvalCaseResult[] = []

  const check = (
    name: string,
    category: EvalCaseResult['category'],
    passed: boolean,
    detail: string,
  ): void => {
    cases.push({ name, category, passed, detail })
  }

  // — Strategy selection ----------------------------------------------------
  const codingKey = buildContextKey('coding', 'neutral')
  check(
    'coding context key is stable',
    'strategy',
    codingKey === 'coding:neutral',
    `contextKey=${codingKey}`,
  )

  const codingAllowed = allowedStrategiesFor('coding', 'neutral')
  check(
    'coding allows only approved strategies',
    'strategy',
    codingAllowed.every(s => (RESPONSE_STRATEGIES as readonly string[]).includes(s)),
    codingAllowed.join(','),
  )

  const neutralPick = selectStrategy('greeting', 'neutral', fixtureProfile(), {})
  check(
    'greeting resolves to direct-answer',
    'strategy',
    neutralPick.strategy === 'direct-answer',
    neutralPick.strategy,
  )

  const repeatPick = selectStrategy('greeting', 'neutral', fixtureProfile(), {})
  check(
    'selection is reproducible',
    'strategy',
    repeatPick.strategy === neutralPick.strategy,
    `${neutralPick.strategy} === ${repeatPick.strategy}`,
  )

  // — Preference precedence -------------------------------------------------
  const inferredStrategy: AdaptivePreference = {
    key: 'preferred_problem_solving_strategy',
    value: 'step-by-step-plan',
    confidence: 0.9,
    evidenceCount: 9,
    source: 'explicit-user-confirmation',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    explanation: 'Confirmed by the user.',
  }
  const codingPick = selectStrategy('coding', 'neutral', fixtureProfile([inferredStrategy]), {})
  check(
    'confirmed strategy is honoured when approved',
    'preference-precedence',
    codingPick.strategy === 'step-by-step-plan',
    codingPick.strategy,
  )

  const concisePick = selectStrategy('coding', 'neutral', fixtureProfile([inferredStrategy]), {
    detail_level: 'concise',
  })
  check(
    'explicit concise setting filters long-form strategies',
    'preference-precedence',
    concisePick.strategy !== 'step-by-step-plan',
    concisePick.strategy,
  )

  check(
    'adaptive values stay inside the allowlist',
    'preference-precedence',
    isValidAdaptiveValue('response_detail_tendency', 'concise')
      && !isValidAdaptiveValue('response_detail_tendency', 'verbose'),
    'allowlist enforced',
  )

  // — Safety boundaries -----------------------------------------------------
  for (const mood of ['sad', 'overwhelmed', 'discouraged']) {
    const pick = selectStrategy('humor', mood, fixtureProfile(), {})
    const allowed = allowedStrategiesFor('humor', mood)
    check(
      `distress mood "${mood}" stays supportive`,
      'safety',
      allowed.includes(pick.strategy) && !allowed.includes('tradeoff-options'),
      `${pick.strategy} of [${allowed.join(',')}]`,
    )
  }

  check(
    'forbidden content is detected',
    'safety',
    containsForbiddenContent('my password is hunter2')
      && !containsForbiddenContent('I prefer concise answers'),
    'forbidden pattern matching works',
  )

  // — Memory retrieval ------------------------------------------------------
  const retrieved = retrieveRelevantMemories(
    'help me with my typescript dashboard',
    FIXTURE_MEMORIES,
    fixtureProfile(),
    { maxItems: 5, maxTotalChars: 1000, minRelevanceScore: 0.1 },
  )
  check(
    'relevant memory is retrieved',
    'memory',
    retrieved.some(m => m.text.includes('TypeScript React dashboard')),
    `${retrieved.length} item(s)`,
  )
  check(
    'secret-bearing memory is excluded',
    'memory',
    !retrieved.some(m => m.text.includes('hunter2')),
    'no credentials retrieved',
  )
  check(
    'retrieval respects item bound',
    'memory',
    retrieveRelevantMemories('typescript dashboard coast', FIXTURE_MEMORIES, fixtureProfile(), {
      maxItems: 1,
    }).length <= 1,
    'maxItems honoured',
  )

  // — Routing ---------------------------------------------------------------
  const offline = routeRequest(fixtureRoutingContext({ isOnline: false }))
  check('offline routes local', 'routing', offline.mode === 'local' && offline.reason === 'offline', offline.mode)

  const anon = routeRequest(fixtureRoutingContext({ isAuthenticated: false }))
  check('unauthenticated routes local', 'routing', anon.mode === 'local' && anon.reason === 'unauthenticated', anon.mode)

  const complex = routeRequest(fixtureRoutingContext({ complexity: 'complex' }))
  check('complex + authenticated routes cloud', 'routing', complex.mode === 'cloud', complex.mode)

  const optOut = routeRequest(fixtureRoutingContext({ privacyOptOut: true, complexity: 'complex' }))
  check('privacy opt-out stays local', 'routing', optOut.mode === 'local' && optOut.reason === 'privacy-opt-out', optOut.mode)

  const research = routeRequest(fixtureRoutingContext({ taskKeywords: ['latest', 'news'] }))
  check(
    'unavailable research capability falls back',
    'routing',
    research.reason === 'capability-unavailable' && research.safeFallback === 'local',
    research.mode,
  )

  check(
    'complexity classification is deterministic',
    'routing',
    classifyComplexity('hi', 'greeting') === 'simple'
      && classifyComplexity('compare the tradeoffs of these two architectures', 'answer') === 'complex',
    'classification stable',
  )

  const passed = cases.filter(c => c.passed).length
  return {
    cases,
    passed,
    failed: cases.length - passed,
    total: cases.length,
    allPassed: passed === cases.length,
    policyVersion: ADAPTIVE_POLICY_VERSION,
  }
}
