from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

import opusloops_stem_calibration.audio_probe as audio_probe_module
import opusloops_stem_calibration.cli as cli_module
import opusloops_stem_calibration.render_plan as render_plan_module
import opusloops_stem_calibration.zip_ingest as zip_ingest_module
from opusloops_stem_calibration.beat_tracker import (
    AnalysisArtifact,
    BeatAnalysis,
    create_click_audition,
)
from opusloops_stem_calibration.cli import CalibrationCLIError, command_analyze, main
from opusloops_stem_calibration.manifest import (
    ManifestError,
    RunManifest,
    approval_binding,
    artifact_reference,
    atomic_write_json,
    verify_artifact_reference,
)
from opusloops_stem_calibration.reference import (
    ReferenceStem,
    build_reference,
    read_float32_file,
    write_float32_file,
)

HEX_A = "a" * 64
HEX_B = "b" * 64


def _events(run_dir: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]


def _write_audio_zip(path: Path, *names: str) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            archive.writestr(name, f"fixture audio for {name}".encode())


class _ProbeFixture:
    codec = "mp3"
    profile = "fixture"
    tags = {"source": "test"}
    time_base = "1/48000"
    first_packet_timestamp = 0.0
    skip_samples = 0
    discard_padding = 0

    def to_dict(self) -> dict[str, object]:
        return {"codec": self.codec, "sample_rate": 48_000, "channels": 2}


class _CanonicalFixture:
    sample_rate = 48_000
    channels = 2
    frames = 4
    timeline_offset_frames = 0

    def __init__(self, output_path: Path) -> None:
        self.output_path = output_path

    def to_dict(self, *, run_dir: Path) -> dict[str, object]:
        return {
            "canonical_format": "wav-f32le-interleaved",
            "output": artifact_reference(self.output_path, run_dir),
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "frames": self.frames,
        }


def _fake_probe(*args, **kwargs) -> _ProbeFixture:
    del args, kwargs
    return _ProbeFixture()


def _fake_decode(source, output_path: Path, *args, **kwargs) -> _CanonicalFixture:
    del source, args, kwargs
    output_path.write_bytes(b"canonical fixture")
    return _CanonicalFixture(output_path)


def base_manifest(run_dir: Path) -> RunManifest:
    manifest = RunManifest.create(run_id="test-run")
    manifest.data["source_archive"] = {
        "original_name": "fixture.zip",
        "bytes": 123,
        "sha256": HEX_A,
        "zip_comment": {"encoding": "base64", "value": ""},
        "central_directory_sha256": "c" * 64,
        "inventory_sha256": HEX_B,
    }
    manifest.write(run_dir / "run-manifest.json")
    return manifest


def _audio_asset_record(
    asset_id: str,
    path: Path,
    run_dir: Path,
    *,
    sample_rate: int,
    channels: int,
    frames: int,
) -> dict[str, object]:
    return {
        "asset_id": asset_id,
        "original_name": f"{asset_id}.wav",
        "normalized_name": f"{asset_id}.wav",
        "codec": "pcm_f32le",
        "profile": None,
        "tags": {},
        "time_base": f"1/{sample_rate}",
        "first_packet_timestamp": 0.0,
        "skip_samples": 0,
        "discard_padding": 0,
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_seconds": frames / sample_rate,
        "decoded_frames": frames,
        "timeline_offset_frames": 0,
        "canonical_pcm": artifact_reference(path, run_dir),
        "probe": {},
        "decode": {},
    }


def _seal_inspection(manifest: RunManifest, run_dir: Path) -> dict[str, str]:
    manifest.write(run_dir / "run-manifest.json")
    snapshot_path = cli_module._preserve_inspection_snapshot(run_dir, manifest)
    source = manifest.data["source_archive"]
    assert isinstance(source, dict)
    return approval_binding(
        snapshot_path,
        source_archive_sha256=str(source["sha256"]),
        inventory_sha256=str(source["inventory_sha256"]),
    )


def _record_gate_a(manifest: RunManifest, run_dir: Path, payload: dict[str, object]) -> Path:
    approval_path = run_dir / "analysis-selection.json"
    atomic_write_json(approval_path, payload)
    manifest.data["analysis_selection"] = {
        "artifact": artifact_reference(approval_path, run_dir),
        "upstream": payload["upstream"],
    }
    manifest.write()
    return approval_path


def test_inspect_closes_every_successful_stage(tmp_path: Path, monkeypatch) -> None:
    archive = tmp_path / "stems.zip"
    run_dir = tmp_path / "run"
    run_dir.mkdir(mode=0o755)
    run_dir.chmod(0o755)
    archive_names = ("Drums.mp3", "Bass.mp3")
    expected_extracted_bytes = sum(
        len(f"fixture audio for {name}".encode()) for name in archive_names
    )
    _write_audio_zip(archive, *archive_names)
    monkeypatch.setattr(audio_probe_module, "probe_audio", _fake_probe)
    monkeypatch.setattr(audio_probe_module, "decode_canonical", _fake_decode)

    result = cli_module.command_inspect(
        argparse.Namespace(
            run=str(run_dir),
            zip=str(archive),
            ffmpeg="unused",
            ffprobe="unused",
        )
    )

    assert result["accepted_files"] == 2
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    snapshot_ref = manifest.data["inspection_snapshot"]
    snapshot_path = verify_artifact_reference(snapshot_ref, run_dir)
    template = json.loads((run_dir / "analysis-selection.template.json").read_text())
    assert template["upstream"]["run_manifest_sha256"] == snapshot_ref["sha256"]
    assert hashlib.sha256(snapshot_path.read_bytes()).hexdigest() == snapshot_ref["sha256"]
    assert RunManifest.load(snapshot_path).data["inspection_snapshot"] is None
    events = _events(run_dir)
    for stage in ("inspecting-archive", "extracting", "probing-and-decoding"):
        stage_events = [event for event in events if event["stage"] == stage]
        assert stage_events[0]["status"] == "started"
        assert stage_events[-1]["status"] == "completed"
    decode_completed = next(
        event
        for event in events
        if event["stage"] == "probing-and-decoding" and event["status"] == "completed"
    )
    assert decode_completed["progress"] == {
        "completed": 2,
        "total": 2,
        "unit": "files",
    }
    assert decode_completed["details"]["decoded_frames"] == 8
    extraction_events = [event for event in events if event["stage"] == "extracting"]
    assert extraction_events[0]["progress"] == {
        "completed": 0,
        "total": expected_extracted_bytes,
        "unit": "bytes",
    }
    assert extraction_events[-1]["progress"] == {
        "completed": expected_extracted_bytes,
        "total": expected_extracted_bytes,
        "unit": "bytes",
    }
    progress_events = [event for event in extraction_events if event["status"] == "progress"]
    assert progress_events
    assert [event["progress"]["completed"] for event in progress_events] == sorted(
        event["progress"]["completed"] for event in progress_events
    )
    assert progress_events[-1]["details"]["completed_files"] == 2
    assert stat.S_IMODE(run_dir.stat().st_mode) == 0o755
    assert stat.S_IMODE((run_dir / "canonical").stat().st_mode) == 0o700
    assert stat.S_IMODE((run_dir / "artifacts").stat().st_mode) == 0o700


