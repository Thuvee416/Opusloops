"""Deterministic reference construction from canonical float32 WAVE stems."""

from __future__ import annotations

import hashlib
import hmac
import math
import os
import shutil
import stat
import struct
import sys
import tempfile
from array import array
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import BinaryIO

EventCallback = Callable[[str, str, dict[str, object]], None]


class ReferenceError(ValueError):
    """Raised when approved stems cannot form one trustworthy reference."""


@dataclass(frozen=True)
class ReferenceStem:
    asset_id: str
    output_path: Path
    sample_rate: int
    channels: int
    frames: int
    gain_db: float = 0.0
    timeline_offset_frames: int = 0
    sha256: str | None = None
    canonical_format: str | None = None

    @classmethod
    def from_object(
        cls,
        value: object,
        *,
        asset_id: str | None = None,
        gain_db: float = 0.0,
    ) -> ReferenceStem:
        """Accept CanonicalAudio dataclasses or equivalent mappings defensively."""

        def field(name: str, default: object | None = None) -> object | None:
            if isinstance(value, Mapping):
                return value.get(name, default)
            return getattr(value, name, default)

        resolved_id = asset_id or field("asset_id") or field("source_name")
        path = field("output_path") or field("path")
        if not isinstance(resolved_id, str) or not resolved_id:
            raise ReferenceError("canonical stem is missing an asset_id")
        if not isinstance(path, str | os.PathLike):
            raise ReferenceError(f"canonical stem {resolved_id!r} is missing output_path")
        try:
            return cls(
                asset_id=resolved_id,
                output_path=Path(path),
                sample_rate=int(field("sample_rate") or 0),
                channels=int(field("channels") or 0),
                frames=int(field("frames") or 0),
                gain_db=float(gain_db),
                timeline_offset_frames=int(field("timeline_offset_frames") or 0),
                sha256=field("sha256") if isinstance(field("sha256"), str) else None,
                canonical_format=(
                    str(field("canonical_format"))
                    if isinstance(field("canonical_format"), str)
                    else None
                ),
            )
        except (TypeError, ValueError) as exc:
            raise ReferenceError(f"invalid canonical stem metadata for {resolved_id!r}") from exc


@dataclass(frozen=True)
class ReferenceResult:
    algorithm_version: str
    method: str
    output_path: Path
    sample_rate: int
    channels: int
    frames: int
    timeline_offset_frames: int
    bytes: int
    audio_data_bytes: int
    audio_data_offset_bytes: int
    canonical_format: str
    sha256: str
    selected_asset_ids: tuple[str, ...]
    gain_db_by_asset: dict[str, float]
    sum_headroom_db: float
    normalize_peak_dbfs: float
    pre_normalization_peak: float
    normalization_gain: float
    output_peak: float
    input_sha256_by_asset: dict[str, str] = field(default_factory=dict)

    def to_dict(self, *, relative_to: Path | None = None) -> dict[str, object]:
        payload = asdict(self)
        path = self.output_path
        if relative_to is not None:
            try:
                path = path.resolve().relative_to(relative_to.resolve())
            except ValueError as exc:
                raise ReferenceError("reference output is outside the run directory") from exc
        payload["output_path"] = path.as_posix()
        payload["selected_asset_ids"] = list(self.selected_asset_ids)
        return payload

    @classmethod
    def from_dict(
        cls, payload: Mapping[str, object], *, relative_to: Path | None = None
    ) -> ReferenceResult:
        path = Path(str(payload["output_path"]))
        if relative_to is not None:
            root = relative_to.resolve()
            try:
                path = (root / path).resolve(strict=True)
                path.relative_to(root)
            except (OSError, ValueError) as exc:
                raise ReferenceError("reference artifact path escapes or is missing") from exc
        return cls(
            algorithm_version=str(payload["algorithm_version"]),
            method=str(payload["method"]),
            output_path=path,
            sample_rate=int(payload["sample_rate"]),
            channels=int(payload["channels"]),
            frames=int(payload["frames"]),
            timeline_offset_frames=int(payload.get("timeline_offset_frames", 0)),
            bytes=int(payload["bytes"]),
            audio_data_bytes=int(payload["audio_data_bytes"]),
            audio_data_offset_bytes=int(payload["audio_data_offset_bytes"]),
            canonical_format=str(payload["canonical_format"]),
            sha256=str(payload["sha256"]),
            selected_asset_ids=tuple(str(value) for value in payload["selected_asset_ids"]),
            gain_db_by_asset={
                str(key): float(value) for key, value in dict(payload["gain_db_by_asset"]).items()
            },
            sum_headroom_db=float(payload["sum_headroom_db"]),
            normalize_peak_dbfs=float(payload["normalize_peak_dbfs"]),
            pre_normalization_peak=float(payload["pre_normalization_peak"]),
            normalization_gain=float(payload["normalization_gain"]),
            output_peak=float(payload["output_peak"]),
            input_sha256_by_asset={
                str(key): str(value)
                for key, value in dict(payload.get("input_sha256_by_asset", {})).items()
            },
        )


