import hashlib
import math
import shutil
import struct
import subprocess
import wave
from dataclasses import replace
from pathlib import Path

import pytest

from opusloops_stem_calibration.render_plan import (
    FrameAnchor,
    RendererInputs,
    RenderPlan,
    StemInput,
    run_signalsmith,
    signalsmith_command,
    write_renderer_inputs,
)
from opusloops_stem_calibration.tempo_map import build_tempo_map


def _write_pcm16(path: Path, *, frames: int, sample_rate: int, phase: float = 0.0) -> None:
    samples = bytearray()
    for frame in range(frames):
        value = 0.35 * math.sin(2 * math.pi * 220 * frame / sample_rate + phase)
        if frame % 2_000 < 12:
            value += 0.4 * math.exp(-(frame % 2_000) / 4)
        sample = max(-32_768, min(32_767, round(value * 32_767)))
        samples.extend(struct.pack("<h", sample))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples)


def _write_extensible_float32(
    path: Path,
    *,
    frames: int,
    sample_rate: int,
    channels: int = 2,
    extension_bytes: int = 22,
    valid_bits: int = 32,
    subtype: bytes = bytes.fromhex("0300000000001000800000aa00389b71"),
) -> None:
    block_align = channels * 4
    samples = bytearray()
    for frame in range(frames):
        for channel in range(channels):
            value = 0.2 * math.sin(2 * math.pi * (220 + channel * 110) * frame / sample_rate)
            samples.extend(struct.pack("<f", value))
    fmt = struct.pack(
        "<HHIIHHHHI16s",
        0xFFFE,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        32,
        extension_bytes,
        valid_bits,
        (1 << channels) - 1,
        subtype,
    )
    riff_bytes = 4 + 8 + len(fmt) + 8 + len(samples)
    path.write_bytes(
        b"RIFF"
        + struct.pack("<I", riff_bytes)
        + b"WAVEfmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(samples))
        + samples
    )


def _write_impulses(
    path: Path, *, frames: int, sample_rate: int, impulses: tuple[int, ...]
) -> None:
    samples = bytearray()
    impulse_frames = set(impulses)
    for frame in range(frames):
        samples.extend(struct.pack("<h", 29_490 if frame in impulse_frames else 0))
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples)


def _read_float_wav(path: Path) -> tuple[int, int, list[float]]:
    content = path.read_bytes()
    assert content[:4] == b"RIFF" and content[8:12] == b"WAVE"
    audio_format, channels, sample_rate = struct.unpack_from("<HHI", content, 20)
    assert audio_format == 3
    assert content[36:40] == b"data"
    data_bytes = struct.unpack_from("<I", content, 40)[0]
    values = list(struct.unpack_from(f"<{data_bytes // 4}f", content, 44))
    return channels, sample_rate, values


@pytest.fixture(scope="session")
def renderer_binary(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not shutil.which("cmake") or not shutil.which("c++"):
        pytest.skip("native renderer test requires CMake and a C++ compiler")
    prototype = Path(__file__).resolve().parents[1]
    build = tmp_path_factory.mktemp("signalsmith-native-build")
    subprocess.run(
        [
            "cmake",
            "-S",
            str(prototype / "native"),
            "-B",
            str(build),
            "-DCMAKE_BUILD_TYPE=Release",
            "-DCMAKE_CXX_FLAGS=-DOPUSLOOPS_RENDER_TESTING=1",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["cmake", "--build", str(build), "--parallel"],
        check=True,
        capture_output=True,
        text=True,
    )
    return (build / "opusloops-signalsmith-render").resolve()


def _run_test_renderer(
    binary: Path,
    plan: RenderPlan,
    inputs: RendererInputs,
    output: Path,
    *,
    mode: str,
    options: tuple[str, ...],
) -> subprocess.CompletedProcess[str]:
    command = signalsmith_command(
        binary,
        inputs,
        output,
        mode=mode,
        sample_rate=plan.sample_rate,
    )
    return subprocess.run(
        [*command, *options],
        check=False,
        capture_output=True,
        text=True,
    )


def _plan(tmp_path: Path) -> tuple[RenderPlan, dict[str, str]]:
    sample_rate = 8_000
    frames = 16_000
    first = tmp_path / "First Stem.wav"
    second = tmp_path / "Second Stem.wav"
    _write_pcm16(first, frames=frames, sample_rate=sample_rate)
    _write_pcm16(second, frames=frames, sample_rate=sample_rate)
    hashes = {
        first.name: hashlib.sha256(first.read_bytes()).hexdigest(),
        second.name: hashlib.sha256(second.read_bytes()).hexdigest(),
    }
    plan = RenderPlan(
        stems=(
            StemInput("first", first.resolve(), 1, frames),
            StemInput("second", second.resolve(), 1, frames),
        ),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_000, 8_200),
            FrameAnchor(16_000, 17_000),
        ),
        sample_rate=sample_rate,
    )
    return plan, hashes


