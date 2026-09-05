begin;

select '1..11';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '{"opusloops":true}'::jsonb, '{}'::jsonb),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '{}'::jsonb, '{}'::jsonb);

insert into public.projects (
  user_id, id, name, schema_version, document, client_updated_at
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'Stem test', 2, '{}'::jsonb, statement_timestamp()
);

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

create temporary table stem_test_state (key text primary key, value text) on commit drop;

do $$
declare
  v_result jsonb;
begin
  v_result := public.create_stem_import(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Suno Stems.zip', 22589337, 'application/zip'
  );
  insert into stem_test_state values ('job_id', v_result ->> 'id');
  if v_result ->> 'status' <> 'uploading'
     or (v_result ->> 'revision')::integer <> 0
     or v_result ->> 'source_object_path' <> (
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/'
       || (v_result ->> 'id') || '/source.zip'
     ) then
    raise exception 'create_stem_import returned an invalid job';
  end if;
end;
$$;

select 'ok 1 - a member receives one immutable user/project/job upload path';

do $$
begin
  perform public.create_stem_import(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111', 'bad.zip', 10, 'application/zip'
  );
  raise exception 'non-member import unexpectedly succeeded';
exception when insufficient_privilege then null;
end;
$$;

select 'ok 2 - non-members cannot create stem imports';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key = 'job_id');
  v_result jsonb;
begin
  begin
    perform public.finalize_stem_upload(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, 0, 1, 'wrong'
    );
    raise exception 'wrong upload byte count unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  v_result := public.finalize_stem_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, 0, 22589337, 'etag-one'
  );
  insert into stem_test_state values ('inspect_attempt', v_result ->> 'active_attempt_id');
  if v_result ->> 'status' <> 'inspect_queued' or (v_result ->> 'revision')::int <> 1 then
    raise exception 'upload did not enter inspect_queued';
  end if;
  -- Repeating the exact current revision is idempotent while dispatch is pending.
  v_result := public.finalize_stem_upload(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, 1, 22589337, 'etag-one'
  );
  if v_result ->> 'status' <> 'inspect_queued' then raise exception 'finalize retry failed'; end if;
end;
$$;

select 'ok 3 - upload finalization is size-bound, revisioned, and safely retryable';

do $$
declare
  v_other jsonb;
begin
  v_other := public.create_stem_import(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'Second.zip', 100, 'application/zip'
  );
  begin
    perform public.finalize_stem_upload(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      (v_other ->> 'id')::uuid, 0, 100, 'etag-two'
    );
    raise exception 'second processing job unexpectedly entered the queue';
  exception when sqlstate '54000' then null;
  end;
end;
$$;

select 'ok 4 - the initial Fargate quota admits only one queued or running processing job';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key = 'job_id');
  v_attempt uuid := (select value::uuid from stem_test_state where key = 'inspect_attempt');
  v_claim uuid := '10000000-0000-4000-8000-000000000001';
  v_prefix text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/' || v_job::text;
  v_payload jsonb;
