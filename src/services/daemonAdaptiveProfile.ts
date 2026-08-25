/**
 * Daemon Adaptive Profile Service
 *
 * Stores a small, bounded set of *inferred* communication preferences that
 * Daemon may learn from feedback, plus the controls the user needs to see,
 * edit, and erase them.
 *
 * Hard boundaries (non-negotiable):
 *   • Daemon is never sentient, conscious, human, or "the user".
 *   • Learning may only select among approved response strategies and the
 *     bounded preference values enumerated below. It can never modify
 *     production code, prompts, migrations, RLS, auth, or safety policy.
 *   • Only the allowlisted keys/values in ADAPTIVE_PREFERENCE_ALLOWED_VALUES
 *     may be stored. Arbitrary keys, free-text values, sensitive traits,
 *     political profiles, and relationship-dependency signals are rejected.
 *   • Explicit user settings always override inferred preferences.
 *   • Everything stored here is visible, explainable, editable, and deletable.
 *
 * Storage is localStorage-only so the feature works offline and while
 * unauthenticated. Cloud sync (see supabase/migrations/*_adaptive_profiles.sql)
 * is owner-only via RLS.
 */

import { genUUID } from './daemonStorageMigration'
import type { PersonalityPreferences } from './daemonPersonalityPreferences'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allowed adaptive preference keys (allowlist — no arbitrary keys). */
export type AdaptivePreferenceKey =
  | 'response_detail_tendency'
  | 'directness_preference'
  | 'preferred_problem_solving_strategy'
  | 'follow_up_question_tolerance'
  | 'desired_structure'
  | 'humor_preference'
  | 'helpful_contexts'

/** Allowed values per key (bounded enums — no free text). */
export const ADAPTIVE_PREFERENCE_ALLOWED_VALUES: Record<AdaptivePreferenceKey, readonly string[]> = {
  response_detail_tendency: ['concise', 'balanced', 'detailed'],
  directness_preference: ['gentle', 'balanced', 'direct'],
  preferred_problem_solving_strategy: [
    'direct-answer',
    'step-by-step-plan',
    'tradeoff-options',
    'research-and-cite',
    'clarify-first',
  ],
  follow_up_question_tolerance: ['low', 'medium', 'high'],
  desired_structure: ['summary', 'checklist', 'plan', 'narrative'],
  humor_preference: ['none', 'light', 'moderate'],
  helpful_contexts: ['coding', 'planning', 'emotional-support', 'research', 'general'],
}

export const ADAPTIVE_PREFERENCE_KEYS = Object.keys(
  ADAPTIVE_PREFERENCE_ALLOWED_VALUES,
) as AdaptivePreferenceKey[]

export type AdaptivePreferenceSource = 'feedback-derived' | 'explicit-user-confirmation'

export interface AdaptivePreference {
  key: AdaptivePreferenceKey
  value: string
  /** 0–1. Feedback-derived confidence grows slowly and decays on negatives. */
  confidence: number
  evidenceCount: number
  source: AdaptivePreferenceSource
  createdAt: string // ISO-8601
  updatedAt: string
  /** Feedback-derived preferences expire without reinforcement. */
  expiresAt?: string
  /** Plain-language explanation that is safe to show the user. */
  explanation: string
}

export interface AdaptiveProfile {
  /** 'local' when unauthenticated. */
  userId: string
  preferences: AdaptivePreference[]
  learningEnabled: boolean
  updatedAt: string
  policyVersion: number
}

