import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { URL, fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Shared configuration
// ---------------------------------------------------------------------------

/**
 * Prefer the Daemon configuration namespace while preserving existing HELEN_*
 * deployment settings during the identity migration.
 */
function daemonEnv(suffix: string): string | undefined {
  return process.env[`DAEMON_${suffix}`] ?? process.env[`HELEN_${suffix}`]
}

const PORT = Number(process.env.PORT ?? 3001)
const PROVIDER = (daemonEnv('PROVIDER') ?? 'openai').toLowerCase()
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const DAEMON_MODEL_DEFAULTS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
}
const MODEL = daemonEnv('MODEL') ?? DAEMON_MODEL_DEFAULTS[PROVIDER] ?? 'gpt-4o-mini'
const API_TOKEN = daemonEnv('API_TOKEN') ?? ''

const ALLOWED_ORIGINS = (
  daemonEnv('ALLOWED_ORIGINS') ??
  'http://localhost:3000,http://localhost:4173,https://dmankv.github.io'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const FRONTEND_BASE_URL = daemonEnv('FRONTEND_URL') ?? 'http://localhost:3000/Project-HELEN/'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024
const MAX_HISTORY_TURNS = 20

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'daemon_session'
const CSRF_COOKIE_NAME = process.env.AUTH_CSRF_COOKIE_NAME ?? 'daemon_csrf'
const LEGACY_AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME === undefined ? 'helen_session' : undefined
const LEGACY_CSRF_COOKIE_NAME = process.env.AUTH_CSRF_COOKIE_NAME === undefined ? 'helen_csrf' : undefined
const AUTH_SESSION_TTL_MS = Number(process.env.AUTH_SESSION_TTL_MS ?? 1000 * 60 * 60 * 12)
const AUTH_VERIFY_TTL_MS = Number(process.env.AUTH_VERIFY_TTL_MS ?? 1000 * 60 * 60 * 24)
const AUTH_RESET_TTL_MS = Number(process.env.AUTH_RESET_TTL_MS ?? 1000 * 60 * 30)
const AUTH_REQUIRE_HTTPS =
  (process.env.AUTH_REQUIRE_HTTPS ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) ===
  'true'
const AUTH_SECURE_COOKIES =
  (process.env.AUTH_SECURE_COOKIES ?? (process.env.NODE_ENV === 'production' ? 'true' : 'false')) ===
  'true'

const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20)
const AUTH_RATE_LIMIT_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000)

const CHAT_RATE_LIMIT_MAX = Number(daemonEnv('RATE_LIMIT') ?? 60)
const CHAT_RATE_LIMIT_WINDOW_MS = Number(daemonEnv('RATE_LIMIT_WINDOW_MS') ?? 60_000)

const AUTH_DATA_FILE = process.env.AUTH_DATA_FILE
  ? path.resolve(process.env.AUTH_DATA_FILE)
  : path.resolve(process.cwd(), '.data', 'auth-store.json')
const AUTH_OUTBOX_FILE = process.env.AUTH_DEV_EMAIL_OUTBOX_FILE
  ? path.resolve(process.env.AUTH_DEV_EMAIL_OUTBOX_FILE)
  : path.resolve(path.dirname(AUTH_DATA_FILE), 'auth-email-outbox.jsonl')

/**
 * When DAEMON_TRUST_PROXY=1 the server is assumed to sit behind a trusted
 * reverse proxy (nginx, Vercel, Fly.io, Render, etc.) that sets the
 * X-Forwarded-For header.  The rate limiter will use the first (left-most)
 * value from that header as the client IP instead of the socket address.
 *
 * Leave unset (the default) when the server is exposed directly to the
 * internet, to prevent IP-spoofing via a forged X-Forwarded-For header.
 */
const TRUST_PROXY = daemonEnv('TRUST_PROXY') === '1'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatRequest {
  messages: ChatMessage[]
}