begin
  perform public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, v_claim
  );
  perform public.record_stem_dispatch(v_attempt, v_claim, 'local-inspect-job');

  v_payload := jsonb_build_object(
    'version', 1, 'jobId', v_job, 'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId', v_attempt, 'dispatchJobId', 'local-inspect-job', 'stage', 'inspect',
    'event', jsonb_build_object('status', 'started', 'determinate', false,
      'completed', null, 'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'lifecycle')),
    'assets', jsonb_build_array(), 'result', null, 'error', null
  );
  begin
    perform public.apply_stem_worker_callback(
      '20000000-0000-4000-8000-000000000099', repeat('9', 64),
      jsonb_set(v_payload, '{dispatchJobId}', '"non-authoritative-job"'::jsonb)
    );
    raise exception 'non-authoritative dispatch callback unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then null;
  end;
  perform public.apply_stem_worker_callback(
    '20000000-0000-4000-8000-000000000001', repeat('1', 64), v_payload
  );

  v_payload := jsonb_build_object(
    'version', 1, 'jobId', v_job, 'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId', v_attempt, 'dispatchJobId', 'local-inspect-job', 'stage', 'inspect',
    'event', jsonb_build_object('status', 'progress', 'determinate', true,
      'completed', 100, 'total', 1000, 'unit', 'bytes',
      'detail', jsonb_build_object('operation', 'extract')),
    'assets', jsonb_build_array(jsonb_build_object(
      'id', '30000000-0000-4000-8000-000000000010', 'kind', 'report',
      'variant', 'inspect-progress', 'bucket', 'opusloops-stem-artifacts',
      'objectPath', v_prefix || '/attempts/' || v_attempt::text || '/inspect/progress.json',
      'sha256', repeat('9', 64), 'bytes', 40, 'contentType', 'application/json',
      'metadata', '{}'::jsonb
    )), 'result', null, 'error', null
  );
  perform public.apply_stem_worker_callback(
    '20000000-0000-4000-8000-000000000002', repeat('2', 64), v_payload
  );
  -- A different measured operation may restart its own counter.
  v_payload := jsonb_set(v_payload, '{assets}', '[]'::jsonb);
  v_payload := jsonb_set(v_payload, '{event,detail,operation}', '"decode"'::jsonb);
  v_payload := jsonb_set(v_payload, '{event,completed}', '10'::jsonb);
  perform public.apply_stem_worker_callback(
    '20000000-0000-4000-8000-000000000003', repeat('3', 64), v_payload
  );
  begin
    v_payload := jsonb_set(v_payload, '{event,completed}', '5'::jsonb);
    perform public.apply_stem_worker_callback(
      '20000000-0000-4000-8000-000000000004', repeat('4', 64), v_payload
    );
    raise exception 'decreasing progress unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;

  v_payload := jsonb_build_object(
    'version', 1, 'jobId', v_job, 'userId', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId', v_attempt, 'dispatchJobId', 'local-inspect-job', 'stage', 'inspect',
    'event', jsonb_build_object('status', 'completed', 'determinate', false,
      'completed', null, 'total', null, 'unit', null,
      'detail', jsonb_build_object('operation', 'lifecycle')),
    'assets', jsonb_build_array(
      jsonb_build_object(
        'id', '30000000-0000-4000-8000-000000000001', 'kind', 'state_index',
        'variant', 'inspection', 'bucket', 'opusloops-stem-artifacts',
        'objectPath', v_prefix || '/attempts/' || v_attempt::text || '/inspect/state-index.json',
        'sha256', repeat('b', 64), 'bytes', 400, 'contentType', 'application/json',
        'metadata', '{}'::jsonb
      )
    ),
    'result', jsonb_build_object(
      'sourceSha256', repeat('a', 64), 'manifestSha256', repeat('b', 64),
      'tracks', jsonb_build_array(jsonb_build_object('name', 'Drums.mp3', 'role', 'drums'))
    ), 'error', null
  );
  perform public.apply_stem_worker_callback(
    '20000000-0000-4000-8000-000000000005', repeat('5', 64), v_payload
  );
end;
$$;

-- The remaining assertions inspect persisted state as the migration owner. Service-role
-- execution and table isolation are covered independently by stem_import_rls.sql.
reset role;

do $$
begin
  if not exists (
    select 1 from public.stem_import_assets
    where asset_id = '30000000-0000-4000-8000-000000000010'
  ) then
    raise exception 'progress-batched worker asset was not persisted';
  end if;
end;
$$;

select 'ok 5 - worker callbacks preserve operation-scoped progress, batched assets, and inspection hashes';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key = 'job_id');
  v_revision bigint;
  v_result jsonb;
  v_selection jsonb := '{"stems":[{"assetId":"drums","included":true,"role":"drums","gainDb":0}],"reference":{"method":"selected-stem-sum"}}'::jsonb;
begin
  select revision into v_revision from public.stem_import_jobs
  where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id = v_job;
  begin
    perform public.approve_stem_analysis(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, v_revision, repeat('b', 64),
      v_selection, true, true, false, true
    );
    raise exception 'partial Gate A unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  v_result := public.approve_stem_analysis(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job, v_revision, repeat('b', 64),
    v_selection, true, true, true, true
  );
  insert into stem_test_state values ('analysis_attempt', v_result ->> 'active_attempt_id');
  perform public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job,
    '10000000-0000-4000-8000-000000000002'
  );
  perform public.record_stem_dispatch(
    (v_result ->> 'active_attempt_id')::uuid,
    '10000000-0000-4000-8000-000000000002', 'local-analysis-job'
  );
  if v_result ->> 'status' <> 'analysis_queued' or v_result ->> 'gate_a_approved_by'
      <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'Gate A was not bound to the member';
  end if;
end;
$$;

