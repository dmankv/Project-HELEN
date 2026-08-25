/**
 * Daemon Capability Router
 *
 * Decides, deterministically, where a turn should be handled: the local
 * response brain, the authenticated cloud edge function, or a capability that
 * is not configured yet (research / tool).
 *
 * Hard boundaries (non-negotiable):
 *   • Research and tool modes are placeholders. Nothing here performs web
 *     search, shell execution, or arbitrary code execution; when such a
 *     capability would be needed the router reports it as unavailable and
 *     falls back safely.
 *   • Offline, unauthenticated, and privacy-opt-out requests stay local.
 *   • `userVisibleStatus` must be truthful and quiet — no fake capability
 *     claims, no noisy chatter.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingMode = 'local' | 'cloud' | 'research' | 'tool'

export type RoutingReason =
  | 'offline'
  | 'unauthenticated'
  | 'simple-chat'
  | 'complex-reasoning'
  | 'current-information'
  | 'calculation'
  | 'capability-unavailable'
  | 'privacy-opt-out'
  | 'user-preference'

export interface RoutingDecision {
  mode: RoutingMode
  reason: RoutingReason
  /** What would have to be true to use the requested capability. */
  requirements: string[]
  safeFallback: RoutingMode
  /** Truthful, non-noisy status shown to the user. */
  userVisibleStatus: string
}

export interface RoutingContext {
  intent: string
  mood: string
  complexity: 'simple' | 'moderate' | 'complex'
  isAuthenticated: boolean
  isOnline: boolean
  cloudAvailable: boolean
  privacyOptOut: boolean
  userPreference?: RoutingMode
  taskKeywords: string[]
}

/**
 * Research and tool execution are not configured in this build. They stay
 * false until an explicitly configured, reviewed capability exists.
 */
export const RESEARCH_CAPABILITY_ENABLED = false
export const TOOL_CAPABILITY_ENABLED = false

/** Local handling is always available, so it is the universal safe fallback. */
export const SAFE_FALLBACK_MODE: RoutingMode = 'local'

// ---------------------------------------------------------------------------
// Complexity classification
// ---------------------------------------------------------------------------

const SIMPLE_INTENTS = ['greeting', 'identity', 'smalltalk', 'acknowledge', 'humor']

const COMPLEX_KEYWORDS = /\b(architecture|architect|design|trade[\s-]?offs?|compare|comparison|migrate|migration|refactor|optimi[sz]e|scalab\w*|strategy|analy[sz]e|analysis|evaluate|pros and cons|why does|explain why|step by step|end[\s-]to[\s-]end|debug|root cause)\b/i

const MODERATE_KEYWORDS = /\b(how do i|how to|write|implement|build|create|fix|configure|set up|example)\b/i

const SIMPLE_WORD_LIMIT = 8
const COMPLEX_WORD_LIMIT = 60

/** Deterministic complexity bucket for a user message. */
export function classifyComplexity(input: string, intent: string): 'simple' | 'moderate' | 'complex' {
  const text = (input ?? '').trim()
  const words = text.length === 0 ? [] : text.split(/\s+/)

  if (COMPLEX_KEYWORDS.test(text)) return 'complex'
  if (words.length > COMPLEX_WORD_LIMIT) return 'complex'
  if (SIMPLE_INTENTS.includes(intent) && words.length <= SIMPLE_WORD_LIMIT) return 'simple'
  if (MODERATE_KEYWORDS.test(text)) return 'moderate'
  if (words.length <= SIMPLE_WORD_LIMIT) return 'simple'
  return 'moderate'
}

// ---------------------------------------------------------------------------
// Keyword capability signals
// ---------------------------------------------------------------------------

const CURRENT_INFO_KEYWORDS = [
  'news', 'today', 'latest', 'current', 'weather', 'stock', 'price', 'headline',
  'right now', 'this week', 'recent',
]

const CALCULATION_KEYWORDS = [
  'calculate', 'compute', 'convert', 'how much is', 'sum of', 'percentage of', 'math',
]