interface UserRecord {
  id: string
  email: string
  passwordHash: string
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

interface SessionRecord {
  id: string
  userId: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

interface AuthTokenRecord {
  id: string
  userId: string
  purpose: 'verify-email' | 'password-reset'
  tokenHash: string
  createdAt: string
  expiresAt: string
  usedAt: string | null
}

interface AuthStoreFile {
  users: UserRecord[]
  sessions: SessionRecord[]
  tokens: AuthTokenRecord[]
}

interface SafeUser {
  id: string
  email: string
  emailVerified: boolean
}

interface EmailMessage {
  to: string
  subject: string
  template: 'verify-email' | 'password-reset'
  token: string
  link: string
  createdAt: string
}

interface ParsedCookies {
  [key: string]: string
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function nowIso(): string {
  return new Date().toISOString()
}

function randomId(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  const maxLen = Math.max(ab.length, bb.length, 1)
  const pa = Buffer.alloc(maxLen)
  const pb = Buffer.alloc(maxLen)
  ab.copy(pa)
  bb.copy(pb)
  return crypto.timingSafeEqual(pa, pb) && ab.length === bb.length
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function isValidEmail(value: string): boolean {
  if (value.length < 3 || value.length > 254) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function isValidPassword(value: string): boolean {
  return value.length >= 8 && value.length <= 128
}

function toSafeUser(user: UserRecord): SafeUser {
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.verifiedAt),
  }
}

function buildTokenLink(route: string, token: string): string {
  const base = FRONTEND_BASE_URL.endsWith('/') ? FRONTEND_BASE_URL : FRONTEND_BASE_URL + '/'
  return `${base}#/${route}?token=${encodeURIComponent(token)}`
}

function parseCookies(header: string | undefined): ParsedCookies {
  const out: ParsedCookies = {}
  if (!header) return out
  const pairs = header.split(';')
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    maxAgeSeconds?: number
    path?: string
  },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${opts.path ?? '/'}`)
  if (typeof opts.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`)
  }
  if (opts.httpOnly) parts.push('HttpOnly')
  if (opts.secure) parts.push('Secure')
  parts.push(`SameSite=${opts.sameSite ?? 'Lax'}`)
  return parts.join('; ')
}

function setCookies(res: http.ServerResponse, cookies: string[]): void {
  if (cookies.length === 0) return
  res.setHeader('Set-Cookie', cookies)
}

function currentOrLegacyCookie(
  cookies: ParsedCookies,
  currentName: string,
  legacyName: string | undefined,
): string | undefined {
  return cookies[currentName] ?? (legacyName ? cookies[legacyName] : undefined)
}

function usesLegacyCookie(
  cookies: ParsedCookies,
  currentName: string,
  legacyName: string | undefined,
): boolean {
  return Boolean(legacyName && !cookies[currentName] && cookies[legacyName])
}

function expireCookie(name: string | undefined, httpOnly: boolean): string[] {
  if (!name) return []
  return [
    serializeCookie(name, '', {
      httpOnly,
      secure: AUTH_SECURE_COOKIES,
      sameSite: 'Lax',
      maxAgeSeconds: 0,
    }),
  ]
}

function parseJson<T>(body: string): T {
  return JSON.parse(body) as T
}

function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-site',
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, X-DAEMON-API-TOKEN, X-HELEN-API-TOKEN',
      Vary: 'Origin',
    }
  }
  return {}
}

function isAllowedOrigin(origin: string | undefined): boolean {
  return Boolean(origin && ALLOWED_ORIGINS.includes(origin))
}

function hasValidApiToken(req: http.IncomingMessage): boolean {
  const token = normalizeHeader(req.headers['x-daemon-api-token'])
    || normalizeHeader(req.headers['x-helen-api-token'])
    || ''
  return API_TOKEN.length > 0 && token.length > 0 && timingSafeEqualString(token, API_TOKEN)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let finished = false

    const fail = (message: string) => {
      if (finished) return
      finished = true
      reject(new Error(message))
    }

    req.on('data', chunk => {
      if (finished) return
      const buf = chunk as Buffer
      totalBytes += buf.length
      if (totalBytes > MAX_BODY_BYTES) {
        fail('Request body too large')
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', err => {
      if (finished) return
      finished = true
      reject(err)
    })
  })
}

