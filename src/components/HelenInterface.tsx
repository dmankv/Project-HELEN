import { useState, useRef, useEffect, useCallback } from 'react'
import MessageInput from './MessageInput'
import helenLearning from '../services/helen_learning_integration'
import type { LearningMetadata } from '../services/helen_learning_integration'
import '../styles/HelenInterface.css'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  interactionId?: string
  metadata?: LearningMetadata
  feedback?: 'helpful' | 'neutral' | 'unhelpful'
}

interface Conversation {
  id: string
  title: string
  messages: Message[]
  createdAt: Date
}

// Stored shape for localStorage (timestamps as ISO strings)
interface StoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  interactionId?: string
  metadata?: Omit<LearningMetadata, 'timestamp'> & { timestamp: string }
  feedback?: 'helpful' | 'neutral' | 'unhelpful'
}
interface StoredConversation {
  id: string
  title: string
  messages: StoredMessage[]
  createdAt: string
}

const CONV_STORAGE_KEY = 'helen_conversations'
const MAX_CONV_MESSAGES = 100 // bound per-conversation history

function loadConversations(): { convs: Conversation[]; activeId: string | null } {
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY)
    if (!raw) return { convs: [], activeId: null }
    const parsed = JSON.parse(raw) as { convs: StoredConversation[]; activeId: string | null }
    const convs: Conversation[] = (parsed.convs || []).map(c => ({
      ...c,
      createdAt: new Date(c.createdAt),
      messages: (c.messages || []).map(m => ({
        ...m,
        timestamp: new Date(m.timestamp),
        metadata: m.metadata ? { ...m.metadata, timestamp: new Date(m.metadata.timestamp) } : undefined
      }))
    }))
    return { convs, activeId: parsed.activeId ?? null }
  } catch {
    return { convs: [], activeId: null }
  }
}

function saveConversations(convs: Conversation[], activeId: string | null): void {
  try {
    localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify({ convs, activeId }))
  } catch { /* quota exceeded – best effort */ }
}

let _idCounter = 0
const nextId = () => `helen-${Date.now()}-${++_idCounter}`

// ── Response generation ────────────────────────────────────────────────────

// Deterministic confidence derived from the input text length and turn index
function deriveConfidence(input: string, turnIndex: number): number {
  const base = 0.65 + Math.min(input.length / 400, 0.20)
  const familiarity = Math.min(turnIndex * 0.01, 0.10)
  return Math.min(base + familiarity, 0.95)
}

