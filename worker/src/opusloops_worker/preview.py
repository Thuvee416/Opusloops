"""Create mobile-safe AAC four-bar segments from approved aligned stems."""

from __future__ import annotations

import json
import math
import os
import statistics
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .errors import HarnessError, IntegrityError
from .storage import sha256_file

SAMPLE_RATE = 48_000
MAX_SEGMENTS_PER_STEM = 512
AAC_BITRATE = "96k"


@dataclass(frozen=True, slots=True)
class PreviewSegment:
    path: Path
    stem_id: str
    index: int
    start_frame: int
    end_frame: int
    bars: int
    target_bpm: float
    codec: str = "aac-lc"


def create_mobile_click_audition(
    *,
    source: Path,
    destination: Path,
    ffmpeg: Path,
    timeout_seconds: float = 600,
) -> Path:
    """Encode the full Gate-B reference+click mix without exposing its float WAV."""

    if not source.is_file() or source.is_symlink() or source.stat().st_size <= 0:
        raise IntegrityError("click audition source is not a regular non-empty file")
    if destination.exists() or destination.is_symlink():
        raise IntegrityError("mobile click audition destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    command = [
        str(ffmpeg),
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-ar",
        str(SAMPLE_RATE),
        "-c:a",
        "aac",
        "-b:a",
        AAC_BITRATE,
        "-movflags",
        "+faststart",
        "-n",
        str(destination),
    ]
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/local/bin:/usr/bin:/bin"},
            check=False,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HarnessError("mobile click encoder could not complete") from exc
    if result.returncode != 0 or not destination.is_file() or destination.stat().st_size <= 0:
        destination.unlink(missing_ok=True)
        raise HarnessError("mobile click encoder rejected the Gate-B audition")
    if os.name == "posix":
        os.chmod(destination, 0o600)
    return destination


def _load_json(path: Path, max_bytes: int = 16 * 1024 * 1024) -> Mapping[str, object]:
    try:
        raw = path.read_bytes()
        if len(raw) > max_bytes:
            raise IntegrityError("preview metadata is too large")
        payload = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IntegrityError("preview metadata is not valid JSON") from exc
    if not isinstance(payload, Mapping):
        raise IntegrityError("preview metadata must be an object")
    return payload


def _safe_bound_artifact(run_dir: Path, reference: object) -> Path:
    if not isinstance(reference, Mapping):
        raise IntegrityError("render artifact reference is invalid")
    relative = reference.get("path")
    expected_hash = reference.get("sha256")
    expected_bytes = reference.get("bytes")
    if not isinstance(relative, str) or not isinstance(expected_hash, str):
        raise IntegrityError("render artifact binding is incomplete")
    try:
        path = (run_dir / relative).resolve(strict=True)
        path.relative_to(run_dir.resolve())
    except (OSError, ValueError) as exc:
        raise IntegrityError("render artifact escaped the run") from exc
    actual_hash, actual_bytes = sha256_file(path)
    if actual_hash != expected_hash or actual_bytes != expected_bytes:
        raise IntegrityError("render artifact does not match its manifest binding")
    return path


def _target_timing(manifest: Mapping[str, object], run_dir: Path) -> tuple[float, float, int, int]:
    tempo_map = manifest.get("tempo_map")
    if not isinstance(tempo_map, Mapping) or not isinstance(tempo_map.get("decision"), Mapping):
        raise IntegrityError("approved tempo decision is missing")
    decision = tempo_map["decision"]
    meter = decision.get("meter")
    if not isinstance(meter, Mapping):
        raise IntegrityError("approved meter is missing")
    numerator = meter.get("numerator")
    denominator = meter.get("denominator")
    if type(numerator) is not int or denominator not in {1, 2, 4, 8, 16, 32}:
        raise IntegrityError("approved meter is invalid")
    target_frames = decision.get("total_target_frames")
    if type(target_frames) is not int or target_frames <= 0:
        raise IntegrityError("approved target frame count is invalid")
    bpm_value = decision.get("target_bpm")
    if isinstance(bpm_value, int | float) and not isinstance(bpm_value, bool):
        bpm = float(bpm_value)
    else:
        analysis_record = manifest.get("analysis")
        if not isinstance(analysis_record, Mapping):
            raise IntegrityError("analysis binding is missing for no-conform preview timing")
        analysis_path = _safe_bound_artifact(run_dir, analysis_record.get("artifact"))
        analysis = _load_json(analysis_path)
        primary = analysis.get("primary")
        beats = primary.get("beats_seconds") if isinstance(primary, Mapping) else None
        if not isinstance(beats, list) or len(beats) < 2:
            raise IntegrityError("analysis has too few beats for preview timing")
        differences = [
            float(right) - float(left) for left, right in zip(beats, beats[1:], strict=False)
        ]
        positive = [
            difference for difference in differences if math.isfinite(difference) and difference > 0
        ]
        if not positive:
            raise IntegrityError("analysis beat intervals are invalid")
        bpm = 60.0 / statistics.median(positive)
    if not math.isfinite(bpm) or not 20 <= bpm <= 400:
        raise IntegrityError("preview tempo is outside the supported range")
    quarter_notes_per_bar = float(numerator) * (4.0 / float(denominator))
    four_bar_seconds = 4.0 * quarter_notes_per_bar * 60.0 / bpm
    segment_frames = max(1, round(four_bar_seconds * SAMPLE_RATE))
    return bpm, four_bar_seconds, segment_frames, target_frames