function isSecureRequest(req: http.IncomingMessage): boolean {
  if (TRUST_PROXY) {
    const proto = normalizeHeader(req.headers['x-forwarded-proto'])
    if (proto && proto.toLowerCase().split(',')[0].trim() === 'https') return true
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

function requestIp(req: http.IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown'
  if (!TRUST_PROXY) return socketIp
  const forwarded = normalizeHeader(req.headers['x-forwarded-for'])
  return forwarded?.split(',')[0]?.trim() || socketIp
}

// ---------------------------------------------------------------------------
// Persistent auth store
// ---------------------------------------------------------------------------

class AuthStore {
  private readonly filePath: string
  private state: AuthStoreFile

  constructor(filePath: string) {
    this.filePath = filePath
    this.state = this.load()
  }

  private load(): AuthStoreFile {
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        const initial: AuthStoreFile = { users: [], sessions: [], tokens: [] }
        fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), { mode: 0o600 })
        return initial
      }
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AuthStoreFile>
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [],
      }
    } catch {
      return { users: [], sessions: [], tokens: [] }
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.filePath)
  }

  private pruneExpired(): void {
    const now = Date.now()
    this.state.sessions = this.state.sessions.filter(s => !s.revokedAt && Date.parse(s.expiresAt) > now)
    this.state.tokens = this.state.tokens.filter(t => Date.parse(t.expiresAt) > now && !t.usedAt)
  }

  findUserByEmail(email: string): UserRecord | null {
    this.pruneExpired()
    return this.state.users.find(u => u.email === email) ?? null
  }

  findUserById(id: string): UserRecord | null {
    this.pruneExpired()
    return this.state.users.find(u => u.id === id) ?? null
  }

  createUser(email: string, passwordHash: string): UserRecord {
    const user: UserRecord = {
      id: randomId(16),
      email,
      passwordHash,
      verifiedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.state.users.push(user)
    this.persist()
    return user
  }

  updateUserPassword(userId: string, passwordHash: string): void {
    const user = this.state.users.find(u => u.id === userId)
    if (!user) return
    user.passwordHash = passwordHash
    user.updatedAt = nowIso()
    this.persist()
  }

  markUserVerified(userId: string): void {
    const user = this.state.users.find(u => u.id === userId)
    if (!user) return
    user.verifiedAt = nowIso()
    user.updatedAt = nowIso()
    this.persist()
  }

  createSession(userId: string, ttlMs: number): SessionRecord {
    const session: SessionRecord = {
      id: randomId(32),
      userId,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      revokedAt: null,
    }
    this.state.sessions.push(session)
    this.persist()
    return session
  }

  findActiveSession(sessionId: string): SessionRecord | null {
    this.pruneExpired()
    const session = this.state.sessions.find(s => s.id === sessionId && !s.revokedAt)
    if (!session) return null
    if (Date.parse(session.expiresAt) <= Date.now()) return null
    return session
  }

  revokeSession(sessionId: string): void {
    const session = this.state.sessions.find(s => s.id === sessionId)
    if (!session) return
    session.revokedAt = nowIso()
    this.persist()
  }

  revokeAllSessionsForUser(userId: string): void {
    let changed = false
    for (const session of this.state.sessions) {
      if (session.userId === userId && !session.revokedAt) {
        session.revokedAt = nowIso()
        changed = true
      }
    }
    if (changed) this.persist()
  }

  createToken(userId: string, purpose: AuthTokenRecord['purpose'], token: string, ttlMs: number): AuthTokenRecord {
    const rec: AuthTokenRecord = {
      id: randomId(16),
      userId,
      purpose,
      tokenHash: tokenHash(token),
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      usedAt: null,
    }
    this.state.tokens.push(rec)
    this.persist()
    return rec
  }

  consumeToken(purpose: AuthTokenRecord['purpose'], token: string): AuthTokenRecord | null {
    const hash = tokenHash(token)
    const now = Date.now()
    const rec = this.state.tokens.find(
      t => t.purpose === purpose && !t.usedAt && timingSafeEqualString(t.tokenHash, hash),
    )
    if (!rec) return null
    if (Date.parse(rec.expiresAt) <= now) return null
    rec.usedAt = nowIso()
    this.persist()
    return rec
  }
}

