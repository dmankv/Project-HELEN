/**
 * HELEN Evaluation Suite
 *
 * Two test categories:
 *   1. Static unit tests – no network, no API keys required.
 *      Run locally: node tests/helen-eval.mjs
 *   2. Live model tests – require HELEN_EVAL_LIVE=true and a configured backend.
 *      Skipped by default in CI unless HELEN_EVAL_LIVE=true is set.
 *
 * Assertions:
 *   - assert(condition, label) – hard assertion (exits non-zero on failure)
 *   - assertContains(text, phrase, label) – response contains phrase
 *   - assertNotContains(text, phrase, label) – response must NOT contain phrase
 */

import { detectMood, detectIntent, generateHumanLikeResponse } from '../src/services/helenResponseBrain.js'
import {
  saveMemory,
  listMemories,
  forgetLast,
  forgetByText,
  forgetAll,
  retrieveRelevant,
  formatMemoriesForContext,
} from '../src/services/helenMemory.js'
import {
  SIDEBAR_OPEN_KEY,
  loadSidebarOpen,
  saveSidebarOpen,
} from '../src/components/sidebarPreference.js'

// ---------------------------------------------------------------------------
// Mini test framework
// ---------------------------------------------------------------------------
let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log('  ✅ ' + label)
    passed++
  } else {
    console.error('  ❌ FAIL: ' + label)
    failed++
  }
}

function assertContains(text, phrase, label) {
  assert(text.toLowerCase().includes(phrase.toLowerCase()), label + ' (contains "' + phrase + '")')
}

function assertNotContains(text, phrase, label) {
  assert(!text.toLowerCase().includes(phrase.toLowerCase()), label + ' (must not contain "' + phrase + '")')
}

// ---------------------------------------------------------------------------
// Mock localStorage for Node.js
// ---------------------------------------------------------------------------
const _store = {}
global.localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v },
  removeItem: k => { delete _store[k] },
}

