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

const evolutionInfrastructureMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260926221000_evolution_infrastructure.sql',
)

describe('Evolution infrastructure migration', () => {
  const rawSql = fs.readFileSync(evolutionInfrastructureMigrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  it('keeps promotion and rollback finalization on provider-side privileged paths', () => {
    expect(rawSql).toMatch(/auth\.role\(\)\s*(?:=\s*'service_role'|in\s*\(\s*'service_role'\s*(?:,\s*'supabase_admin'\s*)?\))/i)
    expect(rawSql).toMatch(/session_user\s+in\s+\('postgres',\s*'supabase_admin'\)/i)
    expect(rawSql).toMatch(/Only provider-side privileged context can finalize promotion or rollback evolution runs\./i)
  })

  it('reserves control-plane audit events for service_role and blocks browser clients from forging them', () => {
    expect(normalizedSql).toContain("event_type not in ('canary_decision', 'rollback_triggered', 'rollback_completed', 'run_finished')")
    expect(normalizedSql).toContain("event_type in ('canary_decision', 'rollback_triggered', 'rollback_completed', 'run_finished')")
    expect(normalizedSql).toContain('to service_role')
  })

  it('requires backend rollback and run-finished attestations bound to the run identity', () => {
    expect(normalizedSql).toContain("event.event_type = 'run_finished'")
    expect(normalizedSql).toContain("event.event_type = 'rollback_completed'")
    expect(normalizedSql).toContain("old.status is distinct from new.status")
    expect(normalizedSql).toContain("metadata ->> 'candidateversion' = old.candidate_version")
    expect(normalizedSql).toContain("metadata ->> 'targetdeployedversion' = old.last_known_good")
    expect(normalizedSql).toContain("if promotion_finalization_requested")
    expect(normalizedSql).toContain("if rollback_finalization_requested")
    expect(normalizedSql).toContain(") and privileged_control_plane_actor")
    expect(normalizedSql).toContain("and rollback_attestation_present")
  })
})

const liveEvalWorkflowPath = path.resolve(
  process.cwd(),
  '.github/workflows/live-eval.yml',
)

describe('Live eval workflow', () => {
  const workflow = fs.readFileSync(liveEvalWorkflowPath, 'utf8')

  it('checks out promotion-bound candidate code before restoring trusted unit gate files', () => {
    expect(workflow).toContain('Promotion-bound unit gate requires candidate_version, candidate_snapshot_id, run_id, and candidate_sha together.')
    expect(workflow).toContain('git fetch --no-tags origin "$CANDIDATE_SHA"')
    expect(workflow).toContain('git checkout --detach "$CANDIDATE_SHA"')
    expect(workflow).toContain('Promotion-bound unit gate must run from the protected default branch workflow ref.')
    expect(workflow).toContain('TRUSTED_WORKFLOW_SHA: ${{ github.sha }}')
    expect(workflow).toContain('TRUSTED_WORKFLOW_SHA: ${{ steps.binding.outputs.workflow_sha }}')
    expect(workflow).toContain('git fetch --no-tags origin "$TRUSTED_WORKFLOW_SHA"')
    expect(workflow).toContain('TRUSTED_REF="$TRUSTED_WORKFLOW_SHA"')
    expect(workflow).toContain('Validate promotion-bound candidate scope')
    expect(workflow).toContain("const changedPaths = execGit(['diff', '--name-only', '--no-renames', trustedWorkflowSha, candidateSha])")
    expect(workflow).toContain("const violations = changedPaths.filter((path) => classifyPath(path) !== 'write_sandbox')")
    expect(workflow).toContain('Promotion-bound candidate diff violates immutable sandbox policy:')
    expect(workflow).toContain("if: always() && steps.binding.outcome == 'success' && steps.binding.outputs.ready == 'true'")
  })
})

const allFatherReviewMigrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260928100000_all_father_reviews.sql',
)

describe('ALL-FATHER review migration', () => {
  const rawSql = fs.readFileSync(allFatherReviewMigrationPath, 'utf8')
  const normalizedSql = rawSql.toLowerCase()

  it('creates the append-only audit table with decision and assurance fields', () => {
    expect(normalizedSql).toContain('create table if not exists public.all_father_reviews')
    expect(normalizedSql).toContain("target_branch       text not null check (target_branch = 'main')")
    expect(rawSql).toContain("decision            text not null check (decision in ('APPROVED', 'REJECTED', 'REQUIRES_HUMAN_REVIEW'))")
    expect(normalizedSql).toContain('has_tests           boolean not null')
    expect(normalizedSql).toContain('security_assured    boolean not null')
    expect(normalizedSql).toContain('audit_assured       boolean not null')
    expect(normalizedSql).toContain('rollback_assured    boolean not null')
    expect(normalizedSql).toContain('create index if not exists all_father_reviews_created_at_idx')
  })

  it('limits reads to admins and inserts to service_role with reviewer constraints', () => {
    expect(normalizedSql).toContain('alter table public.all_father_reviews enable row level security;')
    expect(normalizedSql).toContain('create policy "all_father_reviews_select_admin"')
    expect(normalizedSql).toContain("profiles.role = 'admin'")
    expect(normalizedSql).toContain('create policy "all_father_reviews_insert_service"')
    expect(normalizedSql).toContain('to service_role')
    expect(normalizedSql).toContain('all_father_reviews.reviewer_user_id')
  })

  it('blocks mutation of existing review audit rows', () => {
    expect(rawSql).toMatch(/create or replace function public\.prevent_all_father_review_mutation\(\)/i)
    expect(rawSql).toMatch(/ALL-FATHER reviews are append-only/i)
    expect(normalizedSql).toContain('before update on public.all_father_reviews')
    expect(normalizedSql).toContain('before delete on public.all_father_reviews')
  })
})
