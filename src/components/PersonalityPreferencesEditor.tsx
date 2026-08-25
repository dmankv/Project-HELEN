/**
 * PersonalityPreferencesEditor
 *
 * Private, authenticated UI for editing per-user Daemon communication
 * preferences. Accessible from the sidebar when a user is signed in.
 *
 * Settings affect tone and phrasing only. They cannot override safety,
 * factuality, crisis policy, refusal behavior, or relationship boundaries.
 *
 * When Supabase is unavailable or the user is not signed in, preferences
 * are stored in localStorage only, clearly labeled as browser-local.
 * The user must explicitly confirm before preferences are synced to the cloud.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  loadLocalPreferences,
  saveLocalPreferences,
  clearLocalPreferences,
  exportLocalPreferences,
  loadCloudPreferences,
  saveCloudPreferences,
  deleteCloudPreferences,
  resolvePreferences,
  PREFERENCES_DEFAULTS,
  CUSTOM_GREETING_MAX_LENGTH,
} from '../services/daemonPersonalityPreferences'
import type { PersonalityPreferences } from '../services/daemonPersonalityPreferences'
import AdaptiveProfilePanel from './AdaptiveProfilePanel'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PersonalityPreferencesEditorProps {
  /** The authenticated user's ID. Null when not signed in. */
  userId?: string | null
  /** Called when the editor should be closed. */
  onClose: () => void
  /** Called after preferences are saved so the parent can reload them. */
  onSaved?: (prefs: PersonalityPreferences) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PersonalityPreferencesEditor({
  userId,
  onClose,
  onSaved,
}: PersonalityPreferencesEditorProps) {
  const isAuthenticated = Boolean(userId)

  const [prefs, setPrefs] = useState<PersonalityPreferences>(() => loadLocalPreferences())
  const [cloudLoaded, setCloudLoaded] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [greetingError, setGreetingError] = useState<string | null>(null)

  // Load cloud preferences on mount when authenticated
  useEffect(() => {
    if (!isAuthenticated || !userId) return
    let mounted = true
    loadCloudPreferences(userId).then(cloud => {
      if (!mounted || !cloud) return
      setPrefs(cloud)
      setCloudLoaded(true)
    })
    return () => { mounted = false }
  }, [userId, isAuthenticated])

  const resolved = resolvePreferences(prefs)

  const set = useCallback(<K extends keyof PersonalityPreferences>(
    key: K,
    value: PersonalityPreferences[K],
  ) => {
    setPrefs(prev => ({ ...prev, [key]: value }))
    setMessage(null)
  }, [])

  function validateGreeting(val: string): boolean {
    if (val.length > CUSTOM_GREETING_MAX_LENGTH) {
      setGreetingError(`Max ${CUSTOM_GREETING_MAX_LENGTH} characters`)
      return false
    }
    setGreetingError(null)
    return true
  }

  async function handleSave() {
    if (greetingError) return
    setIsSaving(true)
    setMessage(null)
    try {
      const validated = resolvePreferences(prefs)
      saveLocalPreferences(prefs)
      if (isAuthenticated && userId) {
        const ok = await saveCloudPreferences(userId, prefs)
        if (ok) {
          setMessage({ text: 'Saved to your account.', ok: true })
        } else {
          setMessage({ text: 'Saved locally. Cloud sync failed — check your connection.', ok: false })
        }
      } else {
        setMessage({ text: 'Saved to this browser. Sign in to sync across devices.', ok: true })
      }
      onSaved?.(validated)
    } finally {
      setIsSaving(false)
    }
  }

  function handleReset() {
    setPrefs(PREFERENCES_DEFAULTS)
    setGreetingError(null)
    setMessage(null)
  }

  async function handleDelete() {
    if (!window.confirm(
      'Delete all your Daemon preferences? This removes them from this browser' +
      (isAuthenticated ? ' and from your account.' : '.'),
    )) return
    setIsDeleting(true)
    setMessage(null)
    try {
      clearLocalPreferences()
      if (isAuthenticated && userId) {
        await deleteCloudPreferences(userId)
      }
      setPrefs(PREFERENCES_DEFAULTS)
      setMessage({ text: 'Preferences deleted. Defaults restored.', ok: true })
      onSaved?.(PREFERENCES_DEFAULTS)
    } finally {
      setIsDeleting(false)
    }
  }

  function handleExport() {
    const data = exportLocalPreferences()
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'daemon-preferences.json'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div
      className="preferences-editor"
      role="dialog"
      aria-modal="true"
      aria-label="Daemon personality preferences"
    >
      <div className="preferences-header">
        <h2 className="preferences-title">Personality Preferences</h2>
        <button
          type="button"
          className="preferences-close"
          onClick={onClose}
          aria-label="Close preferences"
        >
          ✕
        </button>
      </div>

      {!isAuthenticated && (
        <p className="preferences-notice" role="note">
          <strong>Browser-local mode:</strong> These preferences are stored only in
          this browser until you sign in. Sign in to sync them to your account.
        </p>
      )}

      {isAuthenticated && cloudLoaded && (
        <p className="preferences-notice preferences-notice--synced" role="note">
          Loaded from your account.
        </p>
      )}

      <form
        onSubmit={e => { e.preventDefault(); void handleSave() }}
        className="preferences-form"
        aria-label="Daemon preferences form"
        noValidate
      >
        {/* Response detail */}
        <div className="pref-row">
          <label htmlFor="pref-detail" className="pref-label">
            Response detail
          </label>
          <select
            id="pref-detail"
            className="pref-select"
            value={resolved.detail_level}
            onChange={e => set('detail_level', e.target.value as PersonalityPreferences['detail_level'])}
          >
            <option value="concise">Concise</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </div>

        {/* Directness */}
        <div className="pref-row">
          <label htmlFor="pref-directness" className="pref-label">
            Directness
          </label>
          <select
            id="pref-directness"
            className="pref-select"
            value={resolved.directness}
            onChange={e => set('directness', e.target.value as PersonalityPreferences['directness'])}
          >
            <option value="gentle">Gentle</option>
            <option value="balanced">Balanced</option>
            <option value="direct">Direct</option>
          </select>
        </div>

        {/* Warmth */}
        <div className="pref-row">
          <label htmlFor="pref-warmth" className="pref-label">
            Warmth
          </label>
          <select
            id="pref-warmth"
            className="pref-select"
            value={resolved.warmth}
            onChange={e => set('warmth', e.target.value as PersonalityPreferences['warmth'])}
          >
            <option value="reserved">Reserved</option>
            <option value="balanced">Balanced</option>
            <option value="warm">Warm</option>
          </select>
        </div>

        {/* Humor */}
        <div className="pref-row">
          <label htmlFor="pref-humor" className="pref-label">
            Humor
          </label>
          <select
            id="pref-humor"
            className="pref-select"
            value={resolved.humor_level}
            onChange={e => set('humor_level', e.target.value as PersonalityPreferences['humor_level'])}
          >
            <option value="none">None</option>
            <option value="light">Light</option>
            <option value="moderate">Moderate</option>
          </select>
        </div>

        {/* Mild profanity */}
        <div className="pref-row pref-row--checkbox">
          <label className="pref-label" htmlFor="pref-profanity">
            Allow mild profanity
            <span className="pref-hint"> (only in clearly casual contexts)</span>
          </label>
          <input
            id="pref-profanity"
            type="checkbox"
            className="pref-checkbox"
            checked={resolved.allow_mild_profanity}
            onChange={e => set('allow_mild_profanity', e.target.checked)}
          />
        </div>

        {/* Follow-up questions */}
        <div className="pref-row pref-row--checkbox">
          <label className="pref-label" htmlFor="pref-followup">
            Follow-up questions
            <span className="pref-hint"> (Daemon may ask clarifying questions)</span>
          </label>
          <input
            id="pref-followup"
            type="checkbox"
            className="pref-checkbox"
            checked={resolved.follow_up_questions}
            onChange={e => set('follow_up_questions', e.target.checked)}
          />
        </div>

        {/* Pattern recognition */}
        <div className="pref-row pref-row--checkbox">
          <label className="pref-label" htmlFor="pref-patterns">
            Pattern recognition
            <span className="pref-hint"> (Daemon may gently note patterns like stress or avoidance)</span>
          </label>
          <input
            id="pref-patterns"
            type="checkbox"
            className="pref-checkbox"
            checked={resolved.pattern_recognition}
            onChange={e => set('pattern_recognition', e.target.checked)}
          />
        </div>

        {/* Custom greeting — explicit opt-in */}
        <div className="pref-row pref-row--full">
          <label htmlFor="pref-greeting" className="pref-label">
            Custom greeting / sign-off
            <span className="pref-hint">
              {' '}(optional; your personalised phrase — not a claim of Daemon's feelings)
            </span>
          </label>
          <input
            id="pref-greeting"
            type="text"
            className={`pref-text${greetingError ? ' pref-text--error' : ''}`}
            value={resolved.custom_greeting ?? ''}
            placeholder="Leave blank to disable"
            maxLength={CUSTOM_GREETING_MAX_LENGTH}
            onChange={e => {
              const val = e.target.value
              validateGreeting(val)
              set('custom_greeting', val.trim().length > 0 ? val : null)
            }}
            aria-describedby={greetingError ? 'pref-greeting-error' : undefined}
          />
          {greetingError && (
            <p id="pref-greeting-error" className="pref-error" role="alert">
              {greetingError}
            </p>
          )}
          <p className="pref-help">
            This phrase will appear as a sign-off on greetings. It is a personal customisation
            scoped to your account. Daemon will not claim it as its own romantic feeling.
            Max {CUSTOM_GREETING_MAX_LENGTH} characters.
          </p>
        </div>

        {message && (
          <p
            className={`preferences-message${message.ok ? '' : ' preferences-message--error'}`}
            role={message.ok ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        )}

        <div className="preferences-actions">
          <button
            type="submit"
            className="pref-btn pref-btn--primary"
            disabled={isSaving || Boolean(greetingError)}
          >
            {isSaving ? 'Saving…' : 'Save preferences'}
          </button>
          <button
            type="button"
            className="pref-btn"
            onClick={handleReset}
            disabled={isSaving || isDeleting}
          >
            Reset to defaults
          </button>
          <button
            type="button"
            className="pref-btn"
            onClick={handleExport}
            disabled={isSaving || isDeleting}
          >
            Export
          </button>
          <button
            type="button"
            className="pref-btn pref-btn--danger"
            onClick={() => void handleDelete()}
            disabled={isSaving || isDeleting}
          >
            {isDeleting ? 'Deleting…' : 'Delete preferences'}
          </button>
        </div>
      </form>

      <AdaptiveProfilePanel />

      <p className="preferences-footer-note">
        These preferences affect tone and phrasing only. Safety, factuality, and
        crisis handling are not affected by any setting here. Preferences are separate
        from durable memories (use "forget" commands to manage memories) and from
        what Daemon has learned from your feedback (shown above).
      </p>
    </div>
  )
}
