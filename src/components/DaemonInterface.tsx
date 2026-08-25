import { useState, useRef, useEffect, useCallback } from 'react'
import {
  detectMood,
  detectIntent,
  generateHumanLikeResponse,
} from '../services/daemonResponseBrain'
import type { MemorySnippet, ResponseIntent } from '../services/daemonResponseBrain'
import learningSystem from '../services/daemon_learning_integration'
import {
  saveMemory,
  listMemories,
  forgetLast,
  forgetByText,
  forgetAll,
  retrieveRelevant,
  formatMemoriesForContext,
} from '../services/daemonMemory'
import { callChatAPI, hasBackend, isAPIFailure } from '../services/daemonChatAPI'
import type { APIMessage } from '../services/daemonChatAPI'
import { callEdgeFunction, hasEdgeFunction } from '../services/supabaseEdgeChat'
import {
  isPersistenceConfigured,
  upsertConversation,
  insertMessage,
  insertCloudMemory,
  deleteLastCloudMemory,
  deleteCloudMemoriesByText,
  deleteAllCloudMemories,
  updateLearningFeedback,
  insertLearningInteraction,
  migrateLocalMemoriesToCloud,
  hydrateFromCloud,
  deleteConversation,
  deleteMessagesForConversation,
  listConversations as listCloudConversations,
} from '../services/supabasePersistence'
import type { SyncStatus } from '../services/supabasePersistence'
import { LEGACY_STORAGE_KEYS, loadMigratedStorageItem, runLegacyIdMigration, genUUID } from '../services/daemonStorageMigration'
import { loadSidebarOpen, saveSidebarOpen } from './sidebarPreference'
import {
  loadLocalPreferences,
  loadCloudPreferences,
  toPersonalitySettings,
} from '../services/daemonPersonalityPreferences'
import type { PersonalityPreferences } from '../services/daemonPersonalityPreferences'
import PersonalityPreferencesEditor from './PersonalityPreferencesEditor'
import '../styles/DaemonInterface.css'

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

const MESSAGES_KEY = 'daemon_messages'
const CONVERSATIONS_KEY = 'daemon_conversations'

// Run the one-time legacy-ID migration before any data is read from localStorage.
// This is safe to call at module load; it exits early if already complete.
runLegacyIdMigration()
const MIN_THINKING_DELAY = 600
const MAX_THINKING_DELAY = 1800

function thinkingDelay(text: string): number {
  const words = text.trim().split(/\s+/).length
  const scaled = Math.min(MIN_THINKING_DELAY + words * 40, MAX_THINKING_DELAY)
  const jitter = Math.floor(Math.random() * 300) - 150
  return Math.max(MIN_THINKING_DELAY, scaled + jitter)
}

function loadMessages(): Message[] {
  try {
    const raw = loadMigratedStorageItem(MESSAGES_KEY, LEGACY_STORAGE_KEYS.messages)
    return raw ? (JSON.parse(raw) as Message[]) : []
  } catch {
    return []
  }
}

function saveMessages(messages: Message[]): void {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages))
  } catch { /* quota exceeded – best effort */ }
}

function loadConversations(): Conversation[] {
  try {
    const raw = loadMigratedStorageItem(CONVERSATIONS_KEY, LEGACY_STORAGE_KEYS.conversations)
    return raw ? (JSON.parse(raw) as Conversation[]) : []
  } catch {
    return []
  }
}

function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations))
  } catch { /* quota exceeded – best effort */ }
}

function conversationTitle(messages: Message[]): string {
  const first = messages.find(m => m.role === 'user')
  if (!first) return 'New chat'
  const words = first.content.trim().split(/\s+/)
  const clipped = words.slice(0, 6).join(' ')
  return words.length > 6 ? clipped + '…' : clipped
}

function newUUID(): string {
  return genUUID()
}

const nextId = () => newUUID()

// ---------------------------------------------------------------------------
// Memory command parser
// ---------------------------------------------------------------------------
type MemoryCommand =
  | { type: 'remember'; payload: string }
  | { type: 'forget-last' }
  | { type: 'forget-text'; payload: string }
  | { type: 'forget-all' }
  | { type: 'recall' }

