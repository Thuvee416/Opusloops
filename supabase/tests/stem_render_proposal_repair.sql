begin;

select '1..10';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values (
  'a3000000-0000-4000-8000-000000000001',
  '{"opusloops":true}'::jsonb,
  '{}'::jsonb
);

insert into public.projects (
  user_id, id, name, schema_version, document, client_updated_at
) values (
  'a3000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000001',
  'Render proposal repair tests', 2, '{}'::jsonb, statement_timestamp()
);

create temporary table stem_render_repair_fixtures (
  job_id uuid primary key,
  attempt_id uuid not null,
  ordinal integer not null,
  job_status text not null,
  error_code text not null,
  attempt_stage text not null,
  recovery_expires_at timestamptz not null
) on commit drop;

insert into stem_render_repair_fixtures values
  (
    'c3000000-0000-4000-8000-000000000001',
    'd3000000-0000-4000-8000-000000000001',
    1, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000002',
    'd3000000-0000-4000-8000-000000000002',
    2, 'failed', 'internal_worker_error', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000003',
    'd3000000-0000-4000-8000-000000000003',
    3, 'failed', 'tempo_map_preroll_invalid', 'analyze',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000004',
    'd3000000-0000-4000-8000-000000000004',
    4, 'cancelled', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000005',
    'd3000000-0000-4000-8000-000000000005',
    5, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() - interval '1 second'
  ),
  (
    'c3000000-0000-4000-8000-000000000006',
    'd3000000-0000-4000-8000-000000000006',
    6, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000007',
    'd3000000-0000-4000-8000-000000000007',
    7, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000008',
    'd3000000-0000-4000-8000-000000000008',
    8, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000009',
    'd3000000-0000-4000-8000-000000000009',
    9, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000010',
    'd3000000-0000-4000-8000-000000000010',
    10, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000011',
    'd3000000-0000-4000-8000-000000000011',
    11, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  ),
  (
    'c3000000-0000-4000-8000-000000000012',
    'd3000000-0000-4000-8000-000000000012',
    12, 'failed', 'tempo_map_preroll_invalid', 'render',
    statement_timestamp() + interval '1 day'
  );

with timing as (
  select jsonb_build_object(
    'schema_version', 'opusloops.tempo-grid-review.v1',
    'analysis_sha256', repeat('a', 64),
    'reviewed', true,
    'beats_seconds', jsonb_build_array(0.02, 0.57, 1.12, 1.67, 2.22),
    'downbeats_seconds', jsonb_build_array(0.02),
    'notes', 'Approved timing fixture'
  ) as reviewed_grid
), selection as (
  select jsonb_build_object(
    'stems', jsonb_build_array(
      jsonb_build_object(
        'assetId', 'drums', 'included', true, 'role', 'drums', 'gainDb', 0
      )
    ),
    'reference', jsonb_build_object('method', 'selected-stem-sum')
  ) as value
)
insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path, source_storage_etag, source_sha256,
  inspection_manifest_sha256, inspection, analysis_selection,
  analysis_selection_sha256, gate_a_approved_at, gate_a_approved_by,
  analysis_sha256, analysis, proposal_id, target_bpm, conform_mode,
  reviewed_grid, reviewed_grid_sha256, meter_numerator, meter_denominator,
  first_downbeat_seconds, proposal_manifest_sha256, proposal,
  tempo_approval, tempo_approval_sha256, gate_b_approved_at,
  gate_b_approved_by, active_attempt_id, aws_job_id, error_code,
  error_message, recovery_expires_at
)
select
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  'b3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_status,
  20,
  'render-repair-' || fixture.ordinal::text || '.zip',
  100,
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/source.zip',
  'source-etag-' || fixture.ordinal::text,
  repeat('f', 64),
  repeat('e', 64),
  jsonb_build_object('manifestSha256', repeat('e', 64)),
  selection.value,
  private.opusloops_stem_json_sha256(selection.value),
  statement_timestamp() - interval '1 hour',
  'a3000000-0000-4000-8000-000000000001'::uuid,
  repeat('a', 64),
  jsonb_build_object('analysisSha256', repeat('a', 64)),
  'old-proposal-' || pg_catalog.lpad(fixture.ordinal::text, 2, '0'),
  109,
  'musical-4bar',
  timing.reviewed_grid,
  private.opusloops_stem_json_sha256(jsonb_build_object(
    'reviewedGrid', timing.reviewed_grid,
    'meterNumerator', 4,
    'meterDenominator', 4,
    'firstDownbeatSeconds', 0.02::numeric
  )),
  4,
  4,
  0.02,
  repeat('b', 64),
  jsonb_build_object(
    'proposalId', 'old-proposal-' || pg_catalog.lpad(fixture.ordinal::text, 2, '0'),
    'proposalManifestSha256', repeat('b', 64)
  ),
  jsonb_build_object(
    'proposalId', 'old-proposal-' || pg_catalog.lpad(fixture.ordinal::text, 2, '0'),
    'reviewedRegions', jsonb_build_array()
  ),
  private.opusloops_stem_json_sha256(jsonb_build_object(
    'proposalId', 'old-proposal-' || pg_catalog.lpad(fixture.ordinal::text, 2, '0'),
    'reviewedRegions', jsonb_build_array()
  )),
  statement_timestamp() - interval '30 minutes',
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.attempt_id,
  'old-render-' || fixture.ordinal::text,
  fixture.error_code,
  'The approved tempo map needs a compatibility update before rendering.',
  fixture.recovery_expires_at
