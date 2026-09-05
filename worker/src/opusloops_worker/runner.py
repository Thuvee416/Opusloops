"""One-shot worker orchestration for the four immutable Batch stages."""

from __future__ import annotations

import math
import os
import statistics
import tempfile
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from pathlib import Path

from .callback import CallbackClient, event_payload
from .contracts import JobContract, ObjectReference
from .errors import ContractError, IntegrityError, WorkerError
from .harness import HarnessRunner
from .normalization import (
    analysis_selection_from_patch,
    load_run_json,
    proposal_regions,
    tempo_approval_from_patch,
    validate_reviewed_grid,
)
from .preview import (
    SAMPLE_RATE,
    PreviewSegment,
    create_four_bar_previews,
    create_mobile_click_audition,
)
from .storage import (
    ObjectStore,
    S3ObjectStore,
    StateSnapshot,
    StoredObject,
    asset_payload,
    load_state,
    publish_state,
)

HarnessFactory = Callable[..., HarnessRunner]
PreviewFactory = Callable[..., tuple[PreviewSegment, ...]]


class ProgressEmitter:
    """Translate byte callbacks into independently monotonic operation streams."""

    def __init__(self, callback: CallbackClient, operation_prefix: str) -> None:
        self.callback = callback
        self.operation_prefix = operation_prefix
        self.index = 0
        self._last: tuple[int, int, str] | None = None

    def __call__(self, completed: int, total: int, unit: str) -> None:
        current = (completed, total, unit)
        if current == self._last:
            return
        self._last = current
        self.callback.send(
            event=event_payload(
                status="progress",
                operation=f"{self.operation_prefix}-{self.index:04d}",
                determinate=True,
                completed=completed,
                total=total,
                unit=unit,
                detail={"source": "storage"},
            )
        )
        if completed == total:
            self.index += 1
            self._last = None


def _state_reference(job: JobContract) -> ObjectReference:
    if job.stage == "analyze":
        assert job.inputs.inspection_manifest is not None
        return job.inputs.inspection_manifest
    if job.stage == "propose":
        assert job.inputs.analysis is not None
        return job.inputs.analysis
    if job.stage == "render":
        assert job.inputs.proposal is not None
        return job.inputs.proposal
    raise ContractError("inspect does not restore a prior state")


def _meaningful_asset(
    entry_path: str,
    stored: StoredObject,
    *,
    job: JobContract,
    variant: str,
    manifest: Mapping[str, object],
    previews: Mapping[str, PreviewSegment],
) -> dict[str, object] | None:
    name = Path(entry_path).name
    lowered = entry_path.lower()
    kind: str | None = None
    asset_variant = variant
    metadata: dict[str, object] = {}

    track_id: str | None = None
    audio_assets = manifest.get("audio_assets")
    if isinstance(audio_assets, list):
        for item in audio_assets:
            if not isinstance(item, Mapping) or not isinstance(item.get("asset_id"), str):
                continue
            candidate_id = str(item["asset_id"])
            canonical = item.get("canonical_pcm")
            if (
                entry_path == f"extracted/{item.get('normalized_name')}"
                or isinstance(canonical, Mapping)
                and canonical.get("path") == entry_path
                or name == f"{candidate_id}.wav"
                and "/renders/" in f"/{entry_path}"
            ):
                track_id = candidate_id
                break

    if entry_path == "run-manifest.json":
        kind = "run_manifest"
    elif entry_path == "events.jsonl":
        kind = "report"
        asset_variant = "event-journal"
    elif entry_path.startswith("extracted/") and job.stage == "inspect":
        if track_id is None:
            raise IntegrityError("extracted source has no track asset binding")
        kind = "source_member"
        asset_variant = "original"
        metadata["trackAssetId"] = track_id
    elif entry_path.startswith("canonical/") and job.stage == "inspect":
        if track_id is None:
            raise IntegrityError("canonical source has no track asset binding")
        kind = "canonical"
        asset_variant = "48khz-f32"
        metadata["trackAssetId"] = track_id
    elif "/renders/linked/" in f"/{entry_path}" and name.endswith(".wav"):
        track_id = track_id or Path(entry_path).stem
        kind = "render_linked"
        asset_variant = track_id
        metadata["trackAssetId"] = track_id
    elif "/renders/independent/" in f"/{entry_path}" and name.endswith(".wav"):
        track_id = track_id or Path(entry_path).stem
        kind = "render_independent"
        asset_variant = track_id
        metadata["trackAssetId"] = track_id
    elif name == "analysis-selection.template.json" and job.stage == "inspect":
        kind = "selection"
        asset_variant = "template"
    elif name == "analysis-selection.json" and job.stage == "analyze":
        kind = "selection"
        asset_variant = "approved"
    elif name == "analysis.json" and job.stage == "analyze":
        kind = "analysis"
        asset_variant = "default"
    elif name == "reference.wav" and "analysis-attempts/" in entry_path and job.stage == "analyze":
        kind = "reference"
        asset_variant = "analysis"
    elif (
        name == "tempo-grid.template.json"
        and "analysis-attempts/" in entry_path
        and job.stage == "analyze"
    ):
        kind = "grid"
        asset_variant = "analysis"
    elif (
        name == "tempo-grid.input.json"
        and "/proposals/" in f"/{entry_path}"
        and job.stage == "propose"
    ):
        kind = "grid"
        asset_variant = variant
    elif name == "mobile-click-audition.m4a" and job.stage == "propose":
        kind = "click"
        asset_variant = variant
    elif name == "tempo-map.proposal.json" and job.stage == "propose":
        kind = "proposal_manifest"
        asset_variant = variant
    elif name == "tempo-approval.json" and job.stage == "render":
        kind = "approval"
        asset_variant = job.inputs.proposal_id or variant
    elif name == "render-metrics.json" and job.stage == "render":
        kind = "metrics"
        asset_variant = "render"
    elif lowered.startswith("mobile-previews/") and name.endswith(".m4a"):
        preview = previews.get(entry_path)
        if preview is None:
            raise ContractError("published preview is missing its frame metadata")
        kind = "preview_segment"
        asset_variant = f"{preview.stem_id}-r{preview.index}"
        metadata = {
            "trackAssetId": preview.stem_id,
            "regionIndex": preview.index,
            "startBar": preview.index * preview.bars + 1,
            "barCount": preview.bars,
            "targetBpm": preview.target_bpm,
            "startSeconds": preview.start_frame / SAMPLE_RATE,
            "durationSeconds": (preview.end_frame - preview.start_frame) / SAMPLE_RATE,
            "codec": preview.codec,
        }
    if kind is None:
        return None
    return asset_payload(
        stored,
        job=job,
        kind=kind,
        variant=asset_variant,
        metadata=metadata,
    )