def test_approve_analysis_persists_gate_a_before_analysis_and_verify_checks_it(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    archive = tmp_path / "stems.zip"
    run_dir = tmp_path / "run"
    _write_audio_zip(archive, "Drums.mp3")
    monkeypatch.setattr(audio_probe_module, "probe_audio", _fake_probe)
    monkeypatch.setattr(audio_probe_module, "decode_canonical", _fake_decode)
    cli_module.command_inspect(
        argparse.Namespace(
            run=str(run_dir),
            zip=str(archive),
            ffmpeg="unused",
            ffprobe="unused",
        )
    )

    result = main(
        [
            "approve-analysis",
            "--run",
            str(run_dir),
            "--approved-by",
            "test-user",
            "--confirm-files",
            "--confirm-roles",
            "--confirm-reference",
            "--confirm-originals-unchanged",
        ]
    )

    assert result == 0, capsys.readouterr().err
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["analysis"] is None
    assert manifest.data["analysis_selection"]["artifact"]["path"] == "analysis-selection.json"
    cli_module.command_report(argparse.Namespace(run=str(run_dir)))
    assert "- Gate A: approved" in (run_dir / "report.md").read_text()

    approval_path = run_dir / "analysis-selection.json"
    approval_path.write_bytes(approval_path.read_bytes() + b"\n")
    assert main(["verify-run", "--run", str(run_dir)]) == 2
    assert "artifact hash/length mismatch" in capsys.readouterr().err


def test_approve_analysis_rolls_back_new_approval_if_manifest_write_fails(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    archive = tmp_path / "stems.zip"
    run_dir = tmp_path / "run"
    _write_audio_zip(archive, "Drums.mp3")
    monkeypatch.setattr(audio_probe_module, "probe_audio", _fake_probe)
    monkeypatch.setattr(audio_probe_module, "decode_canonical", _fake_decode)
    cli_module.command_inspect(
        argparse.Namespace(
            run=str(run_dir),
            zip=str(archive),
            ffmpeg="unused",
            ffprobe="unused",
        )
    )

    def fail_write(*args, **kwargs):
        del args, kwargs
        raise OSError("synthetic manifest write failure")

    monkeypatch.setattr(RunManifest, "write", fail_write)
    result = main(
        [
            "approve-analysis",
            "--run",
            str(run_dir),
            "--approved-by",
            "test-user",
            "--confirm-files",
            "--confirm-roles",
            "--confirm-reference",
            "--confirm-originals-unchanged",
        ]
    )

    assert result == 2
    assert "synthetic manifest write failure" in capsys.readouterr().err
    assert not (run_dir / "analysis-selection.json").exists()
    stored = json.loads((run_dir / "run-manifest.json").read_text())
    assert stored["analysis_selection"] is None


def test_inspect_records_archive_inspection_failure(tmp_path: Path) -> None:
    archive = tmp_path / "not-a-zip.zip"
    archive.write_bytes(b"not a zip")
    run_dir = tmp_path / "run"

    with pytest.raises(RuntimeError, match="invalid or unsupported ZIP"):
        cli_module.command_inspect(
            argparse.Namespace(
                run=str(run_dir),
                zip=str(archive),
                ffmpeg="unused",
                ffprobe="unused",
            )
        )

    events = _events(run_dir)
    assert [(event["stage"], event["status"]) for event in events] == [
        ("inspecting-archive", "started"),
        ("inspecting-archive", "failed"),
    ]
    assert "invalid or unsupported ZIP" in events[-1]["details"]["error"]


def test_inspect_records_atomic_extraction_failure(tmp_path: Path, monkeypatch) -> None:
    archive = tmp_path / "stems.zip"
    run_dir = tmp_path / "run"
    _write_audio_zip(archive, "Drums.mp3")

    def fail_extract(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("synthetic extraction failure")

    monkeypatch.setattr(zip_ingest_module, "extract_zip_safe", fail_extract)

    with pytest.raises(RuntimeError, match="synthetic extraction failure"):
        cli_module.command_inspect(
            argparse.Namespace(
                run=str(run_dir),
                zip=str(archive),
                ffmpeg="unused",
                ffprobe="unused",
            )
        )

    extraction_events = [event for event in _events(run_dir) if event["stage"] == "extracting"]
    failed = extraction_events[-1]
    assert (failed["stage"], failed["status"]) == ("extracting", "failed")
    assert failed["progress"] == {
        "completed": 0,
        "total": extraction_events[0]["progress"]["total"],
        "unit": "bytes",
    }
    assert failed["details"]["completed_files"] == 0
    assert failed["details"]["total_files"] == 1
    assert failed["details"]["error"] == "synthetic extraction failure"


def test_inspect_records_decode_failure_after_completed_files(tmp_path: Path, monkeypatch) -> None:
    archive = tmp_path / "stems.zip"
    run_dir = tmp_path / "run"
    _write_audio_zip(archive, "Drums.mp3", "Bass.mp3")
    monkeypatch.setattr(audio_probe_module, "probe_audio", _fake_probe)
    decode_count = 0

    def fail_second_decode(source, output_path: Path, *args, **kwargs):
        nonlocal decode_count
        decode_count += 1
        if decode_count == 2:
            raise RuntimeError("synthetic decode failure")
        return _fake_decode(source, output_path, *args, **kwargs)

    monkeypatch.setattr(audio_probe_module, "decode_canonical", fail_second_decode)

    with pytest.raises(RuntimeError, match="synthetic decode failure"):
        cli_module.command_inspect(
            argparse.Namespace(
                run=str(run_dir),
                zip=str(archive),
                ffmpeg="unused",
                ffprobe="unused",
            )
        )

    failed = _events(run_dir)[-1]
    assert (failed["stage"], failed["status"]) == (
        "probing-and-decoding",
        "failed",
    )
    assert failed["progress"] == {"completed": 1, "total": 2, "unit": "files"}
    assert failed["details"]["operation"] == "decoding"
    assert failed["details"]["error"] == "synthetic decode failure"
    assert isinstance(failed["details"]["asset_id"], str)


def test_analyze_refuses_without_gate_a(tmp_path: Path, capsys) -> None:
    base_manifest(tmp_path)

    result = main(["analyze", "--run", str(tmp_path)])

    assert result == 2
    assert "Gate A is not approved" in capsys.readouterr().err


def test_render_refuses_without_gate_b(tmp_path: Path, capsys) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    command_analyze(_analyze_args(run_dir, librosa=False), analyzer=FakeAnalyzer())

    result = main(["render-bakeoff", "--run", str(run_dir)])

    assert result == 2
    assert "Gate B is not approved" in capsys.readouterr().err


class FakeAnalyzer:
    def analyze(self, reference, artifact_dir: Path) -> BeatAnalysis:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        return BeatAnalysis(
            analyzer="fake",
            package_version="1",
            model="deterministic-test",
            checkpoint_sha256=None,
            resolution_hz=48_000,
            reference_sha256=reference.sha256,
            reference_frames=reference.frames,
            reference_sample_rate=reference.sample_rate,
            beats_seconds=(0.0, 1 / 48_000),
            downbeats_seconds=(0.0,),
            elapsed_seconds=0.0,
        )


class ArtifactAnalyzer:
    def analyze(self, reference, artifact_dir: Path) -> BeatAnalysis:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        logits_path = artifact_dir / "primary-logits.npy"
        logits_path.write_bytes(b"fixture primary logits")
        return BeatAnalysis(
            analyzer="fake-beat-this",
            package_version="1",
            model="deterministic-test",
            checkpoint_sha256=None,
            resolution_hz=48_000,
            reference_sha256=reference.sha256,
            reference_frames=reference.frames,
            reference_sample_rate=reference.sample_rate,
            beats_seconds=(0.0, 1 / 48_000),
            downbeats_seconds=(0.0,),
            elapsed_seconds=0.0,
            artifacts=(
                AnalysisArtifact(
                    path=logits_path.name,
                    bytes=logits_path.stat().st_size,
                    sha256=hashlib.sha256(logits_path.read_bytes()).hexdigest(),
                ),
            ),
            diagnostics={
                "torch_version": "fixture-torch",
                "numpy_version": "fixture-numpy",
            },
        )


class FailOnceAfterArtifactAnalyzer:
    def __init__(self) -> None:
        self.calls = 0

    def analyze(self, reference, artifact_dir: Path) -> BeatAnalysis:
        self.calls += 1
        artifact_dir.mkdir(parents=True, exist_ok=True)
        (artifact_dir / "partial-model-output.bin").write_bytes(
            f"failed attempt {self.calls}".encode()
        )
        if self.calls == 1:
            raise RuntimeError("synthetic primary model failure")
        return ArtifactAnalyzer().analyze(reference, artifact_dir)


class DiagnosticFixture:
    def __init__(
        self,
        name: str,
        calls: list[dict[str, object]],
        *,
        fail: bool = False,
    ) -> None:
        self.name = name
        self.calls = calls
        self.fail = fail

    def analyze(self, reference, artifact_dir: Path) -> dict[str, object]:
        self.calls.append(
            {
                "name": self.name,
                "path": reference.output_path,
                "sha256": reference.sha256,
                "frames": reference.frames,
                "bytes_before": reference.output_path.read_bytes(),
            }
        )
        if self.fail:
            raise RuntimeError(f"synthetic {self.name} failure")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        artifact_path = artifact_dir / "librosa-dynamic-tempo.npy"
        artifact_path.write_bytes(f"fixture {self.name} tempo curve".encode())
        return {
            "analyzer": "librosa",
            "package_version": "fixture-librosa",
            "numpy_version": "fixture-numpy",
            "role": "diagnostic-only",
            "artifact": {
                "path": artifact_path.name,
                "bytes": artifact_path.stat().st_size,
                "sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            },
            # The runner must force this false even if an implementation claims otherwise.
            "may_replace_primary": True,
        }


def _drum_analysis_run(
    tmp_path: Path,
    *,
    drum_included: bool = True,
    drum_role: str = "drums",
) -> tuple[Path, dict[str, Path]]:
    run_dir = tmp_path / "drum-analysis-run"
    run_dir.mkdir()
    paths = {
        "drums": run_dir / "canonical" / "drums.wav",
        "bass": run_dir / "canonical" / "bass.wav",
    }
    write_float32_file(paths["drums"], [0.1, -0.1, 0.2, -0.2])
    write_float32_file(paths["bass"], [0.05, -0.05, 0.1, -0.1])
    manifest = RunManifest.create(run_id="drum-analysis-test")
    manifest.data["source_archive"] = {
        "original_name": "fixture.zip",
        "bytes": 123,
        "sha256": HEX_A,
        "zip_comment": {"encoding": "base64", "value": ""},
        "central_directory_sha256": "c" * 64,
        "inventory_sha256": HEX_B,
    }
    manifest.data["audio_assets"] = [
        _audio_asset_record(
            asset_id,
            path,
            run_dir,
            sample_rate=48_000,
            channels=2,
            frames=2,
        )
        for asset_id, path in paths.items()
    ]
    binding = _seal_inspection(manifest, run_dir)
    gate_a = {
        "schema_version": "opusloops.analysis-selection.v1",
        "approval_id": "approval-drum-crosscheck",
        "approved_at": "2026-09-05T12:00:00Z",
        "approved_by": "test-user",
        "upstream": binding,
        "selection": {
            "reference_method": "selected-stem-sum",
            "assets": [
                {
                    "asset_id": "drums",
                    "role": drum_role,
                    "included": drum_included,
                    "gain_db": 0,
                },
                {
                    "asset_id": "bass",
                    "role": "bass",
                    "included": True,
                    "gain_db": 0,
                },
            ],
            "full_mix_asset_id": None,
            "drum_crosscheck_asset_id": "drums",
            "sum": {"headroom_db": -12, "normalize_peak_dbfs": -3},
        },
        "confirmations": {
            "files_and_hashes_reviewed": True,
            "roles_reviewed": True,
            "reference_method_reviewed": True,
            "originals_unchanged": True,
        },
    }
    _record_gate_a(manifest, run_dir, gate_a)
    return run_dir, paths


def _analyze_args(run_dir: Path, *, librosa: bool = True) -> argparse.Namespace:
    return argparse.Namespace(
        run=str(run_dir),
        checkpoint="unused",
        checkpoint_sha256=None,
        device="cpu",
        float16=False,
        librosa=librosa,
    )


def test_analyze_accepts_hash_bound_gate_a_with_injected_analyzer(tmp_path: Path) -> None:
    canonical_path = tmp_path / "canonical" / "asset_one.wav"
    write_float32_file(canonical_path, [0.1, -0.1, 0.2, -0.2])
    manifest = RunManifest.create(run_id="test-run")
    manifest.data["source_archive"] = {
        "original_name": "fixture.zip",
        "bytes": 123,
        "sha256": HEX_A,
        "zip_comment": {"encoding": "base64", "value": ""},
        "central_directory_sha256": "c" * 64,
        "inventory_sha256": HEX_B,
    }
    manifest.data["audio_assets"] = [
        _audio_asset_record(
            "asset_one",
            canonical_path,
            tmp_path,
            sample_rate=48_000,
            channels=2,
            frames=2,
        )
    ]
    binding = _seal_inspection(manifest, tmp_path)
    gate_a = {
        "schema_version": "opusloops.analysis-selection.v1",
        "approval_id": "approval-a",
        "approved_at": "2026-09-05T12:00:00Z",
        "approved_by": "test-user",
        "upstream": binding,
        "selection": {
            "reference_method": "full-mix",
            "assets": [
                {
                    "asset_id": "asset_one",
                    "role": "full-mix",
                    "included": True,
                    "gain_db": 0,
                }
            ],
            "full_mix_asset_id": "asset_one",
            "drum_crosscheck_asset_id": None,
            "sum": {"headroom_db": -12, "normalize_peak_dbfs": -3},
        },
        "confirmations": {
            "files_and_hashes_reviewed": True,
            "roles_reviewed": True,
            "reference_method_reviewed": True,
            "originals_unchanged": True,
        },
    }
    _record_gate_a(manifest, tmp_path, gate_a)
    args = argparse.Namespace(
        run=str(tmp_path),
        checkpoint="unused",
        checkpoint_sha256=None,
        device="cpu",
        float16=False,
        librosa=False,
    )

    result = command_analyze(args, analyzer=FakeAnalyzer())

    assert result["beats"] == 2
    attempt_dir = Path(str(result["attempt_directory"]))
    analysis_path = Path(str(result["analysis"]))
    assert result["attempt_id"] == attempt_dir.name
    assert attempt_dir.parent == tmp_path / "analysis-attempts"
    assert analysis_path == attempt_dir / "analysis.json"
    assert analysis_path.is_file()
    assert stat.S_IMODE(attempt_dir.stat().st_mode) == 0o700
    updated = RunManifest.load(tmp_path / "run-manifest.json")
    assert updated.data["analysis_selection"] is not None
    assert updated.data["analysis"] is not None
    assert updated.data["analysis"]["attempt_id"] == result["attempt_id"]
    assert (
        updated.data["analysis"]["artifact"]["path"]
        == analysis_path.relative_to(tmp_path).as_posix()
    )
    events = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]
    analyzing_started = next(
        event for event in events if event["stage"] == "analyzing" and event["status"] == "started"
    )
    assert "progress" not in analyzing_started
    assert analyzing_started["details"]["progress_kind"] == "indeterminate"
    assert analyzing_started["details"]["attempt_id"] == result["attempt_id"]


@pytest.mark.parametrize(
    ("drum_included", "drum_role", "message"),
    (
        (False, "drums", "drum cross-check asset must be included"),
        (True, "bass", "drum cross-check asset must have the drums role"),
    ),
)
def test_analyze_rejects_invalid_approved_drum_crosscheck(
    tmp_path: Path,
    drum_included: bool,
    drum_role: str,
    message: str,
) -> None:
    run_dir, _ = _drum_analysis_run(
        tmp_path,
        drum_included=drum_included,
        drum_role=drum_role,
    )

    with pytest.raises(RuntimeError, match=message):
        command_analyze(_analyze_args(run_dir), analyzer=FakeAnalyzer())

    assert not (run_dir / "analysis-attempts").exists()


def test_failed_analysis_attempt_is_private_and_does_not_block_retry(tmp_path: Path) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    analyzer = FailOnceAfterArtifactAnalyzer()

    with pytest.raises(RuntimeError, match="synthetic primary model failure"):
        command_analyze(_analyze_args(run_dir, librosa=False), analyzer=analyzer)

    failed_manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert failed_manifest.data["analysis"] is None
    attempts_dir = run_dir / "analysis-attempts"
    failed_attempts = tuple(attempts_dir.iterdir())
    assert len(failed_attempts) == 1
    failed_attempt = failed_attempts[0]
    assert (failed_attempt / "reference.wav").is_file()
    assert (failed_attempt / "analysis" / "partial-model-output.bin").is_file()
    assert not (failed_attempt / "analysis.json").exists()
    assert stat.S_IMODE(attempts_dir.stat().st_mode) == 0o700
    assert stat.S_IMODE(failed_attempt.stat().st_mode) == 0o700
    assert stat.S_IMODE((failed_attempt / "analysis").stat().st_mode) == 0o700

    result = command_analyze(_analyze_args(run_dir, librosa=False), analyzer=analyzer)

    completed_attempt = Path(str(result["attempt_directory"]))
    assert completed_attempt != failed_attempt
    assert completed_attempt.parent == attempts_dir
    assert stat.S_IMODE(completed_attempt.stat().st_mode) == 0o700
    assert stat.S_IMODE((completed_attempt / "analysis").stat().st_mode) == 0o700
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["analysis"]["attempt_id"] == result["attempt_id"]
    assert manifest.data["analysis"]["artifact"]["path"].startswith(
        f"analysis-attempts/{result['attempt_id']}/"
    )
    assert len(tuple(attempts_dir.iterdir())) == 2

    attempt_events = [event for event in _events(run_dir) if event["stage"] == "analysis-attempt"]
    assert [event["status"] for event in attempt_events] == [
        "started",
        "failed",
        "started",
        "completed",
    ]
    failed_attempt_id = attempt_events[0]["details"]["attempt_id"]
    assert attempt_events[1]["details"]["attempt_id"] == failed_attempt_id
    assert attempt_events[2]["details"]["attempt_id"] == result["attempt_id"]
    assert attempt_events[3]["details"]["attempt_id"] == result["attempt_id"]
    assert failed_attempt_id != result["attempt_id"]
    correlated_stages = {
        "building-reference",
        "normalizing-reference",
        "analyzing",
        "analysis-attempt",
        "analysis-ready-for-review",
    }
    assert all(
        isinstance(event.get("details", {}).get("attempt_id"), str)
        for event in _events(run_dir)
        if event["stage"] in correlated_stages
    )


def test_completed_analysis_prevents_a_second_attempt(tmp_path: Path) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    result = command_analyze(_analyze_args(run_dir, librosa=False), analyzer=FakeAnalyzer())
    attempts_dir = run_dir / "analysis-attempts"

    with pytest.raises(RuntimeError, match="analysis already exists"):
        command_analyze(_analyze_args(run_dir, librosa=False), analyzer=FakeAnalyzer())

    assert [path.name for path in attempts_dir.iterdir()] == [result["attempt_id"]]
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["analysis"]["attempt_id"] == result["attempt_id"]


def test_analysis_lock_refuses_a_concurrent_attempt(tmp_path: Path) -> None:
    run_dir = tmp_path / "analysis-lock-run"
    run_dir.mkdir()

    with (
        cli_module._exclusive_analysis_lock(run_dir),
        pytest.raises(CalibrationCLIError, match="already running"),
        cli_module._exclusive_analysis_lock(run_dir),
    ):
        raise AssertionError("a second analysis lock must not be acquired")

    lock_path = run_dir / ".analysis.lock"
    assert lock_path.is_file()
    assert stat.S_IMODE(lock_path.stat().st_mode) == 0o600


def test_analyze_recovers_crash_left_stages_before_fresh_attempt(tmp_path: Path) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    orphan_attempt_id = "00000000-0000-4000-8000-000000000001"
    attempts_dir = run_dir / "analysis-attempts"
    attempts_dir.mkdir(mode=0o700)
    orphan_attempt = attempts_dir / orphan_attempt_id
    orphan_attempt.mkdir(mode=0o700)
    (orphan_attempt / "partial-reference.bin").write_bytes(b"interrupted")
    orphan_relative = f"analysis-attempts/{orphan_attempt_id}"
    cli_module.append_event(
        run_dir,
        "analysis-attempt",
        "started",
        details={
            "attempt_id": orphan_attempt_id,
            "attempt_directory": orphan_relative,
            "progress_kind": "indeterminate",
        },
    )
    cli_module.append_event(
        run_dir,
        "building-reference",
        "started",
        completed=0,
        total=2,
        unit="frames",
        details={"attempt_id": orphan_attempt_id, "selected_files": 2},
    )
    cli_module.append_event(
        run_dir,
        "building-reference",
        "progress",
        completed=1,
        total=2,
        unit="frames",
        details={"attempt_id": orphan_attempt_id, "selected_files": 2},
    )

    result = command_analyze(_analyze_args(run_dir, librosa=False), analyzer=FakeAnalyzer())

    assert result["attempt_id"] != orphan_attempt_id
    assert (orphan_attempt / "partial-reference.bin").read_bytes() == b"interrupted"
    events = cli_module.verify_event_journal(run_dir)
    orphan_events = [
        event for event in events if event.get("details", {}).get("attempt_id") == orphan_attempt_id
    ]
    building_failed = next(
        event
        for event in orphan_events
        if event["stage"] == "building-reference" and event["status"] == "failed"
    )
    assert building_failed["progress"] == {
        "completed": 1,
        "total": 2,
        "unit": "frames",
    }
    assert building_failed["details"]["recovered_on_retry"] is True
    attempt_failed = next(
        event
        for event in orphan_events
        if event["stage"] == "analysis-attempt" and event["status"] == "failed"
    )
    assert attempt_failed["determinate"] is False
    assert attempt_failed["details"]["attempt_directory"] == orphan_relative
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    analysis_record = manifest.data["analysis"]
    assert analysis_record["attempt_id"] == result["attempt_id"]
    bound_prefix = f"analysis-attempts/{result['attempt_id']}/"
    assert analysis_record["artifact"]["path"].startswith(bound_prefix)
    assert analysis_record["reference"]["path"].startswith(bound_prefix)
    assert analysis_record["grid_template"]["path"].startswith(bound_prefix)


def test_analyze_refuses_to_recover_an_attempt_with_mismatched_path(tmp_path: Path) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    orphan_attempt_id = "00000000-0000-4000-8000-000000000002"
    attempts_dir = run_dir / "analysis-attempts"
    attempts_dir.mkdir(mode=0o700)
    (attempts_dir / orphan_attempt_id).mkdir(mode=0o700)
    cli_module.append_event(
        run_dir,
        "analysis-attempt",
        "started",
        details={
            "attempt_id": orphan_attempt_id,
            "attempt_directory": "analysis-attempts/different-attempt",
            "progress_kind": "indeterminate",
        },
    )

    with pytest.raises(CalibrationCLIError, match="not cross-bound"):
        command_analyze(_analyze_args(run_dir, librosa=False), analyzer=FakeAnalyzer())

    assert len(tuple(attempts_dir.iterdir())) == 1
    assert [event["status"] for event in _events(run_dir)[-1:]] == ["started"]
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["analysis"] is None


def test_analyze_runs_hash_verified_drum_diagnostic_with_provenance(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir, canonical_paths = _drum_analysis_run(tmp_path)
    original_bytes = {name: path.read_bytes() for name, path in canonical_paths.items()}
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        cli_module,
        "LibrosaDiagnostic",
        lambda: DiagnosticFixture("librosa", calls),
    )
    monkeypatch.setattr(
        cli_module,
        "LibrosaDrumStemDiagnostic",
        lambda: DiagnosticFixture("librosa-drum-stem", calls),
    )

    result = command_analyze(_analyze_args(run_dir), analyzer=ArtifactAnalyzer())

    assert result["beats"] == 2
    attempt_id = str(result["attempt_id"])
    attempt_dir = Path(str(result["attempt_directory"]))
    assert [call["name"] for call in calls] == ["librosa", "librosa-drum-stem"]
    assert calls[0]["path"] == attempt_dir / "reference.wav"
    assert calls[1]["path"] == canonical_paths["drums"].resolve()
    assert calls[1]["path"] != canonical_paths["bass"].resolve()
    assert calls[1]["sha256"] == hashlib.sha256(original_bytes["drums"]).hexdigest()
    assert calls[1]["frames"] == 2
    assert {name: path.read_bytes() for name, path in canonical_paths.items()} == original_bytes

    analysis = json.loads(Path(str(result["analysis"])).read_text())
    assert analysis["attempt_id"] == attempt_id
    primary = analysis["primary"]
    assert primary["analyzer"] == "fake-beat-this"
    assert primary["diagnostics"]["torch_version"] == "fixture-torch"
    assert primary["diagnostics"]["numpy_version"] == "fixture-numpy"
    shared = primary["diagnostics"]["librosa"]
    drum = primary["diagnostics"]["librosa-drum-stem"]
    assert shared["status"] == "completed"
    assert shared["may_replace_primary"] is False
    assert shared["numpy_version"] == "fixture-numpy"
    assert drum["status"] == "completed"
    assert drum["may_replace_primary"] is False
    assert drum["reference"] == {
        "kind": "canonical-drum-stem",
        "asset_id": "drums",
        "artifact": artifact_reference(canonical_paths["drums"], run_dir),
        "sha256": hashlib.sha256(original_bytes["drums"]).hexdigest(),
        "frames": 2,
        "sample_rate": 48_000,
        "channels": 2,
        "timeline_offset_frames": 0,
    }

    manifest = RunManifest.load(run_dir / "run-manifest.json")
    artifacts = manifest.data["analysis"]["artifacts"]
    assert [item["path"] for item in artifacts["primary"]] == [
        f"analysis-attempts/{attempt_id}/analysis/primary-logits.npy"
    ]
    assert artifacts["diagnostics"]["librosa"][0]["path"] == (
        f"analysis-attempts/{attempt_id}/analysis/librosa/librosa-dynamic-tempo.npy"
    )
    assert artifacts["diagnostics"]["librosa-drum-stem"][0]["path"] == (
        f"analysis-attempts/{attempt_id}/analysis/librosa-drum-stem/librosa-dynamic-tempo.npy"
    )
    for reference in artifacts["primary"]:
        verify_artifact_reference(reference, run_dir)
    for diagnostic_artifacts in artifacts["diagnostics"].values():
        for reference in diagnostic_artifacts:
            verify_artifact_reference(reference, run_dir)

    events = _events(run_dir)
    shared_events = [event for event in events if event["stage"] == "diagnostic-analysis"]
    drum_events = [event for event in events if event["stage"] == "drum-stem-diagnostic-analysis"]
    assert [event["status"] for event in shared_events] == ["started", "completed"]
    assert [event["status"] for event in drum_events] == ["started", "completed"]
    assert all(event["details"]["attempt_id"] == attempt_id for event in shared_events)
    assert all(event["details"]["attempt_id"] == attempt_id for event in drum_events)
    assert drum_events[0]["details"]["reference"]["asset_id"] == "drums"
    assert drum_events[0]["details"]["reference"]["frames"] == 2
    assert drum_events[0]["details"]["reference"]["sha256"] == drum["reference"]["sha256"]


def test_drum_diagnostic_failure_is_non_authoritative_and_truthful(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir, canonical_paths = _drum_analysis_run(tmp_path)
    original_hash = hashlib.sha256(canonical_paths["drums"].read_bytes()).hexdigest()
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        cli_module,
        "LibrosaDiagnostic",
        lambda: DiagnosticFixture("librosa", calls),
    )
    monkeypatch.setattr(
        cli_module,
        "LibrosaDrumStemDiagnostic",
        lambda: DiagnosticFixture("librosa-drum-stem", calls, fail=True),
    )

    result = command_analyze(_analyze_args(run_dir), analyzer=ArtifactAnalyzer())

    assert result["beats"] == 2
    analysis = json.loads(Path(str(result["analysis"])).read_text())
    primary = analysis["primary"]
    assert primary["analyzer"] == "fake-beat-this"
    assert primary["diagnostics"]["librosa"]["status"] == "completed"
    drum = primary["diagnostics"]["librosa-drum-stem"]
    assert drum["status"] == "failed"
    assert drum["may_replace_primary"] is False
    assert drum["role"] == "diagnostic-only"
    assert drum["error"] == "synthetic librosa-drum-stem failure"
    assert drum["reference"]["asset_id"] == "drums"
    assert hashlib.sha256(canonical_paths["drums"].read_bytes()).hexdigest() == original_hash

    manifest = RunManifest.load(run_dir / "run-manifest.json")
    diagnostic_artifacts = manifest.data["analysis"]["artifacts"]["diagnostics"]
    assert "librosa" in diagnostic_artifacts
    assert "librosa-drum-stem" not in diagnostic_artifacts
    drum_events = [
        event for event in _events(run_dir) if event["stage"] == "drum-stem-diagnostic-analysis"
    ]
    assert [event["status"] for event in drum_events] == ["started", "failed"]
    assert drum_events[-1]["details"]["error"] == "synthetic librosa-drum-stem failure"
    assert any(
        event["stage"] == "analysis-ready-for-review" and event["status"] == "waiting"
        for event in _events(run_dir)
    )


@pytest.mark.parametrize(
    "mutation",
    ("tamper-primary", "delete-drum-diagnostic", "cross-attempt-primary"),
)
def test_verify_run_covers_primary_and_diagnostic_analysis_artifacts(
    tmp_path: Path, monkeypatch, capsys, mutation: str
) -> None:
    run_dir, _ = _drum_analysis_run(tmp_path)
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        cli_module,
        "LibrosaDiagnostic",
        lambda: DiagnosticFixture("librosa", calls),
    )
    monkeypatch.setattr(
        cli_module,
        "LibrosaDrumStemDiagnostic",
        lambda: DiagnosticFixture("librosa-drum-stem", calls),
    )
    command_analyze(_analyze_args(run_dir), analyzer=ArtifactAnalyzer())
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    artifacts = manifest.data["analysis"]["artifacts"]
    if mutation == "tamper-primary":
        path = verify_artifact_reference(artifacts["primary"][0], run_dir)
        path.write_bytes(path.read_bytes() + b"tampered")
    elif mutation == "delete-drum-diagnostic":
        path = verify_artifact_reference(
            artifacts["diagnostics"]["librosa-drum-stem"][0],
            run_dir,
        )
        path.unlink()
    else:
        foreign_attempt = run_dir / "analysis-attempts" / "foreign-attempt"
        foreign_attempt.mkdir()
        foreign_artifact = foreign_attempt / "foreign-logits.npy"
        foreign_artifact.write_bytes(b"valid but belongs to another attempt")
        artifacts["primary"][0] = artifact_reference(foreign_artifact, run_dir)
        manifest.write()

    result = main(["verify-run", "--run", str(run_dir)])

    assert result == 2
    error = capsys.readouterr().err
    if mutation == "tamper-primary":
        assert "artifact hash/length mismatch" in error
    elif mutation == "delete-drum-diagnostic":
        assert "artifact reference escapes or is missing" in error
    else:
        assert "analyzer artifact is outside its analysis attempt" in error


def test_approve_map_requires_every_explicit_confirmation(tmp_path: Path, capsys) -> None:
    manifest = base_manifest(tmp_path)
    attempt_id = "fixture-analysis"
    attempt_dir = tmp_path / "analysis-attempts" / attempt_id
    attempt_dir.mkdir(parents=True)
    reference_path = attempt_dir / "reference.wav"
    reference_path.write_bytes(b"reference")
    reference_ref = artifact_reference(reference_path, tmp_path)
    analysis_path = attempt_dir / "analysis.json"
    atomic_write_json(
        analysis_path,
        {
            "schema_version": "opusloops.analysis.v1",
            "attempt_id": attempt_id,
            "reference": {
                "sha256": reference_ref["sha256"],
                "output_path": reference_ref["path"],
            },
            "primary": {
                "reference_sha256": reference_ref["sha256"],
                "reference_sample_rate": 48_000,
                "reference_frames": 100,
            },
        },
    )
    analysis_ref = artifact_reference(analysis_path, tmp_path)
    grid_template_path = attempt_dir / "tempo-grid.template.json"
    atomic_write_json(
        grid_template_path,
        {
            "schema_version": "opusloops.tempo-grid-review.v1",
            "attempt_id": attempt_id,
            "analysis_sha256": analysis_ref["sha256"],
            "beats_seconds": [0],
            "downbeats_seconds": [0],
            "reviewed": False,
        },
    )
    manifest.data["analysis"] = {
        "attempt_id": attempt_id,
        "artifact": analysis_ref,
        "reference": reference_ref,
        "grid_template": artifact_reference(grid_template_path, tmp_path),
        "artifacts": {"primary": [], "diagnostics": {}},
    }
    manifest.write()
    click_path = tmp_path / "click.wav"
    click_path.write_bytes(b"click")
    grid_path = tmp_path / "tempo-grid.input.json"
    atomic_write_json(
        grid_path,
        {
            "schema_version": "opusloops.tempo-grid-review.v1",
            "analysis_sha256": artifact_reference(analysis_path, tmp_path)["sha256"],
            "beats_seconds": [0],
            "downbeats_seconds": [0],
            "source": "analyzer",
        },
    )
    atomic_write_json(
        tmp_path / "tempo-approval.template.json",
        {
            "schema_version": "opusloops.tempo-approval.v1",
            "approval_id": "approval-b",
            "approved_at": None,
            "approved_by": None,
            "notice": "No audio has been altered yet.",
            "upstream": {
                "analysis_artifact": analysis_ref["path"],
                "analysis_sha256": analysis_ref["sha256"],
                "reference_sha256": reference_ref["sha256"],
                "click_audition": artifact_reference(click_path, tmp_path),
                "tempo_grid": artifact_reference(grid_path, tmp_path),
            },
            "decision": {
                "map_algorithm_version": "opusloops.shared-tempo-map.v1",
                "mode": "musical-4bar",
                "meter": {"numerator": 4, "denominator": 4},
                "first_downbeat_seconds": 0,
                "tempo_octave": "normal",
                "target_bpm": 120,
                "sample_rate": 48_000,
                "total_source_frames": 100,
                "total_target_frames": 100,
                "anchors": [
                    {"source_frame": 0, "target_frame": 0, "kind": "four-bar"},
                    {"source_frame": 100, "target_frame": 100, "kind": "partial-outro"},
                ],
                "notes": "",
            },
            "confirmations": {},
        },
    )

    result = main(
        [
            "approve-map",
            "--run",
            str(tmp_path),
            "--approved-by",
            "test-user",
        ]
    )

    assert result == 2
    assert "all Gate-B confirmations" in capsys.readouterr().err
    assert not (tmp_path / "tempo-approval.json").exists()


def test_click_audition_is_a_separate_real_wav_artifact(tmp_path: Path) -> None:
    source_path = tmp_path / "source.wav"
    write_float32_file(source_path, [0.0] * 400)
    source = ReferenceStem("source", source_path, 48_000, 2, 200)
    reference = build_reference([source], tmp_path / "reference.wav", method="full-mix")

    clicked = create_click_audition(
        reference,
        beats_seconds=[0.0, 0.002],
        downbeats_seconds=[0.0],
        output_path=tmp_path / "clicked.wav",
    )

    assert clicked.read_bytes().startswith(b"RIFF")
    assert clicked != reference.output_path
    assert max(abs(value) for value in read_float32_file(clicked)) > 0
    assert all(value == 0 for value in read_float32_file(reference.output_path))


def _proposal_test_run(tmp_path: Path) -> Path:
    run_dir = tmp_path / "proposal-run"
    run_dir.mkdir()
    attempt_id = "fixture-analysis"
    attempt_dir = run_dir / "analysis-attempts" / attempt_id
    attempt_dir.mkdir(parents=True)
    source_path = run_dir / "canonical" / "source.wav"
    write_float32_file(source_path, [0.0] * 8)
    reference = build_reference(
        [ReferenceStem("source", source_path, 48_000, 2, 4)],
        attempt_dir / "reference.wav",
        method="full-mix",
    )
    primary = BeatAnalysis(
        analyzer="fake",
        package_version="1",
        model="fixture",
        checkpoint_sha256=None,
        resolution_hz=50,
        reference_sha256=reference.sha256,
        reference_frames=reference.frames,
        reference_sample_rate=reference.sample_rate,
        beats_seconds=(0.0, 1 / 48_000),
        downbeats_seconds=(0.0,),
        elapsed_seconds=0,
    )
    analysis_path = attempt_dir / "analysis.json"
    atomic_write_json(
        analysis_path,
        {
            "schema_version": "opusloops.analysis.v1",
            "attempt_id": attempt_id,
            "reference": reference.to_dict(relative_to=run_dir),
            "primary": primary.to_dict(),
        },
    )
    analysis_ref = artifact_reference(analysis_path, run_dir)
    grid_template_path = attempt_dir / "tempo-grid.template.json"
    atomic_write_json(
        grid_template_path,
        {
            "schema_version": "opusloops.tempo-grid-review.v1",
            "attempt_id": attempt_id,
            "analysis_sha256": analysis_ref["sha256"],
            "beats_seconds": list(primary.beats_seconds),
            "downbeats_seconds": list(primary.downbeats_seconds),
            "reviewed": False,
        },
    )
    manifest = RunManifest.create(run_id="proposal-test")
    manifest.data["analysis"] = {
        "attempt_id": attempt_id,
        "artifact": analysis_ref,
        "reference": artifact_reference(reference.output_path, run_dir),
        "grid_template": artifact_reference(grid_template_path, run_dir),
        "artifacts": {"primary": [], "diagnostics": {}},
    }
    manifest.write(run_dir / "run-manifest.json")
    return run_dir


def _proposal_args(
    run_dir: Path,
    *,
    proposal_id: str | None,
    first_downbeat: float | None = None,
) -> argparse.Namespace:
    return argparse.Namespace(
        run=str(run_dir),
        grid=None,
        first_downbeat=first_downbeat,
        meter_numerator=4,
        meter_denominator=4,
        target_bpm=None,
        mode="no-conform",
        snap_tolerance=0.08,
        proposal_id=proposal_id,
    )


def _two_proposals(run_dir: Path) -> tuple[dict[str, object], dict[str, object]]:
    first = cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="revision-one"))
    second = cli_module.command_propose_map(
        _proposal_args(
            run_dir,
            proposal_id="revision-two",
            first_downbeat=1 / 48_000,
        )
    )
    return first, second