from stem_render_repair_fixtures as fixture
cross join timing
cross join selection;

insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, external_job_id,
  dispatch_job_name, dispatched_at, started_at, finished_at
)
select
  fixture.attempt_id,
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  fixture.attempt_stage,
  18,
  'failed',
  'old-render-' || fixture.ordinal::text,
  'opusloops-' || fixture.attempt_stage || '-c3000000-d3000000',
  statement_timestamp() - interval '3 minutes',
  statement_timestamp() - interval '2 minutes',
  statement_timestamp() - interval '1 minute'
from stem_render_repair_fixtures as fixture;

insert into public.stem_import_events (
  user_id, job_id, sequence, attempt_id, stage, status, determinate,
  completed, total, unit, detail
)
select
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  1,
  fixture.attempt_id,
  fixture.attempt_stage,
  'failed',
  false,
  null,
  null,
  null,
  jsonb_build_object('operation', 'fixture-failure')
from stem_render_repair_fixtures as fixture;

insert into storage.objects (bucket_id, name, owner_id, metadata)
select
  'opusloops-stem-uploads',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/source.zip',
  'a3000000-0000-4000-8000-000000000001',
  '{"size":100}'::jsonb
from stem_render_repair_fixtures as fixture
where fixture.ordinal <> 7;

-- Retain the analysis and old proposal states. Fixture 12 deliberately lacks
-- the analysis state so the repair cannot reconstruct its proposal.
insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
)
select
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  gen_random_uuid(),
  'state_index',
  'analysis',
  'opusloops-stem-artifacts',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/attempts/a3000000-0000-4000-8000-000000000099/'
    || 'analyze/state-index.json',
  repeat('c', 64),
  500,
  'application/json'
from stem_render_repair_fixtures as fixture
where fixture.ordinal <> 12;

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
)
select
  'a3000000-0000-4000-8000-000000000001'::uuid,
  fixture.job_id,
  gen_random_uuid(),
  'state_index',
  'old-proposal-' || pg_catalog.lpad(fixture.ordinal::text, 2, '0'),
  'opusloops-stem-artifacts',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || fixture.job_id::text || '/attempts/a3000000-0000-4000-8000-000000000098/'
    || 'propose/state-index.json',
  repeat('d', 64),
  600,
  'application/json'
from stem_render_repair_fixtures as fixture;

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'a3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001',
  'click',
  'old-proposal-01',
  'opusloops-stem-artifacts',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000001/attempts/'
    || 'a3000000-0000-4000-8000-000000000098/propose/click.m4a',
  repeat('1', 64),
  700,
  'audio/mp4'
);

insert into private.stem_retention_items (
  user_id, job_id, subject_type, reason, bucket, object_path
) values (
  'a3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000006',
  'archive',
  'recovery_expired',
  'opusloops-stem-uploads',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000006/source.zip'
);

insert into public.stem_import_assets (
  user_id, job_id, asset_id, kind, variant, bucket, object_path,
  sha256, bytes, content_type
) values (
  'a3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000008',
  'e3000000-0000-4000-8000-000000000008',
  'report',
  'event-journal',
  'opusloops-stem-artifacts',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000008/attempts/'
    || 'd3000000-0000-4000-8000-000000000008/render/events.jsonl',
  repeat('2', 64),
  50,
  'application/x-ndjson'
);

update public.stem_import_jobs
set render_manifest_sha256 = repeat('3', 64),
    render_result = jsonb_build_object('renderManifestSha256', repeat('3', 64))
where id = 'c3000000-0000-4000-8000-000000000009';

