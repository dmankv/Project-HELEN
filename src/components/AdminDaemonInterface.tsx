/**
 * Admin Daemon Interface
 *
 * Isolated administrative assistant interface, available only to authenticated
 * users with `profiles.role = 'admin'`.
 *
 * Storage isolation:
 *   - Uses distinct localStorage keys: daemon_admin_conversations,
 *     daemon_admin_active_conv_id.
 *   - Never reads or writes public Daemon storage keys.
 *   - Cloud persistence uses dedicated admin_ tables via adminDaemonPersistence.ts.
 *
 * This is the same Daemon identity in restricted administrative mode —
 * not a different sentient entity.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import type { AuthUser } from '../services/daemonAuthAPI'
import { genUUID } from '../services/daemonStorageMigration'
import { loadSidebarOpenForKey, saveSidebarOpenForKey } from './sidebarPreference'
import {
  deleteAdminMessagesForConversation,
  deleteAdminConversation,
  deleteAllAdminConversations,
  getAdminDiagnosticsStatus,
  insertAdminMessage,
  listAdminConversations,
  listAdminMessages,
  upsertAdminConversation,
} from '../services/adminDaemonPersistence'
import '../styles/DaemonInterface.css'

// ---------------------------------------------------------------------------
// Isolated storage keys — never overlap with public Daemon keys
// ---------------------------------------------------------------------------

export const ADMIN_STORAGE_KEYS = {
  conversations: 'daemon_admin_conversations',
  activeConversationId: 'daemon_admin_active_conv_id',
  sidebarOpen: 'daemon_admin_sidebar_open',
} as const

type AdminStorageKeyName = keyof typeof ADMIN_STORAGE_KEYS

const ADMIN_SUPABASE_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
const ADMIN_SUPABASE_ANON_KEY =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''
const MAX_ADMIN_HISTORY_MESSAGES = 40
const MAX_ADMIN_MESSAGE_BYTES = 8_000
const textEncoder = new TextEncoder()
let adminEdgeAuthClient: ReturnType<typeof createClient> | null = null

export function getAdminStorageKey(userId: string, key: AdminStorageKeyName): string {
  return `${ADMIN_STORAGE_KEYS[key]}:${userId}`
}

function getAdminEdgeAuthClient(): ReturnType<typeof createClient> | null {
  if (!ADMIN_SUPABASE_URL || !ADMIN_SUPABASE_ANON_KEY) return null
  if (adminEdgeAuthClient) return adminEdgeAuthClient
  adminEdgeAuthClient = createClient(ADMIN_SUPABASE_URL, ADMIN_SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  })
  return adminEdgeAuthClient
}

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
  signal?: AbortSignal,
): Promise<AdminEdgeChatResult> {
  const client = getAdminEdgeAuthClient()
  if (!client) {
    return { ok: false, error: 'admin-daemon edge function is not configured.' }
  }

  const { data } = await client.auth.getSession()
  const token = data.session?.access_token
  if (!token) {
    return { ok: false, error: 'No active session.' }
  }

  const endpoint = `${ADMIN_SUPABASE_URL}/functions/v1/admin-daemon`
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({ messages }),
      signal,
    })
    if (!res.ok) {
      await res.json().catch(() => undefined)
      if (res.status === 403) {
        return { ok: false, error: 'Access denied.' }
      }
      if (res.status === 429) {
        return { ok: false, error: 'Rate limit exceeded. Please wait a moment.' }
      }
      return { ok: false, error: 'Admin cloud chat is temporarily unavailable.' }
    }
    const data2 = await res.json() as { message?: string }
    return { ok: true, message: data2.message ?? '' }
  } catch {
    if (signal?.aborted) {
      return { ok: false, error: 'Request cancelled.' }
    }
    return { ok: false, error: 'Network error reaching admin-daemon.' }
  }
}

// ---------------------------------------------------------------------------
// localStorage helpers (isolated to admin keys)
// ---------------------------------------------------------------------------

function loadAdminConversations(userId: string): Conversation[] {
  try {
    const raw = localStorage.getItem(getAdminStorageKey(userId, 'conversations'))
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}

function saveAdminConversations(userId: string, convs: Conversation[]): void {
  try {
    localStorage.setItem(getAdminStorageKey(userId, 'conversations'), JSON.stringify(convs))
  } catch { /* best-effort */ }
}

