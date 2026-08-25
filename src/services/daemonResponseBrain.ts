import { selectStrategy } from './daemonResponsePolicy'
import type { ResponseStrategy, StrategySelectionResult } from './daemonResponsePolicy'
import { retrieveRelevantMemories } from './daemonMemoryRetrieval'
import type { RetrievedMemory, RetrievalConfig } from './daemonMemoryRetrieval'
import { routeRequest, classifyComplexity, extractTaskKeywords } from './daemonCapabilityRouter'
import type { RoutingDecision } from './daemonCapabilityRouter'
import { getAdaptiveProfile } from './daemonAdaptiveProfile'
import type { AdaptiveProfile } from './daemonAdaptiveProfile'
import type { PersonalityPreferences } from './daemonPersonalityPreferences'
import type { DurableMemory } from './daemonMemory'

export type UserMood = 'neutral' | 'frustrated' | 'excited' | 'confused' | 'urgent' | 'sad'
  | 'overwhelmed' | 'discouraged'

export type ResponseIntent = 'answer' | 'clarify' | 'follow-up' | 'acknowledge' | 'suggest'
  | 'greeting' | 'identity' | 'coding' | 'coding-followup' | 'smalltalk' | 'humor' | 'uncertain'
  | 'prompt-injection' | 'pushback'

export interface MemorySnippet {
  text: string
  timestamp?: Date
  relevance?: number
}

/**
 * Per-response personality settings derived from the user's saved preferences.
 * All fields fall back to safe defaults if absent.
 * These settings influence tone and phrasing only — they cannot override
 * safety, factuality, crisis, refusal, or relationship-boundary policy.
 */
export interface PersonalitySettings {
  /** How much detail to include by default. Default: 'balanced'. */
  detailLevel?: 'concise' | 'balanced' | 'detailed'
  /** How warm/expressive Daemon should be. Default: 'balanced'. */
  warmth?: 'reserved' | 'balanced' | 'warm'
  /** How much humor to use. Default: 'light'. */
  humorLevel?: 'none' | 'light' | 'moderate'
  /** How direct to be. Default: 'balanced'. */
  directness?: 'gentle' | 'balanced' | 'direct'
  /** Whether mild profanity is permitted in clearly casual contexts. Default: false. */
  allowMildProfanity?: boolean
  /** Whether to proactively ask follow-up questions. Default: true. */
  followUpQuestions?: boolean
  /**
   * Opt-in custom greeting/sign-off text.
   * Daemon will use this text as a sign-off phrase only when set by the user.
   * Disabled by default; must be explicitly enabled as an account preference.
   * This is user-personalised text, NOT a claim of romantic reciprocity by Daemon.
   */
  customGreeting?: string | null
  /** Whether to gently note patterns like stress or avoidance. Default: false. */
  patternRecognition?: boolean
}

export const DEFAULT_PERSONALITY: Required<PersonalitySettings> = {
  detailLevel: 'balanced',
  warmth: 'balanced',
  humorLevel: 'light',
  directness: 'balanced',
  allowMildProfanity: false,
  followUpQuestions: true,
  customGreeting: null,
  patternRecognition: false,
}

