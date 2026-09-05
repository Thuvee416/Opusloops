alter table public.projects
  drop constraint projects_pkey,
  add primary key (user_id, id);

revoke select, insert, update, delete on table public.projects from authenticated;

create or replace function public.sync_projects(p_changes jsonb default '[]'::jsonb)
returns setof public.projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_change jsonb;
  v_id uuid;
  v_name text;
  v_schema_version smallint;
  v_document jsonb;
  v_client_updated_at timestamptz;
  v_deleted_at timestamptz;
  v_active_count integer;
  v_total_count integer;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'array' then
    raise exception using errcode = '22023', message = 'Project changes must be a JSON array';
  end if;

  if pg_catalog.jsonb_array_length(p_changes) > 600
     or pg_catalog.octet_length(p_changes::text) > 4194304 then
    raise exception using errcode = '54000', message = 'Project sync batch is too large';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_uid::text, 831527)
  );

  for v_change in
    select value from pg_catalog.jsonb_array_elements(p_changes)
  loop
    if pg_catalog.jsonb_typeof(v_change) <> 'object' then
      raise exception using errcode = '22023', message = 'Each project change must be an object';
    end if;

    begin
      v_id := (v_change ->> 'id')::uuid;
      v_name := pg_catalog.btrim(v_change ->> 'name');
      v_schema_version := (v_change ->> 'schema_version')::smallint;
      v_document := v_change -> 'document';
      v_client_updated_at := (v_change ->> 'client_updated_at')::timestamptz;
      v_deleted_at := nullif(v_change ->> 'deleted_at', '')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'A project change has invalid fields';
    end;

    if v_id is null
       or v_name is null
       or v_schema_version is null
       or v_document is null
       or v_client_updated_at is null
       or (v_deleted_at is not null and v_deleted_at <> v_client_updated_at)
       or v_client_updated_at > pg_catalog.statement_timestamp() + interval '24 hours' then
      raise exception using errcode = '22023', message = 'A project change has invalid fields';
    end if;

    insert into public.projects as existing (
      user_id,
      id,
      name,
      schema_version,
      document,
      client_updated_at,
      deleted_at
    ) values (
      v_uid,
      v_id,
      v_name,
      v_schema_version,
      v_document,
      v_client_updated_at,
      v_deleted_at
    )
    on conflict (user_id, id) do update
      set name = excluded.name,
          schema_version = excluded.schema_version,
          document = excluded.document,
          client_updated_at = excluded.client_updated_at,
          deleted_at = excluded.deleted_at
    where excluded.client_updated_at > existing.client_updated_at
       or (
         excluded.client_updated_at = existing.client_updated_at
         and (excluded.deleted_at is not null)::integer > (existing.deleted_at is not null)::integer
       )
       or (
         excluded.client_updated_at = existing.client_updated_at
         and (excluded.deleted_at is not null) = (existing.deleted_at is not null)
         and pg_catalog.md5(pg_catalog.jsonb_build_array(
           excluded.name,
           excluded.schema_version,
           excluded.document
         )::text) > pg_catalog.md5(pg_catalog.jsonb_build_array(
           existing.name,
           existing.schema_version,
           existing.document
         )::text)
       );
  end loop;

  select
    pg_catalog.count(*) filter (where deleted_at is null),
    pg_catalog.count(*)
  into v_active_count, v_total_count
  from public.projects
  where user_id = v_uid;

  if v_active_count > 100 or v_total_count > 500 then
    raise exception using errcode = '54000', message = 'Project storage limit reached';
  end if;

  return query
    select project.*
    from public.projects as project
    where project.user_id = v_uid
    order by project.client_updated_at asc, project.id asc;
end;
$$;

comment on function public.sync_projects(jsonb) is
  'Atomically reconciles an authenticated user project snapshot with deterministic LWW and delete precedence.';

revoke all on function public.sync_projects(jsonb) from public, anon;
grant execute on function public.sync_projects(jsonb) to authenticated;
