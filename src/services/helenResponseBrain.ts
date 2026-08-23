export type UserMood = 'neutral' | 'frustrated' | 'excited' | 'confused' | 'urgent' | 'sad'

export type ResponseIntent = 'answer' | 'clarify' | 'follow-up' | 'acknowledge' | 'suggest'
  | 'greeting' | 'identity' | 'coding' | 'smalltalk'

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

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const MOOD_PATTERNS: Array<{ mood: UserMood; pattern: RegExp }> = [
  { mood: 'urgent', pattern: /\b(urgent|asap|immediately|right now|quickly|deadline|emergency)\b/i },
  { mood: 'frustrated', pattern: /\b(frustrated|annoyed|upset|angry|stuck|hate|broken|not working)\b/i },
  { mood: 'sad', pattern: /\b(sad|unhappy|down|depressed|lonely|heartbroken|crying|miserable|grief)\b/i },
  { mood: 'confused', pattern: /\b(confused|unsure|not sure|don't understand|dont understand|lost|unclear)\b/i },
  { mood: 'excited', pattern: /\b(excited|awesome|great|amazing|love|fantastic|yay)\b/i }
]

const INTENT_PATTERNS: Array<{ intent: ResponseIntent; pattern: RegExp }> = [
  { intent: 'greeting', pattern: /^(hey|hi|hello|howdy|yo|sup|hiya|good morning|good afternoon|good evening|what's up|whats up)\b/i },
  { intent: 'identity', pattern: /\b(who are you|what are you|are you (a |an )?(ai|bot|robot|human|person)|tell me about yourself|introduce yourself)\b/i },
  { intent: 'coding', pattern: /\b(write|code|function|script|program|snippet|debug|fix|implement|class|method|algorithm|loop|array|object|variable|import|export|compile|run|test)\b/i },
  { intent: 'smalltalk', pattern: /\b(how are you|how('s| is) it going|what's new|hows your day|how was your day|feeling today)\b/i },
  { intent: 'clarify', pattern: /\b(what do you mean|clarify|can you explain|not sure|confused|which one)\b/i },
  { intent: 'acknowledge', pattern: /\b(thanks|thank you|got it|makes sense|understood|okay|ok)\b/i },
  { intent: 'suggest', pattern: /\b(should i|recommend|suggest|best way|what should|options|idea)\b/i },
  { intent: 'follow-up', pattern: /\b(follow up|earlier|before|that one|as mentioned|continue)\b/i }
]

// ---------------------------------------------------------------------------
// Canned answer library keyed by intent (Rec 1)
// Each entry is a list of complete responses; one is chosen at random.
// ---------------------------------------------------------------------------

const CANNED_ANSWERS: Record<ResponseIntent, string[]> = {
  greeting: [
    "Hey! Good to hear from you. What can I help with today?",
    "Hi there! What's on your mind?",
    "Hello! I'm HELEN — happy to chat or help out. What do you need?",
    "Hey! What's up? Anything I can do for you?",
  ],
  identity: [
    "I'm HELEN — an adaptive AI assistant built to have real conversations and actually help you get things done. What would you like to do?",
    "Good question! I'm HELEN, your AI assistant. I can chat, help with code, answer questions, brainstorm ideas, and more. What's on your mind?",
    "I'm HELEN. Think of me as a knowledgeable friend who's always around — I can help with almost anything. What do you need?",
  ],
  smalltalk: [
    "Honestly, doing pretty well! Every conversation is different, which I enjoy. How about you — how's your day going?",
    "Not bad at all! I'm here and ready to help. How are you doing?",
    "Pretty good, thanks for asking! What about you?",
  ],
  coding: [
    "Sure, I can help with that. Could you give me a bit more detail — what language, and what should it do exactly?",
    "Happy to help with code. What language are you working in, and what's the goal?",
    "On it — what language and what should the code do? The more detail you give me, the better I can help.",
  ],
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

// ---------------------------------------------------------------------------
// Mood openers and closers
// ---------------------------------------------------------------------------

const MOOD_OPENERS: Record<UserMood, string[]> = {
  neutral: ['Sure.', 'Absolutely.', 'Okay.', 'Of course.', 'Happy to help.'],
  frustrated: ["I hear you.", "That sounds frustrating.", "Let's make this easier.", "Let's fix that.", "I get it — that's annoying."],
  sad: ["I'm sorry to hear that.", "That sounds really hard.", "I'm here if you want to talk.", "That's tough — I'm listening."],
  excited: ['Love that energy.', "That's exciting.", 'Nice momentum.', "Great — let's dive in.", "Awesome, let's go!"],
  confused: ['No worries.', "Let's break it down.", "You're not alone in that.", "That's a fair thing to wonder about.", "Let me clarify."],
  urgent: ["Got it — moving fast.", "On it.", "Let's handle this now.", "Right away.", "Quick answer coming."]
}

const CLOSERS: Record<UserMood, string[]> = {
  neutral: ['Want me to go deeper?', 'I can expand if you want.', 'Happy to refine this with you.', 'Let me know if you need more.', 'Anything else I can help with?'],
  frustrated: ["If you want, I'll keep this step-by-step.", 'We can troubleshoot this together.', "I'll stay with you through it.", "Take your time — I'm here.", "Let's work through it."],
  sad: ["I'm here whenever you need.", "Take your time — no rush.", "Feel free to talk about anything."],
  excited: ['Want to push it further?', "We can level this up from here.", "Tell me where you'd like to take it next.", "Let's keep the momentum going!", "What's the next step?"],
  confused: ['If helpful, I can simplify this more.', 'I can give a concrete example next.', 'Want me to rephrase this in simpler terms?', "Ask away if anything is still unclear.", "We can go step by step if that helps."],
  urgent: ['If needed, I can give a fastest-path checklist.', 'I can keep this brief and actionable.', "Say the word and I'll prioritize the next step.", "What else do you need right now?", "I'm ready for the next task."]
}

// ---------------------------------------------------------------------------
// Mood-specific full responses for emotional moments (no echo)
// ---------------------------------------------------------------------------

const MOOD_FULL_RESPONSES: Partial<Record<UserMood, string[]>> = {
  sad: [
    "I'm really sorry you're feeling that way. If you want to talk about it, I'm here — no pressure at all.",
    "That sounds genuinely hard. I'm listening if you want to share more, or I can help with something to take your mind off it.",
    "I hear you. Sometimes things are just tough and there's no quick fix. I'm here if you need to vent or want any kind of help.",
  ],
  frustrated: [
    "Ugh, that sounds really frustrating. Let's figure it out together — what exactly is happening?",
    "I get it, that kind of thing is genuinely annoying. Can you tell me more about what's going wrong so we can fix it?",
    "That sounds maddening. Let's slow down and work through it step by step. What are you seeing?",
  ],
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

function memoryPhrase(memories: MemorySnippet[] = []): string {
  if (memories.length === 0) return ''
  const ranked = [...memories].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  const chosen = ranked[0]
  const excerpt = chosen.text.trim().slice(0, 90)
  if (!excerpt) return ''
  return `You mentioned earlier: "${excerpt}${chosen.text.length > 90 ? '…' : ''}". `
}

// ---------------------------------------------------------------------------
// pick — select a random item from an array
// ---------------------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---------------------------------------------------------------------------
// Main response generator
// ---------------------------------------------------------------------------

export function generateHumanLikeResponse(baseResponse: string, context: ResponseContext): string {
  const { mood, intent, memories, wantsShortAnswer } = context

  // 1. For emotionally charged moods that warrant a full bespoke reply, use
  //    the mood-specific response pool directly (no echo).
  const moodFull = MOOD_FULL_RESPONSES[mood]
  if (moodFull && (intent === 'answer' || intent === 'clarify')) {
    const opener = pick(moodFull)
    if (wantsShortAnswer) return opener
    return `${opener} ${pick(CLOSERS[mood])}`
  }

  // 2. For well-defined intents that have complete canned answers, use them.
  const standAloneIntents: ResponseIntent[] = ['greeting', 'identity', 'smalltalk', 'acknowledge', 'clarify']
  if (standAloneIntents.includes(intent)) {
    return pick(CANNED_ANSWERS[intent])
  }

  // 3. For coding intent: use canned opener only (asks user for clarification
  //    since we have no execution engine).
  if (intent === 'coding') {
    return pick(CANNED_ANSWERS.coding)
  }

  // 4. Guard against empty content
  const rawContent = baseResponse.trim() || context.userMessage.trim()
  const openerPool = MOOD_OPENERS[mood]
  const closerPool = CLOSERS[mood]
  const memory = memoryPhrase(memories)

  if (!rawContent) {
    return `${pick(openerPool)} ${pick(closerPool)}`.replace(/\s+/g, ' ').trim()
  }

  // 5. For answer / suggest / follow-up: build a composed response using a
  //    topic phrase derived from the message (not a verbatim quote), with mood coloring.
  const topic = buildTopicPhrase(rawContent, context)

  // Shuffle pools so different entries are selected on every call
  const shuffled = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5)
  const candidates: string[] = []
  const openers = shuffled(openerPool).slice(0, 3)
  const cores = shuffled(CANNED_ANSWERS[intent] ?? CANNED_ANSWERS.answer).slice(0, 3)
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

  if (wantsShortAnswer && candidates.length > 0) {
    return `${pick(openers)} ${memory}${pick(cores)}${topic}.`.replace(/\s+/g, ' ').trim()
  }

  return candidates[Math.floor(Math.random() * candidates.length)] ?? rawContent
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

  // Longer message: extract a meaningful short phrase, skipping filler words
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
