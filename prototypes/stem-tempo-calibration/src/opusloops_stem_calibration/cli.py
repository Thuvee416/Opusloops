"""Command-line orchestration for the production-isolated calibration harness."""

from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import stat
import sys
import uuid
from collections.abc import Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from .beat_tracker import (
    BeatAnalysis,
    BeatThisAdapter,
    LibrosaDiagnostic,
    LibrosaDrumStemDiagnostic,
    analyze_reference,
    create_click_audition,
    run_diagnostic_analysis,
)
from .manifest import (
    RunManifest,
    append_event,
    approval_binding,
    artifact_reference,
    atomic_create_json,
    atomic_write_bytes,
    atomic_write_json,
    canonical_json_bytes,
    load_json,
    sha256_file,
    utc_now,
    validate_analysis_selection,
    validate_tempo_approval_schema,
    verify_artifact_reference,
    verify_event_journal,
)
from .reference import ReferenceResult, ReferenceStem, build_reference, view_canonical_stem
from .tempo_map import (
    build_tempo_map,
    seconds_to_frame,
    validate_anchor_payload,
)


class CalibrationCLIError(RuntimeError):
    """A command cannot safely advance the run state."""


def _run_path(value: str | os.PathLike[str]) -> Path:
    return Path(value).resolve()


def _manifest_path(run_dir: Path) -> Path:
    return run_dir / "run-manifest.json"


def _ensure_private_directory(path: Path, *, parents: bool = False) -> bool:
    """Create one private directory without changing permissions on an existing one."""

    if path.is_symlink():
        raise CalibrationCLIError(f"directory path must not be a symlink: {path}")
    if path.exists():
        if not path.is_dir():
            raise CalibrationCLIError(f"directory path is not a directory: {path}")
        return False
    try:
        path.mkdir(mode=0o700, parents=parents)
    except FileExistsError as exc:
        if path.is_symlink() or not path.is_dir():
            raise CalibrationCLIError(f"directory path is not a real directory: {path}") from exc
        return False
    except OSError as exc:
        raise CalibrationCLIError(f"cannot create private directory {path}: {exc}") from exc
    try:
        path.chmod(0o700)
    except OSError as exc:
        raise CalibrationCLIError(f"cannot secure private directory {path}: {exc}") from exc
    return True


@contextmanager
def _exclusive_render_lock(run_dir: Path):
    """Serialize bake-offs without leaving a crash-stale ownership claim."""

    path = run_dir / ".render-bakeoff.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise CalibrationCLIError(f"cannot open render-bakeoff lock: {exc}") from exc
    try:
        descriptor_stat = os.fstat(descriptor)
        path_stat = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(descriptor_stat.st_mode)
            or not stat.S_ISREG(path_stat.st_mode)
            or descriptor_stat.st_nlink != 1
            or path_stat.st_nlink != 1
            or (descriptor_stat.st_dev, descriptor_stat.st_ino)
            != (path_stat.st_dev, path_stat.st_ino)
        ):
            raise CalibrationCLIError("render-bakeoff lock must be a bound regular file")
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        if os.name == "posix":
            import fcntl

            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CalibrationCLIError("another render bake-off is already running") from exc
        elif os.name == "nt":  # pragma: no cover - exercised on Windows workers
            import msvcrt

            if descriptor_stat.st_size == 0:
                os.write(descriptor, b"\0")
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise CalibrationCLIError("another render bake-off is already running") from exc
        else:  # pragma: no cover - explicit fail-closed portability boundary
            raise CalibrationCLIError("render-bakeoff locking is unsupported on this platform")
        yield
    finally:
        if os.name == "posix":
            with suppress(OSError):
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
        elif os.name == "nt":  # pragma: no cover - exercised on Windows workers
            with suppress(OSError):
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def _create_render_attempt(run_dir: Path) -> tuple[str, Path]:
    attempts = run_dir / "render-attempts"
    _ensure_private_directory(attempts, parents=True)
    for _ in range(16):
        attempt_id = f"render-{uuid.uuid4().hex}"
        attempt_dir = attempts / attempt_id
        try:
            attempt_dir.mkdir(mode=0o700)
        except FileExistsError:
            continue
        except OSError as exc:
            raise CalibrationCLIError(f"cannot create render attempt: {exc}") from exc
        attempt_stat = attempt_dir.stat(follow_symlinks=False)
        if not stat.S_ISDIR(attempt_stat.st_mode):
            raise CalibrationCLIError("render attempt is not a real directory")
        if os.name == "posix" and stat.S_IMODE(attempt_stat.st_mode) != 0o700:
            raise CalibrationCLIError("render attempt directory is not owner-only")
        return attempt_id, attempt_dir
    raise CalibrationCLIError("cannot allocate a unique render attempt")


def _render_attempt_from_event(run_dir: Path, event: Mapping[str, object]) -> str:
    details = event.get("details")
    attempt_id = details.get("attempt_id") if isinstance(details, Mapping) else None
    if not isinstance(attempt_id, str) or re.fullmatch(r"render-[0-9a-f]{32}", attempt_id) is None:
        raise CalibrationCLIError("cannot recover render stage with an invalid attempt_id")
    attempt_dir = run_dir / "render-attempts" / attempt_id
    try:
        attempt_stat = attempt_dir.stat(follow_symlinks=False)
        resolved_attempt = attempt_dir.resolve(strict=True)
    except OSError as exc:
        raise CalibrationCLIError("cannot recover missing render attempt directory") from exc
    if (
        attempt_dir.is_symlink()
        or not stat.S_ISDIR(attempt_stat.st_mode)
        or resolved_attempt != attempt_dir
    ):
        raise CalibrationCLIError("cannot recover render stage from an unsafe attempt directory")
    if os.name == "posix" and stat.S_IMODE(attempt_stat.st_mode) != 0o700:
        raise CalibrationCLIError(
            "cannot recover render stage from a non-private attempt directory"
        )
    if hasattr(os, "geteuid") and attempt_stat.st_uid != os.geteuid():
        raise CalibrationCLIError("cannot recover render stage owned by another user")
    return attempt_id


def _close_interrupted_render_stages(run_dir: Path) -> None:
    """Turn crash-left bake-off stages terminal before starting a fresh attempt."""

    event_path = run_dir / "events.jsonl"
    if not (event_path.exists() or event_path.is_symlink()):
        return
    tracked = {"rendering", "measuring-render-metrics"}
    active: dict[str, dict[str, object]] = {}
    for event in verify_event_journal(run_dir):
        stage = event["stage"]
        if stage not in tracked:
            continue
        status = event["status"]
        if status == "started" or (status == "progress" and stage in active):
            active[stage] = event
        elif status in {"completed", "failed", "skipped"}:
            active.pop(stage, None)

    attempt_ids = {_render_attempt_from_event(run_dir, event) for event in active.values()}
    if len(attempt_ids) > 1:
        raise CalibrationCLIError("cannot recover render stages from different attempts")
    for stage, last_event in sorted(active.items(), key=lambda item: int(item[1]["sequence"])):
        attempt_id = _render_attempt_from_event(run_dir, last_event)
        recovery_details = {
            "attempt_id": attempt_id,
            "error": "previous render process ended before recording a terminal event",
            "recovered_on_retry": True,
            "last_event_sequence": int(last_event["sequence"]),
        }
        progress = last_event.get("progress")
        if isinstance(progress, Mapping):
            append_event(
                run_dir,
                stage,
                "failed",
                completed=int(progress["completed"]),
                total=int(progress["total"]),
                unit=str(progress["unit"]),
                details=recovery_details,
            )
        else:
            append_event(run_dir, stage, "failed", details=recovery_details)


def _load_manifest(run_dir: Path) -> RunManifest:
    path = _manifest_path(run_dir)
    if not path.is_file():
        raise CalibrationCLIError(f"run manifest is missing: {path}")
    return RunManifest.load(path)


def _print_result(value: Mapping[str, object]) -> None:
    print(json.dumps(value, ensure_ascii=False, sort_keys=True))


def _event_callback(run_dir: Path, *, attempt_id: str | None = None):
    def callback(stage: str, status: str, data: dict[str, object]) -> None:
        details = dict(data)
        if attempt_id is not None:
            details["attempt_id"] = attempt_id
        completed = details.pop("completed_frames", None)
        total = details.pop("total_frames", None)
        if completed is not None or total is not None:
            append_event(
                run_dir,
                stage,
                status,
                completed=completed,
                total=total,
                unit="frames",
                details=details or None,
            )
        else:
            append_event(run_dir, stage, status, details=details or None)

    return callback


def _source_binding(manifest: RunManifest) -> dict[str, str]:
    if manifest.path is None:
        raise CalibrationCLIError("run manifest has no persisted inspection state")
    run_dir = manifest.path.parent.resolve()
    snapshot, snapshot_path = _verified_inspection_snapshot(run_dir, manifest)
    source = snapshot.data.get("source_archive")
    if not isinstance(source, Mapping):
        raise CalibrationCLIError("inspection snapshot has no inspected source archive")
    archive_hash = source.get("sha256")
    inventory_hash = source.get("inventory_sha256")
    if not isinstance(archive_hash, str) or not isinstance(inventory_hash, str):
        raise CalibrationCLIError("run manifest source archive hashes are incomplete")
    return approval_binding(
        snapshot_path,
        source_archive_sha256=archive_hash,
        inventory_sha256=inventory_hash,
    )


_IMMUTABLE_INGEST_FIELDS = ("source_archive", "policy", "entries", "audio_assets")


def _preserve_inspection_snapshot(run_dir: Path, manifest: RunManifest) -> Path:
    """Copy the exact inspect manifest bytes once, then bind them into live state."""

    if manifest.path is None or manifest.path.resolve() != _manifest_path(run_dir).resolve():
        raise CalibrationCLIError("inspection manifest must be persisted in its run directory")
    if manifest.data.get("inspection_snapshot") is not None:
        raise CalibrationCLIError("inspection snapshot is already bound")
    if any(
        manifest.data.get(key) != expected
        for key, expected in (
            ("analysis_selection", None),
            ("analysis", None),
            ("tempo_map", None),
            ("renders", []),
            ("metrics", None),
            ("toolchain", {}),
        )
    ):
        raise CalibrationCLIError("inspection snapshot cannot include post-inspection state")
    snapshot_path = run_dir / "artifacts" / "inspection-manifest.json"
    if snapshot_path.exists() or snapshot_path.is_symlink():
        raise CalibrationCLIError("inspection snapshot already exists; refusing to overwrite it")
    _ensure_private_directory(snapshot_path.parent, parents=True)
    try:
        snapshot_bytes = manifest.path.read_bytes()
    except OSError as exc:
        raise CalibrationCLIError(f"cannot read inspection manifest: {exc}") from exc
    atomic_write_bytes(snapshot_path, snapshot_bytes, mode=0o400)
    snapshot = RunManifest.load(snapshot_path)
    if snapshot.data.get("inspection_snapshot") is not None:
        raise CalibrationCLIError("inspection snapshot must not recursively bind itself")
    manifest.data["inspection_snapshot"] = artifact_reference(snapshot_path, run_dir)
    manifest.write()
    return snapshot_path


def _verified_inspection_snapshot(
    run_dir: Path,
    manifest: RunManifest,
) -> tuple[RunManifest, Path]:
    """Validate immutable ingest state against its exact approval-time snapshot."""

    snapshot_reference = manifest.data.get("inspection_snapshot")
    if not isinstance(snapshot_reference, Mapping):
        raise CalibrationCLIError("run manifest has no bound inspection snapshot")
    snapshot_path = verify_artifact_reference(snapshot_reference, run_dir)
    snapshot = RunManifest.load(snapshot_path)
    if snapshot.data.get("run_id") != manifest.data.get("run_id"):
        raise CalibrationCLIError("inspection snapshot belongs to a different run")
    if snapshot.data.get("inspection_snapshot") is not None:
        raise CalibrationCLIError("inspection snapshot recursively binds another snapshot")
    if any(
        snapshot.data.get(key) != expected
        for key, expected in (
            ("analysis_selection", None),
            ("analysis", None),
            ("tempo_map", None),
            ("renders", []),
            ("metrics", None),
            ("toolchain", {}),
        )
    ):
        raise CalibrationCLIError("inspection snapshot contains post-inspection state")
    for field in _IMMUTABLE_INGEST_FIELDS:
        if canonical_json_bytes(manifest.data.get(field)) != canonical_json_bytes(
            snapshot.data.get(field)
        ):
            raise CalibrationCLIError(f"immutable ingest field changed after Gate A: {field}")
    # This re-hashes accepted extracted inputs and every canonical WAV recorded
    # in the snapshot. It is intentionally repeated at approval/verify/render
    # boundaries rather than trusting mutable paths.
    snapshot.verify_artifacts(run_dir)
    return snapshot, snapshot_path


