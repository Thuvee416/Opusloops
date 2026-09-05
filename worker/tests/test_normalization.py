from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from opusloops_worker.errors import ContractError
from opusloops_worker.normalization import (
    analysis_selection_from_patch,
    proposal_regions,
    tempo_approval_from_patch,
    validate_reviewed_grid,
)


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_gate_a_compact_patch_is_bound_to_worker_template(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write(
        run / "analysis-selection.template.json",
        {
            "schema_version": "opusloops.analysis-selection.v1",
            "approval_id": "worker-generated",
            "approved_at": None,
            "approved_by": None,
            "upstream": {"immutable": "binding"},
            "selection": {
                "assets": [
                    {"asset_id": "asset-a"},
                    {"asset_id": "asset-b"},
                ]
            },
            "confirmations": {},
        },
    )
    normalized = analysis_selection_from_patch(
        run,
        {
            "referenceMethod": "selected-stem-sum",
            "assets": [
                {"assetId": "asset-a", "role": "drums", "included": True, "gainDb": -1},
                {"assetId": "asset-b", "role": "bass", "included": True, "gainDb": 0},
            ],
            "fullMixAssetId": None,
            "drumCrosscheckAssetId": "asset-a",
            "sum": {"headroomDb": -12, "normalizePeakDbfs": -3},
        },
    )
    assert normalized["upstream"] == {"immutable": "binding"}
    assert normalized["selection"]["assets"][0] == {
        "asset_id": "asset-a",
        "role": "drums",
        "included": True,
        "gain_db": -1.0,
    }


def test_gate_a_rejects_asset_substitution(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write(
        run / "analysis-selection.template.json",
        {"selection": {"assets": [{"asset_id": "asset-a"}]}},
    )
    with pytest.raises(ContractError, match="assetId"):
        analysis_selection_from_patch(
            run,
            {
                "referenceMethod": "selected-stem-sum",
                "assets": [
                    {
                        "assetId": "asset-foreign",
                        "role": "drums",
                        "included": True,
                        "gainDb": 0,
                    }
                ],
                "fullMixAssetId": None,
                "drumCrosscheckAssetId": None,
                "sum": {"headroomDb": -12, "normalizePeakDbfs": -3},
            },
        )


def test_reviewed_grid_is_bound_to_reconstructed_analysis(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _write(
        run / "run-manifest.json",
        {
            "analysis": {
                "attempt_id": "analysis-attempt",
                "artifact": {"sha256": "a" * 64},
            }
        },
    )
    grid, numerator, denominator, first = validate_reviewed_grid(
        run,
        {
            "schema_version": "opusloops.tempo-grid-review.v1",
            "attempt_id": "analysis-attempt",
            "analysis_sha256": "a" * 64,
            "beats_seconds": [0, 0.5, 1],
            "downbeats_seconds": [0],
            "reviewed": True,
            "meter": {"numerator": 4, "denominator": 4},
            "firstDownbeatSeconds": 0,
        },
        meter_numerator=4,
        meter_denominator=4,
        first_downbeat_seconds=0,
    )
    assert grid["beats_seconds"] == [0.0, 0.5, 1.0]
    assert (numerator, denominator, first) == (4, 4, 0.0)


def _proposal_fixture(run: Path) -> tuple[dict[str, object], list[dict[str, object]]]:
    decision: dict[str, object] = {
        "map_algorithm_version": "opusloops.shared-tempo-map.v1",
        "mode": "musical-4bar",
        "meter": {"numerator": 4, "denominator": 4},
        "first_downbeat_seconds": 0,
        "tempo_octave": "normal",
        "target_bpm": 120,
        "sample_rate": 48_000,
        "total_source_frames": 384_000,
        "total_target_frames": 384_000,
        "anchors": [
            {"source_frame": 0, "target_frame": 0, "kind": "four-bar"},
            {"source_frame": 384_000, "target_frame": 384_000, "kind": "four-bar"},
        ],
        "notes": "",
    }
    _write(
        run / "proposals/proposal-1/tempo-map.proposal.json",
        {
            "schema_version": "opusloops.tempo-map-proposal.v1",
            "proposal_id": "proposal-1",
            "map": {
                "target_bpm": 120,
                "regions": [
                    {
                        "index": 0,
                        "bars": 4,
                        "local_bpm": 118.5,
                        "output_per_input_ratio": 1.01,
                        "max_internal_residual_ms": 2.75,
                    }
                ],
            },
        },
    )
    _write(
        run / "proposals/proposal-1/tempo-approval.template.json",
        {"schema_version": "opusloops.tempo-approval.v1", "decision": decision},
    )
    return decision, proposal_regions(run, "proposal-1")


def _compact_reviews(regions: list[dict[str, object]]) -> list[dict[str, object]]:
    projected = []
    for region in regions:
        review = {
            key: region[key]
            for key in ("id", "startBar", "endBar", "localBpm", "targetBpm", "flagged")
        }
        if "note" in region:
            review["note"] = region["note"]
        projected.append(review)
    return projected


def test_proposal_regions_expose_measured_ratio_and_residual(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _, regions = _proposal_fixture(run)

    assert regions[0]["outputPerInputRatio"] == pytest.approx(1.01)
    assert regions[0]["maxInternalResidualMs"] == pytest.approx(2.75)


def test_gate_b_uses_generated_anchors_and_accepts_read_only_regions(tmp_path: Path) -> None:
    run = tmp_path / "run"
    decision, regions = _proposal_fixture(run)
    normalized = tempo_approval_from_patch(
        run,
        {
            "proposalId": "proposal-1",
            "reviewedRegions": _compact_reviews(regions),
        },
        proposal_id="proposal-1",
    )
    assert normalized["decision"] == decision
    assert "regions" not in normalized["decision"]


def test_gate_b_rejects_unsupported_region_target_mutation(tmp_path: Path) -> None:
    run = tmp_path / "run"
    _, regions = _proposal_fixture(run)
    changed = copy.deepcopy(_compact_reviews(regions))
    changed[0]["targetBpm"] = 130
    with pytest.raises(ContractError, match="unsupported region mutation"):
        tempo_approval_from_patch(
            run,
            {
                "proposalId": "proposal-1",
                "reviewedRegions": changed,
            },
            proposal_id="proposal-1",
        )


def test_gate_b_rejects_client_supplied_render_decision(tmp_path: Path) -> None:
    run = tmp_path / "run"
    decision, regions = _proposal_fixture(run)
    with pytest.raises(ContractError, match="fields are invalid"):
        tempo_approval_from_patch(
            run,
            {
                "proposalId": "proposal-1",
                "decision": decision,
                "reviewedRegions": _compact_reviews(regions),
            },
            proposal_id="proposal-1",
        )
