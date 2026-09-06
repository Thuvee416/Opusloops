begin;

select '1..9';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values (
  'a2000000-0000-4000-8000-000000000001',
  '{"opusloops":true}'::jsonb,
  '{}'::jsonb
);

insert into public.projects (
  user_id, id, name, schema_version, document, client_updated_at
) values (
  'a2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'Proposal retry tests', 2, '{}'::jsonb, statement_timestamp()
);

with timing as (
  select jsonb_build_object(
    'schema_version', 'opusloops.tempo-grid-review.v1',
    'analysis_sha256', repeat('a', 64),
    'reviewed', true,
    'beats_seconds', jsonb_build_array(0, 0.5, 1, 1.5, 2),
    'downbeats_seconds', jsonb_build_array(0),
    'notes', 'Approved timing fixture'
  ) as reviewed_grid
), fixtures as (
  select * from (values
    (
      'c2000000-0000-4000-8000-000000000001'::uuid,
      'd2000000-0000-4000-8000-000000000001'::uuid,
      'callback_failed', 'propose'
    ),
    (
      'c2000000-0000-4000-8000-000000000002'::uuid,
      'd2000000-0000-4000-8000-000000000002'::uuid,
      'internal_worker_error', 'propose'
    ),
    (
      'c2000000-0000-4000-8000-000000000003'::uuid,
      'd2000000-0000-4000-8000-000000000003'::uuid,
      'callback_failed', 'analyze'
    ),
    (
      'c2000000-0000-4000-8000-000000000004'::uuid,
      'd2000000-0000-4000-8000-000000000004'::uuid,
      'callback_failed', 'propose'
    ),
    (
      'c2000000-0000-4000-8000-000000000005'::uuid,
      'd2000000-0000-4000-8000-000000000005'::uuid,
      'callback_failed', 'propose'
    )
  ) as value(job_id, attempt_id, error_code, stage)
)
insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path, source_sha256, analysis_sha256, analysis,
  gate_a_approved_at, gate_a_approved_by, proposal_id, target_bpm,
  conform_mode, reviewed_grid, reviewed_grid_sha256, meter_numerator,
  meter_denominator, first_downbeat_seconds, active_attempt_id, aws_job_id,
  error_code, error_message, recovery_expires_at
)
select
  'a2000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  'b2000000-0000-4000-8000-000000000001'::uuid,
  'failed', 9, 'proposal-' || right(fixture.job_id::text, 1) || '.zip', 100,
  'a2000000-0000-4000-8000-000000000001/b2000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/source.zip',
  repeat('f', 64), repeat('a', 64), '{}'::jsonb,
  statement_timestamp(), 'a2000000-0000-4000-8000-000000000001'::uuid,
  'retry-proposal-v1', 120, 'musical-4bar', timing.reviewed_grid,
  private.opusloops_stem_json_sha256(jsonb_build_object(
    'reviewedGrid', timing.reviewed_grid,
    'meterNumerator', 4,
    'meterDenominator', 4,
    'firstDownbeatSeconds', 0::numeric
  )),
  4, 4, 0, fixture.attempt_id, 'old-' || fixture.job_id::text,
  fixture.error_code, 'Synthetic proposal failure',
  statement_timestamp() + interval '1 day'
from fixtures as fixture
cross join timing;

insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, external_job_id, finished_at
)
select
  fixture.attempt_id,
  'a2000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  fixture.stage,
  4,
  'failed',
  'old-' || fixture.job_id::text,
  statement_timestamp()
from (values
  ('c2000000-0000-4000-8000-000000000001'::uuid, 'd2000000-0000-4000-8000-000000000001'::uuid, 'propose'),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 'd2000000-0000-4000-8000-000000000002'::uuid, 'propose'),
  ('c2000000-0000-4000-8000-000000000003'::uuid, 'd2000000-0000-4000-8000-000000000003'::uuid, 'analyze'),
  ('c2000000-0000-4000-8000-000000000004'::uuid, 'd2000000-0000-4000-8000-000000000004'::uuid, 'propose'),
  ('c2000000-0000-4000-8000-000000000005'::uuid, 'd2000000-0000-4000-8000-000000000005'::uuid, 'propose')
) as fixture(job_id, attempt_id, stage);

