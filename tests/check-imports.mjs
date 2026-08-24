/**
 * Cross-platform import-chain verification (replaces the POSIX-only shell
 * one-liner that was previously inlined in package.json's check:imports).
 *
 * Verifies that:
 *   - Active frontend, CLI, wrapper, auth, and server files use Daemon paths.
 *   - Legacy HELEN filenames and stale import paths are absent.
 *   - The protected GitHub Pages base remains /Project-HELEN/.
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

function requireNotMatches(content, pattern, description) {
  if (pattern.test(content)) {
    console.error(`Import check failed: ${description}`)
    process.exit(1)
  }
}

function requireMissingFile(rel) {
  if (fs.existsSync(path.join(root, rel))) {
    console.error(`Import check failed: legacy file remains: ${rel}`)
    process.exit(1)
  }
}

const main = read('src/main.tsx')
const app = read('src/App.tsx')
const daemon = read('src/components/DaemonInterface.tsx')
const login = read('src/components/LoginView.tsx')
const authApi = read('src/services/daemonAuthAPI.ts')
const chatApi = read('src/services/daemonChatAPI.ts')
const cli = read('src/cli/daemon-cli.ts')
const shellWrapper = read('bin/daemon.sh')
const pythonWrapper = read('bin/daemon-cli.py')
const server = read('server/index.ts')
const vite = read('vite.config.ts')
const packageJson = read('package.json')

requireContains(main, `from './App'`, "main.tsx imports from './App'")
requireContains(app, `from './components/DaemonInterface'`, "App.tsx imports from './components/DaemonInterface'")
requireContains(app, `from './components/LoginView'`, "App.tsx imports from './components/LoginView'")
requireContains(app, `from './services/daemonAuthAPI'`, "App.tsx imports daemonAuthAPI")
requireContains(daemon, 'daemonResponseBrain', 'DaemonInterface.tsx imports daemonResponseBrain')
requireContains(daemon, 'daemonMemory', 'DaemonInterface.tsx imports daemonMemory')
requireContains(daemon, 'daemonChatAPI', 'DaemonInterface.tsx imports daemonChatAPI')
requireContains(daemon, 'daemonStorageMigration', 'DaemonInterface.tsx imports daemon storage migration')
requireContains(login, 'daemonAuthAPI', 'LoginView imports daemonAuthAPI')
requireContains(authApi, 'VITE_DAEMON', 'daemonAuthAPI reads Daemon frontend configuration')
requireContains(chatApi, 'VITE_DAEMON_API_URL', 'daemonChatAPI reads Daemon chat configuration')
requireContains(cli, 'daemonResponseBrain', 'CLI imports daemonResponseBrain')
requireContains(shellWrapper, 'src/cli/daemon-cli.ts', 'shell wrapper runs daemon CLI')
requireContains(pythonWrapper, 'src/cli/daemon-cli.ts', 'Python wrapper runs daemon CLI')
requireContains(server, 'DAEMON_SYSTEM_PROMPT', 'server uses Daemon system prompt')
requireContains(packageJson, 'tests/daemon-eval.mjs', 'package test script runs daemon evaluation')
requireContains(packageJson, 'src/cli/daemon-cli.ts', 'package CLI script runs daemon CLI')
requireContains(vite, "base: '/Project-HELEN/'", 'Vite preserves protected Pages base path')

for (const source of [app, daemon, login, authApi, chatApi, cli, shellWrapper, pythonWrapper]) {
  requireNotMatches(
    source,
    /(?:from\s+['"][^'"]*helen|src\/(?:components|services|cli)\/helen|bin\/helen)/i,
    'active source contains a stale Helen import or path',
  )
}

for (const legacyFile of [
  'HELEN_ACCESS_GUIDE.md',
  'bin/helen-cli.py',
  'bin/helen.sh',
  'docs/HELEN_SPEC.md',
  'src/cli/helen-cli.ts',
  'src/components/HelenInterface.tsx',
  'src/services/helenAuthAPI.ts',
  'src/services/helenChatAPI.ts',
  'src/services/helenMemory.ts',
  'src/services/helenResponseBrain.ts',
  'src/services/helen_learning_integration.ts',
  'src/styles/HelenInterface.css',
  'tests/HelenInterface.test.tsx',
  'tests/helen-eval.mjs',
]) {
  requireMissingFile(legacyFile)
}

console.log('Import chain checks passed.')
