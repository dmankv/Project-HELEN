import '@testing-library/jest-dom'

// scrollIntoView is not implemented in jsdom; stub it out so components that
// call messagesEndRef.current?.scrollIntoView() don't throw.
window.HTMLElement.prototype.scrollIntoView = vi.fn()

// Mock localStorage so tests never touch real browser storage.
const store: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { Object.keys(store).forEach(k => delete store[k]) },
  },
  writable: false,
})
