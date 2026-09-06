begin;

select '1..4';

insert into auth.users (id, raw_app_meta_data, raw_user_meta_data)
values
  (
    'a4000000-0000-4000-8000-000000000001',
    '{"opusloops":true}'::jsonb,
    '{}'::jsonb
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    '{"opusloops":true}'::jsonb,
    '{}'::jsonb
  );

insert into public.projects (
  user_id, id, name, schema_version, document, client_updated_at
) values
  (
    'a4000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000001',
    'Snapshot owner A', 2, '{}'::jsonb, statement_timestamp()
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    'b4000000-0000-4000-8000-000000000002',
    'Snapshot owner B', 2, '{}'::jsonb, statement_timestamp()
  );

insert into public.stem_import_jobs (
  user_id, id, project_id, status, revision, source_name, source_bytes,
  source_object_path
) values
  (
    'a4000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'b4000000-0000-4000-8000-000000000001',
    'uploading', 17, 'snapshot-a.zip', 250,
    'a4000000-0000-4000-8000-000000000001/b4000000-0000-4000-8000-000000000001/'
      || 'c4000000-0000-4000-8000-000000000001/source.zip'
  ),
  (
    'a4000000-0000-4000-8000-000000000002',
    'c4000000-0000-4000-8000-000000000002',
    'b4000000-0000-4000-8000-000000000002',
    'uploading', 3, 'snapshot-b.zip', 1,
    'a4000000-0000-4000-8000-000000000002/b4000000-0000-4000-8000-000000000002/'
      || 'c4000000-0000-4000-8000-000000000002/source.zip'
  );

insert into public.stem_import_events (
  user_id, job_id, sequence, stage, status, determinate,
  completed, total, unit, detail
)
select
  'a4000000-0000-4000-8000-000000000001'::uuid,
  'c4000000-0000-4000-8000-000000000001'::uuid,
  value,
  'upload',
  'progress',
  true,
  value,
  250,
  'files',
  jsonb_build_object('ordinal', value)
from generate_series(1, 250) as value;

insert into public.stem_import_events (
  user_id, job_id, sequence, stage, status, determinate,
  completed, total, unit, detail
) values (
  'a4000000-0000-4000-8000-000000000002',
  'c4000000-0000-4000-8000-000000000002',
  1, 'upload', 'started', true, 0, 1, 'files',
  jsonb_build_object('owner', 'B')
);

select set_config('request.jwt.claim.sub', 'a4000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-000000000001","role":"authenticated","app_metadata":{"opusloops":true}}',
  true
);
set local role authenticated;

do $$
declare
  v_snapshot jsonb;
begin
  v_snapshot := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000001', 0
  );
  if v_snapshot is null
     or v_snapshot #>> '{job,id}' <> 'c4000000-0000-4000-8000-000000000001'
     or v_snapshot #>> '{job,user_id}' <> 'a4000000-0000-4000-8000-000000000001'
     or (v_snapshot #>> '{job,revision}')::bigint <> 17
     or jsonb_typeof(v_snapshot -> 'events') <> 'array'
     or v_snapshot ? 'assets' then
    raise exception 'owned atomic snapshot has the wrong shape: %', v_snapshot;
  end if;
end;
$$;

reset role;
select 'ok 1 - an owner receives one job and events snapshot without assets';
set local role authenticated;

do $$
declare
  v_snapshot jsonb;
  v_is_ordered boolean;
begin
  v_snapshot := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000001', 0
  );
  select bool_and((entry.value ->> 'sequence')::bigint = entry.ordinality + 50)
  into v_is_ordered
  from jsonb_array_elements(v_snapshot -> 'events') with ordinality
    as entry(value, ordinality);

  if jsonb_array_length(v_snapshot -> 'events') <> 200
     or not coalesce(v_is_ordered, false)
     or (v_snapshot #>> '{events,0,sequence}')::bigint <> 51
     or (v_snapshot #>> '{events,199,sequence}')::bigint <> 250 then
    raise exception 'snapshot cap or chronological order is invalid';
  end if;
end;
$$;

reset role;
select 'ok 2 - snapshots return the latest 200 events in ascending sequence order';
set local role authenticated;

do $$
declare
  v_snapshot jsonb;
begin
  v_snapshot := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000001', 247
  );
  if jsonb_array_length(v_snapshot -> 'events') <> 3
     or (v_snapshot #>> '{events,0,sequence}')::bigint <> 248
     or (v_snapshot #>> '{events,1,sequence}')::bigint <> 249
     or (v_snapshot #>> '{events,2,sequence}')::bigint <> 250 then
    raise exception 'event cursor did not return only newer events: %', v_snapshot;
  end if;

  v_snapshot := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000001', 250
  );
  if v_snapshot #>> '{job,id}' <> 'c4000000-0000-4000-8000-000000000001'
     or v_snapshot -> 'events' <> '[]'::jsonb then
    raise exception 'empty event cursor lost its owned job: %', v_snapshot;
  end if;
end;
$$;

reset role;
select 'ok 3 - after_sequence filters events while retaining the current job row';

select set_config('request.jwt.claim.sub', 'a4000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"a4000000-0000-4000-8000-000000000002","role":"authenticated","app_metadata":{"opusloops":true}}',
  true
);
set local role authenticated;

do $$
declare
  v_foreign jsonb;
  v_owned jsonb;
begin
  v_foreign := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000001', 0
  );
  v_owned := public.get_stem_import_event_snapshot(
    'c4000000-0000-4000-8000-000000000002', 0
  );
  if v_foreign is not null
     or v_owned #>> '{job,user_id}' <> 'a4000000-0000-4000-8000-000000000002'
     or jsonb_array_length(v_owned -> 'events') <> 1
     or v_owned #>> '{events,0,detail,owner}' <> 'B' then
    raise exception 'snapshot ownership isolation failed';
  end if;
end;
$$;

reset role;
select 'ok 4 - explicit auth.uid ownership prevents cross-user snapshot reads';

rollback;