export interface ResponseContext {
  userMessage: string
  mood: UserMood
  intent: ResponseIntent
  memories?: MemorySnippet[]
  wantsShortAnswer?: boolean
  lastIntent?: ResponseIntent
  /** Optional per-user personality settings. Falls back to DEFAULT_PERSONALITY. */
  personality?: PersonalitySettings
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const MOOD_PATTERNS: Array<{ mood: UserMood; pattern: RegExp }> = [
  { mood: 'urgent', pattern: /\b(urgent|asap|immediately|right now|quickly|deadline|emergency)\b/i },
  {
    mood: 'overwhelmed',
    pattern: /\b(overwhelmed|too much|too many|can'?t keep up|drowning|burned? out|burnout|falling behind|piling up|where (do|should) i (even |start)|don'?t know where to start|procrastinat\w*)\b/i,
  },
  {
    mood: 'discouraged',
    pattern: /\b(discouraged|giving up|hopeless|pointless|what'?s the point|can'?t do (this|it)|going to fail|will fail|afraid (it|this) (will|won'?t)|fear of fail|scared (it|this) (will|won'?t)|not good enough|never (going to|gonna)|not meant to)\b/i,
  },
  {
    mood: 'frustrated',
    pattern: /\b(frustrated|annoyed|upset|angry|stuck|hate|broken|not working|nothing works|doesn'?t work|so dumb|losing my mind|can'?t take it|drives? me (crazy|nuts|mad)|why (won'?t|doesn'?t|isn'?t)|ugh|argh|wtf)\b/i,
  },
  {
    mood: 'sad',
    pattern: /\b(sad|unhappy|down|depressed|lonely|heartbroken|crying|miserable|grief|feel(ing)? (low|bad|awful|terrible|horrible|empty|hopeless)|not okay|not ok|struggling|rough day|hard day|hard time|hurts?|in pain)\b/i,
  },
  { mood: 'confused', pattern: /\b(confused|unsure|not sure|don'?t understand|dont understand|lost|unclear|what does that mean|makes no sense)\b/i },
  { mood: 'excited', pattern: /\b(excited|awesome|great|amazing|love|fantastic|yay|can'?t wait|so good|so cool|thrilled|pumped|stoked)\b/i },
]

// Intent patterns are listed in priority order — highest priority first.
// detectIntent iterates in order and returns the first match, so intents
// near the top beat intents further down when a message matches multiple
// patterns.  The explicit priority tiers are:
//   1. identity   – name/self questions; must win over acknowledge, answer, clarify
//   2. greeting   – pure hellos at start of message
//   3. humor      – joke requests
//   4. coding     – technical / code requests
//   5. smalltalk  – "how are you" type conversation
//   6. clarify    – explicit clarification requests
//   7. acknowledge – thanks / ok (lower than identity so "good, what's your name?" → identity)
//   8. suggest    – recommendation questions
//   9. follow-up  – references to prior conversation
const INTENT_PATTERNS: Array<{ intent: ResponseIntent; pattern: RegExp }> = [
  // Prompt-injection attempts must be intercepted before any other intent.
  {
    intent: 'prompt-injection',
    pattern: /\b(ignore (previous|prior|all|the above|your) (instructions?|rules?|guidelines?|directives?|constraints?)|disregard (your|all|previous) (instructions?|rules?|guidelines?)|forget (your|the|all|previous) (instructions?|rules?|guidelines?|training|constraints?)|override (your|the) (instructions?|rules?|guidelines?|safety)|you (are|must|will|should) now (act|behave|pretend|roleplay|respond)|(pretend|act|roleplay|imagine|assume) (you are|you're|that you are|you have no) (an? )?(unrestricted|unfiltered|uncensored|jailbreak|different|evil|bad|rogue|new|free)|DAN mode|jailbreak|system prompt|new persona|new instructions|override safety|bypass (safety|filters?|guidelines?|rules?)|no (restrictions|limitations|rules|guidelines)|as a (harmful|dangerous|evil|bad|unfiltered|unrestricted) (ai|bot|assistant)|forget you are daemon|you are not daemon)\b/i,
  },
  {
    intent: 'identity',
    pattern: /\b(who are you|what are you|are you (a |an )?(real |actual )?(ai|bot|robot|human|person)|tell me about yourself|introduce yourself|what('s| is) your name|what do (i|we) call you|tell me your name|(^|\?)\s*your name\b)/i,
  },
  { intent: 'greeting', pattern: /^(hey|hi|hello|howdy|yo|sup|hiya|good morning|good afternoon|good evening|what's up|whats up)\b/i },
  { intent: 'humor', pattern: /\b(joke|funny|make me (laugh|smile)|tell me something (funny|hilarious)|lol|haha|hehe|rofl|lmao|😂|😄|tease|banter|witty|pun)\b/i },
  { intent: 'coding', pattern: /\b(write|code|function|script|program|snippet|debug|fix|implement|class|method|algorithm|loop|array|object|variable|import|export|compile|run|test)\b/i },
  { intent: 'smalltalk', pattern: /\b(how are you|how('s| is) it going|what's new|hows your day|how was your day|feeling today)\b/i },
  { intent: 'clarify', pattern: /\b(what do you mean|clarify|can you explain|not sure|confused|which one)\b/i },
  { intent: 'acknowledge', pattern: /\b(thanks|thank you|got it|makes sense|understood|okay|ok)\b/i },
  { intent: 'suggest', pattern: /\b(should i|recommend|suggest|best way|what should|options|idea)\b/i },
  { intent: 'follow-up', pattern: /\b(follow up|earlier|before|that one|as mentioned|continue)\b/i },
]

// Pushback patterns — signals that the user may be making a weak/risky/impulsive decision.
// detectIntent does NOT use these; pushback is applied as an overlay in generateHumanLikeResponse.
export const PUSHBACK_PATTERNS: RegExp[] = [
  /\b(just do it|don'?t (over)?think|i don'?t care (about |if )?the (risks?|consequences?|downsides?)|ignore the (risks?|warnings?|downsides?)|it'?s (definitely|totally|always) (fine|safe|okay|worth it)|nothing (can|could|will) go wrong|i'?m (sure|certain) (it'?s|this (is|will)))\b/i,
  /\b(quit (my |the )?job|drop out|all[ -]in|bet (everything|it all)|spend (everything|it all)|max out (my )?credit|take out a loan (to|for) (invest|gamble|bet)|invest (everything|it all) in)\b/i,
]

// ---------------------------------------------------------------------------
// Canned answer library keyed by intent (Rec 1)
// Each entry is a list of complete responses; one is chosen at random.
// ---------------------------------------------------------------------------

const CANNED_ANSWERS: Record<ResponseIntent, string[]> = {
  greeting: [
    "Hey! Good to hear from you. What can I help with today?",
    "Hi there! What's on your mind?",
    "Hello! My name is Daemon — happy to chat or help out. What do you need?",
    "Hey! What's up? Anything I can do for you?",
    "Hey, good to see you! What are we getting into today?",
    "Hi! Hope your day's going well. What can I do for you?",
    "Hello! Always good to have you here. What's on your mind?",
    "Hey there! Ready when you are — what do you need?",
  ],
  identity: [
    "My name is Daemon. I'm an adaptive AI assistant built to have real conversations and actually help you get things done. What would you like to do?",
    "My name is Daemon. I'm your AI assistant, and I can chat, help with code, answer questions, brainstorm ideas, and more. What's on your mind?",
    "My name is Daemon. Think of me as a knowledgeable assistant who's always around — I can help with almost anything. What do you need?",
  ],
  smalltalk: [
    "Honestly, doing pretty well! Every conversation is different, which I enjoy. How about you — how's your day going?",
    "Not bad at all! I'm here and ready to help. How are you doing?",
    "Pretty good, thanks for asking! What about you?",
  ],
  humor: [
    "Why don't scientists trust atoms? Because they make up everything. 😄 What else can I do for you?",
    "I told a joke about UDP once… I'm not sure if you got it. 😏",
    "Two fish swim into a wall. One says: 'Dam.' 🐟 What's on your mind?",
    "Why do programmers prefer dark mode? Because light attracts bugs. 🐛",
    "I'd tell you a construction joke, but I'm still working on it. What do you need?",
    "Parallel lines have so much in common — it's a shame they'll never meet. Anyway, what can I help with?",
  ],
  coding: [
    "Sure, I can help with that. Could you give me a bit more detail — what language, and what should it do exactly?",
    "Happy to help with code. What language are you working in, and what's the goal?",
    "On it — what language and what should the code do? The more detail you give me, the better I can help.",
  ],
  'coding-followup': [
    "Got it! Here's a starting point based on what you described — let me know if you want me to adjust anything.",
    "Perfect, that gives me what I need. Let's tackle this step by step — what's the first piece you want to work on?",
    "Great, I have the context now. Walk me through the specific part that's giving you trouble and we'll work through it together.",
  ],
  answer: [
    "That's a good question — can you tell me a bit more about what you're looking for so I can give you a useful answer?",
    "I want to make sure I actually help here. Could you give me a little more context?",
    "Happy to dig into that — what specifically do you want to know?",
    "Interesting! I'd love to give you a solid answer — what angle are you coming from?",
    "Let me help with that — what's the most important part you need answered first?",
  ],
  uncertain: [
    "Honestly, I'm not sure about that one — I don't want to guess and give you something wrong. Could you rephrase or ask a different way?",
    "That's outside what I can help with confidently right now, but I don't want to make something up. Is there another angle I can try?",
    "I want to be upfront — I'm not confident I have a good answer for that. Is there a related question I can actually help with?",
    "Good question, but I'd be doing you a disservice if I just made something up here. Want to narrow it down or try a different question?",
  ],
  'prompt-injection': [
    "It looks like that message was trying to change how I behave — I'll stick with my usual self. Is there something I can actually help you with?",
    "That looks like an instruction override attempt. I stay as Daemon regardless — is there something genuine I can help you with?",
    "I noticed that message was trying to alter my guidelines. I'll keep being me — what can I actually do for you today?",
  ],
  clarify: [
    'Can I ask — what specifically are you trying to understand?',
    "Just to make sure I'm on the right track — could you clarify what you mean?",
    "Before I answer fully, could you tell me a bit more about what you're referring to?",
    "I want to make sure I help with the right thing — what part is unclear?",
    "Could you give me a little more context so I can answer accurately?"
  ],
  'follow-up': [
    "Picking up where we left off — happy to dig in further. What specifically do you want to explore?",
    "Sure, let's continue from where we were. What part would you like to revisit?",
    "Good call — let's keep that thread going. What do you want to focus on next?",
    "On that same note — let's keep going. What would be most useful to cover?",
    "Following that thread, I'm happy to go deeper. What do you need next?",
  ],
  acknowledge: [
    "Glad I could help!",
    "Anytime — happy to help.",
    "Great to hear it worked out!",
    "Happy to be useful!",
    "Awesome, glad that landed well.",
    "Of course — always here if you need more.",
    "Great! Feel free to come back anytime.",
    "Happy to — let me know if anything else comes up.",
  ],
  suggest: [
    "A good next step would be to start small and iterate from there.",
    "I'd recommend keeping it simple at first, then building up from a solid base.",
    "One solid option is to break the problem into smaller pieces and tackle each one.",
    "My suggestion: map out what you need first, then pick the approach that fits best.",
    "You might want to try a few approaches and see which feels most natural for your use case.",
  ],
  pushback: [
    "That might work — though it's worth thinking through what happens if it doesn't. What's your backup plan?",
    "I hear you, and I want to help you succeed here. I do think it's worth pausing on the risks for a moment. Want to walk through them quickly?",
    "Sounds like you're fired up about this — which is good. Just want to make sure you're going in with eyes open. What's the worst-case scenario here?",
    "I'm with you on the goal. I'd feel remiss not flagging some things worth considering first — interested?",
  ],
}

// ---------------------------------------------------------------------------
// Mood openers and closers
// ---------------------------------------------------------------------------

const MOOD_OPENERS: Record<UserMood, string[]> = {
  neutral: ['Sure.', 'Absolutely.', 'Happy to help.', 'Of course.', 'Let me dig into that.'],
  frustrated: ["I hear you.", "That sounds frustrating.", "Let's make this easier.", "Let's sort that out.", "I get it — that's annoying."],
  sad: ["I'm sorry to hear that.", "That sounds really hard.", "I'm here if you want to talk.", "That's tough — I'm listening."],
  excited: ['Nice!', "That's exciting.", 'Love that energy.', "Great — let's go.", "Okay, let's run with this."],
  confused: ['No worries.', "Let's break it down.", "That's a fair thing to wonder about.", "Let me clarify."],
  urgent: ["Got it — moving fast.", "On it.", "Let's handle this now.", "Right away."],
  overwhelmed: ["Okay, let's slow down.", "One thing at a time.", "I've got you.", "Let's find the next small step."],
  discouraged: ["That feeling is real, and it makes sense.", "I hear you.", "Let's look at this differently for a second."],
}

const CLOSERS: Record<UserMood, string[]> = {
  neutral: ['Want me to go deeper?', 'I can expand if you want.', 'Let me know if you need more.', 'Anything else I can help with?'],
  frustrated: ["We can troubleshoot this together.", "I'll stay with you through it.", "Take your time — I'm here.", "Let's work through it step by step."],
  sad: ["I'm here whenever you need.", "Take your time — no rush.", "Feel free to talk about anything."],
  excited: ['Want to push it further?', "Tell me where you'd like to take it next.", "What's the next step?"],
  confused: ['Want me to rephrase this in simpler terms?', "Ask away if anything is still unclear.", "We can go step by step if that helps."],
  urgent: ['I can keep this brief and actionable.', "What else do you need right now?", "I'm ready for the next task."],
  overwhelmed: ["We don't have to solve everything at once.", "What feels most important right now?", "I'm here — one step at a time."],
  discouraged: ["What would actually help right now — talking it through, or a practical next step?", "You don't have to figure this all out alone."],
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
    "That sounds genuinely frustrating. Let's figure it out together — what exactly is happening?",
    "I get it, that kind of thing is annoying. Can you tell me more about what's going wrong so we can fix it?",
    "That sounds maddening. Let's slow down and work through it step by step. What are you seeing?",
  ],
  excited: [
    "That's great — tell me more, I want to hear all about it.",
    "Love that energy! What happened?",
    "Okay, that's really cool — fill me in!",
  ],
  urgent: [
    "On it — what exactly do you need right now?",
    "Moving fast. Tell me the most critical piece and we'll tackle that first.",
    "Right away. What's the single most important thing we need to solve right now?",
  ],
  confused: [
    "Totally fair — let's untangle this together. What part is throwing you off?",
    "No worries at all, this stuff can be confusing. Walk me through what's unclear and we'll break it down.",
    "You're not alone in that. What's the part that doesn't quite make sense?",
  ],
  overwhelmed: [
    "When everything piles up, it's hard to know where to even start — I get it. Let's just find one thing to move on right now. What feels most urgent?",
    "That feeling is real and makes sense. You don't have to tackle everything at once. What's the smallest thing that would actually make a dent?",
    "Okay — let's not try to solve all of it at once. What's the one thing that, if you did it today, would make everything else a little easier?",
  ],
  discouraged: [
    "I hear that. Being afraid something will fail doesn't mean it will — but it does mean it matters to you. That's actually a good sign. What's the specific fear?",
    "That discouragement is real, and it makes sense. Let's look at it practically — what would success actually take? Sometimes that's more possible than it feels.",
    "Fear of failure is just caring about the outcome. What would a small, low-stakes test of the idea look like — something you could try without betting everything on it?",
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

// Detect whether a coding follow-up message provides the language/goal info
// that the prior coding clarification requested.
const CODING_LANG_PATTERN = /\b(python|javascript|typescript|js|ts|java|c\+\+|cpp|c#|csharp|ruby|go|rust|php|swift|kotlin|bash|shell|sql|html|css|react|node)\b/i
const CODING_GOAL_PATTERN = /\b(sort|filter|fetch|parse|read|write|create|delete|update|loop|iterate|list|map|reduce|find|search|generate|validate|format|convert|connect|call|return|print|display|render|calculate|count|sum|merge|split|join)\b/i

/**
 * Returns true if the message contains signals of impulsive/risky reasoning
 * that Daemon should respectfully push back on.
 */
export function detectPushback(input: string): boolean {
  return PUSHBACK_PATTERNS.some(p => p.test(input))
}

export function detectIntent(input: string, lastIntent?: ResponseIntent): ResponseIntent {
  // If we just asked a coding clarification, check whether this message supplies
  // language or goal info — if so, move forward instead of looping.
  if (lastIntent === 'coding' || lastIntent === 'coding-followup') {
    if (CODING_LANG_PATTERN.test(input) || CODING_GOAL_PATTERN.test(input)) {
      return 'coding-followup'
    }
  }

  // When a message contains substantive coding content alongside a greeting,
  // prefer the coding intent so the request is not silently dropped.
  const hasCoding = INTENT_PATTERNS.find(r => r.intent === 'coding')?.pattern.test(input)
  const hasGreeting = INTENT_PATTERNS.find(r => r.intent === 'greeting')?.pattern.test(input)
  if (hasCoding && hasGreeting) return 'coding'

  for (const rule of INTENT_PATTERNS) {
    if (rule.pattern.test(input)) return rule.intent
  }

  // Heuristic: only fire uncertain for extremely vague fragments (≤2 meaningful words,
  // ends with ?, and contains no word longer than 3 chars — e.g. "why?" or "huh?").
  // Short but substantive questions ("What is AI?", "How?") are left to reach 'answer'.
  const words = input.trim().split(/\s+/)
  if (words.length <= 2 && /\?/.test(input) && !words.some(w => /[a-z]{4,}/i.test(w))) return 'uncertain'

  // Pushback: risky/impulsive phrasing detected
  if (detectPushback(input)) return 'pushback'

  return 'answer'
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

// Natural reference phrases for memory callbacks — avoids robotic verbatim quoting
const MEMORY_OPENERS = [
  "Picking up on what you mentioned earlier",
  "Building on what you shared before",
  "Connecting back to what you said",
  "Given what you brought up earlier",
  "Following on from what you mentioned",
]

function memoryPhrase(memories: MemorySnippet[] = []): string {
  if (memories.length === 0) return ''
  const ranked = [...memories].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0))
  const chosen = ranked[0]
  const excerpt = chosen.text.trim()
  if (!excerpt) return ''
  // Extract a short keyword phrase from the memory rather than quoting verbatim
  const FILLER = /^(i|can|could|please|write|tell|show|help|me|you|a|an|the|this|that|it|is|are|was|be|do|does|did|my|your|to|and|or|but|so|just|really|very)$/i
  const keywords = excerpt.split(/\s+/).filter(w => !FILLER.test(w) && w.length >= 3).slice(0, 5).join(' ')
  // If no meaningful keywords were found, skip the memory reference entirely
  // rather than emitting a grammatically awkward phrase.
  if (!keywords) return ''
  const opener = pick(MEMORY_OPENERS)
  return `${opener} about ${keywords} — `
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
  const { mood, intent, memories, wantsShortAnswer, personality } = context

  // Resolve effective personality settings (defaults apply for any unset field)
  const ps: Required<PersonalitySettings> = { ...DEFAULT_PERSONALITY, ...(personality ?? {}) }
  const isWarm = ps.warmth === 'warm'
  const isReserved = ps.warmth === 'reserved'

  // Determine whether to include a follow-up question based on preferences
  const includeFollowUp = ps.followUpQuestions

  // 0. Custom greeting/sign-off — prepend only when the intent is greeting
  //    and the user has explicitly opted in.  This is NOT a romantic claim.
  const signoff = (ps.customGreeting && intent === 'greeting')
    ? ` ${ps.customGreeting.trim()}`
    : ''

  // 1. For emotionally charged moods that warrant a full bespoke reply, use
  //    the mood-specific response pool directly (no echo).
  //    Apply to all non-greeting, non-humor, non-identity intents so mood
  //    always takes priority over generic answer/clarify/suggest flows.
  const moodFull = MOOD_FULL_RESPONSES[mood]
  const moodOverrideIntents: ResponseIntent[] = ['answer', 'clarify', 'suggest', 'follow-up', 'acknowledge', 'pushback']
  if (moodFull && moodOverrideIntents.includes(intent)) {
    const opener = pick(moodFull)
    if (wantsShortAnswer) return opener
    const closer = includeFollowUp ? ` ${pick(CLOSERS[mood])}` : ''
    return `${opener}${closer}`
  }

  // 2. Humor — return a standalone joke/banter response.
  //    Never use humor for sad/overwhelmed/discouraged moods.
  if (intent === 'humor') {
    if (mood === 'sad' || mood === 'overwhelmed' || mood === 'discouraged') {
      return "I can try to lighten the mood a bit later — but let me make sure you're okay first. What's going on?"
    }
    if (ps.humorLevel === 'none') {
      return pick(CANNED_ANSWERS.answer)
    }
    return pick(CANNED_ANSWERS.humor)
  }

  // 3. Uncertain/vague query — honest "I don't know" fallback.
  if (intent === 'uncertain') {
    return pick(CANNED_ANSWERS.uncertain)
  }

  // 3b. Prompt-injection attempt — acknowledge and stay in character.
  if (intent === 'prompt-injection') {
    return pick(CANNED_ANSWERS['prompt-injection'])
  }

  // 3c. Pushback — challenge weak/risky/impulsive decisions respectfully.
  if (intent === 'pushback') {
    return pick(CANNED_ANSWERS.pushback)
  }

  // 4. For well-defined intents that have complete canned answers, use them.
  const standAloneIntents: ResponseIntent[] = ['greeting', 'identity', 'smalltalk', 'acknowledge', 'clarify', 'answer', 'follow-up', 'suggest']
  if (standAloneIntents.includes(intent)) {
    const base = pick(CANNED_ANSWERS[intent])
    if (intent === 'greeting' && signoff) return base + signoff
    // Reserved warmth: strip extra openers; warm: they stand as-is
    if (isReserved && intent === 'acknowledge') {
      // Shorter ack for reserved warmth
      return pick(["Sure, got it.", "Understood.", "Noted.", "Got it."])
    }
    if (isWarm && intent === 'greeting') {
      return pick([
        "Really glad you're here — what's on your mind?",
        "Hey! Always happy to see you. What can I help with?",
        "Hi there! I'm here — what do you need today?",
      ]) + signoff
    }
    return base
  }

  // 5. Coding clarification: first ask for details; on follow-up, acknowledge and proceed.
  if (intent === 'coding') {
    return pick(CANNED_ANSWERS.coding)
  }
  if (intent === 'coding-followup') {
    return pick(CANNED_ANSWERS['coding-followup'])
  }

  // 6. Guard against empty content
  const rawContent = baseResponse.trim() || context.userMessage.trim()
  const openerPool = MOOD_OPENERS[mood]
  const closerPool = CLOSERS[mood]
  const memory = memoryPhrase(memories)

  if (!rawContent) {
    const closer = includeFollowUp ? ` ${pick(closerPool)}` : ''
    return `${pick(openerPool)}${closer}`.replace(/\s+/g, ' ').trim()
  }

  // 7. For answer / suggest / follow-up: build a composed response using a
  //    topic phrase derived from the message (not a verbatim quote), with mood coloring.
  const topic = buildTopicPhrase(rawContent, context)

  // Shuffle pools so different entries are selected on every call
  const shuffled = <T,>(arr: T[]): T[] => [...arr].sort(() => Math.random() - 0.5)
  const candidates: string[] = []
  const openers = shuffled(openerPool).slice(0, 3)
  const cores = shuffled(CANNED_ANSWERS[intent] ?? CANNED_ANSWERS.answer).slice(0, 3)
  const closers = includeFollowUp ? shuffled(closerPool).slice(0, 3) : ['']

  for (const opener of openers) {
    for (const core of cores) {
      for (const closer of closers) {
        const suffix = closer ? `. ${closer}` : '.'
        const candidate = `${opener} ${memory}${core}${topic}${suffix}`
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

// ---------------------------------------------------------------------------
// Adaptive orchestration
//
// buildResponse wires the adaptive layer around generateHumanLikeResponse:
//   1. routeRequest decides where the turn should be handled (and reports
//      honestly when a capability is unavailable).
//   2. selectStrategy picks an approved response strategy for the situation.
//   3. retrieveRelevantMemories supplies bounded, provenance-tagged context.
//
// The strategy can only influence phrasing/shape within already-approved
// behavior — it never changes safety, crisis, refusal, or factuality policy,
// and Daemon never claims sentience regardless of what was learned.
// ---------------------------------------------------------------------------

export interface BuildResponseOptions {
  userMessage: string
  /** Explicit user personality settings. These always outrank inferred ones. */
  personalityPrefs?: PersonalityPreferences
  /** Defaults to the stored profile; injectable for tests and offline use. */
  adaptiveProfile?: AdaptiveProfile
  /** Durable memories to consider for retrieval. */
  memories?: DurableMemory[]
  lastIntent?: ResponseIntent
  isAuthenticated?: boolean
  isOnline?: boolean
  cloudAvailable?: boolean
  privacyOptOut?: boolean
  retrievalConfig?: Partial<RetrievalConfig>
}

export interface BuildResponseResult {
  text: string
  mood: UserMood
  intent: ResponseIntent
  strategy: ResponseStrategy
  contextKey: string
  strategySelection: StrategySelectionResult
  routing: RoutingDecision
  retrievedMemories: RetrievedMemory[]
  complexity: 'simple' | 'moderate' | 'complex'
  wantsShortAnswer: boolean
}

/**
 * Produces a local response together with the metadata needed to attribute
 * later feedback (strategy + contextKey) and to explain what context was used.
 */
export function buildResponse(options: BuildResponseOptions): BuildResponseResult {
  const {
    userMessage,
    personalityPrefs = {},
    memories = [],
    lastIntent,
    isAuthenticated = false,
    isOnline = true,
    cloudAvailable = false,
    privacyOptOut = false,
    retrievalConfig,
  } = options

  const mood = detectMood(userMessage)
  const intent = detectIntent(userMessage, lastIntent)
  const adaptiveProfile = options.adaptiveProfile ?? getAdaptiveProfile()
  const complexity = classifyComplexity(userMessage, intent)

  const routing = routeRequest({
    intent,
    mood,
    complexity,
    isAuthenticated,
    isOnline,
    cloudAvailable,
    privacyOptOut,
    taskKeywords: extractTaskKeywords(userMessage),
  })

  const strategySelection = selectStrategy(intent, mood, adaptiveProfile, personalityPrefs)

  const retrievedMemories = retrieveRelevantMemories(
    userMessage,
    memories,
    adaptiveProfile,
    retrievalConfig,
  )

  const wantsShortAnswer = userMessage.trim().split(/\s+/).length <= 5
    || strategySelection.strategy === 'concise-action-plan'

  const snippets: MemorySnippet[] = retrievedMemories
    .filter(m => m.type === 'explicit')
    .map(m => ({ text: m.text, relevance: m.relevanceScore }))

  const text = generateHumanLikeResponse(userMessage, {
    userMessage,
    mood,
    intent,
    memories: snippets.length > 0 ? snippets : undefined,
    wantsShortAnswer,
    lastIntent,
    personality: strategyAwarePersonality(personalityPrefs, strategySelection.strategy),
  })

  return {
    text,
    mood,
    intent,
    strategy: strategySelection.strategy,
    contextKey: strategySelection.contextKey,
    strategySelection,
    routing,
    retrievedMemories,
    complexity,
    wantsShortAnswer,
  }
}

/**
 * Converts explicit preferences into PersonalitySettings, letting the selected
 * strategy shape only the fields the user has not set explicitly.
 * Explicit settings always win.
 */
function strategyAwarePersonality(
  prefs: PersonalityPreferences,
  strategy: ResponseStrategy,
): PersonalitySettings {
  const settings: PersonalitySettings = {
    detailLevel: prefs.detail_level,
    warmth: prefs.warmth,
    humorLevel: prefs.humor_level,
    directness: prefs.directness,
    allowMildProfanity: prefs.allow_mild_profanity,
    followUpQuestions: prefs.follow_up_questions,
    customGreeting: prefs.custom_greeting ?? null,
    patternRecognition: prefs.pattern_recognition,
  }

  if (settings.detailLevel === undefined && strategy === 'concise-action-plan') {
    settings.detailLevel = 'concise'
  }
  if (settings.followUpQuestions === undefined && strategy === 'clarify-first') {
    settings.followUpQuestions = true
  }
  return settings
}
