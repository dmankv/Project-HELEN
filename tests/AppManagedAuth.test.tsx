import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/DaemonInterface', () => ({
  default: ({ currentUser, onLoginClick, onLogoutClick }: {
    currentUser?: { email?: string; role?: string } | null
    onLoginClick?: () => void
    onLogoutClick?: () => void
  }) => (
    <div>
      <div data-testid="daemon-user">{currentUser?.email ?? 'none'}</div>
      <div data-testid="daemon-role">{currentUser?.role ?? 'none'}</div>
      {onLoginClick && <button onClick={onLoginClick}>go-login</button>}
      {onLogoutClick && <button onClick={onLogoutClick}>do-logout</button>}
    </div>
  ),
}))

vi.mock('../src/components/LoginView', () => ({
  default: ({ mode, hasBackend, isManagedAuth }: { mode: string; hasBackend: boolean; isManagedAuth: boolean }) => (
    <div>
      <div data-testid="login-mode">{mode}</div>
      <div data-testid="login-has-backend">{String(hasBackend)}</div>
      <div data-testid="login-managed-auth">{String(isManagedAuth)}</div>
    </div>
  ),
}))

vi.mock('../src/services/daemonAuthAPI', () => ({
  getCurrentSession: vi.fn(() => Promise.resolve(null)),
  hasAuthBackend: vi.fn(() => false),
  hasAnyAuth: vi.fn(() => false),
  logoutUser: vi.fn(() => Promise.resolve(true)),
}))

vi.mock('../src/services/supabaseAuthAPI', () => ({
  hasSupabaseConfig: vi.fn(() => false),
  supabaseGetCurrentSession: vi.fn(() => Promise.resolve(null)),
  supabaseLogout: vi.fn(() => Promise.resolve(true)),
  supabaseOnAuthStateChange: vi.fn(() => () => undefined),
}))

import App from '../src/App'
import { getCurrentSession, hasAuthBackend, hasAnyAuth, logoutUser } from '../src/services/daemonAuthAPI'
import {
  hasSupabaseConfig,
  supabaseGetCurrentSession,
  supabaseLogout,
  supabaseOnAuthStateChange,
} from '../src/services/supabaseAuthAPI'

const WAIT = { timeout: 5000 }

beforeEach(() => {
  vi.clearAllMocks()
  window.location.hash = '#/'
  vi.mocked(hasSupabaseConfig).mockReturnValue(false)
  vi.mocked(hasAuthBackend).mockReturnValue(false)
  vi.mocked(hasAnyAuth).mockReturnValue(false)
})

describe('App managed-auth integration', () => {
  it('restores Supabase session when managed auth is configured', async () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(hasAnyAuth).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'u1',
      email: 'admin@example.com',
      emailVerified: true,
      role: 'admin',
    })

    render(<App />)

    await waitFor(() => expect(supabaseGetCurrentSession).toHaveBeenCalled(), WAIT)
    expect(getCurrentSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('daemon-user')).toHaveTextContent('admin@example.com')
    expect(screen.getByTestId('daemon-role')).toHaveTextContent('admin')
  })

  it('falls back to self-hosted session restore when Supabase is not configured', async () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(false)
    vi.mocked(hasAuthBackend).mockReturnValue(true)
    vi.mocked(hasAnyAuth).mockReturnValue(true)
    vi.mocked(getCurrentSession).mockResolvedValue({
      id: 'u2',
      email: 'user@example.com',
      emailVerified: true,
      role: 'user',
    })

    render(<App />)

    await waitFor(() => expect(getCurrentSession).toHaveBeenCalled(), WAIT)
    expect(supabaseGetCurrentSession).not.toHaveBeenCalled()
    expect(screen.getByTestId('daemon-user')).toHaveTextContent('user@example.com')
  })

  it('shows login route in unconfigured state without crashing', async () => {
    window.location.hash = '#/login'
    render(<App />)

    await waitFor(() => expect(screen.getByTestId('login-mode')).toHaveTextContent('login'), WAIT)
    expect(screen.getByTestId('login-has-backend')).toHaveTextContent('false')
    expect(screen.getByTestId('login-managed-auth')).toHaveTextContent('false')
  })

  it('logs out through Supabase path when managed auth is configured', async () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(hasAnyAuth).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'u1',
      email: 'admin@example.com',
      emailVerified: true,
      role: 'admin',
    })

    render(<App />)
    await waitFor(() => expect(screen.getByTestId('daemon-user')).toHaveTextContent('admin@example.com'), WAIT)

    fireEvent.click(screen.getByRole('button', { name: 'do-logout' }))
    await waitFor(() => expect(supabaseLogout).toHaveBeenCalled(), WAIT)
    expect(logoutUser).not.toHaveBeenCalled()
  })

  it('subscribes to Supabase auth state change and applies role from callback user', async () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(hasAnyAuth).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue(null)

    vi.mocked(supabaseOnAuthStateChange).mockImplementation((callback) => {
      const timer = window.setTimeout(() => {
        callback(
          { id: 'u3', email: 'role-user@example.com', emailVerified: true, role: 'user' },
          'SIGNED_IN',
        )
      }, 0)
      return () => window.clearTimeout(timer)
    })

    render(<App />)

    await waitFor(() => expect(screen.getByTestId('daemon-user')).toHaveTextContent('role-user@example.com'), WAIT)
    expect(screen.getByTestId('daemon-role')).toHaveTextContent('user')
  })
})
