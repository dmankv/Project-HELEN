/**
 * Cross-platform import-chain verification (replaces the POSIX-only shell
 * one-liner that was previously inlined in package.json's check:imports).
 *
 * Verifies that:
 *   - Active frontend, CLI, wrapper, auth, and server files use Daemon paths.
 *   - Legacy HELEN filenames and stale import paths are absent.
 *   - The protected GitHub Pages base remains /Project-HELEN/.
 *   - Migration filenames use real UTC YYYYMMDDHHmmss prefixes and immutable
 *     ordering rules relative to branch history.
 *   - Legacy prefixed ID construction is not reintroduced in frontend code.
 *   - Provider API key variable names are not present in frontend source.
 *
 * Exits non-zero and prints a message on the first failure category.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_DIR_REL = 'supabase/migrations'
const LEGACY_PREFIXED_ID_RULE_EXCLUSIONS = new Set(['src/services/daemonStorageMigration.ts'])
const LEGACY_ID_SOURCE_EXTENSIONS = ['.ts', '.tsx']
const PROVIDER_KEY_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']

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

function readDirRecursive(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...readDirRecursive(full))
    } else {
      out.push(full)
    }
  }
  return out
}

function toRel(fullPath) {
  return path.relative(root, fullPath).replace(/\\/g, '/')
}

function listSourceFiles(extensions) {
  const srcRoot = path.join(root, 'src')
  return readDirRecursive(srcRoot)
    .filter(file => extensions.some(ext => file.endsWith(ext)))
    .map(file => ({ rel: toRel(file), content: fs.readFileSync(file, 'utf8') }))
}

function scriptKindFromRelPath(relPath) {
  if (relPath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (relPath.endsWith('.ts') || relPath.endsWith('.mts')) return ts.ScriptKind.TS
  if (relPath.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

function parseSourceFile(relPath, content) {
  return ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, scriptKindFromRelPath(relPath))
}

function collectStringFragments(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text]
  }
  if (ts.isRegularExpressionLiteral(node)) {
    return [node.getText(sourceFile)]
  }
  if (!ts.isTemplateExpression(node)) return []
  return [node.head.text, ...node.templateSpans.map(span => span.literal.text)]
}

function toMigrationRelPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/')
  const prefix = `${MIGRATION_DIR_REL}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

function isRealUtcTimestamp(version) {
  if (!/^\d{14}$/.test(version)) return false
  const year = Number(version.slice(0, 4))
  const month = Number(version.slice(4, 6))
  const day = Number(version.slice(6, 8))
  const hour = Number(version.slice(8, 10))
  const minute = Number(version.slice(10, 12))
  const second = Number(version.slice(12, 14))
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return false
  }
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
    && candidate.getUTCHours() === hour
    && candidate.getUTCMinutes() === minute
    && candidate.getUTCSeconds() === second
}

function parseMigrationFilename(filename) {
  const match = /^(\d{14})_[^/]+\.sql$/.exec(filename)
  if (!match) return { filename, error: 'must match YYYYMMDDHHmmss_description.sql' }
  const version = match[1]
  if (!isRealUtcTimestamp(version)) {
    return { filename, version, error: `contains invalid UTC timestamp prefix "${version}"` }
  }
  return { filename, version, error: null }
}

function evaluateMigrationCatalog(filenames) {
  const errors = []
  const versions = new Map()
  let maxVersion = null

  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename)
    if (parsed.error) {
      errors.push(`${filename}: ${parsed.error}`)
      continue
    }

    const prior = versions.get(parsed.version)
    if (prior) {
      errors.push(`duplicate migration version ${parsed.version}: ${prior} and ${filename}`)
      continue
    }

    versions.set(parsed.version, filename)
    if (!maxVersion || parsed.version > maxVersion) maxVersion = parsed.version
  }

  return { errors, versions, maxVersion }
}

function evaluateMigrationHistoryChanges({ baseVersions, baseMaxVersion, addedFiles, renamedFiles, deletedFiles, modifiedFiles = [] }) {
  const errors = []

  for (const file of modifiedFiles) {
    errors.push(`modifying an existing migration is not allowed: ${file}`)
  }

  for (const rename of renamedFiles) {
    errors.push(`renaming existing migration is not allowed: ${rename.from} -> ${rename.to}`)
  }

  for (const deleted of deletedFiles) {
    errors.push(`deleting existing migration is not allowed: ${deleted}`)
  }

  for (const file of addedFiles) {
    const parsed = parseMigrationFilename(file)
    if (parsed.error) {
      errors.push(`${file}: ${parsed.error}`)
      continue
    }

    if (baseVersions.has(parsed.version)) {
      errors.push(`migration ${file} reuses existing version ${parsed.version}`)
      continue
    }

    if (baseMaxVersion && parsed.version <= baseMaxVersion) {
      errors.push(`migration ${file} must be newer than current max ${baseMaxVersion}`)
    }
  }

  return errors
}

function findLegacyPrefixedIdViolations(relPath, content) {
  if (LEGACY_PREFIXED_ID_RULE_EXCLUSIONS.has(relPath)) return []
  const sourceFile = parseSourceFile(relPath, content)
  const violations = []
  const prefixedTemplatePattern = /^`(?:daemon|mem|interaction)-/i
  const prefixedValuePattern = /^(?:daemon|mem|interaction)-/i

  function visit(node) {
    const decodedTemplateHead = ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? node.head.text
        : null
    if (decodedTemplateHead && prefixedTemplatePattern.test(`\`${decodedTemplateHead}`)) {
      violations.push(`${relPath}: ${node.getText(sourceFile)}`)
    }

    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      let left = node.left
      while (
        ts.isParenthesizedExpression(left)
        || ts.isAsExpression(left)
        || ts.isTypeAssertionExpression(left)
        || ts.isSatisfiesExpression(left)
        || ts.isNonNullExpression(left)
      ) {
        left = left.expression
      }
      if ((ts.isStringLiteral(left) || ts.isNoSubstitutionTemplateLiteral(left))
        && prefixedValuePattern.test(left.text)) {
        const snippet = sourceFile.text.slice(node.left.getStart(sourceFile), node.operatorToken.end)
        violations.push(`${relPath}: ${snippet}`)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

function findProviderKeyViolations(relPath, content) {
  const sourceFile = parseSourceFile(relPath, content)
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
  const found = new Set()

  function visit(node) {
    if (ts.isIdentifier(node) && keys.includes(node.text)) {
      found.add(node.text)
    }

    for (const fragment of collectStringFragments(node, sourceFile)) {
      for (const key of keys) {
        if (fragment.includes(key)) found.add(key)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  const violations = []
  for (const key of keys) if (found.has(key)) violations.push(`${relPath}: ${key}`)
  return violations
}

function runGit(args, allowFailure = false) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim()
  } catch (error) {
    if (allowFailure) return null
    const stderr = error?.stderr?.toString?.().trim?.() || error.message
    throw new Error(stderr)
  }
}

function ensureBaseRefExists(baseRef) {
  const hasRef = runGit(['rev-parse', '--verify', baseRef], true)
  if (hasRef) return
  const branch = baseRef.replace(/^origin\//, '')
  runGit(['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`])
}

function getMergeBaseRef() {
  const baseBranch = process.env.GITHUB_BASE_REF
  if (!baseBranch) return null

  const baseRef = `origin/${baseBranch}`
  ensureBaseRefExists(baseRef)

  const mergeBase = runGit(['merge-base', 'HEAD', baseRef], true)
  if (mergeBase) return mergeBase

  const isShallow = runGit(['rev-parse', '--is-shallow-repository'], true) === 'true'
  const shallowHint = isShallow ? ' Repository is shallow; set actions/checkout fetch-depth: 0.' : ''
  throw new Error(`Unable to determine merge-base with ${baseRef}.${shallowHint}`)
}

function listMigrationsAtRef(ref) {
  const output = runGit(['ls-tree', '-r', '--name-only', ref, MIGRATION_DIR_REL])
  if (!output) return []
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.endsWith('.sql'))
    .map(toMigrationRelPath)
}

function classifyMigrationDiff(output) {
  if (!output) return { addedFiles: [], renamedFiles: [], deletedFiles: [], modifiedFiles: [] }

  const addedFiles = []
  const renamedFiles = []
  const deletedFiles = []
  const modifiedFiles = []

  for (const line of output.split('\n')) {
    const parts = line.trim().split('\t')
    const status = parts[0]
    if (!status) continue

    if (status.startsWith('R')) {
      const from = parts[1] ? toMigrationRelPath(parts[1]) : null
      const to = parts[2] ? toMigrationRelPath(parts[2]) : null
      const fromIsSql = from?.endsWith('.sql') ?? false
      const toIsSql = to?.endsWith('.sql') ?? false

      if (from && to && fromIsSql && from !== to) {
        renamedFiles.push({ from, to })
      }
      if (to && toIsSql && !fromIsSql) addedFiles.push(to)
      continue
    }

    const file = parts[1] ? toMigrationRelPath(parts[1]) : null
    if (!file || !file.endsWith('.sql')) continue

    if (status === 'A') addedFiles.push(file)
    else if (status === 'D') deletedFiles.push(file)
    else if (status === 'M' || status === 'T') modifiedFiles.push(file)
  }

  return { addedFiles, renamedFiles, deletedFiles, modifiedFiles }
}

function parseMigrationDiff(mergeBase) {
  const output = runGit([
    'diff',
    '--name-status',
    '--find-renames',
    `${mergeBase}..HEAD`,
    '--',
    MIGRATION_DIR_REL,
  ])
  return classifyMigrationDiff(output)
}

function runMigrationChecks() {
  const migrationDir = path.join(root, MIGRATION_DIR_REL)
  if (!fs.existsSync(migrationDir)) {
    throw new Error(`Missing required migration directory: ${MIGRATION_DIR_REL}`)
  }
  const filenames = readDirRecursive(migrationDir)
    .filter(file => file.endsWith('.sql'))
    .map(file => path.relative(migrationDir, file).replace(/\\/g, '/'))
    .sort()

  const current = evaluateMigrationCatalog(filenames)
  if (current.errors.length) {
    throw new Error(`Migration filename validation failed:\n- ${current.errors.join('\n- ')}`)
  }

  const mergeBase = getMergeBaseRef()
  if (!mergeBase) return

  const baseFilenames = listMigrationsAtRef(mergeBase)
  const baseCatalog = evaluateMigrationCatalog(baseFilenames)
  if (baseCatalog.errors.length) {
    throw new Error(`Cannot evaluate migration history at merge-base ${mergeBase.slice(0, 12)}:\n- ${baseCatalog.errors.join('\n- ')}`)
  }

  const diff = parseMigrationDiff(mergeBase)
  const historyErrors = evaluateMigrationHistoryChanges({
    baseVersions: baseCatalog.versions,
    baseMaxVersion: baseCatalog.maxVersion,
    addedFiles: diff.addedFiles,
    renamedFiles: diff.renamedFiles,
    deletedFiles: diff.deletedFiles,
    modifiedFiles: diff.modifiedFiles,
  })

  if (historyErrors.length) {
    throw new Error(
      `Migration ordering/history validation failed (merge-base ${mergeBase.slice(0, 12)}, current max ${baseCatalog.maxVersion ?? 'none'}):\n- ${historyErrors.join('\n- ')}`,
    )
  }
}

function runLegacyPrefixedIdChecks() {
  const violations = []
  for (const file of listSourceFiles(LEGACY_ID_SOURCE_EXTENSIONS)) {
    violations.push(...findLegacyPrefixedIdViolations(file.rel, file.content))
  }
  if (violations.length) {
    throw new Error(`Legacy prefixed IDs are disallowed in frontend source:\n- ${violations.join('\n- ')}`)
  }
}

function runFrontendProviderKeyChecks() {
  const violations = []
  for (const file of listSourceFiles(PROVIDER_KEY_SOURCE_EXTENSIONS)) {
    violations.push(...findProviderKeyViolations(file.rel, file.content))
  }
  if (violations.length) {
    throw new Error(`Frontend source must not contain provider API key names:\n- ${violations.join('\n- ')}`)
  }
}

function runChecks() {
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
  requireContains(app, `from './services/daemonAuthAPI'`, 'App.tsx imports daemonAuthAPI')
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

  runMigrationChecks()
  runLegacyPrefixedIdChecks()
  runFrontendProviderKeyChecks()

  console.log('Import chain checks passed.')
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isMainModule()) {
  try {
    runChecks()
  } catch (error) {
    console.error(`Import check failed: ${error.message}`)
    process.exit(1)
  }
}

export {
  classifyMigrationDiff,
  evaluateMigrationCatalog,
  evaluateMigrationHistoryChanges,
  findLegacyPrefixedIdViolations,
  findProviderKeyViolations,
  parseMigrationFilename,
  runChecks,
}
