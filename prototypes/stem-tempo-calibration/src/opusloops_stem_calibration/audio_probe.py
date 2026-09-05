"""Bounded FFprobe inspection and canonical FFmpeg decoding.

The canonical intermediate is RIFF/WAVE IEEE little-endian float32 at 48 kHz.
Channel count is preserved (mono remains mono; stereo remains stereo), and no
silence trimming is performed. Timeline metadata is recorded rather than
silently normalized.
"""

from __future__ import annotations

import array
import hashlib
import json
import math
import os
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
from collections.abc import Sequence
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .policy import DEFAULT_POLICY, IngestPolicy


class AudioProbeError(RuntimeError):
    """An audio file or external decoder failed closed."""


@dataclass(frozen=True, slots=True)
class ToolIdentity:
    name: str
    path: str
    sha256: str
    version: str
    build_configuration: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "sha256": self.sha256,
            "version": self.version,
            "build_configuration": self.build_configuration,
        }


@dataclass(frozen=True, slots=True)
class AudioProbe:
    source_path: Path
    source_name: str
    source_bytes: int
    source_sha256: str
    stream_index: int
    audio_stream_count: int
    codec: str
    codec_long_name: str | None
    profile: str | None
    sample_format: str | None
    sample_rate: int
    channels: int
    channel_layout: str | None
    time_base: str | None
    stream_start_time: float | None
    first_packet_timestamp: float | None
    duration_seconds: float
    duration_source: str
    packet_timeline_duration_seconds: float | None
    stream_declared_duration_seconds: float | None
    format_declared_duration_seconds: float | None
    bit_rate: int | None
    packet_count: int
    skip_samples: int
    discard_padding: int
    tags: dict[str, str]
    first_packet: dict[str, Any] | None
    last_packet: dict[str, Any] | None
    ffprobe: ToolIdentity
    sanitized_arguments: tuple[str, ...]

    @property
    def timeline_start_seconds(self) -> float:
        if self.stream_start_time is not None:
            return self.stream_start_time
        if self.first_packet_timestamp is not None:
            return self.first_packet_timestamp
        return 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_name": self.source_name,
            "source_bytes": self.source_bytes,
            "source_sha256": self.source_sha256,
            "stream_index": self.stream_index,
            "audio_stream_count": self.audio_stream_count,
            "codec": self.codec,
            "codec_long_name": self.codec_long_name,
            "profile": self.profile,
            "sample_format": self.sample_format,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "channel_layout": self.channel_layout,
            "time_base": self.time_base,
            "stream_start_time": self.stream_start_time,
            "first_packet_timestamp": self.first_packet_timestamp,
            "timeline_start_seconds": self.timeline_start_seconds,
            "duration_seconds": self.duration_seconds,
            "duration_source": self.duration_source,
            "packet_timeline_duration_seconds": self.packet_timeline_duration_seconds,
            "stream_declared_duration_seconds": self.stream_declared_duration_seconds,
            "format_declared_duration_seconds": self.format_declared_duration_seconds,
            "bit_rate": self.bit_rate,
            "packet_count": self.packet_count,
            "skip_samples": self.skip_samples,
            "discard_padding": self.discard_padding,
            "tags": dict(sorted(self.tags.items())),
            "first_packet": self.first_packet,
            "last_packet": self.last_packet,
            "ffprobe": self.ffprobe.to_dict(),
            "sanitized_arguments": list(self.sanitized_arguments),
        }