def _aligned_stems(manifest: Mapping[str, object], run_dir: Path) -> list[tuple[str, Path]]:
    renders = manifest.get("renders")
    if isinstance(renders, list):
        linked = next(
            (
                item
                for item in renders
                if isinstance(item, Mapping) and item.get("mode") == "linked"
            ),
            None,
        )
        if isinstance(linked, Mapping) and isinstance(linked.get("artifacts"), list):
            result: list[tuple[str, Path]] = []
            for reference in linked["artifacts"]:
                path = _safe_bound_artifact(run_dir, reference)
                result.append((path.stem, path))
            if result:
                return result

    # no-conform keeps the exact canonical stems as the approved aligned timeline.
    assets = manifest.get("audio_assets")
    if not isinstance(assets, list):
        raise IntegrityError("manifest has no aligned or canonical stems")
    result = []
    for asset in assets:
        if not isinstance(asset, Mapping) or not isinstance(asset.get("canonical_pcm"), Mapping):
            raise IntegrityError("canonical stem binding is invalid")
        asset_id = asset.get("asset_id")
        if not isinstance(asset_id, str):
            raise IntegrityError("canonical stem ID is invalid")
        result.append((asset_id, _safe_bound_artifact(run_dir, asset["canonical_pcm"])))
    return result


def create_four_bar_previews(
    *,
    run_dir: Path,
    ffmpeg: Path,
    timeout_seconds: float = 600,
) -> tuple[PreviewSegment, ...]:
    manifest = _load_json(run_dir / "run-manifest.json")
    bpm, segment_seconds, segment_frames, target_frames = _target_timing(manifest, run_dir)
    stems = _aligned_stems(manifest, run_dir)
    output_root = run_dir / "mobile-previews"
    output_root.mkdir(mode=0o700)
    segments: list[PreviewSegment] = []
    expected_segments = math.ceil(target_frames / segment_frames)
    if expected_segments > MAX_SEGMENTS_PER_STEM:
        raise HarnessError("approved map creates too many four-bar preview segments")
    for stem_id, source in stems:
        stem_dir = output_root / stem_id
        stem_dir.mkdir(mode=0o700)
        pattern = stem_dir / "segment-%04d.m4a"
        command = [
            str(ffmpeg),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "aac",
            "-b:a",
            AAC_BITRATE,
            "-f",
            "segment",
            "-segment_format",
            "mp4",
            "-segment_time",
            f"{segment_seconds:.9f}",
            "-segment_format_options",
            "movflags=+faststart",
            "-reset_timestamps",
            "1",
            str(pattern),
        ]
        try:
            result = subprocess.run(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/local/bin:/usr/bin:/bin"},
                check=False,
                timeout=timeout_seconds,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HarnessError("mobile preview encoder could not complete") from exc
        if result.returncode != 0:
            raise HarnessError("mobile preview encoder rejected an aligned stem")
        generated = sorted(stem_dir.glob("segment-*.m4a"))
        if len(generated) < expected_segments:
            raise HarnessError("mobile preview segment count differs from the approved timeline")
        # AAC priming can make the segment muxer observe one packet beyond an
        # exact timeline boundary. The bound PCM frame count is authoritative;
        # discard only encoder-padding segments outside that approved range.
        for padding_segment in generated[expected_segments:]:
            padding_segment.unlink()
        generated = generated[:expected_segments]
        for index, path in enumerate(generated):
            if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
                raise IntegrityError("mobile preview segment is not a regular non-empty file")
            if os.name == "posix":
                os.chmod(path, 0o600)
            start = index * segment_frames
            end = min(target_frames, start + segment_frames)
            segments.append(
                PreviewSegment(
                    path=path,
                    stem_id=stem_id,
                    index=index,
                    start_frame=start,
                    end_frame=end,
                    bars=4,
                    target_bpm=bpm,
                )
            )
    return tuple(segments)
