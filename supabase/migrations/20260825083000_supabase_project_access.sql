-- Server-side Supabase project access.
--
-- OAuth credentials, authorization states, rate limits, and audit events are
-- intentionally inaccessible to browser roles. Edge Functions use service_role
-- after verifying the caller's Supabase JWT and enforcing user ownership.

-- ──────────────────────────────────────────────────────────────────────────
-- Encrypted OAuth connections
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.supabase_mcp_connections (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  project_ref                 text not null check (project_ref ~ '^[a-z0-9]{1,64}$'),
  access_mode                 text not null check (access_mode in ('read_logs', 'write_secrets')),
  oauth_client_id             text not null check (char_length(oauth_client_id) between 1 and 512),
  oauth_token_endpoint        text not null check (oauth_token_endpoint ~ '^https://'),
  oauth_revocation_endpoint   text check (oauth_revocation_endpoint is null or oauth_revocation_endpoint ~ '^https://'),
  refresh_token_ciphertext    text not null check (char_length(refresh_token_ciphertext) > 24),
  connected_at                timestamptz not null default now(),
  last_used_at                timestamptz,
  updated_at                  timestamptz not null default now()
);

create unique index if not exists supabase_mcp_connections_user_project_mode_idx
  on public.supabase_mcp_connections (user_id, project_ref, access_mode);

create index if not exists supabase_mcp_connections_user_id_idx
  on public.supabase_mcp_connections (user_id, connected_at desc);

create or replace function public.prevent_supabase_mcp_connection_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id then
    raise exception 'supabase MCP connection owner is immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prevent_supabase_mcp_connection_owner_change on public.supabase_mcp_connections;
create trigger prevent_supabase_mcp_connection_owner_change
  before update on public.supabase_mcp_connections
  for each row execute function public.prevent_supabase_mcp_connection_owner_change();

alter table public.supabase_mcp_connections enable row level security;

-- No authenticated policies: refresh-token ciphertext is service-role-only.
revoke all on table public.supabase_mcp_connections from public;
revoke all on table public.supabase_mcp_connections from anon;
revoke all on table public.supabase_mcp_connections from authenticated;
grant all on table public.supabase_mcp_connections to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Short-lived OAuth authorization state
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.supabase_mcp_oauth_states (
  state_hash                 text primary key check (char_length(state_hash) = 64),
  user_id                    uuid not null references auth.users(id) on delete cascade,
  project_ref                text not null check (project_ref ~ '^[a-z0-9]{1,64}$'),
  access_mode                text not null check (access_mode in ('read_logs', 'write_secrets')),
  oauth_client_id            text not null check (char_length(oauth_client_id) between 1 and 512),
  oauth_authorization_endpoint text not null check (oauth_authorization_endpoint ~ '^https://'),
  oauth_token_endpoint       text not null check (oauth_token_endpoint ~ '^https://'),
  oauth_revocation_endpoint  text check (oauth_revocation_endpoint is null or oauth_revocation_endpoint ~ '^https://'),
  code_verifier_ciphertext   text not null check (char_length(code_verifier_ciphertext) > 24),
  redirect_uri               text not null check (redirect_uri ~ '^https://'),
  expires_at                 timestamptz not null,
  created_at                 timestamptz not null default now()
);

create index if not exists supabase_mcp_oauth_states_expires_at_idx
  on public.supabase_mcp_oauth_states (expires_at);

alter table public.supabase_mcp_oauth_states enable row level security;

-- No browser policy: state and PKCE verifier are callback-only server data.
revoke all on table public.supabase_mcp_oauth_states from public;
revoke all on table public.supabase_mcp_oauth_states from anon;
revoke all on table public.supabase_mcp_oauth_states from authenticated;
grant all on table public.supabase_mcp_oauth_states to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Server-side, per-user rate limiting for on-demand project access
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.supabase_mcp_rate_limits (
  user_id       uuid not null references auth.users(id) on delete cascade,
  scope         text not null check (scope in ('logs', 'secret-write')),
  request_count integer not null default 0,
  window_start  timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (user_id, scope)
);

alter table public.supabase_mcp_rate_limits enable row level security;

revoke all on table public.supabase_mcp_rate_limits from public;
revoke all on table public.supabase_mcp_rate_limits from anon;
revoke all on table public.supabase_mcp_rate_limits from authenticated;
grant all on table public.supabase_mcp_rate_limits to service_role;

create or replace function public.increment_supabase_mcp_rate_limit(
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
  if p_scope not in ('logs', 'secret-write') then
    raise exception 'invalid Supabase MCP rate-limit scope';
  end if;

  insert into public.supabase_mcp_rate_limits (
    user_id, scope, request_count, window_start, updated_at
  )
  values (p_user_id, p_scope, 1, v_now, v_now)
  on conflict (user_id, scope) do update
    set
      request_count = case
        when (extract(epoch from (v_now - public.supabase_mcp_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then 1
        else public.supabase_mcp_rate_limits.request_count + 1
      end,
      window_start = case
        when (extract(epoch from (v_now - public.supabase_mcp_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then v_now
        else public.supabase_mcp_rate_limits.window_start
      end,
      updated_at = v_now
  returning request_count into v_count;

  if v_count is null then
    v_count := 1;
  end if;

  return query select
    v_count <= p_max_count as allowed,
    greatest(0, p_max_count - v_count) as remaining,
    v_count as request_count;
end;
$$;

revoke execute on function public.increment_supabase_mcp_rate_limit(uuid, text, bigint, integer) from public;
revoke execute on function public.increment_supabase_mcp_rate_limit(uuid, text, bigint, integer) from anon;
revoke execute on function public.increment_supabase_mcp_rate_limit(uuid, text, bigint, integer) from authenticated;
grant execute on function public.increment_supabase_mcp_rate_limit(uuid, text, bigint, integer) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Append-only audit events. No tokens, secret values, or raw log content are
-- stored here.
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.supabase_mcp_access_audit (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  connection_id uuid,
  project_ref   text not null check (project_ref ~ '^[a-z0-9]{1,64}$'),
  action        text not null check (action in (
    'read_consent_requested',
    'write_consent_requested',
    'oauth_connected',
    'oauth_denied',
    'logs_read',
    'secret_health_checked',
    'connection_revoked',
    'secret_write_requested',
    'secret_write_succeeded',
    'secret_write_failed'
  )),
  log_service   text,
  log_count     integer check (log_count is null or log_count >= 0),
  window_start  timestamptz,
  window_end    timestamptz,
  secret_name   text,
  created_at    timestamptz not null default now()
);

create index if not exists supabase_mcp_access_audit_user_id_created_at_idx
  on public.supabase_mcp_access_audit (user_id, created_at desc);

create or replace function public.prevent_supabase_mcp_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'supabase MCP audit records are append-only';
end;
$$;

drop trigger if exists prevent_supabase_mcp_audit_mutation on public.supabase_mcp_access_audit;
create trigger prevent_supabase_mcp_audit_mutation
  before update or delete on public.supabase_mcp_access_audit
  for each row execute function public.prevent_supabase_mcp_audit_mutation();

alter table public.supabase_mcp_access_audit enable row level security;

revoke all on table public.supabase_mcp_access_audit from public;
revoke all on table public.supabase_mcp_access_audit from anon;
revoke all on table public.supabase_mcp_access_audit from authenticated;
grant insert, select on table public.supabase_mcp_access_audit to service_role;
