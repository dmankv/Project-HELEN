export type UserMood = 'neutral' | 'frustrated' | 'excited' | 'confused' | 'urgent'

export type ResponseIntent = 'answer' | 'clarify' | 'follow-up' | 'acknowledge' | 'suggest'

export interface MemorySnippet {
  text: string
  timestamp?: Date
  relevance?: number
}

export interface ResponseContext {
  userMessage: string
  mood: UserMood
  intent: ResponseIntent
  memories?: MemorySnippet[]
  wantsShortAnswer?: boolean
}

const MOOD_PATTERNS: Array<{ mood: UserMood; pattern: RegExp }> = [
  { mood: 'urgent', pattern: /\b(urgent|asap|immediately|right now|quickly|deadline|emergency)\b/i },
  { mood: 'frustrated', pattern: /\b(frustrated|annoyed|upset|angry|stuck|hate|broken|not working)\b/i },
  { mood: 'confused', pattern: /\b(confused|unsure|not sure|don't understand|dont understand|lost|unclear)\b/i },
  { mood: 'excited', pattern: /\b(excited|awesome|great|amazing|love|fantastic|yay)\b/i }
]

const INTENT_PATTERNS: Array<{ intent: ResponseIntent; pattern: RegExp }> = [
  { intent: 'clarify', pattern: /\b(what do you mean|clarify|can you explain|not sure|confused|which one)\b/i },
  { intent: 'acknowledge', pattern: /\b(thanks|thank you|got it|makes sense|understood|okay|ok)\b/i },
  { intent: 'suggest', pattern: /\b(should i|recommend|suggest|best way|what should|options|idea)\b/i },
  { intent: 'follow-up', pattern: /\b(follow up|earlier|before|that one|as mentioned|continue)\b/i }
]

const MOOD_OPENERS: Record<UserMood, string[]> = {
  neutral: ['Sure.', 'Absolutely.', 'Okay.', 'Of course.', 'Happy to help.'],
  frustrated: ["I hear you.", "That sounds frustrating.", "Let's make this easier.", "Let's fix that.", "I get it — that's annoying."],
  excited: ['Love that energy.', "That's exciting.", 'Nice momentum.', "Great — let's dive in.", "Awesome, let's go!"],
  confused: ['No worries.', "Let's break it down.", "You're not alone in that.", "That's a fair thing to wonder about.", "Let me clarify."],
  urgent: ["Got it — moving fast.", "On it.", "Let's handle this now.", "Right away.", "Quick answer coming."]
}

const INTENT_CORE: Record<ResponseIntent, string[]> = {
  answer: [
    "Here's the direct answer: ",
    'A practical way to approach this is: ',
    "What matters most is this: ",
    "To put it simply: ",
    "The short version is: "
  ],
  clarify: [
    'Can I ask — what specifically are you trying to understand?',
    "Just to make sure I'm on the right track — could you clarify what you mean?",
    "Before I answer fully, could you tell me a bit more about what you're referring to?",
    "I want to make sure I help with the right thing — what part is unclear?",
    "Could you give me a little more context so I can answer accurately?"
  ],
  'follow-up': [
    'Building on what you said earlier, ',
    'Following that thread, ',
    'From your earlier point, ',
    "Picking up where we left off, ",
    "On that same note, "
  ],
  acknowledge: [
    'That makes sense.',
    'Thanks for sharing that.',
    "I understand where you're coming from.",
    "Glad that's clear.",
    "Got it — good to know."
  ],
  suggest: [
    'A good next step would be to ',
    'I recommend you ',
    'One option you can try is to ',
    "My suggestion would be to ",
    "You might want to "
  ]
}

const CLOSERS: Record<UserMood, string[]> = {
  neutral: ['Want me to go deeper?', 'I can expand if you want.', 'Happy to refine this with you.', 'Let me know if you need more.', 'Anything else I can help with?'],
  frustrated: ["If you want, I'll keep this step-by-step.", 'We can troubleshoot this together.', "I'll stay with you through it.", "Take your time — I'm here.", "Let's work through it."],
  excited: ['Want to push it further?', "We can level this up from here.", "Tell me where you'd like to take it next.", "Let's keep the momentum going!", "What's the next step?"],
  confused: ['If helpful, I can simplify this more.', 'I can give a concrete example next.', 'Want me to rephrase this in simpler terms?', "Ask away if anything is still unclear.", "We can go step by step if that helps."],
  urgent: ['If needed, I can give a fastest-path checklist.', 'I can keep this brief and actionable.', "Say the word and I'll prioritize the next step.", "What else do you need right now?", "I'm ready for the next task."]
}

export function detectMood(input: string): UserMood {
  for (const rule of MOOD_PATTERNS) {
    if (rule.pattern.test(input)) return rule.mood
  }
  return 'neutral'
}

export function detectIntent(input: string): ResponseIntent {
  for (const rule of INTENT_PATTERNS) {
    if (rule.pattern.test(input)) return rule.intent
  }
  if (/\?$/.test(input.trim())) return 'answer'
  return 'answer'
}

function memoryPhrase(memories: MemorySnippet[] = []): string {
  if (memories.length === 0) return ''
  const ranked = [...memories].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  const chosen = ranked[0]
  const excerpt = chosen.text.trim().slice(0, 90)
  if (!excerpt) return ''
  return `You mentioned earlier: "${excerpt}${chosen.text.length > 90 ? '…' : ''}". `
}

function scoreCandidate(candidate: string, context: ResponseContext): number {
  let score = 0
  const length = candidate.length
  const hasQuestion = candidate.includes('?')
  const hasMemory = /you mentioned earlier/i.test(candidate)

  if (context.intent === 'clarify') score += hasQuestion ? 4 : 0
  if (context.intent === 'acknowledge') score += length < 180 ? 3 : 0
  if (context.mood === 'urgent') score += length < 200 ? 3 : 0
  if (context.mood === 'frustrated') score += /together|step-by-step|easier/i.test(candidate) ? 2 : 0
  if (context.memories && context.memories.length > 0) score += hasMemory ? 2 : 0
  if (length > 320) score -= 2
  return score
}

export function generateHumanLikeResponse(baseResponse: string, context: ResponseContext): string {
  const openerPool = MOOD_OPENERS[context.mood]
  const corePool = INTENT_CORE[context.intent]
  const closerPool = CLOSERS[context.mood]
  const memory = memoryPhrase(context.memories)

  // Acknowledge intent: return a short standalone phrase — no opener stacking, no user-quote
  if (context.intent === 'acknowledge') {
    const pool = [...INTENT_CORE.acknowledge, ...closerPool.slice(0, 2)]
    const pick = pool[Math.floor(Math.random() * pool.length)]
    return pick
  }

  // Clarify intent: use standalone clarify phrases — no user-input appended
  if (context.intent === 'clarify') {
    const clarifyPool = INTENT_CORE.clarify
    const pick = clarifyPool[Math.floor(Math.random() * clarifyPool.length)]
    return `${memory}${pick}`.replace(/\s+/g, ' ').trim()
  }

  // Guard against empty content
  const rawContent = baseResponse.trim() || context.userMessage.trim()
  if (!rawContent) {
    const opener = openerPool[Math.floor(Math.random() * openerPool.length)]
    const closer = closerPool[Math.floor(Math.random() * closerPool.length)]
    return `${opener} ${closer}`.replace(/\s+/g, ' ').trim()
  }

  // For all other intents: use a topic phrase derived from the message, not a verbatim quote
  const topic = buildTopicPhrase(rawContent, context)

  const candidates: string[] = []
  // Shuffle pools so different entries are selected on every call
  const shuffled = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5)
  const openers = shuffled(openerPool).slice(0, 3)
  const cores = shuffled(corePool).slice(0, 3)
  const closers = shuffled(closerPool).slice(0, 3)
  for (const opener of openers) {
    for (const core of cores) {
      for (const closer of closers) {
        const candidate = `${opener} ${memory}${core}${topic}. ${closer}`
          .replace(/\s+/g, ' ')
          .trim()
        candidates.push(candidate)
      }
    }
  }

  const scored = candidates.map(text => ({ text, score: scoreCandidate(text, context) }))
  const bestScore = Math.max(...scored.map(s => s.score))
  const best = scored.filter(s => s.score === bestScore)
  return best[Math.floor(Math.random() * best.length)].text
}

/**
 * Builds a short, readable topic phrase from the user message instead of
 * quoting it verbatim. Extracts key nouns/verbs from the message.
 */
function buildTopicPhrase(message: string, _context: ResponseContext): string {
  const words = message.trim().split(/\s+/)

  // Short message (≤6 words): rephrase naturally
  if (words.length <= 6) {
    return message.trim()
  }

  // Longer message: extract a meaningful short phrase (first 8 meaningful words,
  // skipping filler at the start like "I", "can you", "please", "write me", etc.)
  const FILLER = /^(i|can|could|please|write|tell|show|help|me|you|a|an|the|this|that|it|is|are|was|be|do|does|did|my|your)$/i
  const meaningful = words.filter(w => !FILLER.test(w))
  const phrase = meaningful.slice(0, 8).join(' ')

  // Trim to a clean phrase without trailing punctuation
  const trimmed = phrase.replace(/[.,!?;:]+$/, '').trim()

  // If still very long, cut at 60 chars
  if (trimmed.length > 60) {
    return trimmed.slice(0, 57) + '…'
  }
  return trimmed || message.trim().slice(0, 60)
}
