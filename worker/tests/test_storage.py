from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from conftest import job_payload

from opusloops_worker.contracts import parse_job
from opusloops_worker.errors import IntegrityError
from opusloops_worker.storage import (
    S3ObjectStore,
    StoredObject,
    asset_payload,
    load_state,
    publish_state,
)


class MissingObject(Exception):
    response = {
        "ResponseMetadata": {"HTTPStatusCode": 404},
        "Error": {"Code": "NoSuchKey"},
    }


class PutObjectClient:
    def __init__(self, body: bytes, sha256: str) -> None:
        self.body = body
        self.sha256 = sha256
        self.head_calls = 0
        self.put_request = None

    def head_object(self, **_kwargs):
        self.head_calls += 1
        if self.head_calls == 1:
            raise MissingObject
        return {
            "ContentLength": len(self.body),
            "ContentType": "application/octet-stream",
            "Metadata": {"sha256": self.sha256, "immutable": "true"},
        }

    def put_object(self, **kwargs):
        self.put_request = kwargs
        assert kwargs["Body"].read() == self.body
        return {}


class MemoryStore:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.upload_calls = 0

    def download(self, *, bucket, key, destination, expected_sha256, progress=None):
        body, content_type = self.objects[(bucket, key)]
        measured_sha256 = hashlib.sha256(body).hexdigest()
        assert expected_sha256 is None or measured_sha256 == expected_sha256
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        if progress:
            progress(len(body), len(body), "bytes")
        return StoredObject(bucket, key, measured_sha256, len(body), content_type)

    def upload_immutable(
        self, *, bucket, key, source, sha256, content_type, metadata, progress=None
    ):
        body = source.read_bytes()
        assert hashlib.sha256(body).hexdigest() == sha256
        existing = self.objects.get((bucket, key))
        if existing is not None and existing[0] != body:
            raise IntegrityError("overwrite")
        if existing is None:
            self.upload_calls += 1
            self.objects[(bucket, key)] = (body, content_type)
        if progress:
            progress(len(body), len(body), "bytes")
        return StoredObject(bucket, key, sha256, len(body), content_type)


def test_supabase_put_uses_supported_headers_and_verifies_publication(tmp_path: Path) -> None:
    body = b"published-once"
    digest = hashlib.sha256(body).hexdigest()
    source = tmp_path / "artifact.bin"
    source.write_bytes(body)
    client = PutObjectClient(body, digest)
    store = object.__new__(S3ObjectStore)
    store._client = client

    stored = store.upload_immutable(
        bucket="opusloops-stem-artifacts",
        key="user/project/job/attempts/attempt/inspect/files/artifact.bin",
        source=source,
        sha256=digest,
        content_type="application/octet-stream",
        metadata={},
    )

    assert stored.sha256 == digest
    assert client.put_request is not None
    assert "IfNoneMatch" not in client.put_request
    assert client.put_request["Metadata"] == {"sha256": digest, "immutable": "true"}
    assert client.head_calls == 2


def test_unbound_upload_download_measures_source_hash(tmp_path: Path) -> None:
    store = MemoryStore()
    body = b"immutable TUS upload bytes"
    store.objects[("opusloops-stem-uploads", "job/upload.zip")] = (
        body,
        "application/zip",
    )
    measured = store.download(
        bucket="opusloops-stem-uploads",
        key="job/upload.zip",
        destination=tmp_path / "upload.zip",
        expected_sha256=None,
    )
    assert measured.sha256 == hashlib.sha256(body).hexdigest()