@dataclass(frozen=True, slots=True)
class CanonicalAudio:
    source_name: str
    source_sha256: str
    output_path: Path
    sample_rate: int
    channels: int
    frames: int
    bytes: int
    audio_data_bytes: int
    sha256: str
    timeline_start_seconds: float
    timeline_offset_frames: int
    leading_silence_frames: int
    leading_silence_seconds: float
    silence_epsilon: float
    peak_absolute_sample: float
    ffmpeg: ToolIdentity
    sanitized_arguments: tuple[str, ...]

    @property
    def canonical_format(self) -> str:
        return "wav-f32le-interleaved"

    def to_dict(self, *, run_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
        if run_dir is None:
            output: dict[str, Any] = {
                "path": self.output_path.name,
                "bytes": self.bytes,
                "sha256": self.sha256,
            }
        else:
            from .manifest import artifact_reference

            output = artifact_reference(self.output_path, run_dir)
        return {
            "source_name": self.source_name,
            "source_sha256": self.source_sha256,
            "canonical_format": self.canonical_format,
            "output": output,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "frames": self.frames,
            "audio_data_bytes": self.audio_data_bytes,
            "timeline_start_seconds": self.timeline_start_seconds,
            "timeline_offset_frames": self.timeline_offset_frames,
            "leading_silence": {
                "behavior": "preserved-no-trim",
                "frames": self.leading_silence_frames,
                "seconds": self.leading_silence_seconds,
                "epsilon": self.silence_epsilon,
            },
            "peak_absolute_sample": self.peak_absolute_sample,
            "ffmpeg": self.ffmpeg.to_dict(),
            "sanitized_arguments": list(self.sanitized_arguments),
        }


@dataclass(frozen=True, slots=True)
class _ProcessResult:
    stdout: bytes
    stderr: bytes


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(slots=True)
class _PinnedTool:
    expected_name: str
    original_path: Path
    original_descriptor: int
    original_identity: _FileIdentity
    snapshot_path: Path
    snapshot_descriptor: int
    snapshot_identity: _FileIdentity
    sha256: str
    identity: ToolIdentity | None = None

    def close(self) -> None:
        for descriptor in (self.snapshot_descriptor, self.original_descriptor):
            with suppress(OSError):
                os.close(descriptor)


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


def _resolve_executable(binary: str | os.PathLike[str]) -> Path:
    requested = os.fspath(binary)
    try:
        if os.sep in requested or (os.altsep and os.altsep in requested):
            path = Path(requested).expanduser().resolve(strict=True)
        else:
            located = shutil.which(requested)
            if not located:
                raise AudioProbeError(f"required executable not found: {requested}")
            path = Path(located).resolve(strict=True)
    except OSError as error:
        raise AudioProbeError(f"cannot resolve executable {requested}: {error}") from error
    try:
        path_stat = path.stat(follow_symlinks=False)
    except OSError as error:
        raise AudioProbeError(f"cannot stat executable {path}: {error}") from error
    if not stat.S_ISREG(path_stat.st_mode) or not os.access(path, os.X_OK):
        raise AudioProbeError(f"external tool is not an executable regular file: {path}")
    return path


def _open_bound_regular_file(
    path: Path, *, label: str, writable: bool = False
) -> tuple[int, _FileIdentity]:
    flags = os.O_RDWR if writable else os.O_RDONLY
    flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise AudioProbeError(f"cannot open {label}: {error}") from error
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
        if not stat.S_ISREG(descriptor_identity.mode) or not stat.S_ISREG(path_identity.mode):
            raise AudioProbeError(f"{label} must be a non-symlink regular file")
        if not _same_file(descriptor_identity, path_identity):
            raise AudioProbeError(f"{label} changed while it was being opened")
        return descriptor, descriptor_identity
    except Exception:
        os.close(descriptor)
        raise


def _verify_bound_descriptor(
    path: Path,
    descriptor: int,
    expected: _FileIdentity,
    *,
    label: str,
) -> None:
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
    except OSError as error:
        raise AudioProbeError(f"{label} identity is no longer available: {error}") from error
    if descriptor_identity != expected or not _same_file(path_identity, expected):
        raise AudioProbeError(f"{label} identity changed")
    if not stat.S_ISREG(path_identity.mode):
        raise AudioProbeError(f"{label} is no longer a regular file")


def _hash_descriptor(descriptor: int, *, chunk_bytes: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    if hasattr(os, "pread"):
        while chunk := os.pread(descriptor, chunk_bytes, total):
            digest.update(chunk)
            total += len(chunk)
        return digest.hexdigest(), total

    previous_offset = os.lseek(descriptor, 0, os.SEEK_CUR)
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        while chunk := os.read(descriptor, chunk_bytes):
            digest.update(chunk)
            total += len(chunk)
    finally:
        os.lseek(descriptor, previous_offset, os.SEEK_SET)
    return digest.hexdigest(), total


def _file_sha256(path: Path, *, chunk_bytes: int) -> tuple[str, int]:
    descriptor, identity = _open_bound_regular_file(path, label=f"file {path}")
    try:
        digest, total = _hash_descriptor(descriptor, chunk_bytes=chunk_bytes)
        _verify_bound_descriptor(path, descriptor, identity, label=f"file {path}")
        if total != identity.size:
            raise AudioProbeError(f"file changed while it was being hashed: {path}")
        return digest, total
    finally:
        os.close(descriptor)


def _write_all(descriptor: int, value: bytes) -> None:
    remaining = memoryview(value)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError("short write while snapshotting executable")
        remaining = remaining[written:]


def _fsync_directory(path: Path) -> None:
    if os.name != "posix":
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _open_bound_directory(path: Path, *, label: str) -> tuple[int, _FileIdentity]:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise AudioProbeError(f"cannot open {label}: {error}") from error
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
        if not stat.S_ISDIR(descriptor_identity.mode) or not stat.S_ISDIR(path_identity.mode):
            raise AudioProbeError(f"{label} must be a directory")
        if not _same_file(descriptor_identity, path_identity):
            raise AudioProbeError(f"{label} changed while it was being opened")
        return descriptor, descriptor_identity
    except Exception:
        os.close(descriptor)
        raise


def _verify_bound_directory(
    path: Path, descriptor: int, expected: _FileIdentity, *, label: str
) -> None:
    try:
        descriptor_identity = _identity(os.fstat(descriptor))
        path_identity = _identity(path.stat(follow_symlinks=False))
    except OSError as error:
        raise AudioProbeError(f"{label} identity is no longer available: {error}") from error
    if not _same_file(descriptor_identity, expected) or not _same_file(path_identity, expected):
        raise AudioProbeError(f"{label} identity changed")
    if not stat.S_ISDIR(descriptor_identity.mode) or not stat.S_ISDIR(path_identity.mode):
        raise AudioProbeError(f"{label} is no longer a directory")


def _directory_entry_identity(directory_descriptor: int, name: str) -> _FileIdentity | None:
    try:
        return _identity(os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False))
    except FileNotFoundError:
        return None
    except OSError as error:
        raise AudioProbeError(f"cannot inspect canonical output destination: {error}") from error


def _require_destination_absent(directory_descriptor: int, name: str) -> None:
    if _directory_entry_identity(directory_descriptor, name) is not None:
        raise AudioProbeError("canonical output already exists; refusing to overwrite it")


def _publish_noreplace(
    staged_path: Path,
    staged_descriptor: int,
    staged_identity: _FileIdentity,
    *,
    output_parent_descriptor: int,
    output_name: str,
) -> None:
    """Publish a verified staged inode without replacing any destination entry."""

    _verify_bound_descriptor(
        staged_path,
        staged_descriptor,
        staged_identity,
        label="staged canonical WAVE",
    )
    _require_destination_absent(output_parent_descriptor, output_name)
    published = False
    try:
        try:
            os.link(
                staged_path,
                output_name,
                dst_dir_fd=output_parent_descriptor,
                follow_symlinks=False,
            )
        except FileExistsError as error:
            raise AudioProbeError(
                "canonical output already exists; refusing to overwrite it"
            ) from error
        except OSError as error:
            raise AudioProbeError(f"cannot publish canonical output atomically: {error}") from error
        published = True
        published_identity = _directory_entry_identity(output_parent_descriptor, output_name)
        if published_identity is None or not _same_file(published_identity, staged_identity):
            raise AudioProbeError("published canonical output has an unexpected identity")
        os.fsync(output_parent_descriptor)
    except Exception:
        if published:
            try:
                current = _directory_entry_identity(output_parent_descriptor, output_name)
                if current is not None and _same_file(current, staged_identity):
                    os.unlink(output_name, dir_fd=output_parent_descriptor)
                    os.fsync(output_parent_descriptor)
            except OSError:
                # Never risk deleting a replacement installed by another actor.
                pass
        raise


def _limit_child_resources(policy: IngestPolicy, max_file_bytes: int | None) -> Any:
    if os.name != "posix":
        return None

    def apply_limits() -> None:
        import resource

        def lower_soft_limit(kind: int, requested: int) -> None:
            _, inherited_hard = resource.getrlimit(kind)
            soft = min(requested, inherited_hard)
            resource.setrlimit(kind, (soft, inherited_hard))

        lower_soft_limit(resource.RLIMIT_CPU, policy.max_subprocess_cpu_seconds)
        # Darwin exposes RLIMIT_AS but rejects setting it for these spawned
        # decoder processes. The production worker is Linux, where an address
        # space ceiling is mandatory. macOS retains CPU/file ceilings plus the
        # parent-enforced wall timeout and post-decode byte/frame validation.
        if sys.platform.startswith("linux"):
            lower_soft_limit(resource.RLIMIT_AS, policy.max_subprocess_memory_bytes)
        if max_file_bytes is not None:
            lower_soft_limit(resource.RLIMIT_FSIZE, max_file_bytes)

    return apply_limits


def _minimal_environment() -> dict[str, str]:
    environment = {"LC_ALL": "C", "LANG": "C"}
    # Required for Windows process creation; harmlessly omitted elsewhere.
    if "SYSTEMROOT" in os.environ:
        environment["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    return environment


def _run_process(
    arguments: Sequence[str],
    *,
    timeout_seconds: float,
    policy: IngestPolicy,
    max_captured_bytes: int,
    max_file_bytes: int | None = None,
) -> _ProcessResult:
    if not arguments or not Path(arguments[0]).is_absolute():
        raise AudioProbeError("external tool command must use a resolved absolute executable")
    try:
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            process = subprocess.Popen(
                list(arguments),
                stdin=subprocess.DEVNULL,
                stdout=stdout_file,
                stderr=stderr_file,
                shell=False,
                env=_minimal_environment(),
                start_new_session=(os.name == "posix"),
                preexec_fn=_limit_child_resources(policy, max_file_bytes),
            )
            try:
                process.communicate(timeout=timeout_seconds)
            except subprocess.TimeoutExpired as error:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.communicate()
                raise AudioProbeError(
                    f"{Path(arguments[0]).name} timed out after {timeout_seconds:g}s"
                ) from error
            stdout_bytes = stdout_file.tell()
            stderr_bytes = stderr_file.tell()
            if stdout_bytes > max_captured_bytes or stderr_bytes > max_captured_bytes:
                raise AudioProbeError("external tool output exceeded the capture limit")
            stdout_file.seek(0)
            stderr_file.seek(0)
            stdout = stdout_file.read()
            stderr = stderr_file.read()
    except (OSError, subprocess.SubprocessError) as error:
        raise AudioProbeError(f"failed to execute {Path(arguments[0]).name}: {error}") from error

    if process.returncode != 0:
        message = stderr.decode("utf-8", errors="replace").strip()
        if len(message) > 2_000:
            message = message[:2_000] + "…"
        raise AudioProbeError(
            f"{Path(arguments[0]).name} exited with {process.returncode}: {message}"
        )
    return _ProcessResult(stdout=stdout, stderr=stderr)


def _snapshot_executable(
    binary: str | os.PathLike[str],
    *,
    expected_name: str,
    snapshot_directory: Path,
    policy: IngestPolicy,
) -> _PinnedTool:
    original_path = _resolve_executable(binary)
    original_descriptor, original_identity = _open_bound_regular_file(
        original_path, label=f"{expected_name} executable"
    )
    snapshot_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot_path = snapshot_directory / expected_name
    snapshot_descriptor: int | None = None
    output_descriptor: int | None = None
    try:
        if not original_identity.mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            raise AudioProbeError(f"{expected_name} executable lost its execute permission")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        output_descriptor = os.open(snapshot_path, flags, 0o500)
        digest = hashlib.sha256()
        total = 0
        previous_offset = os.lseek(original_descriptor, 0, os.SEEK_CUR)
        try:
            os.lseek(original_descriptor, 0, os.SEEK_SET)
            while chunk := os.read(original_descriptor, policy.copy_chunk_bytes):
                digest.update(chunk)
                total += len(chunk)
                _write_all(output_descriptor, chunk)
        finally:
            os.lseek(original_descriptor, previous_offset, os.SEEK_SET)
        if total != original_identity.size:
            raise AudioProbeError(f"{expected_name} executable changed while being snapshotted")
        if hasattr(os, "fchmod"):
            os.fchmod(output_descriptor, stat.S_IRUSR | stat.S_IXUSR)
        os.fsync(output_descriptor)
        os.close(output_descriptor)
        output_descriptor = None
        _fsync_directory(snapshot_directory)
        _verify_bound_descriptor(
            original_path,
            original_descriptor,
            original_identity,
            label=f"{expected_name} executable",
        )
        snapshot_descriptor, snapshot_identity = _open_bound_regular_file(
            snapshot_path, label=f"pinned {expected_name} executable"
        )
        snapshot_sha256, snapshot_bytes = _hash_descriptor(
            snapshot_descriptor, chunk_bytes=policy.copy_chunk_bytes
        )
        if snapshot_sha256 != digest.hexdigest() or snapshot_bytes != total:
            raise AudioProbeError(f"pinned {expected_name} executable failed verification")
        return _PinnedTool(
            expected_name=expected_name,
            original_path=original_path,
            original_descriptor=original_descriptor,
            original_identity=original_identity,
            snapshot_path=snapshot_path,
            snapshot_descriptor=snapshot_descriptor,
            snapshot_identity=snapshot_identity,
            sha256=digest.hexdigest(),
        )
    except Exception:
        if output_descriptor is not None:
            os.close(output_descriptor)
        if snapshot_descriptor is not None:
            os.close(snapshot_descriptor)
        os.close(original_descriptor)
        snapshot_path.unlink(missing_ok=True)
        raise


def _verify_pinned_tool(tool: _PinnedTool, policy: IngestPolicy, *, hash_bytes: bool) -> None:
    _verify_bound_descriptor(
        tool.original_path,
        tool.original_descriptor,
        tool.original_identity,
        label=f"{tool.expected_name} executable",
    )
    _verify_bound_descriptor(
        tool.snapshot_path,
        tool.snapshot_descriptor,
        tool.snapshot_identity,
        label=f"pinned {tool.expected_name} executable",
    )
    if not hash_bytes:
        return
    for descriptor, label in (
        (tool.original_descriptor, f"{tool.expected_name} executable"),
        (tool.snapshot_descriptor, f"pinned {tool.expected_name} executable"),
    ):
        digest, byte_length = _hash_descriptor(descriptor, chunk_bytes=policy.copy_chunk_bytes)
        if digest != tool.sha256 or byte_length != tool.original_identity.size:
            raise AudioProbeError(f"{label} content changed")


def _run_pinned_process(
    tool: _PinnedTool,
    arguments: Sequence[str],
    *,
    timeout_seconds: float,
    policy: IngestPolicy,
    max_captured_bytes: int,
    max_file_bytes: int | None = None,
) -> tuple[_ProcessResult, tuple[str, ...]]:
    _verify_pinned_tool(tool, policy, hash_bytes=False)
    command = (str(tool.snapshot_path), *arguments)
    result = _run_process(
        command,
        timeout_seconds=timeout_seconds,
        policy=policy,
        max_captured_bytes=max_captured_bytes,
        max_file_bytes=max_file_bytes,
    )
    _verify_pinned_tool(tool, policy, hash_bytes=False)
    return result, command


def _identify_pinned_tool(tool: _PinnedTool, policy: IngestPolicy) -> ToolIdentity:
    result, _ = _run_pinned_process(
        tool,
        ("-version",),
        timeout_seconds=policy.probe_timeout_seconds,
        policy=policy,
        max_captured_bytes=policy.max_probe_output_bytes,
    )
    stdout_lines = result.stdout.decode("utf-8", errors="replace").splitlines()
    stderr_lines = result.stderr.decode("utf-8", errors="replace").splitlines()
    lines = stdout_lines or stderr_lines
    version = lines[0].strip() if lines else ""
    expected_prefix = f"{tool.expected_name} version "
    if not version.startswith(expected_prefix) or len(version) <= len(expected_prefix):
        raise AudioProbeError(
            f"{tool.expected_name} -version did not identify the expected executable"
        )
    configuration = next(
        (
            line.removeprefix("configuration:").strip()
            for line in lines
            if line.startswith("configuration:")
        ),
        None,
    )
    identity = ToolIdentity(
        name=tool.original_path.name,
        path=str(tool.original_path),
        sha256=tool.sha256,
        version=version,
        build_configuration=configuration,
    )
    tool.identity = identity
    return identity


def _pin_tool(
    binary: str | os.PathLike[str],
    *,
    expected_name: str,
    snapshot_directory: Path,
    policy: IngestPolicy,
) -> _PinnedTool:
    tool = _snapshot_executable(
        binary,
        expected_name=expected_name,
        snapshot_directory=snapshot_directory,
        policy=policy,
    )
    try:
        _identify_pinned_tool(tool, policy)
        _verify_pinned_tool(tool, policy, hash_bytes=True)
        return tool
    except Exception:
        tool.close()
        raise


def _tool_identity(tool: _PinnedTool) -> ToolIdentity:
    if tool.identity is None:  # pragma: no cover - construction is fail-closed
        raise AudioProbeError(f"{tool.expected_name} identity is incomplete")
    return tool.identity


def tool_identity(
    binary: str | os.PathLike[str], policy: IngestPolicy = DEFAULT_POLICY
) -> ToolIdentity:
    requested_name = Path(os.fspath(binary)).name.casefold()
    expected_name = (
        "ffprobe"
        if requested_name.startswith("ffprobe")
        else "ffmpeg"
        if requested_name.startswith("ffmpeg")
        else requested_name
    )
    with tempfile.TemporaryDirectory(prefix=".opusloops-tool-identity-") as temporary:
        tool = _pin_tool(
            binary,
            expected_name=expected_name,
            snapshot_directory=Path(temporary),
            policy=policy,
        )
        try:
            return _tool_identity(tool)
        finally:
            tool.close()


def _number(value: Any) -> float | None:
    if value in {None, "", "N/A"}:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _integer(value: Any) -> int | None:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _packet_summary(packet: dict[str, Any] | None) -> dict[str, Any] | None:
    if packet is None:
        return None
    allowed = (
        "stream_index",
        "pts",
        "pts_time",
        "dts",
        "dts_time",
        "duration",
        "duration_time",
        "size",
        "flags",
        "side_data_list",
    )
    return {key: packet[key] for key in allowed if key in packet}


def _packet_timestamp(packet: dict[str, Any] | None) -> float | None:
    if not packet:
        return None
    pts = _number(packet.get("pts_time"))
    return pts if pts is not None else _number(packet.get("dts_time"))


def _side_data_amount(packets: list[dict[str, Any]], key: str) -> int:
    values: list[int] = []
    for packet in packets:
        side_data = packet.get("side_data_list", [])
        if not isinstance(side_data, list):
            continue
        for item in side_data:
            if isinstance(item, dict):
                parsed = _integer(item.get(key))
                if parsed is not None and parsed >= 0:
                    values.append(parsed)
    return max(values, default=0)


def _packet_timeline_duration(packets: list[dict[str, Any]]) -> float | None:
    starts: list[float] = []
    ends: list[float] = []
    for packet in packets:
        timestamp = _packet_timestamp(packet)
        if timestamp is None:
            continue
        packet_duration = _number(packet.get("duration_time")) or 0.0
        if packet_duration < 0:
            continue
        starts.append(timestamp)
        ends.append(timestamp + packet_duration)
    if not starts or not ends:
        return None
    duration = max(ends) - min(starts)
    return duration if duration > 0 and math.isfinite(duration) else None


def _probe_audio_with_tool(
    source: Path,
    source_descriptor: int,
    source_identity: _FileIdentity,
    source_sha256: str,
    source_bytes: int,
    policy: IngestPolicy,
    ffprobe: _PinnedTool,
) -> AudioProbe:
    arguments_tail = [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-select_streams",
        "a",
        "-show_streams",
        "-show_format",
        "-show_packets",
        "-of",
        "json",
        str(source),
    ]
    result, arguments = _run_pinned_process(
        ffprobe,
        arguments_tail,
        timeout_seconds=policy.probe_timeout_seconds,
        policy=policy,
        max_captured_bytes=policy.max_probe_output_bytes,
        max_file_bytes=policy.max_probe_output_bytes,
    )
    try:
        payload = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AudioProbeError("ffprobe did not return valid JSON") from error
    if not isinstance(payload, dict):
        raise AudioProbeError("ffprobe JSON root is not an object")

    streams = payload.get("streams", [])
    if not isinstance(streams, list) or not streams:
        raise AudioProbeError("file has no audio stream")
    if len(streams) > policy.max_audio_streams_per_file:
        raise AudioProbeError(
            f"file has {len(streams)} audio streams; policy allows "
            f"{policy.max_audio_streams_per_file}"
        )
    stream = streams[0]
    if not isinstance(stream, dict):
        raise AudioProbeError("ffprobe returned an invalid audio stream")
    stream_index = _integer(stream.get("index"))
    sample_rate = _integer(stream.get("sample_rate"))
    channels = _integer(stream.get("channels"))
    if stream_index is None or sample_rate is None or sample_rate <= 0:
        raise AudioProbeError("audio stream is missing a valid index or sample rate")
    if channels is None or channels <= 0:
        raise AudioProbeError("audio stream is missing a valid channel count")
    if channels > policy.max_channels_per_stem:
        raise AudioProbeError(
            f"audio stream has {channels} channels; policy allows {policy.max_channels_per_stem}"
        )

    packets_raw = payload.get("packets", [])
    packets = (
        [
            packet
            for packet in packets_raw
            if isinstance(packet, dict) and _integer(packet.get("stream_index")) == stream_index
        ]
        if isinstance(packets_raw, list)
        else []
    )
    first_packet = packets[0] if packets else None
    last_packet = packets[-1] if packets else None
    format_info = payload.get("format", {})
    if not isinstance(format_info, dict):
        format_info = {}
    stream_duration = _number(stream.get("duration"))
    format_duration = _number(format_info.get("duration"))
    packet_duration = _packet_timeline_duration(packets)
    if packet_duration is not None:
        duration = packet_duration
        duration_source = "packet-timeline"
    elif stream_duration is not None:
        duration = stream_duration
        duration_source = "stream-declaration"
    else:
        duration = format_duration
        duration_source = "format-declaration"
    if duration is None or duration <= 0:
        raise AudioProbeError("audio stream is missing a positive finite duration")
    if duration > policy.max_audio_duration_seconds:
        raise AudioProbeError(
            f"audio duration {duration:.6f}s exceeds "
            f"{policy.max_audio_duration_seconds:.6f}s policy limit"
        )

    final_sha256, final_bytes = _hash_descriptor(
        source_descriptor, chunk_bytes=policy.copy_chunk_bytes
    )
    _verify_bound_descriptor(
        source,
        source_descriptor,
        source_identity,
        label="audio source",
    )
    if final_sha256 != source_sha256 or final_bytes != source_bytes:
        raise AudioProbeError("audio source changed while it was being probed")
    tags = stream.get("tags", {})
    if not isinstance(tags, dict):
        tags = {}
    clean_tags = {str(key): str(value) for key, value in tags.items()}
    bit_rate = _integer(stream.get("bit_rate")) or _integer(format_info.get("bit_rate"))
    _verify_pinned_tool(ffprobe, policy, hash_bytes=True)
    sanitized = tuple(
        "<source>"
        if argument == str(source)
        else "<pinned-ffprobe>"
        if argument == str(ffprobe.snapshot_path)
        else argument
        for argument in arguments
    )
    return AudioProbe(
        source_path=source,
        source_name=source.name,
        source_bytes=source_bytes,
        source_sha256=source_sha256,
        stream_index=stream_index,
        audio_stream_count=len(streams),
        codec=str(stream.get("codec_name", "unknown")),
        codec_long_name=(str(stream["codec_long_name"]) if stream.get("codec_long_name") else None),
        profile=(str(stream["profile"]) if stream.get("profile") else None),
        sample_format=(str(stream["sample_fmt"]) if stream.get("sample_fmt") else None),
        sample_rate=sample_rate,
        channels=channels,
        channel_layout=(str(stream["channel_layout"]) if stream.get("channel_layout") else None),
        time_base=(str(stream["time_base"]) if stream.get("time_base") else None),
        stream_start_time=_number(stream.get("start_time")),
        first_packet_timestamp=_packet_timestamp(first_packet),
        duration_seconds=duration,
        duration_source=duration_source,
        packet_timeline_duration_seconds=packet_duration,
        stream_declared_duration_seconds=stream_duration,
        format_declared_duration_seconds=format_duration,
        bit_rate=bit_rate,
        packet_count=len(packets),
        skip_samples=_side_data_amount(packets[:2], "skip_samples"),
        discard_padding=_side_data_amount(packets[-2:], "discard_padding"),
        tags=clean_tags,
        first_packet=_packet_summary(first_packet),
        last_packet=_packet_summary(last_packet),
        ffprobe=_tool_identity(ffprobe),
        sanitized_arguments=sanitized,
    )


def probe_audio(
    source_path: str | os.PathLike[str],
    policy: IngestPolicy = DEFAULT_POLICY,
    *,
    ffprobe_bin: str | os.PathLike[str] = "ffprobe",
) -> AudioProbe:
    """Probe one local audio file and enforce duration/channel/stream ceilings."""

    requested_source = Path(source_path)
    try:
        source_stat = requested_source.stat(follow_symlinks=False)
    except OSError as error:
        raise AudioProbeError(f"cannot stat audio source: {error}") from error
    if not stat.S_ISREG(source_stat.st_mode):
        raise AudioProbeError("audio source must be a regular file, not a symlink")
    source = Path(os.path.abspath(requested_source))
    with tempfile.TemporaryDirectory(prefix=".opusloops-ffprobe-") as temporary:
        ffprobe = _pin_tool(
            ffprobe_bin,
            expected_name="ffprobe",
            snapshot_directory=Path(temporary),
            policy=policy,
        )
        source_descriptor: int | None = None
        try:
            source_descriptor, source_identity = _open_bound_regular_file(
                source, label="audio source"
            )
            source_sha256, source_bytes = _hash_descriptor(
                source_descriptor, chunk_bytes=policy.copy_chunk_bytes
            )
            if source_bytes != source_identity.size:
                raise AudioProbeError("audio source changed while it was being hashed")
            return _probe_audio_with_tool(
                source,
                source_descriptor,
                source_identity,
                source_sha256,
                source_bytes,
                policy,
                ffprobe,
            )
        finally:
            if source_descriptor is not None:
                os.close(source_descriptor)
            ffprobe.close()


@dataclass(frozen=True, slots=True)
class _WaveLayout:
    channels: int
    sample_rate: int
    block_align: int
    bits_per_sample: int
    data_offset: int
    data_bytes: int


_IEEE_FLOAT_SUBFORMAT = bytes.fromhex("0300000000001000800000aa00389b71")


def _parse_canonical_wave(descriptor: int) -> _WaveLayout:
    """Parse enough RIFF/WAVE to validate the exact canonical data payload."""

    file_bytes = os.fstat(descriptor).st_size
    with os.fdopen(os.dup(descriptor), "rb") as stream:
        header = stream.read(12)
        if len(header) != 12 or header[:4] != b"RIFF" or header[8:] != b"WAVE":
            raise AudioProbeError("canonical output is not a RIFF/WAVE file")
        declared_riff_bytes = struct.unpack_from("<I", header, 4)[0] + 8
        if declared_riff_bytes != file_bytes:
            raise AudioProbeError("canonical WAVE RIFF size does not match the file length")
        format_values: tuple[int, int, int, int, int, int] | None = None
        float_format = False
        data_chunk: tuple[int, int] | None = None
        position = 12
        while position < file_bytes:
            stream.seek(position)
            chunk_header = stream.read(8)
            if len(chunk_header) != 8:
                raise AudioProbeError("canonical WAVE has a truncated chunk header")
            chunk_id = chunk_header[:4]
            chunk_bytes = struct.unpack_from("<I", chunk_header, 4)[0]
            payload_offset = position + 8
            payload_end = payload_offset + chunk_bytes
            padded_end = payload_end + (chunk_bytes & 1)
            if payload_end > file_bytes or padded_end > file_bytes:
                raise AudioProbeError("canonical WAVE chunk exceeds the file length")
            if chunk_id == b"fmt ":
                if format_values is not None or chunk_bytes < 16:
                    raise AudioProbeError("canonical WAVE has an invalid or duplicate fmt chunk")
                stream.seek(payload_offset)
                payload = stream.read(chunk_bytes)
                format_values = struct.unpack_from("<HHIIHH", payload)
                format_tag = format_values[0]
                if format_tag == 3:
                    float_format = True
                elif format_tag == 0xFFFE and chunk_bytes >= 40:
                    float_format = payload[24:40] == _IEEE_FLOAT_SUBFORMAT
            elif chunk_id == b"data":
                if data_chunk is not None:
                    raise AudioProbeError("canonical WAVE has multiple data chunks")
                data_chunk = (payload_offset, chunk_bytes)
            position = padded_end
        if position != file_bytes:
            raise AudioProbeError("canonical WAVE chunk alignment is invalid")
    if format_values is None or data_chunk is None:
        raise AudioProbeError("canonical WAVE is missing fmt or data")
    _, channels, sample_rate, byte_rate, block_align, bits_per_sample = format_values
    if not float_format or bits_per_sample != 32:
        raise AudioProbeError("canonical WAVE is not IEEE float32")
    if channels <= 0 or block_align != channels * 4:
        raise AudioProbeError("canonical WAVE has invalid channel block alignment")
    if byte_rate != sample_rate * block_align:
        raise AudioProbeError("canonical WAVE has an invalid byte rate")
    if data_chunk[1] <= 0 or data_chunk[1] % block_align:
        raise AudioProbeError("canonical WAVE data has an invalid byte/frame length")
    return _WaveLayout(
        channels=channels,
        sample_rate=sample_rate,
        block_align=block_align,
        bits_per_sample=bits_per_sample,
        data_offset=data_chunk[0],
        data_bytes=data_chunk[1],
    )


def _validate_samples_and_measure_leading_silence(
    descriptor: int,
    *,
    layout: _WaveLayout,
    epsilon: float,
) -> tuple[int, float]:
    leading_frames = 0
    found_signal = False
    peak = 0.0
    frame_bytes = layout.block_align
    with os.fdopen(os.dup(descriptor), "rb") as stream:
        stream.seek(layout.data_offset)
        remaining = layout.data_bytes
        while remaining:
            raw = stream.read(min(remaining, frame_bytes * 65_536))
            if not raw:
                raise AudioProbeError("canonical WAVE data ended unexpectedly")
            remaining -= len(raw)
            if len(raw) % frame_bytes:
                raise AudioProbeError("canonical PCM ended with a partial frame")
            samples = array.array("f")
            samples.frombytes(raw)
            if samples.itemsize != 4:
                raise AudioProbeError("this runtime does not provide 32-bit float arrays")
            if sys.byteorder != "little":
                samples.byteswap()
            for frame_start in range(0, len(samples), layout.channels):
                frame_peak = 0.0
                for sample in samples[frame_start : frame_start + layout.channels]:
                    if not math.isfinite(sample):
                        raise AudioProbeError("canonical PCM contains NaN or infinity")
                    absolute = abs(sample)
                    peak = max(peak, absolute)
                    frame_peak = max(frame_peak, absolute)
                if not found_signal:
                    if frame_peak > epsilon:
                        found_signal = True
                    else:
                        leading_frames += 1
    return leading_frames, peak


def decode_canonical(
    source_path: str | os.PathLike[str],
    output_path: str | os.PathLike[str],
    policy: IngestPolicy = DEFAULT_POLICY,
    *,
    ffmpeg_bin: str | os.PathLike[str] = "ffmpeg",
    ffprobe_bin: str | os.PathLike[str] = "ffprobe",
    probe: AudioProbe | None = None,
) -> CanonicalAudio:
    """Decode one approved audio stream to an atomic 48 kHz float32 WAVE."""

    requested_source = Path(source_path).expanduser()
    try:
        source_stat = requested_source.stat(follow_symlinks=False)
    except OSError as error:
        raise AudioProbeError(f"cannot stat audio source: {error}") from error
    if not stat.S_ISREG(source_stat.st_mode):
        raise AudioProbeError("audio source must be a regular file, not a symlink")
    source = Path(os.path.abspath(requested_source))

    requested_output = Path(output_path).expanduser()
    if requested_output.suffix.casefold() != ".wav":
        raise AudioProbeError("canonical output must use a .wav path")
    requested_output.parent.mkdir(parents=True, exist_ok=True)
    output_parent = requested_output.parent.resolve(strict=True)
    output = output_parent / requested_output.name
    output_parent_descriptor, output_parent_identity = _open_bound_directory(
        output_parent, label="canonical output directory"
    )
    staging_dir: Path | None = None
    source_descriptor: int | None = None
    staged_descriptor: int | None = None
    ffmpeg: _PinnedTool | None = None
    ffprobe: _PinnedTool | None = None
    try:
        _require_destination_absent(output_parent_descriptor, output.name)
        staging_dir = Path(tempfile.mkdtemp(prefix=f".{output.name}.decode-", dir=output_parent))
        staging_dir.chmod(stat.S_IRWXU)
        if stat.S_IMODE(staging_dir.stat(follow_symlinks=False).st_mode) != 0o700:
            raise AudioProbeError("canonical staging directory is not owner-only")
        tools_directory = staging_dir / "tools"

        # Snapshot, hash, and identify both executables before decoding. All
        # subsequent invocations use these private immutable-by-convention
        # copies, while their original path identities remain held and checked.
        ffmpeg = _pin_tool(
            ffmpeg_bin,
            expected_name="ffmpeg",
            snapshot_directory=tools_directory / "ffmpeg",
            policy=policy,
        )
        ffprobe = _pin_tool(
            ffprobe_bin,
            expected_name="ffprobe",
            snapshot_directory=tools_directory / "ffprobe",
            policy=policy,
        )

        source_descriptor, source_identity = _open_bound_regular_file(source, label="audio source")
        source_sha256, source_bytes = _hash_descriptor(
            source_descriptor, chunk_bytes=policy.copy_chunk_bytes
        )
        _verify_bound_descriptor(source, source_descriptor, source_identity, label="audio source")
        if source_bytes != source_identity.size:
            raise AudioProbeError("audio source changed while it was being hashed")

        if probe is None:
            probe = _probe_audio_with_tool(
                source,
                source_descriptor,
                source_identity,
                source_sha256,
                source_bytes,
                policy,
                ffprobe,
            )
        else:
            if probe.source_path != source:
                raise AudioProbeError("provided probe belongs to a different source path")
            if probe.source_sha256 != source_sha256 or probe.source_bytes != source_bytes:
                raise AudioProbeError("audio source changed after probing")
            if probe.ffprobe != _tool_identity(ffprobe):
                raise AudioProbeError("provided probe FFprobe provenance no longer matches")

        staged_output = staging_dir / "canonical.wav"
        arguments_tail = [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "file",
            "-i",
            str(source),
            "-map",
            f"0:{probe.stream_index}",
            "-vn",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-threads",
            "1",
            "-bitexact",
            "-ar",
            str(policy.canonical_sample_rate),
            "-c:a",
            "pcm_f32le",
            "-f",
            "wav",
            "-n",
            str(staged_output),
        ]
        _, arguments = _run_pinned_process(
            ffmpeg,
            arguments_tail,
            timeout_seconds=policy.decode_timeout_seconds,
            policy=policy,
            max_captured_bytes=policy.max_probe_output_bytes,
            max_file_bytes=policy.max_canonical_output_bytes_per_stem,
        )
        staged_descriptor, _ = _open_bound_regular_file(
            staged_output, label="staged canonical WAVE", writable=True
        )
        os.fchmod(staged_descriptor, stat.S_IRUSR | stat.S_IWUSR)
        staged_identity = _identity(os.fstat(staged_descriptor))
        if stat.S_IMODE(staged_identity.mode) != 0o600:
            raise AudioProbeError("staged canonical WAVE is not owner-only")
        output_bytes = staged_identity.size
        layout = _parse_canonical_wave(staged_descriptor)
        _verify_bound_descriptor(
            staged_output,
            staged_descriptor,
            staged_identity,
            label="staged canonical WAVE",
        )
        if layout.channels != probe.channels:
            raise AudioProbeError("canonical WAVE changed the approved channel count")
        if layout.sample_rate != policy.canonical_sample_rate:
            raise AudioProbeError("canonical WAVE does not use the policy sample rate")
        frames = layout.data_bytes // layout.block_align
        # Decoder output may differ slightly from container duration due to codec
        # delay/padding, but it may not exceed the declared duration by >1 second.
        maximum_frames = math.ceil((probe.duration_seconds + 1.0) * policy.canonical_sample_rate)
        if frames > maximum_frames:
            raise AudioProbeError("decoded frame count exceeds probed duration allowance")
        leading_frames, peak = _validate_samples_and_measure_leading_silence(
            staged_descriptor, layout=layout, epsilon=policy.silence_epsilon
        )
        _verify_bound_descriptor(
            staged_output,
            staged_descriptor,
            staged_identity,
            label="staged canonical WAVE",
        )
        output_sha256, hashed_bytes = _hash_descriptor(
            staged_descriptor, chunk_bytes=policy.copy_chunk_bytes
        )
        _verify_bound_descriptor(
            staged_output,
            staged_descriptor,
            staged_identity,
            label="staged canonical WAVE",
        )
        if hashed_bytes != output_bytes:
            raise AudioProbeError("canonical PCM changed while it was being hashed")

        final_source_sha256, final_source_bytes = _hash_descriptor(
            source_descriptor, chunk_bytes=policy.copy_chunk_bytes
        )
        _verify_bound_descriptor(source, source_descriptor, source_identity, label="audio source")
        if final_source_sha256 != probe.source_sha256 or final_source_bytes != probe.source_bytes:
            raise AudioProbeError("audio source changed during canonical decoding")
        _verify_pinned_tool(ffmpeg, policy, hash_bytes=True)
        _verify_pinned_tool(ffprobe, policy, hash_bytes=True)
        _verify_bound_directory(
            output_parent,
            output_parent_descriptor,
            output_parent_identity,
            label="canonical output directory",
        )
        os.fsync(staged_descriptor)

        timeline_start = probe.timeline_start_seconds
        sanitized = tuple(
            "<source>"
            if argument == str(source)
            else "<canonical-output>"
            if argument == str(staged_output)
            else "<pinned-ffmpeg>"
            if argument == str(ffmpeg.snapshot_path)
            else argument
            for argument in arguments
        )
        canonical = CanonicalAudio(
            source_name=source.name,
            source_sha256=probe.source_sha256,
            output_path=output,
            sample_rate=policy.canonical_sample_rate,
            channels=probe.channels,
            frames=frames,
            bytes=output_bytes,
            audio_data_bytes=layout.data_bytes,
            sha256=output_sha256,
            timeline_start_seconds=timeline_start,
            timeline_offset_frames=round(timeline_start * policy.canonical_sample_rate),
            leading_silence_frames=leading_frames,
            leading_silence_seconds=leading_frames / policy.canonical_sample_rate,
            silence_epsilon=policy.silence_epsilon,
            peak_absolute_sample=peak,
            ffmpeg=_tool_identity(ffmpeg),
            sanitized_arguments=sanitized,
        )
        _publish_noreplace(
            staged_output,
            staged_descriptor,
            staged_identity,
            output_parent_descriptor=output_parent_descriptor,
            output_name=output.name,
        )
        return canonical
    finally:
        if staged_descriptor is not None:
            os.close(staged_descriptor)
        if source_descriptor is not None:
            os.close(source_descriptor)
        if ffprobe is not None:
            ffprobe.close()
        if ffmpeg is not None:
            ffmpeg.close()
        if staging_dir is not None:
            shutil.rmtree(staging_dir, ignore_errors=True)
        os.close(output_parent_descriptor)


__all__ = [
    "AudioProbe",
    "AudioProbeError",
    "CanonicalAudio",
    "ToolIdentity",
    "decode_canonical",
    "probe_audio",
    "tool_identity",
]
