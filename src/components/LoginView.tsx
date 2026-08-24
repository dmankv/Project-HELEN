import { useCallback } from 'react'
import '../styles/LoginView.css'

interface LoginViewProps {
  onBackToChat: () => void
}

export default function LoginView({ onBackToChat }: LoginViewProps) {
  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Authentication is not configured. No credentials are stored or transmitted.
    alert('Authentication is not configured yet.')
  }, [])

  return (
    <div className="login-page" role="main">
      <div className="login-card">
        <div className="login-header">
          <span className="helen-logo-sm" aria-hidden="true">🧠</span>
          <span className="login-title">HELEN – Log In</span>
        </div>

        <p className="login-notice">
          Authentication is not yet configured. This form is UI-only and does
          not store or transmit any credentials.
        </p>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          <div className="login-field">
            <label htmlFor="login-username">User</label>
            <input
              id="login-username"
              type="text"
              name="username"
              autoComplete="username"
              placeholder="Username"
              aria-label="Username"
            />
          </div>

          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              name="current-password"
              autoComplete="current-password"
              placeholder="Password"
              aria-label="Password"
            />
          </div>

          <button type="submit" className="login-submit-btn">
            Log In
          </button>
        </form>

        <button
          type="button"
          className="login-back-btn"
          onClick={onBackToChat}
          aria-label="Back to chat"
        >
          ← Back to chat
        </button>
      </div>
    </div>
  )
}
