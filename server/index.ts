/**
 * HELEN API Server
 *
 * A minimal Node/Express gateway that proxies chat requests to an LLM provider
 * using server-side credentials.  Provider API keys NEVER reach the browser.
 *
 * Supported providers (set HELEN_PROVIDER env var):
 *   openai   – OpenAI Chat Completions (default)
 *   anthropic – Anthropic Messages API
 *
 * Required environment variables:
 *   HELEN_PROVIDER        openai | anthropic  (default: openai)
 *   OPENAI_API_KEY        required when provider=openai
 *   ANTHROPIC_API_KEY     required when provider=anthropic
 *   HELEN_MODEL           model name overrides default per-provider
 *   HELEN_ALLOWED_ORIGINS comma-separated list of allowed CORS origins
 *                         default: http://localhost:3000,http://localhost:4173
 *
 * Frontend uses VITE_HELEN_API_URL to point at this server.
 * When VITE_HELEN_API_URL is not set the frontend falls back to its local
 * rule-based response brain – no server required.
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001)
const PROVIDER = (process.env.HELEN_PROVIDER ?? 'openai').toLowerCase()
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? ''
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
}
const MODEL = process.env.HELEN_MODEL ?? DEFAULT_MODELS[PROVIDER] ?? 'gpt-4o-mini'

const ALLOWED_ORIGINS = (
  process.env.HELEN_ALLOWED_ORIGINS ??
  'http://localhost:3000,http://localhost:4173'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

/** Maximum turns to include in context window sent to provider */
const MAX_HISTORY_TURNS = 20
/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface ChatRequest {
  messages: ChatMessage[]
  stream?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns CORS headers only when the request origin is in ALLOWED_ORIGINS.
 * For untrusted or missing origins the Access-Control-Allow-Origin header is
 * omitted entirely so the browser will refuse cross-origin access.
 */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    }
  }
  // No origin header (same-origin / server-to-server) or untrusted origin:
  // do not advertise any allowed origin.
  return {}
}

/** Maximum allowed request body size in bytes (64 KB is generous for chat payloads) */
const MAX_BODY_BYTES = 64 * 1024

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', chunk => {
      const buf = chunk as Buffer
      totalBytes += buf.length
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy(new Error('Request body too large'))
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
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
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }
    const req = https.request(options, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk as Buffer))
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf-8') }),
      )
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Provider request timed out'))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

const HELEN_SYSTEM_PROMPT = `You are HELEN, a helpful, honest, and thoughtful AI assistant.
You are NOT a human. You are an AI. Never claim or imply otherwise.
You are warm, curious, and direct. You acknowledge uncertainty.
You refuse requests that are harmful, illegal, or unethical, and explain why briefly.`

async function callOpenAI(messages: ChatMessage[]): Promise<string> {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set')

  const payload = {
    model: MODEL,
    messages: [{ role: 'system', content: HELEN_SYSTEM_PROMPT }, ...messages],
    max_tokens: 1024,
  }

  const result = await httpsPost(
    'https://api.openai.com/v1/chat/completions',
    { Authorization: 'Bearer ' + OPENAI_KEY },
    JSON.stringify(payload),
  )

  if (result.status !== 200) {
    throw new Error(`OpenAI error ${result.status}: ${result.body.slice(0, 200)}`)
  }

  interface OpenAIResponse {
    choices: Array<{ message: { content: string } }>
  }
  const data = JSON.parse(result.body) as OpenAIResponse
  return data.choices[0]?.message?.content ?? ''
}

async function callAnthropic(messages: ChatMessage[]): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set')

  // Anthropic uses a separate system field
  const payload = {
    model: MODEL,
    system: HELEN_SYSTEM_PROMPT,
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

  if (result.status !== 200) {
    throw new Error(`Anthropic error ${result.status}: ${result.body.slice(0, 200)}`)
  }

  interface AnthropicResponse {
    content: Array<{ text: string }>
  }
  const data = JSON.parse(result.body) as AnthropicResponse
  return data.content[0]?.text ?? ''
}

async function callProvider(messages: ChatMessage[]): Promise<string> {
  if (PROVIDER === 'anthropic') return callAnthropic(messages)
  return callOpenAI(messages)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateChatRequest(raw: unknown): ChatRequest {
  if (typeof raw !== 'object' || raw === null) throw new Error('Request body must be a JSON object')
  const obj = raw as Record<string, unknown>

  if (!Array.isArray(obj.messages)) throw new Error('messages must be an array')

  const messages: ChatMessage[] = obj.messages.slice(-MAX_HISTORY_TURNS * 2).map((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`messages[${i}] must be an object`)
    const msg = m as Record<string, unknown>
    if (!['user', 'assistant'].includes(msg.role as string)) {
      throw new Error(`messages[${i}].role must be "user" or "assistant"`)
    }
    if (typeof msg.content !== 'string' || msg.content.length > 8192) {
      throw new Error(`messages[${i}].content must be a string ≤ 8192 chars`)
    }
    return { role: msg.role as 'user' | 'assistant', content: msg.content }
  })

  return { messages }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const origin = req.headers['origin']
  const cors = corsHeaders(origin)

  // CORS preflight
  if (req.method === 'OPTIONS') {
    const preflightOrigin = req.headers['origin']
    if (preflightOrigin && ALLOWED_ORIGINS.includes(preflightOrigin)) {
      res.writeHead(204, corsHeaders(preflightOrigin))
    } else {
      res.writeHead(403)
    }
    res.end()
    return
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
    res.end(JSON.stringify({ ok: true, provider: PROVIDER, model: MODEL }))
    return
  }

  // Chat endpoint
  if (req.url === '/api/chat' && req.method === 'POST') {
    let chatReq: ChatRequest

    try {
      const body = await readBody(req)
      const parsed: unknown = JSON.parse(body)
      chatReq = validateChatRequest(parsed)
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify({ error: (err as Error).message }))
      return
    }

    try {
      const text = await callProvider(chatReq.messages)
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify({ message: text }))
    } catch (err) {
      const msg = (err as Error).message
      // Do not leak API key details – only surface a safe excerpt
      const safe = msg.replace(/sk-[A-Za-z0-9-]+/g, '[redacted]')
      console.error('[helen-api] Provider error:', safe)
      res.writeHead(502, { 'Content-Type': 'application/json', ...cors })
      res.end(JSON.stringify({ error: 'Provider request failed. Please try again.' }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json', ...cors })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, () => {
  console.log(`[helen-api] Listening on http://localhost:${PORT}`)
  console.log(`[helen-api] Provider: ${PROVIDER}  Model: ${MODEL}`)
})

export default server
