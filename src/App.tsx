import { useState, useEffect, useCallback } from 'react'
import HelenInterface from './components/HelenInterface'
import LoginView from './components/LoginView'

type Route = 'chat' | 'login'

function getRoute(): Route {
  return window.location.hash === '#/login' ? 'login' : 'chat'
}

function App() {
  const [route, setRoute] = useState<Route>(getRoute)

  useEffect(() => {
    const onHashChange = () => setRoute(getRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const goToLogin = useCallback(() => {
    window.location.hash = '#/login'
  }, [])

  const goToChat = useCallback(() => {
    window.location.hash = '#/'
  }, [])

  if (route === 'login') {
    return <LoginView onBackToChat={goToChat} />
  }

  return <HelenInterface onLoginClick={goToLogin} />
}

export default App
