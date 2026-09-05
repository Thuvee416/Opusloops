"""Deterministic, in-process metrics for objective WAV render comparisons.

The functions in this module never invoke media tools.  They stream decoded
samples through ``soundfile`` so large calibration renders do not need to be
held in memory, and they use fixed formulas that are suitable for comparing a
linked render against independently rendered stems.
"""

from __future__ import annotations

import math
import os
from collections.abc import Sequence
from contextlib import ExitStack
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

PathLike = str | os.PathLike[str]


class MetricsDependencyError(RuntimeError):
    """Raised when the analysis extras required for WAV metrics are absent."""


class WavMetricsError(ValueError):
    """Raised when a metric cannot be computed from the supplied WAV file."""


class WavAlignmentError(WavMetricsError):
    """Raised when files supplied for a residual comparison do not align."""


@dataclass(frozen=True, slots=True)
class StereoMetrics:
    """Whole-file, zero-lag relationship between two stereo channels.

    ``phase_correlation`` is a DC-centred signed correlation in ``[-1, 1]``.
    ``coherence`` is its sign-insensitive, uncentred squared normalization in
    ``[0, 1]``.  Inverted copies therefore have phase correlation ``-1`` but
    coherence ``1``.  ``None`` means there was insufficient finite, non-silent
    signal for the relevant calculation.
    """

    paired_finite_samples: int
    phase_correlation: float | None
    coherence: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class WavMetrics:
    """Signal-integrity and level metrics for one WAV file."""

    path: str
    sample_rate: int
    channels: int
    frames: int
    sample_count: int
    finite_sample_count: int
    non_finite_sample_count: int
    all_samples_finite: bool
    clipped_sample_count: int
    clipping_fraction: float
    clip_threshold: float
    peak_absolute: float | None
    rms: float | None
    stereo: StereoMetrics | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class BoundaryPointMetrics:
    """Discontinuity measured between frames ``boundary_frame - 1`` and N."""

    boundary_frame: int
    finite_channels: int
    non_finite_channels: int
    max_absolute_step: float | None
    rms_step: float | None
    local_derivative_rms: float | None
    step_to_local_rms: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class BoundaryMetrics:
    """Aggregate and per-boundary discontinuity measurements."""

    path: str
    sample_rate: int
    channels: int
    frames: int
    context_frames: int
    points: tuple[BoundaryPointMetrics, ...]
    max_absolute_step: float | None
    max_step_to_local_rms: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class MixResidualMetrics:
    """Residual between a reference WAV and the gain-weighted sum of WAVs.

    The function producing this result requires identical sample rates,
    channel counts, and frame counts.  It never truncates or resamples inputs.
    A caller comparing linked and independent renderers should therefore use
    the same source-to-target frame map for both sets before measuring.
    """

    reference_path: str
    component_paths: tuple[str, ...]
    gains: tuple[float, ...]
    sample_rate: int
    channels: int
    frames: int
    compared_sample_count: int
    finite_sample_count: int
    non_finite_sample_count: int
    all_samples_finite: bool
    exact_match: bool
    residual_peak_absolute: float | None
    residual_rms: float | None
    reference_rms: float | None
    normalized_residual_rms: float | None
    snr_db: float | None
    reference_to_mix_correlation: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True, slots=True)
class _WavShape:
    sample_rate: int
    channels: int
    frames: int


def _audio_modules() -> tuple[Any, Any]:
    try:
        import numpy as np
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover - depends on the caller's environment
        raise MetricsDependencyError(
            "WAV metrics require the calibration analysis extras; "
            "install the project with `.[analysis]`."
        ) from exc
    return np, sf


