"""Continuous beat/downbeat analysis adapters for canonical PCM references."""

from __future__ import annotations

import hashlib
import hmac
import importlib.metadata
import math
import os
import shutil
import stat
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager, suppress
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol

from .reference import (
    CanonicalReferenceView,
    ReferenceError,
    ReferenceResult,
    _little_endian_bytes,
    _read_float32,
    _wav_header,
    open_verified_reference_stream,
)

EventCallback = Callable[[str, str, dict[str, object]], None]


class BeatTrackerError(RuntimeError):
    """Raised when analysis cannot produce a reviewable continuous grid."""


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True, slots=True)
class _CheckpointSource:
    path: Path
    resolution: str
    model_label: str


@dataclass(slots=True)
class _PinnedCheckpoint:
    source: _CheckpointSource
    original_descriptor: int
    original_identity: _FileIdentity
    snapshot_path: Path
    snapshot_descriptor: int
    snapshot_identity: _FileIdentity
    sha256: str

    @property
    def bytes(self) -> int:
        return self.snapshot_identity.size

    def verify(self, *, phase: str) -> None:
        _verify_bound_checkpoint(
            self.source.path,
            self.original_descriptor,
            self.original_identity,
            expected_sha256=self.sha256,
            label=f"Beat This checkpoint source after {phase}",
        )
        _verify_bound_checkpoint(
            self.snapshot_path,
            self.snapshot_descriptor,
            self.snapshot_identity,
            expected_sha256=self.sha256,
            label=f"private Beat This checkpoint snapshot after {phase}",
        )

    def provenance(self) -> dict[str, object]:
        common = {"bytes": self.bytes, "sha256": self.sha256}
        return {
            "resolution": self.source.resolution,
            "original": {**common, "identity_bound": True},
            "snapshot": {
                **common,
                "kind": "private-owned-temporary-copy",
                "identity_bound": True,
                "path_recorded": False,
            },
            "verification_points": [
                "before-model-load",
                "after-model-initialization",
                "after-inference",
            ],
        }


@dataclass(frozen=True)
class AnalysisArtifact:
    path: str
    bytes: int
    sha256: str

    def to_dict(self) -> dict[str, str | int]:
        return asdict(self)


@dataclass(frozen=True)
class BeatAnalysis:
    analyzer: str
    package_version: str
    model: str
    checkpoint_sha256: str | None
    resolution_hz: float | None
    reference_sha256: str
    reference_frames: int
    reference_sample_rate: int
    beats_seconds: tuple[float, ...]
    downbeats_seconds: tuple[float, ...]
    elapsed_seconds: float
    artifacts: tuple[AnalysisArtifact, ...] = ()
    diagnostics: Mapping[str, object] | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "analyzer": self.analyzer,
            "package_version": self.package_version,
            "model": self.model,
            "checkpoint_sha256": self.checkpoint_sha256,
            "resolution_hz": self.resolution_hz,
            "reference_sha256": self.reference_sha256,
            "reference_frames": self.reference_frames,
            "reference_sample_rate": self.reference_sample_rate,
            "reference_duration_seconds": self.reference_frames / self.reference_sample_rate,
            "beats_seconds": list(self.beats_seconds),
            "downbeats_seconds": list(self.downbeats_seconds),
            "elapsed_seconds": self.elapsed_seconds,
            "artifacts": [artifact.to_dict() for artifact in self.artifacts],
            # Model logits are deliberately not exposed as a correctness
            # percentage.  Any product quality label must be calibrated on a
            # representative Suno corpus and confirmed by a person.
            "confidence": None,
            "requires_human_confirmation": True,
            "diagnostics": dict(self.diagnostics or {}),
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, object]) -> BeatAnalysis:
        artifacts = tuple(
            AnalysisArtifact(
                path=str(item["path"]),
                bytes=int(item["bytes"]),
                sha256=str(item["sha256"]),
            )
            for item in payload.get("artifacts", [])
            if isinstance(item, Mapping)
        )
        return cls(
            analyzer=str(payload["analyzer"]),
            package_version=str(payload["package_version"]),
            model=str(payload["model"]),
            checkpoint_sha256=(
                str(payload["checkpoint_sha256"])
                if payload.get("checkpoint_sha256") is not None
                else None
            ),
            resolution_hz=(
                float(payload["resolution_hz"])
                if payload.get("resolution_hz") is not None
                else None
            ),
            reference_sha256=str(payload["reference_sha256"]),
            reference_frames=int(payload["reference_frames"]),
            reference_sample_rate=int(payload["reference_sample_rate"]),
            beats_seconds=tuple(float(value) for value in payload["beats_seconds"]),
            downbeats_seconds=tuple(float(value) for value in payload["downbeats_seconds"]),
            elapsed_seconds=float(payload["elapsed_seconds"]),
            artifacts=artifacts,
            diagnostics=(
                payload.get("diagnostics")
                if isinstance(payload.get("diagnostics"), Mapping)
                else None
            ),
        )


