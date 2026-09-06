"""Hashable, shell-safe input planning for the native calibration renderer."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
from collections.abc import Iterable, Iterator, Sequence
from contextlib import suppress
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

_ASSET_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_MIN_RATE = 0.25
_MAX_RATE = 4.0
SIGNALSMITH_ENGINE = "signalsmith-stretch"
SIGNALSMITH_VERSION = "1.3.2"


class RenderPlanError(ValueError):
    """A render plan cannot be represented safely or deterministically."""


@dataclass(frozen=True, slots=True)
class StemInput:
    asset_id: str
    path: Path
    channels: int
    frames: int
    sha256: str | None = None


@dataclass(frozen=True, slots=True)
class FrameAnchor:
    source_frame: int
    target_frame: int


@dataclass(frozen=True, slots=True)
class RenderBlock:
    source_offset: int
    source_frames: int
    target_offset: int
    target_frames: int


@dataclass(frozen=True, slots=True)
class RenderPlan:
    stems: tuple[StemInput, ...]
    anchors: tuple[FrameAnchor, ...]
    sample_rate: int
    approval_sha256: str | None = None

    @property
    def source_frames(self) -> int:
        return self.anchors[-1].source_frame

    @property
    def target_frames(self) -> int:
        return self.anchors[-1].target_frame


@dataclass(frozen=True, slots=True)
class RendererInputs:
    stems_tsv: Path
    map_tsv: Path
    binding_json: Path | None = None
    plan_sha256: str | None = None
    map_sha256: str | None = None
    stems_tsv_sha256: str | None = None
    map_tsv_sha256: str | None = None
    binding_sha256: str | None = None
    stem_sha256s: tuple[tuple[str, str], ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "stems_tsv": str(self.stems_tsv),
            "map_tsv": str(self.map_tsv),
            "binding_json": str(self.binding_json) if self.binding_json else None,
            "plan_sha256": self.plan_sha256,
            "map_sha256": self.map_sha256,
            "stems_tsv_sha256": self.stems_tsv_sha256,
            "map_tsv_sha256": self.map_tsv_sha256,
            "binding_sha256": self.binding_sha256,
            "stem_sha256s": dict(self.stem_sha256s),
        }


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(slots=True)
class PinnedRenderer:
    """One descriptor-bound renderer and its private executable snapshot."""

    original_path: Path
    original_descriptor: int
    original_identity: _FileIdentity
    snapshot_path: Path
    snapshot_descriptor: int
    snapshot_identity: _FileIdentity
    sha256: str
    byte_length: int
    _temporary_directory: tempfile.TemporaryDirectory[str]
    _closed: bool = False

    def verify(self, *, hash_bytes: bool = True) -> None:
        if self._closed:
            raise RenderPlanError("pinned Signalsmith renderer is already closed")
        _verify_bound_file(
            self.original_path,
            self.original_descriptor,
            self.original_identity,
            label="Signalsmith renderer executable",
        )
        _verify_bound_file(
            self.snapshot_path,
            self.snapshot_descriptor,
            self.snapshot_identity,
            label="pinned Signalsmith renderer executable",
        )
        if not hash_bytes:
            return
        for descriptor, label in (
            (self.original_descriptor, "Signalsmith renderer executable"),
            (self.snapshot_descriptor, "pinned Signalsmith renderer executable"),
        ):
            digest, byte_length = _hash_descriptor(descriptor)
            if digest != self.sha256 or byte_length != self.byte_length:
                raise RenderPlanError(f"{label} content changed")
        _verify_bound_file(
            self.original_path,
            self.original_descriptor,
            self.original_identity,
            label="Signalsmith renderer executable",
        )
        _verify_bound_file(
            self.snapshot_path,
            self.snapshot_descriptor,
            self.snapshot_identity,
            label="pinned Signalsmith renderer executable",
        )

    def provenance(self) -> dict[str, object]:
        self.verify(hash_bytes=True)
        return {
            "executable_path": str(self.original_path),
            "bytes": self.byte_length,
            "sha256": self.sha256,
        }

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for descriptor in (self.snapshot_descriptor, self.original_descriptor):
            with suppress(OSError):
                os.close(descriptor)
        self._temporary_directory.cleanup()

    def __enter__(self) -> PinnedRenderer:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def validate_render_plan(plan: RenderPlan, *, require_files: bool = True) -> None:
    if (
        not isinstance(plan.sample_rate, int)
        or isinstance(plan.sample_rate, bool)
        or not 8_000 <= plan.sample_rate <= 384_000
    ):
        raise RenderPlanError("sample_rate must be between 8000 and 384000 Hz")
    if plan.approval_sha256 is not None and not _SHA256.fullmatch(plan.approval_sha256):
        raise RenderPlanError("approval_sha256 must be lowercase SHA-256 or null")
    if not plan.stems:
        raise RenderPlanError("at least one stem is required")
    if any(
        not isinstance(anchor.source_frame, int)
        or isinstance(anchor.source_frame, bool)
        or not isinstance(anchor.target_frame, int)
        or isinstance(anchor.target_frame, bool)
        for anchor in plan.anchors
    ):
        raise RenderPlanError("source and target frame anchors must be integers")
    if len(plan.anchors) < 2 or plan.anchors[0] != FrameAnchor(0, 0):
        raise RenderPlanError("the frame map must begin at (0, 0) and have two anchors")

    seen_ids: set[str] = set()
    longest = 0
    total_channels = 0
    for stem in plan.stems:
        if not _ASSET_ID.fullmatch(stem.asset_id) or stem.asset_id in seen_ids:
            raise RenderPlanError(f"unsafe or duplicate asset_id: {stem.asset_id!r}")
        seen_ids.add(stem.asset_id)
        if (
            not isinstance(stem.channels, int)
            or isinstance(stem.channels, bool)
            or not 1 <= stem.channels <= 8
        ):
            raise RenderPlanError(f"{stem.asset_id}: channels must be between 1 and 8")
        if not isinstance(stem.frames, int) or isinstance(stem.frames, bool) or stem.frames <= 0:
            raise RenderPlanError(f"{stem.asset_id}: frames must be positive")
        if stem.sha256 is not None and not _SHA256.fullmatch(stem.sha256):
            raise RenderPlanError(f"{stem.asset_id}: sha256 must be lowercase SHA-256 or null")
        if not isinstance(stem.path, Path) or not stem.path.is_absolute():
            raise RenderPlanError(f"{stem.asset_id}: canonical path must be absolute")
        if any(character in str(stem.path) for character in ("\t", "\r", "\n")):
            raise RenderPlanError(
                f"{stem.asset_id}: canonical path cannot contain control separators"
            )
        if require_files and (not stem.path.is_file() or stem.path.is_symlink()):
            raise RenderPlanError(
                f"{stem.asset_id}: canonical WAV must be a non-symlink regular file"
            )
        longest = max(longest, stem.frames)
        total_channels += stem.channels
    if total_channels > 64:
        raise RenderPlanError("linked rendering supports at most 64 channels")

    previous = plan.anchors[0]
    for anchor in plan.anchors[1:]:
        source_delta = anchor.source_frame - previous.source_frame
        target_delta = anchor.target_frame - previous.target_frame
        if source_delta <= 0 or target_delta <= 0:
            raise RenderPlanError("source and target frame anchors must be strictly increasing")
        playback_rate = source_delta / target_delta
        if not _MIN_RATE <= playback_rate <= _MAX_RATE:
            raise RenderPlanError("frame-map playback rate must remain between 0.25x and 4x")
        previous = anchor
    if plan.source_frames != longest:
        raise RenderPlanError("the frame map must end at the longest canonical stem")
    validate_signalsmith_pre_roll(plan.anchors, sample_rate=plan.sample_rate)


def _source_at_target(start: FrameAnchor, end: FrameAnchor, target_frame: int) -> int:
    target_delta = end.target_frame - start.target_frame
    source_delta = end.source_frame - start.source_frame
    relative = target_frame - start.target_frame
    # Positive integers make half-up rounding explicit and repeatable across languages.
    return start.source_frame + (relative * source_delta + target_delta // 2) // target_delta


def target_at_source(anchors: Sequence[FrameAnchor], source_frame: int) -> int:
    """Map one bound source frame through a validated piecewise-linear plan."""

    if (
        not anchors
        or source_frame < anchors[0].source_frame
        or source_frame > anchors[-1].source_frame
    ):
        raise RenderPlanError("source frame falls outside the frame map")
    if source_frame == anchors[-1].source_frame:
        return anchors[-1].target_frame
    for start, end in zip(anchors[:-1], anchors[1:], strict=True):
        if source_frame <= end.source_frame:
            source_delta = end.source_frame - start.source_frame
            target_delta = end.target_frame - start.target_frame
            relative = source_frame - start.source_frame
            return (
                start.target_frame + (relative * target_delta + source_delta // 2) // source_delta
            )
    raise RenderPlanError("source frame falls outside the frame map")


def _signalsmith_default_split_latencies(sample_rate: int) -> tuple[int, int]:
    """Match Signalsmith Stretch 1.3.2's split-computation default preset."""

    block_samples = int(sample_rate * 0.12)
    interval_samples = int(sample_rate * 0.03)
    # Signalsmith's Kaiser window is normalised once per interval residue.  For
    # the default 4:1 block/interval ratio, its selected peak (and therefore
    # the analysis/synthesis offsets) follows this four-case pattern.  Keeping
    # it explicit avoids pretending every supported sample rate has an even
    # window.  At the canonical 48 kHz this yields Lin=2880 and Lout=4320.
    remainder = block_samples - 4 * interval_samples
    synthesis_adjustment = {0: 0, 1: -1, 2: 2, 3: -1}.get(remainder)
    if synthesis_adjustment is None or interval_samples <= 0:
        raise RenderPlanError("sample_rate is incompatible with the pinned Signalsmith preset")
    synthesis_latency = 2 * interval_samples + synthesis_adjustment
    input_latency = block_samples - synthesis_latency
    output_latency = synthesis_latency + interval_samples
    return input_latency, output_latency


