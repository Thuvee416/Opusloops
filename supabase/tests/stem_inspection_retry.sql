begin;

select '1..11';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values (
  'a1000000-0000-4000-8000-000000000001',
  '{"opusloops":true}'::jsonb,
  '{}'::jsonb
);

insert into public.projects (
  user_id, id, name, schema_version, document, client_updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'Inspection retry tests', 2, '{}'::jsonb, statement_timestamp()
);

insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path, source_storage_etag, active_attempt_id, aws_job_id,
  error_code, error_message, recovery_expires_at
)
select
  'a1000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  'b1000000-0000-4000-8000-000000000001'::uuid,
  'failed', 2, fixture.name, 100,
  'a1000000-0000-4000-8000-000000000001/b1000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/source.zip',
  'old-etag', fixture.attempt_id, 'old-' || fixture.job_id::text,
  fixture.error_code, 'Synthetic inspection failure', fixture.recovery_expires_at
from (values
  (
    'c1000000-0000-4000-8000-000000000001'::uuid,
    'd1000000-0000-4000-8000-000000000001'::uuid,
    'valid.zip', 'batch_bootstrap_failed', statement_timestamp() + interval '1 day'
  ),
  (
    'c1000000-0000-4000-8000-000000000002'::uuid,
    'd1000000-0000-4000-8000-000000000002'::uuid,
    'nonretry.zip', 'internal_worker_error', statement_timestamp() + interval '1 day'
  ),
  (
    'c1000000-0000-4000-8000-000000000003'::uuid,
    'd1000000-0000-4000-8000-000000000003'::uuid,
    'wrong-stage.zip', 'batch_bootstrap_failed', statement_timestamp() + interval '1 day'
  ),
  (
    'c1000000-0000-4000-8000-000000000004'::uuid,
    'd1000000-0000-4000-8000-000000000004'::uuid,
    'expired.zip', 'batch_bootstrap_failed', statement_timestamp() - interval '1 second'
  ),
  (
    'c1000000-0000-4000-8000-000000000005'::uuid,
    'd1000000-0000-4000-8000-000000000005'::uuid,
    'cleanup.zip', 'batch_bootstrap_failed', statement_timestamp() + interval '1 day'
  ),
  (
    'c1000000-0000-4000-8000-000000000006'::uuid,
    'd1000000-0000-4000-8000-000000000006'::uuid,
    'assets.zip', 'batch_bootstrap_failed', statement_timestamp() + interval '1 day'
  ),
  (
    'c1000000-0000-4000-8000-000000000007'::uuid,
    'd1000000-0000-4000-8000-000000000007'::uuid,
    'missing.zip', 'batch_queue_timeout', statement_timestamp() + interval '1 day'
  )
) as fixture(job_id, attempt_id, name, error_code, recovery_expires_at);

insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, external_job_id, finished_at
)
select
  fixture.attempt_id,
  'a1000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  fixture.stage,
  1,
  'failed',
  'old-' || fixture.job_id::text,
  statement_timestamp()
from (values
  ('c1000000-0000-4000-8000-000000000001'::uuid, 'd1000000-0000-4000-8000-000000000001'::uuid, 'inspect'),
  ('c1000000-0000-4000-8000-000000000002'::uuid, 'd1000000-0000-4000-8000-000000000002'::uuid, 'inspect'),
  ('c1000000-0000-4000-8000-000000000003'::uuid, 'd1000000-0000-4000-8000-000000000003'::uuid, 'analyze'),
  ('c1000000-0000-4000-8000-000000000004'::uuid, 'd1000000-0000-4000-8000-000000000004'::uuid, 'inspect'),
  ('c1000000-0000-4000-8000-000000000005'::uuid, 'd1000000-0000-4000-8000-000000000005'::uuid, 'inspect'),
  ('c1000000-0000-4000-8000-000000000006'::uuid, 'd1000000-0000-4000-8000-000000000006'::uuid, 'inspect'),
  ('c1000000-0000-4000-8000-000000000007'::uuid, 'd1000000-0000-4000-8000-000000000007'::uuid, 'inspect')
) as fixture(job_id, attempt_id, stage);

insert into storage.objects (bucket_id, name, owner_id, metadata)
select
  'opusloops-stem-uploads',
  'a1000000-0000-4000-8000-000000000001/b1000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/source.zip',
  'a1000000-0000-4000-8000-000000000001',
  '{"size":100}'::jsonb
from (values
  ('c1000000-0000-4000-8000-000000000001'::uuid),
  ('c1000000-0000-4000-8000-000000000002'::uuid),
  ('c1000000-0000-4000-8000-000000000003'::uuid),
  ('c1000000-0000-4000-8000-000000000004'::uuid),
  ('c1000000-0000-4000-8000-000000000005'::uuid),
  ('c1000000-0000-4000-8000-000000000006'::uuid)
) as fixture(job_id);

insert into private.stem_retention_items (
  user_id, job_id, subject_type, reason, bucket, object_path
) values (
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000005',
  'archive', 'recovery_expired', 'opusloops-stem-uploads',
  'a1000000-0000-4000-8000-000000000001/b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000005/source.zip'
);

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'a1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000006',
  'e1000000-0000-4000-8000-000000000001',
  'report', 'event-journal', 'opusloops-stem-artifacts',
  'a1000000-0000-4000-8000-000000000001/b1000000-0000-4000-8000-000000000001/c1000000-0000-4000-8000-000000000006/attempts/d1000000-0000-4000-8000-000000000006/inspect/events.jsonl',
  repeat('a', 64), 1, 'application/x-ndjson'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
