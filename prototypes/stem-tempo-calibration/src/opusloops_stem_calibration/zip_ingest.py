"""Fail-closed ZIP inventory and streamed extraction for stem archives."""

from __future__ import annotations

import base64
import ctypes
import errno
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import unicodedata
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO

from .policy import DEFAULT_POLICY, IngestPolicy

_DRIVE_PATH = re.compile(r"^[A-Za-z]:")


class ZipIngestError(RuntimeError):
    """Base error for archive inspection or extraction failures."""


class ZipPolicyError(ZipIngestError):
    """An archive violates the versioned resource or path policy."""

    def __init__(self, message: str, *, inventory: ZipInventory | None = None) -> None:
        super().__init__(message)
        self.inventory = inventory


@dataclass(frozen=True, slots=True)
class ExtractionProgress:
    completed_files: int
    total_files: int
    completed_uncompressed_bytes: int
    total_uncompressed_bytes: int
    current_asset_id: str | None
    current_name: str | None

    def to_dict(self) -> dict[str, int | str | None]:
        return {
            "completed_files": self.completed_files,
            "total_files": self.total_files,
            "completed_uncompressed_bytes": self.completed_uncompressed_bytes,
            "total_uncompressed_bytes": self.total_uncompressed_bytes,
            "current_asset_id": self.current_asset_id,
            "current_name": self.current_name,
        }


ExtractionProgressCallback = Callable[[ExtractionProgress], None]


class _ExtractionProgressCallbackError(ZipIngestError):
    """A caller callback failed while observing measured extraction progress."""


def _report_progress(
    callback: ExtractionProgressCallback | None,
    progress: ExtractionProgress,
) -> None:
    if callback is None:
        return
    try:
        callback(progress)
    except Exception as error:
        raise _ExtractionProgressCallbackError("extraction progress callback failed") from error


@dataclass(frozen=True, slots=True)
class ZipEntryRecord:
    asset_id: str | None
    original_name: str
    normalized_name: str | None
    compressed_bytes: int
    uncompressed_bytes: int
    crc32: str
    compression_method: int
    outcome: str
    reason: str | None = None
    sha256: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "asset_id": self.asset_id,
            "original_name": self.original_name,
            "normalized_name": self.normalized_name,
            "compressed_bytes": self.compressed_bytes,
            "uncompressed_bytes": self.uncompressed_bytes,
            "crc32": self.crc32,
            "compression_method": self.compression_method,
            "sha256": self.sha256,
            "outcome": self.outcome,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class ZipInventory:
    archive_name: str
    archive_bytes: int
    archive_sha256: str
    zip_comment_base64: str
    policy_version: str
    entries: tuple[ZipEntryRecord, ...]

    @property
    def accepted_entries(self) -> tuple[ZipEntryRecord, ...]:
        return tuple(entry for entry in self.entries if entry.outcome == "accepted")

    @property
    def rejected_entries(self) -> tuple[ZipEntryRecord, ...]:
        return tuple(entry for entry in self.entries if entry.outcome == "rejected")

    @property
    def ignored_entries(self) -> tuple[ZipEntryRecord, ...]:
        return tuple(entry for entry in self.entries if entry.outcome == "ignored")

    @property
    def total_compressed_bytes(self) -> int:
        return sum(entry.compressed_bytes for entry in self.entries)

    @property
    def total_uncompressed_bytes(self) -> int:
        return sum(entry.uncompressed_bytes for entry in self.entries)

    @property
    def accepted_uncompressed_bytes(self) -> int:
        return sum(entry.uncompressed_bytes for entry in self.accepted_entries)

    @property
    def central_directory_sha256(self) -> str:
        central = [
            {
                key: value
                for key, value in entry.to_dict().items()
                if key not in {"asset_id", "sha256"}
            }
            for entry in self.entries
        ]
        return hashlib.sha256(_canonical_json_bytes(central)).hexdigest()

    @property
    def inventory_sha256(self) -> str:
        return hashlib.sha256(_canonical_json_bytes(self.to_dict(include_hash=False))).hexdigest()

    def to_dict(self, *, include_hash: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "archive_name": self.archive_name,
            "archive_bytes": self.archive_bytes,
            "archive_sha256": self.archive_sha256,
            "zip_comment": {"encoding": "base64", "value": self.zip_comment_base64},
            "policy_version": self.policy_version,
            "central_directory_sha256": self.central_directory_sha256,
            "entries": [entry.to_dict() for entry in self.entries],
            "totals": {
                "entries": len(self.entries),
                "accepted_audio_entries": len(self.accepted_entries),
                "compressed_bytes": self.total_compressed_bytes,
                "uncompressed_bytes": self.total_uncompressed_bytes,
                "accepted_uncompressed_bytes": self.accepted_uncompressed_bytes,
            },
        }
        if include_hash:
            result["inventory_sha256"] = self.inventory_sha256
        return result

    def require_acceptable(self) -> None:
        if self.rejected_entries:
            details = "; ".join(
                f"{entry.original_name!r}: {entry.reason}" for entry in self.rejected_entries
            )
            raise ZipPolicyError(f"archive rejected: {details}", inventory=self)


