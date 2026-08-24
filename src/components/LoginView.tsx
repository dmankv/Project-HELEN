import { FormEvent, useEffect, useRef, useState } from 'react'
import '../styles/LoginView.css'

interface LoginViewProps {
  onBackToChat: () => void
}

export const LOGIN_UNAVAILABLE_MESSAGE =
  'Login is not configured yet. This is a UI-only form and does not authenticate.'

export default function LoginView({ onBackToChat }: LoginViewProps) {
  const userInputRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    userInputRef.current?.focus()
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setMessage(LOGIN_UNAVAILABLE_MESSAGE)
  }

  return (
    <main className="login-page" aria-labelledby="login-heading">
      <section className="login-card">
        <h1 id="login-heading">Log in to HELEN</h1>
        <p className="login-copy">Authentication backend is not configured in this deployment.</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label htmlFor="login-user">Username</label>
          <input
            ref={userInputRef}
            id="login-user"
            name="user"
            type="text"
            autoComplete="username"
            required
          />

          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />

          <button type="submit">Log in</button>
        </form>

        {message && (
          <p className="login-message" aria-live="polite">
            {message}
          </p>
        )}

        <button type="button" className="back-to-chat-btn" onClick={onBackToChat}>
          Back to HELEN chat
        </button>
      </section>
    </main>
  )
}