class Analyzer(Protocol):
    def analyze(self, reference: ReferenceResult, artifact_dir: Path) -> BeatAnalysis: ...


class DiagnosticAnalyzer(Protocol):
    name: str

    def analyze(
        self,
        reference: ReferenceResult | CanonicalReferenceView,
        artifact_dir: Path,
    ) -> Mapping[str, object]: ...


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _identity(value: os.stat_result) -> _FileIdentity:
    return _FileIdentity(
        device=value.st_dev,
        inode=value.st_ino,
        mode=value.st_mode,
        size=value.st_size,
        modified_ns=value.st_mtime_ns,
        changed_ns=value.st_ctime_ns,
    )


def _same_file(left: _FileIdentity, right: _FileIdentity) -> bool:
    return left.device == right.device and left.inode == right.inode


def _validate_expected_checkpoint_sha256(value: str | None) -> str:
    if value is None:
        raise BeatTrackerError(
            "Beat This requires an expected checkpoint SHA-256 before model loading"
        )
    normalized = value.lower()
    if len(normalized) != 64 or any(
        character not in "0123456789abcdef" for character in normalized
    ):
        raise BeatTrackerError(
            "Beat This expected checkpoint SHA-256 must be 64 hexadecimal digits"
        )
    return normalized


def _resolved_parent_entry(path: Path, *, label: str) -> Path:
    expanded = path.expanduser()
    try:
        parent = expanded.parent.resolve(strict=True)
    except OSError as exc:
        raise BeatTrackerError(f"cannot resolve {label} parent") from exc
    return parent / expanded.name


def _resolve_checkpoint_source(checkpoint: str, torch_module: object) -> _CheckpointSource:
    """Resolve Beat This's local-file/cache semantics without loading a model."""

    requested = Path(checkpoint).expanduser()
    try:
        requested.lstat()
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise BeatTrackerError("cannot inspect Beat This checkpoint") from exc
    else:
        return _CheckpointSource(
            path=_resolved_parent_entry(requested, label="Beat This checkpoint"),
            resolution="explicit-local-file",
            model_label=requested.name,
        )

    if checkpoint.startswith(("http://", "https://")):
        raise BeatTrackerError(
            "remote Beat This checkpoint URLs are not loaded directly; provide a pinned local file"
        )
    if requested.is_absolute() or len(requested.parts) != 1:
        raise BeatTrackerError(f"Beat This checkpoint file does not exist: {requested.name}")

    try:
        hub_dir = Path(torch_module.hub.get_dir())
    except Exception as exc:
        raise BeatTrackerError("cannot resolve the PyTorch checkpoint cache") from exc
    candidate = hub_dir / "checkpoints" / f"beat_this-{checkpoint}.ckpt"
    try:
        candidate.lstat()
    except FileNotFoundError as exc:
        raise BeatTrackerError(
            f"Beat This checkpoint {checkpoint!r} is not present in the local PyTorch cache; "
            "prefetch it separately, record its SHA-256, and retry"
        ) from exc
    except OSError as exc:
        raise BeatTrackerError("cannot inspect cached Beat This checkpoint") from exc
    return _CheckpointSource(
        path=_resolved_parent_entry(candidate, label="PyTorch checkpoint cache"),
        resolution="torch-hub-shortname-cache",
        model_label=checkpoint,
    )


