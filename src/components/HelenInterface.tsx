import { useState, useRef, useEffect } from 'react'
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

export default function HelenInterface() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const activeConv = conversations.find(c => c.id === activeConvId) ?? null
  const messages = activeConv?.messages ?? []
  const insights = helenLearning.getLearningInsights()

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isLoading])

  const newConversation = () => {
    const id = `conv-${Date.now()}`
    const conv: Conversation = {
      id,
      title: 'New conversation',
      messages: [],
      createdAt: new Date()
    }
    setConversations(prev => [conv, ...prev])
    setActiveConvId(id)
  }

  const generateHelenResponse = (input: string, history: Message[]): { content: string; metadata: LearningMetadata } => {
    const lowerInput = input.toLowerCase()

    // Simple intent classification
    let intent = 'general'
    if (/hello|hi|hey/.test(lowerInput)) intent = 'greeting'
    else if (/help|how|what|explain|tell/.test(lowerInput)) intent = 'information'
    else if (/remember|memory|recall|last time/.test(lowerInput)) intent = 'memory_query'
    else if (/stats|statistics|analytics|progress/.test(lowerInput)) intent = 'analytics'
    else if (/plan|goal|task|do/.test(lowerInput)) intent = 'planning'

    const memoryUsed = history.length
    const confidence = 0.7 + Math.random() * 0.25
    const complexities: Array<'simple' | 'moderate' | 'complex'> = ['simple', 'moderate', 'complex']
    const planComplexity = complexities[Math.min(Math.floor(history.length / 3), 2)]

    const metadata: LearningMetadata = {
      intent,
      confidence,
      ambiguity: 1 - confidence,
      memoryUsed,
      planComplexity,
      timestamp: new Date()
    }

    let content = ''

    if (intent === 'greeting') {
      content = `Hello! I'm HELEN, your adaptive AI assistant. I've had ${memoryUsed} messages of context from our conversation. How can I help you today?`
    } else if (intent === 'memory_query') {
      if (history.length === 0) {
        content = "This is the start of our conversation — I don't have any prior exchanges to reference yet. Feel free to tell me something and I'll remember it for this session!"
      } else {
        const userMessages = history.filter(m => m.role === 'user').slice(-3)
        content = `Based on our conversation so far, you've mentioned things like: "${userMessages.map(m => m.content.slice(0, 40)).join('", "')}". Is there something specific you'd like me to recall or revisit?`
      }
    } else if (intent === 'analytics') {
      const ins = helenLearning.getLearningInsights()
      content = `Here are my current learning analytics:\n• Total interactions: ${ins.totalInteractions}\n• Success rate: ${(ins.successRate * 100).toFixed(1)}%\n• Average confidence: ${(ins.averageConfidence * 100).toFixed(1)}%\n• Learning cycles: ${ins.learningCycles}\n• Policy version: ${ins.policyVersion}`
    } else if (intent === 'planning') {
      content = `I'm analyzing your request with ${planComplexity} complexity planning. Here's my approach: I'll break down your goal into structured steps, consider dependencies, and track progress. What's the specific outcome you're aiming for?`
    } else {
      const responses = [
        `I understand you're asking about "${input.slice(0, 60)}". Based on my current knowledge and our ${memoryUsed}-message context, I can help explore this further. What aspect interests you most?`,
        `That's a thoughtful question. I'm processing it with ${(confidence * 100).toFixed(0)}% confidence. Could you share more details so I can give you a more precise answer?`,
        `Interesting! I've noted your message and will incorporate it into my learning model. My current policy (v${insights.policyVersion}) suggests a ${planComplexity} approach here.`,
      ]
      content = responses[Math.floor(Math.random() * responses.length)]
    }

    return { content, metadata }
  }

  const handleSendMessage = async (content: string) => {
    let convId = activeConvId
    if (!convId) {
      const id = `conv-${Date.now()}`
      const conv: Conversation = {
        id,
        title: content.slice(0, 30) || 'New conversation',
        messages: [],
        createdAt: new Date()
      }
      setConversations(prev => [conv, ...prev])
      setActiveConvId(id)
      convId = id
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date()
    }

    setConversations(prev => prev.map(c =>
      c.id === convId
        ? {
            ...c,
            title: c.messages.length === 0 ? content.slice(0, 30) || c.title : c.title,
            messages: [...c.messages, userMessage]
          }
        : c
    ))

    setIsLoading(true)

    setTimeout(() => {
      setConversations(prev => {
        const conv = prev.find(c => c.id === convId)
        if (!conv) return prev
        const { content: responseContent, metadata } = generateHelenResponse(content, conv.messages)
        const record = helenLearning.recordInteraction(content, responseContent, metadata)

        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: responseContent,
          timestamp: new Date(),
          interactionId: record.id,
          metadata
        }

        return prev.map(c =>
          c.id === convId
            ? { ...c, messages: [...c.messages, aiMessage] }
            : c
        )
      })
      setIsLoading(false)
    }, 600)
  }

  const handleFeedback = (messageId: string, interactionId: string, rating: 'helpful' | 'neutral' | 'unhelpful') => {
    helenLearning.processFeedback(interactionId, rating)
    setConversations(prev => prev.map(c =>
      c.id === activeConvId
        ? {
            ...c,
            messages: c.messages.map(m =>
              m.id === messageId ? { ...m, feedback: rating } : m
            )
          }
        : c
    ))
  }

  return (
    <div className="helen-app">
      {/* Sidebar */}
      <aside className={`helen-sidebar ${sidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-header">
          <div className="helen-brand">
            <span className="helen-logo">🧠</span>
            <span className="helen-name">HELEN</span>
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Toggle sidebar"
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
        </div>

        {sidebarOpen && (
          <>
            <button className="new-chat-btn" onClick={newConversation}>
              + New Conversation
            </button>

            <nav className="conversation-list">
              {conversations.length === 0 && (
                <p className="no-conversations">No conversations yet</p>
              )}
              {conversations.map(conv => (
                <button
                  key={conv.id}
                  className={`conversation-item ${conv.id === activeConvId ? 'active' : ''}`}
                  onClick={() => setActiveConvId(conv.id)}
                >
                  <span className="conv-icon">💬</span>
                  <span className="conv-title">{conv.title || 'Untitled'}</span>
                </button>
              ))}
            </nav>

            {/* Analytics Panel */}
            <div className="analytics-panel">
              <h3 className="analytics-title">Analytics</h3>
              <div className="analytics-grid">
                <div className="stat-item">
                  <span className="stat-value">{insights.totalInteractions}</span>
                  <span className="stat-label">Interactions</span>
                </div>
                <div className="stat-item">
                  <span className="stat-value">{(insights.successRate * 100).toFixed(0)}%</span>
                  <span className="stat-label">Success</span>
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
            <button
              className="sidebar-toggle-inline"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open sidebar"
            >
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
                <p>Your adaptive AI assistant with memory, intent recognition, and continuous learning.</p>
                <button className="start-chat-btn" onClick={newConversation}>
                  Start a conversation
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="messages-container">
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
                    <div className="message-avatar">
                      {message.role === 'user' ? '👤' : '🧠'}
                    </div>
                    <div className="message-body">
                      <div className={`bubble ${message.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
                        <div className="bubble-text">{message.content}</div>
                        {message.metadata && (
                          <div className="message-meta">
                            <span className="meta-tag">intent: {message.metadata.intent}</span>
                            <span className="meta-tag">{(message.metadata.confidence * 100).toFixed(0)}% conf</span>
                            <span className="meta-tag">{message.metadata.planComplexity}</span>
                          </div>
                        )}
                      </div>
                      <div className="message-footer">
                        <span className="message-time">
                          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {message.role === 'assistant' && message.interactionId && (
                          <div className="feedback-controls">
                            {message.feedback ? (
                              <span className="feedback-given">
                                {message.feedback === 'helpful' ? '👍' : message.feedback === 'unhelpful' ? '👎' : '😐'} Recorded
                              </span>
                            ) : (
                              <>
                                <button
                                  className="feedback-btn"
                                  title="Helpful"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'helpful')}
                                >👍</button>
                                <button
                                  className="feedback-btn"
                                  title="Neutral"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'neutral')}
                                >😐</button>
                                <button
                                  className="feedback-btn"
                                  title="Not helpful"
                                  onClick={() => handleFeedback(message.id, message.interactionId!, 'unhelpful')}
                                >👎</button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {isLoading && (
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

              <MessageInput onSendMessage={handleSendMessage} disabled={isLoading} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
