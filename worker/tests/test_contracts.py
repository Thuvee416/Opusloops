from __future__ import annotations

import copy

import pytest
from conftest import encode, job_payload

from opusloops_worker.contracts import decode_payload, parse_job
from opusloops_worker.errors import ContractError


@pytest.mark.parametrize("stage", ["inspect", "analyze", "propose", "render"])
def test_each_stage_contract_round_trips(stage: str) -> None:
    payload = job_payload(stage)
    parsed = parse_job(decode_payload(encode(payload)), expected_stage=stage)
    assert parsed.stage == stage
    assert parsed.storage.project_ref == "heryvahetgzfalmuprbw"
    assert parsed.storage.run_prefix == parsed.expected_run_prefix


def test_rejects_stage_confusion() -> None:
    with pytest.raises(ContractError, match="does not match"):
        parse_job(job_payload("inspect"), expected_stage="render")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("endpoint", "http://127.0.0.1/storage/v1/s3"),
        ("endpoint", "https://example.com/storage/v1/s3"),
        ("sourceKey", "../../secret"),
        ("runPrefix", "someone/else/job"),
        ("accessKeyId", "anotherprojectref123"),
        ("secretAccessKey", "public-but-not-a-jwt-secret"),
        ("sessionToken", "header..signature-with-empty-payload"),
    ],
)
def test_rejects_unsafe_storage_contract(field: str, value: str) -> None:
    payload = job_payload("inspect")
    payload["storage"][field] = value  # type: ignore[index]
    with pytest.raises(ContractError):
        parse_job(payload)


def test_callback_must_match_storage_project() -> None:
    payload = job_payload("inspect")
    payload["callback"]["url"] = (  # type: ignore[index]
        "https://aaaaaaaaaaaaaaaaaaaa.supabase.co/functions/v1/stem-worker-callback"
    )
    with pytest.raises(ContractError, match="match"):
        parse_job(payload)


@pytest.mark.parametrize("token", ["a" * 63, "A" * 64, "g" * 64, "not-a-token"])
def test_callback_token_is_exact_lowercase_hmac_digest(token: str) -> None:
    payload = job_payload("inspect")
    payload["callback"]["token"] = token  # type: ignore[index]
    with pytest.raises(ContractError, match="callback token"):
        parse_job(payload)


def test_rejects_unexpected_fields() -> None:
    payload = copy.deepcopy(job_payload("inspect"))
    payload["secret"] = "must-not-pass"
    with pytest.raises(ContractError, match="fields"):
        parse_job(payload)


def test_inspect_hash_is_measured_by_worker() -> None:
    payload = job_payload("inspect")
    payload["inputs"]["sourceSha256"] = "a" * 64  # type: ignore[index]
    with pytest.raises(ContractError, match="measure sourceSha256"):
        parse_job(payload)


def test_rejects_noncanonical_identifiers() -> None:
    payload = job_payload("inspect")
    payload["jobId"] = "33333333333343338333333333333333"
    with pytest.raises(ContractError, match="canonical"):
        parse_job(payload)


def test_rejects_invalid_base64() -> None:
    with pytest.raises(ContractError, match="base64"):
        decode_payload("!not-base64!")


def test_storage_session_credentials_are_redacted_from_repr() -> None:
    parsed = parse_job(job_payload("inspect"))

    rendered = repr(parsed)

    assert parsed.storage.secret_access_key not in rendered
    assert parsed.storage.session_token not in rendered
    assert parsed.callback_token not in rendered
