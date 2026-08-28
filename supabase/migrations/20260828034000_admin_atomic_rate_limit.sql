-- Admin Daemon dedicated atomic rate-limit state and RPC.
-- Keeps admin-daemon limits independent from public daemon-chat counters.

create table if not exists public.admin_edge_rate_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  request_count integer not null default 0,
  window_start timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_edge_rate_limits enable row level security;

create or replace function public.increment_admin_rate_limit(
  p_user_id uuid,
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
  insert into public.admin_edge_rate_limits (user_id, request_count, window_start, updated_at)
  values (p_user_id, 1, v_now, v_now)
  on conflict (user_id) do update
    set
      request_count = case
        when (extract(epoch from (v_now - public.admin_edge_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then 1
        else public.admin_edge_rate_limits.request_count + 1
      end,
      window_start = case
        when (extract(epoch from (v_now - public.admin_edge_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then v_now
        else public.admin_edge_rate_limits.window_start
      end,
      updated_at = v_now
  returning request_count
  into v_count;

  if v_count is null then
    v_count := 1;
  end if;

  return query select
    v_count <= p_max_count as allowed,
    greatest(0, p_max_count - v_count) as remaining,
    v_count as request_count;
end;
$$;

revoke execute on function public.increment_admin_rate_limit(uuid, bigint, integer) from public;
revoke execute on function public.increment_admin_rate_limit(uuid, bigint, integer) from anon;
revoke execute on function public.increment_admin_rate_limit(uuid, bigint, integer) from authenticated;
grant execute on function public.increment_admin_rate_limit(uuid, bigint, integer) to service_role;
