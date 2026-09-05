"""Atomic provenance manifests, artifact hashes, events, and approval binding."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import platform
import re
import stat
import subprocess
import tempfile
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from importlib.resources import files
from pathlib import Path, PurePosixPath
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import SchemaError
from referencing import Registry, Resource

from .policy import DEFAULT_POLICY, IngestPolicy

MANIFEST_SCHEMA_VERSION = "opusloops.run-manifest.v1"
ANALYSIS_SELECTION_SCHEMA_VERSION = "opusloops.analysis-selection.v1"
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
_RENDER_ATTEMPT_PATTERN = re.compile(r"^render-[0-9a-f]{32}$")
_ANALYSIS_ROLES = {
    "full-mix",
    "drums",
    "bass",
    "vocals",
    "guitar",
    "keys",
    "synth",
    "percussion",
    "fx",
    "other",
}
_MANIFEST_SCHEMA_RESOURCE = "schemas/run-manifest.v1.schema.json"
_TEMPO_APPROVAL_SCHEMA_RESOURCE = "schemas/tempo-approval.v1.schema.json"


class ManifestError(RuntimeError):
    """A provenance artifact is invalid, stale, or fails verification."""


def _packaged_schema(resource_name: str, *, label: str) -> dict[str, Any]:
    try:
        resource = files("opusloops_stem_calibration").joinpath(resource_name)
        payload = json.loads(resource.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot load packaged {label} schema: {error}") from error
    if not isinstance(payload, dict):
        raise ManifestError(f"packaged {label} schema root must be an object")
    try:
        Draft202012Validator.check_schema(payload)
    except SchemaError as error:
        raise ManifestError(f"packaged {label} schema is invalid: {error.message}") from error
    return payload


@lru_cache(maxsize=1)
def run_manifest_schema() -> dict[str, Any]:
    """Load the packaged Draft 2020-12 schema used by every manifest boundary."""

    return _packaged_schema(_MANIFEST_SCHEMA_RESOURCE, label="run-manifest")


@lru_cache(maxsize=1)
def tempo_approval_schema() -> dict[str, Any]:
    """Load the one canonical Gate-B approval contract shipped with the package."""

    return _packaged_schema(_TEMPO_APPROVAL_SCHEMA_RESOURCE, label="tempo-approval")


@lru_cache(maxsize=1)
def _schema_registry() -> Registry:
    schema = tempo_approval_schema()
    schema_id = schema.get("$id")
    if not isinstance(schema_id, str) or not schema_id:
        raise ManifestError("packaged tempo-approval schema has no $id")
    return Registry().with_resource(schema_id, Resource.from_contents(schema))


@lru_cache(maxsize=1)
def _run_manifest_validator() -> Draft202012Validator:
    return Draft202012Validator(
        run_manifest_schema(),
        registry=_schema_registry(),
        format_checker=FormatChecker(),
    )


@lru_cache(maxsize=1)
def _tempo_approval_validator() -> Draft202012Validator:
    return Draft202012Validator(
        tempo_approval_schema(),
        registry=_schema_registry(),
        format_checker=FormatChecker(),
    )


def _validate_schema(
    value: Mapping[str, Any],
    *,
    validator: Draft202012Validator,
    label: str,
) -> None:
    errors = sorted(
        validator.iter_errors(value),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    if not errors:
        return
    error = errors[0]
    location = ".".join(str(part) for part in error.absolute_path) or "<root>"
    raise ManifestError(f"{label} schema validation failed at {location}: {error.message}")


def _validate_run_manifest_schema(value: Mapping[str, Any]) -> None:
    _validate_schema(
        value,
        validator=_run_manifest_validator(),
        label="run manifest",
    )
    _validate_render_publication_bindings(value)


def _artifact_path(reference: object, *, label: str) -> str:
    if not isinstance(reference, Mapping) or not isinstance(reference.get("path"), str):
        raise ManifestError(f"{label} has no artifact path")
    return str(reference["path"])


def _validate_render_publication_bindings(value: Mapping[str, Any]) -> None:
    """Require one complete render attempt or no published render state."""

    renders = value.get("renders")
    metrics = value.get("metrics")
    toolchain = value.get("toolchain")
    renderer = toolchain.get("signalsmith_renderer") if isinstance(toolchain, Mapping) else None
    if not renders:
        if metrics is not None or renderer is not None:
            raise ManifestError("render publication state is incomplete")
        return
    if not isinstance(renders, list) or len(renders) != 2:
        raise ManifestError("render publication must contain both comparison modes")
    if not isinstance(metrics, Mapping) or not isinstance(renderer, Mapping):
        raise ManifestError("render publication must include metrics and renderer provenance")

    attempt_ids = [render.get("attempt_id") for render in renders]
    attempt_ids.append(metrics.get("attempt_id"))
    if (
        not all(isinstance(attempt_id, str) for attempt_id in attempt_ids)
        or len(set(attempt_ids)) != 1
        or _RENDER_ATTEMPT_PATTERN.fullmatch(str(attempt_ids[0])) is None
    ):
        raise ManifestError("render publication does not bind one valid attempt_id")
    attempt_id = str(attempt_ids[0])
    prefix = f"render-attempts/{attempt_id}/"

    expected_inputs = {
        "binding": f"{prefix}inputs/renderer-inputs.json",
        "stems_tsv": f"{prefix}inputs/stems.tsv",
        "map_tsv": f"{prefix}inputs/map.tsv",
    }
    shared_keys = (
        "engine",
        "version",
        "source_frames",
        "target_frames",
        "stem_count",
        "plan_sha256",
        "stems_tsv_sha256",
        "map_tsv_sha256",
        "stem_sha256s",
        "verified_inputs",
        "input_artifacts",
    )
    baseline = renders[0]
    for result in renders:
        if not isinstance(result, Mapping):  # schema validation normally catches this first
            raise ManifestError("render publication contains an invalid result")
        mode = result.get("mode")
        inputs = result.get("input_artifacts")
        if not isinstance(mode, str) or not isinstance(inputs, Mapping):
            raise ManifestError("render publication has incomplete mode inputs")
        for key, expected_path in expected_inputs.items():
            if _artifact_path(inputs.get(key), label=f"render {key}") != expected_path:
                raise ManifestError("render input artifacts escape their bound attempt")
        stem_hashes = result.get("stem_sha256s")
        artifacts = result.get("artifacts")
        if not isinstance(stem_hashes, Mapping) or not isinstance(artifacts, list):
            raise ManifestError("render publication has incomplete stem artifacts")
        if result.get("stem_count") != len(stem_hashes) or len(artifacts) != len(stem_hashes):
            raise ManifestError("render publication stem counts do not match")
        expected_outputs = {f"{prefix}renders/{mode}/{asset_id}.wav" for asset_id in stem_hashes}
        actual_outputs = {
            _artifact_path(reference, label="render output") for reference in artifacts
        }
        if actual_outputs != expected_outputs:
            raise ManifestError("render output artifacts escape their bound attempt or stem set")
        verified_inputs = result["verified_inputs"]
        native_consumed = verified_inputs["native_consumed"]
        for key in ("plan_sha256", "stems_tsv_sha256", "map_tsv_sha256", "stem_sha256s"):
            result_value = result.get(key)
            if result_value != verified_inputs.get(key) or result_value != native_consumed.get(key):
                raise ManifestError("render result hash bindings are internally inconsistent")
        if any(
            inputs[key]["sha256"] != verified_inputs[verified_key]
            for key, verified_key in (
                ("binding", "binding_sha256"),
                ("stems_tsv", "stems_tsv_sha256"),
                ("map_tsv", "map_tsv_sha256"),
            )
        ):
            raise ManifestError("render input artifact hashes differ from their verified bindings")
        if any(result.get(key) != baseline.get(key) for key in shared_keys):
            raise ManifestError("render comparison modes do not share one bound render plan")

    if any(
        result.get("engine") != renderer.get("engine")
        or result.get("version") != renderer.get("version")
        for result in renders
    ):
        raise ManifestError("render results do not match renderer provenance")
    source_hashes = {
        asset["asset_id"]: asset["canonical_pcm"]["sha256"] for asset in value["audio_assets"]
    }
    if baseline.get("stem_sha256s") != source_hashes:
        raise ManifestError("render publication does not bind the canonical source stems")
    approval_sha256 = baseline["verified_inputs"]["approval_sha256"]
    if metrics.get("gate_b_sha256") != approval_sha256:
        raise ManifestError("render publication does not bind its Gate-B approval")
    tempo_map = value.get("tempo_map")
    if (
        not isinstance(tempo_map, Mapping)
        or tempo_map["approval"]["sha256"] != approval_sha256
        or tempo_map["decision"]["total_source_frames"] != baseline.get("source_frames")
        or tempo_map["decision"]["total_target_frames"] != baseline.get("target_frames")
    ):
        raise ManifestError("render publication differs from its approved tempo-map decision")
    if (
        _artifact_path(metrics.get("artifact"), label="render metrics")
        != f"{prefix}artifacts/render-metrics.json"
    ):
        raise ManifestError("render metrics escape their bound attempt")


def validate_tempo_approval_schema(value: Mapping[str, Any]) -> None:
    """Validate Gate B against the same contract referenced by the run manifest."""

    _validate_schema(
        value,
        validator=_tempo_approval_validator(),
        label="tempo approval",
    )


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize deterministic UTF-8 JSON used for content hashes."""

    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ManifestError(f"value is not canonical JSON: {error}") from error


