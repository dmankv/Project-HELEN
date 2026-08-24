import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

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

function section(name) {
  console.log('\n── ' + name + ' ──')
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-auth-'))
const authFile = path.join(tempRoot, 'auth-store.json')
const outboxFile = path.join(tempRoot, 'email-outbox.jsonl')

process.env.PORT = '3111'
process.env.AUTH_DATA_FILE = authFile
process.env.AUTH_DEV_EMAIL_OUTBOX_FILE = outboxFile
process.env.AUTH_REQUIRE_HTTPS = 'false'
process.env.AUTH_SECURE_COOKIES = 'false'
process.env.DAEMON_ALLOWED_ORIGINS = 'http://localhost:3000'
process.env.AUTH_RATE_LIMIT_MAX = '5'
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000'
process.env.OPENAI_API_KEY = ''

const { default: server } = await import('../server/index.ts')
server.listen(Number(process.env.PORT))
await once(server, 'listening')

const base = `http://localhost:${process.env.PORT}`
const origin = 'http://localhost:3000'

const cookieJar = new Map()

function storeCookies(res) {
  const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  for (const cookie of cookies) {
    const [pair] = cookie.split(';')
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const name = pair.slice(0, idx)
    const value = pair.slice(idx + 1)
    cookieJar.set(name, value)
  }
}

function cookieHeader() {
  return Array.from(cookieJar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

async function request(pathname, options = {}) {
  const headers = {
    Origin: origin,
    ...(options.headers ?? {}),
  }
  const cookie = cookieHeader()
  if (cookie) headers.Cookie = cookie

  const res = await fetch(base + pathname, {
    method: options.method ?? 'GET',
    headers,
    body: options.body,
  })
  storeCookies(res)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { res, body }
}

async function csrfRequest(pathname, payload) {
  const csrf = cookieJar.get('daemon_csrf') ?? ''
  return request(pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify(payload),
  })
}

function latestToken(template) {
  if (!fs.existsSync(outboxFile)) return ''
  const lines = fs.readFileSync(outboxFile, 'utf8').trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const row = JSON.parse(lines[i])
    if (row.template === template) return row.token
  }
  return ''
}

section('CSRF + origin checks')
{
  const csrfRes = await request('/api/auth/csrf')
  assert(csrfRes.res.status === 200, 'GET /api/auth/csrf returns 200')
  assert(typeof csrfRes.body?.csrfToken === 'string', 'CSRF endpoint returns token')

  const noCsrf = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com', password: 'Password123!', passwordConfirm: 'Password123!' }),
  })
  assert(noCsrf.res.status === 403, 'state-changing endpoint rejects missing CSRF')

  const badOrigin = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: {
      Origin: 'http://evil.example.com',
      'Content-Type': 'application/json',
      'X-CSRF-Token': cookieJar.get('daemon_csrf') ?? '',
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({ email: 'a@example.com', password: 'Password123!', passwordConfirm: 'Password123!' }),
  })
  assert(badOrigin.status === 403, 'state-changing endpoint rejects disallowed origin')

  const unauthenticatedChat = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert(unauthenticatedChat.res.status === 401, 'chat rejects a request without a session or API token')
}

section('Registration + verification flow')
{
  const reg = await csrfRequest('/api/auth/register', {
    email: 'user@example.com',
    password: 'Password123!',
    passwordConfirm: 'Password123!',
  })
  assert(reg.res.status === 200, 'register returns generic success')

  const regDup = await csrfRequest('/api/auth/register', {
    email: 'user@example.com',
    password: 'Password123!',
    passwordConfirm: 'Password123!',
  })
  assert(regDup.res.status === 200, 'duplicate register still returns generic success')

  const verifyToken = latestToken('verify-email')
  assert(verifyToken.length > 20, 'verification token generated via email adapter')

  const verify1 = await csrfRequest('/api/auth/verify-email', { token: verifyToken })
  assert(verify1.res.status === 200, 'verify token accepted')

  const verify2 = await csrfRequest('/api/auth/verify-email', { token: verifyToken })
  assert(verify2.res.status === 200, 'verify endpoint remains enumeration-safe on reused token')
}