def _asset_records(manifest: RunManifest) -> dict[str, Mapping[str, object]]:
    records = manifest.data.get("audio_assets")
    if not isinstance(records, list) or not records:
        raise CalibrationCLIError("run manifest has no decoded audio assets")
    result: dict[str, Mapping[str, object]] = {}
    for value in records:
        if not isinstance(value, Mapping):
            raise CalibrationCLIError("run manifest contains an invalid audio asset")
        asset_id = value.get("asset_id")
        if not isinstance(asset_id, str) or not asset_id or asset_id in result:
            raise CalibrationCLIError("run manifest has an invalid or duplicate asset_id")
        result[asset_id] = value
    return result


def _validate_selection_assets(approval: Mapping[str, object], manifest: RunManifest) -> None:
    manifest_assets = _asset_records(manifest)
    selection = approval.get("selection")
    if not isinstance(selection, Mapping) or not isinstance(selection.get("assets"), list):
        raise CalibrationCLIError("analysis selection has no asset inventory")
    selected_assets = selection["assets"]
    ids = {
        item.get("asset_id")
        for item in selected_assets
        if isinstance(item, Mapping) and isinstance(item.get("asset_id"), str)
    }
    if ids != set(manifest_assets):
        raise CalibrationCLIError(
            "analysis selection must list every inspected audio asset exactly once"
        )
    drum_crosscheck_asset_id = selection.get("drum_crosscheck_asset_id")
    if drum_crosscheck_asset_id is not None:
        drum_choice = next(
            (
                item
                for item in selected_assets
                if isinstance(item, Mapping) and item.get("asset_id") == drum_crosscheck_asset_id
            ),
            None,
        )
        if not isinstance(drum_choice, Mapping):
            raise CalibrationCLIError(
                "drum_crosscheck_asset_id must reference an inspected audio asset"
            )
        if drum_choice.get("included") is not True:
            raise CalibrationCLIError("drum cross-check asset must be included in the reference")
        if drum_choice.get("role") != "drums":
            raise CalibrationCLIError("drum cross-check asset must have the drums role")


def _gate_a(
    run_dir: Path,
    manifest: RunManifest,
    *,
    inspection_state: tuple[RunManifest, Path] | None = None,
) -> Mapping[str, object]:
    approval_path = run_dir / "analysis-selection.json"
    if not approval_path.is_file():
        raise CalibrationCLIError(
            "Gate A is not approved: run approve-analysis after reviewing files and method"
        )
    snapshot, snapshot_path = inspection_state or _verified_inspection_snapshot(run_dir, manifest)
    approval = load_json(approval_path)
    if not isinstance(approval, Mapping):
        raise CalibrationCLIError("Gate A approval must be a JSON object")
    source = snapshot.data.get("source_archive")
    assert isinstance(source, Mapping)
    expected_binding = approval_binding(
        snapshot_path,
        source_archive_sha256=str(source["sha256"]),
        inventory_sha256=str(source["inventory_sha256"]),
    )
    validate_analysis_selection(approval, expected_binding=expected_binding)
    _validate_selection_assets(approval, snapshot)
    selection_record = manifest.data.get("analysis_selection")
    if not isinstance(selection_record, Mapping):
        raise CalibrationCLIError("Gate A is not recorded in the run manifest")
    stored_artifact = selection_record.get("artifact")
    if not isinstance(stored_artifact, Mapping):
        raise CalibrationCLIError("manifest Gate-A artifact reference is invalid")
    stored_path = verify_artifact_reference(stored_artifact, run_dir)
    if stored_path != approval_path.resolve():
        raise CalibrationCLIError("manifest Gate-A record points to a different approval")
    if selection_record.get("upstream") != approval.get("upstream"):
        raise CalibrationCLIError("manifest Gate-A binding differs from its approval")
    return approval


def _sha256(path: Path) -> str:
    return sha256_file(path)[0]


def _approval_artifact_stub(path: str) -> dict[str, object]:
    """Provide a schema-valid artifact shape before an approval file is published."""

    return {"path": path, "bytes": 1, "sha256": "0" * 64}


def _prevalidate_manifest_update(
    manifest: RunManifest,
    field: str,
    value: Mapping[str, object],
) -> None:
    candidate = RunManifest(data=copy.deepcopy(manifest.data), path=manifest.path)
    candidate.data[field] = copy.deepcopy(dict(value))
    candidate.validate()


def _unlink_owned_file(path: Path, owned: os.stat_result) -> None:
    """Roll back only the exact regular file created by the current command."""

    try:
        current = path.stat(follow_symlinks=False)
    except OSError:
        return
    if stat.S_ISREG(current.st_mode) and (current.st_dev, current.st_ino) == (
        owned.st_dev,
        owned.st_ino,
    ):
        path.unlink(missing_ok=True)


def _role_from_name(name: str) -> str:
    lowered = name.casefold()
    matches = (
        ("drum", "drums"),
        ("percussion", "percussion"),
        ("bass", "bass"),
        ("vocal", "vocals"),
        ("guitar", "guitar"),
        ("keyboard", "keys"),
        ("piano", "keys"),
        ("synth", "synth"),
        ("fx", "fx"),
    )
    return next((role for token, role in matches if token in lowered), "other")


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def command_inspect(args: argparse.Namespace) -> dict[str, object]:
    from .audio_probe import decode_canonical, probe_audio
    from .policy import DEFAULT_POLICY
    from .zip_ingest import ExtractionProgress, extract_zip_safe, inspect_zip

    run_dir = _run_path(args.run)
    if run_dir.exists():
        if not run_dir.is_dir():
            raise CalibrationCLIError("inspect run path must be a directory")
        if any(run_dir.iterdir()):
            raise CalibrationCLIError("inspect requires a new or empty run directory")
    _ensure_private_directory(run_dir, parents=True)
    archive = Path(args.zip).resolve()
    append_event(run_dir, "inspecting-archive", "started")
    try:
        inventory = inspect_zip(archive, DEFAULT_POLICY)
    except Exception as exc:
        append_event(
            run_dir,
            "inspecting-archive",
            "failed",
            details={"error": str(exc)},
        )
        raise
    append_event(
        run_dir,
        "inspecting-archive",
        "completed",
        completed=inventory.archive_bytes,
        total=inventory.archive_bytes,
        unit="bytes",
        details={"accepted_files": len(inventory.accepted_entries)},
    )
    extraction_total_bytes = inventory.accepted_uncompressed_bytes
    extraction_state = {"completed_bytes": 0, "completed_files": 0}
    append_event(
        run_dir,
        "extracting",
        "started",
        completed=0,
        total=extraction_total_bytes,
        unit="bytes",
        details={"total_files": len(inventory.accepted_entries)},
    )

    def record_extraction_progress(progress: ExtractionProgress) -> None:
        if (
            progress.total_files != len(inventory.accepted_entries)
            or progress.total_uncompressed_bytes != extraction_total_bytes
        ):
            raise CalibrationCLIError("extractor progress totals changed after preflight")
        extraction_state["completed_bytes"] = progress.completed_uncompressed_bytes
        extraction_state["completed_files"] = progress.completed_files
        details: dict[str, object] = {
            "completed_files": progress.completed_files,
            "total_files": progress.total_files,
        }
        if progress.current_asset_id is not None:
            details["asset_id"] = progress.current_asset_id
        if progress.current_name is not None:
            details["name"] = progress.current_name
        append_event(
            run_dir,
            "extracting",
            "progress",
            completed=progress.completed_uncompressed_bytes,
            total=progress.total_uncompressed_bytes,
            unit="bytes",
            details=details,
        )

    extracted_dir = run_dir / "extracted"
    try:
        extracted = extract_zip_safe(
            archive,
            extracted_dir,
            DEFAULT_POLICY,
            progress_callback=record_extraction_progress,
        )
    except Exception as exc:
        append_event(
            run_dir,
            "extracting",
            "failed",
            completed=extraction_state["completed_bytes"],
            total=extraction_total_bytes,
            unit="bytes",
            details={
                "completed_files": extraction_state["completed_files"],
                "total_files": len(inventory.accepted_entries),
                "error": str(exc),
            },
        )
        raise
    append_event(
        run_dir,
        "extracting",
        "completed",
        completed=extraction_total_bytes,
        total=extraction_total_bytes,
        unit="bytes",
        details={
            "completed_files": len(extracted.accepted_entries),
            "total_files": len(extracted.accepted_entries),
        },
    )

    manifest = RunManifest.create(policy=DEFAULT_POLICY, repo_dir=_repo_root())
    inventory_payload = extracted.to_dict()
    zip_comment = inventory_payload["zip_comment"]
    manifest.data["source_archive"] = {
        "original_name": extracted.archive_name,
        "bytes": extracted.archive_bytes,
        "sha256": extracted.archive_sha256,
        "zip_comment": zip_comment,
        "central_directory_sha256": extracted.central_directory_sha256,
        "inventory_sha256": extracted.inventory_sha256,
    }
    manifest.data["entries"] = [entry.to_dict() for entry in extracted.entries]

    canonical_dir = run_dir / "canonical"
    _ensure_private_directory(canonical_dir, parents=True)
    decoded_assets: list[dict[str, object]] = []
    total_files = len(extracted.accepted_entries)
    append_event(
        run_dir, "probing-and-decoding", "started", completed=0, total=total_files, unit="files"
    )
    completed_files = 0
    active_asset_id: str | None = None
    active_source_name: str | None = None
    active_operation: str | None = None
    try:
        for entry in extracted.accepted_entries:
            assert entry.asset_id is not None and entry.normalized_name is not None
            active_asset_id = entry.asset_id
            active_source_name = entry.original_name
            source = extracted_dir.joinpath(*entry.normalized_name.split("/"))
            active_operation = "probing"
            probe = probe_audio(source, DEFAULT_POLICY, ffprobe_bin=args.ffprobe)
            active_operation = "decoding"
            canonical = decode_canonical(
                source,
                canonical_dir / f"{entry.asset_id}.wav",
                DEFAULT_POLICY,
                ffmpeg_bin=args.ffmpeg,
                ffprobe_bin=args.ffprobe,
                probe=probe,
            )
            active_operation = "recording-artifact"
            decoded_assets.append(
                {
                    "asset_id": entry.asset_id,
                    "original_name": entry.original_name,
                    "normalized_name": entry.normalized_name,
                    "codec": probe.codec,
                    "profile": probe.profile,
                    "tags": probe.tags,
                    "time_base": probe.time_base,
                    "first_packet_timestamp": probe.first_packet_timestamp,
                    "skip_samples": probe.skip_samples,
                    "discard_padding": probe.discard_padding,
                    "sample_rate": canonical.sample_rate,
                    "channels": canonical.channels,
                    "duration_seconds": canonical.frames / canonical.sample_rate,
                    "decoded_frames": canonical.frames,
                    "timeline_offset_frames": canonical.timeline_offset_frames,
                    "canonical_pcm": artifact_reference(canonical.output_path, run_dir),
                    "probe": probe.to_dict(),
                    "decode": canonical.to_dict(run_dir=run_dir),
                }
            )
            completed_files += 1
            append_event(
                run_dir,
                "probing-and-decoding",
                "progress",
                completed=completed_files,
                total=total_files,
                unit="files",
                details={"asset_id": entry.asset_id, "decoded_frames": canonical.frames},
            )
    except Exception as exc:
        details = {"error": str(exc)}
        if active_asset_id is not None:
            details["asset_id"] = active_asset_id
        if active_source_name is not None:
            details["source_name"] = active_source_name
        if active_operation is not None:
            details["operation"] = active_operation
        append_event(
            run_dir,
            "probing-and-decoding",
            "failed",
            completed=completed_files,
            total=total_files,
            unit="files",
            details=details,
        )
        raise
    append_event(
        run_dir,
        "probing-and-decoding",
        "completed",
        completed=completed_files,
        total=total_files,
        unit="files",
        details={"decoded_frames": sum(int(asset["decoded_frames"]) for asset in decoded_assets)},
    )
    manifest.data["audio_assets"] = decoded_assets
    manifest.write(_manifest_path(run_dir))
    _preserve_inspection_snapshot(run_dir, manifest)

    binding = _source_binding(manifest)
    selection_assets = [
        {
            "asset_id": asset["asset_id"],
            "role": _role_from_name(str(asset["original_name"])),
            "included": True,
            "gain_db": 0.0,
        }
        for asset in decoded_assets
    ]
    drum_id = next((item["asset_id"] for item in selection_assets if item["role"] == "drums"), None)
    template = {
        "schema_version": "opusloops.analysis-selection.v1",
        "approval_id": str(uuid.uuid4()),
        "approved_at": None,
        "approved_by": None,
        "upstream": binding,
        "selection": {
            "reference_method": "selected-stem-sum",
            "assets": selection_assets,
            "full_mix_asset_id": None,
            "drum_crosscheck_asset_id": drum_id,
            "sum": {"headroom_db": -12.0, "normalize_peak_dbfs": -3},
        },
        "confirmations": {
            "files_and_hashes_reviewed": False,
            "roles_reviewed": False,
            "reference_method_reviewed": False,
            "originals_unchanged": False,
        },
    }
    template_path = run_dir / "analysis-selection.template.json"
    atomic_write_json(template_path, template)
    append_event(run_dir, "awaiting-analysis-approval", "waiting")
    return {
        "run": str(run_dir),
        "manifest": str(_manifest_path(run_dir)),
        "selection_template": str(template_path),
        "accepted_files": total_files,
        "next": "Review the template, then run approve-analysis with all confirmation flags.",
    }


