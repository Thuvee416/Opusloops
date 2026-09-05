from __future__ import annotations

import io
import json
from pathlib import Path

from conftest import job_payload

from opusloops_worker import __main__ as entrypoint
from opusloops_worker import runner
from opusloops_worker.contracts import encode_payload, parse_job
from opusloops_worker.isolation import IsolationError

WORKER_ROOT = Path(__file__).resolve().parents[1]


def test_entrypoint_fails_before_decoding_when_isolation_is_unavailable(
    monkeypatch, capsys
) -> None:
    def reject_isolation() -> None:
        raise IsolationError

    monkeypatch.setattr(entrypoint, "harden_process", reject_isolation)
    monkeypatch.setattr(
        entrypoint,
        "decode_payload",
        lambda _encoded: (_ for _ in ()).throw(AssertionError("must not decode")),
    )

    assert entrypoint.main(["inspect", "--payload-base64", "sensitive"]) == 1
    error = json.loads(capsys.readouterr().err)
    assert error == {
        "status": "failed",
        "code": "process_isolation_failed",
        "retryable": False,
    }


def test_payload_descriptor_is_closed_after_one_bounded_read(monkeypatch) -> None:
    encoded = encode_payload(job_payload("inspect"))
    payload_file = io.BytesIO(encoded.encode("ascii") + b"\n")
    monkeypatch.setattr(entrypoint.os, "fdopen", lambda *_args, **_kwargs: payload_file)

    assert entrypoint._payload_from_descriptor(3) == encoded
    assert payload_file.closed


def test_container_uses_the_descriptor_handoff_entrypoint() -> None:
    dockerfile = (WORKER_ROOT / "Dockerfile").read_text(encoding="utf-8")
    wrapper = (WORKER_ROOT / "entrypoint.sh").read_text(encoding="utf-8")

    assert 'ENTRYPOINT ["/opt/opusloops/bin/opusloops-worker-entrypoint"]' in dockerfile
    assert 'exec "$worker" "$1" --payload-fd 3 3<<EOF' in wrapper
    assert "OPUSLOOPS_JOB_PAYLOAD_BASE64" not in dockerfile


def test_production_callback_uses_attempt_token_not_global_environment(monkeypatch) -> None:
    job = parse_job(job_payload("inspect"))
    captured: dict[str, object] = {}

    def object_store(**kwargs):
        captured["storage"] = kwargs
        return object()

    def callback_client(**kwargs):
        captured["callback"] = kwargs
        return object()

    monkeypatch.setattr(runner, "S3ObjectStore", object_store)
    monkeypatch.setattr(runner, "CallbackClient", callback_client)
    monkeypatch.setenv("AWS_BATCH_JOB_ID", "66666666-6666-4666-8666-666666666666")
    monkeypatch.setenv("OPUSLOOPS_CALLBACK_HMAC_SECRET", "must-not-be-used")

    runner.production_dependencies(job)

    callback = captured["callback"]
    assert isinstance(callback, dict)
    assert callback["secret"] == job.callback_token
    assert callback["secret"] != "must-not-be-used"
