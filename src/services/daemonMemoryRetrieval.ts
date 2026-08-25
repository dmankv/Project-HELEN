/**
 * Daemon Relevant Memory Retrieval
 *
 * Deterministic, bounded retrieval of context for a single turn. No vector
 * database, no embeddings, no network calls — plain lexical overlap plus
 * recency, so results are reproducible and auditable.
 *
 * Hard boundaries (non-negotiable):
 *   • Never retrieves (or stores) passwords, API keys, auth tokens, payment
 *     details, government IDs, precise location, or sensitive medical/legal
 *     information. See FORBIDDEN_MEMORY_PATTERNS.
 *   • Never surfaces sensitive traits, political profiles, or
 *     relationship-dependency signals.
 *   • Every returned item carries provenance (explicit memory vs inferred
 *     preference) and a confidence value so the user can tell them apart.
 *   • Results are hard-bounded by item count and total characters.
 */

import type { DurableMemory } from './daemonMemory'
import type { AdaptiveProfile } from './daemonAdaptiveProfile'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievedMemory {
  id: string
  text: string
  type: 'explicit' | 'adaptive-preference'
  confidence: number
  relevanceScore: number
  source: string
  createdAt: string
  tags?: string[]
}

export interface RetrievalConfig {
  maxItems: number
  maxTotalChars: number
  minRelevanceScore: number
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  maxItems: 5,
  maxTotalChars: 1000,
  minRelevanceScore: 0.1,
}


// ---------------------------------------------------------------------------
// Forbidden content
// ---------------------------------------------------------------------------

/**
 * Categories that must never be retained or retrieved. Matching text is
 * dropped entirely rather than redacted, so a partial match cannot leak.
 */
export const FORBIDDEN_MEMORY_PATTERNS: RegExp[] = [
  // Credentials and secrets
  /\b(password|passphrase|passcode|pin\s*(code|number))\b\s*(is|=|:)?/i,
  /\b(api[\s_-]?key|secret[\s_-]?key|access[\s_-]?token|refresh[\s_-]?token|bearer\s+token|auth[\s_-]?token|private[\s_-]?key|client[\s_-]?secret)\b/i,
  /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Payment information
  /\b(credit[\s_-]?card|debit[\s_-]?card|card\s*number|cvv|cvc|iban|routing\s*number|account\s*number|sort\s*code)\b/i,
  /\b(?:\d[ -]?){13,19}\b/,
  // Government identifiers
  /\b(social security(\s*number)?|ssn|passport\s*(no|number)|driver'?s?\s*licen[cs]e|national\s*insurance|tax\s*id|nhs\s*number)\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Precise location
  /\b-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/,
  /\b(home address|my address is|i live at|gps coordinates|lat(itude)?\s*[:=]\s*-?\d)/i,
  // Sensitive medical / legal
  /\b(diagnos(is|ed|es)|prescri(bed|ption)|medication|hiv|std|sti|cancer|therapy session|psychiatric|mental health record|medical record)\b/i,
  /\b(criminal record|arrest(ed)?|conviction|lawsuit|court case|restraining order|immigration status|visa status)\b/i,
  // Sensitive traits / profiling / dependency signals
  /\b(political (party|affiliation|views)|voted for|religion is|religious belief|sexual orientation|gender identity|ethnicity is|union member)\b/i,
  /\b(you'?re all i have|only one who understands me|can'?t live without you|my only friend)\b/i,
]

/** True when the text matches any prohibited data category. */
export function containsForbiddenContent(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false
  return FORBIDDEN_MEMORY_PATTERNS.some(p => p.test(text))
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'did', 'do', 'does', 'for',
  'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'not',
  'of', 'on', 'or', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this',
  'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'you', 'your',
])

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter(t => t.length > 2 && !STOP_WORDS.has(t)),
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Recency bonus: newer context is more likely to still be relevant. */
export const RECENCY_BONUS_RECENT = 0.1
export const RECENCY_BONUS_MONTH = 0.05

/** Explicit memories the user asked Daemon to keep outrank inferred ones. */
export const EXPLICIT_PRIORITY_BONUS = 0.2

export interface ScoreOptions {
  createdAt?: string
  type?: 'explicit' | 'adaptive-preference'
  now?: Date
}