def signalsmith_default_pre_roll_frames(sample_rate: int) -> int:
    """Return the source-frame boundary needed by the pinned default preset."""

    input_latency, output_latency = _signalsmith_default_split_latencies(sample_rate)
    return input_latency + output_latency


def validate_signalsmith_pre_roll(anchors: Sequence[FrameAnchor], *, sample_rate: int) -> None:
    """Reject an early map change which Signalsmith's one-rate seek would smear."""

    if len(anchors) <= 2:
        return
    input_latency, output_latency = _signalsmith_default_split_latencies(sample_rate)
    # The native renderer retains its authoritative total-length checks.  This
    # Python guard is specifically for the hidden first-region constraint that
    # must be knowable while reviewing a multi-region map.
    if output_latency >= anchors[-1].target_frame:
        return
    for start, end in zip(anchors[:-1], anchors[1:], strict=True):
        if output_latency <= end.target_frame:
            mapped_pre_roll = _source_at_target(start, end, output_latency)
            break
    else:  # pragma: no cover - guarded by the total-target check above
        raise RenderPlanError("Signalsmith output pre-roll falls outside the frame map")
    required_first_source_frame = input_latency + mapped_pre_roll
    if required_first_source_frame > anchors[1].source_frame:
        raise RenderPlanError(
            "first map region is shorter than the Signalsmith pre-roll "
            f"(needs source frame {required_first_source_frame}, "
            f"ends at {anchors[1].source_frame})"
        )


