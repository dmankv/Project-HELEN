/**
 * Admin Daemon Interface
 *
 * Isolated administrative assistant interface, available only to authenticated
 * users with `profiles.role = 'admin'`.
 *
 * Storage isolation:
 *   - Uses distinct localStorage keys: daemon_admin_conversations,
 *     daemon_admin_messages, daemon_admin_active_conv_id.
 *   - Never reads or writes public Daemon storage keys.
 *   - Cloud persistence uses dedicated admin_ tables via adminDaemonPersistence.ts.
 *
 * This is the same Daemon identity in restricted administrative mode —
 * not a different sentient entity.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { AuthUser } from '../services/daemonAuthAPI'
import { genUUID } from '../services/daemonStorageMigration'
import { hasEdgeFunction } from '../services/supabaseEdgeChat'
import {
  upsertAdminConversation,
  deleteAdminConversation,
  deleteAllAdminConversations,
  insertAdminMessage,
  getAdminDiagnosticsStatus,
} from '../services/adminDaemonPersistence'

// ---------------------------------------------------------------------------
// Isolated storage keys — never overlap with public Daemon keys
// ---------------------------------------------------------------------------

const ADMIN_CONVERSATIONS_KEY = 'daemon_admin_conversations'
const ADMIN_ACTIVE_CONV_KEY = 'daemon_admin_active_conv_id'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: string
}

interface AdminDaemonInterfaceProps {
  currentUser: AuthUser
  onBackToPublic: () => void
  onLogoutClick?: () => void
}

// ---------------------------------------------------------------------------
// Edge function call for admin-daemon
// ---------------------------------------------------------------------------

interface AdminEdgeChatResult {
  ok: boolean
  message?: string
  error?: string
}

async function callAdminEdgeFunction(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<AdminEdgeChatResult> {
  const supabaseUrl =
    (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
  const supabaseAnonKey =
    (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, error: 'admin-daemon edge function is not configured.' }
  }

  // Get the current session token from Supabase auth
  const { createClient } = await import('@supabase/supabase-js')
  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    return { ok: false, error: 'No active session.' }
  }

  const endpoint = `${supabaseUrl}/functions/v1/admin-daemon`
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ messages }),
    })
    if (!res.ok) {
      const errData = await res.json().catch(() => ({})) as { code?: string }
      if (res.status === 403) {
        return { ok: false, error: 'Access denied.' }
      }
      if (res.status === 429) {
        return { ok: false, error: 'Rate limit exceeded. Please wait a moment.' }
      }
      return {
        ok: false,
        error: errData.code === 'PROVIDER_UNAVAILABLE' || errData.code === 'FUNCTION_CONFIG_ERROR'
          ? 'Admin cloud chat is temporarily unavailable.'
          : 'Admin cloud chat is temporarily unavailable.',
      }
    }
    const data2 = await res.json() as { message?: string }
    return { ok: true, message: data2.message ?? '' }
  } catch {
    return { ok: false, error: 'Network error reaching admin-daemon.' }
  }
}

// ---------------------------------------------------------------------------
// localStorage helpers (isolated to admin keys)
// ---------------------------------------------------------------------------

function loadAdminConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(ADMIN_CONVERSATIONS_KEY)
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}

function saveAdminConversations(convs: Conversation[]): void {
  try {
    localStorage.setItem(ADMIN_CONVERSATIONS_KEY, JSON.stringify(convs))
  } catch { /* best-effort */ }
}

function loadAdminActiveConvId(convs: Conversation[]): string | null {
  try {
    const saved = localStorage.getItem(ADMIN_ACTIVE_CONV_KEY)
    if (saved && convs.some(c => c.id === saved)) return saved
  } catch { /* best-effort */ }
  if (convs.length === 0) return null
  const sorted = [...convs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return sorted[0].id
}

function saveAdminActiveConvId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(ADMIN_ACTIVE_CONV_KEY)
    } else {
      localStorage.setItem(ADMIN_ACTIVE_CONV_KEY, id)
    }
  } catch { /* best-effort */ }
}

