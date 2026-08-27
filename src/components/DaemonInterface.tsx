import { useState, useRef, useEffect, useCallback } from 'react'
import {
  detectMood,
  detectIntent,
  generateHumanLikeResponse,
} from '../services/daemonResponseBrain'
import type { MemorySnippet, ResponseIntent } from '../services/daemonResponseBrain'
import { selectStrategy, attributeFeedback } from '../services/daemonResponsePolicy'
import type { ResponseStrategy } from '../services/daemonResponsePolicy'
import { retrieveRelevantMemories } from '../services/daemonMemoryRetrieval'
import { routeRequest, classifyComplexity, extractTaskKeywords } from '../services/daemonCapabilityRouter'
import { getAdaptiveProfile } from '../services/daemonAdaptiveProfile'
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
import {
  callEdgeFunction,
  createEdgeChatFailure,
  getSafeEdgeFallbackMessage,
  hasEdgeFunction,
  isEdgeChatFailure,
} from '../services/supabaseEdgeChat'
import type {
  EdgeChatFailure,
  EdgeChatFailureCategory,
  SafeEdgeFunctionErrorCode,
} from '../services/supabaseEdgeChat'
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
  deleteCloudConversation,
  deleteAllCloudConversations,
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
import SupabaseProjectAccessPanel from './SupabaseProjectAccessPanel'
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
// Persists which conversation is currently open so reloads restore the same chat.
const ACTIVE_CONV_KEY = 'daemon_active_conv_id'

function sortConversationsByMostRecent(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
}

function loadActiveConvId(conversations: Conversation[]): string | null {
  try {
    const saved = localStorage.getItem(ACTIVE_CONV_KEY)
    if (saved) {
      // Validate: the stored ID must still exist in the conversation list.
      if (conversations.some(c => c.id === saved)) return saved
    }
  } catch { /* best-effort */ }
  // Fallback: pick the most-recently-created conversation so the pane is never
  // unexpectedly blank after a reload when history already exists.
  if (conversations.length === 0) return null
  const sorted = sortConversationsByMostRecent(conversations)
  return sorted[0].id
}

function saveActiveConvId(id: string | null): void {
  try {
    if (id === null) {
      localStorage.removeItem(ACTIVE_CONV_KEY)
    } else {
      localStorage.setItem(ACTIVE_CONV_KEY, id)
    }
  } catch { /* best-effort */ }
}

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
const CLOUD_CHAT_DOCS_URL = 'https://github.com/dmankv/Project-HELEN/blob/main/DEPLOYMENT.md#cloud-chat-diagnostics'

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
  onAdminDaemonClick?: () => void
  currentUser?: { id?: string; email: string; role?: 'user' | 'admin' | null } | null
}

type CloudAttemptStatus = 'success' | 'fallback' | 'cancelled'

interface CloudAttemptRecord {
  status: CloudAttemptStatus
  mode: 'cloud' | 'local'
  category?: EdgeChatFailureCategory
  statusCode?: number
  safeCode?: SafeEdgeFunctionErrorCode
  timestamp: string
}

function formatCloudAttempt(record: CloudAttemptRecord | null): string {
  if (!record) return 'No cloud-chat attempt recorded in this session.'
  const details: string[] = [record.status, record.mode]
  if (record.category) details.push(record.category)
  if (typeof record.statusCode === 'number') details.push(`HTTP ${record.statusCode}`)
  if (record.safeCode) details.push(record.safeCode)
  return `${details.join(' · ')} · ${record.timestamp}`
}

function buildSafeDiagnosticsPayload(
  currentUser: DaemonInterfaceProps['currentUser'],
  usingBackend: boolean,
  lastCloudAttempt: CloudAttemptRecord | null,
): string {
  return [
    'cloud_chat_diagnostics',
    `frontend_config=${hasEdgeFunction() ? 'present' : 'missing'}`,
    `session=${currentUser ? 'present' : 'missing'}`,
    `current_backend_mode=${usingBackend ? 'cloud' : 'local'}`,
    `last_attempt_status=${lastCloudAttempt?.status ?? 'none'}`,
    `last_attempt_category=${lastCloudAttempt?.category ?? 'none'}`,
    `last_attempt_status_code=${typeof lastCloudAttempt?.statusCode === 'number' ? String(lastCloudAttempt.statusCode) : 'none'}`,
    `last_attempt_code=${lastCloudAttempt?.safeCode ?? 'none'}`,
    `last_attempt_time=${lastCloudAttempt?.timestamp ?? 'none'}`,
    `docs=${CLOUD_CHAT_DOCS_URL}`,
  ].join('\n')
}

