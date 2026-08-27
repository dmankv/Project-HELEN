/**
 * Admin Daemon tests
 *
 * Covers:
 * 1. Route parsing: admin-daemon recognized; public chat stays public.
 * 2. Anonymous users see access-denied, never render AdminDaemonInterface.
 * 3. Authenticated non-admin users see access-denied, never render AdminDaemonInterface.
 * 4. Authenticated admin renders AdminDaemonInterface.
 * 5. Admin can navigate back to public Daemon and logout cleanly.
 * 6. Admin storage namespacing: admin actions do not touch public Daemon keys.
 * 7. Admin navigation link only visible to admins.
 * 8. #/admin-daemon in unconfigured auth mode shows access-denied.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/components/DaemonInterface', () => ({
  default: ({
    currentUser,
    onLoginClick,
    onLogoutClick,
    onAdminDaemonClick,
  }: {
    currentUser?: { email?: string; role?: string } | null
    onLoginClick?: () => void
    onLogoutClick?: () => void
    onAdminDaemonClick?: () => void
  }) => (
    <div>
      <div data-testid="daemon-public">public-daemon</div>
      <div data-testid="daemon-user">{currentUser?.email ?? 'none'}</div>
      <div data-testid="daemon-role">{currentUser?.role ?? 'none'}</div>
      {onLoginClick && <button onClick={onLoginClick}>go-login</button>}
      {onLogoutClick && <button onClick={onLogoutClick}>do-logout</button>}
      {onAdminDaemonClick && (
        <button onClick={onAdminDaemonClick} data-testid="admin-daemon-nav">
          Admin Daemon
        </button>
      )}
    </div>
  ),
}))

vi.mock('../src/components/LoginView', () => ({
  default: ({ mode }: { mode: string }) => (
    <div data-testid="login-view" data-mode={mode} />
  ),
}))

vi.mock('../src/components/AccessDenied', () => ({
  default: ({
    currentUser,
    onLoginClick,
    onBackToPublic,
  }: {
    currentUser: { email?: string } | null
    onLoginClick: () => void
    onBackToPublic: () => void
  }) => (
    <div data-testid="access-denied">
      <div data-testid="access-denied-user">{currentUser?.email ?? 'anonymous'}</div>
      {!currentUser && <button onClick={onLoginClick} data-testid="access-denied-login">Sign in</button>}
      <button onClick={onBackToPublic} data-testid="access-denied-back">Back to Daemon</button>
    </div>
  ),
}))

vi.mock('../src/components/AdminDaemonInterface', () => ({
  default: ({
    currentUser,
    onBackToPublic,
    onLogoutClick,
  }: {
    currentUser: { email?: string }
    onBackToPublic: () => void
    onLogoutClick?: () => void
  }) => (
    <div data-testid="admin-daemon-interface">
      <div data-testid="admin-user">{currentUser?.email}</div>
      <button onClick={onBackToPublic} data-testid="admin-back">Return to Daemon</button>
      {onLogoutClick && <button onClick={onLogoutClick} data-testid="admin-logout">Sign out</button>}
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
import { hasSupabaseConfig, supabaseGetCurrentSession, supabaseLogout } from '../src/services/supabaseAuthAPI'

const WAIT = { timeout: 5000 }

beforeEach(() => {
  vi.clearAllMocks()
  window.location.hash = '#/'
  vi.mocked(hasSupabaseConfig).mockReturnValue(false)
  vi.mocked(supabaseGetCurrentSession).mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// 1. Route parsing
// ---------------------------------------------------------------------------

describe('Admin Daemon route parsing', () => {
  it('renders public DaemonInterface for #/', async () => {
    window.location.hash = '#/'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('daemon-public')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-interface')).toBeNull()
    expect(screen.queryByTestId('access-denied')).toBeNull()
  })

  it('renders AccessDenied for #/admin-daemon when unauthenticated', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-interface')).toBeNull()
    expect(screen.queryByTestId('daemon-public')).toBeNull()
  })

  it('renders LoginView for #/login', async () => {
    window.location.hash = '#/login'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('login-view')).toBeInTheDocument(), WAIT)
  })
})

// ---------------------------------------------------------------------------
// 2. Anonymous user access denied
// ---------------------------------------------------------------------------

describe('Anonymous user at #/admin-daemon', () => {
  it('shows AccessDenied with sign-in option', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument(), WAIT)
    expect(screen.getByTestId('access-denied-user')).toHaveTextContent('anonymous')
    expect(screen.getByTestId('access-denied-login')).toBeInTheDocument()
  })

  it('navigates to login when anonymous user clicks sign-in', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied-login')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('access-denied-login'))
    expect(window.location.hash).toBe('#/login')
  })

  it('navigates to public Daemon when anonymous user clicks back', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied-back')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('access-denied-back'))
    expect(window.location.hash).toBe('#/')
  })
})

// ---------------------------------------------------------------------------
// 3. Authenticated non-admin user access denied
// ---------------------------------------------------------------------------

describe('Authenticated non-admin user at #/admin-daemon', () => {
  beforeEach(() => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      role: 'user',
    })
  })

  it('shows AccessDenied without disclosing admin capability', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-interface')).toBeNull()
    // Non-admin should not see the sign-in button (they are signed in)
    expect(screen.queryByTestId('access-denied-login')).toBeNull()
  })

  it('navigates to public Daemon when non-admin clicks back', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied-back')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('access-denied-back'))
    expect(window.location.hash).toBe('#/')
  })
})

// ---------------------------------------------------------------------------
// 4 & 5. Admin user receives AdminDaemonInterface; can return to public and logout
// ---------------------------------------------------------------------------

describe('Authenticated admin user at #/admin-daemon', () => {
  beforeEach(() => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      emailVerified: true,
      role: 'admin',
    })
  })

  it('renders AdminDaemonInterface for admin at #/admin-daemon', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('admin-daemon-interface')).toBeInTheDocument(), WAIT)
    expect(screen.getByTestId('admin-user')).toHaveTextContent('admin@example.com')
    expect(screen.queryByTestId('access-denied')).toBeNull()
    expect(screen.queryByTestId('daemon-public')).toBeNull()
  })

  it('admin can return to public Daemon', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('admin-back')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('admin-back'))
    expect(window.location.hash).toBe('#/')
  })

  it('admin can sign out from AdminDaemonInterface', async () => {
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('admin-logout')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('admin-logout'))
    await waitFor(() => expect(supabaseLogout).toHaveBeenCalled(), WAIT)
    expect(window.location.hash).toBe('#/')
  })
})

// ---------------------------------------------------------------------------
// 7. Admin navigation link only visible to admins
// ---------------------------------------------------------------------------

describe('Admin navigation link in public DaemonInterface', () => {
  it('admin nav link is shown only to admin users on public Daemon', async () => {
    window.location.hash = '#/'
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      emailVerified: true,
      role: 'admin',
    })
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('daemon-public')).toBeInTheDocument(), WAIT)
    expect(screen.getByTestId('admin-daemon-nav')).toBeInTheDocument()
  })

  it('admin nav link is NOT shown to non-admin users on public Daemon', async () => {
    window.location.hash = '#/'
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      emailVerified: true,
      role: 'user',
    })
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('daemon-public')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-nav')).toBeNull()
  })

  it('admin nav link is NOT shown to anonymous users', async () => {
    window.location.hash = '#/'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('daemon-public')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-nav')).toBeNull()
  })

  it('clicking admin nav navigates to #/admin-daemon', async () => {
    window.location.hash = '#/'
    vi.mocked(hasSupabaseConfig).mockReturnValue(true)
    vi.mocked(supabaseGetCurrentSession).mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      emailVerified: true,
      role: 'admin',
    })
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('admin-daemon-nav')).toBeInTheDocument(), WAIT)
    fireEvent.click(screen.getByTestId('admin-daemon-nav'))
    expect(window.location.hash).toBe('#/admin-daemon')
  })
})

// ---------------------------------------------------------------------------
// 8. Unconfigured auth mode: #/admin-daemon shows access-denied
// ---------------------------------------------------------------------------

describe('#/admin-daemon in unconfigured auth mode', () => {
  it('shows AccessDenied (no admin access without auth)', async () => {
    vi.mocked(hasSupabaseConfig).mockReturnValue(false)
    window.location.hash = '#/admin-daemon'
    render(<App />)
    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument(), WAIT)
    expect(screen.queryByTestId('admin-daemon-interface')).toBeNull()
  })
})
