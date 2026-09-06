from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

import pytest

from opusloops_stem_calibration.render_plan import (
    target_at_source,
    validate_signalsmith_pre_roll,
)
from opusloops_stem_calibration.tempo_map import (
    TempoMapError,
    build_tempo_map,
    subdivide_segment,
    validate_anchor_payload,
)

SAMPLE_RATE = 48_000


def steady_grid() -> tuple[list[float], list[float]]:
    # One pickup beat, then nine complete 4/4 bar starts at 120 BPM.
    beats = [0.5] + [1.0 + index * 0.5 for index in range(36)]
    downbeats = [1.0 + index * 2.0 for index in range(9)]
    return beats, downbeats


def round_half_up(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def test_musical_map_preserves_pickup_and_lands_four_bar_boundaries_exactly() -> None:
    beats, downbeats = steady_grid()
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=20 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=100,
    )

    coordinates = [(item.source_frame, item.target_frame) for item in tempo_map.anchors]
    assert coordinates == [
        (0, 0),
        (1 * SAMPLE_RATE, 1 * SAMPLE_RATE),
        (9 * SAMPLE_RATE, 508_800),
        (17 * SAMPLE_RATE, 969_600),
        (20 * SAMPLE_RATE, 1_142_400),
    ]
    assert [item.kind for item in tempo_map.anchors] == [
        "timeline-origin",
        "four-bar",
        "four-bar",
        "four-bar",
        "partial-outro",
    ]
    assert tempo_map.total_target_frames == 1_142_400
    assert len(tempo_map.regions) == 2
    assert all(region.local_bpm == pytest.approx(120) for region in tempo_map.regions)
    assert all(region.max_internal_residual_ms == pytest.approx(0) for region in tempo_map.regions)


def test_near_origin_downbeat_gets_a_renderer_safe_identity_preroll() -> None:
    # These are the production failure's exact first two four-bar coordinates:
    # (960, 960) -> (424320, 423712) at 48 kHz and 109 BPM.
    beats = [0.02 + index * 0.55125 for index in range(21)]
    downbeats = beats[::4]
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=12 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=109,
    )

    assert tempo_map.algorithm_version == "opusloops.shared-tempo-map.v2"
    assert tempo_map.first_downbeat_seconds == pytest.approx(0.02)
    assert (
        tempo_map.anchors[1].source_frame,
        tempo_map.anchors[1].target_frame,
        tempo_map.anchors[1].kind,
    ) == (7_200, 7_200, "renderer-preroll")
    assert (
        tempo_map.anchors[2].source_frame,
        tempo_map.anchors[2].target_frame,
        tempo_map.anchors[2].kind,
    ) == (424_320, 423_712, "four-bar")
    assert target_at_source(tempo_map.to_render_plan_anchors(), 960) == 960
    validate_signalsmith_pre_roll(
        tempo_map.to_render_plan_anchors(),
        sample_rate=SAMPLE_RATE,
    )
    assert tempo_map.regions[0].source_start_frame == 960
    assert tempo_map.regions[0].target_start_frame == 960
    assert tempo_map.regions[0].max_internal_residual_ms > 0
    assert tempo_map.residuals[0].residual_ms == 0
    assert any("renderer-safe identity pre-roll" in item for item in tempo_map.warnings)


def test_target_positions_use_one_cumulative_rounding_not_incremental_rounding() -> None:
    beats, downbeats = steady_grid()
    bpm = Decimal("123.45")
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=20 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=float(bpm),
    )
    four_bar = [anchor for anchor in tempo_map.anchors if anchor.kind == "four-bar"]
    first = SAMPLE_RATE
    for group_index, anchor in enumerate(four_bar):
        expected_offset = round_half_up(Decimal(group_index * 4 * 4 * 60 * SAMPLE_RATE) / bpm)
        assert anchor.target_frame == first + expected_offset