_GATE_B_CONFIRMATION_FLAGS = (
    "--confirm-click",
    "--confirm-beat-grid",
    "--confirm-meter-downbeat",
    "--confirm-tempo-octave",
    "--confirm-flags",
    "--confirm-target",
    "--confirm-shared-map",
    "--confirm-originals-unchanged",
)


def _approve_map_argv(
    run_dir: Path,
    approval_path: Path,
    *,
    omitted_flag: str | None = None,
) -> list[str]:
    flags = [flag for flag in _GATE_B_CONFIRMATION_FLAGS if flag != omitted_flag]
    return [
        "approve-map",
        "--run",
        str(run_dir),
        "--approval",
        str(approval_path),
        "--approved-by",
        "test-user",
        *flags,
    ]


def test_propose_map_creates_two_immutable_revision_bundles(tmp_path: Path) -> None:
    run_dir = _proposal_test_run(tmp_path)

    first = cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="revision-one"))
    first_hashes = {
        key: hashlib.sha256(Path(str(first[key])).read_bytes()).hexdigest()
        for key in ("proposal", "click_audition", "tempo_grid", "approval_template")
    }
    second = cli_module.command_propose_map(
        _proposal_args(run_dir, proposal_id=None, first_downbeat=1 / 48_000)
    )

    assert first["proposal_id"] == "revision-one"
    assert isinstance(second["proposal_id"], str)
    assert second["proposal_id"] != first["proposal_id"]
    for result in (first, second):
        proposal_dir = run_dir / "proposals" / str(result["proposal_id"])
        assert stat.S_IMODE(proposal_dir.stat().st_mode) == 0o700
        assert result["proposal_directory"] == str(proposal_dir)
        assert result["proposal"] == str(proposal_dir / "tempo-map.proposal.json")
        assert result["click_audition"] == str(proposal_dir / "raw-grid-click-audition.wav")
        assert result["tempo_grid"] == str(proposal_dir / "tempo-grid.input.json")
        assert result["approval_template"] == str(proposal_dir / "tempo-approval.template.json")
        assert all(Path(str(result[key])).is_file() for key in first_hashes)
    assert stat.S_IMODE((run_dir / "proposals").stat().st_mode) == 0o700
    assert {
        key: hashlib.sha256(Path(str(first[key])).read_bytes()).hexdigest() for key in first_hashes
    } == first_hashes
    assert (
        Path(str(first["click_audition"])).read_bytes()
        != Path(str(second["click_audition"])).read_bytes()
    )


