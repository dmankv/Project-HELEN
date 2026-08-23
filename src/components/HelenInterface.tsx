import { useState, useRef, useEffect } from 'react'
import {
  detectMood,
  detectIntent,
  generateHumanLikeResponse,
} from '../services/helenResponseBrain'
import type { MemorySnippet, ResponseIntent } from '../services/helenResponseBrain'
import learningSystem from '../services/helen_learning_integration'
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
const MEMORIES_KEY = 'helen_memories'
const CONVERSATIONS_KEY = 'helen_conversations'
const MIN_THINKING_DELAY = 600
const MAX_THINKING_DELAY = 1800

function thinkingDelay(text: string): number {
  // Scale delay with message length: short messages ~600ms, long ones up to 1800ms
  const words = text.trim().split(/\s+/).length
  const scaled = Math.min(MIN_THINKING_DELAY + words * 40, MAX_THINKING_DELAY)
  // Add up to ±150ms of jitter so responses never feel robotic/clockwork
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

function loadMemories(): MemorySnippet[] {
  try {
    const raw = localStorage.getItem(MEMORIES_KEY)
    return raw ? (JSON.parse(raw) as MemorySnippet[]) : []
  } catch {
    return []
  }
}

function saveMemories(memories: MemorySnippet[]): void {
  try {
    localStorage.setItem(MEMORIES_KEY, JSON.stringify(memories))
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
  return words.length < first.content.trim().length ? `${words}…` : words
}

let _idCounter = 0
const nextId = () => `helen-${Date.now()}-${++_idCounter}`

export default function HelenInterface() {
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [lastIntent, setLastIntent] = useState<ResponseIntent | undefined>(undefined)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  // Auto-grow textarea height to fit content, up to the CSS max-height
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  const handleSend = () => {
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

    setTimeout(() => {
      const memories = loadMemories()
      const mood = detectMood(text)
      const intent = detectIntent(text, lastIntent)
      const wantsShortAnswer = text.trim().split(/\s+/).length <= 5

      const response = generateHumanLikeResponse(text, {
        userMessage: text,
        mood,
        intent,
        memories: memories.length > 0 ? memories : undefined,
        wantsShortAnswer,
        lastIntent,
      })

      setLastIntent(intent)

      // Record the interaction in the learning system
      learningSystem.recordInteraction(text, response, {
        intent,
        confidence: 0.8,
        ambiguity: intent === 'clarify' ? 0.6 : 0.2,
        memoryUsed: memories.length,
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

      // Store user message as memory snippet (recency-weighted relevance)
      const newMemory: MemorySnippet = { text, relevance: Date.now() }
      const updatedMemories = [...memories, newMemory].slice(-20)
      saveMemories(updatedMemories)

      // Persist conversation to sidebar list
      const convId = activeConvId ?? nextId()
      if (!activeConvId) setActiveConvId(convId)
      const existing = conversations.find(c => c.id === convId)
      const updatedConv: Conversation = existing
        ? { ...existing, messages: updated }
        : { id: convId, title: conversationTitle(updated), messages: updated, createdAt: new Date().toISOString() }
      const updatedConvList = existing
        ? conversations.map(c => c.id === convId ? updatedConv : c)
        : [updatedConv, ...conversations]
      setConversations(updatedConvList)
      saveConversations(updatedConvList)

      setIsThinking(false)
    }, thinkingDelay(text))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleClear = () => {
    setMessages([])
    setActiveConvId(null)
    setLastIntent(undefined)
    setConversations([])
    localStorage.removeItem(MESSAGES_KEY)
    localStorage.removeItem(MEMORIES_KEY)
    localStorage.removeItem(CONVERSATIONS_KEY)
    learningSystem.clearHistory()
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
      {/* ── Sidebar ── */}
      <nav className={`helen-sidebar ${sidebarOpen ? 'open' : 'closed'}`} aria-label="Conversation history">
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
                    className={`conversation-item ${conv.id === activeConvId ? 'active' : ''}`}
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
            </div>
          </>
        )}
      </nav>

      {/* ── Main content ── */}
      <main className="helen-main">
        <header className="helen-header">
          <div className="header-title">
            <span className="helen-logo-sm">🧠</span>
            <span>HELEN</span>
          </div>
          <button
            type="button"
            className="clear-btn"
            onClick={handleClear}
            aria-label="Clear conversation"
            title="Clear conversation"
          >
            Clear
          </button>
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
                </div>
              </div>
            )}

            {messages.map(msg => (
              <div
                key={msg.id}
                className={`message-row ${msg.role === 'user' ? 'user-row' : 'assistant-row'}`}
              >
                <div className="message-avatar">{msg.role === 'user' ? '👤' : '🧠'}</div>
                <div className="message-body">
                  <div className={`bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
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
              onClick={handleSend}
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
