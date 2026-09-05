-- Private, resumable, per-user stem imports with two hash-bound approval gates.
-- CPU-heavy work is dispatched to an external worker; browser roles can only
-- read their own records and upload the one ZIP allocated by create_stem_import.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('opusloops-stem-uploads', 'opusloops-stem-uploads', false, 2147483648, null),
  ('opusloops-stem-sources', 'opusloops-stem-sources', false, 5368709120, null),
  ('opusloops-stem-artifacts', 'opusloops-stem-artifacts', false, 5368709120, null)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.stem_import_jobs (
  user_id uuid not null references auth.users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  project_id uuid not null,
  status text not null default 'uploading',
  status_before_deletion text,
  revision bigint not null default 0,
  source_name text not null,
  source_bytes bigint not null,
  source_content_type text not null default 'application/zip',
  source_bucket text not null default 'opusloops-stem-uploads',
  source_object_path text not null,
  source_storage_etag text,
  source_sha256 text,
  inspection_manifest_sha256 text,
  inspection jsonb,
  analysis_selection jsonb,
  analysis_selection_sha256 text,
  gate_a_approved_at timestamptz,
  gate_a_approved_by uuid,
  analysis_sha256 text,
  analysis jsonb,
  proposal_id text,
  target_bpm numeric(7, 3),
  conform_mode text,
  reviewed_grid jsonb,
  reviewed_grid_sha256 text,
  meter_numerator smallint,
  meter_denominator smallint,
  first_downbeat_seconds numeric(12, 6),
  proposal_manifest_sha256 text,
  proposal jsonb,
  tempo_approval jsonb,
  tempo_approval_sha256 text,
  gate_b_approved_at timestamptz,
  gate_b_approved_by uuid,
  render_manifest_sha256 text,
  render_result jsonb,
  active_attempt_id uuid,
  aws_job_id text,
  error_code text,
  error_message text,
  recovery_expires_at timestamptz,
  archive_delete_after timestamptz,
  deletion_requested_at timestamptz,
  source_delete_after timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (user_id, id),
  foreign key (user_id, project_id)
    references public.projects (user_id, id)
    on delete cascade
    deferrable initially immediate,
  unique (source_object_path),
  constraint stem_import_jobs_status check (status in (
    'uploading', 'uploaded', 'inspect_queued', 'inspecting',
    'awaiting_analysis_confirmation', 'analysis_queued', 'analyzing',
    'awaiting_map_request', 'proposal_queued', 'proposing',
    'awaiting_tempo_confirmation', 'render_queued', 'rendering', 'ready',
    'failed', 'cancelled', 'deletion_pending', 'deleted'
  )),
  constraint stem_import_jobs_previous_status check (
    status_before_deletion is null or status_before_deletion in (
      'uploading', 'uploaded', 'inspect_queued', 'inspecting',
      'awaiting_analysis_confirmation', 'analysis_queued', 'analyzing',
      'awaiting_map_request', 'proposal_queued', 'proposing',
      'awaiting_tempo_confirmation', 'render_queued', 'rendering', 'ready',
      'failed', 'cancelled'
    )
  ),
  constraint stem_import_jobs_revision check (revision >= 0),
  constraint stem_import_jobs_source_name check (
    char_length(source_name) between 1 and 255
    and source_name !~ '[[:cntrl:]/\\]'
  ),
  constraint stem_import_jobs_source_bytes check (source_bytes between 1 and 2147483648),
  constraint stem_import_jobs_source_content_type check (
    char_length(source_content_type) between 1 and 127
  ),
  constraint stem_import_jobs_source_bucket check (source_bucket = 'opusloops-stem-uploads'),
  constraint stem_import_jobs_source_path check (
    source_object_path = user_id::text || '/' || project_id::text || '/' || id::text || '/source.zip'
  ),
  constraint stem_import_jobs_source_hash check (
    source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_inspection_hash check (
    inspection_manifest_sha256 is null or inspection_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_selection_hash check (
    analysis_selection_sha256 is null or analysis_selection_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_analysis_hash check (
    analysis_sha256 is null or analysis_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_reviewed_grid_hash check (
    reviewed_grid_sha256 is null or reviewed_grid_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_proposal_hash check (
    proposal_manifest_sha256 is null or proposal_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_approval_hash check (
    tempo_approval_sha256 is null or tempo_approval_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_render_hash check (
    render_manifest_sha256 is null or render_manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  constraint stem_import_jobs_json_shapes check (
    (inspection is null or jsonb_typeof(inspection) = 'object')
    and (analysis_selection is null or jsonb_typeof(analysis_selection) = 'object')
    and (analysis is null or jsonb_typeof(analysis) = 'object')
    and (reviewed_grid is null or jsonb_typeof(reviewed_grid) = 'object')
    and (proposal is null or jsonb_typeof(proposal) = 'object')
    and (tempo_approval is null or jsonb_typeof(tempo_approval) = 'object')
    and (render_result is null or jsonb_typeof(render_result) = 'object')
  ),
  constraint stem_import_jobs_json_sizes check (
    coalesce(octet_length(inspection::text), 0) <= 1048576
    and coalesce(octet_length(analysis_selection::text), 0) <= 65536
    and coalesce(octet_length(analysis::text), 0) <= 1048576
    and coalesce(octet_length(reviewed_grid::text), 0) <= 131072
    and coalesce(octet_length(proposal::text), 0) <= 1048576
    and coalesce(octet_length(tempo_approval::text), 0) <= 65536
    and coalesce(octet_length(render_result::text), 0) <= 1048576
  ),
  constraint stem_import_jobs_proposal_id check (
    proposal_id is null or proposal_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  ),
  constraint stem_import_jobs_target_bpm check (
    target_bpm is null or target_bpm between 20 and 400
  ),
  constraint stem_import_jobs_conform_mode check (
    conform_mode is null or conform_mode in ('musical-4bar', 'rigid-beat', 'no-conform')
  ),
  constraint stem_import_jobs_meter check (
    (meter_numerator is null and meter_denominator is null and first_downbeat_seconds is null)
    or
    (meter_numerator between 1 and 32
      and meter_denominator in (1, 2, 4, 8, 16, 32)
      and first_downbeat_seconds between 0 and 86400)
  ),
  constraint stem_import_jobs_error_lengths check (
    (error_code is null or char_length(error_code) between 1 and 80)
    and (error_message is null or char_length(error_message) between 1 and 1000)
  ),
  constraint stem_import_jobs_deletion_order check (
    (deleted_at is null or deletion_requested_at is not null)
    and (source_delete_after is null or deletion_requested_at is not null)
  )
);

create index stem_import_jobs_project_idx
  on public.stem_import_jobs (user_id, project_id, created_at desc);
create index stem_import_jobs_active_idx
  on public.stem_import_jobs (status, updated_at)
  where status not in ('ready', 'failed', 'cancelled', 'deleted');
create index stem_import_jobs_retention_idx
  on public.stem_import_jobs (archive_delete_after, source_delete_after)
  where deleted_at is null;

create table public.stem_import_assets (
  user_id uuid not null,
  job_id uuid not null,
  asset_id uuid not null,
  kind text not null,
  variant text not null default 'default',
  bucket text not null,
  object_path text not null,
  sha256 text not null,
  bytes bigint not null,
  content_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  retention_until timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, job_id, asset_id),
  foreign key (user_id, job_id)
    references public.stem_import_jobs (user_id, id)
    on delete cascade,
  unique (bucket, object_path),
  constraint stem_import_assets_kind check (kind in (
    'source_zip', 'source_member', 'canonical', 'reference', 'selection',
    'analysis', 'grid', 'waveform', 'click', 'proposal_manifest',
    'approval', 'render_linked', 'render_independent', 'preview_segment',
    'metrics', 'report', 'run_manifest', 'state_index'
  )),
  constraint stem_import_assets_variant check (
    char_length(variant) between 1 and 96 and variant ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'
  ),
  constraint stem_import_assets_bucket check (bucket in (
    'opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'
  )),
  constraint stem_import_assets_path check (
    object_path like user_id::text || '/%/' || job_id::text || '/%'
    and object_path !~ '(^|/)\.\.(/|$)'
    and object_path !~ '[[:cntrl:]]'
  ),
  constraint stem_import_assets_sha check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint stem_import_assets_bytes check (bytes between 1 and 5368709120),
  constraint stem_import_assets_content_type check (char_length(content_type) between 1 and 127),
  constraint stem_import_assets_metadata check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 65536
  )
);

create index stem_import_assets_job_idx
  on public.stem_import_assets (user_id, job_id, kind, variant)
  where deleted_at is null;
create index stem_import_assets_retention_idx
  on public.stem_import_assets (retention_until)
  where deleted_at is null and retention_until is not null;

create table public.stem_import_events (
  user_id uuid not null,
  job_id uuid not null,
  sequence bigint not null,
  attempt_id uuid,
  stage text not null,
  status text not null,
  determinate boolean not null,
  completed bigint,
  total bigint,
  unit text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, job_id, sequence),
  foreign key (user_id, job_id)
    references public.stem_import_jobs (user_id, id)
    on delete cascade,
  constraint stem_import_events_sequence check (sequence > 0),
  constraint stem_import_events_stage check (stage in (
    'upload', 'dispatch', 'inspect', 'extract', 'decode', 'reference',
    'analyze', 'diagnostic', 'propose', 'click', 'render', 'publish',
    'cleanup'
  )),
  constraint stem_import_events_status check (status in (
    'started', 'progress', 'completed', 'failed', 'cancelled'
  )),
  constraint stem_import_events_unit check (
    unit is null or unit in ('bytes', 'files', 'frames', 'artifacts')
  ),
  constraint stem_import_events_progress check (
    (determinate and completed is not null and total is not null and unit is not null
      and total > 0 and completed between 0 and total)
    or
    (not determinate and completed is null and total is null and unit is null)
  ),
  constraint stem_import_events_detail check (
    jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 32768
  )
);

create index stem_import_events_poll_idx
  on public.stem_import_events (user_id, job_id, sequence);

create table private.stem_job_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  stage text not null,
  job_revision bigint not null,
  state text not null default 'pending_dispatch',
  external_job_id text,
  dispatch_error text,
  dispatch_claim_id uuid,
  dispatch_claim_expires_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  dispatched_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (user_id, job_id)
    references public.stem_import_jobs (user_id, id)
    on delete cascade,
  unique (user_id, job_id, stage, job_revision),
  constraint stem_job_attempts_stage check (stage in ('inspect', 'analyze', 'propose', 'render')),
  constraint stem_job_attempts_state check (state in (
    'pending_dispatch', 'dispatching', 'submitted', 'running', 'completed', 'failed', 'cancelled'
  )),
  constraint stem_job_attempts_revision check (job_revision > 0),
  constraint stem_job_attempts_external_id check (
    external_job_id is null or char_length(external_job_id) between 1 and 200
  ),
  constraint stem_job_attempts_dispatch_error check (
    dispatch_error is null or char_length(dispatch_error) <= 1000
  )
);

create table private.stem_worker_nonces (
  nonce uuid primary key,
  request_sha256 text not null,
  response_body jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint stem_worker_nonces_hash check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint stem_worker_nonces_response check (
    jsonb_typeof(response_body) = 'object' and octet_length(response_body::text) <= 262144
  )
);

create index stem_worker_nonces_created_idx on private.stem_worker_nonces (created_at);

alter table public.stem_import_jobs enable row level security;
alter table public.stem_import_assets enable row level security;
alter table public.stem_import_events enable row level security;
alter table private.stem_job_attempts enable row level security;
alter table private.stem_worker_nonces enable row level security;

revoke all on table public.stem_import_jobs from public, anon, authenticated;
revoke all on table public.stem_import_assets from public, anon, authenticated;
revoke all on table public.stem_import_events from public, anon, authenticated;
revoke all on table private.stem_job_attempts from public, anon, authenticated;
revoke all on table private.stem_worker_nonces from public, anon, authenticated;

grant select on table public.stem_import_jobs to authenticated;
grant select on table public.stem_import_assets to authenticated;
grant select on table public.stem_import_events to authenticated;

create policy "Opusloops members can read their own stem jobs"
on public.stem_import_jobs for select to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
);

create policy "Opusloops members can read their own stem assets"
on public.stem_import_assets for select to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
);

create policy "Opusloops members can read their own stem events"
on public.stem_import_events for select to authenticated
using (
  (select auth.uid()) = user_id
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
);

-- TUS may create only the exact immutable ZIP object allocated to a live job.
create policy "Opusloops members can upload an allocated stem ZIP"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'opusloops-stem-uploads'
  and owner_id = (select auth.uid())::text
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
  and exists (
    select 1
    from public.stem_import_jobs as job
    where job.user_id = (select auth.uid())
      and job.status = 'uploading'
      and job.source_object_path = name
  )
);

create policy "Opusloops members can download their own stem objects"
on storage.objects for select to authenticated
using (
  bucket_id in (
    'opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'
  )
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (
    select 1
    from public.stem_import_jobs as job
    where job.user_id = (select auth.uid())
      and job.project_id::text = (storage.foldername(name))[2]
      and job.id::text = (storage.foldername(name))[3]
      and job.status <> 'deleted'
  )
);

create function private.opusloops_stem_assert_service_role()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;
end;
$$;

create function private.opusloops_stem_assert_member(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_member boolean;
begin
  perform private.opusloops_stem_assert_service_role();
  select coalesce((raw_app_meta_data ->> 'opusloops')::boolean, false)
  into v_is_member
  from auth.users
  where id = p_user_id;
  if coalesce(v_is_member, false) is not true then
    raise exception using errcode = '42501', message = 'Opusloops account required';
  end if;
end;
$$;

create function private.opusloops_stem_json_sha256(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value::text, 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create function private.opusloops_stem_next_sequence(p_user_id uuid, p_job_id uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select coalesce(max(event.sequence), 0) + 1
  from public.stem_import_events as event
  where event.user_id = p_user_id and event.job_id = p_job_id;
$$;

create function private.opusloops_stem_validate_reviewed_grid(
  p_grid jsonb,
  p_analysis_sha256 text,
  p_meter_numerator integer,
  p_meter_denominator integer,
  p_first_downbeat_seconds numeric
)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_seconds numeric;
  v_previous numeric;
  v_beats numeric[] := '{}'::numeric[];
  v_downbeats numeric[] := '{}'::numeric[];
begin
  if jsonb_typeof(p_grid) <> 'object'
     or octet_length(p_grid::text) > 131072
     or exists (
       select 1 from jsonb_object_keys(p_grid) as field(key)
       where field.key not in (
         'schema_version', 'analysis_sha256', 'attempt_id', 'beats_seconds',
         'downbeats_seconds', 'notes', 'reviewed'
       )
     )
     or p_grid -> 'reviewed' <> 'true'::jsonb
     or coalesce(p_grid ->> 'analysis_sha256', '') <> p_analysis_sha256
     or jsonb_typeof(p_grid -> 'beats_seconds') <> 'array'
     or jsonb_array_length(p_grid -> 'beats_seconds') not between 2 and 20000
     or jsonb_typeof(p_grid -> 'downbeats_seconds') <> 'array'
     or jsonb_array_length(p_grid -> 'downbeats_seconds') not between 1 and 5000
     or p_meter_numerator is null or p_meter_numerator not between 1 and 32
     or p_meter_denominator is null or p_meter_denominator not in (1, 2, 4, 8, 16, 32)
     or p_first_downbeat_seconds is null or p_first_downbeat_seconds not between 0 and 86400
     or (p_grid ? 'schema_version' and (
       jsonb_typeof(p_grid -> 'schema_version') <> 'string'
       or char_length(p_grid ->> 'schema_version') not between 1 and 80
     ))
     or (p_grid ? 'attempt_id' and coalesce(p_grid ->> 'attempt_id', '')
       !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     or (p_grid ? 'notes' and (
       jsonb_typeof(p_grid -> 'notes') <> 'string'
       or char_length(p_grid ->> 'notes') > 1000
     )) then
    raise exception using errcode = '22023', message = 'Invalid reviewed timing grid';
  end if;

  for v_item in select value from jsonb_array_elements(p_grid -> 'beats_seconds') loop
    begin
      if jsonb_typeof(v_item) <> 'number' then raise exception 'not numeric'; end if;
      v_seconds := (v_item #>> '{}')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'Invalid reviewed beat time';
    end;
    if v_seconds not between 0 and 86400
       or (v_previous is not null and v_seconds <= v_previous) then
      raise exception using errcode = '22023', message = 'Reviewed beats must be strictly increasing';
    end if;
    v_beats := array_append(v_beats, v_seconds);
    v_previous := v_seconds;
  end loop;

  v_previous := null;
  for v_item in select value from jsonb_array_elements(p_grid -> 'downbeats_seconds') loop
    begin
      if jsonb_typeof(v_item) <> 'number' then raise exception 'not numeric'; end if;
      v_seconds := (v_item #>> '{}')::numeric;
    exception when others then
      raise exception using errcode = '22023', message = 'Invalid reviewed downbeat time';
    end;
    if v_seconds not between 0 and 86400
       or (v_previous is not null and v_seconds <= v_previous)
       or not (v_seconds = any(v_beats)) then
      raise exception using errcode = '22023', message = 'Reviewed downbeats must be ordered beat events';
    end if;
    v_downbeats := array_append(v_downbeats, v_seconds);
    v_previous := v_seconds;
  end loop;

  if p_first_downbeat_seconds <> v_downbeats[1] then
    raise exception using errcode = '22023', message = 'First downbeat does not match the reviewed grid';
  end if;
end;
$$;

create function private.opusloops_stem_assert_processing_slot(
  p_user_id uuid,
  p_job_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The initial Batch quota is six Fargate vCPUs and each job reserves four.
  -- Serialize admission across the project so a second job cannot be queued
  -- while the first is queued or running. Uploads and human review may overlap.
  perform pg_catalog.pg_advisory_xact_lock(729410221);
  if exists (
    select 1 from public.stem_import_jobs
    where (user_id, id) <> (p_user_id, p_job_id)
      and status in (
        'inspect_queued', 'inspecting', 'analysis_queued', 'analyzing',
        'proposal_queued', 'proposing', 'render_queued', 'rendering'
      )
  ) then
    raise exception using errcode = '54000', message = 'Stem processing capacity is busy';
  end if;
end;
$$;

create function private.opusloops_stem_begin_attempt(
  p_user_id uuid,
  p_job_id uuid,
  p_stage text,
  p_revision bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt_id uuid;
begin
  insert into private.stem_job_attempts (user_id, job_id, stage, job_revision)
  values (p_user_id, p_job_id, p_stage, p_revision)
  on conflict (user_id, job_id, stage, job_revision) do update
    set dispatch_error = null
  returning id into v_attempt_id;

  update public.stem_import_jobs
  set active_attempt_id = v_attempt_id,
      aws_job_id = null,
      updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id;
  return v_attempt_id;
end;
$$;

create function public.create_stem_import(
  p_user_id uuid,
  p_project_id uuid,
  p_source_name text,
  p_source_bytes bigint,
  p_source_content_type text default 'application/zip'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_id uuid := gen_random_uuid();
  v_name text := pg_catalog.btrim(p_source_name);
  v_type text := pg_catalog.btrim(coalesce(p_source_content_type, 'application/zip'));
  v_active_count integer;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);

  if v_name = '' or char_length(v_name) > 255 or v_name ~ '[[:cntrl:]/\\]'
     or lower(right(v_name, 4)) <> '.zip'
     or p_source_bytes not between 1 and 2147483648
     or char_length(v_type) not between 1 and 127 then
    raise exception using errcode = '22023', message = 'Invalid stem archive metadata';
  end if;

  if not exists (
    select 1 from public.projects
    where user_id = p_user_id and id = p_project_id and deleted_at is null
  ) then
    raise exception using errcode = 'P0002', message = 'Project not found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text, 1299041)
  );
  select count(*) into v_active_count
  from public.stem_import_jobs
  where user_id = p_user_id
    and status not in ('ready', 'failed', 'cancelled', 'deleted');
  if v_active_count >= 5 then
    raise exception using errcode = '54000', message = 'Too many active stem imports';
  end if;

  insert into public.stem_import_jobs (
    user_id, id, project_id, source_name, source_bytes, source_content_type,
    source_object_path, recovery_expires_at
  ) values (
    p_user_id, v_id, p_project_id, v_name, p_source_bytes, v_type,
    p_user_id::text || '/' || p_project_id::text || '/' || v_id::text || '/source.zip',
    statement_timestamp() + interval '7 days'
  ) returning * into v_job;

  insert into public.stem_import_events (
    user_id, job_id, sequence, stage, status, determinate, completed, total, unit, detail
  ) values (
    p_user_id, v_id, 1, 'upload', 'started', true, 0, p_source_bytes, 'bytes',
    jsonb_build_object('message', 'Upload allocated')
  );
  return to_jsonb(v_job);
end;
$$;

create function public.finalize_stem_upload(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_observed_bytes bigint,
  p_storage_etag text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt uuid;
  v_sequence bigint;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.revision <> p_revision then
    raise exception using errcode = '40001', message = 'Stale stem import revision';
  end if;
  if v_job.status = 'inspect_queued' then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'uploading' then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting upload';
  end if;
  if p_observed_bytes <> v_job.source_bytes then
    raise exception using errcode = '22023', message = 'Uploaded archive size does not match';
  end if;
  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'inspect_queued', revision = revision + 1,
      source_storage_etag = nullif(left(pg_catalog.btrim(p_storage_etag), 200), ''),
      error_code = null, error_message = null, updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id returning * into v_job;
  v_attempt := private.opusloops_stem_begin_attempt(p_user_id, p_job_id, 'inspect', v_job.revision);
  v_job.active_attempt_id := v_attempt;
  v_sequence := private.opusloops_stem_next_sequence(p_user_id, p_job_id);
  insert into public.stem_import_events values (
    p_user_id, p_job_id, v_sequence, null, 'upload', 'completed', true,
    p_observed_bytes, p_observed_bytes, 'bytes',
    jsonb_build_object('message', 'Upload verified'), statement_timestamp()
  );
  return to_jsonb(v_job);
end;
$$;

create function public.get_stem_job_for_finalize(p_user_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.status not in ('uploading', 'inspect_queued') then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting upload finalization';
  end if;
  return jsonb_build_object(
    'id', v_job.id,
    'source_bucket', v_job.source_bucket,
    'source_object_path', v_job.source_object_path,
    'source_bytes', v_job.source_bytes
  );
end;
$$;

create function public.approve_stem_analysis(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_inspection_manifest_sha256 text,
  p_selection jsonb,
  p_confirm_files boolean,
  p_confirm_roles boolean,
  p_confirm_reference boolean,
  p_confirm_originals_unchanged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt uuid;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.revision <> p_revision then raise exception using errcode = '40001', message = 'Stale stem import revision'; end if;
  if v_job.status = 'analysis_queued'
     and v_job.analysis_selection_sha256 = private.opusloops_stem_json_sha256(p_selection) then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'awaiting_analysis_confirmation' then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting analysis confirmation';
  end if;
  if p_inspection_manifest_sha256 is distinct from v_job.inspection_manifest_sha256
     or p_inspection_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Inspection manifest binding is stale';
  end if;
  if p_selection is null or jsonb_typeof(p_selection) <> 'object'
     or octet_length(p_selection::text) > 65536 then
    raise exception using errcode = '22023', message = 'Invalid analysis selection';
  end if;
  if not (coalesce(p_confirm_files, false) and coalesce(p_confirm_roles, false)
      and coalesce(p_confirm_reference, false) and coalesce(p_confirm_originals_unchanged, false)) then
    raise exception using errcode = '22023', message = 'Every Gate A confirmation is required';
  end if;
  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'analysis_queued', revision = revision + 1,
      analysis_selection = p_selection,
      analysis_selection_sha256 = private.opusloops_stem_json_sha256(p_selection),
      gate_a_approved_at = statement_timestamp(), gate_a_approved_by = p_user_id,
      error_code = null, error_message = null, updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id returning * into v_job;
  v_attempt := private.opusloops_stem_begin_attempt(p_user_id, p_job_id, 'analyze', v_job.revision);
  v_job.active_attempt_id := v_attempt;
  return to_jsonb(v_job);
end;
$$;

create function public.request_stem_proposal(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_analysis_sha256 text,
  p_proposal_id text,
  p_target_bpm numeric,
  p_mode text,
  p_reviewed_grid jsonb,
  p_meter_numerator integer,
  p_meter_denominator integer,
  p_first_downbeat_seconds numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt uuid;
  v_reviewed_grid_sha256 text;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.revision <> p_revision then raise exception using errcode = '40001', message = 'Stale stem import revision'; end if;
  if p_analysis_sha256 is distinct from v_job.analysis_sha256
     or p_analysis_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Analysis binding is stale';
  end if;
  if p_proposal_id is null or p_proposal_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or p_mode is null or p_mode not in ('musical-4bar', 'rigid-beat', 'no-conform')
     or (p_mode = 'no-conform' and p_target_bpm is not null)
     or (p_mode <> 'no-conform' and (p_target_bpm is null or p_target_bpm not between 20 and 400)) then
    raise exception using errcode = '22023', message = 'Invalid tempo-map request';
  end if;
  perform private.opusloops_stem_validate_reviewed_grid(
    p_reviewed_grid, p_analysis_sha256, p_meter_numerator,
    p_meter_denominator, p_first_downbeat_seconds
  );
  v_reviewed_grid_sha256 := private.opusloops_stem_json_sha256(jsonb_build_object(
    'reviewedGrid', p_reviewed_grid,
    'meterNumerator', p_meter_numerator,
    'meterDenominator', p_meter_denominator,
    'firstDownbeatSeconds', p_first_downbeat_seconds
  ));
  if v_job.status = 'proposal_queued' and v_job.proposal_id = p_proposal_id
     and v_job.target_bpm = p_target_bpm and v_job.conform_mode = p_mode
     and v_job.reviewed_grid_sha256 = v_reviewed_grid_sha256
     and v_job.meter_numerator = p_meter_numerator
     and v_job.meter_denominator = p_meter_denominator
     and v_job.first_downbeat_seconds = p_first_downbeat_seconds then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'awaiting_map_request' then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting a map request';
  end if;
  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'proposal_queued', revision = revision + 1,
      proposal_id = p_proposal_id, target_bpm = p_target_bpm,
      conform_mode = p_mode, reviewed_grid = p_reviewed_grid,
      reviewed_grid_sha256 = v_reviewed_grid_sha256,
      meter_numerator = p_meter_numerator, meter_denominator = p_meter_denominator,
      first_downbeat_seconds = p_first_downbeat_seconds,
      error_code = null, error_message = null, updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id returning * into v_job;
  v_attempt := private.opusloops_stem_begin_attempt(p_user_id, p_job_id, 'propose', v_job.revision);
  v_job.active_attempt_id := v_attempt;
  return to_jsonb(v_job);
end;
$$;

create function public.approve_stem_tempo(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_proposal_manifest_sha256 text,
  p_approval jsonb,
  p_confirm_click boolean,
  p_confirm_beat_grid boolean,
  p_confirm_meter_downbeat boolean,
  p_confirm_tempo_octave boolean,
  p_confirm_flags boolean,
  p_confirm_target boolean,
  p_confirm_shared_map boolean,
  p_confirm_originals_unchanged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt uuid;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.revision <> p_revision then raise exception using errcode = '40001', message = 'Stale stem import revision'; end if;
  if v_job.status = 'render_queued'
     and v_job.tempo_approval_sha256 = private.opusloops_stem_json_sha256(p_approval) then
    return to_jsonb(v_job);
  end if;
  if v_job.status <> 'awaiting_tempo_confirmation' then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting tempo confirmation';
  end if;
  if p_proposal_manifest_sha256 is distinct from v_job.proposal_manifest_sha256
     or p_proposal_manifest_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Proposal binding is stale';
  end if;
  if p_approval is null or jsonb_typeof(p_approval) <> 'object'
     or octet_length(p_approval::text) > 65536 then
    raise exception using errcode = '22023', message = 'Invalid tempo approval';
  end if;
  if not (
    coalesce(p_confirm_click, false) and coalesce(p_confirm_beat_grid, false)
    and coalesce(p_confirm_meter_downbeat, false) and coalesce(p_confirm_tempo_octave, false)
    and coalesce(p_confirm_flags, false) and coalesce(p_confirm_target, false)
    and coalesce(p_confirm_shared_map, false) and coalesce(p_confirm_originals_unchanged, false)
  ) then
    raise exception using errcode = '22023', message = 'Every Gate B confirmation is required';
  end if;
  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'render_queued', revision = revision + 1,
      tempo_approval = p_approval,
      tempo_approval_sha256 = private.opusloops_stem_json_sha256(p_approval),
      gate_b_approved_at = statement_timestamp(), gate_b_approved_by = p_user_id,
      error_code = null, error_message = null, updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id returning * into v_job;
  v_attempt := private.opusloops_stem_begin_attempt(p_user_id, p_job_id, 'render', v_job.revision);
  v_job.active_attempt_id := v_attempt;
  return to_jsonb(v_job);
end;
$$;

create function public.cancel_stem_import(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_sequence bigint;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.revision <> p_revision then raise exception using errcode = '40001', message = 'Stale stem import revision'; end if;
  if v_job.status = 'cancelled' then return to_jsonb(v_job); end if;
  if v_job.status in ('ready', 'deletion_pending', 'deleted') then
    raise exception using errcode = '55000', message = 'Stem import can no longer be cancelled';
  end if;
  update public.stem_import_jobs
  set status = 'cancelled', revision = revision + 1,
      error_code = null, error_message = null, updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id returning * into v_job;
  update private.stem_job_attempts set state = 'cancelled', finished_at = statement_timestamp()
  where id = v_job.active_attempt_id and state in ('pending_dispatch', 'submitted', 'running');
  v_sequence := private.opusloops_stem_next_sequence(p_user_id, p_job_id);
  insert into public.stem_import_events values (
    p_user_id, p_job_id, v_sequence, v_job.active_attempt_id, 'cleanup', 'cancelled',
    false, null, null, null, jsonb_build_object('message', 'Import cancelled'),
    statement_timestamp()
  );
  return to_jsonb(v_job);
end;
$$;

create function public.get_stem_dispatch_payload(p_user_id uuid, p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
  v_inspection jsonb;
  v_analysis jsonb;
  v_proposal jsonb;
begin
  perform private.opusloops_stem_assert_service_role();
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  select * into v_attempt from private.stem_job_attempts where id = v_job.active_attempt_id;
  if not found or v_attempt.user_id <> p_user_id or v_attempt.job_id <> p_job_id then
    raise exception using errcode = '55000', message = 'Stem import has no dispatchable attempt';
  end if;
  if v_attempt.state not in ('pending_dispatch', 'dispatching', 'submitted') then
    raise exception using errcode = '55000', message = 'Stem import attempt is not dispatchable';
  end if;

  select jsonb_build_object('bucket', asset.bucket, 'key', asset.object_path,
      'sha256', asset.sha256)
  into v_inspection from public.stem_import_assets asset
  where asset.user_id = p_user_id and asset.job_id = p_job_id
    and asset.kind in ('state_index', 'run_manifest') and asset.variant = 'inspection'
    and asset.deleted_at is null order by (asset.kind = 'state_index') desc limit 1;
  select jsonb_build_object('bucket', asset.bucket, 'key', asset.object_path,
      'sha256', asset.sha256)
  into v_analysis from public.stem_import_assets asset
  where asset.user_id = p_user_id and asset.job_id = p_job_id
    and asset.kind in ('state_index', 'run_manifest') and asset.variant = 'analysis'
    and asset.deleted_at is null order by (asset.kind = 'state_index') desc limit 1;
  select jsonb_build_object('bucket', asset.bucket, 'key', asset.object_path,
      'sha256', asset.sha256)
  into v_proposal from public.stem_import_assets asset
  where asset.user_id = p_user_id and asset.job_id = p_job_id
    and asset.kind in ('state_index', 'proposal_manifest') and asset.variant = v_job.proposal_id
    and asset.deleted_at is null order by (asset.kind = 'state_index') desc limit 1;

  return jsonb_build_object(
    'version', 1,
    'jobId', v_job.id,
    'userId', v_job.user_id,
    'projectId', v_job.project_id,
    'attemptId', v_attempt.id,
    'stage', v_attempt.stage,
    'revision', v_attempt.job_revision,
    'sourceBucket', v_job.source_bucket,
    'sourceKey', v_job.source_object_path,
    'sourceSha256', v_job.source_sha256,
    'runPrefix', v_job.user_id::text || '/' || v_job.project_id::text || '/' || v_job.id::text,
    'inputs', jsonb_build_object(
      'sourceSha256', case when v_attempt.stage = 'inspect' then v_job.source_sha256 else null end,
      'inspectionManifest', case when v_attempt.stage = 'analyze' then v_inspection else null end,
      'selection', case when v_attempt.stage = 'analyze' then v_job.analysis_selection else null end,
      'analysis', case when v_attempt.stage = 'propose' then v_analysis else null end,
      'proposal', case when v_attempt.stage = 'render' then v_proposal else null end,
      'approval', case when v_attempt.stage = 'render' then v_job.tempo_approval else null end,
      'targetBpm', case when v_attempt.stage in ('propose', 'render') then v_job.target_bpm else null end,
      'mode', case when v_attempt.stage in ('propose', 'render') then v_job.conform_mode else null end,
      'proposalId', case when v_attempt.stage in ('propose', 'render') then v_job.proposal_id else null end,
      'reviewedGrid', case when v_attempt.stage = 'propose' then v_job.reviewed_grid else null end,
      'reviewedGridSha256', case when v_attempt.stage = 'propose' then v_job.reviewed_grid_sha256 else null end,
      'meterNumerator', case when v_attempt.stage = 'propose' then v_job.meter_numerator else null end,
      'meterDenominator', case when v_attempt.stage = 'propose' then v_job.meter_denominator else null end,
      'firstDownbeatSeconds', case when v_attempt.stage = 'propose' then v_job.first_downbeat_seconds else null end
    ),
    'alreadyDispatched', v_attempt.external_job_id is not null
  );
end;
$$;

create function public.claim_stem_dispatch(
  p_user_id uuid,
  p_job_id uuid,
  p_claim_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
  v_payload jsonb;
begin
  perform private.opusloops_stem_assert_service_role();
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  select * into v_attempt from private.stem_job_attempts
  where id = v_job.active_attempt_id for update;
  if not found then raise exception using errcode = '55000', message = 'Stem import has no dispatchable attempt'; end if;

  if v_attempt.external_job_id is null then
    if v_attempt.state = 'dispatching'
       and v_attempt.dispatch_claim_expires_at > statement_timestamp()
       and v_attempt.dispatch_claim_id <> p_claim_id then
      return jsonb_build_object(
        'version', 1, 'jobId', p_job_id, 'attemptId', v_attempt.id,
        'stage', v_attempt.stage, 'dispatchClaimed', false, 'alreadyDispatched', false
      );
    end if;
    if v_attempt.state not in ('pending_dispatch', 'dispatching') then
      raise exception using errcode = '55000', message = 'Stem import attempt is not dispatchable';
    end if;
    update private.stem_job_attempts
    set state = 'dispatching', dispatch_claim_id = p_claim_id,
        dispatch_claim_expires_at = statement_timestamp() + interval '45 seconds',
        dispatch_error = null
    where id = v_attempt.id;
  end if;
  v_payload := public.get_stem_dispatch_payload(p_user_id, p_job_id);
  return v_payload || jsonb_build_object(
    'dispatchClaimed', v_attempt.external_job_id is null,
    'dispatchClaimId', case when v_attempt.external_job_id is null then p_claim_id else null end
  );
end;
$$;

create function public.record_stem_dispatch(
  p_attempt_id uuid,
  p_claim_id uuid,
  p_external_job_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt private.stem_job_attempts;
begin
  perform private.opusloops_stem_assert_service_role();
  if p_external_job_id is null or char_length(p_external_job_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid external job identifier';
  end if;
  select * into v_attempt from private.stem_job_attempts where id = p_attempt_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem attempt not found'; end if;
  if v_attempt.external_job_id is not null and v_attempt.external_job_id <> p_external_job_id then
    raise exception using errcode = '23505', message = 'Stem attempt was already dispatched';
  end if;
  if v_attempt.external_job_id is null and (
    v_attempt.state <> 'dispatching' or v_attempt.dispatch_claim_id <> p_claim_id
  ) then
    raise exception using errcode = '55000', message = 'Stem dispatch claim is stale';
  end if;
  update private.stem_job_attempts
  set state = 'submitted', external_job_id = p_external_job_id,
      dispatch_error = null, dispatch_claim_id = null, dispatch_claim_expires_at = null,
      dispatched_at = coalesce(dispatched_at, statement_timestamp())
  where id = p_attempt_id;
  update public.stem_import_jobs
  set aws_job_id = p_external_job_id, updated_at = statement_timestamp()
  where user_id = v_attempt.user_id and id = v_attempt.job_id
    and active_attempt_id = p_attempt_id;
end;
$$;

create function public.record_stem_dispatch_error(
  p_attempt_id uuid,
  p_claim_id uuid,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.opusloops_stem_assert_service_role();
  update private.stem_job_attempts
  set state = 'pending_dispatch', dispatch_error = left(coalesce(p_error_message, 'Dispatch unavailable'), 1000),
      dispatch_claim_id = null, dispatch_claim_expires_at = null
  where id = p_attempt_id and external_job_id is null
    and state = 'dispatching' and dispatch_claim_id = p_claim_id;
end;
$$;

create function public.get_stem_asset_for_signing(
  p_user_id uuid,
  p_job_id uuid,
  p_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.stem_import_assets;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
  select asset.* into v_asset
  from public.stem_import_assets asset
  join public.stem_import_jobs job
    on job.user_id = asset.user_id and job.id = asset.job_id
  where asset.user_id = p_user_id and asset.job_id = p_job_id
    and asset.asset_id = p_asset_id and asset.deleted_at is null
    and job.status <> 'deleted';
  if not found then raise exception using errcode = 'P0002', message = 'Stem asset not found'; end if;
  return to_jsonb(v_asset);
end;
$$;

create function public.apply_stem_worker_callback(
  p_nonce uuid,
  p_request_sha256 text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing private.stem_worker_nonces;
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
  v_event jsonb := p_payload -> 'event';
  v_result jsonb := p_payload -> 'result';
  v_error jsonb := p_payload -> 'error';
  v_user_id uuid;
  v_job_id uuid;
  v_attempt_id uuid;
  v_stage text;
  v_event_status text;
  v_determinate boolean;
  v_completed bigint;
  v_total bigint;
  v_unit text;
  v_detail jsonb;
  v_sequence bigint;
  v_previous public.stem_import_events;
  v_asset jsonb;
  v_kind text;
  v_bucket text;
  v_object_path text;
  v_response jsonb;
  v_queued_status text;
  v_running_status text;
  v_completed_status text;
begin
  perform private.opusloops_stem_assert_service_role();
  if p_request_sha256 !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 262144 then
    raise exception using errcode = '22023', message = 'Invalid worker callback envelope';
  end if;

  select * into v_existing from private.stem_worker_nonces where nonce = p_nonce;
  if found then
    if v_existing.request_sha256 <> p_request_sha256 then
      raise exception using errcode = '23505', message = 'Worker callback nonce was replayed with different bytes';
    end if;
    return v_existing.response_body || jsonb_build_object('duplicate', true);
  end if;

  begin
    v_user_id := (p_payload ->> 'userId')::uuid;
    v_job_id := (p_payload ->> 'jobId')::uuid;
    v_attempt_id := (p_payload ->> 'attemptId')::uuid;
    v_stage := p_payload ->> 'stage';
    v_event_status := v_event ->> 'status';
    v_determinate := (v_event ->> 'determinate')::boolean;
    v_completed := nullif(v_event ->> 'completed', '')::bigint;
    v_total := nullif(v_event ->> 'total', '')::bigint;
    v_unit := nullif(v_event ->> 'unit', '');
    v_detail := coalesce(v_event -> 'detail', '{}'::jsonb);
  exception when others then
    raise exception using errcode = '22023', message = 'Invalid worker callback fields';
  end;
  if (p_payload ->> 'version')::integer <> 1 or jsonb_typeof(v_event) <> 'object'
     or v_stage not in ('inspect', 'analyze', 'propose', 'render')
     or v_event_status not in ('started', 'progress', 'completed', 'failed')
     or jsonb_typeof(v_detail) <> 'object' or octet_length(v_detail::text) > 32768 then
    raise exception using errcode = '22023', message = 'Invalid worker event';
  end if;
  if (v_determinate and (
      v_completed is null or v_total is null or v_total <= 0
      or v_completed < 0 or v_completed > v_total
      or v_unit not in ('bytes', 'files', 'frames', 'artifacts')
    )) or (not v_determinate and (
      v_completed is not null or v_total is not null or v_unit is not null
    )) then
    raise exception using errcode = '22023', message = 'Invalid worker progress';
  end if;
  if jsonb_typeof(coalesce(p_payload -> 'assets', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_payload -> 'assets', '[]'::jsonb)) > 128 then
    raise exception using errcode = '22023', message = 'Invalid worker asset list';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_job_id::text, 227131));
  select * into v_job from public.stem_import_jobs
  where user_id = v_user_id and id = v_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  select * into v_attempt from private.stem_job_attempts where id = v_attempt_id for update;
  if not found or v_attempt.user_id <> v_user_id or v_attempt.job_id <> v_job_id
     or v_attempt.stage <> v_stage or v_job.active_attempt_id <> v_attempt_id then
    raise exception using errcode = '55000', message = 'Worker attempt binding is stale';
  end if;

  v_queued_status := case v_stage
    when 'inspect' then 'inspect_queued' when 'analyze' then 'analysis_queued'
    when 'propose' then 'proposal_queued' else 'render_queued' end;
  v_running_status := case v_stage
    when 'inspect' then 'inspecting' when 'analyze' then 'analyzing'
    when 'propose' then 'proposing' else 'rendering' end;
  v_completed_status := case v_stage
    when 'inspect' then 'awaiting_analysis_confirmation'
    when 'analyze' then 'awaiting_map_request'
    when 'propose' then 'awaiting_tempo_confirmation'
    else 'ready' end;

  select * into v_previous from public.stem_import_events
  where user_id = v_user_id and job_id = v_job_id and attempt_id = v_attempt_id
    and determinate = v_determinate
    and unit is not distinct from v_unit
    and coalesce(detail ->> 'operation', '') = coalesce(v_detail ->> 'operation', '')
  order by sequence desc limit 1;
  if found and v_determinate and v_previous.determinate then
    if v_previous.total <> v_total or v_completed < v_previous.completed then
      raise exception using errcode = '22023', message = 'Worker progress must be monotonic';
    end if;
  end if;

  if v_event_status not in ('progress', 'completed')
     and jsonb_array_length(coalesce(p_payload -> 'assets', '[]'::jsonb)) > 0 then
    raise exception using errcode = '22023', message = 'Assets require a progress or completion event';
  end if;
  if v_event_status in ('progress', 'completed') then
    for v_asset in select value from jsonb_array_elements(coalesce(p_payload -> 'assets', '[]'::jsonb)) loop
      begin
        v_kind := v_asset ->> 'kind';
        v_bucket := v_asset ->> 'bucket';
        v_object_path := v_asset ->> 'objectPath';
        if v_kind not in (
          'source_zip', 'source_member', 'canonical', 'reference', 'selection',
          'analysis', 'grid', 'waveform', 'click', 'proposal_manifest', 'approval',
          'render_linked', 'render_independent', 'preview_segment', 'metrics',
          'report', 'run_manifest', 'state_index'
        ) or v_bucket not in (
          'opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'
        ) or v_object_path not like (
          v_user_id::text || '/' || v_job.project_id::text || '/' || v_job_id::text || '/%'
        ) or v_object_path ~ '(^|/)\.\.(/|$)' then
          raise exception 'invalid asset binding';
        end if;
        if (v_kind = 'source_zip' and v_bucket <> 'opusloops-stem-uploads')
           or (v_kind in ('source_member', 'canonical') and v_bucket <> 'opusloops-stem-sources')
           or (v_kind not in ('source_zip', 'source_member', 'canonical')
               and v_bucket <> 'opusloops-stem-artifacts') then
          raise exception 'invalid asset bucket';
        end if;
        insert into public.stem_import_assets (
          user_id, job_id, asset_id, kind, variant, bucket, object_path,
          sha256, bytes, content_type, metadata, retention_until
        ) values (
          v_user_id, v_job_id, (v_asset ->> 'id')::uuid, v_kind,
          coalesce(nullif(v_asset ->> 'variant', ''), 'default'), v_bucket, v_object_path,
          v_asset ->> 'sha256', (v_asset ->> 'bytes')::bigint,
          v_asset ->> 'contentType', coalesce(v_asset -> 'metadata', '{}'::jsonb),
          nullif(v_asset ->> 'retentionUntil', '')::timestamptz
        );
      exception when others then
        raise exception using errcode = '22023', message = 'Invalid or duplicate worker asset';
      end;
    end loop;
  end if;

  if v_event_status = 'started' then
    if v_job.status <> v_queued_status or v_attempt.state not in ('submitted', 'dispatching') then
      raise exception using errcode = '55000', message = 'Worker start is not valid in the current state';
    end if;
    update private.stem_job_attempts set state = 'running', started_at = statement_timestamp()
    where id = v_attempt_id;
    update public.stem_import_jobs set status = v_running_status, revision = revision + 1,
      updated_at = statement_timestamp() where user_id = v_user_id and id = v_job_id;
  elsif v_event_status = 'progress' then
    if v_job.status <> v_running_status or v_attempt.state <> 'running' then
      raise exception using errcode = '55000', message = 'Worker progress is not valid in the current state';
    end if;
    update public.stem_import_jobs set revision = revision + 1, updated_at = statement_timestamp()
    where user_id = v_user_id and id = v_job_id;
  elsif v_event_status = 'failed' then
    if v_job.status not in (v_queued_status, v_running_status)
       or v_attempt.state not in ('submitted', 'pending_dispatch', 'running') then
      raise exception using errcode = '55000', message = 'Worker failure is not valid in the current state';
    end if;
    if jsonb_typeof(v_error) <> 'object'
       or char_length(coalesce(v_error ->> 'code', '')) not between 1 and 80
       or char_length(coalesce(v_error ->> 'message', '')) not between 1 and 1000 then
      raise exception using errcode = '22023', message = 'Invalid worker failure';
    end if;
    update private.stem_job_attempts set state = 'failed', finished_at = statement_timestamp()
    where id = v_attempt_id;
    update public.stem_import_jobs set status = 'failed', revision = revision + 1,
      error_code = v_error ->> 'code', error_message = v_error ->> 'message',
      updated_at = statement_timestamp() where user_id = v_user_id and id = v_job_id;
  else
    if v_job.status <> v_running_status or v_attempt.state <> 'running' then
      raise exception using errcode = '55000', message = 'Worker completion is not valid in the current state';
    end if;
    if v_determinate and v_completed <> v_total then
      raise exception using errcode = '22023', message = 'Completed worker stage has unfinished progress';
    end if;
    if jsonb_typeof(v_result) <> 'object' then
      raise exception using errcode = '22023', message = 'Worker completion requires a result object';
    end if;

    if v_stage = 'inspect' then
      if coalesce(v_result ->> 'sourceSha256', '') !~ '^[0-9a-f]{64}$'
         or coalesce(v_result ->> 'manifestSha256', '') !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Inspection result is missing hash bindings';
      end if;
      update public.stem_import_jobs set source_sha256 = v_result ->> 'sourceSha256',
        inspection_manifest_sha256 = v_result ->> 'manifestSha256', inspection = v_result,
        status = v_completed_status, revision = revision + 1, updated_at = statement_timestamp()
      where user_id = v_user_id and id = v_job_id;
    elsif v_stage = 'analyze' then
      if coalesce(v_result ->> 'analysisSha256', '') !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Analysis result is missing its hash binding';
      end if;
      update public.stem_import_jobs set analysis_sha256 = v_result ->> 'analysisSha256',
        analysis = v_result, status = v_completed_status, revision = revision + 1,
        updated_at = statement_timestamp() where user_id = v_user_id and id = v_job_id;
    elsif v_stage = 'propose' then
      if coalesce(v_result ->> 'proposalId', '') <> v_job.proposal_id
         or coalesce(v_result ->> 'proposalManifestSha256', '') !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Proposal result is missing its hash binding';
      end if;
      update public.stem_import_jobs
      set proposal_manifest_sha256 = v_result ->> 'proposalManifestSha256', proposal = v_result,
        status = v_completed_status, revision = revision + 1, updated_at = statement_timestamp()
      where user_id = v_user_id and id = v_job_id;
    else
      if coalesce(v_result ->> 'renderManifestSha256', '') !~ '^[0-9a-f]{64}$' then
        raise exception using errcode = '22023', message = 'Render result is missing its hash binding';
      end if;
      update public.stem_import_jobs
      set render_manifest_sha256 = v_result ->> 'renderManifestSha256', render_result = v_result,
        status = v_completed_status, revision = revision + 1,
        archive_delete_after = statement_timestamp() + interval '7 days',
        updated_at = statement_timestamp()
      where user_id = v_user_id and id = v_job_id;
    end if;
    update private.stem_job_attempts set state = 'completed', finished_at = statement_timestamp()
    where id = v_attempt_id;
  end if;

  v_sequence := private.opusloops_stem_next_sequence(v_user_id, v_job_id);
  insert into public.stem_import_events (
    user_id, job_id, sequence, attempt_id, stage, status, determinate,
    completed, total, unit, detail
  ) values (
    v_user_id, v_job_id, v_sequence, v_attempt_id, v_stage, v_event_status,
    v_determinate, v_completed, v_total, v_unit, v_detail
  );

  select * into v_job from public.stem_import_jobs where user_id = v_user_id and id = v_job_id;
  v_response := jsonb_build_object(
    'accepted', true, 'duplicate', false,
    'job', jsonb_build_object('id', v_job.id, 'status', v_job.status, 'revision', v_job.revision)
  );
  insert into private.stem_worker_nonces (nonce, request_sha256, response_body)
  values (p_nonce, p_request_sha256, v_response);
  return v_response;
end;
$$;

create function private.opusloops_stem_project_retention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.stem_import_jobs
    set status_before_deletion = status,
        status = case when status = 'deleted' then status else 'deletion_pending' end,
        deletion_requested_at = statement_timestamp(),
        source_delete_after = statement_timestamp() + interval '30 days',
        revision = revision + 1,
        updated_at = statement_timestamp()
    where user_id = new.user_id and project_id = new.id and status <> 'deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.stem_import_jobs
    set status = coalesce(status_before_deletion, 'failed'),
        status_before_deletion = null,
        deletion_requested_at = null,
        source_delete_after = null,
        revision = revision + 1,
        updated_at = statement_timestamp()
    where user_id = new.user_id and project_id = new.id and status = 'deletion_pending';
  end if;
  return new;
end;
$$;

create trigger opusloops_stem_project_retention
after update of deleted_at on public.projects
for each row when (old.deleted_at is distinct from new.deleted_at)
execute function private.opusloops_stem_project_retention();

-- Browser roles never execute mutation/callback helpers directly.
revoke all on function private.opusloops_stem_assert_service_role() from public, anon, authenticated;
revoke all on function private.opusloops_stem_assert_member(uuid) from public, anon, authenticated;
revoke all on function private.opusloops_stem_json_sha256(jsonb) from public, anon, authenticated;
revoke all on function private.opusloops_stem_next_sequence(uuid, uuid) from public, anon, authenticated;
revoke all on function private.opusloops_stem_validate_reviewed_grid(jsonb, text, integer, integer, numeric) from public, anon, authenticated;
revoke all on function private.opusloops_stem_assert_processing_slot(uuid, uuid) from public, anon, authenticated;
revoke all on function private.opusloops_stem_begin_attempt(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.create_stem_import(uuid, uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.finalize_stem_upload(uuid, uuid, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.get_stem_job_for_finalize(uuid, uuid) from public, anon, authenticated;
revoke all on function public.approve_stem_analysis(uuid, uuid, bigint, text, jsonb, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.request_stem_proposal(uuid, uuid, bigint, text, text, numeric, text, jsonb, integer, integer, numeric) from public, anon, authenticated;
revoke all on function public.approve_stem_tempo(uuid, uuid, bigint, text, jsonb, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function public.cancel_stem_import(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.get_stem_dispatch_payload(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_stem_dispatch(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_stem_dispatch(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_stem_dispatch_error(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_stem_asset_for_signing(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_stem_worker_callback(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.opusloops_stem_project_retention() from public, anon, authenticated;

grant execute on function public.create_stem_import(uuid, uuid, text, bigint, text) to service_role;
grant execute on function public.finalize_stem_upload(uuid, uuid, bigint, bigint, text) to service_role;
grant execute on function public.get_stem_job_for_finalize(uuid, uuid) to service_role;
grant execute on function public.approve_stem_analysis(uuid, uuid, bigint, text, jsonb, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.request_stem_proposal(uuid, uuid, bigint, text, text, numeric, text, jsonb, integer, integer, numeric) to service_role;
grant execute on function public.approve_stem_tempo(uuid, uuid, bigint, text, jsonb, boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.cancel_stem_import(uuid, uuid, bigint) to service_role;
grant execute on function public.get_stem_dispatch_payload(uuid, uuid) to service_role;
grant execute on function public.claim_stem_dispatch(uuid, uuid, uuid) to service_role;
grant execute on function public.record_stem_dispatch(uuid, uuid, text) to service_role;
grant execute on function public.record_stem_dispatch_error(uuid, uuid, text) to service_role;
grant execute on function public.get_stem_asset_for_signing(uuid, uuid, uuid) to service_role;
grant execute on function public.apply_stem_worker_callback(uuid, text, jsonb) to service_role;

comment on table public.stem_import_jobs is
  'User-owned stem import state with revisioned, hash-bound Gate A and Gate B decisions.';
comment on table public.stem_import_events is
  'Measured stem pipeline progress; indeterminate stages intentionally have no percentage.';
comment on table public.stem_import_assets is
  'Immutable object-store artifacts and source stems bound by path, size, and SHA-256.';
