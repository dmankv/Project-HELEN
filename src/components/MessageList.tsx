import Message from './Message'
import { Message as MessageType } from './ChatInterface'
import '../styles/MessageList.css'

interface MessageListProps {
  messages: MessageType[]
  isLoading: boolean
}

export default function MessageList({ messages, isLoading }: MessageListProps) {
  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty-state">
          <h2>Start a conversation</h2>
          <p>Ask me anything and I'll do my best to help!</p>
        </div>
      )}
      {messages.map(message => (
        <Message key={message.id} message={message} />
      ))}
      {isLoading && (
        <div className="message message-assistant">
          <div className="message-content">
            <div className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
