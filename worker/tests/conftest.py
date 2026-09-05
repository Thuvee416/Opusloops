from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

WORKER_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = WORKER_ROOT / "src"
if str(SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(SOURCE_ROOT))


def job_payload(stage: str = "inspect") -> dict[str, object]:
    job_id = "33333333-3333-4333-8333-333333333333"
    user_id = "11111111-1111-4111-8111-111111111111"
    project_id = "22222222-2222-4222-8222-222222222222"
    prefix = f"{user_id}/{project_id}/{job_id}"
    inputs: dict[str, object] = {
        "sourceSha256": None,
        "inspectionManifest": None,
        "selection": None,
        "analysis": None,
        "proposal": None,
        "approval": None,
        "targetBpm": None,
        "mode": None,
        "proposalId": None,
        "reviewedGrid": None,
        "reviewedGridSha256": None,
        "meterNumerator": None,
        "meterDenominator": None,
        "firstDownbeatSeconds": None,
    }
    reference = {
        "bucket": "opusloops-stem-artifacts",
        "key": f"{prefix}/attempts/00000000-0000-4000-8000-000000000000/state-index.json",
        "sha256": "b" * 64,
    }
    if stage == "analyze":
        inputs["inspectionManifest"] = reference
        inputs["selection"] = {"schema_version": "test-selection"}
    elif stage == "propose":
        inputs["analysis"] = reference
        inputs["targetBpm"] = 120
        inputs["mode"] = "musical-4bar"
        inputs["proposalId"] = "first-listen"
        inputs["reviewedGrid"] = {
            "schema_version": "opusloops.tempo-grid-review.v1",
            "attempt_id": "analysis-attempt",
            "analysis_sha256": "c" * 64,
            "beats_seconds": [0.0, 0.5],
            "downbeats_seconds": [0.0],
            "reviewed": True,
        }
        inputs["reviewedGridSha256"] = "d" * 64
        inputs["meterNumerator"] = 4
        inputs["meterDenominator"] = 4
        inputs["firstDownbeatSeconds"] = 0
    elif stage == "render":
        inputs["proposal"] = reference
        inputs["approval"] = {"schema_version": "test-approval"}
        inputs["proposalId"] = "first-listen"
    return {
        "version": 1,
        "jobId": job_id,
        "userId": user_id,
        "projectId": project_id,
        "attemptId": "44444444-4444-4444-8444-444444444444",
        "stage": stage,
        "revision": 0,
        "storage": {
            "endpoint": "https://heryvahetgzfalmuprbw.storage.supabase.co/storage/v1/s3",
            "region": "us-east-1",
            "uploadBucket": "opusloops-stem-uploads",
            "sourceBucket": "opusloops-stem-sources",
            "artifactBucket": "opusloops-stem-artifacts",
            "sourceKey": f"{prefix}/upload/stems.zip",
            "runPrefix": prefix,
            "accessKeyId": "heryvahetgzfalmuprbw",
            "secretAccessKey": "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.cHVibGljLXNpZ25hdHVyZQ",
            "sessionToken": "header.payload.signature-with-enough-characters",
        },
        "inputs": inputs,
        "callback": {
            "url": "https://heryvahetgzfalmuprbw.supabase.co/functions/v1/stem-worker-callback",
            "token": "a" * 64,
        },
    }


def encode(value: object) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
