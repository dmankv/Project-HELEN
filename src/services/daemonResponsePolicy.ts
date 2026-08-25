/**
 * Daemon Response Strategy Policy
 *
 * Learns which *approved* response strategy works best per (intent, mood)
 * context from thumbs-up/down feedback.
 *
 * Hard boundaries (non-negotiable):
 *   • Learning may only choose between the fixed ResponseStrategy values
 *     below. It cannot invent strategies, change prompts, or alter safety,
 *     crisis, refusal, or factuality behavior.
 *   • Distress contexts (sad / overwhelmed / discouraged) are restricted to
 *     supportive strategies. Humor-first handling is never selectable there.
 *   • Selection is deterministic: identical inputs always give the same
 *     strategy, with alphabetical tie-breaking.
 *   • Explicit user settings outrank learned scores.
 */

import type { AdaptiveProfile } from './daemonAdaptiveProfile'
import { ADAPTIVE_TRUST_THRESHOLD } from './daemonAdaptiveProfile'
import type { PersonalityPreferences } from './daemonPersonalityPreferences'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResponseStrategy =
  | 'direct-answer'
  | 'clarify-first'
  | 'step-by-step-plan'
  | 'listen-first'
  | 'tradeoff-options'
  | 'research-and-cite'
  | 'concise-action-plan'

export const RESPONSE_STRATEGIES: readonly ResponseStrategy[] = [
  'clarify-first',
  'concise-action-plan',
  'direct-answer',
  'listen-first',
  'research-and-cite',
  'step-by-step-plan',
  'tradeoff-options',
]

/**
 * Approved strategy subset per intent and per mood.
 * Safety: sadness/distress contexts must never receive humor-first handling,
 * so their entries only contain supportive, non-joking strategies.
 */
export const STRATEGY_ALLOWLIST: Record<string, ResponseStrategy[]> = {
  'answer': ['direct-answer', 'clarify-first', 'tradeoff-options', 'research-and-cite'],
  'coding': ['direct-answer', 'step-by-step-plan', 'clarify-first'],
  'coding-followup': ['direct-answer', 'step-by-step-plan'],
  'clarify': ['clarify-first', 'direct-answer'],
  'greeting': ['direct-answer'],
  'identity': ['direct-answer'],
  'smalltalk': ['direct-answer', 'listen-first'],
  'acknowledge': ['listen-first', 'direct-answer'],
  'suggest': ['tradeoff-options', 'concise-action-plan', 'direct-answer'],
  'follow-up': ['direct-answer', 'clarify-first'],
  'uncertain': ['clarify-first', 'direct-answer'],
  'sad': ['listen-first', 'direct-answer'],
  'overwhelmed': ['listen-first', 'concise-action-plan'],
  'discouraged': ['listen-first', 'direct-answer'],
  'frustrated': ['listen-first', 'direct-answer', 'clarify-first'],
  'urgent': ['concise-action-plan', 'direct-answer'],
  'excited': ['direct-answer', 'concise-action-plan'],
  'confused': ['step-by-step-plan', 'clarify-first'],
  'prompt-injection': ['direct-answer'],
  'pushback': ['direct-answer', 'listen-first'],
  'humor': ['direct-answer'],
  'default': ['direct-answer', 'clarify-first'],
}

/**
 * Moods where the emotional context overrides the intent's usual strategy set
 * and where humor-first handling is forbidden.
 */
export const DISTRESS_MOODS: readonly string[] = ['sad', 'overwhelmed', 'discouraged']

/** Moods that constrain strategy selection at all (distress plus practical). */
export const MOOD_CONSTRAINED: readonly string[] = [
  'sad',
  'overwhelmed',
  'discouraged',
  'frustrated',
  'urgent',
  'excited',
  'confused',
]

export interface StrategyScore {
  strategy: ResponseStrategy
  contextKey: string
  helpful: number
  unhelpful: number
  confidence: number
  lastUpdatedAt: string
}

export interface StrategySelectionResult {
  strategy: ResponseStrategy
  contextKey: string
  reason: string
  explorationUsed: boolean
}

const SCORES_KEY = 'daemon_strategy_scores'

