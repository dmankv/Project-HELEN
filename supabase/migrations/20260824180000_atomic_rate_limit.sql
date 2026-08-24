-- Migration: add atomic rate-limit increment RPC
-- This function runs under SECURITY DEFINER with service_role privileges.
-- It is inaccessible to normal browser clients (anon/authenticated roles).

create or replace function public.increment_rate_limit(
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
  -- Upsert: insert or reset/increment atomically using a single statement.
  insert into public.edge_rate_limits (user_id, request_count, window_start, updated_at)
  values (p_user_id, 1, v_now, v_now)
  on conflict (user_id) do update
    set
      request_count = case
        when (extract(epoch from (v_now - public.edge_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then 1
        else public.edge_rate_limits.request_count + 1
      end,
      window_start = case
        when (extract(epoch from (v_now - public.edge_rate_limits.window_start)) * 1000)::bigint >= p_window_ms
          then v_now
        else public.edge_rate_limits.window_start
      end,
      updated_at = v_now
  returning request_count
  into v_count;

  -- If the returning clause didn't populate (insert path), v_count = 1.
  if v_count is null then
    v_count := 1;
  end if;

  return query select
    v_count <= p_max_count as allowed,
    greatest(0, p_max_count - v_count) as remaining,
    v_count as request_count;
end;
$$;

-- Revoke from all roles first, then grant only to service_role.
-- Browser clients (anon / authenticated) cannot call this function.
revoke execute on function public.increment_rate_limit(uuid, bigint, integer) from public;
revoke execute on function public.increment_rate_limit(uuid, bigint, integer) from anon;
revoke execute on function public.increment_rate_limit(uuid, bigint, integer) from authenticated;
grant execute on function public.increment_rate_limit(uuid, bigint, integer) to service_role;