class DevEmailAdapter {
  send(message: EmailMessage): void {
    fs.mkdirSync(path.dirname(AUTH_OUTBOX_FILE), { recursive: true })
    fs.appendFileSync(AUTH_OUTBOX_FILE, JSON.stringify(message) + '\n', { mode: 0o600 })
  }
}

const authStore = new AuthStore(AUTH_DATA_FILE)
const emailAdapter = new DevEmailAdapter()

function hasActiveSession(cookies: ParsedCookies): boolean {
  const sid = currentOrLegacyCookie(cookies, AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME)
  if (!sid) return false
  const session = authStore.findActiveSession(sid)
  return Boolean(session && authStore.findUserById(session.userId))
}

// ---------------------------------------------------------------------------
// Rate limiting (chat + auth)
// ---------------------------------------------------------------------------

const chatRateCounts = new Map<string, { count: number; resetAt: number }>()
const authRateCounts = new Map<string, { count: number; resetAt: number }>()

function evictRateEntries(map: Map<string, { count: number; resetAt: number }>): void {
  const now = Date.now()
  for (const [k, v] of map) {
    if (now >= v.resetAt) map.delete(k)
  }
}

setInterval(() => {
  evictRateEntries(chatRateCounts)
  evictRateEntries(authRateCounts)
}, Math.min(AUTH_RATE_LIMIT_WINDOW_MS, 60_000)).unref()

function isRateLimited(
  map: Map<string, { count: number; resetAt: number }>,
  key: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now()
  const entry = map.get(key)
  if (!entry || now >= entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  if (entry.count >= max) return true
  entry.count += 1
  return false
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, server-side)
// ---------------------------------------------------------------------------

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 64

function scryptDerive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derived) => {
      if (err) {
        reject(err)
        return
      }
      resolve(derived as Buffer)
    })
  })
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const derived = await scryptDerive(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString(
    'base64',
  )}`
}

async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  const salt = Buffer.from(parts[4], 'base64')
  const hash = Buffer.from(parts[5], 'base64')
  const derived = await scryptDerive(password, salt, hash.length, { N: n, r, p })
  if (derived.length !== hash.length) return false
  return crypto.timingSafeEqual(derived, hash)
}

// ---------------------------------------------------------------------------
// Auth request guards
// ---------------------------------------------------------------------------

function requireAllowedOrigin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): boolean {
  const origin = normalizeHeader(req.headers.origin)
  if (!origin) return true
  if (ALLOWED_ORIGINS.includes(origin)) return true
  res.writeHead(403, { 'Content-Type': 'application/json', ...cors, ...securityHeaders() })
  res.end(JSON.stringify({ error: 'Origin not allowed.' }))
  return false
}

function requireHttpsForSensitive(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
): boolean {
  if (!AUTH_REQUIRE_HTTPS) return true
  if (isSecureRequest(req)) return true
  res.writeHead(400, { 'Content-Type': 'application/json', ...cors, ...securityHeaders() })
  res.end(JSON.stringify({ error: 'HTTPS is required.' }))
  return false
}

function ensureCsrfToken(cookies: ParsedCookies): string {
  const existing = currentOrLegacyCookie(cookies, CSRF_COOKIE_NAME, LEGACY_CSRF_COOKIE_NAME)
  if (existing && existing.length >= 32 && existing.length <= 256) return existing
  return randomId(24)
}

function requireCsrf(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cors: Record<string, string>,
  cookies: ParsedCookies,
): boolean {
  const sent = normalizeHeader(req.headers['x-csrf-token']) ?? ''
  const cookie = currentOrLegacyCookie(cookies, CSRF_COOKIE_NAME, LEGACY_CSRF_COOKIE_NAME) ?? ''
  if (!sent || !cookie || sent.length > 256 || cookie.length > 256 || !timingSafeEqualString(sent, cookie)) {
    res.writeHead(403, { 'Content-Type': 'application/json', ...cors, ...securityHeaders() })
    res.end(JSON.stringify({ error: 'CSRF validation failed.' }))
    return false
  }
  return true
}

function authRateKey(req: http.IncomingMessage, scope: string): string {
  return `${scope}:${requestIp(req)}`
}

// ---------------------------------------------------------------------------
// Chat provider adapter
// ---------------------------------------------------------------------------

const DAEMON_SYSTEM_PROMPT = `You are Daemon, a helpful, honest, and thoughtful AI assistant.
You are NOT a human. You are an AI. Never claim or imply otherwise.
You are warm, curious, and direct. You acknowledge uncertainty.
You refuse requests that are harmful, illegal, or unethical, and explain why briefly.`

function validateChatRequest(raw: unknown): ChatRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('Request body must be a JSON object')
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.messages)) throw new Error('messages must be an array')

  const messages: ChatMessage[] = obj.messages.slice(-MAX_HISTORY_TURNS * 2).map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`messages[${i}] must be an object`)
    const msg = m as Record<string, unknown>
    if (!['user', 'assistant'].includes(msg.role as string)) {
      throw new Error(`messages[${i}].role must be \"user\" or \"assistant\"`)
    }
    if (typeof msg.content !== 'string' || msg.content.length > 8192) {
      throw new Error(`messages[${i}].content must be a string ≤ 8192 chars`)
    }
    return { role: msg.role as 'user' | 'assistant', content: msg.content }
  })

  return { messages }
}

