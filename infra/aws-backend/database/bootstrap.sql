-- Native PostgreSQL compatibility layer, not a self-hosted Supabase deployment.
-- This must run on a NEW dedicated AWS database, before the app migrations.
-- Cognito owns credentials. auth.users only preserves the existing app identity.
do $$
begin
  if current_database() not in ('opusloops', 'opusloops_aws_test')
     or to_regnamespace('supabase_migrations') is not null
     or to_regclass('auth.users') is not null
     or to_regclass('public.projects') is not null then
    raise exception 'Refusing bootstrap: expected an empty dedicated Opusloops AWS database';
  end if;
end;
$$;

-- No superuser or BYPASSRLS privileges are needed by these application roles.
create role anon nologin noinherit nosuperuser nobypassrls;
create role authenticated nologin noinherit nosuperuser nobypassrls;
create role service_role nologin noinherit nosuperuser nobypassrls;

revoke create on schema public from public;
create schema auth;
create schema storage;
create schema extensions;
create schema private;
revoke all on schema auth, storage, extensions, private from public;
grant usage on schema public, auth, storage, extensions to authenticated, service_role;
grant usage on schema public, auth to anon;
create extension pgcrypto with schema extensions;

create table auth.users (
  id uuid primary key,
  provider_subject text unique,
  email text,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table auth.users is
  'App identity registry. Cognito subject maps to the original immutable Opusloops UUID. No passwords or refresh tokens.';
alter table auth.users enable row level security;
grant select, insert, update on auth.users to service_role;
create policy aws_identity_service on auth.users to service_role using (true) with check (true);

-- ONLY the trusted AWS API sets these transaction-local claims, after checking
-- Cognito and the identity registry. Never expose arbitrary SQL to a client.
create function auth.jwt() returns jsonb language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), auth.jwt()->>'sub')::uuid
$$;
create function auth.role() returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt()->>'role')
$$;
revoke all on all functions in schema auth from public;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- Logical bucket IDs and object keys stay unchanged inside saved project JSON,
-- manifests, and approval hashes. The AWS API maps bucket IDs to physical S3
-- buckets; it registers metadata only after S3 confirms publication. This table
-- is an application registry, not the S3 object itself.
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  owner_id text,
  metadata jsonb,
  user_metadata jsonb,
  version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz,
  unique (bucket_id, name)
);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
-- RLS, not table grants, limits writes to the one allocated ZIP/current attempt.
-- There are deliberately no authenticated UPDATE or DELETE policies.
grant select, insert, update, delete on storage.objects to authenticated;
grant select, insert, update, delete on storage.objects to service_role;
grant select on storage.buckets to service_role;
create policy aws_storage_registry_service on storage.objects to service_role using (true) with check (true);
create policy aws_storage_buckets_service on storage.buckets for select to service_role using (true);

create function storage.foldername(name text) returns text[] language sql immutable set search_path = '' as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1]
$$;
create function storage.filename(name text) returns text language sql immutable set search_path = '' as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;
revoke all on all functions in schema storage from public;
grant execute on all functions in schema storage to authenticated, service_role;

create table private.aws_schema_migrations (
  filename text primary key,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);
