export interface AuthUser {
  id: string
  email: string
  emailVerified: boolean
}

interface SessionResponse {
  authenticated: boolean
  user?: AuthUser
}

const env = (import.meta as { env?: Record<string, string> }).env ?? {}
const BASE_URL = env.VITE_DAEMON_AUTH_API_URL
  ?? env.VITE_DAEMON_API_URL
  ?? env.VITE_HELEN_AUTH_API_URL
  ?? env.VITE_HELEN_API_URL
  ?? ''

let csrfTokenCache: string | null = null

async function parseJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function endpoint(path: string): string {
  return `${BASE_URL}${path}`
}

function hasAuthBackend(): boolean {
  return BASE_URL.length > 0
}

export { hasAuthBackend }

export async function getCsrfToken(force = false): Promise<string | null> {
  if (!hasAuthBackend()) return null
  if (!force && csrfTokenCache) return csrfTokenCache

  const res = await fetch(endpoint('/api/auth/csrf'), {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) return null
  const data = await parseJson<{ csrfToken?: string }>(res)
  csrfTokenCache = data.csrfToken ?? null
  return csrfTokenCache
}

async function authPost<T>(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: T | null }> {
  if (!hasAuthBackend()) return { ok: false, status: 0, data: null }
  const csrf = await getCsrfToken()
  if (!csrf) return { ok: false, status: 0, data: null }

  const res = await fetch(endpoint(path), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify(body),
  })

  let data: T | null = null
  try {
    data = await parseJson<T>(res)
  } catch {
    data = null
  }
  return { ok: res.ok, status: res.status, data }
}

export async function getCurrentSession(): Promise<AuthUser | null> {
  if (!hasAuthBackend()) return null
  const res = await fetch(endpoint('/api/auth/session'), {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) return null
  const data = await parseJson<SessionResponse>(res)
  if (!data.authenticated || !data.user) return null
  return data.user
}

export async function registerUser(email: string, password: string, passwordConfirm: string): Promise<{ ok: boolean; message: string }> {
  const res = await authPost<{ message?: string }>('/api/auth/register', {
    email,
    password,
    passwordConfirm,
  })
  return {
    ok: res.ok,
    message: res.data?.message ?? (res.ok ? 'Registration request accepted.' : 'Registration failed.'),
  }
}

export async function requestVerification(email: string): Promise<{ ok: boolean; message: string }> {
  const res = await authPost<{ message?: string }>('/api/auth/verification/request', { email })
  return {
    ok: res.ok,
    message: res.data?.message ?? (res.ok ? 'Verification request accepted.' : 'Verification request failed.'),
  }
}

export async function completeVerification(token: string): Promise<{ ok: boolean; message: string }> {
  const res = await authPost<{ message?: string }>('/api/auth/verify-email', { token })
  return {
    ok: res.ok,
    message: res.data?.message ?? (res.ok ? 'Verification complete.' : 'Verification failed.'),
  }
}

export async function loginUser(email: string, password: string): Promise<{ ok: boolean; user: AuthUser | null; message: string }> {
  const res = await authPost<{ user?: AuthUser; error?: string }>('/api/auth/login', { email, password })
  return {
    ok: res.ok,
    user: res.ok ? (res.data?.user ?? null) : null,
    message: res.ok ? 'Logged in.' : (res.data?.error ?? 'Invalid email or password.'),
  }
}

export async function logoutUser(): Promise<boolean> {
  const res = await authPost<Record<string, never>>('/api/auth/logout', {})
  csrfTokenCache = null
  return res.ok
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }> {
  const res = await authPost<{ message?: string }>('/api/auth/password-reset/request', { email })
  return {
    ok: res.ok,
    message: res.data?.message ?? (res.ok ? 'Reset request accepted.' : 'Reset request failed.'),
  }
}

export async function completePasswordReset(
  token: string,
  password: string,
  passwordConfirm: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await authPost<{ message?: string; error?: string }>('/api/auth/password-reset/confirm', {
    token,
    password,
    passwordConfirm,
  })
  return {
    ok: res.ok,
    message: res.ok ? (res.data?.message ?? 'Password reset completed.') : (res.data?.error ?? 'Password reset failed.'),
  }
}
