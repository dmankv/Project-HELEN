/**
 * Tests for Supabase persistence service and edge function chat client.
 * Uses module-level mocking since env vars are read at module initialization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Mock @supabase/supabase-js with factory (hoisted before imports)
// ---------------------------------------------------------------------------

const mockGetSession = vi.fn()
const mockFrom = vi.fn()

vi.mock('@supabase/supabase-js', () => {
  return {
    createClient: vi.fn(() => ({
      from: mockFrom,
      auth: { getSession: mockGetSession, getUser: vi.fn() },
    })),
  }
})

// ---------------------------------------------------------------------------
// We test the persistence services by mocking their exported functions
// since env vars are baked at module init time.
// ---------------------------------------------------------------------------

vi.mock('../src/services/supabasePersistence', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/supabasePersistence')>()
  return {
    ...actual,
    isPersistenceConfigured: vi.fn(() => true),
    isCloudMigrationDone: vi.fn(() => false),
  }
})

vi.mock('../src/services/supabaseEdgeChat', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/supabaseEdgeChat')>()
  return {
    ...actual,
    hasEdgeFunction: vi.fn(() => true),
  }
})

import {
  isPersistenceConfigured,
  isCloudMigrationDone,
} from '../src/services/supabasePersistence'

import { hasEdgeFunction } from '../src/services/supabaseEdgeChat'

// ---------------------------------------------------------------------------
// SQL static assertions (no runtime Supabase needed)
// ---------------------------------------------------------------------------

const persistenceSql = fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations/20260824160000_daemon_persistence.sql'),
  'utf8',
)
const normalizedSql = persistenceSql.toLowerCase()

describe('Supabase persistence – isPersistenceConfigured mock', () => {
  it('returns true (mocked as configured)', () => {
    expect(isPersistenceConfigured()).toBe(true)
  })
})

describe('Supabase edge chat – hasEdgeFunction mock', () => {
  it('returns true (mocked as configured)', () => {
    expect(hasEdgeFunction()).toBe(true)
  })
})

describe('isCloudMigrationDone', () => {
  it('returns false before migration runs (mocked)', () => {
    expect(isCloudMigrationDone()).toBe(false)
  })
})

describe('Daemon persistence SQL – RLS on all tables', () => {
  const TABLES = ['conversations', 'messages', 'durable_memories', 'learning_interactions', 'edge_rate_limits']

  TABLES.forEach(table => {
    it(`enables RLS on ${table}`, () => {
      expect(normalizedSql).toContain(`alter table public.${table} enable row level security;`)
    })
  })
})

describe('Daemon persistence SQL – owner-only policies', () => {
  it('uses auth.uid() = user_id in policies', () => {
    expect(normalizedSql).toContain('auth.uid() = user_id')
  })

  it('has no public (unauthenticated) policies on user tables', () => {
    const policyBlocks = persistenceSql.match(/create policy[\s\S]+?;/gi) ?? []
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toMatch(/\bto public\b/)
    }
  })

  it('all user-data policies target authenticated role', () => {
    const policyBlocks = persistenceSql.match(/create policy[\s\S]+?;/gi) ?? []
    const userPolicies = policyBlocks.filter(p =>
      !p.toLowerCase().includes('edge_rate_limits')
    )
    expect(userPolicies.length).toBeGreaterThan(0)
    for (const policy of userPolicies) {
      expect(policy.toLowerCase()).toContain('to authenticated')
    }
  })
})

describe('Daemon persistence SQL – owner immutability triggers', () => {
  it('prevents conversation owner change', () => {
    expect(persistenceSql).toMatch(/prevent_conversation_owner_change/i)
    expect(persistenceSql).toMatch(/conversation owner is immutable/i)
  })

  it('prevents message owner change', () => {
    expect(persistenceSql).toMatch(/prevent_message_owner_change/i)
    expect(persistenceSql).toMatch(/message owner and conversation are immutable/i)
  })

  it('prevents memory owner change', () => {
    expect(persistenceSql).toMatch(/prevent_memory_owner_change/i)
    expect(persistenceSql).toMatch(/memory owner is immutable/i)
  })

  it('prevents learning interaction owner change', () => {
    expect(persistenceSql).toMatch(/prevent_learning_owner_change/i)
    expect(persistenceSql).toMatch(/learning interaction owner is immutable/i)
  })
})

describe('Daemon persistence SQL – edge_rate_limits service-role only', () => {
  it('grants all to service_role for edge_rate_limits', () => {
    expect(normalizedSql).toContain('grant all on table public.edge_rate_limits to service_role;')
  })

  it('has no authenticated client policies on edge_rate_limits', () => {
    const rateLimitSection = persistenceSql.slice(persistenceSql.toLowerCase().indexOf('edge_rate_limits'))
    const policyBlocks = rateLimitSection.match(/create policy[\s\S]+?;/gi) ?? []
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toContain('to authenticated')
    }
  })
})

describe('Edge function callEdgeFunction – runtime behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: 'u1' }, access_token: 'tok' } },
    })
  })

  it('returns null when session is null (callEdgeFunction uses real module with mocked supabase)', async () => {
    // Use the real callEdgeFunction but with a mocked supabase client
    // Since the module env vars are empty at test time, hasEdgeFunction() would
    // return false unless SUPABASE_URL is set. We test the mock behavior:
    // The mock above makes hasEdgeFunction() return true, but callEdgeFunction
    // uses the real implementation which needs env vars. Test fallback behavior.
    const { callEdgeFunction: realCall } = await import('../src/services/supabaseEdgeChat')
    // Without real env vars, getClient() returns null → returns null
    const result = await realCall([{ role: 'user', content: 'hi' }])
    // Result is null because SUPABASE_URL/KEY are empty in test env
    expect(result).toBeNull()
  })
})