def _publish_asset_batches(
    callback: CallbackClient,
    assets: Sequence[Mapping[str, object]],
    *,
    batch_size: int = 80,
) -> None:
    if not assets:
        return
    total = len(assets)
    completed = 0
    for offset in range(0, total, batch_size):
        batch = assets[offset : offset + batch_size]
        completed += len(batch)
        callback.send(
            event=event_payload(
                status="progress",
                operation="publishing-assets",
                determinate=True,
                completed=completed,
                total=total,
                unit="artifacts",
                detail={"source": "storage"},
            ),
            assets=batch,
        )


def _asset_matches(
    assets: Sequence[Mapping[str, object]],
    kind: str,
    *,
    variant: str | None = None,
    track_id: str | None = None,
) -> list[Mapping[str, object]]:
    matches: list[Mapping[str, object]] = []
    for asset in assets:
        if asset.get("kind") != kind or (variant is not None and asset.get("variant") != variant):
            continue
        metadata = asset.get("metadata")
        if track_id is not None and (
            not isinstance(metadata, Mapping) or metadata.get("trackAssetId") != track_id
        ):
            continue
        matches.append(asset)
    return matches


def _only_asset(
    assets: Sequence[Mapping[str, object]],
    kind: str,
    *,
    variant: str | None = None,
    track_id: str | None = None,
) -> Mapping[str, object]:
    matches = _asset_matches(assets, kind, variant=variant, track_id=track_id)
    if len(matches) != 1:
        raise IntegrityError(f"stage did not publish exactly one required {kind} asset")
    return matches[0]


def _state_binding(state: StateSnapshot) -> dict[str, object]:
    return {
        "bucket": state.reference.bucket,
        "key": state.reference.key,
        "sha256": state.reference.sha256,
    }


def _median_bpm(beats: object) -> float | None:
    if not isinstance(beats, list) or len(beats) < 2:
        return None
    try:
        intervals = [
            float(right) - float(left) for left, right in zip(beats, beats[1:], strict=False)
        ]
    except (TypeError, ValueError):
        return None
    positive = [value for value in intervals if math.isfinite(value) and value > 0]
    if not positive:
        return None
    return round(60.0 / statistics.median(positive), 6)


