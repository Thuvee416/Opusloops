begin;

select '1..18';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"opusloops":true}'::jsonb, '{}'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{"opusloops":true}'::jsonb, '{}'::jsonb);

insert into public.projects (user_id, id, name, schema_version, document, client_updated_at)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'A', 2, '{}'::jsonb, statement_timestamp()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222', 'B', 2, '{}'::jsonb, statement_timestamp());

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

create temporary table stem_dispatch_test_state (key text primary key, value text) on commit drop;

do $$
declare
  v_job jsonb;
  v_claim jsonb;
begin
  v_job := public.create_stem_import(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111', 'dispatch.zip', 100, 'application/zip'
  );
  v_job := public.finalize_stem_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (v_job ->> 'id')::uuid, 0, 100, 'etag'
  );
  insert into stem_dispatch_test_state values
    ('job_id', v_job ->> 'id'), ('attempt_id', v_job ->> 'active_attempt_id');
  v_claim := public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', (v_job ->> 'id')::uuid,
    '90000000-0000-4000-8000-000000000001'
  );
  if v_claim ->> 'dispatchJobName' !~ '^opusloops-inspect-[0-9a-f]{8}-[0-9a-f]{8}$'
     or (v_claim ->> 'dispatchClaimed')::boolean is not true
     or (v_claim ->> 'reconcileRequired')::boolean is not false then
    raise exception 'initial dispatch claim is not deterministic';
  end if;
  insert into stem_dispatch_test_state values ('job_name', v_claim ->> 'dispatchJobName');
end;
$$;

select 'ok 1 - initial dispatch claims persist a deterministic AWS job name';

do $$
declare
  v_job_id uuid := (select value::uuid from stem_dispatch_test_state where key = 'job_id');
  v_attempt_id uuid := (select value::uuid from stem_dispatch_test_state where key = 'attempt_id');
  v_claim jsonb;
begin
  perform public.record_stem_dispatch_unknown(
    v_attempt_id, '90000000-0000-4000-8000-000000000001'
  );
  reset role;
  update private.stem_job_attempts
  set reconcile_after = statement_timestamp() - interval '1 second'
  where id = v_attempt_id;
  set local role service_role;
  v_claim := public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job_id,
    '90000000-0000-4000-8000-000000000002'
  );
  if (v_claim ->> 'reconcileRequired')::boolean is not true
     or v_claim ->> 'dispatchJobName' <> (
       select value from stem_dispatch_test_state where key = 'job_name'
     ) then
    raise exception 'ambiguous dispatch was not routed through reconciliation';
  end if;
end;
$$;

select 'ok 2 - ambiguous submissions cannot be blindly resubmitted before reconciliation';

do $$
declare
  v_job_id uuid := (select value::uuid from stem_dispatch_test_state where key = 'job_id');
  v_attempt_id uuid := (select value::uuid from stem_dispatch_test_state where key = 'attempt_id');
  v_claim jsonb;
begin
  perform public.record_stem_dispatch(
    v_attempt_id, '90000000-0000-4000-8000-000000000002',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  );
  v_claim := public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job_id,
    '90000000-0000-4000-8000-000000000003'
  );
  if (v_claim ->> 'alreadyDispatched')::boolean is not true
     or (v_claim ->> 'dispatchClaimed')::boolean is not false then
    raise exception 'authoritative dispatch was not idempotent';
  end if;
end;
$$;

select 'ok 3 - an authoritative AWS dispatch makes every retry a no-op';

do $$
begin
  begin
    perform public.get_stem_job_for_dispatch(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      (select value::uuid from stem_dispatch_test_state where key = 'job_id')
    );
    raise exception 'cross-user dispatch lookup unexpectedly succeeded';
  exception when no_data_found then null;
  end;
end;
$$;

select 'ok 4 - dispatch retry lookup remains user-bound';

reset role;

insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '40000000-0000-4000-8000-000000000009',
  '11111111-1111-4111-8111-111111111111', 'inspect_queued', 1, 'callback.zip', 100,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/40000000-0000-4000-8000-000000000009/source.zip'
);

insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, dispatch_job_name,
  reconcile_after
) values (
  '60000000-0000-4000-8000-000000000009',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '40000000-0000-4000-8000-000000000009',
  'inspect', 1, 'reconcile_pending', 'opusloops-inspect-40000000-60000000',
  statement_timestamp() + interval '1 minute'
);

