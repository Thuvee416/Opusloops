from __future__ import annotations

from pathlib import Path

from conftest import job_payload

from opusloops_worker.contracts import ObjectReference, parse_job
from opusloops_worker.preview import PreviewSegment
from opusloops_worker.runner import _meaningful_asset, _stage_result
from opusloops_worker.storage import StateSnapshot, StoredObject


def _stored(bucket: str = "opusloops-stem-artifacts") -> StoredObject:
    return StoredObject(bucket, "user/project/job/object", "a" * 64, 100, "audio/wav")


def test_audio_asset_contract_uses_canonical_kinds_and_track_metadata() -> None:
    job = parse_job(job_payload("inspect"))
    manifest = {
        "audio_assets": [
            {
                "asset_id": "asset-drums",
                "normalized_name": "Drums.wav",
                "canonical_pcm": {"path": "canonical/asset-drums.wav"},
            }
        ]
    }
    original = _meaningful_asset(
        "extracted/Drums.wav",
        _stored("opusloops-stem-sources"),
        job=job,
        variant="inspection",
        manifest=manifest,
        previews={},
    )
    canonical = _meaningful_asset(
        "canonical/asset-drums.wav",
        _stored("opusloops-stem-sources"),
        job=job,
        variant="inspection",
        manifest=manifest,
        previews={},
    )
    assert (original["kind"], original["variant"]) == ("source_member", "original")
    assert original["metadata"] == {"trackAssetId": "asset-drums"}
    assert (canonical["kind"], canonical["variant"]) == ("canonical", "48khz-f32")
    assert canonical["metadata"] == {"trackAssetId": "asset-drums"}


def test_preview_asset_contract_is_directly_signable_by_track_and_region() -> None:
    job = parse_job(job_payload("render"))
    path = Path("/run/mobile-previews/asset-drums/segment-0002.m4a")
    preview = PreviewSegment(
        path=path,
        stem_id="asset-drums",
        index=2,
        start_frame=768_000,
        end_frame=1_152_000,
        bars=4,
        target_bpm=120,
    )
    relative = "mobile-previews/asset-drums/segment-0002.m4a"
    asset = _meaningful_asset(
        relative,
        StoredObject(
            "opusloops-stem-artifacts",
            "user/project/job/preview",
            "b" * 64,
            100,
            "audio/mp4",
        ),
        job=job,
        variant="render",
        manifest={"audio_assets": []},
        previews={relative: preview},
    )
    assert (asset["kind"], asset["variant"]) == (
        "preview_segment",
        "asset-drums-r2",
    )
    assert asset["metadata"] == {
        "trackAssetId": "asset-drums",
        "regionIndex": 2,
        "startBar": 9,
        "barCount": 4,
        "targetBpm": 120,
        "startSeconds": 16.0,
        "durationSeconds": 8.0,
        "codec": "aac-lc",
    }


def test_only_compact_gate_b_click_is_published_to_browser() -> None:
    job = parse_job(job_payload("propose"))
    manifest = {"audio_assets": []}
    raw = _meaningful_asset(
        "proposals/first-listen/raw-grid-click-audition.wav",
        _stored(),
        job=job,
        variant="first-listen",
        manifest=manifest,
        previews={},
    )
    mobile = _meaningful_asset(
        "proposals/first-listen/mobile-click-audition.m4a",
        StoredObject(
            "opusloops-stem-artifacts",
            "user/project/job/click",
            "c" * 64,
            100,
            "audio/mp4",
        ),
        job=job,
        variant="first-listen",
        manifest=manifest,
        previews={},
    )

    assert raw is None
    assert (mobile["kind"], mobile["variant"], mobile["contentType"]) == (
        "click",
        "first-listen",
        "audio/mp4",
    )


def test_propose_does_not_republish_the_reused_analysis_manifest(tmp_path: Path) -> None:
    job = parse_job(job_payload("propose"))
    previous_manifest = StoredObject(
        "opusloops-stem-artifacts",
        f"{job.storage.run_prefix}/attempts/old-analysis/analyze/files/manifest.json",
        "d" * 64,
        100,
        "application/json",
    )

    assert (
        _meaningful_asset(
            "run-manifest.json",
            previous_manifest,
            job=job,
            variant="first-listen",
            manifest={"audio_assets": []},
            previews={},
        )
        is None
    )

    proposal_dir = tmp_path / "proposals" / "first-listen"
    proposal_dir.mkdir(parents=True)
    (proposal_dir / "tempo-map.proposal.json").write_text(
        '{"schema_version":"opusloops.tempo-map-proposal.v1",'
        '"proposal_id":"first-listen","map":{"target_bpm":120,"regions":[]}}',
        encoding="utf-8",
    )
    state = StateSnapshot(
        ObjectReference(
            "opusloops-stem-artifacts",
            f"{job.storage.run_prefix}/attempts/{job.attempt_id}/propose/state-index.json",
            "e" * 64,
        ),
        (),
        "first-listen",
    )
    assets = [
        {
            "id": "proposal-asset",
            "kind": "proposal_manifest",
            "variant": "first-listen",
            "sha256": "f" * 64,
        },
        {"id": "click-asset", "kind": "click", "variant": "first-listen"},
    ]

    result = _stage_result(
        job=job,
        run_dir=tmp_path,
        state=state,
        assets=assets,
        source=None,
    )

    assert result["proposalManifestSha256"] == "f" * 64
    assert result["clickAssetId"] == "click-asset"
