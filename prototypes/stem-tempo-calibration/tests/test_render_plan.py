import hashlib
import json
import subprocess
from pathlib import Path
from unittest import mock

import pytest

from opusloops_stem_calibration.render_plan import (
    FrameAnchor,
    RenderPlan,
    RenderPlanError,
    StemInput,
    iter_render_blocks,
    pin_signalsmith_renderer,
    run_signalsmith,
    signalsmith_command,
    validate_render_plan,
    verify_renderer_inputs,
    write_renderer_inputs,
)


def plan_for(path: Path) -> RenderPlan:
    return RenderPlan(
        stems=(StemInput("lead-vocals", path, 2, 24_001),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_001, 8_000),
            FrameAnchor(16_000, 16_100),
            FrameAnchor(24_001, 24_000),
        ),
        sample_rate=48_000,
    )


def test_block_allocation_is_exact_across_variable_regions() -> None:
    anchors = plan_for(Path("/private/not-read.wav")).anchors
    blocks = list(iter_render_blocks(anchors, max_target_frames=997))

    assert sum(block.source_frames for block in blocks) == anchors[-1].source_frame
    assert sum(block.target_frames for block in blocks) == anchors[-1].target_frame
    assert blocks[0].source_offset == blocks[0].target_offset == 0
    assert blocks[-1].source_offset + blocks[-1].source_frames == 24_001
    assert blocks[-1].target_offset + blocks[-1].target_frames == 24_000


def test_validation_allows_shorter_zero_padded_stems(tmp_path: Path) -> None:
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    first.touch()
    second.touch()
    plan = RenderPlan(
        stems=(
            StemInput("first", first, 2, 20_000),
            StemInput("second", second, 1, 18_000),
        ),
        anchors=(FrameAnchor(0, 0), FrameAnchor(20_000, 21_000)),
        sample_rate=48_000,
    )

    validate_render_plan(plan)


@pytest.mark.parametrize(
    "anchors",
    [
        (FrameAnchor(0, 0), FrameAnchor(10, 10), FrameAnchor(9, 20)),
        (FrameAnchor(0, 0), FrameAnchor(10, 10), FrameAnchor(20, 9)),
        (FrameAnchor(1, 0), FrameAnchor(10, 10)),
    ],
)
def test_validation_rejects_invalid_maps(tmp_path: Path, anchors: tuple[FrameAnchor, ...]) -> None:
    source = tmp_path / "source.wav"
    source.touch()
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, anchors[-1].source_frame),),
        anchors=anchors,
        sample_rate=48_000,
    )

    with pytest.raises(RenderPlanError):
        validate_render_plan(plan)


def test_renderer_inputs_preserve_spaces_without_shell_encoding(tmp_path: Path) -> None:
    source = tmp_path / "Lead Vocals.wav"
    source.touch()
    plan = RenderPlan(
        stems=(StemInput("lead", source, 2, 24_000),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_000, 25_000)),
        sample_rate=48_000,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "run")

    assert inputs.stems_tsv.read_text().splitlines()[0] == (
        "asset_id\tchannels\tframes\tsha256\tpath"
    )
    assert inputs.stems_tsv.read_text().splitlines()[1].endswith(str(source))
    binding = verify_renderer_inputs(plan, inputs)
    assert binding["plan_sha256"] == inputs.plan_sha256
    assert binding["map_sha256"] == inputs.map_sha256
    assert binding["stems"][0]["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert inputs.binding_json is not None
    assert json.loads(inputs.binding_json.read_text()) == binding
    command = signalsmith_command(
        Path("/opt/opus renderer"),
        inputs,
        (tmp_path / "render output").resolve(),
        mode="linked",
        sample_rate=48_000,
    )
    assert command[0] == "/opt/opus renderer"
    assert command[6] == str((tmp_path / "render output").resolve())
    assert command[command.index("--plan-sha256") + 1] == inputs.plan_sha256
    assert command[command.index("--stems-tsv-sha256") + 1] == inputs.stems_tsv_sha256
    assert command[command.index("--map-tsv-sha256") + 1] == inputs.map_tsv_sha256


def test_validation_rejects_path_control_separators() -> None:
    plan = plan_for(Path("/private/bad\tpath.wav"))

    with pytest.raises(RenderPlanError, match="control separators"):
        validate_render_plan(plan, require_files=False)


def test_validation_rejects_canonical_symlinks(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    alias = tmp_path / "alias.wav"
    source.touch()
    alias.symlink_to(source)
    plan = RenderPlan(
        stems=(StemInput("source", alias, 1, 24_001),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_001, 24_001)),
        sample_rate=48_000,
    )

    with pytest.raises(RenderPlanError, match="non-symlink regular file"):
        validate_render_plan(plan)


def test_validation_rejects_rate_change_inside_pinned_signalsmith_preroll(
    tmp_path: Path,
) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.touch()
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(7_199, 7_199),
            FrameAnchor(24_000, 24_000),
        ),
        sample_rate=48_000,
    )

    with pytest.raises(RenderPlanError, match=r"needs source frame 7200, ends at 7199"):
        validate_render_plan(plan)


