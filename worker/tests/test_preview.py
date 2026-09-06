from __future__ import annotations

import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest

from opusloops_worker.preview import (
    _target_timing,
    create_four_bar_previews,
    create_mobile_click_audition,
)
from opusloops_worker.storage import sha256_file


def test_preview_commands_restrict_ffmpeg_to_local_files(monkeypatch, tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"audio")
    destination = tmp_path / "preview.m4a"
    captured: list[str] = []

    def run(command, **_kwargs):
        captured.extend(command)
        destination.write_bytes(b"preview")
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", run)

    create_mobile_click_audition(
        source=source,
        destination=destination,
        ffmpeg=Path("/usr/bin/ffmpeg"),
    )

    input_index = captured.index("-i")
    assert captured[input_index - 2 : input_index] == ["-protocol_whitelist", "file"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is unavailable")
def test_creates_exact_four_bar_aac_segments(tmp_path: Path) -> None:
    run = tmp_path / "run"
    canonical = run / "canonical"
    canonical.mkdir(parents=True)
    source = canonical / "stem.wav"
    frames = 16 * 48_000
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(48_000)
        output.writeframes(b"\0\0" * frames)
    digest, byte_count = sha256_file(source)
    manifest = {
        "tempo_map": {
            "decision": {
                "meter": {"numerator": 4, "denominator": 4},
                "target_bpm": 120,
                "total_target_frames": frames,
            }
        },
        "renders": [],
        "audio_assets": [
            {
                "asset_id": "stem",
                "canonical_pcm": {
                    "path": "canonical/stem.wav",
                    "sha256": digest,
                    "bytes": byte_count,
                },
            }
        ],
    }
    (run / "run-manifest.json").write_text(json.dumps(manifest))
    segments = create_four_bar_previews(
        run_dir=run,
        ffmpeg=Path(shutil.which("ffmpeg") or "ffmpeg"),
    )
    assert len(segments) == 2
    assert [(item.start_frame, item.end_frame) for item in segments] == [
        (0, 8 * 48_000),
        (8 * 48_000, 16 * 48_000),
    ]
    assert all(item.path.stat().st_size > 0 for item in segments)


def test_no_conform_preview_uses_analysis_beats_seconds(tmp_path: Path) -> None:
    run = tmp_path / "run"
    analysis_path = run / "analysis.json"
    analysis_path.parent.mkdir(parents=True)
    analysis_path.write_text(json.dumps({"primary": {"beats_seconds": [0.0, 0.5, 1.0]}}))
    digest, byte_count = sha256_file(analysis_path)
    manifest = {
        "tempo_map": {
            "decision": {
                "meter": {"numerator": 4, "denominator": 4},
                "target_bpm": None,
                "total_target_frames": 16 * 48_000,
            }
        },
        "analysis": {
            "artifact": {
                "path": "analysis.json",
                "sha256": digest,
                "bytes": byte_count,
            }
        },
    }

    bpm, segment_seconds, segment_frames, target_frames = _target_timing(manifest, run)

    assert bpm == 120
    assert segment_seconds == 8
    assert segment_frames == 8 * 48_000
    assert target_frames == 16 * 48_000


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="FFmpeg is unavailable")
def test_mobile_click_audition_is_compact_aac(tmp_path: Path) -> None:
    source = tmp_path / "raw-grid-click-audition.wav"
    with wave.open(str(source), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(48_000)
        output.writeframes(b"\0\0\0\0" * 48_000)
    destination = tmp_path / "mobile-click-audition.m4a"

    result = create_mobile_click_audition(
        source=source,
        destination=destination,
        ffmpeg=Path(shutil.which("ffmpeg") or "ffmpeg"),
    )

    assert result == destination
    assert 0 < destination.stat().st_size < source.stat().st_size