/** A single feedback signal. Bounded, allowlisted, never free text. */
export interface AdaptiveEvidence {
  id: string
  key: AdaptivePreferenceKey
  value: string
  isPositive: boolean
  createdAt: string
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Minimum number of positive signals before anything is inferred. */
export const ADAPTIVE_MIN_EVIDENCE = 3

/** Confirming signals required to change an already-established value. */
export const ADAPTIVE_CHANGE_COOLDOWN_SIGNALS = 2

/** Feedback-derived preferences expire after this long without reinforcement. */
export const ADAPTIVE_EXPIRY_DAYS = 90

/** Confidence lost per negative signal. */
export const ADAPTIVE_NEGATIVE_STEP = 0.2

/** Below this confidence a feedback-derived preference is dropped entirely. */
export const ADAPTIVE_MIN_CONFIDENCE = 0.1

/** Confidence required before an inferred strategy may steer selection. */
export const ADAPTIVE_TRUST_THRESHOLD = 0.7

export const ADAPTIVE_POLICY_VERSION = 1

const DAY_MS = 24 * 60 * 60 * 1000

const PROFILE_KEY = 'daemon_adaptive_profile'
const EVIDENCE_KEY = 'daemon_adaptive_evidence'

/** Evidence ledger is bounded so localStorage cannot grow without limit. */
const MAX_EVIDENCE_RECORDS = 500

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidAdaptiveKey(key: string): key is AdaptivePreferenceKey {
  return Object.prototype.hasOwnProperty.call(ADAPTIVE_PREFERENCE_ALLOWED_VALUES, key)
}

export function isValidAdaptiveValue(key: string, value: string): boolean {
  if (!isValidAdaptiveKey(key)) return false
  return ADAPTIVE_PREFERENCE_ALLOWED_VALUES[key].includes(value)
}

/**
 * Throws when a key/value pair is outside the allowlist. Callers must never
 * be able to persist arbitrary or sensitive inferences.
 */
export function assertAdaptivePair(key: string, value: string): void {
  if (!isValidAdaptiveKey(key)) {
    throw new Error(`Adaptive preference key is not allowed: ${key}`)
  }
  if (!ADAPTIVE_PREFERENCE_ALLOWED_VALUES[key].includes(value)) {
    throw new Error(`Adaptive preference value is not allowed for ${key}: ${value}`)
  }
}

/** Drops any stored entry that is not a well-formed, allowlisted preference. */
function validatePreference(raw: unknown): AdaptivePreference | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.key !== 'string' || typeof r.value !== 'string') return null
  if (!isValidAdaptiveValue(r.key, r.value)) return null
  if (r.source !== 'feedback-derived' && r.source !== 'explicit-user-confirmation') return null
  const confidence = typeof r.confidence === 'number' ? clamp01(r.confidence) : 0
  const evidenceCount = typeof r.evidenceCount === 'number' && r.evidenceCount >= 0
    ? Math.floor(r.evidenceCount)
    : 0
  const createdAt = typeof r.createdAt === 'string' ? r.createdAt : new Date().toISOString()
  const updatedAt = typeof r.updatedAt === 'string' ? r.updatedAt : createdAt
  return {
    key: r.key as AdaptivePreferenceKey,
    value: r.value,
    confidence,
    evidenceCount,
    source: r.source,
    createdAt,
    updatedAt,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : undefined,
    explanation: typeof r.explanation === 'string' ? r.explanation : buildExplanation(
      r.key as AdaptivePreferenceKey,
      r.value,
      r.source,
      evidenceCount,
    ),
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

// ---------------------------------------------------------------------------
// Explanations (always user-visible, never speculative about the person)
// ---------------------------------------------------------------------------

const KEY_LABELS: Record<AdaptivePreferenceKey, string> = {
  response_detail_tendency: 'how much detail you seem to prefer',
  directness_preference: 'how direct you seem to prefer answers',
  preferred_problem_solving_strategy: 'how you seem to prefer problems to be approached',
  follow_up_question_tolerance: 'how many follow-up questions you seem to welcome',
  desired_structure: 'how you seem to prefer answers to be structured',
  humor_preference: 'how much humor you seem to welcome',
  helpful_contexts: 'the kinds of tasks you seem to find Daemon most useful for',
}

function buildExplanation(
  key: AdaptivePreferenceKey,
  value: string,
  source: AdaptivePreferenceSource,
  evidenceCount: number,
): string {
  if (source === 'explicit-user-confirmation') {
    return `You confirmed "${value}" for ${KEY_LABELS[key]}. This stays until you change it.`
  }
  return `Inferred "${value}" for ${KEY_LABELS[key]} from ${evidenceCount} helpful-response signal${evidenceCount === 1 ? '' : 's'}. You can accept, change, or delete this.`
}

// ---------------------------------------------------------------------------
// Persistence (localStorage; every access guarded)
// ---------------------------------------------------------------------------

function emptyProfile(userId = 'local'): AdaptiveProfile {
  return {
    userId,
    preferences: [],
    learningEnabled: true,
    updatedAt: new Date().toISOString(),
    policyVersion: ADAPTIVE_POLICY_VERSION,
  }
}

function readProfile(): AdaptiveProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY)
    if (!raw) return emptyProfile()
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return emptyProfile()
    const preferences = Array.isArray(parsed.preferences)
      ? parsed.preferences.map(validatePreference).filter((p): p is AdaptivePreference => p !== null)
      : []
    return {
      userId: typeof parsed.userId === 'string' && parsed.userId ? parsed.userId : 'local',
      preferences,
      learningEnabled: parsed.learningEnabled !== false,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      policyVersion: typeof parsed.policyVersion === 'number' ? parsed.policyVersion : ADAPTIVE_POLICY_VERSION,
    }
  } catch {
    return emptyProfile()
  }
}