def _inferred_meter(beats: object, downbeats: object) -> dict[str, int]:
    if not isinstance(beats, list) or not isinstance(downbeats, list) or len(downbeats) < 2:
        return {"numerator": 4, "denominator": 4}
    try:
        beat_values = [float(value) for value in beats]
        indexes = [
            min(range(len(beat_values)), key=lambda index: abs(beat_values[index] - float(value)))
            for value in downbeats
        ]
        spans = [right - left for left, right in zip(indexes, indexes[1:], strict=False)]
        numerator = round(statistics.median(value for value in spans if value > 0))
    except (TypeError, ValueError, statistics.StatisticsError):
        numerator = 4
    if not 1 <= numerator <= 32:
        numerator = 4
    return {"numerator": numerator, "denominator": 4}


def _inspect_tracks(
    manifest: Mapping[str, object], assets: Sequence[Mapping[str, object]]
) -> list[dict[str, object]]:
    audio_assets = manifest.get("audio_assets")
    selection_template = manifest.get("analysis_selection")
    roles: dict[str, str] = {}
    # The generated template is not stored in the manifest. Asset roles are
    # reconstructed from the template by the caller and passed via this key.
    if isinstance(selection_template, Mapping):
        selected = selection_template.get("assets")
        if isinstance(selected, list):
            roles = {
                str(item.get("asset_id")): str(item.get("role"))
                for item in selected
                if isinstance(item, Mapping) and isinstance(item.get("asset_id"), str)
            }
    if not isinstance(audio_assets, list) or len(audio_assets) > 128:
        raise IntegrityError("inspection manifest has an invalid track inventory")
    tracks: list[dict[str, object]] = []
    for item in audio_assets:
        if not isinstance(item, Mapping) or not isinstance(item.get("asset_id"), str):
            raise IntegrityError("inspection manifest contains an invalid track")
        track_id = str(item["asset_id"])
        source = _only_asset(assets, "source_member", track_id=track_id)
        canonical = _only_asset(assets, "canonical", track_id=track_id)
        track = {
            "assetId": track_id,
            "name": str(item.get("original_name") or item.get("normalized_name") or track_id)[:255],
            "role": roles.get(track_id, "other"),
            "durationSeconds": float(item.get("duration_seconds") or 0),
            "bytes": int(source["bytes"]),
            "sha256": str(source["sha256"]),
            "contentType": str(source["contentType"]),
            "canonicalAssetId": str(canonical["id"]),
        }
        tracks.append(track)
    return tracks


