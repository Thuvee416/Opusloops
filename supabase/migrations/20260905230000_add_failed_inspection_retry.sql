-- Requeue a narrowly defined, retryable inspect failure without asking the user
-- to upload the immutable source archive again.

create or replace function private.opusloops_stem_retryable_inspection_job(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint
)
returns public.stem_import_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);

  -- Retention claims use the same outer lock. Once this transaction has
  -- confirmed that cleanup has not started, no cleanup claim can race the
  -- transition back to inspect_queued.
  perform pg_catalog.pg_advisory_xact_lock(729410222);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_job_id::text, 227131)
  );

  select * into v_job
  from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Stem import not found';
  end if;
  if v_job.revision is distinct from p_revision then
    raise exception using errcode = '40001', message = 'Stale stem import revision';
  end if;
  if v_job.status <> 'failed'
     or v_job.error_code is null
     or v_job.error_code not in ('batch_bootstrap_failed', 'batch_queue_timeout') then
    raise exception using errcode = '55000',
      message = 'Stem inspection failure is not retryable';
  end if;
  if v_job.recovery_expires_at is null
     or v_job.recovery_expires_at <= statement_timestamp()
     or v_job.deletion_requested_at is not null
     or v_job.archive_deleted_at is not null
     or v_job.deleted_at is not null
     or v_job.status_before_deletion is not null then
    raise exception using errcode = '55000',
      message = 'Stem archive recovery is no longer available';
  end if;

  select * into v_attempt
  from private.stem_job_attempts
  where id = v_job.active_attempt_id
  for update;

  if not found
     or v_attempt.user_id <> p_user_id
     or v_attempt.job_id <> p_job_id
     or v_attempt.stage <> 'inspect'
     or v_attempt.state <> 'failed' then
    raise exception using errcode = '55000',
      message = 'Stem import has no failed inspection attempt';
  end if;

  if exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = p_user_id and item.job_id = p_job_id
    ) or exists (
      select 1 from private.stem_retention_scopes as scope
      where scope.user_id = p_user_id and scope.job_id = p_job_id
    ) then
    raise exception using errcode = '55000',
      message = 'Stem archive cleanup has started; create a new import';
  end if;

  -- The current asset identity includes attempt_id while source object paths do
  -- not. Until source assets have attempt-independent identities, retry only a
  -- bootstrap failure that registered no partial assets.
  if exists (
    select 1 from public.stem_import_assets as asset
    where asset.user_id = p_user_id and asset.job_id = p_job_id
  ) then
    raise exception using errcode = '55000',
      message = 'Stem inspection published partial assets; create a new import';
  end if;

  if not exists (
    select 1
    from storage.objects as object
    where object.bucket_id = v_job.source_bucket
      and object.name = v_job.source_object_path
      and object.owner_id = p_user_id::text
      and case
        when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
          then (object.metadata ->> 'size')::numeric = v_job.source_bytes
        else false
      end
  ) then
    raise exception using errcode = '55000',
      message = 'Stem archive is no longer available; create a new import';
  end if;

  return v_job;
end;
$$;

create or replace function public.get_stem_inspection_retry_source(
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
begin
  v_job := private.opusloops_stem_retryable_inspection_job(
    p_user_id, p_job_id, p_revision
  );
  return jsonb_build_object(
    'id', v_job.id,
    'source_bucket', v_job.source_bucket,
    'source_object_path', v_job.source_object_path,
    'source_bytes', v_job.source_bytes
  );
end;
$$;

create or replace function public.retry_stem_inspection(
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
  v_attempt_id uuid;
  v_sequence bigint;
begin
  v_job := private.opusloops_stem_retryable_inspection_job(
    p_user_id, p_job_id, p_revision
  );
  if p_observed_bytes is distinct from v_job.source_bytes then
    raise exception using errcode = '22023',
      message = 'Uploaded archive size does not match';
  end if;

  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'inspect_queued',
      revision = revision + 1,
      source_storage_etag = nullif(left(pg_catalog.btrim(p_storage_etag), 200), ''),
      active_attempt_id = null,
      aws_job_id = null,
      error_code = null,
      error_message = null,
      updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id
  returning * into v_job;

  v_attempt_id := private.opusloops_stem_begin_attempt(
    p_user_id, p_job_id, 'inspect', v_job.revision
  );
  v_job.active_attempt_id := v_attempt_id;
  v_job.aws_job_id := null;

  v_sequence := private.opusloops_stem_next_sequence(p_user_id, p_job_id);
  insert into public.stem_import_events (
    user_id, job_id, sequence, attempt_id, stage, status, determinate,
    completed, total, unit, detail
  ) values (
    p_user_id, p_job_id, v_sequence, v_attempt_id, 'dispatch', 'started', false,
    null, null, null,
    jsonb_build_object(
      'message', 'Inspection retry queued',
      'operation', 'retry-inspection'
    )
  );

  return to_jsonb(v_job);
end;
$$;

revoke all on function private.opusloops_stem_retryable_inspection_job(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.get_stem_inspection_retry_source(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function public.retry_stem_inspection(uuid, uuid, bigint, bigint, text)
  from public, anon, authenticated;

grant execute on function public.get_stem_inspection_retry_source(uuid, uuid, bigint)
  to service_role;
grant execute on function public.retry_stem_inspection(uuid, uuid, bigint, bigint, text)
  to service_role;

comment on function public.retry_stem_inspection(uuid, uuid, bigint, bigint, text) is
  'Creates a fresh inspect attempt for an intact, asset-free, allowlisted AWS startup failure.';