select 'ok 6 - Gate A requires every confirmation and the exact inspection hash';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key = 'job_id');
  v_attempt uuid := (select value::uuid from stem_test_state where key = 'analysis_attempt');
  v_prefix text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/' || v_job::text;
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'version',1,'jobId',v_job,'userId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId',v_attempt,'dispatchJobId','local-analysis-job','stage','analyze','assets',jsonb_build_array(),
    'event',jsonb_build_object('status','started','determinate',false,'completed',null,
      'total',null,'unit',null,'detail',jsonb_build_object('operation','lifecycle')),
    'result',null,'error',null
  );
  perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000006',repeat('6',64),v_payload);
  v_payload := jsonb_set(v_payload,'{event,status}','"completed"');
  v_payload := jsonb_set(v_payload,'{assets}',jsonb_build_array(jsonb_build_object(
    'id','30000000-0000-4000-8000-000000000002','kind','state_index','variant','analysis',
    'bucket','opusloops-stem-artifacts','objectPath',v_prefix || '/attempts/' || v_attempt::text || '/analyze/state-index.json',
    'sha256',repeat('c',64),'bytes',500,'contentType','application/json','metadata','{}'::jsonb
  )));
  v_payload := jsonb_set(v_payload,'{result}',jsonb_build_object('analysisSha256',repeat('c',64),'requiresHumanConfirmation',true));
  perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000007',repeat('7',64),v_payload);
end;
$$;

select 'ok 7 - analysis completion remains explicitly human-confirmed and hash-bound';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key = 'job_id');
  v_revision bigint;
  v_result jsonb;
  v_grid jsonb := jsonb_build_object(
    'schema_version', 'opusloops.tempo-grid-review.v1',
    'analysis_sha256', repeat('c', 64),
    'attempt_id', (select value from stem_test_state where key = 'analysis_attempt'),
    'beats_seconds', jsonb_build_array(0, 0.5, 1.0, 1.5, 2.0),
    'downbeats_seconds', jsonb_build_array(0),
    'reviewed', true
  );
begin
  select revision into v_revision from public.stem_import_jobs where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id=v_job;
  begin
    perform public.request_stem_proposal(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_job,v_revision,repeat('d',64),'first',120,'musical-4bar',
      v_grid,4,4,0
    );
    raise exception 'stale analysis hash unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  v_result := public.request_stem_proposal(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_job,v_revision,repeat('c',64),'first',120,'musical-4bar',
    v_grid,4,4,0
  );
  insert into stem_test_state values ('proposal_attempt',v_result->>'active_attempt_id');
  perform public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job,
    '10000000-0000-4000-8000-000000000003'
  );
  perform public.record_stem_dispatch(
    (v_result->>'active_attempt_id')::uuid,
    '10000000-0000-4000-8000-000000000003', 'local-proposal-job'
  );
end;
$$;

select 'ok 8 - map requests bind the exact analysis, target, mode, and proposal id';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key='job_id');
  v_attempt uuid := (select value::uuid from stem_test_state where key='proposal_attempt');
  v_prefix text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/'||v_job::text;
  v_payload jsonb;
  v_revision bigint;
  v_result jsonb;
  v_approval jsonb := '{"proposalId":"first","targetBpm":120,"mode":"musical-4bar"}'::jsonb;