def command_approve_analysis(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    manifest = _load_manifest(run_dir)
    source_path = (
        Path(args.selection).resolve()
        if args.selection
        else (run_dir / "analysis-selection.template.json")
    )
    payload = load_json(source_path)
    if not isinstance(payload, dict):
        raise CalibrationCLIError("analysis selection must be a JSON object")
    payload = copy.deepcopy(payload)
    payload["approved_at"] = utc_now()
    payload["approved_by"] = args.approved_by
    payload["confirmations"] = {
        "files_and_hashes_reviewed": args.confirm_files,
        "roles_reviewed": args.confirm_roles,
        "reference_method_reviewed": args.confirm_reference,
        "originals_unchanged": args.confirm_originals_unchanged,
    }
    validate_analysis_selection(payload, expected_binding=_source_binding(manifest))
    _validate_selection_assets(payload, manifest)
    destination = run_dir / "analysis-selection.json"
    if destination.exists() or destination.is_symlink():
        raise CalibrationCLIError("Gate A is already approved; create a new run to change it")
    record = {
        "artifact": _approval_artifact_stub("analysis-selection.json"),
        "upstream": dict(payload["upstream"]),
    }
    _prevalidate_manifest_update(manifest, "analysis_selection", record)
    atomic_create_json(destination, payload)
    owned = destination.stat(follow_symlinks=False)
    original_manifest = copy.deepcopy(manifest.data)
    try:
        record["artifact"] = artifact_reference(destination, run_dir)
        manifest.data["analysis_selection"] = record
        manifest.write()
    except Exception:
        manifest.data = original_manifest
        _unlink_owned_file(destination, owned)
        raise
    append_event(
        run_dir,
        "awaiting-analysis-approval",
        "approved",
        details={"approval_sha256": _sha256(destination)},
    )
    return {"approval": str(destination), "sha256": _sha256(destination)}


PINNED_BEAT_THIS_FINAL0_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"


def _selected_reference_stems(
    run_dir: Path,
    manifest: RunManifest,
    approval: Mapping[str, object],
) -> tuple[ReferenceStem, ...]:
    records = _asset_records(manifest)
    selection = approval["selection"]
    assert isinstance(selection, Mapping)
    selected = selection["assets"]
    assert isinstance(selected, list)
    reference_method = selection.get("reference_method")
    full_mix_asset_id = selection.get("full_mix_asset_id")
    stems: list[ReferenceStem] = []
    for choice in selected:
        assert isinstance(choice, Mapping)
        if choice.get("included") is not True:
            continue
        asset_id = str(choice["asset_id"])
        if reference_method == "full-mix" and asset_id != full_mix_asset_id:
            continue
        record = records[asset_id]
        canonical_ref = record.get("canonical_pcm")
        if not isinstance(canonical_ref, Mapping):
            raise CalibrationCLIError(f"asset {asset_id} has no canonical PCM artifact")
        canonical_path = verify_artifact_reference(canonical_ref, run_dir)
        stems.append(
            ReferenceStem(
                asset_id=asset_id,
                output_path=canonical_path,
                sample_rate=int(record["sample_rate"]),
                channels=int(record["channels"]),
                frames=int(record["decoded_frames"]),
                gain_db=float(choice["gain_db"]),
                timeline_offset_frames=int(record.get("timeline_offset_frames", 0)),
                sha256=str(canonical_ref["sha256"]),
                canonical_format="wav-f32le-interleaved",
            )
        )
    if not stems:
        raise CalibrationCLIError("Gate A includes no stems in the analysis reference")
    return tuple(stems)


def _bind_analysis_artifact(
    run_dir: Path,
    base_dir: Path,
    declared: Mapping[str, object],
) -> dict[str, object]:
    if set(declared) != {"path", "bytes", "sha256"}:
        raise CalibrationCLIError("analysis artifact declaration has an invalid shape")
    relative_path = declared.get("path")
    if not isinstance(relative_path, str) or not relative_path:
        raise CalibrationCLIError("analysis artifact declaration has no relative path")
    try:
        base = base_dir.resolve(strict=True)
        path = (base / relative_path).resolve(strict=True)
        path.relative_to(base)
    except (OSError, ValueError) as exc:
        raise CalibrationCLIError("analysis artifact escapes or is missing") from exc
    reference = artifact_reference(path, run_dir)
    if reference["bytes"] != declared.get("bytes") or reference["sha256"] != declared.get("sha256"):
        raise CalibrationCLIError("analysis artifact changed before manifest binding")
    return reference


def _analysis_artifact_inventory(
    run_dir: Path,
    primary: BeatAnalysis,
    *,
    analysis_dir: Path,
) -> dict[str, object]:
    primary_refs = [
        _bind_analysis_artifact(run_dir, analysis_dir, artifact.to_dict())
        for artifact in primary.artifacts
    ]
    diagnostic_refs: dict[str, list[dict[str, object]]] = {}
    for name, value in dict(primary.diagnostics or {}).items():
        if not isinstance(value, Mapping) or "artifact" not in value:
            continue
        artifact = value.get("artifact")
        if not isinstance(artifact, Mapping):
            raise CalibrationCLIError(f"diagnostic {name} has an invalid artifact declaration")
        diagnostic_dir = analysis_dir / name
        try:
            diagnostic_dir.resolve().relative_to(analysis_dir.resolve())
        except ValueError as exc:
            raise CalibrationCLIError("diagnostic artifact directory escapes analysis") from exc
        diagnostic_refs[name] = [_bind_analysis_artifact(run_dir, diagnostic_dir, artifact)]
    return {"primary": primary_refs, "diagnostics": diagnostic_refs}


def _create_analysis_attempt_directory(run_dir: Path) -> tuple[str, Path]:
    attempts_dir = run_dir / "analysis-attempts"
    _ensure_private_directory(attempts_dir, parents=True)
    for _ in range(8):
        attempt_id = str(uuid.uuid4())
        attempt_dir = attempts_dir / attempt_id
        if _ensure_private_directory(attempt_dir):
            return attempt_id, attempt_dir
    raise CalibrationCLIError("could not claim a unique analysis attempt directory")


_ANALYSIS_EVENT_STAGES = {
    "analysis-attempt",
    "building-reference",
    "normalizing-reference",
    "analyzing",
    "diagnostic-analysis",
    "drum-stem-diagnostic-analysis",
}


def _analysis_attempt_directory_from_event(
    run_dir: Path,
    event: Mapping[str, object],
) -> tuple[str, Path, str]:
    details = event.get("details")
    if not isinstance(details, Mapping):
        raise CalibrationCLIError("cannot recover analysis attempt without event details")
    attempt_id = details.get("attempt_id")
    try:
        parsed_attempt_id = uuid.UUID(str(attempt_id))
    except (ValueError, AttributeError) as exc:
        raise CalibrationCLIError(
            "cannot recover analysis attempt with an invalid attempt_id"
        ) from exc
    if not isinstance(attempt_id, str) or str(parsed_attempt_id) != attempt_id:
        raise CalibrationCLIError("cannot recover analysis attempt with an invalid attempt_id")
    attempt_relative = f"analysis-attempts/{attempt_id}"
    if details.get("attempt_directory") != attempt_relative:
        raise CalibrationCLIError(
            "cannot recover analysis attempt whose ID and directory are not cross-bound"
        )
    attempt_dir = run_dir / "analysis-attempts" / attempt_id
    try:
        attempt_stat = attempt_dir.stat(follow_symlinks=False)
        resolved_attempt = attempt_dir.resolve(strict=True)
    except OSError as exc:
        raise CalibrationCLIError("cannot recover missing analysis attempt directory") from exc
    if (
        attempt_dir.is_symlink()
        or not stat.S_ISDIR(attempt_stat.st_mode)
        or resolved_attempt != attempt_dir
    ):
        raise CalibrationCLIError("cannot recover analysis attempt from an unsafe directory")
    if os.name == "posix" and stat.S_IMODE(attempt_stat.st_mode) != 0o700:
        raise CalibrationCLIError("cannot recover analysis attempt from a non-private directory")
    if hasattr(os, "geteuid") and attempt_stat.st_uid != os.geteuid():
        raise CalibrationCLIError("cannot recover analysis attempt owned by another user")
    return attempt_id, attempt_dir, attempt_relative


def _close_interrupted_analysis_stages(run_dir: Path, manifest: RunManifest) -> None:
    """Fail crash-left analysis stages at their last truthful progress point."""

    event_path = run_dir / "events.jsonl"
    if not (event_path.exists() or event_path.is_symlink()):
        return
    active: dict[str, dict[str, object]] = {}
    event_anchor = manifest.data.get("events")
    for event in verify_event_journal(
        run_dir,
        anchor=event_anchor if isinstance(event_anchor, Mapping) else None,
    ):
        stage = event["stage"]
        if stage not in _ANALYSIS_EVENT_STAGES:
            continue
        status = event["status"]
        if status == "started" or (status == "progress" and stage in active):
            active[stage] = event
        elif status in {"completed", "failed", "skipped"}:
            active.pop(stage, None)
    if not active:
        return

    attempt_event = active.get("analysis-attempt")
    if attempt_event is None:
        raise CalibrationCLIError(
            "cannot recover active analysis stages without an analysis-attempt owner"
        )
    attempt_id, _, attempt_relative = _analysis_attempt_directory_from_event(
        run_dir,
        attempt_event,
    )
    for stage, event in active.items():
        details = event.get("details")
        if not isinstance(details, Mapping) or details.get("attempt_id") != attempt_id:
            raise CalibrationCLIError(
                f"cannot recover analysis stage {stage!r} with a different attempt_id"
            )

    # Close innermost/recent stages first and the owning attempt last. Each
    # determinate stage retains its last journaled counter instead of claiming
    # work which the interrupted process did not complete.
    for stage, last_event in sorted(
        active.items(),
        key=lambda item: int(item[1]["sequence"]),
        reverse=True,
    ):
        recovery_details = {
            "attempt_id": attempt_id,
            "attempt_directory": attempt_relative,
            "error": "previous analysis process ended before recording a terminal event",
            "recovered_on_retry": True,
            "last_event_sequence": int(last_event["sequence"]),
        }
        progress = last_event.get("progress")
        if isinstance(progress, Mapping):
            append_event(
                run_dir,
                stage,
                "failed",
                completed=int(progress["completed"]),
                total=int(progress["total"]),
                unit=str(progress["unit"]),
                details=recovery_details,
            )
        else:
            append_event(run_dir, stage, "failed", details=recovery_details)


@contextmanager
def _exclusive_analysis_lock(run_dir: Path):
    """Allow only one analysis command to inspect and advance run state."""

    path = run_dir / ".analysis.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise CalibrationCLIError(f"cannot open analysis lock: {exc}") from exc
    try:
        descriptor_stat = os.fstat(descriptor)
        path_stat = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(descriptor_stat.st_mode)
            or not stat.S_ISREG(path_stat.st_mode)
            or descriptor_stat.st_nlink != 1
            or path_stat.st_nlink != 1
            or (descriptor_stat.st_dev, descriptor_stat.st_ino)
            != (path_stat.st_dev, path_stat.st_ino)
        ):
            raise CalibrationCLIError("analysis lock must be a bound regular file")
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        if os.name == "posix":
            import fcntl

            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CalibrationCLIError("another analysis attempt is already running") from exc
        elif os.name == "nt":  # pragma: no cover - exercised on Windows workers
            import msvcrt

            if descriptor_stat.st_size == 0:
                os.write(descriptor, b"\0")
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise CalibrationCLIError("another analysis attempt is already running") from exc
        else:  # pragma: no cover - explicit fail-closed portability boundary
            raise CalibrationCLIError("analysis locking is unsupported on this platform")
        yield
    finally:
        if os.name == "posix":
            with suppress(OSError):
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
        elif os.name == "nt":  # pragma: no cover - exercised on Windows workers
            with suppress(OSError):
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def command_analyze(
    args: argparse.Namespace, *, analyzer: object | None = None
) -> dict[str, object]:
    run_dir = _run_path(args.run)
    with _exclusive_analysis_lock(run_dir):
        return _command_analyze_locked(args, run_dir, analyzer=analyzer)


