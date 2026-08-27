import { useState, useEffect, useCallback } from 'react'
import DaemonInterface from './components/DaemonInterface'
import LoginView from './components/LoginView'
import AccessDenied from './components/AccessDenied'
import AdminDaemonInterface from './components/AdminDaemonInterface'
import {
  getCurrentSession,
  hasAuthBackend,
  hasAnyAuth,
  logoutUser,
} from './services/daemonAuthAPI'
import {
  hasSupabaseConfig,
  supabaseGetCurrentSession,
  supabaseLogout,
  supabaseOnAuthStateChange,
} from './services/supabaseAuthAPI'
import type { AuthUser } from './services/daemonAuthAPI'

type Route =
  | 'chat'
  | 'admin-daemon'
  | 'login'
  | 'register'
  | 'forgot-password'
  | 'reset-password'
  | 'verify-email'

interface ParsedRoute {
  route: Route
  token: string
}

function parseRoute(hash: string): ParsedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const pathAndQuery = raw || '/'
  const [pathPart, queryPart = ''] = pathAndQuery.split('?')
  const params = new URLSearchParams(queryPart)
  const token = params.get('token') ?? ''

  switch (pathPart) {
    case '/admin-daemon':
      return { route: 'admin-daemon', token: '' }
    case '/login':
      return { route: 'login', token }
    case '/register':
      return { route: 'register', token }
    case '/forgot-password':
      return { route: 'forgot-password', token }
    case '/reset-password':
      return { route: 'reset-password', token }
    case '/verify-email':
      return { route: 'verify-email', token }
    default:
      return { route: 'chat', token: '' }
  }
}

function App() {
  const [{ route, token }, setParsedRoute] = useState<ParsedRoute>(() => parseRoute(window.location.hash))
  const [authReady, setAuthReady] = useState(false)
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null)

  useEffect(() => {
    const onHashChange = () => setParsedRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Session restore on mount.
  // Supabase is the primary path; falls back to the self-hosted Node API.
  useEffect(() => {
    let mounted = true
    async function initAuth() {
      if (hasSupabaseConfig()) {
        const user = await supabaseGetCurrentSession()
        if (mounted) {
          setCurrentUser(user)
          setAuthReady(true)
        }
        return
      }
      if (!hasAuthBackend()) {
        if (mounted) {
          setCurrentUser(null)
          setAuthReady(true)
        }
        return
      }
      const user = await getCurrentSession()
      if (mounted) {
        setCurrentUser(user)
        setAuthReady(true)
      }
    }
    void initAuth()
    return () => {
      mounted = false
    }
  }, [])

  // Subscribe to Supabase auth state changes (e.g. email link callback).
  useEffect(() => {
    if (!hasSupabaseConfig()) return
    const unsubscribe = supabaseOnAuthStateChange((user, event) => {
      setCurrentUser(user)
      // Only redirect to chat on a real SIGNED_IN event triggered by an
      // email-link callback (the URL will contain the Supabase access_token
      // fragment). Silent token refreshes must NOT interrupt the current page.
      if (
        event === 'SIGNED_IN' &&
        user &&
        typeof window !== 'undefined' &&
        window.location.hash.includes('access_token=')
      ) {
        window.location.hash = '#/'
      }
    })
    return unsubscribe
  }, [])

  const navigate = useCallback((next: Route, routeToken = '') => {
    if (next === 'chat') {
      window.location.hash = '#/'
      return
    }
    if (next === 'admin-daemon') {
      window.location.hash = '#/admin-daemon'
      return
    }
    const encoded = routeToken ? `?token=${encodeURIComponent(routeToken)}` : ''
    window.location.hash = `#/${next}${encoded}`
  }, [])

  const handleAuthSuccess = useCallback((user: AuthUser) => {
    setCurrentUser(user)
    navigate('chat')
  }, [navigate])

  const handleLogout = useCallback(async () => {
    if (hasSupabaseConfig()) {
      await supabaseLogout()
    } else {
      await logoutUser()
    }
    setCurrentUser(null)
    navigate('chat')
  }, [navigate])

  if (!authReady) {
    return <main style={{ padding: '2rem' }}>Loading…</main>
  }

  // ── Admin Daemon route ──────────────────────────────────────────────────
  if (route === 'admin-daemon') {
    const isAdmin = currentUser?.role === 'admin'
    if (!isAdmin) {
      // Show access-denied for anonymous and authenticated non-admin users.
      // Do not disclose that an admin section exists to non-admins.
      return (
        <AccessDenied
          currentUser={currentUser}
          onLoginClick={() => navigate('login')}
          onBackToPublic={() => navigate('chat')}
        />
      )
    }
    return (
      <AdminDaemonInterface
        currentUser={currentUser}
        onBackToPublic={() => navigate('chat')}
        onLogoutClick={handleLogout}
      />
    )
  }

  if (route !== 'chat') {
    return (
      <LoginView
        mode={route}
        token={token}
        hasBackend={hasAnyAuth()}
        isManagedAuth={hasSupabaseConfig()}
        onBackToChat={() => navigate('chat')}
        onNavigate={navigate}
        onAuthSuccess={handleAuthSuccess}
      />
    )
  }

  return (
    <DaemonInterface
      currentUser={currentUser}
      onLoginClick={() => navigate('login')}
      onLogoutClick={currentUser ? handleLogout : undefined}
      onAdminDaemonClick={currentUser?.role === 'admin' ? () => navigate('admin-daemon') : undefined}
    />
  )
}

export default App