def test_missing_bar_or_beat_blocks_for_review() -> None:
    beats, _ = steady_grid()
    with pytest.raises(TempoMapError, match="missing beat/downbeat requires review"):
        build_tempo_map(
            beats,
            [1.0, 3.0, 7.0, 9.0, 11.0],
            sample_rate=SAMPLE_RATE,
            total_frames=20 * SAMPLE_RATE,
            meter_numerator=4,
            target_bpm=120,
        )


def test_non_monotonic_events_block_instead_of_being_sorted() -> None:
    beats, downbeats = steady_grid()
    with pytest.raises(TempoMapError, match="strictly increasing"):
        build_tempo_map(
            [*beats[:5], beats[3], *beats[5:]],
            downbeats,
            sample_rate=SAMPLE_RATE,
            total_frames=20 * SAMPLE_RATE,
            meter_numerator=4,
            target_bpm=120,
        )


def test_downbeat_without_nearby_beat_blocks() -> None:
    beats, downbeats = steady_grid()
    downbeats[2] += 0.2
    with pytest.raises(TempoMapError, match="has no beat within"):
        build_tempo_map(
            beats,
            downbeats,
            sample_rate=SAMPLE_RATE,
            total_frames=20 * SAMPLE_RATE,
            meter_numerator=4,
            target_bpm=120,
        )


def test_rigid_mode_anchors_each_confirmed_beat_after_first_downbeat() -> None:
    beats, downbeats = steady_grid()
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=20 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=100,
        mode="rigid-beat",
    )

    beat_anchors = [anchor for anchor in tempo_map.anchors if anchor.kind == "beat"]
    assert len(beat_anchors) == len(beats) - 2  # first downbeat reuses its pickup anchor
    assert beat_anchors[0].source_frame == int(1.5 * SAMPLE_RATE)
    assert beat_anchors[0].target_frame == SAMPLE_RATE + 28_800


def test_no_conform_is_an_exact_identity_map() -> None:
    beats, downbeats = steady_grid()
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=20 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=None,
        mode="no-conform",
    )

    assert [(a.source_frame, a.target_frame) for a in tempo_map.anchors] == [
        (0, 0),
        (20 * SAMPLE_RATE, 20 * SAMPLE_RATE),
    ]
    assert tempo_map.algorithm_version == "opusloops.shared-tempo-map.v2"
    assert tempo_map.first_downbeat_seconds == 1.0
    assert target_at_source(tempo_map.to_render_plan_anchors(), SAMPLE_RATE) == SAMPLE_RATE
    assert all(anchor.kind != "renderer-preroll" for anchor in tempo_map.anchors)


def test_extreme_stretch_is_preserved_but_warned_for_human_decision() -> None:
    beats, downbeats = steady_grid()
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=SAMPLE_RATE,
        total_frames=20 * SAMPLE_RATE,
        meter_numerator=4,
        target_bpm=60,
    )
    assert any("outside the recommended" in warning for warning in tempo_map.warnings)


def test_bounded_block_allocation_has_exact_integer_totals() -> None:
    budgets = subdivide_segment(7, 10_010, 11, 14_019, max_output_frames=1_000)

    assert max(item.target_frames for item in budgets) <= 1_000
    assert sum(item.source_frames for item in budgets) == 10_003
    assert sum(item.target_frames for item in budgets) == 14_008
    assert budgets[0].source_start_frame == 7
    assert budgets[-1].source_end_frame == 10_010
    assert budgets[0].target_start_frame == 11
    assert budgets[-1].target_end_frame == 14_019


def test_edited_anchor_payload_must_cover_timeline_and_remain_monotonic() -> None:
    with pytest.raises(TempoMapError, match="strictly increasing"):
        validate_anchor_payload(
            [
                {"source_frame": 0, "target_frame": 0},
                {"source_frame": 10, "target_frame": 12},
                {"source_frame": 9, "target_frame": 20},
            ],
            total_source_frames=9,
        )

    validate_anchor_payload(
        [
            {"source_frame": 0, "target_frame": 0},
            {"source_frame": 10, "target_frame": 12},
        ],
        total_source_frames=10,
    )
