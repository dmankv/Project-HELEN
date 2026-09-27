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
  deployed_version     text not null,
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

create or replace function public.prevent_evolution_run_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Evolution runs are append-only';
end;
$$;

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
  with check (
    auth.uid() = user_id
    and public.is_admin()
    and exists (
      select 1
      from public.evolution_runs
      where run_id = evolution_gate_results.run_id
        and user_id = auth.uid()
    )
  );

create or replace function public.prevent_evolution_gate_result_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Evolution gate results are append-only';
end;
$$;

create table if not exists public.evolution_audit_events (
  event_id             uuid primary key default gen_random_uuid(),
  run_id               uuid references public.evolution_runs(run_id) on delete cascade,
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
  with check (
    auth.uid() = user_id
    and public.is_admin()
    and (
      evolution_audit_events.run_id is null
      or exists (
        select 1
        from public.evolution_runs
        where run_id = evolution_audit_events.run_id
          and user_id = auth.uid()
      )
    )
  );

create or replace function public.prevent_evolution_run_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.run_id is distinct from new.run_id
    or old.user_id is distinct from new.user_id
    or old.candidate_version is distinct from new.candidate_version
    or old.candidate_snapshot_id is distinct from new.candidate_snapshot_id
    or old.last_known_good is distinct from new.last_known_good
    or old.policy_version is distinct from new.policy_version
    or old.started_at is distinct from new.started_at then
    raise exception 'Evolution run identity is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_evolution_run_initial_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stage is distinct from 'observe'
    or new.status is distinct from 'running'
    or new.deployed_version is distinct from new.last_known_good
    or new.ended_at is not null then
    raise exception 'Evolution runs must start in observe/running with deployed_version = last_known_good and no ended_at.';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_evolution_run_lifecycle_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  lifecycle_unchanged boolean;
  row_unchanged boolean;
  terminal_transition boolean;
  expected_next_stage text;
  sequential_transition_allowed boolean;
  stop_transition_allowed boolean;
  promotion_transition_allowed boolean;
  rollback_transition_allowed boolean;
begin
  row_unchanged := (
    row(
      old.run_id,
      old.user_id,
      old.candidate_version,
      old.candidate_snapshot_id,
      old.last_known_good,
      old.deployed_version,
      old.stage,
      old.status,
      old.policy_version,
      old.started_at
    ) is not distinct from row(
      new.run_id,
      new.user_id,
      new.candidate_version,
      new.candidate_snapshot_id,
      new.last_known_good,
      new.deployed_version,
      new.stage,
      new.status,
      new.policy_version,
      new.started_at
    )
  );
  lifecycle_unchanged := (
    old.stage = new.stage
    and old.status = new.status
    and old.deployed_version = new.deployed_version
  );
  terminal_transition := old.status in ('succeeded', 'failed', 'denied', 'timed_out', 'rolled_back');
  if row_unchanged then
    new.updated_at := old.updated_at;
    new.ended_at := old.ended_at;
    return new;
  end if;
  if terminal_transition and not row_unchanged then
    raise exception 'Evolution run lifecycle state is immutable after terminal status.';
  end if;
  new.updated_at := case
    when lifecycle_unchanged then old.updated_at
    else now()
  end;
  new.ended_at := case
    when new.status = 'running' then null
    else coalesce(old.ended_at, now())
  end;
  expected_next_stage := case old.stage
    when 'observe' then 'learn'
    when 'learn' then 'propose'
    when 'propose' then 'write'
    when 'write' then 'test'
    when 'test' then 'evaluate'
    when 'evaluate' then 'canary'
    when 'canary' then 'promote'
    else null
  end;

  sequential_transition_allowed := (
    old.status = 'running'
    and new.status = 'running'
    and expected_next_stage is not null
    and new.stage = expected_next_stage
    and new.deployed_version = old.deployed_version
  );
  stop_transition_allowed := (
    old.status = 'running'
    and new.stage = old.stage
    and new.status in ('failed', 'denied', 'timed_out')
    and new.deployed_version = old.last_known_good
  );
  promotion_transition_allowed := (
    old.status = 'running'
    and old.stage = 'promote'
    and old.deployed_version = old.last_known_good
    and new.deployed_version = old.candidate_version
    and new.stage = 'promote'
    and new.status = 'succeeded'
  );
  rollback_transition_allowed := (
    (
      old.status = 'running'
      and old.stage in ('canary', 'promote')
      and new.deployed_version = old.last_known_good
    )
    or (
      old.deployed_version = old.candidate_version
      and old.stage = 'promote'
      and old.status = 'succeeded'
      and new.deployed_version = old.last_known_good
    )
  ) and new.stage = 'rollback'
    and new.status = 'rolled_back';

  if (new.stage = 'rollback' or new.status = 'rolled_back')
    and not rollback_transition_allowed then
    raise exception 'Evolution rollback is allowed only from canary/promote stages or a succeeded promotion.';
  end if;

  if not sequential_transition_allowed
    and not stop_transition_allowed
    and not promotion_transition_allowed
    and not rollback_transition_allowed then
    raise exception 'Invalid evolution lifecycle transition.';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_evolution_run_owner_change on public.evolution_runs;
drop trigger if exists enforce_evolution_run_initial_state on public.evolution_runs;
create trigger enforce_evolution_run_initial_state
  before insert on public.evolution_runs
  for each row execute function public.enforce_evolution_run_initial_state();

drop trigger if exists prevent_evolution_run_identity_change on public.evolution_runs;
create trigger prevent_evolution_run_identity_change
  before update on public.evolution_runs
  for each row execute function public.prevent_evolution_run_identity_change();

drop trigger if exists enforce_evolution_run_lifecycle_update on public.evolution_runs;
create trigger enforce_evolution_run_lifecycle_update
  before update on public.evolution_runs
  for each row execute function public.enforce_evolution_run_lifecycle_update();

drop trigger if exists prevent_evolution_run_delete on public.evolution_runs;
drop trigger if exists prevent_evolution_gate_result_update on public.evolution_gate_results;
create trigger prevent_evolution_gate_result_update
  before update on public.evolution_gate_results
  for each row execute function public.prevent_evolution_gate_result_mutation();

drop trigger if exists prevent_evolution_gate_result_delete on public.evolution_gate_results;
drop trigger if exists prevent_evolution_audit_owner_change on public.evolution_audit_events;

create or replace function public.prevent_evolution_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Evolution audit events are append-only';
end;
$$;

drop trigger if exists prevent_evolution_audit_update on public.evolution_audit_events;
create trigger prevent_evolution_audit_update
  before update on public.evolution_audit_events
  for each row execute function public.prevent_evolution_audit_mutation();

drop trigger if exists prevent_evolution_audit_delete on public.evolution_audit_events;
drop function if exists public.prevent_evolution_run_mutation();

create or replace function public.redact_evolution_audit_metadata(value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  key text;
  item jsonb;
  result jsonb;
begin
  case jsonb_typeof(value)
    when 'object' then
      result := '{}'::jsonb;
      for key, item in select * from jsonb_each(value) loop
        if key ~* '(password|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization)' then
          result := result || jsonb_build_object(key, '[REDACTED]');
        else
          result := result || jsonb_build_object(key, public.redact_evolution_audit_metadata(item));
        end if;
      end loop;
      return result;
    when 'array' then
      return coalesce((
        select jsonb_agg(public.redact_evolution_audit_metadata(element))
        from jsonb_array_elements(value) as element
      ), '[]'::jsonb);
    when 'string' then
      if trim(both '"' from value::text) ~* '(sk-[a-z0-9_-]{8,}|ghp_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|eyj[a-z0-9_-]{5,}\.[a-z0-9_-]{5,}\.[a-z0-9_-]{5,})' then
        return '"[REDACTED]"'::jsonb;
      end if;
  end case;
  return value;
end;
$$;

create or replace function public.redact_evolution_audit_metadata_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.metadata := public.redact_evolution_audit_metadata(new.metadata);
  return new;
end;
$$;

drop trigger if exists redact_evolution_audit_metadata_before_insert on public.evolution_audit_events;
create trigger redact_evolution_audit_metadata_before_insert
  before insert on public.evolution_audit_events
  for each row execute function public.redact_evolution_audit_metadata_before_insert();
