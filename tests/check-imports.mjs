/**
 * Cross-platform import-chain verification (replaces the POSIX-only shell
 * one-liner that was previously inlined in package.json's check:imports).
 *
 * Verifies that:
 *   - Active frontend, CLI, wrapper, auth, and server files use Daemon paths.
 *   - Legacy HELEN filenames and stale import paths are absent.
 *   - The protected GitHub Pages base remains /Project-HELEN/.
 *   - Supabase migration timestamps are in strictly ascending order and all
 *     future migrations use a timestamp greater than the current maximum.
 *   - Production source files do not introduce prefixed ID construction
 *     patterns (e.g. `daemon-${…}`, `'mem-' +`) that violate the UUID-only
 *     ID contract enforced by daemonStorageMigration.ts.
 *   - Frontend source files do not contain literal provider secret-key names
 *     (OPENAI_API_KEY, ANTHROPIC_API_KEY) that were removed in commit 84909fa.
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

// ---------------------------------------------------------------------------
// 5c — Migration timestamp ordering
//
// All migration filenames must parse as strictly ascending 14-digit timestamps
// (YYYYMMDDHHmmss). This prevents a future migration from accidentally being
// applied before an existing one, which could break RLS policies or FK
// constraints.  The current highest timestamp is printed so contributors know
// what value to exceed when adding a new migration.
// ---------------------------------------------------------------------------
{
  const migrationsDir = path.join(root, 'supabase', 'migrations')
  if (fs.existsSync(migrationsDir)) {
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort()

    let prev = '0'
    for (const file of migrationFiles) {
      const ts = file.slice(0, 14)
      if (!/^\d{14}$/.test(ts)) {
        console.error(`Migration check failed: filename "${file}" does not start with a 14-digit timestamp (YYYYMMDDHHmmss)`)
        process.exit(1)
      }
      if (ts <= prev) {
        console.error(
          `Migration check failed: "${file}" timestamp ${ts} is not strictly greater than previous ${prev}.` +
          ' Migrations must have strictly ascending timestamps.',
        )
        process.exit(1)
      }
      prev = ts
    }
    if (migrationFiles.length > 0) {
      console.log(`Migration timestamp check passed. Max timestamp: ${prev} (next migration must use > ${prev})`)
    }
  }
}

// ---------------------------------------------------------------------------
// 5d — Prefixed ID construction patterns
//
// All Daemon entity IDs must be raw UUID v4 strings produced by genUUID().
// The patterns below match the legacy construction forms documented in
// daemonStorageMigration.ts:
//   "daemon-<ts>-<n>"  → /`daemon-\$\{|['"]daemon-[0-9]/
//   "mem-<uuid>"       → /`mem-\$\{|['"]mem-[0-9a-f]/
//   "interaction-<ts>" → /`interaction-\$\{|['"]interaction-[0-9]/
//
// The migration service itself is excluded (it explicitly handles legacy IDs).
// ---------------------------------------------------------------------------
{
  const prefixedIdPatterns = [
    { re: /`daemon-\$\{|['"]daemon-['"]\s*\+|['"]daemon-[0-9]/, label: 'legacy "daemon-<timestamp>" ID construction' },
    { re: /`mem-\$\{|['"]mem-['"]\s*\+|['"]mem-[0-9a-f]/, label: 'legacy "mem-<uuid>" ID construction' },
    { re: /`interaction-\$\{|['"]interaction-['"]\s*\+|['"]interaction-[0-9]/, label: 'legacy "interaction-<timestamp>" ID construction' },
  ]

  function scanDir(dir, excludeFile) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanDir(fullPath, excludeFile)
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        if (fullPath === excludeFile) continue
        const content = fs.readFileSync(fullPath, 'utf8')
        for (const { re, label } of prefixedIdPatterns) {
          if (re.test(content)) {
            console.error(
              `Prefixed-ID check failed in ${path.relative(root, fullPath)}: found ${label}.` +
              ' Use genUUID() from daemonStorageMigration instead.',
            )
            process.exit(1)
          }
        }
      }
    }
  }

  const migrationService = path.join(root, 'src', 'services', 'daemonStorageMigration.ts')
  scanDir(path.join(root, 'src'), migrationService)
  console.log('Prefixed-ID construction check passed.')
}

// ---------------------------------------------------------------------------
// 5f — Provider secret-key names in frontend source
//
// The frontend must not contain the literal strings OPENAI_API_KEY or
// ANTHROPIC_API_KEY. Provider keys are Supabase Vault secrets accessed only
// inside the daemon-chat Edge Function (see commit 84909fa). Their presence
// in frontend files is a hygiene failure that suggests a key might be leaked
// via a future environment variable or template substitution.
// ---------------------------------------------------------------------------
{
  const bannedKeyNames = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
  const frontendDirs = [
    path.join(root, 'src'),
  ]

  function scanFrontendDir(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanFrontendDir(fullPath)
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8')
        for (const keyName of bannedKeyNames) {
          if (content.includes(keyName)) {
            console.error(
              `Secret-key hygiene check failed in ${path.relative(root, fullPath)}: ` +
              `literal "${keyName}" must not appear in frontend source. ` +
              'Provider keys belong only in Supabase Vault / Edge Function secrets.',
            )
            process.exit(1)
          }
        }
      }
    }
  }

  for (const dir of frontendDirs) {
    scanFrontendDir(dir)
  }
  console.log('Provider secret-key name check passed.')
}

console.log('Import chain checks passed.')