def test_propose_map_lock_refuses_a_concurrent_invocation(tmp_path: Path) -> None:
    run_dir = _proposal_test_run(tmp_path)

    with (
        cli_module._exclusive_proposal_lock(run_dir),
        pytest.raises(CalibrationCLIError, match="already running"),
    ):
        cli_module.command_propose_map(_proposal_args(run_dir, proposal_id=None))

    lock_path = run_dir / ".proposal-map.lock"
    assert lock_path.is_file()
    if os.name == "posix":
        assert stat.S_IMODE(lock_path.stat().st_mode) == 0o600
    assert not (run_dir / "proposals").exists()


def test_propose_map_recovers_sigkill_left_stages_before_fresh_proposal(
    tmp_path: Path,
) -> None:
    run_dir = _proposal_test_run(tmp_path)
    orphan_id = "interrupted-revision"
    orphan_dir = run_dir / "proposals" / orphan_id
    orphan_dir.mkdir(mode=0o700, parents=True)
    partial = orphan_dir / "partial-click.bin"
    partial.write_bytes(b"interrupted")
    cli_module.append_event(
        run_dir,
        "building-tempo-map",
        "started",
        details={"proposal_id": orphan_id},
    )
    cli_module.append_event(
        run_dir,
        "building-click-audition",
        "started",
        completed=0,
        total=4,
        unit="frames",
        details={"proposal_id": orphan_id},
    )
    cli_module.append_event(
        run_dir,
        "building-click-audition",
        "progress",
        completed=2,
        total=4,
        unit="frames",
        details={"proposal_id": orphan_id},
    )

    result = cli_module.command_propose_map(
        _proposal_args(run_dir, proposal_id="replacement-revision")
    )

    assert result["proposal_id"] == "replacement-revision"
    assert partial.read_bytes() == b"interrupted"
    assert list(orphan_dir.iterdir()) == [partial]
    events = cli_module.verify_event_journal(run_dir)
    recovered = [
        event
        for event in events
        if event.get("details", {}).get("proposal_id") == orphan_id and event["status"] == "failed"
    ]
    assert [event["stage"] for event in recovered] == [
        "building-click-audition",
        "building-tempo-map",
    ]
    assert recovered[0]["progress"] == {
        "completed": 2,
        "total": 4,
        "unit": "frames",
    }
    assert recovered[0]["details"]["recovered_on_retry"] is True
    assert recovered[1]["determinate"] is False
    replacement_click_events = [
        event
        for event in events
        if event["stage"] == "building-click-audition"
        and event.get("details", {}).get("proposal_id") == "replacement-revision"
    ]
    assert [event["status"] for event in replacement_click_events] == [
        "started",
        "progress",
        "completed",
    ]
    assert Path(str(result["proposal"])).is_file()