function parseMemoryCommand(text: string): MemoryCommand | null {
  const t = text.trim()
  const rememberMatch = /^remember(?:\s+this)?[:-]?\s*(.+)$/i.exec(t)
  if (rememberMatch) return { type: 'remember', payload: rememberMatch[1].trim() }
  if (/^forget this$/i.test(t)) return { type: 'forget-last' }
  const forgetMatch = /^forget[:-]?\s*(.+)$/i.exec(t)
  if (forgetMatch) {
    if (/^all(?:\s+memories)?$/i.test(forgetMatch[1].trim())) return { type: 'forget-all' }
    return { type: 'forget-text', payload: forgetMatch[1].trim() }
  }
  if (/^(what do you remember|show memories|list memories|recall)\??$/i.test(t)) {
    return { type: 'recall' }
  }
  return null
}

function handleMemoryCommand(cmd: MemoryCommand): string {
  switch (cmd.type) {
    case 'remember': {
      const mem = saveMemory(cmd.payload)
      return 'Got it — I\'ll remember: "' + mem.text + '"'
    }
    case 'forget-last': {
      const removed = forgetLast()
      return removed
        ? 'Forgotten: "' + removed.text + '"'
        : "I don't have any memories to forget right now."
    }
    case 'forget-text': {
      const removed = forgetByText(cmd.payload)
      if (removed.length === 0) return 'I couldn\'t find any memory matching "' + cmd.payload + '".'
      const names = removed.map(m => '"' + m.text + '"').join(', ')
      return 'Forgotten ' + removed.length + ' memor' + (removed.length > 1 ? 'ies' : 'y') + ': ' + names
    }
    case 'forget-all': {
      forgetAll()
      return 'All memories cleared.'
    }
    case 'recall': {
      const mems = listMemories()
      return mems.length === 0
        ? 'I don\'t have any durable memories yet. You can say "remember this: <text>" to add one.'
        : 'Here\'s what I remember:\n\n' + formatMemoriesForContext(mems)
    }
  }
}

const MAX_API_TURNS = 20

// Confidence/ambiguity defaults for local-brain responses recorded to Supabase.
// These are fixed-point estimates: local mode always uses the same rule engine,
// so we record a conservative baseline rather than a dynamically computed score.
const LOCAL_BRAIN_DEFAULT_CONFIDENCE = 0.8
const LOCAL_BRAIN_CLARIFY_AMBIGUITY = 0.6
const LOCAL_BRAIN_DEFAULT_AMBIGUITY = 0.2

