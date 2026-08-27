-- Private GitHub App connection state for the explicitly confirmed,
-- issue-creation-only write channel. Browser roles have no direct access to
-- any of these records; Edge Functions use service_role after verifying the
-- caller's Supabase JWT and ownership.

-- ──────────────────────────────────────────────────────────────────────────
-- One-time OAuth state and short-lived, server-verified repository choices
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.github_write_oauth_states (
  state_hash               text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  code_verifier_ciphertext text not null check (char_length(code_verifier_ciphertext) > 24),
  expires_at               timestamptz not null,
  created_at               timestamptz not null default now()
);

create index if not exists github_write_oauth_states_expires_at_idx
  on public.github_write_oauth_states (expires_at);

create table if not exists public.github_write_eligible_repositories (
  user_id              uuid not null references auth.users(id) on delete cascade,
  github_user_id       bigint not null check (github_user_id > 0),
  installation_id      bigint not null check (installation_id > 0),
  repository_id        bigint not null check (repository_id > 0),
  repository_full_name text not null check (
    repository_full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
  ),
  expires_at           timestamptz not null,
  created_at           timestamptz not null default now(),
  primary key (user_id, repository_id)
);

create index if not exists github_write_eligible_repositories_expires_at_idx
  on public.github_write_eligible_repositories (expires_at);

-- ──────────────────────────────────────────────────────────────────────────
-- User-owned, repository-scoped connections
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.github_write_connections (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  github_user_id       bigint not null check (github_user_id > 0),
  installation_id      bigint not null check (installation_id > 0),
  repository_id        bigint not null check (repository_id > 0),
  repository_full_name text not null check (
    repository_full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
  ),
  allowed_actions      text[] not null default array['create_issue']::text[] check (
    allowed_actions = array['create_issue']::text[]
  ),
  authorization_expires_at timestamptz not null,
  connected_at         timestamptz not null default now(),
  last_used_at         timestamptz,
  updated_at           timestamptz not null default now(),
  unique (user_id, repository_id)
);

create index if not exists github_write_connections_user_id_idx
  on public.github_write_connections (user_id, connected_at desc);

create index if not exists github_write_connections_authorization_expires_at_idx
  on public.github_write_connections (authorization_expires_at);

create or replace function public.prevent_github_write_connection_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id
    or old.github_user_id is distinct from new.github_user_id
    or old.installation_id is distinct from new.installation_id
    or old.repository_id is distinct from new.repository_id
    or old.allowed_actions is distinct from new.allowed_actions then
    raise exception 'GitHub write connection identity is immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prevent_github_write_connection_identity_change on public.github_write_connections;
create trigger prevent_github_write_connection_identity_change
  before update on public.github_write_connections
  for each row execute function public.prevent_github_write_connection_identity_change();

-- ──────────────────────────────────────────────────────────────────────────
-- Per-user action limits and idempotency records
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.github_write_rate_limits (
  user_id       uuid not null references auth.users(id) on delete cascade,
  scope         text not null check (scope in ('connect', 'connection-mutate', 'issue-create')),
  request_count integer not null default 0,
  window_start  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, scope)
);

