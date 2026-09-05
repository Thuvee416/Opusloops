"""Translate compact browser decisions into immutable harness gate documents."""

from __future__ import annotations

import copy
import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .errors import ContractError, IntegrityError

MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
MAX_STEMS = 128
MAX_GRID_EVENTS = 100_000
ANALYSIS_ROLES = frozenset(
    {
        "full-mix",
        "drums",
        "bass",
        "vocals",
        "guitar",
        "keys",
        "synth",
        "percussion",
        "fx",
        "other",
    }
)


def load_run_json(run_dir: Path, relative_path: str) -> dict[str, Any]:
    """Load a bounded, regular JSON artifact from inside the reconstructed run."""

    root = run_dir.resolve(strict=True)
    candidate = run_dir.joinpath(*relative_path.split("/"))
    if candidate.is_symlink():
        raise IntegrityError("gate input artifact must not be a symbolic link")
    try:
        path = candidate.resolve(strict=True)
        path.relative_to(root)
        info = path.stat(follow_symlinks=False)
        if not path.is_file() or info.st_size <= 0 or info.st_size > MAX_DOCUMENT_BYTES:
            raise IntegrityError("gate input artifact has an invalid size")
        value = json.loads(path.read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise IntegrityError("gate input artifact is not valid bound JSON") from exc
    if not isinstance(value, dict):
        raise IntegrityError("gate input artifact must be a JSON object")
    return value


def _finite_number(value: object, label: str, minimum: float, maximum: float) -> float:
    if (
        not isinstance(value, int | float)
        or isinstance(value, bool)
        or not math.isfinite(float(value))
        or not minimum <= float(value) <= maximum
    ):
        raise ContractError(f"{label} is outside the supported range")
    return float(value)


def analysis_selection_from_patch(run_dir: Path, patch: Mapping[str, object]) -> dict[str, Any]:
    """Bind a compact Gate-A patch to the worker-generated selection template."""

    required = {
        "referenceMethod",
        "assets",
        "fullMixAssetId",
        "drumCrosscheckAssetId",
        "sum",
    }
    if set(patch) != required:
        raise ContractError("Gate-A selection patch fields are invalid")
    template = load_run_json(run_dir, "analysis-selection.template.json")
    template_selection = template.get("selection")
    template_assets = (
        template_selection.get("assets") if isinstance(template_selection, Mapping) else None
    )
    if not isinstance(template_assets, list) or not template_assets:
        raise IntegrityError("Gate-A template has no inspected asset inventory")
    expected_ids = {
        item.get("asset_id")
        for item in template_assets
        if isinstance(item, Mapping) and isinstance(item.get("asset_id"), str)
    }
    if len(expected_ids) != len(template_assets) or len(expected_ids) > MAX_STEMS:
        raise IntegrityError("Gate-A template asset inventory is invalid")

    method = patch.get("referenceMethod")
    if method not in {"full-mix", "selected-stem-sum"}:
        raise ContractError("Gate-A referenceMethod is invalid")
    patch_assets = patch.get("assets")
    if not isinstance(patch_assets, list) or not patch_assets or len(patch_assets) > MAX_STEMS:
        raise ContractError("Gate-A assets are invalid")
    translated_assets: list[dict[str, object]] = []
    seen: set[str] = set()
    included: set[str] = set()
    roles: dict[str, str] = {}
    for index, item in enumerate(patch_assets):
        if not isinstance(item, Mapping) or set(item) != {
            "assetId",
            "role",
            "included",
            "gainDb",
        }:
            raise ContractError(f"Gate-A asset {index} fields are invalid")
        asset_id = item.get("assetId")
        role = item.get("role")
        is_included = item.get("included")
        if not isinstance(asset_id, str) or asset_id not in expected_ids or asset_id in seen:
            raise ContractError(f"Gate-A asset {index} has an invalid assetId")
        if role not in ANALYSIS_ROLES:
            raise ContractError(f"Gate-A asset {index} has an invalid role")
        if not isinstance(is_included, bool):
            raise ContractError(f"Gate-A asset {index} included must be boolean")
        gain = _finite_number(item.get("gainDb"), f"Gate-A asset {index} gainDb", -120, 24)
        seen.add(asset_id)
        roles[asset_id] = str(role)
        if is_included:
            included.add(asset_id)
        translated_assets.append(
            {
                "asset_id": asset_id,
                "role": role,
                "included": is_included,
                "gain_db": gain,
            }
        )
    if seen != expected_ids or not included:
        raise ContractError("Gate-A patch must list every inspected asset and include at least one")

    full_mix = patch.get("fullMixAssetId")
    if method == "full-mix":
        if not isinstance(full_mix, str) or full_mix not in expected_ids or included != {full_mix}:
            raise ContractError("full-mix Gate A must include exactly its selected full mix")
    elif full_mix is not None:
        raise ContractError("selected-stem-sum Gate A cannot set fullMixAssetId")
    drum = patch.get("drumCrosscheckAssetId")
    if drum is not None and (
        not isinstance(drum, str)
        or drum not in expected_ids
        or drum not in included
        or roles.get(drum) != "drums"
    ):
        raise ContractError("Gate-A drumCrosscheckAssetId is not an included drum stem")

    summing = patch.get("sum")
    if not isinstance(summing, Mapping) or set(summing) != {
        "headroomDb",
        "normalizePeakDbfs",
    }:
        raise ContractError("Gate-A sum settings are invalid")
    headroom = _finite_number(summing.get("headroomDb"), "Gate-A headroomDb", -120, 0)
    normalize = _finite_number(
        summing.get("normalizePeakDbfs"), "Gate-A normalizePeakDbfs", -120, 0
    )
    if normalize != -3:
        raise ContractError("Gate-A v1 normalizePeakDbfs must remain -3")

    normalized = copy.deepcopy(template)
    normalized["selection"] = {
        "reference_method": method,
        "assets": translated_assets,
        "full_mix_asset_id": full_mix,
        "drum_crosscheck_asset_id": drum,
        "sum": {"headroom_db": headroom, "normalize_peak_dbfs": normalize},
    }
    return normalized


def validate_reviewed_grid(
    run_dir: Path,
    value: Mapping[str, object],
    *,
    meter_numerator: int | None,
    meter_denominator: int | None,
    first_downbeat_seconds: float | None,
) -> tuple[dict[str, object], int | None, int | None, float | None]:
    """Validate the server-bound reviewed grid before it can rebuild a proposal."""

    allowed = {
        "schema_version",
        "attempt_id",
        "analysis_sha256",
        "beats_seconds",
        "downbeats_seconds",
        "notes",
        "reviewed",
        "meter",
        "firstDownbeatSeconds",
        "first_downbeat_seconds",
    }
    required = {
        "schema_version",
        "attempt_id",
        "analysis_sha256",
        "beats_seconds",
        "downbeats_seconds",
        "reviewed",
    }
    if not required.issubset(value) or set(value) - allowed:
        raise ContractError("reviewedGrid fields are invalid")
    if value.get("schema_version") != "opusloops.tempo-grid-review.v1":
        raise ContractError("reviewedGrid schema is invalid")
    if value.get("reviewed") is not True:
        raise ContractError("reviewedGrid must be explicitly reviewed")

    manifest = load_run_json(run_dir, "run-manifest.json")
    analysis_record = manifest.get("analysis")
    if not isinstance(analysis_record, Mapping):
        raise IntegrityError("run manifest has no analysis binding")
    artifact = analysis_record.get("artifact")
    if (
        not isinstance(artifact, Mapping)
        or value.get("analysis_sha256") != artifact.get("sha256")
        or value.get("attempt_id") != analysis_record.get("attempt_id")
    ):
        raise ContractError("reviewedGrid is stale for the reconstructed analysis")

    def times(label: str) -> list[float]:
        raw = value.get(label)
        if not isinstance(raw, list) or not raw or len(raw) > MAX_GRID_EVENTS:
            raise ContractError(f"reviewedGrid {label} is invalid")
        result: list[float] = []
        previous = -1.0
        for index, item in enumerate(raw):
            current = _finite_number(item, f"reviewedGrid {label}[{index}]", 0, 24 * 3600)
            if current <= previous:
                raise ContractError(f"reviewedGrid {label} must be strictly increasing")
            result.append(current)
            previous = current
        return result

    beats = times("beats_seconds")
    downbeats = times("downbeats_seconds")
    normalized = dict(value)
    normalized["beats_seconds"] = beats
    normalized["downbeats_seconds"] = downbeats

    embedded_meter = value.get("meter")
    if embedded_meter is not None:
        if not isinstance(embedded_meter, Mapping) or set(embedded_meter) != {
            "numerator",
            "denominator",
        }:
            raise ContractError("reviewedGrid meter is invalid")
        embedded_numerator = embedded_meter.get("numerator")
        embedded_denominator = embedded_meter.get("denominator")
        if type(embedded_numerator) is not int or not 1 <= embedded_numerator <= 32:
            raise ContractError("reviewedGrid meter numerator is invalid")
        if type(embedded_denominator) is not int or embedded_denominator not in {
            1,
            2,
            4,
            8,
            16,
            32,
        }:
            raise ContractError("reviewedGrid meter denominator is invalid")
        if meter_numerator is not None and meter_numerator != embedded_numerator:
            raise ContractError("reviewedGrid meter conflicts with dispatch binding")
        if meter_denominator is not None and meter_denominator != embedded_denominator:
            raise ContractError("reviewedGrid meter conflicts with dispatch binding")
        meter_numerator = int(embedded_numerator)
        meter_denominator = int(embedded_denominator)

    embedded_downbeat = value.get("firstDownbeatSeconds", value.get("first_downbeat_seconds"))
    if embedded_downbeat is not None:
        embedded_downbeat_number = _finite_number(
            embedded_downbeat, "reviewedGrid first downbeat", 0, 24 * 3600
        )
        if (
            first_downbeat_seconds is not None
            and first_downbeat_seconds != embedded_downbeat_number
        ):
            raise ContractError("reviewedGrid first downbeat conflicts with dispatch binding")
        first_downbeat_seconds = embedded_downbeat_number
    if first_downbeat_seconds is not None and not any(
        math.isclose(first_downbeat_seconds, value, rel_tol=0, abs_tol=1e-6) for value in beats
    ):
        raise ContractError("reviewedGrid first downbeat must be one of its beats")
    return (
        normalized,
        meter_numerator,
        meter_denominator,
        first_downbeat_seconds,
    )


def proposal_regions(run_dir: Path, proposal_id: str) -> list[dict[str, object]]:
    """Return the bounded, read-only mobile projection of generated DSP regions."""

    proposal = load_run_json(run_dir, f"proposals/{proposal_id}/tempo-map.proposal.json")
    if (
        proposal.get("schema_version") != "opusloops.tempo-map-proposal.v1"
        or proposal.get("proposal_id") != proposal_id
    ):
        raise IntegrityError("proposal manifest does not match its immutable proposal ID")
    tempo_map = proposal.get("map")
    if not isinstance(tempo_map, Mapping):
        raise IntegrityError("proposal manifest has no generated tempo map")
    raw_regions = tempo_map.get("regions")
    if not isinstance(raw_regions, list) or len(raw_regions) > 1024:
        raise IntegrityError("proposal region inventory is invalid")
    global_target = tempo_map.get("target_bpm")
    if global_target is not None:
        global_target = _finite_number(global_target, "proposal target BPM", 20, 400)
    projected: list[dict[str, object]] = []
    for array_index, raw in enumerate(raw_regions):
        if not isinstance(raw, Mapping):
            raise IntegrityError("proposal region is invalid")
        bars_value = raw.get("bars")
        region_index = raw.get("index")
        local_bpm = raw.get("local_bpm")
        ratio = raw.get("output_per_input_ratio")
        residual = raw.get("max_internal_residual_ms")
        if type(region_index) is not int or region_index != array_index:
            raise IntegrityError("proposal region indexes are not contiguous")
        if type(bars_value) is not int or bars_value <= 0 or bars_value > 64:
            raise IntegrityError("proposal region bar count is invalid")
        local = _finite_number(local_bpm, "proposal local BPM", 20, 400)
        output_ratio = _finite_number(ratio, "proposal stretch ratio", 0.01, 100)
        max_residual_ms = _finite_number(
            residual, "proposal internal residual", 0, 24 * 3600 * 1000
        )
        flagged = output_ratio < 0.75 or output_ratio > 1.5
        start_bar = array_index * bars_value + 1
        record: dict[str, object] = {
            "id": f"region-{array_index + 1}",
            "startBar": start_bar,
            "endBar": start_bar + bars_value - 1,
            "localBpm": local,
            "targetBpm": global_target,
            "outputPerInputRatio": output_ratio,
            "maxInternalResidualMs": max_residual_ms,
            "flagged": flagged,
        }
        if flagged:
            record["note"] = "Stretch ratio is outside the recommended 0.75–1.50 range."
        projected.append(record)
    return projected


def tempo_approval_from_patch(
    run_dir: Path,
    patch: Mapping[str, object],
    *,
    proposal_id: str,
) -> dict[str, Any]:
    """Bind compact Gate B to the generated proposal without accepting new anchors."""

    if set(patch) != {"proposalId", "reviewedRegions"}:
        raise ContractError("Gate-B approval patch fields are invalid")
    if patch.get("proposalId") != proposal_id:
        raise ContractError("Gate-B approval belongs to another proposal")
    reviewed_regions = patch.get("reviewedRegions")
    if not isinstance(reviewed_regions, list):
        raise ContractError("Gate-B reviewedRegions is invalid")

    template = load_run_json(run_dir, f"proposals/{proposal_id}/tempo-approval.template.json")
    if not isinstance(template.get("decision"), Mapping):
        raise IntegrityError("Gate-B template has no render decision")

    expected_regions = []
    for region in proposal_regions(run_dir, proposal_id):
        expected = {
            key: region[key]
            for key in ("id", "startBar", "endBar", "localBpm", "targetBpm", "flagged")
        }
        if "note" in region:
            expected["note"] = region["note"]
        expected_regions.append(expected)
    if reviewed_regions != expected_regions:
        raise ContractError("Gate-B contains an unsupported region mutation")
    # Return the complete worker-generated document. HarnessRunner alone adds
    # approval identity/time and the eight independently supplied attestations.
    return copy.deepcopy(template)


def find_mapping_item(values: object, key: str, expected: object) -> Mapping[str, object] | None:
    if not isinstance(values, Sequence) or isinstance(values, str | bytes):
        return None
    return next(
        (item for item in values if isinstance(item, Mapping) and item.get(key) == expected),
        None,
    )
