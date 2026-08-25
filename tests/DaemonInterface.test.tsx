/**
 * DaemonInterface component smoke tests.
 *
 * Exercises the main user-facing interaction paths without a real browser or
 * backend.  All services that touch localStorage are mocked to keep tests
 * deterministic and fast.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — declared before any import of the component so Vitest
// can hoist them.
// ---------------------------------------------------------------------------

vi.mock('../src/services/daemonResponseBrain', () => ({
  detectMood: vi.fn(() => 'neutral'),
  detectIntent: vi.fn(() => 'answer'),
  generateHumanLikeResponse: vi.fn(() => 'Test response from local brain.'),
}))

vi.mock('../src/services/daemonChatAPI', () => ({
  callChatAPI: vi.fn(() => Promise.resolve(null)),
  hasBackend: vi.fn(() => false),
  isAPIFailure: vi.fn((result: unknown) => result !== null && typeof result === 'object' && 'reason' in (result as object)),
}))

vi.mock('../src/services/supabaseEdgeChat', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/supabaseEdgeChat')>()
  return {
    ...actual,
    callEdgeFunction: vi.fn(() => Promise.resolve(actual.createEdgeChatFailure('provider', { status: 503, safeCode: 'PROVIDER_UNAVAILABLE' }))),
    hasEdgeFunction: vi.fn(() => false),
  }
})

vi.mock('../src/services/daemonMemory', () => ({
  saveMemory: vi.fn((text: string) => ({ id: 'mem-1', text, createdAt: new Date().toISOString() })),
  listMemories: vi.fn(() => []),
  forgetLast: vi.fn(() => null),
  forgetByText: vi.fn(() => []),
  forgetAll: vi.fn(),
  retrieveRelevant: vi.fn(() => []),
  formatMemoriesForContext: vi.fn(() => ''),
}))

vi.mock('../src/services/daemon_learning_integration', () => ({
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

vi.mock('../src/services/supabasePersistence', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/supabasePersistence')>()
  return {
    ...actual,
    isPersistenceConfigured: vi.fn(() => false),
    upsertConversation: vi.fn(async () => null),
    insertMessage: vi.fn(async () => null),
    insertCloudMemory: vi.fn(async () => null),
    deleteLastCloudMemory: vi.fn(async () => false),
    deleteCloudMemoriesByText: vi.fn(async () => false),
    deleteAllCloudMemories: vi.fn(async () => false),
    updateLearningFeedback: vi.fn(async () => false),
    insertLearningInteraction: vi.fn(async () => null),
    migrateLocalMemoriesToCloud: vi.fn(async () => undefined),
    hydrateFromCloud: vi.fn(async () => null),
    deleteConversation: vi.fn(async () => true),
    deleteMessagesForConversation: vi.fn(async () => true),
    listConversations: vi.fn(async () => []),
    deleteCloudConversation: vi.fn(async () => true),
    deleteAllCloudConversations: vi.fn(async () => true),
  }
})

// Import the component after mocks are registered.
import DaemonInterface from '../src/components/DaemonInterface'
import { saveMemory, listMemories, forgetAll } from '../src/services/daemonMemory'
import { callChatAPI, hasBackend, isAPIFailure } from '../src/services/daemonChatAPI'
import { callEdgeFunction, hasEdgeFunction, createEdgeChatFailure } from '../src/services/supabaseEdgeChat'
import {
  isPersistenceConfigured,
  deleteCloudConversation,
  deleteAllCloudConversations,
  listConversations,
} from '../src/services/supabasePersistence'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn(() => Promise.resolve()),
    },
  })
  vi.mocked(isPersistenceConfigured).mockReturnValue(false)
  vi.mocked(deleteCloudConversation).mockResolvedValue(true)
  vi.mocked(deleteAllCloudConversations).mockResolvedValue(true)
  vi.mocked(listConversations).mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WAIT_OPTS = { timeout: 5000 }

describe('DaemonInterface', () => {
  // ── Render ────────────────────────────────────────────────────────────────

  it('renders the welcome screen when there are no messages', () => {
    render(<DaemonInterface />)
    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
  })

  it('renders the message input and Send button', () => {
    render(<DaemonInterface />)
    expect(screen.getByPlaceholderText(/Message Daemon/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Send message/i })).toBeInTheDocument()
  })

  it('Send button is disabled when input is empty', () => {
    render(<DaemonInterface />)
    expect(screen.getByRole('button', { name: /Send message/i })).toBeDisabled()
  })

  it('Send button becomes enabled when the user types', () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Hello' } })
    expect(screen.getByRole('button', { name: /Send message/i })).not.toBeDisabled()
  })

  it('shows admin role status for authenticated admin users', () => {
    render(<DaemonInterface currentUser={{ email: 'admin@example.com', role: 'admin' }} onLoginClick={vi.fn()} />)
    expect(screen.getByLabelText(/account role admin/i)).toHaveTextContent('Role: Admin')
  })

  it('shows user role status for authenticated non-admin users', () => {
    render(<DaemonInterface currentUser={{ email: 'user@example.com', role: 'user' }} onLoginClick={vi.fn()} />)
    expect(screen.getByLabelText(/account role user/i)).toHaveTextContent('Role: User')
  })

  it('shows unknown role status when role is unavailable', () => {
    render(<DaemonInterface currentUser={{ email: 'unknown@example.com', role: null }} onLoginClick={vi.fn()} />)
    expect(screen.getByLabelText(/account role unknown/i)).toHaveTextContent('Role: Unknown')
  })

  it('renders the admin diagnostics panel only for admin users', () => {
    render(<DaemonInterface currentUser={{ email: 'admin@example.com', role: 'admin' }} onLoginClick={vi.fn()} />)
    expect(screen.getByText(/Admin cloud diagnostics/i)).toBeInTheDocument()
  })

  it('does not render the admin diagnostics panel for non-admin users', () => {
    render(<DaemonInterface currentUser={{ email: 'user@example.com', role: 'user' }} onLoginClick={vi.fn()} />)
    expect(screen.queryByText(/Admin cloud diagnostics/i)).not.toBeInTheDocument()
  })

  it('does not render the admin diagnostics panel for signed-out visitors', () => {
    render(<DaemonInterface />)
    expect(screen.queryByText(/Admin cloud diagnostics/i)).not.toBeInTheDocument()
  })

  it('copies redacted safe diagnostics for admins', async () => {
    vi.mocked(hasBackend).mockReturnValue(false)
    vi.mocked(hasEdgeFunction).mockReturnValue(true)
    vi.mocked(callEdgeFunction).mockResolvedValue(createEdgeChatFailure('provider', { status: 503, safeCode: 'FUNCTION_CONFIG_ERROR' }))

    render(<DaemonInterface currentUser={{ email: 'admin@example.com', role: 'admin' }} onLoginClick={vi.fn()} />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Secret prompt text' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(() => expect(screen.getByText(/Cloud chat is temporarily unavailable/i)).toBeInTheDocument(), WAIT_OPTS)

    fireEvent.click(screen.getByRole('button', { name: /Copy safe diagnostics/i }))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled(), WAIT_OPTS)
    const payload = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0]
    expect(payload).toContain('frontend_config=present')
    expect(payload).toContain('last_attempt_category=provider')
    expect(payload).toContain('last_attempt_code=FUNCTION_CONFIG_ERROR')
    expect(payload).not.toContain('admin@example.com')
    expect(payload).not.toContain('Secret prompt text')
    expect(payload).not.toMatch(/access[_-]?token/i)
  })

  // ── Sending a message ─────────────────────────────────────────────────────

  it('displays the user message immediately after sending', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
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
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    expect(input.value).toBe('')
  })

  it('falls back to local mode when backend is configured but unavailable', async () => {
    vi.mocked(hasBackend).mockReturnValue(true)
    vi.mocked(callChatAPI).mockResolvedValue(null)

    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Please help' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(
      () => expect(screen.getByText(/I used local mode for this response/i)).toBeInTheDocument(),
      WAIT_OPTS,
    )
    await waitFor(
      () => expect(screen.getByText('Test response from local brain.')).toBeInTheDocument(),
      WAIT_OPTS,
    )
  }, 10000)

  it('shows the not-configured fallback message when only local mode is available', async () => {
    vi.mocked(hasBackend).mockReturnValue(false)
    vi.mocked(hasEdgeFunction).mockReturnValue(false)

    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Use local mode' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(
      () => expect(screen.getByText(/Cloud chat is not configured in this build/i)).toBeInTheDocument(),
      WAIT_OPTS,
    )
  })

  it('shows the sign-in fallback message instead of an outage for signed-out users', async () => {
    vi.mocked(hasBackend).mockReturnValue(false)
    vi.mocked(hasEdgeFunction).mockReturnValue(true)

    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Use local mode' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(
      () => expect(screen.getByText(/Cloud chat is available after you sign in/i)).toBeInTheDocument(),
      WAIT_OPTS,
    )
  })

  it('shows the rate-limit fallback message for rate-limited cloud responses', async () => {
    vi.mocked(hasBackend).mockReturnValue(false)
    vi.mocked(hasEdgeFunction).mockReturnValue(true)
    vi.mocked(callEdgeFunction).mockResolvedValue(createEdgeChatFailure('rate-limited', { status: 429, safeCode: 'RATE_LIMITED' }))

    render(<DaemonInterface currentUser={{ email: 'admin@example.com', role: 'admin' }} onLoginClick={vi.fn()} />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Rate limited?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(
      () => expect(screen.getByText(/Cloud chat is temporarily rate-limited/i)).toBeInTheDocument(),
      WAIT_OPTS,
    )
  })

  // ── Memory commands ───────────────────────────────────────────────────────

  it('remember command calls saveMemory and echoes confirmation', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'remember this: I prefer Python' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    await waitFor(() => expect(saveMemory).toHaveBeenCalledWith('I prefer Python'), WAIT_OPTS)
    await waitFor(() => expect(screen.getByText(/I'll remember/i)).toBeInTheDocument(), WAIT_OPTS)
  }, 8000)

  it('recall command calls listMemories', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'what do you remember?' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(listMemories).toHaveBeenCalled(), WAIT_OPTS)
  }, 8000)

  it('forget all command calls forgetAll', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'forget all memories' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(forgetAll).toHaveBeenCalled(), WAIT_OPTS)
  }, 8000)

  // ── Clear All button ──────────────────────────────────────────────────────

  it('"Clear all chats" button in sidebar removes all messages from view', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    // Wait for user message to be visible.
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument(), WAIT_OPTS)

    fireEvent.click(screen.getByRole('button', { name: /Clear all chats/i }))

    expect(screen.queryByText('hello')).not.toBeInTheDocument()
    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
  }, 8000)

  it('Clear all chats remains safe when localStorage removeItem fails', () => {
    const originalRemoveItem = localStorage.removeItem
    localStorage.removeItem = vi.fn(() => { throw new Error('blocked') })
    render(<DaemonInterface />)
    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: /Clear all chats/i }))
    }).not.toThrow()
    localStorage.removeItem = originalRemoveItem
  })

  // ── Sidebar layout ────────────────────────────────────────────────────────

  it('sidebar has New chat above the clear action buttons', () => {
    render(<DaemonInterface />)
    const sidebar = screen.getByRole('navigation', { name: /Conversation history/i })
    const buttons = Array.from(sidebar.querySelectorAll('button'))
    const newChatIdx = buttons.findIndex(b => /\+ New chat/i.test(b.textContent ?? ''))
    const clearCurrentIdx = buttons.findIndex(b => /Clear current chat/i.test(b.textContent ?? ''))
    const clearAllIdx = buttons.findIndex(b => /Clear all chats/i.test(b.textContent ?? ''))
    expect(newChatIdx).toBeGreaterThanOrEqual(0)
    expect(clearCurrentIdx).toBeGreaterThan(newChatIdx)
    expect(clearAllIdx).toBeGreaterThan(newChatIdx)
  })

  it('header does not contain a Clear All button', () => {
    render(<DaemonInterface />)
    const header = document.querySelector('.daemon-header')
    expect(header).not.toBeNull()
    const clearAllInHeader = Array.from(header!.querySelectorAll('button')).find(b =>
      /clear/i.test(b.textContent ?? '') || /clear/i.test(b.getAttribute('aria-label') ?? '')
    )
    expect(clearAllInHeader).toBeUndefined()
  })

  // ── Clear current chat ────────────────────────────────────────────────────

  it('"Clear current chat" is disabled when no active conversation exists', () => {
    render(<DaemonInterface />)
    const btn = screen.getByRole('button', { name: /No active chat to clear/i })
    expect(btn).toBeDisabled()
  })

  it('"Clear current chat" removes only the active conversation, leaves others intact', async () => {
    // Pre-populate two conversations in localStorage
    const conv1 = {
      id: 'conv-1',
      title: 'First chat',
      messages: [{ id: 'msg-1', role: 'user', content: 'First message', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    const conv2 = {
      id: 'conv-2',
      title: 'Second chat',
      messages: [{ id: 'msg-2', role: 'user', content: 'Second message', timestamp: '2026-08-25T02:00:00Z' }],
      createdAt: '2026-08-25T02:00:00Z',
    }
    // Most recent first
    localStorage.setItem('daemon_conversations', JSON.stringify([conv2, conv1]))
    localStorage.setItem('daemon_messages', JSON.stringify(conv2.messages))

    render(<DaemonInterface />)

    // Select conv1 (the first conversation entry, which is the second item in list)
    const conv1Btn = screen.getByRole('button', { name: /First chat/i })
    fireEvent.click(conv1Btn)

    // Active is now conv1 — clear current chat should remove only conv1
    fireEvent.click(screen.getByRole('button', { name: /Clear current chat/i }))

    // conv2 should still be present in sidebar
    expect(screen.getByRole('button', { name: /Second chat/i })).toBeInTheDocument()
    // conv1 should be gone
    expect(screen.queryByRole('button', { name: /First chat/i })).not.toBeInTheDocument()
    // The view should now show conv2's messages
    expect(screen.getByText('Second message')).toBeInTheDocument()
  })

  it('clear current chat promotes the remaining conversation with its latest persisted messages and keeps follow-ups in that chat', async () => {
    const newerConv = {
      id: 'conv-newer',
      title: 'Newer chat',
      messages: [{ id: 'm-newer', role: 'user', content: 'Newer message', timestamp: '2026-08-25T02:00:00Z' }],
      createdAt: '2026-08-25T02:00:00Z',
    }
    const olderConv = {
      id: 'conv-older',
      title: 'Older chat',
      messages: [{ id: 'm-older', role: 'user', content: 'Older message', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([newerConv, olderConv]))
    localStorage.setItem('daemon_active_conv_id', newerConv.id)
    localStorage.setItem('daemon_messages', JSON.stringify(newerConv.messages))

    render(<DaemonInterface />)

    fireEvent.click(screen.getByRole('button', { name: /Older chat/i }))

    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'reply to older' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('reply to older')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    fireEvent.click(screen.getByRole('button', { name: /Newer chat/i }))
    expect(screen.getByText('Newer message')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Clear current chat/i }))

    expect(screen.queryByRole('button', { name: /Newer chat/i })).not.toBeInTheDocument()
    expect(screen.getByText('Older message')).toBeInTheDocument()
    expect(screen.getByText('reply to older')).toBeInTheDocument()

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    expect(storedConvs).toHaveLength(1)
    expect(storedConvs[0].id).toBe('conv-older')
    expect(storedConvs[0].messages.some(message => message.content === 'reply to older')).toBe(true)

    fireEvent.change(input, { target: { value: 'follow-up in older' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('follow-up in older')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    const afterFollowUp = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    expect(afterFollowUp).toHaveLength(1)
    expect(afterFollowUp[0].id).toBe('conv-older')
    expect(afterFollowUp[0].messages.some(message => message.content === 'follow-up in older')).toBe(true)
    expect(localStorage.getItem('daemon_active_conv_id')).toBe('conv-older')
  }, 15000)

  it('"Clear current chat" with the sole conversation shows blank pane', async () => {
    const conv = {
      id: 'conv-only',
      title: 'Only chat',
      messages: [{ id: 'msg-only', role: 'user', content: 'Only message', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([conv]))
    localStorage.setItem('daemon_messages', JSON.stringify(conv.messages))

    render(<DaemonInterface />)

    // Select the sole conversation
    fireEvent.click(screen.getByRole('button', { name: /Only chat/i }))

    fireEvent.click(screen.getByRole('button', { name: /Clear current chat/i }))

    // Welcome pane should be visible
    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
    // The button should now be disabled
    const btn = screen.getByRole('button', { name: /No active chat to clear/i })
    expect(btn).toBeDisabled()
  })

  it('"Clear all chats" preserves no conversation data but leaves a blank pane', async () => {
    const conv = {
      id: 'conv-a',
      title: 'Chat A',
      messages: [{ id: 'msg-a', role: 'user', content: 'Message A', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([conv]))
    localStorage.setItem('daemon_messages', JSON.stringify(conv.messages))

    render(<DaemonInterface />)

    fireEvent.click(screen.getByRole('button', { name: /Clear all chats/i }))

    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Chat A/i })).not.toBeInTheDocument()
  })

  it('active-chat behavior preserved after clearing: new chat only on explicit + New chat click', async () => {
    render(<DaemonInterface />)

    // Send first message — creates active conv
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'Hello first' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('Hello first')).toBeInTheDocument(), WAIT_OPTS)

    // Wait for the conversation to be listed in the sidebar
    await waitFor(() => expect(document.querySelectorAll('.conversation-item').length).toBeGreaterThanOrEqual(1), WAIT_OPTS)

    // Click New chat
    fireEvent.click(screen.getByRole('button', { name: /\+ New chat/i }))

    // Send second message — should create a second distinct conversation
    fireEvent.change(input, { target: { value: 'Hello second' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('Hello second')).toBeInTheDocument(), WAIT_OPTS)

    // Wait for both conversations to be listed
    await waitFor(() => expect(document.querySelectorAll('.conversation-item').length).toBe(2), WAIT_OPTS)
  }, 12000)

  it('clear current chat keeps local deletion when cloud delete fails and reports sync error', async () => {
    vi.mocked(isPersistenceConfigured).mockReturnValue(true)
    vi.mocked(deleteCloudConversation).mockResolvedValue(false)

    const conv1 = {
      id: 'conv-1',
      title: 'First chat',
      messages: [{ id: 'msg-1', role: 'user', content: 'First message', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    const conv2 = {
      id: 'conv-2',
      title: 'Second chat',
      messages: [{ id: 'msg-2', role: 'user', content: 'Second message', timestamp: '2026-08-25T02:00:00Z' }],
      createdAt: '2026-08-25T02:00:00Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([conv2, conv1]))
    localStorage.setItem('daemon_active_conv_id', conv2.id)
    localStorage.setItem('daemon_messages', JSON.stringify(conv2.messages))

    render(<DaemonInterface currentUser={{ id: 'user-1', email: 'user@example.com', role: 'user' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Clear current chat/i }))

    expect(screen.queryByRole('button', { name: /Second chat/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /First chat/i })).toBeInTheDocument()
    expect(screen.getByText('First message')).toBeInTheDocument()

    await waitFor(() => expect(deleteCloudConversation).toHaveBeenCalledWith('conv-2'), WAIT_OPTS)
    await waitFor(() => expect(screen.getByText('Sync error')).toBeInTheDocument(), WAIT_OPTS)

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string }>
    expect(storedConvs.map(conv => conv.id)).toEqual(['conv-1'])
  })

  it('clear all chats uses the owner-scoped bulk delete helper without post-wipe discovery', async () => {
    vi.mocked(isPersistenceConfigured).mockReturnValue(true)
    vi.mocked(deleteAllCloudConversations).mockResolvedValue(true)

    const conv = {
      id: 'conv-a',
      title: 'Chat A',
      messages: [{ id: 'msg-a', role: 'user', content: 'Message A', timestamp: '2026-08-25T01:00:00Z' }],
      createdAt: '2026-08-25T01:00:00Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([conv]))
    localStorage.setItem('daemon_active_conv_id', conv.id)
    localStorage.setItem('daemon_messages', JSON.stringify(conv.messages))

    render(<DaemonInterface currentUser={{ id: 'user-1', email: 'user@example.com', role: 'user' }} />)

    fireEvent.click(screen.getByRole('button', { name: /Clear all chats/i }))

    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Chat A/i })).not.toBeInTheDocument()
    await waitFor(() => expect(deleteAllCloudConversations).toHaveBeenCalledTimes(1), WAIT_OPTS)
    expect(listConversations).not.toHaveBeenCalled()
  })

  it.each([false, null])(
    'clear all chats keeps local deletion when cloud bulk delete returns %s and reports sync error',
    async (result) => {
      vi.mocked(isPersistenceConfigured).mockReturnValue(true)
      vi.mocked(deleteAllCloudConversations).mockResolvedValue(result as unknown as boolean)

      const conv = {
        id: 'conv-a',
        title: 'Chat A',
        messages: [{ id: 'msg-a', role: 'user', content: 'Message A', timestamp: '2026-08-25T01:00:00Z' }],
        createdAt: '2026-08-25T01:00:00Z',
      }
      localStorage.setItem('daemon_conversations', JSON.stringify([conv]))
      localStorage.setItem('daemon_active_conv_id', conv.id)
      localStorage.setItem('daemon_messages', JSON.stringify(conv.messages))

      render(<DaemonInterface currentUser={{ id: 'user-1', email: 'user@example.com', role: 'user' }} />)

      fireEvent.click(screen.getByRole('button', { name: /Clear all chats/i }))

      expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Chat A/i })).not.toBeInTheDocument()
      await waitFor(() => expect(deleteAllCloudConversations).toHaveBeenCalledTimes(1), WAIT_OPTS)
      await waitFor(() => expect(screen.getByText('Sync error')).toBeInTheDocument(), WAIT_OPTS)
    },
  )

  // ── Enter key ─────────────────────────────────────────────────────────────

  it('pressing Enter submits the message', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'test Enter key' } })
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    })
    expect(screen.getByText('test Enter key')).toBeInTheDocument()
  })

  it('pressing Shift+Enter does NOT submit the message', () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'no submit' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    const messageRows = document.querySelectorAll('.message-row')
    expect(messageRows.length).toBe(0)
  })

  // ── Sidebar ───────────────────────────────────────────────────────────────

  it('sidebar close and reopen buttons toggle the sidebar', () => {
    render(<DaemonInterface />)
    const closeBtn = screen.getByRole('button', { name: /Close sidebar/i })
    fireEvent.click(closeBtn)
    expect(screen.queryByRole('navigation', { name: /Conversation history/i })).not.toBeInTheDocument()

    const openBtn = screen.getByRole('button', { name: /Open sidebar/i })
    fireEvent.click(openBtn)
    expect(screen.getByRole('navigation', { name: /Conversation history/i })).toBeInTheDocument()
  })

  it('migrates legacy chat and conversation storage to daemon keys', () => {
    const messages = [{
      id: 'legacy-message',
      role: 'user',
      content: 'Legacy conversation',
      timestamp: '2026-08-24T00:00:00.000Z',
    }]
    const conversations = [{
      id: 'legacy-conversation',
      title: 'Legacy conversation',
      messages,
      createdAt: '2026-08-24T00:00:00.000Z',
    }]
    localStorage.setItem('helen_messages', JSON.stringify(messages))
    localStorage.setItem('helen_conversations', JSON.stringify(conversations))

    render(<DaemonInterface />)

    expect(screen.getAllByText('Legacy conversation')).toHaveLength(2)
    expect(localStorage.getItem('daemon_messages')).toBe(JSON.stringify(messages))
    expect(localStorage.getItem('daemon_conversations')).toBe(JSON.stringify(conversations))
    expect(localStorage.getItem('helen_messages')).toBeNull()
    expect(localStorage.getItem('helen_conversations')).toBeNull()
  })

  // ── Conversation-selection regression tests ───────────────────────────────

  it('multiple sends in one session yield one conversation with all messages', async () => {
    render(<DaemonInterface />)
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    const log = () => screen.getByRole('log')

    fireEvent.change(input, { target: { value: 'first message' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('first message')).toBeInTheDocument(), WAIT_OPTS)
    // Wait for the component to finish thinking before the second send.
    await waitFor(() => expect(log()).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    fireEvent.change(input, { target: { value: 'second message' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('second message')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(log()).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    // Both messages must be in the same single conversation.
    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    expect(storedConvs).toHaveLength(1)
    const msgs = storedConvs[0].messages
    expect(msgs.some(m => m.content === 'first message')).toBe(true)
    expect(msgs.some(m => m.content === 'second message')).toBe(true)
  }, 15000)

  it('reloading with saved conversations restores the active conversation; next send stays in that conversation', async () => {
    // Pre-populate localStorage with a conversation and mark it active.
    const convId = 'test-conv-reload'
    const existingMsgs = [
      { id: 'msg-1', role: 'user', content: 'Saved message', timestamp: '2026-08-25T00:00:00.000Z' },
    ]
    const existingConvs = [{ id: convId, title: 'Saved message', messages: existingMsgs, createdAt: '2026-08-25T00:00:00.000Z' }]
    localStorage.setItem('daemon_messages', JSON.stringify(existingMsgs))
    localStorage.setItem('daemon_conversations', JSON.stringify(existingConvs))
    localStorage.setItem('daemon_active_conv_id', convId)

    render(<DaemonInterface />)

    // Restored message appears in the chat pane (sidebar also shows it as title).
    expect(screen.getAllByText('Saved message').length).toBeGreaterThanOrEqual(1)

    // Send a new message; it must stay in the same conversation.
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'follow-up message' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('follow-up message')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    // Must still be exactly 1 conversation (no new conversation was created).
    expect(storedConvs).toHaveLength(1)
    expect(storedConvs[0].id).toBe(convId)
    expect(storedConvs[0].messages.some(m => m.content === 'follow-up message')).toBe(true)
  }, 15000)

  it('selecting a sidebar conversation and sending appends to that conversation only', async () => {
    // Two existing conversations; "older" is not the most-recent.
    const newerConv = {
      id: 'conv-newer',
      title: 'Newer chat',
      messages: [{ id: 'm-n1', role: 'user', content: 'Newer message', timestamp: '2026-08-25T02:00:00.000Z' }],
      createdAt: '2026-08-25T02:00:00.000Z',
    }
    const olderConv = {
      id: 'conv-older',
      title: 'Older chat',
      messages: [{ id: 'm-o1', role: 'user', content: 'Older message', timestamp: '2026-08-25T01:00:00.000Z' }],
      createdAt: '2026-08-25T01:00:00.000Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([newerConv, olderConv]))
    localStorage.setItem('daemon_active_conv_id', newerConv.id)
    localStorage.setItem('daemon_messages', JSON.stringify(newerConv.messages))

    render(<DaemonInterface />)

    // Select the older conversation in the sidebar.
    fireEvent.click(screen.getByText('Older chat'))

    // Send a message; it must go to olderConv, not newerConv.
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'reply to older' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('reply to older')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    const older = storedConvs.find(c => c.id === 'conv-older')
    const newer = storedConvs.find(c => c.id === 'conv-newer')
    // The sent message must be in olderConv.
    expect(older?.messages.some(m => m.content === 'reply to older')).toBe(true)
    // newerConv must NOT have the sent message and must remain at 1 message.
    expect(newer?.messages.some(m => m.content === 'reply to older')).toBeFalsy()
    expect(newer?.messages).toHaveLength(1)
  }, 15000)

  it('clicking + New chat clears the pane; next send creates exactly one new conversation', async () => {
    // Start with an existing conversation.
    const existingConv = {
      id: 'conv-existing',
      title: 'Existing chat',
      messages: [{ id: 'm1', role: 'user', content: 'Old message', timestamp: '2026-08-25T00:00:00.000Z' }],
      createdAt: '2026-08-25T00:00:00.000Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([existingConv]))
    localStorage.setItem('daemon_active_conv_id', existingConv.id)
    localStorage.setItem('daemon_messages', JSON.stringify(existingConv.messages))

    render(<DaemonInterface />)

    expect(screen.getByText('Old message')).toBeInTheDocument()

    // Click + New chat.
    fireEvent.click(screen.getByRole('button', { name: /New chat/i }))

    // Pane should be empty.
    expect(screen.queryByText('Old message')).not.toBeInTheDocument()
    expect(screen.getByText(/Hello, I'm Daemon/i)).toBeInTheDocument()

    // Send a message; it should create a new, separate conversation.
    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'brand new message' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))
    await waitFor(() => expect(screen.getByText('brand new message')).toBeInTheDocument(), WAIT_OPTS)
    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    // The new message must be in its own conversation (not conv-existing).
    const newConv = storedConvs.find(c => c.messages.some(m => m.content === 'brand new message'))
    expect(newConv).toBeDefined()
    expect(newConv!.id).not.toBe('conv-existing')
    // Original conversation must be unchanged.
    const oldConv = storedConvs.find(c => c.id === 'conv-existing')
    expect(oldConv).toBeDefined()
    expect(oldConv!.messages).toHaveLength(1)
    expect(oldConv!.messages[0].content).toBe('Old message')
  }, 15000)

  it('a completed response does not steal the visible pane after the user switches chats', async () => {
    const activeConv = {
      id: 'conv-active',
      title: 'Active chat',
      messages: [{ id: 'm-active', role: 'user', content: 'Active message', timestamp: '2026-08-25T02:00:00.000Z' }],
      createdAt: '2026-08-25T02:00:00.000Z',
    }
    const otherConv = {
      id: 'conv-other',
      title: 'Other chat',
      messages: [{ id: 'm-other', role: 'user', content: 'Other message', timestamp: '2026-08-25T01:00:00.000Z' }],
      createdAt: '2026-08-25T01:00:00.000Z',
    }
    localStorage.setItem('daemon_conversations', JSON.stringify([activeConv, otherConv]))
    localStorage.setItem('daemon_active_conv_id', activeConv.id)
    localStorage.setItem('daemon_messages', JSON.stringify(activeConv.messages))

    render(<DaemonInterface />)

    const input = screen.getByPlaceholderText(/Message Daemon/i)
    fireEvent.change(input, { target: { value: 'message while active' } })
    fireEvent.click(screen.getByRole('button', { name: /Send message/i }))

    fireEvent.click(screen.getByRole('button', { name: /Other chat/i }))
    expect(screen.getByText('Other message')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByRole('log')).toHaveAttribute('aria-busy', 'false'), WAIT_OPTS)

    expect(screen.getByText('Other message')).toBeInTheDocument()
    expect(screen.queryByText('message while active')).not.toBeInTheDocument()

    const storedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]') as Array<{ id: string; messages: Array<{ content: string }> }>
    const updatedActive = storedConvs.find(conv => conv.id === 'conv-active')
    expect(updatedActive?.messages.some(message => message.content === 'message while active')).toBe(true)
  }, 15000)
})
