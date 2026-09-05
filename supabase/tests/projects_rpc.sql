begin;

select '1..8';

-- The linked test role cannot create Auth users. Deferring this foreign key inside
-- the rolled-back transaction lets deterministic JWT identities exercise the RPC
-- without weakening ownership checks at commit or leaving test data behind.
set constraints projects_user_id_fkey deferred;

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
declare
  v_name text;
begin
  select name into v_name
  from public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Original',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2}'::jsonb,
    'client_updated_at', '2026-01-01T00:00:00Z',
    'deleted_at', null
  )));
  if v_name is distinct from 'Original' then
    raise exception 'owner A could not create its project';
  end if;
end;
$$;

reset role;
select 'ok 1 - authenticated owner can create through sync_projects';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
declare
  v_name text;
begin
  perform public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Newest',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2,"tempo":120}'::jsonb,
    'client_updated_at', '2026-01-03T00:00:00Z',
    'deleted_at', null
  )));
  select name into v_name
  from public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Stale',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2,"tempo":60}'::jsonb,
    'client_updated_at', '2026-01-02T00:00:00Z',
    'deleted_at', null
  )));
  if v_name is distinct from 'Newest' then
    raise exception 'a stale write replaced the newest project';
  end if;
end;
$$;

reset role;
select 'ok 2 - stale writes cannot replace a newer project';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
declare
  v_deleted_at timestamptz;
  v_name text;
begin
  select deleted_at into v_deleted_at
  from public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Deleted loop',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2}'::jsonb,
    'client_updated_at', '2026-01-03T00:00:00Z',
    'deleted_at', '2026-01-03T00:00:00Z'
  )));
  if v_deleted_at is null then
    raise exception 'equal-time deletion did not win';
  end if;

  select name, deleted_at into v_name, v_deleted_at
  from public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Stale resurrection',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2}'::jsonb,
    'client_updated_at', '2026-01-02T12:00:00Z',
    'deleted_at', null
  )));
  if v_deleted_at is null or v_name is distinct from 'Deleted loop' then
    raise exception 'a stale project resurrected a deletion';
  end if;
end;
$$;

reset role;
select 'ok 3 - equal-time deletes win and stale projects stay deleted';

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
declare
  v_count integer;
  v_name text;
begin
  select count(*), max(name) into v_count, v_name
  from public.sync_projects(jsonb_build_array(jsonb_build_object(
    'id', '11111111-1111-4111-8111-111111111111',
    'name', 'Owner B',
    'schema_version', 2,
    'document', '{"id":"11111111-1111-4111-8111-111111111111","schemaVersion":2}'::jsonb,
    'client_updated_at', '2026-01-04T00:00:00Z',
    'deleted_at', null
  )));
  if v_count <> 1 or v_name is distinct from 'Owner B' then
    raise exception 'owner B did not receive an isolated same-id project';
  end if;
end;
$$;

reset role;
select 'ok 4 - two owners can safely use the same project id';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claims', '{"role":"anon","app_metadata":{}}', true);
set local role anon;

do $$
begin
  perform public.sync_projects('[]'::jsonb);
  raise exception 'anonymous sync unexpectedly succeeded';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
select 'ok 5 - anonymous callers cannot execute sync_projects';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
begin
  insert into public.projects (
    id, name, schema_version, document, client_updated_at
  ) values (
    '22222222-2222-4222-8222-222222222222',
    'Direct write',
    2,
    '{}'::jsonb,
    '2026-01-01T00:00:00Z'
  );
  raise exception 'direct authenticated insert unexpectedly succeeded';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
select 'ok 6 - authenticated callers cannot bypass the atomic RPC';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
declare
  v_changes jsonb;
  v_count integer;
begin
  select jsonb_agg(jsonb_build_object(
    'id', format('33333333-3333-4333-8333-%s', lpad(number::text, 12, '0')),
    'name', format('Quota %s', number),
    'schema_version', 2,
    'document', jsonb_build_object('schemaVersion', 2),
    'client_updated_at', '2026-02-01T00:00:00Z',
    'deleted_at', null
  ))
  into v_changes
  from generate_series(1, 101) as number;

  begin
    perform public.sync_projects(v_changes);
    raise exception 'project quota unexpectedly allowed 101 active rows';
  exception
    when sqlstate '54000' then null;
  end;

  select count(*) into v_count from public.sync_projects('[]'::jsonb);
  if v_count <> 1 then
    raise exception 'a rejected quota batch was not rolled back';
  end if;
end;
$$;

reset role;
select 'ok 7 - active-project quota is atomic and rolls back oversized batches';

select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","app_metadata":{}}', true);
set local role authenticated;

do $$
begin
  perform public.sync_projects('[]'::jsonb);
  raise exception 'an untagged authenticated user unexpectedly synced';
exception
  when insufficient_privilege then null;
end;
$$;

reset role;
select 'ok 8 - only invited Opusloops accounts can sync projects';

rollback;
