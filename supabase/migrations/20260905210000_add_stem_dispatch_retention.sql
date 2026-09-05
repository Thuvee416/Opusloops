-- Durable dispatch retries and an idempotent, service-only Storage retention outbox.

alter table public.stem_import_jobs
  add column archive_deleted_at timestamptz;

alter table private.stem_job_attempts
  add column dispatch_job_name text,
  add column reconcile_after timestamptz;

alter table private.stem_job_attempts
  drop constraint stem_job_attempts_state,
  add constraint stem_job_attempts_state check (state in (
    'pending_dispatch', 'dispatching', 'reconcile_pending', 'submitted',
    'running', 'completed', 'failed', 'cancelled'
  )),
  add constraint stem_job_attempts_job_name check (
    dispatch_job_name is null
    or dispatch_job_name ~ '^[A-Za-z0-9_-]{1,128}$'
  );

-- Supabase S3 session-token credentials assume the authenticated user's RLS
-- identity. Inspect may publish content-addressed sources; every other worker
-- write is restricted to the current immutable attempt and stage.
create policy "Opusloops workers can publish active stem objects"
on storage.objects for insert to authenticated
with check (
  owner_id = (select auth.uid())::text
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
  and (
    (
      bucket_id = 'opusloops-stem-sources'
      and (storage.foldername(name))[4] = 'sources'
      and storage.filename(name) ~ '^[0-9a-f]{16}-[0-9a-f]{64}\.[A-Za-z0-9]{1,10}$'
      and exists (
        select 1
        from public.stem_import_jobs as job
        where job.user_id = (select auth.uid())
          and job.project_id::text = (storage.foldername(name))[2]
          and job.id::text = (storage.foldername(name))[3]
          and (storage.foldername(name))[1] = (select auth.uid())::text
          and job.status = 'inspecting'
          and job.deleted_at is null
      )
    )
    or
    (
      bucket_id = 'opusloops-stem-artifacts'
      and (storage.foldername(name))[4] = 'attempts'
      and exists (
        select 1
        from public.stem_import_jobs as job
        where job.user_id = (select auth.uid())
          and job.project_id::text = (storage.foldername(name))[2]
          and job.id::text = (storage.foldername(name))[3]
          and (storage.foldername(name))[1] = (select auth.uid())::text
          and job.active_attempt_id::text = (storage.foldername(name))[5]
          and job.deleted_at is null
          and case (storage.foldername(name))[6]
            when 'inspect' then job.status = 'inspecting'
            when 'analyze' then job.status = 'analyzing'
            when 'propose' then job.status = 'proposing'
            when 'render' then job.status = 'rendering'
            else false
          end
      )
    )
  )
);

-- The same user JWT is carried into one Batch task, so it must not retain the
-- broad browser-era ability to enumerate every historical job. Workers may
-- read only the one processing job; completed playback uses signed-download.
drop policy "Opusloops members can download their own stem objects"
on storage.objects;

create policy "Opusloops members can read current stem objects"
on storage.objects for select to authenticated
using (
  owner_id = (select auth.uid())::text
  and coalesce(((select auth.jwt()) -> 'app_metadata' ->> 'opusloops')::boolean, false)
  and exists (
    select 1
    from public.stem_import_jobs as job
    where job.user_id = (select auth.uid())
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and job.project_id::text = (storage.foldername(name))[2]
      and job.id::text = (storage.foldername(name))[3]
      and job.active_attempt_id is not null
      and job.deleted_at is null
      and job.status in (
        'inspect_queued', 'inspecting', 'analysis_queued', 'analyzing',
        'proposal_queued', 'proposing', 'render_queued', 'rendering'
      )
      and (
        (
          bucket_id = 'opusloops-stem-uploads'
          and name = job.source_object_path
          and job.status in ('inspect_queued', 'inspecting')
        )
        or (
          bucket_id in ('opusloops-stem-sources', 'opusloops-stem-artifacts')
          and name like (
            job.user_id::text || '/' || job.project_id::text || '/' || job.id::text || '/%'
          )
        )
      )
  )
);

create table private.stem_retention_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  asset_id uuid,
  subject_type text not null,
  reason text not null,
  bucket text not null,
  object_path text not null,
  claim_id uuid,
  claim_expires_at timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default statement_timestamp(),
  last_error text,
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (bucket, object_path),
  constraint stem_retention_items_subject check (
    (subject_type = 'archive' and asset_id is null)
    or (subject_type = 'asset' and asset_id is not null)
    or (subject_type = 'orphan' and asset_id is null)
  ),
  constraint stem_retention_items_reason check (
    reason in (
      'archive_expired', 'recovery_expired', 'project_deleted', 'asset_expired',
      'hard_delete'
    )
  ),
  constraint stem_retention_items_bucket check (bucket in (
    'opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'
  )),
  constraint stem_retention_items_path check (
    object_path like user_id::text || '/%/' || job_id::text || '/%'
    and object_path !~ '(^|/)\.\.(/|$)'
    and object_path !~ '[[:cntrl:]]'
  ),
  constraint stem_retention_items_attempts check (attempt_count between 0 and 1000000),
  constraint stem_retention_items_error check (
    last_error is null or char_length(last_error) between 1 and 500
  )
);

create unique index stem_retention_items_asset_idx
  on private.stem_retention_items (user_id, job_id, asset_id)
  where asset_id is not null;
