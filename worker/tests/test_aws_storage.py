from __future__ import annotations

import pytest
from conftest import job_payload

from opusloops_worker.contracts import parse_job
from opusloops_worker.errors import ContractError, StorageError
from opusloops_worker.storage import S3ObjectStore


def native_payload(monkeypatch: pytest.MonkeyPatch) -> dict:
    payload = job_payload()
    payload["version"] = 2
    account = "123456789012"
    callback = "https://example.execute-api.us-east-1.amazonaws.com/worker/callback"
    monkeypatch.setenv("OPUSLOOPS_AWS_STORAGE_ACCOUNT", account)
    monkeypatch.setenv("OPUSLOOPS_AWS_CALLBACK_URL", callback)
    payload["callback"]["url"] = callback
    payload["storage"].update(
        endpoint="https://s3.us-east-1.amazonaws.com",
        accessKeyId="ASIA" + "A" * 16,
        secretAccessKey="a" * 40,
        sessionToken="temporary-session-token-" + "x" * 100,
        bucketMap={
            f"opusloops-stem-{kind}": f"opusloops-{kind}-{account}-us-east-1"
            for kind in ("uploads", "sources", "artifacts")
        },
    )
    return payload


def test_native_aws_keeps_approved_logical_bucket_references(monkeypatch: pytest.MonkeyPatch):
    parsed = parse_job(native_payload(monkeypatch))
    assert parsed.storage.source_bucket == "opusloops-stem-sources"
    assert parsed.storage.bucket_mapping["opusloops-stem-sources"].endswith(
        "123456789012-us-east-1"
    )
    assert parsed.storage.secret_access_key not in repr(parsed)


@pytest.mark.parametrize(
    "mutation", ["endpoint", "account", "permanent_key", "callback", "missing_config"]
)
def test_native_aws_rejects_unbound_destinations(monkeypatch: pytest.MonkeyPatch, mutation: str):
    payload = native_payload(monkeypatch)
    if mutation == "endpoint":
        payload["storage"]["endpoint"] = "https://attacker.example"
    elif mutation == "account":
        payload["storage"]["bucketMap"]["opusloops-stem-sources"] = "other-account"
    elif mutation == "permanent_key":
        payload["storage"]["accessKeyId"] = "AKIA" + "A" * 16
    elif mutation == "callback":
        payload["callback"]["url"] = "https://attacker.example/callback"
    else:
        monkeypatch.delenv("OPUSLOOPS_AWS_STORAGE_ACCOUNT")
    with pytest.raises(ContractError):
        parse_job(payload)


def test_storage_mapping_never_changes_saved_manifest_bucket_names():
    store = object.__new__(S3ObjectStore)
    store._bucket_mapping = {"opusloops-stem-sources": "physical-s3-bucket"}
    assert store._physical_bucket("opusloops-stem-sources") == "physical-s3-bucket"
    with pytest.raises(ContractError):
        store._physical_bucket("other-bucket")


def test_missing_object_can_be_conditionally_created_without_list_permissions():
    class HiddenMissing(Exception):
        response = {"ResponseMetadata": {"HTTPStatusCode": 403}}

    class DeniedHead:
        def head_object(self, **_kwargs):
            raise HiddenMissing

    store = object.__new__(S3ObjectStore)
    store._client = DeniedHead()
    store._bucket_mapping = {"opusloops-stem-sources": "physical-s3-bucket"}
    assert store._head("opusloops-stem-sources", "key", before_conditional_create=True) is None
    with pytest.raises(StorageError):
        store._head("opusloops-stem-sources", "key")