def _open_bound_regular_file(path: Path, *, label: str) -> tuple[int, _FileIdentity]:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise BeatTrackerError(f"cannot open {label}") from exc
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
        if not stat.S_ISREG(descriptor_identity.mode) or not stat.S_ISREG(path_identity.mode):
            raise BeatTrackerError(f"{label} must be a non-symlink regular file")
        if not _same_file(descriptor_identity, path_identity):
            raise BeatTrackerError(f"{label} changed while it was being opened")
        return descriptor, descriptor_identity
    except Exception:
        os.close(descriptor)
        raise


def _hash_descriptor(descriptor: int) -> tuple[str, int]:
    try:
        original_offset = os.lseek(descriptor, 0, os.SEEK_CUR)
        os.lseek(descriptor, 0, os.SEEK_SET)
    except OSError as exc:
        raise BeatTrackerError(f"cannot seek Beat This checkpoint descriptor: {exc}") from exc
    digest = hashlib.sha256()
    byte_count = 0
    try:
        while True:
            block = os.read(descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            byte_count += len(block)
    except OSError as exc:
        raise BeatTrackerError(f"cannot read Beat This checkpoint descriptor: {exc}") from exc
    finally:
        with suppress(OSError):
            os.lseek(descriptor, original_offset, os.SEEK_SET)
    return digest.hexdigest(), byte_count


def _verify_bound_checkpoint(
    path: Path,
    descriptor: int,
    expected_identity: _FileIdentity,
    *,
    expected_sha256: str,
    label: str,
) -> None:
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
    except OSError as exc:
        raise BeatTrackerError(f"{label} identity is no longer available") from exc
    if descriptor_identity != expected_identity or not _same_file(path_identity, expected_identity):
        raise BeatTrackerError(f"{label} identity changed")
    if not stat.S_ISREG(path_identity.mode):
        raise BeatTrackerError(f"{label} is no longer a regular file")
    actual_sha256, byte_count = _hash_descriptor(descriptor)
    try:
        final_descriptor_identity = _identity(os.fstat(descriptor))
        final_path_identity = _identity(path.stat(follow_symlinks=False))
    except OSError as exc:
        raise BeatTrackerError(f"{label} changed while it was being verified") from exc
    if (
        final_descriptor_identity != expected_identity
        or not _same_file(final_path_identity, expected_identity)
        or byte_count != expected_identity.size
    ):
        raise BeatTrackerError(f"{label} changed while it was being verified")
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise BeatTrackerError(f"{label} hash changed")


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        try:
            written = os.write(descriptor, view)
        except OSError as exc:
            raise BeatTrackerError("cannot write private Beat This checkpoint snapshot") from exc
        if written <= 0:
            raise BeatTrackerError("short write while snapshotting Beat This checkpoint")
        view = view[written:]


@contextmanager
def _pinned_checkpoint(
    source: _CheckpointSource,
    *,
    expected_sha256: str,
) -> Iterator[_PinnedCheckpoint]:
    """Copy one no-follow source descriptor into a private path for PyTorch."""

    original_descriptor, original_identity = _open_bound_regular_file(
        source.path, label="Beat This checkpoint"
    )
    temporary_root: Path | None = None
    snapshot_descriptor: int | None = None
    output_descriptor: int | None = None
    try:
        temporary_root = Path(tempfile.mkdtemp(prefix=".opusloops-beat-this-checkpoint-"))
        snapshot_path = temporary_root / "checkpoint.ckpt"
        os.chmod(temporary_root, 0o700)
        directory_stat = temporary_root.stat(follow_symlinks=False)
        if (
            not stat.S_ISDIR(directory_stat.st_mode)
            or stat.S_IMODE(directory_stat.st_mode) != 0o700
        ):
            raise BeatTrackerError("private Beat This checkpoint directory is not mode 0700")
        if hasattr(os, "geteuid") and directory_stat.st_uid != os.geteuid():
            raise BeatTrackerError("private Beat This checkpoint directory has an unexpected owner")

        output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        output_flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
        output_flags |= getattr(os, "O_NOFOLLOW", 0)
        output_descriptor = os.open(snapshot_path, output_flags, 0o600)
        digest = hashlib.sha256()
        copied_bytes = 0
        os.lseek(original_descriptor, 0, os.SEEK_SET)
        while True:
            block = os.read(original_descriptor, 1024 * 1024)
            if not block:
                break
            digest.update(block)
            copied_bytes += len(block)
            _write_all(output_descriptor, block)
        os.fsync(output_descriptor)
        os.fchmod(output_descriptor, 0o400)
        os.close(output_descriptor)
        output_descriptor = None

        actual_sha256 = digest.hexdigest()
        if copied_bytes != original_identity.size:
            raise BeatTrackerError("Beat This checkpoint changed while it was being snapshotted")
        _verify_bound_checkpoint(
            source.path,
            original_descriptor,
            original_identity,
            expected_sha256=actual_sha256,
            label="Beat This checkpoint source after snapshot copy",
        )
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            raise BeatTrackerError(
                "Beat This checkpoint hash does not match the pinned expected hash"
            )

        snapshot_descriptor, snapshot_identity = _open_bound_regular_file(
            snapshot_path, label="private Beat This checkpoint snapshot"
        )
        if stat.S_IMODE(snapshot_identity.mode) != 0o400:
            raise BeatTrackerError("private Beat This checkpoint snapshot is not mode 0400")
        if hasattr(os, "geteuid"):
            snapshot_stat = snapshot_path.stat(follow_symlinks=False)
            if snapshot_stat.st_uid != os.geteuid():
                raise BeatTrackerError(
                    "private Beat This checkpoint snapshot has an unexpected owner"
                )
        pinned = _PinnedCheckpoint(
            source=source,
            original_descriptor=original_descriptor,
            original_identity=original_identity,
            snapshot_path=snapshot_path,
            snapshot_descriptor=snapshot_descriptor,
            snapshot_identity=snapshot_identity,
            sha256=actual_sha256,
        )
        pinned.verify(phase="model load")
        yield pinned
    finally:
        if output_descriptor is not None:
            os.close(output_descriptor)
        if snapshot_descriptor is not None:
            os.close(snapshot_descriptor)
        os.close(original_descriptor)
        if temporary_root is not None:
            shutil.rmtree(temporary_root, ignore_errors=True)


def _artifact(path: Path, artifact_dir: Path) -> AnalysisArtifact:
    try:
        relative = path.resolve().relative_to(artifact_dir.resolve())
    except ValueError as exc:
        raise BeatTrackerError("analysis artifact escaped its artifact directory") from exc
    return AnalysisArtifact(
        path=relative.as_posix(),
        bytes=path.stat().st_size,
        sha256=_sha256_file(path),
    )


def _validated_events(
    values: Sequence[float], *, label: str, duration_seconds: float
) -> tuple[float, ...]:
    result = tuple(float(value) for value in values)
    previous = -math.inf
    for index, value in enumerate(result):
        if not math.isfinite(value) or value < 0 or value > duration_seconds + 1e-6:
            raise BeatTrackerError(f"{label}[{index}] falls outside the reference timeline")
        if value <= previous:
            raise BeatTrackerError(f"{label} must be strictly increasing")
        previous = value
    return result


def _emit(
    callback: EventCallback | None,
    stage: str,
    status: str,
    **data: object,
) -> None:
    if callback is not None:
        callback(stage, status, data)


@contextmanager
def _verified_signal(
    reference: ReferenceResult | CanonicalReferenceView,
    numpy_module: Any,
) -> Iterator[Any]:
    """Memory-map a private, hash-verified snapshot rather than a mutable path."""

    try:
        with open_verified_reference_stream(reference) as stream:
            signal = numpy_module.memmap(
                stream,
                dtype="<f4",
                mode="r",
                offset=reference.audio_data_offset_bytes,
                shape=(reference.frames, reference.channels),
            )
            try:
                if not numpy_module.isfinite(signal).all():
                    raise BeatTrackerError("canonical reference contains NaN or infinity")
                yield signal
            finally:
                memory_map = getattr(signal, "_mmap", None)
                if memory_map is not None:
                    memory_map.close()
    except ReferenceError as exc:
        raise BeatTrackerError(f"canonical reference failed integrity validation: {exc}") from exc


class BeatThisAdapter:
    """Beat This 1.1 adapter that bypasses unreliable compressed-audio loaders.

    The adapter verifies and snapshots the canonical little-endian float32
    reference, memory-maps that anonymous snapshot, and calls Beat This's signal
    API once for the complete timeline. It uses the minimal postprocessor and
    never enables the optional madmom DBN.
    """

    def __init__(
        self,
        *,
        checkpoint: str = "final0",
        expected_checkpoint_sha256: str | None = None,
        device: str = "cpu",
        float16: bool = False,
    ) -> None:
        self.checkpoint = checkpoint
        self.expected_checkpoint_sha256 = expected_checkpoint_sha256
        self.device = device
        self.float16 = float16

    def analyze(self, reference: ReferenceResult, artifact_dir: Path) -> BeatAnalysis:
        expected_checkpoint_sha256 = _validate_expected_checkpoint_sha256(
            self.expected_checkpoint_sha256
        )
        try:
            import numpy as np
            import torch
        except ImportError as exc:
            raise BeatTrackerError(
                "Beat This analysis dependencies are missing; install the 'analysis' extra"
            ) from exc

        checkpoint_source = _resolve_checkpoint_source(self.checkpoint, torch)
        artifact_dir.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        with _pinned_checkpoint(
            checkpoint_source,
            expected_sha256=expected_checkpoint_sha256,
        ) as pinned_checkpoint:
            # Importing Beat This is safe before this point, but delaying it makes
            # the security boundary explicit: no model-loading entrypoint exists
            # until the checkpoint bytes match the operator-pinned digest.
            try:
                from beat_this.inference import Audio2Frames
                from beat_this.model.postprocessor import Postprocessor
            except ImportError as exc:
                raise BeatTrackerError(
                    "Beat This analysis dependencies are missing; install the 'analysis' extra"
                ) from exc

            with _verified_signal(reference, np) as signal:
                frame_analyzer = Audio2Frames(
                    checkpoint_path=str(pinned_checkpoint.snapshot_path),
                    device=self.device,
                    float16=self.float16,
                )
                pinned_checkpoint.verify(phase="model initialization")

                beat_logits, downbeat_logits = frame_analyzer(signal, reference.sample_rate)
                pinned_checkpoint.verify(phase="inference")
                beats, downbeats = Postprocessor(type="minimal", fps=50)(
                    beat_logits, downbeat_logits
                )
            checkpoint_sha256 = pinned_checkpoint.sha256
            checkpoint_provenance = pinned_checkpoint.provenance()
        elapsed = time.monotonic() - started
        logits_path = artifact_dir / "beat-this-logits.npy"
        temp_path = artifact_dir / ".beat-this-logits.npy.tmp"
        with temp_path.open("wb") as stream:
            np.save(
                stream,
                np.vstack(
                    [beat_logits.detach().cpu().numpy(), downbeat_logits.detach().cpu().numpy()]
                ).astype("<f4", copy=False),
                allow_pickle=False,
            )
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, logits_path)

        duration = reference.frames / reference.sample_rate
        beat_values = _validated_events(beats, label="beats_seconds", duration_seconds=duration)
        downbeat_values = _validated_events(
            downbeats, label="downbeats_seconds", duration_seconds=duration
        )
        if not beat_values:
            raise BeatTrackerError("Beat This did not detect any beats")
        if not downbeat_values:
            raise BeatTrackerError("Beat This did not detect any downbeats")
        return BeatAnalysis(
            analyzer="beat-this",
            package_version=importlib.metadata.version("beat-this"),
            model=checkpoint_source.model_label,
            checkpoint_sha256=checkpoint_sha256,
            resolution_hz=50.0,
            reference_sha256=reference.sha256,
            reference_frames=reference.frames,
            reference_sample_rate=reference.sample_rate,
            beats_seconds=beat_values,
            downbeats_seconds=downbeat_values,
            elapsed_seconds=elapsed,
            artifacts=(_artifact(logits_path, artifact_dir),),
            diagnostics={
                "postprocessor": "minimal",
                "dbn_enabled": False,
                "device": self.device,
                "float16": self.float16,
                "torch_version": str(torch.__version__),
                "numpy_version": str(np.__version__),
                "logits_are_calibrated_confidence": False,
                "checkpoint_provenance": checkpoint_provenance,
            },
        )