function loadAdminActiveConvId(userId: string, convs: Conversation[]): string | null {
  try {
    const saved = localStorage.getItem(getAdminStorageKey(userId, 'activeConversationId'))
    if (saved && convs.some(c => c.id === saved)) return saved
  } catch { /* best-effort */ }
  if (convs.length === 0) return null
  const sorted = [...convs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return sorted[0].id
}

function loadInitialAdminState(userId: string): {
  conversations: Conversation[]
  activeConvId: string | null
  sidebarOpen: boolean
} {
  const conversations = loadAdminConversations(userId)
  return {
    conversations,
    activeConvId: loadAdminActiveConvId(userId, conversations),
    sidebarOpen: loadSidebarOpenForKey(getAdminStorageKey(userId, 'sidebarOpen')),
  }
}

function saveAdminActiveConvId(userId: string, id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(getAdminStorageKey(userId, 'activeConversationId'))
    } else {
      localStorage.setItem(getAdminStorageKey(userId, 'activeConversationId'), id)
    }
  } catch { /* best-effort */ }
}

function loadAdminSidebarOpen(userId: string): boolean {
  return loadSidebarOpenForKey(getAdminStorageKey(userId, 'sidebarOpen'))
}

function saveAdminSidebarOpen(userId: string, sidebarOpen: boolean): void {
  saveSidebarOpenForKey(getAdminStorageKey(userId, 'sidebarOpen'), sidebarOpen)
}

function createConversation(): Conversation {
  return {
    id: genUUID(),
    title: 'New admin chat',
    messages: [],
    createdAt: new Date().toISOString(),
  }
}