insert into storage.objects (bucket_id, name, owner_id, metadata)
values (
  'opusloops-stem-artifacts',
  'a3000000-0000-4000-8000-000000000001/b3000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000010/attempts/'
    || 'd3000000-0000-4000-8000-000000000010/render/orphan.wav',
  'a3000000-0000-4000-8000-000000000001',
  '{"size":50}'::jsonb
);

-- Fixture 11 points at a failed render that is no longer its latest attempt.
insert into private.stem_job_attempts (
  id, user_id, job_id, stage, job_revision, state, finished_at
) values (
  'e3000000-0000-4000-8000-000000000011',
  'a3000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000011',
  'propose',
  19,
  'failed',
  statement_timestamp()
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000001',
      19,
      repeat('b', 64)
    );
    raise exception 'stale revision unexpectedly repaired';
  exception when serialization_failure then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000001',
      20,
      repeat('9', 64)
    );
    raise exception 'stale proposal hash unexpectedly repaired';
  exception when invalid_parameter_value then null;
  end;
end;
$$;

select 'ok 1 - repair is bound to the exact job revision and approved proposal hash';

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000002', 20, repeat('b', 64)
    );
    raise exception 'wrong error code unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000004', 20, repeat('b', 64)
    );
    raise exception 'wrong job status unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 2 - only the allowlisted failed job state is repairable';

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000003', 20, repeat('b', 64)
    );
    raise exception 'wrong active stage unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000011', 20, repeat('b', 64)
    );
    raise exception 'non-latest render attempt unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 3 - repair requires the active latest failed render attempt and event';

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000007', 20, repeat('b', 64)
    );
    raise exception 'missing source unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000012', 20, repeat('b', 64)
    );
    raise exception 'missing analysis state unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 4 - repair requires retained source and analysis state';

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000005', 20, repeat('b', 64)
    );
    raise exception 'expired recovery unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000006', 20, repeat('b', 64)
    );
    raise exception 'cleanup-started recovery unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 5 - expired recovery and any retention record fence repair';

do $$
begin
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000008', 20, repeat('b', 64)
    );
    raise exception 'registered partial render unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000009', 20, repeat('b', 64)
    );
    raise exception 'render result unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
  begin
    perform public.repair_stem_render_proposal(
      'a3000000-0000-4000-8000-000000000001',
      'c3000000-0000-4000-8000-000000000010', 20, repeat('b', 64)
    );
    raise exception 'unregistered render object unexpectedly repaired';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 6 - any persisted result, registered asset, or orphan render object blocks repair';

do $$
declare
  v_result jsonb;
  v_old_attempt uuid := 'd3000000-0000-4000-8000-000000000001';
  v_new_attempt uuid;
  v_new_proposal text;
begin
  v_result := public.repair_stem_render_proposal(
    'a3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001', 20, repeat('b', 64)
  );
  v_new_attempt := (v_result ->> 'active_attempt_id')::uuid;
  v_new_proposal := v_result ->> 'proposal_id';

  if v_result ->> 'status' <> 'proposal_queued'
     or (v_result ->> 'revision')::bigint <> 21
     or v_new_proposal !~ '^repair-[0-9a-f]{32}$'
     or v_new_proposal = 'old-proposal-01'
     or v_new_attempt = v_old_attempt
     or v_result ->> 'target_bpm' <> '109.000'
     or v_result ->> 'conform_mode' <> 'musical-4bar'
     or v_result -> 'reviewed_grid' ->> 'notes' <> 'Approved timing fixture'
     or v_result ->> 'analysis_sha256' <> repeat('a', 64)
     or v_result ->> 'gate_a_approved_by'
       <> 'a3000000-0000-4000-8000-000000000001'
     or v_result ->> 'proposal_manifest_sha256' is not null
     or v_result ->> 'proposal' is not null
     or v_result ->> 'tempo_approval' is not null
     or v_result ->> 'tempo_approval_sha256' is not null
     or v_result ->> 'gate_b_approved_at' is not null
     or v_result ->> 'gate_b_approved_by' is not null
     or v_result ->> 'render_manifest_sha256' is not null
     or v_result ->> 'render_result' is not null
     or v_result ->> 'archive_delete_after' is not null
     or v_result ->> 'aws_job_id' is not null
     or v_result ->> 'error_code' is not null
     or v_result ->> 'error_message' is not null then
    raise exception 'successful repair returned an invalid job: %', v_result;
  end if;

  reset role;
  if (select state from private.stem_job_attempts where id = v_old_attempt) <> 'failed'
     or (select state from private.stem_job_attempts where id = v_new_attempt)
       <> 'pending_dispatch'
     or (select stage from private.stem_job_attempts where id = v_new_attempt) <> 'propose'
     or (select job_revision from private.stem_job_attempts where id = v_new_attempt) <> 21
     or (select count(*) from private.stem_job_attempts
         where job_id = 'c3000000-0000-4000-8000-000000000001') <> 2
     or (select count(*) from public.stem_import_assets
         where job_id = 'c3000000-0000-4000-8000-000000000001'
           and deleted_at is null) <> 3
     or not exists (
       select 1 from public.stem_import_assets
       where job_id = 'c3000000-0000-4000-8000-000000000001'
         and kind = 'click' and variant = 'old-proposal-01'
         and deleted_at is null
     )
     or not exists (
       select 1 from public.stem_import_events
       where job_id = 'c3000000-0000-4000-8000-000000000001'
         and attempt_id = v_new_attempt
         and stage = 'dispatch' and status = 'started'
         and detail ->> 'operation' = 'repair-render-proposal'
         and detail ->> 'proposalId' = v_new_proposal
         and detail ->> 'previousProposalId' = 'old-proposal-01'
     ) then
    raise exception 'repair did not preserve history or create one fresh proposal attempt';
  end if;
  set local role service_role;
