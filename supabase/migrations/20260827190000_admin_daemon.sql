-- Admin Daemon persistence schema for Project-HELEN.
--
-- Adds dedicated tables for Admin Daemon conversations, messages, durable
-- memories, and learning interactions. Completely isolated from the public
-- Daemon tables to prevent accidental cross-scope access.
--
-- Apply from a privileged Supabase context (Dashboard SQL Editor or Supabase
-- CLI with service-role credentials). Do NOT execute from browser clients.
--
-- Rollback instructions are in ADMIN_DAEMON.md.

-- ──────────────────────────────────────────────────────────────────────────
-- is_admin() — SECURITY DEFINER helper with pinned search_path
-- Returns true when the calling authenticated user has role = 'admin' in
-- public.profiles. Never trusts client-supplied claims.
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role
  from public.profiles
  where id = auth.uid();
  return coalesce(v_role = 'admin', false);
end;
$$;

-- Only authenticated sessions may call is_admin().
revoke execute on function public.is_admin() from public;
revoke execute on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- admin_conversations
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.admin_conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'New admin chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists admin_conversations_user_id_updated_at_idx
  on public.admin_conversations (user_id, updated_at desc);

alter table public.admin_conversations enable row level security;

drop policy if exists "admin_conversations_select_own" on public.admin_conversations;
create policy "admin_conversations_select_own"
  on public.admin_conversations for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_conversations_insert_own" on public.admin_conversations;
create policy "admin_conversations_insert_own"
  on public.admin_conversations for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_conversations_update_own" on public.admin_conversations;
create policy "admin_conversations_update_own"
  on public.admin_conversations for update
  to authenticated
  using (auth.uid() = user_id and public.is_admin())
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_conversations_delete_own" on public.admin_conversations;
create policy "admin_conversations_delete_own"
  on public.admin_conversations for delete
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

create or replace function public.prevent_admin_conversation_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id then
    raise exception 'Admin conversation owner is immutable';
  end if;
  if old.id is distinct from new.id then
    raise exception 'Admin conversation id is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_admin_conversation_owner_change on public.admin_conversations;
create trigger prevent_admin_conversation_owner_change
  before update on public.admin_conversations
  for each row execute function public.prevent_admin_conversation_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- admin_messages
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.admin_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.admin_conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists admin_messages_conversation_id_position_idx
  on public.admin_messages (conversation_id, position asc);

create index if not exists admin_messages_user_id_idx
  on public.admin_messages (user_id);

alter table public.admin_messages enable row level security;

drop policy if exists "admin_messages_select_own" on public.admin_messages;
create policy "admin_messages_select_own"
  on public.admin_messages for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_messages_insert_own" on public.admin_messages;
create policy "admin_messages_insert_own"
  on public.admin_messages for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and public.is_admin()
    and exists (
      select 1
      from public.admin_conversations
      where admin_conversations.id = conversation_id
        and admin_conversations.user_id = auth.uid()
    )
  );

drop policy if exists "admin_messages_delete_own" on public.admin_messages;
create policy "admin_messages_delete_own"
  on public.admin_messages for delete
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

create or replace function public.prevent_admin_message_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id or old.conversation_id is distinct from new.conversation_id then
    raise exception 'Admin message owner and conversation are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_admin_message_owner_change on public.admin_messages;
create trigger prevent_admin_message_owner_change
  before update on public.admin_messages
  for each row execute function public.prevent_admin_message_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- admin_durable_memories
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.admin_durable_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  text       text not null,
  tags       text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists admin_durable_memories_user_id_created_at_idx
  on public.admin_durable_memories (user_id, created_at desc);

alter table public.admin_durable_memories enable row level security;

drop policy if exists "admin_durable_memories_select_own" on public.admin_durable_memories;
create policy "admin_durable_memories_select_own"
  on public.admin_durable_memories for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_durable_memories_insert_own" on public.admin_durable_memories;
create policy "admin_durable_memories_insert_own"
  on public.admin_durable_memories for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_durable_memories_delete_own" on public.admin_durable_memories;
create policy "admin_durable_memories_delete_own"
  on public.admin_durable_memories for delete
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

create or replace function public.prevent_admin_memory_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id then
    raise exception 'Admin memory owner is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_admin_memory_owner_change on public.admin_durable_memories;
create trigger prevent_admin_memory_owner_change
  before update on public.admin_durable_memories
  for each row execute function public.prevent_admin_memory_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- admin_learning_interactions
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.admin_learning_interactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  input            text not null,
  response         text not null,
  intent           text not null default '',
  confidence       real not null default 0,
  feedback_rating  text check (feedback_rating in ('helpful', 'neutral', 'unhelpful')),
  feedback_comment text,
  feedback_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists admin_learning_interactions_user_id_idx
  on public.admin_learning_interactions (user_id, created_at desc);

alter table public.admin_learning_interactions enable row level security;

drop policy if exists "admin_learning_interactions_select_own" on public.admin_learning_interactions;
create policy "admin_learning_interactions_select_own"
  on public.admin_learning_interactions for select
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_learning_interactions_insert_own" on public.admin_learning_interactions;
create policy "admin_learning_interactions_insert_own"
  on public.admin_learning_interactions for insert
  to authenticated
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_learning_interactions_update_own" on public.admin_learning_interactions;
create policy "admin_learning_interactions_update_own"
  on public.admin_learning_interactions for update
  to authenticated
  using (auth.uid() = user_id and public.is_admin())
  with check (auth.uid() = user_id and public.is_admin());

drop policy if exists "admin_learning_interactions_delete_own" on public.admin_learning_interactions;
create policy "admin_learning_interactions_delete_own"
  on public.admin_learning_interactions for delete
  to authenticated
  using (auth.uid() = user_id and public.is_admin());

create or replace function public.prevent_admin_learning_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id then
    raise exception 'Admin learning interaction owner is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_admin_learning_owner_change on public.admin_learning_interactions;
create trigger prevent_admin_learning_owner_change
  before update on public.admin_learning_interactions
  for each row execute function public.prevent_admin_learning_owner_change();