def test_renderer_binding_rejects_same_endpoints_with_different_middle_anchors(
    tmp_path: Path,
) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"immutable canonical fixture")
    approved = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(8_000, 8_200),
            FrameAnchor(16_000, 16_100),
            FrameAnchor(24_000, 24_000),
        ),
        sample_rate=48_000,
        approval_sha256="a" * 64,
    )
    inputs = write_renderer_inputs(approved, tmp_path / "inputs")
    substituted = RenderPlan(
        stems=approved.stems,
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(7_500, 8_200),
            FrameAnchor(16_500, 16_100),
            FrameAnchor(24_000, 24_000),
        ),
        sample_rate=approved.sample_rate,
        approval_sha256=approved.approval_sha256,
    )

    with (
        mock.patch("opusloops_stem_calibration.render_plan.subprocess.run") as invoked,
        pytest.raises(RenderPlanError, match="map.tsv|RenderPlan"),
    ):
        run_signalsmith(
            Path("/private/fake-renderer"),
            substituted,
            inputs,
            (tmp_path / "output").resolve(),
            mode="linked",
        )
    invoked.assert_not_called()


def test_renderer_binding_rejects_altered_stem_before_native_invocation(
    tmp_path: Path,
) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"canonical-before")
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000, sha256=original_hash),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_000, 24_000)),
        sample_rate=48_000,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "inputs")
    source.write_bytes(b"canonical-after")

    with (
        mock.patch("opusloops_stem_calibration.render_plan.subprocess.run") as invoked,
        pytest.raises(RenderPlanError, match="source SHA-256 changed"),
    ):
        run_signalsmith(
            Path("/private/fake-renderer"),
            plan,
            inputs,
            (tmp_path / "output").resolve(),
            mode="linked",
        )
    invoked.assert_not_called()


def test_renderer_binding_rejects_modified_map_file(tmp_path: Path) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"canonical")
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(
            FrameAnchor(0, 0),
            FrameAnchor(12_000, 11_000),
            FrameAnchor(24_000, 24_000),
        ),
        sample_rate=48_000,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "inputs")
    inputs.map_tsv.write_text("source_frame\ttarget_frame\n0\t0\n10_000\t11_000\n24_000\t24_000\n")

    with pytest.raises(RenderPlanError, match="map.tsv"):
        verify_renderer_inputs(plan, inputs)