end;
$$;

select 'ok 7 - repair preserves Gate A and immutable assets while clearing Gate B and render state';

do $$
declare
  v_dispatch jsonb;
  v_active_attempt uuid;
  v_proposal_id text;
begin
  reset role;
  select active_attempt_id, proposal_id into v_active_attempt, v_proposal_id
  from public.stem_import_jobs
  where id = 'c3000000-0000-4000-8000-000000000001';
  set local role service_role;

  v_dispatch := public.claim_stem_dispatch(
    'a3000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'f3000000-0000-4000-8000-000000000001'
  );
  if (v_dispatch ->> 'dispatchClaimed')::boolean is not true
     or v_dispatch ->> 'stage' <> 'propose'
     or v_dispatch ->> 'attemptId' <> v_active_attempt::text
     or v_dispatch -> 'inputs' ->> 'proposalId' <> v_proposal_id
     or (v_dispatch -> 'inputs' ->> 'targetBpm')::numeric <> 109
     or v_dispatch -> 'inputs' ->> 'mode' <> 'musical-4bar'
     or v_dispatch -> 'inputs' -> 'analysis' is null
     or v_dispatch -> 'inputs' -> 'reviewedGrid' ->> 'notes'
       <> 'Approved timing fixture'
     or (v_dispatch -> 'inputs' ->> 'meterNumerator')::integer <> 4
     or (v_dispatch -> 'inputs' ->> 'meterDenominator')::integer <> 4
     or (v_dispatch -> 'inputs' ->> 'firstDownbeatSeconds')::numeric <> 0.02
     or v_dispatch -> 'inputs' ->> 'proposal' is not null
     or v_dispatch -> 'inputs' ->> 'approval' is not null then
    raise exception 'repaired dispatch lost or leaked proposal inputs: %', v_dispatch;
  end if;
end;
$$;

select 'ok 8 - the repaired attempt dispatches only retained analysis and reviewed timing inputs';

do $$
declare
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'version', 1,
    'jobId', 'c3000000-0000-4000-8000-000000000001',
    'userId', 'a3000000-0000-4000-8000-000000000001',
    'attemptId', 'd3000000-0000-4000-8000-000000000001',
    'dispatchJobId', 'old-render-1',
    'stage', 'render',
    'event', jsonb_build_object(
      'status', 'failed', 'determinate', false,
      'completed', null, 'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'late-old-render')
    ),
    'assets', '[]'::jsonb,
    'result', null,
    'error', jsonb_build_object(
      'code', 'tempo_map_preroll_invalid',
      'message', 'Late old render failure',
      'retryable', false
    )
  );
  begin
    perform public.apply_stem_worker_callback(
      'f3000000-0000-4000-8000-000000000002', repeat('f', 64), v_payload
    );
    raise exception 'late old render callback unexpectedly mutated the repair';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select 'ok 9 - active-attempt binding rejects callbacks from the old failed render';

reset role;

do $$
begin
  if has_function_privilege(
       'anon',
       'public.repair_stem_render_proposal(uuid,uuid,bigint,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.repair_stem_render_proposal(uuid,uuid,bigint,text)',
       'EXECUTE'
     )
     or not has_function_privilege(
       'service_role',
       'public.repair_stem_render_proposal(uuid,uuid,bigint,text)',
       'EXECUTE'
     ) then
    raise exception 'repair_stem_render_proposal must be service-role-only';
  end if;
end;
$$;

select 'ok 10 - render proposal repair remains service-role-only';

rollback;