export function buildHistoryMessages(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages
    .slice(-MAX_ADMIN_HISTORY_MESSAGES)
    .map(message => ({ role: message.role, content: message.content }))
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
  const initialStateRef = useRef(loadInitialAdminState(currentUser.id))
  const [conversations, setConversations] = useState<Conversation[]>(
   initialStateRef.current.conversations,
  )
  const [activeConvId, setActiveConvId] = useState<string | null>(
   initialStateRef.current.activeConvId,
  )
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(initialStateRef.current.sidebarOpen)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [isThinking, setIsThinking] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [diagnostics, setDiagnostics] = useState<{
   persistenceConfigured: boolean
   sessionActive: boolean
   supabaseUrl: string
  } | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [clearConfirm, setClearConfirm] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const requestVersionRef = useRef(0)
  const conversationsRef = useRef(conversations)
  const activeConvIdRef = useRef(activeConvId)

  const activeConversation = conversations.find(c => c.id === activeConvId) ?? null
  const isBusy = isThinking || isResetting

  // Scroll to bottom on new messages
  useEffect(() => {
   messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeConversation?.messages.length, isThinking])

  useEffect(() => {
   conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
   activeConvIdRef.current = activeConvId
  }, [activeConvId])

  const applyConversationState = useCallback((nextConversations: Conversation[], nextActiveConvId: string | null) => {
   conversationsRef.current = nextConversations
   activeConvIdRef.current = nextActiveConvId
   setConversations(nextConversations)
   setActiveConvId(nextActiveConvId)
   saveAdminConversations(currentUser.id, nextConversations)
   saveAdminActiveConvId(currentUser.id, nextActiveConvId)
  }, [currentUser.id])

  const cancelInFlightRequest = useCallback(() => {
   requestVersionRef.current += 1
   abortRef.current?.abort()
   abortRef.current = null
   setIsThinking(false)
  }, [])

  const updateSidebarOpen = useCallback((nextSidebarOpen: boolean) => {
   setSidebarOpen(nextSidebarOpen)
   saveAdminSidebarOpen(currentUser.id, nextSidebarOpen)
  }, [currentUser.id])

  useEffect(() => {
   let cancelled = false
   cancelInFlightRequest()
   setInput('')
   setInputError(null)
   setIsResetting(false)
   setClearConfirm(false)
   setSidebarOpen(loadAdminSidebarOpen(currentUser.id))

   const localConversations = loadAdminConversations(currentUser.id)
   const localActiveConvId = loadAdminActiveConvId(currentUser.id, localConversations)
   applyConversationState(localConversations, localActiveConvId)

   void getAdminDiagnosticsStatus().then(status => {
     if (!cancelled) setDiagnostics(status)
   })

   void (async () => {
     const cloudConversations = await listAdminConversations()
     if (cancelled) return

     const cloudMessages = await Promise.all(
       cloudConversations.map(async conversation => [
         conversation.id,
         await listAdminMessages(conversation.id),
       ] as const),
     )
     if (cancelled) return

     const cloudIds = new Set(cloudConversations.map(conversation => conversation.id))
     const localConversationsById = new Map(localConversations.map(conversation => [conversation.id, conversation]))
     const mergedCloudConversations = cloudConversations.map(conversation => ({
       id: conversation.id,
       title: conversation.title,
       messages: (() => {
         const localConversation = localConversationsById.get(conversation.id)
         const fetchedMessages = cloudMessages.find(([id]) => id === conversation.id)?.[1] ?? null
         if (fetchedMessages === null) {
           return localConversation?.messages ?? []
         }
         const cloudConversationMessages = fetchedMessages.map(message => ({
           id: message.id,
           role: message.role,
           content: message.content,
           timestamp: message.created_at,
         }))
         if (!localConversation) {
           return cloudConversationMessages
         }
         const cloudMessageIds = new Set(cloudConversationMessages.map(message => message.id))
         const localOnlyMessages = localConversation.messages.filter(message => !cloudMessageIds.has(message.id))
         return [...cloudConversationMessages, ...localOnlyMessages]
           .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
       })(),
       createdAt: conversation.created_at,
     }))
     const localOnlyConversations = localConversations.filter(conversation => !cloudIds.has(conversation.id))
     const mergedConversations = [...mergedCloudConversations, ...localOnlyConversations]
       .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

     const nextConversations = mergedConversations.length > 0
       ? mergedConversations
       : [createConversation()]
     const nextActiveConvId = localActiveConvId && nextConversations.some(conversation => conversation.id === localActiveConvId)
       ? localActiveConvId
       : loadAdminActiveConvId(currentUser.id, nextConversations)

     if (!cancelled) {
       applyConversationState(nextConversations, nextActiveConvId)
     }
   })()

   return () => {
     cancelled = true
    }
  }, [applyConversationState, cancelInFlightRequest, currentUser.id])

  const startNewChat = useCallback(async () => {
   const conversation = createConversation()
   applyConversationState([conversation, ...conversationsRef.current], conversation.id)
   setClearConfirm(false)
   setInputError(null)
   await upsertAdminConversation(conversation.id, conversation.title)
  }, [applyConversationState])

  const selectConversation = useCallback((id: string) => {
   activeConvIdRef.current = id
   setActiveConvId(id)
   saveAdminActiveConvId(currentUser.id, id)
   setClearConfirm(false)
  }, [currentUser.id])

  const clearCurrentChat = useCallback(async () => {
   const conversationId = activeConvIdRef.current
   if (!conversationId) return
   cancelInFlightRequest()
   setIsResetting(true)
   setClearConfirm(false)
   try {
     const didUpsertConversation = await upsertAdminConversation(conversationId, 'New admin chat')
     if (!didUpsertConversation) {
       setInputError('Unable to clear this chat right now. Please try again.')
       return
     }
     const didDeleteMessages = await deleteAdminMessagesForConversation(conversationId)
     if (!didDeleteMessages) {
       setInputError('Unable to clear this chat right now. Please try again.')
       return
     }
     const nextConversations = conversationsRef.current.map(conversation =>
       conversation.id === conversationId
         ? { ...conversation, messages: [], title: 'New admin chat' }
         : conversation,
     )
     applyConversationState(nextConversations, conversationId)
     setInputError(null)
   } finally {
     setIsResetting(false)
   }
  }, [applyConversationState, cancelInFlightRequest])

  const deleteCurrentConversation = useCallback(async () => {
   const conversationId = activeConvIdRef.current
   if (!conversationId) return
   cancelInFlightRequest()
   setIsResetting(true)
   const remainingConversations = conversationsRef.current.filter(
     conversation => conversation.id !== conversationId,
   )
   const fallbackConversation = remainingConversations.length === 0
     ? createConversation()
     : null
   const nextConversations = fallbackConversation
     ? [fallbackConversation]
     : remainingConversations
   const nextActiveConvId = fallbackConversation?.id ?? remainingConversations[0]?.id ?? null
   setClearConfirm(false)
   const didDeleteConversation = await deleteAdminConversation(conversationId)
   if (!didDeleteConversation) {
     setInputError('Unable to delete this conversation right now. Please try again.')
     setIsResetting(false)
     return
   }
   if (fallbackConversation) {
     const didCreateFallbackConversation = await upsertAdminConversation(
       fallbackConversation.id,
       fallbackConversation.title,
     )
     if (!didCreateFallbackConversation) {
       setInputError('Conversation deleted, but creating a replacement chat failed. Please try again.')
     }
   }
   applyConversationState(nextConversations, nextActiveConvId)
   if (!fallbackConversation) {
     setInputError(null)
   }
   setIsResetting(false)
  }, [applyConversationState, cancelInFlightRequest])

  const clearAllChats = useCallback(async () => {
   cancelInFlightRequest()
   setIsResetting(true)
   setClearConfirm(false)
   const didDeleteAllConversations = await deleteAllAdminConversations()
   if (!didDeleteAllConversations) {
     setInputError('Unable to clear admin chats right now. Please try again.')
     setIsResetting(false)
     return
   }
   const replacementConversation = createConversation()
   const didCreateReplacementConversation = await upsertAdminConversation(
     replacementConversation.id,
     replacementConversation.title,
   )
   if (!didCreateReplacementConversation) {
     setInputError('Admin chats were cleared, but creating a replacement chat failed. Please try again.')
     setIsResetting(false)
     return
   }
   applyConversationState([replacementConversation], replacementConversation.id)
   setInputError(null)
   setIsResetting(false)
  }, [applyConversationState, cancelInFlightRequest])

  const sendMessage = useCallback(async () => {
   const trimmed = input.trim()
   if (!trimmed || isBusy) return
   if (textEncoder.encode(trimmed).byteLength > MAX_ADMIN_MESSAGE_BYTES) {
     setInputError(`Message is too large. Keep it under ${MAX_ADMIN_MESSAGE_BYTES} UTF-8 bytes.`)
     return
   }
   setInputError(null)

   const requestVersion = requestVersionRef.current + 1
   requestVersionRef.current = requestVersion

   let convId = activeConvIdRef.current
   let currentConversation = conversationsRef.current.find(conversation => conversation.id === convId) ?? null
   if (!convId) {
     currentConversation = createConversation()
     convId = currentConversation.id
     applyConversationState([currentConversation, ...conversationsRef.current], convId)
   }

   const userMsg: Message = {
     id: genUUID(),
     role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    }

    setInput('')
    setIsThinking(true)
    const userPosition = currentConversation?.messages.length ?? 0
    const nextMessages = [...(currentConversation?.messages ?? []), userMsg]
    const nextTitle = userPosition === 0
      ? titleFromMessages(nextMessages)
      : currentConversation?.title ?? titleFromMessages(nextMessages)
    const updatedConversation: Conversation = {
      ...(currentConversation ?? createConversation()),
      id: convId,
      title: nextTitle,
      messages: nextMessages,
    }
    const nextConversations = conversationsRef.current.some(conversation => conversation.id === convId)
      ? conversationsRef.current.map(conversation =>
          conversation.id === convId ? updatedConversation : conversation,
        )
      : [updatedConversation, ...conversationsRef.current]
    applyConversationState(nextConversations, convId)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await upsertAdminConversation(convId, nextTitle)
      if (requestVersionRef.current !== requestVersion) return

      await insertAdminMessage({
        id: userMsg.id,
        conversation_id: convId,
        role: 'user',
        content: userMsg.content,
        position: userPosition,
      })
      if (requestVersionRef.current !== requestVersion) return

      const result = await callAdminEdgeFunction(
        buildHistoryMessages(nextMessages),
        controller.signal,
      )
      if (requestVersionRef.current !== requestVersion || controller.signal.aborted) return

      const assistantMsg: Message = {
        id: genUUID(),
        role: 'assistant',
        content: result.ok && result.message
          ? result.message
          : result.error ?? 'Admin cloud chat is temporarily unavailable.',
        timestamp: new Date().toISOString(),
      }

      const currentMessages = (
        conversationsRef.current.find(conversation => conversation.id === convId)?.messages
        ?? nextMessages
      )
      const finalConversations = conversationsRef.current.map(conversation =>
        conversation.id === convId
          ? { ...conversation, title: nextTitle, messages: [...currentMessages, assistantMsg] }
          : conversation,
      )
      const selectedConversationId = activeConvIdRef.current
      const nextActiveConvId = selectedConversationId && finalConversations.some(conversation => conversation.id === selectedConversationId)
        ? selectedConversationId
        : convId
      applyConversationState(finalConversations, nextActiveConvId)

      if (result.ok) {
        await upsertAdminConversation(convId, nextTitle)
        if (requestVersionRef.current !== requestVersion) return

        await insertAdminMessage({
          id: assistantMsg.id,
          conversation_id: convId,
          role: 'assistant',
          content: assistantMsg.content,
          position: userPosition + 1,
        })
      }
    } finally {
      if (requestVersionRef.current === requestVersion) {
        abortRef.current = null
        setIsThinking(false)
      }
    }
  }, [applyConversationState, input, isBusy])

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
    <div className="daemon-app admin-daemon-app">
      {sidebarOpen && (
        <nav
          className="daemon-sidebar admin-daemon-sidebar"
          aria-label="Admin Daemon conversation history"
        >
          <div className="sidebar-header admin-daemon-sidebar-header">
            <div className="admin-daemon-brand-wrap">
              <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>Admin Daemon</div>
              <div style={{ fontSize: '0.75rem', color: '#aab', marginTop: '0.2rem' }}>
                Restricted administrative assistant
              </div>
              <div style={{ fontSize: '0.7rem', color: '#889', marginTop: '0.15rem' }}>
                {currentUser.email}
              </div>
            </div>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => updateSidebarOpen(false)}
              aria-label="Close sidebar"
              title="Close sidebar"
            >
              ◀
            </button>
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
          <ul
            aria-label="Admin conversations"
            style={{ flex: 1, overflowY: 'auto', padding: '0.25rem 0.5rem', listStyle: 'none', margin: 0 }}
          >
            {sortedConversations.map(c => (
              <li key={c.id} style={{ marginBottom: '0.2rem' }}>
                <button
                  type="button"
                  onClick={() => selectConversation(c.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.5rem 0.75rem',
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
              </li>
            ))}
          </ul>

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
        </nav>
      )}

      {/* Main chat pane */}
      <main
        className="daemon-main admin-daemon-main"
        aria-label="Admin Daemon chat"
      >
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-reopen admin-daemon-sidebar-reopen"
            onClick={() => updateSidebarOpen(true)}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            ▶
          </button>
        )}
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
              <li>Admin edge function status: not verified by the browser diagnostics</li>
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
            onChange={e => {
              setInput(e.target.value)
              if (inputError) setInputError(null)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Message Admin Daemon…"
            rows={2}
            disabled={isBusy}
            style={{
              flex: 1,
              resize: 'none',
              padding: '0.6rem 0.75rem',
              borderRadius: '8px',
              border: inputError ? '1px solid #c44' : '1px solid #ccc',
              fontSize: '0.9rem',
              lineHeight: 1.5,
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={isBusy || !input.trim()}
            aria-label="Send message"
            style={{
              padding: '0.6rem 1.2rem',
              background: '#1a1a2e',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: isBusy || !input.trim() ? 'not-allowed' : 'pointer',
              opacity: isBusy || !input.trim() ? 0.5 : 1,
              fontSize: '0.9rem',
            }}
          >
            Send
          </button>
        </div>
        {inputError && (
          <p
            role="alert"
            style={{ margin: '0 1.25rem 0.75rem', color: '#c44', fontSize: '0.8rem' }}
          >
            {inputError}
          </p>
        )}
      </main>
    </div>
  )
}