@dataclass(frozen=True)
class CanonicalReferenceView:
    """Read-only analysis view over one hash-verified canonical stem."""

    asset_id: str
    output_path: Path
    sample_rate: int
    channels: int
    frames: int
    timeline_offset_frames: int
    bytes: int
    audio_data_bytes: int
    audio_data_offset_bytes: int
    canonical_format: str
    sha256: str


def _emit(
    callback: EventCallback | None,
    stage: str,
    status: str,
    **data: object,
) -> None:
    if callback is not None:
        callback(stage, status, data)


def _db_to_gain(db: float, label: str) -> float:
    if not math.isfinite(db):
        raise ReferenceError(f"{label} must be finite")
    return 10.0 ** (db / 20.0)


def _read_float32(raw: bytes) -> array:
    if len(raw) % 4:
        raise ReferenceError("canonical PCM ended mid-sample")
    values = array("f")
    values.frombytes(raw)
    if values.itemsize != 4:
        raise ReferenceError("this Python runtime does not provide 32-bit float arrays")
    if sys.byteorder != "little":
        values.byteswap()
    return values


def _little_endian_bytes(values: array) -> bytes:
    if sys.byteorder == "little":
        return values.tobytes()
    copy = array("f", values)
    copy.byteswap()
    return copy.tobytes()


