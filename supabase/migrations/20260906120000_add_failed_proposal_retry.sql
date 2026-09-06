-- Recover a proposal whose completion assets were rejected by the callback.
-- The reviewed timing decision is immutable; retry creates only a new worker
-- attempt and never sends the user back through Gate A.

create function public.retry_stem_proposal(
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
  v_failed_attempt private.stem_job_attempts;
  v_attempt_id uuid;
  v_sequence bigint;
  v_reviewed_grid_sha256 text;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);

  -- Retention uses this outer lock. Once the recovery window and outbox are
  -- checked, cleanup cannot race the transition back to proposal_queued.
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
     or v_job.error_code is distinct from 'callback_failed' then
    raise exception using errcode = '55000',
      message = 'Stem proposal failure is not retryable';
  end if;
  if v_job.recovery_expires_at is null
     or v_job.recovery_expires_at <= statement_timestamp()
     or v_job.deletion_requested_at is not null
     or v_job.archive_deleted_at is not null
     or v_job.deleted_at is not null
     or v_job.status_before_deletion is not null then
    raise exception using errcode = '55000',
      message = 'Stem proposal recovery is no longer available';
  end if;

  select * into v_failed_attempt
  from private.stem_job_attempts
  where id = v_job.active_attempt_id
  for update;

  if not found
     or v_failed_attempt.user_id <> p_user_id
     or v_failed_attempt.job_id <> p_job_id
     or v_failed_attempt.stage <> 'propose'
     or v_failed_attempt.state <> 'failed' then
    raise exception using errcode = '55000',
      message = 'Stem import has no failed proposal attempt';
  end if;

  -- Revalidate every persisted input needed by the worker. trim_scale restores
  -- the canonical numeric representation used before first_downbeat_seconds
  -- was stored in its fixed-scale table column.
  if v_job.gate_a_approved_at is null
     or v_job.gate_a_approved_by is distinct from p_user_id
     or v_job.analysis_sha256 is null
     or v_job.analysis_sha256 !~ '^[0-9a-f]{64}$'
     or v_job.proposal_id is null
     or v_job.proposal_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_job.conform_mode is null
     or v_job.conform_mode not in ('musical-4bar', 'rigid-beat', 'no-conform')
     or (v_job.conform_mode = 'no-conform' and v_job.target_bpm is not null)
     or (v_job.conform_mode <> 'no-conform' and (
       v_job.target_bpm is null or v_job.target_bpm not between 20 and 400
     )) then
    raise exception using errcode = '55000',
      message = 'Stem proposal inputs are incomplete';
  end if;

  perform private.opusloops_stem_validate_reviewed_grid(
    v_job.reviewed_grid,
    v_job.analysis_sha256,
    v_job.meter_numerator,
    v_job.meter_denominator,
    v_job.first_downbeat_seconds
  );
  v_reviewed_grid_sha256 := private.opusloops_stem_json_sha256(
    jsonb_build_object(
      'reviewedGrid', v_job.reviewed_grid,
      'meterNumerator', v_job.meter_numerator,
      'meterDenominator', v_job.meter_denominator,
      'firstDownbeatSeconds', pg_catalog.trim_scale(v_job.first_downbeat_seconds)
    )
  );
  if v_job.reviewed_grid_sha256 is distinct from v_reviewed_grid_sha256 then
    raise exception using errcode = '55000',
      message = 'Stem proposal timing binding is invalid';
  end if;

  -- A failed proposal must not have reached Gate B or rendering. Refuse to
  -- erase unexpected downstream state under the guise of a retry.
  if v_job.proposal_manifest_sha256 is not null
     or v_job.proposal is not null
     or v_job.tempo_approval is not null
     or v_job.tempo_approval_sha256 is not null
     or v_job.gate_b_approved_at is not null
     or v_job.gate_b_approved_by is not null
     or v_job.render_manifest_sha256 is not null
     or v_job.render_result is not null
     or v_job.archive_delete_after is not null then
    raise exception using errcode = '55000',
      message = 'Stem proposal has unexpected downstream state';
  end if;

  if exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = p_user_id and item.job_id = p_job_id
    ) or exists (
      select 1 from private.stem_retention_scopes as scope
      where scope.user_id = p_user_id and scope.job_id = p_job_id
    ) then
    raise exception using errcode = '55000',
      message = 'Stem proposal cleanup has started; create a new import';
  end if;

  if not exists (
    select 1
    from public.stem_import_assets as asset
    where asset.user_id = p_user_id
      and asset.job_id = p_job_id
      and asset.kind = 'state_index'
      and asset.variant = 'analysis'
      and asset.deleted_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'Stem analysis state is no longer available';
  end if;

  -- Asset callbacks are transactional for one batch. A registered object from
  -- the failed attempt means a larger, partially accepted publish and needs a
  -- separate reconciliation path rather than an automatic replay.
  if exists (
    select 1
    from public.stem_import_assets as asset
    where asset.user_id = p_user_id
      and asset.job_id = p_job_id
      and asset.deleted_at is null
      and asset.object_path like (
        v_job.user_id::text || '/' || v_job.project_id::text || '/'
          || v_job.id::text || '/attempts/' || v_failed_attempt.id::text
          || '/propose/%'
      )
  ) then
    raise exception using errcode = '55000',
      message = 'Stem proposal published partial assets; manual recovery is required';
  end if;

  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'proposal_queued',
      revision = revision + 1,
      active_attempt_id = null,
      aws_job_id = null,
      error_code = null,
      error_message = null,
      updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id
  returning * into v_job;

  v_attempt_id := private.opusloops_stem_begin_attempt(
    p_user_id, p_job_id, 'propose', v_job.revision
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
      'message', 'Proposal retry queued',
      'operation', 'retry-proposal',
      'proposalId', v_job.proposal_id
    )
  );

  return to_jsonb(v_job);
end;
$$;

revoke all on function public.retry_stem_proposal(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.retry_stem_proposal(uuid, uuid, bigint)
  to service_role;

comment on function public.retry_stem_proposal(uuid, uuid, bigint) is
  'Creates a fresh propose attempt for an intact callback_failed proposal while preserving the reviewed timing decision.';