@pytest.mark.parametrize("mode", ["linked", "independent"])
def test_renderer_is_frame_exact_finite_and_source_immutable(
    renderer_binary: Path, tmp_path: Path, mode: str
) -> None:
    plan, before = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / mode).resolve()

    result = run_signalsmith(renderer_binary, plan, inputs, output, mode=mode)

    assert result["target_frames"] == 17_000
    assert result["wall_seconds"] >= 0
    assert result["peak_rss_bytes"] is None or result["peak_rss_bytes"] > 0
    assert result["plan_sha256"] == inputs.plan_sha256
    assert result["stems_tsv_sha256"] == inputs.stems_tsv_sha256
    assert result["map_tsv_sha256"] == inputs.map_tsv_sha256
    assert result["stem_sha256s"] == dict(inputs.stem_sha256s)
    rendered: list[list[float]] = []
    for stem in plan.stems:
        channels, sample_rate, samples = _read_float_wav(output / f"{stem.asset_id}.wav")
        assert channels == 1
        assert sample_rate == 8_000
        assert len(samples) == 17_000
        assert all(math.isfinite(sample) for sample in samples)
        assert max(abs(sample) for sample in samples) > 0.05
        rendered.append(samples)
        assert hashlib.sha256(stem.path.read_bytes()).hexdigest() == before[stem.path.name]

    # Signalsmith links the spectral decisions, but its channel synthesis is not bit-identical.
    assert max(abs(left - right) for left, right in zip(*rendered, strict=True)) < 1e-3


@pytest.mark.parametrize("mode", ["linked", "independent"])
def test_renderer_accepts_extensible_ieee_float32_canonical_wav(
    renderer_binary: Path, tmp_path: Path, mode: str
) -> None:
    source = (tmp_path / "extensible-float.wav").resolve()
    _write_extensible_float32(source, frames=16_000, sample_rate=8_000)
    plan = RenderPlan(
        stems=(StemInput("extensible-float", source, 2, 16_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_000, 8_200),
            FrameAnchor(16_000, 17_000),
        ),
        sample_rate=8_000,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / mode).resolve()

    result = run_signalsmith(renderer_binary, plan, inputs, output, mode=mode)

    assert result["target_frames"] == 17_000
    channels, sample_rate, samples = _read_float_wav(output / "extensible-float.wav")
    assert channels == 2
    assert sample_rate == 8_000
    assert len(samples) == 34_000
    assert all(math.isfinite(sample) for sample in samples)
    assert max(abs(sample) for sample in samples) > 0.05


@pytest.mark.parametrize(
    ("extension_bytes", "valid_bits", "subtype", "expected_error"),
    [
        (20, 32, bytes.fromhex("0300000000001000800000aa00389b71"), "invalid extensible"),
        (22, 24, bytes.fromhex("0300000000001000800000aa00389b71"), "invalid extensible"),
        (22, 32, bytes.fromhex("0600000000001000800000aa00389b71"), "unsupported extensible"),
    ],
)
def test_renderer_rejects_invalid_extensible_wav_contract(
    renderer_binary: Path,
    tmp_path: Path,
    extension_bytes: int,
    valid_bits: int,
    subtype: bytes,
    expected_error: str,
) -> None:
    source = (tmp_path / "invalid-extensible.wav").resolve()
    _write_extensible_float32(
        source,
        frames=16_000,
        sample_rate=8_000,
        extension_bytes=extension_bytes,
        valid_bits=valid_bits,
        subtype=subtype,
    )
    plan = RenderPlan(
        stems=(StemInput("invalid-extensible", source, 2, 16_000),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(16_000, 16_000)),
        sample_rate=8_000,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    failed = _run_test_renderer(renderer_binary, plan, inputs, output, mode="linked", options=())

    assert failed.returncode == 2
    assert expected_error in failed.stderr
    assert not output.exists()


def test_renderer_refuses_to_overwrite_derivatives(renderer_binary: Path, tmp_path: Path) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "linked").resolve()
    run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")

    with pytest.raises(subprocess.CalledProcessError):
        run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")


