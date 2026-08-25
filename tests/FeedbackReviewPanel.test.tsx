import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import FeedbackReviewPanel from '../src/components/FeedbackReviewPanel'

const pendingInteraction = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  input: 'How should I organize this project?',
  response: 'Start by separating the work into focused milestones.',
  metadata: {
    intent: 'suggest',
    confidence: 0.8,
    ambiguity: 0.2,
    memoryUsed: 0,
    planComplexity: 'moderate' as const,
    timestamp: new Date('2026-08-25T00:00:00.000Z'),
  },
}

describe('FeedbackReviewPanel', () => {
  it('submits a rating and optional note for a pending response', () => {
    const onFeedback = vi.fn()
    render(
      <FeedbackReviewPanel
        pendingInteractions={[pendingInteraction]}
        exportStatus="idle"
        onExport={vi.fn()}
        onFeedback={onFeedback}
      />,
    )

    fireEvent.change(screen.getByLabelText(/Optional note/i), {
      target: { value: 'This was clear and actionable.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Mark response 1 as helpful/i }))

    expect(onFeedback).toHaveBeenCalledWith(
      pendingInteraction.id,
      'helpful',
      'This was clear and actionable.',
    )
  })

  it('starts a learning-data export and reports export status', () => {
    const onExport = vi.fn()
    render(
      <FeedbackReviewPanel
        pendingInteractions={[]}
        exportStatus="exported"
        onExport={onExport}
        onFeedback={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Export learning data/i }))

    expect(onExport).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Learning-data download started/i)).toBeInTheDocument()
    expect(screen.getByText(/No responses are waiting for feedback/i)).toBeInTheDocument()
  })
})