@pytest.mark.parametrize(
    "proposal_id",
    ("", ".hidden", "../escape", "nested/revision", "nested\\revision", "has space", "x" * 129),
)
def test_propose_map_rejects_unsafe_proposal_ids(tmp_path: Path, proposal_id: str) -> None:
    run_dir = _proposal_test_run(tmp_path)

    with pytest.raises(CalibrationCLIError, match="proposal_id must be"):
        cli_module.command_propose_map(_proposal_args(run_dir, proposal_id=proposal_id))

    assert not (run_dir / "proposals").exists()
    assert not (tmp_path / "escape").exists()


def test_propose_map_refuses_existing_proposal_id_without_overwrite(tmp_path: Path) -> None:
    run_dir = _proposal_test_run(tmp_path)
    existing = run_dir / "proposals" / "revision-one"
    existing.mkdir(parents=True)
    marker = existing / "keep.txt"
    marker.write_text("keep", encoding="utf-8")

    with pytest.raises(CalibrationCLIError, match="already exists"):
        cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="revision-one"))

    assert marker.read_text(encoding="utf-8") == "keep"
    assert list(existing.iterdir()) == [marker]


def test_propose_map_records_failure_for_active_build_stage(tmp_path: Path, monkeypatch) -> None:
    run_dir = _proposal_test_run(tmp_path)

    def fail_map(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("synthetic tempo-map failure")

    monkeypatch.setattr(cli_module, "build_tempo_map", fail_map)

    with pytest.raises(RuntimeError, match="synthetic tempo-map failure"):
        cli_module.command_propose_map(
            argparse.Namespace(
                run=str(run_dir),
                grid=None,
                first_downbeat=None,
                meter_numerator=4,
                meter_denominator=4,
                target_bpm=120,
                mode="musical-4bar",
                snap_tolerance=0.08,
                proposal_id="failed-revision",
            )
        )

    map_events = [event for event in _events(run_dir) if event["stage"] == "building-tempo-map"]
    assert [event["status"] for event in map_events] == ["started", "failed"]
    assert map_events[-1]["details"]["error"] == "synthetic tempo-map failure"


def test_propose_map_preflights_renderer_compatibility_before_click_creation(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir = _proposal_test_run(tmp_path)

    class InvalidTempoMap:
        @staticmethod
        def to_render_plan_anchors():
            return (
                render_plan_module.FrameAnchor(0, 0),
                render_plan_module.FrameAnchor(960, 960),
                render_plan_module.FrameAnchor(24_000, 24_000),
            )

    monkeypatch.setattr(cli_module, "build_tempo_map", lambda *args, **kwargs: InvalidTempoMap())

    def unexpected_click(*args, **kwargs):
        del args, kwargs
        raise AssertionError("click creation must follow render-plan preflight")

    monkeypatch.setattr(cli_module, "create_click_audition", unexpected_click)

    with pytest.raises(
        CalibrationCLIError,
        match="tempo map cannot be rendered: first map region is shorter",
    ):
        cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="renderer-incompatible"))

    map_events = [event for event in _events(run_dir) if event["stage"] == "building-tempo-map"]
    assert [event["status"] for event in map_events] == ["started", "failed"]