_COPY_CHUNK_BYTES = 1024 * 1024


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _valid_sha256(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _open_regular_nofollow(path: Path, *, label: str) -> BinaryIO:
    if path.is_symlink():
        raise ReferenceError(f"{label} must be a regular file, not a symlink")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ReferenceError(f"cannot safely open {label}: {exc}") from exc
    try:
        opened_stat = os.fstat(descriptor)
        path_stat = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(opened_stat.st_mode) or not stat.S_ISREG(path_stat.st_mode):
            raise ReferenceError(f"{label} must be a regular file, not a symlink")
        if (opened_stat.st_dev, opened_stat.st_ino) != (path_stat.st_dev, path_stat.st_ino):
            raise ReferenceError(f"{label} changed while it was being opened")
        return os.fdopen(descriptor, "rb")
    except Exception:
        os.close(descriptor)
        raise


def _hash_stream(stream: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    stream.seek(0)
    while block := stream.read(_COPY_CHUNK_BYTES):
        digest.update(block)
        total += len(block)
    return digest.hexdigest(), total


@dataclass(frozen=True)
class _VerifiedSnapshot:
    stream: BinaryIO
    sha256: str
    bytes: int
    resolved_source_path: Path


@contextmanager
def _verified_path_snapshot(
    path: Path,
    *,
    expected_sha256: str | None,
    label: str,
    temp_dir: Path | None = None,
) -> Iterator[_VerifiedSnapshot]:
    """Copy one no-follow descriptor into an anonymous, verified snapshot."""

    if expected_sha256 is not None and not _valid_sha256(expected_sha256):
        raise ReferenceError(f"{label} has an invalid approved SHA-256 digest")
    with (
        _open_regular_nofollow(path, label=label) as source,
        tempfile.TemporaryFile(mode="w+b", dir=temp_dir) as snapshot,
    ):
        initial_stat = os.fstat(source.fileno())
        digest = hashlib.sha256()
        copied = 0
        while block := source.read(_COPY_CHUNK_BYTES):
            snapshot.write(block)
            digest.update(block)
            copied += len(block)
        final_stat = os.fstat(source.fileno())
        try:
            final_path_stat = path.stat(follow_symlinks=False)
        except OSError as exc:
            raise ReferenceError(f"{label} changed while it was being verified") from exc
        if (
            _stat_identity(initial_stat) != _stat_identity(final_stat)
            or (final_stat.st_dev, final_stat.st_ino)
            != (final_path_stat.st_dev, final_path_stat.st_ino)
            or copied != initial_stat.st_size
        ):
            raise ReferenceError(f"{label} changed while it was being verified")
        actual_sha256 = digest.hexdigest()
        if expected_sha256 is not None and not hmac.compare_digest(actual_sha256, expected_sha256):
            raise ReferenceError(f"{label} hash changed from its approved SHA-256")
        try:
            resolved_source_path = path.resolve(strict=True)
            resolved_stat = resolved_source_path.stat(follow_symlinks=False)
        except OSError as exc:
            raise ReferenceError(f"{label} changed while it was being verified") from exc
        if (resolved_stat.st_dev, resolved_stat.st_ino) != (
            final_stat.st_dev,
            final_stat.st_ino,
        ):
            raise ReferenceError(f"{label} changed while it was being verified")
        snapshot.flush()
        os.fsync(snapshot.fileno())
        snapshot.seek(0)
        yield _VerifiedSnapshot(
            stream=snapshot,
            sha256=actual_sha256,
            bytes=copied,
            resolved_source_path=resolved_source_path,
        )
        try:
            consumed_stat = os.fstat(source.fileno())
            consumed_path_stat = path.stat(follow_symlinks=False)
        except OSError as exc:
            raise ReferenceError(f"{label} changed while its snapshot was consumed") from exc
        if _stat_identity(initial_stat) != _stat_identity(consumed_stat) or (
            consumed_stat.st_dev,
            consumed_stat.st_ino,
        ) != (consumed_path_stat.st_dev, consumed_path_stat.st_ino):
            raise ReferenceError(f"{label} changed while its snapshot was consumed")


def _mix_block(
    blocks: Sequence[bytes],
    gains: Sequence[float],
    global_gain: float,
) -> tuple[array, float]:
    arrays = [_read_float32(block) for block in blocks]
    if not arrays or any(len(values) != len(arrays[0]) for values in arrays):
        raise ReferenceError("canonical PCM block lengths disagree")
    mixed = array("f", [0.0]) * len(arrays[0])
    peak = 0.0
    # Accumulate in Python double precision, then commit controlled float32.
    for sample_index in range(len(mixed)):
        sample = sum(
            float(values[sample_index]) * gain for values, gain in zip(arrays, gains, strict=True)
        )
        sample *= global_gain
        if not math.isfinite(sample):
            raise ReferenceError("reference sum produced NaN or infinity")
        mixed[sample_index] = sample
        peak = max(peak, abs(sample))
    return mixed, peak


def _scale_block(raw: bytes, gain: float) -> tuple[array, float]:
    values = _read_float32(raw)
    peak = 0.0
    for index, value in enumerate(values):
        scaled = float(value) * gain
        if not math.isfinite(scaled):
            raise ReferenceError("reference normalization produced NaN or infinity")
        values[index] = scaled
        peak = max(peak, abs(scaled))
    return values, peak


@dataclass(frozen=True)
class _PcmLayout:
    data_offset: int
    data_bytes: int
    sample_rate: int
    channels: int
    frames: int
    canonical_format: str


def _wav_layout_stream(stream: BinaryIO, *, file_bytes: int, label: str) -> _PcmLayout:
    stream.seek(0)
    if stream.read(4) != b"RIFF":
        raise ReferenceError(f"canonical WAV is not little-endian RIFF: {label}")
    stream.read(4)
    if stream.read(4) != b"WAVE":
        raise ReferenceError(f"canonical WAV has an invalid form type: {label}")
    audio_format: int | None = None
    channels: int | None = None
    sample_rate: int | None = None
    bits_per_sample: int | None = None
    block_align: int | None = None
    data_offset: int | None = None
    data_bytes: int | None = None
    while stream.tell() + 8 <= file_bytes:
        chunk_id = stream.read(4)
        chunk_size_raw = stream.read(4)
        if len(chunk_id) != 4 or len(chunk_size_raw) != 4:
            break
        chunk_size = struct.unpack("<I", chunk_size_raw)[0]
        chunk_start = stream.tell()
        padded_chunk_end = chunk_start + chunk_size + (chunk_size & 1)
        if chunk_start + chunk_size > file_bytes or padded_chunk_end > file_bytes:
            raise ReferenceError(f"canonical WAV chunk exceeds file: {label}")
        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise ReferenceError(f"canonical WAV fmt chunk is too short: {label}")
            fmt = stream.read(16)
            (
                audio_format,
                channels,
                sample_rate,
                _,
                block_align,
                bits_per_sample,
            ) = struct.unpack("<HHIIHH", fmt)
            # WAVE_FORMAT_EXTENSIBLE stores the real IEEE-float format in
            # the first two bytes of its subformat GUID.
            if audio_format == 0xFFFE and chunk_size >= 40:
                extension = stream.read(24)
                if len(extension) == 24:
                    audio_format = struct.unpack("<H", extension[8:10])[0]
        elif chunk_id == b"data":
            if data_offset is not None:
                raise ReferenceError(f"canonical WAV has multiple data chunks: {label}")
            data_offset = chunk_start
            data_bytes = chunk_size
        stream.seek(padded_chunk_end)

    if None in {audio_format, channels, sample_rate, bits_per_sample, block_align}:
        raise ReferenceError(f"canonical WAV is missing its fmt chunk: {label}")
    if data_offset is None or data_bytes is None:
        raise ReferenceError(f"canonical WAV is missing its data chunk: {label}")
    if audio_format != 3 or bits_per_sample != 32:
        raise ReferenceError(f"canonical WAV must contain IEEE float32 PCM: {label}")
    assert channels is not None and sample_rate is not None and block_align is not None
    if block_align != channels * 4 or data_bytes % block_align:
        raise ReferenceError(f"canonical WAV has invalid block alignment: {label}")
    return _PcmLayout(
        data_offset=data_offset,
        data_bytes=data_bytes,
        sample_rate=sample_rate,
        channels=channels,
        frames=data_bytes // block_align,
        canonical_format="wav-f32le-interleaved",
    )


def _wav_layout(path: Path) -> _PcmLayout:
    with _open_regular_nofollow(path, label=f"canonical WAV {path.name!r}") as stream:
        initial_stat = os.fstat(stream.fileno())
        layout = _wav_layout_stream(stream, file_bytes=initial_stat.st_size, label=path.name)
        if _stat_identity(initial_stat) != _stat_identity(os.fstat(stream.fileno())):
            raise ReferenceError(f"canonical WAV changed while being parsed: {path.name}")
        return layout


def _stem_layout(stem: ReferenceStem, stream: BinaryIO, *, file_bytes: int) -> _PcmLayout:
    stream.seek(0)
    signature = stream.read(4)
    if signature == b"RIFF" or stem.canonical_format in {
        "wav-f32le-interleaved",
        "wav-float32",
    }:
        return _wav_layout_stream(stream, file_bytes=file_bytes, label=stem.output_path.name)
    data_bytes = stem.frames * stem.channels * 4
    if file_bytes != data_bytes:
        raise ReferenceError(f"canonical PCM byte count mismatch for asset {stem.asset_id!r}")
    return _PcmLayout(
        data_offset=0,
        data_bytes=data_bytes,
        sample_rate=stem.sample_rate,
        channels=stem.channels,
        frames=stem.frames,
        canonical_format="f32le-interleaved",
    )


def _wav_header(*, sample_rate: int, channels: int, data_bytes: int) -> bytes:
    if data_bytes > 0xFFFFFFFF - 36:
        raise ReferenceError("reference is too large for a RIFF WAV container")
    block_align = channels * 4
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", 36 + data_bytes),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH",
                16,
                3,
                channels,
                sample_rate,
                sample_rate * block_align,
                block_align,
                32,
            ),
            b"data",
            struct.pack("<I", data_bytes),
        )
    )


