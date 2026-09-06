-- Read the mutable job and its event cursor from one PostgreSQL snapshot. The
-- event cap bounds polling responses while retaining chronological delivery.
create function public.get_stem_import_event_snapshot(
  p_job_id uuid,
  p_after_sequence bigint default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with owned_job as materialized (
    select job.*
    from public.stem_import_jobs as job
    where job.id = p_job_id
      and job.user_id = (select auth.uid())
    limit 1
  ), recent_events as materialized (
    select event.*
    from public.stem_import_events as event
    join owned_job as job
      on job.user_id = event.user_id and job.id = event.job_id
    where event.sequence > greatest(coalesce(p_after_sequence, 0), 0)
    order by event.sequence desc
    limit 200
  )
  select jsonb_build_object(
    'job', to_jsonb(job),
    'events', coalesce(
      (
        select jsonb_agg(to_jsonb(event) order by event.sequence)
        from recent_events as event
      ),
      '[]'::jsonb
    )
  )
  from owned_job as job;
$$;

revoke all on function public.get_stem_import_event_snapshot(uuid, bigint)
  from public, anon, service_role;
grant execute on function public.get_stem_import_event_snapshot(uuid, bigint)
  to authenticated;

comment on function public.get_stem_import_event_snapshot(uuid, bigint) is
  'Returns one owned stem job and up to the latest 200 newer events from a single database snapshot.';

-- Rebuild a renderer-incompatible, already approved tempo proposal from the
-- retained analysis. The old proposal and approval remain immutable assets;
-- the replacement proposal must pass a fresh Gate B before rendering.

create function public.repair_stem_render_proposal(
  p_user_id uuid,
  p_job_id uuid,
  p_revision bigint,
  p_proposal_manifest_sha256 text
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
  v_old_proposal_id text;
  v_new_proposal_id text;
begin
  perform private.opusloops_stem_assert_service_role();
  perform private.opusloops_stem_assert_member(p_user_id);

  -- Retention claims use the outer lock. Once the retained inputs and absence
  -- of cleanup are confirmed, storage deletion cannot race this repair.
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
     or p_proposal_manifest_sha256 is distinct from v_job.proposal_manifest_sha256 then
    raise exception using errcode = '22023', message = 'Proposal binding is stale';
  end if;
  if v_job.status <> 'failed'
     or v_job.error_code is distinct from 'tempo_map_preroll_invalid' then
    raise exception using errcode = '55000',
      message = 'Stem render failure is not repairable';
  end if;
  if v_job.recovery_expires_at is null
     or v_job.recovery_expires_at <= statement_timestamp()
     or v_job.deletion_requested_at is not null
     or v_job.source_delete_after is not null
     or v_job.archive_deleted_at is not null
     or v_job.deleted_at is not null
     or v_job.status_before_deletion is not null then
    raise exception using errcode = '55000',
      message = 'Stem render recovery is no longer available';
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

  -- Gate A, source, and analysis are the provenance required to regenerate the
  -- proposal without reinterpreting any user decision.
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
  ) then
    raise exception using errcode = '55000',
      message = 'Stem source archive is no longer available';
  end if;

  if not exists (
    select 1 from public.stem_import_assets as asset
    where asset.user_id = p_user_id and asset.job_id = p_job_id
      and asset.kind = 'state_index' and asset.variant = 'analysis'
      and asset.deleted_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'Stem analysis state is no longer available';
  end if;

  -- The reviewed timing request remains immutable and hash-bound. Only the
  -- worker-generated renderer representation is being regenerated.
  if v_job.proposal_id is null
     or v_job.proposal_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     or v_job.conform_mode is null
     or v_job.conform_mode not in ('musical-4bar', 'rigid-beat', 'no-conform')
     or (v_job.conform_mode = 'no-conform' and v_job.target_bpm is not null)
     or (v_job.conform_mode <> 'no-conform' and (
       v_job.target_bpm is null or v_job.target_bpm not between 20 and 400
     )) then
    raise exception using errcode = '55000',
      message = 'Stem proposal timing inputs are incomplete';
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

  -- Preserve proof of the old proposal and Gate B, but ensure every mutable
  -- job-level reference is self-consistent before it is cleared.
  if v_job.proposal is null
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
    select 1 from public.stem_import_assets as asset
    where asset.user_id = p_user_id and asset.job_id = p_job_id
      and asset.kind = 'state_index' and asset.variant = v_job.proposal_id
      and asset.deleted_at is null
  ) then
    raise exception using errcode = '55000',
      message = 'Stem proposal state is no longer available';
  end if;

  -- A failed render that published anything needs reconciliation rather than
  -- automatic repair. Check registered outputs and the authoritative Storage
  -- inventory so an object from a rejected callback is not overlooked.
  if v_job.render_manifest_sha256 is not null
     or v_job.render_result is not null
     or v_job.archive_delete_after is not null
     or exists (
       select 1 from public.stem_import_assets as asset
       where asset.user_id = p_user_id and asset.job_id = p_job_id
         and asset.deleted_at is null
         and (
           asset.kind in ('render_linked', 'render_independent', 'preview_segment')
           or asset.object_path like (
             v_job.user_id::text || '/' || v_job.project_id::text || '/'
               || v_job.id::text || '/attempts/' || v_failed_attempt.id::text
               || '/render/%'
           )
         )
     ) or exists (
       select 1 from storage.objects as object
       where object.bucket_id in ('opusloops-stem-sources', 'opusloops-stem-artifacts')
         and object.name like (
           v_job.user_id::text || '/' || v_job.project_id::text || '/'
             || v_job.id::text || '/attempts/' || v_failed_attempt.id::text
             || '/render/%'
         )
     ) then
    raise exception using errcode = '55000',
      message = 'Stem render published partial output; manual recovery is required';
  end if;

  if exists (
      select 1 from private.stem_retention_items as item
      where item.user_id = p_user_id and item.job_id = p_job_id
    ) or exists (
      select 1 from private.stem_retention_scopes as scope
      where scope.user_id = p_user_id and scope.job_id = p_job_id
    ) then
    raise exception using errcode = '55000',
      message = 'Stem render cleanup has started; create a new import';
  end if;

  perform private.opusloops_stem_assert_processing_slot(p_user_id, p_job_id);

  v_old_proposal_id := v_job.proposal_id;
  v_new_proposal_id := 'repair-' || pg_catalog.replace(gen_random_uuid()::text, '-', '');

  update public.stem_import_jobs
  set status = 'proposal_queued',
      revision = revision + 1,
      proposal_id = v_new_proposal_id,
      proposal_manifest_sha256 = null,
      proposal = null,
      tempo_approval = null,
      tempo_approval_sha256 = null,
      gate_b_approved_at = null,
      gate_b_approved_by = null,
      render_manifest_sha256 = null,
      render_result = null,
      archive_delete_after = null,
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
      'message', 'Renderer-safe proposal repair queued',
      'operation', 'repair-render-proposal',
      'proposalId', v_new_proposal_id,
      'previousProposalId', v_old_proposal_id
    )
  );

  return to_jsonb(v_job);