def _command_analyze_locked(
    args: argparse.Namespace,
    run_dir: Path,
    *,
    analyzer: object | None = None,
) -> dict[str, object]:
    manifest = _load_manifest(run_dir)
    if manifest.data.get("analysis") is not None:
        raise CalibrationCLIError("analysis already exists; create a new run to change inputs")
    _close_interrupted_analysis_stages(run_dir, manifest)
    approval = _gate_a(run_dir, manifest)
    selection = approval["selection"]
    assert isinstance(selection, Mapping)
    summing = selection["sum"]
    assert isinstance(summing, Mapping)
    stems = _selected_reference_stems(run_dir, manifest, approval)
    drum_crosscheck_asset_id = selection.get("drum_crosscheck_asset_id")
    drum_crosscheck_stem = (
        next(
            (stem for stem in stems if stem.asset_id == drum_crosscheck_asset_id),
            None,
        )
        if drum_crosscheck_asset_id is not None
        else None
    )
    if drum_crosscheck_asset_id is not None and drum_crosscheck_stem is None:
        raise CalibrationCLIError("approved drum cross-check stem is unavailable")
    attempt_id, attempt_dir = _create_analysis_attempt_directory(run_dir)
    attempt_relative = attempt_dir.relative_to(run_dir).as_posix()
    analysis_dir = attempt_dir / "analysis"
    reference_path = attempt_dir / "reference.wav"
    analysis_path = attempt_dir / "analysis.json"
    grid_template_path = attempt_dir / "tempo-grid.template.json"
    append_event(
        run_dir,
        "analysis-attempt",
        "started",
        details={
            "attempt_id": attempt_id,
            "attempt_directory": attempt_relative,
            "progress_kind": "indeterminate",
        },
    )
    try:
        _ensure_private_directory(analysis_dir)
        reference = build_reference(
            stems,
            reference_path,
            method=str(selection["reference_method"]),
            sum_headroom_db=float(summing["headroom_db"]),
            normalize_peak_dbfs=float(summing["normalize_peak_dbfs"]),
            event_callback=_event_callback(run_dir, attempt_id=attempt_id),
        )
        primary_analyzer = analyzer or BeatThisAdapter(
            checkpoint=args.checkpoint,
            expected_checkpoint_sha256=args.checkpoint_sha256,
            device=args.device,
            float16=args.float16,
        )
        diagnostic = LibrosaDiagnostic() if args.librosa else None
        primary = analyze_reference(
            reference,
            primary_analyzer,  # type: ignore[arg-type]
            artifact_dir=analysis_dir,
            diagnostic=diagnostic,
            event_callback=_event_callback(run_dir, attempt_id=attempt_id),
        )
        if primary.reference_sha256 != reference.sha256:
            raise CalibrationCLIError("analyzer result is bound to a different reference")
        if args.librosa and drum_crosscheck_stem is not None:
            drum_reference = view_canonical_stem(drum_crosscheck_stem)
            drum_provenance = {
                "kind": "canonical-drum-stem",
                "asset_id": drum_reference.asset_id,
                "artifact": artifact_reference(drum_reference.output_path, run_dir),
                "sha256": drum_reference.sha256,
                "frames": drum_reference.frames,
                "sample_rate": drum_reference.sample_rate,
                "channels": drum_reference.channels,
                "timeline_offset_frames": drum_reference.timeline_offset_frames,
            }
            drum_diagnostic = LibrosaDrumStemDiagnostic()
            drum_result = run_diagnostic_analysis(
                drum_reference,
                drum_diagnostic,
                artifact_dir=analysis_dir / drum_diagnostic.name,
                event_stage="drum-stem-diagnostic-analysis",
                reference_provenance=drum_provenance,
                event_callback=_event_callback(run_dir, attempt_id=attempt_id),
            )
            primary = replace(
                primary,
                diagnostics={
                    **dict(primary.diagnostics or {}),
                    drum_diagnostic.name: drum_result,
                },
            )
        analysis_artifacts = _analysis_artifact_inventory(
            run_dir,
            primary,
            analysis_dir=analysis_dir,
        )

        approval_path = run_dir / "analysis-selection.json"
        payload = {
            "schema_version": "opusloops.analysis.v1",
            "attempt_id": attempt_id,
            "created_at": utc_now(),
            "gate_a": artifact_reference(approval_path, run_dir),
            "reference": reference.to_dict(relative_to=run_dir),
            "primary": primary.to_dict(),
        }
        atomic_create_json(analysis_path, payload)
        analysis_ref = artifact_reference(analysis_path, run_dir)
        atomic_create_json(
            grid_template_path,
            {
                "schema_version": "opusloops.tempo-grid-review.v1",
                "attempt_id": attempt_id,
                "analysis_sha256": analysis_ref["sha256"],
                "beats_seconds": list(primary.beats_seconds),
                "downbeats_seconds": list(primary.downbeats_seconds),
                "reviewed": False,
                "notes": "Edit only after click audition; missing/duplicate bars otherwise block.",
            },
        )
        analysis_record = {
            "attempt_id": attempt_id,
            "artifact": analysis_ref,
            "reference": artifact_reference(reference_path, run_dir),
            "grid_template": artifact_reference(grid_template_path, run_dir),
            "artifacts": analysis_artifacts,
        }
        _prevalidate_manifest_update(manifest, "analysis", analysis_record)

        # Re-read immediately before binding so a completed concurrent attempt is
        # never replaced by this one. Attempt artifacts themselves remain immutable.
        current_manifest = _load_manifest(run_dir)
        if current_manifest.data.get("analysis") is not None:
            raise CalibrationCLIError(
                "analysis already exists; completed attempt will not be overwritten"
            )
        _gate_a(run_dir, current_manifest)
        current_manifest.data["analysis"] = analysis_record
        current_manifest.write()
    except Exception as exc:
        append_event(
            run_dir,
            "analysis-attempt",
            "failed",
            details={
                "attempt_id": attempt_id,
                "attempt_directory": attempt_relative,
                "error": str(exc),
            },
        )
        raise

    append_event(
        run_dir,
        "analysis-attempt",
        "completed",
        details={
            "attempt_id": attempt_id,
            "attempt_directory": attempt_relative,
            "analysis_sha256": analysis_ref["sha256"],
        },
    )
    append_event(
        run_dir,
        "analysis-ready-for-review",
        "waiting",
        details={
            "attempt_id": attempt_id,
            "analysis_sha256": analysis_ref["sha256"],
            "notice": "No audio has been altered yet.",
        },
    )
    return {
        "attempt_id": attempt_id,
        "attempt_directory": str(attempt_dir),
        "analysis": str(analysis_path),
        "analysis_sha256": analysis_ref["sha256"],
        "beats": len(primary.beats_seconds),
        "downbeats": len(primary.downbeats_seconds),
        "grid_template": str(grid_template_path),
        "next": (
            "Copy grid_template to a review file, then run propose-map, "
            "audition the click/grid, and approve-map."
        ),
    }


def _load_analysis(run_dir: Path, manifest: RunManifest) -> tuple[dict[str, object], Path]:
    record = manifest.data.get("analysis")
    if not isinstance(record, Mapping) or not isinstance(record.get("artifact"), Mapping):
        raise CalibrationCLIError("analysis has not completed")
    attempt_id = record.get("attempt_id")
    if not isinstance(attempt_id, str) or not _PROPOSAL_ID_RE.fullmatch(attempt_id):
        raise CalibrationCLIError("manifest analysis has an invalid attempt_id")
    attempt_dir = (run_dir / "analysis-attempts" / attempt_id).resolve()
    path = verify_artifact_reference(record["artifact"], run_dir)
    payload = load_json(path)
    if not isinstance(payload, dict) or payload.get("schema_version") != "opusloops.analysis.v1":
        raise CalibrationCLIError("analysis artifact has an unsupported shape")
    if payload.get("attempt_id") != attempt_id:
        raise CalibrationCLIError("analysis artifact belongs to a different attempt")
    if path.parent != attempt_dir or path.name != "analysis.json":
        raise CalibrationCLIError("manifest analysis artifact is outside its attempt directory")
    primary = payload.get("primary")
    reference = payload.get("reference")
    if not isinstance(primary, Mapping) or not isinstance(reference, Mapping):
        raise CalibrationCLIError("analysis artifact is incomplete")
    reference_hash = reference.get("sha256")
    if primary.get("reference_sha256") != reference_hash:
        raise CalibrationCLIError("analysis artifact reference hash is internally inconsistent")
    reference_record = record.get("reference")
    if not isinstance(reference_record, Mapping):
        raise CalibrationCLIError("manifest analysis has no canonical reference artifact")
    reference_path = verify_artifact_reference(reference_record, run_dir)
    if reference_path.parent != attempt_dir or reference_path.name != "reference.wav":
        raise CalibrationCLIError("manifest reference is outside its analysis attempt")
    if reference_path != (run_dir / str(reference.get("output_path"))).resolve():
        raise CalibrationCLIError("analysis JSON points to a different canonical reference")
    if reference_record.get("sha256") != reference_hash:
        raise CalibrationCLIError("canonical reference hash changed after analysis")
    grid_record = record.get("grid_template")
    if not isinstance(grid_record, Mapping):
        raise CalibrationCLIError("manifest analysis has no review-grid template")
    grid_path = verify_artifact_reference(grid_record, run_dir)
    if grid_path.parent != attempt_dir or grid_path.name != "tempo-grid.template.json":
        raise CalibrationCLIError("review-grid template is outside its analysis attempt")
    grid_payload = load_json(grid_path)
    if (
        not isinstance(grid_payload, Mapping)
        or grid_payload.get("schema_version") != "opusloops.tempo-grid-review.v1"
        or grid_payload.get("attempt_id") != attempt_id
        or grid_payload.get("analysis_sha256") != record["artifact"].get("sha256")
    ):
        raise CalibrationCLIError("analysis review-grid template binding is invalid")
    artifact_inventory = record.get("artifacts")
    if not isinstance(artifact_inventory, Mapping):
        raise CalibrationCLIError("manifest analysis artifact inventory is invalid")
    stored_artifacts: list[Mapping[str, object]] = []
    primary_artifacts = artifact_inventory.get("primary")
    diagnostics = artifact_inventory.get("diagnostics")
    if isinstance(primary_artifacts, list):
        stored_artifacts.extend(
            artifact for artifact in primary_artifacts if isinstance(artifact, Mapping)
        )
    if isinstance(diagnostics, Mapping):
        for diagnostic_artifacts in diagnostics.values():
            if isinstance(diagnostic_artifacts, list):
                stored_artifacts.extend(
                    artifact for artifact in diagnostic_artifacts if isinstance(artifact, Mapping)
                )
    analysis_artifact_dir = attempt_dir / "analysis"
    for stored_artifact in stored_artifacts:
        artifact_path = verify_artifact_reference(stored_artifact, run_dir)
        try:
            artifact_path.relative_to(analysis_artifact_dir.resolve(strict=True))
        except (OSError, ValueError) as exc:
            raise CalibrationCLIError("analyzer artifact is outside its analysis attempt") from exc
    return payload, path


_PROPOSAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _proposal_id(value: object) -> str:
    if value is None:
        proposal_id = str(uuid.uuid4())
    elif isinstance(value, str):
        proposal_id = value
    else:
        raise CalibrationCLIError("proposal_id must be a string when provided")
    if not _PROPOSAL_ID_RE.fullmatch(proposal_id):
        raise CalibrationCLIError(
            "proposal_id must be 1-128 characters using letters, numbers, '.', '_', or '-'"
        )
    return proposal_id


def _create_proposal_directory(run_dir: Path, proposal_id: str) -> Path:
    proposals_dir = run_dir / "proposals"
    if proposals_dir.is_symlink() or (proposals_dir.exists() and not proposals_dir.is_dir()):
        raise CalibrationCLIError("proposals path must be a real directory inside the run")
    _ensure_private_directory(proposals_dir, parents=True)
    proposal_dir = proposals_dir / proposal_id
    if proposal_dir.exists() or proposal_dir.is_symlink():
        raise CalibrationCLIError(
            f"proposal_id already exists and will not be overwritten: {proposal_id}"
        )
    if not _ensure_private_directory(proposal_dir):
        raise CalibrationCLIError(
            f"proposal_id already exists and will not be overwritten: {proposal_id}"
        )
    return proposal_dir


@contextmanager
def _exclusive_proposal_lock(run_dir: Path):
    """Serialize proposal builds while allowing the OS to release crashed owners."""

    path = run_dir / ".proposal-map.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise CalibrationCLIError(f"cannot open proposal-map lock: {exc}") from exc
    locked = False
    try:
        descriptor_stat = os.fstat(descriptor)
        path_stat = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(descriptor_stat.st_mode)
            or not stat.S_ISREG(path_stat.st_mode)
            or descriptor_stat.st_nlink != 1
            or path_stat.st_nlink != 1
            or (descriptor_stat.st_dev, descriptor_stat.st_ino)
            != (path_stat.st_dev, path_stat.st_ino)
        ):
            raise CalibrationCLIError("proposal-map lock must be a bound regular file")
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        if os.name == "posix":
            import fcntl

            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CalibrationCLIError("another tempo-map proposal is already running") from exc
        elif os.name == "nt":  # pragma: no cover - exercised on Windows workers
            import msvcrt

            if descriptor_stat.st_size == 0:
                os.write(descriptor, b"\0")
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise CalibrationCLIError("another tempo-map proposal is already running") from exc
        else:  # pragma: no cover - explicit fail-closed portability boundary
            raise CalibrationCLIError("proposal-map locking is unsupported on this platform")
        locked = True
        locked_path_stat = path.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(locked_path_stat.st_mode)
            or locked_path_stat.st_nlink != 1
            or (descriptor_stat.st_dev, descriptor_stat.st_ino)
            != (locked_path_stat.st_dev, locked_path_stat.st_ino)
        ):
            raise CalibrationCLIError("proposal-map lock changed while acquiring ownership")
        yield
    finally:
        if locked and os.name == "posix":
            with suppress(OSError):
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
        elif locked and os.name == "nt":  # pragma: no cover - exercised on Windows workers
            with suppress(OSError):
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def _proposal_directory_from_event(
    run_dir: Path,
    event: Mapping[str, object],
) -> tuple[str, Path]:
    details = event.get("details")
    if not isinstance(details, Mapping):
        raise CalibrationCLIError("cannot recover proposal build without event details")
    proposal_id = details.get("proposal_id")
    if not isinstance(proposal_id, str) or not _PROPOSAL_ID_RE.fullmatch(proposal_id):
        raise CalibrationCLIError("cannot recover proposal build with an invalid proposal_id")
    proposal_dir = run_dir / "proposals" / proposal_id
    try:
        proposal_stat = proposal_dir.stat(follow_symlinks=False)
        resolved_proposal = proposal_dir.resolve(strict=True)
    except OSError as exc:
        raise CalibrationCLIError("cannot recover missing proposal directory") from exc
    if (
        proposal_dir.is_symlink()
        or not stat.S_ISDIR(proposal_stat.st_mode)
        or resolved_proposal != proposal_dir
    ):
        raise CalibrationCLIError("cannot recover proposal build from an unsafe directory")
    if os.name == "posix" and stat.S_IMODE(proposal_stat.st_mode) != 0o700:
        raise CalibrationCLIError("cannot recover proposal build from a non-private directory")
    if hasattr(os, "geteuid") and proposal_stat.st_uid != os.geteuid():
        raise CalibrationCLIError("cannot recover proposal build owned by another user")
    return proposal_id, proposal_dir


def _close_interrupted_proposal_stages(run_dir: Path, manifest: RunManifest) -> None:
    """Fail crash-left proposal stages at their last truthful progress point."""

    event_path = run_dir / "events.jsonl"
    if not (event_path.exists() or event_path.is_symlink()):
        return
    tracked = {"building-click-audition", "building-tempo-map"}
    active: dict[str, dict[str, object]] = {}
    event_anchor = manifest.data.get("events")
    for event in verify_event_journal(
        run_dir,
        anchor=event_anchor if isinstance(event_anchor, Mapping) else None,
    ):
        stage = event["stage"]
        if stage not in tracked:
            continue
        status = event["status"]
        if status == "started" or (status == "progress" and stage in active):
            active[stage] = event
        elif status in {"completed", "failed", "skipped"}:
            active.pop(stage, None)
    if not active:
        return

    owner_event = active.get("building-tempo-map")
    if owner_event is None:
        raise CalibrationCLIError(
            "cannot recover active click audition without a tempo-map proposal owner"
        )
    proposal_id, _ = _proposal_directory_from_event(run_dir, owner_event)
    for stage, event in active.items():
        details = event.get("details")
        if not isinstance(details, Mapping) or details.get("proposal_id") != proposal_id:
            raise CalibrationCLIError(
                f"cannot recover proposal stage {stage!r} with a different proposal_id"
            )
    click_event = active.get("building-click-audition")
    if click_event is not None and int(click_event["sequence"]) <= int(owner_event["sequence"]):
        raise CalibrationCLIError("cannot recover click audition outside its proposal owner")

    # Close the nested click render first, then its owning map build. A crash
    # between these appends remains recoverable on the next invocation.
    for stage in ("building-click-audition", "building-tempo-map"):
        last_event = active.get(stage)
        if last_event is None:
            continue
        recovery_details = {
            "proposal_id": proposal_id,
            "error": "previous proposal process ended before recording a terminal event",
            "recovered_on_retry": True,
            "last_event_sequence": int(last_event["sequence"]),
        }
        progress = last_event.get("progress")
        if isinstance(progress, Mapping):
            append_event(
                run_dir,
                stage,
                "failed",
                completed=int(progress["completed"]),
                total=int(progress["total"]),
                unit=str(progress["unit"]),
                details=recovery_details,
            )
        else:
            append_event(run_dir, stage, "failed", details=recovery_details)


def _proposal_event_callback(run_dir: Path, proposal_id: str):
    callback = _event_callback(run_dir)

    def proposal_callback(stage: str, status: str, data: dict[str, object]) -> None:
        details = dict(data)
        details["proposal_id"] = proposal_id
        callback(stage, status, details)

    return proposal_callback