section('Login success/failure + session/logout')
{
  const badLogin = await csrfRequest('/api/auth/login', {
    email: 'user@example.com',
    password: 'WrongPass123!',
  })
  assert(badLogin.res.status === 401, 'bad login rejected with generic status')

  const goodLogin = await csrfRequest('/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
  })
  assert(goodLogin.res.status === 200, 'valid login succeeds')
  assert(goodLogin.body?.user?.email === 'user@example.com', 'safe user returned on login')

  const session = await request('/api/auth/session')
  assert(session.res.status === 200 && session.body?.authenticated === true, 'session endpoint validates active login')

  const savedSessionId = cookieJar.get('daemon_session') ?? ''
  const savedCsrfToken = cookieJar.get('daemon_csrf') ?? ''
  cookieJar.delete('daemon_session')
  cookieJar.delete('daemon_csrf')
  cookieJar.set('helen_session', savedSessionId)
  cookieJar.set('helen_csrf', savedCsrfToken)
  const migratedSession = await request('/api/auth/session')
  assert(migratedSession.body?.authenticated === true, 'legacy session cookie remains authenticated during migration')
  assert(cookieJar.get('daemon_session') === savedSessionId, 'legacy session is reissued under daemon cookie name')
  assert(cookieJar.get('daemon_csrf') === savedCsrfToken, 'legacy CSRF token is reissued under daemon cookie name')
  assert(cookieJar.get('helen_session') === '', 'legacy session cookie is expired after migration')
  assert(cookieJar.get('helen_csrf') === '', 'legacy CSRF cookie is expired after migration')

  const authenticatedChat = await request('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert(authenticatedChat.res.status === 502, 'chat accepts an authenticated session before provider handling')

  const logout = await csrfRequest('/api/auth/logout', {})
  assert(logout.res.status === 200, 'logout succeeds')

  const postLogoutSession = await request('/api/auth/session')
  assert(postLogoutSession.body?.authenticated === false, 'session endpoint reports logged out state')
}

section('Password reset token + single use + session invalidation')
{
  const loginAgain = await csrfRequest('/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
  })
  assert(loginAgain.res.status === 200, 'can log in before reset')

  const resetReq = await csrfRequest('/api/auth/password-reset/request', { email: 'user@example.com' })
  assert(resetReq.res.status === 200, 'password reset request returns generic success')

  const resetToken = latestToken('password-reset')
  assert(resetToken.length > 20, 'password reset token generated')

  const resetDone = await csrfRequest('/api/auth/password-reset/confirm', {
    token: resetToken,
    password: 'NewPassword123!',
    passwordConfirm: 'NewPassword123!',
  })
  assert(resetDone.res.status === 200, 'password reset completion succeeds')

  const staleSession = await request('/api/auth/session')
  assert(staleSession.body?.authenticated === false, 'password reset invalidates existing sessions')

  const resetReplay = await csrfRequest('/api/auth/password-reset/confirm', {
    token: resetToken,
    password: 'AnotherPassword123!',
    passwordConfirm: 'AnotherPassword123!',
  })
  assert(resetReplay.res.status === 400, 'password reset token cannot be reused')

  const oldPasswordLogin = await csrfRequest('/api/auth/login', {
    email: 'user@example.com',
    password: 'Password123!',
  })
  assert(oldPasswordLogin.res.status === 401, 'old password fails after reset')

  const newPasswordLogin = await csrfRequest('/api/auth/login', {
    email: 'user@example.com',
    password: 'NewPassword123!',
  })
  assert(newPasswordLogin.res.status === 200, 'new password works after reset')
}

section('Rate limit coverage')
{
  let lastStatus = 200
  for (let i = 0; i < 6; i++) {
    const attempt = await csrfRequest('/api/auth/verification/request', { email: 'nobody@example.com' })
    lastStatus = attempt.res.status
  }
  assert(lastStatus === 429, 'verification request endpoint is rate limited')
}

await new Promise(resolve => server.close(resolve))

console.log('\n════════════════════════════════════')
console.log(`Auth Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