def _validate_stem_metadata(stems: Sequence[ReferenceStem], method: str) -> None:
    if method not in {"full-mix", "selected-stem-sum"}:
        raise ReferenceError(f"unsupported reference method: {method}")
    if not stems:
        raise ReferenceError("at least one approved stem is required")
    if method == "full-mix" and len(stems) != 1:
        raise ReferenceError("full-mix reference requires exactly one included asset")
    ids = [stem.asset_id for stem in stems]
    if len(ids) != len(set(ids)):
        raise ReferenceError("selected asset IDs must be unique")
    first = stems[0]
    if first.sample_rate <= 0 or first.channels <= 0 or first.frames <= 0:
        raise ReferenceError("canonical stem dimensions must be positive")
    for stem in stems:
        if stem.sample_rate != first.sample_rate:
            raise ReferenceError("selected stems do not share one sample rate")
        if stem.channels != first.channels:
            raise ReferenceError("selected stems do not share one channel layout")
        if stem.frames != first.frames:
            raise ReferenceError(
                "selected stems have unequal decoded frame counts; review required"
            )
        if stem.timeline_offset_frames != first.timeline_offset_frames:
            raise ReferenceError("selected stems have unequal timeline offsets; review required")


def _validate_stem_layout(stem: ReferenceStem, layout: _PcmLayout, file_bytes: int) -> None:
    if (
        layout.sample_rate != stem.sample_rate
        or layout.channels != stem.channels
        or layout.frames != stem.frames
    ):
        raise ReferenceError(f"canonical PCM metadata mismatch for {stem.asset_id!r}")
    if file_bytes < layout.data_offset + layout.data_bytes:
        raise ReferenceError(f"canonical PCM is truncated for {stem.asset_id!r}")