function buildAPIHistory(messages: Message[]): APIMessage[] {
  return messages
    .slice(-MAX_API_TURNS * 2)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DaemonInterfaceProps {
  onLoginClick?: () => void
  onLogoutClick?: () => void
  currentUser?: { id?: string; email: string; role?: 'user' | 'admin' | null } | null
}

export default function DaemonInterface({
  onLoginClick,
  onLogoutClick,
  currentUser = null,
}: DaemonInterfaceProps = {}) {
  const currentUserRoleLabel = currentUser?.role === 'admin'
    ? 'Admin'
    : currentUser?.role === 'user'
      ? 'User'
      : 'Unknown'
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen)
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [lastIntent, setLastIntent] = useState<ResponseIntent | undefined>(undefined)
  const [usingBackend, setUsingBackend] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unconfigured')
  const [ratedMessages, setRatedMessages] = useState<Set<string>>(() => new Set())
  const [personalityPrefs, setPersonalityPrefs] = useState<PersonalityPreferences>(() => loadLocalPreferences())
  const [showPreferences, setShowPreferences] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Maps message id → learning interaction id (ephemeral; not persisted across page loads).
  const msgToInteractionRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  useEffect(() => {
    saveSidebarOpen(sidebarOpen)
  }, [sidebarOpen])

  // Update sync status based on configuration and auth state
  useEffect(() => {
    if (!isPersistenceConfigured()) {
      setSyncStatus('unconfigured')
    } else if (!currentUser) {
      setSyncStatus('offline')
    } else {
      setSyncStatus('idle')
    }
  }, [currentUser])

  // One-time local-to-cloud memory migration + cloud hydration when user first signs in
  useEffect(() => {
    if (!isPersistenceConfigured() || !currentUser) return
    const localMems = listMemories()
    void migrateLocalMemoriesToCloud(localMems)
    // Hydrate cloud data into local state non-disruptively
    void (async () => {
      const hydrated = await hydrateFromCloud()
      if (!hydrated) return
      // Merge cloud conversations: add ones not already in local state
      if (hydrated.conversations.length > 0) {
        setConversations(prev => {
          const existingIds = new Set(prev.map(c => c.id))
          const newConvs = hydrated.conversations
            .filter(cc => !existingIds.has(cc.id))
            .map(cc => ({
              id: cc.id,
              title: cc.title,
              messages: (hydrated.messagesByConversation[cc.id] ?? []).map(m => ({
                id: m.id,
                role: m.role,
                content: m.content,
                timestamp: m.created_at,
              })),
              createdAt: cc.created_at,
            }))
          if (newConvs.length === 0) return prev
          const merged = [...newConvs, ...prev]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          saveConversations(merged)
          return merged
        })
      }
    })()
  }, [currentUser])

  // Load cloud personality preferences when the user signs in.
  useEffect(() => {
    if (!currentUser?.id) return
    void loadCloudPreferences(currentUser.id).then(cloud => {
      if (cloud) setPersonalityPrefs(cloud)
    })
  }, [currentUser])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isThinking) return
    setInput('')

    const userMsg: Message = {
      id: nextId(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    }

    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    saveMessages(nextMessages)
    setIsThinking(true)

    const convId = activeConvId ?? nextId()
    if (!activeConvId) setActiveConvId(convId)
    let backendFailedThisTurn = false
    let authErrorThisTurn = false

    try {
      // Check for memory command first
      const memCmd = parseMemoryCommand(text)
      if (memCmd) {
        await new Promise(r => setTimeout(r, 400))
        const responseText = handleMemoryCommand(memCmd)
        // Cloud-persist new memory if user is authenticated
        if (memCmd.type === 'remember' && isPersistenceConfigured() && currentUser) {
          const mems = listMemories()
          const latest = mems[0]
          if (latest) {
            void insertCloudMemory({ id: latest.id, text: latest.text, tags: latest.tags, createdAt: latest.createdAt })
          }
        }
        // Mirror memory deletions to cloud
        if (isPersistenceConfigured() && currentUser) {
          if (memCmd.type === 'forget-last') {
            void deleteLastCloudMemory()
          } else if (memCmd.type === 'forget-text') {
            void deleteCloudMemoriesByText(memCmd.payload)
          } else if (memCmd.type === 'forget-all') {
            void deleteAllCloudMemories()
          }
        }
        const aiMsg: Message = {
          id: nextId(),
          role: 'assistant',
          content: responseText,
          timestamp: new Date().toISOString(),
        }
        const updated = [...nextMessages, aiMsg]
        setMessages(updated)
        saveMessages(updated)
        // Use functional update to avoid stale conversations closure
        setConversations(prev => {
          const existing = prev.find(c => c.id === convId)
          const updatedConv: Conversation = existing
            ? { ...existing, messages: updated }
            : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
          const updatedList = existing
            ? prev.map(c => (c.id === convId ? updatedConv : c))
            : [updatedConv, ...prev]
          saveConversations(updatedList)
          return updatedList
        })
        setIsThinking(false)
        return
      }

      // Try backend first
      const controller = new AbortController()
      abortRef.current = controller

      // 1. Supabase Edge Function (authenticated, rate-limited, no browser API keys)
      if (hasEdgeFunction() && currentUser) {
        const apiHistory = buildAPIHistory(nextMessages)
        const edgeResult = await callEdgeFunction(apiHistory, controller.signal)
        if (typeof edgeResult === 'string') {
          setUsingBackend(true)
          setAuthError(false)
          setSyncStatus('syncing')
          const aiMsg: Message = {
            id: nextId(),
            role: 'assistant',
            content: edgeResult,
            timestamp: new Date().toISOString(),
          }
          const updated = [...nextMessages, aiMsg]
          setMessages(updated)
          saveMessages(updated)
          // Persist to Supabase
          void (async () => {
            try {
              const convResult = await upsertConversation({ id: convId, title: conversationTitle(updated), createdAt: new Date().toISOString() })
              if (!convResult) { setSyncStatus('error'); return }
              const pos = nextMessages.length
              const r1 = await insertMessage({ id: userMsg.id, conversationId: convId, role: 'user', content: userMsg.content, position: pos, createdAt: userMsg.timestamp })
              if (!r1) { setSyncStatus('error'); return }
              const r2 = await insertMessage({ id: aiMsg.id, conversationId: convId, role: 'assistant', content: aiMsg.content, position: pos + 1, createdAt: aiMsg.timestamp })
              if (!r2) { setSyncStatus('error'); return }
              setSyncStatus('synced')
            } catch { setSyncStatus('error') }
          })()
          setConversations(prev => {
            const existing = prev.find(c => c.id === convId)
            const updatedConv: Conversation = existing
              ? { ...existing, messages: updated }
              : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
            const updatedList = existing
              ? prev.map(c => (c.id === convId ? updatedConv : c))
              : [updatedConv, ...prev]
            saveConversations(updatedList)
            return updatedList
          })
          setIsThinking(false)
          abortRef.current = null
          return
        }
        setUsingBackend(false)
        if (controller.signal.aborted || (isAPIFailure(edgeResult) && edgeResult.reason === 'aborted')) {
          setIsThinking(false)
          abortRef.current = null
          return
        }
        if (isAPIFailure(edgeResult) && edgeResult.reason === 'auth') {
          setAuthError(true)
          authErrorThisTurn = true
        }
        backendFailedThisTurn = true
      }

      // 2. Legacy Node API backend (optional self-hosted)
      if (hasBackend() && !backendFailedThisTurn) {
        const apiHistory = buildAPIHistory(nextMessages)
        const backendResult = await callChatAPI(apiHistory, controller.signal)
        if (typeof backendResult === 'string') {
          setUsingBackend(true)
          setAuthError(false)
          const aiMsg: Message = {
            id: nextId(),
            role: 'assistant',
            content: backendResult,
            timestamp: new Date().toISOString(),
          }
          const updated = [...nextMessages, aiMsg]
          setMessages(updated)
          saveMessages(updated)
          setConversations(prev => {
            const existing = prev.find(c => c.id === convId)
            const updatedConv: Conversation = existing
              ? { ...existing, messages: updated }
              : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
            const updatedList = existing
              ? prev.map(c => (c.id === convId ? updatedConv : c))
              : [updatedConv, ...prev]
            saveConversations(updatedList)
            return updatedList
          })
          setIsThinking(false)
          abortRef.current = null
          return
        }
        setUsingBackend(false)
        // User may have cancelled while awaiting the backend response
        if (controller.signal.aborted || (isAPIFailure(backendResult) && backendResult.reason === 'aborted')) {
          setIsThinking(false)
          abortRef.current = null
          return
        }
        if (isAPIFailure(backendResult) && backendResult.reason === 'auth') {
          setAuthError(true)
          authErrorThisTurn = true
        }
        backendFailedThisTurn = true
      }

      // Local brain fallback
      await new Promise(r => setTimeout(r, thinkingDelay(text)))

      const durableMemories = retrieveRelevant(text, 5)
      const legacySnippets: MemorySnippet[] = durableMemories.map(m => ({
        text: m.text,
        relevance: new Date(m.createdAt).getTime(),
      }))

      const mood = detectMood(text)
      const intent = detectIntent(text, lastIntent)
      const wantsShortAnswer = text.trim().split(/\s+/).length <= 5

      const response = generateHumanLikeResponse(text, {
        userMessage: text,
        mood,
        intent,
        memories: legacySnippets.length > 0 ? legacySnippets : undefined,
        wantsShortAnswer,
        lastIntent,
        personality: toPersonalitySettings(personalityPrefs),
      })

      setLastIntent(intent)

      const interactionRecord = learningSystem.recordInteraction(text, response, {
        intent,
        confidence: LOCAL_BRAIN_DEFAULT_CONFIDENCE,
        ambiguity: intent === 'clarify' ? LOCAL_BRAIN_CLARIFY_AMBIGUITY : LOCAL_BRAIN_DEFAULT_AMBIGUITY,
        memoryUsed: legacySnippets.length,
        planComplexity: wantsShortAnswer ? 'simple' : 'moderate',
        timestamp: new Date(),
      })

      const aiMsg: Message = {
        id: nextId(),
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
      }
      const fallbackMsg: Message | null = backendFailedThisTurn
        ? {
            id: nextId(),
            role: 'assistant',
            content: authErrorThisTurn
              ? 'The cloud backend rejected the request (authentication error). Sign in to use cloud chat. Using local mode for this response.'
              : 'The cloud backend is unreachable right now. I used local mode for this response.',
            timestamp: new Date().toISOString(),
          }
        : null
      msgToInteractionRef.current.set(aiMsg.id, interactionRecord.id)

      const updated = fallbackMsg ? [...nextMessages, fallbackMsg, aiMsg] : [...nextMessages, aiMsg]
      setMessages(updated)
      saveMessages(updated)

      // Persist learning interaction and conversation/messages to Supabase when authenticated
      if (isPersistenceConfigured() && currentUser) {
        void insertLearningInteraction({
          id: interactionRecord.id,
          input: text,
          response,
          intent,
          confidence: LOCAL_BRAIN_DEFAULT_CONFIDENCE,
          ambiguity: intent === 'clarify' ? LOCAL_BRAIN_CLARIFY_AMBIGUITY : LOCAL_BRAIN_DEFAULT_AMBIGUITY,
          memoryUsed: legacySnippets.length,
          planComplexity: wantsShortAnswer ? 'simple' : 'moderate',
          createdAt: new Date().toISOString(),
        })
        setSyncStatus('syncing')
        void (async () => {
          try {
            const convResult = await upsertConversation({ id: convId, title: conversationTitle(updated), createdAt: new Date().toISOString() })
            if (!convResult) { setSyncStatus('error'); return }
            const pos = nextMessages.length
            const r1 = await insertMessage({ id: userMsg.id, conversationId: convId, role: 'user', content: userMsg.content, position: pos, createdAt: userMsg.timestamp })
            if (!r1) { setSyncStatus('error'); return }
            const r2 = await insertMessage({ id: aiMsg.id, conversationId: convId, role: 'assistant', content: aiMsg.content, position: pos + 1, createdAt: aiMsg.timestamp })
            if (!r2) { setSyncStatus('error'); return }
            setSyncStatus('synced')
          } catch { setSyncStatus('error') }
        })()
      }

      setConversations(prev => {
        const existing = prev.find(c => c.id === convId)
        const updatedConv: Conversation = existing
          ? { ...existing, messages: updated }
          : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
        const updatedList = existing
          ? prev.map(c => (c.id === convId ? updatedConv : c))
          : [updatedConv, ...prev]
        saveConversations(updatedList)
        return updatedList
      })
      setIsThinking(false)
      abortRef.current = null
    } catch (err) {
      // Ensure the UI is never permanently frozen if an unexpected error occurs
      console.error('[daemon] Unexpected error in handleSend:', (err as Error).message)
      setIsThinking(false)
      abortRef.current = null
    }
  }, [input, isThinking, messages, activeConvId, lastIntent])

  const handleCancel = useCallback(() => {
    abortRef.current?.abort()
    setIsThinking(false)
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const handleClearAllChats = () => {
    abortRef.current?.abort()
    setMessages([])
    setActiveConvId(null)
    setLastIntent(undefined)
    setIsThinking(false)
    setConversations([])
    setRatedMessages(new Set())
    abortRef.current = null
    try {
      localStorage.removeItem(MESSAGES_KEY)
      localStorage.removeItem(CONVERSATIONS_KEY)
    } catch {
      // best-effort only; UI state is already reset in-memory
    }
    learningSystem.clearHistory()
    // Durable memories are intentionally preserved. Use "forget all memories" to erase them.
    // Mirror all conversation/message deletions to Supabase when authenticated
    if (isPersistenceConfigured() && currentUser) {
      setSyncStatus('syncing')
      void (async () => {
        try {
          const cloudConvs = await listCloudConversations()
          if (cloudConvs) {
            const results = await Promise.all(
              cloudConvs.map(async c => {
                const r1 = await deleteMessagesForConversation(c.id)
                const r2 = await deleteConversation(c.id)
                return r1 && r2
              })
            )
            setSyncStatus(results.every(Boolean) ? 'synced' : 'error')
          } else {
            setSyncStatus('error')
          }
        } catch {
          setSyncStatus('error')
        }
      })()
    }
  }

  const handleClearCurrentChat = () => {
    if (!activeConvId) return
    abortRef.current?.abort()
    abortRef.current = null
    setIsThinking(false)

    setConversations(prev => {
      const remaining = prev.filter(c => c.id !== activeConvId)
      saveConversations(remaining)
      if (remaining.length > 0) {
        const next = remaining[0]
        setActiveConvId(next.id)
        setMessages(next.messages)
        saveMessages(next.messages)
      } else {
        setActiveConvId(null)
        setMessages([])
        saveMessages([])
      }
      return remaining
    })
    // Mirror deletion to Supabase when authenticated
    if (isPersistenceConfigured() && currentUser) {
      const convIdToDelete = activeConvId
      setSyncStatus('syncing')
      void (async () => {
        try {
          const r1 = await deleteMessagesForConversation(convIdToDelete)
          const r2 = await deleteConversation(convIdToDelete)
          setSyncStatus(r1 && r2 ? 'synced' : 'error')
        } catch {
          setSyncStatus('error')
        }
      })()
    }
  }

  const handleNewChat = () => {
    // Start a blank conversation while preserving the conversation history in the sidebar.
    // Use handleClearAllChats instead if you want to wipe everything.
    setMessages([])
    setActiveConvId(null)
    setLastIntent(undefined)
    saveMessages([])
    // Persist the current conversation list so it survives page reload.
    setConversations(prev => {
      saveConversations(prev)
      return prev
    })
  }

  const handleSelectConversation = (conv: Conversation) => {
    setMessages(conv.messages)
    setActiveConvId(conv.id)
    saveMessages(conv.messages)
  }

  const insights = learningSystem.getLearningInsights()

  return (
    <div className="daemon-app">
      {sidebarOpen && (
        <nav className="daemon-sidebar" aria-label="Conversation history">
          <div className="sidebar-header">
            <div className="daemon-brand">
              <span className="daemon-logo" aria-hidden="true">🧠</span>
              <span>Daemon</span>
            </div>
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              ◀
            </button>
          </div>

          <button type="button" className="new-chat-btn" onClick={handleNewChat}>
            + New chat
          </button>

          <div className="sidebar-chat-actions">
            <button
              type="button"
              className="clear-current-btn"
              onClick={handleClearCurrentChat}
              disabled={!activeConvId}
              aria-label={activeConvId ? 'Clear current chat' : 'No active chat to clear'}
              title={activeConvId ? 'Delete only the current conversation' : 'No active conversation selected'}
            >
              Clear current chat
            </button>
            <button
              type="button"
              className="clear-all-btn"
              onClick={handleClearAllChats}
              aria-label="Clear all chats"
              title="Delete all conversations and history (durable memories are preserved)"
            >
              Clear all chats
            </button>
          </div>

          <ul className="conversation-list">
            {conversations.length === 0 ? (
              <li className="no-conversations">No conversations yet</li>
            ) : (
              conversations.map(conv => (
                <li key={conv.id} className="conversation-list-item">
                  <button
                    type="button"
                    className={'conversation-item ' + (conv.id === activeConvId ? 'active' : '')}
                    onClick={() => handleSelectConversation(conv)}
                    title={conv.title}
                  >
                    <span className="conv-icon" aria-hidden="true">💬</span>
                    <span className="conv-title">{conv.title}</span>
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="analytics-panel" aria-label="Usage stats">
            <p className="analytics-title">Stats</p>
            <div className="analytics-grid">
              <div
                className="stat-item"
                title="Total turns recorded across all sessions (resets when you use Clear All)"
              >
                <span className="stat-value">{insights.totalInteractions}</span>
                <span className="stat-label">Turns</span>
              </div>
              <div className="stat-item">
                <span className="stat-value">{conversations.length}</span>
                <span className="stat-label">Chats</span>
              </div>
            </div>
            {hasBackend() && (
              <p
                className="backend-badge"
                title={
                  authError
                    ? 'Authentication error — sign in to use cloud chat'
                    : messages.length === 0
                      ? 'Cloud mode configured — will activate on first message'
                      : usingBackend
                        ? 'Responses from cloud model'
                        : 'Using local brain'
                }
                aria-label={
                  authError
                    ? 'Cloud auth error'
                    : messages.length === 0
                      ? 'Cloud mode configured'
                      : usingBackend
                        ? 'Cloud mode active'
                        : 'Local mode active'
                }
              >
                <span aria-hidden="true">
                  {authError ? '⚠️' : usingBackend || messages.length === 0 ? '☁️' : '🖥️'}
                </span>
                {' '}
                {authError
                  ? 'Auth error'
                  : usingBackend
                    ? 'Cloud'
                    : messages.length === 0
                      ? 'Cloud (ready)'
                      : 'Local'}
              </p>
            )}
            <p
              className="sync-badge"
              aria-label={
                syncStatus === 'unconfigured'
                  ? 'Supabase not configured — data stored locally only'
                  : syncStatus === 'offline'
                    ? 'Sign in to sync data to your account'
                    : syncStatus === 'syncing'
                      ? 'Syncing data to your account…'
                      : syncStatus === 'synced'
                        ? 'Data synced to your account'
                        : syncStatus === 'error'
                          ? 'Sync error — data saved locally'
                          : 'Ready to sync'
              }
              title={
                syncStatus === 'unconfigured'
                  ? 'Supabase not configured. All data is stored in browser only.'
                  : syncStatus === 'offline'
                    ? 'Sign in to enable cloud sync.'
                    : syncStatus === 'syncing'
                      ? 'Saving to your Supabase account…'
                      : syncStatus === 'synced'
                        ? 'Conversation saved to cloud.'
                        : syncStatus === 'error'
                          ? 'Cloud sync failed. Data saved locally.'
                          : 'Cloud sync ready.'
              }
            >
              <span aria-hidden="true">
                {syncStatus === 'unconfigured' ? '💾' : syncStatus === 'offline' ? '🔒' : syncStatus === 'syncing' ? '⏳' : syncStatus === 'synced' ? '✅' : syncStatus === 'error' ? '⚠️' : '☁️'}
              </span>
              {' '}
              {syncStatus === 'unconfigured'
                ? 'Local only'
                : syncStatus === 'offline'
                  ? 'Sign in to sync'
                  : syncStatus === 'syncing'
                    ? 'Syncing…'
                    : syncStatus === 'synced'
                      ? 'Synced'
                      : syncStatus === 'error'
                        ? 'Sync error'
                        : 'Sync ready'}
            </p>
          </div>
          <div className="sidebar-preferences">
            <button
              type="button"
              className="preferences-open-btn"
              onClick={() => setShowPreferences(true)}
              aria-label="Open personality preferences"
              title="Edit Daemon's communication style for your account"
            >
              ⚙ Preferences
            </button>
          </div>
        </nav>
      )}

      {showPreferences && (
        <div className="preferences-overlay" role="presentation">
          <PersonalityPreferencesEditor
            userId={currentUser?.id ?? null}
            onClose={() => setShowPreferences(false)}
            onSaved={saved => {
              setPersonalityPrefs(saved)
              setShowPreferences(false)
            }}
          />
        </div>
      )}

      <main className="daemon-main">
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-reopen"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            title="Open sidebar"
          >
            ▶
          </button>
        )}
        <header className="daemon-header">
          <div className="header-title">
            <span className="daemon-logo-sm" aria-hidden="true">🧠</span>
            <span>Daemon</span>
          </div>
          <div className="header-actions">
            {onLoginClick && (
              currentUser ? (
                <>
                  <span className="account-label" aria-label={`Signed in as ${currentUser.email}`}>
                    {currentUser.email}
                  </span>
                  <span
                    className="account-role-label"
                    aria-label={`Account role ${currentUserRoleLabel.toLowerCase()}`}
                  >
                    Role: {currentUserRoleLabel}
                  </span>
                  {onLogoutClick && (
                    <button
                      type="button"
                      className="login-btn"
                      onClick={onLogoutClick}
                      aria-label="Log out"
                      title="Log out"
                    >
                      Log out
                    </button>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="login-btn"
                  onClick={onLoginClick}
                  aria-label="Log in"
                  title="Log in"
                >
                  Log in
                </button>
              )
            )}
          </div>
        </header>

        <div className="chat-area">
          <div
            className="messages-container"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
            aria-busy={isThinking}
          >
            {messages.length === 0 && !isThinking && (
              <div className="welcome-screen">
                <div className="welcome-content">
                  <div className="welcome-icon" aria-hidden="true">🧠</div>
                  <h1>Hello, I'm Daemon</h1>
                  <p>Your adaptive AI assistant. Say something to begin.</p>
                  <p className="welcome-hint">
                    Try: <em>"remember this: I prefer concise answers"</em><br />
                    Or: <em>"what do you remember?"</em>
                  </p>
                </div>
              </div>
            )}

            {messages.map(msg => (
              <div
                key={msg.id}
                className={'message-row ' + (msg.role === 'user' ? 'user-row' : 'assistant-row')}
              >
                <div className="message-avatar" aria-hidden="true">{msg.role === 'user' ? '👤' : '🧠'}</div>
                <div className="message-body">
                  <div className={'bubble ' + (msg.role === 'user' ? 'user-bubble' : 'assistant-bubble')}>
                    <div className="bubble-text">{msg.content}</div>
                  </div>
                  <div className="message-footer">
                    <span className="message-time">
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {msg.role === 'assistant' && msgToInteractionRef.current.has(msg.id) && (
                      ratedMessages.has(msg.id) ? (
                        <span className="feedback-given">Thanks!</span>
                      ) : (
                        <span className="feedback-controls" aria-label="Rate this response">
                          <button
                            type="button"
                            className="feedback-btn"
                            aria-label="Helpful"
                            onClick={() => {
                              const interactionId = msgToInteractionRef.current.get(msg.id)
                              if (interactionId) {
                                learningSystem.processFeedback(interactionId, 'helpful')
                                if (isPersistenceConfigured() && currentUser) {
                                  void updateLearningFeedback(interactionId, 'helpful')
                                }
                              }
                              setRatedMessages(prev => new Set(prev).add(msg.id))
                            }}
                          ><span aria-hidden="true">👍</span></button>
                          <button
                            type="button"
                            className="feedback-btn"
                            aria-label="Not helpful"
                            onClick={() => {
                              const interactionId = msgToInteractionRef.current.get(msg.id)
                              if (interactionId) {
                                learningSystem.processFeedback(interactionId, 'unhelpful')
                                if (isPersistenceConfigured() && currentUser) {
                                  void updateLearningFeedback(interactionId, 'unhelpful')
                                }
                              }
                              setRatedMessages(prev => new Set(prev).add(msg.id))
                            }}
                          ><span aria-hidden="true">👎</span></button>
                        </span>
                      )
                    )}
                  </div>
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="message-row assistant-row">
                <div className="message-avatar" aria-hidden="true">🧠</div>
                <div className="message-body">
                  <div className="bubble assistant-bubble">
                    <div className="typing-indicator" aria-label="Daemon is typing">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={handleCancel}
                    aria-label="Cancel response"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          <div className="input-area">
            <textarea
              ref={textareaRef}
              className="daemon-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message Daemon…"
              aria-label="Message input"
              disabled={isThinking}
              rows={1}
            />
            <button
              type="button"
              className="send-btn"
              onClick={() => void handleSend()}
              disabled={isThinking || !input.trim()}
              aria-label="Send message"
            >
              Send
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}
