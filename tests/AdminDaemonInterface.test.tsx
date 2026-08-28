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
  buildHistoryMessages,
  getAdminStorageKey,
} from '../src/components/AdminDaemonInterface'

const currentUser = {
  id: 'admin-1',
  email: 'admin@example.com',
  emailVerified: true,
  role: 'admin' as const,
}

const PUBLIC_CONVERSATIONS_KEY = 'daemon_conversations'
const PUBLIC_MESSAGES_KEY = 'daemon_messages'
const PUBLIC_ACTIVE_CONV_KEY = 'daemon_active_conv_id'

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