def _stage_result(
    *,
    job: JobContract,
    run_dir: Path,
    state: StateSnapshot,
    assets: Sequence[Mapping[str, object]],
    source: StoredObject | None,
) -> dict[str, object]:
    manifest = load_run_json(run_dir, "run-manifest.json")
    manifest_asset = _only_asset(
        assets,
        "run_manifest",
        variant=(
            "inspection"
            if job.stage == "inspect"
            else "analysis"
            if job.stage == "analyze"
            else job.inputs.proposal_id
            if job.stage == "propose"
            else "render"
        ),
    )
    state_value = _state_binding(state)
    if job.stage == "inspect":
        if source is None:
            raise IntegrityError("inspection has no measured source binding")
        selection = load_run_json(run_dir, "analysis-selection.template.json").get("selection")
        summary_manifest = dict(manifest)
        summary_manifest["analysis_selection"] = selection
        return {
            "sourceSha256": source.sha256,
            "manifestSha256": str(manifest_asset["sha256"]),
            "manifestAssetId": str(manifest_asset["id"]),
            "tracks": _inspect_tracks(summary_manifest, assets),
            "state": state_value,
        }
    if job.stage == "analyze":
        analysis_record = manifest.get("analysis")
        if not isinstance(analysis_record, Mapping) or not isinstance(
            analysis_record.get("artifact"), Mapping
        ):
            raise IntegrityError("analyze stage produced no bound analysis record")
        analysis_path = analysis_record["artifact"].get("path")
        if not isinstance(analysis_path, str):
            raise IntegrityError("analysis artifact path is invalid")
        analysis = load_run_json(run_dir, analysis_path)
        primary = analysis.get("primary")
        if not isinstance(primary, Mapping):
            raise IntegrityError("analysis result has no primary beat result")
        analysis_asset = _only_asset(assets, "analysis", variant="default")
        grid_asset = _only_asset(assets, "grid", variant="analysis")
        beats = primary.get("beats_seconds")
        downbeats = primary.get("downbeats_seconds")
        first_downbeat = float(downbeats[0]) if isinstance(downbeats, list) and downbeats else 0.0
        duration = primary.get("reference_duration_seconds")
        if not isinstance(duration, int | float) or isinstance(duration, bool):
            frames = primary.get("reference_frames")
            rate = primary.get("reference_sample_rate")
            duration = (
                float(frames) / float(rate)
                if isinstance(frames, int) and isinstance(rate, int) and rate > 0
                else 0.0
            )
        return {
            "analysisSha256": str(analysis_asset["sha256"]),
            "analysisAssetId": str(analysis_asset["id"]),
            "gridAssetId": str(grid_asset["id"]),
            "attemptId": str(analysis.get("attempt_id") or ""),
            "durationSeconds": float(duration),
            "medianBpm": _median_bpm(beats),
            "meter": _inferred_meter(beats, downbeats),
            "firstDownbeatSeconds": first_downbeat,
            "issues": ["Confirm the detected beat grid, meter, and first downbeat."],
            "requiresHumanConfirmation": True,
            "state": state_value,
        }
    if job.stage == "propose":
        assert job.inputs.proposal_id is not None
        proposal_asset = _only_asset(assets, "proposal_manifest", variant=job.inputs.proposal_id)
        click_asset = _only_asset(assets, "click", variant=job.inputs.proposal_id)
        regions = proposal_regions(run_dir, job.inputs.proposal_id)
        return {
            "proposalId": job.inputs.proposal_id,
            "proposalManifestSha256": str(proposal_asset["sha256"]),
            "proposalManifestAssetId": str(proposal_asset["id"]),
            "clickAssetId": str(click_asset["id"]),
            "targetBpm": job.inputs.target_bpm,
            "mode": job.inputs.mode,
            "regions": regions,
            "flaggedRegions": sum(1 for region in regions if region["flagged"] is True),
            "state": state_value,
        }

    linked = _asset_matches(assets, "render_linked")
    independent = _asset_matches(assets, "render_independent")
    previews = _asset_matches(assets, "preview_segment")
    preview_ends = []
    for preview in previews:
        metadata = preview.get("metadata")
        if not isinstance(metadata, Mapping):
            continue
        start = metadata.get("startSeconds")
        duration = metadata.get("durationSeconds")
        if (
            isinstance(start, int | float)
            and not isinstance(start, bool)
            and isinstance(duration, int | float)
            and not isinstance(duration, bool)
        ):
            preview_ends.append(float(start) + float(duration))
    return {
        "renderManifestSha256": str(manifest_asset["sha256"]),
        "renderManifestAssetId": str(manifest_asset["id"]),
        "durationSeconds": max(preview_ends, default=0.0),
        "previewSegments": len(previews),
        "linkedAssets": [str(asset["id"]) for asset in linked],
        "independentAssets": [str(asset["id"]) for asset in independent],
        "state": state_value,
    }