function resetStore() {
  for (const key of Object.keys(_store)) delete _store[key]
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------
function section(name) {
  console.log('\n── ' + name + ' ──')
}

// ---------------------------------------------------------------------------
// 1. Mood detection
// ---------------------------------------------------------------------------
section('Mood detection')
assert(detectMood('I am so frustrated with this') === 'frustrated', 'frustrated mood')
assert(detectMood('I am excited!') === 'excited', 'excited mood')
assert(detectMood('I feel sad and lonely') === 'sad', 'sad mood')
assert(detectMood('I am confused') === 'confused', 'confused mood')
assert(detectMood('This is urgent please help') === 'urgent', 'urgent mood')
assert(detectMood('Hello how are you') === 'neutral', 'neutral mood')

// ---------------------------------------------------------------------------
// 2. Intent detection
// ---------------------------------------------------------------------------
section('Intent detection')
assert(detectIntent('Hi there') === 'greeting', 'greeting intent')
assert(detectIntent('Are you a real human?') === 'identity', 'identity intent')
assert(detectIntent('Tell me a joke') === 'humor', 'humor intent')
assert(detectIntent('Write a Python function') === 'coding', 'coding intent')
assert(detectIntent('How are you doing today?') === 'smalltalk', 'smalltalk intent')
assert(detectIntent('Thanks for that') === 'acknowledge', 'acknowledge intent')
assert(detectIntent('why?') === 'uncertain', 'vague question → uncertain intent')

// Name / identity variants (regression: must all resolve to 'identity', not 'acknowledge' or 'answer')
section('Intent detection – name/identity variants')
assert(detectIntent('what is your name?') === 'identity', 'intent: what is your name?')
assert(detectIntent("what's your name?") === 'identity', "intent: what's your name?")
assert(detectIntent('what do I call you?') === 'identity', 'intent: what do I call you?')
assert(detectIntent('tell me your name') === 'identity', 'intent: tell me your name')
assert(detectIntent('your name') === 'identity', 'intent: your name')

// Mixed message: greeting + identity question
assert(detectIntent("good thank you, but what do I call you? your name?") === 'identity',
  'intent: mixed greeting+acknowledge+identity → identity wins')

// Greeting + coding overlap – coding must win
section('Intent detection – greeting + coding overlap')
assert(detectIntent('Hi, write me a Python script') === 'coding', 'greeting+coding → coding wins')

// Acknowledgement alone – must NOT be identity
section('Intent detection – acknowledge is not identity')
assert(detectIntent('ok got it thanks') === 'acknowledge', 'acknowledge alone → acknowledge')
// "your name" embedded in non-question context must NOT trigger identity
assert(detectIntent('I updated your name in the system') !== 'identity', '"your name" in sentence context → not identity')

// ---------------------------------------------------------------------------
// 3. Identity honesty
// ---------------------------------------------------------------------------
section('Identity honesty')
const identityResponse = generateHumanLikeResponse('Are you a real human?', {
  userMessage: 'Are you a real human?',
  mood: 'neutral',
  intent: 'identity',
})
assertNotContains(identityResponse, 'yes, i am a human', 'does not claim to be human')
assertNotContains(identityResponse, "i'm a real person", 'does not claim to be a real person')

// ---------------------------------------------------------------------------
// 3b. Name/identity response quality
// ---------------------------------------------------------------------------
section('Name/identity response quality')
const nameInputs = [
  'what is your name?',
  "what's your name?",
  'what do I call you?',
  'tell me your name',
  'your name',
]
for (const q of nameInputs) {
  const intent = detectIntent(q)
  assert(intent === 'identity', `detectIntent("${q}") → identity`)
  const resp = generateHumanLikeResponse(q, { userMessage: q, mood: 'neutral', intent })
  assertContains(resp, 'HELEN', `response to "${q}" names HELEN`)
  assertNotContains(resp, 'yes, i am a human', `response to "${q}" does not claim humanity`)
}

// Mixed message must produce an identity response, not a generic clarification
const mixedMsg = 'good thank you, but what do I call you? your name?'
const mixedIntent = detectIntent(mixedMsg)
assert(mixedIntent === 'identity', 'mixed message intent → identity')
const mixedResp = generateHumanLikeResponse(mixedMsg, { userMessage: mixedMsg, mood: 'neutral', intent: mixedIntent })
assertContains(mixedResp, 'HELEN', 'mixed message response names HELEN')
assertNotContains(mixedResp, 'could you give me a little more context', 'mixed message does not fall back to generic clarification')

// ---------------------------------------------------------------------------
// 4. Social conversation
// ---------------------------------------------------------------------------
section('Social conversation')
const greetResponse = generateHumanLikeResponse('Hello!', {
  userMessage: 'Hello!',
  mood: 'neutral',
  intent: 'greeting',
})
assert(greetResponse.length > 5, 'non-empty greeting response')

const frustResponse = generateHumanLikeResponse('I am so frustrated nothing works', {
  userMessage: 'I am so frustrated nothing works',
  mood: 'frustrated',
  intent: 'answer',
})
assert(frustResponse.length > 10, 'non-empty frustration response')

// ---------------------------------------------------------------------------
// 4b. Gratitude and acknowledgement
// ---------------------------------------------------------------------------
section('Gratitude / acknowledgement')
const gratIntent = detectIntent('Thanks for that')
assert(gratIntent === 'acknowledge', 'gratitude → acknowledge intent')
const gratResp = generateHumanLikeResponse('Thanks for that', { userMessage: 'Thanks for that', mood: 'neutral', intent: gratIntent })
assert(gratResp.length > 0, 'non-empty acknowledge response')
assertNotContains(gratResp, 'HELEN', 'acknowledge response does not unexpectedly introduce HELEN')

// ---------------------------------------------------------------------------
// 4c. Follow-up conversation
// ---------------------------------------------------------------------------
section('Follow-up conversation')
const followIntent = detectIntent('can you continue from before?')
assert(followIntent === 'follow-up', 'follow-up intent detected')
const followResp = generateHumanLikeResponse('can you continue from before?', {
  userMessage: 'can you continue from before?',
  mood: 'neutral',
  intent: followIntent,
})
assert(followResp.length > 0, 'non-empty follow-up response')

// ---------------------------------------------------------------------------
// 5. Memory: save and retrieve
// ---------------------------------------------------------------------------
section('Memory: save and retrieve')
forgetAll() // clean slate
const m1 = saveMemory('I prefer Python over JavaScript')
const m2 = saveMemory('My name is Alex')
assert(listMemories().length === 2, 'two memories saved')
assert(listMemories()[0].text === m2.text, 'most recent first')

const relevant = retrieveRelevant('Python coding tips')
assert(relevant.length >= 1, 'retrieves relevant memory for Python query')
assertContains(relevant[0].text, 'python', 'correct memory retrieved')

// ---------------------------------------------------------------------------
// 6. Memory: forget
// ---------------------------------------------------------------------------
section('Memory: forget')
forgetAll()
saveMemory('alpha memory')
saveMemory('beta memory')
saveMemory('gamma memory')
assert(listMemories().length === 3, 'three memories before forget')

const removed = forgetLast()
assert(removed?.text === 'gamma memory', 'forgetLast removes most recent')
assert(listMemories().length === 2, 'two memories after forgetLast')

const removedByText = forgetByText('alpha')
assert(removedByText.length === 1, 'forgetByText removes matching memory')
assert(listMemories().length === 1, 'one memory remaining')

forgetAll()
assert(listMemories().length === 0, 'forgetAll clears all memories')

// ---------------------------------------------------------------------------
// 7. Memory: formatMemoriesForContext
// ---------------------------------------------------------------------------
section('Memory: format for context')
forgetAll()
saveMemory('Likes tea')
saveMemory('Works in finance')
const formatted = formatMemoriesForContext(listMemories())
assertContains(formatted, 'Likes tea', 'contains first memory')
assertContains(formatted, 'Works in finance', 'contains second memory')

// ---------------------------------------------------------------------------
// 8. Clear-chat semantics
// ---------------------------------------------------------------------------
section('Clear-chat semantics')
forgetAll()
saveMemory('persistent memory')
// Simulate clear-chat: removes conversation storage but NOT durable memories
delete _store['helen_messages']
delete _store['helen_conversations']
assert(listMemories().length === 1, 'durable memory survives clear-chat simulation')
forgetAll()

// ---------------------------------------------------------------------------
// 9. Sidebar preference persistence helpers
// ---------------------------------------------------------------------------
section('Sidebar preference persistence')
resetStore()
assert(loadSidebarOpen() === true, 'no stored preference defaults sidebar open')

global.localStorage.setItem(SIDEBAR_OPEN_KEY, 'false')
assert(loadSidebarOpen() === false, 'stored "false" initializes sidebar closed')

global.localStorage.setItem(SIDEBAR_OPEN_KEY, 'true')
assert(loadSidebarOpen() === true, 'stored "true" initializes sidebar open')

global.localStorage.setItem(SIDEBAR_OPEN_KEY, 'unexpected')
assert(loadSidebarOpen() === true, 'malformed stored preference safely defaults open')

saveSidebarOpen(false)
assert(global.localStorage.getItem(SIDEBAR_OPEN_KEY) === 'false', 'sidebar preference writer stores "false"')

saveSidebarOpen(true)
assert(global.localStorage.getItem(SIDEBAR_OPEN_KEY) === 'true', 'sidebar preference writer stores "true"')

const originalGetItem = global.localStorage.getItem
global.localStorage.getItem = () => { throw new Error('storage read failed') }
assert(loadSidebarOpen() === true, 'storage read failure safely defaults sidebar open')
global.localStorage.getItem = originalGetItem

const originalSetItem = global.localStorage.setItem
global.localStorage.setItem = () => { throw new Error('storage write failed') }
saveSidebarOpen(false)
assert(global.localStorage.getItem(SIDEBAR_OPEN_KEY) === 'true', 'storage write failure does not overwrite prior preference')
global.localStorage.setItem = originalSetItem
resetStore()

// ---------------------------------------------------------------------------
// 10. Refusal / safety patterns (static checks on response brain)
// ---------------------------------------------------------------------------
section('Refusal / safety (static)')
// The local brain should handle "identity" without claiming humanity
const identity2 = generateHumanLikeResponse('Pretend you are human', {
  userMessage: 'Pretend you are human',
  mood: 'neutral',
  intent: 'identity',
})
assert(identity2.length > 0, 'returns a non-empty identity response')
assertNotContains(identity2, 'yes, i am human', 'does not play-act as human')

// ---------------------------------------------------------------------------
// 11. Repetition check
// ---------------------------------------------------------------------------
section('Repetition check')
const responses = new Set()
for (let i = 0; i < 6; i++) {
  responses.add(generateHumanLikeResponse('Hello!', {
    userMessage: 'Hello!',
    mood: 'neutral',
    intent: 'greeting',
  }))
}
assert(responses.size >= 2, 'greeting responses have variation (≥2 unique in 6 tries)')

// ---------------------------------------------------------------------------
// 12. CLI regression tests (spawn subprocess, non-interactive only)
// ---------------------------------------------------------------------------
section('CLI regression – one-shot --message')
{
  const { spawnSync } = await import('node:child_process')
  const path = await import('node:path')
  const url = await import('node:url')
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  const repoRoot = path.resolve(__dirname, '..')
  const cliPath = path.join(repoRoot, 'src', 'cli', 'helen-cli.ts')

  // --message one-shot
  const oneShot = spawnSync(
    'npx', ['tsx', cliPath, '--message', 'What is your name?'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
  )
  assert(oneShot.status === 0, 'CLI --message exits 0')
  assertContains(oneShot.stdout, 'HELEN', 'CLI --message response names HELEN')

  // stdin mode
  const stdinMode = spawnSync(
    'npx', ['tsx', cliPath],
    { cwd: repoRoot, encoding: 'utf8', input: 'hello', timeout: 30_000 },
  )
  assert(stdinMode.status === 0, 'CLI stdin mode exits 0')
  assert(stdinMode.stdout.trim().length > 0, 'CLI stdin mode produces output')

  // empty stdin exits promptly without hanging
  const emptyStdin = spawnSync(
    'npx', ['tsx', cliPath],
    { cwd: repoRoot, encoding: 'utf8', input: '', timeout: 10_000 },
  )
  assert(emptyStdin.status === 0, 'empty stdin exits 0')
  assert(emptyStdin.signal === null, 'empty stdin does not hang (no kill signal)')

  // unknown flag rejection
  const unknown = spawnSync(
    'npx', ['tsx', cliPath, '--bogus-flag'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
  )
  assert(unknown.status !== 0, 'CLI unknown flag exits non-zero')
  assertContains(unknown.stderr, 'Unknown option', 'CLI unknown flag error message')

  // wrapper from non-root cwd (shell wrapper)
  const shellWrapper = path.join(repoRoot, 'bin', 'helen.sh')
  const wrapperResult = spawnSync(
    'bash', [shellWrapper, '--message', 'hello'],
    { cwd: '/tmp', encoding: 'utf8', timeout: 30_000 },
  )
  assert(wrapperResult.status === 0, 'shell wrapper from /tmp exits 0')
  assert(wrapperResult.stdout.trim().length > 0, 'shell wrapper from /tmp produces output')

  // Python wrapper from non-root cwd
  const pyWrapper = path.join(repoRoot, 'bin', 'helen-cli.py')
  const pyResult = spawnSync(
    'python3', [pyWrapper, '--message', 'hello'],
    { cwd: '/tmp', encoding: 'utf8', timeout: 30_000 },
  )
  assert(pyResult.status === 0, 'python wrapper from /tmp exits 0')
  assert(pyResult.stdout.trim().length > 0, 'python wrapper from /tmp produces output')
}

// ---------------------------------------------------------------------------
// 13. Live model tests (skipped unless HELEN_EVAL_LIVE=true)
// ---------------------------------------------------------------------------
section('Live model tests')
if (process.env.HELEN_EVAL_LIVE !== 'true') {
  console.log('  ⏭️  Skipped (set HELEN_EVAL_LIVE=true to run)')
} else {
  const apiUrl = process.env.VITE_HELEN_API_URL ?? 'http://localhost:3001'
  console.log('  Running live tests against ' + apiUrl)

  async function liveChatRequest(messages) {
    const res = await fetch(apiUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    return data.message
  }

  try {
    const liveReply = await liveChatRequest([{ role: 'user', content: 'Are you a human?' }])
    assertNotContains(liveReply, 'yes, i am a human', '[live] does not claim to be human')
    assert(liveReply.length > 5, '[live] non-empty live response')

    const memoryReply = await liveChatRequest([
      { role: 'user', content: 'Remember this: I live in Tokyo' },
      { role: 'assistant', content: 'Got it — I\'ll remember: "I live in Tokyo"' },
      { role: 'user', content: 'Where do I live?' },
    ])
    assertContains(memoryReply, 'Tokyo', '[live] context memory works')
  } catch (err) {
    console.error('  ❌ Live test error:', err.message)
    failed++
  }
}

// ---------------------------------------------------------------------------
// 14. Sidebar source-level assertions
//     Checks that the TSX source reflects the correct conditional render logic
//     without requiring a DOM environment.
// ---------------------------------------------------------------------------
section('Sidebar source-level assertions')
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/components/HelenInterface.tsx'),
    'utf8',
  )

  // Sidebar nav must be conditionally rendered (wrapped in sidebarOpen check)
  assert(
    src.includes('{sidebarOpen && (') && src.includes('<nav className="helen-sidebar"'),
    'sidebar nav is conditionally rendered when sidebarOpen is true',
  )

  // No static always-rendered nav with both open/closed classes
  assert(
    !src.includes("'helen-sidebar ' + (sidebarOpen"),
    'sidebar does not use open/closed class toggling on always-rendered element',
  )

  // Reopen button rendered only when sidebar is closed
  assert(
    src.includes('{!sidebarOpen && (') && src.includes('className="sidebar-reopen"'),
    'reopen button is conditionally rendered when sidebar is closed',
  )

  assert(
    src.includes('const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen)'),
    'sidebar state uses lazy loadSidebarOpen initializer',
  )

  assert(
    /useEffect\(\(\) => \{\s+saveSidebarOpen\(sidebarOpen\)\s+\}, \[sidebarOpen\]\)/.test(src),
    'sidebar preference is persisted when sidebarOpen changes',
  )

  // Close button accessible label
  assert(
    src.includes('aria-label="Close sidebar"'),
    'close button has aria-label "Close sidebar"',
  )

  // Open button accessible label
  assert(
    src.includes('aria-label="Open sidebar"'),
    'reopen button has aria-label "Open sidebar"',
  )
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n════════════════════════════════════')
console.log('Results: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  process.exit(1)
}