def _canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _sha256_stream(
    stream: BinaryIO,
    *,
    chunk_bytes: int,
    max_bytes: int,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    while chunk := stream.read(min(chunk_bytes, max_bytes - total + 1)):
        digest.update(chunk)
        total += len(chunk)
        if total > max_bytes:
            raise ZipPolicyError("archive byte limit exceeded")
    return digest.hexdigest(), total


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _path_matches_descriptor(path: Path, opened_stat: os.stat_result) -> bool:
    try:
        path_stat = path.stat(follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISREG(path_stat.st_mode) and (path_stat.st_dev, path_stat.st_ino) == (
        opened_stat.st_dev,
        opened_stat.st_ino,
    )


@dataclass(frozen=True, slots=True)
class _PinnedArchive:
    path: Path
    stream: BinaryIO
    initial_stat: os.stat_result
    sha256: str
    bytes: int


@contextmanager
def _open_pinned_archive(path: Path, policy: IngestPolicy) -> Iterator[_PinnedArchive]:
    """Hold one no-follow descriptor for hashing, ZIP parsing, and extraction."""

    if path.is_symlink():
        raise ZipPolicyError("archive must be a regular file, not a symlink or special file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ZipIngestError(f"cannot safely open archive: {error}") from error
    try:
        opened_stat = os.fstat(descriptor)
        if not stat.S_ISREG(opened_stat.st_mode) or not _path_matches_descriptor(path, opened_stat):
            raise ZipPolicyError("archive must be a regular file, not a symlink or special file")
        if opened_stat.st_size > policy.max_archive_bytes:
            raise ZipPolicyError("archive byte limit exceeded")
        stream = os.fdopen(descriptor, "rb")
    except Exception:
        os.close(descriptor)
        raise

    with stream:
        stream.seek(0)
        archive_sha256, archive_bytes = _sha256_stream(
            stream,
            chunk_bytes=policy.copy_chunk_bytes,
            max_bytes=policy.max_archive_bytes,
        )
        hashed_stat = os.fstat(stream.fileno())
        if (
            archive_bytes != opened_stat.st_size
            or _stat_identity(opened_stat) != _stat_identity(hashed_stat)
            or not _path_matches_descriptor(path, hashed_stat)
        ):
            raise ZipIngestError("archive changed while it was being hashed")
        stream.seek(0)
        yield _PinnedArchive(
            path=path,
            stream=stream,
            initial_stat=opened_stat,
            sha256=archive_sha256,
            bytes=archive_bytes,
        )

        before_final_hash = os.fstat(stream.fileno())
        stream.seek(0)
        final_sha256, final_bytes = _sha256_stream(
            stream,
            chunk_bytes=policy.copy_chunk_bytes,
            max_bytes=policy.max_archive_bytes,
        )
        final_stat = os.fstat(stream.fileno())
        if (
            _stat_identity(opened_stat) != _stat_identity(before_final_hash)
            or _stat_identity(opened_stat) != _stat_identity(final_stat)
            or not _path_matches_descriptor(path, final_stat)
            or final_bytes != archive_bytes
            or final_sha256 != archive_sha256
        ):
            raise ZipIngestError("archive changed while its pinned descriptor was consumed")


def _normalize_member_name(name: str) -> tuple[str | None, str | None]:
    """Return (normalized path, rejection reason)."""

    if not name:
        return None, "empty member name"
    if any(unicodedata.category(character).startswith("C") for character in name):
        return None, "member name contains a NUL or control character"
    if "\\" in name:
        return None, "backslashes and Windows/UNC paths are not allowed"
    if name.startswith(("/", "//")) or _DRIVE_PATH.match(name):
        return None, "absolute, drive-qualified, or UNC path is not allowed"

    normalized_unicode = unicodedata.normalize("NFC", name)
    raw_parts = normalized_unicode.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts[:-1]):
        return None, "empty, dot, or parent path component is not allowed"
    # A trailing slash is valid only for a directory entry and is handled by the caller.
    if raw_parts[-1] in {".", ".."}:
        return None, "dot or parent path component is not allowed"
    parts = [part for part in raw_parts if part]
    if not parts:
        return None, "member does not name a file or directory"
    normalized = PurePosixPath(*parts).as_posix()
    if normalized.startswith("../") or normalized == "..":
        return None, "parent traversal is not allowed"
    return normalized, None


def _entry_kind(info: zipfile.ZipInfo) -> str:
    if info.is_dir() or info.filename.endswith("/"):
        return "directory"
    if info.create_system == 3:
        mode = (info.external_attr >> 16) & 0xFFFF
        file_type = stat.S_IFMT(mode)
        if file_type == stat.S_IFLNK:
            return "symlink"
        # Some ZIP writers preserve only Unix permission bits, with no file-type
        # bits.  Treat that conventional zero type as a regular file.
        if file_type and file_type != stat.S_IFREG:
            return "special"
    return "file"


def _is_ignored_metadata(normalized_name: str) -> bool:
    path = PurePosixPath(normalized_name)
    return bool(path.parts and path.parts[0] == "__MACOSX") or path.name == ".DS_Store"


def _preflight_entry(
    info: zipfile.ZipInfo,
    *,
    archive_sha256: str,
    policy: IngestPolicy,
) -> ZipEntryRecord:
    normalized_name, path_error = _normalize_member_name(info.filename)
    common = {
        "asset_id": None,
        "original_name": info.filename,
        "normalized_name": normalized_name,
        "compressed_bytes": info.compress_size,
        "uncompressed_bytes": info.file_size,
        "crc32": f"{info.CRC:08x}",
        "compression_method": info.compress_type,
    }
    if path_error:
        return ZipEntryRecord(**common, outcome="rejected", reason=path_error)

    assert normalized_name is not None
    if len(normalized_name.encode()) > policy.max_member_name_bytes:
        return ZipEntryRecord(
            **common, outcome="rejected", reason="member name byte limit exceeded"
        )
    if any(
        len(part.encode()) > policy.max_path_component_bytes
        for part in PurePosixPath(normalized_name).parts
    ):
        return ZipEntryRecord(
            **common, outcome="rejected", reason="path component byte limit exceeded"
        )
    kind = _entry_kind(info)
    if kind in {"symlink", "special"}:
        return ZipEntryRecord(
            **common, outcome="rejected", reason=f"{kind} archive members are not allowed"
        )
    if info.flag_bits & 0x1:
        return ZipEntryRecord(**common, outcome="rejected", reason="encrypted member")
    if info.compress_type not in policy.allowed_zip_compression_methods:
        return ZipEntryRecord(
            **common,
            outcome="rejected",
            reason=f"unsupported ZIP compression method {info.compress_type}",
        )
    if kind == "directory":
        return ZipEntryRecord(**common, outcome="ignored", reason="directory")
    if _is_ignored_metadata(normalized_name):
        return ZipEntryRecord(**common, outcome="ignored", reason="explicit metadata")

    suffix = PurePosixPath(normalized_name).suffix.casefold()
    if suffix in policy.rejected_archive_extensions:
        return ZipEntryRecord(**common, outcome="rejected", reason="nested archive")
    if suffix not in policy.allowed_audio_extensions:
        return ZipEntryRecord(**common, outcome="rejected", reason="unsupported media type")
    if info.file_size <= 0:
        return ZipEntryRecord(**common, outcome="rejected", reason="empty audio member")
    if info.compress_size > policy.max_entry_compressed_bytes:
        return ZipEntryRecord(
            **common, outcome="rejected", reason="per-entry compressed byte limit exceeded"
        )
    if info.file_size > policy.max_entry_uncompressed_bytes:
        return ZipEntryRecord(
            **common, outcome="rejected", reason="per-entry uncompressed byte limit exceeded"
        )
    ratio = float("inf") if info.compress_size == 0 else info.file_size / info.compress_size
    if ratio > policy.max_compression_ratio:
        return ZipEntryRecord(
            **common, outcome="rejected", reason="per-entry compression ratio limit exceeded"
        )

    asset_material = f"{archive_sha256}\0{normalized_name}".encode()
    asset_id = "asset_" + hashlib.sha256(asset_material).hexdigest()[:24]
    return replace(ZipEntryRecord(**common, outcome="accepted"), asset_id=asset_id)


def _inventory_from_zipfile(
    archive: zipfile.ZipFile,
    *,
    archive_name: str,
    archive_sha256: str,
    archive_bytes: int,
    policy: IngestPolicy,
    fail_on_rejected: bool,
) -> ZipInventory:
    infos = archive.infolist()
    if len(infos) > policy.max_total_entries:
        raise ZipPolicyError("archive entry count limit exceeded")
    records = tuple(
        _preflight_entry(info, archive_sha256=archive_sha256, policy=policy) for info in infos
    )
    comment = base64.b64encode(archive.comment).decode("ascii")

    # Duplicate normalized/case-folded paths and file-as-parent collisions are
    # ambiguous across filesystems, so mark every implicated entry rejected.
    mutable = list(records)
    seen: dict[str, int] = {}
    normalized_files: dict[str, int] = {}
    for index, record in enumerate(records):
        if record.normalized_name is None:
            continue
        collision_key = record.normalized_name.casefold()
        if collision_key in seen:
            prior = seen[collision_key]
            mutable[prior] = replace(
                mutable[prior], outcome="rejected", reason="duplicate Unicode/casefolded path"
            )
            mutable[index] = replace(
                record, outcome="rejected", reason="duplicate Unicode/casefolded path"
            )
        else:
            seen[collision_key] = index
        if record.outcome == "accepted":
            normalized_files[collision_key] = index

    for path_key, index in tuple(normalized_files.items()):
        parts = path_key.split("/")
        for stop in range(1, len(parts)):
            parent_key = "/".join(parts[:stop])
            if parent_key in normalized_files:
                other = normalized_files[parent_key]
                reason = "file/directory ancestor collision"
                mutable[index] = replace(mutable[index], outcome="rejected", reason=reason)
                mutable[other] = replace(mutable[other], outcome="rejected", reason=reason)

    records = tuple(mutable)
    accepted = tuple(record for record in records if record.outcome == "accepted")
    total_compressed = sum(record.compressed_bytes for record in records)
    total_uncompressed = sum(record.uncompressed_bytes for record in records)
    aggregate_ratio = (
        float("inf")
        if total_compressed == 0 and total_uncompressed
        else total_uncompressed / max(1, total_compressed)
    )
    aggregate_error: str | None = None
    if len(accepted) > policy.max_audio_entries:
        aggregate_error = "accepted audio entry count limit exceeded"
    elif total_compressed > policy.max_aggregate_compressed_bytes:
        aggregate_error = "aggregate compressed byte limit exceeded"
    elif total_uncompressed > policy.max_aggregate_uncompressed_bytes:
        aggregate_error = "aggregate uncompressed byte limit exceeded"
    elif aggregate_ratio > policy.max_compression_ratio:
        aggregate_error = "aggregate compression ratio limit exceeded"
    if aggregate_error:
        records = tuple(
            replace(record, outcome="rejected", reason=aggregate_error)
            if record.outcome == "accepted"
            else record
            for record in records
        )

    inventory = ZipInventory(
        archive_name=archive_name,
        archive_bytes=archive_bytes,
        archive_sha256=archive_sha256,
        zip_comment_base64=comment,
        policy_version=policy.version,
        entries=records,
    )
    if fail_on_rejected:
        inventory.require_acceptable()
        if not inventory.accepted_entries:
            raise ZipPolicyError("archive contains no accepted audio entries", inventory=inventory)
    return inventory


def inspect_zip(
    archive_path: str | os.PathLike[str],
    policy: IngestPolicy = DEFAULT_POLICY,
    *,
    fail_on_rejected: bool = True,
) -> ZipInventory:
    """Hash and inventory a ZIP through one pinned, no-follow descriptor.

    All central-directory entries are evaluated so callers can present a useful
    rejection report. By default, any rejected entry raises
    :class:`ZipPolicyError`; the complete inventory remains attached to it.
    """

    path = Path(archive_path)
    try:
        with (
            _open_pinned_archive(path, policy) as pinned,
            zipfile.ZipFile(pinned.stream, "r", allowZip64=True) as archive,
        ):
            return _inventory_from_zipfile(
                archive,
                archive_name=path.name,
                archive_sha256=pinned.sha256,
                archive_bytes=pinned.bytes,
                policy=policy,
                fail_on_rejected=fail_on_rejected,
            )
    except ZipPolicyError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, OSError) as error:
        raise ZipPolicyError(f"invalid or unsupported ZIP archive: {error}") from error


def _copy_member(
    source: BinaryIO,
    target_path: Path,
    *,
    staging_root: Path,
    entry: ZipEntryRecord,
    declared_bytes: int,
    aggregate_so_far: int,
    completed_files: int,
    total_files: int,
    total_uncompressed_bytes: int,
    progress_callback: ExtractionProgressCallback | None,
    policy: IngestPolicy,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    copied = 0
    try:
        relative_parent = target_path.parent.relative_to(staging_root)
    except ValueError as error:  # pragma: no cover - caller invariant
        raise ZipIngestError("extraction target escaped its owned staging directory") from error
    current = staging_root
    for component in relative_parent.parts:
        current /= component
        try:
            current.mkdir(mode=0o700)
        except FileExistsError as error:
            current_stat = current.stat(follow_symlinks=False)
            if not stat.S_ISDIR(current_stat.st_mode):
                raise ZipIngestError("extraction parent is not a safe directory") from error
        os.chmod(current, 0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(target_path, flags, 0o600)
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        target_stream = os.fdopen(descriptor, "wb")
        descriptor = None
        with target_stream as target:
            while chunk := source.read(policy.copy_chunk_bytes):
                copied += len(chunk)
                if copied > declared_bytes:
                    raise ZipPolicyError("member expanded beyond its declared size")
                if copied > policy.max_entry_uncompressed_bytes:
                    raise ZipPolicyError("member exceeded the actual extraction byte limit")
                if aggregate_so_far + copied > policy.max_aggregate_uncompressed_bytes:
                    raise ZipPolicyError("archive exceeded the actual aggregate extraction limit")
                target.write(chunk)
                digest.update(chunk)
                _report_progress(
                    progress_callback,
                    ExtractionProgress(
                        completed_files=completed_files,
                        total_files=total_files,
                        completed_uncompressed_bytes=aggregate_so_far + copied,
                        total_uncompressed_bytes=total_uncompressed_bytes,
                        current_asset_id=entry.asset_id,
                        current_name=entry.normalized_name,
                    ),
                )
            target.flush()
            os.fsync(target.fileno())
    except Exception:
        if descriptor is not None:
            os.close(descriptor)
        target_path.unlink(missing_ok=True)
        raise
    if copied != declared_bytes:
        target_path.unlink(missing_ok=True)
        raise ZipPolicyError(
            f"member size mismatch: central directory={declared_bytes}, actual={copied}"
        )
    _report_progress(
        progress_callback,
        ExtractionProgress(
            completed_files=completed_files + 1,
            total_files=total_files,
            completed_uncompressed_bytes=aggregate_so_far + copied,
            total_uncompressed_bytes=total_uncompressed_bytes,
            current_asset_id=entry.asset_id,
            current_name=entry.normalized_name,
        ),
    )
    return digest.hexdigest(), copied


def _fsync_directory(directory: Path) -> None:
    if os.name != "posix":
        return
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(directory, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_staging_directories(staging: Path) -> None:
    if os.name != "posix":
        return
    directories = [Path(root) for root, _, _ in os.walk(staging, topdown=False)]
    for directory in directories:
        _fsync_directory(directory)


def _native_rename_no_replace(source: Path, destination: Path) -> None:
    source_bytes = os.fsencode(source)
    destination_bytes = os.fsencode(destination)
    if sys.platform == "darwin":
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            renamex_np = libc.renamex_np
        except AttributeError as error:  # pragma: no cover - unsupported macOS runtime
            raise ZipIngestError(
                "renamex_np is unavailable; refusing non-atomic publication"
            ) from error
        renamex_np.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        renamex_np.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = renamex_np(source_bytes, destination_bytes, 0x00000004)  # RENAME_EXCL
    elif sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            renameat2 = libc.renameat2
        except AttributeError as error:  # pragma: no cover - old/non-glibc runtime
            raise ZipIngestError(
                "renameat2 is unavailable; refusing non-atomic publication"
            ) from error
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = renameat2(-100, source_bytes, -100, destination_bytes, 1)  # RENAME_NOREPLACE
    elif os.name == "nt":  # pragma: no cover - exercised on Windows CI
        os.rename(source, destination)
        return
    else:  # pragma: no cover - fail closed on an unknown platform
        raise ZipIngestError("atomic no-replace directory publication is unsupported")

    if result == 0:
        return
    error_number = ctypes.get_errno()
    if error_number in {errno.EEXIST, errno.ENOTEMPTY}:
        raise FileExistsError(error_number, os.strerror(error_number), destination)
    raise OSError(error_number, os.strerror(error_number), destination)


def _publish_directory_no_replace(staging: Path, destination: Path) -> None:
    staged_stat = staging.stat(follow_symlinks=False)
    if not stat.S_ISDIR(staged_stat.st_mode):  # pragma: no cover - caller invariant
        raise ZipIngestError("owned extraction staging path is not a directory")
    try:
        _native_rename_no_replace(staging, destination)
    except FileExistsError as error:
        raise ZipIngestError("destination already exists; refusing to overwrite it") from error
    except OSError as error:
        raise ZipIngestError(
            f"failed to atomically publish extracted directory: {error}"
        ) from error
    try:
        published_stat = destination.stat(follow_symlinks=False)
    except OSError as error:
        raise ZipIngestError("published extraction directory is missing") from error
    if not stat.S_ISDIR(published_stat.st_mode) or (
        published_stat.st_dev,
        published_stat.st_ino,
    ) != (staged_stat.st_dev, staged_stat.st_ino):
        raise ZipIngestError("published extraction directory is not the owned staging directory")
    if stat.S_IMODE(published_stat.st_mode) != 0o700:
        raise ZipIngestError("published extraction directory permissions changed unexpectedly")
    _fsync_directory(destination.parent)


def _remove_owned_staging(staging: Path, owned_stat: os.stat_result) -> None:
    try:
        current = staging.stat(follow_symlinks=False)
    except OSError:
        return
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev, current.st_ino) != (
        owned_stat.st_dev,
        owned_stat.st_ino,
    ):
        return
    shutil.rmtree(staging)


def extract_zip_safe(
    archive_path: str | os.PathLike[str],
    destination: str | os.PathLike[str],
    policy: IngestPolicy = DEFAULT_POLICY,
    *,
    progress_callback: ExtractionProgressCallback | None = None,
) -> ZipInventory:
    """Extract from one pinned archive descriptor and publish without replacement."""

    archive_path = Path(archive_path)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ZipIngestError("destination already exists; refusing to overwrite it")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging: Path | None = None
    staging_stat: os.stat_result | None = None
    extracted_by_name: dict[str, tuple[str, int]] = {}
    aggregate = 0
    try:
        with _open_pinned_archive(archive_path, policy) as pinned:
            try:
                with zipfile.ZipFile(pinned.stream, "r", allowZip64=True) as archive:
                    inventory = _inventory_from_zipfile(
                        archive,
                        archive_name=archive_path.name,
                        archive_sha256=pinned.sha256,
                        archive_bytes=pinned.bytes,
                        policy=policy,
                        fail_on_rejected=True,
                    )
                    required_scratch = int(
                        inventory.accepted_uncompressed_bytes * policy.scratch_space_multiplier
                    )
                    available_scratch = shutil.disk_usage(destination.parent).free
                    if available_scratch < required_scratch:
                        raise ZipPolicyError(
                            "insufficient scratch space: "
                            f"need {required_scratch} bytes, have {available_scratch}"
                        )

                    staging = Path(
                        tempfile.mkdtemp(
                            prefix=f".{destination.name}.staging-", dir=destination.parent
                        )
                    )
                    os.chmod(staging, 0o700)
                    staging_stat = staging.stat(follow_symlinks=False)
                    total_files = len(inventory.accepted_entries)
                    total_uncompressed_bytes = inventory.accepted_uncompressed_bytes
                    _report_progress(
                        progress_callback,
                        ExtractionProgress(
                            completed_files=0,
                            total_files=total_files,
                            completed_uncompressed_bytes=0,
                            total_uncompressed_bytes=total_uncompressed_bytes,
                            current_asset_id=None,
                            current_name=None,
                        ),
                    )

                    accepted_by_original = {
                        entry.original_name: entry for entry in inventory.accepted_entries
                    }
                    completed_files = 0
                    for info in archive.infolist():
                        entry = accepted_by_original.get(info.filename)
                        if entry is None:
                            continue
                        assert entry.normalized_name is not None
                        target = staging.joinpath(*PurePosixPath(entry.normalized_name).parts)
                        try:
                            with archive.open(info, "r") as source:
                                digest, copied = _copy_member(
                                    source,
                                    target,
                                    staging_root=staging,
                                    entry=entry,
                                    declared_bytes=entry.uncompressed_bytes,
                                    aggregate_so_far=aggregate,
                                    completed_files=completed_files,
                                    total_files=total_files,
                                    total_uncompressed_bytes=total_uncompressed_bytes,
                                    progress_callback=progress_callback,
                                    policy=policy,
                                )
                        except _ExtractionProgressCallbackError:
                            raise
                        except (zipfile.BadZipFile, RuntimeError, OSError) as error:
                            raise ZipPolicyError(
                                "failed CRC/decompression validation for "
                                f"{info.filename!r}: {error}"
                            ) from error
                        aggregate += copied
                        completed_files += 1
                        extracted_by_name[entry.original_name] = (digest, copied)
            except ZipPolicyError:
                raise
            except (
                zipfile.BadZipFile,
                zipfile.LargeZipFile,
                NotImplementedError,
                OSError,
            ) as error:
                raise ZipPolicyError(f"invalid or unsupported ZIP archive: {error}") from error

        if len(extracted_by_name) != len(inventory.accepted_entries):
            raise ZipPolicyError("not every accepted member was extracted exactly once")

        records = tuple(
            replace(entry, sha256=extracted_by_name[entry.original_name][0])
            if entry.outcome == "accepted"
            else entry
            for entry in inventory.entries
        )
        completed = replace(inventory, entries=records)
        assert staging is not None
        _fsync_staging_directories(staging)
        _publish_directory_no_replace(staging, destination)
        return completed
    except Exception:
        if staging is not None and staging_stat is not None:
            _remove_owned_staging(staging, staging_stat)
        raise


__all__ = [
    "ExtractionProgress",
    "ExtractionProgressCallback",
    "ZipEntryRecord",
    "ZipIngestError",
    "ZipInventory",
    "ZipPolicyError",
    "extract_zip_safe",
    "inspect_zip",
]
