import { useState } from 'react'
import type { InteractionRecord } from '../services/daemon_learning_integration'

export type FeedbackRating = 'helpful' | 'neutral' | 'unhelpful'

interface FeedbackReviewPanelProps {
  pendingInteractions: InteractionRecord[]
  exportStatus: 'idle' | 'exported' | 'failed'
  onExport: () => void
  onFeedback: (interactionId: string, rating: FeedbackRating, comment?: string) => void
}

export default function FeedbackReviewPanel({
  pendingInteractions,
  exportStatus,
  onExport,
  onFeedback,
}: FeedbackReviewPanelProps) {
  const [comments, setComments] = useState<Record<string, string>>({})

  const submitFeedback = (interaction: InteractionRecord, rating: FeedbackRating) => {
    const comment = comments[interaction.id]?.trim()
    onFeedback(interaction.id, rating, comment || undefined)
    setComments(current => {
      const next = { ...current }
      delete next[interaction.id]
      return next
    })
  }

  return (
    <section className="feedback-review-panel" aria-label="Feedback and data">
      <div className="data-panel-heading">
        <div>
          <h2>Review responses</h2>
          <p>Rate locally stored responses to improve future local suggestions.</p>
        </div>
        <button type="button" className="data-export-btn" onClick={onExport}>
          Export learning data
        </button>
      </div>
      <p className="data-export-status" aria-live="polite">
        {exportStatus === 'exported'
          ? 'Learning-data download started.'
          : exportStatus === 'failed'
            ? 'Unable to start the learning-data download.'
            : ''}
      </p>
      {pendingInteractions.length === 0 ? (
        <p className="data-panel-empty">No responses are waiting for feedback.</p>
      ) : (
        <ul className="feedback-review-list">
          {pendingInteractions.map((interaction, index) => {
            const commentId = `feedback-comment-${interaction.id}`
            return (
              <li key={interaction.id} className="feedback-review-item">
                <p className="feedback-review-meta">
                  Response {index + 1} · {interaction.metadata.intent}
                </p>
                <p className="feedback-review-text"><strong>You:</strong> {interaction.input}</p>
                <p className="feedback-review-text"><strong>Daemon:</strong> {interaction.response}</p>
                <label className="feedback-comment-label" htmlFor={commentId}>
                  Optional note
                </label>
                <textarea
                  id={commentId}
                  className="feedback-comment-input"
                  value={comments[interaction.id] ?? ''}
                  onChange={event => setComments(current => ({
                    ...current,
                    [interaction.id]: event.target.value,
                  }))}
                  rows={2}
                />
                <div className="feedback-review-actions">
                  <button
                    type="button"
                    onClick={() => submitFeedback(interaction, 'helpful')}
                    aria-label={`Mark response ${index + 1} as helpful`}
                  >
                    Helpful
                  </button>
                  <button
                    type="button"
                    onClick={() => submitFeedback(interaction, 'neutral')}
                    aria-label={`Mark response ${index + 1} as neutral`}
                  >
                    Neutral
                  </button>
                  <button
                    type="button"
                    onClick={() => submitFeedback(interaction, 'unhelpful')}
                    aria-label={`Mark response ${index + 1} as not helpful`}
                  >
                    Not helpful
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