class LibrosaDiagnostic:
    """Independent diagnostic that never replaces Beat This results."""

    name = "librosa"

    def __init__(self, *, sample_rate: int = 22_050, hop_length: int = 512) -> None:
        self.sample_rate = sample_rate
        self.hop_length = hop_length

    def analyze(
        self,
        reference: ReferenceResult | CanonicalReferenceView,
        artifact_dir: Path,
    ) -> Mapping[str, object]:
        try:
            import librosa
            import numpy as np
        except ImportError as exc:
            raise BeatTrackerError(
                "librosa diagnostic dependencies are missing; install the 'analysis' extra"
            ) from exc

        with _verified_signal(reference, np) as source:
            mono = np.asarray(source.mean(axis=1), dtype=np.float32)
        if reference.sample_rate != self.sample_rate:
            mono = librosa.resample(mono, orig_sr=reference.sample_rate, target_sr=self.sample_rate)
        onset = librosa.onset.onset_strength(
            y=mono, sr=self.sample_rate, hop_length=self.hop_length
        )
        tempo_curve = librosa.feature.tempo(
            onset_envelope=onset,
            sr=self.sample_rate,
            hop_length=self.hop_length,
            aggregate=None,
        )
        _, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset,
            sr=self.sample_rate,
            hop_length=self.hop_length,
            sparse=True,
            trim=True,
        )
        beat_times = librosa.frames_to_time(
            beat_frames, sr=self.sample_rate, hop_length=self.hop_length
        )
        artifact_dir.mkdir(parents=True, exist_ok=True)
        curve_path = artifact_dir / "librosa-dynamic-tempo.npy"
        temp_path = artifact_dir / ".librosa-dynamic-tempo.npy.tmp"
        with temp_path.open("wb") as stream:
            np.save(stream, np.asarray(tempo_curve, dtype="<f4"), allow_pickle=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_path, curve_path)
        return {
            "analyzer": "librosa",
            "package_version": importlib.metadata.version("librosa"),
            "numpy_version": str(np.__version__),
            "role": "diagnostic-only",
            "hop_length": self.hop_length,
            "sample_rate": self.sample_rate,
            "beats_seconds": [float(value) for value in beat_times],
            "dynamic_tempo_median_bpm": (
                float(np.median(tempo_curve)) if len(tempo_curve) else None
            ),
            "artifact": _artifact(curve_path, artifact_dir).to_dict(),
            "may_replace_primary": False,
        }


