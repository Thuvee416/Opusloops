"""Deterministic shared tempo-map construction.

Beat detection is continuous.  The four-bar mode in this module only groups an
already-confirmed grid for review and stretching; it never runs independent
four-bar BPM estimators.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

MapMode = Literal["musical-4bar", "rigid-beat", "no-conform"]


class TempoMapError(ValueError):
    """Raised when a proposed grid cannot safely become a render map."""


@dataclass(frozen=True)
class FrameAnchor:
    source_frame: int
    target_frame: int
    kind: str

    def to_dict(self) -> dict[str, int | str]:
        return asdict(self)


@dataclass(frozen=True)
class BeatResidual:
    beat_index: int
    source_frame: int
    mapped_target_frame: int
    straight_target_frame: int
    residual_ms: float

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


@dataclass(frozen=True)
class TempoRegion:
    index: int
    source_start_frame: int
    source_end_frame: int
    target_start_frame: int
    target_end_frame: int
    bars: int
    local_bpm: float
    output_per_input_ratio: float
    max_internal_residual_ms: float

    def to_dict(self) -> dict[str, int | float]:
        return asdict(self)


@dataclass(frozen=True)
class FrameBudget:
    source_start_frame: int
    source_end_frame: int
    target_start_frame: int
    target_end_frame: int

    @property
    def source_frames(self) -> int:
        return self.source_end_frame - self.source_start_frame

    @property
    def target_frames(self) -> int:
        return self.target_end_frame - self.target_start_frame

    def to_dict(self) -> dict[str, int]:
        return {
            **asdict(self),
            "source_frames": self.source_frames,
            "target_frames": self.target_frames,
        }


@dataclass(frozen=True)
class TempoMap:
    algorithm_version: str
    mode: MapMode
    sample_rate: int
    meter_numerator: int
    meter_denominator: int
    target_bpm: float | None
    first_downbeat_seconds: float
    total_source_frames: int
    total_target_frames: int
    snap_tolerance_seconds: float
    anchors: tuple[FrameAnchor, ...]
    regions: tuple[TempoRegion, ...]
    residuals: tuple[BeatResidual, ...]
    warnings: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "algorithm_version": self.algorithm_version,
            "mode": self.mode,
            "sample_rate": self.sample_rate,
            "meter": {
                "numerator": self.meter_numerator,
                "denominator": self.meter_denominator,
            },
            "target_bpm": self.target_bpm,
            "first_downbeat_seconds": self.first_downbeat_seconds,
            "total_source_frames": self.total_source_frames,
            "total_target_frames": self.total_target_frames,
            "snap_tolerance_seconds": self.snap_tolerance_seconds,
            "anchors": [anchor.to_dict() for anchor in self.anchors],
            "regions": [region.to_dict() for region in self.regions],
            "residuals": [residual.to_dict() for residual in self.residuals],
            "warnings": list(self.warnings),
        }

    def to_render_plan_anchors(self) -> tuple[object, ...]:
        """Convert without coupling render-plan serialization back into map math."""

        from .render_plan import FrameAnchor as RenderFrameAnchor

        return tuple(
            RenderFrameAnchor(anchor.source_frame, anchor.target_frame) for anchor in self.anchors
        )


def _round_decimal(value: Decimal) -> int:
    """Round a non-negative frame position once, with explicit tie behavior."""

    if value < 0:
        raise TempoMapError("frame positions cannot be negative")
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def seconds_to_frame(seconds: float, sample_rate: int) -> int:
    if not math.isfinite(seconds) or seconds < 0:
        raise TempoMapError(f"invalid non-negative time: {seconds!r}")
    if sample_rate <= 0:
        raise TempoMapError("sample_rate must be positive")
    return _round_decimal(Decimal(str(seconds)) * Decimal(sample_rate))


def _target_offset_frames(beats: int, target_bpm: float, sample_rate: int) -> int:
    if not math.isfinite(target_bpm) or target_bpm <= 0:
        raise TempoMapError("target_bpm must be a positive finite number")
    value = Decimal(beats) * Decimal(60) * Decimal(sample_rate) / Decimal(str(target_bpm))
    return _round_decimal(value)


def _validated_times(values: Iterable[float], label: str) -> tuple[float, ...]:
    result = tuple(float(value) for value in values)
    if not result:
        raise TempoMapError(f"{label} cannot be empty")
    previous = -math.inf
    for index, value in enumerate(result):
        if not math.isfinite(value) or value < 0:
            raise TempoMapError(f"{label}[{index}] is not a finite non-negative time")
        if value <= previous:
            raise TempoMapError(f"{label} must be strictly increasing")
        previous = value
    return result


def snap_downbeats_to_beats(
    beats_seconds: Sequence[float],
    downbeats_seconds: Sequence[float],
    *,
    meter_numerator: int,
    tolerance_seconds: float = 0.08,
) -> tuple[tuple[float, ...], tuple[int, ...]]:
    """Snap confirmed downbeats and reject ambiguous or incomplete bars.

    Every consecutive downbeat must span exactly ``meter_numerator`` detected
    beat intervals.  A missing/duplicate beat or downbeat therefore blocks the
    proposal for human repair instead of being guessed here.
    """

    beats = _validated_times(beats_seconds, "beats_seconds")
    downbeats = _validated_times(downbeats_seconds, "downbeats_seconds")
    if meter_numerator <= 0:
        raise TempoMapError("meter_numerator must be positive")
    if not math.isfinite(tolerance_seconds) or tolerance_seconds < 0:
        raise TempoMapError("tolerance_seconds must be finite and non-negative")

    snapped: list[float] = []
    beat_indices: list[int] = []
    for downbeat_index, downbeat in enumerate(downbeats):
        insertion = bisect.bisect_left(beats, downbeat)
        candidates = [index for index in (insertion - 1, insertion) if 0 <= index < len(beats)]
        distances = sorted((abs(beats[index] - downbeat), index) for index in candidates)
        if not distances or distances[0][0] > tolerance_seconds:
            raise TempoMapError(
                f"downbeat {downbeat_index} at {downbeat:.6f}s has no beat within "
                f"{tolerance_seconds:.3f}s"
            )
        if len(distances) > 1 and math.isclose(
            distances[0][0], distances[1][0], rel_tol=0.0, abs_tol=1e-12
        ):
            raise TempoMapError(
                f"downbeat {downbeat_index} at {downbeat:.6f}s is equally close to two beats"
            )
        beat_index = distances[0][1]
        if beat_indices and beat_index <= beat_indices[-1]:
            raise TempoMapError("snapped downbeats are duplicate or non-monotonic")
        snapped.append(beats[beat_index])
        beat_indices.append(beat_index)

    for bar_index, (left, right) in enumerate(zip(beat_indices, beat_indices[1:], strict=False)):
        beat_intervals = right - left
        if beat_intervals != meter_numerator:
            condition = "missing" if beat_intervals > meter_numerator else "duplicate"
            raise TempoMapError(
                f"bar {bar_index} spans {beat_intervals} beat intervals; expected "
                f"{meter_numerator} ({condition} beat/downbeat requires review)"
            )
    return tuple(snapped), tuple(beat_indices)


def _append_anchor(anchors: list[FrameAnchor], anchor: FrameAnchor) -> None:
    if anchors and anchor.source_frame == anchors[-1].source_frame:
        if anchor.target_frame != anchors[-1].target_frame:
            raise TempoMapError("one source frame maps to conflicting target frames")
        return
    if anchors and (
        anchor.source_frame < anchors[-1].source_frame
        or anchor.target_frame < anchors[-1].target_frame
    ):
        raise TempoMapError("tempo-map anchors must be monotonic")
    anchors.append(anchor)


def _extend_tail(anchors: list[FrameAnchor], total_frames: int) -> None:
    if total_frames < anchors[-1].source_frame:
        raise TempoMapError("total_frames ends before the last approved anchor")
    if total_frames == anchors[-1].source_frame:
        return

    non_identity_segments = [
        (left, right)
        for left, right in zip(anchors, anchors[1:], strict=False)
        if right.source_frame > left.source_frame and right.kind != "first-downbeat"
    ]
    if not non_identity_segments:
        raise TempoMapError("not enough confirmed timing to extend the partial outro")
    left, right = non_identity_segments[-1]
    source_delta = right.source_frame - left.source_frame
    target_delta = right.target_frame - left.target_frame
    remaining_source = total_frames - anchors[-1].source_frame
    remaining_target = _round_decimal(
        Decimal(remaining_source) * Decimal(target_delta) / Decimal(source_delta)
    )
    _append_anchor(
        anchors,
        FrameAnchor(
            source_frame=total_frames,
            target_frame=anchors[-1].target_frame + remaining_target,
            kind="partial-outro",
        ),
    )


def _segment_target_frame(
    source_frame: int,
    source_start: int,
    source_end: int,
    target_start: int,
    target_end: int,
) -> int:
    source_delta = source_end - source_start
    if source_delta <= 0:
        raise TempoMapError("source anchor deltas must be positive")
    offset = Decimal(source_frame - source_start) * Decimal(target_end - target_start)
    return target_start + _round_decimal(offset / Decimal(source_delta))


def _four_bar_diagnostics(
    *,
    anchors: Sequence[FrameAnchor],
    beat_frames: Sequence[int],
    first_downbeat_beat_index: int,
    sample_rate: int,
    meter_numerator: int,
    target_bpm: float,
) -> tuple[tuple[TempoRegion, ...], tuple[BeatResidual, ...]]:
    regions: list[TempoRegion] = []
    residuals: list[BeatResidual] = []
    musical = [anchor for anchor in anchors if anchor.kind == "four-bar"]
    for region_index, (left, right) in enumerate(zip(musical, musical[1:], strict=False)):
        source_delta = right.source_frame - left.source_frame
        target_delta = right.target_frame - left.target_frame
        local_bpm = (4 * meter_numerator * 60 * sample_rate) / source_delta
        region_residuals: list[float] = []
        region_start_beat = first_downbeat_beat_index + region_index * 4 * meter_numerator
        for ordinal in range(4 * meter_numerator + 1):
            beat_index = region_start_beat + ordinal
            if beat_index >= len(beat_frames):
                break
            source_frame = beat_frames[beat_index]
            if not left.source_frame <= source_frame <= right.source_frame:
                continue
            mapped = _segment_target_frame(
                source_frame,
                left.source_frame,
                right.source_frame,
                left.target_frame,
                right.target_frame,
            )
            straight = left.target_frame + _target_offset_frames(ordinal, target_bpm, sample_rate)
            residual_ms = (mapped - straight) * 1000 / sample_rate
            region_residuals.append(abs(residual_ms))
            residuals.append(
                BeatResidual(
                    beat_index=beat_index,
                    source_frame=source_frame,
                    mapped_target_frame=mapped,
                    straight_target_frame=straight,
                    residual_ms=residual_ms,
                )
            )
        regions.append(
            TempoRegion(
                index=region_index,
                source_start_frame=left.source_frame,
                source_end_frame=right.source_frame,
                target_start_frame=left.target_frame,
                target_end_frame=right.target_frame,
                bars=4,
                local_bpm=local_bpm,
                output_per_input_ratio=target_delta / source_delta,
                max_internal_residual_ms=max(region_residuals, default=0.0),
            )
        )
    return tuple(regions), tuple(residuals)


def build_tempo_map(
    beats_seconds: Sequence[float],
    downbeats_seconds: Sequence[float],
    *,
    sample_rate: int,
    total_frames: int,
    meter_numerator: int,
    target_bpm: float | None,
    mode: MapMode = "musical-4bar",
    meter_denominator: int = 4,
    snap_tolerance_seconds: float = 0.08,
    quality_ratio_min: float = 0.75,
    quality_ratio_max: float = 1.5,
) -> TempoMap:
    """Build one map that must be shared by every aligned stem."""

    if sample_rate <= 0 or total_frames <= 0:
        raise TempoMapError("sample_rate and total_frames must be positive")
    if meter_denominator <= 0:
        raise TempoMapError("meter_denominator must be positive")
    if mode not in {"musical-4bar", "rigid-beat", "no-conform"}:
        raise TempoMapError(f"unsupported tempo-map mode: {mode}")

    beats = _validated_times(beats_seconds, "beats_seconds")
    downbeats = _validated_times(downbeats_seconds, "downbeats_seconds")
    snapped_downbeats, downbeat_beat_indices = snap_downbeats_to_beats(
        beats,
        downbeats,
        meter_numerator=meter_numerator,
        tolerance_seconds=snap_tolerance_seconds,
    )
    beat_frames = tuple(seconds_to_frame(value, sample_rate) for value in beats)
    downbeat_frames = tuple(seconds_to_frame(value, sample_rate) for value in snapped_downbeats)
    if any(right <= left for left, right in zip(beat_frames, beat_frames[1:], strict=False)):
        raise TempoMapError("two beat times collapse to one or non-monotonic sample frame")
    if downbeat_frames[-1] > total_frames:
        raise TempoMapError("a confirmed downbeat falls beyond the source audio")

    first_source = downbeat_frames[0]
    anchors: list[FrameAnchor] = [FrameAnchor(0, 0, "timeline-origin")]
    if first_source:
        _append_anchor(anchors, FrameAnchor(first_source, first_source, "first-downbeat"))

    if mode == "no-conform":
        _append_anchor(anchors, FrameAnchor(total_frames, total_frames, "timeline-end"))
        return TempoMap(
            algorithm_version="opusloops.shared-tempo-map.v1",
            mode=mode,
            sample_rate=sample_rate,
            meter_numerator=meter_numerator,
            meter_denominator=meter_denominator,
            target_bpm=None,
            first_downbeat_seconds=snapped_downbeats[0],
            total_source_frames=total_frames,
            total_target_frames=total_frames,
            snap_tolerance_seconds=snap_tolerance_seconds,
            anchors=tuple(anchors),
            regions=(),
            residuals=(),
            warnings=(),
        )

    if target_bpm is None or not math.isfinite(target_bpm) or target_bpm <= 0:
        raise TempoMapError("a positive target_bpm is required when conforming")

    if mode == "musical-4bar":
        if len(downbeat_frames) < 5:
            raise TempoMapError("musical-4bar requires at least five confirmed bar starts")
        # The first downbeat is already present to preserve a pickup.  Mark it
        # as the first four-bar anchor instead of silently losing it when the
        # two coordinates are identical.
        anchors[-1] = FrameAnchor(first_source, first_source, "four-bar")
        for bar_index in range(4, len(downbeat_frames), 4):
            source_frame = downbeat_frames[bar_index]
            target_frame = first_source + _target_offset_frames(
                bar_index * meter_numerator, target_bpm, sample_rate
            )
            _append_anchor(anchors, FrameAnchor(source_frame, target_frame, "four-bar"))
        # A trailing downbeat not on a four-bar boundary is review information,
        # not an implicit extra render anchor.  Tail timing follows the last
        # complete approved four-bar segment.
        _extend_tail(anchors, total_frames)
        regions, residuals = _four_bar_diagnostics(
            anchors=anchors,
            beat_frames=beat_frames,
            first_downbeat_beat_index=downbeat_beat_indices[0],
            sample_rate=sample_rate,
            meter_numerator=meter_numerator,
            target_bpm=target_bpm,
        )
    else:
        first_beat_index = downbeat_beat_indices[0]
        for beat_index in range(first_beat_index, len(beat_frames)):
            source_frame = beat_frames[beat_index]
            target_frame = first_source + _target_offset_frames(
                beat_index - first_beat_index, target_bpm, sample_rate
            )
            _append_anchor(anchors, FrameAnchor(source_frame, target_frame, "beat"))
        _extend_tail(anchors, total_frames)
        regions = ()
        residuals = ()

    warnings: list[str] = []
    for index, (left, right) in enumerate(zip(anchors, anchors[1:], strict=False)):
        source_delta = right.source_frame - left.source_frame
        target_delta = right.target_frame - left.target_frame
        if source_delta <= 0 or target_delta <= 0:
            raise TempoMapError(f"anchor segment {index} is not strictly positive")
        ratio = target_delta / source_delta
        if ratio < quality_ratio_min or ratio > quality_ratio_max:
            warnings.append(
                f"segment {index} output/input ratio {ratio:.6f} is outside the "
                f"recommended {quality_ratio_min:.2f}-{quality_ratio_max:.2f} quality range"
            )

    return TempoMap(
        algorithm_version="opusloops.shared-tempo-map.v1",
        mode=mode,
        sample_rate=sample_rate,
        meter_numerator=meter_numerator,
        meter_denominator=meter_denominator,
        target_bpm=float(target_bpm),
        first_downbeat_seconds=snapped_downbeats[0],
        total_source_frames=total_frames,
        total_target_frames=anchors[-1].target_frame,
        snap_tolerance_seconds=snap_tolerance_seconds,
        anchors=tuple(anchors),
        regions=regions,
        residuals=residuals,
        warnings=tuple(warnings),
    )


def subdivide_segment(
    source_start: int,
    source_end: int,
    target_start: int,
    target_end: int,
    *,
    max_output_frames: int,
) -> tuple[FrameBudget, ...]:
    """Allocate bounded blocks with cumulative integer rounding.

    Endpoint subtraction, rather than independently rounded block sizes,
    guarantees that source and output totals exactly equal the map segment.
    """

    source_delta = source_end - source_start
    target_delta = target_end - target_start
    if source_delta <= 0 or target_delta <= 0 or max_output_frames <= 0:
        raise TempoMapError("segment deltas and max_output_frames must be positive")
    block_count = math.ceil(target_delta / max_output_frames)
    block_count = min(block_count, source_delta, target_delta)
    source_boundaries = [
        source_start + _round_decimal(Decimal(index) * Decimal(source_delta) / Decimal(block_count))
        for index in range(block_count + 1)
    ]
    target_boundaries = [
        target_start + _round_decimal(Decimal(index) * Decimal(target_delta) / Decimal(block_count))
        for index in range(block_count + 1)
    ]
    budgets = tuple(
        FrameBudget(source_left, source_right, target_left, target_right)
        for source_left, source_right, target_left, target_right in zip(
            source_boundaries,
            source_boundaries[1:],
            target_boundaries,
            target_boundaries[1:],
            strict=False,
        )
    )
    if any(budget.source_frames <= 0 or budget.target_frames <= 0 for budget in budgets):
        raise TempoMapError("cumulative subdivision produced an empty block")
    if sum(budget.source_frames for budget in budgets) != source_delta:
        raise AssertionError("source frame allocation drifted")
    if sum(budget.target_frames for budget in budgets) != target_delta:
        raise AssertionError("target frame allocation drifted")
    return budgets


def validate_anchor_payload(
    anchors: Sequence[dict[str, object]], *, total_source_frames: int | None = None
) -> None:
    """Fail closed on an edited approval map before it reaches a renderer."""

    if len(anchors) < 2:
        raise TempoMapError("an approved map needs at least two anchors")
    previous_source = -1
    previous_target = -1
    for index, anchor in enumerate(anchors):
        source = anchor.get("source_frame")
        target = anchor.get("target_frame")
        if type(source) is not int or type(target) is not int:  # bool is not accepted
            raise TempoMapError(f"anchor {index} frames must be integers")
        if source < 0 or target < 0:
            raise TempoMapError(f"anchor {index} frames cannot be negative")
        if index and (source <= previous_source or target <= previous_target):
            raise TempoMapError("approved anchors must be strictly increasing")
        previous_source = source
        previous_target = target
    if anchors[0]["source_frame"] != 0 or anchors[0]["target_frame"] != 0:
        raise TempoMapError("approved map must begin at timeline origin (0, 0)")
    if total_source_frames is not None and anchors[-1]["source_frame"] != total_source_frames:
        raise TempoMapError("approved map does not end at the source frame count")
