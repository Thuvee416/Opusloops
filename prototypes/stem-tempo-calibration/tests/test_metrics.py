from __future__ import annotations

import math

import numpy as np
import pytest
import soundfile as sf

from opusloops_stem_calibration.metrics import (
    WavAlignmentError,
    WavMetricsError,
    inspect_wav,
    measure_boundary_discontinuities,
    measure_mix_residual,
    measure_pair_residual,
)

SAMPLE_RATE = 48_000


def _write_float_wav(path, samples, *, sample_rate=SAMPLE_RATE):
    sf.write(path, np.asarray(samples, dtype=np.float32), sample_rate, subtype="FLOAT")
    return path


def test_inspect_wav_reports_frames_finite_values_and_clipping(tmp_path):
    wav_path = _write_float_wav(
        tmp_path / "integrity.wav",
        np.asarray(
            [
                [0.0, 0.0],
                [0.5, -0.5],
                [1.0, -1.0],
                [math.nan, math.inf],
            ]
        ),
    )

    result = inspect_wav(wav_path)

    assert result.sample_rate == SAMPLE_RATE
    assert result.channels == 2
    assert result.frames == 4
    assert result.sample_count == 8
    assert result.finite_sample_count == 6
    assert result.non_finite_sample_count == 2
    assert result.all_samples_finite is False
    assert result.clipped_sample_count == 2
    assert result.clipping_fraction == pytest.approx(2 / 6)
    assert result.peak_absolute == pytest.approx(1.0)
    assert result.rms == pytest.approx(math.sqrt(2.5 / 6))
    assert result.stereo is not None
    assert result.stereo.paired_finite_samples == 3
    assert result == inspect_wav(wav_path)


@pytest.mark.parametrize(
    ("right_multiplier", "expected_phase"),
    [(1.0, 1.0), (-1.0, -1.0)],
)
def test_stereo_phase_is_signed_while_coherence_is_sign_insensitive(
    tmp_path, right_multiplier, expected_phase
):
    frame = np.arange(4_096, dtype=np.float64)
    left = np.sin(2.0 * np.pi * frame / 127.0)
    samples = np.column_stack((left, left * right_multiplier))
    wav_path = _write_float_wav(tmp_path / f"phase-{right_multiplier}.wav", samples)

    result = inspect_wav(wav_path, clip_threshold=1.0)

    assert result.stereo is not None
    assert result.stereo.phase_correlation == pytest.approx(expected_phase, abs=1e-12)
    assert result.stereo.coherence == pytest.approx(1.0, abs=1e-12)


def test_mono_wav_has_no_stereo_metrics(tmp_path):
    wav_path = _write_float_wav(tmp_path / "mono.wav", np.zeros(32))

    result = inspect_wav(wav_path)

    assert result.channels == 1
    assert result.stereo is None


def test_boundary_discontinuity_is_normalized_against_local_derivative(tmp_path):
    values = np.arange(128, dtype=np.float64) * 0.001
    values[64:] += 0.5
    wav_path = _write_float_wav(tmp_path / "splice.wav", np.column_stack((values, values)))

    result = measure_boundary_discontinuities(
        wav_path,
        [64],
        context_frames=16,
    )

    assert len(result.points) == 1
    point = result.points[0]
    assert point.boundary_frame == 64
    assert point.finite_channels == 2
    assert point.max_absolute_step == pytest.approx(0.501, abs=1e-6)
    assert point.rms_step == pytest.approx(0.501, abs=1e-6)
    assert point.local_derivative_rms == pytest.approx(0.001, abs=1e-6)
    assert point.step_to_local_rms == pytest.approx(501.0, rel=1e-3)
    assert result.max_absolute_step == point.max_absolute_step
    assert result.max_step_to_local_rms == point.step_to_local_rms


@pytest.mark.parametrize("boundary", [0, 16])
def test_boundary_must_have_a_frame_on_both_sides(tmp_path, boundary):
    wav_path = _write_float_wav(tmp_path / "short.wav", np.zeros((16, 2)))

    with pytest.raises(WavMetricsError, match="outside the valid range"):
        measure_boundary_discontinuities(wav_path, [boundary])


def test_mix_residual_nulls_for_exactly_aligned_component_sum(tmp_path):
    stem_a = np.tile(np.asarray([[0.25, -0.25], [-0.25, 0.25]]), (64, 1))
    stem_b = np.tile(np.asarray([[0.125, 0.125], [-0.125, -0.125]]), (64, 1))
    reference = stem_a + stem_b

    reference_path = _write_float_wav(tmp_path / "linked.wav", reference)
    stem_a_path = _write_float_wav(tmp_path / "stem-a.wav", stem_a)
    stem_b_path = _write_float_wav(tmp_path / "stem-b.wav", stem_b)

    result = measure_mix_residual(reference_path, [stem_a_path, stem_b_path])

    assert result.frames == 128
    assert result.compared_sample_count == 256
    assert result.all_samples_finite is True
    assert result.exact_match is True
    assert result.residual_peak_absolute == 0.0
    assert result.residual_rms == 0.0
    assert result.normalized_residual_rms == 0.0
    assert result.snr_db is None
    assert result.reference_to_mix_correlation == pytest.approx(1.0)


def test_pair_residual_reports_objective_error(tmp_path):
    reference = np.tile(np.asarray([[0.25, -0.25], [-0.25, 0.25]]), (64, 1))
    candidate = reference.copy()
    candidate[32, 0] += 0.125
    reference_path = _write_float_wav(tmp_path / "reference.wav", reference)
    candidate_path = _write_float_wav(tmp_path / "candidate.wav", candidate)

    result = measure_pair_residual(reference_path, candidate_path)

    assert result.exact_match is False
    assert result.residual_peak_absolute == pytest.approx(0.125)
    assert result.residual_rms == pytest.approx(0.125 / math.sqrt(256))
    assert result.normalized_residual_rms is not None
    assert result.normalized_residual_rms > 0.0
    assert result.snr_db is not None
    assert result.reference_to_mix_correlation is not None
    assert result.reference_to_mix_correlation < 1.0


@pytest.mark.parametrize("mismatch", ["sample_rate", "channels", "frames"])
def test_mix_residual_rejects_unaligned_wavs(tmp_path, mismatch):
    reference = np.zeros((64, 2))
    reference_path = _write_float_wav(tmp_path / "reference.wav", reference)
    if mismatch == "sample_rate":
        component_path = _write_float_wav(tmp_path / "component.wav", reference, sample_rate=44_100)
    elif mismatch == "channels":
        component_path = _write_float_wav(tmp_path / "component.wav", np.zeros(64))
    else:
        component_path = _write_float_wav(tmp_path / "component.wav", np.zeros((63, 2)))

    with pytest.raises(WavAlignmentError, match=mismatch.replace("_", " ")):
        measure_mix_residual(reference_path, [component_path])


def test_mix_residual_validates_component_and_gain_counts(tmp_path):
    wav_path = _write_float_wav(tmp_path / "signal.wav", np.zeros((8, 2)))

    with pytest.raises(ValueError, match="at least one"):
        measure_mix_residual(wav_path, [])
    with pytest.raises(ValueError, match="one value per component"):
        measure_mix_residual(wav_path, [wav_path], gains=[1.0, 2.0])


def test_non_wav_container_is_rejected(tmp_path):
    flac_path = tmp_path / "signal.flac"
    sf.write(flac_path, np.zeros(32, dtype=np.float32), SAMPLE_RATE)

    with pytest.raises(WavMetricsError, match="Expected a WAV"):
        inspect_wav(flac_path)