export default function DaemonInterface({
  onLoginClick,
  onLogoutClick,
  onAdminDaemonClick,
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
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  // Restore the previously-active conversation so that the next send appends to
  // it rather than creating a new one. Null only when no history exists or the
  // user explicitly started a new chat via "+ New chat".
  // `conversations` above is already the result of loadConversations(), so we
  // re-use it here to avoid a second localStorage parse.
  const [activeConvId, setActiveConvId] = useState<string | null>(() => loadActiveConvId(conversations))
  const [lastIntent, setLastIntent] = useState<ResponseIntent | undefined>(undefined)
  const [usingBackend, setUsingBackend] = useState(false)
  const [authError, setAuthError] = useState(false)
  const [lastCloudAttempt, setLastCloudAttempt] = useState<CloudAttemptRecord | null>(null)
  const [copyDiagnosticsStatus, setCopyDiagnosticsStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('unconfigured')
  const [ratedMessages, setRatedMessages] = useState<Set<string>>(() => new Set())
  const [personalityPrefs, setPersonalityPrefs] = useState<PersonalityPreferences>(() => loadLocalPreferences())
  const [showPreferences, setShowPreferences] = useState(false)
  const [projectLogContext, setProjectLogContext] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  const conversationsRef = useRef(conversations)
  const activeConvIdRef = useRef(activeConvId)
  // Maps message id → learning interaction id (ephemeral; not persisted across page loads).
  const msgToInteractionRef = useRef<Map<string, string>>(new Map())
  // Maps an assistant message to the approved strategy that produced it, so
  // thumbs-up/down feedback is attributed to the right strategy.
  const msgToStrategyRef = useRef<Map<string, { strategy: ResponseStrategy; contextKey: string }>>(new Map())

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  useEffect(() => {
    activeConvIdRef.current = activeConvId
  }, [activeConvId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  useEffect(() => {
    saveSidebarOpen(sidebarOpen)
  }, [sidebarOpen])

  // A selected log context is ephemeral: it can be used in one Edge Function
  // request and is discarded after five minutes even if the user never sends.
  useEffect(() => {
    if (!projectLogContext) return
    const timer = window.setTimeout(() => setProjectLogContext(null), 5 * 60 * 1000)
    return () => window.clearTimeout(timer)
  }, [projectLogContext])

  // Persist the active conversation ID so reloads restore the same chat.
  useEffect(() => {
    saveActiveConvId(activeConvId)
  }, [activeConvId])

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
      // Merge cloud conversations: add ones not already in local state.
      // Strategy: cloud data is additive — we never replace or clear local
      // conversations, and we never reset the currently-active conversation
      // (activeConvId). A user who is actively chatting should not have their
      // pane hijacked by a cloud sync. The activeConvId is intentionally left
      // unchanged here; it was set deterministically on initial load from
      // localStorage (or from the most-recently-created conversation).
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

  const setConversationView = useCallback((nextConversations: Conversation[], nextActiveConvId: string | null) => {
    const nextMessages = nextActiveConvId
      ? nextConversations.find(conv => conv.id === nextActiveConvId)?.messages ?? []
      : []
    conversationsRef.current = nextConversations
    activeConvIdRef.current = nextActiveConvId
    messagesRef.current = nextMessages
    setConversations(nextConversations)
    setActiveConvId(nextActiveConvId)
    setMessages(nextMessages)
    saveConversations(nextConversations)
    saveActiveConvId(nextActiveConvId)
    saveMessages(nextMessages)
  }, [])

  const persistConversationMessages = useCallback((
    convId: string,
    nextMessages: Message[],
    options?: { syncVisiblePane?: boolean },
  ) => {
    const existing = conversationsRef.current.find(conv => conv.id === convId)
    const updatedConv: Conversation = existing
      ? { ...existing, messages: nextMessages }
      : { id: convId, title: conversationTitle(nextMessages), messages: nextMessages, createdAt: new Date().toISOString() }
    const nextConversations = existing
      ? conversationsRef.current.map(conv => (conv.id === convId ? updatedConv : conv))
      : [updatedConv, ...conversationsRef.current]
    conversationsRef.current = nextConversations
    setConversations(nextConversations)
    saveConversations(nextConversations)
    if (options?.syncVisiblePane) {
      activeConvIdRef.current = convId
      messagesRef.current = nextMessages
      setActiveConvId(convId)
      setMessages(nextMessages)
      saveMessages(nextMessages)
    } else if (activeConvIdRef.current === convId) {
      messagesRef.current = nextMessages
      setMessages(nextMessages)
      saveMessages(nextMessages)
    }
    return nextConversations
  }, [])

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

    const currentMessages = messagesRef.current
    const nextMessages = [...currentMessages, userMsg]
    setMessages(nextMessages)
    saveMessages(nextMessages)
    messagesRef.current = nextMessages
    setIsThinking(true)

    const currentActiveConvId = activeConvIdRef.current
    const convId = currentActiveConvId ?? nextId()
    if (!currentActiveConvId) {
      activeConvIdRef.current = convId
      setActiveConvId(convId)
    }
    let backendFailedThisTurn = false
    let cloudFailureForFallback: EdgeChatFailure | null = null

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
        persistConversationMessages(convId, updated)
        setIsThinking(false)
        return
      }

      // Try backend first
      const controller = new AbortController()
      abortRef.current = controller

      // Adaptive layer: classify the turn once and reuse the selected strategy
      // for both the cloud request and the local fallback.
      const adaptiveProfile = getAdaptiveProfile()
      const mood = detectMood(text)
      const intent = detectIntent(text, lastIntent)
      const complexity = classifyComplexity(text, intent)
      const routing = routeRequest({
        intent,
        mood,
        complexity,
        isAuthenticated: Boolean(currentUser),
        isOnline: typeof navigator === 'undefined' || navigator.onLine !== false,
        cloudAvailable: hasEdgeFunction() || hasBackend(),
        privacyOptOut: false,
        taskKeywords: extractTaskKeywords(text),
      })
      const selection = selectStrategy(intent, mood, adaptiveProfile, personalityPrefs)

      // 1. Supabase Edge Function (authenticated, rate-limited, no browser API keys)
      // Project logs can only be attached once after an explicit user selection.
      // They are never persisted with the conversation or sent to the legacy API.
      const diagnosticContext = projectLogContext ?? undefined
      if (!hasBackend() && !hasEdgeFunction()) {
        cloudFailureForFallback = createEdgeChatFailure('not-configured')
      } else if (hasEdgeFunction() && !currentUser && !hasBackend()) {
        cloudFailureForFallback = createEdgeChatFailure('not-signed-in')
      }

      if (hasEdgeFunction() && currentUser) {
        const apiHistory = buildAPIHistory(nextMessages)
        // Clear only when this request actually dispatches the selected context
        // to the Supabase Edge Function. Local/legacy fallback leaves it queued.
        if (diagnosticContext) setProjectLogContext(null)
        const edgeResult = await callEdgeFunction(apiHistory, controller.signal, {
          strategy: selection.strategy,
          contextKey: selection.contextKey,
        }, diagnosticContext)
        if (typeof edgeResult === 'string') {
          setUsingBackend(true)
          setAuthError(false)
          setLastCloudAttempt({
            status: 'success',
            mode: 'cloud',
            timestamp: new Date().toISOString(),
          })
          setSyncStatus('syncing')
          const aiMsg: Message = {
            id: nextId(),
            role: 'assistant',
            content: edgeResult,
            timestamp: new Date().toISOString(),
          }
          msgToStrategyRef.current.set(aiMsg.id, { strategy: selection.strategy, contextKey: selection.contextKey })
          const updated = [...nextMessages, aiMsg]
          persistConversationMessages(convId, updated)
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
          setIsThinking(false)
          abortRef.current = null
          return
        }
        setUsingBackend(false)
        if (controller.signal.aborted || (isEdgeChatFailure(edgeResult) && edgeResult.category === 'aborted')) {
          setLastCloudAttempt({
            status: 'cancelled',
            mode: 'local',
            category: 'aborted',
            timestamp: new Date().toISOString(),
          })
          setIsThinking(false)
          abortRef.current = null
          return
        }
        if (isEdgeChatFailure(edgeResult) && (edgeResult.category === 'auth' || edgeResult.category === 'not-signed-in')) {
          setAuthError(true)
        } else {
          setAuthError(false)
        }
        cloudFailureForFallback = isEdgeChatFailure(edgeResult) ? edgeResult : createEdgeChatFailure('server')
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
          persistConversationMessages(convId, updated)
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
        }
        backendFailedThisTurn = true
      }

      // Local brain fallback
      await new Promise(r => setTimeout(r, thinkingDelay(text)))

      const durableMemories = retrieveRelevant(text, 5)

      // Bounded, provenance-tagged context retrieval.
      const retrieved = retrieveRelevantMemories(text, durableMemories, adaptiveProfile)
      const legacySnippets: MemorySnippet[] = retrieved
        .filter(m => m.type === 'explicit')
        .map(m => ({ text: m.text, relevance: m.relevanceScore }))

      const wantsShortAnswer = text.trim().split(/\s+/).length <= 5
        || selection.strategy === 'concise-action-plan'

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
        memoryUsed: retrieved.length,
        planComplexity: complexity,
        timestamp: new Date(),
        strategy: selection.strategy,
        contextKey: selection.contextKey,
        routingMode: routing.mode,
        routingReason: routing.reason,
      })

      const aiMsg: Message = {
        id: nextId(),
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
      }
      const fallbackText = cloudFailureForFallback
        ? getSafeEdgeFallbackMessage(cloudFailureForFallback)
        : backendFailedThisTurn
          ? 'The configured backend is unavailable. I used local mode for this response.'
          : null
      if (fallbackText && cloudFailureForFallback) {
        setLastCloudAttempt({
          status: 'fallback',
          mode: 'local',
          category: cloudFailureForFallback.category,
          statusCode: cloudFailureForFallback.status,
          safeCode: cloudFailureForFallback.safeCode,
          timestamp: new Date().toISOString(),
        })
      }
      const fallbackMsg: Message | null = fallbackText
        ? {
            id: nextId(),
            role: 'assistant',
            content: fallbackText,
            timestamp: new Date().toISOString(),
          }
        : null
      msgToInteractionRef.current.set(aiMsg.id, interactionRecord.id)
      msgToStrategyRef.current.set(aiMsg.id, { strategy: selection.strategy, contextKey: selection.contextKey })

      const updated = fallbackMsg ? [...nextMessages, fallbackMsg, aiMsg] : [...nextMessages, aiMsg]
      persistConversationMessages(convId, updated)

      // Persist learning interaction and conversation/messages to Supabase when authenticated
      if (isPersistenceConfigured() && currentUser) {
        void insertLearningInteraction({
          id: interactionRecord.id,
          input: text,
          response,
          intent,
          confidence: LOCAL_BRAIN_DEFAULT_CONFIDENCE,
          ambiguity: intent === 'clarify' ? LOCAL_BRAIN_CLARIFY_AMBIGUITY : LOCAL_BRAIN_DEFAULT_AMBIGUITY,
          memoryUsed: retrieved.length,
          planComplexity: complexity,
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
      setIsThinking(false)
      abortRef.current = null
    } catch (err) {
      // Ensure the UI is never permanently frozen if an unexpected error occurs
      console.error('[daemon] Unexpected error in handleSend:', (err as Error).message)
      setIsThinking(false)
      abortRef.current = null
    }
  }, [input, isThinking, lastIntent, persistConversationMessages, currentUser, personalityPrefs, projectLogContext])

  const handleCopySafeDiagnostics = useCallback(async () => {
    const payload = buildSafeDiagnosticsPayload(currentUser, usingBackend, lastCloudAttempt)
    try {
      await navigator.clipboard.writeText(payload)
      setCopyDiagnosticsStatus('copied')
    } catch {
      setCopyDiagnosticsStatus('failed')
    }
  }, [currentUser, usingBackend, lastCloudAttempt])

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
    conversationsRef.current = []
    activeConvIdRef.current = null
    messagesRef.current = []
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
      localStorage.removeItem(ACTIVE_CONV_KEY)
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
          const deleted = await deleteAllCloudConversations()
          setSyncStatus(deleted ? 'synced' : 'error')
        } catch {
          setSyncStatus('error')
        }
      })()
    }
  }

  const handleClearCurrentChat = () => {
    const currentActiveConvId = activeConvIdRef.current
    if (!currentActiveConvId) return
    // Capture the ID immediately so all downstream logic uses the same value,
    // regardless of async state batching or React strict-mode double-invocation.
    const convIdToDelete = currentActiveConvId

    abortRef.current?.abort()
    abortRef.current = null
    setIsThinking(false)

    // Compute updated list from current state before any setters fire.
    const remaining = conversationsRef.current.filter(c => c.id !== convIdToDelete)
    const nextActiveConvId = loadActiveConvId(remaining)
    setConversationView(remaining, nextActiveConvId)

    // Mirror deletion to Supabase when authenticated
    if (isPersistenceConfigured() && currentUser) {
      setSyncStatus('syncing')
      void (async () => {
        try {
          const deleted = await deleteCloudConversation(convIdToDelete)
          setSyncStatus(deleted ? 'synced' : 'error')
        } catch {
          setSyncStatus('error')
        }
      })()
    }
  }

  const handleNewChat = () => {
    // Start a blank conversation while preserving the conversation history in the sidebar.
    // Use handleClearAllChats instead if you want to wipe everything.
    activeConvIdRef.current = null
    messagesRef.current = []
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
    const current = conversationsRef.current.find(existing => existing.id === conv.id) ?? conv
    activeConvIdRef.current = current.id
    messagesRef.current = current.messages
    setMessages(current.messages)
    setActiveConvId(current.id)
    saveMessages(current.messages)
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
            {(hasBackend() || hasEdgeFunction()) && (
              <p
                className="backend-badge"
                title={
                  lastCloudAttempt?.category === 'not-signed-in'
                    ? 'Cloud chat is available after sign-in'
                    : authError
                    ? 'Authentication error — sign in to use cloud chat'
                    : messages.length === 0
                      ? 'Cloud mode configured — will activate on first message'
                      : usingBackend
                        ? 'Responses from cloud model'
                        : 'Using local brain'
                }
                aria-label={
                  lastCloudAttempt?.category === 'not-signed-in'
                    ? 'Cloud sign-in required'
                    : authError
                    ? 'Cloud auth error'
                    : messages.length === 0
                      ? 'Cloud mode configured'
                      : usingBackend
                        ? 'Cloud mode active'
                        : 'Local mode active'
                }
              >
                <span aria-hidden="true">
                  {lastCloudAttempt?.category === 'not-signed-in' || authError ? '⚠️' : usingBackend || messages.length === 0 ? '☁️' : '🖥️'}
                </span>
                {' '}
                {lastCloudAttempt?.category === 'not-signed-in'
                  ? 'Sign in for cloud'
                  : authError
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
            {currentUser?.role === 'admin' && (
              <details className="admin-diagnostics" aria-label="Admin cloud diagnostics">
                <summary>Admin cloud diagnostics</summary>
                <ul className="admin-diagnostics-list">
                  <li><strong>Frontend config:</strong> {hasEdgeFunction() ? 'Present' : 'Missing'}</li>
                  <li><strong>Current session:</strong> {currentUser ? 'Present' : 'Missing'}</li>
                  <li><strong>Backend mode:</strong> {usingBackend ? 'Cloud' : 'Local'}</li>
                  <li><strong>Latest cloud attempt:</strong> {formatCloudAttempt(lastCloudAttempt)}</li>
                </ul>
                <div className="admin-diagnostics-actions">
                  <button
                    type="button"
                    className="diagnostics-copy-btn"
                    onClick={() => void handleCopySafeDiagnostics()}
                  >
                    Copy safe diagnostics
                  </button>
                  <a
                    className="diagnostics-link"
                    href={CLOUD_CHAT_DOCS_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Troubleshooting guide
                  </a>
                </div>
                <p className="admin-diagnostics-copy-status" aria-live="polite">
                  {copyDiagnosticsStatus === 'copied'
                    ? 'Safe diagnostics copied.'
                    : copyDiagnosticsStatus === 'failed'
                      ? 'Unable to copy safe diagnostics.'
                      : ''}
                </p>
                <ul className="admin-diagnostics-list admin-diagnostics-checklist">
                  <li>Confirm this build includes <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>.</li>
                  <li>In Supabase Dashboard → Edge Functions → <code>daemon-chat</code>, confirm the function exists and the latest deploy succeeded.</li>
                  <li>Review the <code>daemon-chat</code> Edge Function logs for safe codes such as <code>RATE_LIMITED</code>, <code>PROVIDER_UNAVAILABLE</code>, or <code>FUNCTION_CONFIG_ERROR</code>.</li>
                  <li>Verify Supabase function secrets: the AI provider API key (e.g. the key for OpenAI or Anthropic), <code>DAEMON_PROVIDER</code>, and optional <code>DAEMON_MODEL</code>.</li>
                  <li>GitHub Pages deploys the frontend only; it does not deploy the Supabase Edge Function or its secrets.</li>
                </ul>
              </details>
            )}
            {currentUser && (
              <SupabaseProjectAccessPanel
                hasQueuedContext={Boolean(projectLogContext)}
                onUseWithDaemon={context => setProjectLogContext(context)}
              />
            )}
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
                  {onAdminDaemonClick && currentUser?.role === 'admin' && (
                    <button
                      type="button"
                      className="login-btn"
                      onClick={onAdminDaemonClick}
                      aria-label="Go to Admin Daemon"
                      title="Admin Daemon"
                    >
                      Admin Daemon
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
                              const attribution = msgToStrategyRef.current.get(msg.id)
                              if (attribution) {
                                attributeFeedback(attribution.contextKey, attribution.strategy, true)
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
                              const attribution = msgToStrategyRef.current.get(msg.id)
                              if (attribution) {
                                attributeFeedback(attribution.contextKey, attribution.strategy, false)
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
