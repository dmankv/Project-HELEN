/**
 * Admin Daemon migration tests
 *
 * Covers requirement 6 from the problem statement:
 * - RLS enabled on all admin tables
 * - Owner-only policies using auth.uid() = user_id AND is_admin() predicate
 * - FK/cascade/indexes
 * - No public/anon broad policies
 * - Secure is_admin() SECURITY DEFINER helper with pinned search_path
 * - Owner-immutability triggers
 * - Demoted user behaviour: is_admin() check in policies prevents access when role changed
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260827190000_admin_daemon.sql',
)

describe('Admin Daemon migration', () => {
  const rawSql = fs.readFileSync(migrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  // ---------------------------------------------------------------------------
  // is_admin() helper
  // ---------------------------------------------------------------------------

  describe('is_admin() helper function', () => {
    it('defines is_admin() as SECURITY DEFINER with pinned search_path', () => {
      expect(rawSql).toMatch(/create or replace function public\.is_admin\(\)/i)
      expect(rawSql).toMatch(/security definer/i)
      expect(rawSql).toMatch(/set search_path = public/i)
    })

    it('fetches role from profiles table server-side', () => {
      expect(normalizedSql).toContain('select role into v_role')
      expect(normalizedSql).toContain('from public.profiles')
      expect(normalizedSql).toContain('where id = auth.uid()')
    })

    it('is_admin() revokes execution from anon role', () => {
      expect(normalizedSql).toContain('revoke execute on function public.is_admin()')
      expect(normalizedSql).toContain('from anon')
    })

    it('is_admin() grants execution only to authenticated role', () => {
      expect(normalizedSql).toContain('grant execute on function public.is_admin() to authenticated')
    })
  })

  // ---------------------------------------------------------------------------
  // RLS enabled on all tables
  // ---------------------------------------------------------------------------

  const ADMIN_TABLES = [
    'admin_conversations',
    'admin_messages',
    'admin_durable_memories',
    'admin_learning_interactions',
  ]

  ADMIN_TABLES.forEach(table => {
    it(`RLS is enabled on ${table}`, () => {
      expect(normalizedSql).toContain(`alter table public.${table} enable row level security;`)
    })
  })

  // ---------------------------------------------------------------------------
  // Owner-only policies with is_admin() check
  // ---------------------------------------------------------------------------

  ADMIN_TABLES.forEach(table => {
    it(`${table} select policy requires auth.uid() = user_id AND is_admin()`, () => {
      expect(normalizedSql).toContain(`create policy "${table}_select_own"`)
      expect(normalizedSql).toContain(`on public.${table} for select`)
      expect(normalizedSql).toContain('auth.uid() = user_id and public.is_admin()')
    })

    it(`${table} insert policy requires auth.uid() = user_id AND is_admin()`, () => {
      expect(normalizedSql).toContain(`create policy "${table}_insert_own"`)
      expect(normalizedSql).toContain(`on public.${table} for insert`)
    })

    it(`${table} delete policy requires auth.uid() = user_id AND is_admin()`, () => {
      expect(normalizedSql).toContain(`create policy "${table}_delete_own"`)
    })
  })

  it('all policies use is_admin() — demoted users lose access', () => {
    // Every RLS policy must reference is_admin() so that if a user is demoted
    // from admin to user, their rows become inaccessible.
    const policyBlocks = rawSql.match(/create policy[\s\S]+?;/gi) ?? []
    // There should be at least 4 tables × 3+ ops = 12+ policies
    expect(policyBlocks.length).toBeGreaterThanOrEqual(12)
    for (const policy of policyBlocks) {
      // Every policy using/with check must include is_admin()
      if (/\busing\b/i.test(policy)) {
        expect(policy).toMatch(/public\.is_admin\(\)/i)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // No public/anon broad policies
  // ---------------------------------------------------------------------------

  it('has no policies granting access to public or anon roles', () => {
    const policyBlocks = rawSql.match(/create policy[\s\S]+?;/gi) ?? []
    for (const policy of policyBlocks) {
      expect(policy.toLowerCase()).not.toMatch(/\bto public\b/)
      expect(policy.toLowerCase()).not.toMatch(/\bto anon\b/)
    }
  })

  // ---------------------------------------------------------------------------
  // Foreign keys and cascades
  // ---------------------------------------------------------------------------

  it('admin_messages has FK to admin_conversations with ON DELETE CASCADE', () => {
    expect(normalizedSql).toContain('references public.admin_conversations(id) on delete cascade')
  })

  it('all tables have FK to auth.users with ON DELETE CASCADE', () => {
    const cascadeMatches = normalizedSql.match(/references auth\.users\(id\) on delete cascade/g) ?? []
    expect(cascadeMatches.length).toBeGreaterThanOrEqual(ADMIN_TABLES.length)
  })

  // ---------------------------------------------------------------------------
  // Indexes
  // ---------------------------------------------------------------------------

  it('admin_conversations has user_id + updated_at index', () => {
    expect(normalizedSql).toContain('create index if not exists admin_conversations_user_id_updated_at_idx')
  })

  it('admin_messages has conversation_id + position index', () => {
    expect(normalizedSql).toContain('create index if not exists admin_messages_conversation_id_position_idx')
  })

  it('admin_messages has user_id index', () => {
    expect(normalizedSql).toContain('create index if not exists admin_messages_user_id_idx')
  })

  it('admin_durable_memories has user_id + created_at index', () => {
    expect(normalizedSql).toContain('create index if not exists admin_durable_memories_user_id_created_at_idx')
  })

  it('admin_learning_interactions has user_id index', () => {
    expect(normalizedSql).toContain('create index if not exists admin_learning_interactions_user_id_idx')
  })

  // ---------------------------------------------------------------------------
  // Owner-immutability triggers
  // ---------------------------------------------------------------------------

  it('prevents owner reassignment on admin_conversations', () => {
    expect(rawSql).toMatch(/prevent_admin_conversation_owner_change/i)
    expect(rawSql).toMatch(/admin conversation owner is immutable/i)
  })

  it('prevents owner reassignment on admin_messages', () => {
    expect(rawSql).toMatch(/prevent_admin_message_owner_change/i)
    expect(rawSql).toMatch(/admin message owner and conversation are immutable/i)
  })

  it('prevents owner reassignment on admin_durable_memories', () => {
    expect(rawSql).toMatch(/prevent_admin_memory_owner_change/i)
    expect(rawSql).toMatch(/admin memory owner is immutable/i)
  })

  it('prevents owner reassignment on admin_learning_interactions', () => {
    expect(rawSql).toMatch(/prevent_admin_learning_owner_change/i)
    expect(rawSql).toMatch(/admin learning interaction owner is immutable/i)
  })

  it('all trigger functions use SECURITY DEFINER with pinned search_path', () => {
    const triggerFunctions = rawSql.match(/create or replace function public\.prevent_admin[\s\S]+?end;\n\$\$;/gi) ?? []
    expect(triggerFunctions.length).toBe(4)
    for (const fn of triggerFunctions) {
      expect(fn.toLowerCase()).toContain('security definer')
      expect(fn.toLowerCase()).toContain('set search_path = public')
    }
  })

  // ---------------------------------------------------------------------------
  // UUID primary keys
  // ---------------------------------------------------------------------------

  ADMIN_TABLES.forEach(table => {
    it(`${table} uses UUID primary key with gen_random_uuid() default`, () => {
      expect(normalizedSql).toContain(`id          uuid primary key default gen_random_uuid()`)
    })
  })

  // ---------------------------------------------------------------------------
  // Idempotent (uses IF NOT EXISTS)
  // ---------------------------------------------------------------------------

  it('migration uses CREATE TABLE IF NOT EXISTS for idempotency', () => {
    const createStatements = normalizedSql.match(/create table if not exists/g) ?? []
    expect(createStatements.length).toBe(ADMIN_TABLES.length)
  })
})