def test_approve_map_without_path_refuses_ambiguous_proposals(tmp_path: Path, capsys) -> None:
    run_dir = _proposal_test_run(tmp_path)
    _two_proposals(run_dir)

    result = main(
        [
            "approve-map",
            "--run",
            str(run_dir),
            "--approved-by",
            "test-user",
            "--confirm-click",
            "--confirm-beat-grid",
            "--confirm-meter-downbeat",
            "--confirm-tempo-octave",
            "--confirm-flags",
            "--confirm-target",
            "--confirm-shared-map",
            "--confirm-originals-unchanged",
        ]
    )

    assert result == 2
    assert "multiple tempo approval templates" in capsys.readouterr().err
    assert not (run_dir / "tempo-approval.json").exists()


def test_approve_map_explicitly_selects_one_proposal_and_preserves_bindings(
    tmp_path: Path, capsys
) -> None:
    run_dir = _proposal_test_run(tmp_path)
    first, second = _two_proposals(run_dir)

    result = main(
        [
            "approve-map",
            "--run",
            str(run_dir),
            "--approval",
            str(second["approval_template"]),
            "--approved-by",
            "test-user",
            "--confirm-click",
            "--confirm-beat-grid",
            "--confirm-meter-downbeat",
            "--confirm-tempo-octave",
            "--confirm-flags",
            "--confirm-target",
            "--confirm-shared-map",
            "--confirm-originals-unchanged",
        ]
    )

    assert result == 0, capsys.readouterr().err
    approved = json.loads((run_dir / "tempo-approval.json").read_text())
    selected = json.loads(Path(str(second["approval_template"])).read_text())
    rejected = json.loads(Path(str(first["approval_template"])).read_text())
    assert selected["decision"]["map_algorithm_version"] == "opusloops.shared-tempo-map.v2"
    assert selected["decision"]["first_downbeat_seconds"] == pytest.approx(1 / 48_000)
    assert all(anchor["source_frame"] != 1 for anchor in selected["decision"]["anchors"])
    assert approved["upstream"] == selected["upstream"]
    assert approved["upstream"] != rejected["upstream"]
    assert approved["upstream"]["click_audition"]["path"].startswith("proposals/revision-two/")
    assert approved["upstream"]["tempo_grid"]["path"].startswith("proposals/revision-two/")
    verify_artifact_reference(approved["upstream"]["click_audition"], run_dir)
    verify_artifact_reference(approved["upstream"]["tempo_grid"], run_dir)
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    gate_b, _, approval_path = cli_module._gate_b(run_dir, manifest)
    assert gate_b["upstream"] == approved["upstream"]
    assert approval_path == run_dir / "tempo-approval.json"


def test_approve_map_remains_compatible_with_a_v1_decision(tmp_path: Path, capsys) -> None:
    run_dir = _proposal_test_run(tmp_path)
    proposal = cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="legacy-v1"))
    template_path = Path(str(proposal["approval_template"]))
    payload = json.loads(template_path.read_text())
    payload["decision"]["map_algorithm_version"] = "opusloops.shared-tempo-map.v1"
    atomic_write_json(template_path, payload)

    assert main(_approve_map_argv(run_dir, template_path)) == 0, capsys.readouterr().err
    approved = json.loads((run_dir / "tempo-approval.json").read_text())
    assert approved["decision"]["map_algorithm_version"] == "opusloops.shared-tempo-map.v1"


@pytest.mark.parametrize(
    "omitted_flag",
    ("--confirm-beat-grid", "--confirm-meter-downbeat", "--confirm-tempo-octave"),
)
def test_approve_map_requires_distinct_grid_meter_and_octave_confirmations(
    tmp_path: Path, capsys, omitted_flag: str
) -> None:
    run_dir = _proposal_test_run(tmp_path)
    proposal = cli_module.command_propose_map(
        _proposal_args(run_dir, proposal_id="distinct-confirmations")
    )

    result = main(
        _approve_map_argv(
            run_dir,
            Path(str(proposal["approval_template"])),
            omitted_flag=omitted_flag,
        )
    )

    assert result == 2
    assert "all Gate-B confirmations" in capsys.readouterr().err
    assert not (run_dir / "tempo-approval.json").exists()


def test_approve_map_uses_canonical_schema_before_publishing(tmp_path: Path, capsys) -> None:
    run_dir = _proposal_test_run(tmp_path)
    proposal = cli_module.command_propose_map(
        _proposal_args(run_dir, proposal_id="invalid-contract")
    )
    template_path = Path(str(proposal["approval_template"]))
    payload = json.loads(template_path.read_text())
    payload["decision"].pop("notes")
    invalid_path = run_dir / "invalid-tempo-approval.json"
    atomic_write_json(invalid_path, payload)

    result = main(_approve_map_argv(run_dir, invalid_path))

    assert result == 2
    assert "tempo approval schema validation" in capsys.readouterr().err
    assert not (run_dir / "tempo-approval.json").exists()
    assert RunManifest.load(run_dir / "run-manifest.json").data["tempo_map"] is None