def json_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def sha256_file(path: str | os.PathLike[str], *, chunk_bytes: int = 1024 * 1024) -> tuple[str, int]:
    candidate = Path(path)
    try:
        path_stat = candidate.stat(follow_symlinks=False)
    except OSError as error:
        raise ManifestError(f"cannot stat artifact {candidate}: {error}") from error
    if not stat.S_ISREG(path_stat.st_mode):
        raise ManifestError(f"artifact must be a regular file, not a symlink: {candidate}")
    digest = hashlib.sha256()
    total = 0
    with candidate.open("rb") as source:
        while chunk := source.read(chunk_bytes):
            digest.update(chunk)
            total += len(chunk)
    final_stat = candidate.stat(follow_symlinks=False)
    if total != path_stat.st_size or (
        final_stat.st_size,
        final_stat.st_mtime_ns,
        final_stat.st_ino,
    ) != (path_stat.st_size, path_stat.st_mtime_ns, path_stat.st_ino):
        raise ManifestError(f"artifact changed while hashing: {candidate}")
    return digest.hexdigest(), total


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write_bytes(path: str | os.PathLike[str], payload: bytes, *, mode: int = 0o600) -> None:
    """Durably replace a file with a complete byte payload."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.tmp-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        _fsync_directory(target.parent)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
        raise


def atomic_create_bytes(path: str | os.PathLike[str], payload: bytes, *, mode: int = 0o600) -> None:
    """Durably publish a complete file while refusing every form of replacement."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.tmp-", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.link(temporary, target, follow_symlinks=False)
        except FileExistsError as error:
            raise ManifestError(
                f"artifact already exists; refusing to overwrite it: {target}"
            ) from error
        _fsync_directory(target.parent)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        raise
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(path: str | os.PathLike[str], value: Any, *, mode: int = 0o600) -> None:
    """Write stable pretty JSON atomically; hashes should use the resulting file."""

    canonical_json_bytes(value)  # fail on NaN/non-JSON before creating a temp file
    rendered = (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    atomic_write_bytes(path, rendered, mode=mode)


def atomic_create_json(path: str | os.PathLike[str], value: Any, *, mode: int = 0o600) -> None:
    """Publish stable pretty JSON once without an overwrite race."""

    canonical_json_bytes(value)
    rendered = (
        json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    atomic_create_bytes(path, rendered, mode=mode)


def load_json(path: str | os.PathLike[str]) -> Any:
    try:
        with Path(path).open("r", encoding="utf-8") as source:
            return json.load(source)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManifestError(f"cannot load JSON {path}: {error}") from error


def _safe_relative_path(value: str) -> PurePosixPath:
    if not value or "\\" in value or any(ord(character) < 32 for character in value):
        raise ManifestError("artifact path is empty or contains unsafe characters")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ManifestError(f"artifact path must be a normalized run-relative path: {value!r}")
    return path


def artifact_reference(
    artifact_path: str | os.PathLike[str], run_dir: str | os.PathLike[str]
) -> dict[str, Any]:
    root = Path(run_dir).resolve()
    candidate = Path(artifact_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=True)
        relative = resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise ManifestError("artifact must resolve inside the run directory") from error
    digest, byte_length = sha256_file(resolved)
    relative_posix = relative.as_posix()
    _safe_relative_path(relative_posix)
    return {"path": relative_posix, "bytes": byte_length, "sha256": digest}


def verify_artifact_reference(
    reference: Mapping[str, Any], run_dir: str | os.PathLike[str]
) -> Path:
    if set(reference) != {"path", "bytes", "sha256"}:
        raise ManifestError("artifact reference must contain exactly path, bytes, and sha256")
    relative = _safe_relative_path(str(reference["path"]))
    expected_bytes = reference["bytes"]
    expected_sha256 = reference["sha256"]
    if (
        not isinstance(expected_bytes, int)
        or isinstance(expected_bytes, bool)
        or expected_bytes < 0
    ):
        raise ManifestError("artifact byte length must be a non-negative integer")
    if not isinstance(expected_sha256, str) or not _SHA256_PATTERN.fullmatch(expected_sha256):
        raise ManifestError("artifact SHA-256 must be 64 lowercase hexadecimal characters")
    root = Path(run_dir).resolve()
    candidate = root.joinpath(*relative.parts)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError) as error:
        raise ManifestError("artifact reference escapes or is missing from the run") from error
    actual_sha256, actual_bytes = sha256_file(resolved)
    if actual_bytes != expected_bytes or not hmac.compare_digest(actual_sha256, expected_sha256):
        raise ManifestError(f"artifact hash/length mismatch: {relative.as_posix()}")
    return resolved


def _metric_record(
    value: object,
    *,
    fields: set[str],
    label: str,
) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != fields:
        raise ManifestError(f"{label} has missing or unsupported fields")
    return value


def _metric_integer(
    value: object,
    *,
    label: str,
    expected: int | None = None,
    minimum: int = 0,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManifestError(f"{label} must be an integer in its valid domain")
    if maximum is not None and value > maximum:
        raise ManifestError(f"{label} must be an integer in its valid domain")
    if expected is not None and value != expected:
        raise ManifestError(f"{label} differs from its bound render shape")
    return value


def _metric_number(
    value: object,
    *,
    label: str,
    minimum: float | None = None,
    maximum: float | None = None,
    nullable: bool = False,
) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ManifestError(f"{label} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise ManifestError(f"{label} must be a finite number")
    if minimum is not None and number < minimum:
        raise ManifestError(f"{label} is outside its valid domain")
    if maximum is not None and number > maximum:
        raise ManifestError(f"{label} is outside its valid domain")
    return number


def _verify_wav_integrity_metrics(
    value: object,
    *,
    expected_path: str,
    sample_rate: int,
    channels: int,
    frames: int,
    label: str,
) -> None:
    record = _metric_record(
        value,
        fields={
            "path",
            "sample_rate",
            "channels",
            "frames",
            "sample_count",
            "finite_sample_count",
            "non_finite_sample_count",
            "all_samples_finite",
            "clipped_sample_count",
            "clipping_fraction",
            "clip_threshold",
            "peak_absolute",
            "rms",
            "stereo",
        },
        label=label,
    )
    if record["path"] != expected_path:
        raise ManifestError(f"{label} path differs from its rendered output")
    _metric_integer(record["sample_rate"], label=f"{label} sample_rate", expected=sample_rate)
    _metric_integer(record["channels"], label=f"{label} channels", expected=channels)
    _metric_integer(record["frames"], label=f"{label} frames", expected=frames)
    sample_count = frames * channels
    _metric_integer(record["sample_count"], label=f"{label} sample_count", expected=sample_count)
    _metric_integer(
        record["finite_sample_count"],
        label=f"{label} finite_sample_count",
        expected=sample_count,
    )
    _metric_integer(
        record["non_finite_sample_count"],
        label=f"{label} non_finite_sample_count",
        expected=0,
    )
    if record["all_samples_finite"] is not True:
        raise ManifestError(f"{label} must attest that all rendered samples are finite")
    clipped = _metric_integer(
        record["clipped_sample_count"],
        label=f"{label} clipped_sample_count",
        maximum=sample_count,
    )
    fraction = _metric_number(
        record["clipping_fraction"],
        label=f"{label} clipping_fraction",
        minimum=0.0,
        maximum=1.0,
    )
    assert fraction is not None
    if not math.isclose(fraction, clipped / sample_count, rel_tol=1e-12, abs_tol=1e-15):
        raise ManifestError(f"{label} clipping counts are internally inconsistent")
    threshold = _metric_number(
        record["clip_threshold"],
        label=f"{label} clip_threshold",
        minimum=0.0,
        maximum=1.0,
    )
    if threshold != 0.999:
        raise ManifestError(f"{label} uses an unexpected clipping threshold")
    peak = _metric_number(record["peak_absolute"], label=f"{label} peak_absolute", minimum=0.0)
    rms = _metric_number(record["rms"], label=f"{label} rms", minimum=0.0)
    assert peak is not None and rms is not None
    if rms > peak + 1e-12:
        raise ManifestError(f"{label} level metrics are internally inconsistent")

    stereo = record["stereo"]
    if channels != 2:
        if stereo is not None:
            raise ManifestError(f"{label} contains stereo metrics for a non-stereo output")
        return
    stereo_record = _metric_record(
        stereo,
        fields={"paired_finite_samples", "phase_correlation", "coherence"},
        label=f"{label} stereo metrics",
    )
    _metric_integer(
        stereo_record["paired_finite_samples"],
        label=f"{label} paired_finite_samples",
        expected=frames,
    )
    _metric_number(
        stereo_record["phase_correlation"],
        label=f"{label} phase_correlation",
        minimum=-1.0,
        maximum=1.0,
        nullable=True,
    )
    _metric_number(
        stereo_record["coherence"],
        label=f"{label} coherence",
        minimum=0.0,
        maximum=1.0,
        nullable=True,
    )


def _verify_boundary_metrics(
    value: object,
    *,
    expected_path: str,
    sample_rate: int,
    channels: int,
    frames: int,
    boundary_frames: list[int],
    label: str,
) -> None:
    record = _metric_record(
        value,
        fields={
            "path",
            "sample_rate",
            "channels",
            "frames",
            "context_frames",
            "points",
            "max_absolute_step",
            "max_step_to_local_rms",
        },
        label=label,
    )
    if record["path"] != expected_path:
        raise ManifestError(f"{label} path differs from its rendered output")
    _metric_integer(record["sample_rate"], label=f"{label} sample_rate", expected=sample_rate)
    _metric_integer(record["channels"], label=f"{label} channels", expected=channels)
    _metric_integer(record["frames"], label=f"{label} frames", expected=frames)
    _metric_integer(record["context_frames"], label=f"{label} context_frames", expected=2_048)
    points = record["points"]
    if not isinstance(points, list) or len(points) != len(boundary_frames):
        raise ManifestError(f"{label} does not cover every approved internal boundary")
    absolute_steps: list[float] = []
    normalized_steps: list[float] = []
    for point, boundary_frame in zip(points, boundary_frames, strict=True):
        point_record = _metric_record(
            point,
            fields={
                "boundary_frame",
                "finite_channels",
                "non_finite_channels",
                "max_absolute_step",
                "rms_step",
                "local_derivative_rms",
                "step_to_local_rms",
            },
            label=f"{label} boundary point",
        )
        _metric_integer(
            point_record["boundary_frame"],
            label=f"{label} boundary_frame",
            expected=boundary_frame,
        )
        _metric_integer(
            point_record["finite_channels"],
            label=f"{label} finite_channels",
            expected=channels,
        )
        _metric_integer(
            point_record["non_finite_channels"],
            label=f"{label} non_finite_channels",
            expected=0,
        )
        absolute_step = _metric_number(
            point_record["max_absolute_step"],
            label=f"{label} max_absolute_step",
            minimum=0.0,
        )
        _metric_number(point_record["rms_step"], label=f"{label} rms_step", minimum=0.0)
        _metric_number(
            point_record["local_derivative_rms"],
            label=f"{label} local_derivative_rms",
            minimum=0.0,
            nullable=True,
        )
        normalized_step = _metric_number(
            point_record["step_to_local_rms"],
            label=f"{label} step_to_local_rms",
            minimum=0.0,
        )
        assert absolute_step is not None and normalized_step is not None
        absolute_steps.append(absolute_step)
        normalized_steps.append(normalized_step)

    aggregate_absolute = _metric_number(
        record["max_absolute_step"],
        label=f"{label} aggregate max_absolute_step",
        minimum=0.0,
        nullable=True,
    )
    aggregate_normalized = _metric_number(
        record["max_step_to_local_rms"],
        label=f"{label} aggregate max_step_to_local_rms",
        minimum=0.0,
        nullable=True,
    )
    if absolute_steps:
        if aggregate_absolute != max(absolute_steps) or aggregate_normalized != max(
            normalized_steps
        ):
            raise ManifestError(f"{label} aggregate values are internally inconsistent")
    elif aggregate_absolute is not None or aggregate_normalized is not None:
        raise ManifestError(f"{label} has aggregate values without boundary points")


def _verify_pair_residual_metrics(
    value: object,
    *,
    linked_path: str,
    independent_path: str,
    sample_rate: int,
    channels: int,
    frames: int,
    label: str,
) -> None:
    record = _metric_record(
        value,
        fields={
            "reference_path",
            "component_paths",
            "gains",
            "sample_rate",
            "channels",
            "frames",
            "compared_sample_count",
            "finite_sample_count",
            "non_finite_sample_count",
            "all_samples_finite",
            "exact_match",
            "residual_peak_absolute",
            "residual_rms",
            "reference_rms",
            "normalized_residual_rms",
            "snr_db",
            "reference_to_mix_correlation",
        },
        label=label,
    )
    if record["reference_path"] != linked_path or record["component_paths"] != [independent_path]:
        raise ManifestError(f"{label} paths differ from the compared render outputs")
    gains = record["gains"]
    if (
        not isinstance(gains, list)
        or len(gains) != 1
        or _metric_number(gains[0], label=f"{label} gain") != 1.0
    ):
        raise ManifestError(f"{label} must compare the independent output at unity gain")
    _metric_integer(record["sample_rate"], label=f"{label} sample_rate", expected=sample_rate)
    _metric_integer(record["channels"], label=f"{label} channels", expected=channels)
    _metric_integer(record["frames"], label=f"{label} frames", expected=frames)
    sample_count = frames * channels
    for field in ("compared_sample_count", "finite_sample_count"):
        _metric_integer(record[field], label=f"{label} {field}", expected=sample_count)
    _metric_integer(
        record["non_finite_sample_count"],
        label=f"{label} non_finite_sample_count",
        expected=0,
    )
    if record["all_samples_finite"] is not True or not isinstance(record["exact_match"], bool):
        raise ManifestError(f"{label} has invalid finite-sample attestations")
    peak = _metric_number(
        record["residual_peak_absolute"],
        label=f"{label} residual_peak_absolute",
        minimum=0.0,
    )
    residual_rms = _metric_number(
        record["residual_rms"], label=f"{label} residual_rms", minimum=0.0
    )
    reference_rms = _metric_number(
        record["reference_rms"], label=f"{label} reference_rms", minimum=0.0
    )
    assert peak is not None and residual_rms is not None and reference_rms is not None
    if residual_rms > peak + 1e-12 or record["exact_match"] is not (peak == 0.0):
        raise ManifestError(f"{label} residual values are internally inconsistent")
    normalized = _metric_number(
        record["normalized_residual_rms"],
        label=f"{label} normalized_residual_rms",
        minimum=0.0,
        nullable=True,
    )
    if reference_rms > 0.0:
        expected_normalized = residual_rms / reference_rms
        if normalized is None or not math.isclose(
            normalized, expected_normalized, rel_tol=1e-12, abs_tol=1e-15
        ):
            raise ManifestError(f"{label} normalized residual is internally inconsistent")
    elif normalized is not None:
        raise ManifestError(f"{label} normalized residual has no nonzero reference")
    snr = _metric_number(record["snr_db"], label=f"{label} snr_db", nullable=True)
    if reference_rms > 0.0 and residual_rms > 0.0:
        expected_snr = 20.0 * math.log10(reference_rms / residual_rms)
        if snr is None or not math.isclose(snr, expected_snr, rel_tol=1e-12, abs_tol=1e-12):
            raise ManifestError(f"{label} SNR is internally inconsistent")
    elif snr is not None:
        raise ManifestError(f"{label} SNR is defined for a zero-energy signal")
    _metric_number(
        record["reference_to_mix_correlation"],
        label=f"{label} reference_to_mix_correlation",
        minimum=-1.0,
        maximum=1.0,
        nullable=True,
    )


def _verify_render_metrics_binding(value: Mapping[str, Any], run_dir: Path) -> None:
    """Verify the metrics artifact belongs to the one published render attempt."""

    renders = value.get("renders")
    if not renders:
        return
    metrics_record = value["metrics"]
    assert isinstance(metrics_record, Mapping)
    attempt_id = renders[0]["attempt_id"]
    attempt_dir = run_dir / "render-attempts" / attempt_id
    directories = (
        attempt_dir,
        attempt_dir / "inputs",
        attempt_dir / "renders",
        attempt_dir / "renders" / "linked",
        attempt_dir / "renders" / "independent",
        attempt_dir / "artifacts",
    )
    for directory in directories:
        try:
            directory_stat = directory.stat(follow_symlinks=False)
            resolved = directory.resolve(strict=True)
        except OSError as error:
            raise ManifestError("published render attempt directory is missing") from error
        if (
            directory.is_symlink()
            or not stat.S_ISDIR(directory_stat.st_mode)
            or resolved != directory
        ):
            raise ManifestError("published render attempt directory is unsafe")
        if os.name == "posix" and stat.S_IMODE(directory_stat.st_mode) != 0o700:
            raise ManifestError("published render attempt directory is not owner-only")
        if hasattr(os, "geteuid") and directory_stat.st_uid != os.geteuid():
            raise ManifestError("published render attempt directory has a different owner")
    metrics_path = verify_artifact_reference(metrics_record["artifact"], run_dir)
    payload = load_json(metrics_path)
    if not isinstance(payload, Mapping):
        raise ManifestError("render metrics artifact root must be an object")
    _metric_record(
        payload,
        fields={
            "schema_version",
            "attempt_id",
            "created_at",
            "gate_b",
            "approved_map",
            "renderer",
            "outputs",
        },
        label="render metrics artifact",
    )
    if payload.get("schema_version") != "opusloops.render-metrics.v1":
        raise ManifestError("render metrics artifact has an unsupported schema")
    if payload.get("attempt_id") != attempt_id:
        raise ManifestError("render metrics artifact belongs to a different attempt_id")
    created_at = payload.get("created_at")
    if not isinstance(created_at, str):
        raise ManifestError("render metrics artifact has no creation timestamp")
    try:
        created_datetime = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ManifestError("render metrics artifact has an invalid creation timestamp") from error
    if created_datetime.tzinfo is None:
        raise ManifestError("render metrics artifact creation timestamp has no timezone")
    renderer = value["toolchain"]["signalsmith_renderer"]
    if payload.get("renderer") != renderer:
        raise ManifestError("render metrics renderer provenance differs from the manifest")
    tempo_map = value.get("tempo_map")
    if not isinstance(tempo_map, Mapping) or payload.get("gate_b") != tempo_map.get("approval"):
        raise ManifestError("render metrics artifact does not bind the approved Gate-B artifact")
    decision = tempo_map["decision"]
    expected_map = {
        "sample_rate": decision["sample_rate"],
        "target_frames": decision["total_target_frames"],
        "internal_target_boundary_frames": sorted(
            {anchor["target_frame"] for anchor in decision["anchors"][1:-1]}
        ),
    }
    if payload.get("approved_map") != expected_map:
        raise ManifestError("render metrics artifact differs from the approved frame map")

    outputs = payload.get("outputs")
    stem_ids = set(renders[0]["stem_sha256s"])
    if not isinstance(outputs, Mapping) or set(outputs) != stem_ids:
        raise ManifestError("render metrics artifact does not cover the rendered stem set")
    results_by_mode = {result["mode"]: result for result in renders}
    assets_by_id = {asset["asset_id"]: asset for asset in value["audio_assets"]}
    sample_rate = decision["sample_rate"]
    target_frames = decision["total_target_frames"]
    boundary_frames = expected_map["internal_target_boundary_frames"]
    for asset_id in stem_ids:
        stem_metrics = outputs.get(asset_id)
        stem_metrics = _metric_record(
            stem_metrics,
            fields={"linked", "independent", "linked_vs_independent_residual"},
            label=f"render metrics stem {asset_id}",
        )
        channels = assets_by_id[asset_id]["channels"]
        for mode in ("linked", "independent"):
            mode_metrics = _metric_record(
                stem_metrics.get(mode),
                fields={"artifact", "integrity", "approved_boundary_discontinuities"},
                label=f"render metrics {mode}/{asset_id}",
            )
            expected_path = f"render-attempts/{attempt_id}/renders/{mode}/{asset_id}.wav"
            result_artifact = next(
                reference
                for reference in results_by_mode[mode]["artifacts"]
                if reference["path"] == expected_path
            )
            if mode_metrics.get("artifact") != result_artifact:
                raise ManifestError(
                    "render metrics artifact references a different rendered output"
                )
            _verify_wav_integrity_metrics(
                mode_metrics["integrity"],
                expected_path=expected_path,
                sample_rate=sample_rate,
                channels=channels,
                frames=target_frames,
                label=f"render metrics {mode}/{asset_id} integrity",
            )
            _verify_boundary_metrics(
                mode_metrics["approved_boundary_discontinuities"],
                expected_path=expected_path,
                sample_rate=sample_rate,
                channels=channels,
                frames=target_frames,
                boundary_frames=boundary_frames,
                label=f"render metrics {mode}/{asset_id} boundaries",
            )
        _verify_pair_residual_metrics(
            stem_metrics["linked_vs_independent_residual"],
            linked_path=f"render-attempts/{attempt_id}/renders/linked/{asset_id}.wav",
            independent_path=(f"render-attempts/{attempt_id}/renders/independent/{asset_id}.wav"),
            sample_rate=sample_rate,
            channels=channels,
            frames=target_frames,
            label=f"render metrics linked/independent residual for {asset_id}",
        )


def _walk_artifact_references(value: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        if set(value) == {"path", "bytes", "sha256"}:
            yield value
            return
        for child in value.values():
            yield from _walk_artifact_references(child)
    elif isinstance(value, list | tuple):
        for child in value:
            yield from _walk_artifact_references(child)


def approval_binding(
    manifest_path: str | os.PathLike[str],
    *,
    source_archive_sha256: str,
    inventory_sha256: str,
) -> dict[str, str]:
    for name, digest in (
        ("source_archive_sha256", source_archive_sha256),
        ("inventory_sha256", inventory_sha256),
    ):
        if not _SHA256_PATTERN.fullmatch(digest):
            raise ManifestError(f"{name} is not a lowercase SHA-256 digest")
    manifest_sha256, _ = sha256_file(manifest_path)
    return {
        "run_manifest_sha256": manifest_sha256,
        "source_archive_sha256": source_archive_sha256,
        "inventory_sha256": inventory_sha256,
    }


def verify_approval_binding(approval: Mapping[str, Any], expected: Mapping[str, str]) -> None:
    upstream = approval.get("upstream")
    if not isinstance(upstream, Mapping):
        raise ManifestError("approval has no upstream binding")
    required = (
        "run_manifest_sha256",
        "source_archive_sha256",
        "inventory_sha256",
    )
    for key in required:
        actual_value = upstream.get(key)
        expected_value = expected.get(key)
        if not isinstance(actual_value, str) or not isinstance(expected_value, str):
            raise ManifestError(f"approval binding is missing {key}")
        if not hmac.compare_digest(actual_value, expected_value):
            raise ManifestError(f"approval is stale: upstream {key} changed")


def validate_analysis_selection(
    value: Mapping[str, Any], *, expected_binding: Mapping[str, str] | None = None
) -> None:
    """Enforce Gate-A semantics which JSON Schema cannot express by itself."""

    allowed_top_level = {
        "schema_version",
        "approval_id",
        "approved_at",
        "approved_by",
        "upstream",
        "selection",
        "confirmations",
    }
    if set(value) != allowed_top_level:
        raise ManifestError("analysis selection has missing or unsupported top-level fields")
    if value.get("schema_version") != ANALYSIS_SELECTION_SCHEMA_VERSION:
        raise ManifestError("unsupported analysis-selection schema version")
    approval_id = value.get("approval_id")
    if not isinstance(approval_id, str) or not _IDENTIFIER_PATTERN.fullmatch(approval_id):
        raise ManifestError("analysis selection requires a non-empty approval_id")
    approved_by = value.get("approved_by")
    if not isinstance(approved_by, str) or not approved_by.strip() or len(approved_by) > 200:
        raise ManifestError("analysis selection requires a non-empty approved_by")
    approved_at = value.get("approved_at")
    if not isinstance(approved_at, str):
        raise ManifestError("analysis selection requires approved_at")
    try:
        approved_datetime = datetime.fromisoformat(approved_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ManifestError("approved_at must be an ISO-8601 timestamp") from error
    if approved_datetime.tzinfo is None:
        raise ManifestError("approved_at must include a timezone")

    upstream = value.get("upstream")
    upstream_keys = {
        "run_manifest_sha256",
        "source_archive_sha256",
        "inventory_sha256",
    }
    if not isinstance(upstream, Mapping) or set(upstream) != upstream_keys:
        raise ManifestError("analysis selection requires an upstream binding")
    for key in ("run_manifest_sha256", "source_archive_sha256", "inventory_sha256"):
        digest = upstream.get(key)
        if not isinstance(digest, str) or not _SHA256_PATTERN.fullmatch(digest):
            raise ManifestError(f"analysis selection has an invalid {key}")
    if expected_binding is not None:
        verify_approval_binding(value, expected_binding)

    selection = value.get("selection")
    selection_keys = {
        "reference_method",
        "assets",
        "full_mix_asset_id",
        "drum_crosscheck_asset_id",
        "sum",
    }
    if not isinstance(selection, Mapping) or set(selection) != selection_keys:
        raise ManifestError("analysis selection requires selection details")
    method = selection.get("reference_method")
    if method not in {"full-mix", "selected-stem-sum"}:
        raise ManifestError("unsupported reference_method")
    assets = selection.get("assets")
    if not isinstance(assets, list) or not assets:
        raise ManifestError("analysis selection requires at least one asset")
    seen: set[str] = set()
    included: set[str] = set()
    assets_by_id: dict[str, Mapping[str, Any]] = {}
    for asset in assets:
        if not isinstance(asset, Mapping):
            raise ManifestError("analysis selection assets must be objects")
        if set(asset) != {"asset_id", "role", "included", "gain_db"}:
            raise ManifestError("analysis selection asset has unsupported or missing fields")
        asset_id = asset.get("asset_id")
        if not isinstance(asset_id, str) or not _IDENTIFIER_PATTERN.fullmatch(asset_id):
            raise ManifestError("every selected asset requires an asset_id")
        if asset_id in seen:
            raise ManifestError(f"duplicate asset_id in analysis selection: {asset_id}")
        seen.add(asset_id)
        assets_by_id[asset_id] = asset
        if not isinstance(asset.get("included"), bool):
            raise ManifestError(f"asset {asset_id} included must be boolean")
        if asset.get("included") is True:
            included.add(asset_id)
        if asset.get("role") not in _ANALYSIS_ROLES:
            raise ManifestError(f"asset {asset_id} has an unsupported role")
        gain_db = asset.get("gain_db")
        if not isinstance(gain_db, int | float) or isinstance(gain_db, bool):
            raise ManifestError(f"asset {asset_id} requires a numeric gain_db")
        if not math.isfinite(float(gain_db)) or not -120 <= float(gain_db) <= 24:
            raise ManifestError(f"asset {asset_id} gain_db is outside the safe range")
    if not included:
        raise ManifestError("analysis selection includes no assets")
    full_mix = selection.get("full_mix_asset_id")
    if method == "full-mix":
        if not isinstance(full_mix, str) or included != {full_mix}:
            raise ManifestError(
                "full-mix analysis requires exactly one included asset: full_mix_asset_id"
            )
    elif full_mix is not None:
        raise ManifestError("selected-stem-sum analysis must not set full_mix_asset_id")
    drum = selection.get("drum_crosscheck_asset_id")
    if drum is not None and (not isinstance(drum, str) or drum not in seen):
        raise ManifestError("drum_crosscheck_asset_id must refer to a listed asset")
    if isinstance(drum, str):
        drum_asset = assets_by_id[drum]
        if drum_asset.get("included") is not True:
            raise ManifestError("drum cross-check asset must be included in the reference")
        if drum_asset.get("role") != "drums":
            raise ManifestError("drum cross-check asset must have the drums role")
    summing = selection.get("sum")
    if not isinstance(summing, Mapping) or set(summing) != {
        "headroom_db",
        "normalize_peak_dbfs",
    }:
        raise ManifestError("analysis selection requires deterministic sum settings")
    if summing.get("normalize_peak_dbfs") != -3:
        raise ManifestError("v1 reference sum must normalize the completed sum to -3 dBFS")
    headroom = summing.get("headroom_db")
    if (
        not isinstance(headroom, int | float)
        or isinstance(headroom, bool)
        or not math.isfinite(float(headroom))
        or headroom > 0
    ):
        raise ManifestError("sum headroom_db must be a non-positive number")

    confirmations = value.get("confirmations")
    required_confirmations = {
        "files_and_hashes_reviewed",
        "roles_reviewed",
        "reference_method_reviewed",
        "originals_unchanged",
    }
    if (
        not isinstance(confirmations, Mapping)
        or set(confirmations) != required_confirmations
        or any(confirmations.get(key) is not True for key in required_confirmations)
    ):
        raise ManifestError("all Gate-A confirmations must be explicitly true")


def append_event(
    run_dir: str | os.PathLike[str],
    stage: str,
    status: str,
    *,
    completed: int | None = None,
    total: int | None = None,
    unit: str | None = None,
    message: str | None = None,
    details: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Append one durable, sequenced event without inventing cross-stage progress."""

    if not stage or not status:
        raise ManifestError("event stage and status are required")
    progress_values = (completed, total, unit)
    if any(value is not None for value in progress_values) and not all(
        value is not None for value in progress_values
    ):
        raise ManifestError("determinate progress requires completed, total, and unit")
    if completed is not None:
        if not isinstance(completed, int) or isinstance(completed, bool):
            raise ManifestError("event completed value must be an integer")
        if not isinstance(total, int) or isinstance(total, bool) or total <= 0:
            raise ManifestError("event total value must be a positive integer")
        if completed < 0 or completed > total:
            raise ManifestError("event completed value must be within [0, total]")
        if not isinstance(unit, str) or not unit:
            raise ManifestError("event progress unit must be non-empty")

    directory = Path(run_dir)
    directory.mkdir(parents=True, exist_ok=True)
    event_path = directory / "events.jsonl"
    if event_path.is_symlink():
        raise ManifestError("cannot safely open events.jsonl: path is a symlink")
    flags = os.O_RDWR | os.O_CREAT | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(event_path, flags, 0o600)
    except OSError as error:
        raise ManifestError(f"cannot safely open events.jsonl: {error}") from error
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ManifestError("events.jsonl must be a regular file")
        try:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX)
        except ImportError:  # pragma: no cover - Windows fallback
            pass
        with os.fdopen(descriptor, "r+b", closefd=False) as stream:
            stream.seek(0)
            existing = stream.read()
            previous_events = _verify_event_lines(existing.splitlines())
            sequence = len(previous_events) + 1
            unsigned: dict[str, Any] = {
                "schema_version": "opusloops.run-event.v1",
                "event_id": str(uuid.uuid4()),
                "sequence": sequence,
                "occurred_at": utc_now(),
                "stage": stage,
                "status": status,
                "determinate": completed is not None,
                "previous_event_sha256": (
                    previous_events[-1]["event_sha256"] if previous_events else None
                ),
            }
            if completed is not None:
                unsigned["progress"] = {
                    "completed": completed,
                    "total": total,
                    "unit": unit,
                }
            if message is not None:
                unsigned["message"] = message
            if details is not None:
                unsigned["details"] = dict(details)
            event = dict(unsigned)
            event["event_sha256"] = json_sha256(unsigned)
            line = canonical_json_bytes(event) + b"\n"
            _verify_event_lines((*existing.splitlines(), line.rstrip(b"\n")))
            stream.seek(0, os.SEEK_END)
            stream.write(line)
            stream.flush()
            os.fsync(stream.fileno())
        return event
    finally:
        try:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
        except (ImportError, OSError):  # pragma: no cover - Windows/closed descriptor
            pass
        os.close(descriptor)


def _verify_event_lines(lines: Iterable[bytes]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    previous_sha256: str | None = None
    active_stages: set[str] = set()
    stage_progress: dict[str, tuple[int, str, int]] = {}
    terminal_statuses = {"completed", "failed", "skipped"}
    for line_number, raw_line in enumerate(lines, start=1):
        try:
            value = json.loads(raw_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ManifestError(f"events.jsonl line {line_number} is invalid JSON") from error
        if not isinstance(value, dict):
            raise ManifestError(f"events.jsonl line {line_number} is not an object")
        if value.get("schema_version") != "opusloops.run-event.v1":
            raise ManifestError(f"events.jsonl line {line_number} has an unsupported schema")
        event_sha256 = value.get("event_sha256")
        if not isinstance(event_sha256, str) or not _SHA256_PATTERN.fullmatch(event_sha256):
            raise ManifestError(f"events.jsonl line {line_number} has no valid event hash")
        unsigned = dict(value)
        unsigned.pop("event_sha256")
        expected_hash = json_sha256(unsigned)
        if not hmac.compare_digest(event_sha256, expected_hash):
            raise ManifestError(f"events.jsonl line {line_number} hash does not match")
        sequence = value.get("sequence")
        if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence != line_number:
            raise ManifestError("events.jsonl sequence is not contiguous")
        if value.get("previous_event_sha256") != previous_sha256:
            raise ManifestError("events.jsonl hash chain is broken")
        stage = value.get("stage")
        status = value.get("status")
        if not isinstance(stage, str) or not stage or not isinstance(status, str) or not status:
            raise ManifestError("event stage and status must be non-empty strings")
        if status == "started":
            if stage in active_stages:
                raise ManifestError(f"event stage restarted before terminal status: {stage}")
            active_stages.add(stage)
            stage_progress.pop(stage, None)
        elif status == "progress" and stage not in active_stages:
            raise ManifestError(f"event progress has no active started stage: {stage}")
        determinate = value.get("determinate")
        if determinate is True:
            if status != "started" and stage not in active_stages:
                raise ManifestError(f"determinate event has no active started stage: {stage}")
            progress = value.get("progress")
            if not isinstance(progress, dict) or set(progress) != {
                "completed",
                "total",
                "unit",
            }:
                raise ManifestError("determinate event has invalid progress units")
            completed = progress["completed"]
            total = progress["total"]
            unit = progress["unit"]
            if (
                not isinstance(completed, int)
                or isinstance(completed, bool)
                or not isinstance(total, int)
                or isinstance(total, bool)
                or total <= 0
                or not 0 <= completed <= total
                or not isinstance(unit, str)
                or not unit
            ):
                raise ManifestError("determinate event has invalid progress values")
            previous_progress = stage_progress.get(stage)
            if previous_progress is not None:
                previous_total, previous_unit, previous_completed = previous_progress
                if total != previous_total or unit != previous_unit:
                    raise ManifestError(
                        f"determinate progress total/unit changed within stage: {stage}"
                    )
                if completed < previous_completed:
                    raise ManifestError(f"determinate progress regressed within stage: {stage}")
            stage_progress[stage] = (total, unit, completed)
        elif determinate is False:
            if "progress" in value:
                raise ManifestError("indeterminate event must not claim progress")
        else:
            raise ManifestError("event determinate flag must be boolean")
        if status in terminal_statuses:
            active_stages.discard(stage)
            stage_progress.pop(stage, None)
        events.append(value)
        previous_sha256 = event_sha256
    return events


def _read_event_journal_bytes(path: Path) -> bytes:
    try:
        before = path.stat(follow_symlinks=False)
    except OSError as error:
        raise ManifestError(f"cannot stat event journal: {error}") from error
    if not stat.S_ISREG(before.st_mode):
        raise ManifestError("events.jsonl must be a regular file, not a symlink")
    try:
        contents = path.read_bytes()
    except OSError as error:
        raise ManifestError(f"cannot read event journal: {error}") from error
    after = path.stat(follow_symlinks=False)
    if (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or len(
        contents
    ) != before.st_size:
        raise ManifestError("event journal changed while reading")
    return contents


def _event_anchor(contents: bytes, events: list[dict[str, Any]]) -> dict[str, Any]:
    if not contents or not events or not contents.endswith(b"\n"):
        raise ManifestError("event journal cannot be anchored while empty or incomplete")
    return {
        "path": "events.jsonl",
        "entries": len(events),
        "bytes_at_anchor": len(contents),
        "journal_sha256_at_anchor": hashlib.sha256(contents).hexdigest(),
        "head_event_sha256": events[-1]["event_sha256"],
    }


def _verify_event_anchor_contents(
    anchor: Mapping[str, Any], contents: bytes
) -> list[dict[str, Any]]:
    expected_fields = {
        "path",
        "entries",
        "bytes_at_anchor",
        "journal_sha256_at_anchor",
        "head_event_sha256",
    }
    if set(anchor) != expected_fields or anchor.get("path") != "events.jsonl":
        raise ManifestError("event journal anchor has an invalid shape or path")
    entries = anchor.get("entries")
    anchored_bytes = anchor.get("bytes_at_anchor")
    anchored_sha256 = anchor.get("journal_sha256_at_anchor")
    head_sha256 = anchor.get("head_event_sha256")
    if not isinstance(entries, int) or isinstance(entries, bool) or entries <= 0:
        raise ManifestError("event journal anchor entry count must be positive")
    if (
        not isinstance(anchored_bytes, int)
        or isinstance(anchored_bytes, bool)
        or anchored_bytes <= 0
        or anchored_bytes > len(contents)
    ):
        raise ManifestError("event journal is missing its anchored prefix")
    if not isinstance(anchored_sha256, str) or not _SHA256_PATTERN.fullmatch(anchored_sha256):
        raise ManifestError("event journal anchor hash is invalid")
    if not isinstance(head_sha256, str) or not _SHA256_PATTERN.fullmatch(head_sha256):
        raise ManifestError("event journal anchor head hash is invalid")
    prefix = contents[:anchored_bytes]
    if not prefix.endswith(b"\n") or not hmac.compare_digest(
        hashlib.sha256(prefix).hexdigest(), anchored_sha256
    ):
        raise ManifestError("event journal anchored prefix was rewritten")
    prefix_events = _verify_event_lines(prefix.splitlines())
    if len(prefix_events) != entries or not hmac.compare_digest(
        str(prefix_events[-1]["event_sha256"]), head_sha256
    ):
        raise ManifestError("event journal anchored prefix metadata changed")
    return _verify_event_lines(contents.splitlines())


def verify_event_journal(
    run_dir: str | os.PathLike[str],
    *,
    anchor: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Verify the complete event sequence and tamper-evident hash chain."""

    path = Path(run_dir) / "events.jsonl"
    contents = _read_event_journal_bytes(path)
    if anchor is not None:
        return _verify_event_anchor_contents(anchor, contents)
    return _verify_event_lines(contents.splitlines())


def _git_repository(repo_dir: Path | None) -> dict[str, Any]:
    if repo_dir is None:
        return {"commit": None, "dirty": None}
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=normal"],
            cwd=repo_dir,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
        return {"commit": commit, "dirty": bool(status)}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "dirty": None}


def _host_identity() -> dict[str, Any]:
    return {
        "os": platform.system(),
        "os_release": platform.release(),
        "machine": platform.machine(),
        "processor": platform.processor() or None,
        "cpu_count": os.cpu_count(),
        "gpu": None,
    }


def _anchor_events_for_write(
    current_anchor: object,
    run_dir: Path,
) -> dict[str, Any] | None:
    event_path = run_dir / "events.jsonl"
    if not (event_path.exists() or event_path.is_symlink()):
        if current_anchor is not None:
            raise ManifestError("anchored event journal is missing")
        return None
    contents = _read_event_journal_bytes(event_path)
    if current_anchor is None:
        events = _verify_event_lines(contents.splitlines())
    elif isinstance(current_anchor, Mapping):
        events = _verify_event_anchor_contents(current_anchor, contents)
    else:
        raise ManifestError("event journal anchor must be an object or null")
    return _event_anchor(contents, events)


@dataclass(slots=True)
class RunManifest:
    data: dict[str, Any]
    path: Path | None = None

    @classmethod
    def create(
        cls,
        *,
        run_id: str | None = None,
        policy: IngestPolicy = DEFAULT_POLICY,
        repo_dir: str | os.PathLike[str] | None = None,
    ) -> RunManifest:
        created_at = utc_now()
        identifier = run_id or str(uuid.uuid4())
        if not identifier or "/" in identifier or "\\" in identifier:
            raise ManifestError("run_id must be non-empty and path-safe")
        return cls(
            {
                "schema_version": MANIFEST_SCHEMA_VERSION,
                "run_id": identifier,
                "created_at": created_at,
                "updated_at": created_at,
                "repository": _git_repository(Path(repo_dir).resolve() if repo_dir else None),
                "host": _host_identity(),
                "source_archive": None,
                "policy": policy.to_dict(),
                "entries": [],
                "audio_assets": [],
                "inspection_snapshot": None,
                "analysis_selection": None,
                "analysis": None,
                "tempo_map": None,
                "renders": [],
                "metrics": None,
                "toolchain": {},
                "events": None,
            }
        )

    @classmethod
    def load(cls, path: str | os.PathLike[str]) -> RunManifest:
        data = load_json(path)
        if not isinstance(data, dict):
            raise ManifestError("run manifest root must be an object")
        manifest = cls(data=data, path=Path(path))
        manifest.validate()
        return manifest

    def validate(self) -> None:
        canonical_json_bytes(self.data)
        _validate_run_manifest_schema(self.data)

    def write(self, path: str | os.PathLike[str] | None = None) -> Path:
        destination = Path(path) if path is not None else self.path
        if destination is None:
            raise ManifestError("manifest write requires a destination path")
        self.data["events"] = _anchor_events_for_write(
            self.data.get("events"), destination.resolve().parent
        )
        self.data["updated_at"] = utc_now()
        self.validate()
        atomic_write_json(destination, self.data)
        self.path = destination
        return destination

    @property
    def content_sha256(self) -> str:
        return json_sha256(self.data)

    def file_sha256(self) -> str:
        if self.path is None:
            raise ManifestError("manifest has not been written")
        digest, _ = sha256_file(self.path)
        return digest

    def verify_artifacts(self, run_dir: str | os.PathLike[str] | None = None) -> list[Path]:
        self.validate()
        if run_dir is None:
            if self.path is None:
                raise ManifestError("artifact verification requires a run directory")
            run_dir = self.path.parent
        root = Path(run_dir).resolve()
        verified: list[Path] = []
        for reference in _walk_artifact_references(self.data):
            verified.append(verify_artifact_reference(reference, root))
        _verify_render_metrics_binding(self.data, root)
        entries = self.data.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, Mapping) or entry.get("outcome") != "accepted":
                    continue
                normalized_name = entry.get("normalized_name")
                sha256 = entry.get("sha256")
                byte_length = entry.get("uncompressed_bytes")
                if not isinstance(normalized_name, str):
                    raise ManifestError("accepted archive entry has no normalized path")
                reference = {
                    "path": f"extracted/{normalized_name}",
                    "bytes": byte_length,
                    "sha256": sha256,
                }
                verified.append(verify_artifact_reference(reference, root))
        event_anchor = self.data.get("events")
        event_path = root / "events.jsonl"
        if event_path.exists() or event_path.is_symlink():
            if event_anchor is not None and not isinstance(event_anchor, Mapping):
                raise ManifestError("event journal anchor must be an object or null")
            verify_event_journal(
                root,
                anchor=event_anchor if isinstance(event_anchor, Mapping) else None,
            )
            verified.append(event_path.resolve())
        elif event_anchor is not None:
            raise ManifestError("anchored event journal is missing")
        return verified


__all__ = [
    "ANALYSIS_SELECTION_SCHEMA_VERSION",
    "MANIFEST_SCHEMA_VERSION",
    "ManifestError",
    "RunManifest",
    "append_event",
    "approval_binding",
    "artifact_reference",
    "atomic_create_bytes",
    "atomic_create_json",
    "atomic_write_bytes",
    "atomic_write_json",
    "canonical_json_bytes",
    "json_sha256",
    "load_json",
    "run_manifest_schema",
    "sha256_file",
    "tempo_approval_schema",
    "utc_now",
    "validate_analysis_selection",
    "validate_tempo_approval_schema",
    "verify_approval_binding",
    "verify_artifact_reference",
    "verify_event_journal",
]
