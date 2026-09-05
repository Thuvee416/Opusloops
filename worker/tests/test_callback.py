from __future__ import annotations

import hashlib
import hmac
import io
import json
import urllib.error

import pytest
from conftest import job_payload

from opusloops_worker.callback import CallbackClient, callback_body, event_payload, sign_request
from opusloops_worker.contracts import parse_job
from opusloops_worker.errors import ContractError

DISPATCH_JOB_ID = "66666666-6666-4666-8666-666666666666"


class Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, _limit: int) -> bytes:
        return json.dumps(
            {
                "accepted": True,
                "duplicate": False,
                "job": {"id": "job", "status": "ok", "revision": 1},
            }
        ).encode()


def test_signature_matches_backend_contract() -> None:
    job = parse_job(job_payload("inspect"))
    body = b'{"hello":"world"}'
    nonce = "55555555-5555-4555-8555-555555555555"
    signed = sign_request(job, body, "a" * 64, nonce=nonce, timestamp=1_788_600_000)
    expected = hmac.new(
        b"a" * 64,
        b"1788600000.55555555-5555-4555-8555-555555555555." + body,
        hashlib.sha256,
    ).hexdigest()
    assert signed.headers["X-Opusloops-Signature"] == expected
    assert signed.headers["X-Opusloops-Job-Id"] == job.job_id
    assert signed.headers["X-Opusloops-Attempt"] == job.attempt_id


def test_retry_reuses_identical_nonce_signature_and_body() -> None:
    job = parse_job(job_payload("inspect"))
    requests = []
    sleeps = []

    def opener(request, **_kwargs):
        requests.append(request)
        if len(requests) == 1:
            raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, io.BytesIO())
        return Response()

    client = CallbackClient(
        job=job,
        dispatch_job_id=DISPATCH_JOB_ID,
        secret="b" * 64,
        opener=opener,
        sleeper=sleeps.append,
    )
    response = client.send(event=event_payload(status="started", operation="inspect"))
    assert response["accepted"] is True
    assert len(requests) == 2
    for header in (
        "X-opusloops-nonce",
        "X-opusloops-timestamp",
        "X-opusloops-signature",
    ):
        assert requests[0].headers[header] == requests[1].headers[header]
    assert requests[0].data == requests[1].data
    assert sleeps == [0.5]
    assert json.loads(requests[0].data)["dispatchJobId"] == DISPATCH_JOB_ID


def test_callback_body_binds_the_aws_batch_job() -> None:
    job = parse_job(job_payload("inspect"))
    body = callback_body(
        job,
        dispatch_job_id=DISPATCH_JOB_ID,
        event=event_payload(status="started", operation="inspect"),
    )
    assert json.loads(body)["dispatchJobId"] == DISPATCH_JOB_ID


def test_callback_client_rejects_an_unbound_dispatch() -> None:
    job = parse_job(job_payload("inspect"))
    with pytest.raises(ContractError, match="AWS Batch dispatch job ID"):
        CallbackClient(job=job, dispatch_job_id="", secret="b" * 64)


def test_determinate_completion_must_reach_total() -> None:
    with pytest.raises(ContractError, match="equal"):
        event_payload(
            status="completed",
            operation="upload",
            determinate=True,
            completed=4,
            total=5,
            unit="files",
        )


def test_detail_fields_are_allowlisted() -> None:
    with pytest.raises(ContractError, match="non-public"):
        event_payload(status="progress", operation="download", detail={"localPath": "/secret"})
