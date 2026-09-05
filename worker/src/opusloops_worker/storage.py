"""Immutable Supabase Storage S3 transport and stage-state snapshots."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import stat
import uuid
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .contracts import BUCKETS, SHA256_RE, JobContract, ObjectReference
from .errors import ContractError, IntegrityError, StorageError

CHUNK_BYTES = 6 * 1024 * 1024
STATE_VERSION = 1
ASSET_NAMESPACE = uuid.UUID("4d0b76dc-6fc0-4bd2-b8f8-5843e7a98410")
Progress = Callable[[int, int, str], None]


class ObjectStore(Protocol):
    def download(
        self,
        *,
        bucket: str,
        key: str,
        destination: Path,
        expected_sha256: str | None,
        progress: Progress | None = None,
    ) -> StoredObject: ...

    def upload_immutable(
        self,
        *,
        bucket: str,
        key: str,
        source: Path,
        sha256: str,
        content_type: str,
        metadata: Mapping[str, str],
        progress: Progress | None = None,
    ) -> StoredObject: ...


@dataclass(frozen=True, slots=True)
class StoredObject:
    bucket: str
    key: str
    sha256: str
    bytes: int
    content_type: str


@dataclass(frozen=True, slots=True)
class StateEntry:
    relative_path: str
    object: StoredObject
    storage_class: str

    def to_dict(self) -> dict[str, object]:
        return {
            "relativePath": self.relative_path,
            "bucket": self.object.bucket,
            "objectPath": self.object.key,
            "sha256": self.object.sha256,
            "bytes": self.object.bytes,
            "contentType": self.object.content_type,
            "storageClass": self.storage_class,
        }


@dataclass(frozen=True, slots=True)
class StateSnapshot:
    reference: ObjectReference
    entries: tuple[StateEntry, ...]
    variant: str


def sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    byte_count = 0
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise IntegrityError("artifact is not a regular file")
        while True:
            chunk = os.read(descriptor, CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
            byte_count += len(chunk)
        after = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
        ):
            raise IntegrityError("artifact changed while it was hashed")
    finally:
        os.close(descriptor)
    if byte_count != opened.st_size:
        raise IntegrityError("artifact size changed while it was hashed")
    return digest.hexdigest(), byte_count


def _safe_local_file(root: Path, relative_path: str) -> Path:
    candidate = root.joinpath(*relative_path.split("/"))
    try:
        parent = candidate.parent.resolve(strict=False)
        parent.relative_to(root.resolve())
    except (OSError, ValueError) as exc:
        raise ContractError("state entry escapes the run directory") from exc
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        os.chmod(parent, 0o700)
    if candidate.exists() or candidate.is_symlink():
        raise IntegrityError("state reconstruction would overwrite a file")
    return candidate


def _validate_relative_path(value: object) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 2048:
        raise ContractError("state relativePath is invalid")
    if value.startswith("/") or "\\" in value or any(ord(char) < 32 for char in value):
        raise ContractError("state relativePath is unsafe")
    parts = value.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        raise ContractError("state relativePath contains traversal")
    return value


def _validate_state_index(payload: object, job: JobContract) -> tuple[str, tuple[StateEntry, ...]]:
    fields = {
        "version",
        "jobId",
        "userId",
        "projectId",
        "attemptId",
        "stage",
        "variant",
        "runManifestSha256",
        "files",
    }
    if not isinstance(payload, Mapping) or set(payload) != fields or payload.get("version") != 1:
        raise ContractError("state index fields or version are invalid")
    if (
        payload.get("jobId") != job.job_id
        or payload.get("userId") != job.user_id
        or payload.get("projectId") != job.project_id
    ):
        raise ContractError("state index belongs to another job scope")
    if payload.get("stage") not in {"inspect", "analyze", "propose", "render"}:
        raise ContractError("state index stage is invalid")
    variant = payload.get("variant")
    if not isinstance(variant, str) or not variant:
        raise ContractError("state index variant is invalid")
    manifest_sha = payload.get("runManifestSha256")
    if not isinstance(manifest_sha, str) or not SHA256_RE.fullmatch(manifest_sha):
        raise ContractError("state index run manifest hash is invalid")
    files = payload.get("files")
    if not isinstance(files, list) or not files or len(files) > 4096:
        raise ContractError("state index file list is invalid")
    entries: list[StateEntry] = []
    seen_paths: set[str] = set()
    for item in files:
        expected = {
            "relativePath",
            "bucket",
            "objectPath",
            "sha256",
            "bytes",
            "contentType",
            "storageClass",
        }
        if not isinstance(item, Mapping) or set(item) != expected:
            raise ContractError("state index file entry is invalid")
        relative_path = _validate_relative_path(item.get("relativePath"))
        if relative_path in seen_paths:
            raise ContractError("state index contains a duplicate relativePath")
        seen_paths.add(relative_path)
        bucket = item.get("bucket")
        if bucket not in set(BUCKETS.values()):
            raise ContractError("state index references an unexpected bucket")
        key = item.get("objectPath")
        if not isinstance(key, str) or not key.startswith(f"{job.storage.run_prefix}/"):
            raise ContractError("state index object is outside the job prefix")
        sha256 = item.get("sha256")
        byte_count = item.get("bytes")
        content_type = item.get("contentType")
        storage_class = item.get("storageClass")
        if not isinstance(sha256, str) or not SHA256_RE.fullmatch(sha256):
            raise ContractError("state index file hash is invalid")
        if type(byte_count) is not int or byte_count < 0:
            raise ContractError("state index file size is invalid")
        if not isinstance(content_type, str) or not content_type or len(content_type) > 200:
            raise ContractError("state index content type is invalid")
        if storage_class not in {"source", "artifact"}:
            raise ContractError("state index storage class is invalid")
        entries.append(
            StateEntry(
                relative_path=relative_path,
                object=StoredObject(
                    bucket=str(bucket),
                    key=key,
                    sha256=sha256,
                    bytes=byte_count,
                    content_type=content_type,
                ),
                storage_class=str(storage_class),
            )
        )
    manifest_entry = next(
        (entry for entry in entries if entry.relative_path == "run-manifest.json"), None
    )
    if manifest_entry is None or manifest_entry.object.sha256 != manifest_sha:
        raise ContractError("state index does not bind its run manifest")
    return variant, tuple(entries)


class S3ObjectStore:
    """Minimal S3-compatible transport configured only for Supabase Storage."""

    def __init__(
        self,
        *,
        endpoint: str,
        region: str,
        access_key_id: str,
        secret_access_key: str,
        session_token: str,
    ) -> None:
        if not access_key_id or not secret_access_key or not session_token:
            raise ContractError("storage credentials were not injected")
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:  # pragma: no cover - container dependency
            raise StorageError("S3 client dependency is unavailable", retryable=False) from exc
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            aws_session_token=session_token,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 3, "mode": "standard"},
                connect_timeout=10,
                read_timeout=120,
            ),
        )

    @staticmethod
    def _metadata_sha256(response: Mapping[str, Any]) -> str | None:
        metadata = response.get("Metadata")
        if not isinstance(metadata, Mapping):
            return None
        value = metadata.get("sha256")
        return str(value) if isinstance(value, str) else None

    def _head(self, bucket: str, key: str) -> Mapping[str, Any] | None:
        try:
            return self._client.head_object(Bucket=bucket, Key=key)
        except Exception as exc:
            response = getattr(exc, "response", {})
            status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            code = response.get("Error", {}).get("Code")
            if status == 404 or code in {"404", "NoSuchKey", "NotFound"}:
                return None
            raise StorageError("object metadata request failed") from exc

    def download(
        self,
        *,
        bucket: str,
        key: str,
        destination: Path,
        expected_sha256: str | None,
        progress: Progress | None = None,
    ) -> StoredObject:
        head_before = self._head(bucket, key)
        if head_before is None:
            raise StorageError("required immutable object is missing", retryable=False)
        total = int(head_before.get("ContentLength", -1))
        if total < 0:
            raise StorageError("object metadata has no valid size", retryable=False)
        etag = str(head_before.get("ETag", ""))
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if os.name == "posix":
            os.chmod(destination.parent, 0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(destination, flags, 0o600)
        digest = hashlib.sha256()
        completed = 0
        try:
            request: dict[str, Any] = {"Bucket": bucket, "Key": key}
            if etag:
                request["IfMatch"] = etag
            response = self._client.get_object(**request)
            stream = response["Body"]
            while True:
                chunk = stream.read(CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                completed += len(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise StorageError("short write while downloading object")
                    view = view[written:]
                if progress is not None:
                    progress(completed, total, "bytes")
            os.fsync(descriptor)
        except Exception:
            with suppress(OSError):
                destination.unlink(missing_ok=True)
            raise
        finally:
            os.close(descriptor)
        measured_sha256 = digest.hexdigest()
        if completed != total or (
            expected_sha256 is not None and measured_sha256 != expected_sha256
        ):
            destination.unlink(missing_ok=True)
            raise IntegrityError("downloaded object does not match its immutable binding")
        head_after = self._head(bucket, key)
        if head_after is None or (
            int(head_after.get("ContentLength", -1)) != total
            or str(head_after.get("ETag", "")) != etag
        ):
            destination.unlink(missing_ok=True)
            raise IntegrityError("source object changed while it was downloaded")
        if os.name == "posix":
            os.chmod(destination, 0o600)
        return StoredObject(
            bucket=bucket,
            key=key,
            sha256=measured_sha256,
            bytes=total,
            content_type=str(head_before.get("ContentType") or "application/octet-stream"),
        )

    def upload_immutable(
        self,
        *,
        bucket: str,
        key: str,
        source: Path,
        sha256: str,
        content_type: str,
        metadata: Mapping[str, str],
        progress: Progress | None = None,
    ) -> StoredObject:
        actual_sha256, byte_count = sha256_file(source)
        if actual_sha256 != sha256:
            raise IntegrityError("upload source changed before publication")
        existing = self._head(bucket, key)
        if existing is not None:
            if (
                int(existing.get("ContentLength", -1)) == byte_count
                and self._metadata_sha256(existing) == sha256
            ):
                return StoredObject(bucket, key, sha256, byte_count, content_type)
            raise IntegrityError("immutable object key already contains different bytes")
        upload_metadata = {str(k): str(v) for k, v in metadata.items()}
        upload_metadata["sha256"] = sha256
        upload_metadata["immutable"] = "true"
        try:
            with source.open("rb") as handle:
                self._client.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=handle,
                    ContentLength=byte_count,
                    ContentType=content_type,
                    CacheControl="private, no-store",
                    Metadata=upload_metadata,
                )
        except Exception as exc:
            existing = self._head(bucket, key)
            if existing is None or (
                int(existing.get("ContentLength", -1)) != byte_count
                or self._metadata_sha256(existing) != sha256
            ):
                raise StorageError("immutable object publication failed") from exc
        published = self._head(bucket, key)
        if published is None or (
            int(published.get("ContentLength", -1)) != byte_count
            or self._metadata_sha256(published) != sha256
        ):
            raise IntegrityError("published object metadata does not match its binding")
        if progress is not None:
            progress(byte_count, byte_count, "bytes")
        return StoredObject(bucket, key, sha256, byte_count, content_type)


def load_state(
    store: ObjectStore,
    *,
    job: JobContract,
    reference: ObjectReference,
    run_dir: Path,
    progress: Progress | None = None,
) -> StateSnapshot:
    index_path = run_dir.parent / "incoming-state-index.json"
    store.download(
        bucket=reference.bucket,
        key=reference.key,
        destination=index_path,
        expected_sha256=reference.sha256,
        progress=progress,
    )
    try:
        raw = index_path.read_bytes()
        if len(raw) > 4 * 1024 * 1024:
            raise ContractError("state index is too large")
        payload = json.loads(raw)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("state index is not valid JSON") from exc
    variant, entries = _validate_state_index(payload, job)
    run_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    if os.name == "posix":
        os.chmod(run_dir, 0o700)
    for entry in entries:
        destination = _safe_local_file(run_dir, entry.relative_path)
        downloaded = store.download(
            bucket=entry.object.bucket,
            key=entry.object.key,
            destination=destination,
            expected_sha256=entry.object.sha256,
            progress=progress,
        )
        if downloaded.bytes != entry.object.bytes:
            raise IntegrityError("state file size differs from its index")
    return StateSnapshot(reference=reference, entries=entries, variant=variant)


def _content_type(path: Path) -> str:
    explicit = {
        ".json": "application/json",
        ".jsonl": "application/x-ndjson",
        ".wav": "audio/wav",
        ".mp3": "audio/mpeg",
        ".m4a": "audio/mp4",
        ".tsv": "text/tab-separated-values",
    }
    return (
        explicit.get(path.suffix.lower())
        or mimetypes.guess_type(path.name)[0]
        or "application/octet-stream"
    )


def _object_key(job: JobContract, relative: str, sha256: str, storage_class: str) -> str:
    suffix = Path(relative).suffix.lower()
    if suffix not in {".json", ".jsonl", ".wav", ".mp3", ".m4a", ".tsv"}:
        suffix = ".bin"
    logical_id = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:16]
    if storage_class == "source":
        return f"{job.storage.run_prefix}/sources/{logical_id}-{sha256}{suffix}"
    return (
        f"{job.storage.run_prefix}/attempts/{job.attempt_id}/{job.stage}/files/"
        f"{logical_id}-{sha256}{suffix}"
    )


def _iter_run_files(run_dir: Path) -> Iterable[tuple[str, Path]]:
    for path in sorted(run_dir.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(run_dir).as_posix()
        if path.is_symlink():
            raise IntegrityError("run state contains a symbolic link")
        if path.is_dir():
            continue
        if not path.is_file():
            raise IntegrityError("run state contains a non-regular file")
        if Path(relative).name.startswith(".") and Path(relative).name.endswith(".lock"):
            continue
        yield relative, path


def publish_state(
    store: ObjectStore,
    *,
    job: JobContract,
    run_dir: Path,
    variant: str,
    previous: StateSnapshot | None = None,
    progress: Progress | None = None,
) -> tuple[StateSnapshot, StoredObject]:
    previous_by_content = (
        {(entry.relative_path, entry.object.sha256): entry for entry in previous.entries}
        if previous
        else {}
    )
    entries: list[StateEntry] = []
    for relative, path in _iter_run_files(run_dir):
        digest, byte_count = sha256_file(path)
        reused = previous_by_content.get((relative, digest))
        if reused is not None and reused.object.bytes == byte_count:
            entries.append(reused)
            continue
        storage_class = (
            "source" if relative.startswith(("extracted/", "canonical/")) else "artifact"
        )
        bucket = (
            job.storage.source_bucket if storage_class == "source" else job.storage.artifact_bucket
        )
        key = _object_key(job, relative, digest, storage_class)
        stored = store.upload_immutable(
            bucket=bucket,
            key=key,
            source=path,
            sha256=digest,
            content_type=_content_type(path),
            metadata={
                "job-id": job.job_id,
                "project-id": job.project_id,
                "stage": job.stage,
                "storage-class": storage_class,
            },
            progress=progress,
        )
        entries.append(StateEntry(relative, stored, storage_class))
    manifest = next(
        (entry for entry in entries if entry.relative_path == "run-manifest.json"), None
    )
    if manifest is None:
        raise IntegrityError("run state has no manifest")
    payload = {
        "version": STATE_VERSION,
        "jobId": job.job_id,
        "userId": job.user_id,
        "projectId": job.project_id,
        "attemptId": job.attempt_id,
        "stage": job.stage,
        "variant": variant,
        "runManifestSha256": manifest.object.sha256,
        "files": [entry.to_dict() for entry in entries],
    }
    index_path = run_dir.parent / "outgoing-state-index.json"
    descriptor = os.open(
        index_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise StorageError("short write while creating state index", retryable=False)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    index_sha, _ = sha256_file(index_path)
    index_key = f"{job.storage.run_prefix}/attempts/{job.attempt_id}/{job.stage}/state-index.json"
    index_object = store.upload_immutable(
        bucket=job.storage.artifact_bucket,
        key=index_key,
        source=index_path,
        sha256=index_sha,
        content_type="application/json",
        metadata={
            "job-id": job.job_id,
            "project-id": job.project_id,
            "stage": job.stage,
            "variant": variant,
        },
        progress=progress,
    )
    return (
        StateSnapshot(
            reference=ObjectReference(index_object.bucket, index_object.key, index_object.sha256),
            entries=tuple(entries),
            variant=variant,
        ),
        index_object,
    )


def asset_payload(
    stored: StoredObject,
    *,
    job: JobContract,
    kind: str,
    variant: str,
    metadata: Mapping[str, object] | None = None,
) -> dict[str, object]:
    identity = uuid.uuid5(
        ASSET_NAMESPACE,
        f"{job.job_id}:{job.attempt_id}:{stored.bucket}:{stored.key}:{stored.sha256}",
    )
    return {
        "id": str(identity),
        "kind": kind,
        "variant": variant,
        "bucket": stored.bucket,
        "objectPath": stored.key,
        "sha256": stored.sha256,
        "bytes": stored.bytes,
        "contentType": stored.content_type,
        "metadata": dict(metadata or {}),
    }
