/**
 * Supabase managed-auth integration for the GitHub Pages frontend.
 *
 * This module wraps @supabase/supabase-js to provide email/password sign-up,
 * sign-in, sign-out, password reset, email verification, and persisted session
 * restore — all from a static browser client with no custom backend required.
 *
 * Configuration is supplied via Vite build-time variables:
 *   VITE_SUPABASE_URL     – your Supabase project URL  (publishable, safe to embed)
 *   VITE_SUPABASE_ANON_KEY – your Supabase anon/public key (publishable, safe to embed)
 *
 * Both variables must be present for the managed auth path to activate.
 * When absent the module exports safe no-op results and the UI shows the
 * "not configured" state rather than a broken form.
 *
 * Never embed service-role keys, JWT secrets, or any private credentials here.
 * The Supabase anon key is intentionally public and is protected by Row Level
 * Security on the database side.
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthUser } from './daemonAuthAPI'

type AuthRole = 'user' | 'admin'

// ---------------------------------------------------------------------------
// Supabase client – only initialised when both config values are present
// ---------------------------------------------------------------------------

const SUPABASE_URL = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = (import.meta as { env?: Record<string, string> }).env?.VITE_SUPABASE_ANON_KEY ?? ''

/** Returns true when Supabase is configured at build time. */
export function hasSupabaseConfig(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0
}

let _client: SupabaseClient | null = null

function getClient(): SupabaseClient | null {
  if (!hasSupabaseConfig()) return null
  if (_client) return _client
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Store session in localStorage so it survives page reloads.
      persistSession: true,
      // Automatically refresh the JWT before it expires.
      autoRefreshToken: true,
      // Use the hash fragment for redirect callbacks (GitHub Pages hash routing).
      detectSessionInUrl: true,
      // Flow type – PKCE is the secure default for SPAs.
      flowType: 'pkce',
    },
  })
  return _client
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchRole(client: SupabaseClient, userId: string): Promise<AuthRole | null> {
  const { data, error } = await client
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle<{ role: AuthRole }>()

  if (error || !data?.role) return null
  return data.role
}

async function toAuthUser(client: SupabaseClient, sbUser: import('@supabase/supabase-js').User): Promise<AuthUser> {
  return {
    id: sbUser.id,
    email: sbUser.email ?? '',
    emailVerified: sbUser.email_confirmed_at != null,
    role: await fetchRole(client, sbUser.id),
  }
}

/**
 * The redirect URL for password-reset and email-verification links sent by
 * Supabase.  We point back to the Pages hash route that handles the token.
 *
 * The final URL fragment is appended by Supabase, e.g.
 *   https://dmankv.github.io/Project-HELEN/#/verify-email#access_token=...
 *
 * We rely on Supabase's detectSessionInUrl to pick up the token on load.
 */
function emailRedirectTo(route: 'verify-email' | 'reset-password'): string {
  const base = typeof window !== 'undefined' ? window.location.origin : 'https://dmankv.github.io'
  return `${base}/Project-HELEN/#/${route}`
}

// ---------------------------------------------------------------------------
// Public API – mirrors the shape used by daemonAuthAPI.ts
// ---------------------------------------------------------------------------

/** Restore an existing Supabase session (called on app mount). */
export async function supabaseGetCurrentSession(): Promise<AuthUser | null> {
  const client = getClient()
  if (!client) return null
  const { data } = await client.auth.getSession()
  const user = data.session?.user ?? null
  return user ? toAuthUser(client, user) : null
}

/** Sign up with email + password. */
export async function supabaseRegister(
  email: string,
  password: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient()
  if (!client) return { ok: false, message: 'Supabase is not configured.' }
  const { error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: emailRedirectTo('verify-email') },
  })
  if (error) return { ok: false, message: error.message }
  return {
    ok: true,
    message: 'Account created. Check your inbox to verify your email before signing in.',
  }
}

/** Sign in with email + password. */
export async function supabaseLogin(
  email: string,
  password: string,
): Promise<{ ok: boolean; user: AuthUser | null; message: string }> {
  const client = getClient()
  if (!client) return { ok: false, user: null, message: 'Supabase is not configured.' }
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.user) {
    return { ok: false, user: null, message: error?.message ?? 'Invalid email or password.' }
  }
  return { ok: true, user: await toAuthUser(client, data.user), message: 'Logged in.' }
}

/** Sign out the current user. */
export async function supabaseLogout(): Promise<boolean> {
  const client = getClient()
  if (!client) return false
  const { error } = await client.auth.signOut()
  return !error
}

/** Send a password-reset email. */
export async function supabaseRequestPasswordReset(
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient()
  if (!client) return { ok: false, message: 'Supabase is not configured.' }
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: emailRedirectTo('reset-password'),
  })
  if (error) return { ok: false, message: error.message }
  return {
    ok: true,
    message: 'Password reset email sent. Check your inbox.',
  }
}

/**
 * Complete a password reset using the Supabase token surfaced in the URL.
 * Supabase's detectSessionInUrl exchanges the token automatically on load;
 * after that we call updateUser to set the new password.
 */
export async function supabaseCompletePasswordReset(
  password: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient()
  if (!client) return { ok: false, message: 'Supabase is not configured.' }
  const { error } = await client.auth.updateUser({ password })
  if (error) return { ok: false, message: error.message }
  return { ok: true, message: 'Password updated. You can now sign in with your new password.' }
}

/**
 * Resend a verification email.
 * Supabase handles the verify-email callback via detectSessionInUrl; the user
 * just needs to click the link in their inbox.
 */
export async function supabaseResendVerification(
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const client = getClient()
  if (!client) return { ok: false, message: 'Supabase is not configured.' }
  const { error } = await client.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: emailRedirectTo('verify-email') },
  })
  if (error) return { ok: false, message: error.message }
  return { ok: true, message: 'Verification email resent. Check your inbox.' }
}

/**
 * Subscribe to auth state changes (sign-in / sign-out / token refresh).
 * The callback receives the mapped AuthUser (or null on sign-out) and the
 * raw Supabase event name so callers can distinguish sign-in from refresh.
 * Returns an unsubscribe function.
 */
export function supabaseOnAuthStateChange(
  callback: (user: AuthUser | null, event: string) => void,
): () => void {
  const client = getClient()
  if (!client) return () => undefined
  let latestEventId = 0
  const { data } = client.auth.onAuthStateChange((event, session) => {
    const eventId = ++latestEventId
    void (async () => {
      const nextUser = session?.user ? await toAuthUser(client, session.user) : null
      if (eventId !== latestEventId) return
      callback(nextUser, event)
    })()
  })
  return () => data.subscription.unsubscribe()
}