function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const options: https.RequestOptions = {
      hostname: u.hostname,
      ...(u.port ? { port: Number(u.port) } : {}),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }

    const req = https.request(options, res => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      res.on('data', chunk => {
        const buf = chunk as Buffer
        totalBytes += buf.length
        if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
          req.destroy(new Error('Provider response body too large'))
          return
        }
        chunks.push(buf)
      })
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }),
      )
    })

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('Provider request timed out')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function callOpenAI(messages: ChatMessage[]): Promise<string> {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set')
  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: DAEMON_SYSTEM_PROMPT }, ...messages],
    max_tokens: 1024,
  }
  const result = await httpsPost(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: 'Bearer ' + OPENAI_KEY },
    JSON.stringify(payload),
  )
  if (result.status !== 200) throw new Error(`OpenAI error ${result.status}`)
  const data = JSON.parse(result.body) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

async function callAnthropic(messages: ChatMessage[]): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const payload = {
    model: MODEL,
    system: DAEMON_SYSTEM_PROMPT,
    messages: messages.filter(m => m.role !== 'system'),
    max_tokens: 1024,
  }
  const result = await httpsPost(
    'https://api.anthropic.com/v1/messages',
    {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    JSON.stringify(payload),
  )
  if (result.status !== 200) throw new Error(`Anthropic error ${result.status}`)
  const data = JSON.parse(result.body) as { content?: Array<{ text?: string }> }
  return data.content?.[0]?.text ?? ''
}