def test_state_snapshot_rehydrates_and_reuses_unchanged_sources(tmp_path: Path) -> None:
    job = parse_job(job_payload("inspect"))
    run = tmp_path / "first" / "run"
    (run / "canonical").mkdir(parents=True)
    (run / "run-manifest.json").write_text('{"version":1}\n')
    (run / "events.jsonl").write_text('{"event":1}\n')
    (run / "canonical" / "asset.wav").write_bytes(b"RIFF-source")
    store = MemoryStore()
    snapshot, index = publish_state(store, job=job, run_dir=run, variant="inspection")
    uploads_after_first = store.upload_calls
    next_payload = job_payload("analyze")
    next_payload["inputs"]["inspectionManifest"] = {  # type: ignore[index]
        "bucket": index.bucket,
        "key": index.key,
        "sha256": index.sha256,
    }
    next_job = parse_job(next_payload)
    restored = tmp_path / "second" / "run"
    restored_state = load_state(
        store,
        job=next_job,
        reference=next_job.inputs.inspection_manifest,  # type: ignore[arg-type]
        run_dir=restored,
    )
    assert (restored / "canonical" / "asset.wav").read_bytes() == b"RIFF-source"
    (restored / "analysis.json").write_text('{"analysis":true}\n')
    second, _ = publish_state(
        store,
        job=next_job,
        run_dir=restored,
        variant="analysis",
        previous=restored_state,
    )
    canonical = next(entry for entry in second.entries if entry.relative_path.endswith("asset.wav"))
    assert canonical.object.bucket == "opusloops-stem-sources"
    assert store.upload_calls == uploads_after_first + 2  # new analysis plus new state index


def test_identical_logical_stems_keep_distinct_object_and_asset_identities(tmp_path: Path) -> None:
    job = parse_job(job_payload("inspect"))
    run = tmp_path / "duplicate-stems" / "run"
    (run / "canonical").mkdir(parents=True)
    (run / "run-manifest.json").write_text('{"version":1}\n')
    (run / "canonical" / "left.wav").write_bytes(b"RIFF-identical-silence")
    (run / "canonical" / "right.wav").write_bytes(b"RIFF-identical-silence")
    store = MemoryStore()

    snapshot, _ = publish_state(store, job=job, run_dir=run, variant="inspection")
    canonical = [
        entry for entry in snapshot.entries if entry.relative_path.startswith("canonical/")
    ]

    assert len(canonical) == 2
    assert canonical[0].object.sha256 == canonical[1].object.sha256
    assert canonical[0].object.key != canonical[1].object.key
    payloads = [
        asset_payload(
            entry.object,
            job=job,
            kind="canonical",
            variant=entry.relative_path,
        )
        for entry in canonical
    ]
    assert payloads[0]["id"] != payloads[1]["id"]


def test_identical_preview_segments_keep_distinct_artifact_identities(tmp_path: Path) -> None:
    job = parse_job(job_payload("inspect"))
    run = tmp_path / "duplicate-previews" / "run"
    (run / "mobile-previews" / "left").mkdir(parents=True)
    (run / "mobile-previews" / "right").mkdir(parents=True)
    (run / "run-manifest.json").write_text('{"version":1}\n')
    (run / "mobile-previews" / "left" / "0000.m4a").write_bytes(b"same-aac-silence")
    (run / "mobile-previews" / "right" / "0000.m4a").write_bytes(b"same-aac-silence")
    store = MemoryStore()

    snapshot, _ = publish_state(store, job=job, run_dir=run, variant="preview")
    previews = [
        entry for entry in snapshot.entries if entry.relative_path.startswith("mobile-previews/")
    ]

    assert len(previews) == 2
    assert previews[0].object.sha256 == previews[1].object.sha256
    assert previews[0].object.key != previews[1].object.key
    payloads = [
        asset_payload(
            entry.object,
            job=job,
            kind="preview_segment",
            variant=entry.relative_path,
        )
        for entry in previews
    ]
    assert payloads[0]["id"] != payloads[1]["id"]


def test_state_index_rejects_scope_substitution(tmp_path: Path) -> None:
    job = parse_job(job_payload("inspect"))
    store = MemoryStore()
    run = tmp_path / "first" / "run"
    run.mkdir(parents=True)
    (run / "run-manifest.json").write_text("{}\n")
    _, index = publish_state(store, job=job, run_dir=run, variant="inspection")
    body, content_type = store.objects[(index.bucket, index.key)]
    value = json.loads(body)
    value["userId"] = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    tampered = json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    digest = hashlib.sha256(tampered).hexdigest()
    key = index.key.replace("state-index.json", "tampered-state-index.json")
    store.objects[(index.bucket, key)] = (tampered, content_type)
    next_job = parse_job(job_payload("analyze"))
    with pytest.raises(Exception, match="another job scope"):
        load_state(
            store,
            job=next_job,
            reference=type(next_job.inputs.inspection_manifest)(index.bucket, key, digest),
            run_dir=tmp_path / "tampered" / "run",
        )