function matchesKeyword(keywords: string[], candidates: string[]): boolean {
  const lowered = candidates.map(k => (k ?? '').toLowerCase())
  return keywords.some(k => lowered.some(c => c === k || c.includes(k)))
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function decide(
  mode: RoutingMode,
  reason: RoutingReason,
  userVisibleStatus: string,
  requirements: string[] = [],
): RoutingDecision {
  return { mode, reason, requirements, safeFallback: SAFE_FALLBACK_MODE, userVisibleStatus }
}

/** Cloud is usable only when online, authenticated, configured, and permitted. */
function cloudUsable(context: RoutingContext): boolean {
  return context.isOnline && context.isAuthenticated && context.cloudAvailable && !context.privacyOptOut
}

/**
 * Deterministic routing decision. Same context always yields the same result.
 */
export function routeRequest(context: RoutingContext): RoutingDecision {
  // 1. Privacy opt-out wins over everything: nothing leaves the device.
  if (context.privacyOptOut) {
    return decide('local', 'privacy-opt-out', 'Answering on-device — cloud processing is turned off.')
  }

  // 2. Offline and unauthenticated turns are always local.
  if (!context.isOnline) {
    return decide('local', 'offline', 'Offline — answering with the local model.', ['network connection'])
  }
  if (!context.isAuthenticated) {
    return decide('local', 'unauthenticated', 'Answering locally — sign in to use cloud responses.', ['signed-in account'])
  }

  // 3. Explicit user preference, where the capability actually exists.
  if (context.userPreference === 'local') {
    return decide('local', 'user-preference', 'Answering with the local model, as you preferred.')
  }
  if (context.userPreference === 'cloud') {
    return cloudUsable(context)
      ? decide('cloud', 'user-preference', 'Using cloud responses, as you preferred.')
      : decide('local', 'capability-unavailable', 'Cloud responses are unavailable right now — answering locally.', ['cloud chat configured'])
  }
  if (context.userPreference === 'research' || context.userPreference === 'tool') {
    return unavailableCapability(context, context.userPreference)
  }

  // 4. Capability-shaped requests. Neither capability is configured, so both
  //    report honestly and fall back instead of pretending to have run.
  if (matchesKeyword(CURRENT_INFO_KEYWORDS, context.taskKeywords)) {
    if (!RESEARCH_CAPABILITY_ENABLED) {
      return unavailableCapability(context, 'research')
    }
    return decide('research', 'current-information', 'Looking up current information.')
  }
  if (matchesKeyword(CALCULATION_KEYWORDS, context.taskKeywords)) {
    if (!TOOL_CAPABILITY_ENABLED) {
      return unavailableCapability(context, 'tool')
    }
    return decide('tool', 'calculation', 'Running a calculation.')
  }

  // 5. Complex reasoning goes to the cloud when it is genuinely available.
  if (context.complexity === 'complex') {
    return cloudUsable(context)
      ? decide('cloud', 'complex-reasoning', 'Using cloud responses for this one.')
      : decide('local', 'capability-unavailable', 'Cloud responses are unavailable right now — answering locally.', ['cloud chat configured'])
  }

  // 6. Everything else is simple enough to stay local.
  return decide('local', 'simple-chat', 'Answering with the local model.')
}

function unavailableCapability(context: RoutingContext, wanted: 'research' | 'tool'): RoutingDecision {
  const requirements = wanted === 'research'
    ? ['configured research capability', 'explicit user opt-in']
    : ['configured tool capability', 'explicit user opt-in']
  const fallbackMode: RoutingMode = cloudUsable(context) ? 'cloud' : 'local'
  const status = wanted === 'research'
    ? "I can't look things up online, so I'll answer from what I already know."
    : "I don't have calculation tools available, so I'll answer directly."
  return {
    mode: fallbackMode,
    reason: 'capability-unavailable',
    requirements,
    safeFallback: SAFE_FALLBACK_MODE,
    userVisibleStatus: status,
  }
}

/** Extracts lowercase keyword candidates from a message for routing. */
export function extractTaskKeywords(input: string): string[] {
  return (input ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2)
}