class LibrosaDrumStemDiagnostic(LibrosaDiagnostic):
    """Librosa diagnostic reserved for the approved canonical drum stem."""

    name = "librosa-drum-stem"


def run_diagnostic_analysis(
    reference: ReferenceResult | CanonicalReferenceView,
    diagnostic: DiagnosticAnalyzer,
    *,
    artifact_dir: str | os.PathLike[str],
    event_stage: str = "diagnostic-analysis",
    reference_provenance: Mapping[str, object] | None = None,
    event_callback: EventCallback | None = None,
) -> dict[str, object]:
    """Run one non-authoritative diagnostic with a complete event lifecycle."""

    if not event_stage:
        raise BeatTrackerError("diagnostic event_stage must be non-empty")
    provenance = dict(reference_provenance or {})
    event_details: dict[str, object] = {"analyzer": diagnostic.name}
    if provenance:
        event_details["reference"] = provenance
    _emit(
        event_callback,
        event_stage,
        "started",
        elapsed_seconds=0.0,
        progress_kind="indeterminate",
        **event_details,
    )
    started = time.monotonic()
    try:
        result = dict(diagnostic.analyze(reference, Path(artifact_dir)))
    except Exception as exc:  # diagnostics can never replace or invalidate primary analysis
        result = {
            "status": "failed",
            "error": str(exc),
            "role": "diagnostic-only",
            "may_replace_primary": False,
        }
        if provenance:
            result["reference"] = provenance
        _emit(
            event_callback,
            event_stage,
            "failed",
            elapsed_seconds=time.monotonic() - started,
            error=str(exc),
            **event_details,
        )
        return result

    result["status"] = "completed"
    result["may_replace_primary"] = False
    if provenance:
        result["reference"] = provenance
    _emit(
        event_callback,
        event_stage,
        "completed",
        elapsed_seconds=time.monotonic() - started,
        **event_details,
    )
    return result


