create table public.projects (
  user_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  id uuid primary key,
  name text not null,
  schema_version smallint not null default 2,
  document jsonb not null,
  client_updated_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_name_length
    check (char_length(name) between 1 and 48),
  constraint projects_schema_version
    check (schema_version between 1 and 32767),
  constraint projects_document_is_object
    check (jsonb_typeof(document) = 'object'),
  constraint projects_document_size
    check (octet_length(document::text) <= 131072),
  constraint projects_deleted_at_order
    check (deleted_at is null or deleted_at >= client_updated_at)
);

comment on table public.projects is
  'Private, offline-first Opusloops project documents owned by Supabase Auth users.';
comment on column public.projects.client_updated_at is
  'Client edit clock used for deterministic last-write-wins reconciliation.';
comment on column public.projects.deleted_at is
  'Durable client tombstone; populated instead of hard-deleting during offline sync.';

create index projects_user_updated_idx
  on public.projects (user_id, client_updated_at desc);

create function public.opusloops_set_projects_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = statement_timestamp();
  return new;
end;
$$;

revoke all on function public.opusloops_set_projects_updated_at() from public;

create trigger opusloops_projects_updated_at
before update on public.projects
for each row execute function public.opusloops_set_projects_updated_at();

alter table public.projects enable row level security;

revoke all on table public.projects from anon, authenticated;
grant select, insert, update, delete on table public.projects to authenticated;

create policy "Users can view their own Opusloops projects"
on public.projects
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their own Opusloops projects"
on public.projects
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their own Opusloops projects"
on public.projects
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their own Opusloops projects"
on public.projects
for delete
to authenticated
using ((select auth.uid()) = user_id);