function titleFromMessages(messages: Message[]): string {
  const first = messages.find(m => m.role === 'user')
  if (!first) return 'New admin chat'
  const words = first.content.trim().split(/\s+/).slice(0, 6)
  const clipped = words.join(' ')
  return words.length > 5 ? clipped + '…' : clipped
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminDaemonInterface({
  currentUser,
  onBackToPublic,
  onLogoutClick,
}: AdminDaemonInterfaceProps): JSX.Element {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadAdminConversations(),
  )
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    const convs = loadAdminConversations()
    return loadAdminActiveConvId(convs)
  })
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [diagnostics, setDiagnostics] = useState<{
    persistenceConfigured: boolean
    sessionActive: boolean
    supabaseUrl: string
  } | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [clearConfirm, setClearConfirm] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeConversation = conversations.find(c => c.id === activeConvId) ?? null

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeConversation?.messages.length])

  // Load diagnostics once on mount
  useEffect(() => {
    void getAdminDiagnosticsStatus().then(setDiagnostics)
  }, [])

  const persistConversations = useCallback((convs: Conversation[]) => {
    saveAdminConversations(convs)
    // Best-effort cloud sync — do not await, do not block UI
    for (const c of convs) {
      void upsertAdminConversation(c.id, c.title)
    }
  }, [])

  const startNewChat = useCallback(() => {
    const id = genUUID()
    const conv: Conversation = {
      id,
      title: 'New admin chat',
      messages: [],
      createdAt: new Date().toISOString(),
    }
    setConversations(prev => {
      const next = [conv, ...prev]
      persistConversations(next)
      return next
    })
    setActiveConvId(id)
    saveAdminActiveConvId(id)
    setClearConfirm(false)
  }, [persistConversations])

  // Create initial conversation if none exist
  useEffect(() => {
    if (conversations.length === 0) {
      startNewChat()
    }
  }, []) // intentionally empty: run once on mount only

  const selectConversation = useCallback((id: string) => {
    setActiveConvId(id)
    saveAdminActiveConvId(id)
    setClearConfirm(false)
  }, [])

  const clearCurrentChat = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => {
      const next = prev.map(c =>
        c.id === activeConvId ? { ...c, messages: [], title: 'New admin chat' } : c,
      )
      persistConversations(next)
      return next
    })
    setClearConfirm(false)
  }, [activeConvId, persistConversations])

  const deleteCurrentConversation = useCallback(() => {
    if (!activeConvId) return
    setConversations(prev => {
      const next = prev.filter(c => c.id !== activeConvId)
      persistConversations(next)
      return next
    })
    void deleteAdminConversation(activeConvId)
    // Select another conversation or create new
    const remaining = conversations.filter(c => c.id !== activeConvId)
    if (remaining.length > 0) {
      const nextId = remaining[0].id
      setActiveConvId(nextId)
      saveAdminActiveConvId(nextId)
    } else {
      setActiveConvId(null)
      saveAdminActiveConvId(null)
    }
    setClearConfirm(false)
  }, [activeConvId, conversations, persistConversations])

  const clearAllChats = useCallback(() => {
    setConversations([])
    saveAdminConversations([])
    setActiveConvId(null)
    saveAdminActiveConvId(null)
    void deleteAllAdminConversations()
    setClearConfirm(false)
    // Start fresh after clearing
    const id = genUUID()
    const conv: Conversation = {
      id,
      title: 'New admin chat',
      messages: [],
      createdAt: new Date().toISOString(),
    }
    setConversations([conv])
    saveAdminConversations([conv])
    setActiveConvId(id)
    saveAdminActiveConvId(id)
  }, [])

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim()
    if (!trimmed || isThinking) return

    let convId = activeConvId
    if (!convId) {
      const id = genUUID()
      const conv: Conversation = {
        id,
        title: 'New admin chat',
        messages: [],
        createdAt: new Date().toISOString(),
      }
      setConversations(prev => {
        const next = [conv, ...prev]
        persistConversations(next)
        return next
      })
      setActiveConvId(id)
      saveAdminActiveConvId(id)
      convId = id
    }

    const userMsg: Message = {
      id: genUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }

    setInput('')
    setIsThinking(true)

    // Add user message to local state immediately
    setConversations(prev => {
      const next = prev.map(c => {
        if (c.id !== convId) return c
        const msgs = [...c.messages, userMsg]
        const title = msgs.length === 1 ? titleFromMessages(msgs) : c.title
        return { ...c, messages: msgs, title }
      })
      saveAdminConversations(next)
      return next
    })

    // Best-effort cloud persist of user message
    void insertAdminMessage({
      id: userMsg.id,
      conversation_id: convId,
      role: 'user',
      content: userMsg.content,
      position: 0,
    })

    // Build message history for the API call
    const currentConv = conversations.find(c => c.id === convId)
    const historyMessages = [
      ...(currentConv?.messages ?? []),
      userMsg,
    ].map(m => ({ role: m.role, content: m.content }))

    const result = await callAdminEdgeFunction(historyMessages)

    const assistantMsg: Message = {
      id: genUUID(),
      role: 'assistant',
      content: result.ok && result.message
        ? result.message
        : result.error ?? 'Admin cloud chat is temporarily unavailable.',
      timestamp: new Date().toISOString(),
    }

    setConversations(prev => {
      const next = prev.map(c => {
        if (c.id !== convId) return c
        const msgs = [...c.messages, assistantMsg]
        return { ...c, messages: msgs }
      })
      saveAdminConversations(next)
      // Cloud sync conversation after assistant reply
      const updatedConv = next.find(c => c.id === convId)
      if (updatedConv) void upsertAdminConversation(updatedConv.id, updatedConv.title)
      return next
    })

    void insertAdminMessage({
      id: assistantMsg.id,
      conversation_id: convId,
      role: 'assistant',
      content: assistantMsg.content,
      position: 1,
    })

    setIsThinking(false)
  }, [input, isThinking, activeConvId, conversations, persistConversations])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        void sendMessage()
      }
    },
    [sendMessage],
  )

  const sortedConversations = [...conversations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        fontFamily: 'inherit',
        background: '#f9f9f9',
      }}
    >
      {/* Sidebar */}
      <aside
        aria-label="Admin Daemon conversation history"
        style={{
          width: 260,
          borderRight: '1px solid #e0e0e0',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          flexShrink: 0,
        }}
      >
        {/* Admin identity badge */}
        <div
          style={{
            padding: '1rem',
            borderBottom: '1px solid #e0e0e0',
            background: '#1a1a2e',
            color: '#fff',
          }}
        >
          <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>Admin Daemon</div>
          <div style={{ fontSize: '0.75rem', color: '#aab', marginTop: '0.2rem' }}>
            Restricted administrative assistant
          </div>
          <div style={{ fontSize: '0.7rem', color: '#889', marginTop: '0.15rem' }}>
            {currentUser.email}
          </div>
        </div>

        {/* Nav actions */}
        <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <button
            type="button"
            onClick={startNewChat}
            style={{
              width: '100%',
              padding: '0.5rem',
              background: '#1a1a2e',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            + New admin chat
          </button>

          <button
            type="button"
            onClick={onBackToPublic}
            style={{
              width: '100%',
              padding: '0.5rem',
              background: 'transparent',
              border: '1px solid #ccc',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            ← Return to Daemon
          </button>

          {onLogoutClick && (
            <button
              type="button"
              onClick={onLogoutClick}
              style={{
                width: '100%',
                padding: '0.5rem',
                background: 'transparent',
                border: '1px solid #ccc',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                color: '#666',
              }}
            >
              Sign out
            </button>
          )}
        </div>

        {/* Conversation list */}
        <nav
          aria-label="Admin conversations"
          style={{ flex: 1, overflowY: 'auto', padding: '0.25rem 0.5rem' }}
        >
          {sortedConversations.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => selectConversation(c.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                marginBottom: '0.2rem',
                borderRadius: '6px',
                border: 'none',
                background: c.id === activeConvId ? '#eef' : 'transparent',
                cursor: 'pointer',
                fontSize: '0.82rem',
                color: '#222',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {c.title}
            </button>
          ))}
        </nav>

        {/* Destructive actions */}
        <div style={{ padding: '0.75rem', borderTop: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {!clearConfirm ? (
            <>
              <button
                type="button"
                onClick={() => setClearConfirm(true)}
                aria-label="Destructive chat actions"
                style={{
                  padding: '0.4rem',
                  background: 'transparent',
                  border: '1px solid #e0e0e0',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                  color: '#888',
                }}
              >
                Clear / delete…
              </button>
              <button
                type="button"
                onClick={() => setShowDiagnostics(v => !v)}
                style={{
                  padding: '0.4rem',
                  background: 'transparent',
                  border: '1px solid #e0e0e0',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  fontSize: '0.78rem',
                  color: '#888',
                }}
              >
                {showDiagnostics ? 'Hide diagnostics' : 'Diagnostics'}
              </button>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '0.78rem', color: '#888' }}>Choose action:</span>
              <button
                type="button"
                onClick={clearCurrentChat}
                style={{ padding: '0.4rem', border: '1px solid #e0e0e0', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', background: 'transparent' }}
              >
                Clear current chat
              </button>
              <button
                type="button"
                onClick={deleteCurrentConversation}
                style={{ padding: '0.4rem', border: '1px solid #f99', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', color: '#c44', background: 'transparent' }}
              >
                Delete this conversation
              </button>
              <button
                type="button"
                onClick={clearAllChats}
                style={{ padding: '0.4rem', border: '1px solid #f66', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', color: '#c00', background: 'transparent' }}
              >
                Clear all admin chats
              </button>
              <button
                type="button"
                onClick={() => setClearConfirm(false)}
                style={{ padding: '0.4rem', border: '1px solid #ccc', borderRadius: '5px', cursor: 'pointer', fontSize: '0.78rem', background: 'transparent' }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main chat pane */}
      <main
        aria-label="Admin Daemon chat"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <header
          style={{
            padding: '0.75rem 1.25rem',
            borderBottom: '1px solid #e0e0e0',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
            {activeConversation?.title ?? 'Admin Daemon'}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.75rem',
              background: '#1a1a2e',
              color: '#fff',
              padding: '0.2rem 0.6rem',
              borderRadius: '4px',
            }}
          >
            Admin
          </span>
        </header>

        {/* Diagnostics panel */}
        {showDiagnostics && diagnostics && (
          <section
            aria-label="Admin diagnostics"
            role="region"
            style={{
              padding: '0.75rem 1.25rem',
              background: '#f0f0ff',
              borderBottom: '1px solid #e0e0e0',
              fontSize: '0.8rem',
              color: '#444',
            }}
          >
            <strong>Diagnostics</strong>
            <ul style={{ margin: '0.4rem 0 0', paddingLeft: '1.2rem' }}>
              <li>Persistence configured: {String(diagnostics.persistenceConfigured)}</li>
              <li>Session active: {String(diagnostics.sessionActive)}</li>
              <li>Supabase host: {diagnostics.supabaseUrl || '(not configured)'}</li>
              <li>Admin edge function: {hasEdgeFunction() ? 'reachable (public daemon-chat)' : 'not configured'}</li>
            </ul>
            <p style={{ margin: '0.4rem 0 0', color: '#888' }}>
              No secret values are shown above. To access project secrets, use the Supabase dashboard.
            </p>
          </section>
        )}

        {/* Messages */}
        <div
          role="log"
          aria-live="polite"
          aria-label="Admin chat messages"
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          {(activeConversation?.messages.length ?? 0) === 0 && (
            <div
              style={{
                color: '#aaa',
                textAlign: 'center',
                marginTop: '3rem',
                fontSize: '0.9rem',
              }}
            >
              Admin Daemon is a restricted administrative assistant.
              <br />
              Start a new message to begin.
            </div>
          )}
          {(activeConversation?.messages ?? []).map(msg => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '72%',
                  padding: '0.6rem 0.9rem',
                  borderRadius: '12px',
                  background: msg.role === 'user' ? '#1a1a2e' : '#f0f0ff',
                  color: msg.role === 'user' ? '#fff' : '#222',
                  fontSize: '0.9rem',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {isThinking && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                aria-label="Admin Daemon is thinking"
                style={{
                  padding: '0.6rem 0.9rem',
                  borderRadius: '12px',
                  background: '#f0f0ff',
                  color: '#888',
                  fontSize: '0.9rem',
                  fontStyle: 'italic',
                }}
              >
                Thinking…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div
          style={{
            padding: '0.75rem 1.25rem',
            borderTop: '1px solid #e0e0e0',
            background: '#fff',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-end',
          }}
        >
          <textarea
            aria-label="Admin Daemon message input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Admin Daemon…"
            rows={2}
            disabled={isThinking}
            style={{
              flex: 1,
              resize: 'none',
              padding: '0.6rem 0.75rem',
              borderRadius: '8px',
              border: '1px solid #ccc',
              fontSize: '0.9rem',
              lineHeight: 1.5,
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={isThinking || !input.trim()}
            aria-label="Send message"
            style={{
              padding: '0.6rem 1.2rem',
              background: '#1a1a2e',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: isThinking || !input.trim() ? 'not-allowed' : 'pointer',
              opacity: isThinking || !input.trim() ? 0.5 : 1,
              fontSize: '0.9rem',
            }}
          >
            Send
          </button>
        </div>
      </main>
    </div>
  )
}
