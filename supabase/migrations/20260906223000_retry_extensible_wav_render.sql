-- Retry the exact approved render after the worker gains support for canonical
-- IEEE-float WAVE_FORMAT_EXTENSIBLE files. This path preserves both approval
-- gates and refuses any attempt that may have published render output.

create function public.retry_stem_render(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_proposal_manifest_sha256 text,
  p_tempo_approval_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.stem_import_jobs;
  v_failed_attempt private.stem_job_attempts;
  v_latest_render_event public.stem_import_events;
  v_attempt_id uuid;
  v_sequence bigint;
  v_reviewed_grid_sha256 text;
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
  if v_job.revision is distinct from p_revision then
    raise exception using errcode = '40001', message = 'Stale stem import revision';
  end if;
  if p_proposal_manifest_sha256 is null
     or p_proposal_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_proposal_manifest_sha256 is distinct from v_job.proposal_manifest_sha256
     or p_tempo_approval_sha256 is null
     or p_tempo_approval_sha256 !~ '^[0-9a-f]{64}$'
     or p_tempo_approval_sha256 is distinct from v_job.tempo_approval_sha256 then
    raise exception using errcode = '22023', message = 'Render approval binding is stale';
  end if;
  if v_job.status <> 'failed'
     or v_job.error_code is distinct from 'canonical_wav_extensible_unsupported' then
    raise exception using errcode = '55000', message = 'Stem render failure is not retryable';
  end if;
  if v_job.recovery_expires_at is null
     or v_job.recovery_expires_at <= statement_timestamp()
     or v_job.deletion_requested_at is not null
     or v_job.source_delete_after is not null
     or v_job.archive_deleted_at is not null
     or v_job.deleted_at is not null
     or v_job.status_before_deletion is not null then
    raise exception using errcode = '55000', message = 'Stem render recovery is no longer available';
  end if;

  select * into v_failed_attempt
  from private.stem_job_attempts
  where id = v_job.active_attempt_id
  for update;

  if not found
     or v_failed_attempt.user_id <> p_user_id
     or v_failed_attempt.job_id <> p_job_id
     or v_failed_attempt.stage <> 'render'
     or v_failed_attempt.state <> 'failed'
     or exists (
       select 1 from private.stem_job_attempts as newer
       where newer.user_id = p_user_id and newer.job_id = p_job_id
         and newer.id <> v_failed_attempt.id
         and newer.job_revision >= v_failed_attempt.job_revision
     ) then
    raise exception using errcode = '55000',
      message = 'Stem import has no latest failed render attempt';
  end if;

  select * into v_latest_render_event
  from public.stem_import_events as event
  where event.user_id = p_user_id and event.job_id = p_job_id
    and event.attempt_id = v_failed_attempt.id and event.stage = 'render'
  order by event.sequence desc
  limit 1;

  if not found or v_latest_render_event.status <> 'failed' then
    raise exception using errcode = '55000',
      message = 'Stem import has no latest failed render event';
  end if;

  if v_job.source_sha256 is null
     or v_job.source_sha256 !~ '^[0-9a-f]{64}$'
     or v_job.inspection_manifest_sha256 is null
     or v_job.inspection_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or v_job.inspection is null
     or v_job.analysis_selection is null
     or v_job.analysis_selection_sha256 is distinct from
       private.opusloops_stem_json_sha256(v_job.analysis_selection)
     or v_job.gate_a_approved_at is null
     or v_job.gate_a_approved_by is distinct from p_user_id
     or v_job.analysis_sha256 is null
     or v_job.analysis_sha256 !~ '^[0-9a-f]{64}$'
     or v_job.analysis is null
     or v_job.analysis ->> 'analysisSha256' is distinct from v_job.analysis_sha256 then
    raise exception using errcode = '55000',
      message = 'Stem source, Gate A, or analysis binding is incomplete';
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
    raise exception using errcode = '55000', message = 'Stem proposal timing binding is invalid';
  end if;

  if v_job.proposal_id is null
     or v_job.proposal_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_job.proposal_manifest_sha256 is null
     or v_job.proposal_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or v_job.proposal is null
     or v_job.proposal ->> 'proposalId' is distinct from v_job.proposal_id
     or v_job.proposal ->> 'proposalManifestSha256'
       is distinct from v_job.proposal_manifest_sha256
     or v_job.tempo_approval is null
     or v_job.tempo_approval ->> 'proposalId' is distinct from v_job.proposal_id
     or v_job.tempo_approval_sha256 is distinct from
       private.opusloops_stem_json_sha256(v_job.tempo_approval)
     or v_job.gate_b_approved_at is null
     or v_job.gate_b_approved_by is distinct from p_user_id then
    raise exception using errcode = '55000',
      message = 'Stem proposal or Gate B binding is incomplete';
  end if;

  if not exists (
    select 1 from storage.objects as object
    where object.bucket_id = v_job.source_bucket
      and object.name = v_job.source_object_path
      and object.owner_id = p_user_id::text
      and case
        when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
          then (object.metadata ->> 'size')::numeric = v_job.source_bytes
        else false
      end
  ) or not exists (
    select 1 from public.stem_import_assets as asset
    where asset.user_id = p_user_id and asset.job_id = p_job_id
      and asset.kind = 'state_index' and asset.variant = v_job.proposal_id
      and asset.deleted_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'Stem source or approved proposal state is no longer available';
  end if;

  if v_job.render_manifest_sha256 is not null
     or v_job.render_result is not null
     or v_job.archive_delete_after is not null
     or exists (
       select 1 from private.stem_retention_items as item
       where item.user_id = p_user_id and item.job_id = p_job_id
     )
     or exists (
       select 1 from private.stem_retention_scopes as scope
       where scope.user_id = p_user_id and scope.job_id = p_job_id
     )
     or exists (
       select 1 from public.stem_import_assets as asset
       where asset.user_id = p_user_id and asset.job_id = p_job_id
         and asset.deleted_at is null
         and (
           asset.kind in (
             'approval', 'render_linked', 'render_independent',
             'preview_segment', 'metrics'
           )
           or (asset.kind in ('state_index', 'run_manifest') and asset.variant = 'render')
           or asset.object_path like (
             v_job.user_id::text || '/' || v_job.project_id::text || '/'
               || v_job.id::text || '/attempts/' || v_failed_attempt.id::text
               || '/render/%'
           )
         )
     )
     or exists (
       select 1 from storage.objects as object
       where object.bucket_id in ('opusloops-stem-sources', 'opusloops-stem-artifacts')
         and object.name like (
           v_job.user_id::text || '/' || v_job.project_id::text || '/'
             || v_job.id::text || '/attempts/' || v_failed_attempt.id::text
             || '/render/%'
         )
     )
     or exists (
       select 1 from public.stem_import_events as event
       where event.user_id = p_user_id and event.job_id = p_job_id
         and event.attempt_id = v_failed_attempt.id
         and event.detail ->> 'operation' in ('publishing-state', 'publishing-assets')
     ) then
    raise exception using errcode = '55000',
      message = 'Stem render published partial output or cleanup has started';
  end if;

  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  update public.stem_import_jobs
  set status = 'render_queued',
      revision = revision + 1,
      active_attempt_id = null,
      aws_job_id = null,
      error_code = null,
      error_message = null,
      updated_at = statement_timestamp()
  where user_id = p_user_id and id = p_job_id
  returning * into v_job;

  v_attempt_id := private.opusloops_stem_begin_attempt(
    p_user_id, p_job_id, 'render', v_job.revision
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
      'message', 'Approved render retry queued',
      'operation', 'retry-render',
      'proposalId', v_job.proposal_id,
      'proposalManifestSha256', v_job.proposal_manifest_sha256,
      'tempoApprovalSha256', v_job.tempo_approval_sha256
    )
  );

  return to_jsonb(v_job);
end;
$$;

revoke all on function public.retry_stem_render(uuid, uuid, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.retry_stem_render(uuid, uuid, bigint, text, text)
  to service_role;

comment on function public.retry_stem_render(uuid, uuid, bigint, text, text) is
  'Creates a fresh render attempt for an allowlisted worker-compatibility failure while preserving the exact proposal and Gate B.';

-- Reclassify only the observed production failure. This does not retry it;
-- the authenticated retry action below still revalidates every invariant and
-- performs the durable dispatch with the user's scoped worker credentials.
do $$
declare
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
  v_latest_render_event public.stem_import_events;
  v_sequence bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(729410222);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      '0e1c9e9b-f554-446b-b06f-4c69c43ebc98'::uuid::text,
      227131
    )
  );

  select * into v_job
  from public.stem_import_jobs
  where id = '0e1c9e9b-f554-446b-b06f-4c69c43ebc98'
    and status = 'failed'
    and revision = 1711
    and error_code = 'calibration_stage_failed'
    and error_message = 'calibration harness rejected the requested stage'
    and active_attempt_id = 'd6e46699-f68e-4d60-ac36-1b8b5ac1d8f5'
    and aws_job_id = '34e6b69f-3ce4-4335-ab64-ea49f293d2e7'
    and proposal_id = 'repair-f3b75baf93bb411ca873957e7906a0a2'
    and proposal_manifest_sha256 =
      'bf8cc458bef7cf90f60fcebd05f17b0bed6a8423b841096bfc3637177d2454aa'
    and tempo_approval_sha256 =
      'ddfd73969172dcc7ec44703ffb1e607240c24d0fd5cdd5362db78a7c0d9ddf13'
    and render_manifest_sha256 is null
    and render_result is null
    and archive_delete_after is null
  for update;

  if found then
    select * into v_attempt
    from private.stem_job_attempts
    where id = v_job.active_attempt_id
    for update;

    select * into v_latest_render_event
    from public.stem_import_events as event
    where event.user_id = v_job.user_id and event.job_id = v_job.id
      and event.attempt_id = v_job.active_attempt_id and event.stage = 'render'
    order by event.sequence desc
    limit 1;

    if v_attempt.id is not null
       and v_attempt.user_id = v_job.user_id
       and v_attempt.job_id = v_job.id
       and v_attempt.stage = 'render'
       and v_attempt.state = 'failed'
       and v_latest_render_event.status = 'failed'
       and v_job.recovery_expires_at > statement_timestamp()
       and v_job.deletion_requested_at is null
       and v_job.source_delete_after is null
       and v_job.archive_deleted_at is null
       and v_job.deleted_at is null
       and v_job.status_before_deletion is null
       and v_job.proposal ->> 'proposalId' = v_job.proposal_id
       and v_job.proposal ->> 'proposalManifestSha256' = v_job.proposal_manifest_sha256
       and v_job.tempo_approval ->> 'proposalId' = v_job.proposal_id
       and v_job.tempo_approval_sha256 =
         private.opusloops_stem_json_sha256(v_job.tempo_approval)
       and v_job.gate_b_approved_at is not null
       and v_job.gate_b_approved_by = v_job.user_id
       and not exists (
         select 1 from private.stem_job_attempts as newer
         where newer.user_id = v_job.user_id and newer.job_id = v_job.id
           and newer.id <> v_attempt.id
           and newer.job_revision >= v_attempt.job_revision
       )
       and not exists (
         select 1 from private.stem_retention_items as item
         where item.user_id = v_job.user_id and item.job_id = v_job.id
       )
       and not exists (
         select 1 from private.stem_retention_scopes as scope
         where scope.user_id = v_job.user_id and scope.job_id = v_job.id
       )
       and exists (
         select 1 from public.stem_import_assets as asset
         where asset.user_id = v_job.user_id and asset.job_id = v_job.id
           and asset.kind = 'state_index' and asset.variant = v_job.proposal_id
           and asset.deleted_at is null
       )
       and not exists (
         select 1 from public.stem_import_assets as asset
         where asset.user_id = v_job.user_id and asset.job_id = v_job.id
           and asset.deleted_at is null
           and (
             asset.kind in (
               'approval', 'render_linked', 'render_independent',
               'preview_segment', 'metrics'
             )
             or (asset.kind in ('state_index', 'run_manifest') and asset.variant = 'render')
             or asset.object_path like (
               v_job.user_id::text || '/' || v_job.project_id::text || '/'
                 || v_job.id::text || '/attempts/' || v_attempt.id::text || '/render/%'
             )
           )
       )
       and not exists (
         select 1 from storage.objects as object
         where object.bucket_id in ('opusloops-stem-sources', 'opusloops-stem-artifacts')
           and object.name like (
             v_job.user_id::text || '/' || v_job.project_id::text || '/'
               || v_job.id::text || '/attempts/' || v_attempt.id::text || '/render/%'
           )
       )
       and not exists (
         select 1 from public.stem_import_events as event
         where event.user_id = v_job.user_id and event.job_id = v_job.id
           and event.attempt_id = v_attempt.id
           and event.detail ->> 'operation' in ('publishing-state', 'publishing-assets')
       ) then
      update public.stem_import_jobs
      set revision = revision + 1,
          error_code = 'canonical_wav_extensible_unsupported',
          error_message = 'The audio format is ready to retry with the updated renderer.',
          updated_at = statement_timestamp()
      where user_id = v_job.user_id and id = v_job.id
        and revision = 1711
        and active_attempt_id = 'd6e46699-f68e-4d60-ac36-1b8b5ac1d8f5'
        and aws_job_id = '34e6b69f-3ce4-4335-ab64-ea49f293d2e7';

      if found then
        v_sequence := private.opusloops_stem_next_sequence(v_job.user_id, v_job.id);
        insert into public.stem_import_events (
          user_id, job_id, sequence, attempt_id, stage, status, determinate,
          completed, total, unit, detail
        ) values (
          v_job.user_id, v_job.id, v_sequence, v_attempt.id,
          'diagnostic', 'completed', false, null, null, null,
          jsonb_build_object(
            'message', 'Canonical WAV compatibility issue identified',
            'operation', 'classify-render-failure',
            'previousErrorCode', 'calibration_stage_failed'
          )
        );
      end if;
    end if;
  end if;
end;
$$;