update public.stem_import_jobs
set active_attempt_id = '60000000-0000-4000-8000-000000000009'
where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and id = '40000000-0000-4000-8000-000000000009';

set local role service_role;

do $$
declare
  v_response jsonb;
  v_payload jsonb := jsonb_build_object(
    'version', 1,
    'jobId', '40000000-0000-4000-8000-000000000009',
    'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId', '60000000-0000-4000-8000-000000000009',
    'dispatchJobId', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'stage', 'inspect',
    'assets', '[]'::jsonb,
    'event', jsonb_build_object(
      'status', 'started', 'determinate', false, 'completed', null,
      'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'lifecycle')
    ),
    'result', null,
    'error', null
  );
begin
  v_response := public.apply_stem_worker_callback(
    '92000000-0000-4000-8000-000000000001', repeat('d', 64), v_payload
  );
  if v_response #>> '{job,status}' <> 'inspecting' then
    raise exception 'first callback did not start the ambiguous AWS job';
  end if;
  perform public.record_stem_dispatch(
    '60000000-0000-4000-8000-000000000009',
    '92000000-0000-4000-8000-000000000099',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  );
end;
$$;

reset role;

do $$
begin
  if (select external_job_id from private.stem_job_attempts
      where id = '60000000-0000-4000-8000-000000000009')
       <> 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
     or (select state from private.stem_job_attempts
         where id = '60000000-0000-4000-8000-000000000009') <> 'running'
     or (select aws_job_id from public.stem_import_jobs
         where id = '40000000-0000-4000-8000-000000000009')
       <> 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' then
    raise exception 'callback authority was not atomically bound or was regressed';
  end if;
end;
$$;

select 'ok 5 - the first signed callback atomically binds an ambiguous AWS submission';

set local role service_role;

do $$
declare
  v_payload jsonb := jsonb_build_object(
    'version', 1,
    'jobId', '40000000-0000-4000-8000-000000000009',
    'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId', '60000000-0000-4000-8000-000000000009',
    'dispatchJobId', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'stage', 'inspect',
    'assets', '[]'::jsonb,
    'event', jsonb_build_object(
      'status', 'progress', 'determinate', true, 'completed', 1,
      'total', 2, 'unit', 'files',
      'detail', jsonb_build_object('operation', 'extract')
    ),
    'result', null,
    'error', null
  );
begin
  begin
    perform public.apply_stem_worker_callback(
      '92000000-0000-4000-8000-000000000002', repeat('e', 64), v_payload
    );
    raise exception 'conflicting duplicate AWS callback unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;

do $$
begin
  if exists (select 1 from private.stem_worker_nonces
      where nonce = '92000000-0000-4000-8000-000000000002')
     or (select count(*) from public.stem_import_events
         where job_id = '40000000-0000-4000-8000-000000000009') <> 1 then
    raise exception 'conflicting AWS callback mutated callback state';
  end if;
end;
$$;

select 'ok 6 - callbacks from a conflicting duplicate AWS dispatch are rejected';

reset role;

insert into public.stem_import_jobs (
  user_id, id, project_id, status, source_name, source_bytes, source_object_path,
  recovery_expires_at, archive_delete_after
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000001',
  '22222222-2222-4222-8222-222222222222', 'ready', 'ready.zip', 100,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/40000000-0000-4000-8000-000000000001/source.zip',
  statement_timestamp() + interval '1 day', statement_timestamp() - interval '1 minute'
);

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type, retention_until
) values
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001', 'preview_segment', 'track-r0',
    'opusloops-stem-artifacts',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/40000000-0000-4000-8000-000000000001/preview-expired.m4a',
    repeat('a', 64), 20, 'audio/mp4', statement_timestamp() - interval '1 minute'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002', 'preview_segment', 'track-r1',
    'opusloops-stem-artifacts',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/40000000-0000-4000-8000-000000000001/preview-future.m4a',
    repeat('b', 64), 20, 'audio/mp4', statement_timestamp() + interval '1 day'
  );

set local role service_role;

do $$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_stem_retention('91000000-0000-4000-8000-000000000001', 50);
  if jsonb_array_length(v_claim -> 'items') <> 2 then
    raise exception 'expected the due archive and one expired asset';
  end if;
  insert into stem_dispatch_test_state values ('ready_claim', v_claim::text);
end;
$$;

select 'ok 7 - retention claims only due objects in a bounded leased batch';