@pytest.mark.parametrize("mode", ["linked", "independent"])
def test_later_writer_failure_is_atomic_and_retryable(
    renderer_binary: Path, tmp_path: Path, mode: str
) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / mode).resolve()

    failed = _run_test_renderer(
        renderer_binary,
        plan,
        inputs,
        output,
        mode=mode,
        options=("--test-fail-after-writer", "1"),
    )

    assert failed.returncode == 2
    assert "injected failure after writer 1" in failed.stderr
    assert not output.exists()
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []

    run_signalsmith(renderer_binary, plan, inputs, output, mode=mode)
    assert {path.name for path in output.iterdir()} == {"first.wav", "second.wav"}


def test_final_publication_race_does_not_overwrite_claimed_directory(
    renderer_binary: Path, tmp_path: Path
) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "claimed-output").resolve()

    failed = _run_test_renderer(
        renderer_binary,
        plan,
        inputs,
        output,
        mode="linked",
        options=("--test-create-final-before-publish", "1"),
    )

    assert failed.returncode == 2
    assert "cannot publish without overwriting" in failed.stderr
    assert (output / "external-owner.txt").read_text() == "external-owner\n"
    assert {path.name for path in output.iterdir()} == {"external-owner.txt"}
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []

    with pytest.raises(subprocess.CalledProcessError):
        run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    assert (output / "external-owner.txt").read_text() == "external-owner\n"


def test_retry_ignores_and_preserves_unowned_orphan_staging(
    renderer_binary: Path, tmp_path: Path
) -> None:
    orphan = tmp_path / ".opusloops-render-staging-interrupted-other-lease"
    orphan.mkdir()
    (orphan / ".opusloops-render-lease").write_text(
        "opusloops-render-lease-v1\nother-lease\n/other/target\n"
    )
    (orphan / "foreign.txt").write_text("leave me alone")
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")

    assert {path.name for path in output.iterdir()} == {"first.wav", "second.wav"}
    assert (orphan / "foreign.txt").read_text() == "leave me alone"
    assert (orphan / ".opusloops-render-lease").exists()


@pytest.mark.parametrize(
    ("artifact", "expected_error"),
    [
        ("stems", "stems manifest SHA-256 does not match"),
        ("map", "frame map SHA-256 does not match"),
    ],
)
def test_native_rejects_tampered_renderer_input_bytes(
    renderer_binary: Path,
    tmp_path: Path,
    artifact: str,
    expected_error: str,
) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    path = inputs.stems_tsv if artifact == "stems" else inputs.map_tsv
    path.write_bytes(path.read_bytes() + b"\n")
    output = (tmp_path / "render").resolve()

    failed = _run_test_renderer(renderer_binary, plan, inputs, output, mode="linked", options=())

    assert failed.returncode == 2
    assert expected_error in failed.stderr
    assert not output.exists()
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []


def test_native_rejects_substituted_source_before_render(
    renderer_binary: Path, tmp_path: Path
) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    plan.stems[0].path.write_bytes(plan.stems[0].path.read_bytes() + b"substitution")
    output = (tmp_path / "render").resolve()

    failed = _run_test_renderer(renderer_binary, plan, inputs, output, mode="linked", options=())

    assert failed.returncode == 2
    assert "canonical WAV SHA-256 does not match stems manifest: first" in failed.stderr
    assert not output.exists()
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []


def test_native_rechecks_sources_before_atomic_publish(
    renderer_binary: Path, tmp_path: Path
) -> None:
    plan, _ = _plan(tmp_path)
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    failed = _run_test_renderer(
        renderer_binary,
        plan,
        inputs,
        output,
        mode="linked",
        options=("--test-tamper-source-before-publish", "1"),
    )

    assert failed.returncode == 2
    assert "canonical WAV SHA-256 changed during rendering: first" in failed.stderr
    assert not output.exists()
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []


