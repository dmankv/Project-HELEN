create table if not exists public.all_father_reviews (
  review_id           uuid primary key default gen_random_uuid(),
  reviewer_user_id    uuid not null references auth.users(id) on delete restrict,
  target_branch       text not null check (target_branch = 'main'),
  decision            text not null check (decision in ('APPROVED', 'REJECTED', 'REQUIRES_HUMAN_REVIEW')),
  changed_files       jsonb not null default '[]'::jsonb,
  proposal_diff       text not null default '',
  findings            jsonb not null default '[]'::jsonb,
  has_tests           boolean not null,
  security_assured    boolean not null,
  audit_assured       boolean not null,
  rollback_assured    boolean not null,
  created_at          timestamptz not null default now(),
  check (jsonb_typeof(changed_files) = 'array'),
  check (jsonb_typeof(findings) = 'array'),
  check (char_length(proposal_diff) <= 1000000)
);

create index if not exists all_father_reviews_created_at_idx
  on public.all_father_reviews (created_at desc);

alter table public.all_father_reviews enable row level security;

drop policy if exists "all_father_reviews_select_admin" on public.all_father_reviews;
create policy "all_father_reviews_select_admin"
  on public.all_father_reviews for select
  to authenticated
  using (
    exists (
      select 1
      from public.profiles
      where profiles.id = auth.uid()
        and profiles.role = 'admin'
    )
  );

drop policy if exists "all_father_reviews_insert_service" on public.all_father_reviews;
create policy "all_father_reviews_insert_service"
  on public.all_father_reviews for insert
  to service_role
  with check (
    target_branch = 'main'
    and exists (
      select 1
      from public.profiles
      where profiles.id = all_father_reviews.reviewer_user_id
        and profiles.role = 'admin'
    )
  );

create or replace function public.prevent_all_father_review_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ALL-FATHER reviews are append-only';
end;
$$;

drop trigger if exists prevent_all_father_reviews_update on public.all_father_reviews;
create trigger prevent_all_father_reviews_update
  before update on public.all_father_reviews
  for each row execute function public.prevent_all_father_review_mutation();

drop trigger if exists prevent_all_father_reviews_delete on public.all_father_reviews;
create trigger prevent_all_father_reviews_delete
  before delete on public.all_father_reviews
  for each row execute function public.prevent_all_father_review_mutation();
