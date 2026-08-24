import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '../styles/LoginView.css'
import {
  completePasswordReset,
  completeVerification,
  loginUser,
  registerUser,
  requestPasswordReset,
  requestVerification,
} from '../services/daemonAuthAPI'
import {
  supabaseCompletePasswordReset,
  supabaseLogin,
  supabaseRegister,
  supabaseRequestPasswordReset,
  supabaseResendVerification,
} from '../services/supabaseAuthAPI'
import type { AuthUser } from '../services/daemonAuthAPI'

type AuthRoute =
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'reset-password'
  | 'verify-email'

interface LoginViewProps {
  mode: AuthRoute
  token: string
  hasBackend: boolean
  /** True when Supabase managed auth is the active provider. */
  isManagedAuth?: boolean
  onBackToChat: () => void
  onNavigate: (route: AuthRoute | 'chat', token?: string) => void
  onAuthSuccess: (user: AuthUser) => void
}

function clearSensitive(...setters: Array<(value: string) => void>): void {
  for (const set of setters) set('')
}

export default function LoginView({
  mode,
  token,
  hasBackend,
  isManagedAuth = false,
  onBackToChat,
  onNavigate,
  onAuthSuccess,
}: LoginViewProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
    setError('')
    setStatus('')
    clearSensitive(setPassword, setPasswordConfirm)
  }, [mode])

  useEffect(() => {
    return () => {
      clearSensitive(setPassword, setPasswordConfirm)
    }
  }, [])

  const title = useMemo(() => {
    switch (mode) {
      case 'register': return 'Create account'
      case 'forgot-password': return 'Reset password'
      case 'reset-password': return 'Set new password'
      case 'verify-email': return 'Verify email'
      default: return 'Log in'
    }
  }, [mode])

  const backendWarning = !hasBackend
    ? isManagedAuth
      ? 'Managed authentication is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY as GitHub Actions variables and redeploy.'
      : 'Authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (for managed auth) or VITE_DAEMON_AUTH_API_URL (for a self-hosted server) and redeploy.'
    : ''

  const withPending = useCallback(async (work: () => Promise<void>) => {
    setPending(true)
    setError('')
    setStatus('')
    try {
      await work()
    } catch {
      setError('Request failed. Please try again.')
    } finally {
      setPending(false)
      clearSensitive(setPassword, setPasswordConfirm)
    }
  }, [])

  const onSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!hasBackend) {
      setError('Authentication is not available.')
      clearSensitive(setPassword, setPasswordConfirm)
      return
    }

    void withPending(async () => {
      if (mode === 'login') {
        const result = isManagedAuth
          ? await supabaseLogin(email, password)
          : await loginUser(email, password)
        if (!result.ok || !result.user) {
          setError(result.message)
          return
        }
        setStatus('Login successful.')
        onAuthSuccess(result.user)
        return
      }

      if (mode === 'register') {
        const result = isManagedAuth
          ? await supabaseRegister(email, password)
          : await registerUser(email, password, passwordConfirm)
        if (!result.ok) {
          setError(result.message)
          return
        }
        setStatus(result.message)
        return
      }

      if (mode === 'forgot-password') {
        const result = isManagedAuth
          ? await supabaseRequestPasswordReset(email)
          : await requestPasswordReset(email)
        setStatus(result.message)
        return
      }

      if (mode === 'reset-password') {
        if (isManagedAuth) {
          // For Supabase, the token is exchanged automatically via
          // detectSessionInUrl; we just update the password.
          const result = await supabaseCompletePasswordReset(password)
          if (!result.ok) {
            setError(result.message)
            return
          }
          setStatus(result.message)
          return
        }
        if (!token) {
          setError('Missing reset token in URL.')
          return
        }
        const result = await completePasswordReset(token, password, passwordConfirm)
        if (!result.ok) {
          setError(result.message)
          return
        }
        setStatus(result.message)
        return
      }

      if (mode === 'verify-email') {
        if (!isManagedAuth) {
          if (!token) {
            setError('Missing verification token in URL.')
            return
          }
          const result = await completeVerification(token)
          setStatus(result.message)
        } else {
          // Supabase verification is handled automatically via detectSessionInUrl
          // and the onAuthStateChange listener.  Nothing extra to do here.
          setStatus('Email verified. You can now sign in.')
        }
      }
    })
  }, [email, hasBackend, isManagedAuth, mode, onAuthSuccess, password, passwordConfirm, token, withPending])

  const onResendVerification = useCallback(() => {
    if (!hasBackend) {
      setError('Authentication is not available.')
      return
    }
    void withPending(async () => {
      const result = isManagedAuth
        ? await supabaseResendVerification(email)
        : await requestVerification(email)
      setStatus(result.message)
    })
  }, [email, hasBackend, isManagedAuth, withPending])

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-header">
          <span className="daemon-logo-sm" aria-hidden="true">🧠</span>
          <h1 ref={headingRef} className="login-title" tabIndex={-1}>{title}</h1>
        </div>

        {backendWarning && <p className="login-notice" role="status">{backendWarning}</p>}
        {!!error && <p className="login-error" role="alert">{error}</p>}
        {!!status && <p className="login-submitted-notice" role="status">{status}</p>}

        <form className="login-form" onSubmit={onSubmit} noValidate>
          {(mode === 'login' || mode === 'register' || mode === 'forgot-password') && (
            <div className="login-field">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                maxLength={254}
                disabled={pending}
              />
            </div>
          )}

          {(mode === 'login' || mode === 'reset-password' || mode === 'register') && (
            <div className="login-field">
              <label htmlFor="login-password">Password</label>
              <input
                id="login-password"
                type="password"
                name="password"
                autoComplete={mode === 'register' || mode === 'reset-password' ? 'new-password' : 'current-password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                maxLength={128}
                disabled={pending}
              />
            </div>
          )}

          {/* Confirm password only needed for Node self-hosted auth */}
          {!isManagedAuth && (mode === 'register' || mode === 'reset-password') && (
            <div className="login-field">
              <label htmlFor="login-password-confirm">Confirm password</label>
              <input
                id="login-password-confirm"
                type="password"
                name="passwordConfirm"
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={e => setPasswordConfirm(e.target.value)}
                required
                minLength={8}
                maxLength={128}
                disabled={pending}
              />
            </div>
          )}

          {mode === 'verify-email' && (
            <p className="login-notice">
              {isManagedAuth
                ? 'Click the verification link in your email. Once verified, you will be signed in automatically.'
                : 'Use the verification link from your email, then submit to complete verification.'}
            </p>
          )}

          <button type="submit" className="login-submit-btn" disabled={pending || !hasBackend}>
            {pending ? 'Please wait…' : title}
          </button>
        </form>

        <nav className="login-links" aria-label="Authentication navigation">
          {mode !== 'login' && (
            <button type="button" className="login-back-btn" onClick={() => onNavigate('login')}>
              Log in
            </button>
          )}
          {mode !== 'register' && (
            <button type="button" className="login-back-btn" onClick={() => onNavigate('register')}>
              Create account
            </button>
          )}
          {mode !== 'forgot-password' && (
            <button type="button" className="login-back-btn" onClick={() => onNavigate('forgot-password')}>
              Forgot password
            </button>
          )}
          {mode === 'verify-email' && (
            <button type="button" className="login-back-btn" onClick={onResendVerification} disabled={pending || !hasBackend}>
              Resend verification
            </button>
          )}
        </nav>

        <button
          type="button"
          className="login-back-btn"
          onClick={onBackToChat}
          aria-label="Back to chat"
        >
          ← Back to chat
        </button>
      </div>
    </main>
  )
}