def analyze_reference(
    reference: ReferenceResult,
    analyzer: Analyzer,
    *,
    artifact_dir: str | os.PathLike[str],
    diagnostic: DiagnosticAnalyzer | None = None,
    event_callback: EventCallback | None = None,
) -> BeatAnalysis:
    """Run primary continuous analysis with honest stage-level events."""

    destination = Path(artifact_dir)
    _emit(
        event_callback,
        "analyzing",
        "started",
        elapsed_seconds=0.0,
        progress_kind="indeterminate",
        analyzer=type(analyzer).__name__,
    )
    started = time.monotonic()
    try:
        primary = analyzer.analyze(reference, destination)
        duration = reference.frames / reference.sample_rate
        beats = _validated_events(
            primary.beats_seconds, label="beats_seconds", duration_seconds=duration
        )
        downbeats = _validated_events(
            primary.downbeats_seconds, label="downbeats_seconds", duration_seconds=duration
        )
        if not beats or not downbeats:
            raise BeatTrackerError("analysis must provide both beats and downbeats")
        diagnostics = dict(primary.diagnostics or {})
        if diagnostic is not None:
            diagnostics[diagnostic.name] = run_diagnostic_analysis(
                reference,
                diagnostic,
                artifact_dir=destination / diagnostic.name,
                reference_provenance={
                    "kind": "shared-reference",
                    "sha256": reference.sha256,
                    "frames": reference.frames,
                    "sample_rate": reference.sample_rate,
                    "channels": reference.channels,
                },
                event_callback=event_callback,
            )
        result = BeatAnalysis(
            analyzer=primary.analyzer,
            package_version=primary.package_version,
            model=primary.model,
            checkpoint_sha256=primary.checkpoint_sha256,
            resolution_hz=primary.resolution_hz,
            reference_sha256=primary.reference_sha256,
            reference_frames=primary.reference_frames,
            reference_sample_rate=primary.reference_sample_rate,
            beats_seconds=beats,
            downbeats_seconds=downbeats,
            elapsed_seconds=primary.elapsed_seconds,
            artifacts=primary.artifacts,
            diagnostics=diagnostics,
        )
    except Exception as exc:
        _emit(
            event_callback,
            "analyzing",
            "failed",
            elapsed_seconds=time.monotonic() - started,
            error=str(exc),
        )
        raise
    _emit(
        event_callback,
        "analyzing",
        "completed",
        elapsed_seconds=time.monotonic() - started,
        beat_count=len(result.beats_seconds),
        downbeat_count=len(result.downbeats_seconds),
    )
    return result


