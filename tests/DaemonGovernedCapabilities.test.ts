import { describe, expect, it, vi } from 'vitest'
import { runCognitiveLoop } from '../src/services/daemonCognitiveLoop'
import {
  acceptLearningItem,
  VALIDATED_LEARNING_MIN_CONFIDENCE,
} from '../src/services/daemonValidatedLearning'
import {
  createSelfImprovementManifest,
  evaluateSelfImprovement,
} from '../src/services/daemonSelfImprovement'
import { runPublicWebResearchGateway } from '../src/services/publicWebResearchGateway'
import { buildResponse, detectIntent, detectMood, generateHumanLikeResponse } from '../src/services/daemonResponseBrain'
import { toPersonalitySettings } from '../src/services/daemonPersonalityPreferences'

describe('daemon cognitive loop', () => {
  it('selects code-propose mode for coding requests', () => {
    const output = runCognitiveLoop({
      userMessage: 'Write a TypeScript function to sort users by score.',
      mood: 'neutral',
      intent: 'coding',
      context: {
        recentConversation: [],
        retrievedMemories: [],
        preferences: {},
        validatedInsights: [],
      },
    })
    expect(output.reasoningMode).toBe('code-propose')
    expect(output.draftPlan.length).toBeGreaterThan(0)
  })

  it('keeps safe lessons and drops secret-bearing lessons', () => {
    const output = runCognitiveLoop({
      userMessage: 'I prefer concise answers in future responses.',
      mood: 'neutral',
      intent: 'answer',
      context: {
        recentConversation: [],
        retrievedMemories: [],
        preferences: {},
        validatedInsights: ['Store this API_KEY: super-secret', 'Prefer concise answer formatting for me.'],
      },
    })
    expect(output.safeLessons).toContain('Prefer concise answer formatting for me.')
    expect(output.safeLessons.some(item => item.includes('API_KEY'))).toBe(false)
  })
})

describe('validated durable learning gate', () => {
  it('accepts validated non-sensitive learning', () => {
    const decision = acceptLearningItem({
      text: 'User prefers concise action-oriented answers.',
      source: 'user-confirmed',
      confidence: VALIDATED_LEARNING_MIN_CONFIDENCE,
      createdAt: new Date().toISOString(),
    })
    expect(decision.accepted).toBe(true)
    expect(decision.code).toBe('accepted')
  })

  it('rejects secrets and sensitive identifiers', () => {
    const secretDecision = acceptLearningItem({
      text: 'password = hunter2',
      source: 'validated-insight',
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    })
    const sensitiveDecision = acceptLearningItem({
      text: 'SSN 123-45-6789',
      source: 'validated-insight',
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    })
    expect(secretDecision.accepted).toBe(false)
    expect(secretDecision.code).toBe('rejected-secret')
    expect(sensitiveDecision.accepted).toBe(false)
    expect(sensitiveDecision.code).toBe('rejected-sensitive')
  })

  it('rejects complete GitHub token forms', () => {
    for (const text of [
      `credential ${'ghp_'}${'a'.repeat(36)}`,
      `credential ${'github_pat_'}${'a'.repeat(82)}`,
    ]) {
      expect(acceptLearningItem({
        text,
        source: 'validated-insight',
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      }).code).toBe('rejected-secret')
    }
  })
})

describe('daemon self-improvement manifest', () => {
  const validManifest = createSelfImprovementManifest({
    sourceBranch: 'copilot/daemon-self-improve',
    changedFiles: ['src/services/daemonSelfImprovement.ts'],
    purpose: 'Propose governed daemon self-improvement metadata.',
    assurances: {
      testsPassed: true,
      securityAssured: true,
      auditAssured: true,
      rollbackAssured: true,
    },
  })

  it('rejects manifests with invalid metadata fields', () => {
    expect(evaluateSelfImprovement({ ...validManifest, sourceBranch: '' }).code).toBe('rejected-source-branch')
    expect(evaluateSelfImprovement({ ...validManifest, proposalId: 'not-a-uuid' }).code).toBe('rejected-proposal-id')
    expect(evaluateSelfImprovement({ ...validManifest, createdAt: 'not-a-date' }).code).toBe('rejected-created-at')
    expect(evaluateSelfImprovement({ ...validManifest, changedFiles: [' '] }).code).toBe('rejected-empty-files')
  })

  it('rejects manifest submission when any assurance is false', () => {
    const manifest = createSelfImprovementManifest({
      sourceBranch: 'copilot/daemon-self-improve',
      changedFiles: ['src/services/daemonSelfImprovement.ts'],
      purpose: 'Propose governed daemon self-improvement metadata.',
      assurances: {
        testsPassed: true,
        securityAssured: false,
        auditAssured: true,
        rollbackAssured: true,
      },
    })
    const decision = evaluateSelfImprovement(manifest)
    expect(manifest.targetBranch).toBe('main')
    expect(decision.accepted).toBe(false)
    expect(decision.code).toBe('rejected-assurance')
  })
})

describe('public web research gateway', () => {
  it('fails closed when no vetted provider is configured', async () => {
    const result = await runPublicWebResearchGateway({ searchQuery: 'latest react releases' }, { provider: undefined })
    expect(result.status).toBe('unavailable')
    expect(result.quarantined).toBe(true)
  })

  it('rejects unsafe URLs before provider execution', async () => {
    const provider = {
      execute: vi.fn(),
    }
    const result = await runPublicWebResearchGateway(
      { url: 'https://localhost/private', method: 'GET' },
      { provider },
    )
    expect(result.status).toBe('policy_blocked')
    expect(provider.execute).not.toHaveBeenCalled()
  })

  it('rejects oversized search queries before provider execution', async () => {
    const provider = { execute: vi.fn() }
    const result = await runPublicWebResearchGateway(
      { searchQuery: 'x'.repeat(1_025) },
      { provider },
    )
    expect(result.status).toBe('policy_blocked')
    expect(provider.execute).not.toHaveBeenCalled()
  })
})

describe('daemon response-brain governed integration', () => {
  it('does not approve unaccepted lessons and preserves response generation behavior', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const personalityPrefs = {
        detail_level: 'balanced',
        warmth: 'balanced',
        humor_level: 'light',
        directness: 'balanced',
        allow_mild_profanity: false,
        follow_up_questions: true,
        custom_greeting: null,
        pattern_recognition: false,
      } as const
      const userMessage = 'Please explain what an API is.'
      const result = buildResponse({
        userMessage,
        personalityPrefs,
        memories: [],
        validatedInsights: ['password = no-store-this', 'User likes concise examples.'],
      })

      const expected = generateHumanLikeResponse(userMessage, {
        userMessage,
        mood: detectMood(userMessage),
        intent: detectIntent(userMessage),
        wantsShortAnswer: result.wantsShortAnswer,
        personality: toPersonalitySettings(personalityPrefs),
      })

      expect(result.text).toBe(expected)
      expect(result.approvedLearningCandidates).toContain('User likes concise examples.')
      expect(result.approvedLearningCandidates.some(item => item.includes('password'))).toBe(false)
      expect(result.cognitive.draftPlan.length).toBeGreaterThan(0)
    } finally {
      randomSpy.mockRestore()
    }
  })
})
