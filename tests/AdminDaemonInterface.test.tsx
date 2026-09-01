import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  genUUIDMock,
  getSessionMock,
  persistenceMocks,
} = vi.hoisted(() => ({
  genUUIDMock: vi.fn(),
  getSessionMock: vi.fn(),
  persistenceMocks: {
    deleteAdminMessagesForConversation: vi.fn(async () => true),
    deleteAdminConversation: vi.fn(async () => true),
    deleteAllAdminConversations: vi.fn(async () => true),
    getAdminDiagnosticsStatus: vi.fn(async () => ({
      persistenceConfigured: true,
      sessionActive: true,
      supabaseUrl: 'example.supabase.co',
    })),
    insertAdminMessage: vi.fn(async () => true),
    listAdminConversations: vi.fn(async () => []),
    listAdminMessages: vi.fn(async () => []),
    upsertAdminConversation: vi.fn(async () => true),
  },
}))

vi.mock('../src/services/daemonStorageMigration', () => ({
  genUUID: genUUIDMock,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: getSessionMock,
    },
  })),
}))

vi.mock('../src/services/adminDaemonPersistence', () => persistenceMocks)
vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')

import AdminDaemonInterface, {
  ADMIN_STORAGE_KEYS,
  buildHistoryMessages,
  getAdminStorageKey,
} from '../src/components/AdminDaemonInterface'
import { SIDEBAR_OPEN_KEY } from '../src/components/sidebarPreference'

const currentUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  emailVerified: true,
  role: 'admin' as const,
}

const PUBLIC_CONVERSATIONS_KEY = 'daemon_conversations'
const PUBLIC_MESSAGES_KEY = 'daemon_messages'
const PUBLIC_ACTIVE_CONV_KEY = 'daemon_active_conv_id'
const PUBLIC_SIDEBAR_KEY = SIDEBAR_OPEN_KEY

