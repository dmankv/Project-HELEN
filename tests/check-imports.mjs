/**
 * Cross-platform import-chain verification (replaces the POSIX-only shell
 * one-liner that was previously inlined in package.json's check:imports).
 *
 * Verifies that:
 *   - The five key source files exist.
 *   - main.tsx imports from './App'.
 *   - App.tsx imports from './components/HelenInterface' and './components/LoginView'.
 *   - HelenInterface.tsx imports helenResponseBrain, helenMemory, and helenChatAPI.
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
const helen = read('src/components/HelenInterface.tsx')
read('src/components/LoginView.tsx')

requireContains(main, `from './App'`, "main.tsx imports from './App'")
requireContains(app, `from './components/HelenInterface'`, "App.tsx imports from './components/HelenInterface'")
requireContains(app, `from './components/LoginView'`, "App.tsx imports from './components/LoginView'")
requireContains(helen, 'helenResponseBrain', 'HelenInterface.tsx imports helenResponseBrain')
requireContains(helen, 'helenMemory', 'HelenInterface.tsx imports helenMemory')
requireContains(helen, 'helenChatAPI', 'HelenInterface.tsx imports helenChatAPI')

console.log('Import chain checks passed.')