do $$
declare
  v_claim jsonb := (select value::jsonb from stem_dispatch_test_state where key = 'ready_claim');
  v_item jsonb;
  v_first uuid;
  v_response jsonb;
begin
  for v_item in select value from jsonb_array_elements(v_claim -> 'items') loop
    v_response := public.complete_stem_retention_item(
      (v_claim ->> 'claimId')::uuid, (v_item ->> 'itemId')::uuid
    );
    if v_first is null then v_first := (v_item ->> 'itemId')::uuid; end if;
  end loop;
  v_response := public.complete_stem_retention_item(
    (v_claim ->> 'claimId')::uuid, v_first
  );
  if (v_response ->> 'duplicate')::boolean is not true then
    raise exception 'retention completion retry was not idempotent';
  end if;
end;
$$;

reset role;

do $$
begin
  if (select status from public.stem_import_jobs where id = '40000000-0000-4000-8000-000000000001') <> 'ready'
     or (select archive_deleted_at from public.stem_import_jobs where id = '40000000-0000-4000-8000-000000000001') is null
     or (select deleted_at from public.stem_import_assets where asset_id = '50000000-0000-4000-8000-000000000001') is null
     or (select deleted_at from public.stem_import_assets where asset_id = '50000000-0000-4000-8000-000000000002') is not null then
    raise exception 'retention completion marked the wrong rows';
  end if;
end;
$$;

select 'ok 8 - successful deletion marks only its rows and preserves a ready job';
select 'ok 9 - exact retention completion retries are idempotent';

update public.stem_import_assets
set retention_until = statement_timestamp() - interval '1 minute'
where asset_id = '50000000-0000-4000-8000-000000000002';

set local role service_role;

do $$
declare
  v_claim jsonb;
  v_item_id uuid;
  v_retry jsonb;
begin
  v_claim := public.claim_stem_retention('91000000-0000-4000-8000-000000000002', 1);
  v_item_id := (v_claim #>> '{items,0,itemId}')::uuid;
  perform public.fail_stem_retention_item(
    (v_claim ->> 'claimId')::uuid, v_item_id, 'Synthetic Storage failure'
  );
  v_retry := public.claim_stem_retention('91000000-0000-4000-8000-000000000003', 1);
  if jsonb_array_length(v_retry -> 'items') <> 0 then
    raise exception 'failed retention item ignored its retry backoff';
  end if;
  insert into stem_dispatch_test_state values ('failed_item', v_item_id::text);
end;
$$;

select 'ok 10 - failed Storage deletion releases its lease with retry backoff';

reset role;
update private.stem_retention_items
set next_attempt_at = statement_timestamp() - interval '1 second'
where id = (select value::uuid from stem_dispatch_test_state where key = 'failed_item');
set local role service_role;

do $$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_stem_retention('91000000-0000-4000-8000-000000000004', 1);
  perform public.complete_stem_retention_item(
    (v_claim ->> 'claimId')::uuid, (v_claim #>> '{items,0,itemId}')::uuid
  );
end;
$$;

select 'ok 11 - a due failed deletion can be reclaimed and completed safely';

reset role;

insert into public.stem_import_jobs (
  user_id, id, project_id, status, status_before_deletion, source_name, source_bytes,
  source_object_path, recovery_expires_at, deletion_requested_at, source_delete_after
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000002',
  '22222222-2222-4222-8222-222222222222', 'deletion_pending', 'ready',
  'deleted-project.zip', 100,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/40000000-0000-4000-8000-000000000002/source.zip',
  statement_timestamp() - interval '1 day', statement_timestamp() - interval '31 days',
  statement_timestamp() - interval '1 day'
);

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '40000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000003', 'canonical', '48khz-f32',
  'opusloops-stem-sources',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/22222222-2222-4222-8222-222222222222/40000000-0000-4000-8000-000000000002/source.wav',
  repeat('c', 64), 20, 'audio/wav'
);

set local role service_role;

do $$
declare
  v_claim jsonb;
  v_item jsonb;
  v_index integer := 0;
  v_status text;
begin
  v_claim := public.claim_stem_retention('91000000-0000-4000-8000-000000000005', 50);
  if jsonb_array_length(v_claim -> 'items') <> 2 then
    raise exception 'project cleanup did not claim every known object';
  end if;
  for v_item in select value from jsonb_array_elements(v_claim -> 'items') loop
    v_index := v_index + 1;
    perform public.complete_stem_retention_item(
      (v_claim ->> 'claimId')::uuid, (v_item ->> 'itemId')::uuid
    );
    reset role;
    select status into v_status from public.stem_import_jobs
    where id = '40000000-0000-4000-8000-000000000002';
    if v_index = 1 and v_status <> 'deletion_pending' then
      raise exception 'job was deleted before every Storage object succeeded';
    end if;
    set local role service_role;
  end loop;
  reset role;
  select status into v_status from public.stem_import_jobs
  where id = '40000000-0000-4000-8000-000000000002';
  if v_status <> 'deleted' then raise exception 'fully cleaned project job was not finalized'; end if;
  set local role service_role;
end;
$$;

select 'ok 12 - project jobs become deleted only after every Storage object succeeds';

reset role;

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '{"opusloops":true}'::jsonb, '{}'::jsonb);
insert into public.projects (user_id, id, name, schema_version, document, client_updated_at)
values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '33333333-3333-4333-8333-333333333333', 'Restore fence', 2, '{}'::jsonb,
  statement_timestamp()
);
insert into public.stem_import_jobs (
  user_id, id, project_id, status, source_name, source_bytes,
  source_object_path, recovery_expires_at, archive_delete_after
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '40000000-0000-4000-8000-000000000003',
  '33333333-3333-4333-8333-333333333333', 'ready', 'restore.zip', 100,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd/33333333-3333-4333-8333-333333333333/40000000-0000-4000-8000-000000000003/source.zip',
  statement_timestamp() + interval '1 day', statement_timestamp() + interval '1 day'
);
update public.projects
set deleted_at = statement_timestamp() + interval '1 second'
where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and id = '33333333-3333-4333-8333-333333333333';
update public.stem_import_jobs
set source_delete_after = statement_timestamp() - interval '1 second'
where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and id = '40000000-0000-4000-8000-000000000003';