def iter_render_blocks(
    anchors: Sequence[FrameAnchor], *, max_target_frames: int = 4096
) -> Iterator[RenderBlock]:
    """Allocate exact source/target counts without cumulative rounding drift."""

    if max_target_frames <= 0:
        raise RenderPlanError("max_target_frames must be positive")
    if len(anchors) < 2 or anchors[0] != FrameAnchor(0, 0):
        raise RenderPlanError("anchors must begin at (0, 0)")
    for start, end in zip(anchors[:-1], anchors[1:], strict=True):
        if end.source_frame <= start.source_frame or end.target_frame <= start.target_frame:
            raise RenderPlanError("anchors must be strictly increasing")
        target = start.target_frame
        source = start.source_frame
        while target < end.target_frame:
            next_target = min(end.target_frame, target + max_target_frames)
            next_source = _source_at_target(start, end, next_target)
            yield RenderBlock(
                source_offset=source,
                source_frames=next_source - source,
                target_offset=target,
                target_frames=next_target - target,
            )
            source = next_source
            target = next_target


def _write_atomic(path: Path, lines: Iterable[str]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    if path.exists() or path.is_symlink() or temporary.exists() or temporary.is_symlink():
        raise FileExistsError(f"renderer input already exists: {path}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            for line in lines:
                handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _canonical_json_bytes(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    except (TypeError, ValueError) as error:
        raise RenderPlanError(f"renderer binding is not canonical JSON: {error}") from error


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _file_identity(value: os.stat_result) -> _FileIdentity:
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


def _open_bound_file(path: Path, *, label: str) -> tuple[int, _FileIdentity]:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        path_identity = _file_identity(path.stat(follow_symlinks=False))
        if not stat.S_ISREG(path_identity.mode):
            raise RenderPlanError(f"{label} must be a non-symlink regular file")
        descriptor = os.open(path, flags)
    except RenderPlanError:
        raise
    except OSError as error:
        raise RenderPlanError(f"cannot open {label}: {error}") from error
    try:
        descriptor_identity = _file_identity(os.fstat(descriptor))
        final_path_identity = _file_identity(path.stat(follow_symlinks=False))
        if (
            not stat.S_ISREG(descriptor_identity.mode)
            or not stat.S_ISREG(final_path_identity.mode)
            or not _same_file(path_identity, descriptor_identity)
            or not _same_file(descriptor_identity, final_path_identity)
        ):
            raise RenderPlanError(f"{label} changed while it was being opened")
        return descriptor, descriptor_identity
    except Exception:
        os.close(descriptor)
        raise


def _verify_bound_file(
    path: Path,
    descriptor: int,
    expected: _FileIdentity,
    *,
    label: str,
) -> None:
    try:
        descriptor_identity = _file_identity(os.fstat(descriptor))
        path_identity = _file_identity(path.stat(follow_symlinks=False))
    except OSError as error:
        raise RenderPlanError(f"{label} identity is no longer available: {error}") from error
    if (
        descriptor_identity != expected
        or not stat.S_ISREG(path_identity.mode)
        or not _same_file(path_identity, expected)
    ):
        raise RenderPlanError(f"{label} identity changed")


def _descriptor_blocks(descriptor: int) -> Iterator[bytes]:
    if hasattr(os, "pread"):
        offset = 0
        while block := os.pread(descriptor, 1024 * 1024, offset):
            yield block
            offset += len(block)
        return

    previous_offset: int | None = None
    try:
        previous_offset = os.lseek(descriptor, 0, os.SEEK_CUR)
        os.lseek(descriptor, 0, os.SEEK_SET)
        while block := os.read(descriptor, 1024 * 1024):
            yield block
    except OSError as error:
        raise RenderPlanError(f"cannot read executable descriptor: {error}") from error
    finally:
        if previous_offset is not None:
            with suppress(OSError):
                os.lseek(descriptor, previous_offset, os.SEEK_SET)


def _hash_descriptor(descriptor: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    for block in _descriptor_blocks(descriptor):
        digest.update(block)
        total += len(block)
    return digest.hexdigest(), total


def _write_all(descriptor: int, value: bytes) -> None:
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("short write while snapshotting Signalsmith renderer")
        remaining = remaining[written:]


def pin_signalsmith_renderer(binary: str | os.PathLike[str]) -> PinnedRenderer:
    """Snapshot and bind one exact renderer executable for an entire bake-off."""

    requested = Path(binary).expanduser()
    original_path = Path(os.path.abspath(requested))
    original_descriptor, original_identity = _open_bound_file(
        original_path, label="Signalsmith renderer executable"
    )
    temporary: tempfile.TemporaryDirectory[str] | None = None
    output_descriptor: int | None = None
    snapshot_descriptor: int | None = None
    try:
        if os.name == "posix":
            if not original_identity.mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
                raise RenderPlanError("Signalsmith renderer executable is not executable")
        elif not os.access(original_path, os.X_OK):
            raise RenderPlanError("Signalsmith renderer executable is not executable")

        temporary = tempfile.TemporaryDirectory(prefix=".opusloops-signalsmith-renderer-")
        snapshot_directory = Path(temporary.name)
        try:
            snapshot_directory.chmod(0o700)
            directory_mode = snapshot_directory.stat(follow_symlinks=False).st_mode
        except OSError as error:
            raise RenderPlanError(f"cannot secure renderer snapshot directory: {error}") from error
        if os.name == "posix" and stat.S_IMODE(directory_mode) != 0o700:
            raise RenderPlanError("renderer snapshot directory is not owner-only")

        suffix = ".exe" if os.name == "nt" else ""
        snapshot_path = snapshot_directory / f"opusloops-signalsmith-render{suffix}"
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        output_descriptor = os.open(snapshot_path, flags, 0o500)
        digest = hashlib.sha256()
        byte_length = 0
        for block in _descriptor_blocks(original_descriptor):
            digest.update(block)
            byte_length += len(block)
            _write_all(output_descriptor, block)
        if byte_length != original_identity.size:
            raise RenderPlanError("Signalsmith renderer changed while it was being snapshotted")
        if hasattr(os, "fchmod"):
            os.fchmod(output_descriptor, stat.S_IRUSR | stat.S_IXUSR)
        else:
            os.chmod(snapshot_path, stat.S_IRUSR | stat.S_IXUSR, follow_symlinks=False)
        os.fsync(output_descriptor)
        os.close(output_descriptor)
        output_descriptor = None
        _verify_bound_file(
            original_path,
            original_descriptor,
            original_identity,
            label="Signalsmith renderer executable",
        )
        snapshot_descriptor, snapshot_identity = _open_bound_file(
            snapshot_path, label="pinned Signalsmith renderer executable"
        )
        snapshot_sha256, snapshot_bytes = _hash_descriptor(snapshot_descriptor)
        if snapshot_sha256 != digest.hexdigest() or snapshot_bytes != byte_length:
            raise RenderPlanError("pinned Signalsmith renderer failed hash verification")
        pinned = PinnedRenderer(
            original_path=original_path,
            original_descriptor=original_descriptor,
            original_identity=original_identity,
            snapshot_path=snapshot_path,
            snapshot_descriptor=snapshot_descriptor,
            snapshot_identity=snapshot_identity,
            sha256=digest.hexdigest(),
            byte_length=byte_length,
            _temporary_directory=temporary,
        )
        pinned.verify(hash_bytes=True)
        return pinned
    except Exception:
        if output_descriptor is not None:
            os.close(output_descriptor)
        if snapshot_descriptor is not None:
            os.close(snapshot_descriptor)
        os.close(original_descriptor)
        if temporary is not None:
            temporary.cleanup()
        raise


def _hash_regular_file(path: Path) -> tuple[str, int]:
    try:
        before = path.stat(follow_symlinks=False)
    except OSError as error:
        raise RenderPlanError(f"cannot stat renderer input {path}: {error}") from error
    if not stat.S_ISREG(before.st_mode):
        raise RenderPlanError(f"renderer input must be a non-symlink regular file: {path}")
    digest = hashlib.sha256()
    byte_length = 0
    try:
        with path.open("rb") as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
                byte_length += len(block)
    except OSError as error:
        raise RenderPlanError(f"cannot hash renderer input {path}: {error}") from error
    after = path.stat(follow_symlinks=False)
    identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_after or byte_length != before.st_size:
        raise RenderPlanError(f"renderer input changed while hashing: {path}")
    return digest.hexdigest(), byte_length


def _read_bound_regular_file(path: Path, *, max_bytes: int) -> bytes:
    try:
        before = path.stat(follow_symlinks=False)
    except OSError as error:
        raise RenderPlanError(f"cannot stat renderer binding {path}: {error}") from error
    if not stat.S_ISREG(before.st_mode):
        raise RenderPlanError(f"renderer binding must be a non-symlink regular file: {path}")
    if before.st_size > max_bytes:
        raise RenderPlanError(f"renderer binding exceeds its byte limit: {path}")
    try:
        content = path.read_bytes()
    except OSError as error:
        raise RenderPlanError(f"cannot read renderer binding {path}: {error}") from error
    after = path.stat(follow_symlinks=False)
    before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if before_identity != after_identity or len(content) != before.st_size:
        raise RenderPlanError(f"renderer binding changed while reading: {path}")
    return content


def _stem_hashes(plan: RenderPlan) -> tuple[tuple[str, str], ...]:
    hashes: list[tuple[str, str]] = []
    for stem in plan.stems:
        digest, _ = _hash_regular_file(stem.path)
        if stem.sha256 is not None and digest != stem.sha256:
            raise RenderPlanError(f"{stem.asset_id}: canonical source SHA-256 changed")
        hashes.append((stem.asset_id, digest))
    return tuple(hashes)


def _map_payload(plan: RenderPlan) -> dict[str, object]:
    return {
        "sample_rate": plan.sample_rate,
        "anchors": [asdict(anchor) for anchor in plan.anchors],
    }


def _plan_payload(plan: RenderPlan, stem_sha256s: tuple[tuple[str, str], ...]) -> dict[str, object]:
    hashes = dict(stem_sha256s)
    return {
        "approval_sha256": plan.approval_sha256,
        "sample_rate": plan.sample_rate,
        "stems": [
            {
                "asset_id": stem.asset_id,
                "path": str(stem.path),
                "channels": stem.channels,
                "frames": stem.frames,
                "sha256": hashes[stem.asset_id],
            }
            for stem in plan.stems
        ],
        "anchors": [asdict(anchor) for anchor in plan.anchors],
    }


def _stems_tsv_text(plan: RenderPlan, stem_sha256s: tuple[tuple[str, str], ...]) -> str:
    hashes = dict(stem_sha256s)
    return "".join(
        (
            "asset_id\tchannels\tframes\tsha256\tpath\n",
            *(
                f"{stem.asset_id}\t{stem.channels}\t{stem.frames}\t"
                f"{hashes[stem.asset_id]}\t{stem.path}\n"
                for stem in plan.stems
            ),
        )
    )


def _map_tsv_text(plan: RenderPlan) -> str:
    return "".join(
        (
            "source_frame\ttarget_frame\n",
            *(f"{anchor.source_frame}\t{anchor.target_frame}\n" for anchor in plan.anchors),
        )
    )


def _binding_payload(
    plan: RenderPlan,
    stem_sha256s: tuple[tuple[str, str], ...],
    *,
    stems_tsv_sha256: str,
    stems_tsv_bytes: int,
    map_tsv_sha256: str,
    map_tsv_bytes: int,
) -> dict[str, object]:
    map_sha256 = _sha256_bytes(_canonical_json_bytes(_map_payload(plan)))
    plan_sha256 = _sha256_bytes(_canonical_json_bytes(_plan_payload(plan, stem_sha256s)))
    return {
        "schema_version": "opusloops.renderer-inputs.v1",
        "approval_sha256": plan.approval_sha256,
        "plan_sha256": plan_sha256,
        "map_sha256": map_sha256,
        "sample_rate": plan.sample_rate,
        "source_frames": plan.source_frames,
        "target_frames": plan.target_frames,
        "stems": [
            {
                "asset_id": stem.asset_id,
                "sha256": dict(stem_sha256s)[stem.asset_id],
            }
            for stem in plan.stems
        ],
        "artifacts": {
            "stems_tsv": {
                "path": "stems.tsv",
                "bytes": stems_tsv_bytes,
                "sha256": stems_tsv_sha256,
            },
            "map_tsv": {
                "path": "map.tsv",
                "bytes": map_tsv_bytes,
                "sha256": map_tsv_sha256,
            },
        },
    }


def write_renderer_inputs(plan: RenderPlan, directory: Path) -> RendererInputs:
    validate_render_plan(plan)
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stems_path = directory / "stems.tsv"
    map_path = directory / "map.tsv"
    binding_path = directory / "renderer-inputs.json"
    stem_sha256s = _stem_hashes(plan)
    stems_text = _stems_tsv_text(plan, stem_sha256s)
    map_text = _map_tsv_text(plan)
    _write_atomic(stems_path, (stems_text,))
    try:
        _write_atomic(map_path, (map_text,))
        stems_tsv_sha256, stems_tsv_bytes = _hash_regular_file(stems_path)
        map_tsv_sha256, map_tsv_bytes = _hash_regular_file(map_path)
        binding = _binding_payload(
            plan,
            stem_sha256s,
            stems_tsv_sha256=stems_tsv_sha256,
            stems_tsv_bytes=stems_tsv_bytes,
            map_tsv_sha256=map_tsv_sha256,
            map_tsv_bytes=map_tsv_bytes,
        )
        rendered_binding = (
            json.dumps(binding, ensure_ascii=False, allow_nan=False, indent=2, sort_keys=True)
            + "\n"
        )
        _write_atomic(binding_path, (rendered_binding,))
    except Exception:
        stems_path.unlink(missing_ok=True)
        map_path.unlink(missing_ok=True)
        binding_path.unlink(missing_ok=True)
        raise
    binding_sha256, _ = _hash_regular_file(binding_path)
    return RendererInputs(
        stems_tsv=stems_path,
        map_tsv=map_path,
        binding_json=binding_path,
        plan_sha256=str(binding["plan_sha256"]),
        map_sha256=str(binding["map_sha256"]),
        stems_tsv_sha256=stems_tsv_sha256,
        map_tsv_sha256=map_tsv_sha256,
        binding_sha256=binding_sha256,
        stem_sha256s=stem_sha256s,
    )


def verify_renderer_inputs(plan: RenderPlan, inputs: RendererInputs) -> dict[str, object]:
    """Re-derive and verify the complete renderer handoff against ``plan``."""

    validate_render_plan(plan)
    required_hashes = {
        "plan_sha256": inputs.plan_sha256,
        "map_sha256": inputs.map_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "binding_sha256": inputs.binding_sha256,
    }
    if inputs.binding_json is None or any(
        not isinstance(value, str) or not _SHA256.fullmatch(value)
        for value in required_hashes.values()
    ):
        raise RenderPlanError("renderer inputs are missing their plan/hash binding")
    paths = (inputs.stems_tsv, inputs.map_tsv, inputs.binding_json)
    if any(not path.is_absolute() for path in paths):
        raise RenderPlanError("bound renderer input paths must be absolute")
    if len({path.parent.resolve() for path in paths}) != 1:
        raise RenderPlanError("bound renderer inputs must share one controlled directory")

    stem_sha256s = _stem_hashes(plan)
    if stem_sha256s != inputs.stem_sha256s:
        raise RenderPlanError("canonical stem source hashes no longer match renderer inputs")
    expected_stems = _stems_tsv_text(plan, stem_sha256s).encode()
    expected_map = _map_tsv_text(plan).encode()
    actual_stems = _read_bound_regular_file(
        inputs.stems_tsv, max_bytes=max(1024, len(expected_stems))
    )
    actual_map = _read_bound_regular_file(inputs.map_tsv, max_bytes=max(1024, len(expected_map)))
    actual_binding = _read_bound_regular_file(inputs.binding_json, max_bytes=1024 * 1024)
    if actual_stems != expected_stems:
        raise RenderPlanError("stems.tsv does not match the exact RenderPlan")
    if actual_map != expected_map:
        raise RenderPlanError("map.tsv does not match every approved frame anchor")

    stems_tsv_sha256 = _sha256_bytes(actual_stems)
    map_tsv_sha256 = _sha256_bytes(actual_map)
    if stems_tsv_sha256 != inputs.stems_tsv_sha256:
        raise RenderPlanError("stems.tsv SHA-256 binding changed")
    if map_tsv_sha256 != inputs.map_tsv_sha256:
        raise RenderPlanError("map.tsv SHA-256 binding changed")
    if _sha256_bytes(actual_binding) != inputs.binding_sha256:
        raise RenderPlanError("renderer-inputs.json SHA-256 binding changed")
    try:
        binding: Any = json.loads(actual_binding)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RenderPlanError("renderer-inputs.json is invalid JSON") from error
    if not isinstance(binding, dict):
        raise RenderPlanError("renderer-inputs.json root must be an object")
    expected_binding = _binding_payload(
        plan,
        stem_sha256s,
        stems_tsv_sha256=stems_tsv_sha256,
        stems_tsv_bytes=len(actual_stems),
        map_tsv_sha256=map_tsv_sha256,
        map_tsv_bytes=len(actual_map),
    )
    if binding != expected_binding:
        raise RenderPlanError("renderer-inputs.json is stale or belongs to another RenderPlan")
    if binding["plan_sha256"] != inputs.plan_sha256:
        raise RenderPlanError("RenderPlan SHA-256 binding changed")
    if binding["map_sha256"] != inputs.map_sha256:
        raise RenderPlanError("semantic frame-map SHA-256 binding changed")
    return binding


def signalsmith_command(
    binary: Path,
    inputs: RendererInputs,
    output_directory: Path,
    *,
    mode: str,
    sample_rate: int,
) -> list[str]:
    if mode not in {"linked", "independent"}:
        raise RenderPlanError("mode must be 'linked' or 'independent'")
    if not 8_000 <= sample_rate <= 384_000:
        raise RenderPlanError("sample_rate must be between 8000 and 384000 Hz")
    if (
        not binary.is_absolute()
        or not inputs.stems_tsv.is_absolute()
        or not inputs.map_tsv.is_absolute()
    ):
        raise RenderPlanError("renderer and manifest paths must be absolute")
    if not output_directory.is_absolute():
        raise RenderPlanError("output directory must be absolute")
    required_hashes = {
        "plan_sha256": inputs.plan_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
    }
    if any(
        not isinstance(value, str) or not _SHA256.fullmatch(value)
        for value in required_hashes.values()
    ):
        raise RenderPlanError("renderer command is missing required SHA-256 bindings")
    return [
        str(binary),
        "--stems",
        str(inputs.stems_tsv),
        "--map",
        str(inputs.map_tsv),
        "--output-dir",
        str(output_directory),
        "--mode",
        mode,
        "--sample-rate",
        str(sample_rate),
        "--plan-sha256",
        str(inputs.plan_sha256),
        "--stems-tsv-sha256",
        str(inputs.stems_tsv_sha256),
        "--map-tsv-sha256",
        str(inputs.map_tsv_sha256),
    ]


def run_signalsmith(
    binary: Path | PinnedRenderer,
    plan: RenderPlan,
    inputs: RendererInputs,
    output_directory: Path,
    *,
    mode: str,
) -> dict[str, object]:
    binding = verify_renderer_inputs(plan, inputs)
    if not isinstance(binary, PinnedRenderer):
        with pin_signalsmith_renderer(binary) as pinned:
            return _run_pinned_signalsmith(
                pinned,
                plan,
                inputs,
                output_directory,
                mode=mode,
                binding=binding,
            )
    return _run_pinned_signalsmith(
        binary,
        plan,
        inputs,
        output_directory,
        mode=mode,
        binding=binding,
    )


def _run_pinned_signalsmith(
    renderer: PinnedRenderer,
    plan: RenderPlan,
    inputs: RendererInputs,
    output_directory: Path,
    *,
    mode: str,
    binding: dict[str, object],
) -> dict[str, object]:
    renderer.verify(hash_bytes=True)
    command = signalsmith_command(
        renderer.snapshot_path,
        inputs,
        output_directory,
        mode=mode,
        sample_rate=plan.sample_rate,
    )
    environment = {"LC_ALL": "C", "LANG": "C"}
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            shell=False,
            env=environment,
            start_new_session=(os.name == "posix"),
        )
    finally:
        renderer.verify(hash_bytes=True)
    # Detect source or handoff changes made while the native process was
    # running. Native hash verification is still required to close the narrow
    # verify/open race completely in a hostile environment.
    verify_renderer_inputs(plan, inputs)
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Signalsmith renderer returned invalid JSON") from error
    if not isinstance(result, dict):
        raise RuntimeError("Signalsmith renderer JSON root is not an object")
    if result.get("engine") != SIGNALSMITH_ENGINE:
        raise RuntimeError(f"Signalsmith renderer did not identify engine {SIGNALSMITH_ENGINE!r}")
    if result.get("version") != SIGNALSMITH_VERSION:
        raise RuntimeError(f"Signalsmith renderer did not identify version {SIGNALSMITH_VERSION!r}")
    if result.get("source_frames") != plan.source_frames:
        raise RuntimeError("Signalsmith renderer reported a different source length")
    if result.get("target_frames") != plan.target_frames:
        raise RuntimeError("Signalsmith renderer reported a different target length")
    if result.get("stem_count") != len(plan.stems):
        raise RuntimeError("Signalsmith renderer reported a different stem count")
    if result.get("mode") != mode:
        raise RuntimeError("Signalsmith renderer reported a different processing mode")
    native_echoes: dict[str, object] = {
        "plan_sha256": binding["plan_sha256"],
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
    }
    for key, expected in native_echoes.items():
        if key not in result:
            raise RuntimeError(f"Signalsmith renderer did not report required {key}")
        if result[key] != expected:
            raise RuntimeError(f"Signalsmith renderer reported a different {key}")
    verified_inputs: dict[str, object] = {
        "approval_sha256": binding["approval_sha256"],
        "plan_sha256": binding["plan_sha256"],
        "map_sha256": binding["map_sha256"],
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "binding_sha256": inputs.binding_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
        "native_consumed": native_echoes,
    }
    result["verified_inputs"] = verified_inputs
    return result