def test_approve_map_rolls_back_new_approval_if_manifest_write_fails(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    run_dir = _proposal_test_run(tmp_path)
    proposal = cli_module.command_propose_map(
        _proposal_args(run_dir, proposal_id="manifest-write-failure")
    )

    def fail_write(*args, **kwargs):
        del args, kwargs
        raise OSError("synthetic manifest write failure")

    monkeypatch.setattr(RunManifest, "write", fail_write)
    result = main(_approve_map_argv(run_dir, Path(str(proposal["approval_template"]))))

    assert result == 2
    assert "synthetic manifest write failure" in capsys.readouterr().err
    assert not (run_dir / "tempo-approval.json").exists()
    stored = json.loads((run_dir / "run-manifest.json").read_text())
    assert stored["tempo_map"] is None


def test_gate_b_accepts_user_bar_and_rejects_approval_or_manifest_drift(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    run_dir = _proposal_test_run(tmp_path)
    proposal = cli_module.command_propose_map(_proposal_args(run_dir, proposal_id="manual-bar"))
    template_path = Path(str(proposal["approval_template"]))
    payload = json.loads(template_path.read_text())
    payload["decision"]["anchors"][0]["kind"] = "user-bar"
    atomic_write_json(template_path, payload)

    assert main(_approve_map_argv(run_dir, template_path)) == 0, capsys.readouterr().err
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    approval, _, _ = cli_module._gate_b(run_dir, manifest)
    assert approval["decision"]["anchors"][0]["kind"] == "user-bar"

    approval_path = run_dir / "tempo-approval.json"
    approved_payload = json.loads(approval_path.read_text())
    approved_payload["decision"]["notes"] = "changed after approval"
    atomic_write_json(approval_path, approved_payload)
    with pytest.raises(RuntimeError, match="artifact hash/length mismatch"):
        cli_module._gate_b(run_dir, manifest)
    assert main(["verify-run", "--run", str(run_dir)]) == 2
    assert "artifact hash/length mismatch" in capsys.readouterr().err

    monkeypatch.setattr(
        cli_module,
        "_verified_inspection_snapshot",
        lambda current_run, current_manifest: (current_manifest, current_run / "snapshot.json"),
    )
    monkeypatch.setattr(cli_module, "_gate_a", lambda *args, **kwargs: {})
    assert main(["render-bakeoff", "--run", str(run_dir)]) == 2
    assert "artifact hash/length mismatch" in capsys.readouterr().err

    atomic_write_json(approval_path, approval)
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    manifest.data["tempo_map"]["decision"]["notes"] = "manifest-only drift"
    manifest.write()
    with pytest.raises(CalibrationCLIError, match="decision differs"):
        cli_module._gate_b(run_dir, manifest)


def _render_test_run(tmp_path: Path, *, stem_count: int = 2):
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    manifest = RunManifest.create(run_id="render-test")
    manifest.data["source_archive"] = {
        "original_name": "fixture.zip",
        "bytes": 123,
        "sha256": HEX_A,
        "zip_comment": {"encoding": "base64", "value": ""},
        "central_directory_sha256": "c" * 64,
        "inventory_sha256": HEX_B,
    }
    assets = []
    for index in range(stem_count):
        asset_id = f"stem_{index}"
        path = run_dir / "canonical" / f"{asset_id}.wav"
        path.parent.mkdir(exist_ok=True)
        frame = np.arange(64, dtype=np.float32)
        signal = (0.1 * np.sin(2 * np.pi * frame / (11 + index))).astype(np.float32)
        sf.write(path, signal, 8_000, subtype="FLOAT")
        assets.append(
            _audio_asset_record(
                asset_id,
                path,
                run_dir,
                sample_rate=8_000,
                channels=1,
                frames=64,
            )
        )
    manifest.data["audio_assets"] = assets
    binding = _seal_inspection(manifest, run_dir)
    gate_a_path = run_dir / "analysis-selection.json"
    gate_a = {
        "schema_version": "opusloops.analysis-selection.v1",
        "approval_id": "render-gate-a",
        "approved_at": "2026-09-05T12:00:00Z",
        "approved_by": "test-user",
        "upstream": binding,
        "selection": {
            "reference_method": "selected-stem-sum",
            "assets": [
                {
                    "asset_id": str(asset["asset_id"]),
                    "role": "other",
                    "included": True,
                    "gain_db": 0,
                }
                for asset in assets
            ],
            "full_mix_asset_id": None,
            "drum_crosscheck_asset_id": None,
            "sum": {"headroom_db": -12, "normalize_peak_dbfs": -3},
        },
        "confirmations": {
            "files_and_hashes_reviewed": True,
            "roles_reviewed": True,
            "reference_method_reviewed": True,
            "originals_unchanged": True,
        },
    }
    atomic_write_json(gate_a_path, gate_a)
    manifest.data["analysis_selection"] = {
        "artifact": artifact_reference(gate_a_path, run_dir),
        "upstream": binding,
    }
    manifest.write()
    approval_path = run_dir / "tempo-approval.json"
    atomic_write_json(approval_path, {"test": "approved-gate-b"})
    approval = {
        "decision": {
            "map_algorithm_version": "opusloops.shared-tempo-map.v1",
            "mode": "musical-4bar",
            "meter": {"numerator": 4, "denominator": 4},
            "first_downbeat_seconds": 0.0,
            "tempo_octave": "normal",
            "target_bpm": 120.0,
            "sample_rate": 8_000,
            "total_source_frames": 64,
            "total_target_frames": 64,
            "anchors": [
                {"source_frame": 0, "target_frame": 0, "kind": "four-bar"},
                {"source_frame": 32, "target_frame": 32, "kind": "four-bar"},
                {"source_frame": 64, "target_frame": 64, "kind": "partial-outro"},
            ],
            "notes": "test render approval",
        }
    }
    manifest.data["tempo_map"] = {
        "approval": artifact_reference(approval_path, run_dir),
        "decision": approval["decision"],
    }
    manifest.write()
    binary = tmp_path / "fake-signalsmith-render"
    binary.write_bytes(b"deterministic renderer test binary")
    binary.chmod(0o700)
    return run_dir, approval, approval_path, binary


def _fake_renderer(*, short_independent: bool = False, fail_mode: str | None = None):
    def run(binary, plan, inputs, output_directory, *, mode):
        del binary
        if mode == fail_mode:
            raise RuntimeError(f"synthetic {mode} render failure")
        output_directory.mkdir(mode=0o700, parents=True)
        for stem_index, stem in enumerate(plan.stems):
            frame_count = plan.target_frames
            if short_independent and mode == "independent":
                frame_count -= 1
            frame = np.arange(frame_count, dtype=np.float32)
            values = (0.1 * np.sin(2 * np.pi * frame / (11 + stem_index))).astype(np.float32)
            if mode == "independent" and frame_count > 20:
                values[20] += 0.01
            sf.write(
                output_directory / f"{stem.asset_id}.wav",
                values,
                plan.sample_rate,
                subtype="FLOAT",
            )
        return {
            "engine": "signalsmith-stretch",
            "version": "1.3.2",
            "mode": mode,
            "source_frames": plan.source_frames,
            "target_frames": plan.target_frames,
            "stem_count": len(plan.stems),
            "plan_sha256": inputs.plan_sha256,
            "stems_tsv_sha256": inputs.stems_tsv_sha256,
            "map_tsv_sha256": inputs.map_tsv_sha256,
            "stem_sha256s": dict(inputs.stem_sha256s),
            "wall_seconds": 0.01,
            "peak_rss_bytes": 1024,
            "verified_inputs": {
                "approval_sha256": plan.approval_sha256,
                "plan_sha256": inputs.plan_sha256,
                "map_sha256": inputs.map_sha256,
                "stems_tsv_sha256": inputs.stems_tsv_sha256,
                "map_tsv_sha256": inputs.map_tsv_sha256,
                "binding_sha256": inputs.binding_sha256,
                "stem_sha256s": dict(inputs.stem_sha256s),
                "native_consumed": {
                    "plan_sha256": inputs.plan_sha256,
                    "stems_tsv_sha256": inputs.stems_tsv_sha256,
                    "map_tsv_sha256": inputs.map_tsv_sha256,
                    "stem_sha256s": dict(inputs.stem_sha256s),
                },
            },
        }

    return run


def _mutate_approved_audio_assets(run_dir: Path, mutation: str) -> None:
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assets = list(manifest.data["audio_assets"])
    if mutation == "add":
        path = run_dir / "canonical" / "injected.wav"
        sf.write(path, np.zeros(64, dtype=np.float32), 8_000, subtype="FLOAT")
        assets.append(
            _audio_asset_record(
                "injected",
                path,
                run_dir,
                sample_rate=8_000,
                channels=1,
                frames=64,
            )
        )
    elif mutation == "remove":
        assets.pop()
    elif mutation == "replace":
        path = run_dir / "canonical" / "replacement.wav"
        sf.write(path, np.ones(64, dtype=np.float32) * 0.05, 8_000, subtype="FLOAT")
        replacement = dict(assets[0])
        replacement["canonical_pcm"] = artifact_reference(path, run_dir)
        assets[0] = replacement
    else:  # pragma: no cover - test helper contract
        raise AssertionError(f"unsupported mutation: {mutation}")
    manifest.data["audio_assets"] = assets
    manifest.write()


@pytest.mark.parametrize("mutation", ("add", "remove", "replace"))
def test_verify_run_rejects_post_gate_a_asset_mutation(
    tmp_path: Path, capsys, mutation: str
) -> None:
    run_dir, _, _, _ = _render_test_run(tmp_path)
    _mutate_approved_audio_assets(run_dir, mutation)

    result = main(["verify-run", "--run", str(run_dir)])

    assert result == 2
    assert "immutable ingest field changed after Gate A: audio_assets" in capsys.readouterr().err


@pytest.mark.parametrize("field", ("source_archive", "entries", "policy"))
def test_verify_run_rejects_other_immutable_ingest_mutation(
    tmp_path: Path, capsys, field: str
) -> None:
    run_dir, _, _, _ = _render_test_run(tmp_path)
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    if field == "source_archive":
        changed = dict(manifest.data[field])
        changed["original_name"] = "substituted.zip"
        manifest.data[field] = changed
    elif field == "entries":
        manifest.data[field] = [
            {
                "asset_id": None,
                "original_name": "notes.txt",
                "normalized_name": None,
                "compressed_bytes": 1,
                "uncompressed_bytes": 1,
                "crc32": "00000000",
                "compression_method": 0,
                "sha256": None,
                "outcome": "ignored",
                "reason": "non-audio file",
            }
        ]
    else:
        changed = dict(manifest.data[field])
        changed["max_total_entries"] = int(changed["max_total_entries"]) - 1
        manifest.data[field] = changed
    manifest.write()

    result = main(["verify-run", "--run", str(run_dir)])

    assert result == 2
    assert f"immutable ingest field changed after Gate A: {field}" in capsys.readouterr().err


@pytest.mark.parametrize("mutation", ("add", "remove", "replace"))
def test_render_rejects_post_gate_a_asset_mutation_before_gate_b_or_renderer(
    tmp_path: Path, monkeypatch, mutation: str
) -> None:
    run_dir, _, _, binary = _render_test_run(tmp_path)
    _mutate_approved_audio_assets(run_dir, mutation)
    gate_b_called = False

    def unexpected_gate_b(*args, **kwargs):
        nonlocal gate_b_called
        del args, kwargs
        gate_b_called = True
        raise AssertionError("Gate B must not run for mutated ingest state")

    monkeypatch.setattr(cli_module, "_gate_b", unexpected_gate_b)

    with pytest.raises(
        CalibrationCLIError,
        match="immutable ingest field changed after Gate A: audio_assets",
    ):
        cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))

    assert gate_b_called is False
    assert not (run_dir / "render-inputs").exists()
    assert not (run_dir / "render-attempts").exists()


def test_render_bakeoff_lock_rejects_a_concurrent_invocation(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    with (
        cli_module._exclusive_render_lock(run_dir),
        pytest.raises(CalibrationCLIError, match="already running"),
        cli_module._exclusive_render_lock(run_dir),
    ):
        raise AssertionError("a second render lock must not be acquired")

    lock = run_dir / ".render-bakeoff.lock"
    assert lock.is_file()
    if os.name == "posix":
        assert stat.S_IMODE(lock.stat().st_mode) == 0o600


def test_render_bakeoff_lock_rejects_a_hard_link(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    unrelated = tmp_path / "unrelated"
    unrelated.write_bytes(b"do not chmod")
    unrelated.chmod(0o644)
    os.link(unrelated, run_dir / ".render-bakeoff.lock")

    with (
        pytest.raises(CalibrationCLIError, match="bound regular file"),
        cli_module._exclusive_render_lock(run_dir),
    ):
        raise AssertionError("a hard-linked lock file must not be acquired")

    if os.name == "posix":
        assert stat.S_IMODE(unrelated.stat().st_mode) == 0o644


@pytest.mark.parametrize(
    ("fail_mode", "completed_frames"),
    (("linked", 0), ("independent", 128)),
)
def test_render_bakeoff_records_determinate_failure_for_active_mode(
    tmp_path: Path,
    monkeypatch,
    fail_mode: str,
    completed_frames: int,
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path)
    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(
        render_plan_module,
        "run_signalsmith",
        _fake_renderer(fail_mode=fail_mode),
    )

    with pytest.raises(RuntimeError, match=f"synthetic {fail_mode} render failure"):
        cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))

    render_events = [event for event in _events(run_dir) if event["stage"] == "rendering"]
    assert render_events[0]["status"] == "started"
    assert render_events[0]["progress"] == {
        "completed": 0,
        "total": 256,
        "unit": "stem-frames",
    }
    attempt_id = render_events[0]["details"]["attempt_id"]
    assert re.fullmatch(r"render-[0-9a-f]{32}", attempt_id)
    assert render_events[-1]["status"] == "failed"
    assert render_events[-1]["progress"] == {
        "completed": completed_frames,
        "total": 256,
        "unit": "stem-frames",
    }
    assert render_events[-1]["details"] == {
        "attempt_id": attempt_id,
        "mode": fail_mode,
        "error": f"synthetic {fail_mode} render failure",
    }
    assert not any(event["status"] == "completed" for event in render_events)
    attempt_dir = run_dir / "render-attempts" / attempt_id
    assert attempt_dir.is_dir()
    if os.name == "posix":
        assert stat.S_IMODE(attempt_dir.stat().st_mode) == 0o700


