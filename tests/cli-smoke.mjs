/**
 * CLI smoke tests – fast non-interactive subprocess checks.
 *
 * Run via: npm run cli:smoke
 *
 * Covers:
 *   - npm entrypoint  --message one-shot (user-facing npm script)
 *   - npm entrypoint name question → Daemon
 *   - direct tsx  --message one-shot
 *   - one-line stdin mode
 *   - empty stdin exits promptly (no hang)
 *   - unknown flag rejection and nonzero exit
 *   - unknown short flag rejection (-x)
 *   - trailing flag after --message value
 *   - duplicate --message/-m rejection
 *   - positional argument rejection
 *   - missing value for --message
 *   - shell wrapper from a non-root cwd
 *   - shell wrapper exit-code propagation
 *   - Python wrapper from a non-root cwd (conditional on python3 availability)
 *   - Python wrapper exit-code propagation
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import url from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'src', 'cli', 'daemon-cli.ts')
const tmpDir = os.tmpdir()

let passed = 0
let failed = 0

function check(label, condition, result) {
  if (result && result.signal === 'SIGTERM') {
    console.error(`  ❌ FAIL (TIMEOUT): ${label}`)
    failed++
    return
  }
  if (result && result.error) {
    console.error(`  ❌ FAIL (SPAWN ERROR: ${result.error.message}): ${label}`)
    failed++
    return
  }
  if (condition) {
    console.log('  ✅ ' + label)
    passed++
  } else {
    console.error('  ❌ FAIL: ' + label)
    failed++
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...opts })
  if (result.signal === 'SIGTERM') {
    console.error(`  ⚠️  Process timed out: ${cmd} ${args.join(' ')}`)
  }
  return result
}

// Detect whether python3 is available.
const python3Available = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0

console.log('\n── CLI smoke ──')

// ── npm entrypoint (user-facing script) ──────────────────────────────────────
console.log('\n  [npm entrypoint]')

const npmMsg = run('npm', ['run', 'cli', '--', '--message', 'hello'], { cwd: repoRoot })
check('npm run cli -- --message "hello" exits 0', npmMsg.status === 0, npmMsg)
check('npm run cli -- --message "hello" produces output', npmMsg.stdout.trim().length > 0, npmMsg)

const npmName = run('npm', ['run', 'cli', '--', '--message', 'What is your name?'], { cwd: repoRoot })
check('npm run cli -- --message "What is your name?" exits 0', npmName.status === 0, npmName)
check('npm run cli -- --message "What is your name?" says "My name is Daemon"', npmName.stdout.toLowerCase().includes('my name is daemon'), npmName)

// ── Direct tsx invocations ───────────────────────────────────────────────────
console.log('\n  [direct tsx]')

const msg = run('npx', ['tsx', cliPath, '--message', 'hello'], { cwd: repoRoot })
check('--message exits 0', msg.status === 0, msg)
check('--message produces output', msg.stdout.trim().length > 0, msg)

const stdin = run('npx', ['tsx', cliPath], { cwd: repoRoot, input: 'hello' })
check('one-line stdin exits 0', stdin.status === 0, stdin)
check('one-line stdin produces output', stdin.stdout.trim().length > 0, stdin)

const empty = run('npx', ['tsx', cliPath], { cwd: repoRoot, input: '' })
check('empty stdin exits 0', empty.status === 0, empty)
check('empty stdin does not hang (completes within timeout)', empty.signal === null, empty)

// ── Argument validation ──────────────────────────────────────────────────────
console.log('\n  [argument validation]')

const unknown = run('npx', ['tsx', cliPath, '--bogus-flag'], { cwd: repoRoot })
check('unknown long flag exits non-zero', unknown.status !== 0, unknown)
check('unknown long flag error mentions "Unknown option"', unknown.stderr.includes('Unknown option'), unknown)

const shortFlag = run('npx', ['tsx', cliPath, '-x'], { cwd: repoRoot })
check('unknown short flag exits non-zero', shortFlag.status !== 0, shortFlag)
check('unknown short flag error mentions "Unknown option"', shortFlag.stderr.includes('Unknown option'), shortFlag)

const trailing = run('npx', ['tsx', cliPath, '--message', 'hello', '--bogus-flag'], { cwd: repoRoot })
check('trailing flag after --message exits non-zero', trailing.status !== 0, trailing)
check('trailing flag error mentions "Unknown option"', trailing.stderr.includes('Unknown option'), trailing)

const duplicate = run('npx', ['tsx', cliPath, '--message', 'hello', '--message', 'world'], { cwd: repoRoot })
check('duplicate --message exits non-zero', duplicate.status !== 0, duplicate)
check('duplicate --message error mentions "Duplicate option"', duplicate.stderr.includes('Duplicate option'), duplicate)

const positional = run('npx', ['tsx', cliPath, 'foo'], { cwd: repoRoot })
check('positional argument exits non-zero', positional.status !== 0, positional)
check('positional argument error mentions "Unexpected argument"', positional.stderr.includes('Unexpected argument'), positional)

const missingVal = run('npx', ['tsx', cliPath, '--message'], { cwd: repoRoot })
check('--message with no value exits non-zero', missingVal.status !== 0, missingVal)
check('--message with no value error mentions "Missing value"', missingVal.stderr.includes('Missing value'), missingVal)

// ── Shell wrapper ────────────────────────────────────────────────────────────
console.log('\n  [shell wrapper]')

const shWrapper = path.join(repoRoot, 'bin', 'daemon.sh')
const sh = run('bash', [shWrapper, '--message', 'hello'], { cwd: tmpDir })
check('shell wrapper from /tmp exits 0', sh.status === 0, sh)
check('shell wrapper from /tmp produces output', sh.stdout.trim().length > 0, sh)

const shErr = run('bash', [shWrapper, '--bogus-flag'], { cwd: tmpDir })
check('shell wrapper propagates nonzero exit for unknown flag', shErr.status !== 0, shErr)

// ── Python wrapper (conditional) ─────────────────────────────────────────────
console.log('\n  [python wrapper]')

if (!python3Available) {
  console.log('  ⚠️  python3 not found; skipping Python wrapper tests')
} else {
  const pyWrapper = path.join(repoRoot, 'bin', 'daemon-cli.py')

  const py = run('python3', [pyWrapper, '--message', 'hello'], { cwd: tmpDir })
  check('python wrapper from /tmp exits 0', py.status === 0, py)
  check('python wrapper from /tmp produces output', py.stdout.trim().length > 0, py)

  const pyErr = run('python3', [pyWrapper, '--bogus-flag'], { cwd: tmpDir })
  check('python wrapper propagates nonzero exit for unknown flag', pyErr.status !== 0, pyErr)
}

console.log(`\n${'═'.repeat(40)}`)
console.log(`CLI smoke: ${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)
