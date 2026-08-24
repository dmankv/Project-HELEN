/**
 * Daemon Personality Preferences Service
 *
 * Manages per-user communication preferences for Daemon.
 * Settings are stored locally in localStorage and optionally synced to
 * a Supabase table (user_personality_preferences) when the user is
 * authenticated. Local preferences are clearly labeled browser-only
 * until the user explicitly syncs them.
 *
 * Non-negotiable safety, factuality, crisis, refusal, authentication, and
 * RLS policies are NOT affected by any preference here.
 */

import { createClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** User-controlled response detail preference. */
export type DetailLevel = 'concise' | 'balanced' | 'detailed'

/** User-controlled warmth preference. */
export type WarmthLevel = 'reserved' | 'balanced' | 'warm'

/** User-controlled humor preference. */
export type HumorLevel = 'none' | 'light' | 'moderate'

/** User-controlled directness preference. */
export type DirectnessLevel = 'gentle' | 'balanced' | 'direct'

/**
 * Per-user personality preferences.
 * All fields are optional; absent/null fields default to the policy default.
 * Fields named *_opt_in are disabled by default and require explicit user action.
 */
export interface PersonalityPreferences {
  /** How much detail Daemon includes by default. */
  detail_level?: DetailLevel
  /** How direct Daemon should be. */
  directness?: DirectnessLevel
  /** How warm/expressive Daemon should be. */
  warmth?: WarmthLevel
  /** How much humor Daemon should use. */
  humor_level?: HumorLevel
  /** Whether Daemon may use very mild profanity in clearly casual contexts. */
  allow_mild_profanity?: boolean
  /** Whether Daemon should proactively ask follow-up questions. */
  follow_up_questions?: boolean
  /**
   * Opt-in custom greeting/sign-off text shown by Daemon.
   * Disabled by default. Must be user-supplied text only.
   * This is NOT romantic reciprocity from Daemon; it is a personal
   * customization scoped to the account owner's own experience.
   * Max 80 characters. Daemon will NOT claim this phrase as its own feeling.
   */
  custom_greeting?: string | null
  /** Whether Daemon may gently note patterns (stress, avoidance, etc.). */
  pattern_recognition?: boolean
}

export const PREFERENCES_DEFAULTS: Required<PersonalityPreferences> = {
  detail_level: 'balanced',
  directness: 'balanced',
  warmth: 'balanced',
  humor_level: 'light',
  allow_mild_profanity: false,
  follow_up_questions: true,
  custom_greeting: null,
  pattern_recognition: false,
}

export const CUSTOM_GREETING_MAX_LENGTH = 80

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_DETAIL: DetailLevel[] = ['concise', 'balanced', 'detailed']
const VALID_WARMTH: WarmthLevel[] = ['reserved', 'balanced', 'warm']
const VALID_HUMOR: HumorLevel[] = ['none', 'light', 'moderate']
const VALID_DIRECTNESS: DirectnessLevel[] = ['gentle', 'balanced', 'direct']

export function validatePreferences(raw: unknown): PersonalityPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: PersonalityPreferences = {}

  if (VALID_DETAIL.includes(r.detail_level as DetailLevel)) {
    out.detail_level = r.detail_level as DetailLevel
  }
  if (VALID_DIRECTNESS.includes(r.directness as DirectnessLevel)) {
    out.directness = r.directness as DirectnessLevel
  }
  if (VALID_WARMTH.includes(r.warmth as WarmthLevel)) {
    out.warmth = r.warmth as WarmthLevel
  }
  if (VALID_HUMOR.includes(r.humor_level as HumorLevel)) {
    out.humor_level = r.humor_level as HumorLevel
  }
  if (typeof r.allow_mild_profanity === 'boolean') {
    out.allow_mild_profanity = r.allow_mild_profanity
  }
  if (typeof r.follow_up_questions === 'boolean') {
    out.follow_up_questions = r.follow_up_questions
  }
  if (typeof r.pattern_recognition === 'boolean') {
    out.pattern_recognition = r.pattern_recognition
  }
  // custom_greeting: must be a non-empty string ≤ CUSTOM_GREETING_MAX_LENGTH, or null
  if (r.custom_greeting === null || r.custom_greeting === undefined) {
    out.custom_greeting = null
  } else if (typeof r.custom_greeting === 'string') {
    const trimmed = r.custom_greeting.trim().slice(0, CUSTOM_GREETING_MAX_LENGTH)
    out.custom_greeting = trimmed.length > 0 ? trimmed : null
  }
  return out
}