-- Every fixture except c...004 retains the accepted analysis state needed to
-- reconstruct a proposal. c...005 also has a partially registered old output.
insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
)
select
  'a2000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  fixture.asset_id,
  'state_index', 'analysis', 'opusloops-stem-artifacts',
  'a2000000-0000-4000-8000-000000000001/b2000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/attempts/e2000000-0000-4000-8000-000000000001/analyze/state/index.json',
  repeat('b', 64), 1, 'application/json'
from (values
  ('c2000000-0000-4000-8000-000000000001'::uuid, 'e2000000-0000-4000-8000-000000000011'::uuid),
  ('c2000000-0000-4000-8000-000000000002'::uuid, 'e2000000-0000-4000-8000-000000000012'::uuid),
  ('c2000000-0000-4000-8000-000000000003'::uuid, 'e2000000-0000-4000-8000-000000000013'::uuid),
  ('c2000000-0000-4000-8000-000000000005'::uuid, 'e2000000-0000-4000-8000-000000000015'::uuid)
) as fixture(job_id, asset_id);

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'a2000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000005',
  'e2000000-0000-4000-8000-000000000025',
  'report', 'event-journal', 'opusloops-stem-artifacts',
  'a2000000-0000-4000-8000-000000000001/b2000000-0000-4000-8000-000000000001/c2000000-0000-4000-8000-000000000005/attempts/d2000000-0000-4000-8000-000000000005/propose/events.jsonl',
  repeat('c', 64), 1, 'application/x-ndjson'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
begin
  begin
    perform public.retry_stem_proposal(
      'a2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000002', 9
    );
    raise exception 'non-callback failure unexpectedly retried';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 1 - retry requires error_code callback_failed';

do $$
begin
  begin
    perform public.retry_stem_proposal(
      'a2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000003', 9
    );
    raise exception 'failed analyze attempt unexpectedly retried';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 2 - retry requires the active failed attempt to be propose';

do $$
begin
  begin
    perform public.retry_stem_proposal(
      'a2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000004', 9
    );
    raise exception 'missing analysis state unexpectedly retried';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 3 - retry requires the retained analysis state';

do $$
begin
  begin
    perform public.retry_stem_proposal(
      'a2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000005', 9
    );
    raise exception 'partially registered proposal unexpectedly retried';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 4 - retry refuses a partially registered failed-attempt publish';

do $$
begin
  begin
    perform public.retry_stem_proposal(
      'a2000000-0000-4000-8000-000000000001',
      'c2000000-0000-4000-8000-000000000001', 8
    );
    raise exception 'stale revision unexpectedly retried';
  exception when serialization_failure then null;
  end;
end;
$$;

select 'ok 5 - retry remains revision-bound';

do $$
declare
  v_result jsonb;
  v_old_attempt uuid := 'd2000000-0000-4000-8000-000000000001';
  v_new_attempt uuid;
