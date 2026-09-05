"""Container entry point."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence

from .contracts import MAX_PAYLOAD_BYTES, STAGES, decode_payload, parse_job
from .errors import ContractError, WorkerError
from .isolation import harden_process
from .runner import production_dependencies, run_job


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(prog="opusloops-stem-worker")
    value.add_argument("stage", choices=sorted(STAGES))
    payload = value.add_mutually_exclusive_group(required=True)
    payload.add_argument(
        "--payload-base64",
        help="base64 job contract for local execution",
    )
    payload.add_argument("--payload-fd", type=int, help=argparse.SUPPRESS)
    return value


def _payload_from_descriptor(descriptor: int) -> str:
    if descriptor != 3:
        raise ContractError("job payload descriptor is invalid")
    try:
        with os.fdopen(descriptor, "rb", closefd=True) as payload_file:
            raw = payload_file.read(MAX_PAYLOAD_BYTES * 2 + 2)
    except OSError:
        raise ContractError("job payload descriptor is unavailable") from None
    if (
        not raw
        or len(raw) > MAX_PAYLOAD_BYTES * 2 + 1
        or not raw.endswith(b"\n")
        or b"\n" in raw[:-1]
    ):
        raise ContractError("job payload descriptor contents are invalid")
    try:
        return raw[:-1].decode("ascii")
    except UnicodeDecodeError:
        raise ContractError("job payload descriptor contents are invalid") from None


def main(argv: Sequence[str] | None = None) -> int:
    try:
        harden_process()
        args = parser().parse_args(argv)
        encoded = (
            args.payload_base64
            if args.payload_base64 is not None
            else _payload_from_descriptor(args.payload_fd)
        )
        job = parse_job(decode_payload(encoded), expected_stage=args.stage)
        store, callback, scratch_root = production_dependencies(job)
        result = run_job(
            job,
            store=store,
            callback=callback,
            scratch_root=scratch_root,
        )
    except WorkerError as exc:
        print(
            json.dumps(
                {"status": "failed", "code": exc.code, "retryable": exc.retryable},
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps({"status": "completed", **result}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
