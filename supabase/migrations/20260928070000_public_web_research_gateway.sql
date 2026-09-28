-- Public-web research gateway persistence (fail-closed, append-only).
--
-- Stores provenance and quarantined unverified external insights gathered by
-- the server-side research gateway. Browser clients can read only their own
-- records; inserts are restricted to service-role backend paths.

create table if not exists public.research_fetch_provenance (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  normalized_url       text not null,
  host                 text not null,
  fetched_at           timestamptz not null default now(),
  http_status          integer not null check (http_status >= 100 and http_status <= 599),
  content_type         text not null,
  content_size_bytes   integer not null check (content_size_bytes >= 0),
  content_hash         text not null,
  policy_decision      text not null,
  sanitized_excerpt    text not null default '',
  created_at           timestamptz not null default now()
);

create index if not exists research_fetch_provenance_user_created_idx
  on public.research_fetch_provenance (user_id, created_at desc);

create index if not exists research_fetch_provenance_host_idx
  on public.research_fetch_provenance (host, created_at desc);

alter table public.research_fetch_provenance enable row level security;

drop policy if exists "research_fetch_provenance_select_own" on public.research_fetch_provenance;
create policy "research_fetch_provenance_select_own"
  on public.research_fetch_provenance for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "research_fetch_provenance_insert_service" on public.research_fetch_provenance;
create policy "research_fetch_provenance_insert_service"
  on public.research_fetch_provenance for insert
  to service_role
  with check (
    exists (
      select 1
      from auth.users
      where id = research_fetch_provenance.user_id
    )
  );

create or replace function public.prevent_research_fetch_provenance_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Research provenance is append-only';
end;
$$;

drop trigger if exists prevent_research_fetch_provenance_update on public.research_fetch_provenance;
create trigger prevent_research_fetch_provenance_update
  before update on public.research_fetch_provenance
  for each row execute function public.prevent_research_fetch_provenance_mutation();

drop trigger if exists prevent_research_fetch_provenance_delete on public.research_fetch_provenance;
create trigger prevent_research_fetch_provenance_delete
  before delete on public.research_fetch_provenance
  for each row execute function public.prevent_research_fetch_provenance_mutation();

create table if not exists public.unverified_external_insights (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  normalized_url       text not null,
  host                 text not null,
  source_timestamp     timestamptz not null,
  source_hash          text not null,
  excerpt              text not null,
  confidence           numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  expires_at           timestamptz not null,
  policy_decision      text not null,
  evaluation_state     text not null check (evaluation_state in ('quarantined', 'rejected', 'validated')),
  promotion_state      text not null check (promotion_state in ('blocked_pending_validation', 'rejected', 'approved_manual_only')),
  created_at           timestamptz not null default now()
);

create index if not exists unverified_external_insights_user_created_idx
  on public.unverified_external_insights (user_id, created_at desc);

create index if not exists unverified_external_insights_expiry_idx
  on public.unverified_external_insights (expires_at asc);

alter table public.unverified_external_insights enable row level security;

drop policy if exists "unverified_external_insights_select_own" on public.unverified_external_insights;
create policy "unverified_external_insights_select_own"
  on public.unverified_external_insights for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "unverified_external_insights_insert_service" on public.unverified_external_insights;
create policy "unverified_external_insights_insert_service"
  on public.unverified_external_insights for insert
  to service_role
  with check (
    exists (
      select 1
      from auth.users
      where id = unverified_external_insights.user_id
    )
    and evaluation_state = 'quarantined'
    and promotion_state = 'blocked_pending_validation'
  );

create or replace function public.prevent_unverified_external_insight_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Unverified external insights are immutable while promotion remains blocked.';
end;
$$;

drop trigger if exists prevent_unverified_external_insight_update on public.unverified_external_insights;
create trigger prevent_unverified_external_insight_update
  before update on public.unverified_external_insights
  for each row execute function public.prevent_unverified_external_insight_mutation();

drop trigger if exists prevent_unverified_external_insight_delete on public.unverified_external_insights;
create trigger prevent_unverified_external_insight_delete
  before delete on public.unverified_external_insights
  for each row execute function public.prevent_unverified_external_insight_mutation();

create table if not exists public.research_audit_events (
  event_id             uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  event_type           text not null check (
    event_type in ('research_policy', 'research_request', 'research_result', 'research_insight')
  ),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

create index if not exists research_audit_events_user_created_idx
  on public.research_audit_events (user_id, created_at desc);

alter table public.research_audit_events enable row level security;

drop policy if exists "research_audit_events_select_own" on public.research_audit_events;
create policy "research_audit_events_select_own"
  on public.research_audit_events for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "research_audit_events_insert_service" on public.research_audit_events;
create policy "research_audit_events_insert_service"
  on public.research_audit_events for insert
  to service_role
  with check (
    exists (
      select 1
      from auth.users
      where id = research_audit_events.user_id
    )
  );

create or replace function public.prevent_research_audit_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Research audit events are append-only';
end;
$$;

drop trigger if exists prevent_research_audit_events_update on public.research_audit_events;
create trigger prevent_research_audit_events_update
  before update on public.research_audit_events
  for each row execute function public.prevent_research_audit_event_mutation();

drop trigger if exists prevent_research_audit_events_delete on public.research_audit_events;
create trigger prevent_research_audit_events_delete
  before delete on public.research_audit_events
  for each row execute function public.prevent_research_audit_event_mutation();
