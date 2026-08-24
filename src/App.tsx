import { useState, useEffect, useCallback } from 'react'
import DaemonInterface from './components/DaemonInterface'
import LoginView from './components/LoginView'
import {
  getCurrentSession,
  hasAuthBackend,
  logoutUser,
} from './services/daemonAuthAPI'
import type { AuthUser } from './services/daemonAuthAPI'

type Route =
  | 'chat'
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

  useEffect(() => {
    let mounted = true
    async function initAuth() {
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

  const navigate = useCallback((next: Route, routeToken = '') => {
    if (next === 'chat') {
      window.location.hash = '#/'
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
    await logoutUser()
    setCurrentUser(null)
    navigate('chat')
  }, [navigate])

  if (!authReady) {
    return <main style={{ padding: '2rem' }}>Loading…</main>
  }

  if (route !== 'chat') {
    return (
      <LoginView
        mode={route}
        token={token}
        hasBackend={hasAuthBackend()}
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
    />
  )
}

export default App
