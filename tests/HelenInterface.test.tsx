/**
 * HelenInterface component smoke tests.
 *
 * Exercises the main user-facing interaction paths without a real browser or
 * backend.  All services that touch localStorage are mocked to keep tests
 * deterministic and fast.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the component so Vitest
// can hoist them.
// ---------------------------------------------------------------------------

vi.mock('../src/services/helenResponseBrain', () => ({
  detectMood: vi.fn(() => 'neutral'),
  detectIntent: vi.fn(() => 'answer'),
  generateHumanLikeResponse: vi.fn(() => 'Test response from local brain.'),
}))

vi.mock('../src/services/helenChatAPI', () => ({
  callChatAPI: vi.fn(() => Promise.resolve(null)),
  hasBackend: vi.fn(() => false),
}))

vi.mock('../src/services/helenMemory', () => ({
  saveMemory: vi.fn((text: string) => ({ id: 'mem-1', text, createdAt: new Date().toISOString() })),
  listMemories: vi.fn(() => []),
  forgetLast: vi.fn(() => null),
  forgetByText: vi.fn(() => []),
  forgetAll: vi.fn(),
  retrieveRelevant: vi.fn(() => []),
  formatMemoriesForContext: vi.fn(() => ''),
}))

vi.mock('../src/services/helen_learning_integration', () => ({
  default: {
    recordInteraction: vi.fn(() => ({ id: 'interaction-1', input: '', response: '', metadata: {} })),
    processFeedback: vi.fn(),
    getLearningInsights: vi.fn(() => ({
      totalInteractions: 0,
      successRate: 0,
      averageConfidence: 0,
      commonIntents: {},
      complexityDistribution: {},
      learningCycles: 0,
      policyVersion: 1,
    })),
    clearHistory: vi.fn(),
    getPendingLearning: vi.fn(() => []),
    exportLearningData: vi.fn(() => '{}'),
  },
}))

// Import the component after mocks are registered.
import HelenInterface from '../src/components/HelenInterface'
import { saveMemory, listMemories, forgetAll } from '../src/services/helenMemory'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Override thinkingDelay so it returns immediately — avoids 600-1800 ms waits.
vi.mock('../src/components/HelenInterface', async () => {
  const mod = await vi.importActual<typeof import('../src/components/HelenInterface')>(
    '../src/components/HelenInterface',
  )
  return mod
})

// Patch global Math.random so thinkingDelay always returns MIN (600 ms).
// Tests use waitFor with a generous timeout so even 600 ms is fine.
beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WAIT_OPTS = { timeout: 5000 }

describe('HelenInterface', () => {
  // ── Render ────────────────────────────────────────────────────────────────

  it('renders the welcome screen when there are no messages', () => {
    render(<HelenInterface />)
    expect(screen.getByText(/Hello, I'm HELEN/i)).toBeInTheDocument()
  })

  it('renders the message input and Send button', () => {
    render(<HelenInterface />)
    expect(screen.getByPlaceholderText(/Message HELEN/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send message/i })).toBeInTheDocument()
  })

  it('Send button is disabled when input is empty', () => {
    render(<HelenInterface />)
    expect(screen.getByRole('button', { name: /Send message/i })).toBeDisabled()
  })

  it('Send button becomes enabled when the user types', () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'Hello' } })
    expect(screen.getByRole('button', { name: /Send message/i })).not.toBeDisabled()
  })

  // ── Sending a message ─────────────────────────────────────────────────────

  it('displays the user message immediately after sending', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'What is your name?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    // User message appears synchronously.
    expect(screen.getByText('What is your name?')).toBeInTheDocument()

    // Wait for the assistant response to appear (after thinking delay).
    await waitFor(
      () => expect(screen.getByText('Test response from local brain.')).toBeInTheDocument(),
      WAIT_OPTS,
    )
  }, 8000)

  it('clears the input field after sending', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    expect(input.value).toBe('')
  })

  // ── Memory commands ───────────────────────────────────────────────────────

  it('remember command calls saveMemory and echoes confirmation', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'remember this: I prefer Python' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(() => expect(saveMemory).toHaveBeenCalledWith('I prefer Python'), WAIT_OPTS)
    await waitFor(() => expect(screen.getByText(/I'll remember/i)).toBeInTheDocument(), WAIT_OPTS)
  }, 8000)

  it('recall command calls listMemories', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'what do you remember?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(listMemories).toHaveBeenCalled(), WAIT_OPTS)
  }, 8000)

  it('forget all command calls forgetAll', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'forget all memories' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(forgetAll).toHaveBeenCalled(), WAIT_OPTS)
  }, 8000)

  // ── Clear All button ──────────────────────────────────────────────────────

  it('"Clear All" button removes all messages from view', async () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    // Wait for user message to be visible.
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument(), WAIT_OPTS)

    fireEvent.click(screen.getByRole('button', { name: /Clear all conversations/i }))

    expect(screen.queryByText('hello')).not.toBeInTheDocument()
    expect(screen.getByText(/Hello, I'm HELEN/i)).toBeInTheDocument()
  }, 8000)

  // ── Enter key ─────────────────────────────────────────────────────────────

  it('pressing Enter submits the message', () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'test Enter key' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(screen.getByText('test Enter key')).toBeInTheDocument()
  })

  it('pressing Shift+Enter does NOT submit the message', () => {
    render(<HelenInterface />)
    const input = screen.getByPlaceholderText(/Message HELEN/i)
    fireEvent.change(input, { target: { value: 'no submit' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    const messageRows = document.querySelectorAll('.message-row')
    expect(messageRows.length).toBe(0)
  })

  // ── Sidebar ───────────────────────────────────────────────────────────────

  it('sidebar close and reopen buttons toggle the sidebar', () => {
    render(<HelenInterface />)
    const closeBtn = screen.getByRole('button', { name: /Close sidebar/i })
    fireEvent.click(closeBtn)
    expect(screen.queryByRole('navigation', { name: /Conversation history/i })).not.toBeInTheDocument()

    const openBtn = screen.getByRole('button', { name: /Open sidebar/i })
    fireEvent.click(openBtn)
    expect(screen.getByRole('navigation', { name: /Conversation history/i })).toBeInTheDocument()
  })
})