set local role service_role;

do $$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_stem_retention('93000000-0000-4000-8000-000000000001', 50);
  if jsonb_array_length(v_claim -> 'items') <> 1 then
    raise exception 'restore-race fixture did not claim its archive';
  end if;
  insert into stem_dispatch_test_state values ('restore_item', v_claim #>> '{items,0,itemId}');
end;
$$;

reset role;

do $$
begin
  begin
    update public.projects set deleted_at = null
    where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      and id = '33333333-3333-4333-8333-333333333333';
    raise exception 'project restored while Storage deletion was leased';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

update private.stem_retention_items
set claim_expires_at = statement_timestamp() - interval '1 second'
where id = (select value::uuid from stem_dispatch_test_state where key = 'restore_item');
update public.projects set deleted_at = null
where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and id = '33333333-3333-4333-8333-333333333333';

set local role service_role;

do $$
begin
  begin
    perform public.complete_stem_retention_item(
      '93000000-0000-4000-8000-000000000001',
      (select value::uuid from stem_dispatch_test_state where key = 'restore_item')
    );
    raise exception 'restored project cleanup unexpectedly finalized';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;

do $$
begin
  if (select status from public.stem_import_jobs
      where id = '40000000-0000-4000-8000-000000000003') <> 'ready'
     or (select archive_deleted_at from public.stem_import_jobs
         where id = '40000000-0000-4000-8000-000000000003') is not null then
    raise exception 'restore fence left the project in an unsafe cleanup state';
  end if;
end;
$$;

select 'ok 13 - restore is fenced during a lease and completion rechecks eligibility';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '{"opusloops":true}'::jsonb, '{}'::jsonb);
insert into public.projects (user_id, id, name, schema_version, document, client_updated_at)
values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '44444444-4444-4444-8444-444444444444', 'Active restore', 2, '{}'::jsonb,
  statement_timestamp()
);
insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000004',
  '44444444-4444-4444-8444-444444444444', 'inspecting', 2,
  'active.zip', 100,
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/44444444-4444-4444-8444-444444444444/40000000-0000-4000-8000-000000000004/source.zip'
);
insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, external_job_id
) values (
  '60000000-0000-4000-8000-000000000004',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '40000000-0000-4000-8000-000000000004', 'inspect', 1, 'running',
  'ffffffff-ffff-4fff-8fff-ffffffffffff'
);
update public.stem_import_jobs
set active_attempt_id = '60000000-0000-4000-8000-000000000004'
where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  and id = '40000000-0000-4000-8000-000000000004';
update public.projects
set deleted_at = statement_timestamp() + interval '1 second'
where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  and id = '44444444-4444-4444-8444-444444444444';
update public.projects set deleted_at = null
where user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  and id = '44444444-4444-4444-8444-444444444444';

