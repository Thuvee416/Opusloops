"""Strict public contracts shared by Batch dispatch and the callback function."""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any
from urllib.parse import urlsplit

from .errors import ContractError

PAYLOAD_VERSION = 1
MAX_PAYLOAD_BYTES = 256 * 1024
STAGES = frozenset({"inspect", "analyze", "propose", "render"})
MODES = frozenset({"musical-4bar", "rigid-beat", "no-conform"})
BUCKETS = {
    "uploadBucket": "opusloops-stem-uploads",
    "sourceBucket": "opusloops-stem-sources",
    "artifactBucket": "opusloops-stem-artifacts",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
PROJECT_HOST_RE = re.compile(r"^([a-z0-9]{20})\.storage\.supabase\.co$")
CALLBACK_HOST_RE = re.compile(r"^([a-z0-9]{20})\.supabase\.co$")


def _uuid(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise ContractError(f"{label} must be a UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ContractError(f"{label} must be a UUID") from exc
    if str(parsed) != value.lower():
        raise ContractError(f"{label} must use canonical UUID form")
    return str(parsed)


def _sha256(value: object, label: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ContractError(f"{label} must be a lowercase SHA-256")
    return value


def _object_key(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024:
        raise ContractError(f"{label} is invalid")
    if value.startswith("/") or "\\" in value or any(ord(char) < 32 for char in value):
        raise ContractError(f"{label} is unsafe")
    parts = value.split("/")
    if any(
        not part or part in {".", ".."} or not SAFE_SEGMENT_RE.fullmatch(part) for part in parts
    ):
        raise ContractError(f"{label} contains an unsafe path segment")
    return value


def _bounded_mapping(value: object, label: str, *, max_bytes: int = 128 * 1024) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{label} must be an object")
    copied = dict(value)
    encoded = json.dumps(copied, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > max_bytes:
        raise ContractError(f"{label} is too large")
    return copied


@dataclass(frozen=True, slots=True)
class ObjectReference:
    bucket: str
    key: str
    sha256: str

    @classmethod
    def from_value(cls, value: object, label: str) -> ObjectReference | None:
        if value is None:
            return None
        if not isinstance(value, Mapping) or set(value) != {"bucket", "key", "sha256"}:
            raise ContractError(f"{label} must contain only bucket, key, and sha256")
        bucket = value["bucket"]
        if not isinstance(bucket, str) or bucket not in set(BUCKETS.values()):
            raise ContractError(f"{label}.bucket is not an approved stem bucket")
        return cls(
            bucket=bucket,
            key=_object_key(value["key"], f"{label}.key"),
            sha256=_sha256(value["sha256"], f"{label}.sha256"),  # type: ignore[arg-type]
        )


@dataclass(frozen=True, slots=True)
class StorageContract:
    endpoint: str
    region: str
    upload_bucket: str
    source_bucket: str
    artifact_bucket: str
    source_key: str
    run_prefix: str
    project_ref: str
    access_key_id: str
    secret_access_key: str = dataclass_field(repr=False)
    session_token: str = dataclass_field(repr=False)


@dataclass(frozen=True, slots=True)
class InputContract:
    source_sha256: str | None
    inspection_manifest: ObjectReference | None
    selection: dict[str, Any] | None
    analysis: ObjectReference | None
    proposal: ObjectReference | None
    approval: dict[str, Any] | None
    target_bpm: float | None
    mode: str | None
    proposal_id: str | None
    reviewed_grid: dict[str, Any] | None
    reviewed_grid_sha256: str | None
    meter_numerator: int | None
    meter_denominator: int | None
    first_downbeat_seconds: float | None


@dataclass(frozen=True, slots=True)
class JobContract:
    job_id: str
    user_id: str
    project_id: str
    attempt_id: str
    stage: str
    revision: int
    storage: StorageContract
    inputs: InputContract
    callback_url: str
    callback_token: str = dataclass_field(repr=False)

    @property
    def expected_run_prefix(self) -> str:
        return f"{self.user_id}/{self.project_id}/{self.job_id}"


def decode_payload(encoded: str) -> dict[str, Any]:
    if not encoded or len(encoded) > MAX_PAYLOAD_BYTES * 2:
        raise ContractError("encoded job payload is empty or too large")
    try:
        raw = base64.b64decode(encoded, altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ContractError("job payload is not valid base64") from exc
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise ContractError("decoded job payload exceeds 256 KiB")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("job payload is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ContractError("job payload must be a JSON object")
    return value


def parse_job(value: Mapping[str, Any], *, expected_stage: str | None = None) -> JobContract:
    required = {
        "version",
        "jobId",
        "userId",
        "projectId",
        "attemptId",
        "stage",
        "revision",
        "storage",
        "inputs",
        "callback",
    }
    if set(value) != required or value.get("version") != PAYLOAD_VERSION:
        raise ContractError("job payload fields or version are invalid")
    stage = value.get("stage")
    if stage not in STAGES or (expected_stage is not None and stage != expected_stage):
        raise ContractError("job stage does not match the invoked worker stage")
    revision = value.get("revision")
    if type(revision) is not int or revision < 0:
        raise ContractError("revision must be a non-negative integer")

    job_id = _uuid(value.get("jobId"), "jobId")
    user_id = _uuid(value.get("userId"), "userId")
    project_id = _uuid(value.get("projectId"), "projectId")
    attempt_id = _uuid(value.get("attemptId"), "attemptId")

    storage_value = value.get("storage")
    storage_fields = {
        "endpoint",
        "region",
        "uploadBucket",
        "sourceBucket",
        "artifactBucket",
        "sourceKey",
        "runPrefix",
        "accessKeyId",
        "secretAccessKey",
        "sessionToken",
    }
    if not isinstance(storage_value, Mapping) or set(storage_value) != storage_fields:
        raise ContractError("storage contract fields are invalid")
    endpoint = storage_value.get("endpoint")
    if not isinstance(endpoint, str):
        raise ContractError("storage endpoint is invalid")
    endpoint_parts = urlsplit(endpoint)
    host_match = PROJECT_HOST_RE.fullmatch(endpoint_parts.hostname or "")
    if (
        endpoint_parts.scheme != "https"
        or endpoint_parts.path.rstrip("/") != "/storage/v1/s3"
        or endpoint_parts.query
        or endpoint_parts.fragment
        or not host_match
    ):
        raise ContractError("storage endpoint must be a Supabase S3 HTTPS endpoint")
    region = storage_value.get("region")
    if not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", region):
        raise ContractError("storage region is invalid")
    for field, expected_bucket in BUCKETS.items():
        if storage_value.get(field) != expected_bucket:
            raise ContractError(f"{field} must be {expected_bucket}")
    run_prefix = _object_key(storage_value.get("runPrefix"), "runPrefix")
    expected_prefix = f"{user_id}/{project_id}/{job_id}"
    if run_prefix != expected_prefix:
        raise ContractError("runPrefix must bind the user, project, and job IDs")
    source_key = _object_key(storage_value.get("sourceKey"), "sourceKey")
    if not source_key.startswith(f"{expected_prefix}/"):
        raise ContractError("sourceKey must be inside the bound job prefix")
    access_key_id = storage_value.get("accessKeyId")
    secret_access_key = storage_value.get("secretAccessKey")
    session_token = storage_value.get("sessionToken")
    if access_key_id != host_match.group(1):
        raise ContractError("S3 accessKeyId must match the bound Supabase project")
    jwt_pattern = re.compile(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
    if (
        not isinstance(secret_access_key, str)
        or not 32 <= len(secret_access_key) <= 4096
        or any(ord(char) < 32 for char in secret_access_key)
        or not jwt_pattern.fullmatch(secret_access_key)
    ):
        raise ContractError("S3 secretAccessKey is invalid")
    if (
        not isinstance(session_token, str)
        or not 32 <= len(session_token) <= 16_384
        or any(ord(char) < 32 for char in session_token)
        or not jwt_pattern.fullmatch(session_token)
    ):
        raise ContractError("S3 sessionToken is invalid")

    callback_value = value.get("callback")
    if not isinstance(callback_value, Mapping) or set(callback_value) != {"url", "token"}:
        raise ContractError("callback contract fields are invalid")
    callback_url = callback_value.get("url")
    if not isinstance(callback_url, str):
        raise ContractError("callback URL is invalid")
    callback_parts = urlsplit(callback_url)
    callback_host_match = CALLBACK_HOST_RE.fullmatch(callback_parts.hostname or "")
    if (
        callback_parts.scheme != "https"
        or callback_parts.path != "/functions/v1/stem-worker-callback"
        or callback_parts.query
        or callback_parts.fragment
        or not callback_host_match
        or callback_host_match.group(1) != host_match.group(1)
    ):
        raise ContractError("callback URL must match the storage Supabase project")
    callback_token = callback_value.get("token")
    if not isinstance(callback_token, str) or not SHA256_RE.fullmatch(callback_token):
        raise ContractError("callback token must be 64 lowercase hexadecimal characters")

    inputs_value = value.get("inputs")
    input_fields = {
        "sourceSha256",
        "inspectionManifest",
        "selection",
        "analysis",
        "proposal",
        "approval",
        "targetBpm",
        "mode",
        "proposalId",
        "reviewedGrid",
        "reviewedGridSha256",
        "meterNumerator",
        "meterDenominator",
        "firstDownbeatSeconds",
    }
    if not isinstance(inputs_value, Mapping) or set(inputs_value) != input_fields:
        raise ContractError("inputs contract fields are invalid")
    source_sha256 = _sha256(inputs_value.get("sourceSha256"), "sourceSha256", nullable=True)
    selection = inputs_value.get("selection")
    approval = inputs_value.get("approval")
    target_bpm_value = inputs_value.get("targetBpm")
    target_bpm: float | None = None
    if target_bpm_value is not None:
        if (
            not isinstance(target_bpm_value, int | float)
            or isinstance(target_bpm_value, bool)
            or not math.isfinite(float(target_bpm_value))
            or not 20 <= float(target_bpm_value) <= 400
        ):
            raise ContractError("targetBpm must be between 20 and 400")
        target_bpm = float(target_bpm_value)
    mode = inputs_value.get("mode")
    if mode is not None and mode not in MODES:
        raise ContractError("mode is invalid")
    proposal_id = inputs_value.get("proposalId")
    if proposal_id is not None and (
        not isinstance(proposal_id, str) or not SAFE_SEGMENT_RE.fullmatch(proposal_id)
    ):
        raise ContractError("proposalId is invalid")

    reviewed_grid_value = inputs_value.get("reviewedGrid")
    reviewed_grid = (
        _bounded_mapping(reviewed_grid_value, "reviewedGrid")
        if reviewed_grid_value is not None
        else None
    )
    reviewed_grid_sha256 = _sha256(
        inputs_value.get("reviewedGridSha256"), "reviewedGridSha256", nullable=True
    )
    if (reviewed_grid is None) != (reviewed_grid_sha256 is None):
        raise ContractError("reviewedGrid and reviewedGridSha256 must be supplied together")

    meter_numerator_value = inputs_value.get("meterNumerator")
    meter_numerator: int | None = None
    if meter_numerator_value is not None:
        if type(meter_numerator_value) is not int or not 1 <= meter_numerator_value <= 32:
            raise ContractError("meterNumerator must be an integer from 1 to 32")
        meter_numerator = meter_numerator_value
    meter_denominator_value = inputs_value.get("meterDenominator")
    meter_denominator: int | None = None
    if meter_denominator_value is not None:
        if meter_denominator_value not in {1, 2, 4, 8, 16, 32}:
            raise ContractError("meterDenominator is invalid")
        meter_denominator = int(meter_denominator_value)
    if (meter_numerator is None) != (meter_denominator is None):
        raise ContractError("meter numerator and denominator must be supplied together")

    first_downbeat_value = inputs_value.get("firstDownbeatSeconds")
    first_downbeat_seconds: float | None = None
    if first_downbeat_value is not None:
        if (
            not isinstance(first_downbeat_value, int | float)
            or isinstance(first_downbeat_value, bool)
            or not math.isfinite(float(first_downbeat_value))
            or float(first_downbeat_value) < 0
        ):
            raise ContractError("firstDownbeatSeconds must be a finite non-negative number")
        first_downbeat_seconds = float(first_downbeat_value)

    inputs = InputContract(
        source_sha256=source_sha256,
        inspection_manifest=ObjectReference.from_value(
            inputs_value.get("inspectionManifest"), "inspectionManifest"
        ),
        selection=(_bounded_mapping(selection, "selection") if selection is not None else None),
        analysis=ObjectReference.from_value(inputs_value.get("analysis"), "analysis"),
        proposal=ObjectReference.from_value(inputs_value.get("proposal"), "proposal"),
        approval=_bounded_mapping(approval, "approval") if approval is not None else None,
        target_bpm=target_bpm,
        mode=mode,
        proposal_id=proposal_id,
        reviewed_grid=reviewed_grid,
        reviewed_grid_sha256=reviewed_grid_sha256,
        meter_numerator=meter_numerator,
        meter_denominator=meter_denominator,
        first_downbeat_seconds=first_downbeat_seconds,
    )
    _validate_stage_inputs(stage, inputs)
    return JobContract(
        job_id=job_id,
        user_id=user_id,
        project_id=project_id,
        attempt_id=attempt_id,
        stage=stage,
        revision=revision,
        storage=StorageContract(
            endpoint=endpoint.rstrip("/"),
            region=region,
            upload_bucket=BUCKETS["uploadBucket"],
            source_bucket=BUCKETS["sourceBucket"],
            artifact_bucket=BUCKETS["artifactBucket"],
            source_key=source_key,
            run_prefix=run_prefix,
            project_ref=host_match.group(1),
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            session_token=session_token,
        ),
        inputs=inputs,
        callback_url=callback_url,
        callback_token=callback_token,
    )


def _validate_stage_inputs(stage: str, inputs: InputContract) -> None:
    if stage == "inspect":
        if inputs.source_sha256 is not None:
            raise ContractError("inspect must measure sourceSha256 inside the worker")
        if any(
            item is not None
            for item in (
                inputs.inspection_manifest,
                inputs.selection,
                inputs.analysis,
                inputs.proposal,
                inputs.approval,
                inputs.target_bpm,
                inputs.mode,
                inputs.proposal_id,
                inputs.reviewed_grid,
                inputs.reviewed_grid_sha256,
                inputs.meter_numerator,
                inputs.meter_denominator,
                inputs.first_downbeat_seconds,
            )
        ):
            raise ContractError("inspect received inputs for a later stage")
    elif stage == "analyze":
        if inputs.inspection_manifest is None or inputs.selection is None:
            raise ContractError("analyze requires inspectionManifest and selection")
    elif stage == "propose":
        if (
            inputs.analysis is None
            or inputs.mode is None
            or inputs.proposal_id is None
            or inputs.reviewed_grid is None
            or inputs.reviewed_grid_sha256 is None
        ):
            raise ContractError("propose requires analysis, reviewed grid, mode, and proposalId")
        if inputs.mode == "no-conform" and inputs.target_bpm is not None:
            raise ContractError("no-conform proposal must not set targetBpm")
        if inputs.mode != "no-conform" and inputs.target_bpm is None:
            raise ContractError("conforming proposal requires targetBpm")
    elif stage == "render":
        if inputs.proposal is None or inputs.approval is None or inputs.proposal_id is None:
            raise ContractError("render requires proposal state, proposalId, and approval")


def encode_payload(value: Mapping[str, Any]) -> str:
    """Encode a payload exactly as an AWS Batch parameter for tests and operations."""

    raw = json.dumps(dict(value), separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise ContractError("job payload exceeds 256 KiB")
    return base64.urlsafe_b64encode(raw).decode("ascii")