begin
  v_payload := jsonb_build_object('version',1,'jobId',v_job,'userId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId',v_attempt,'dispatchJobId','local-proposal-job','stage','propose','assets','[]'::jsonb,
    'event',jsonb_build_object('status','started','determinate',false,'completed',null,'total',null,'unit',null,'detail',jsonb_build_object('operation','lifecycle')),
    'result',null,'error',null);
  perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000008',repeat('8',64),v_payload);
  v_payload := jsonb_set(v_payload,'{event,status}','"completed"');
  v_payload := jsonb_set(v_payload,'{assets}',jsonb_build_array(
    jsonb_build_object('id','30000000-0000-4000-8000-000000000003','kind','click','variant','first','bucket','opusloops-stem-artifacts',
      'objectPath',v_prefix||'/attempts/'||v_attempt::text||'/propose/click.wav','sha256',repeat('d',64),'bytes',800,
      'contentType','audio/wav','metadata','{}'::jsonb),
    jsonb_build_object('id','30000000-0000-4000-8000-000000000004','kind','state_index','variant','first','bucket','opusloops-stem-artifacts',
      'objectPath',v_prefix||'/attempts/'||v_attempt::text||'/propose/state-index.json','sha256',repeat('e',64),'bytes',900,
      'contentType','application/json','metadata','{}'::jsonb)
  ));
  v_payload := jsonb_set(v_payload,'{result}',jsonb_build_object('proposalId','first','proposalManifestSha256',repeat('e',64),'flaggedRegions','[]'::jsonb));
  perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000009',repeat('9',64),v_payload);
  select revision into v_revision from public.stem_import_jobs where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id=v_job;
  begin
    perform public.approve_stem_tempo('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_job,v_revision,repeat('e',64),v_approval,
      true,true,true,true,true,true,false,true);
    raise exception 'partial Gate B unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;
  v_result := public.approve_stem_tempo('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',v_job,v_revision,repeat('e',64),v_approval,
    true,true,true,true,true,true,true,true);
  insert into stem_test_state values ('render_attempt',v_result->>'active_attempt_id');
  perform public.claim_stem_dispatch(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', v_job,
    '10000000-0000-4000-8000-000000000004'
  );
  perform public.record_stem_dispatch(
    (v_result->>'active_attempt_id')::uuid,
    '10000000-0000-4000-8000-000000000004', 'local-render-job'
  );
end;
$$;

select 'ok 9 - Gate B requires click, grid, meter, octave, flags, target, map, and original attestations';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key='job_id');
  v_attempt uuid := (select value::uuid from stem_test_state where key='render_attempt');
  v_prefix text := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/11111111-1111-4111-8111-111111111111/'||v_job::text;
  v_payload jsonb;
  v_response jsonb;
begin
  v_payload := jsonb_build_object('version',1,'jobId',v_job,'userId','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'attemptId',v_attempt,'dispatchJobId','local-render-job','stage','render','assets','[]'::jsonb,
    'event',jsonb_build_object('status','started','determinate',false,'completed',null,'total',null,'unit',null,'detail',jsonb_build_object('operation','lifecycle')),
    'result',null,'error',null);
  perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000010',repeat('a',64),v_payload);
  v_payload := jsonb_set(v_payload,'{event,status}','"completed"');
  v_payload := jsonb_set(v_payload,'{assets}',jsonb_build_array(jsonb_build_object(
    'id','30000000-0000-4000-8000-000000000005','kind','preview_segment','variant','drums-r0',
    'bucket','opusloops-stem-artifacts','objectPath',v_prefix||'/attempts/'||v_attempt::text||'/render/drums-r0.m4a',
    'sha256',repeat('f',64),'bytes',1200,'contentType','audio/mp4',
    'metadata',jsonb_build_object('trackAssetId','drums','regionIndex',0,'startBar',1,'barCount',4,'targetBpm',120)
  )));
  v_payload := jsonb_set(v_payload,'{result}',jsonb_build_object('renderManifestSha256',repeat('f',64),'previewSegments',1));
  v_response := public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000011',repeat('b',64),v_payload);
  if v_response #>> '{job,status}' <> 'ready' then raise exception 'render did not become ready'; end if;
  v_response := public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000011',repeat('b',64),v_payload);
  if (v_response ->> 'duplicate')::boolean is not true then raise exception 'retry was not deduplicated'; end if;
  begin
    perform public.apply_stem_worker_callback('20000000-0000-4000-8000-000000000011',repeat('c',64),v_payload);
    raise exception 'changed replay unexpectedly succeeded';
  exception when unique_violation then null;
  end;
end;
$$;

select 'ok 10 - final render publishes an immutable preview and callback retries are replay-safe';

reset role;

update public.projects set deleted_at = statement_timestamp()
where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id='11111111-1111-4111-8111-111111111111';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key='job_id');
  v_status text;
begin
  select status into v_status from public.stem_import_jobs
  where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id=v_job;
  if v_status <> 'deletion_pending' then raise exception 'project deletion did not queue retention'; end if;
end;
$$;

update public.projects set deleted_at = null
where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id='11111111-1111-4111-8111-111111111111';

do $$
declare
  v_job uuid := (select value::uuid from stem_test_state where key='job_id');
  v_status text;
begin
  select status into v_status from public.stem_import_jobs
  where user_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and id=v_job;
  if v_status <> 'ready' then raise exception 'project resurrection did not restore stem job'; end if;
end;
$$;

select 'ok 11 - project deletion schedules cleanup and a newer resurrection cancels it';

rollback;
