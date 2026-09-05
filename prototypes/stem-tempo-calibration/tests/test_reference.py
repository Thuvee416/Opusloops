from __future__ import annotations

import hashlib
import math
import os
from dataclasses import replace
from pathlib import Path

import pytest

import opusloops_stem_calibration.reference as reference_module
from opusloops_stem_calibration.reference import (
    ReferenceError,
    ReferenceResult,
    ReferenceStem,
    build_reference,
    read_float32_file,
    view_canonical_stem,
    write_float32_file,
)


def stem(path: Path, asset_id: str, samples: list[float], *, frames: int = 2) -> ReferenceStem:
    write_float32_file(path, samples)
    return ReferenceStem(
        asset_id=asset_id,
        output_path=path,
        sample_rate=48_000,
        channels=2,
        frames=frames,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
    )


def test_reference_preserves_relative_levels_then_normalizes_completed_sum(tmp_path: Path) -> None:
    first = stem(tmp_path / "first.f32le", "first", [0.2, -0.2, 0.4, -0.4])
    second = stem(tmp_path / "second.f32le", "second", [0.1, -0.1, 0.2, -0.2])
    original_hashes = {
        item.asset_id: hashlib.sha256(item.output_path.read_bytes()).hexdigest()
        for item in (first, second)
    }
    events: list[tuple[str, str, dict[str, object]]] = []

    result = build_reference(
        [first, second],
        tmp_path / "reference.f32le",
        method="selected-stem-sum",
        sum_headroom_db=0,
        normalize_peak_dbfs=-6,
        block_frames=1,
        event_callback=lambda stage, status, data: events.append((stage, status, data)),
    )

    target_peak = 10 ** (-6 / 20)
    output = read_float32_file(result.output_path)
    assert max(abs(value) for value in output) == pytest.approx(target_peak, abs=1e-6)
    assert output[0] / output[2] == pytest.approx(0.5, abs=1e-6)
    assert result.pre_normalization_peak == pytest.approx(0.6, abs=1e-6)
    assert result.frames == 2
    assert result.bytes == 16
    assert result.sha256 == hashlib.sha256(result.output_path.read_bytes()).hexdigest()
    assert result.input_sha256_by_asset == original_hashes
    assert ReferenceResult.from_dict(result.to_dict()).input_sha256_by_asset == original_hashes
    legacy_payload = result.to_dict()
    legacy_payload.pop("input_sha256_by_asset")
    assert ReferenceResult.from_dict(legacy_payload).input_sha256_by_asset == {}
    assert [status for stage, status, _ in events if stage == "building-reference"] == [
        "started",
        "progress",
        "progress",
        "completed",
    ]
    assert events[-1][0:2] == ("normalizing-reference", "completed")
    assert events[-1][2]["completed_frames"] == events[-1][2]["total_frames"] == 2
    assert events[-1][2]["output_sha256"] == result.sha256
    for item in (first, second):
        current_hash = hashlib.sha256(item.output_path.read_bytes()).hexdigest()
        assert current_hash == original_hashes[item.asset_id]


def test_reference_applies_approved_stem_gain_without_individual_normalization(
    tmp_path: Path,
) -> None:
    loud = stem(tmp_path / "loud.f32le", "loud", [0.5, 0.5, 0.0, 0.0])
    quiet = stem(tmp_path / "quiet.f32le", "quiet", [0.5, 0.5, 0.5, 0.5])
    quiet = ReferenceStem(**{**quiet.__dict__, "gain_db": -6.020599913279624})

    result = build_reference(
        [loud, quiet],
        tmp_path / "reference.f32le",
        sum_headroom_db=-12,
        normalize_peak_dbfs=-3,
    )
    output = read_float32_file(result.output_path)

    # First frame is loud + half-gain quiet; second frame is only half-gain
    # quiet.  The 3:1 ratio survives the one global normalization pass.
    assert output[0] / output[2] == pytest.approx(3.0, abs=1e-5)
    assert result.gain_db_by_asset == {"loud": 0.0, "quiet": quiet.gain_db}


def test_reference_rejects_unequal_frames_without_padding_or_trimming(tmp_path: Path) -> None:
    first = stem(tmp_path / "first.f32le", "first", [0.1, 0.1, 0.2, 0.2])
    second = stem(
        tmp_path / "second.f32le",
        "second",
        [0.1, 0.1, 0.2, 0.2, 0.3, 0.3],
        frames=3,
    )

    with pytest.raises(ReferenceError, match="unequal decoded frame counts"):
        build_reference([first, second], tmp_path / "reference.f32le")


def test_full_mix_requires_exactly_one_asset(tmp_path: Path) -> None:
    first = stem(tmp_path / "first.f32le", "first", [0.1, 0.1, 0.2, 0.2])
    second = stem(tmp_path / "second.f32le", "second", [0.1, 0.1, 0.2, 0.2])

    with pytest.raises(ReferenceError, match="exactly one"):
        build_reference([first, second], tmp_path / "reference.f32le", method="full-mix")