def create_click_audition(
    reference: ReferenceResult,
    beats_seconds: Sequence[float],
    downbeats_seconds: Sequence[float],
    output_path: str | os.PathLike[str],
    *,
    event_callback: EventCallback | None = None,
    block_frames: int = 65_536,
) -> Path:
    """Overlay an audible metronome on the analyzed reference for Gate B.

    This is a derivative audition file only.  It never replaces the canonical
    reference or any source stem.  High clicks identify candidate downbeats.
    """

    if block_frames <= 0:
        raise BeatTrackerError("block_frames must be positive")
    duration = reference.frames / reference.sample_rate
    beats = _validated_events(beats_seconds, label="beats_seconds", duration_seconds=duration)
    downbeats = _validated_events(
        downbeats_seconds, label="downbeats_seconds", duration_seconds=duration
    )
    if not beats:
        raise BeatTrackerError("cannot create a click audition without beats")
    destination = Path(output_path)
    if destination.exists() or destination.resolve() == reference.output_path.resolve():
        raise BeatTrackerError("click audition cannot overwrite an existing or source artifact")
    destination.parent.mkdir(parents=True, exist_ok=True)
    downbeat_frames = {round(value * reference.sample_rate) for value in downbeats}
    events = [
        (
            round(value * reference.sample_rate),
            round(value * reference.sample_rate) in downbeat_frames,
        )
        for value in beats
    ]
    click_frames = max(1, round(0.035 * reference.sample_rate))
    audio_bytes = reference.frames * reference.channels * 4
    with tempfile.NamedTemporaryFile(
        mode="w+b", prefix=f".{destination.name}.tmp-", dir=destination.parent, delete=False
    ) as temporary_handle:
        temporary = Path(temporary_handle.name)
    completed = 0
    event_index = 0
    _emit(
        event_callback,
        "building-click-audition",
        "started",
        completed_frames=0,
        total_frames=reference.frames,
    )
    try:
        with reference.output_path.open("rb") as source, temporary.open("wb") as output:
            source.seek(reference.audio_data_offset_bytes)
            output.write(
                _wav_header(
                    sample_rate=reference.sample_rate,
                    channels=reference.channels,
                    data_bytes=audio_bytes,
                )
            )
            while completed < reference.frames:
                frame_count = min(block_frames, reference.frames - completed)
                raw = source.read(frame_count * reference.channels * 4)
                if len(raw) != frame_count * reference.channels * 4:
                    raise BeatTrackerError("reference truncated while creating click audition")
                samples = _read_float32(raw)
                block_end = completed + frame_count
                while (
                    event_index < len(events) and events[event_index][0] + click_frames <= completed
                ):
                    event_index += 1
                scan_index = event_index
                while scan_index < len(events) and events[scan_index][0] < block_end:
                    click_start, is_downbeat = events[scan_index]
                    start_frame = max(completed, click_start)
                    end_frame = min(block_end, click_start + click_frames)
                    frequency = 1760.0 if is_downbeat else 1040.0
                    amplitude = 0.25 if is_downbeat else 0.15
                    for absolute_frame in range(start_frame, end_frame):
                        click_offset = absolute_frame - click_start
                        phase = 2 * math.pi * frequency * click_offset / reference.sample_rate
                        envelope = (1 - click_offset / click_frames) ** 3
                        click = amplitude * envelope * math.cos(phase)
                        sample_start = (absolute_frame - completed) * reference.channels
                        for channel in range(reference.channels):
                            sample_index = sample_start + channel
                            samples[sample_index] = max(
                                -0.999,
                                min(0.999, float(samples[sample_index]) + click),
                            )
                    scan_index += 1
                output.write(_little_endian_bytes(samples))
                completed = block_end
                _emit(
                    event_callback,
                    "building-click-audition",
                    "progress",
                    completed_frames=completed,
                    total_frames=reference.frames,
                )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        _emit(
            event_callback,
            "building-click-audition",
            "failed",
            completed_frames=completed,
            total_frames=reference.frames,
            error=str(exc),
        )
        raise
    _emit(
        event_callback,
        "building-click-audition",
        "completed",
        completed_frames=reference.frames,
        total_frames=reference.frames,
        output_bytes=destination.stat().st_size,
    )
    return destination
