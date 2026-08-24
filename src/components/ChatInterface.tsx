import { useState, useRef, useEffect } from 'react'
import MessageList from './MessageList'
import MessageInput from './MessageInput'
import { callChatAPI } from '../services/helenChatAPI'
import type { APIMessage } from '../services/helenChatAPI'
import { detectMood, detectIntent, generateHumanLikeResponse } from '../services/helenResponseBrain'
import '../styles/ChatInterface.css'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const sendReply = async (content: string, history: Message[]) => {
    try {
      const apiMessages: APIMessage[] = history
        .filter((m): m is Message & { role: 'user' | 'assistant' } =>
          m.role === 'user' || m.role === 'assistant'
        )
        .map(m => ({ role: m.role, content: m.content }))
      let responseText = await callChatAPI(apiMessages)

      if (!responseText) {
        const mood = detectMood(content)
        const intent = detectIntent(content, undefined)
        responseText = generateHumanLikeResponse(content, { userMessage: content, mood, intent })
      }

      const aiMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseText,
        timestamp: new Date()
      }
      setMessages(prev => [...prev, aiMessage])
    } catch (error) {
      console.error('Error sending message:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleSendMessage = async (content: string) => {
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date()
    }

    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)
    sendReply(content, [...messages, userMessage])
  }

  return (
    <div className="chat-interface">
      <MessageList messages={messages} isLoading={isLoading} />
      <div ref={messagesEndRef} />
      <MessageInput onSendMessage={handleSendMessage} disabled={isLoading} />
    </div>
  )
}