def test_run_records_verified_binding_when_native_result_matches(tmp_path: Path) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"canonical")
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_000, 25_000)),
        sample_rate=48_000,
        approval_sha256="b" * 64,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "inputs")
    native_result = {
        "engine": "signalsmith-stretch",
        "version": "1.3.2",
        "mode": "linked",
        "source_frames": 24_000,
        "target_frames": 25_000,
        "stem_count": 1,
        "plan_sha256": inputs.plan_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
    }
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=json.dumps(native_result), stderr=""
    )
    binary = tmp_path / "fake-renderer"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o700)
    with mock.patch(
        "opusloops_stem_calibration.render_plan.subprocess.run", return_value=completed
    ):
        result = run_signalsmith(
            binary,
            plan,
            inputs,
            (tmp_path / "output").resolve(),
            mode="linked",
        )

    assert result["verified_inputs"]["approval_sha256"] == "b" * 64
    assert result["verified_inputs"]["plan_sha256"] == inputs.plan_sha256
    assert result["verified_inputs"]["stem_sha256s"] == dict(inputs.stem_sha256s)
    assert result["verified_inputs"]["native_consumed"] == {
        "plan_sha256": inputs.plan_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
    }


@pytest.mark.parametrize(
    "missing_key",
    ["plan_sha256", "stems_tsv_sha256", "map_tsv_sha256", "stem_sha256s"],
)
def test_run_requires_every_native_consumed_hash_echo(tmp_path: Path, missing_key: str) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"canonical")
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_000, 25_000)),
        sample_rate=48_000,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "inputs")
    native_result = {
        "engine": "signalsmith-stretch",
        "version": "1.3.2",
        "mode": "linked",
        "source_frames": 24_000,
        "target_frames": 25_000,
        "stem_count": 1,
        "plan_sha256": inputs.plan_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
    }
    del native_result[missing_key]
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=json.dumps(native_result), stderr=""
    )
    binary = tmp_path / "fake-renderer"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o700)

    with (
        mock.patch("opusloops_stem_calibration.render_plan.subprocess.run", return_value=completed),
        pytest.raises(RuntimeError, match=rf"did not report required {missing_key}"),
    ):
        run_signalsmith(
            binary,
            plan,
            inputs,
            (tmp_path / "output").resolve(),
            mode="linked",
        )


def test_pinned_renderer_rejects_original_executable_swap(tmp_path: Path) -> None:
    binary = tmp_path / "opusloops-signalsmith-render"
    binary.write_text("#!/bin/sh\necho original\n")
    binary.chmod(0o700)

    with pin_signalsmith_renderer(binary) as renderer:
        replacement = tmp_path / "replacement"
        replacement.write_text("#!/bin/sh\necho replaced\n")
        replacement.chmod(0o700)
        replacement.replace(binary)

        with pytest.raises(RenderPlanError, match="executable identity changed"):
            renderer.verify(hash_bytes=True)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("engine", "lookalike-renderer", "identify engine"),
        ("version", "1.3.3", "identify version"),
    ],
)
def test_run_requires_exact_renderer_identity(
    tmp_path: Path, field: str, value: str, message: str
) -> None:
    source = (tmp_path / "source.wav").resolve()
    source.write_bytes(b"canonical")
    plan = RenderPlan(
        stems=(StemInput("source", source, 1, 24_000),),
        anchors=(FrameAnchor(0, 0), FrameAnchor(24_000, 25_000)),
        sample_rate=48_000,
    )
    inputs = write_renderer_inputs(plan, tmp_path / "inputs")
    native_result = {
        "engine": "signalsmith-stretch",
        "version": "1.3.2",
        "mode": "linked",
        "source_frames": 24_000,
        "target_frames": 25_000,
        "stem_count": 1,
        "plan_sha256": inputs.plan_sha256,
        "stems_tsv_sha256": inputs.stems_tsv_sha256,
        "map_tsv_sha256": inputs.map_tsv_sha256,
        "stem_sha256s": dict(inputs.stem_sha256s),
    }
    native_result[field] = value
    binary = tmp_path / "fake-renderer"
    binary.write_text("#!/bin/sh\nexit 0\n")
    binary.chmod(0o700)
    completed = subprocess.CompletedProcess(
        args=[], returncode=0, stdout=json.dumps(native_result), stderr=""
    )

    with (
        mock.patch("opusloops_stem_calibration.render_plan.subprocess.run", return_value=completed),
        pytest.raises(RuntimeError, match=message),
    ):
        run_signalsmith(
            binary,
            plan,
            inputs,
            (tmp_path / "output").resolve(),
            mode="linked",
        )