create index stem_retention_items_due_idx
  on private.stem_retention_items (next_attempt_at, claim_expires_at)
  where completed_at is null;

alter table private.stem_retention_items enable row level security;
revoke all on table private.stem_retention_items from public, anon, authenticated;

create table private.stem_retention_scopes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  reason text not null,
  bucket text not null,
  object_prefix text not null,
  due_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  unique (bucket, object_prefix),
  constraint stem_retention_scopes_reason check (
    reason in ('recovery_expired', 'project_deleted', 'hard_delete')
  ),
  constraint stem_retention_scopes_bucket check (bucket in (
    'opusloops-stem-uploads', 'opusloops-stem-sources', 'opusloops-stem-artifacts'
  )),
  constraint stem_retention_scopes_prefix check (
    object_prefix = user_id::text || '/' || project_id::text || '/'
      || job_id::text || '/'
  )
);

create index stem_retention_scopes_due_idx
  on private.stem_retention_scopes (due_at, created_at)
  where completed_at is null;

alter table private.stem_retention_scopes enable row level security;
revoke all on table private.stem_retention_scopes from public, anon, authenticated;

-- Storage is external to PostgreSQL, so cascades must first snapshot every
-- object into an outbox that deliberately has no parent foreign key. This also
-- covers an admin/auth user deletion, which cascades through projects/jobs.
create function private.opusloops_stem_enqueue_hard_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.stem_retention_scopes (
    user_id, project_id, job_id, reason, bucket, object_prefix, due_at
  )
  select old.user_id, old.project_id, old.id, 'hard_delete', bucket,
    old.user_id::text || '/' || old.project_id::text || '/' || old.id::text || '/',
    statement_timestamp()
  from (values
    ('opusloops-stem-uploads'::text),
    ('opusloops-stem-sources'::text),
    ('opusloops-stem-artifacts'::text)
  ) as buckets(bucket)
  on conflict (bucket, object_prefix) do update
  set reason = 'hard_delete', due_at = statement_timestamp(), completed_at = null,
      updated_at = statement_timestamp();

  if old.archive_deleted_at is null then
    insert into private.stem_retention_items (
      user_id, job_id, subject_type, reason, bucket, object_path
    ) values (
      old.user_id, old.id, 'archive', 'hard_delete',
      old.source_bucket, old.source_object_path
    )
    on conflict (bucket, object_path) do update
    set reason = 'hard_delete', next_attempt_at = statement_timestamp(),
        updated_at = statement_timestamp();
  end if;

  insert into private.stem_retention_items (
    user_id, job_id, asset_id, subject_type, reason, bucket, object_path
  )
  select asset.user_id, asset.job_id, asset.asset_id, 'asset', 'hard_delete',
    asset.bucket, asset.object_path
  from public.stem_import_assets as asset
  where asset.user_id = old.user_id and asset.job_id = old.id
    and asset.deleted_at is null
  on conflict (bucket, object_path) do update
  set reason = 'hard_delete', next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp();

  return old;
end;
$$;

create trigger opusloops_stem_enqueue_hard_delete
before delete on public.stem_import_jobs
for each row execute function private.opusloops_stem_enqueue_hard_delete();

-- Serialize restore against retention claims. Once a project-deletion object is
-- physically removed, restoration is intentionally rejected instead of
-- reviving a project with missing media. Live worker attempts are terminalized
-- at deletion and are never resurrected as phantom running work.
create or replace function private.opusloops_stem_project_retention()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(729410222);
  if old.deleted_at is null and new.deleted_at is not null then
    update private.stem_job_attempts as attempt
    set state = 'cancelled', finished_at = statement_timestamp(),
        dispatch_claim_id = null, dispatch_claim_expires_at = null,
        reconcile_after = null
    from public.stem_import_jobs as job
    where job.user_id = new.user_id and job.project_id = new.id
      and job.active_attempt_id = attempt.id
      and attempt.state in (
        'pending_dispatch', 'dispatching', 'reconcile_pending',
        'submitted', 'running'
      );

    update public.stem_import_jobs
    set status_before_deletion = status,
        status = case when status = 'deleted' then status else 'deletion_pending' end,
        deletion_requested_at = statement_timestamp(),
        source_delete_after = statement_timestamp() + interval '30 days',
        revision = revision + 1,
        updated_at = statement_timestamp()
    where user_id = new.user_id and project_id = new.id and status <> 'deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then
    if exists (
      select 1
      from public.stem_import_jobs as job
      join private.stem_retention_items as item
        on item.user_id = job.user_id and item.job_id = job.id
      where job.user_id = new.user_id and job.project_id = new.id
        and item.reason = 'project_deleted'
        and (
          item.completed_at is not null
          or (item.claim_id is not null
            and item.claim_expires_at > statement_timestamp())
        )
    ) then
      raise exception using errcode = '55000',
        message = 'Project media deletion has started and cannot be restored';
    end if;

    update public.stem_import_jobs
    set status = case
          when status_before_deletion in (
            'inspect_queued', 'inspecting', 'analysis_queued', 'analyzing',
            'proposal_queued', 'proposing', 'render_queued', 'rendering'
          ) then 'failed'
          else coalesce(status_before_deletion, 'failed')
        end,
        error_code = case
          when status_before_deletion in (
            'inspect_queued', 'inspecting', 'analysis_queued', 'analyzing',
            'proposal_queued', 'proposing', 'render_queued', 'rendering'
          ) then 'project_restored_processing_cancelled'
          else error_code
        end,
        error_message = case
          when status_before_deletion in (
            'inspect_queued', 'inspecting', 'analysis_queued', 'analyzing',
            'proposal_queued', 'proposing', 'render_queued', 'rendering'
          ) then 'Processing was cancelled when the project was deleted; start a new import.'
          else error_message
        end,
        status_before_deletion = null,
        deletion_requested_at = null,
        source_delete_after = null,
        revision = revision + 1,
        updated_at = statement_timestamp()
    where user_id = new.user_id and project_id = new.id
      and status = 'deletion_pending';
  end if;
  return new;
