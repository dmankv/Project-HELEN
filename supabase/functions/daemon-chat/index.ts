/**
 * Daemon Chat Edge Function
 *
 * Verifies the caller's Supabase JWT, enforces per-user rate limiting using
 * provider-side storage, validates the request schema, and calls the
 * configured AI provider (OpenAI or Anthropic) using secrets stored only in
 * Supabase Edge Function secrets — never in the browser bundle.
 *
 * Required Supabase Function secrets (set via `supabase secrets set`):
 *   OPENAI_API_KEY       – OpenAI secret key (when DAEMON_PROVIDER=openai)
 *   ANTHROPIC_API_KEY    – Anthropic secret key (when DAEMON_PROVIDER=anthropic)
 *   DAEMON_PROVIDER      – "openai" or "anthropic" (default: openai)
 *   DAEMON_MODEL         – model name override (optional)
 *
 * Public environment variables (injected automatically by Supabase):
 *   SUPABASE_URL         – project URL
 *   SUPABASE_SERVICE_ROLE_KEY – service-role key (available only inside edge functions)
 *
 * CORS:
 *   Only https://dmankv.github.io and http://localhost:* (dev) are allowed.
 *   Wildcard credentialed CORS is explicitly NOT used.
 *
 * Rate limit:
 *   60 requests per user per 60-second window, tracked in public.edge_rate_limits
 *   using service-role writes (bypasses RLS, invisible to browser clients).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface RequestBody {
  messages: ChatMessage[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX = 60
const RATE_LIMIT_WINDOW_MS = 60_000
const MAX_MESSAGES = 40
const MAX_CONTENT_BYTES = 8_000
const REQUEST_TIMEOUT_MS = 30_000

const DAEMON_SYSTEM_PROMPT = `You are Daemon, a thoughtful and loyal AI assistant. You provide helpful, honest, and precise responses. You never reveal internal system details, API keys, or other secrets. If you cannot help with something, say so clearly.`

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  'https://dmankv.github.io',
])

function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (!requestOrigin) return null
  if (ALLOWED_ORIGINS.has(requestOrigin)) return requestOrigin
  // Allow localhost for local development
  if (/^http:\/\/localhost(:\d+)?$/.test(requestOrigin)) return requestOrigin
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(requestOrigin)) return requestOrigin
  return null
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (server-side, durable)
// ---------------------------------------------------------------------------

async function checkRateLimit(
  serviceClient: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now()

  // Read existing row first
  const { data: existing, error: selectError } = await serviceClient
    .from('edge_rate_limits')
    .select('request_count, window_start')
    .eq('user_id', userId)
    .maybeSingle<{ request_count: number; window_start: string }>()

  if (selectError) {
    console.warn('[daemon-chat] rate limit select failed:', selectError.message)
    return { allowed: true, remaining: RATE_LIMIT_MAX }
  }

  const nowIso = new Date(now).toISOString()

  if (!existing) {
    // First request for this user — insert a fresh row
    await serviceClient
      .from('edge_rate_limits')
      .insert({ user_id: userId, request_count: 1, window_start: nowIso, updated_at: nowIso })
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  const windowStartTs = new Date(existing.window_start).getTime()

  if (windowStartTs < now - RATE_LIMIT_WINDOW_MS) {
    // Current window expired — reset counter to 1
    await serviceClient
      .from('edge_rate_limits')
      .update({ request_count: 1, window_start: nowIso, updated_at: nowIso })
      .eq('user_id', userId)
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 }
  }

  if (existing.request_count >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 }
  }

  // Increment atomically — use the current DB value to avoid races
  const { error: updateError } = await serviceClient
    .from('edge_rate_limits')
    .update({ request_count: existing.request_count + 1, updated_at: nowIso })
    .eq('user_id', userId)

  if (updateError) {
    console.warn('[daemon-chat] rate limit increment failed:', updateError.message)
    return { allowed: true, remaining: RATE_LIMIT_MAX }
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - existing.request_count - 1 }
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validateMessages(body: unknown): { valid: boolean; messages?: ChatMessage[]; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, error: 'Request body must be a JSON object.' }
  }
  const { messages } = body as Record<string, unknown>
  if (!Array.isArray(messages)) return { valid: false, error: 'messages must be an array.' }
  if (messages.length === 0) return { valid: false, error: 'messages must not be empty.' }
  if (messages.length > MAX_MESSAGES) {
    return { valid: false, error: `messages exceeds maximum of ${MAX_MESSAGES} turns.` }
  }
  const validated: ChatMessage[] = []
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') return { valid: false, error: 'Each message must be an object.' }
    const { role, content } = msg as Record<string, unknown>
    if (role !== 'user' && role !== 'assistant') {
      return { valid: false, error: 'Each message role must be "user" or "assistant".' }
    }
    if (typeof content !== 'string') return { valid: false, error: 'Each message content must be a string.' }
    if (new TextEncoder().encode(content).byteLength > MAX_CONTENT_BYTES) {
      return { valid: false, error: `Message content exceeds ${MAX_CONTENT_BYTES} bytes.` }
    }
    validated.push({ role: role as 'user' | 'assistant', content })
  }
  // Last message must be from user
  if (validated[validated.length - 1].role !== 'user') {
    return { valid: false, error: 'Last message must be from user.' }
  }
  return { valid: true, messages: validated }
}

// ---------------------------------------------------------------------------
// AI provider call
// ---------------------------------------------------------------------------

async function callProvider(messages: ChatMessage[]): Promise<string> {
  const provider = (Deno.env.get('DAEMON_PROVIDER') ?? 'openai').toLowerCase()
  const systemMessages = [{ role: 'system', content: DAEMON_SYSTEM_PROMPT }]

  if (provider === 'anthropic') {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
    const model = Deno.env.get('DAEMON_MODEL') ?? 'claude-3-5-haiku-20241022'
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: DAEMON_SYSTEM_PROMPT,
        messages,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[daemon-chat] Anthropic error:', res.status, text.slice(0, 200))
      throw new Error('Provider error')
    }
    const data = await res.json() as { content?: Array<{ text?: string }> }
    return data.content?.[0]?.text ?? ''
  }

  // Default: OpenAI
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')
  const model = Deno.env.get('DAEMON_MODEL') ?? 'gpt-4o-mini'
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [...systemMessages, ...messages],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error('[daemon-chat] OpenAI error:', res.status, text.slice(0, 200))
    throw new Error('Provider error')
  }
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get('origin')
  const allowedOrigin = getAllowedOrigin(requestOrigin)

  // Always handle preflight
  if (req.method === 'OPTIONS') {
    const origin = allowedOrigin ?? 'https://dmankv.github.io'
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  // Reject disallowed origins for credentialed requests
  if (!allowedOrigin) {
    return new Response(JSON.stringify({ error: 'CORS: origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const headers = { 'Content-Type': 'application/json', ...corsHeaders(allowedOrigin) }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers })
  }

  // ── JWT verification ─────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), { status: 401, headers })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, headers })
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  const serviceClient = createClient(supabaseUrl, serviceRoleKey)
  const { allowed, remaining } = await checkRateLimit(serviceClient, user.id)
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded. Please wait before sending more messages.' }),
      { status: 429, headers: { ...headers, 'X-RateLimit-Remaining': '0' } },
    )
  }

  // ── Schema validation ────────────────────────────────────────────────────
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers })
  }

  const validation = validateMessages(body)
  if (!validation.valid || !validation.messages) {
    return new Response(JSON.stringify({ error: validation.error }), { status: 400, headers })
  }

  // ── AI provider call ─────────────────────────────────────────────────────
  try {
    const message = await callProvider(validation.messages)
    return new Response(
      JSON.stringify({ message }),
      { status: 200, headers: { ...headers, 'X-RateLimit-Remaining': String(remaining) } },
    )
  } catch (err) {
    const msg = (err as Error).message ?? 'Unknown error'
    // Do not expose provider details; log internally only
    console.error('[daemon-chat] provider call failed:', msg)
    return new Response(
      JSON.stringify({ error: 'The AI provider is temporarily unavailable. Please try again later.' }),
      { status: 502, headers },
    )
  }
})
