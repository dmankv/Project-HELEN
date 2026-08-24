/**
 * CLI smoke tests – fast non-interactive subprocess checks.
 *
 * Run via: npm run cli:smoke
 *
 * Covers:
 *   - npm CLI  --message one-shot
 *   - one-line stdin mode
 *   - empty stdin exits promptly (no hang)
 *   - unknown flag rejection and nonzero exit
 *   - shell wrapper from a non-root cwd
 *   - Python wrapper from a non-root cwd
 *   - wrapper exit-code propagation
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import url from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const cliPath = path.join(repoRoot, 'src', 'cli', 'helen-cli.ts')
const tmpDir = os.tmpdir()

let passed = 0
let failed = 0

function check(label, condition) {
  if (condition) {
    console.log('  ✅ ' + label)
    passed++
  } else {
    console.error('  ❌ FAIL: ' + label)
    failed++
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000, ...opts })
}

console.log('\n── CLI smoke ──')

// --message one-shot
const msg = run('npx', ['tsx', cliPath, '--message', 'hello'], { cwd: repoRoot })
check('--message exits 0', msg.status === 0)
check('--message produces output', msg.stdout.trim().length > 0)

// --message for name question → names HELEN
const name = run('npx', ['tsx', cliPath, '--message', 'What is your name?'], { cwd: repoRoot })
check('--message "What is your name?" exits 0', name.status === 0)
check('--message "What is your name?" names HELEN', name.stdout.toLowerCase().includes('helen'))

// one-line stdin
const stdin = run('npx', ['tsx', cliPath], { cwd: repoRoot, input: 'hello' })
check('one-line stdin exits 0', stdin.status === 0)
check('one-line stdin produces output', stdin.stdout.trim().length > 0)

// empty stdin exits promptly (no hang)
const empty = run('npx', ['tsx', cliPath], { cwd: repoRoot, input: '' })
check('empty stdin exits 0', empty.status === 0)
check('empty stdin does not hang (completes within timeout)', empty.signal === null)

// unknown flag rejected with nonzero exit
const unknown = run('npx', ['tsx', cliPath, '--bogus-flag'], { cwd: repoRoot })
check('unknown flag exits non-zero', unknown.status !== 0)
check('unknown flag error mentions "Unknown option"', unknown.stderr.includes('Unknown option'))

// shell wrapper from non-root cwd
const shWrapper = path.join(repoRoot, 'bin', 'helen.sh')
const sh = run('bash', [shWrapper, '--message', 'hello'], { cwd: tmpDir })
check('shell wrapper from /tmp exits 0', sh.status === 0)
check('shell wrapper from /tmp produces output', sh.stdout.trim().length > 0)

// shell wrapper exit-code propagation (unknown flag)
const shErr = run('bash', [shWrapper, '--bogus-flag'], { cwd: tmpDir })
check('shell wrapper propagates nonzero exit for unknown flag', shErr.status !== 0)

// Python wrapper from non-root cwd
const pyWrapper = path.join(repoRoot, 'bin', 'helen-cli.py')
const py = run('python3', [pyWrapper, '--message', 'hello'], { cwd: tmpDir })
check('python wrapper from /tmp exits 0', py.status === 0)
check('python wrapper from /tmp produces output', py.stdout.trim().length > 0)

// Python wrapper exit-code propagation (unknown flag)
const pyErr = run('python3', [pyWrapper, '--bogus-flag'], { cwd: tmpDir })
check('python wrapper propagates nonzero exit for unknown flag', pyErr.status !== 0)

console.log(`\n${'═'.repeat(40)}`)
console.log(`CLI smoke: ${passed} passed, ${failed} failed`)

if (failed > 0) process.exit(1)
