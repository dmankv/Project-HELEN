import { useState, useRef, useEffect, useCallback } from 'react'
import {
  detectMood,
  detectIntent,
  generateHumanLikeResponse,
} from '../services/helenResponseBrain'
import type { MemorySnippet, ResponseIntent } from '../services/helenResponseBrain'
import learningSystem from '../services/helen_learning_integration'
import {
  saveMemory,
  listMemories,
  forgetLast,
  forgetByText,
  forgetAll,
  retrieveRelevant,
  formatMemoriesForContext,
} from '../services/helenMemory'
import { callChatAPI, hasBackend } from '../services/helenChatAPI'
import type { APIMessage } from '../services/helenChatAPI'
import '../styles/HelenInterface.css'

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

const MESSAGES_KEY = 'helen_messages'
const CONVERSATIONS_KEY = 'helen_conversations'
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
    const raw = localStorage.getItem(MESSAGES_KEY)
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
    const raw = localStorage.getItem(CONVERSATIONS_KEY)
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
  const words = first.content.trim().split(/\s+/).slice(0, 6).join(' ')
  return words.length < first.content.trim().length ? words + '…' : words
}

let _idCounter = 0
const nextId = () => 'helen-' + Date.now() + '-' + (++_idCounter)

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

function buildAPIHistory(messages: Message[]): APIMessage[] {
  return messages
    .slice(-MAX_API_TURNS * 2)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HelenInterfaceProps {
  onLogInClick?: () => void
}

export default function HelenInterface({ onLogInClick }: HelenInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [lastIntent, setLastIntent] = useState<ResponseIntent | undefined>(undefined)
  const [usingBackend, setUsingBackend] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [input])

  const persistConversation = useCallback(
    (updated: Message[], convId: string, convList: Conversation[]) => {
      const existing = convList.find(c => c.id === convId)
      const updatedConv: Conversation = existing
        ? { ...existing, messages: updated }
        : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
      const updatedConvList = existing
        ? convList.map(c => (c.id === convId ? updatedConv : c))
        : [updatedConv, ...convList]
      setConversations(updatedConvList)
      saveConversations(updatedConvList)
    },
    [],
  )

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

    // Check for memory command first
    const memCmd = parseMemoryCommand(text)
    if (memCmd) {
      await new Promise(r => setTimeout(r, 400))
      const responseText = handleMemoryCommand(memCmd)
      const aiMsg: Message = {
        id: nextId(),
        role: 'assistant',
        content: responseText,
        timestamp: new Date().toISOString(),
      }
      const updated = [...nextMessages, aiMsg]
      setMessages(updated)
      saveMessages(updated)
      persistConversation(updated, convId, conversations)
      setIsThinking(false)
      return
    }

    // Try backend first
    const controller = new AbortController()
    abortRef.current = controller

    if (hasBackend()) {
      const apiHistory = buildAPIHistory(nextMessages)
      const backendResponse = await callChatAPI(apiHistory, controller.signal)
      if (backendResponse !== null) {
        setUsingBackend(true)
        const aiMsg: Message = {
          id: nextId(),
          role: 'assistant',
          content: backendResponse,
          timestamp: new Date().toISOString(),
        }
        const updated = [...nextMessages, aiMsg]
        setMessages(updated)
        saveMessages(updated)
        persistConversation(updated, convId, conversations)
        setIsThinking(false)
        abortRef.current = null
        return
      }
      setUsingBackend(false)
      // User may have cancelled while awaiting the backend response
      if (controller.signal.aborted) {
        setIsThinking(false)
        abortRef.current = null
        return
      }
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
    })

    setLastIntent(intent)

    learningSystem.recordInteraction(text, response, {
      intent,
      confidence: 0.8,
      ambiguity: intent === 'clarify' ? 0.6 : 0.2,
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

    const updated = [...nextMessages, aiMsg]
    setMessages(updated)
    saveMessages(updated)
    persistConversation(updated, convId, conversations)
    setIsThinking(false)
    abortRef.current = null
  }, [input, isThinking, messages, activeConvId, lastIntent, conversations, persistConversation])

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

  const handleClear = () => {
    setMessages([])
    setActiveConvId(null)
    setLastIntent(undefined)
    setConversations([])
    localStorage.removeItem(MESSAGES_KEY)
    localStorage.removeItem(CONVERSATIONS_KEY)
    learningSystem.clearHistory()
    // Durable memories are intentionally preserved. Use "forget all memories" to erase them.
  }

  const handleNewChat = () => {
    handleClear()
  }

  const handleSelectConversation = (conv: Conversation) => {
    setMessages(conv.messages)
    setActiveConvId(conv.id)
    saveMessages(conv.messages)
  }

  const insights = learningSystem.getLearningInsights()

  return (
    <div className="helen-app">
      <nav className={'helen-sidebar ' + (sidebarOpen ? 'open' : 'closed')} aria-label="Conversation history">
        <div className="sidebar-header">
          {sidebarOpen && (
            <div className="helen-brand">
              <span className="helen-logo">🧠</span>
              <span>HELEN</span>
            </div>
          )}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {sidebarOpen && (
          <>
            <button type="button" className="new-chat-btn" onClick={handleNewChat}>
              + New chat
            </button>

            <div className="conversation-list" role="list">
              {conversations.length === 0 ? (
                <p className="no-conversations">No conversations yet</p>
              ) : (
                conversations.map(conv => (
                  <button
                    key={conv.id}
                    type="button"
                    role="listitem"
                    className={'conversation-item ' + (conv.id === activeConvId ? 'active' : '')}
                    onClick={() => handleSelectConversation(conv)}
                    title={conv.title}
                  >
                    <span className="conv-icon">💬</span>
                    <span className="conv-title">{conv.title}</span>
                  </button>
                ))
              )}
            </div>

            <div className="analytics-panel" aria-label="Usage stats">
              <p className="analytics-title">Stats</p>
              <div className="analytics-grid">
                <div className="stat-item">
                  <span className="stat-value">{insights.totalInteractions}</span>
                  <span className="stat-label">Turns</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value">{conversations.length}</span>
                  <span className="stat-label">Chats</span>
                </div>
              </div>
              {hasBackend() && (
                <p className="backend-badge" title={usingBackend ? 'Responses from cloud model' : 'Using local brain'}>
                  {usingBackend ? '☁️ Cloud' : '🖥️ Local'}
                </p>
              )}
            </div>
          </>
        )}
      </nav>

      <main className="helen-main">
        <header className="helen-header">
          <div className="header-title">
            <span className="helen-logo-sm">🧠</span>
            <span>HELEN</span>
          </div>
          <div className="header-actions">
            {onLogInClick && (
              <button type="button" className="login-btn" onClick={onLogInClick} aria-label="Log in">
                Log in
              </button>
            )}
            <button
              type="button"
              className="clear-btn"
              onClick={handleClear}
              aria-label="Clear conversation"
              title="Clear conversation (durable memories are preserved)"
            >
              Clear
            </button>
          </div>
        </header>

        <div className="chat-area">
          <div
            className="messages-container"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            {messages.length === 0 && !isThinking && (
              <div className="welcome-screen">
                <div className="welcome-content">
                  <div className="welcome-icon">🧠</div>
                  <h1>Hello, I'm HELEN</h1>
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
                <div className="message-avatar">{msg.role === 'user' ? '👤' : '🧠'}</div>
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
                  </div>
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="message-row assistant-row">
                <div className="message-avatar">🧠</div>
                <div className="message-body">
                  <div className="bubble assistant-bubble">
                    <div className="typing-indicator">
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
              className="helen-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message HELEN…"
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