def command_propose_map(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    with _exclusive_proposal_lock(run_dir):
        return _command_propose_map_locked(args, run_dir)


def _command_propose_map_locked(
    args: argparse.Namespace,
    run_dir: Path,
) -> dict[str, object]:
    manifest = _load_manifest(run_dir)
    _close_interrupted_proposal_stages(run_dir, manifest)
    proposal_id = _proposal_id(getattr(args, "proposal_id", None))
    analysis_payload, analysis_path = _load_analysis(run_dir, manifest)
    primary = BeatAnalysis.from_dict(analysis_payload["primary"])
    reference = analysis_payload["reference"]
    assert isinstance(reference, Mapping)
    reference_result = ReferenceResult.from_dict(reference, relative_to=run_dir)
    beats = list(primary.beats_seconds)
    downbeats = list(primary.downbeats_seconds)
    grid_source = "analyzer"
    if args.grid:
        reviewed_grid = load_json(Path(args.grid).resolve())
        if not isinstance(reviewed_grid, Mapping):
            raise CalibrationCLIError("reviewed tempo grid must be a JSON object")
        if reviewed_grid.get("schema_version") != "opusloops.tempo-grid-review.v1":
            raise CalibrationCLIError("reviewed tempo grid has an unsupported schema")
        if reviewed_grid.get("analysis_sha256") != _sha256(analysis_path):
            raise CalibrationCLIError("reviewed tempo grid is stale for this analysis")
        if not isinstance(reviewed_grid.get("beats_seconds"), list) or not isinstance(
            reviewed_grid.get("downbeats_seconds"), list
        ):
            raise CalibrationCLIError("reviewed tempo grid is missing beat arrays")
        beats = [float(value) for value in reviewed_grid["beats_seconds"]]
        downbeats = [float(value) for value in reviewed_grid["downbeats_seconds"]]
        grid_source = "user-reviewed" if reviewed_grid.get("reviewed") is True else "edited-draft"
    if args.first_downbeat is not None:
        downbeats[0] = float(args.first_downbeat)
    proposal_dir = _create_proposal_directory(run_dir, proposal_id)
    append_event(
        run_dir,
        "building-tempo-map",
        "started",
        details={"proposal_id": proposal_id},
    )
    try:
        tempo_map = build_tempo_map(
            beats,
            downbeats,
            sample_rate=primary.reference_sample_rate,
            total_frames=primary.reference_frames,
            meter_numerator=args.meter_numerator,
            meter_denominator=args.meter_denominator,
            target_bpm=args.target_bpm,
            mode=args.mode,
            snap_tolerance_seconds=args.snap_tolerance,
        )
        click_path = create_click_audition(
            reference_result,
            beats,
            downbeats,
            proposal_dir / "raw-grid-click-audition.wav",
            event_callback=_proposal_event_callback(run_dir, proposal_id),
        )
        click_ref = artifact_reference(click_path, run_dir)
        grid_path = proposal_dir / "tempo-grid.input.json"
        atomic_write_json(
            grid_path,
            {
                "schema_version": "opusloops.tempo-grid-review.v1",
                "analysis_sha256": _sha256(analysis_path),
                "beats_seconds": beats,
                "downbeats_seconds": downbeats,
                "source": grid_source,
            },
        )
        grid_ref = artifact_reference(grid_path, run_dir)
        proposal = {
            "schema_version": "opusloops.tempo-map-proposal.v1",
            "proposal_id": proposal_id,
            "created_at": utc_now(),
            "notice": "No audio has been altered yet.",
            "analysis_sha256": _sha256(analysis_path),
            "reference_sha256": reference["sha256"],
            "click_audition": click_ref,
            "tempo_grid": grid_ref,
            "map": tempo_map.to_dict(),
            "requires_human_confirmation": True,
        }
        proposal_path = proposal_dir / "tempo-map.proposal.json"
        atomic_write_json(proposal_path, proposal)
        map_payload = tempo_map.to_dict()
        template = {
            "schema_version": "opusloops.tempo-approval.v1",
            "approval_id": str(uuid.uuid4()),
            "approved_at": None,
            "approved_by": None,
            "notice": "No audio has been altered yet.",
            "upstream": {
                "analysis_artifact": analysis_path.relative_to(run_dir).as_posix(),
                "analysis_sha256": _sha256(analysis_path),
                "reference_sha256": reference["sha256"],
                "click_audition": click_ref,
                "tempo_grid": grid_ref,
            },
            "decision": {
                "map_algorithm_version": map_payload["algorithm_version"],
                "mode": map_payload["mode"],
                "meter": map_payload["meter"],
                "first_downbeat_seconds": map_payload["first_downbeat_seconds"],
                "tempo_octave": "normal",
                "target_bpm": map_payload["target_bpm"],
                "sample_rate": map_payload["sample_rate"],
                "total_source_frames": map_payload["total_source_frames"],
                "total_target_frames": map_payload["total_target_frames"],
                "anchors": map_payload["anchors"],
                "notes": "",
            },
            "confirmations": {
                "click_auditioned": False,
                "beat_grid_reviewed": False,
                "meter_and_first_downbeat_reviewed": False,
                "tempo_octave_reviewed": False,
                "flagged_regions_reviewed": False,
                "target_and_mode_reviewed": False,
                "shared_map_for_all_stems": False,
                "originals_unchanged": False,
            },
        }
        template_path = proposal_dir / "tempo-approval.template.json"
        atomic_write_json(template_path, template)
    except Exception as exc:
        append_event(
            run_dir,
            "building-tempo-map",
            "failed",
            details={"proposal_id": proposal_id, "error": str(exc)},
        )
        raise
    append_event(
        run_dir,
        "building-tempo-map",
        "completed",
        details={
            "proposal_id": proposal_id,
            "anchors": len(tempo_map.anchors),
            "regions": len(tempo_map.regions),
            "warnings": len(tempo_map.warnings),
        },
    )
    append_event(
        run_dir,
        "awaiting-tempo-map-approval",
        "waiting",
        details={
            "proposal_id": proposal_id,
            "approval_template": template_path.relative_to(run_dir).as_posix(),
        },
    )
    return {
        "proposal_id": proposal_id,
        "proposal_directory": str(proposal_dir),
        "proposal": str(proposal_path),
        "click_audition": str(click_path),
        "tempo_grid": str(grid_path),
        "approval_template": str(template_path),
        "warnings": list(tempo_map.warnings),
        "notice": "No audio has been altered yet.",
    }


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _tempo_approval(
    payload: object,
    *,
    run_dir: Path,
    analysis_payload: Mapping[str, object],
    analysis_path: Path,
) -> Mapping[str, object]:
    if not isinstance(payload, Mapping):
        raise CalibrationCLIError("tempo approval must be a JSON object")
    expected_top_level = {
        "schema_version",
        "approval_id",
        "approved_at",
        "approved_by",
        "notice",
        "upstream",
        "decision",
        "confirmations",
    }
    if set(payload) != expected_top_level:
        raise CalibrationCLIError("tempo approval has missing or unexpected top-level fields")
    if payload.get("schema_version") != "opusloops.tempo-approval.v1":
        raise CalibrationCLIError("unsupported tempo-approval schema version")
    if payload.get("notice") != "No audio has been altered yet.":
        raise CalibrationCLIError("tempo approval must retain the unaltered-original notice")
    for field in ("approval_id", "approved_by", "approved_at"):
        if not isinstance(payload.get(field), str) or not str(payload[field]).strip():
            raise CalibrationCLIError(f"tempo approval requires {field}")
    try:
        datetime.fromisoformat(str(payload["approved_at"]).replace("Z", "+00:00"))
    except ValueError as exc:
        raise CalibrationCLIError("tempo approval approved_at must be ISO-8601") from exc

    upstream = payload.get("upstream")
    if not isinstance(upstream, Mapping):
        raise CalibrationCLIError("tempo approval has no analysis binding")
    if set(upstream) != {
        "analysis_artifact",
        "analysis_sha256",
        "reference_sha256",
        "click_audition",
        "tempo_grid",
    }:
        raise CalibrationCLIError("tempo approval upstream binding has unexpected fields")
    analysis_digest = upstream.get("analysis_sha256")
    reference_digest = upstream.get("reference_sha256")
    if not isinstance(analysis_digest, str) or not _SHA256_RE.fullmatch(analysis_digest):
        raise CalibrationCLIError("tempo approval has an invalid analysis SHA-256")
    if not isinstance(reference_digest, str) or not _SHA256_RE.fullmatch(reference_digest):
        raise CalibrationCLIError("tempo approval has an invalid reference SHA-256")
    if analysis_digest != _sha256(analysis_path):
        raise CalibrationCLIError("Gate B is stale: the analysis artifact changed")
    reference = analysis_payload.get("reference")
    if not isinstance(reference, Mapping) or reference.get("sha256") != reference_digest:
        raise CalibrationCLIError("Gate B is stale: the analyzed reference changed")
    relative_analysis = upstream.get("analysis_artifact")
    if not isinstance(relative_analysis, str):
        raise CalibrationCLIError("tempo approval analysis path is invalid")
    try:
        bound_analysis_path = (run_dir / relative_analysis).resolve(strict=True)
        bound_analysis_path.relative_to(run_dir)
    except (OSError, ValueError) as exc:
        raise CalibrationCLIError("tempo approval analysis path escapes the run") from exc
    if bound_analysis_path != analysis_path.resolve():
        raise CalibrationCLIError("tempo approval is bound to a different analysis artifact")
    click_audition = upstream.get("click_audition")
    if not isinstance(click_audition, Mapping):
        raise CalibrationCLIError("tempo approval is missing its clicked audition artifact")
    verify_artifact_reference(click_audition, run_dir)
    tempo_grid = upstream.get("tempo_grid")
    if not isinstance(tempo_grid, Mapping):
        raise CalibrationCLIError("tempo approval is missing its exact reviewed grid artifact")
    grid_path = verify_artifact_reference(tempo_grid, run_dir)
    grid_payload = load_json(grid_path)
    if (
        not isinstance(grid_payload, Mapping)
        or grid_payload.get("analysis_sha256") != analysis_digest
    ):
        raise CalibrationCLIError("tempo approval reviewed grid is stale for this analysis")

    decision = payload.get("decision")
    if not isinstance(decision, Mapping):
        raise CalibrationCLIError("tempo approval has no decision")
    allowed_decision_fields = {
        "map_algorithm_version",
        "mode",
        "meter",
        "first_downbeat_seconds",
        "tempo_octave",
        "target_bpm",
        "sample_rate",
        "total_source_frames",
        "total_target_frames",
        "anchors",
        "notes",
    }
    if set(decision) - allowed_decision_fields:
        raise CalibrationCLIError("tempo approval decision has unexpected fields")
    if decision.get("map_algorithm_version") != "opusloops.shared-tempo-map.v1":
        raise CalibrationCLIError("tempo approval has an unsupported map algorithm")
    mode = decision.get("mode")
    if mode not in {"musical-4bar", "rigid-beat", "no-conform"}:
        raise CalibrationCLIError("tempo approval has an unsupported mode")
    meter = decision.get("meter")
    if not isinstance(meter, Mapping):
        raise CalibrationCLIError("tempo approval meter is missing")
    numerator = meter.get("numerator")
    denominator = meter.get("denominator")
    if type(numerator) is not int or not 1 <= numerator <= 32:
        raise CalibrationCLIError("tempo approval meter numerator is invalid")
    if denominator not in {1, 2, 4, 8, 16, 32}:
        raise CalibrationCLIError("tempo approval meter denominator is invalid")
    if decision.get("tempo_octave") not in {"half", "normal", "double", "custom"}:
        raise CalibrationCLIError("tempo approval octave interpretation is invalid")

    primary = analysis_payload.get("primary")
    if not isinstance(primary, Mapping):
        raise CalibrationCLIError("analysis primary result is missing")
    sample_rate = decision.get("sample_rate")
    total_source = decision.get("total_source_frames")
    total_target = decision.get("total_target_frames")
    if type(sample_rate) is not int or sample_rate != primary.get("reference_sample_rate"):
        raise CalibrationCLIError("tempo approval sample rate changed after analysis")
    if type(total_source) is not int or total_source != primary.get("reference_frames"):
        raise CalibrationCLIError("tempo approval source frame count changed after analysis")
    if type(total_target) is not int or total_target <= 0:
        raise CalibrationCLIError("tempo approval target frame count is invalid")
    first_downbeat = decision.get("first_downbeat_seconds")
    if (
        not isinstance(first_downbeat, int | float)
        or isinstance(first_downbeat, bool)
        or not math.isfinite(float(first_downbeat))
        or first_downbeat < 0
    ):
        raise CalibrationCLIError("tempo approval first downbeat is invalid")
    target_bpm = decision.get("target_bpm")
    if mode == "no-conform":
        if target_bpm is not None or total_target != total_source:
            raise CalibrationCLIError("no-conform approval must be an exact identity timeline")
    elif (
        not isinstance(target_bpm, int | float)
        or isinstance(target_bpm, bool)
        or not math.isfinite(float(target_bpm))
        or not 20 <= float(target_bpm) <= 400
    ):
        raise CalibrationCLIError("tempo approval target BPM must be between 20 and 400")

    anchors = decision.get("anchors")
    if not isinstance(anchors, list):
        raise CalibrationCLIError("tempo approval anchors are missing")
    allowed_anchor_kinds = {
        "timeline-origin",
        "first-downbeat",
        "four-bar",
        "beat",
        "partial-outro",
        "timeline-end",
        "user-bar",
    }
    for index, anchor in enumerate(anchors):
        if not isinstance(anchor, Mapping) or set(anchor) != {
            "source_frame",
            "target_frame",
            "kind",
        }:
            raise CalibrationCLIError(f"tempo approval anchor {index} has an invalid shape")
        if anchor.get("kind") not in allowed_anchor_kinds:
            raise CalibrationCLIError(f"tempo approval anchor {index} has an invalid kind")
    validate_anchor_payload(anchors, total_source_frames=total_source)
    if anchors[-1].get("target_frame") != total_target:
        raise CalibrationCLIError("tempo approval target frame count disagrees with its map")
    from .render_plan import FrameAnchor, RenderPlanError, validate_signalsmith_pre_roll

    if mode != "no-conform":
        try:
            validate_signalsmith_pre_roll(
                tuple(
                    FrameAnchor(int(item["source_frame"]), int(item["target_frame"]))
                    for item in anchors
                ),
                sample_rate=sample_rate,
            )
        except RenderPlanError as exc:
            raise CalibrationCLIError(f"tempo approval cannot be rendered: {exc}") from exc
    if mode == "no-conform" and any(
        item.get("source_frame") != item.get("target_frame") for item in anchors
    ):
        raise CalibrationCLIError("no-conform approval contains a non-identity anchor")
    first_downbeat_frame = seconds_to_frame(float(first_downbeat), sample_rate)
    if not any(item.get("source_frame") == first_downbeat_frame for item in anchors):
        raise CalibrationCLIError("first downbeat is not represented by an approved map anchor")

    confirmations = payload.get("confirmations")
    required_confirmations = {
        "click_auditioned",
        "beat_grid_reviewed",
        "meter_and_first_downbeat_reviewed",
        "tempo_octave_reviewed",
        "flagged_regions_reviewed",
        "target_and_mode_reviewed",
        "shared_map_for_all_stems",
        "originals_unchanged",
    }
    if (
        not isinstance(confirmations, Mapping)
        or set(confirmations) != required_confirmations
        or any(confirmations.get(key) is not True for key in required_confirmations)
    ):
        raise CalibrationCLIError("all Gate-B confirmations must be explicitly true")
    validate_tempo_approval_schema(payload)
    return payload


def _gate_b(
    run_dir: Path,
    manifest: RunManifest,
) -> tuple[Mapping[str, object], dict[str, object], Path]:
    approval_path = run_dir / "tempo-approval.json"
    if not approval_path.is_file():
        raise CalibrationCLIError(
            "Gate B is not approved: audition and approve the tempo map before rendering"
        )
    tempo_map_record = manifest.data.get("tempo_map")
    if not isinstance(tempo_map_record, Mapping):
        raise CalibrationCLIError("Gate B is not recorded in the run manifest")
    stored_approval = tempo_map_record.get("approval")
    if not isinstance(stored_approval, Mapping):
        raise CalibrationCLIError("manifest Gate-B approval reference is invalid")
    stored_approval_path = verify_artifact_reference(stored_approval, run_dir)
    if stored_approval_path != approval_path.resolve():
        raise CalibrationCLIError("manifest Gate-B record points to a different approval")
    analysis_payload, analysis_path = _load_analysis(run_dir, manifest)
    approval = _tempo_approval(
        load_json(approval_path),
        run_dir=run_dir,
        analysis_payload=analysis_payload,
        analysis_path=analysis_path,
    )
    if canonical_json_bytes(tempo_map_record.get("decision")) != canonical_json_bytes(
        approval.get("decision")
    ):
        raise CalibrationCLIError("manifest Gate-B decision differs from its approval")
    return approval, analysis_payload, approval_path


def _approval_template_candidates(run_dir: Path) -> tuple[Path, ...]:
    candidates: list[Path] = []
    legacy = run_dir / "tempo-approval.template.json"
    if legacy.exists() or legacy.is_symlink():
        if legacy.is_symlink() or not legacy.is_file():
            raise CalibrationCLIError("legacy tempo approval template is not a regular file")
        candidates.append(legacy.resolve())

    proposals_dir = run_dir / "proposals"
    if proposals_dir.exists() or proposals_dir.is_symlink():
        if proposals_dir.is_symlink() or not proposals_dir.is_dir():
            raise CalibrationCLIError("proposals path must be a real directory inside the run")
        for proposal_dir in sorted(proposals_dir.iterdir(), key=lambda path: path.name):
            template = proposal_dir / "tempo-approval.template.json"
            if not (template.exists() or template.is_symlink()):
                continue
            if (
                proposal_dir.is_symlink()
                or not proposal_dir.is_dir()
                or not _PROPOSAL_ID_RE.fullmatch(proposal_dir.name)
                or template.is_symlink()
                or not template.is_file()
            ):
                raise CalibrationCLIError(f"unsafe tempo approval template candidate: {template}")
            candidates.append(template.resolve())
    return tuple(candidates)


def _resolve_approval_template(run_dir: Path, explicit: object) -> Path:
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit:
            raise CalibrationCLIError("--approval must name a tempo approval template file")
        requested = Path(explicit).expanduser()
        if requested.is_symlink():
            raise CalibrationCLIError("tempo approval template must not be a symlink")
        try:
            source_path = requested.resolve(strict=True)
        except OSError as exc:
            raise CalibrationCLIError(f"tempo approval template is missing: {requested}") from exc
        if not source_path.is_file():
            raise CalibrationCLIError("tempo approval template must be a regular file")
        return source_path

    candidates = _approval_template_candidates(run_dir)
    if not candidates:
        raise CalibrationCLIError(
            "no tempo approval template found; run propose-map or pass --approval explicitly"
        )
    if len(candidates) > 1:
        choices = ", ".join(path.relative_to(run_dir).as_posix() for path in candidates)
        raise CalibrationCLIError(
            "multiple tempo approval templates exist; pass --approval explicitly "
            f"to select one of: {choices}"
        )
    return candidates[0]


def command_approve_map(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    manifest = _load_manifest(run_dir)
    analysis_payload, analysis_path = _load_analysis(run_dir, manifest)
    source_path = _resolve_approval_template(run_dir, args.approval)
    payload = load_json(source_path)
    if not isinstance(payload, dict):
        raise CalibrationCLIError("tempo approval must be a JSON object")
    payload = copy.deepcopy(payload)
    payload["approved_at"] = utc_now()
    payload["approved_by"] = args.approved_by
    payload["confirmations"] = {
        "click_auditioned": args.confirm_click,
        "beat_grid_reviewed": args.confirm_beat_grid,
        "meter_and_first_downbeat_reviewed": args.confirm_meter_downbeat,
        "tempo_octave_reviewed": args.confirm_tempo_octave,
        "flagged_regions_reviewed": args.confirm_flags,
        "target_and_mode_reviewed": args.confirm_target,
        "shared_map_for_all_stems": args.confirm_shared_map,
        "originals_unchanged": args.confirm_originals_unchanged,
    }
    _tempo_approval(
        payload,
        run_dir=run_dir,
        analysis_payload=analysis_payload,
        analysis_path=analysis_path,
    )
    destination = run_dir / "tempo-approval.json"
    if destination.exists() or destination.is_symlink():
        raise CalibrationCLIError("Gate B is already approved; create a new run to change it")
    record = {
        "approval": _approval_artifact_stub("tempo-approval.json"),
        "decision": payload["decision"],
    }
    _prevalidate_manifest_update(manifest, "tempo_map", record)
    atomic_create_json(destination, payload)
    owned = destination.stat(follow_symlinks=False)
    original_manifest = copy.deepcopy(manifest.data)
    try:
        approval_ref = artifact_reference(destination, run_dir)
        record["approval"] = approval_ref
        manifest.data["tempo_map"] = record
        manifest.write()
    except Exception:
        manifest.data = original_manifest
        _unlink_owned_file(destination, owned)
        raise
    append_event(
        run_dir,
        "awaiting-tempo-map-approval",
        "approved",
        details={"approval_sha256": approval_ref["sha256"]},
    )
    return {
        "approval": str(destination),
        "sha256": approval_ref["sha256"],
        "next": "Gate B is valid; render-bakeoff may now create derivatives.",
    }


def _render_stems(run_dir: Path, manifest: RunManifest):
    from .render_plan import StemInput

    stems = []
    for asset_id, record in _asset_records(manifest).items():
        canonical = record.get("canonical_pcm")
        if not isinstance(canonical, Mapping):
            raise CalibrationCLIError(f"asset {asset_id} has no canonical artifact")
        stems.append(
            StemInput(
                asset_id=asset_id,
                path=verify_artifact_reference(canonical, run_dir),
                channels=int(record["channels"]),
                frames=int(record["decoded_frames"]),
                sha256=str(canonical["sha256"]),
            )
        )
    return tuple(stems)


def _portable_metric_payload(payload: dict[str, object], run_dir: Path) -> dict[str, object]:
    """Replace metric-library host paths with verified run-relative paths."""

    result = copy.deepcopy(payload)
    for key in ("path", "reference_path"):
        value = result.get(key)
        if isinstance(value, str):
            try:
                result[key] = Path(value).resolve(strict=True).relative_to(run_dir).as_posix()
            except (OSError, ValueError) as exc:
                raise CalibrationCLIError("render metric path escapes the run directory") from exc
    component_paths = result.get("component_paths")
    if isinstance(component_paths, tuple | list):
        portable: list[str] = []
        for value in component_paths:
            try:
                portable.append(
                    Path(str(value)).resolve(strict=True).relative_to(run_dir).as_posix()
                )
            except (OSError, ValueError) as exc:
                raise CalibrationCLIError("residual metric path escapes the run directory") from exc
        result["component_paths"] = portable
    return result


def _collect_render_metrics(
    *,
    run_dir: Path,
    attempt_dir: Path,
    attempt_id: str,
    plan: object,
    approval_path: Path,
    pinned_renderer: object,
    render_results: Sequence[Mapping[str, object]],
) -> tuple[dict[str, object], dict[str, object]]:
    """Validate both renders and persist objective, map-bound metrics."""

    from .metrics import inspect_wav, measure_boundary_discontinuities, measure_pair_residual

    stems = plan.stems
    target_frames = plan.target_frames
    sample_rate = plan.sample_rate
    internal_boundaries = sorted({anchor.target_frame for anchor in plan.anchors[1:-1]})
    total_checks = len(stems) * 5
    completed_checks = 0
    append_event(
        run_dir,
        "measuring-render-metrics",
        "started",
        completed=0,
        total=total_checks,
        unit="checks",
        details={
            "attempt_id": attempt_id,
            "output_files": len(stems) * 2,
            "internal_boundaries": len(internal_boundaries),
        },
    )

    output_metrics: dict[str, dict[str, object]] = {stem.asset_id: {} for stem in stems}
    try:
        for mode in ("linked", "independent"):
            for stem in stems:
                output_path = (attempt_dir / "renders" / mode / f"{stem.asset_id}.wav").resolve()
                inspection = inspect_wav(output_path)
                if inspection.sample_rate != sample_rate:
                    raise CalibrationCLIError(
                        f"{mode}/{stem.asset_id} sample rate differs from approved render plan"
                    )
                if inspection.channels != stem.channels:
                    raise CalibrationCLIError(
                        f"{mode}/{stem.asset_id} channel count differs from its source stem"
                    )
                if inspection.frames != target_frames:
                    raise CalibrationCLIError(
                        f"{mode}/{stem.asset_id} has {inspection.frames} frames; "
                        f"expected exactly {target_frames}"
                    )
                if not inspection.all_samples_finite:
                    raise CalibrationCLIError(
                        f"{mode}/{stem.asset_id} contains non-finite rendered samples"
                    )
                completed_checks += 1
                append_event(
                    run_dir,
                    "measuring-render-metrics",
                    "progress",
                    completed=completed_checks,
                    total=total_checks,
                    unit="checks",
                    details={
                        "attempt_id": attempt_id,
                        "mode": mode,
                        "asset_id": stem.asset_id,
                        "check": "integrity",
                    },
                )

                boundaries = measure_boundary_discontinuities(
                    output_path,
                    internal_boundaries,
                )
                completed_checks += 1
                append_event(
                    run_dir,
                    "measuring-render-metrics",
                    "progress",
                    completed=completed_checks,
                    total=total_checks,
                    unit="checks",
                    details={
                        "attempt_id": attempt_id,
                        "mode": mode,
                        "asset_id": stem.asset_id,
                        "check": "boundaries",
                    },
                )
                output_metrics[stem.asset_id][mode] = {
                    "artifact": artifact_reference(output_path, run_dir),
                    "integrity": _portable_metric_payload(inspection.to_dict(), run_dir),
                    "approved_boundary_discontinuities": _portable_metric_payload(
                        boundaries.to_dict(), run_dir
                    ),
                }

        for stem in stems:
            linked_path = (attempt_dir / "renders" / "linked" / f"{stem.asset_id}.wav").resolve()
            independent_path = (
                attempt_dir / "renders" / "independent" / f"{stem.asset_id}.wav"
            ).resolve()
            residual = measure_pair_residual(linked_path, independent_path)
            if not residual.all_samples_finite or residual.frames != target_frames:
                raise CalibrationCLIError(
                    f"linked/independent residual inputs are invalid for {stem.asset_id}"
                )
            output_metrics[stem.asset_id]["linked_vs_independent_residual"] = (
                _portable_metric_payload(residual.to_dict(), run_dir)
            )
            completed_checks += 1
            append_event(
                run_dir,
                "measuring-render-metrics",
                "progress",
                completed=completed_checks,
                total=total_checks,
                unit="checks",
                details={
                    "attempt_id": attempt_id,
                    "asset_id": stem.asset_id,
                    "check": "paired-residual",
                },
            )

        from .render_plan import SIGNALSMITH_ENGINE, SIGNALSMITH_VERSION

        reported_engines = [result.get("engine") for result in render_results]
        reported_versions = [result.get("version") for result in render_results]
        if reported_engines != [SIGNALSMITH_ENGINE, SIGNALSMITH_ENGINE] or reported_versions != [
            SIGNALSMITH_VERSION,
            SIGNALSMITH_VERSION,
        ]:
            raise CalibrationCLIError("renderer modes reported unexpected engine provenance")
        engine = reported_engines[0]
        version = reported_versions[0]
        assert isinstance(engine, str)
        assert isinstance(version, str)
        renderer = {
            "engine": engine,
            "version": version,
            "binary": pinned_renderer.provenance(),
            "modes": ["linked", "independent"],
        }
        payload: dict[str, object] = {
            "schema_version": "opusloops.render-metrics.v1",
            "attempt_id": attempt_id,
            "created_at": utc_now(),
            "gate_b": artifact_reference(approval_path, run_dir),
            "approved_map": {
                "sample_rate": sample_rate,
                "target_frames": target_frames,
                "internal_target_boundary_frames": internal_boundaries,
            },
            "renderer": renderer,
            "outputs": output_metrics,
        }
        metrics_path = attempt_dir / "artifacts" / "render-metrics.json"
        atomic_create_json(metrics_path, payload)
        metrics_ref = artifact_reference(metrics_path, run_dir)
    except Exception as exc:
        append_event(
            run_dir,
            "measuring-render-metrics",
            "failed",
            completed=completed_checks,
            total=total_checks,
            unit="checks",
            details={"attempt_id": attempt_id, "error": str(exc)},
        )
        raise

    append_event(
        run_dir,
        "measuring-render-metrics",
        "completed",
        completed=total_checks,
        total=total_checks,
        unit="checks",
        details={
            "attempt_id": attempt_id,
            "artifact_sha256": metrics_ref["sha256"],
        },
    )
    return metrics_ref, renderer


def command_render_bakeoff(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    with _exclusive_render_lock(run_dir):
        return _command_render_bakeoff_locked(args, run_dir)


def _command_render_bakeoff_locked(args: argparse.Namespace, run_dir: Path) -> dict[str, object]:
    from .render_plan import (
        FrameAnchor,
        RenderPlan,
        pin_signalsmith_renderer,
        run_signalsmith,
        write_renderer_inputs,
    )

    manifest = _load_manifest(run_dir)
    toolchain = manifest.data.get("toolchain")
    published_renderer = (
        toolchain.get("signalsmith_renderer") if isinstance(toolchain, Mapping) else None
    )
    if (
        bool(manifest.data.get("renders"))
        or manifest.data.get("metrics") is not None
        or published_renderer is not None
    ):
        raise CalibrationCLIError(
            "render bake-off is already complete; create a new run to render again"
        )
    _close_interrupted_render_stages(run_dir)
    inspection_state = _verified_inspection_snapshot(run_dir, manifest)
    _gate_a(run_dir, manifest, inspection_state=inspection_state)
    inspection_manifest, _ = inspection_state
    approval, _, approval_path = _gate_b(run_dir, manifest)
    decision = approval["decision"]
    assert isinstance(decision, Mapping)
    if decision["mode"] == "no-conform":
        append_event(
            run_dir,
            "rendering",
            "skipped",
            message="No conform needed; originals remain unchanged.",
        )
        return {"status": "skipped", "reason": "no-conform approved"}
    stems = _render_stems(run_dir, inspection_manifest)
    source_frames = int(decision["total_source_frames"])
    if any(stem.frames != source_frames for stem in stems):
        raise CalibrationCLIError(
            "all stems must share the approved source frame count before bake-off"
        )
    anchors_payload = decision["anchors"]
    assert isinstance(anchors_payload, list)
    plan = RenderPlan(
        stems=stems,
        anchors=tuple(
            FrameAnchor(int(item["source_frame"]), int(item["target_frame"]))
            for item in anchors_payload
        ),
        sample_rate=int(decision["sample_rate"]),
        approval_sha256=str(artifact_reference(approval_path, run_dir)["sha256"]),
    )
    attempt_id, attempt_dir = _create_render_attempt(run_dir)
    total_render_frames = plan.target_frames * len(plan.stems) * 2
    completed_render_frames = 0
    active_mode: str | None = None
    append_event(
        run_dir,
        "rendering",
        "started",
        completed=0,
        total=total_render_frames,
        unit="stem-frames",
        details={
            "attempt_id": attempt_id,
            "modes": ["linked", "independent"],
        },
    )

    binary = (
        Path(os.path.abspath(Path(args.binary).expanduser()))
        if args.binary
        else (
            Path(__file__).resolve().parents[2]
            / ".build"
            / "native"
            / "opusloops-signalsmith-render"
        )
    )
    renderer = None
    results: list[dict[str, object]] = []
    try:
        _ensure_private_directory(attempt_dir / "inputs")
        _ensure_private_directory(attempt_dir / "renders")
        _ensure_private_directory(attempt_dir / "artifacts")
        inputs = write_renderer_inputs(plan, attempt_dir / "inputs")
        renderer = pin_signalsmith_renderer(binary)
        for mode in ("linked", "independent"):
            active_mode = mode
            output_dir = (attempt_dir / "renders" / mode).resolve()
            result = run_signalsmith(renderer, plan, inputs, output_dir, mode=mode)
            result["attempt_id"] = attempt_id
            assert inputs.binding_json is not None
            result["input_artifacts"] = {
                "binding": artifact_reference(inputs.binding_json, run_dir),
                "stems_tsv": artifact_reference(inputs.stems_tsv, run_dir),
                "map_tsv": artifact_reference(inputs.map_tsv, run_dir),
            }
            result["artifacts"] = [
                artifact_reference(output_dir / f"{stem.asset_id}.wav", run_dir)
                for stem in plan.stems
            ]
            results.append(result)
            completed_render_frames += plan.target_frames * len(plan.stems)
            append_event(
                run_dir,
                "rendering",
                "progress",
                completed=completed_render_frames,
                total=total_render_frames,
                unit="stem-frames",
                details={"attempt_id": attempt_id, "mode": mode},
            )
    except BaseException as exc:
        if renderer is not None:
            renderer.close()
        append_event(
            run_dir,
            "rendering",
            "failed",
            completed=completed_render_frames,
            total=total_render_frames,
            unit="stem-frames",
            details={
                "attempt_id": attempt_id,
                "mode": active_mode,
                "error": str(exc),
            },
        )
        raise
    append_event(
        run_dir,
        "rendering",
        "completed",
        completed=completed_render_frames,
        total=total_render_frames,
        unit="stem-frames",
        details={"attempt_id": attempt_id},
    )
    assert renderer is not None
    try:
        metrics_ref, renderer_toolchain = _collect_render_metrics(
            run_dir=run_dir,
            attempt_dir=attempt_dir,
            attempt_id=attempt_id,
            plan=plan,
            approval_path=approval_path,
            pinned_renderer=renderer,
            render_results=results,
        )
    except BaseException:
        renderer.close()
        raise
    try:
        manifest.data["renders"] = results
        manifest.data["metrics"] = {
            "attempt_id": attempt_id,
            "artifact": metrics_ref,
            "gate_b_sha256": artifact_reference(approval_path, run_dir)["sha256"],
        }
        manifest.data["toolchain"]["signalsmith_renderer"] = renderer_toolchain
        renderer.verify(hash_bytes=True)
        manifest.verify_artifacts(run_dir)
        renderer.verify(hash_bytes=True)
        manifest.write()
    finally:
        renderer.close()
    return {
        "status": "completed",
        "attempt_id": attempt_id,
        "renders": results,
        "metrics": metrics_ref,
    }


def command_report(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    manifest = _load_manifest(run_dir)
    source = manifest.data.get("source_archive") or {}
    assets = manifest.data.get("audio_assets") or []
    renders = manifest.data.get("renders") or []
    lines = [
        "# Opusloops stem calibration run",
        "",
        f"Run: `{manifest.data['run_id']}`",
        "",
        "Original audio remains immutable. All renders are versioned derivatives.",
        "",
        f"- Archive: `{source.get('original_name', 'not inspected')}`",
        f"- Decoded stems: {len(assets)}",
        f"- Completed render modes: {len(renders)}",
        f"- Gate A: {'approved' if manifest.data.get('analysis_selection') else 'pending'}",
        f"- Gate B: {'approved' if manifest.data.get('tempo_map') else 'pending'}",
        "",
        "See `run-manifest.json` for hashes, exact frame counts, and tool provenance.",
        "",
    ]
    report_path = run_dir / "report.md"
    if report_path.exists():
        raise CalibrationCLIError("report already exists; refusing to overwrite it")
    from .manifest import atomic_write_bytes

    atomic_write_bytes(report_path, "\n".join(lines).encode("utf-8"))
    append_event(run_dir, "reporting", "completed")
    return {"report": str(report_path), "sha256": _sha256(report_path)}


def command_verify_run(args: argparse.Namespace) -> dict[str, object]:
    run_dir = _run_path(args.run)
    manifest = _load_manifest(run_dir)
    verified = manifest.verify_artifacts(run_dir)
    selection_record = manifest.data.get("analysis_selection")
    inspection_state: tuple[RunManifest, Path] | None = None
    if manifest.data.get("inspection_snapshot") is not None:
        inspection_state = _verified_inspection_snapshot(run_dir, manifest)
    if selection_record is not None or (run_dir / "analysis-selection.json").exists():
        _gate_a(run_dir, manifest, inspection_state=inspection_state)
    if manifest.data.get("analysis") is not None:
        _load_analysis(run_dir, manifest)
    if manifest.data.get("tempo_map") is not None or (run_dir / "tempo-approval.json").exists():
        _gate_b(run_dir, manifest)
    return {
        "status": "verified",
        "manifest": str(_manifest_path(run_dir)),
        "verified_artifacts": len(verified),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="opus-stem-cal",
        description="Inspect and calibrate one shared tempo map for aligned stem archives.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    inspect_command = commands.add_parser(
        "inspect", help="Safely inspect, extract, and decode a ZIP"
    )
    inspect_command.add_argument("--zip", required=True, help="Source stem ZIP")
    inspect_command.add_argument("--run", required=True, help="New run directory")
    inspect_command.add_argument("--ffmpeg", default="ffmpeg")
    inspect_command.add_argument("--ffprobe", default="ffprobe")
    inspect_command.set_defaults(handler=command_inspect)

    approve_analysis = commands.add_parser(
        "approve-analysis", help="Record Gate A after reviewing file roles and reference method"
    )
    approve_analysis.add_argument("--run", required=True)
    approve_analysis.add_argument("--selection", help="Edited selection template")
    approve_analysis.add_argument("--approved-by", required=True, help="Identity of the approver")
    approve_analysis.add_argument(
        "--confirm-files",
        action="store_true",
        help="Attest that every archive file and SHA-256 hash was reviewed",
    )
    approve_analysis.add_argument(
        "--confirm-roles",
        action="store_true",
        help="Attest that every role, inclusion choice, and gain was reviewed",
    )
    approve_analysis.add_argument(
        "--confirm-reference",
        action="store_true",
        help="Attest that the shared-reference method and sum settings were reviewed",
    )
    approve_analysis.add_argument(
        "--confirm-originals-unchanged",
        action="store_true",
        help="Attest that analysis will leave source stems unchanged",
    )
    approve_analysis.set_defaults(handler=command_approve_analysis)

    analyze = commands.add_parser(
        "analyze",
        help="Run one private, immutable analysis attempt after Gate A",
    )
    analyze.add_argument("--run", required=True)
    analyze.add_argument("--checkpoint", default="final0")
    analyze.add_argument("--checkpoint-sha256", default=PINNED_BEAT_THIS_FINAL0_SHA256)
    analyze.add_argument("--device", default="cpu")
    analyze.add_argument("--float16", action="store_true")
    analyze.add_argument("--librosa", action="store_true", help="Run diagnostic cross-check")
    analyze.set_defaults(handler=command_analyze)

    propose = commands.add_parser("propose-map", help="Create a reviewable shared tempo map")
    propose.add_argument("--run", required=True)
    propose.add_argument(
        "--mode", choices=("musical-4bar", "rigid-beat", "no-conform"), default="musical-4bar"
    )
    propose.add_argument("--target-bpm", type=float)
    propose.add_argument("--meter-numerator", type=int, default=4)
    propose.add_argument("--meter-denominator", type=int, default=4)
    propose.add_argument("--first-downbeat", type=float)
    propose.add_argument("--grid", help="Edited tempo-grid review JSON")
    propose.add_argument(
        "--proposal-id",
        help="Safe unique ID for this immutable proposal revision (generated when omitted)",
    )
    propose.add_argument("--snap-tolerance", type=float, default=0.08)
    propose.set_defaults(handler=command_propose_map)

    approve_map = commands.add_parser(
        "approve-map", help="Record Gate B after click audition and map review"
    )
    approve_map.add_argument("--run", required=True)
    approve_map.add_argument("--approval", help="Edited tempo approval template")
    approve_map.add_argument("--approved-by", required=True, help="Identity of the approver")
    approve_map.add_argument(
        "--confirm-click",
        action="store_true",
        help="Attest that the bound click-audition WAV was listened to",
    )
    approve_map.add_argument(
        "--confirm-beat-grid",
        action="store_true",
        help="Attest that the exact bound beat/downbeat grid was reviewed",
    )
    approve_map.add_argument(
        "--confirm-meter-downbeat",
        action="store_true",
        help="Attest that the meter and first downbeat were reviewed",
    )
    approve_map.add_argument(
        "--confirm-tempo-octave",
        action="store_true",
        help="Attest that half, normal, double, or custom tempo interpretation was reviewed",
    )
    approve_map.add_argument(
        "--confirm-flags",
        action="store_true",
        help="Attest that every flagged four-bar region was reviewed",
    )
    approve_map.add_argument(
        "--confirm-target",
        action="store_true",
        help="Attest that the target BPM and conform mode were reviewed",
    )
    approve_map.add_argument(
        "--confirm-shared-map",
        action="store_true",
        help="Attest that this one map must apply to every aligned stem",
    )
    approve_map.add_argument(
        "--confirm-originals-unchanged",
        action="store_true",
        help="Attest that renders remain derivatives and sources stay unchanged",
    )
    approve_map.set_defaults(handler=command_approve_map)

    render = commands.add_parser(
        "render-bakeoff", help="Render linked and independent derivatives after Gate B"
    )
    render.add_argument("--run", required=True)
    render.add_argument("--binary", help="Built opusloops-signalsmith-render binary")
    render.set_defaults(handler=command_render_bakeoff)

    report = commands.add_parser("report", help="Write a concise run report")
    report.add_argument("--run", required=True)
    report.set_defaults(handler=command_report)

    verify = commands.add_parser("verify-run", help="Recompute recorded artifact hashes")
    verify.add_argument("--run", required=True)
    verify.set_defaults(handler=command_verify_run)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "propose-map":
        if args.mode == "no-conform" and args.target_bpm is not None:
            parser.error("--target-bpm must be omitted with --mode no-conform")
        if args.mode != "no-conform" and args.target_bpm is None:
            parser.error("--target-bpm is required for conforming modes")
    try:
        result = args.handler(args)
    except (RuntimeError, OSError, ValueError) as exc:
        print(f"opus-stem-cal: {exc}", file=sys.stderr)
        return 2
    _print_result(result)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
