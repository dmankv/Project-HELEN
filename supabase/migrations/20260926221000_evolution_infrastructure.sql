-- Autonomous evolution backend infrastructure tables.
--
-- Tracks evolution runs, required gate results, and append-only audit events
-- for autonomous self-write + canary promotion flows. Access is restricted to
-- authenticated admins through RLS + public.is_admin().

create table if not exists public.evolution_runs (
  run_id               uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  candidate_version    text not null,
  candidate_snapshot_id uuid not null,
  last_known_good      text not null,
  stage                text not null,
  status               text not null,
  policy_version       text not null default '1.0.0',
  started_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  ended_at             timestamptz,
  check (stage in ('observe', 'learn', 'propose', 'write', 'test', 'evaluate', 'canary', 'promote', 'rollback')),
  check (status in ('running', 'succeeded', 'failed', 'denied', 'timed_out', 'rolled_back'))
);

create index if not exists evolution_runs_user_updated_idx
  on public.evolution_runs (user_id, updated_at desc);

alter table public.evolution_runs enable row level security;

drop policy if exists "evolution_runs_select_admin_own" on public.evolution_runs;
create policy "evolution_runs_select_admin_own"
  on public.evolution_runs for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "evolution_runs_insert_admin_own" on public.evolution_runs;
create policy "evolution_runs_insert_admin_own"
  on public.evolution_runs for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "evolution_runs_update_admin_own" on public.evolution_runs;
create policy "evolution_runs_update_admin_own"
  on public.evolution_runs for update
  to authenticated
  using (auth.uid() = user_id and public.is_admin())
  with check (auth.uid() = user_id and public.is_admin());

create table if not exists public.evolution_gate_results (
  id                   uuid primary key default gen_random_uuid(),
  run_id               uuid not null references public.evolution_runs(run_id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  gate                 text not null,
  status               text not null,
  detail               text not null default '',
  duration_ms          integer not null default 0,
  required             boolean not null default true,
  created_at           timestamptz not null default now(),
  check (gate in ('typecheck', 'lint', 'unit', 'integration', 'build', 'security_scan', 'secret_scan', 'resource_budget', 'regression')),
  check (status in ('passed', 'failed', 'unavailable', 'skipped')),
  check (duration_ms >= 0)
);

create index if not exists evolution_gate_results_run_idx
  on public.evolution_gate_results (run_id, created_at asc);

create unique index if not exists evolution_required_gate_unique_idx
  on public.evolution_gate_results (run_id, gate)
  where required = true;

alter table public.evolution_gate_results enable row level security;

drop policy if exists "evolution_gate_results_select_admin_own" on public.evolution_gate_results;
create policy "evolution_gate_results_select_admin_own"
  on public.evolution_gate_results for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "evolution_gate_results_insert_admin_own" on public.evolution_gate_results;
create policy "evolution_gate_results_insert_admin_own"
  on public.evolution_gate_results for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

create table if not exists public.evolution_audit_events (
  event_id             uuid primary key default gen_random_uuid(),
  run_id               uuid not null references public.evolution_runs(run_id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  event_type           text not null,
  message              text not null default '',
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  check (event_type in ('run_started', 'policy_decision', 'stage_transition', 'gate_result', 'budget_check', 'canary_decision', 'rollback_triggered', 'run_finished'))
);

create index if not exists evolution_audit_events_run_idx
  on public.evolution_audit_events (run_id, created_at asc);

alter table public.evolution_audit_events enable row level security;

drop policy if exists "evolution_audit_events_select_admin_own" on public.evolution_audit_events;
create policy "evolution_audit_events_select_admin_own"
  on public.evolution_audit_events for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "evolution_audit_events_insert_admin_own" on public.evolution_audit_events;
create policy "evolution_audit_events_insert_admin_own"
  on public.evolution_audit_events for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

create or replace function public.prevent_evolution_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id then
    raise exception 'Evolution record owner is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_evolution_run_owner_change on public.evolution_runs;
create trigger prevent_evolution_run_owner_change
  before update on public.evolution_runs
  for each row execute function public.prevent_evolution_owner_change();

drop trigger if exists prevent_evolution_gate_owner_change on public.evolution_gate_results;
create trigger prevent_evolution_gate_owner_change
  before update on public.evolution_gate_results
  for each row execute function public.prevent_evolution_owner_change();

drop trigger if exists prevent_evolution_audit_owner_change on public.evolution_audit_events;
create trigger prevent_evolution_audit_owner_change
  before update on public.evolution_audit_events
  for each row execute function public.prevent_evolution_owner_change();