def run_job(
    job: JobContract,
    *,
    store: ObjectStore,
    callback: CallbackClient,
    scratch_root: Path,
    harness_factory: HarnessFactory = HarnessRunner,
    preview_factory: PreviewFactory = create_four_bar_previews,
) -> Mapping[str, object]:
    callback.send(event=event_payload(status="started", operation=job.stage))
    try:
        scratch_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name == "posix":
            os.chmod(scratch_root, 0o700)
        with tempfile.TemporaryDirectory(
            prefix=f"opusloops-{job.stage}-{job.attempt_id}-", dir=scratch_root
        ) as temporary_name:
            work_dir = Path(temporary_name).resolve()
            if os.name == "posix":
                os.chmod(work_dir, 0o700)
            run_dir = work_dir / "run"
            previous: StateSnapshot | None = None
            if job.stage != "inspect":
                callback.send(event=event_payload(status="progress", operation="restoring-state"))
                previous = load_state(
                    store,
                    job=job,
                    reference=_state_reference(job),
                    run_dir=run_dir,
                    progress=ProgressEmitter(callback, "restore-state"),
                )

            harness = harness_factory(
                run_dir=run_dir,
                work_dir=work_dir,
                emit=lambda event: callback.send(event=event),
            )
            harness_result: Mapping[str, object]
            previews: tuple[PreviewSegment, ...] = ()
            source_object: StoredObject | None = None
            if job.stage == "inspect":
                archive_dir = work_dir / "input"
                archive_dir.mkdir(mode=0o700)
                archive = archive_dir / "stems.zip"
                source_object = store.download(
                    bucket=job.storage.upload_bucket,
                    key=job.storage.source_key,
                    destination=archive,
                    expected_sha256=None,
                    progress=ProgressEmitter(callback, "download-source"),
                )
                harness_result = harness.inspect(archive)
                variant = "inspection"
            elif job.stage == "analyze":
                assert job.inputs.selection is not None
                selection = analysis_selection_from_patch(run_dir, job.inputs.selection)
                harness_result = harness.approve_and_analyze(selection, approved_by=job.user_id)
                variant = "analysis"
            elif job.stage == "propose":
                assert job.inputs.proposal_id is not None
                assert job.inputs.mode is not None
                assert job.inputs.reviewed_grid is not None
                reviewed_grid, meter_numerator, meter_denominator, first_downbeat = (
                    validate_reviewed_grid(
                        run_dir,
                        job.inputs.reviewed_grid,
                        meter_numerator=job.inputs.meter_numerator,
                        meter_denominator=job.inputs.meter_denominator,
                        first_downbeat_seconds=job.inputs.first_downbeat_seconds,
                    )
                )
                harness_result = harness.propose(
                    proposal_id=job.inputs.proposal_id,
                    mode=job.inputs.mode,
                    target_bpm=job.inputs.target_bpm,
                    reviewed_grid=reviewed_grid,
                    meter_numerator=meter_numerator,
                    meter_denominator=meter_denominator,
                    first_downbeat=first_downbeat,
                )
                create_mobile_click_audition(
                    source=run_dir
                    / "proposals"
                    / job.inputs.proposal_id
                    / "raw-grid-click-audition.wav",
                    destination=run_dir
                    / "proposals"
                    / job.inputs.proposal_id
                    / "mobile-click-audition.m4a",
                    ffmpeg=harness.ffmpeg,
                )
                variant = job.inputs.proposal_id
            else:
                assert job.inputs.approval is not None
                assert job.inputs.proposal_id is not None
                approval = tempo_approval_from_patch(
                    run_dir,
                    job.inputs.approval,
                    proposal_id=job.inputs.proposal_id,
                )
                harness_result = harness.approve_and_render(approval, approved_by=job.user_id)
                previews = preview_factory(
                    run_dir=run_dir,
                    ffmpeg=harness.ffmpeg,
                )
                variant = "render"
            harness.verify()

            callback.send(event=event_payload(status="progress", operation="publishing-state"))
            state, index_object = publish_state(
                store,
                job=job,
                run_dir=run_dir,
                variant=variant,
                previous=previous,
                progress=ProgressEmitter(callback, "publish-state"),
            )
            preview_by_relative = {
                item.path.relative_to(run_dir).as_posix(): item for item in previews
            }
            manifest = load_run_json(run_dir, "run-manifest.json")
            assets = [
                asset_payload(
                    index_object,
                    job=job,
                    kind="state_index",
                    variant=variant,
                    metadata={"fileCount": len(state.entries)},
                )
            ]
            if source_object is not None:
                assets.append(
                    asset_payload(
                        source_object,
                        job=job,
                        kind="source_zip",
                        variant="original",
                        metadata={},
                    )
                )
            for entry in state.entries:
                asset = _meaningful_asset(
                    entry.relative_path,
                    entry.object,
                    job=job,
                    variant=variant,
                    manifest=manifest,
                    previews=preview_by_relative,
                )
                if asset is not None:
                    assets.append(asset)
            _publish_asset_batches(callback, assets)
            result = _stage_result(
                job=job,
                run_dir=run_dir,
                state=state,
                assets=assets,
                source=source_object,
            )
            callback.send(
                event=event_payload(status="completed", operation=job.stage),
                result=result,
            )
            return {"result": result, "harnessStatus": harness_result.get("status", "completed")}
    except WorkerError as exc:
        with suppress(WorkerError):
            callback.send(
                event=event_payload(status="failed", operation=job.stage),
                error={
                    "code": exc.code,
                    "message": exc.public_message,
                    "retryable": exc.retryable,
                },
            )
        raise
    except Exception as exc:
        error = WorkerError(
            "internal_worker_error",
            "The isolated worker failed without publishing incomplete results",
            retryable=False,
        )
        with suppress(WorkerError):
            callback.send(
                event=event_payload(status="failed", operation=job.stage),
                error={
                    "code": error.code,
                    "message": error.public_message,
                    "retryable": error.retryable,
                },
            )
        raise error from exc


def production_dependencies(job: JobContract) -> tuple[S3ObjectStore, CallbackClient, Path]:
    dispatch_job_id = os.environ.get("AWS_BATCH_JOB_ID", "")
    store = S3ObjectStore(
        endpoint=job.storage.endpoint,
        region=job.storage.region,
        access_key_id=job.storage.access_key_id,
        secret_access_key=job.storage.secret_access_key,
        session_token=job.storage.session_token,
    )
    callback = CallbackClient(
        job=job,
        dispatch_job_id=dispatch_job_id,
        secret=job.callback_token,
    )
    scratch_root = Path(os.environ.get("OPUSLOOPS_SCRATCH_ROOT", "/scratch")).resolve()
    return store, callback, scratch_root