/** Bounded so localStorage cannot grow without limit. */
const MAX_SCORES = 400

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isResponseStrategy(value: unknown): value is ResponseStrategy {
  return typeof value === 'string' && (RESPONSE_STRATEGIES as readonly string[]).includes(value)
}

export function loadStrategyScores(): StrategyScore[] {
  try {
    const raw = localStorage.getItem(SCORES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((s): s is StrategyScore => {
      if (!s || typeof s !== 'object') return false
      const r = s as Record<string, unknown>
      return isResponseStrategy(r.strategy)
        && typeof r.contextKey === 'string'
        && typeof r.helpful === 'number'
        && typeof r.unhelpful === 'number'
    }).map(s => ({
      strategy: s.strategy,
      contextKey: s.contextKey,
      helpful: Math.max(0, Math.floor(s.helpful)),
      unhelpful: Math.max(0, Math.floor(s.unhelpful)),
      confidence: typeof s.confidence === 'number' ? s.confidence : 0,
      lastUpdatedAt: typeof s.lastUpdatedAt === 'string' ? s.lastUpdatedAt : new Date(0).toISOString(),
    }))
  } catch {
    return []
  }
}

export function saveStrategyScores(scores: StrategyScore[]): void {
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(scores.slice(-MAX_SCORES)))
  } catch { /* quota exceeded — best effort */ }
}

export function getStrategyScores(): StrategyScore[] {
  return loadStrategyScores()
}