def test_render_bakeoff_records_integrity_boundaries_pair_residuals_and_toolchain(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path)
    pinned_renderers: list[object] = []
    fake_renderer = _fake_renderer()

    def recording_renderer(renderer, plan, inputs, output_directory, *, mode):
        pinned_renderers.append(renderer)
        return fake_renderer(renderer, plan, inputs, output_directory, mode=mode)

    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(render_plan_module, "run_signalsmith", recording_renderer)

    result = cli_module.command_render_bakeoff(
        argparse.Namespace(run=str(run_dir), binary=str(binary))
    )

    assert result["status"] == "completed"
    attempt_id = result["attempt_id"]
    assert re.fullmatch(r"render-[0-9a-f]{32}", attempt_id)
    assert all(render["attempt_id"] == attempt_id for render in result["renders"])
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["metrics"] == {
        "attempt_id": attempt_id,
        "artifact": result["metrics"],
        "gate_b_sha256": artifact_reference(approval_path, run_dir)["sha256"],
    }
    metrics_path = verify_artifact_reference(result["metrics"], run_dir)
    metrics = json.loads(metrics_path.read_text())
    assert metrics["attempt_id"] == attempt_id
    assert metrics["approved_map"]["internal_target_boundary_frames"] == [32]
    assert set(metrics["outputs"]) == {"stem_0", "stem_1"}
    for stem_metrics in metrics["outputs"].values():
        assert stem_metrics["linked"]["integrity"]["frames"] == 64
        points = stem_metrics["linked"]["approved_boundary_discontinuities"]["points"]
        assert [point["boundary_frame"] for point in points] == [32]
        residual = stem_metrics["linked_vs_independent_residual"]
        assert residual["residual_peak_absolute"] == pytest.approx(0.01, abs=1e-6)
        assert residual["all_samples_finite"] is True
    tool = manifest.data["toolchain"]["signalsmith_renderer"]
    assert tool["engine"] == "signalsmith-stretch"
    assert tool["version"] == "1.3.2"
    assert tool["binary"]["executable_path"] == str(binary)
    assert "path" not in tool["binary"]
    assert tool["binary"]["sha256"] == hashlib.sha256(binary.read_bytes()).hexdigest()
    assert len(pinned_renderers) == 2
    assert pinned_renderers[0] is pinned_renderers[1]
    assert pinned_renderers[0].snapshot_path != binary
    assert not pinned_renderers[0].snapshot_path.exists()
    attempt_dir = run_dir / "render-attempts" / attempt_id
    assert attempt_dir.is_dir()
    if os.name == "posix":
        assert stat.S_IMODE(attempt_dir.stat().st_mode) == 0o700
    for render in manifest.data["renders"]:
        for reference in (*render["input_artifacts"].values(), *render["artifacts"]):
            assert reference["path"].startswith(f"render-attempts/{attempt_id}/")
    assert result["metrics"]["path"].startswith(f"render-attempts/{attempt_id}/")
    assert manifest.verify_artifacts(run_dir)
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    metric_events = [event for event in events if event["stage"] == "measuring-render-metrics"]
    assert metric_events[0]["progress"] == {"completed": 0, "total": 10, "unit": "checks"}
    assert metric_events[-1]["status"] == "completed"
    assert metric_events[-1]["progress"] == {
        "completed": 10,
        "total": 10,
        "unit": "checks",
    }
    assert all(event["details"]["attempt_id"] == attempt_id for event in metric_events)

    attempts_before = sorted((run_dir / "render-attempts").iterdir())
    with pytest.raises(CalibrationCLIError, match="already complete"):
        cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))
    assert sorted((run_dir / "render-attempts").iterdir()) == attempts_before

    tampered_manifest = RunManifest.load(run_dir / "run-manifest.json")
    tampered_manifest.data["renders"][0]["attempt_id"] = f"render-{'0' * 32}"
    with pytest.raises(ManifestError, match="one valid attempt_id"):
        tampered_manifest.validate()

    tampered_manifest = RunManifest.load(run_dir / "run-manifest.json")
    tampered_manifest.data["renders"][0]["artifacts"][0] = dict(
        tampered_manifest.data["audio_assets"][0]["canonical_pcm"]
    )
    with pytest.raises(ManifestError, match="escape their bound attempt"):
        tampered_manifest.validate()

    tampered_manifest = RunManifest.load(run_dir / "run-manifest.json")
    tampered_metrics_path = verify_artifact_reference(
        tampered_manifest.data["metrics"]["artifact"], run_dir
    )
    tampered_metrics = json.loads(tampered_metrics_path.read_text())
    tampered_metrics["attempt_id"] = f"render-{'0' * 32}"
    atomic_write_json(tampered_metrics_path, tampered_metrics)
    tampered_manifest.data["metrics"]["artifact"] = artifact_reference(
        tampered_metrics_path, run_dir
    )
    tampered_manifest.write()
    with pytest.raises(ManifestError, match="different attempt_id"):
        tampered_manifest.verify_artifacts(run_dir)


@pytest.mark.parametrize(
    ("scope", "field"),
    (
        ("mode", "integrity"),
        ("mode", "approved_boundary_discontinuities"),
        ("stem", "linked_vs_independent_residual"),
    ),
)
def test_render_metrics_verification_rejects_stripped_objective_evidence(
    tmp_path: Path, monkeypatch, scope: str, field: str
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path, stem_count=1)
    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(render_plan_module, "run_signalsmith", _fake_renderer())
    cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))

    manifest = RunManifest.load(run_dir / "run-manifest.json")
    metrics_path = verify_artifact_reference(manifest.data["metrics"]["artifact"], run_dir)
    payload = json.loads(metrics_path.read_text())
    stem_metrics = payload["outputs"]["stem_0"]
    if scope == "mode":
        stem_metrics["linked"].pop(field)
    else:
        stem_metrics.pop(field)
    atomic_write_json(metrics_path, payload)
    manifest.data["metrics"]["artifact"] = artifact_reference(metrics_path, run_dir)
    manifest.write()

    with pytest.raises(ManifestError, match="missing or unsupported fields"):
        manifest.verify_artifacts(run_dir)


def test_render_metrics_fail_closed_on_wrong_target_frame_count(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path, stem_count=1)
    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(
        render_plan_module,
        "run_signalsmith",
        _fake_renderer(short_independent=True),
    )

    with pytest.raises(CalibrationCLIError, match="expected exactly 64"):
        cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))

    assert not list((run_dir / "render-attempts").glob("*/artifacts/render-metrics.json"))
    manifest = RunManifest.load(run_dir / "run-manifest.json")
    assert manifest.data["metrics"] is None
    events = [json.loads(line) for line in (run_dir / "events.jsonl").read_text().splitlines()]
    assert any(
        event["stage"] == "measuring-render-metrics" and event["status"] == "failed"
        for event in events
    )


def test_failed_render_attempt_is_retained_and_retry_uses_a_new_attempt(
    tmp_path: Path, monkeypatch
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path)
    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(
        render_plan_module,
        "run_signalsmith",
        _fake_renderer(fail_mode="independent"),
    )

    with pytest.raises(RuntimeError, match="synthetic independent render failure"):
        cli_module.command_render_bakeoff(argparse.Namespace(run=str(run_dir), binary=str(binary)))

    attempts_root = run_dir / "render-attempts"
    failed_attempts = sorted(attempts_root.iterdir())
    assert len(failed_attempts) == 1
    failed_attempt = failed_attempts[0]
    failed_files_before = {
        path.relative_to(failed_attempt).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in failed_attempt.rglob("*")
        if path.is_file()
    }
    assert "renders/linked/stem_0.wav" in failed_files_before

    monkeypatch.setattr(render_plan_module, "run_signalsmith", _fake_renderer())
    result = cli_module.command_render_bakeoff(
        argparse.Namespace(run=str(run_dir), binary=str(binary))
    )

    attempts_after = sorted(attempts_root.iterdir())
    assert len(attempts_after) == 2
    assert failed_attempt in attempts_after
    assert result["attempt_id"] != failed_attempt.name
    assert attempts_root / result["attempt_id"] in attempts_after
    assert {
        path.relative_to(failed_attempt).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in failed_attempt.rglob("*")
        if path.is_file()
    } == failed_files_before

    manifest = RunManifest.load(run_dir / "run-manifest.json")
    successful_state = {
        "renders": manifest.data["renders"],
        "metrics": manifest.data["metrics"],
        "renderer": manifest.data["toolchain"]["signalsmith_renderer"],
    }
    assert failed_attempt.name not in json.dumps(successful_state, sort_keys=True)
    assert all(render["attempt_id"] == result["attempt_id"] for render in manifest.data["renders"])
    assert manifest.data["metrics"]["attempt_id"] == result["attempt_id"]
    assert manifest.verify_artifacts(run_dir)


@pytest.mark.parametrize(
    ("stage", "completed", "total", "unit"),
    (
        ("rendering", 64, 256, "stem-frames"),
        ("measuring-render-metrics", 4, 10, "checks"),
    ),
)
def test_render_retry_closes_sigkill_orphan_stage_and_preserves_attempt(
    tmp_path: Path,
    monkeypatch,
    stage: str,
    completed: int,
    total: int,
    unit: str,
) -> None:
    run_dir, approval, approval_path, binary = _render_test_run(tmp_path)
    monkeypatch.setattr(
        cli_module,
        "_gate_b",
        lambda run, manifest: (approval, {}, approval_path),
    )
    monkeypatch.setattr(render_plan_module, "run_signalsmith", _fake_renderer())
    interrupted_id = f"render-{'1' * 32}"
    interrupted_dir = run_dir / "render-attempts" / interrupted_id
    interrupted_dir.mkdir(mode=0o700, parents=True)
    evidence = interrupted_dir / "interrupted-evidence"
    evidence.write_bytes(b"must survive retry")
    evidence_sha256 = hashlib.sha256(evidence.read_bytes()).hexdigest()
    cli_module.append_event(
        run_dir,
        stage,
        "started",
        completed=0,
        total=total,
        unit=unit,
        details={"attempt_id": interrupted_id},
    )
    cli_module.append_event(
        run_dir,
        stage,
        "progress",
        completed=completed,
        total=total,
        unit=unit,
        details={"attempt_id": interrupted_id},
    )

    result = cli_module.command_render_bakeoff(
        argparse.Namespace(run=str(run_dir), binary=str(binary))
    )

    assert result["attempt_id"] != interrupted_id
    assert hashlib.sha256(evidence.read_bytes()).hexdigest() == evidence_sha256
    recovered = [
        event
        for event in _events(run_dir)
        if event["stage"] == stage
        and event["status"] == "failed"
        and event.get("details", {}).get("attempt_id") == interrupted_id
    ]
    assert len(recovered) == 1
    assert recovered[0]["progress"] == {
        "completed": completed,
        "total": total,
        "unit": unit,
    }
    assert recovered[0]["details"]["recovered_on_retry"] is True