def view_canonical_stem(stem: ReferenceStem | object) -> CanonicalReferenceView:
    """Validate and expose a canonical WAV without modifying it."""

    canonical = stem if isinstance(stem, ReferenceStem) else ReferenceStem.from_object(stem)
    source = canonical.output_path
    if canonical.sha256 is None:
        raise ReferenceError(f"canonical WAV has no approved hash for asset {canonical.asset_id!r}")
    with _verified_path_snapshot(
        source,
        expected_sha256=canonical.sha256,
        label=f"canonical WAV for asset {canonical.asset_id!r}",
    ) as snapshot:
        layout = _stem_layout(canonical, snapshot.stream, file_bytes=snapshot.bytes)
        if layout.canonical_format != "wav-f32le-interleaved":
            raise ReferenceError("drum diagnostic requires canonical float32 WAV input")
        _validate_stem_layout(canonical, layout, snapshot.bytes)
        resolved_source_path = snapshot.resolved_source_path
        actual_sha256 = snapshot.sha256
        byte_length = snapshot.bytes
    return CanonicalReferenceView(
        asset_id=canonical.asset_id,
        output_path=resolved_source_path,
        sample_rate=layout.sample_rate,
        channels=layout.channels,
        frames=layout.frames,
        timeline_offset_frames=canonical.timeline_offset_frames,
        bytes=byte_length,
        audio_data_bytes=layout.data_bytes,
        audio_data_offset_bytes=layout.data_offset,
        canonical_format=layout.canonical_format,
        sha256=actual_sha256,
    )


@contextmanager
def open_verified_reference_stream(
    reference: ReferenceResult | CanonicalReferenceView,
) -> Iterator[BinaryIO]:
    """Yield an anonymous snapshot whose bytes match the declared reference hash."""

    if reference.frames <= 0 or reference.channels <= 0 or reference.sample_rate <= 0:
        raise ReferenceError("reference dimensions must be positive")
    expected_audio_bytes = reference.frames * reference.channels * 4
    if reference.audio_data_bytes != expected_audio_bytes:
        raise ReferenceError("reference byte count does not match canonical PCM metadata")
    if reference.audio_data_offset_bytes < 0:
        raise ReferenceError("reference audio offset cannot be negative")
    with _verified_path_snapshot(
        reference.output_path,
        expected_sha256=reference.sha256,
        label="canonical reference",
    ) as snapshot:
        if snapshot.bytes != reference.bytes:
            raise ReferenceError("canonical reference byte length changed")
        if reference.canonical_format == "wav-f32le-interleaved":
            layout = _wav_layout_stream(
                snapshot.stream,
                file_bytes=snapshot.bytes,
                label="canonical reference",
            )
        elif reference.canonical_format == "f32le-interleaved":
            layout = _PcmLayout(
                data_offset=0,
                data_bytes=snapshot.bytes,
                sample_rate=reference.sample_rate,
                channels=reference.channels,
                frames=reference.frames,
                canonical_format=reference.canonical_format,
            )
        else:
            raise ReferenceError("canonical reference has an unsupported format")
        if (
            layout.data_offset != reference.audio_data_offset_bytes
            or layout.data_bytes != reference.audio_data_bytes
            or layout.sample_rate != reference.sample_rate
            or layout.channels != reference.channels
            or layout.frames != reference.frames
        ):
            raise ReferenceError("canonical reference metadata does not match its bytes")
        snapshot.stream.seek(0)
        yield snapshot.stream


@dataclass(frozen=True)
class _ValidatedReferenceOutput:
    sha256: str
    bytes: int
    audio_data_bytes: int
    audio_data_offset_bytes: int
    canonical_format: str
    output_peak: float
    file_stat: os.stat_result