// ---------------------------------------------------------------------------
// Local storage
// ---------------------------------------------------------------------------

const LOCAL_STORAGE_KEY = 'daemon_personality_preferences'

export function loadLocalPreferences(): PersonalityPreferences {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return {}
    return validatePreferences(JSON.parse(raw))
  } catch {
    return {}
  }
}

export function saveLocalPreferences(prefs: PersonalityPreferences): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(validatePreferences(prefs)))
  } catch { /* quota exceeded — best effort */ }
}

export function clearLocalPreferences(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY)
  } catch { /* ignore */ }
}

export function exportLocalPreferences(): string {
  return JSON.stringify(loadLocalPreferences(), null, 2)
}

// ---------------------------------------------------------------------------
// Supabase helpers — only called when config + auth are present
// ---------------------------------------------------------------------------

function getSupabaseClient() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!url || !key) return null
  return createClient(url, key)
}

/**
 * Load personality preferences from Supabase for the authenticated user.
 * Returns null if Supabase is unavailable or the user is not authenticated.
 */
export async function loadCloudPreferences(userId: string): Promise<PersonalityPreferences | null> {
  const client = getSupabaseClient()
  if (!client) return null
  try {
    const { data, error } = await client
      .from('user_personality_preferences')
      .select('preferences')
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    return validatePreferences(data.preferences)
  } catch {
    return null
  }
}

/**
 * Save personality preferences to Supabase for the authenticated user.
 * Uses upsert; user_id comes from the authenticated session only.
 * Returns true on success.
 */
export async function saveCloudPreferences(
  userId: string,
  prefs: PersonalityPreferences,
): Promise<boolean> {
  const client = getSupabaseClient()
  if (!client) return false
  try {
    const validated = validatePreferences(prefs)
    const { error } = await client
      .from('user_personality_preferences')
      .upsert({ user_id: userId, preferences: validated }, { onConflict: 'user_id' })
    return !error
  } catch {
    return false
  }
}

/**
 * Delete personality preferences from Supabase for the authenticated user.
 * Returns true on success.
 */
export async function deleteCloudPreferences(userId: string): Promise<boolean> {
  const client = getSupabaseClient()
  if (!client) return false
  try {
    const { error } = await client
      .from('user_personality_preferences')
      .delete()
      .eq('user_id', userId)
    return !error
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Merged preferences (local + cloud)
// ---------------------------------------------------------------------------

/**
 * Returns effective preferences by merging local and cloud (if available).
 * Cloud preferences take precedence when available.
 */
export function mergePreferences(
  local: PersonalityPreferences,
  cloud: PersonalityPreferences | null,
): PersonalityPreferences {
  if (!cloud) return local
  // Cloud wins on any field that is explicitly set
  const merged: PersonalityPreferences = { ...local }
  const keys = Object.keys(PREFERENCES_DEFAULTS) as Array<keyof PersonalityPreferences>
  for (const k of keys) {
    if (cloud[k] !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (merged as any)[k] = cloud[k]
    }
  }
  return merged
}

/**
 * Returns preferences with all defaults filled in.
 */
export function resolvePreferences(prefs: PersonalityPreferences): Required<PersonalityPreferences> {
  return { ...PREFERENCES_DEFAULTS, ...validatePreferences(prefs) }
}

// ---------------------------------------------------------------------------
// Bridge to daemonResponseBrain PersonalitySettings
// ---------------------------------------------------------------------------

import type { PersonalitySettings } from './daemonResponseBrain'

/**
 * Converts stored PersonalityPreferences (snake_case, Supabase-compatible)
 * to the in-memory PersonalitySettings type used by daemonResponseBrain.
 */
export function toPersonalitySettings(prefs: PersonalityPreferences): PersonalitySettings {
  const r = resolvePreferences(prefs)
  return {
    detailLevel: r.detail_level,
    warmth: r.warmth,
    humorLevel: r.humor_level,
    directness: r.directness,
    allowMildProfanity: r.allow_mild_profanity,
    followUpQuestions: r.follow_up_questions,
    customGreeting: r.custom_greeting ?? null,
    patternRecognition: r.pattern_recognition,
  }
}
