-- Daemon persistence schema for Project-HELEN.
--
-- Adds user-owned tables for conversations, messages, durable memories, and
-- learning/feedback interactions.  Every table uses UUID primary keys, foreign
-- keys to auth.users, deterministic ordering fields, and Row Level Security
-- with explicit owner-only policies.
--
-- Apply from a privileged Supabase context (Dashboard SQL Editor or Supabase
-- CLI with service-role credentials). Do NOT execute from browser clients.

-- ──────────────────────────────────────────────────────────────────────────
-- conversations
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists conversations_user_id_updated_at_idx
  on public.conversations (user_id, updated_at desc);

alter table public.conversations enable row level security;

drop policy if exists "conversations_select_own" on public.conversations;
create policy "conversations_select_own"
  on public.conversations for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "conversations_insert_own" on public.conversations;
create policy "conversations_insert_own"
  on public.conversations for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "conversations_update_own" on public.conversations;
create policy "conversations_update_own"
  on public.conversations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "conversations_delete_own" on public.conversations;
create policy "conversations_delete_own"
  on public.conversations for delete
  to authenticated
  using (auth.uid() = user_id);

-- Prevent user_id reassignment
create or replace function public.prevent_conversation_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'conversation owner is immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prevent_conversation_owner_change on public.conversations;
create trigger prevent_conversation_owner_change
  before update on public.conversations
  for each row execute function public.prevent_conversation_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- messages
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  position        integer not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_position_idx
  on public.messages (conversation_id, position asc);

create index if not exists messages_user_id_idx
  on public.messages (user_id);

alter table public.messages enable row level security;

drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own"
  on public.messages for delete
  to authenticated
  using (auth.uid() = user_id);

-- Prevent user_id or conversation_id reassignment
create or replace function public.prevent_message_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (old.user_id is distinct from new.user_id or old.conversation_id is distinct from new.conversation_id)
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'message owner and conversation are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_message_owner_change on public.messages;
create trigger prevent_message_owner_change
  before update on public.messages
  for each row execute function public.prevent_message_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- durable_memories
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.durable_memories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  text       text not null check (char_length(text) > 0 and char_length(text) <= 2000),
  tags       text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists durable_memories_user_id_created_at_idx
  on public.durable_memories (user_id, created_at asc);

alter table public.durable_memories enable row level security;

drop policy if exists "durable_memories_select_own" on public.durable_memories;
create policy "durable_memories_select_own"
  on public.durable_memories for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "durable_memories_insert_own" on public.durable_memories;
create policy "durable_memories_insert_own"
  on public.durable_memories for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "durable_memories_update_own" on public.durable_memories;
create policy "durable_memories_update_own"
  on public.durable_memories for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "durable_memories_delete_own" on public.durable_memories;
create policy "durable_memories_delete_own"
  on public.durable_memories for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.prevent_memory_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'memory owner is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_memory_owner_change on public.durable_memories;
create trigger prevent_memory_owner_change
  before update on public.durable_memories
  for each row execute function public.prevent_memory_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- learning_interactions
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.learning_interactions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  input             text not null,
  response          text not null,
  intent            text not null default '',
  confidence        real not null default 0 check (confidence >= 0 and confidence <= 1),
  ambiguity         real not null default 0 check (ambiguity >= 0 and ambiguity <= 1),
  memory_used       integer not null default 0,
  plan_complexity   text not null default 'simple' check (plan_complexity in ('simple', 'moderate', 'complex')),
  feedback_rating   text check (feedback_rating in ('helpful', 'neutral', 'unhelpful')),
  feedback_comment  text,
  feedback_at       timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists learning_interactions_user_id_created_at_idx
  on public.learning_interactions (user_id, created_at asc);

alter table public.learning_interactions enable row level security;

drop policy if exists "learning_select_own" on public.learning_interactions;
create policy "learning_select_own"
  on public.learning_interactions for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "learning_insert_own" on public.learning_interactions;
create policy "learning_insert_own"
  on public.learning_interactions for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "learning_update_own" on public.learning_interactions;
create policy "learning_update_own"
  on public.learning_interactions for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "learning_delete_own" on public.learning_interactions;
create policy "learning_delete_own"
  on public.learning_interactions for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.prevent_learning_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.user_id is distinct from new.user_id
    and auth.role() not in ('service_role', 'supabase_admin')
    and session_user not in ('postgres', 'supabase_admin')
  then
    raise exception 'learning interaction owner is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_learning_owner_change on public.learning_interactions;
create trigger prevent_learning_owner_change
  before update on public.learning_interactions
  for each row execute function public.prevent_learning_owner_change();

-- ──────────────────────────────────────────────────────────────────────────
-- edge_function_rate_limits
-- Server-side rate limit tracking for the daemon-chat edge function.
-- ──────────────────────────────────────────────────────────────────────────

create table if not exists public.edge_rate_limits (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  request_count integer not null default 0,
  window_start  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- This table is managed only by service_role (edge function). No client policies.
alter table public.edge_rate_limits enable row level security;
-- No policies for authenticated users: edge function runs as service_role.

grant all on table public.edge_rate_limits to service_role;
grant select, insert, update on table public.conversations to authenticated;
grant select, insert, delete on table public.messages to authenticated;
grant select, insert, update, delete on table public.durable_memories to authenticated;
grant select, insert, update, delete on table public.learning_interactions to authenticated;