do $$
begin
  if (select state from private.stem_job_attempts
      where id = '60000000-0000-4000-8000-000000000004') <> 'cancelled'
     or (select status from public.stem_import_jobs
         where id = '40000000-0000-4000-8000-000000000004') <> 'failed'
     or (select error_code from public.stem_import_jobs
         where id = '40000000-0000-4000-8000-000000000004')
       <> 'project_restored_processing_cancelled' then
    raise exception 'live work was resurrected by project restoration';
  end if;
end;
$$;

select 'ok 14 - delete terminalizes active work and restore cannot revive a phantom job';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', '{"opusloops":true}'::jsonb, '{}'::jsonb),
  ('99999999-9999-4999-8999-999999999999', '{"opusloops":true}'::jsonb, '{}'::jsonb);
insert into public.projects (user_id, id, name, schema_version, document, client_updated_at)
values
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', '55555555-5555-4555-8555-555555555555', 'Hard project', 2, '{}'::jsonb, statement_timestamp()),
  ('99999999-9999-4999-8999-999999999999', '66666666-6666-4666-8666-666666666666', 'Hard user', 2, '{}'::jsonb, statement_timestamp());
insert into public.stem_import_jobs (
  user_id, id, project_id, status, source_name, source_bytes, source_object_path,
  recovery_expires_at
) values
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff', '40000000-0000-4000-8000-000000000005',
    '55555555-5555-4555-8555-555555555555', 'failed', 'hard-project.zip', 100,
    'ffffffff-ffff-4fff-8fff-ffffffffffff/55555555-5555-4555-8555-555555555555/40000000-0000-4000-8000-000000000005/source.zip',
    statement_timestamp() - interval '1 day'
  ),
  (
    '99999999-9999-4999-8999-999999999999', '40000000-0000-4000-8000-000000000006',
    '66666666-6666-4666-8666-666666666666', 'uploading', 'hard-user.zip', 100,
    '99999999-9999-4999-8999-999999999999/66666666-6666-4666-8666-666666666666/40000000-0000-4000-8000-000000000006/source.zip',
    statement_timestamp() - interval '1 day'
  );
insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'ffffffff-ffff-4fff-8fff-ffffffffffff', '40000000-0000-4000-8000-000000000005',
  '50000000-0000-4000-8000-000000000005', 'canonical', '48khz-f32',
  'opusloops-stem-sources',
  'ffffffff-ffff-4fff-8fff-ffffffffffff/55555555-5555-4555-8555-555555555555/40000000-0000-4000-8000-000000000005/sources/0123456789abcdef-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wav',
  repeat('a', 64), 100, 'audio/wav'
);
insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  (
    'opusloops-stem-uploads',
    'ffffffff-ffff-4fff-8fff-ffffffffffff/55555555-5555-4555-8555-555555555555/40000000-0000-4000-8000-000000000005/source.zip',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', '{"size":100}'::jsonb
  ),
  (
    'opusloops-stem-sources',
    'ffffffff-ffff-4fff-8fff-ffffffffffff/55555555-5555-4555-8555-555555555555/40000000-0000-4000-8000-000000000005/sources/0123456789abcdef-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.wav',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', '{"size":100}'::jsonb
  ),
  (
    'opusloops-stem-artifacts',
    'ffffffff-ffff-4fff-8fff-ffffffffffff/55555555-5555-4555-8555-555555555555/40000000-0000-4000-8000-000000000005/attempts/77777777-7777-4777-8777-777777777777/inspect/files/unregistered.json',
    'ffffffff-ffff-4fff-8fff-ffffffffffff', '{"size":100}'::jsonb
  ),
  (
    'opusloops-stem-uploads',
    '99999999-9999-4999-8999-999999999999/66666666-6666-4666-8666-666666666666/40000000-0000-4000-8000-000000000006/source.zip',
    '99999999-9999-4999-8999-999999999999', '{"size":100}'::jsonb
  );

delete from public.projects
where user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  and id = '55555555-5555-4555-8555-555555555555';
delete from auth.users where id = '99999999-9999-4999-8999-999999999999';

set local role service_role;

do $$
declare
  v_claim jsonb;
begin
  v_claim := public.claim_stem_retention('93000000-0000-4000-8000-000000000002', 50);
  if jsonb_array_length(v_claim -> 'items') <> 4 then
    raise exception 'hard-delete cleanup did not preserve/sweep every object: %', v_claim;
  end if;