export function clearStrategyScores(): void {
  try {
    localStorage.removeItem(SCORES_KEY)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Context keys and allowlists
// ---------------------------------------------------------------------------

/** Stable, human-readable key for one (intent, mood) situation. */
export function buildContextKey(intent: string, mood: string): string {
  return `${intent || 'default'}:${mood || 'neutral'}`
}

/**
 * Approved strategies for a situation. Mood constraints win over intent
 * constraints so that distress contexts stay supportive even when the intent
 * would normally allow, for example, a joke or a research dump.
 */
export function allowedStrategiesFor(intent: string, mood: string): ResponseStrategy[] {
  const intentAllowed = STRATEGY_ALLOWLIST[intent] ?? STRATEGY_ALLOWLIST.default
  const moodAllowed = MOOD_CONSTRAINED.includes(mood) ? STRATEGY_ALLOWLIST[mood] : undefined
  if (!moodAllowed) return [...intentAllowed]
  const intersection = moodAllowed.filter(s => intentAllowed.includes(s))
  // When intent and mood disagree the mood takes precedence — never fall back
  // to an intent strategy that the mood excluded.
  return intersection.length > 0 ? intersection : [...moodAllowed]
}

/** True when `strategy` is approved for the given intent/mood situation. */
export function isStrategyAllowed(intent: string, mood: string, strategy: ResponseStrategy): boolean {
  return allowedStrategiesFor(intent, mood).includes(strategy)
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Laplace-smoothed helpfulness in (0, 1). Unrated strategies score 0.5. */
export function scoreValue(score: Pick<StrategyScore, 'helpful' | 'unhelpful'>): number {
  return (score.helpful + 1) / (score.helpful + score.unhelpful + 2)
}

function confidenceValue(helpful: number, unhelpful: number): number {
  const total = helpful + unhelpful
  return Math.round((total / (total + 5)) * 1000) / 1000
}

/** Records one feedback signal against a (contextKey, strategy) pair. */
export function updateStrategyScore(
  contextKey: string,
  strategy: ResponseStrategy,
  wasHelpful: boolean,
): void {
  if (!isResponseStrategy(strategy)) {
    throw new Error(`Unknown response strategy: ${strategy}`)
  }
  if (!contextKey) throw new Error('contextKey is required')

  const scores = loadStrategyScores()
  const existing = scores.find(s => s.contextKey === contextKey && s.strategy === strategy)
  const nowIso = new Date().toISOString()

  if (existing) {
    existing.helpful += wasHelpful ? 1 : 0
    existing.unhelpful += wasHelpful ? 0 : 1
    existing.confidence = confidenceValue(existing.helpful, existing.unhelpful)
    existing.lastUpdatedAt = nowIso
    saveStrategyScores(scores)
    return
  }

  saveStrategyScores([
    ...scores,
    {
      strategy,
      contextKey,
      helpful: wasHelpful ? 1 : 0,
      unhelpful: wasHelpful ? 0 : 1,
      confidence: confidenceValue(wasHelpful ? 1 : 0, wasHelpful ? 0 : 1),
      lastUpdatedAt: nowIso,
    },
  ])
}

/**
 * Attributes user feedback to the strategy that actually produced the
 * response. Called from the feedback controls once the user rates a reply.
 */
export function attributeFeedback(
  contextKey: string,
  strategy: ResponseStrategy,
  wasHelpful: boolean,
): void {
  updateStrategyScore(contextKey, strategy, wasHelpful)
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Applies explicit personality settings as filters over the approved set.
 * Filters never empty the set — if a filter would remove everything it is
 * skipped, so safety-approved options always remain available.
 */
function applyPersonalityFilters(
  allowed: ResponseStrategy[],
  prefs: PersonalityPreferences,
): ResponseStrategy[] {
  let result = allowed

  if (prefs.follow_up_questions === false) {
    const filtered = result.filter(s => s !== 'clarify-first')
    if (filtered.length > 0) result = filtered
  }

  if (prefs.detail_level === 'concise') {
    const filtered = result.filter(s => s !== 'research-and-cite' && s !== 'step-by-step-plan')
    if (filtered.length > 0) result = filtered
  }

  return result
}

/**
 * Picks the response strategy for a situation.
 *
 * Order of precedence:
 *   1. Safety/approval allowlist for the (intent, mood) situation.
 *   2. Explicit personality settings (as non-emptying filters).
 *   3. A trusted `preferred_problem_solving_strategy` from the adaptive
 *      profile (confidence above ADAPTIVE_TRUST_THRESHOLD).
 *   4. Deterministic exploration of an approved strategy with no feedback yet.
 *   5. Highest Laplace-smoothed score, alphabetical on ties.
 */
export function selectStrategy(
  intent: string,
  mood: string,
  adaptiveProfile: AdaptiveProfile,
  personalityPrefs: PersonalityPreferences,
): StrategySelectionResult {
  const contextKey = buildContextKey(intent, mood)
  const approved = allowedStrategiesFor(intent, mood)
  const candidates = [...applyPersonalityFilters(approved, personalityPrefs ?? {})].sort()

  // Defensive: the allowlist always yields at least one strategy.
  if (candidates.length === 0) {
    return {
      strategy: 'direct-answer',
      contextKey,
      reason: 'No approved strategy for this context; used the safe default.',
      explorationUsed: false,
    }
  }

  const preferred = adaptiveProfile?.preferences?.find(
    p => p.key === 'preferred_problem_solving_strategy',
  )
  if (
    preferred
    && preferred.confidence > ADAPTIVE_TRUST_THRESHOLD
    && isResponseStrategy(preferred.value)
    && candidates.includes(preferred.value)
  ) {
    return {
      strategy: preferred.value,
      contextKey,
      reason: preferred.source === 'explicit-user-confirmation'
        ? 'You confirmed this problem-solving approach.'
        : 'Matches the problem-solving approach that has worked for you before.',
      explorationUsed: false,
    }
  }

  const scores = loadStrategyScores().filter(s => s.contextKey === contextKey)
  const unexplored = candidates.filter(c => !scores.some(s => s.strategy === c))
  if (unexplored.length > 0) {
    return {
      strategy: unexplored[0],
      contextKey,
      reason: 'No feedback yet for this approach in this context; trying it once.',
      explorationUsed: true,
    }
  }

  let best = candidates[0]
  let bestScore = -1
  for (const candidate of candidates) {
    const score = scores.find(s => s.strategy === candidate)
    const value = score ? scoreValue(score) : 0.5
    // Candidates are pre-sorted alphabetically, so a strict `>` keeps the
    // alphabetically-first strategy on ties.
    if (value > bestScore) {
      bestScore = value
      best = candidate
    }
  }

  return {
    strategy: best,
    contextKey,
    reason: 'Highest rated approach for this kind of message.',
    explorationUsed: false,
  }
}