create or replace function public.increment_github_write_rate_limit(
  p_user_id uuid,
  p_scope text,
  p_window_ms bigint,
  p_max_count integer
)
returns table(allowed boolean, remaining integer, request_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_count integer;
begin
  if p_scope not in ('connect', 'connection-mutate', 'issue-create') then
    raise exception 'invalid GitHub write rate-limit scope';
  end if;

  insert into public.github_write_rate_limits (
    user_id, scope, request_count, window_start, updated_at
  )
  values (p_user_id, p_scope, 1, v_now, v_now)
  on conflict (user_id, scope) do update
    set
      request_count = case
        when (extract(epoch from (v_now - public.github_write_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then 1
        else public.github_write_rate_limits.request_count + 1
      end,
      window_start = case
        when (extract(epoch from (v_now - public.github_write_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then v_now
        else public.github_write_rate_limits.window_start
      end,
      updated_at = v_now
  returning public.github_write_rate_limits.request_count into v_count;

  if v_count is null then
    v_count := 1;
  end if;

  return query select
    v_count <= p_max_count as allowed,
    greatest(0, p_max_count - v_count) as remaining,
    v_count as request_count;
end;
$$;

create table if not exists public.github_write_idempotency (
  user_id         uuid not null references auth.users(id) on delete cascade,
  connection_id   uuid not null references public.github_write_connections(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash    text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status          text not null check (status in ('pending', 'succeeded', 'unknown')),
  issue_number    integer check (issue_number is null or issue_number > 0),
  issue_url       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (user_id, connection_id, idempotency_key)
);

create index if not exists github_write_idempotency_created_at_idx
  on public.github_write_idempotency (created_at);

create or replace function public.touch_github_write_idempotency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_github_write_idempotency on public.github_write_idempotency;
create trigger touch_github_write_idempotency
  before update on public.github_write_idempotency
  for each row execute function public.touch_github_write_idempotency();

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only, value-free audit events
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.github_write_audit (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  connection_id        uuid,
  github_user_id       bigint check (github_user_id is null or github_user_id > 0),
  installation_id      bigint check (installation_id is null or installation_id > 0),
  repository_id        bigint check (repository_id is null or repository_id > 0),
  repository_full_name text check (
    repository_full_name is null or
    repository_full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$'
  ),
  action               text not null check (action in (
    'oauth_requested',
    'oauth_denied',
    'oauth_authorized',
    'repository_connected',
    'connection_revoked',
    'issue_create_requested',
    'issue_create_succeeded',
    'issue_create_failed'
  )),
  idempotency_key      uuid,
  issue_number         integer check (issue_number is null or issue_number > 0),
  issue_url            text,
  created_at           timestamptz not null default now()
);

create index if not exists github_write_audit_user_id_created_at_idx
  on public.github_write_audit (user_id, created_at desc);

create or replace function public.prevent_github_write_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'GitHub write audit records are append-only';
end;
$$;

drop trigger if exists prevent_github_write_audit_mutation on public.github_write_audit;
create trigger prevent_github_write_audit_mutation
  before update or delete on public.github_write_audit
  for each row execute function public.prevent_github_write_audit_mutation();

-- ──────────────────────────────────────────────────────────────────────────
-- Browser roles cannot access authorization state, repository grants, write
-- connections, idempotency records, limits, or audit metadata directly.
-- ──────────────────────────────────────────────────────────────────────────

alter table public.github_write_oauth_states enable row level security;
alter table public.github_write_eligible_repositories enable row level security;
alter table public.github_write_connections enable row level security;
alter table public.github_write_rate_limits enable row level security;
alter table public.github_write_idempotency enable row level security;
alter table public.github_write_audit enable row level security;

revoke all on table public.github_write_oauth_states from public;
revoke all on table public.github_write_oauth_states from anon;
revoke all on table public.github_write_oauth_states from authenticated;
grant all on table public.github_write_oauth_states to service_role;

revoke all on table public.github_write_eligible_repositories from public;
revoke all on table public.github_write_eligible_repositories from anon;
revoke all on table public.github_write_eligible_repositories from authenticated;
grant all on table public.github_write_eligible_repositories to service_role;

revoke all on table public.github_write_connections from public;
revoke all on table public.github_write_connections from anon;
revoke all on table public.github_write_connections from authenticated;
grant all on table public.github_write_connections to service_role;

revoke all on table public.github_write_rate_limits from public;
revoke all on table public.github_write_rate_limits from anon;
revoke all on table public.github_write_rate_limits from authenticated;
grant all on table public.github_write_rate_limits to service_role;

revoke all on table public.github_write_idempotency from public;
revoke all on table public.github_write_idempotency from anon;
revoke all on table public.github_write_idempotency from authenticated;
grant all on table public.github_write_idempotency to service_role;

revoke all on table public.github_write_audit from public;
revoke all on table public.github_write_audit from anon;
revoke all on table public.github_write_audit from authenticated;
grant insert, select on table public.github_write_audit to service_role;

revoke execute on function public.increment_github_write_rate_limit(uuid, text, bigint, integer) from public;
revoke execute on function public.increment_github_write_rate_limit(uuid, text, bigint, integer) from anon;
revoke execute on function public.increment_github_write_rate_limit(uuid, text, bigint, integer) from authenticated;
grant execute on function public.increment_github_write_rate_limit(uuid, text, bigint, integer) to service_role;
