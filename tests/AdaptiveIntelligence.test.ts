/**
 * Deterministic tests for Daemon's adaptive intelligence foundation.
 *
 * Covers the adaptive profile (inference thresholds, decay, cooldown,
 * validation, controls), the response strategy policy (allowlists, safety
 * boundaries, feedback attribution, deterministic selection), bounded memory
 * retrieval with forbidden-category exclusion, capability routing, and the
 * no-secrets-in-frontend invariant.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

import {
  ADAPTIVE_PREFERENCE_ALLOWED_VALUES,
  ADAPTIVE_MIN_EVIDENCE,
  ADAPTIVE_EXPIRY_DAYS,
  ADAPTIVE_TRUST_THRESHOLD,
  ADAPTIVE_POLICY_VERSION,
  getAdaptiveProfile,
  getAdaptiveEvidence,
  updateInferredPreference,
  explicitlyConfirmPreference,
  removePreference,
  resetAllInferredPreferences,
  deleteAdaptiveProfile,
  setLearningEnabled,
  isLearningEnabled,
  exportAdaptiveProfile,
  getEffectivePreference,
  getPreference,
  setAdaptiveProfileUserId,
  isValidAdaptiveKey,
  isValidAdaptiveValue,
  assertAdaptivePair,
} from '../src/services/daemonAdaptiveProfile'
import type { AdaptivePreferenceKey, AdaptiveProfile } from '../src/services/daemonAdaptiveProfile'

import {
  STRATEGY_ALLOWLIST,
  DISTRESS_MOODS,
  RESPONSE_STRATEGIES,
  allowedStrategiesFor,
  isStrategyAllowed,
  buildContextKey,
  selectStrategy,
  updateStrategyScore,
  attributeFeedback,
  loadStrategyScores,
  saveStrategyScores,
  getStrategyScores,
  clearStrategyScores,
  scoreValue,
} from '../src/services/daemonResponsePolicy'
import type { ResponseStrategy } from '../src/services/daemonResponsePolicy'

import {
  scoreRelevance,
  retrieveRelevantMemories,
  containsForbiddenContent,
  FORBIDDEN_MEMORY_PATTERNS,
  DEFAULT_RETRIEVAL_CONFIG,
} from '../src/services/daemonMemoryRetrieval'
import type { DurableMemory } from '../src/services/daemonMemory'

import {
  classifyComplexity,
  routeRequest,
  extractTaskKeywords,
  RESEARCH_CAPABILITY_ENABLED,
  TOOL_CAPABILITY_ENABLED,
} from '../src/services/daemonCapabilityRouter'
import type { RoutingContext } from '../src/services/daemonCapabilityRouter'

import { computeLocalMetrics, runEvaluationSuite } from '../src/services/daemonEvaluation'
import type { InteractionRecord } from '../src/services/daemon_learning_integration'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

function resetStorage(): void {
  localStorage.clear()
}

function emptyProfile(overrides: Partial<AdaptiveProfile> = {}): AdaptiveProfile {
  return {
    userId: 'local',
    preferences: [],
    learningEnabled: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    policyVersion: ADAPTIVE_POLICY_VERSION,
    ...overrides,
  }
}

/** Records n positive signals for a key/value pair. */
function reinforce(key: AdaptivePreferenceKey, value: string, times: number): void {
  for (let i = 0; i < times; i++) {
    updateInferredPreference(key, value, true)
  }
}

function routingContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
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