end;
$$;

revoke all on function public.repair_stem_render_proposal(uuid, uuid, bigint, text)
  from public, anon, authenticated;
grant execute on function public.repair_stem_render_proposal(uuid, uuid, bigint, text)
  to service_role;

comment on function public.repair_stem_render_proposal(uuid, uuid, bigint, text) is
  'Regenerates a renderer-safe proposal after an allowlisted pre-roll failure; a fresh Gate B is required.';

-- One already-observed production failure predates the specific worker error
-- code. Reclassify only that exact immutable proposal and only while every
-- repair invariant still proves that no render output or cleanup was started.
do $$
declare
  v_job public.stem_import_jobs;
  v_attempt private.stem_job_attempts;
  v_latest_render_event public.stem_import_events;
  v_reviewed_grid_sha256 text;
  v_safe boolean := false;
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
    and error_code = 'calibration_stage_failed'
    and error_message = 'calibration command returned invalid JSON'
    and aws_job_id = 'c5f87466-1c3c-4948-810d-38bd5f262079'
    and proposal_manifest_sha256 =
      '4b1cff17f2e5ba4a2339e3e5af3204a120c5a45fc9fe6b6e34cd973627703ddd'
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

    v_reviewed_grid_sha256 := private.opusloops_stem_json_sha256(
      jsonb_build_object(
        'reviewedGrid', v_job.reviewed_grid,
        'meterNumerator', v_job.meter_numerator,
        'meterDenominator', v_job.meter_denominator,
        'firstDownbeatSeconds', pg_catalog.trim_scale(v_job.first_downbeat_seconds)
      )
    );

    v_safe := v_attempt.id is not null
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
      and v_job.source_sha256 ~ '^[0-9a-f]{64}$'
      and v_job.inspection_manifest_sha256 ~ '^[0-9a-f]{64}$'
      and v_job.inspection is not null
      and v_job.analysis_selection is not null
      and v_job.analysis_selection_sha256 =
        private.opusloops_stem_json_sha256(v_job.analysis_selection)
      and v_job.gate_a_approved_at is not null
      and v_job.gate_a_approved_by = v_job.user_id
      and v_job.analysis_sha256 ~ '^[0-9a-f]{64}$'
      and v_job.analysis ->> 'analysisSha256' = v_job.analysis_sha256
      and v_job.reviewed_grid_sha256 = v_reviewed_grid_sha256
      and v_job.proposal_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      and v_job.conform_mode in ('musical-4bar', 'rigid-beat', 'no-conform')
      and (
        (v_job.conform_mode = 'no-conform' and v_job.target_bpm is null)
        or (v_job.conform_mode <> 'no-conform' and v_job.target_bpm between 20 and 400)
      )
      and v_job.proposal ->> 'proposalId' = v_job.proposal_id
      and v_job.proposal ->> 'proposalManifestSha256' = v_job.proposal_manifest_sha256
      and v_job.tempo_approval ->> 'proposalId' = v_job.proposal_id
      and v_job.tempo_approval_sha256 =
        private.opusloops_stem_json_sha256(v_job.tempo_approval)
      and v_job.gate_b_approved_at is not null
      and v_job.gate_b_approved_by = v_job.user_id
      and v_job.render_manifest_sha256 is null
      and v_job.render_result is null
      and v_job.archive_delete_after is null
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
        select 1 from storage.objects as object
        where object.bucket_id = v_job.source_bucket
          and object.name = v_job.source_object_path
          and object.owner_id = v_job.user_id::text
          and case
            when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
              then (object.metadata ->> 'size')::numeric = v_job.source_bytes
            else false
          end
      )
      and exists (
        select 1 from public.stem_import_assets as asset
        where asset.user_id = v_job.user_id and asset.job_id = v_job.id
          and asset.kind = 'state_index' and asset.variant = 'analysis'
          and asset.deleted_at is null
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
            asset.kind in ('render_linked', 'render_independent', 'preview_segment')
            or asset.object_path like (
              v_job.user_id::text || '/' || v_job.project_id::text || '/'
                || v_job.id::text || '/attempts/' || v_attempt.id::text
                || '/render/%'
            )
          )
      )
      and not exists (
        select 1 from storage.objects as object
        where object.bucket_id in ('opusloops-stem-sources', 'opusloops-stem-artifacts')
          and object.name like (
            v_job.user_id::text || '/' || v_job.project_id::text || '/'
              || v_job.id::text || '/attempts/' || v_attempt.id::text
              || '/render/%'
          )
      );

    if v_safe then
      begin
        perform private.opusloops_stem_validate_reviewed_grid(
          v_job.reviewed_grid,
          v_job.analysis_sha256,
          v_job.meter_numerator,
          v_job.meter_denominator,
          v_job.first_downbeat_seconds
        );
      exception when others then
        v_safe := false;
      end;
    end if;

    if v_safe then
      update public.stem_import_jobs
      set revision = revision + 1,
          error_code = 'tempo_map_preroll_invalid',
          error_message =
            'The approved tempo map needs a compatibility update before rendering.',
          updated_at = statement_timestamp()
      where user_id = v_job.user_id and id = v_job.id
        and revision = v_job.revision
        and error_code = 'calibration_stage_failed'
        and aws_job_id = 'c5f87466-1c3c-4948-810d-38bd5f262079'
        and proposal_manifest_sha256 =
          '4b1cff17f2e5ba4a2339e3e5af3204a120c5a45fc9fe6b6e34cd973627703ddd';

      if found then
        v_sequence := private.opusloops_stem_next_sequence(v_job.user_id, v_job.id);
        insert into public.stem_import_events (
          user_id, job_id, sequence, attempt_id, stage, status, determinate,
          completed, total, unit, detail
        ) values (
          v_job.user_id, v_job.id, v_sequence, v_attempt.id,
          'diagnostic', 'completed', false, null, null, null,
          jsonb_build_object(
            'message', 'Renderer pre-roll incompatibility identified',
            'operation', 'classify-render-failure',
            'previousErrorCode', 'calibration_stage_failed'
          )
        );
      end if;
    end if;
  end if;
end;
$$;