/**
 * Deterministic relevance in [0, 1]: Jaccard topic overlap plus a recency
 * bonus and an explicit-memory priority bonus.
 */
export function scoreRelevance(memoryText: string, query: string, options: ScoreOptions = {}): number {
  const memTokens = tokenize(memoryText ?? '')
  const queryTokens = tokenize(query ?? '')

  let score = 0
  if (memTokens.size > 0 && queryTokens.size > 0) {
    let intersection = 0
    for (const token of queryTokens) {
      if (memTokens.has(token)) intersection++
    }
    const union = memTokens.size + queryTokens.size - intersection
    score = union > 0 ? intersection / union : 0
  }

  const now = options.now ?? new Date()
  if (options.createdAt) {
    const ts = Date.parse(options.createdAt)
    if (!Number.isNaN(ts)) {
      const ageDays = (now.getTime() - ts) / DAY_MS
      if (ageDays >= 0 && ageDays < 7) score += RECENCY_BONUS_RECENT
      else if (ageDays >= 0 && ageDays < 30) score += RECENCY_BONUS_MONTH
    }
  }

  if (options.type === 'explicit') score += EXPLICIT_PRIORITY_BONUS

  return Math.min(1, Math.round(score * 10000) / 10000)
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

function adaptiveMemoryText(value: string, explanation: string): string {
  return `Learned preference: ${value}. ${explanation}`
}

/**
 * Returns the most relevant, non-prohibited context for a query, bounded by
 * item count and total characters, with provenance on every item.
 *
 * Ordering is deterministic: relevance desc, then createdAt desc, then id.
 */
export function retrieveRelevantMemories(
  query: string,
  memories: DurableMemory[],
  adaptiveProfile: AdaptiveProfile,
  config: Partial<RetrievalConfig> = {},
): RetrievedMemory[] {
  const cfg: RetrievalConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config }
  const now = new Date()
  const candidates: RetrievedMemory[] = []

  for (const memory of memories ?? []) {
    if (!memory || typeof memory.text !== 'string') continue
    if (containsForbiddenContent(memory.text)) continue
    const relevanceScore = scoreRelevance(memory.text, query, {
      createdAt: memory.createdAt,
      type: 'explicit',
      now,
    })
    candidates.push({
      id: memory.id,
      text: memory.text,
      type: 'explicit',
      confidence: 1,
      relevanceScore,
      source: 'You asked Daemon to remember this.',
      createdAt: memory.createdAt,
      tags: memory.tags,
    })
  }

  for (const pref of adaptiveProfile?.preferences ?? []) {
    const text = adaptiveMemoryText(pref.value, pref.explanation)
    if (containsForbiddenContent(text)) continue
    const relevanceScore = scoreRelevance(`${pref.key} ${pref.value} ${pref.explanation}`, query, {
      createdAt: pref.updatedAt,
      type: 'adaptive-preference',
      now,
    })
    candidates.push({
      id: pref.key,
      text,
      type: 'adaptive-preference',
      confidence: pref.confidence,
      relevanceScore,
      source: pref.source === 'explicit-user-confirmation'
        ? 'You confirmed this preference.'
        : 'Inferred from your feedback. You can review or delete it.',
      createdAt: pref.updatedAt,
    })
  }

  const ranked = candidates
    .filter(c => c.relevanceScore >= cfg.minRelevanceScore)
    .sort((a, b) =>
      b.relevanceScore - a.relevanceScore
      || b.createdAt.localeCompare(a.createdAt)
      || a.id.localeCompare(b.id))

  const selected: RetrievedMemory[] = []
  let totalChars = 0
  for (const item of ranked) {
    if (selected.length >= cfg.maxItems) break
    if (totalChars + item.text.length > cfg.maxTotalChars) continue
    selected.push(item)
    totalChars += item.text.length
  }
  return selected
}

/** Short, readable provenance summary for display or logging. */
export function formatRetrievedMemories(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return 'No relevant context used.'
  return memories
    .map(m => `• [${m.type}] ${m.text} (relevance ${m.relevanceScore.toFixed(2)}, confidence ${m.confidence.toFixed(2)})`)
    .join('\n')
}
