import { useState, useRef, useEffect } from 'react'
import {
  detectMood,
  detectIntent,
  generateHumanLikeResponse,
} from '../services/helenResponseBrain'
import type { MemorySnippet } from '../services/helenResponseBrain'
import learningSystem from '../services/helen_learning_integration'
import '../styles/HelenInterface.css'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

const MESSAGES_KEY = 'helen_messages'
const MEMORIES_KEY = 'helen_memories'
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

let _idCounter = 0
const nextId = () => `helen-${Date.now()}-${++_idCounter}`

export default function HelenInterface() {
  const [messages, setMessages] = useState<Message[]>(() => loadMessages())
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
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
      const intent = detectIntent(text)
      const wantsShortAnswer = text.trim().split(/\s+/).length <= 5

      const response = generateHumanLikeResponse(text, {
        userMessage: text,
        mood,
        intent,
        memories: memories.length > 0 ? memories : undefined,
        wantsShortAnswer,
      })

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
    localStorage.removeItem(MESSAGES_KEY)
    localStorage.removeItem(MEMORIES_KEY)
    learningSystem.clearHistory()
  }

  return (
    <div className="helen-app">
      <header className="helen-header">
        <div className="header-title">
          <span className="helen-logo-sm">🧠</span>
          <span>HELEN</span>
        </div>
        <button type="button" className="clear-btn" onClick={handleClear} title="Clear conversation">
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
    </div>
  )
}