def test_canonical_stem_view_is_hash_verified_and_read_only(tmp_path: Path) -> None:
    drums = stem(tmp_path / "drums.wav", "drums", [0.1, -0.1, 0.2, -0.2])
    original = drums.output_path.read_bytes()

    view = view_canonical_stem(drums)

    assert view.asset_id == "drums"
    assert view.output_path == drums.output_path.resolve()
    assert view.frames == drums.frames
    assert view.audio_data_offset_bytes == 44
    assert view.sha256 == drums.sha256
    assert drums.output_path.read_bytes() == original

    drums.output_path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    with pytest.raises(ReferenceError, match="hash changed"):
        view_canonical_stem(drums)


def test_silent_reference_stays_silent_and_finite(tmp_path: Path) -> None:
    silence = stem(tmp_path / "silence.f32le", "silence", [0.0, 0.0, 0.0, 0.0])
    result = build_reference([silence], tmp_path / "reference.f32le", method="full-mix")

    assert read_float32_file(result.output_path) == (0.0, 0.0, 0.0, 0.0)
    assert result.normalization_gain == 1.0
    assert math.isfinite(result.output_peak)


def test_reference_rejects_wrong_approved_input_hash_before_publication(tmp_path: Path) -> None:
    source = stem(tmp_path / "source.f32le", "source", [0.1, -0.1, 0.2, -0.2])
    source = replace(source, sha256="0" * 64)
    destination = tmp_path / "reference.f32le"

    with pytest.raises(ReferenceError, match="hash changed"):
        build_reference([source], destination, method="full-mix")

    assert not destination.exists()
    assert not list(tmp_path.glob(".reference.f32le.reference-*"))


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symlinks unavailable")
def test_reference_rejects_symlinked_input(tmp_path: Path) -> None:
    source = stem(tmp_path / "source.f32le", "source", [0.1, -0.1, 0.2, -0.2])
    link = tmp_path / "source-link.f32le"
    link.symlink_to(source.output_path)
    linked = replace(source, output_path=link)

    with pytest.raises(ReferenceError, match="symlink"):
        build_reference([linked], tmp_path / "reference.f32le", method="full-mix")


def test_reference_detects_source_mutation_while_verified_snapshot_is_consumed(
    tmp_path: Path,
) -> None:
    source = stem(
        tmp_path / "source.f32le",
        "source",
        [0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4],
        frames=4,
    )
    destination = tmp_path / "reference.f32le"
    changed = False

    def mutate_source(stage: str, status: str, data: dict[str, object]) -> None:
        nonlocal changed
        if (
            not changed
            and stage == "building-reference"
            and status == "progress"
            and data["completed_frames"] == 1
        ):
            changed = True
            write_float32_file(source.output_path, [0.9, -0.9] * 4)

    with pytest.raises(ReferenceError, match="snapshot was consumed"):
        build_reference(
            [source],
            destination,
            method="full-mix",
            block_frames=1,
            event_callback=mutate_source,
        )

    assert changed
    assert not destination.exists()


def test_reference_never_clobbers_existing_output(tmp_path: Path) -> None:
    source = stem(tmp_path / "source.f32le", "source", [0.1, -0.1, 0.2, -0.2])
    destination = tmp_path / "reference.f32le"
    destination.write_bytes(b"existing")

    with pytest.raises(ReferenceError, match="already exists"):
        build_reference([source], destination, method="full-mix")

    assert destination.read_bytes() == b"existing"


def test_reference_publication_race_does_not_overwrite_winner(tmp_path: Path) -> None:
    source = stem(tmp_path / "source.f32le", "source", [0.1, -0.1, 0.2, -0.2])
    destination = tmp_path / "reference.f32le"
    events: list[tuple[str, str]] = []

    def create_race_winner(stage: str, status: str, data: dict[str, object]) -> None:
        del data
        events.append((stage, status))
        if stage == "normalizing-reference" and status == "progress":
            destination.write_bytes(b"race-winner")

    with pytest.raises(ReferenceError, match="already exists"):
        build_reference(
            [source],
            destination,
            method="full-mix",
            event_callback=create_race_winner,
        )

    assert destination.read_bytes() == b"race-winner"
    assert ("normalizing-reference", "completed") not in events
    assert events[-1] == ("normalizing-reference", "failed")


def test_reference_validation_failure_never_publishes_or_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = stem(tmp_path / "source.f32le", "source", [0.1, -0.1, 0.2, -0.2])
    destination = tmp_path / "reference.f32le"
    events: list[tuple[str, str]] = []

    def fail_validation(*args: object, **kwargs: object) -> object:
        del args, kwargs
        raise ReferenceError("synthetic staged validation failure")

    monkeypatch.setattr(reference_module, "_validate_staged_reference", fail_validation)

    with pytest.raises(ReferenceError, match="synthetic staged validation failure"):
        build_reference(
            [source],
            destination,
            method="full-mix",
            event_callback=lambda stage, status, data: events.append((stage, status)),
        )

    assert not destination.exists()
    assert ("normalizing-reference", "completed") not in events
    assert events[-1] == ("normalizing-reference", "failed")
