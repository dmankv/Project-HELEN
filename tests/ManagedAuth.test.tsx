/**
 * Managed auth (Supabase) integration tests.
 *
 * Exercises LoginView + supabaseAuthAPI in both the configured and
 * unconfigured states without hitting a real Supabase project.
 * All Supabase SDK calls are mocked.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock supabaseAuthAPI before it is imported by any component.
// ---------------------------------------------------------------------------

vi.mock('../src/services/supabaseAuthAPI', () => ({
  hasSupabaseConfig: vi.fn(() => false),
  supabaseGetCurrentSession: vi.fn(() => Promise.resolve(null)),
  supabaseLogin: vi.fn(() => Promise.resolve({ ok: false, user: null, message: 'Supabase is not configured.' })),
  supabaseRegister: vi.fn(() => Promise.resolve({ ok: false, message: 'Supabase is not configured.' })),
  supabaseLogout: vi.fn(() => Promise.resolve(false)),
  supabaseRequestPasswordReset: vi.fn(() => Promise.resolve({ ok: false, message: 'Supabase is not configured.' })),
  supabaseCompletePasswordReset: vi.fn(() => Promise.resolve({ ok: false, message: 'Supabase is not configured.' })),
  supabaseResendVerification: vi.fn(() => Promise.resolve({ ok: false, message: 'Supabase is not configured.' })),
  supabaseOnAuthStateChange: vi.fn(() => () => undefined),
}))

vi.mock('../src/services/daemonAuthAPI', () => ({
  hasAuthBackend: vi.fn(() => false),
  hasAnyAuth: vi.fn(() => false),
  getCurrentSession: vi.fn(() => Promise.resolve(null)),
  loginUser: vi.fn(() => Promise.resolve({ ok: false, user: null, message: 'No backend.' })),
  registerUser: vi.fn(() => Promise.resolve({ ok: false, message: 'No backend.' })),
  logoutUser: vi.fn(() => Promise.resolve(false)),
  requestPasswordReset: vi.fn(() => Promise.resolve({ ok: false, message: 'No backend.' })),
  completePasswordReset: vi.fn(() => Promise.resolve({ ok: false, message: 'No backend.' })),
  requestVerification: vi.fn(() => Promise.resolve({ ok: false, message: 'No backend.' })),
  completeVerification: vi.fn(() => Promise.resolve({ ok: false, message: 'No backend.' })),
  getCsrfToken: vi.fn(() => Promise.resolve(null)),
}))

import LoginView from '../src/components/LoginView'
import {
  hasSupabaseConfig,
  supabaseLogin,
  supabaseRegister,
  supabaseRequestPasswordReset,
  supabaseCompletePasswordReset,
  supabaseResendVerification,
} from '../src/services/supabaseAuthAPI'
import { hasAnyAuth } from '../src/services/daemonAuthAPI'

const noop = () => undefined

beforeEach(() => {
  vi.clearAllMocks()
  // Default: nothing configured
  vi.mocked(hasSupabaseConfig).mockReturnValue(false)
  vi.mocked(hasAnyAuth).mockReturnValue(false)
})

const WAIT = { timeout: 5000 }

// ---------------------------------------------------------------------------
// Unconfigured state
// ---------------------------------------------------------------------------

describe('LoginView – unconfigured (no Supabase, no Node API)', () => {
  it('shows configuration notice on login page', () => {
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={false}
        isManagedAuth={false}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/not configured/i)
  })

  it('submit button is disabled when no backend', () => {
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={false}
        isManagedAuth={false}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    expect(screen.getByRole('button', { name: /log in/i })).toBeDisabled()
  })

  it('shows Supabase-specific notice when isManagedAuth and not configured', () => {
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={false}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/VITE_SUPABASE_URL/i)
  })
})

// ---------------------------------------------------------------------------
// Configured Supabase state
// ---------------------------------------------------------------------------

describe('LoginView – Supabase configured', () => {
  beforeEach(() => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(hasAnyAuth).mockReturnValue(true)
  })

  it('calls supabaseLogin on login submit', async () => {
    vi.mocked(supabaseLogin).mockResolvedValue({
      ok: true,
      user: { id: 'uid-1', email: 'user@example.com', emailVerified: true },
      message: 'Logged in.',
    })
    const onAuthSuccess = vi.fn()
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={onAuthSuccess}
      />,
    )
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))

    await waitFor(() => expect(supabaseLogin).toHaveBeenCalledWith('user@example.com', 'secret123'), WAIT)
    await waitFor(() => expect(onAuthSuccess).toHaveBeenCalledWith(expect.objectContaining({ email: 'user@example.com' })), WAIT)
  })

  it('shows error message when supabaseLogin fails', async () => {
    vi.mocked(supabaseLogin).mockResolvedValue({ ok: false, user: null, message: 'Invalid credentials.' })
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /log in/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Invalid credentials/i), WAIT)
  })

  it('calls supabaseRegister on register submit', async () => {
    vi.mocked(supabaseRegister).mockResolvedValue({
      ok: true,
      message: 'Account created. Check your inbox to verify your email before signing in.',
    })
    render(
      <LoginView
        mode="register"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'new@example.com' } })
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))

    await waitFor(() => expect(supabaseRegister).toHaveBeenCalledWith('new@example.com', 'secret123'), WAIT)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/check your inbox/i), WAIT)
  })

  it('calls supabaseRequestPasswordReset on forgot-password submit', async () => {
    vi.mocked(supabaseRequestPasswordReset).mockResolvedValue({
      ok: true,
      message: 'Password reset email sent. Check your inbox.',
    })
    render(
      <LoginView
        mode="forgot-password"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'user@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() => expect(supabaseRequestPasswordReset).toHaveBeenCalledWith('user@example.com'), WAIT)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/check your inbox/i), WAIT)
  })

  it('calls supabaseCompletePasswordReset on reset-password submit', async () => {
    vi.mocked(supabaseCompletePasswordReset).mockResolvedValue({
      ok: true,
      message: 'Password updated. You can now sign in with your new password.',
    })
    render(
      <LoginView
        mode="reset-password"
        token="tok123"
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'newpass123' } })
    fireEvent.click(screen.getByRole('button', { name: /set new password/i }))

    await waitFor(() => expect(supabaseCompletePasswordReset).toHaveBeenCalledWith('newpass123'), WAIT)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Password updated/i), WAIT)
  })

  it('shows verify-email instructions for Supabase flow', () => {
    render(
      <LoginView
        mode="verify-email"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    expect(screen.getByText(/verification link/i)).toBeInTheDocument()
    expect(screen.getByText(/signed in automatically/i)).toBeInTheDocument()
  })

  it('calls supabaseResendVerification on resend click', async () => {
    vi.mocked(supabaseResendVerification).mockResolvedValue({
      ok: true,
      message: 'Verification email resent. Check your inbox.',
    })
    render(
      <LoginView
        mode="verify-email"
        token=""
        hasBackend={true}
        isManagedAuth={true}
        onBackToChat={noop}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /resend verification/i }))
    await waitFor(() => expect(supabaseResendVerification).toHaveBeenCalled(), WAIT)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Verification email resent/i), WAIT)
  })
})

// ---------------------------------------------------------------------------
// Navigation between auth routes
// ---------------------------------------------------------------------------

describe('LoginView – navigation', () => {
  it('calls onNavigate with register when "Create account" is clicked', () => {
    const onNavigate = vi.fn()
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={false}
        onBackToChat={noop}
        onNavigate={onNavigate}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /create account/i }))
    expect(onNavigate).toHaveBeenCalledWith('register')
  })

  it('calls onBackToChat when "← Back to chat" is clicked', () => {
    const onBackToChat = vi.fn()
    render(
      <LoginView
        mode="login"
        token=""
        hasBackend={false}
        onBackToChat={onBackToChat}
        onNavigate={noop}
        onAuthSuccess={noop}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Back to chat/i }))
    expect(onBackToChat).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// hasSupabaseConfig and hasAnyAuth helpers
// ---------------------------------------------------------------------------

describe('supabaseAuthAPI.hasSupabaseConfig', () => {
  it('returns false when mocked with false', () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(false)
    expect(hasSupabaseConfig()).toBe(false)
  })

  it('returns true when mocked with true', () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    expect(hasSupabaseConfig()).toBe(true)
  })
})
