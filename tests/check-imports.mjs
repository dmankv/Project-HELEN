/**
 * Cross-platform import-chain verification (replaces the POSIX-only shell
 * one-liner that was previously inlined in package.json's check:imports).
 *
 * Verifies that:
 *   - The five key source files exist.
 *   - main.tsx imports from './App'.
 *   - App.tsx imports from './components/DaemonInterface' and './components/LoginView'.
 *   - DaemonInterface.tsx imports daemonResponseBrain, daemonMemory, and daemonChatAPI.
 *
 * Exits non-zero and prints a message on the first failure.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  const full = path.join(root, rel)
  if (!fs.existsSync(full)) {
    console.error(`Missing file: ${rel}`)
    process.exit(1)
  }
  return fs.readFileSync(full, 'utf8')
}

function requireContains(content, pattern, description) {
  const ok = typeof pattern === 'string'
    ? content.includes(pattern)
    : pattern.test(content)
  if (!ok) {
    console.error(`Import check failed: ${description}`)
    process.exit(1)
  }
}

const main = read('src/main.tsx')
const app = read('src/App.tsx')
const daemon = read('src/components/DaemonInterface.tsx')
read('src/components/LoginView.tsx')

requireContains(main, `from './App'`, "main.tsx imports from './App'")
requireContains(app, `from './components/DaemonInterface'`, "App.tsx imports from './components/DaemonInterface'")
requireContains(app, `from './components/LoginView'`, "App.tsx imports from './components/LoginView'")
requireContains(daemon, 'daemonResponseBrain', 'DaemonInterface.tsx imports daemonResponseBrain')
requireContains(daemon, 'daemonMemory', 'DaemonInterface.tsx imports daemonMemory')
requireContains(daemon, 'daemonChatAPI', 'DaemonInterface.tsx imports daemonChatAPI')

console.log('Import chain checks passed.')