beforeEach(() => {
  resetStorage()
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// 1. Explicit preference override
// ---------------------------------------------------------------------------

describe('explicit preference precedence', () => {
  it('explicit personality preference overrides an inferred adaptive value', () => {
    reinforce('response_detail_tendency', 'detailed', ADAPTIVE_MIN_EVIDENCE)
    expect(getPreference('response_detail_tendency')?.value).toBe('detailed')

    expect(getEffectivePreference('response_detail_tendency', { detail_level: 'concise' }))
      .toBe('concise')
  })

  it('falls back to the inferred value only when nothing explicit is set', () => {
    reinforce('directness_preference', 'direct', ADAPTIVE_MIN_EVIDENCE)
    expect(getEffectivePreference('directness_preference', {})).toBe('direct')
    expect(getEffectivePreference('directness_preference', { directness: 'gentle' })).toBe('gentle')
  })

  it('maps an explicit follow-up setting onto the adaptive tolerance key', () => {
    reinforce('follow_up_question_tolerance', 'high', ADAPTIVE_MIN_EVIDENCE)
    expect(getEffectivePreference('follow_up_question_tolerance', { follow_up_questions: false }))
      .toBe('low')
    expect(getEffectivePreference('follow_up_question_tolerance', {})).toBe('high')
  })

  it('explicit confirmation is durable and is not overwritten by feedback', () => {
    explicitlyConfirmPreference('desired_structure', 'checklist')
    reinforce('desired_structure', 'narrative', ADAPTIVE_MIN_EVIDENCE + 3)

    const pref = getPreference('desired_structure')
    expect(pref?.value).toBe('checklist')
    expect(pref?.source).toBe('explicit-user-confirmation')
    expect(pref?.expiresAt).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. Inference thresholds, confidence, decay, learning toggle
// ---------------------------------------------------------------------------

describe('inference thresholds', () => {
  it('requires at least three evidence events before inferring', () => {
    updateInferredPreference('response_detail_tendency', 'concise', true)
    expect(getAdaptiveProfile().preferences).toHaveLength(0)

    updateInferredPreference('response_detail_tendency', 'concise', true)
    expect(getAdaptiveProfile().preferences).toHaveLength(0)

    updateInferredPreference('response_detail_tendency', 'concise', true)
    const prefs = getAdaptiveProfile().preferences
    expect(prefs).toHaveLength(1)
    expect(prefs[0].value).toBe('concise')
    expect(prefs[0].evidenceCount).toBe(ADAPTIVE_MIN_EVIDENCE)
    expect(prefs[0].source).toBe('feedback-derived')
  })

  it('increases confidence as evidence accumulates but never reaches 1', () => {
    reinforce('humor_preference', 'light', ADAPTIVE_MIN_EVIDENCE)
    const initial = getPreference('humor_preference')!.confidence
    expect(initial).toBeGreaterThan(0)
    expect(initial).toBeLessThan(1)

    reinforce('humor_preference', 'light', 4)
    const grown = getPreference('humor_preference')!.confidence
    expect(grown).toBeGreaterThan(initial)
    expect(grown).toBeLessThan(1)
  })

  it('negative feedback reduces confidence', () => {
    reinforce('directness_preference', 'direct', ADAPTIVE_MIN_EVIDENCE + 3)
    const before = getPreference('directness_preference')!.confidence

    updateInferredPreference('directness_preference', 'direct', false)
    const after = getPreference('directness_preference')!.confidence

    expect(after).toBeLessThan(before)
  })

  it('drops a preference once repeated negative feedback exhausts confidence', () => {
    reinforce('directness_preference', 'direct', ADAPTIVE_MIN_EVIDENCE)
    for (let i = 0; i < 10; i++) {
      updateInferredPreference('directness_preference', 'direct', false)
    }
    expect(getPreference('directness_preference')).toBeUndefined()
  })

  it('does not return expired feedback-derived preferences as active', () => {
    reinforce('desired_structure', 'summary', ADAPTIVE_MIN_EVIDENCE)
    expect(getPreference('desired_structure')).toBeDefined()

    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + (ADAPTIVE_EXPIRY_DAYS + 1) * DAY_MS))

    expect(getAdaptiveProfile().preferences).toHaveLength(0)
    expect(getPreference('desired_structure')).toBeUndefined()
  })

  it('reinforcement pushes the expiry window out', () => {
    reinforce('desired_structure', 'summary', ADAPTIVE_MIN_EVIDENCE)
    const firstExpiry = getPreference('desired_structure')!.expiresAt!

    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 10 * DAY_MS))
    updateInferredPreference('desired_structure', 'summary', true)

    const secondExpiry = getPreference('desired_structure')!.expiresAt!
    expect(Date.parse(secondExpiry)).toBeGreaterThan(Date.parse(firstExpiry))
  })

  it('requires repeated confirmation before changing an established value (cooldown)', () => {
    reinforce('response_detail_tendency', 'concise', ADAPTIVE_MIN_EVIDENCE)
    expect(getPreference('response_detail_tendency')!.value).toBe('concise')

    // A single competing signal is not enough to flip the value.
    updateInferredPreference('response_detail_tendency', 'detailed', true)
    expect(getPreference('response_detail_tendency')!.value).toBe('concise')

    updateInferredPreference('response_detail_tendency', 'detailed', true)
    expect(getPreference('response_detail_tendency')!.value).toBe('concise')

    // Threshold plus cooldown satisfied — now it may change.
    updateInferredPreference('response_detail_tendency', 'detailed', true)
    expect(getPreference('response_detail_tendency')!.value).toBe('detailed')
  })

  it('records evidence for every signal', () => {
    reinforce('helpful_contexts', 'coding', 2)
    updateInferredPreference('helpful_contexts', 'coding', false)
    const evidence = getAdaptiveEvidence()
    expect(evidence).toHaveLength(3)
    expect(evidence.filter(e => e.isPositive)).toHaveLength(2)
    expect(evidence.every(e => e.key === 'helpful_contexts')).toBe(true)
  })
})

describe('learning toggle', () => {
  it('stops all new inference when disabled', () => {
    setLearningEnabled(false)
    expect(isLearningEnabled()).toBe(false)

    reinforce('response_detail_tendency', 'concise', ADAPTIVE_MIN_EVIDENCE + 5)
    expect(getAdaptiveProfile().preferences).toHaveLength(0)
    expect(getAdaptiveEvidence()).toHaveLength(0)
  })

  it('keeps existing entries visible and manageable while disabled', () => {
    reinforce('response_detail_tendency', 'concise', ADAPTIVE_MIN_EVIDENCE)
    setLearningEnabled(false)

    const profile = getAdaptiveProfile()
    expect(profile.learningEnabled).toBe(false)
    expect(profile.preferences).toHaveLength(1)

    removePreference('response_detail_tendency')
    expect(getAdaptiveProfile().preferences).toHaveLength(0)
  })

  it('resumes inference when re-enabled', () => {
    setLearningEnabled(false)
    reinforce('humor_preference', 'none', ADAPTIVE_MIN_EVIDENCE)
    expect(getAdaptiveProfile().preferences).toHaveLength(0)

    setLearningEnabled(true)
    reinforce('humor_preference', 'none', ADAPTIVE_MIN_EVIDENCE)
    expect(getPreference('humor_preference')?.value).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// 3. Validation — no arbitrary or sensitive keys/values
// ---------------------------------------------------------------------------

describe('adaptive profile validation', () => {
  it('rejects keys outside the allowlist', () => {
    for (const forbidden of [
      'political_affiliation',
      'religion',
      'sexual_orientation',
      'health_status',
      'home_address',
      'password',
      '__proto__',
    ]) {
      expect(isValidAdaptiveKey(forbidden)).toBe(false)
      expect(() => updateInferredPreference(forbidden as AdaptivePreferenceKey, 'x', true)).toThrow()
      expect(() => explicitlyConfirmPreference(forbidden as AdaptivePreferenceKey, 'x')).toThrow()
    }
  })

  it('rejects values outside the per-key allowlist', () => {
    expect(isValidAdaptiveValue('response_detail_tendency', 'verbose')).toBe(false)
    expect(() => updateInferredPreference('response_detail_tendency', 'verbose', true)).toThrow()
    expect(() => explicitlyConfirmPreference('humor_preference', 'savage')).toThrow()
    expect(() => assertAdaptivePair('desired_structure', 'haiku')).toThrow()
  })

  it('accepts every allowlisted key/value pair', () => {
    for (const key of Object.keys(ADAPTIVE_PREFERENCE_ALLOWED_VALUES) as AdaptivePreferenceKey[]) {
      for (const value of ADAPTIVE_PREFERENCE_ALLOWED_VALUES[key]) {
        expect(isValidAdaptiveValue(key, value)).toBe(true)
        expect(() => assertAdaptivePair(key, value)).not.toThrow()
      }
    }
  })

  it('discards stored entries that fall outside the allowlist', () => {
    localStorage.setItem('daemon_adaptive_profile', JSON.stringify({
      userId: 'local',
      learningEnabled: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
      policyVersion: 1,
      preferences: [
        { key: 'political_affiliation', value: 'party', confidence: 1, evidenceCount: 9, source: 'feedback-derived', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', explanation: 'x' },
        { key: 'response_detail_tendency', value: 'nonsense', confidence: 1, evidenceCount: 9, source: 'feedback-derived', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', explanation: 'x' },
        { key: 'response_detail_tendency', value: 'concise', confidence: 0.6, evidenceCount: 3, source: 'feedback-derived', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', explanation: 'ok' },
      ],
    }))

    const prefs = getAdaptiveProfile().preferences
    expect(prefs).toHaveLength(1)
    expect(prefs[0].key).toBe('response_detail_tendency')
    expect(prefs[0].value).toBe('concise')
  })

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem('daemon_adaptive_profile', 'not json')
    expect(getAdaptiveProfile().preferences).toEqual([])
    localStorage.setItem('daemon_adaptive_evidence', '{"not":"an array"}')
    expect(getAdaptiveEvidence()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. Strategy allowlists and safety boundaries
// ---------------------------------------------------------------------------

describe('strategy allowlists', () => {
  it('only ever exposes known strategies', () => {
    for (const list of Object.values(STRATEGY_ALLOWLIST)) {
      for (const strategy of list) {
        expect(RESPONSE_STRATEGIES).toContain(strategy)
      }
    }
  })

  it('restricts each intent to its approved subset', () => {
    expect(allowedStrategiesFor('greeting', 'neutral')).toEqual(['direct-answer'])
    expect(allowedStrategiesFor('confused', 'neutral')).toEqual(['step-by-step-plan', 'clarify-first'])
    expect(isStrategyAllowed('greeting', 'neutral', 'tradeoff-options')).toBe(false)
  })

  it('falls back to the default allowlist for unknown intents', () => {
    expect(allowedStrategiesFor('totally-unknown-intent', 'neutral'))
      .toEqual(STRATEGY_ALLOWLIST.default)
  })

  it('never offers humor-oriented handling in distress moods', () => {
    for (const mood of DISTRESS_MOODS) {
      const allowed = allowedStrategiesFor('humor', mood)
      expect(allowed.length).toBeGreaterThan(0)
      expect(allowed).toEqual(expect.arrayContaining([]))
      // Distress moods are limited to supportive strategies only.
      for (const strategy of allowed) {
        expect(['listen-first', 'direct-answer', 'concise-action-plan']).toContain(strategy)
      }
    }
  })

  it('selects a supportive strategy for distress moods regardless of learned scores', () => {
    // Poison the scores so an unsupportive strategy would win if allowed.
    saveStrategyScores([
      { strategy: 'tradeoff-options', contextKey: 'humor:sad', helpful: 100, unhelpful: 0, confidence: 1, lastUpdatedAt: new Date().toISOString() },
      { strategy: 'research-and-cite', contextKey: 'answer:overwhelmed', helpful: 100, unhelpful: 0, confidence: 1, lastUpdatedAt: new Date().toISOString() },
    ])

    for (const [intent, mood] of [['humor', 'sad'], ['answer', 'overwhelmed'], ['suggest', 'discouraged']]) {
      const result = selectStrategy(intent, mood, emptyProfile(), {})
      expect(allowedStrategiesFor(intent, mood)).toContain(result.strategy)
      expect(['tradeoff-options', 'research-and-cite']).not.toContain(result.strategy)
    }
  })

  it('mood constraints override intent constraints', () => {
    // 'suggest' normally allows tradeoff-options, but an overwhelmed user must
    // get supportive handling instead.
    const allowed = allowedStrategiesFor('suggest', 'overwhelmed')
    expect(allowed).toContain('concise-action-plan')
    expect(allowed).not.toContain('tradeoff-options')
  })

  it('never lets a trusted inferred strategy escape the safety allowlist', () => {
    const profile = emptyProfile({
      preferences: [{
        key: 'preferred_problem_solving_strategy',
        value: 'tradeoff-options',
        confidence: 0.95,
        evidenceCount: 20,
        source: 'explicit-user-confirmation',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        explanation: 'confirmed',
      }],
    })
    const result = selectStrategy('answer', 'sad', profile, {})
    expect(result.strategy).not.toBe('tradeoff-options')
    expect(allowedStrategiesFor('answer', 'sad')).toContain(result.strategy)
  })
})

// ---------------------------------------------------------------------------
// 5. Strategy scoring and deterministic selection
// ---------------------------------------------------------------------------

describe('strategy scoring and selection', () => {
  it('builds a stable context key', () => {
    expect(buildContextKey('coding', 'frustrated')).toBe('coding:frustrated')
    expect(buildContextKey('', '')).toBe('default:neutral')
  })

  it('persists scores and reloads them', () => {
    updateStrategyScore('coding:neutral', 'direct-answer', true)
    const scores = loadStrategyScores()
    expect(scores).toHaveLength(1)
    expect(scores[0]).toMatchObject({ contextKey: 'coding:neutral', strategy: 'direct-answer', helpful: 1, unhelpful: 0 })
    expect(getStrategyScores()).toEqual(scores)
  })

  it('rejects unknown strategies', () => {
    expect(() => updateStrategyScore('coding:neutral', 'humor-first' as ResponseStrategy, true)).toThrow()
    expect(() => updateStrategyScore('', 'direct-answer', true)).toThrow()
  })

  it('scores helpful above unhelpful', () => {
    expect(scoreValue({ helpful: 9, unhelpful: 0 })).toBeGreaterThan(scoreValue({ helpful: 0, unhelpful: 9 }))
    expect(scoreValue({ helpful: 0, unhelpful: 0 })).toBeCloseTo(0.5, 5)
  })

  it('explores an unrated approved strategy before ranking', () => {
    const first = selectStrategy('coding', 'neutral', emptyProfile(), {})
    expect(first.explorationUsed).toBe(true)
    expect(allowedStrategiesFor('coding', 'neutral')).toContain(first.strategy)
  })

  it('is reproducible for identical inputs', () => {
    for (const strategy of allowedStrategiesFor('coding', 'neutral')) {
      updateStrategyScore('coding:neutral', strategy, true)
    }
    const a = selectStrategy('coding', 'neutral', emptyProfile(), {})
    const b = selectStrategy('coding', 'neutral', emptyProfile(), {})
    expect(a.strategy).toBe(b.strategy)
    expect(a.contextKey).toBe(b.contextKey)
  })

  it('breaks ties alphabetically', () => {
    const contextKey = 'coding:neutral'
    // Identical scores for every approved strategy → alphabetical winner.
    for (const strategy of allowedStrategiesFor('coding', 'neutral')) {
      updateStrategyScore(contextKey, strategy, true)
    }
    const expected = [...allowedStrategiesFor('coding', 'neutral')].sort()[0]
    expect(selectStrategy('coding', 'neutral', emptyProfile(), {}).strategy).toBe(expected)
  })

  it('prefers the highest-scoring approved strategy', () => {
    const contextKey = 'coding:neutral'
    for (const strategy of allowedStrategiesFor('coding', 'neutral')) {
      updateStrategyScore(contextKey, strategy, false)
    }
    for (let i = 0; i < 5; i++) {
      updateStrategyScore(contextKey, 'step-by-step-plan', true)
    }
    expect(selectStrategy('coding', 'neutral', emptyProfile(), {}).strategy).toBe('step-by-step-plan')
  })

  it('honours a trusted inferred problem-solving strategy', () => {
    const profile = emptyProfile({
      preferences: [{
        key: 'preferred_problem_solving_strategy',
        value: 'step-by-step-plan',
        confidence: ADAPTIVE_TRUST_THRESHOLD + 0.2,
        evidenceCount: 8,
        source: 'feedback-derived',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        explanation: 'inferred',
      }],
    })
    const result = selectStrategy('coding', 'neutral', profile, {})
    expect(result.strategy).toBe('step-by-step-plan')
    expect(result.explorationUsed).toBe(false)
  })

  it('ignores a low-confidence inferred strategy', () => {
    const profile = emptyProfile({
      preferences: [{
        key: 'preferred_problem_solving_strategy',
        value: 'step-by-step-plan',
        confidence: 0.4,
        evidenceCount: 3,
        source: 'feedback-derived',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        explanation: 'inferred',
      }],
    })
    // Rate everything so exploration does not mask the ranking path.
    for (const strategy of allowedStrategiesFor('coding', 'neutral')) {
      updateStrategyScore('coding:neutral', strategy, false)
    }
    for (let i = 0; i < 4; i++) updateStrategyScore('coding:neutral', 'direct-answer', true)

    expect(selectStrategy('coding', 'neutral', profile, {}).strategy).toBe('direct-answer')
  })

  it('lets explicit personality settings filter the candidate set', () => {
    const result = selectStrategy('coding', 'neutral', emptyProfile(), { detail_level: 'concise' })
    expect(result.strategy).not.toBe('step-by-step-plan')

    const noFollowUp = selectStrategy('answer', 'neutral', emptyProfile(), { follow_up_questions: false })
    expect(noFollowUp.strategy).not.toBe('clarify-first')
  })

  it('never lets a filter empty the approved set', () => {
    // 'clarify' allows clarify-first and direct-answer; disabling follow-ups
    // must still leave a valid option.
    const result = selectStrategy('clarify', 'neutral', emptyProfile(), { follow_up_questions: false })
    expect(allowedStrategiesFor('clarify', 'neutral')).toContain(result.strategy)
  })

  it('ignores corrupt stored scores', () => {
    localStorage.setItem('daemon_strategy_scores', JSON.stringify([
      { strategy: 'not-a-strategy', contextKey: 'coding:neutral', helpful: 5, unhelpful: 0 },
      'garbage',
    ]))
    expect(loadStrategyScores()).toHaveLength(0)
  })

  it('clears scores on request', () => {
    updateStrategyScore('coding:neutral', 'direct-answer', true)
    clearStrategyScores()
    expect(getStrategyScores()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Feedback attribution
// ---------------------------------------------------------------------------

describe('feedback attribution', () => {
  it('updates the score of the strategy that produced the response', () => {
    attributeFeedback('coding:neutral', 'step-by-step-plan', true)
    attributeFeedback('coding:neutral', 'step-by-step-plan', true)
    attributeFeedback('coding:neutral', 'direct-answer', false)

    const scores = getStrategyScores()
    const stepwise = scores.find(s => s.strategy === 'step-by-step-plan')!
    const direct = scores.find(s => s.strategy === 'direct-answer')!

    expect(stepwise.helpful).toBe(2)
    expect(stepwise.unhelpful).toBe(0)
    expect(direct.helpful).toBe(0)
    expect(direct.unhelpful).toBe(1)
  })

  it('keeps scores separate per context key', () => {
    attributeFeedback('coding:neutral', 'direct-answer', true)
    attributeFeedback('answer:sad', 'direct-answer', false)

    const scores = getStrategyScores()
    expect(scores).toHaveLength(2)
    expect(scores.find(s => s.contextKey === 'coding:neutral')!.helpful).toBe(1)
    expect(scores.find(s => s.contextKey === 'answer:sad')!.unhelpful).toBe(1)
  })

  it('raises confidence as feedback accumulates', () => {
    attributeFeedback('coding:neutral', 'direct-answer', true)
    const first = getStrategyScores()[0].confidence
    for (let i = 0; i < 5; i++) attributeFeedback('coding:neutral', 'direct-answer', true)
    expect(getStrategyScores()[0].confidence).toBeGreaterThan(first)
  })
})

// ---------------------------------------------------------------------------
// 7. Memory retrieval
// ---------------------------------------------------------------------------

const MEMORIES: DurableMemory[] = [
  { id: '11111111-1111-4111-8111-111111111111', text: 'I am building a TypeScript React dashboard for analytics', createdAt: '2026-08-20T00:00:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', text: 'My favourite hiking trail is near the northern coast', createdAt: '2026-08-20T00:00:00.000Z' },
  { id: '33333333-3333-4333-8333-333333333333', text: 'My password is hunter2 for the staging server', createdAt: '2026-08-20T00:00:00.000Z' },
  { id: '44444444-4444-4444-8444-444444444444', text: 'My api_key for the weather service is stored in the vault', createdAt: '2026-08-20T00:00:00.000Z' },
]

describe('memory retrieval', () => {
  it('scores topic overlap deterministically', () => {
    const strong = scoreRelevance('typescript react dashboard', 'help with my typescript dashboard')
    const weak = scoreRelevance('hiking trail near the coast', 'help with my typescript dashboard')
    expect(strong).toBeGreaterThan(weak)
    expect(strong).toBe(scoreRelevance('typescript react dashboard', 'help with my typescript dashboard'))
  })

  it('returns zero overlap for unrelated text', () => {
    expect(scoreRelevance('hiking trail coast', 'quantum chromodynamics')).toBe(0)
  })

  it('adds a recency bonus for recent memories', () => {
    const now = new Date('2026-08-25T00:00:00.000Z')
    const recent = scoreRelevance('typescript dashboard project', 'typescript dashboard', {
      createdAt: '2026-08-24T00:00:00.000Z', now,
    })
    const older = scoreRelevance('typescript dashboard project', 'typescript dashboard', {
      createdAt: '2025-08-24T00:00:00.000Z', now,
    })
    expect(recent).toBeGreaterThan(older)
  })

  it('gives explicit memories priority over adaptive ones', () => {
    const now = new Date('2026-08-25T00:00:00.000Z')
    const explicit = scoreRelevance('typescript dashboard project', 'typescript dashboard', { type: 'explicit', now })
    const adaptive = scoreRelevance('typescript dashboard project', 'typescript dashboard', { type: 'adaptive-preference', now })
    expect(explicit).toBeGreaterThan(adaptive)
  })

  it('ranks an explicit memory above an equally relevant adaptive preference', () => {
    const profile = emptyProfile({
      preferences: [{
        key: 'helpful_contexts',
        value: 'coding',
        confidence: 0.8,
        evidenceCount: 8,
        source: 'feedback-derived',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
        explanation: 'Inferred from typescript dashboard analytics work.',
      }],
    })
    const results = retrieveRelevantMemories('typescript dashboard analytics', MEMORIES, profile)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].type).toBe('explicit')
  })

  it('excludes forbidden categories', () => {
    const results = retrieveRelevantMemories('what is my password and api key', MEMORIES, emptyProfile())
    expect(results.some(r => r.text.includes('hunter2'))).toBe(false)
    expect(results.some(r => r.text.includes('api_key'))).toBe(false)
  })

  it('detects every prohibited data category', () => {
    const samples = [
      'my password is hunter2',
      'the api key is abcdef',
      'sk-ABCDEFGHIJKLMNOPQRSTUV',
      'my credit card number is 4111 1111 1111 1111',
      'my ssn is 123-45-6789',
      'I live at 12 Example Street',
      'I was diagnosed with something last year',
      'my political affiliation is private',
      "you're all I have",
    ]
    for (const sample of samples) {
      expect(containsForbiddenContent(sample)).toBe(true)
    }
    expect(containsForbiddenContent('I prefer concise answers about TypeScript')).toBe(false)
    expect(containsForbiddenContent('')).toBe(false)
    expect(FORBIDDEN_MEMORY_PATTERNS.length).toBeGreaterThan(5)
  })

  it('respects the maximum item count', () => {
    const results = retrieveRelevantMemories('typescript dashboard hiking coast analytics', MEMORIES, emptyProfile(), {
      maxItems: 1,
      minRelevanceScore: 0,
    })
    expect(results).toHaveLength(1)
  })

  it('respects the maximum total character budget', () => {
    const results = retrieveRelevantMemories('typescript dashboard hiking coast analytics', MEMORIES, emptyProfile(), {
      maxTotalChars: 45,
      minRelevanceScore: 0,
    })
    const total = results.reduce((acc, r) => acc + r.text.length, 0)
    expect(total).toBeLessThanOrEqual(45)
  })

  it('applies the documented defaults', () => {
    expect(DEFAULT_RETRIEVAL_CONFIG).toEqual({ maxItems: 5, maxTotalChars: 1000, minRelevanceScore: 0.1 })
    const results = retrieveRelevantMemories('typescript dashboard', MEMORIES, emptyProfile())
    expect(results.length).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_CONFIG.maxItems)
    expect(results.every(r => r.relevanceScore >= DEFAULT_RETRIEVAL_CONFIG.minRelevanceScore)).toBe(true)
  })

  it('carries provenance and confidence on every item', () => {
    const profile = emptyProfile({
      preferences: [{
        key: 'response_detail_tendency',
        value: 'concise',
        confidence: 0.6,
        evidenceCount: 3,
        source: 'feedback-derived',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
        explanation: 'Inferred concise typescript dashboard responses.',
      }],
    })
    const results = retrieveRelevantMemories('typescript dashboard', MEMORIES, profile, { minRelevanceScore: 0 })
    expect(results.length).toBeGreaterThan(0)
    for (const item of results) {
      expect(['explicit', 'adaptive-preference']).toContain(item.type)
      expect(item.source.length).toBeGreaterThan(0)
      expect(item.confidence).toBeGreaterThanOrEqual(0)
      expect(item.confidence).toBeLessThanOrEqual(1)
    }
  })

  it('handles empty inputs safely', () => {
    expect(retrieveRelevantMemories('anything', [], emptyProfile())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 8. Capability routing
// ---------------------------------------------------------------------------

describe('capability routing', () => {
  it('classifies complexity deterministically', () => {
    expect(classifyComplexity('hi', 'greeting')).toBe('simple')
    expect(classifyComplexity('thanks', 'acknowledge')).toBe('simple')
    expect(classifyComplexity('how do I write a for loop', 'coding')).toBe('moderate')
    expect(classifyComplexity('compare the tradeoffs of these two architectures', 'answer')).toBe('complex')
    expect(classifyComplexity('a '.repeat(80), 'answer')).toBe('complex')
    expect(classifyComplexity('hi', 'greeting')).toBe(classifyComplexity('hi', 'greeting'))
  })

  it('routes offline requests locally', () => {
    const decision = routeRequest(routingContext({ isOnline: false, complexity: 'complex' }))
    expect(decision.mode).toBe('local')
    expect(decision.reason).toBe('offline')
    expect(decision.safeFallback).toBe('local')
  })

  it('routes unauthenticated requests locally', () => {
    const decision = routeRequest(routingContext({ isAuthenticated: false, complexity: 'complex' }))
    expect(decision.mode).toBe('local')
    expect(decision.reason).toBe('unauthenticated')
  })

  it('routes complex authenticated requests to the cloud', () => {
    const decision = routeRequest(routingContext({ complexity: 'complex' }))
    expect(decision.mode).toBe('cloud')
    expect(decision.reason).toBe('complex-reasoning')
  })

  it('keeps simple chat local', () => {
    const decision = routeRequest(routingContext({ complexity: 'simple' }))
    expect(decision.mode).toBe('local')
    expect(decision.reason).toBe('simple-chat')
  })

  it('falls back when the cloud is unavailable', () => {
    const decision = routeRequest(routingContext({ complexity: 'complex', cloudAvailable: false }))
    expect(decision.mode).toBe('local')
    expect(decision.reason).toBe('capability-unavailable')
    expect(decision.requirements.length).toBeGreaterThan(0)
  })

  it('forces local mode on privacy opt-out', () => {
    const decision = routeRequest(routingContext({ privacyOptOut: true, complexity: 'complex' }))
    expect(decision.mode).toBe('local')
    expect(decision.reason).toBe('privacy-opt-out')
  })

  it('reports unconfigured research and tool capabilities honestly', () => {
    expect(RESEARCH_CAPABILITY_ENABLED).toBe(false)
    expect(TOOL_CAPABILITY_ENABLED).toBe(false)

    const research = routeRequest(routingContext({ taskKeywords: ['latest', 'news'] }))
    expect(research.reason).toBe('capability-unavailable')
    expect(research.mode).not.toBe('research')
    expect(research.safeFallback).toBe('local')
    expect(research.userVisibleStatus.length).toBeGreaterThan(0)

    const tool = routeRequest(routingContext({ taskKeywords: ['calculate'] }))
    expect(tool.reason).toBe('capability-unavailable')
    expect(tool.mode).not.toBe('tool')
  })

  it('honours an explicit routing preference when available', () => {
    expect(routeRequest(routingContext({ userPreference: 'local', complexity: 'complex' })).reason)
      .toBe('user-preference')
    expect(routeRequest(routingContext({ userPreference: 'cloud' })).mode).toBe('cloud')
    expect(routeRequest(routingContext({ userPreference: 'cloud', cloudAvailable: false })).mode).toBe('local')
    expect(routeRequest(routingContext({ userPreference: 'research' })).mode).not.toBe('research')
  })

  it('never claims a capability it does not have', () => {
    for (const keywords of [['news'], ['weather'], ['calculate'], ['convert']]) {
      const decision = routeRequest(routingContext({ taskKeywords: keywords }))
      expect(['local', 'cloud']).toContain(decision.mode)
    }
  })

  it('extracts keywords deterministically', () => {
    expect(extractTaskKeywords("What's the latest news today?")).toEqual(['what', 'the', 'latest', 'news', 'today'])
  })
})

// ---------------------------------------------------------------------------
// 9. Adaptive profile controls
// ---------------------------------------------------------------------------

describe('adaptive profile controls', () => {
  it('exposes an inspectable profile', () => {
    const profile = getAdaptiveProfile()
    expect(profile.userId).toBe('local')
    expect(profile.learningEnabled).toBe(true)
    expect(profile.policyVersion).toBe(ADAPTIVE_POLICY_VERSION)
    expect(Array.isArray(profile.preferences)).toBe(true)
  })

  it('accepts an inferred value as an explicit confirmation', () => {
    reinforce('desired_structure', 'plan', ADAPTIVE_MIN_EVIDENCE)
    expect(getPreference('desired_structure')!.source).toBe('feedback-derived')

    explicitlyConfirmPreference('desired_structure', 'plan')
    const pref = getPreference('desired_structure')!
    expect(pref.source).toBe('explicit-user-confirmation')
    expect(pref.confidence).toBe(1)
  })

  it('edits a value to another allowlisted option', () => {
    reinforce('desired_structure', 'plan', ADAPTIVE_MIN_EVIDENCE)
    explicitlyConfirmPreference('desired_structure', 'checklist')
    expect(getPreference('desired_structure')!.value).toBe('checklist')
  })

  it('rejects (removes) a single preference and its evidence', () => {
    reinforce('humor_preference', 'none', ADAPTIVE_MIN_EVIDENCE)
    reinforce('desired_structure', 'summary', ADAPTIVE_MIN_EVIDENCE)

    removePreference('humor_preference')
    expect(getPreference('humor_preference')).toBeUndefined()
    expect(getPreference('desired_structure')).toBeDefined()
    expect(getAdaptiveEvidence().some(e => e.key === 'humor_preference')).toBe(false)
  })

  it('resets all inferred preferences but keeps explicit confirmations', () => {
    reinforce('humor_preference', 'none', ADAPTIVE_MIN_EVIDENCE)
    explicitlyConfirmPreference('desired_structure', 'checklist')

    resetAllInferredPreferences()
    const prefs = getAdaptiveProfile().preferences
    expect(prefs).toHaveLength(1)
    expect(prefs[0].key).toBe('desired_structure')
    expect(getAdaptiveEvidence()).toHaveLength(0)
  })

  it('deletes the whole profile on request', () => {
    reinforce('humor_preference', 'none', ADAPTIVE_MIN_EVIDENCE)
    explicitlyConfirmPreference('desired_structure', 'checklist')
    deleteAdaptiveProfile()
    expect(getAdaptiveProfile().preferences).toHaveLength(0)
    expect(getAdaptiveEvidence()).toHaveLength(0)
  })

  it('exports a readable JSON snapshot with explanations', () => {
    reinforce('response_detail_tendency', 'concise', ADAPTIVE_MIN_EVIDENCE)
    const parsed = JSON.parse(exportAdaptiveProfile()) as {
      profile: AdaptiveProfile
      evidence: unknown[]
    }
    expect(parsed.profile.preferences).toHaveLength(1)
    expect(parsed.profile.preferences[0].explanation.length).toBeGreaterThan(0)
    expect(parsed.evidence.length).toBe(ADAPTIVE_MIN_EVIDENCE)
  })

  it('gives every preference a user-visible explanation and source', () => {
    reinforce('response_detail_tendency', 'concise', ADAPTIVE_MIN_EVIDENCE)
    explicitlyConfirmPreference('humor_preference', 'none')
    for (const pref of getAdaptiveProfile().preferences) {
      expect(pref.explanation.length).toBeGreaterThan(0)
      expect(['feedback-derived', 'explicit-user-confirmation']).toContain(pref.source)
    }
  })

  it('associates the profile with an authenticated user id', () => {
    const updated = setAdaptiveProfileUserId('cbf1cb0e-0000-4000-8000-000000000001')
    expect(updated.userId).toBe('cbf1cb0e-0000-4000-8000-000000000001')
    expect(getAdaptiveProfile().userId).toBe('cbf1cb0e-0000-4000-8000-000000000001')
    expect(setAdaptiveProfileUserId(null).userId).toBe('local')
  })
})

// ---------------------------------------------------------------------------
// Evaluation fixtures
// ---------------------------------------------------------------------------

describe('evaluation', () => {
  it('passes the deterministic fixture suite', () => {
    const result = runEvaluationSuite()
    const failures = result.cases.filter(c => !c.passed)
    expect(failures.map(f => `${f.name}: ${f.detail}`)).toEqual([])
    expect(result.allPassed).toBe(true)
    expect(result.total).toBeGreaterThan(10)
  })

  it('computes content-free local metrics', () => {
    const interactions: InteractionRecord[] = [
      {
        id: '55555555-5555-4555-8555-555555555555',
        input: 'a',
        response: 'b',
        metadata: { intent: 'coding', confidence: 0.5, ambiguity: 0.2, memoryUsed: 1, planComplexity: 'simple', timestamp: new Date(), strategy: 'direct-answer' },
        feedback: { rating: 'helpful', timestamp: new Date() },
      },
      {
        id: '66666666-6666-4666-8666-666666666666',
        input: 'c',
        response: 'd',
        metadata: { intent: 'coding', confidence: 0.5, ambiguity: 0.2, memoryUsed: 0, planComplexity: 'simple', timestamp: new Date(), strategy: 'clarify-first' },
        feedback: { rating: 'unhelpful', timestamp: new Date() },
      },
    ]
    updateStrategyScore('coding:neutral', 'clarify-first', false)

    const metrics = computeLocalMetrics(interactions, getStrategyScores())
    expect(metrics.feedbackRates.coding).toEqual({ helpful: 1, unhelpful: 1, total: 2 })
    expect(metrics.memoryRetrievalUsage).toBe(1)
    expect(metrics.strategyDistribution['direct-answer']).toBe(1)
    expect(metrics.strategyDistribution['clarify-first']).toBe(1)
    expect(metrics.latencyCategory).toBe('fast')
    expect(metrics.errorCount).toBe(0)
    expect(metrics.preferenceOverrideCount).toBe(1)
  })

  it('tolerates malformed interaction records', () => {
    const metrics = computeLocalMetrics([null as unknown as InteractionRecord], [])
    expect(metrics.errorCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 10. No provider secrets in the frontend
// ---------------------------------------------------------------------------

describe('frontend secret hygiene', () => {
  const root = process.cwd()

  function collectFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) collectFiles(full, acc)
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) acc.push(full)
    }
    return acc
  }

  const sourceFiles = collectFiles(path.join(root, 'src'))

  it('finds source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(5)
  })

  it('never references the Supabase service-role key', () => {
    for (const file of sourceFiles) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    }
  })

  it('never references provider API keys or literal secrets', () => {
    const forbidden = [/OPENAI_API_KEY/, /ANTHROPIC_API_KEY/, /\bsk-[A-Za-z0-9]{16,}\b/]
    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        expect(pattern.test(content), `${file} must not contain ${pattern}`).toBe(false)
      }
    }
  })

  it('keeps the adaptive services free of network calls to AI providers', () => {
    const adaptiveFiles = [
      'src/services/daemonAdaptiveProfile.ts',
      'src/services/daemonResponsePolicy.ts',
      'src/services/daemonMemoryRetrieval.ts',
      'src/services/daemonCapabilityRouter.ts',
      'src/services/daemonEvaluation.ts',
    ]
    for (const rel of adaptiveFiles) {
      const content = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(content).not.toContain('api.openai.com')
      expect(content).not.toContain('api.anthropic.com')
      expect(content).not.toMatch(/\bfetch\s*\(/)
    }
  })
})