def _validate_positive_int(value: int, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _open_wav_info(path: PathLike) -> tuple[Path, _WavShape]:
    _, sf = _audio_modules()
    wav_path = Path(path)
    if not wav_path.is_file():
        raise WavMetricsError(f"WAV file does not exist: {wav_path}")

    try:
        info = sf.info(wav_path)
    except (OSError, RuntimeError) as exc:
        raise WavMetricsError(f"Unable to inspect WAV file {wav_path}: {exc}") from exc

    if not str(info.format).upper().startswith("WAV"):
        raise WavMetricsError(f"Expected a WAV container, got {info.format!r}: {wav_path}")
    return wav_path, _WavShape(
        sample_rate=int(info.samplerate),
        channels=int(info.channels),
        frames=int(info.frames),
    )


def _clamp_unit(value: float) -> float:
    return min(1.0, max(-1.0, value))


def inspect_wav(
    path: PathLike,
    *,
    clip_threshold: float = 0.999,
    block_frames: int = 65_536,
) -> WavMetrics:
    """Stream a WAV and report frame, finite-value, clipping, and stereo metrics.

    Clipping is deliberately threshold-based because integer PCM's largest
    positive sample decodes just below ``1.0``.  The default counts samples at
    or above 99.9 percent of digital full scale.
    """

    np, sf = _audio_modules()
    block_frames = _validate_positive_int(block_frames, name="block_frames")
    if not math.isfinite(clip_threshold) or not 0.0 < clip_threshold <= 1.0:
        raise ValueError("clip_threshold must be finite and in (0, 1]")

    wav_path, shape = _open_wav_info(path)
    finite_count = 0
    clipped_count = 0
    peak = 0.0
    sum_squares = 0.0

    paired_count = 0
    sum_left = 0.0
    sum_right = 0.0
    sum_left_squares = 0.0
    sum_right_squares = 0.0
    sum_cross = 0.0

    try:
        with sf.SoundFile(wav_path) as source:
            while True:
                block = source.read(
                    frames=block_frames,
                    dtype="float64",
                    always_2d=True,
                )
                if block.shape[0] == 0:
                    break

                finite_mask = np.isfinite(block)
                finite_values = block[finite_mask]
                finite_count += int(finite_values.size)
                if finite_values.size:
                    absolute = np.abs(finite_values)
                    peak = max(peak, float(np.max(absolute)))
                    clipped_count += int(np.count_nonzero(absolute >= clip_threshold))
                    sum_squares += float(np.dot(finite_values, finite_values))

                if shape.channels == 2:
                    pair_mask = finite_mask[:, 0] & finite_mask[:, 1]
                    left = block[pair_mask, 0]
                    right = block[pair_mask, 1]
                    paired_count += int(left.size)
                    if left.size:
                        sum_left += float(np.sum(left, dtype=np.float64))
                        sum_right += float(np.sum(right, dtype=np.float64))
                        sum_left_squares += float(np.dot(left, left))
                        sum_right_squares += float(np.dot(right, right))
                        sum_cross += float(np.dot(left, right))
    except (OSError, RuntimeError) as exc:
        raise WavMetricsError(f"Unable to decode WAV file {wav_path}: {exc}") from exc

    sample_count = shape.frames * shape.channels
    non_finite_count = sample_count - finite_count
    stereo = None
    if shape.channels == 2:
        phase_correlation = None
        coherence = None
        if paired_count:
            covariance = sum_cross - (sum_left * sum_right / paired_count)
            left_variance = max(0.0, sum_left_squares - (sum_left * sum_left / paired_count))
            right_variance = max(0.0, sum_right_squares - (sum_right * sum_right / paired_count))
            variance_denominator = math.sqrt(left_variance * right_variance)
            if variance_denominator > 0.0:
                phase_correlation = _clamp_unit(covariance / variance_denominator)

            energy_denominator = sum_left_squares * sum_right_squares
            if energy_denominator > 0.0:
                coherence = min(
                    1.0,
                    max(0.0, (sum_cross * sum_cross) / energy_denominator),
                )

        stereo = StereoMetrics(
            paired_finite_samples=paired_count,
            phase_correlation=phase_correlation,
            coherence=coherence,
        )

    return WavMetrics(
        path=str(wav_path),
        sample_rate=shape.sample_rate,
        channels=shape.channels,
        frames=shape.frames,
        sample_count=sample_count,
        finite_sample_count=finite_count,
        non_finite_sample_count=non_finite_count,
        all_samples_finite=non_finite_count == 0,
        clipped_sample_count=clipped_count,
        clipping_fraction=(clipped_count / finite_count if finite_count else 0.0),
        clip_threshold=clip_threshold,
        peak_absolute=(peak if finite_count else None),
        rms=(math.sqrt(sum_squares / finite_count) if finite_count else None),
        stereo=stereo,
    )


def measure_boundary_discontinuities(
    path: PathLike,
    boundary_frames: Sequence[int],
    *,
    context_frames: int = 2_048,
    normalization_floor: float = 1e-12,
) -> BoundaryMetrics:
    """Measure sample jumps at known chunk, segment, or tempo-map boundaries.

    ``step_to_local_rms`` compares the boundary's RMS jump with ordinary
    first-difference RMS in the surrounding context.  The boundary difference
    itself is excluded from that baseline so a bad splice cannot normalize
    itself away.
    """

    np, sf = _audio_modules()
    context_frames = _validate_positive_int(context_frames, name="context_frames")
    if not math.isfinite(normalization_floor) or normalization_floor <= 0.0:
        raise ValueError("normalization_floor must be finite and greater than zero")

    wav_path, shape = _open_wav_info(path)
    normalized_boundaries: list[int] = []
    for boundary in boundary_frames:
        if isinstance(boundary, bool) or not isinstance(boundary, int):
            raise ValueError("boundary frames must be integers")
        if boundary <= 0 or boundary >= shape.frames:
            raise WavMetricsError(
                f"Boundary frame {boundary} is outside the valid range "
                f"[1, {max(0, shape.frames - 1)}] for {wav_path}"
            )
        normalized_boundaries.append(boundary)

    points: list[BoundaryPointMetrics] = []
    try:
        with sf.SoundFile(wav_path) as source:
            for boundary in normalized_boundaries:
                start = max(0, boundary - context_frames)
                stop = min(shape.frames, boundary + context_frames)
                source.seek(start)
                window = source.read(
                    frames=stop - start,
                    dtype="float64",
                    always_2d=True,
                )

                split = boundary - start
                step = window[split] - window[split - 1]
                finite_step = np.isfinite(step)
                step_values = step[finite_step]
                finite_channels = int(step_values.size)

                max_absolute_step = None
                rms_step = None
                if finite_channels:
                    max_absolute_step = float(np.max(np.abs(step_values)))
                    rms_step = math.sqrt(float(np.dot(step_values, step_values)) / finite_channels)

                differences = np.diff(window, axis=0)
                boundary_difference_index = split - 1
                if differences.shape[0]:
                    differences = np.concatenate(
                        (
                            differences[:boundary_difference_index],
                            differences[boundary_difference_index + 1 :],
                        ),
                        axis=0,
                    )
                finite_differences = differences[np.isfinite(differences)]
                local_derivative_rms = None
                if finite_differences.size:
                    local_derivative_rms = math.sqrt(
                        float(np.dot(finite_differences, finite_differences))
                        / int(finite_differences.size)
                    )

                points.append(
                    BoundaryPointMetrics(
                        boundary_frame=boundary,
                        finite_channels=finite_channels,
                        non_finite_channels=shape.channels - finite_channels,
                        max_absolute_step=max_absolute_step,
                        rms_step=rms_step,
                        local_derivative_rms=local_derivative_rms,
                        step_to_local_rms=(
                            rms_step / max(local_derivative_rms or 0.0, normalization_floor)
                            if rms_step is not None
                            else None
                        ),
                    )
                )
    except (OSError, RuntimeError) as exc:
        raise WavMetricsError(f"Unable to decode WAV file {wav_path}: {exc}") from exc

    absolute_steps = [
        point.max_absolute_step for point in points if point.max_absolute_step is not None
    ]
    normalized_steps = [
        point.step_to_local_rms for point in points if point.step_to_local_rms is not None
    ]
    return BoundaryMetrics(
        path=str(wav_path),
        sample_rate=shape.sample_rate,
        channels=shape.channels,
        frames=shape.frames,
        context_frames=context_frames,
        points=tuple(points),
        max_absolute_step=max(absolute_steps, default=None),
        max_step_to_local_rms=max(normalized_steps, default=None),
    )


def _validate_mix_shapes(
    reference_path: Path,
    reference_shape: _WavShape,
    components: Sequence[tuple[Path, _WavShape]],
) -> None:
    for component_path, component_shape in components:
        mismatches: list[str] = []
        if component_shape.sample_rate != reference_shape.sample_rate:
            mismatches.append(
                f"sample rate {component_shape.sample_rate} != {reference_shape.sample_rate}"
            )
        if component_shape.channels != reference_shape.channels:
            mismatches.append(f"channels {component_shape.channels} != {reference_shape.channels}")
        if component_shape.frames != reference_shape.frames:
            mismatches.append(f"frames {component_shape.frames} != {reference_shape.frames}")
        if mismatches:
            raise WavAlignmentError(
                f"Cannot compare {component_path} with {reference_path}: " + ", ".join(mismatches)
            )


def measure_mix_residual(
    reference_wav: PathLike,
    component_wavs: Sequence[PathLike],
    *,
    gains: Sequence[float] | None = None,
    block_frames: int = 65_536,
) -> MixResidualMetrics:
    """Compare a reference WAV with the aligned sum of component WAV files.

    This is the objective null-test primitive for linked-versus-independent
    renders.  Inputs must have identical sample rates, channel counts, and
    frame counts; mismatches raise :class:`WavAlignmentError` instead of being
    silently truncated or resampled.
    """

    np, sf = _audio_modules()
    block_frames = _validate_positive_int(block_frames, name="block_frames")
    if not component_wavs:
        raise ValueError("component_wavs must contain at least one WAV file")

    reference_path, reference_shape = _open_wav_info(reference_wav)
    components = tuple(_open_wav_info(path) for path in component_wavs)
    _validate_mix_shapes(reference_path, reference_shape, components)

    if gains is None:
        normalized_gains = (1.0,) * len(components)
    else:
        if len(gains) != len(components):
            raise ValueError("gains must contain one value per component WAV")
        normalized_gains = tuple(float(gain) for gain in gains)
        if any(not math.isfinite(gain) for gain in normalized_gains):
            raise ValueError("gains must all be finite")

    finite_count = 0
    residual_peak = 0.0
    residual_sum_squares = 0.0
    reference_sum_squares = 0.0

    paired_count = 0
    sum_reference = 0.0
    sum_mix = 0.0
    sum_reference_squares = 0.0
    sum_mix_squares = 0.0
    sum_cross = 0.0

    try:
        with ExitStack() as stack:
            reference_source = stack.enter_context(sf.SoundFile(reference_path))
            component_sources = [
                stack.enter_context(sf.SoundFile(component_path))
                for component_path, _ in components
            ]

            while True:
                reference = reference_source.read(
                    frames=block_frames,
                    dtype="float64",
                    always_2d=True,
                )
                if reference.shape[0] == 0:
                    break

                mixed = np.zeros_like(reference)
                for component_source, gain in zip(component_sources, normalized_gains, strict=True):
                    component = component_source.read(
                        frames=reference.shape[0],
                        dtype="float64",
                        always_2d=True,
                    )
                    if component.shape != reference.shape:
                        raise WavAlignmentError(
                            "A component WAV ended before its declared frame count"
                        )
                    mixed += component * gain

                paired_finite = np.isfinite(reference) & np.isfinite(mixed)
                reference_values = reference[paired_finite]
                mixed_values = mixed[paired_finite]
                residual_values = reference_values - mixed_values
                finite_count += int(residual_values.size)
                paired_count += int(residual_values.size)

                if residual_values.size:
                    residual_peak = max(residual_peak, float(np.max(np.abs(residual_values))))
                    residual_sum_squares += float(np.dot(residual_values, residual_values))
                    reference_sum_squares += float(np.dot(reference_values, reference_values))

                    sum_reference += float(np.sum(reference_values, dtype=np.float64))
                    sum_mix += float(np.sum(mixed_values, dtype=np.float64))
                    sum_reference_squares += float(np.dot(reference_values, reference_values))
                    sum_mix_squares += float(np.dot(mixed_values, mixed_values))
                    sum_cross += float(np.dot(reference_values, mixed_values))
    except WavAlignmentError:
        raise
    except (OSError, RuntimeError) as exc:
        raise WavMetricsError(f"Unable to decode aligned WAV inputs: {exc}") from exc

    compared_sample_count = reference_shape.frames * reference_shape.channels
    non_finite_count = compared_sample_count - finite_count
    residual_rms = math.sqrt(residual_sum_squares / finite_count) if finite_count else None
    reference_rms = math.sqrt(reference_sum_squares / finite_count) if finite_count else None
    normalized_residual_rms = None
    snr_db = None
    if residual_rms is not None and reference_rms is not None and reference_rms > 0.0:
        normalized_residual_rms = residual_rms / reference_rms
        if residual_rms > 0.0:
            snr_db = 20.0 * math.log10(reference_rms / residual_rms)

    correlation = None
    if paired_count:
        covariance = sum_cross - (sum_reference * sum_mix / paired_count)
        reference_variance = max(
            0.0,
            sum_reference_squares - (sum_reference * sum_reference / paired_count),
        )
        mix_variance = max(
            0.0,
            sum_mix_squares - (sum_mix * sum_mix / paired_count),
        )
        denominator = math.sqrt(reference_variance * mix_variance)
        if denominator > 0.0:
            correlation = _clamp_unit(covariance / denominator)

    return MixResidualMetrics(
        reference_path=str(reference_path),
        component_paths=tuple(str(path) for path, _ in components),
        gains=normalized_gains,
        sample_rate=reference_shape.sample_rate,
        channels=reference_shape.channels,
        frames=reference_shape.frames,
        compared_sample_count=compared_sample_count,
        finite_sample_count=finite_count,
        non_finite_sample_count=non_finite_count,
        all_samples_finite=non_finite_count == 0,
        exact_match=non_finite_count == 0 and residual_peak == 0.0,
        residual_peak_absolute=(residual_peak if finite_count else None),
        residual_rms=residual_rms,
        reference_rms=reference_rms,
        normalized_residual_rms=normalized_residual_rms,
        snr_db=snr_db,
        reference_to_mix_correlation=correlation,
    )


def measure_pair_residual(
    reference_wav: PathLike,
    candidate_wav: PathLike,
    *,
    gain: float = 1.0,
    block_frames: int = 65_536,
) -> MixResidualMetrics:
    """Convenience wrapper for the residual between two aligned WAV files."""

    return measure_mix_residual(
        reference_wav,
        [candidate_wav],
        gains=[gain],
        block_frames=block_frames,
    )