async function callProvider(messages: ChatMessage[]): Promise<string> {
  return PROVIDER === 'anthropic' ? callAnthropic(messages) : callOpenAI(messages)
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const method = req.method ?? 'GET'
  const requestUrl = req.url ?? '/'
  const parsedUrl = new URL(requestUrl, `http://${req.headers.host ?? 'localhost'}`)
  const origin = normalizeHeader(req.headers.origin)
  const cors = corsHeaders(origin)
  const cookies = parseCookies(normalizeHeader(req.headers.cookie))

  const defaultHeaders = { ...securityHeaders(), ...cors }

  if (method === 'OPTIONS') {
    const requestedMethod = normalizeHeader(req.headers['access-control-request-method'])
    if (!requestedMethod) {
      res.writeHead(204, defaultHeaders)
      res.end()
      return
    }
    if (isAllowedOrigin(origin)) {
      res.writeHead(204, defaultHeaders)
      res.end()
      return
    }
    res.writeHead(403, { ...securityHeaders() })
    res.end()
    return
  }

  if (method !== 'OPTIONS') {
    const remoteIp = requestIp(req)
    if (requestUrl.startsWith('/api/chat')) {
      if (isRateLimited(chatRateCounts, remoteIp, CHAT_RATE_LIMIT_MAX, CHAT_RATE_LIMIT_WINDOW_MS)) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(CHAT_RATE_LIMIT_WINDOW_MS / 1000)),
          ...defaultHeaders,
        })
        res.end(JSON.stringify({ error: 'Too many requests. Please wait a moment.' }))
        return
      }
    }
  }

  if (parsedUrl.pathname === '/health' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
    res.end(JSON.stringify({ ok: true, provider: PROVIDER, model: MODEL }))
    return
  }

  if (parsedUrl.pathname === '/api/chat' && method === 'POST') {
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json', ...securityHeaders() })
      res.end(JSON.stringify({ error: 'Origin is not allowed.' }))
      return
    }
    if (!hasValidApiToken(req) && !hasActiveSession(cookies)) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ error: 'Unauthorized.' }))
      return
    }

    let chatReq: ChatRequest
    try {
      const body = await readBody(req)
      chatReq = validateChatRequest(parseJson(body))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ error: (err as Error).message }))
      return
    }

    try {
      const text = await callProvider(chatReq.messages)
      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ message: text }))
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ error: 'Provider request failed. Please try again.' }))
    }
    return
  }

  if (parsedUrl.pathname === '/api/auth/csrf' && method === 'GET') {
    if (!requireAllowedOrigin(req, res, cors)) return
    const csrfToken = ensureCsrfToken(cookies)
    const migratingLegacyCsrf = usesLegacyCookie(cookies, CSRF_COOKIE_NAME, LEGACY_CSRF_COOKIE_NAME)
    setCookies(res, [
      serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false,
        secure: AUTH_SECURE_COOKIES,
        sameSite: 'Lax',
        maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
      }),
      ...(migratingLegacyCsrf ? expireCookie(LEGACY_CSRF_COOKIE_NAME, false) : []),
    ])
    res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
    res.end(JSON.stringify({ csrfToken }))
    return
  }

  if (parsedUrl.pathname === '/api/auth/session' && method === 'GET') {
    if (!requireAllowedOrigin(req, res, cors)) return
    const csrfToken = ensureCsrfToken(cookies)
    const sid = currentOrLegacyCookie(cookies, AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME)
    const migratingLegacySession = usesLegacyCookie(cookies, AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME)
    const migratingLegacyCsrf = usesLegacyCookie(cookies, CSRF_COOKIE_NAME, LEGACY_CSRF_COOKIE_NAME)
    if (!sid) {
      setCookies(res, [
        serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
          httpOnly: false,
          secure: AUTH_SECURE_COOKIES,
          sameSite: 'Lax',
          maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
        }),
        ...(migratingLegacyCsrf ? expireCookie(LEGACY_CSRF_COOKIE_NAME, false) : []),
      ])
      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ authenticated: false }))
      return
    }

    const session = authStore.findActiveSession(sid)
    const user = session ? authStore.findUserById(session.userId) : null
    if (!session || !user) {
      setCookies(res, [
        ...expireCookie(AUTH_COOKIE_NAME, true),
        ...expireCookie(LEGACY_AUTH_COOKIE_NAME, true),
        serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
          httpOnly: false,
          secure: AUTH_SECURE_COOKIES,
          sameSite: 'Lax',
          maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
        }),
        ...(migratingLegacyCsrf ? expireCookie(LEGACY_CSRF_COOKIE_NAME, false) : []),
      ])
      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ authenticated: false }))
      return
    }

    const sessionMaxAgeSeconds = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000))
    setCookies(res, [
      ...(migratingLegacySession
        ? [
            serializeCookie(AUTH_COOKIE_NAME, session.id, {
              httpOnly: true,
              secure: AUTH_SECURE_COOKIES,
              sameSite: 'Lax',
              maxAgeSeconds: sessionMaxAgeSeconds,
            }),
            ...expireCookie(LEGACY_AUTH_COOKIE_NAME, true),
          ]
        : []),
      serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
        httpOnly: false,
        secure: AUTH_SECURE_COOKIES,
        sameSite: 'Lax',
        maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
      }),
      ...(migratingLegacyCsrf ? expireCookie(LEGACY_CSRF_COOKIE_NAME, false) : []),
    ])
    res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
    res.end(JSON.stringify({ authenticated: true, user: toSafeUser(user) }))
    return
  }

  async function readAuthBody(): Promise<Record<string, unknown> | null> {
    try {
      const body = await readBody(req)
      const parsed = parseJson<unknown>(body)
      if (typeof parsed !== 'object' || parsed === null) return null
      return parsed as Record<string, unknown>
    } catch {
      return null
    }
  }

  if (parsedUrl.pathname.startsWith('/api/auth/') && method === 'POST') {
    if (!requireAllowedOrigin(req, res, cors)) return
    if (!requireHttpsForSensitive(req, res, cors)) return

    const scopedEndpoint = parsedUrl.pathname
    if (
      [
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/password-reset/request',
        '/api/auth/password-reset/confirm',
        '/api/auth/verification/request',
        '/api/auth/verify-email',
      ].includes(scopedEndpoint)
    ) {
      if (
        isRateLimited(
          authRateCounts,
          authRateKey(req, scopedEndpoint),
          AUTH_RATE_LIMIT_MAX,
          AUTH_RATE_LIMIT_WINDOW_MS,
        )
      ) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil(AUTH_RATE_LIMIT_WINDOW_MS / 1000)),
          ...defaultHeaders,
        })
        res.end(JSON.stringify({ error: 'Too many requests. Please wait and try again.' }))
        return
      }
    }

    if (!requireCsrf(req, res, cors, cookies)) return

    if (parsedUrl.pathname === '/api/auth/register') {
      const body = await readAuthBody()
      if (!body) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid request.' }))
        return
      }

      const email = typeof body.email === 'string' ? normalizeEmail(body.email) : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const passwordConfirm = typeof body.passwordConfirm === 'string' ? body.passwordConfirm : ''

      if (!isValidEmail(email) || !isValidPassword(password) || password !== passwordConfirm) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid registration data.' }))
        return
      }

      let user = authStore.findUserByEmail(email)
      if (!user) {
        const passwordHash = await hashPassword(password)
        user = authStore.createUser(email, passwordHash)
      }

      if (user && !user.verifiedAt) {
        const rawToken = randomId(32)
        authStore.createToken(user.id, 'verify-email', rawToken, AUTH_VERIFY_TTL_MS)
        emailAdapter.send({
          to: user.email,
          subject: 'Verify your Daemon account',
          template: 'verify-email',
          token: rawToken,
          link: buildTokenLink('verify-email', rawToken),
          createdAt: nowIso(),
        })
      }

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(
        JSON.stringify({
          ok: true,
          message: 'If registration was accepted, check your email for verification instructions.',
        }),
      )
      return
    }

    if (parsedUrl.pathname === '/api/auth/verification/request') {
      const body = await readAuthBody()
      const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : ''

      if (isValidEmail(email)) {
        const user = authStore.findUserByEmail(email)
        if (user && !user.verifiedAt) {
          const rawToken = randomId(32)
          authStore.createToken(user.id, 'verify-email', rawToken, AUTH_VERIFY_TTL_MS)
          emailAdapter.send({
            to: user.email,
            subject: 'Verify your Daemon account',
            template: 'verify-email',
            token: rawToken,
            link: buildTokenLink('verify-email', rawToken),
            createdAt: nowIso(),
          })
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(
        JSON.stringify({
          ok: true,
          message: 'If the account exists, verification instructions have been sent.',
        }),
      )
      return
    }

    if (parsedUrl.pathname === '/api/auth/verify-email') {
      const body = await readAuthBody()
      const token = typeof body?.token === 'string' ? body.token.trim() : ''
      if (token.length < 20 || token.length > 512) {
        res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ ok: true, message: 'If token is valid, your email has been verified.' }))
        return
      }

      const record = authStore.consumeToken('verify-email', token)
      if (record) {
        authStore.markUserVerified(record.userId)
      }

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ ok: true, message: 'If token is valid, your email has been verified.' }))
      return
    }

    if (parsedUrl.pathname === '/api/auth/login') {
      const body = await readAuthBody()
      const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : ''
      const password = typeof body?.password === 'string' ? body.password : ''

      if (!isValidEmail(email) || !isValidPassword(password)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid email or password.' }))
        return
      }

      const user = authStore.findUserByEmail(email)
      const valid = user ? await verifyPassword(password, user.passwordHash) : false
      if (!user || !valid || !user.verifiedAt) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid email or password.' }))
        return
      }

      const session = authStore.createSession(user.id, AUTH_SESSION_TTL_MS)
      const csrfToken = randomId(24)
      setCookies(res, [
        serializeCookie(AUTH_COOKIE_NAME, session.id, {
          httpOnly: true,
          secure: AUTH_SECURE_COOKIES,
          sameSite: 'Lax',
          maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
        }),
        serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
          httpOnly: false,
          secure: AUTH_SECURE_COOKIES,
          sameSite: 'Lax',
          maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
        }),
        ...expireCookie(LEGACY_AUTH_COOKIE_NAME, true),
        ...expireCookie(LEGACY_CSRF_COOKIE_NAME, false),
      ])

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ ok: true, user: toSafeUser(user) }))
      return
    }

    if (parsedUrl.pathname === '/api/auth/logout') {
      const sid = currentOrLegacyCookie(cookies, AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME)
      if (sid) authStore.revokeSession(sid)
      const csrfToken = randomId(24)
      setCookies(res, [
        ...expireCookie(AUTH_COOKIE_NAME, true),
        ...expireCookie(LEGACY_AUTH_COOKIE_NAME, true),
        serializeCookie(CSRF_COOKIE_NAME, csrfToken, {
          httpOnly: false,
          secure: AUTH_SECURE_COOKIES,
          sameSite: 'Lax',
          maxAgeSeconds: Math.floor(AUTH_SESSION_TTL_MS / 1000),
        }),
        ...expireCookie(LEGACY_CSRF_COOKIE_NAME, false),
      ])
      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (parsedUrl.pathname === '/api/auth/password-reset/request') {
      const body = await readAuthBody()
      const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : ''
      if (isValidEmail(email)) {
        const user = authStore.findUserByEmail(email)
        if (user) {
          const rawToken = randomId(32)
          authStore.createToken(user.id, 'password-reset', rawToken, AUTH_RESET_TTL_MS)
          emailAdapter.send({
            to: user.email,
            subject: 'Reset your Daemon password',
            template: 'password-reset',
            token: rawToken,
            link: buildTokenLink('reset-password', rawToken),
            createdAt: nowIso(),
          })
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(
        JSON.stringify({
          ok: true,
          message: 'If an account exists, password reset instructions have been sent.',
        }),
      )
      return
    }

    if (parsedUrl.pathname === '/api/auth/password-reset/confirm') {
      const body = await readAuthBody()
      const token = typeof body?.token === 'string' ? body.token.trim() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      const passwordConfirm = typeof body?.passwordConfirm === 'string' ? body.passwordConfirm : ''

      if (token.length < 20 || token.length > 512 || !isValidPassword(password) || password !== passwordConfirm) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid reset request.' }))
        return
      }

      const record = authStore.consumeToken('password-reset', token)
      if (!record) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...defaultHeaders })
        res.end(JSON.stringify({ error: 'Invalid reset request.' }))
        return
      }

      const passwordHash = await hashPassword(password)
      authStore.updateUserPassword(record.userId, passwordHash)
      authStore.revokeAllSessionsForUser(record.userId)

      setCookies(res, [
        ...expireCookie(AUTH_COOKIE_NAME, true),
        ...expireCookie(LEGACY_AUTH_COOKIE_NAME, true),
      ])

      res.writeHead(200, { 'Content-Type': 'application/json', ...defaultHeaders })
      res.end(JSON.stringify({ ok: true, message: 'Password reset completed.' }))
      return
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json', ...defaultHeaders })
  res.end(JSON.stringify({ error: 'Not found' }))
})

export default server

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  server.listen(PORT, () => {
    console.log(`[daemon-api] Listening on http://localhost:${PORT}`)
    console.log(`[daemon-api] Provider: ${PROVIDER}  Model: ${MODEL}`)
  })

  function shutdown(signal: string): void {
    console.log(`[daemon-api] ${signal} received – shutting down gracefully`)
    server.close(err => {
      if (err) {
        console.error('[daemon-api] Error during shutdown:', err.message)
        process.exit(1)
      }
      process.exit(0)
    })
    setTimeout(() => {
      console.error('[daemon-api] Shutdown timed out – forcing exit')
      process.exit(1)
    }, 10_000).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