describe('AdminDaemonInterface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    genUUIDMock.mockImplementation(() => `uuid-${Math.random().toString(36).slice(2)}`)
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'token-123',
          user: { id: currentUser.id },
        },
      },
    })
    persistenceMocks.deleteAdminMessagesForConversation.mockResolvedValue(true)
    persistenceMocks.deleteAdminConversation.mockResolvedValue(true)
    persistenceMocks.deleteAllAdminConversations.mockResolvedValue(true)
    persistenceMocks.getAdminDiagnosticsStatus.mockResolvedValue({
      persistenceConfigured: true,
      sessionActive: true,
      supabaseUrl: 'example.supabase.co',
    })
    persistenceMocks.insertAdminMessage.mockResolvedValue(true)
    persistenceMocks.listAdminConversations.mockResolvedValue([])
    persistenceMocks.listAdminMessages.mockResolvedValue([])
    persistenceMocks.upsertAdminConversation.mockResolvedValue(true)
    global.fetch = vi.fn()
    window.fetch = global.fetch
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('hydrates persisted admin conversations and messages after authentication', async () => {
    persistenceMocks.listAdminConversations.mockResolvedValue([
      {
        id: 'cloud-conv-1',
        user_id: currentUser.id,
        title: 'Cloud conversation',
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
      },
    ])
    persistenceMocks.listAdminMessages.mockResolvedValue([
      {
        id: 'cloud-msg-1',
        conversation_id: 'cloud-conv-1',
        user_id: currentUser.id,
        role: 'assistant',
        content: 'Recovered from cloud',
        position: 0,
        created_at: '2026-08-28T00:00:01.000Z',
      },
    ])

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    await waitFor(() => expect(screen.getByText('Recovered from cloud')).toBeInTheDocument())
    expect(screen.getAllByText('Cloud conversation')).toHaveLength(2)
    expect(persistenceMocks.listAdminMessages).toHaveBeenCalledWith('cloud-conv-1')
  })

  it('shows admin sidebar open by default with close control', async () => {
    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    expect(await screen.findByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeInTheDocument()
    expect(screen.getAllByRole('navigation')).toHaveLength(1)
    expect(screen.getByRole('list', { name: 'Admin conversations' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
  })

  it('uses shared daemon theme classes for admin shell, messages, controls, and diagnostics', async () => {
    localStorage.setItem(getAdminStorageKey(currentUser.id, 'conversations'), JSON.stringify([
      {
        id: 'admin-conv-1',
        title: 'Admin conversation',
        messages: [
          { id: 'admin-msg-1', role: 'user', content: 'hello admin', timestamp: '2026-08-28T00:00:00.000Z' },
          { id: 'admin-msg-2', role: 'assistant', content: 'hello operator', timestamp: '2026-08-28T00:00:01.000Z' },
        ],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(getAdminStorageKey(currentUser.id, 'activeConversationId'), 'admin-conv-1')

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    expect(document.querySelector('.admin-daemon-app.daemon-app')).toBeInTheDocument()

    const sidebar = await screen.findByRole('navigation', { name: 'Admin Daemon conversation history' })
    expect(sidebar).toHaveClass('daemon-sidebar', 'admin-daemon-sidebar')
    expect(sidebar).not.toHaveAttribute('style')

    const activeConversation = screen.getByRole('button', { name: 'Admin conversation' })
    expect(activeConversation).toHaveClass('conversation-item', 'active')
    expect(activeConversation).not.toHaveAttribute('style')

    const header = document.querySelector('.admin-daemon-header.daemon-header')
    expect(header).toBeInTheDocument()
    expect(header).not.toHaveAttribute('style')

    const newChatButton = screen.getByRole('button', { name: '+ New admin chat' })
    expect(newChatButton).toHaveClass('new-chat-btn', 'admin-daemon-action-btn')
    expect(newChatButton).not.toHaveAttribute('style')

    const userBubble = screen.getByText('hello admin').closest('.bubble')
    const assistantBubble = screen.getByText('hello operator').closest('.bubble')
    expect(userBubble).toHaveClass('bubble', 'user-bubble')
    expect(assistantBubble).toHaveClass('bubble', 'assistant-bubble')

    const messages = screen.getByRole('log', { name: 'Admin chat messages' })
    expect(messages).toHaveClass('messages-container', 'admin-daemon-messages')

    const input = screen.getByLabelText('Admin Daemon message input')
    expect(input).toHaveClass('daemon-input', 'admin-daemon-input')
    expect(input).not.toHaveAttribute('style')

    const sendButton = screen.getByRole('button', { name: 'Send message' })
    expect(sendButton).toHaveClass('send-btn', 'admin-daemon-send-btn')
    expect(sendButton).not.toHaveAttribute('style')

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    const diagnostics = await screen.findByRole('region', { name: 'Admin diagnostics' })
    expect(diagnostics).toHaveClass('admin-daemon-diagnostics-panel')
    expect(diagnostics).not.toHaveAttribute('style')
  })

  it('keeps admin identity labeling visible and accessible across sidebar and header', async () => {
    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    expect(await screen.findByText('Restricted administrative assistant')).toBeInTheDocument()
    expect(await screen.findAllByLabelText(`Signed in as ${currentUser.email}`)).toHaveLength(2)
    expect(screen.getByLabelText('Account role admin')).toHaveTextContent('Admin')
  })

  it('close/open sidebar controls toggle conditional rendering accessibly', async () => {
    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close sidebar' }))
    expect(screen.queryByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }))
    expect(screen.getByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument()
  })

  it('persists sidebar close/open state across remount for the same admin user', async () => {
    const sidebarKey = getAdminStorageKey(currentUser.id, 'sidebarOpen')
    const { unmount } = render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(localStorage.getItem(sidebarKey)).toBe('false'))

    unmount()
    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    expect(await screen.findByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeNull()
  })

  it('reloads user-scoped sidebar preference when authenticated admin account changes', async () => {
    const firstUser = { ...currentUser, id: 'admin-1', email: 'admin1@example.com' }
    const secondUser = { ...currentUser, id: 'admin-2', email: 'admin2@example.com' }
    localStorage.setItem(getAdminStorageKey(firstUser.id, 'sidebarOpen'), 'false')
    localStorage.setItem(getAdminStorageKey(secondUser.id, 'sidebarOpen'), 'true')

    const { rerender } = render(
      <AdminDaemonInterface currentUser={firstUser} onBackToPublic={() => undefined} />,
    )

    expect(await screen.findByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeNull()

    rerender(<AdminDaemonInterface currentUser={secondUser} onBackToPublic={() => undefined} />)

    expect(await screen.findByRole('navigation', { name: 'Admin Daemon conversation history' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument()
  })

  it('uses admin-scoped sidebar key namespace distinct from public daemon keys', () => {
    const adminSidebarPrefix = ADMIN_STORAGE_KEYS.sidebarOpen
    expect(adminSidebarPrefix).toContain('admin')
    expect(adminSidebarPrefix).not.toBe(PUBLIC_SIDEBAR_KEY)
    expect(adminSidebarPrefix).not.toBe(PUBLIC_CONVERSATIONS_KEY)
    expect(adminSidebarPrefix).not.toBe(PUBLIC_MESSAGES_KEY)
    expect(adminSidebarPrefix).not.toBe(PUBLIC_ACTIVE_CONV_KEY)
  })

  it('admin sidebar toggle does not modify public daemon sidebar or chat keys', async () => {
    const adminSidebarKey = getAdminStorageKey(currentUser.id, 'sidebarOpen')
    localStorage.setItem(PUBLIC_SIDEBAR_KEY, 'true')
    localStorage.setItem(PUBLIC_CONVERSATIONS_KEY, JSON.stringify([{ id: 'public-conv-1' }]))
    localStorage.setItem(PUBLIC_MESSAGES_KEY, JSON.stringify([{ id: 'public-msg-1' }]))
    localStorage.setItem(PUBLIC_ACTIVE_CONV_KEY, 'public-conv-1')

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Close sidebar' }))
    await waitFor(() => expect(localStorage.getItem(adminSidebarKey)).toBe('false'))

    expect(localStorage.getItem(PUBLIC_SIDEBAR_KEY)).toBe('true')
    expect(JSON.parse(localStorage.getItem(PUBLIC_CONVERSATIONS_KEY) ?? '[]')).toEqual([{ id: 'public-conv-1' }])
    expect(JSON.parse(localStorage.getItem(PUBLIC_MESSAGES_KEY) ?? '[]')).toEqual([{ id: 'public-msg-1' }])
    expect(localStorage.getItem(PUBLIC_ACTIVE_CONV_KEY)).toBe('public-conv-1')
  })

  it('public daemon sidebar preference writes do not modify admin sidebar preference', async () => {
    const adminSidebarKey = getAdminStorageKey(currentUser.id, 'sidebarOpen')
    localStorage.setItem(adminSidebarKey, 'false')
    localStorage.setItem(PUBLIC_SIDEBAR_KEY, 'true')

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    expect(await screen.findByRole('button', { name: 'Open sidebar' })).toBeInTheDocument()
    expect(localStorage.getItem(adminSidebarKey)).toBe('false')
  })

  it('keeps public storage untouched when admin creates, clears, and deletes chats', async () => {
    const adminConversationKey = getAdminStorageKey(currentUser.id, 'conversations')
    const adminActiveKey = getAdminStorageKey(currentUser.id, 'activeConversationId')
    localStorage.setItem(PUBLIC_CONVERSATIONS_KEY, JSON.stringify([{ id: 'public-conv-1' }]))
    localStorage.setItem(PUBLIC_MESSAGES_KEY, JSON.stringify([{ id: 'public-msg-1' }]))
    localStorage.setItem(PUBLIC_ACTIVE_CONV_KEY, 'public-conv-1')
    localStorage.setItem(adminConversationKey, JSON.stringify([
      {
        id: 'admin-conv-1',
        title: 'Admin conversation',
        messages: [{ id: 'admin-msg-1', role: 'assistant', content: 'hello', timestamp: '2026-08-28T00:00:00.000Z' }],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(adminActiveKey, 'admin-conv-1')
    genUUIDMock
      .mockReturnValueOnce('admin-conv-2')
      .mockReturnValueOnce('admin-conv-3')

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.click(await screen.findByText('+ New admin chat'))
    await waitFor(() => expect(localStorage.getItem(adminActiveKey)).toBe('admin-conv-2'))

    fireEvent.click(screen.getByLabelText('Destructive chat actions'))
    fireEvent.click(screen.getByText('Clear current chat'))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(adminConversationKey) ?? '[]') as Array<{ id: string; messages: unknown[] }>
      expect(stored.find(conversation => conversation.id === 'admin-conv-2')?.messages).toEqual([])
    })

    fireEvent.click(screen.getByLabelText('Destructive chat actions'))
    fireEvent.click(screen.getByText('Delete this conversation'))
    await waitFor(() => expect(localStorage.getItem(adminActiveKey)).toBe('admin-conv-1'))

    expect(JSON.parse(localStorage.getItem(PUBLIC_CONVERSATIONS_KEY) ?? '[]')).toEqual([{ id: 'public-conv-1' }])
    expect(JSON.parse(localStorage.getItem(PUBLIC_MESSAGES_KEY) ?? '[]')).toEqual([{ id: 'public-msg-1' }])
    expect(localStorage.getItem(PUBLIC_ACTIVE_CONV_KEY)).toBe('public-conv-1')
  })

  it('keeps only the 40 newest messages when building admin request history', () => {
    const history = buildHistoryMessages(
      Array.from({ length: 41 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `message-${index}`,
        timestamp: `2026-08-28T00:00:${String(index).padStart(2, '0')}.000Z`,
      })),
    )

    expect(history).toHaveLength(40)
    expect(history[0]?.content).toBe('message-1')
    expect(history.at(-1)?.content).toBe('message-40')
  })

  it('rejects oversized messages before mutating conversation state', async () => {
    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.change(await screen.findByLabelText('Admin Daemon message input'), {
      target: { value: 'a'.repeat(8_001) },
    })
    fireEvent.click(screen.getByLabelText('Send message'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Message is too large.')
    expect(global.fetch).not.toHaveBeenCalled()
    expect(persistenceMocks.insertAdminMessage).not.toHaveBeenCalled()
  })

  it('reloads scoped local admin state when the authenticated account changes', async () => {
    const firstUser = { ...currentUser, id: 'admin-1', email: 'admin1@example.com' }
    const secondUser = { ...currentUser, id: 'admin-2', email: 'admin2@example.com' }
    localStorage.setItem(getAdminStorageKey(firstUser.id, 'conversations'), JSON.stringify([
      {
        id: 'first-conv',
        title: 'First admin chat',
        messages: [],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(getAdminStorageKey(firstUser.id, 'activeConversationId'), 'first-conv')
    localStorage.setItem(getAdminStorageKey(secondUser.id, 'conversations'), JSON.stringify([
      {
        id: 'second-conv',
        title: 'Second admin chat',
        messages: [],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(getAdminStorageKey(secondUser.id, 'activeConversationId'), 'second-conv')

    const { rerender } = render(
      <AdminDaemonInterface currentUser={firstUser} onBackToPublic={() => undefined} />,
    )

    await waitFor(() => expect(screen.getAllByText('First admin chat')).toHaveLength(2))

    rerender(<AdminDaemonInterface currentUser={secondUser} onBackToPublic={() => undefined} />)

    await waitFor(() => expect(screen.getAllByText('Second admin chat')).toHaveLength(2))
    expect(screen.queryByText('First admin chat')).toBeNull()
  })

  it('keeps old regular theme literals out of AdminDaemonInterface source', () => {
    const adminSource = readFileSync(
      resolve(process.cwd(), 'src/components/AdminDaemonInterface.tsx'),
      'utf8',
    )

    expect(adminSource).not.toMatch(
      /#(?:f9f9f9|1a1a2e|f0f0ff|e0e0e0|(?:fff|eef|222|444|666|888|ccc)(?![0-9a-fA-F]))/i,
    )
  })

  it('preserves local messages when cloud message hydration fails for a cloud conversation', async () => {
    const adminConversationKey = getAdminStorageKey(currentUser.id, 'conversations')
    const adminActiveKey = getAdminStorageKey(currentUser.id, 'activeConversationId')
    localStorage.setItem(adminConversationKey, JSON.stringify([
      {
        id: 'cloud-conv-1',
        title: 'Local conversation',
        messages: [{ id: 'local-msg-1', role: 'assistant', content: 'Local pending message', timestamp: '2026-08-28T00:00:01.000Z' }],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(adminActiveKey, 'cloud-conv-1')
    persistenceMocks.listAdminConversations.mockResolvedValue([
      {
        id: 'cloud-conv-1',
        user_id: currentUser.id,
        title: 'Cloud conversation',
        created_at: '2026-08-28T00:00:00.000Z',
        updated_at: '2026-08-28T00:00:00.000Z',
      },
    ])
    persistenceMocks.listAdminMessages.mockResolvedValue(null)

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    await waitFor(() => expect(screen.getByText('Local pending message')).toBeInTheDocument())
  })

  it('does not wipe local chat when cloud clear fails', async () => {
    const adminConversationKey = getAdminStorageKey(currentUser.id, 'conversations')
    const adminActiveKey = getAdminStorageKey(currentUser.id, 'activeConversationId')
    localStorage.setItem(adminConversationKey, JSON.stringify([
      {
        id: 'admin-conv-1',
        title: 'Admin conversation',
        messages: [{ id: 'admin-msg-1', role: 'assistant', content: 'keep me', timestamp: '2026-08-28T00:00:00.000Z' }],
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ]))
    localStorage.setItem(adminActiveKey, 'admin-conv-1')
    persistenceMocks.upsertAdminConversation.mockResolvedValue(true)
    persistenceMocks.deleteAdminMessagesForConversation.mockResolvedValue(false)

    render(<AdminDaemonInterface currentUser={currentUser} onBackToPublic={() => undefined} />)

    fireEvent.click(await screen.findByLabelText('Destructive chat actions'))
    fireEvent.click(screen.getByText('Clear current chat'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to clear this chat right now. Please try again.'))
    const stored = JSON.parse(localStorage.getItem(adminConversationKey) ?? '[]') as Array<{ messages: Array<{ content: string }> }>
    expect(stored[0]?.messages[0]?.content).toBe('keep me')
  })

})
