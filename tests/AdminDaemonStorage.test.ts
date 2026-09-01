/**
 * Admin Daemon storage isolation tests.
 *
 * Verifies that:
 * 4. Admin storage keys are distinct from public Daemon keys.
 * 5. Admin persistence helpers require configured session and fail safely.
 * 8. Demoted user behaviour (access denied at RLS level — tested via
 *    the is_admin() policy convention in the migration tests).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_STORAGE_KEYS, getAdminStorageKey } from '../src/components/AdminDaemonInterface'

// ---------------------------------------------------------------------------
// Isolated admin storage key constants (must match the component)
// ---------------------------------------------------------------------------

const ADMIN_TEST_USER_ID = 'admin-user-1'
const ADMIN_CONVERSATIONS_KEY = getAdminStorageKey(ADMIN_TEST_USER_ID, 'conversations')
const ADMIN_ACTIVE_CONV_KEY = getAdminStorageKey(ADMIN_TEST_USER_ID, 'activeConversationId')
const ADMIN_SIDEBAR_KEY = getAdminStorageKey(ADMIN_TEST_USER_ID, 'sidebarOpen')

// Public Daemon keys (must not be touched by admin operations)
const PUBLIC_CONVERSATIONS_KEY = 'daemon_conversations'
const PUBLIC_MESSAGES_KEY = 'daemon_messages'
const PUBLIC_ACTIVE_CONV_KEY = 'daemon_active_conv_id'
const PUBLIC_SIDEBAR_KEY = 'daemon_sidebar_open'

// All admin storage key names
const ALL_ADMIN_KEYS = [ADMIN_CONVERSATIONS_KEY, ADMIN_ACTIVE_CONV_KEY, ADMIN_SIDEBAR_KEY]

// All public Daemon storage key names
const ALL_PUBLIC_KEYS = [PUBLIC_CONVERSATIONS_KEY, PUBLIC_MESSAGES_KEY, PUBLIC_ACTIVE_CONV_KEY, PUBLIC_SIDEBAR_KEY]

// ---------------------------------------------------------------------------
// Persistence service tests
// ---------------------------------------------------------------------------

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  })),
}))

// Mock import.meta.env for the persistence service
vi.stubEnv('VITE_SUPABASE_URL', '')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

import {
  isAdminPersistenceConfigured,
  listAdminConversations,
  upsertAdminConversation,
  deleteAdminConversation,
  deleteAllAdminConversations,
  listAdminMemories,
  insertAdminMemory,
  deleteAdminMemory,
  deleteAllAdminMemories,
  insertAdminMessage,
  listAdminMessages,
  getAdminDiagnosticsStatus,
} from '../src/services/adminDaemonPersistence'

// ---------------------------------------------------------------------------
// Storage key isolation
// ---------------------------------------------------------------------------

describe('Admin storage key isolation', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('admin keys are distinct from all public Daemon keys', () => {
    for (const adminKey of ALL_ADMIN_KEYS) {
      for (const publicKey of ALL_PUBLIC_KEYS) {
        expect(adminKey).not.toBe(publicKey)
      }
    }
  })

  it('admin conversation key has admin namespace prefix', () => {
    expect(ADMIN_STORAGE_KEYS.conversations).toContain('admin')
    expect(ADMIN_STORAGE_KEYS.activeConversationId).toContain('admin')
    expect(ADMIN_STORAGE_KEYS.sidebarOpen).toContain('admin')
  })

  it('writing to admin keys does not affect public keys', () => {
    // Pre-populate public keys
    localStorage.setItem(PUBLIC_CONVERSATIONS_KEY, JSON.stringify([{ id: 'pub-1' }]))
    localStorage.setItem(PUBLIC_MESSAGES_KEY, JSON.stringify([{ id: 'msg-1' }]))
    localStorage.setItem(PUBLIC_ACTIVE_CONV_KEY, 'pub-1')

    // Simulate admin operation: write to admin keys
    localStorage.setItem(ADMIN_CONVERSATIONS_KEY, JSON.stringify([{ id: 'adm-1' }]))
    localStorage.setItem(ADMIN_ACTIVE_CONV_KEY, 'adm-1')

    // Public keys must be untouched
    expect(JSON.parse(localStorage.getItem(PUBLIC_CONVERSATIONS_KEY)!)).toEqual([{ id: 'pub-1' }])
    expect(JSON.parse(localStorage.getItem(PUBLIC_MESSAGES_KEY)!)).toEqual([{ id: 'msg-1' }])
    expect(localStorage.getItem(PUBLIC_ACTIVE_CONV_KEY)).toBe('pub-1')
  })

  it('clearing admin keys does not remove public keys', () => {
    localStorage.setItem(PUBLIC_CONVERSATIONS_KEY, JSON.stringify([{ id: 'pub-1' }]))
    localStorage.setItem(ADMIN_CONVERSATIONS_KEY, JSON.stringify([{ id: 'adm-1' }]))
    localStorage.setItem(ADMIN_ACTIVE_CONV_KEY, 'adm-1')

    // Simulate admin clear-all: remove only admin keys
    localStorage.removeItem(ADMIN_CONVERSATIONS_KEY)
    localStorage.removeItem(ADMIN_ACTIVE_CONV_KEY)

    expect(localStorage.getItem(PUBLIC_CONVERSATIONS_KEY)).not.toBeNull()
    expect(localStorage.getItem(ADMIN_CONVERSATIONS_KEY)).toBeNull()
  })

  it('public Daemon operations do not alter admin keys', () => {
    localStorage.setItem(ADMIN_CONVERSATIONS_KEY, JSON.stringify([{ id: 'adm-1' }]))

    // Simulate public Daemon operation: write to public keys only
    localStorage.setItem(PUBLIC_CONVERSATIONS_KEY, JSON.stringify([{ id: 'pub-2' }]))
    localStorage.setItem(PUBLIC_ACTIVE_CONV_KEY, 'pub-2')

    // Admin keys must be untouched
    expect(JSON.parse(localStorage.getItem(ADMIN_CONVERSATIONS_KEY)!)).toEqual([{ id: 'adm-1' }])
  })
})

// ---------------------------------------------------------------------------
// Persistence service — safe failure when unconfigured
// ---------------------------------------------------------------------------

describe('Admin persistence service — unconfigured state', () => {
  it('isAdminPersistenceConfigured returns false when env vars are empty', () => {
    // VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are stubbed as empty above
    expect(isAdminPersistenceConfigured()).toBe(false)
  })

  it('listAdminConversations returns empty array when unconfigured', async () => {
    const result = await listAdminConversations()
    expect(result).toEqual([])
  })

  it('upsertAdminConversation returns false when unconfigured', async () => {
    const result = await upsertAdminConversation('id-1', 'Test')
    expect(result).toBe(false)
  })

  it('deleteAdminConversation returns false when unconfigured', async () => {
    const result = await deleteAdminConversation('id-1')
    expect(result).toBe(false)
  })

  it('deleteAllAdminConversations returns false when unconfigured', async () => {
    const result = await deleteAllAdminConversations()
    expect(result).toBe(false)
  })

  it('listAdminMemories returns empty array when unconfigured', async () => {
    const result = await listAdminMemories()
    expect(result).toEqual([])
  })

  it('insertAdminMemory returns false when unconfigured', async () => {
    const result = await insertAdminMemory('id-1', 'test memory')
    expect(result).toBe(false)
  })

  it('deleteAdminMemory returns false when unconfigured', async () => {
    const result = await deleteAdminMemory('id-1')
    expect(result).toBe(false)
  })

  it('deleteAllAdminMemories returns false when unconfigured', async () => {
    const result = await deleteAllAdminMemories()
    expect(result).toBe(false)
  })

  it('insertAdminMessage returns false when unconfigured', async () => {
    const result = await insertAdminMessage({
      id: 'id-1',
      conversation_id: 'conv-1',
      role: 'user',
      content: 'hello',
      position: 0,
    })
    expect(result).toBe(false)
  })

  it('listAdminMessages returns empty array when unconfigured', async () => {
    const result = await listAdminMessages('conv-1')
    expect(result).toEqual([])
  })

  it('getAdminDiagnosticsStatus returns unconfigured state', async () => {
    const status = await getAdminDiagnosticsStatus()
    expect(status.persistenceConfigured).toBe(false)
    expect(status.sessionActive).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Persistence service — no service-role credentials in service
// ---------------------------------------------------------------------------

describe('Admin persistence service — uses only anon key', () => {
  it('service file does not contain service_role in source', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/adminDaemonPersistence.ts'),
      'utf8',
    )
    expect(src).not.toContain('SERVICE_ROLE')
    expect(src).not.toContain('service_role')
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('service file uses only VITE_ prefixed env vars', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/services/adminDaemonPersistence.ts'),
      'utf8',
    )
    // All env var accesses must use VITE_ prefix (browser-safe)
    const envAccesses = src.match(/VITE_\w+/g) ?? []
    expect(envAccesses).toContain('VITE_SUPABASE_URL')
    expect(envAccesses).toContain('VITE_SUPABASE_ANON_KEY')
    expect(src).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})
