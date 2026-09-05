begin;

select '1..9';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"opusloops":true}'::jsonb, '{}'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"opusloops":true}'::jsonb, '{}'::jsonb),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{}'::jsonb, '{}'::jsonb);

insert into public.projects (user_id, id, name, schema_version, document, client_updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'A', 2, '{}'::jsonb, statement_timestamp()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'B', 2, '{}'::jsonb, statement_timestamp());

insert into public.stem_import_jobs (
  user_id, id, project_id, source_name, source_bytes, source_object_path
) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111', 'a.zip', 100,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/source.zip'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222', 'b.zip', 200,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/10000000-0000-4000-8000-000000000002/source.zip'
  );

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001',
    '30000000-0000-4000-8000-000000000001', 'click', 'first',
    'opusloops-stem-artifacts',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/click.wav',
    repeat('a', 64), 50, 'audio/wav'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000002', 'click', 'first',
    'opusloops-stem-artifacts',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/10000000-0000-4000-8000-000000000002/click.wav',
    repeat('b', 64), 50, 'audio/wav'
  );

insert into public.stem_import_events (
  user_id, job_id, sequence, stage, status, determinate, completed, total, unit
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', 1, 'upload', 'started', true, 0, 100, 'bytes'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000002', 1, 'upload', 'started', true, 0, 200, 'bytes');

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
begin
  if (select count(*) from public.stem_import_jobs) <> 1
     or (select count(*) from public.stem_import_assets) <> 1
     or (select count(*) from public.stem_import_events) <> 1 then
    raise exception 'owner A did not receive one isolated row per stem table';
  end if;
end;
$$;

reset role;
select 'ok 1 - RLS exposes only the member own jobs, assets, and events';

select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","app_metadata":{}}', true);
set local role authenticated;

do $$
begin
  if exists (select 1 from public.stem_import_jobs)
     or exists (select 1 from public.stem_import_assets)
     or exists (select 1 from public.stem_import_events) then
    raise exception 'non-member could see stem records';
  end if;
end;
$$;

reset role;
select 'ok 2 - an authenticated non-member sees no stem records';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

do $$
begin
  begin
    update public.stem_import_jobs set status = 'ready';
    raise exception 'browser direct job mutation unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.cancel_stem_import(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '10000000-0000-4000-8000-000000000001', 0
    );
    raise exception 'browser service RPC execution unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select 'ok 3 - browser callers cannot mutate jobs directly or invoke service RPCs';

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","app_metadata":{"opusloops":true}}', true);
set local role authenticated;

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'opusloops-stem-uploads',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/source.zip',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '{"size":100}'::jsonb
);

reset role;
select 'ok 4 - the allocated owner can create the exact immutable upload object';

set local role authenticated;

do $$
begin
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (
    'opusloops-stem-uploads',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/other.zip',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '{"size":100}'::jsonb
  );
  raise exception 'unallocated object path unexpectedly succeeded';
exception when insufficient_privilege then null;
end;
$$;

reset role;
select 'ok 5 - storage RLS rejects unallocated object names';

reset role;
update public.stem_import_jobs
set status = 'inspecting',
    active_attempt_id = '60000000-0000-4000-8000-000000000001'
where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;

insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  (
    'opusloops-stem-sources',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/sources/0123456789abcdef-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wav',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '{"size":100}'::jsonb
  ),
  (
    'opusloops-stem-artifacts',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/attempts/60000000-0000-4000-8000-000000000001/inspect/files/manifest.json',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '{"size":100}'::jsonb
  );

reset role;
select 'ok 6 - a session-token worker can publish only its active source and attempt paths';

set local role authenticated;

do $$
begin
  begin
    insert into storage.objects (bucket_id, name, owner_id, metadata)
    values (
      'opusloops-stem-sources',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/sources/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wav',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '{"size":100}'::jsonb
    );
    raise exception 'source without relative-path hash unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into storage.objects (bucket_id, name, owner_id, metadata)
    values (
      'opusloops-stem-artifacts',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/attempts/60000000-0000-4000-8000-000000000099/inspect/files/manifest.json',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '{"size":100}'::jsonb
    );
    raise exception 'stale attempt path unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

reset role;
select 'ok 7 - worker publication rejects malformed source and stale attempt paths';

set local role authenticated;

do $$
declare
  v_count integer;
begin
  update storage.objects set metadata = '{"size":101}'::jsonb
  where bucket_id = 'opusloops-stem-sources'
    and name like 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%/sources/%';
  get diagnostics v_count = row_count;
  if v_count <> 0 then raise exception 'worker update policy unexpectedly exists'; end if;

  begin
    delete from storage.objects
    where bucket_id = 'opusloops-stem-artifacts'
      and name like 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%/attempts/%';
    get diagnostics v_count = row_count;
    if v_count <> 0 then raise exception 'worker delete policy unexpectedly exists'; end if;
  exception when others then
    if sqlerrm not like 'Direct deletion from storage tables is not allowed%' then
      raise;
    end if;
  end;
end;
$$;

reset role;
select 'ok 8 - worker Storage permissions are insert-only';

reset role;
update public.stem_import_jobs
set status = 'awaiting_analysis_confirmation'
where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;

do $$
begin
  if exists (
    select 1 from storage.objects
    where bucket_id in ('opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts')
      and name like 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/10000000-0000-4000-8000-000000000001/%'
  ) then
    raise exception 'session-bearing worker retained access after its stage ended';
  end if;
end;
$$;

reset role;
select 'ok 9 - Storage reads close when the current processing stage ends';

rollback;