function writeProfile(profile: AdaptiveProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch { /* quota exceeded — best effort */ }
}

function readEvidence(): AdaptiveEvidence[] {
  try {
    const raw = localStorage.getItem(EVIDENCE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is AdaptiveEvidence => {
      if (!e || typeof e !== 'object') return false
      const r = e as Record<string, unknown>
      return typeof r.id === 'string'
        && typeof r.key === 'string'
        && typeof r.value === 'string'
        && typeof r.isPositive === 'boolean'
        && typeof r.createdAt === 'string'
        && isValidAdaptiveValue(r.key, r.value)
    })
  } catch {
    return []
  }
}

function writeEvidence(evidence: AdaptiveEvidence[]): void {
  try {
    localStorage.setItem(EVIDENCE_KEY, JSON.stringify(evidence.slice(-MAX_EVIDENCE_RECORDS)))
  } catch { /* quota exceeded — best effort */ }
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function isExpired(pref: AdaptivePreference, now: Date): boolean {
  if (pref.source === 'explicit-user-confirmation') return false
  if (!pref.expiresAt) return false
  const ts = Date.parse(pref.expiresAt)
  if (Number.isNaN(ts)) return false
  return ts <= now.getTime()
}

function expiryFrom(now: Date): string {
  return new Date(now.getTime() + ADAPTIVE_EXPIRY_DAYS * DAY_MS).toISOString()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current profile with expired feedback-derived preferences
 * removed. Pruning is persisted so expired inferences never come back.
 */
export function getAdaptiveProfile(): AdaptiveProfile {
  const profile = readProfile()
  const now = new Date()
  const active = profile.preferences.filter(p => !isExpired(p, now))
  if (active.length !== profile.preferences.length) {
    const pruned: AdaptiveProfile = { ...profile, preferences: active, updatedAt: now.toISOString() }
    writeProfile(pruned)
    return pruned
  }
  return profile
}

/** Returns the raw feedback ledger backing the inferred preferences. */
export function getAdaptiveEvidence(): AdaptiveEvidence[] {
  return readEvidence()
}

/** Associates the local profile with an authenticated user id (or 'local'). */
export function setAdaptiveProfileUserId(userId: string | null): AdaptiveProfile {
  const profile = getAdaptiveProfile()
  const next: AdaptiveProfile = {
    ...profile,
    userId: userId ?? 'local',
    updatedAt: new Date().toISOString(),
  }
  writeProfile(next)
  return next
}

/**
 * Records one feedback signal for an allowlisted key/value pair and updates
 * the inferred preference when the evidence threshold and cooldown allow it.
 *
 * Throws when the key/value pair is outside the allowlist.
 * No-ops (other than throwing on invalid input) when learning is disabled.
 */
export function updateInferredPreference(
  key: AdaptivePreferenceKey,
  value: string,
  isPositiveFeedback: boolean,
): void {
  assertAdaptivePair(key, value)

  const profile = getAdaptiveProfile()
  if (!profile.learningEnabled) return

  const now = new Date()
  const nowIso = now.toISOString()

  const evidence = readEvidence()
  evidence.push({ id: genUUID(), key, value, isPositive: isPositiveFeedback, createdAt: nowIso })
  writeEvidence(evidence)

  const existing = profile.preferences.find(p => p.key === key)

  // Explicit confirmations are durable: feedback never overwrites them.
  if (existing && existing.source === 'explicit-user-confirmation') return

  if (!isPositiveFeedback) {
    if (!existing || existing.value !== value) return
    const confidence = clamp01(existing.confidence - ADAPTIVE_NEGATIVE_STEP)
    const next = confidence < ADAPTIVE_MIN_CONFIDENCE
      ? profile.preferences.filter(p => p.key !== key)
      : profile.preferences.map(p => p.key === key
        ? { ...p, confidence, updatedAt: nowIso, explanation: buildExplanation(key, value, 'feedback-derived', p.evidenceCount) }
        : p)
    writeProfile({ ...profile, preferences: next, updatedAt: nowIso })
    return
  }

  const positives = evidence.filter(e => e.key === key && e.value === value && e.isPositive)

  if (existing && existing.value === value) {
    // Reinforcement: strengthen and push the expiry window out.
    const evidenceCount = existing.evidenceCount + 1
    const updated: AdaptivePreference = {
      ...existing,
      evidenceCount,
      confidence: confidenceFor(evidenceCount),
      updatedAt: nowIso,
      expiresAt: expiryFrom(now),
      explanation: buildExplanation(key, value, 'feedback-derived', evidenceCount),
    }
    writeProfile({
      ...profile,
      preferences: profile.preferences.map(p => (p.key === key ? updated : p)),
      updatedAt: nowIso,
    })
    return
  }

  if (positives.length < ADAPTIVE_MIN_EVIDENCE) return

  if (existing) {
    // Cooldown: an established value only changes after repeated confirmation
    // of the competing value recorded *after* the current value was set.
    const since = Date.parse(existing.updatedAt)
    const confirming = positives.filter(e => {
      const ts = Date.parse(e.createdAt)
      return Number.isNaN(ts) || Number.isNaN(since) ? true : ts >= since
    })
    if (confirming.length < ADAPTIVE_CHANGE_COOLDOWN_SIGNALS) return
  }

  const evidenceCount = positives.length
  const inferred: AdaptivePreference = {
    key,
    value,
    confidence: confidenceFor(evidenceCount),
    evidenceCount,
    source: 'feedback-derived',
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    expiresAt: expiryFrom(now),
    explanation: buildExplanation(key, value, 'feedback-derived', evidenceCount),
  }
  writeProfile({
    ...profile,
    preferences: [...profile.preferences.filter(p => p.key !== key), inferred],
    updatedAt: nowIso,
  })
}

/**
 * Confidence grows with evidence but never reaches certainty. Three signals
 * yield 0.6; the inferred value only steers strategy selection once it passes
 * ADAPTIVE_TRUST_THRESHOLD.
 */
function confidenceFor(evidenceCount: number): number {
  return clamp01(Math.round((evidenceCount / (evidenceCount + 2)) * 1000) / 1000)
}

/**
 * Durably records a preference the user explicitly confirmed. Overrides any
 * inferred value for the same key and never expires.
 */
export function explicitlyConfirmPreference(key: AdaptivePreferenceKey, value: string): void {
  assertAdaptivePair(key, value)
  const profile = getAdaptiveProfile()
  const nowIso = new Date().toISOString()
  const existing = profile.preferences.find(p => p.key === key)
  const confirmed: AdaptivePreference = {
    key,
    value,
    confidence: 1,
    evidenceCount: existing?.evidenceCount ?? 0,
    source: 'explicit-user-confirmation',
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    explanation: buildExplanation(key, value, 'explicit-user-confirmation', 0),
  }
  writeProfile({
    ...profile,
    preferences: [...profile.preferences.filter(p => p.key !== key), confirmed],
    updatedAt: nowIso,
  })
}

/** Removes a single preference and the evidence that produced it. */
export function removePreference(key: AdaptivePreferenceKey): void {
  if (!isValidAdaptiveKey(key)) {
    throw new Error(`Adaptive preference key is not allowed: ${key}`)
  }
  const profile = getAdaptiveProfile()
  writeProfile({
    ...profile,
    preferences: profile.preferences.filter(p => p.key !== key),
    updatedAt: new Date().toISOString(),
  })
  writeEvidence(readEvidence().filter(e => e.key !== key))
}

/**
 * Clears every inferred preference and all evidence. Explicit confirmations
 * are kept because the user set them deliberately.
 */
export function resetAllInferredPreferences(): void {
  const profile = getAdaptiveProfile()
  writeProfile({
    ...profile,
    preferences: profile.preferences.filter(p => p.source === 'explicit-user-confirmation'),
    updatedAt: new Date().toISOString(),
  })
  writeEvidence([])
}

/** Erases the entire adaptive profile, including explicit confirmations. */
export function deleteAdaptiveProfile(): void {
  try {
    localStorage.removeItem(PROFILE_KEY)
    localStorage.removeItem(EVIDENCE_KEY)
  } catch { /* ignore */ }
}

/**
 * Global learning switch. When disabled no new inference happens; existing
 * entries stay visible and manageable.
 */
export function setLearningEnabled(enabled: boolean): void {
  const profile = getAdaptiveProfile()
  writeProfile({ ...profile, learningEnabled: enabled, updatedAt: new Date().toISOString() })
}

export function isLearningEnabled(): boolean {
  return getAdaptiveProfile().learningEnabled
}

/** JSON export of everything Daemon inferred, for user review or portability. */
export function exportAdaptiveProfile(): string {
  return JSON.stringify(
    { profile: getAdaptiveProfile(), evidence: getAdaptiveEvidence() },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// Precedence: explicit user settings always win
// ---------------------------------------------------------------------------

/**
 * Maps an explicitly configured personality preference onto an adaptive key.
 * Returns undefined when the user has not set the corresponding field, in
 * which case the inferred value (if any) may be used.
 */
function explicitValueFor(
  key: AdaptivePreferenceKey,
  prefs: PersonalityPreferences,
): string | undefined {
  switch (key) {
    case 'response_detail_tendency':
      return prefs.detail_level
    case 'directness_preference':
      return prefs.directness
    case 'humor_preference':
      return prefs.humor_level
    case 'follow_up_question_tolerance':
      if (typeof prefs.follow_up_questions !== 'boolean') return undefined
      return prefs.follow_up_questions ? 'high' : 'low'
    default:
      return undefined
  }
}

/**
 * Returns the effective value for an adaptive key. An explicit personality
 * preference always beats an inferred one; inferred values are only used to
 * fill gaps the user has not configured.
 */
export function getEffectivePreference(
  key: AdaptivePreferenceKey,
  explicitPrefs: PersonalityPreferences,
): string | undefined {
  if (!isValidAdaptiveKey(key)) {
    throw new Error(`Adaptive preference key is not allowed: ${key}`)
  }
  const explicit = explicitValueFor(key, explicitPrefs ?? {})
  if (explicit !== undefined && isValidAdaptiveValue(key, explicit)) return explicit
  const inferred = getAdaptiveProfile().preferences.find(p => p.key === key)
  return inferred?.value
}

/** Convenience lookup for one active preference. */
export function getPreference(key: AdaptivePreferenceKey): AdaptivePreference | undefined {
  return getAdaptiveProfile().preferences.find(p => p.key === key)
}