def test_native_source_swap_restore_cannot_redirect_bound_wav(
    renderer_binary: Path, tmp_path: Path
) -> None:
    plan, before = _plan(tmp_path)
    replacement = (tmp_path / "First Stem replacement.wav").resolve()
    _write_impulses(replacement, frames=16_000, sample_rate=8_000, impulses=())
    replacement_sha256 = hashlib.sha256(replacement.read_bytes()).hexdigest()
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    completed = _run_test_renderer(
        renderer_binary,
        plan,
        inputs,
        output,
        mode="linked",
        options=("--test-swap-first-source-with", str(replacement)),
    )

    assert hashlib.sha256(plan.stems[0].path.read_bytes()).hexdigest() == before["First Stem.wav"]
    assert hashlib.sha256(replacement.read_bytes()).hexdigest() == replacement_sha256
    if completed.returncode == 0:
        _, _, rendered = _read_float_wav(output / "first.wav")
        assert max(abs(sample) for sample in rendered) > 0.05
    else:
        assert "identity changed" in completed.stderr or "test swap" in completed.stderr
        assert not output.exists()


def test_transients_land_near_piecewise_frame_map(renderer_binary: Path, tmp_path: Path) -> None:
    source = (tmp_path / "impulses.wav").resolve()
    _write_impulses(
        source,
        frames=16_000,
        sample_rate=8_000,
        impulses=(4_000, 8_000, 12_000),
    )
    plan = RenderPlan(
        stems=(StemInput("impulses", source, 1, 16_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_000, 8_200),
            FrameAnchor(16_000, 17_000),
        ),
        sample_rate=8_000,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()
    run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    _, _, samples = _read_float_wav(output / "impulses.wav")

    for expected in (4_100, 8_200, 12_600):
        start = expected - 500
        window = samples[start : expected + 501]
        peak = start + max(range(len(window)), key=lambda index: abs(window[index]))
        assert abs(peak - expected) <= 160


def test_gradual_drift_four_bar_anchors_survive_render(
    renderer_binary: Path, tmp_path: Path
) -> None:
    sample_rate = 8_000
    musical_beats = [1.0]
    for interval_index in range(32):
        interval = 0.56 - interval_index * (0.10 / 31)
        musical_beats.append(musical_beats[-1] + interval)
    beats = [0.5, *musical_beats]
    downbeats = musical_beats[::4]
    total_frames = round((musical_beats[-1] + 1.0) * sample_rate)
    tempo_map = build_tempo_map(
        beats,
        downbeats,
        sample_rate=sample_rate,
        total_frames=total_frames,
        meter_numerator=4,
        target_bpm=120,
    )
    musical_anchors = [anchor for anchor in tempo_map.anchors if anchor.kind == "four-bar"]

    source = (tmp_path / "drifting clicks.wav").resolve()
    _write_impulses(
        source,
        frames=total_frames,
        sample_rate=sample_rate,
        impulses=tuple(anchor.source_frame for anchor in musical_anchors),
    )
    plan = RenderPlan(
        stems=(StemInput("drift", source, 1, total_frames),),
        anchors=tempo_map.to_render_plan_anchors(),
        sample_rate=sample_rate,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()
    run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    _, _, samples = _read_float_wav(output / "drift.wav")

    for anchor in musical_anchors:
        expected = anchor.target_frame
        start = expected - 500
        window = samples[start : expected + 501]
        peak = start + max(range(len(window)), key=lambda index: abs(window[index]))
        assert abs(peak - expected) <= 160


def test_near_origin_downbeat_v2_map_survives_native_renderer_preroll(
    renderer_binary: Path, tmp_path: Path
) -> None:
    sample_rate = 8_000
    total_frames = 12 * sample_rate
    beats = [0.02 + index * 0.55125 for index in range(21)]
    tempo_map = build_tempo_map(
        beats,
        beats[::4],
        sample_rate=sample_rate,
        total_frames=total_frames,
        meter_numerator=4,
        target_bpm=109,
    )
    assert tempo_map.anchors[1].kind == "renderer-preroll"
    assert tempo_map.anchors[1].source_frame == 1_200
    assert tempo_map.anchors[1].target_frame == 1_200

    source = (tmp_path / "near-origin.wav").resolve()
    _write_impulses(
        source,
        frames=total_frames,
        sample_rate=sample_rate,
        impulses=(round(0.02 * sample_rate),),
    )
    plan = RenderPlan(
        stems=(StemInput("near-origin", source, 1, total_frames),),
        anchors=tempo_map.to_render_plan_anchors(),
        sample_rate=sample_rate,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    result = run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")

    assert result["target_frames"] == tempo_map.total_target_frames
    _, rendered_rate, samples = _read_float_wav(output / "near-origin.wav")
    assert rendered_rate == sample_rate
    assert len(samples) == tempo_map.total_target_frames


@pytest.mark.parametrize(
    ("source_frame", "expected_target"),
    [(15_799, 15_799), (15_801, 15_804), (15_900, 16_200), (15_999, 16_596)],
)
def test_rate_change_inside_delayed_tail_maps_transients(
    renderer_binary: Path,
    tmp_path: Path,
    source_frame: int,
    expected_target: int,
) -> None:
    source = (tmp_path / "tail-edge.wav").resolve()
    _write_impulses(source, frames=16_000, sample_rate=8_000, impulses=(source_frame,))
    plan = RenderPlan(
        stems=(StemInput("tail-edge", source, 1, 16_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(15_800, 15_800),
            FrameAnchor(16_000, 16_600),
        ),
        sample_rate=8_000,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()
    run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    _, _, samples = _read_float_wav(output / "tail-edge.wav")

    expected = expected_target
    start = max(0, expected - 1_000)
    window = samples[start : min(len(samples), expected + 1_001)]
    dominant_peak = max(abs(sample) for sample in window)
    mapped_window = samples[max(0, expected - 160) : min(len(samples), expected + 161)]
    mapped_peak = max(abs(sample) for sample in mapped_window)

    # Signalsmith spreads an impulse across several phase-vocoder lobes. Tiny
    # platform-specific FFT differences can swap two near-equal lobes, so the
    # mapped lobe must be co-dominant instead of being the single largest sample.
    assert mapped_peak >= dominant_peak * 0.9
    if abs(source_frame - expected) > 160:
        source_window = samples[max(0, source_frame - 80) : min(len(samples), source_frame + 81)]
        source_peak = max(abs(sample) for sample in source_window)
        assert source_peak <= mapped_peak * 0.75


def test_failed_short_render_removes_its_partial_output(
    renderer_binary: Path, tmp_path: Path
) -> None:
    source = (tmp_path / "short.wav").resolve()
    _write_impulses(source, frames=100, sample_rate=8_000, impulses=(50,))
    plan = RenderPlan(
        stems=(StemInput("short", source, 1, 100),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(100, 100)),
        sample_rate=8_000,
    )
    inputs = write_renderer_inputs(plan, (tmp_path / "inputs").resolve())
    output = (tmp_path / "render").resolve()

    with pytest.raises(subprocess.CalledProcessError, match="returned non-zero") as first:
        run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    assert "too short" in first.value.stderr
    assert not (output / "short.wav").exists()
    assert not (output / "short.wav.partial").exists()
    assert list(tmp_path.glob(".opusloops-render-staging-*")) == []

    with pytest.raises(subprocess.CalledProcessError) as retry:
        run_signalsmith(renderer_binary, plan, inputs, output, mode="linked")
    assert "too short" in retry.value.stderr
    assert "already exists" not in retry.value.stderr


def test_renderer_rejects_rate_change_inside_initial_preroll(
    renderer_binary: Path, tmp_path: Path
) -> None:
    source = (tmp_path / "initial-edge.wav").resolve()
    _write_impulses(source, frames=16_000, sample_rate=8_000, impulses=(201,))
    rejected_plan = RenderPlan(
        stems=(StemInput("initial-edge", source, 1, 16_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(200, 800),
            FrameAnchor(16_000, 16_600),
        ),
        sample_rate=8_000,
    )
    safe_plan = replace(
        rejected_plan,
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_000, 8_000),
            FrameAnchor(16_000, 16_600),
        ),
    )
    inputs = write_renderer_inputs(safe_plan, (tmp_path / "inputs").resolve())
    rejected_map = "source_frame\ttarget_frame\n0\t0\n200\t800\n16000\t16600\n"
    inputs.map_tsv.write_text(rejected_map)
    inputs = replace(
        inputs,
        map_tsv_sha256=hashlib.sha256(rejected_map.encode()).hexdigest(),
    )
    output = (tmp_path / "render").resolve()

    failed = _run_test_renderer(
        renderer_binary, rejected_plan, inputs, output, mode="linked", options=()
    )
    assert failed.returncode == 2
    assert "first map region is shorter than the Signalsmith pre-roll" in failed.stderr
    assert not (output / "initial-edge.wav.partial").exists()
