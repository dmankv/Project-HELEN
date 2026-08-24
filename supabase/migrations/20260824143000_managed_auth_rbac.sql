-- Managed-auth RBAC schema for Project-HELEN.
--
-- Apply this migration from a privileged Supabase context (Dashboard SQL Editor
-- as project admin, or supabase CLI with service-role credentials).
-- Do not execute from browser clients.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.set_profile_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.prevent_profile_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if
    old.role is distinct from new.role
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'Only provider-side privileged context can change profile role';
  end if;

  if
    old.id is distinct from new.id
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'Profile id is immutable';
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_profile_updated_at();

drop trigger if exists prevent_profiles_role_change on public.profiles;
create trigger prevent_profiles_role_change
  before update on public.profiles
  for each row
  when (old.role is distinct from new.role or old.id is distinct from new.id)
  execute function public.prevent_profile_role_change();

alter table public.profiles enable row level security;
grant select, update on table public.profiles to authenticated;

-- Users can read only their own profile.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- Users can update only their own profile row. The trigger above blocks role/id
-- changes unless the request runs in provider-side privileged context.
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert/delete policies for authenticated users: profile creation is owned
-- by the auth.users trigger in provider-managed context.

-- Backfill profile rows for existing auth.users accounts.
insert into public.profiles (id, email)
select u.id, coalesce(u.email, '')
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null;