def _validate_staged_reference(
    stream: BinaryIO,
    *,
    output_as_wav: bool,
    sample_rate: int,
    channels: int,
    frames: int,
) -> _ValidatedReferenceOutput:
    """Validate and hash a complete private-stage output using its open descriptor."""

    stream.flush()
    os.fsync(stream.fileno())
    initial_stat = os.fstat(stream.fileno())
    if not stat.S_ISREG(initial_stat.st_mode):
        raise ReferenceError("staged reference output is not a regular file")
    audio_data_bytes = frames * channels * 4
    expected_bytes = audio_data_bytes + (44 if output_as_wav else 0)
    if initial_stat.st_size != expected_bytes:
        raise ReferenceError(
            "reference byte count mismatch: "
            f"expected {expected_bytes}, found {initial_stat.st_size}"
        )
    sha256, byte_length = _hash_stream(stream)
    if byte_length != expected_bytes:
        raise ReferenceError("staged reference changed while it was being hashed")

    if output_as_wav:
        layout = _wav_layout_stream(
            stream,
            file_bytes=byte_length,
            label="staged reference",
        )
    else:
        layout = _PcmLayout(
            data_offset=0,
            data_bytes=audio_data_bytes,
            sample_rate=sample_rate,
            channels=channels,
            frames=frames,
            canonical_format="f32le-interleaved",
        )
    if (
        layout.sample_rate != sample_rate
        or layout.channels != channels
        or layout.frames != frames
        or layout.data_bytes != audio_data_bytes
    ):
        raise ReferenceError("staged reference metadata does not match the requested output")

    stream.seek(layout.data_offset)
    remaining = layout.data_bytes
    output_peak = 0.0
    read_bytes = max(channels * 4, (_COPY_CHUNK_BYTES // (channels * 4)) * channels * 4)
    while remaining:
        raw = stream.read(min(read_bytes, remaining))
        if not raw:
            raise ReferenceError("staged reference is truncated")
        remaining -= len(raw)
        for sample in _read_float32(raw):
            if not math.isfinite(sample):
                raise ReferenceError("staged reference contains NaN or infinity")
            output_peak = max(output_peak, abs(float(sample)))

    final_stat = os.fstat(stream.fileno())
    if _stat_identity(initial_stat) != _stat_identity(final_stat):
        raise ReferenceError("staged reference changed during final validation")
    return _ValidatedReferenceOutput(
        sha256=sha256,
        bytes=byte_length,
        audio_data_bytes=layout.data_bytes,
        audio_data_offset_bytes=layout.data_offset,
        canonical_format=layout.canonical_format,
        output_peak=output_peak,
        file_stat=final_stat,
    )


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _unlink_if_owned(path: Path, expected: os.stat_result) -> None:
    try:
        current = path.stat(follow_symlinks=False)
    except OSError:
        return
    if (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino):
        path.unlink(missing_ok=True)


def _publish_no_replace(
    staged_path: Path,
    destination: Path,
    validated: _ValidatedReferenceOutput,
) -> os.stat_result:
    """Atomically publish a same-filesystem hard link without replacing a name."""

    try:
        os.link(staged_path, destination, follow_symlinks=False)
    except FileExistsError as exc:
        raise ReferenceError("reference output already exists; refusing to overwrite it") from exc
    except OSError as exc:
        raise ReferenceError(
            f"cannot atomically publish reference without overwrite: {exc}"
        ) from exc

    try:
        _fsync_directory(destination.parent)
        with _open_regular_nofollow(destination, label="published reference") as published:
            initial_stat = os.fstat(published.fileno())
            if (initial_stat.st_dev, initial_stat.st_ino) != (
                validated.file_stat.st_dev,
                validated.file_stat.st_ino,
            ):
                raise ReferenceError("published reference does not match the staged output")
            sha256, byte_length = _hash_stream(published)
            final_stat = os.fstat(published.fileno())
            if (
                _stat_identity(initial_stat) != _stat_identity(final_stat)
                or byte_length != validated.bytes
                or not hmac.compare_digest(sha256, validated.sha256)
            ):
                raise ReferenceError("published reference failed final integrity validation")
            return final_stat
    except Exception:
        _unlink_if_owned(destination, validated.file_stat)
        _fsync_directory(destination.parent)
        raise


def build_reference(
    stems: Iterable[ReferenceStem | object],
    output_path: str | os.PathLike[str],
    *,
    method: str = "selected-stem-sum",
    sum_headroom_db: float = -12.0,
    normalize_peak_dbfs: float = -3.0,
    block_frames: int = 65_536,
    event_callback: EventCallback | None = None,
) -> ReferenceResult:
    """Build a normalized reference without altering or individually normalizing stems.

    Production inputs are the little-endian interleaved float32 WAVE files
    emitted by ``decode_canonical``.  Headerless input remains supported only so
    tiny synthetic tests can exercise the sample math.  The approved per-stem
    gains preserve relative level; one global headroom gain is applied during
    summing, then the completed sum is normalized once to
    ``normalize_peak_dbfs``.
    """

    canonical = tuple(
        value if isinstance(value, ReferenceStem) else ReferenceStem.from_object(value)
        for value in stems
    )
    destination = Path(output_path)
    _validate_stem_metadata(canonical, method)
    if block_frames <= 0:
        raise ReferenceError("block_frames must be positive")
    if normalize_peak_dbfs > 0:
        raise ReferenceError("normalize_peak_dbfs cannot exceed 0 dBFS")
    if destination.exists() or destination.is_symlink():
        raise ReferenceError("reference output already exists; refusing to overwrite it")
    headroom_gain = _db_to_gain(sum_headroom_db, "sum_headroom_db")
    target_peak = _db_to_gain(normalize_peak_dbfs, "normalize_peak_dbfs")
    gains = [_db_to_gain(stem.gain_db, f"gain_db for {stem.asset_id}") for stem in canonical]
    sample_rate = canonical[0].sample_rate
    channels = canonical[0].channels
    frames = canonical[0].frames
    frame_bytes = channels * 4
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(
        tempfile.mkdtemp(prefix=f".{destination.name}.reference-", dir=destination.parent)
    )
    staged_output_path = staging_dir / "reference.partial"

    completed_frames = 0
    pre_peak = 0.0
    current_stage = "building-reference"
    published_stat: os.stat_result | None = None
    _emit(
        event_callback,
        "building-reference",
        "started",
        completed_frames=0,
        total_frames=frames,
        selected_files=len(canonical),
    )
    try:
        with ExitStack() as stack:
            snapshots: list[_VerifiedSnapshot] = []
            layouts: list[_PcmLayout] = []
            input_sha256_by_asset: dict[str, str] = {}
            for stem in canonical:
                snapshot = stack.enter_context(
                    _verified_path_snapshot(
                        stem.output_path,
                        expected_sha256=stem.sha256,
                        label=f"canonical PCM for asset {stem.asset_id!r}",
                        temp_dir=staging_dir,
                    )
                )
                layout = _stem_layout(stem, snapshot.stream, file_bytes=snapshot.bytes)
                _validate_stem_layout(stem, layout, snapshot.bytes)
                snapshots.append(snapshot)
                layouts.append(layout)
                input_sha256_by_asset[stem.asset_id] = snapshot.sha256

            summed = stack.enter_context(tempfile.TemporaryFile(mode="w+b", dir=staging_dir))
            for snapshot, layout in zip(snapshots, layouts, strict=True):
                snapshot.stream.seek(layout.data_offset)
            while completed_frames < frames:
                requested_frames = min(block_frames, frames - completed_frames)
                requested_bytes = requested_frames * frame_bytes
                blocks = [snapshot.stream.read(requested_bytes) for snapshot in snapshots]
                if any(len(block) != requested_bytes for block in blocks):
                    raise ReferenceError("canonical PCM was truncated while building reference")
                mixed, block_peak = _mix_block(blocks, gains, headroom_gain)
                summed.write(_little_endian_bytes(mixed))
                pre_peak = max(pre_peak, block_peak)
                completed_frames += requested_frames
                _emit(
                    event_callback,
                    "building-reference",
                    "progress",
                    completed_frames=completed_frames,
                    total_frames=frames,
                    selected_files=len(canonical),
                )
            summed.flush()
            os.fsync(summed.fileno())
            _emit(
                event_callback,
                "building-reference",
                "completed",
                completed_frames=frames,
                total_frames=frames,
                selected_files=len(canonical),
                pre_normalization_peak=pre_peak,
            )

            normalization_gain = target_peak / pre_peak if pre_peak > 0 else 1.0
            current_stage = "normalizing-reference"
            completed_frames = 0
            output_peak = 0.0
            _emit(
                event_callback,
                "normalizing-reference",
                "started",
                completed_frames=0,
                total_frames=frames,
            )
            output_as_wav = destination.suffix.casefold() == ".wav"
            output_header = (
                _wav_header(
                    sample_rate=sample_rate,
                    channels=channels,
                    data_bytes=frames * frame_bytes,
                )
                if output_as_wav
                else b""
            )
            flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
            if hasattr(os, "O_NOFOLLOW"):
                flags |= os.O_NOFOLLOW
            descriptor = os.open(staged_output_path, flags, 0o600)
            output = stack.enter_context(os.fdopen(descriptor, "w+b"))
            if output_header:
                output.write(output_header)
            summed.seek(0)
            while completed_frames < frames:
                requested_frames = min(block_frames, frames - completed_frames)
                requested_bytes = requested_frames * frame_bytes
                raw = summed.read(requested_bytes)
                if len(raw) != requested_bytes:
                    raise ReferenceError("intermediate reference sum was truncated")
                scaled, block_peak = _scale_block(raw, normalization_gain)
                output.write(_little_endian_bytes(scaled))
                output_peak = max(output_peak, block_peak)
                completed_frames += requested_frames
                _emit(
                    event_callback,
                    "normalizing-reference",
                    "progress",
                    completed_frames=completed_frames,
                    total_frames=frames,
                )

            validated = _validate_staged_reference(
                output,
                output_as_wav=output_as_wav,
                sample_rate=sample_rate,
                channels=channels,
                frames=frames,
            )
            published_stat = _publish_no_replace(staged_output_path, destination, validated)
            result = ReferenceResult(
                algorithm_version="opusloops.reference-sum.v1",
                method=method,
                output_path=destination,
                sample_rate=sample_rate,
                channels=channels,
                frames=frames,
                timeline_offset_frames=canonical[0].timeline_offset_frames,
                bytes=validated.bytes,
                sha256=validated.sha256,
                audio_data_bytes=validated.audio_data_bytes,
                audio_data_offset_bytes=validated.audio_data_offset_bytes,
                canonical_format=validated.canonical_format,
                selected_asset_ids=tuple(stem.asset_id for stem in canonical),
                gain_db_by_asset={stem.asset_id: stem.gain_db for stem in canonical},
                sum_headroom_db=float(sum_headroom_db),
                normalize_peak_dbfs=float(normalize_peak_dbfs),
                pre_normalization_peak=pre_peak,
                normalization_gain=normalization_gain,
                output_peak=validated.output_peak,
                input_sha256_by_asset=input_sha256_by_asset,
            )
    except Exception:
        if published_stat is not None:
            _unlink_if_owned(destination, published_stat)
            _fsync_directory(destination.parent)
        _emit(
            event_callback,
            current_stage,
            "failed",
            completed_frames=completed_frames,
            total_frames=frames,
        )
        raise
    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)

    _emit(
        event_callback,
        "normalizing-reference",
        "completed",
        completed_frames=frames,
        total_frames=frames,
        output_bytes=result.bytes,
        output_sha256=result.sha256,
    )
    return result


def read_float32_file(path: str | os.PathLike[str]) -> tuple[float, ...]:
    """Small-fixture helper; production analysis should memory-map the file."""

    source = Path(path)
    if source.suffix.casefold() == ".wav":
        layout = _wav_layout(source)
        with source.open("rb") as stream:
            stream.seek(layout.data_offset)
            return tuple(_read_float32(stream.read(layout.data_bytes)))
    return tuple(_read_float32(source.read_bytes()))


def write_float32_file(path: str | os.PathLike[str], values: Iterable[float]) -> None:
    """Write synthetic canonical PCM for tests without NumPy."""

    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    samples = tuple(float(value) for value in values)
    if any(not math.isfinite(value) for value in samples):
        raise ReferenceError("canonical PCM test values must be finite")
    audio = struct.pack(f"<{len(samples)}f", *samples)
    if output.suffix.casefold() == ".wav":
        # Synthetic helper assumes stereo; callers needing another layout can
        # create an explicit test fixture.
        if len(samples) % 2:
            raise ReferenceError("synthetic stereo WAV requires an even sample count")
        header = _wav_header(sample_rate=48_000, channels=2, data_bytes=len(audio))
        output.write_bytes(header + audio)
    else:
        output.write_bytes(audio)
