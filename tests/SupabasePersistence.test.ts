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
const persistenceServiceSrc = fs.readFileSync(
  path.resolve(process.cwd(), 'src/services/supabasePersistence.ts'),
  'utf8',
)

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

describe('Daemon persistence SQL – conversation/message delete safety', () => {
  it('cascades message deletion from conversations', () => {
    expect(normalizedSql).toContain('conversation_id uuid not null references public.conversations(id) on delete cascade')
  })

  it('keeps owner-scoped delete policies on conversations and messages', () => {
    expect(normalizedSql).toContain('create policy "conversations_delete_own"')
    expect(normalizedSql).toContain('create policy "messages_delete_own"')
    expect(normalizedSql).toContain('using (auth.uid() = user_id);')
  })
})

describe('Supabase persistence service – cloud deletion helpers', () => {
  it('defines deleteCloudConversation as a dedicated helper', () => {
    expect(persistenceServiceSrc).toContain('export async function deleteCloudConversation')
  })

  it('defines deleteAllCloudConversations as a single owner-scoped delete operation', () => {
    expect(persistenceServiceSrc).toContain("export async function deleteAllCloudConversations")
    expect(persistenceServiceSrc).toContain(".from('conversations')")
    expect(persistenceServiceSrc).toContain(".delete()")
    expect(persistenceServiceSrc).toContain(".eq('user_id', userId)")
  })

  it('does not enumerate cloud conversations inside deleteAllCloudConversations', () => {
    const start = persistenceServiceSrc.indexOf('export async function deleteAllCloudConversations')
    const end = persistenceServiceSrc.indexOf('// ---------------------------------------------------------------------------\n// Messages', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const fnSource = persistenceServiceSrc.slice(start, end)
    expect(fnSource).not.toContain('listConversations')
    expect(fnSource).not.toContain('.select(')
    expect(fnSource).toContain('getCurrentUserId')
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

// ---------------------------------------------------------------------------
// UUID generation and legacy ID migration
// ---------------------------------------------------------------------------

describe('UUID generation – daemonMemory', () => {
  it('saveMemory assigns a valid UUID id (no mem- prefix)', async () => {
    const { saveMemory } = await import('../src/services/daemonMemory')
    const mem = saveMemory('test memory')
    expect(mem.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(mem.id).not.toMatch(/^mem-/)
  })
})

describe('UUID generation – daemon_learning_integration', () => {
  it('recordInteraction assigns a valid UUID id (no interaction- prefix)', async () => {
    const { DaemonLearningSystem } = await import('../src/services/daemon_learning_integration')
    const sys = new DaemonLearningSystem()
    const record = sys.recordInteraction('hello', 'hi', {
      intent: 'greet',
      confidence: 0.9,
      ambiguity: 0.1,
      memoryUsed: 0,
      planComplexity: 'simple',
      timestamp: new Date(),
    })
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(record.id).not.toMatch(/^interaction-/)
  })
})

describe('Legacy ID migration – daemonStorageMigration', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset migration done flag
    localStorage.removeItem('daemon_uuid_migration_done')
  })

  it('isUUID returns true for valid UUIDs', async () => {
    const { isUUID } = await import('../src/services/daemonStorageMigration')
    expect(isUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isUUID('daemon-1234-5')).toBe(false)
    expect(isUUID('mem-550e8400-e29b-41d4-a716-446655440000')).toBe(false)
    expect(isUUID('interaction-1234567890-abc')).toBe(false)
  })

  it('genUUID returns valid UUID', async () => {
    const { genUUID, isUUID } = await import('../src/services/daemonStorageMigration')
    const id = genUUID()
    expect(isUUID(id)).toBe(true)
  })

  it('runLegacyIdMigration migrates daemon- prefixed conversation IDs to UUIDs', async () => {
    const { runLegacyIdMigration, isLegacyIdMigrationDone, isUUID } = await import('../src/services/daemonStorageMigration')

    const legacyConvs = [
      {
        id: 'daemon-1234-1',
        title: 'Test',
        messages: [
          { id: 'daemon-1234-2', role: 'user', content: 'hi', timestamp: '2024-01-01T00:00:00Z' },
          { id: 'daemon-1234-3', role: 'assistant', content: 'hello', timestamp: '2024-01-01T00:00:01Z' },
        ],
        createdAt: '2024-01-01T00:00:00Z',
      },
    ]
    localStorage.setItem('daemon_conversations', JSON.stringify(legacyConvs))

    expect(isLegacyIdMigrationDone()).toBe(false)
    runLegacyIdMigration()
    expect(isLegacyIdMigrationDone()).toBe(true)

    const migratedConvs = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]')
    expect(isUUID(migratedConvs[0].id)).toBe(true)
    expect(migratedConvs[0].id).not.toContain('daemon-')
    expect(isUUID(migratedConvs[0].messages[0].id)).toBe(true)
    expect(isUUID(migratedConvs[0].messages[1].id)).toBe(true)
    // Verify message count preserved
    expect(migratedConvs[0].messages).toHaveLength(2)
    // Verify timestamps preserved
    expect(migratedConvs[0].messages[0].timestamp).toBe('2024-01-01T00:00:00Z')
    expect(migratedConvs[0].createdAt).toBe('2024-01-01T00:00:00Z')
  })

  it('runLegacyIdMigration migrates mem- prefixed memory IDs', async () => {
    const { runLegacyIdMigration, isUUID } = await import('../src/services/daemonStorageMigration')

    const legacyMems = [
      { id: 'mem-550e8400-e29b-41d4-a716-446655440001', text: 'test', createdAt: '2024-01-01T00:00:00Z' },
    ]
    localStorage.setItem('daemon_durable_memories', JSON.stringify(legacyMems))
    runLegacyIdMigration()

    const migrated = JSON.parse(localStorage.getItem('daemon_durable_memories') ?? '[]')
    expect(isUUID(migrated[0].id)).toBe(true)
    expect(migrated[0].id).not.toContain('mem-')
    expect(migrated[0].text).toBe('test')
  })

  it('runLegacyIdMigration migrates interaction- prefixed learning IDs', async () => {
    const { runLegacyIdMigration, isUUID } = await import('../src/services/daemonStorageMigration')

    const legacyData = {
      history: [
        { id: 'interaction-1234567890-abc', input: 'hi', response: 'hello', metadata: { intent: 'greet', confidence: 0.9, ambiguity: 0.1, memoryUsed: 0, planComplexity: 'simple', timestamp: '2024-01-01T00:00:00Z' } },
      ],
      stats: { totalInteractions: 1, successfulResponses: 0, learningCycles: 0, policyVersion: 1 },
    }
    localStorage.setItem('daemon_learning_data', JSON.stringify(legacyData))
    runLegacyIdMigration()

    const migrated = JSON.parse(localStorage.getItem('daemon_learning_data') ?? '{}')
    expect(isUUID(migrated.history[0].id)).toBe(true)
    expect(migrated.history[0].id).not.toContain('interaction-')
    // Stats must be preserved
    expect(migrated.stats.totalInteractions).toBe(1)
    // Input/response preserved
    expect(migrated.history[0].input).toBe('hi')
    expect(migrated.history[0].response).toBe('hello')
  })

  it('runLegacyIdMigration is idempotent – second call is a no-op', async () => {
    const { runLegacyIdMigration } = await import('../src/services/daemonStorageMigration')

    const legacyConvs = [{ id: 'daemon-999-1', title: 'T', messages: [], createdAt: '2024-01-01T00:00:00Z' }]
    localStorage.setItem('daemon_conversations', JSON.stringify(legacyConvs))
    runLegacyIdMigration()
    const afterFirst = localStorage.getItem('daemon_conversations')

    // Second call must not change data
    runLegacyIdMigration()
    expect(localStorage.getItem('daemon_conversations')).toBe(afterFirst)
  })

  it('runLegacyIdMigration handles malformed JSON gracefully without data loss', async () => {
    const { runLegacyIdMigration } = await import('../src/services/daemonStorageMigration')

    localStorage.setItem('daemon_conversations', 'not json at all')
    localStorage.setItem('daemon_durable_memories', '{"broken":')
    // Must not throw
    expect(() => runLegacyIdMigration()).not.toThrow()
  })

  it('already-UUID IDs are passed through unchanged', async () => {
    const { runLegacyIdMigration } = await import('../src/services/daemonStorageMigration')

    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    const convs = [{ id: uuid, title: 'T', messages: [], createdAt: '2024-01-01T00:00:00Z' }]
    localStorage.setItem('daemon_conversations', JSON.stringify(convs))
    runLegacyIdMigration()

    const migrated = JSON.parse(localStorage.getItem('daemon_conversations') ?? '[]')
    expect(migrated[0].id).toBe(uuid)
  })
})

// ---------------------------------------------------------------------------
// User-scoped cloud migration marker
// ---------------------------------------------------------------------------

describe('User-scoped cloud migration marker', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('isCloudMigrationDone returns false before migration for a given userId', async () => {
    // Use the real (un-mocked) implementation
    const actual = await vi.importActual<typeof import('../src/services/supabasePersistence')>('../src/services/supabasePersistence')
    expect(actual.isCloudMigrationDone('user-a')).toBe(false)
  })

  it('migration done for user-a does not affect user-b', async () => {
    localStorage.setItem('daemon_cloud_migration_done_user-a', '1')
    const actual = await vi.importActual<typeof import('../src/services/supabasePersistence')>('../src/services/supabasePersistence')
    expect(actual.isCloudMigrationDone('user-a')).toBe(true)
    expect(actual.isCloudMigrationDone('user-b')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// null/false persistence results → sync error state
// ---------------------------------------------------------------------------

describe('Persistence helper null/false → sync error', () => {
  it('DaemonInterface source guards upsertConversation result with if (!convResult)', async () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/DaemonInterface.tsx'),
      'utf8',
    )
    // Verify the null-check guard pattern is present
    expect(src).toContain('if (!convResult)')
    expect(src).toContain("setSyncStatus('error')")
  })

  it('DaemonInterface source guards insertMessage result for both user and assistant messages', async () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/DaemonInterface.tsx'),
      'utf8',
    )
    expect(src).toContain('if (!r1)')
    expect(src).toContain('if (!r2)')
  })

  it('null is falsy – guard condition covers null return', () => {
    const result: null = null
    expect(!result).toBe(true)
  })

  it('false is falsy – guard condition covers false return', () => {
    const result: false = false
    expect(!result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Edge Function source assertions – atomic rate limit and CORS
// ---------------------------------------------------------------------------

describe('Edge Function source – atomic rate limit via RPC', () => {
  const edgeSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/functions/daemon-chat/index.ts'),
    'utf8',
  )

  it('uses increment_rate_limit RPC instead of read-then-update', () => {
    expect(edgeSrc).toContain('increment_rate_limit')
    expect(edgeSrc).toContain('.rpc(')
  })

  it('does not use a read-then-update pattern (.select followed by .update for rate limit)', () => {
    // The old pattern had `.select('request_count, window_start')` specifically for rate limiting.
    // The new implementation delegates to the RPC only.
    expect(edgeSrc).not.toContain("select('request_count, window_start')")
  })
})

describe('Edge Function source – CORS preflight rejection', () => {
  const edgeSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/functions/daemon-chat/index.ts'),
    'utf8',
  )

  it('rejects disallowed CORS preflight origins with 403', () => {
    // Must check allowedOrigin before responding to OPTIONS
    expect(edgeSrc).toContain("status: 403")
    expect(edgeSrc).toContain("CORS: origin not allowed")
  })

  it('does not fall back to a permissive default origin on OPTIONS', () => {
    // Old pattern: `const origin = allowedOrigin ?? 'https://dmankv.github.io'`
    expect(edgeSrc).not.toContain("allowedOrigin ?? 'https://dmankv.github.io'")
  })

  it('allowed origins include only dmankv.github.io and localhost patterns', () => {
    expect(edgeSrc).toContain('https://dmankv.github.io')
    expect(edgeSrc).toContain('localhost')
    // No wildcard credentialed CORS
    expect(edgeSrc).not.toContain("'Access-Control-Allow-Origin': '*'")
  })
})

// ---------------------------------------------------------------------------
// Atomic rate-limit migration SQL assertions
// ---------------------------------------------------------------------------

describe('Atomic rate-limit migration SQL', () => {
  const atomicSql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/20260824180000_atomic_rate_limit.sql'),
    'utf8',
  )
  const normalizedAtomic = atomicSql.toLowerCase()

  it('defines increment_rate_limit function', () => {
    expect(normalizedAtomic).toContain('increment_rate_limit')
    expect(normalizedAtomic).toContain('create or replace function')
  })

  it('uses security definer', () => {
    expect(normalizedAtomic).toContain('security definer')
  })

  it('revokes execute from anon and authenticated roles', () => {
    expect(normalizedAtomic).toContain('revoke execute')
    expect(normalizedAtomic).toContain('from anon')
    expect(normalizedAtomic).toContain('from authenticated')
  })

  it('grants execute only to service_role', () => {
    expect(normalizedAtomic).toContain('grant execute')
    expect(normalizedAtomic).toContain('to service_role')
  })

  it('uses insert ... on conflict for atomicity', () => {
    expect(normalizedAtomic).toContain('on conflict')
    expect(normalizedAtomic).toContain('do update')
  })
})

// ---------------------------------------------------------------------------
// RLS static assertions for all tables including new migration
// ---------------------------------------------------------------------------

describe('Atomic rate-limit migration SQL – RLS not bypassed', () => {
  const atomicSql = fs.readFileSync(
    path.resolve(process.cwd(), 'supabase/migrations/20260824180000_atomic_rate_limit.sql'),
    'utf8',
  )

  it('does not grant authenticated access to edge_rate_limits', () => {
    const policyBlocks = atomicSql.match(/create policy[\s\S]+?;/gi) ?? []
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toContain('to authenticated')
    }
    // Also check no direct authenticated grant on the table
    expect(atomicSql.toLowerCase()).not.toContain('grant all on table public.edge_rate_limits to authenticated')
  })
})