declare
  v_source jsonb;
begin
  v_source := public.get_stem_inspection_retry_source(
    'a1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    2
  );
  if (v_source ->> 'source_bytes')::bigint <> 100
     or v_source ->> 'source_object_path' not like '%/c1000000-0000-4000-8000-000000000001/source.zip' then
    raise exception 'valid retry source was not returned: %', v_source;
  end if;
end;
$$;

select 'ok 1 - an intact allowlisted bootstrap failure passes retry preflight';

do $$
begin
  begin
    perform public.retry_stem_inspection(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000001', 2, 99, 'new-etag'
    );
    raise exception 'wrong observed size unexpectedly retried';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.retry_stem_inspection(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000001', 2, null, 'new-etag'
    );
    raise exception 'missing observed size unexpectedly retried';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

select 'ok 2 - retry remains bound to the observed source byte count';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000002', 2
    );
    raise exception 'non-retryable error unexpectedly passed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 3 - non-allowlisted worker failures cannot be retried';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000003', 2
    );
    raise exception 'failed analyze attempt unexpectedly passed inspect retry';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 4 - retry requires the active failed attempt to be inspect';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000004', 2
    );
    raise exception 'expired recovery unexpectedly passed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 5 - expired recovery windows cannot be reopened';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000005', 2
    );
    raise exception 'cleanup-started recovery unexpectedly passed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 6 - any retention cleanup record fences retry';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000006', 2
    );
    raise exception 'partial asset recovery unexpectedly passed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 7 - retries reject inspections with registered partial assets';

do $$
begin
  begin
    perform public.get_stem_inspection_retry_source(
      'a1000000-0000-4000-8000-000000000001',
      'c1000000-0000-4000-8000-000000000007', 2
    );
    raise exception 'missing archive unexpectedly passed';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 8 - retry requires the original owned Storage object';

do $$
declare
  v_result jsonb;
  v_old_attempt uuid := 'd1000000-0000-4000-8000-000000000001';
  v_new_attempt uuid;
  v_dispatch jsonb;
begin
  v_result := public.retry_stem_inspection(
    'a1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001', 2, 100, 'new-etag'
  );
  v_new_attempt := (v_result ->> 'active_attempt_id')::uuid;
  if v_result ->> 'status' <> 'inspect_queued'
     or (v_result ->> 'revision')::bigint <> 3
     or v_new_attempt = v_old_attempt
     or v_result ->> 'error_code' is not null
     or v_result ->> 'aws_job_id' is not null then
    raise exception 'retry did not create a clean queued revision: %', v_result;
  end if;

  reset role;
  if (select state from private.stem_job_attempts where id = v_old_attempt) <> 'failed'
     or (select state from private.stem_job_attempts where id = v_new_attempt) <> 'pending_dispatch'
     or (select count(*) from private.stem_job_attempts
         where job_id = 'c1000000-0000-4000-8000-000000000001') <> 2
     or not exists (
       select 1 from public.stem_import_events
       where job_id = 'c1000000-0000-4000-8000-000000000001'
         and attempt_id = v_new_attempt
         and stage = 'dispatch' and status = 'started'
         and detail ->> 'operation' = 'retry-inspection'
     ) then
    raise exception 'retry attempt or audit event is invalid';
  end if;
  set local role service_role;

  perform public.get_stem_job_for_dispatch(
    'a1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001'
  );
  v_dispatch := public.claim_stem_dispatch(
    'a1000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001'
  );
  if (v_dispatch ->> 'dispatchClaimed')::boolean is not true
     or v_dispatch ->> 'stage' <> 'inspect'
     or v_dispatch ->> 'attemptId' <> v_new_attempt::text
     or v_dispatch ->> 'dispatchJobName' <> (
       'opusloops-inspect-c1000000-' || left(v_new_attempt::text, 8)
     ) then
    raise exception 'fresh retry attempt was not dispatchable: %', v_dispatch;
  end if;
end;
$$;

select 'ok 9 - retry increments revision and creates one fresh dispatchable attempt';

do $$
declare
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'version', 1,
    'jobId', 'c1000000-0000-4000-8000-000000000001',
    'userId', 'a1000000-0000-4000-8000-000000000001',
    'attemptId', 'd1000000-0000-4000-8000-000000000001',
    'dispatchJobId', 'old-c1000000-0000-4000-8000-000000000001',
    'stage', 'inspect',
    'event', jsonb_build_object(
      'status', 'failed', 'determinate', false,
      'completed', null, 'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'late-old-attempt')
    ),
    'assets', '[]'::jsonb,
    'result', null,
    'error', jsonb_build_object(
      'code', 'batch_bootstrap_failed',
      'message', 'Late old failure',
      'retryable', true
    )
  );
  begin
    perform public.apply_stem_worker_callback(
      'f1000000-0000-4000-8000-000000000002', repeat('f', 64), v_payload
    );
    raise exception 'late old callback unexpectedly mutated the retry';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 10 - fresh active-attempt binding rejects callbacks from the failed attempt';

reset role;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.get_stem_inspection_retry_source(uuid,uuid,bigint)',
    'public.retry_stem_inspection(uuid,uuid,bigint,bigint,text)'
  ] loop
    if has_function_privilege('anon', v_signature, 'EXECUTE')
       or has_function_privilege('authenticated', v_signature, 'EXECUTE')
       or not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception '% must be service-role-only', v_signature;
    end if;
  end loop;
end;
$$;

select 'ok 11 - retry RPCs remain service-role-only';

rollback;