begin
  v_result := public.retry_stem_proposal(
    'a2000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001', 9
  );
  v_new_attempt := (v_result ->> 'active_attempt_id')::uuid;

  if v_result ->> 'status' <> 'proposal_queued'
     or (v_result ->> 'revision')::bigint <> 10
     or v_new_attempt = v_old_attempt
     or v_result ->> 'error_code' is not null
     or v_result ->> 'aws_job_id' is not null
     or v_result ->> 'proposal_id' <> 'retry-proposal-v1'
     or (v_result ->> 'target_bpm')::numeric <> 120
     or v_result ->> 'conform_mode' <> 'musical-4bar'
     or v_result -> 'reviewed_grid' ->> 'notes' <> 'Approved timing fixture'
     or (v_result ->> 'meter_numerator')::integer <> 4
     or (v_result ->> 'meter_denominator')::integer <> 4
     or (v_result ->> 'first_downbeat_seconds')::numeric <> 0 then
    raise exception 'retry did not preserve the reviewed proposal: %', v_result;
  end if;

  reset role;
  if (select state from private.stem_job_attempts where id = v_old_attempt) <> 'failed'
     or (select state from private.stem_job_attempts where id = v_new_attempt) <> 'pending_dispatch'
     or (select stage from private.stem_job_attempts where id = v_new_attempt) <> 'propose'
     or (select job_revision from private.stem_job_attempts where id = v_new_attempt) <> 10
     or (select count(*) from private.stem_job_attempts
         where job_id = 'c2000000-0000-4000-8000-000000000001') <> 2
     or not exists (
       select 1 from public.stem_import_events
       where job_id = 'c2000000-0000-4000-8000-000000000001'
         and attempt_id = v_new_attempt
         and stage = 'dispatch' and status = 'started'
         and detail ->> 'operation' = 'retry-proposal'
         and detail ->> 'proposalId' = 'retry-proposal-v1'
     ) then
    raise exception 'retry attempt or audit event is invalid';
  end if;
  set local role service_role;
end;
$$;

select 'ok 6 - retry preserves timing and creates one fresh proposal attempt';

do $$
declare
  v_dispatch jsonb;
  v_new_attempt uuid;
begin
  reset role;
  select active_attempt_id into v_new_attempt
  from public.stem_import_jobs
  where id = 'c2000000-0000-4000-8000-000000000001';
  set local role service_role;

  v_dispatch := public.claim_stem_dispatch(
    'a2000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000001'
  );
  if (v_dispatch ->> 'dispatchClaimed')::boolean is not true
     or v_dispatch ->> 'stage' <> 'propose'
     or v_dispatch ->> 'attemptId' <> v_new_attempt::text
     or v_dispatch -> 'inputs' ->> 'proposalId' <> 'retry-proposal-v1'
     or (v_dispatch -> 'inputs' ->> 'targetBpm')::numeric <> 120
     or v_dispatch -> 'inputs' ->> 'mode' <> 'musical-4bar'
     or v_dispatch -> 'inputs' -> 'reviewedGrid' ->> 'notes' <> 'Approved timing fixture'
     or (v_dispatch -> 'inputs' ->> 'meterNumerator')::integer <> 4
     or (v_dispatch -> 'inputs' ->> 'meterDenominator')::integer <> 4
     or (v_dispatch -> 'inputs' ->> 'firstDownbeatSeconds')::numeric <> 0 then
    raise exception 'retry dispatch payload lost reviewed inputs: %', v_dispatch;
  end if;
end;
$$;

select 'ok 7 - the fresh attempt dispatches with the preserved proposal contract';

do $$
declare
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'version', 1,
    'jobId', 'c2000000-0000-4000-8000-000000000001',
    'userId', 'a2000000-0000-4000-8000-000000000001',
    'attemptId', 'd2000000-0000-4000-8000-000000000001',
    'dispatchJobId', 'old-c2000000-0000-4000-8000-000000000001',
    'stage', 'propose',
    'event', jsonb_build_object(
      'status', 'failed', 'determinate', false,
      'completed', null, 'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'late-old-proposal')
    ),
    'assets', '[]'::jsonb,
    'result', null,
    'error', jsonb_build_object(
      'code', 'callback_failed',
      'message', 'Late old failure',
      'retryable', false
    )
  );
  begin
    perform public.apply_stem_worker_callback(
      'f2000000-0000-4000-8000-000000000002', repeat('f', 64), v_payload
    );
    raise exception 'late old callback unexpectedly mutated the retry';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 8 - fresh active-attempt binding rejects callbacks from the failed attempt';

reset role;

do $$
begin
  if has_function_privilege(
       'anon', 'public.retry_stem_proposal(uuid,uuid,bigint)', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.retry_stem_proposal(uuid,uuid,bigint)', 'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', 'public.retry_stem_proposal(uuid,uuid,bigint)', 'EXECUTE'
     ) then
    raise exception 'retry_stem_proposal must be service-role-only';
  end if;
end;
$$;

select 'ok 9 - retry RPC remains service-role-only';

rollback;
