import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260824143000_managed_auth_rbac.sql',
)

describe('Supabase RBAC migration', () => {
  const rawSql = fs.readFileSync(migrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  it('enables RLS on profiles and defines own-row policies', () => {
    expect(normalizedSql).toContain('alter table public.profiles enable row level security;')
    expect(normalizedSql).toContain('create policy "profiles_select_own"')
    expect(normalizedSql).toContain('create policy "profiles_update_own"')
    expect(normalizedSql).toContain('using (auth.uid() = id)')
    expect(normalizedSql).toContain('with check (auth.uid() = id)')
  })

  it('prevents client-side admin role escalation', () => {
    expect(rawSql).toMatch(/create or replace function public\.prevent_profile_role_change\(\)/i)
    expect(rawSql).toMatch(/auth\.role\(\)\s+not in\s+\('service_role',\s*'supabase_admin'\)/i)
    expect(rawSql).toMatch(/session_user\s+not in\s+\('postgres',\s*'supabase_admin'\)/i)
    expect(rawSql).toMatch(/raise exception 'Only provider-side privileged context can change profile role'/i)
    expect(rawSql).not.toMatch(/create policy[\s\S]+for update[\s\S]+with check\s*\(\s*true\s*\)/i)
  })
})

// ---------------------------------------------------------------------------
// Daemon persistence migration tests
// ---------------------------------------------------------------------------

const persistenceMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260824160000_daemon_persistence.sql',
)

describe('Daemon persistence migration', () => {
  const rawSql = fs.readFileSync(persistenceMigrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  const TABLES = ['conversations', 'messages', 'durable_memories', 'learning_interactions', 'edge_rate_limits']

  TABLES.forEach(table => {
    it(`enables RLS on ${table}`, () => {
      expect(normalizedSql).toContain(`alter table public.${table} enable row level security;`)
    })
  })

  const USER_TABLES = ['conversations', 'messages', 'durable_memories', 'learning_interactions']

  USER_TABLES.forEach(table => {
    it(`has owner-only select policy on ${table}`, () => {
      // Verify auth.uid() checks exist in the SQL for all user tables
      expect(normalizedSql).toContain('auth.uid() = user_id')
      // Verify select policy exists for this table
      expect(normalizedSql).toContain(`on public.${table} for select`)
    })
  })

  it('has no public (unauthenticated) policies on user tables', () => {
    // Ensure no policies grant access to 'public' (unauthenticated) role
    const policyBlocks = rawSql.match(/create policy[\s\S]+?;/gi) ?? []
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toMatch(/\bto public\b/)
    }
  })

  it('prevents owner reassignment on conversations', () => {
    expect(rawSql).toMatch(/prevent_conversation_owner_change/i)
    expect(rawSql).toMatch(/conversation owner is immutable/i)
  })

  it('prevents owner reassignment on messages', () => {
    expect(rawSql).toMatch(/prevent_message_owner_change/i)
    expect(rawSql).toMatch(/message owner and conversation are immutable/i)
  })

  it('prevents owner reassignment on durable_memories', () => {
    expect(rawSql).toMatch(/prevent_memory_owner_change/i)
    expect(rawSql).toMatch(/memory owner is immutable/i)
  })

  it('prevents owner reassignment on learning_interactions', () => {
    expect(rawSql).toMatch(/prevent_learning_owner_change/i)
    expect(rawSql).toMatch(/learning interaction owner is immutable/i)
  })

  it('edge_rate_limits has no authenticated client policies', () => {
    // edge_rate_limits must only be accessible via service_role
    const rateLimitSection = rawSql.slice(rawSql.indexOf('edge_rate_limits'))
    expect(rateLimitSection).not.toMatch(/create policy[\s\S]+?on public\.edge_rate_limits[\s\S]+?to authenticated/i)
  })
})

const adaptiveMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260825090000_adaptive_profiles.sql',
)

describe('Supabase adaptive profiles migration', () => {
  const rawSql = fs.readFileSync(adaptiveMigrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  it('creates adaptive_profiles with the expected columns', () => {
    expect(normalizedSql).toContain('create table if not exists public.adaptive_profiles')
    expect(normalizedSql).toContain('user_id        uuid        not null unique references auth.users (id) on delete cascade')
    expect(normalizedSql).toContain('preferences    jsonb       not null default')
    expect(normalizedSql).toContain('learning_enabled boolean   not null default true')
    expect(normalizedSql).toContain('updated_at     timestamptz not null default now()')
    expect(normalizedSql).toContain('policy_version integer     not null default 1')
  })

  it('creates adaptive_evidence with the expected columns', () => {
    expect(normalizedSql).toContain('create table if not exists public.adaptive_evidence')
    expect(normalizedSql).toContain('preference_key text        not null')
    expect(normalizedSql).toContain('interaction_id text')
    expect(normalizedSql).toContain('is_positive    boolean     not null')
    expect(normalizedSql).toMatch(/adaptive_evidence[\s\S]+?references auth\.users \(id\) on delete cascade/i)
  })

  it('indexes both tables on user_id', () => {
    expect(normalizedSql).toContain('create index if not exists adaptive_profiles_user_id_idx')
    expect(normalizedSql).toContain('create index if not exists adaptive_evidence_user_id_idx')
    expect(normalizedSql).toContain('create index if not exists adaptive_evidence_user_key_idx')
  })

  it('enables row level security on both tables', () => {
    expect(normalizedSql).toContain('alter table public.adaptive_profiles enable row level security;')
    expect(normalizedSql).toContain('alter table public.adaptive_evidence enable row level security;')
  })

  it('defines owner-only policies for every operation', () => {
    for (const table of ['adaptive_profiles', 'adaptive_evidence']) {
      for (const op of ['select', 'insert', 'update', 'delete']) {
        expect(normalizedSql).toContain(`create policy "${table}_${op}_own"`)
      }
    }
    expect(normalizedSql.match(/using \(auth\.uid\(\) = user_id\)/g)?.length).toBe(6)
    expect(normalizedSql.match(/with check \(auth\.uid\(\) = user_id\)/g)?.length).toBe(4)
  })

  it('has no public (unauthenticated) policies', () => {
    const policyBlocks = rawSql.match(/create policy[\s\S]+?;/gi) ?? []
    expect(policyBlocks.length).toBe(8)
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toMatch(/\bto public\b/)
      expect(policy.toLowerCase()).not.toMatch(/\bto anon\b/)
    }
  })

  it('prevents owner reassignment on adaptive_profiles', () => {
    expect(rawSql).toMatch(/prevent_adaptive_profile_owner_change/i)
    expect(rawSql).toMatch(/adaptive profile owner is immutable/i)
    expect(normalizedSql).toContain('before update on public.adaptive_profiles')
  })

  it('prevents owner reassignment on adaptive_evidence', () => {
    expect(rawSql).toMatch(/prevent_adaptive_evidence_owner_change/i)
    expect(rawSql).toMatch(/adaptive evidence owner is immutable/i)
    expect(normalizedSql).toContain('before update on public.adaptive_evidence')
  })

  it('pins a stable search_path on trigger functions', () => {
    expect(normalizedSql.match(/set search_path = public/g)?.length).toBe(2)
  })
})
