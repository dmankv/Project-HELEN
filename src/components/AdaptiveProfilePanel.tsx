/**
 * AdaptiveProfilePanel
 *
 * "What Daemon Learned" — the user-facing view of the adaptive profile.
 *
 * Everything Daemon has inferred is shown here with its value, confidence,
 * source, and a plain-language explanation, and can be accepted, edited,
 * removed, reset, or exported. A global toggle stops all new inference.
 *
 * This is deliberately separate from Personality Preferences (explicit
 * settings you choose) and from durable memories (things you asked Daemon to
 * remember). Explicit settings always override anything shown here.
 */

import { useCallback, useState } from 'react'
import {
  ADAPTIVE_PREFERENCE_ALLOWED_VALUES,
  getAdaptiveProfile,
  explicitlyConfirmPreference,
  removePreference,
  resetAllInferredPreferences,
  setLearningEnabled,
  exportAdaptiveProfile,
} from '../services/daemonAdaptiveProfile'
import type { AdaptivePreferenceKey, AdaptiveProfile } from '../services/daemonAdaptiveProfile'

const KEY_LABELS: Record<AdaptivePreferenceKey, string> = {
  response_detail_tendency: 'Response detail tendency',
  directness_preference: 'Directness',
  preferred_problem_solving_strategy: 'Problem-solving approach',
  follow_up_question_tolerance: 'Follow-up questions',
  desired_structure: 'Answer structure',
  humor_preference: 'Humor',
  helpful_contexts: 'Most useful for',
}

export default function AdaptiveProfilePanel() {
  const [profile, setProfile] = useState<AdaptiveProfile>(() => getAdaptiveProfile())
  const [status, setStatus] = useState<string | null>(null)

  const refresh = useCallback((message: string | null) => {
    setProfile(getAdaptiveProfile())
    setStatus(message)
  }, [])

  function handleToggleLearning(enabled: boolean) {
    setLearningEnabled(enabled)
    refresh(enabled
      ? 'Learning is on. Daemon may infer preferences from your feedback.'
      : 'Learning is off. Nothing new will be inferred; what is here stays editable.')
  }

  function handleAccept(key: AdaptivePreferenceKey, value: string) {
    explicitlyConfirmPreference(key, value)
    refresh('Saved as a confirmed preference.')
  }

  function handleChange(key: AdaptivePreferenceKey, value: string) {
    explicitlyConfirmPreference(key, value)
    refresh('Updated. Your choice overrides what Daemon inferred.')
  }

  function handleRemove(key: AdaptivePreferenceKey) {
    removePreference(key)
    refresh('Removed, along with the feedback behind it.')
  }

  function handleReset() {
    if (!window.confirm(
      'Delete everything Daemon inferred about how you like to be helped? Preferences you confirmed yourself are kept.',
    )) return
    resetAllInferredPreferences()
    refresh('All learned preferences deleted.')
  }

  function handleExport() {
    const blob = new Blob([exportAdaptiveProfile()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'daemon-adaptive-profile.json'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <section className="adaptive-panel" aria-label="What Daemon learned">
      <h3 className="adaptive-title">What Daemon Learned</h3>

      <p className="adaptive-intro">
        These are patterns Daemon inferred from your thumbs-up/thumbs-down feedback.
        They are separate from the preferences you set above and from anything you
        asked Daemon to remember. Anything you set explicitly always wins.
      </p>

      <div className="pref-row pref-row--checkbox">
        <label className="pref-label" htmlFor="adaptive-learning-toggle">
          Let Daemon learn from my feedback
          <span className="pref-hint"> (turning this off stops all new inference)</span>
        </label>
        <input
          id="adaptive-learning-toggle"
          type="checkbox"
          className="pref-checkbox"
          checked={profile.learningEnabled}
          onChange={e => handleToggleLearning(e.target.checked)}
        />
      </div>

      {profile.preferences.length === 0 ? (
        <p className="adaptive-empty" role="note">
          Daemon hasn't inferred anything yet. It needs at least three consistent
          signals before it will suggest a preference.
        </p>
      ) : (
        <ul className="adaptive-list">
          {profile.preferences.map(pref => (
            <li key={pref.key} className="adaptive-item">
              <div className="adaptive-item-head">
                <span className="adaptive-item-key">{KEY_LABELS[pref.key]}</span>
                <span className="adaptive-item-value">{pref.value}</span>
                <span className="adaptive-item-meta">
                  {pref.source === 'explicit-user-confirmation' ? 'confirmed by you' : 'inferred'}
                  {' · '}
                  confidence {Math.round(pref.confidence * 100)}%
                  {' · '}
                  {pref.evidenceCount} signal{pref.evidenceCount === 1 ? '' : 's'}
                </span>
              </div>

              <p className="adaptive-item-explanation">{pref.explanation}</p>

              <div className="adaptive-item-actions">
                <label className="adaptive-edit-label" htmlFor={`adaptive-edit-${pref.key}`}>
                  Change to
                </label>
                <select
                  id={`adaptive-edit-${pref.key}`}
                  className="pref-select"
                  value={pref.value}
                  onChange={e => handleChange(pref.key, e.target.value)}
                >
                  {ADAPTIVE_PREFERENCE_ALLOWED_VALUES[pref.key].map(option => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
                {pref.source !== 'explicit-user-confirmation' && (
                  <button
                    type="button"
                    className="pref-btn"
                    onClick={() => handleAccept(pref.key, pref.value)}
                  >
                    Accept
                  </button>
                )}
                <button
                  type="button"
                  className="pref-btn pref-btn--danger"
                  onClick={() => handleRemove(pref.key)}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status && (
        <p className="adaptive-status" role="status">{status}</p>
      )}

      <div className="preferences-actions">
        <button type="button" className="pref-btn" onClick={handleExport}>
          Export learned data
        </button>
        <button type="button" className="pref-btn pref-btn--danger" onClick={handleReset}>
          Reset learned data
        </button>
      </div>

      <p className="adaptive-footer-note">
        Daemon only learns bounded communication preferences. It never stores
        passwords, keys, payment details, IDs, precise location, or sensitive
        medical, legal, political, or relationship information, and learning can
        never change its safety rules.
      </p>
    </section>
  )
}