end;
$$;

reset role;

do $$
begin
  if exists (select 1 from public.stem_import_jobs
      where id in (
        '40000000-0000-4000-8000-000000000005',
        '40000000-0000-4000-8000-000000000006'
      ))
     or (select count(*) from private.stem_retention_scopes
         where job_id in (
           '40000000-0000-4000-8000-000000000005',
           '40000000-0000-4000-8000-000000000006'
         )) <> 6
     or not exists (
       select 1 from private.stem_retention_items
       where object_path like '%/inspect/files/unregistered.json'
         and subject_type = 'orphan' and reason = 'hard_delete'
     ) then
    raise exception 'hard-delete cleanup inventory did not survive its parents';
  end if;
end;
$$;

select 'ok 15 - hard project/auth deletion preserves and sweeps registered and partial objects';

reset role;

insert into public.stem_import_jobs (
  user_id, id, project_id, status, source_name, source_bytes,
  source_object_path, recovery_expires_at
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '40000000-0000-4000-8000-000000000007',
  '33333333-3333-4333-8333-333333333333', 'uploading', 'expired.zip', 100,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd/33333333-3333-4333-8333-333333333333/40000000-0000-4000-8000-000000000007/source.zip',
  statement_timestamp() - interval '1 second'
);

set local role service_role;

do $$
begin
  begin
    perform public.finalize_stem_upload(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '40000000-0000-4000-8000-000000000007', 0, 100, 'etag'
    );
    raise exception 'expired archive unexpectedly finalized';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

reset role;
update public.stem_import_jobs
set recovery_expires_at = statement_timestamp() + interval '1 day'
where user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  and id = '40000000-0000-4000-8000-000000000007';
insert into private.stem_retention_items (
  id, user_id, job_id, subject_type, reason, bucket, object_path,
  claim_id, claim_expires_at, attempt_count
) values (
  '94000000-0000-4000-8000-000000000001',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '40000000-0000-4000-8000-000000000007', 'archive', 'recovery_expired',
  'opusloops-stem-uploads',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd/33333333-3333-4333-8333-333333333333/40000000-0000-4000-8000-000000000007/source.zip',
  '94000000-0000-4000-8000-000000000002',
  statement_timestamp() + interval '5 minutes', 1
);

set local role service_role;

do $$
begin
  begin
    perform public.get_stem_job_for_finalize(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '40000000-0000-4000-8000-000000000007'
    );
    raise exception 'claimed cleanup archive unexpectedly passed preflight';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.finalize_stem_upload(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '40000000-0000-4000-8000-000000000007', 0, 100, 'etag'
    );
    raise exception 'claimed cleanup archive unexpectedly finalized';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 16 - upload finalization rejects expired or cleanup-claimed archives';

reset role;

insert into private.stem_worker_nonces (nonce, request_sha256, response_body, created_at)
values
  (
    '95000000-0000-4000-8000-000000000001', repeat('1', 64),
    '{"accepted":true}'::jsonb, statement_timestamp() - interval '25 hours'
  ),
  (
    '95000000-0000-4000-8000-000000000002', repeat('2', 64),
    '{"accepted":true}'::jsonb, statement_timestamp() - interval '23 hours'
  );
set local role service_role;
do $$
begin
  perform public.claim_stem_retention('95000000-0000-4000-8000-000000000003', 1);
end;
$$;
reset role;

do $$
begin
  if exists (select 1 from private.stem_worker_nonces
      where nonce = '95000000-0000-4000-8000-000000000001')
     or not exists (select 1 from private.stem_worker_nonces
         where nonce = '95000000-0000-4000-8000-000000000002') then
    raise exception 'callback nonce retention horizon was not enforced';
  end if;
end;
$$;

select 'ok 17 - retention maintenance prunes callback nonces only after 24 hours';

reset role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.get_stem_job_for_dispatch(uuid,uuid)',
    'public.record_stem_dispatch_unknown(uuid,uuid)',
    'public.claim_stem_retention(uuid,integer)',
    'public.complete_stem_retention_item(uuid,uuid)',
    'public.fail_stem_retention_item(uuid,uuid,text)'
  ] loop
    if has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or has_function_privilege('anon', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception '% has unsafe retention/dispatch grants', v_signature;
    end if;
  end loop;
end;
$$;

select 'ok 18 - retry and retention state/functions remain service-role-only';

rollback;
