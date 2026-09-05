"""HMAC-authenticated, idempotent worker callback client."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .contracts import MAX_PAYLOAD_BYTES, STAGES, JobContract
from .errors import ContractError, WorkerError

CALLBACK_VERSION = 1
STATUSES = frozenset({"started", "progress", "completed", "failed"})
UNITS = frozenset({"bytes", "files", "frames", "artifacts"})
SAFE_DETAIL_KEYS = frozenset(
    {"operation", "sequence", "checkpoint", "mode", "proposalId", "source"}
)


class CallbackError(WorkerError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__("callback_failed", message, retryable=retryable)


@dataclass(frozen=True, slots=True)
class SignedRequest:
    body: bytes
    headers: Mapping[str, str]
    nonce: str
    timestamp: int


def _bounded_json(value: object, label: str, max_bytes: int) -> object:
    try:
        encoded = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ContractError(f"{label} is not JSON serializable") from exc
    if len(encoded) > max_bytes:
        raise ContractError(f"{label} is too large")
    return value


def event_payload(
    *,
    status: str,
    operation: str,
    determinate: bool = False,
    completed: int | None = None,
    total: int | None = None,
    unit: str | None = None,
    detail: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if status not in STATUSES:
        raise ContractError("callback event status is invalid")
    if not operation or len(operation) > 100:
        raise ContractError("callback event operation is invalid")
    safe_detail: dict[str, object] = {"operation": operation}
    for key, value in (detail or {}).items():
        if key not in SAFE_DETAIL_KEYS or key == "operation":
            raise ContractError("callback event detail contains a non-public field")
        safe_detail[key] = value
    _bounded_json(safe_detail, "callback detail", 8 * 1024)
    if determinate:
        if (
            type(completed) is not int
            or type(total) is not int
            or completed < 0
            or total < 0
            or completed > total
            or unit not in UNITS
        ):
            raise ContractError("determinate callback progress is invalid")
        if status == "completed" and completed != total:
            raise ContractError("completed determinate progress must equal its total")
    elif completed is not None or total is not None or unit is not None:
        raise ContractError("indeterminate callback progress must not include counters")
    return {
        "status": status,
        "determinate": determinate,
        "completed": completed,
        "total": total,
        "unit": unit,
        "detail": safe_detail,
    }


def callback_body(
    job: JobContract,
    *,
    dispatch_job_id: str,
    event: Mapping[str, object],
    assets: Sequence[Mapping[str, object]] = (),
    result: Mapping[str, object] | None = None,
    error: Mapping[str, object] | None = None,
) -> bytes:
    if job.stage not in STAGES:
        raise ContractError("callback job stage is invalid")
    if result is not None and error is not None:
        raise ContractError("callback cannot contain both result and error")
    body = {
        "version": CALLBACK_VERSION,
        "jobId": job.job_id,
        "userId": job.user_id,
        "attemptId": job.attempt_id,
        "dispatchJobId": dispatch_job_id,
        "stage": job.stage,
        "event": dict(event),
        "assets": [dict(asset) for asset in assets],
        "result": dict(result) if result is not None else None,
        "error": dict(error) if error is not None else None,
    }
    encoded = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise ContractError("callback body exceeds 256 KiB")
    return encoded


def sign_request(
    job: JobContract,
    body: bytes,
    secret: str,
    *,
    nonce: str | None = None,
    timestamp: int | None = None,
) -> SignedRequest:
    if len(secret.encode("utf-8")) < 32:
        raise ContractError("callback HMAC secret must contain at least 32 bytes")
    request_nonce = nonce or str(uuid.uuid4())
    try:
        if str(uuid.UUID(request_nonce)) != request_nonce.lower():
            raise ValueError
    except (ValueError, AttributeError) as exc:
        raise ContractError("callback nonce must be a canonical UUID") from exc
    request_timestamp = int(time.time()) if timestamp is None else timestamp
    if request_timestamp < 0:
        raise ContractError("callback timestamp is invalid")
    signing_input = f"{request_timestamp}.{request_nonce}.".encode("ascii") + body
    signature = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).hexdigest()
    return SignedRequest(
        body=body,
        nonce=request_nonce,
        timestamp=request_timestamp,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "X-Opusloops-Job-Id": job.job_id,
            "X-Opusloops-Nonce": request_nonce,
            "X-Opusloops-Timestamp": str(request_timestamp),
            "X-Opusloops-Attempt": job.attempt_id,
            "X-Opusloops-Signature": signature,
            "User-Agent": "opusloops-stem-worker/0.1",
        },
    )


class CallbackClient:
    """Send a signed callback with the exact same bytes on every retry."""

    def __init__(
        self,
        *,
        job: JobContract,
        dispatch_job_id: str,
        secret: str,
        attempts: int = 4,
        timeout_seconds: float = 15.0,
        sleeper: Callable[[float], None] = time.sleep,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        if attempts < 1 or attempts > 8:
            raise ContractError("callback attempts must be between 1 and 8")
        if not math.isfinite(timeout_seconds) or not 1 <= timeout_seconds <= 60:
            raise ContractError("callback timeout is invalid")
        try:
            parsed_dispatch_job_id = uuid.UUID(dispatch_job_id)
            if str(parsed_dispatch_job_id) != dispatch_job_id.lower():
                raise ValueError
        except (ValueError, AttributeError) as exc:
            raise ContractError("AWS Batch dispatch job ID must be a canonical UUID") from exc
        self.job = job
        self.dispatch_job_id = dispatch_job_id.lower()
        self.secret = secret
        self.attempts = attempts
        self.timeout_seconds = timeout_seconds
        self._sleep = sleeper
        self._open = opener

    def send(
        self,
        *,
        event: Mapping[str, object],
        assets: Sequence[Mapping[str, object]] = (),
        result: Mapping[str, object] | None = None,
        error: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]:
        body = callback_body(
            self.job,
            dispatch_job_id=self.dispatch_job_id,
            event=event,
            assets=assets,
            result=result,
            error=error,
        )
        signed = sign_request(self.job, body, self.secret)
        last_retryable = False
        for index in range(self.attempts):
            request = urllib.request.Request(
                self.job.callback_url,
                data=signed.body,
                headers=dict(signed.headers),
                method="POST",
            )
            try:
                with self._open(request, timeout=self.timeout_seconds) as response:
                    response_body = response.read(MAX_PAYLOAD_BYTES + 1)
                    if len(response_body) > MAX_PAYLOAD_BYTES:
                        raise CallbackError("callback response is too large", retryable=False)
                    try:
                        decoded = json.loads(response_body)
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise CallbackError(
                            "callback response is not valid JSON", retryable=False
                        ) from exc
                    if (
                        not isinstance(decoded, Mapping)
                        or decoded.get("accepted") is not True
                        or not isinstance(decoded.get("duplicate"), bool)
                        or not isinstance(decoded.get("job"), Mapping)
                    ):
                        raise CallbackError(
                            "callback response contract is invalid", retryable=False
                        )
                    return decoded
            except urllib.error.HTTPError as exc:
                last_retryable = exc.code == 429 or 500 <= exc.code <= 599
                if not last_retryable:
                    raise CallbackError("callback rejected the event", retryable=False) from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last_retryable = True
                if index + 1 >= self.attempts:
                    raise CallbackError("callback remained unavailable", retryable=True) from exc
            if index + 1 < self.attempts:
                self._sleep(min(8.0, 0.5 * (2**index)))
        raise CallbackError("callback remained unavailable", retryable=last_retryable)