// Detect emotional cues
function detectEmotion(text: string): string | null {
  const lower = text.toLowerCase()
  if (/\b(frustrated|annoyed|upset|angry|mad)\b/.test(lower)) return 'frustration'
  if (/\b(confused|lost|not sure|unsure|don'?t understand)\b/.test(lower)) return 'confusion'
  if (/\b(excited|great|awesome|love|amazing)\b/.test(lower)) return 'excitement'
  if (/\b(sad|unhappy|disappoint|worried|anxious)\b/.test(lower)) return 'concern'
  return null
}

// Check if the message is ambiguous (short and non-specific)
function isAmbiguous(text: string): boolean {
  return text.trim().split(/\s+/).length <= 3 && !/\?/.test(text)
}

const GREETING_RESPONSES = [
  "Hey! Good to hear from you. What's on your mind?",
  "Hi there! I'm HELEN — ready to help. What would you like to explore?",
  "Hello! Always glad to chat. What can I do for you today?",
  "Hey! I'm here. What's up?"
]

const FOLLOW_UP_STARTERS = [
  'Following up on what you said — ',
  'Building on that — ',
  'That connects to something you mentioned earlier: ',
  'Picking up from before — '
]

function pickFrom<T>(arr: T[], seed: number): T {
  return arr[seed % arr.length]
}

// Context window: last N user+assistant pairs
const CONTEXT_WINDOW = 6

function generateHelenResponse(
  input: string,
  history: Message[]
): { content: string; metadata: LearningMetadata } {
  const lowerInput = input.toLowerCase()
  // turnIndex from full history for correct complexity progression
  const turnIndex = history.filter(m => m.role === 'user').length
  // Only recent messages for context-based responses
  const recentHistory = history.slice(-CONTEXT_WINDOW)

  // Intent classification
  let intent = 'general'
  if (/\b(hello|hi|hey|good morning|good evening|howdy)\b/.test(lowerInput)) intent = 'greeting'
  else if (/\b(remember|memory|recall|last time|earlier|before|you said)\b/.test(lowerInput)) intent = 'memory_query'
  else if (/\b(stats|statistics|analytics|progress|learning|policy)\b/.test(lowerInput)) intent = 'analytics'
  else if (/\b(plan|goal|task|todo|step|how do i|how to)\b/.test(lowerInput)) intent = 'planning'
  else if (/\b(help|what|explain|tell me|describe|define|why|when|where|who)\b/.test(lowerInput)) intent = 'information'

  const confidence = deriveConfidence(input, turnIndex)
  const complexities: Array<'simple' | 'moderate' | 'complex'> = ['simple', 'moderate', 'complex']
  const planComplexity = complexities[Math.min(Math.floor(turnIndex / 4), 2)]
  const memoryUsed = recentHistory.length

  const metadata: LearningMetadata = {
    intent,
    confidence,
    ambiguity: parseFloat((1 - confidence).toFixed(3)),
    memoryUsed,
    planComplexity,
    timestamp: new Date()
  }

  const emotion = detectEmotion(input)
  const ambiguous = isAmbiguous(input)
  const seed = input.length + turnIndex

  let content = ''
  const emotionPrefix = emotion === 'frustration'
    ? "I can hear that this is frustrating — let's work through it together. "
    : emotion === 'confusion'
    ? "No worries if things feel unclear right now — that's what I'm here for. "
    : emotion === 'excitement'
    ? "That's great energy! "
    : emotion === 'concern'
    ? "I hear you, and I want to help make this easier. "
    : ''

  if (ambiguous && intent === 'general') {
    content = `${emotionPrefix}I want to make sure I understand what you mean by "${input.trim()}". Could you give me a bit more context?`
  } else if (intent === 'greeting') {
    content = pickFrom(GREETING_RESPONSES, seed)
    if (turnIndex > 0) content += ` We've exchanged ${turnIndex} message${turnIndex > 1 ? 's' : ''} so far.`
  } else if (intent === 'memory_query') {
    if (recentHistory.length === 0) {
      content = "This is the start of our session — I haven't stored anything yet. Tell me something and I'll keep it in context!"
    } else {
      const userMsgs = recentHistory.filter(m => m.role === 'user').slice(-3)
      const snippets = userMsgs.map(m => `"${m.content.slice(0, 50)}${m.content.length > 50 ? '…' : ''}"`).join(', ')
      content = `From what I can see in our recent exchange, you've brought up: ${snippets}. Is there something specific from that you'd like to come back to?`
    }
  } else if (intent === 'analytics') {
    const ins = helenLearning.getLearningInsights()
    const ratedCount = ins.learningCycles
    content = `Here's where my learning stands:\n• Interactions recorded: ${ins.totalInteractions}\n• Feedback cycles: ${ratedCount}\n• Helpful rate: ${ins.successRate > 0 ? (ins.successRate * 100).toFixed(0) + '%' : 'no ratings yet'}\n• Avg confidence: ${(ins.averageConfidence * 100).toFixed(0)}%\n• Policy version: v${ins.policyVersion}\n\nYou can rate any of my responses below to help me improve.`
  } else if (intent === 'planning') {
    const followUp = turnIndex > 0 ? pickFrom(FOLLOW_UP_STARTERS, seed) : ''
    content = `${emotionPrefix}${followUp}For "${input.slice(0, 60)}${input.length > 60 ? '…' : ''}", I'd approach this as a ${planComplexity} task. What's the end goal you're aiming for? That'll help me suggest concrete steps.`
  } else {
    // General information / follow-up
    const isFollowUp = turnIndex > 0 && /\b(it|that|this|those|they|them|he|she)\b/.test(lowerInput)
    const starter = isFollowUp ? pickFrom(FOLLOW_UP_STARTERS, seed) : ''
    const generalVariants = [
      `${emotionPrefix}${starter}That's a good point about "${input.slice(0, 50)}${input.length > 50 ? '…' : ''}". I can dig into this — what angle matters most to you?`,
      `${emotionPrefix}${starter}I've registered your question. My read on it (${(confidence * 100).toFixed(0)}% confidence): this touches on ${intent} territory. What would be the most useful next step for you?`,
      `${emotionPrefix}${starter}Noted. To give you a sharper answer, could you tell me a bit more about what you're trying to achieve?`
    ]
    content = pickFrom(generalVariants, seed)
  }

  return { content, metadata }
}

// ── Component ────────────────────────────────────────────────────────────────

// Load once at module init so the two useState initialisers share the same parse
const _initialState = loadConversations()

export default function HelenInterface() {
  const [conversations, setConversations] = useState<Conversation[]>(_initialState.convs)
  const [activeConvId, setActiveConvId] = useState<string | null>(_initialState.activeId)
  const [isLoading, setIsLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [insights, setInsights] = useState(() => helenLearning.getLearningInsights())
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeConv = conversations.find(c => c.id === activeConvId) ?? null
  const messages = activeConv?.messages ?? []

  // Persist conversations whenever they change
  useEffect(() => {
    saveConversations(conversations, activeConvId)
  }, [conversations, activeConvId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  const newConversation = useCallback(() => {
    const id = `conv-${Date.now()}`
    const conv: Conversation = { id, title: 'New conversation', messages: [], createdAt: new Date() }
    setConversations(prev => [conv, ...prev])
    setActiveConvId(id)
  }, [])

  const handleSendMessage = useCallback((content: string) => {
    let convId = activeConvId
    if (!convId) {
      const id = nextId()
      const conv: Conversation = { id, title: content.slice(0, 30) || 'New conversation', messages: [], createdAt: new Date() }
      setConversations(prev => [conv, ...prev])
      setActiveConvId(id)
      convId = id
    }

    const userMessage: Message = { id: nextId(), role: 'user', content, timestamp: new Date() }

    setConversations(prev => prev.map(c =>
      c.id === convId
        ? { ...c, title: c.messages.length === 0 ? content.slice(0, 30) || c.title : c.title, messages: [...c.messages, userMessage] }
        : c
    ))

    setIsLoading(true)

    // Reduced delay for faster response feel
    setTimeout(() => {
      setConversations(prev => {
        const conv = prev.find(c => c.id === convId)
        if (!conv) return prev
        // Pass full message history so turnIndex reflects true conversation length
        const { content: responseContent, metadata } = generateHelenResponse(content, conv.messages)
        const record = helenLearning.recordInteraction(content, responseContent, metadata)

        const aiMessage: Message = {
          id: nextId(),
          role: 'assistant',
          content: responseContent,
          timestamp: new Date(),
          interactionId: record.id,
          metadata
        }

        const updatedMessages = [...conv.messages, aiMessage].slice(-MAX_CONV_MESSAGES)
        return prev.map(c =>
          c.id === convId ? { ...c, messages: updatedMessages } : c
        )
      })
      setInsights(helenLearning.getLearningInsights())
      setIsLoading(false)
    }, 300)
  }, [activeConvId])

  const handleFeedback = useCallback((messageId: string, interactionId: string, rating: 'helpful' | 'neutral' | 'unhelpful') => {
    helenLearning.processFeedback(interactionId, rating)
    // Immediately update insights so analytics reflect the new rating
    setInsights(helenLearning.getLearningInsights())
    setConversations(prev => prev.map(c =>
      c.id === activeConvId
        ? { ...c, messages: c.messages.map(m => m.id === messageId ? { ...m, feedback: rating } : m) }
        : c
    ))
  }, [activeConvId])

  return (
    <div className="helen-app">
      {/* Sidebar */}
      <aside className={`helen-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="helen-brand">
            <span className="helen-logo">🧠</span>
            <span className="helen-name">HELEN</span>
          </div>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar">
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {sidebarOpen && (
          <>
            <button className="new-chat-btn" onClick={newConversation}>
              + New Conversation
            </button>

            <nav className="conversation-list" aria-label="Conversation history">
              {conversations.length === 0 && (
                <p className="no-conversations">No conversations yet</p>
              )}
              {conversations.map(conv => (
                <button
                  key={conv.id}
                  className={`conversation-item ${conv.id === activeConvId ? 'active' : ''}`}
                  onClick={() => setActiveConvId(conv.id)}
                  aria-current={conv.id === activeConvId ? 'page' : undefined}
                >
                  <span className="conv-icon">💬</span>
                  <span className="conv-title">{conv.title || 'Untitled'}</span>
                </button>
              ))}
            </nav>

            {/* Analytics Panel */}
            <div className="analytics-panel" aria-label="Learning analytics">
              <h3 className="analytics-title">Analytics</h3>
              <div className="analytics-grid">
                <div className="stat-item">
                  <span className="stat-value">{insights.totalInteractions}</span>
                  <span className="stat-label">Interactions</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value" title="Based on rated responses">
                    {insights.learningCycles > 0 ? `${(insights.successRate * 100).toFixed(0)}%` : '—'}
                  </span>
                  <span className="stat-label">Helpful</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value">{(insights.averageConfidence * 100).toFixed(0)}%</span>
                  <span className="stat-label">Confidence</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value">v{insights.policyVersion}</span>
                  <span className="stat-label">Policy</span>
                </div>
              </div>
            </div>
          </>
        )}
      </aside>

      {/* Main chat area */}
      <div className="helen-main">
        <header className="helen-header">
          {!sidebarOpen && (
            <button className="sidebar-toggle-inline" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
              ☰
            </button>
          )}
          <div className="header-title">
            <span className="helen-logo-sm">🧠</span>
            <span>HELEN</span>
          </div>
          <div className="header-meta">
            {activeConv && (
              <span className="conv-meta">
                {activeConv.messages.filter(m => m.role === 'user').length} messages
              </span>
            )}
          </div>
        </header>

        <div className="chat-area">
          {!activeConv ? (
            <div className="welcome-screen">
              <div className="welcome-content">
                <div className="welcome-icon">🧠</div>
                <h1>Hello, I'm HELEN</h1>
                <p>Your adaptive assistant with memory, intent recognition, and continuous learning. Start typing and I'll remember your conversation.</p>
                <button className="start-chat-btn" onClick={newConversation}>
                  Start a conversation
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="messages-container" role="log" aria-live="polite" aria-label="Conversation">
                {messages.length === 0 && (
                  <div className="empty-conv">
                    <p>Send a message to begin.</p>
                  </div>
                )}
                {messages.map(message => (
                  <div
                    key={message.id}
                    className={`message-row ${message.role === 'user' ? 'user-row' : 'assistant-row'}`}
                  >
                    <div className="message-avatar" aria-hidden="true">
                      {message.role === 'user' ? '👤' : '🧠'}
                    </div>
                    <div className="message-body">
                      <div className={`bubble ${message.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
                        <div className="bubble-text">{message.content}</div>
                        {message.metadata && (
                          <div className="message-meta" aria-label="Message metadata">
                            <span className="meta-tag">intent: {message.metadata.intent}</span>
                            <span className="meta-tag">{(message.metadata.confidence * 100).toFixed(0)}% conf</span>
                            <span className="meta-tag">mem: {message.metadata.memoryUsed}</span>
                            <span className="meta-tag">{message.metadata.planComplexity}</span>
                          </div>
                        )}
                      </div>
                      <div className="message-footer">
                        <span className="message-time">
                          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {message.role === 'assistant' && message.interactionId && (
                          <div className="feedback-controls" aria-label="Rate this response">
                            {message.feedback ? (
                              <span className="feedback-given">
                                {message.feedback === 'helpful' ? '👍' : message.feedback === 'unhelpful' ? '👎' : '😐'} Recorded
                              </span>
                            ) : (
                              <>
                                <button className="feedback-btn" title="Helpful" aria-label="Mark as helpful"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'helpful')}>👍</button>
                                <button className="feedback-btn" title="Neutral" aria-label="Mark as neutral"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'neutral')}>😐</button>
                                <button className="feedback-btn" title="Not helpful" aria-label="Mark as not helpful"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'unhelpful')}>👎</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {isLoading && (
                  <div className="message-row assistant-row" aria-label="HELEN is typing">
                    <div className="message-avatar" aria-hidden="true">🧠</div>
                    <div className="message-body">
                      <div className="bubble assistant-bubble">
                        <div className="typing-indicator" aria-label="Typing">
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

              <MessageInput onSendMessage={handleSendMessage} disabled={isLoading} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
