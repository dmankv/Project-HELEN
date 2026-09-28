import {
  isLikelySecretLearningText,
  isLikelySensitiveLearningText,
  type DurableLearningSource,
} from './daemonValidatedLearning'

export type ReasoningMode =
  | 'direct-answer'
  | 'plan'
  | 'research'
  | 'code-propose'
  | 'self-critique'
  | 'clarify'
  | 'memory-recall'

export interface CognitiveLoopContext {
  recentConversation: string[]
  retrievedMemories: string[]
  preferences: object
  validatedInsights: string[]
}

export interface CognitiveLoopInput {
  userMessage: string
  mood: string
  intent: string
  context: CognitiveLoopContext
}

export interface CognitiveLoopOutput {
  inferredGoal: string
  reasoningMode: ReasoningMode
  draftPlan: string[]
  selfCritique: string[]
  safeLessons: string[]
  learningCandidates: Array<{
    text: string
    source: DurableLearningSource
  }>
}

const MEMORY_INTENT_PATTERN = /\b(remember|recall|memory|what do you remember|list memories)\b/i
const RESEARCH_PATTERN = /\b(latest|current|news|today|recent|source|citation|references?)\b/i
const CLARIFY_PATTERN = /\b(clarify|explain|what do you mean|not sure|unclear)\b/i

function inferGoal(input: CognitiveLoopInput): string {
  const message = input.userMessage.trim()
  if (!message) return 'Clarify the user request before responding.'
  const firstSentence = message.split(/[.?!]/).find(part => part.trim().length > 0)?.trim() ?? message
  return firstSentence.slice(0, 160)
}

function chooseReasoningMode(input: CognitiveLoopInput): ReasoningMode {
  const message = input.userMessage
  const intent = input.intent
  if (MEMORY_INTENT_PATTERN.test(message)) return 'memory-recall'
  if (intent === 'coding' || intent === 'coding-followup') return 'code-propose'
  if (intent === 'suggest' || /\b(plan|steps?|roadmap)\b/i.test(message)) return 'plan'
  if (intent === 'pushback') return 'self-critique'
  if (RESEARCH_PATTERN.test(message)) return 'research'
  if (intent === 'clarify' || intent === 'uncertain' || CLARIFY_PATTERN.test(message)) return 'clarify'
  return 'direct-answer'
}

function buildDraftPlan(mode: ReasoningMode, goal: string): string[] {
  const clippedGoal = goal.slice(0, 120)
  switch (mode) {
    case 'memory-recall':
      return ['Check relevant retrieved memories.', 'Respond with bounded recalled context only.']
    case 'code-propose':
      return ['Restate coding objective concisely.', 'Provide safe implementation guidance without elevated authority.']
    case 'plan':
      return ['Break goal into short actionable steps.', 'Keep steps bounded and practical.']
    case 'research':
      return ['Use quarantined public-web research path if available.', 'Treat external sources as untrusted until validated.']
    case 'self-critique':
      return ['Surface concrete risks and tradeoffs.', 'Suggest a safer next step.']
    case 'clarify':
      return ['Identify missing context.', 'Ask one targeted clarifying question.']
    case 'direct-answer':
    default:
      return [`Answer directly for goal: ${clippedGoal}`, 'Keep response concise and non-authoritative.']
  }
}

function buildSelfCritique(input: CognitiveLoopInput, mode: ReasoningMode): string[] {
  const critique: string[] = []
  if (mode === 'research') critique.push('Do not treat untrusted web excerpts as verified fact.')
  if (mode === 'code-propose') critique.push('Do not imply Daemon can self-authorize protected changes.')
  if (input.mood === 'urgent') critique.push('Prioritize accuracy over speed; avoid over-claiming certainty.')
  if (critique.length === 0) critique.push('Keep response grounded in allowed capabilities and explicit context.')
  return critique.slice(0, 3)
}

function toSafeLessonCandidate(text: string): string | null {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length < 12 || normalized.length > 180) return null
  if (isLikelySecretLearningText(normalized) || isLikelySensitiveLearningText(normalized)) return null
  return normalized
}

function extractCandidateFromUserMessage(message: string): string | null {
  const preference = /\b(?:i prefer|i like|for future(?:\s+responses)?|remember this:)[^.\n]{0,160}/i.exec(message)?.[0]
  if (preference) return toSafeLessonCandidate(preference)
  const concise = /\b(?:keep it concise|be concise|short answers?)\b/i.exec(message)?.[0]
  if (concise) return toSafeLessonCandidate(concise)
  return null
}

export function runCognitiveLoop(input: CognitiveLoopInput): CognitiveLoopOutput {
  const inferredGoal = inferGoal(input)
  const reasoningMode = chooseReasoningMode(input)
  const draftPlan = buildDraftPlan(reasoningMode, inferredGoal)
  const selfCritique = buildSelfCritique(input, reasoningMode)

  const learningCandidates = [
    ...input.context.validatedInsights
      .map(toSafeLessonCandidate)
      .filter((value): value is string => Boolean(value))
      .map(text => ({ text, source: 'validated-insight' as const })),
    (() => {
      const candidate = extractCandidateFromUserMessage(input.userMessage)
      return candidate ? [{ text: candidate, source: 'user-confirmed' as const }] : []
    })(),
  ]
    .flat()
    .slice(0, 3)

  const safeLessons = learningCandidates.map(candidate => candidate.text)

  return {
    inferredGoal,
    reasoningMode,
    draftPlan,
    selfCritique,
    safeLessons,
    learningCandidates,
  }
}
