import { useEffect, useState } from 'react'
import HelenInterface from './components/HelenInterface'
import LoginView from './components/LoginView'
import { hashForView, viewFromHash } from './viewRouting'

function App() {
  const [view, setView] = useState(() => viewFromHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => {
      setView(viewFromHash(window.location.hash))
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const navigateTo = (nextView: 'chat' | 'login') => {
    const nextHash = hashForView(nextView)
    if (window.location.hash !== nextHash) {
      window.location.hash = nextHash
      return
    }
    setView(nextView)
  }

  if (view === 'login') {
    return <LoginView onBackToChat={() => navigateTo('chat')} />
  }

  return <HelenInterface onLogInClick={() => navigateTo('login')} />
}

export default App
