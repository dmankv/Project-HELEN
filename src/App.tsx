import { useState } from 'react'
import ChatInterface from './components/ChatInterface'
import './App.css'

function App() {
  const [isDarkMode, setIsDarkMode] = useState(true)

  return (
    <div className={`app ${isDarkMode ? 'dark' : 'light'}`}>
      <header className="app-header">
        <h1>AI Assistant</h1>
        <button 
          className="theme-toggle"
          onClick={() => setIsDarkMode(!isDarkMode)}
        >
          {isDarkMode ? '☀️' : '🌙'}
        </button>
      </header>
      <main className="app-main">
        <ChatInterface />
      </main>
    </div>
  )
}

export default App