end;
$$;

-- Finalization and cleanup share a durable fence. The global lock serializes
-- claim creation; the retained attempt history then prevents finalizing an
-- archive that a Storage executor may already have removed.
alter function public.finalize_stem_upload(uuid, uuid, bigint, bigint, text)
  rename to finalize_stem_upload_unchecked;
revoke all on function public.finalize_stem_upload_unchecked(uuid, uuid, bigint, bigint, text)
  from public, anon, authenticated, service_role;

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
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);
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
  if v_job.status = 'uploading' and (
      v_job.recovery_expires_at is null
      or v_job.recovery_expires_at <= statement_timestamp()
      or v_job.deletion_requested_at is not null
      or v_job.archive_deleted_at is not null
      or exists (
        select 1 from private.stem_retention_items as item
        where item.user_id = p_user_id and item.job_id = p_job_id
          and item.bucket = v_job.source_bucket
          and item.object_path = v_job.source_object_path
          and (item.attempt_count > 0 or item.completed_at is not null)
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Stem archive cleanup has started; create a new import';
  end if;
  return public.finalize_stem_upload_unchecked(
    p_user_id, p_job_id, p_revision, p_observed_bytes, p_storage_etag
  );
end;
$$;

create or replace function public.get_stem_job_for_finalize(
  p_user_id uuid,
  p_job_id uuid
)
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
  perform pg_catalog.pg_advisory_xact_lock(729410222);
  select * into v_job
  from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Stem import not found';
  end if;
  if v_job.status not in ('uploading', 'inspect_queued') then
    raise exception using errcode = '55000',
      message = 'Stem import is not awaiting upload finalization';
  end if;
  if v_job.status = 'uploading' and (
      v_job.recovery_expires_at is null
      or v_job.recovery_expires_at <= statement_timestamp()
      or v_job.deletion_requested_at is not null
      or v_job.archive_deleted_at is not null
      or exists (
        select 1 from private.stem_retention_items as item
        where item.user_id = p_user_id and item.job_id = p_job_id
          and item.bucket = v_job.source_bucket
          and item.object_path = v_job.source_object_path
          and (item.attempt_count > 0 or item.completed_at is not null)
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Stem archive cleanup has started; create a new import';
  end if;
  return jsonb_build_object(
    'id', v_job.id,
    'source_bucket', v_job.source_bucket,
    'source_object_path', v_job.source_object_path,
    'source_bytes', v_job.source_bytes
  );
end;
$$;

create function public.get_stem_job_for_dispatch(p_user_id uuid, p_job_id uuid)
returns jsonb
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
  select * into v_job
  from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'Stem import not found';
  end if;
  if v_job.status not in ('inspect_queued', 'analysis_queued', 'proposal_queued', 'render_queued') then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting dispatch';
  end if;
  select * into v_attempt
  from private.stem_job_attempts
  where id = v_job.active_attempt_id;
  if not found or v_attempt.user_id <> p_user_id or v_attempt.job_id <> p_job_id
     or v_attempt.state not in ('pending_dispatch', 'dispatching', 'reconcile_pending', 'submitted') then
    raise exception using errcode = '55000', message = 'Stem import has no dispatchable attempt';
  end if;
  return to_jsonb(v_job);
end;
$$;

create or replace function public.claim_stem_dispatch(
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
  v_reconcile boolean := false;
  v_job_name text;
begin
  perform private.opusloops_stem_assert_service_role();
  select * into v_job from public.stem_import_jobs
  where user_id = p_user_id and id = p_job_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Stem import not found'; end if;
  if v_job.status not in ('inspect_queued', 'analysis_queued', 'proposal_queued', 'render_queued') then
    raise exception using errcode = '55000', message = 'Stem import is not awaiting dispatch';
  end if;
  select * into v_attempt from private.stem_job_attempts
  where id = v_job.active_attempt_id for update;
  if not found or v_attempt.user_id <> p_user_id or v_attempt.job_id <> p_job_id then
    raise exception using errcode = '55000', message = 'Stem import has no dispatchable attempt';
  end if;

  if v_attempt.external_job_id is not null then
    v_payload := public.get_stem_dispatch_payload(p_user_id, p_job_id);
    return v_payload || jsonb_build_object(
      'dispatchClaimed', false,
      'alreadyDispatched', true,
      'dispatchJobName', v_attempt.dispatch_job_name,
      'reconcileRequired', false
    );
  end if;

  if v_attempt.state = 'dispatching' then
    if v_attempt.dispatch_claim_expires_at > statement_timestamp()
       and v_attempt.dispatch_claim_id <> p_claim_id then
      return jsonb_build_object(
        'version', 1, 'jobId', p_job_id, 'attemptId', v_attempt.id,
        'stage', v_attempt.stage, 'dispatchClaimed', false,
        'alreadyDispatched', false, 'reconcileRequired', false
      );
    end if;
    v_reconcile := true;
  elsif v_attempt.state = 'reconcile_pending' then
    if v_attempt.reconcile_after > statement_timestamp() then
      return jsonb_build_object(
        'version', 1, 'jobId', p_job_id, 'attemptId', v_attempt.id,
        'stage', v_attempt.stage, 'dispatchClaimed', false,
        'alreadyDispatched', false, 'reconcileRequired', true
      );
    end if;
    v_reconcile := true;
  elsif v_attempt.state <> 'pending_dispatch' then
    raise exception using errcode = '55000', message = 'Stem import attempt is not dispatchable';
  end if;

  v_job_name := coalesce(
    v_attempt.dispatch_job_name,
    'opusloops-' || v_attempt.stage || '-' || left(v_job.id::text, 8)
      || '-' || left(v_attempt.id::text, 8)
  );
  update private.stem_job_attempts
  set state = 'dispatching', dispatch_claim_id = p_claim_id,
      dispatch_claim_expires_at = statement_timestamp() + interval '2 minutes',
      dispatch_job_name = v_job_name, dispatch_error = null
  where id = v_attempt.id;

  v_payload := public.get_stem_dispatch_payload(p_user_id, p_job_id);
  return v_payload || jsonb_build_object(
    'dispatchClaimed', true,
    'dispatchClaimId', p_claim_id,
    'dispatchJobName', v_job_name,
    'reconcileRequired', v_reconcile
  );
end;
$$;

create function public.record_stem_dispatch_unknown(
  p_attempt_id uuid,
  p_claim_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.opusloops_stem_assert_service_role();
  update private.stem_job_attempts
  set state = 'reconcile_pending',
      reconcile_after = statement_timestamp() + interval '2 minutes',
      dispatch_error = 'Submission outcome requires reconciliation',
      dispatch_claim_id = null,
      dispatch_claim_expires_at = null
  where id = p_attempt_id and external_job_id is null
    and state = 'dispatching' and dispatch_claim_id = p_claim_id;
  if not found then
    raise exception using errcode = '55000', message = 'Stem dispatch claim is stale';
  end if;
end;
$$;

-- Recording the SubmitJob response is idempotent. A callback can win the race
-- and bind/start the same AWS job before this response is persisted; a late
-- recorder must never regress a running or terminal attempt to submitted.
create or replace function public.record_stem_dispatch(
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
  if p_external_job_id is null or char_length(p_external_job_id) not between 1 and 200
     or p_external_job_id ~ '[[:cntrl:]]' then
    raise exception using errcode = '22023', message = 'Invalid external job identifier';
  end if;
  select * into v_attempt
  from private.stem_job_attempts
  where id = p_attempt_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Stem attempt not found';
  end if;
  if v_attempt.external_job_id is not null then
    if v_attempt.external_job_id <> p_external_job_id then
      raise exception using errcode = '23505', message = 'Stem attempt was already dispatched';
    end if;
    update public.stem_import_jobs
    set aws_job_id = p_external_job_id, updated_at = statement_timestamp()
    where user_id = v_attempt.user_id and id = v_attempt.job_id
      and active_attempt_id = p_attempt_id and aws_job_id is distinct from p_external_job_id;
    return;
  end if;
  if v_attempt.state <> 'dispatching' or v_attempt.dispatch_claim_id <> p_claim_id then
    raise exception using errcode = '55000', message = 'Stem dispatch claim is stale';
  end if;
  update private.stem_job_attempts
  set state = 'submitted', external_job_id = p_external_job_id,
      dispatch_error = null, dispatch_claim_id = null,
      dispatch_claim_expires_at = null, reconcile_after = null,
      dispatched_at = coalesce(dispatched_at, statement_timestamp())
  where id = p_attempt_id;
  update public.stem_import_jobs
  set aws_job_id = p_external_job_id, updated_at = statement_timestamp()
  where user_id = v_attempt.user_id and id = v_attempt.job_id
    and active_attempt_id = p_attempt_id;
end;
$$;

-- Wrap the original callback mutation so dispatch identity is checked under the
-- same job lock before any asset, event, or state mutation occurs.
alter function public.apply_stem_worker_callback(uuid, text, jsonb)
  rename to apply_stem_worker_callback_unchecked;
revoke all on function public.apply_stem_worker_callback_unchecked(uuid, text, jsonb)
  from public, anon, authenticated, service_role;

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
  v_job_id uuid;
  v_attempt_id uuid;
  v_dispatch_job_id text;
  v_stage text;
  v_attempt private.stem_job_attempts;
begin
  perform private.opusloops_stem_assert_service_role();
  begin
    v_job_id := (p_payload ->> 'jobId')::uuid;
    v_attempt_id := (p_payload ->> 'attemptId')::uuid;
    v_dispatch_job_id := p_payload ->> 'dispatchJobId';
    v_stage := p_payload ->> 'stage';
  exception when others then
    raise exception using errcode = '22023', message = 'Invalid worker dispatch binding';
  end;
  if v_dispatch_job_id is null or char_length(v_dispatch_job_id) not between 1 and 200
     or v_dispatch_job_id ~ '[[:cntrl:]]'
     or v_stage not in ('inspect', 'analyze', 'propose', 'render') then
    raise exception using errcode = '22023', message = 'Invalid worker dispatch binding';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_job_id::text, 227131));
  select attempt.* into v_attempt
  from private.stem_job_attempts as attempt
  join public.stem_import_jobs as job
    on job.user_id = attempt.user_id and job.id = attempt.job_id
  where attempt.id = v_attempt_id and attempt.job_id = v_job_id
    and job.active_attempt_id = attempt.id
  for update of attempt;
  if not found or v_attempt.stage <> v_stage then
    raise exception using errcode = '55000', message = 'Worker dispatch is not authoritative';
  end if;
  if v_attempt.external_job_id is null then
    if v_attempt.state not in ('dispatching', 'reconcile_pending')
       or v_attempt.dispatch_job_name is distinct from (
         'opusloops-' || v_attempt.stage || '-' || left(v_job_id::text, 8)
           || '-' || left(v_attempt.id::text, 8)
       ) then
      raise exception using errcode = '55000', message = 'Worker dispatch is not authoritative';
    end if;
    update private.stem_job_attempts
    set external_job_id = v_dispatch_job_id, state = 'submitted',
        dispatch_error = null, dispatch_claim_id = null,
        dispatch_claim_expires_at = null, reconcile_after = null,
        dispatched_at = coalesce(dispatched_at, statement_timestamp())
    where id = v_attempt.id;
    update public.stem_import_jobs
    set aws_job_id = v_dispatch_job_id, updated_at = statement_timestamp()
    where id = v_job_id and user_id = v_attempt.user_id
      and active_attempt_id = v_attempt.id;
  elsif v_attempt.external_job_id <> v_dispatch_job_id then
    raise exception using errcode = '55000', message = 'Worker dispatch is not authoritative';
  end if;
  return public.apply_stem_worker_callback_unchecked(p_nonce, p_request_sha256, p_payload);
end;
$$;

create function public.claim_stem_retention(p_claim_id uuid, p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
  v_remaining integer;
begin
  perform private.opusloops_stem_assert_service_role();
  if p_claim_id is null or p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Invalid retention claim';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(729410222);

  -- Callback signatures expire after five minutes. Keeping nonce responses for
  -- 24 hours preserves a generous retry horizon without unbounded growth.
  delete from private.stem_worker_nonces
  where created_at < statement_timestamp() - interval '24 hours';

  insert into private.stem_retention_scopes (
    user_id, project_id, job_id, reason, bucket, object_prefix, due_at
  )
  select job.user_id, job.project_id, job.id,
    case when job.deletion_requested_at is not null
      then 'project_deleted' else 'recovery_expired' end,
    buckets.bucket,
    job.user_id::text || '/' || job.project_id::text || '/' || job.id::text || '/',
    case when job.deletion_requested_at is not null
      then job.source_delete_after else job.recovery_expires_at end
  from public.stem_import_jobs as job
  cross join (values
    ('opusloops-stem-uploads'::text),
    ('opusloops-stem-sources'::text),
    ('opusloops-stem-artifacts'::text)
  ) as buckets(bucket)
  where (
      (job.deletion_requested_at is not null
        and job.source_delete_after <= statement_timestamp())
      or (job.status in ('uploading', 'failed', 'cancelled')
        and job.recovery_expires_at <= statement_timestamp())
    )
    and (
      buckets.bucket = 'opusloops-stem-uploads'
      or job.status in ('failed', 'cancelled')
      or job.deletion_requested_at is not null
    )
  on conflict (bucket, object_prefix) do update
  set reason = excluded.reason,
      due_at = least(private.stem_retention_scopes.due_at, excluded.due_at),
      completed_at = null,
      updated_at = statement_timestamp();

  insert into private.stem_retention_items (
    user_id, job_id, subject_type, reason, bucket, object_path
  )
  select job.user_id, job.id, 'archive',
    case
      when job.deletion_requested_at is not null and job.source_delete_after <= statement_timestamp()
        then 'project_deleted'
      when job.status = 'ready' then 'archive_expired'
      else 'recovery_expired'
    end,
    job.source_bucket, job.source_object_path
  from public.stem_import_jobs as job
  where job.archive_deleted_at is null
    and (
      job.archive_delete_after <= statement_timestamp()
      or (job.deletion_requested_at is not null and job.source_delete_after <= statement_timestamp())
      or (job.status in ('uploading', 'failed', 'cancelled')
        and job.recovery_expires_at <= statement_timestamp())
    )
  on conflict (bucket, object_path) do nothing;

  insert into private.stem_retention_items (
    user_id, job_id, asset_id, subject_type, reason, bucket, object_path
  )
  select asset.user_id, asset.job_id, asset.asset_id, 'asset',
    case
      when job.deletion_requested_at is not null and job.source_delete_after <= statement_timestamp()
        then 'project_deleted'
      when job.status in ('failed', 'cancelled') and job.recovery_expires_at <= statement_timestamp()
        then 'recovery_expired'
      else 'asset_expired'
    end,
    asset.bucket, asset.object_path
  from public.stem_import_assets as asset
  join public.stem_import_jobs as job
    on job.user_id = asset.user_id and job.id = asset.job_id
  where asset.deleted_at is null
    and (
      asset.retention_until <= statement_timestamp()
      or (job.deletion_requested_at is not null and job.source_delete_after <= statement_timestamp())
      or (job.status in ('failed', 'cancelled')
        and job.recovery_expires_at <= statement_timestamp())
    )
  on conflict (bucket, object_path) do nothing;

  -- Storage itself is the authoritative inventory. This bounded sweep catches
  -- objects uploaded immediately before a worker crash or rejected callback.
  with candidates as (
    select scope.user_id, scope.job_id, scope.reason, object.bucket_id,
      object.name
    from private.stem_retention_scopes as scope
    join storage.objects as object
      on object.bucket_id = scope.bucket
      and object.name like scope.object_prefix || '%'
    left join private.stem_retention_items as existing
      on existing.bucket = object.bucket_id and existing.object_path = object.name
    where scope.completed_at is null and scope.due_at <= statement_timestamp()
      and existing.id is null
      and (
        scope.reason = 'hard_delete'
        or exists (
          select 1 from public.stem_import_jobs as job
          where job.user_id = scope.user_id and job.id = scope.job_id
            and (
              (job.deletion_requested_at is not null
                and job.source_delete_after <= statement_timestamp())
              or (job.status in ('uploading', 'failed', 'cancelled')
                and job.recovery_expires_at <= statement_timestamp()
                and (
                  scope.bucket = 'opusloops-stem-uploads'
                  or job.status in ('failed', 'cancelled')
                ))
            )
        )
      )
    order by scope.due_at, scope.id, object.name
    limit 250
  )
  insert into private.stem_retention_items (
    user_id, job_id, subject_type, reason, bucket, object_path
  )
  select candidate.user_id, candidate.job_id, 'orphan', candidate.reason,
    candidate.bucket_id, candidate.name
  from candidates as candidate
  on conflict (bucket, object_path) do nothing;

  update private.stem_retention_scopes as scope
  set completed_at = statement_timestamp(), updated_at = statement_timestamp()
  where scope.completed_at is null and scope.due_at <= statement_timestamp()
    and not exists (
      select 1 from storage.objects as object
      where object.bucket_id = scope.bucket
        and object.name like scope.object_prefix || '%'
    )
    and not exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = scope.user_id and item.job_id = scope.job_id
        and item.bucket = scope.bucket
        and item.object_path like scope.object_prefix || '%'
        and item.completed_at is null
    );

  with eligible as (
    select item.id
    from private.stem_retention_items as item
    where item.completed_at is null
      and item.next_attempt_at <= statement_timestamp()
      and (item.claim_expires_at is null or item.claim_expires_at <= statement_timestamp())
      and (
        item.reason = 'hard_delete'
        or (item.subject_type = 'archive' and exists (
          select 1 from public.stem_import_jobs as job
          where job.user_id = item.user_id and job.id = item.job_id
            and job.archive_deleted_at is null
            and (
              job.archive_delete_after <= statement_timestamp()
              or (job.deletion_requested_at is not null
                and job.source_delete_after <= statement_timestamp())
              or (job.status in ('uploading', 'failed', 'cancelled')
                and job.recovery_expires_at <= statement_timestamp())
            )
        ))
        or
        (item.subject_type = 'asset' and exists (
          select 1
          from public.stem_import_assets as asset
          join public.stem_import_jobs as job
            on job.user_id = asset.user_id and job.id = asset.job_id
          where asset.user_id = item.user_id and asset.job_id = item.job_id
            and asset.asset_id = item.asset_id and asset.deleted_at is null
            and (
              asset.retention_until <= statement_timestamp()
              or (job.deletion_requested_at is not null
                and job.source_delete_after <= statement_timestamp())
              or (job.status in ('failed', 'cancelled')
                and job.recovery_expires_at <= statement_timestamp())
            )
        ))
        or
        (item.subject_type = 'orphan' and exists (
          select 1 from private.stem_retention_scopes as scope
          where scope.user_id = item.user_id and scope.job_id = item.job_id
            and scope.bucket = item.bucket
            and item.object_path like scope.object_prefix || '%'
            and scope.completed_at is null
            and scope.due_at <= statement_timestamp()
            and (
              scope.reason = 'hard_delete'
              or exists (
                select 1 from public.stem_import_jobs as job
                where job.user_id = scope.user_id and job.id = scope.job_id
                  and (
                    (job.deletion_requested_at is not null
                      and job.source_delete_after <= statement_timestamp())
                    or (job.status in ('uploading', 'failed', 'cancelled')
                      and job.recovery_expires_at <= statement_timestamp()
                      and (
                        scope.bucket = 'opusloops-stem-uploads'
                        or job.status in ('failed', 'cancelled')
                      ))
                  )
              )
            )
        ))
      )
    order by item.next_attempt_at, item.created_at, item.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.stem_retention_items as item
    set claim_id = p_claim_id,
        claim_expires_at = statement_timestamp() + interval '5 minutes',
        attempt_count = attempt_count + 1,
        last_error = null,
        updated_at = statement_timestamp()
    from eligible
    where item.id = eligible.id
    returning item.id, item.bucket, item.object_path
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', claimed.id,
    'bucket', claimed.bucket,
    'objectPath', claimed.object_path
  ) order by claimed.id), '[]'::jsonb)
  into v_items
  from claimed;

  select count(*) into v_remaining
  from private.stem_retention_items as item
  where item.completed_at is null
    and item.next_attempt_at <= statement_timestamp()
    and (item.claim_expires_at is null or item.claim_expires_at <= statement_timestamp())
    and (
      item.reason = 'hard_delete'
      or (item.subject_type = 'archive' and exists (
        select 1 from public.stem_import_jobs as job
        where job.user_id = item.user_id and job.id = item.job_id
          and job.archive_deleted_at is null
          and (
            job.archive_delete_after <= statement_timestamp()
            or (job.deletion_requested_at is not null
              and job.source_delete_after <= statement_timestamp())
            or (job.status in ('uploading', 'failed', 'cancelled')
              and job.recovery_expires_at <= statement_timestamp())
          )
      ))
      or (item.subject_type = 'asset' and exists (
        select 1
        from public.stem_import_assets as asset
        join public.stem_import_jobs as job
          on job.user_id = asset.user_id and job.id = asset.job_id
        where asset.user_id = item.user_id and asset.job_id = item.job_id
          and asset.asset_id = item.asset_id and asset.deleted_at is null
          and (
            asset.retention_until <= statement_timestamp()
            or (job.deletion_requested_at is not null
              and job.source_delete_after <= statement_timestamp())
            or (job.status in ('failed', 'cancelled')
              and job.recovery_expires_at <= statement_timestamp())
          )
      ))
      or (item.subject_type = 'orphan' and exists (
        select 1 from private.stem_retention_scopes as scope
        where scope.user_id = item.user_id and scope.job_id = item.job_id
          and scope.bucket = item.bucket
          and item.object_path like scope.object_prefix || '%'
          and scope.completed_at is null
          and scope.due_at <= statement_timestamp()
          and (
            scope.reason = 'hard_delete'
            or exists (
              select 1 from public.stem_import_jobs as job
              where job.user_id = scope.user_id and job.id = scope.job_id
                and (
                  (job.deletion_requested_at is not null
                    and job.source_delete_after <= statement_timestamp())
                  or (job.status in ('uploading', 'failed', 'cancelled')
                    and job.recovery_expires_at <= statement_timestamp()
                    and (
                      scope.bucket = 'opusloops-stem-uploads'
                      or job.status in ('failed', 'cancelled')
                    ))
                )
            )
          )
      ))
    );

  return jsonb_build_object(
    'claimId', p_claim_id,
    'items', v_items,
    'remaining', v_remaining
  );
end;
$$;

create function public.complete_stem_retention_item(p_claim_id uuid, p_item_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item private.stem_retention_items;
  v_job_deleted boolean := false;
  v_eligible boolean := false;
begin
  perform private.opusloops_stem_assert_service_role();
  select * into v_item
  from private.stem_retention_items
  where id = p_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Retention item not found';
  end if;
  if v_item.completed_at is not null then
    if v_item.claim_id is distinct from p_claim_id then
      raise exception using errcode = '55000', message = 'Retention claim is stale';
    end if;
    return jsonb_build_object('completed', true, 'duplicate', true, 'jobDeleted', false);
  end if;
  if v_item.claim_id is distinct from p_claim_id then
    raise exception using errcode = '55000', message = 'Retention claim is stale';
  end if;

  if v_item.reason = 'hard_delete' then
    v_eligible := true;
  elsif v_item.subject_type = 'archive' then
    select exists (
      select 1 from public.stem_import_jobs as job
      where job.user_id = v_item.user_id and job.id = v_item.job_id
        and job.archive_deleted_at is null
        and (
          job.archive_delete_after <= statement_timestamp()
          or (job.deletion_requested_at is not null
            and job.source_delete_after <= statement_timestamp())
          or (job.status in ('uploading', 'failed', 'cancelled')
            and job.recovery_expires_at <= statement_timestamp())
        )
    ) into v_eligible;
  elsif v_item.subject_type = 'asset' then
    select exists (
      select 1
      from public.stem_import_assets as asset
      join public.stem_import_jobs as job
        on job.user_id = asset.user_id and job.id = asset.job_id
      where asset.user_id = v_item.user_id and asset.job_id = v_item.job_id
        and asset.asset_id = v_item.asset_id and asset.deleted_at is null
        and (
          asset.retention_until <= statement_timestamp()
          or (job.deletion_requested_at is not null
            and job.source_delete_after <= statement_timestamp())
          or (job.status in ('failed', 'cancelled')
            and job.recovery_expires_at <= statement_timestamp())
        )
    ) into v_eligible;
  else
    select exists (
      select 1 from private.stem_retention_scopes as scope
      where scope.user_id = v_item.user_id and scope.job_id = v_item.job_id
        and scope.bucket = v_item.bucket
        and v_item.object_path like scope.object_prefix || '%'
        and scope.completed_at is null
        and scope.due_at <= statement_timestamp()
        and (
          scope.reason = 'hard_delete'
          or exists (
            select 1 from public.stem_import_jobs as job
            where job.user_id = scope.user_id and job.id = scope.job_id
              and (
                (job.deletion_requested_at is not null
                  and job.source_delete_after <= statement_timestamp())
                or (job.status in ('uploading', 'failed', 'cancelled')
                  and job.recovery_expires_at <= statement_timestamp()
                  and (
                    scope.bucket = 'opusloops-stem-uploads'
                    or job.status in ('failed', 'cancelled')
                  ))
              )
          )
        )
    ) into v_eligible;
  end if;
  if not v_eligible then
    raise exception using errcode = '55000', message = 'Retention item is no longer eligible';
  end if;

  if v_item.subject_type = 'archive' then
    update public.stem_import_jobs
    set archive_deleted_at = coalesce(archive_deleted_at, statement_timestamp()),
        updated_at = statement_timestamp()
    where user_id = v_item.user_id and id = v_item.job_id;
    update public.stem_import_assets
    set deleted_at = coalesce(deleted_at, statement_timestamp())
    where user_id = v_item.user_id and job_id = v_item.job_id
      and bucket = v_item.bucket and object_path = v_item.object_path;
  elsif v_item.subject_type = 'asset' then
    update public.stem_import_assets
    set deleted_at = coalesce(deleted_at, statement_timestamp())
    where user_id = v_item.user_id and job_id = v_item.job_id
      and asset_id = v_item.asset_id;
    if not found and v_item.reason <> 'hard_delete' then
      raise exception using errcode = '55000', message = 'Retention asset is stale';
    end if;
  else
    update public.stem_import_assets
    set deleted_at = coalesce(deleted_at, statement_timestamp())
    where user_id = v_item.user_id and job_id = v_item.job_id
      and bucket = v_item.bucket and object_path = v_item.object_path;
    update public.stem_import_jobs
    set archive_deleted_at = coalesce(archive_deleted_at, statement_timestamp()),
        updated_at = statement_timestamp()
    where user_id = v_item.user_id and id = v_item.job_id
      and source_bucket = v_item.bucket and source_object_path = v_item.object_path;
  end if;

  update private.stem_retention_items
  set completed_at = statement_timestamp(), claim_expires_at = null,
      updated_at = statement_timestamp()
  where id = p_item_id;

  update private.stem_retention_scopes as scope
  set completed_at = statement_timestamp(), updated_at = statement_timestamp()
  where scope.user_id = v_item.user_id and scope.job_id = v_item.job_id
    and scope.bucket = v_item.bucket and scope.completed_at is null
    and not exists (
      select 1 from storage.objects as object
      where object.bucket_id = scope.bucket
        and object.name like scope.object_prefix || '%'
    )
    and not exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = scope.user_id and item.job_id = scope.job_id
        and item.bucket = scope.bucket
        and item.object_path like scope.object_prefix || '%'
        and item.completed_at is null
    );

  update public.stem_import_jobs as job
  set status = 'deleted',
      status_before_deletion = null,
      deletion_requested_at = coalesce(job.deletion_requested_at, statement_timestamp()),
      deleted_at = statement_timestamp(),
      revision = revision + 1,
      updated_at = statement_timestamp()
  where job.user_id = v_item.user_id and job.id = v_item.job_id
    and job.archive_deleted_at is not null
    and not exists (
      select 1 from public.stem_import_assets as asset
      where asset.user_id = job.user_id and asset.job_id = job.id
        and asset.deleted_at is null
    )
    and not exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = job.user_id and item.job_id = job.id
        and item.completed_at is null
    )
    and not exists (
      select 1 from storage.objects as object
      where object.bucket_id in (
          'opusloops-stem-uploads', 'opusloops-stem-sources',
          'opusloops-stem-artifacts'
        )
        and object.name like (
          job.user_id::text || '/' || job.project_id::text || '/' || job.id::text || '/%'
        )
    )
    and (
      (job.status = 'deletion_pending' and job.source_delete_after <= statement_timestamp())
      or (job.status in ('uploading', 'failed', 'cancelled')
        and job.recovery_expires_at <= statement_timestamp())
    );
  v_job_deleted := found;

  return jsonb_build_object('completed', true, 'duplicate', false, 'jobDeleted', v_job_deleted);
end;
$$;

create function public.fail_stem_retention_item(
  p_claim_id uuid,
  p_item_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.opusloops_stem_assert_service_role();
  if p_error is null or char_length(p_error) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Invalid retention failure';
  end if;
  update private.stem_retention_items
  set claim_id = null,
      claim_expires_at = null,
      last_error = p_error,
      next_attempt_at = statement_timestamp()
        + least(3600, 30 * greatest(1, attempt_count)) * interval '1 second',
      updated_at = statement_timestamp()
  where id = p_item_id and claim_id = p_claim_id and completed_at is null;
  if not found then
    raise exception using errcode = '55000', message = 'Retention claim is stale';
  end if;
end;
$$;

revoke all on function public.get_stem_job_for_dispatch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_stem_upload(uuid, uuid, bigint, bigint, text)
  from public, anon, authenticated;
revoke all on function public.record_stem_dispatch_unknown(uuid, uuid) from public, anon, authenticated;
revoke all on function public.apply_stem_worker_callback(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.claim_stem_retention(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_stem_retention_item(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_stem_retention_item(uuid, uuid, text) from public, anon, authenticated;
revoke all on function private.opusloops_stem_enqueue_hard_delete()
  from public, anon, authenticated;

grant execute on function public.get_stem_job_for_dispatch(uuid, uuid) to service_role;
grant execute on function public.finalize_stem_upload(uuid, uuid, bigint, bigint, text)
  to service_role;
grant execute on function public.record_stem_dispatch_unknown(uuid, uuid) to service_role;
grant execute on function public.apply_stem_worker_callback(uuid, text, jsonb) to service_role;
grant execute on function public.claim_stem_retention(uuid, integer) to service_role;
grant execute on function public.complete_stem_retention_item(uuid, uuid) to service_role;
grant execute on function public.fail_stem_retention_item(uuid, uuid, text) to service_role;

comment on table private.stem_retention_items is
  'Private leased outbox for idempotent Storage deletion; rows are finalized only after Storage succeeds.';
comment on table private.stem_retention_scopes is
  'Durable parent-free job-prefix inventory used to sweep unregistered Storage objects after terminal or hard deletion.';
