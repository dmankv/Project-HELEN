export type UserMood = 'neutral' | 'frustrated' | 'excited' | 'confused' | 'urgent'

export type ResponseIntent = 'answer' | 'clarify' | 'follow-up' | 'acknowledge' | 'suggest'

export interface MemorySnippet {
  content: string
  timestamp?: Date
  relevance?: number
}

export interface ResponseContext {
  userInput: string
  mood: UserMood
  intent: ResponseIntent
  memories?: MemorySnippet[]
}

const MOOD_PATTERNS: Array<{ mood: UserMood; pattern: RegExp }> = [
  { mood: 'urgent', pattern: /\b(urgent|asap|immediately|right now|quickly|deadline|emergency)\b/i },
  { mood: 'frustrated', pattern: /\b(frustrated|annoyed|upset|angry|stuck|hate|broken|not working)\b/i },
  { mood: 'confused', pattern: /\b(confused|unsure|not sure|don't understand|dont understand|lost|unclear)\b/i },
  { mood: 'excited', pattern: /\b(excited|awesome|great|amazing|love|fantastic|yay)\b/i }
]

const INTENT_PATTERNS: Array<{ intent: ResponseIntent; pattern: RegExp }> = [
  { intent: 'clarify', pattern: /\b(what do you mean|clarify|can you explain|not sure|confused|which one)\b/i },
  { intent: 'follow-up', pattern: /\b(follow up|earlier|before|that one|as mentioned|continue|next)\b/i },
  { intent: 'acknowledge', pattern: /\b(thanks|thank you|got it|makes sense|understood|okay|ok)\b/i },
  { intent: 'suggest', pattern: /\b(should i|recommend|suggest|best way|what should|options|idea)\b/i }
]

const MOOD_OPENERS: Record<UserMood, string[]> = {
  neutral: ['Sure.', 'Absolutely.', 'Okay.'],
  frustrated: ["I hear you.", "That sounds frustrating.", "Let's make this easier."],
  excited: ['Love that energy.', "That's exciting.", 'Nice momentum.'],
  confused: ['No worries.', "Let's break it down.", "You're not alone in that."],
  urgent: ["Got it — let's move fast.", "Understood. Quick answer:", "Let's handle this now."]
}

const INTENT_CORE: Record<ResponseIntent, string[]> = {
  answer: [
    "Here's the direct answer: ",
    'A practical way to approach this is: ',
    "What matters most is this: "
  ],
  clarify: [
    'To clarify, are you asking about ',
    'Can I confirm you mean ',
    "Before I answer fully, do you mean "
  ],
  'follow-up': [
    'Building on what you said earlier, ',
    'Following that thread, ',
    'From your earlier point, '
  ],
  acknowledge: [
    'That makes sense.',
    'Thanks for sharing that.',
    "I understand where you're coming from."
  ],
  suggest: [
    'A good next step would be to ',
    'I recommend you ',
    'One option you can try is to '
  ]
}

const CLOSERS: Record<UserMood, string[]> = {
  neutral: ['Want me to go deeper?', 'I can expand if you want.', 'Happy to refine this with you.'],
  frustrated: ["If you want, I'll keep this step-by-step.", 'We can troubleshoot this together.', "I'll stay with you through it."],
  excited: ['Want to push it further?', "We can level this up from here.", "Tell me where you'd like to take it next."],
  confused: ['If helpful, I can simplify this more.', 'I can give a concrete example next.', 'Want me to rephrase this in simpler terms?'],
  urgent: ['If needed, I can give a fastest-path checklist.', 'I can keep this brief and actionable.', "Say the word and I'll prioritize the next step."]
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
  const excerpt = chosen.content.trim().slice(0, 90)
  if (!excerpt) return ''
  return `You mentioned earlier: "${excerpt}${chosen.content.length > 90 ? '…' : ''}". `
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

export function generateHumanLikeResponse(context: ResponseContext): string {
  const openerPool = MOOD_OPENERS[context.mood]
  const corePool = INTENT_CORE[context.intent]
  const closerPool = CLOSERS[context.mood]
  const memory = memoryPhrase(context.memories)
  const prompt = context.userInput.trim().slice(0, 120)

  const openers = openerPool.slice(0, 2)
  const cores = corePool.slice(0, 2)
  const closers = closerPool.slice(0, 2)

  const candidates: string[] = []
  for (const opener of openers) {
    for (const core of cores) {
      for (const closer of closers) {
        const candidate = `${opener} ${memory}${core}"${prompt}${prompt.length >= 120 ? '…' : ''}". ${closer}`
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
