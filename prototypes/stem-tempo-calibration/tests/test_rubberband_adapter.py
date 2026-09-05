from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from opusloops_stem_calibration import rubberband_adapter
from opusloops_stem_calibration.rubberband_adapter import (
    RUBBERBAND_BINARY_ENV,
    RubberBandExecutionError,
    RubberBandInstallation,
    RubberBandUnavailableError,
    build_rubberband_command,
    discover_rubberband,
    render_with_rubberband,
)


def _executable(path: Path) -> Path:
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(0o755)
    return path


def test_discovery_prefers_explicit_executable(tmp_path):
    executable = _executable(tmp_path / "rubber band")

    result = discover_rubberband(
        executable,
        environ={RUBBERBAND_BINARY_ENV: "/ignored", "PATH": ""},
    )

    assert result == RubberBandInstallation(executable=executable.resolve(), source="explicit")


def test_discovery_uses_configured_environment_path(tmp_path):
    executable = _executable(tmp_path / "rubberband-r3")

    result = discover_rubberband(environ={RUBBERBAND_BINARY_ENV: str(executable), "PATH": ""})

    assert result.executable == executable.resolve()
    assert result.source == "environment"


def test_path_discovery_is_opt_in(tmp_path):
    executable = _executable(tmp_path / "rubberband-r3")
    environment = {"PATH": str(tmp_path)}

    with pytest.raises(RubberBandUnavailableError):
        discover_rubberband(environ=environment)

    result = discover_rubberband(environ=environment, search_path=True)
    assert result.executable == executable.resolve()
    assert result.source == "PATH"


def test_missing_cli_fails_with_configuration_and_licensing_guidance():
    with pytest.raises(RubberBandUnavailableError) as raised:
        discover_rubberband(environ={"PATH": ""}, search_path=True)

    message = str(raised.value)
    assert RUBBERBAND_BINARY_ENV in message
    assert "not bundled" in message
    assert "GPL-2.0-or-later" in message
    assert "commercial licence" in message


def test_build_command_is_an_argument_tuple_and_has_required_duration(tmp_path):
    installation = RubberBandInstallation(
        executable=_executable(tmp_path / "rubberband"), source="explicit"
    )

    command = build_rubberband_command(
        installation,
        input_wav=tmp_path / "input with spaces.wav",
        output_wav=tmp_path / "output;still-one-argument.wav",
        time_map_path=tmp_path / "map.txt",
        sample_rate=48_000,
        target_frames=96_000,
    )

    assert isinstance(command, tuple)
    assert command[0] == str(installation.executable)
    assert command[command.index("--duration") + 1] == "2"
    assert "--timemap" in command
    assert "--fine" in command
    assert "--centre-focus" in command
    assert command[-2] == str(tmp_path / "input with spaces.wav")
    assert command[-1] == str(tmp_path / "output;still-one-argument.wav")


def test_render_uses_shell_false_and_writes_exact_frame_map(tmp_path, monkeypatch):
    executable = _executable(tmp_path / "rubberband")
    source = tmp_path / "input with spaces.wav"
    source.write_bytes(b"input-wav")
    destination = tmp_path / "render;no-shell.wav"
    marker = tmp_path / "no-shell.wav"
    captured = {}

    def fake_run(arguments, **kwargs):
        captured["arguments"] = arguments
        captured["kwargs"] = kwargs
        time_map_path = Path(arguments[arguments.index("--timemap") + 1])
        captured["time_map"] = time_map_path.read_text(encoding="ascii")
        Path(arguments[-1]).write_bytes(b"rendered-wav")
        return subprocess.CompletedProcess(arguments, 0, "stdout", "stderr")

    monkeypatch.setattr(rubberband_adapter.subprocess, "run", fake_run)

    result = render_with_rubberband(
        source,
        destination,
        anchors=[(0, 0), (48_000, 47_000), (96_000, 94_000)],
        sample_rate=48_000,
        executable=executable,
    )

    assert isinstance(captured["arguments"], list)
    assert captured["kwargs"]["shell"] is False
    assert captured["kwargs"]["check"] is False
    assert captured["time_map"] == "0 0\n48000 47000\n96000 94000\n"
    assert destination.read_bytes() == b"rendered-wav"
    assert marker.exists() is False
    assert result.output_path == destination
    assert result.requested_target_frames == 94_000
    assert result.anchor_count == 3
    assert result.command[-2] == str(source)


def test_failed_render_does_not_replace_existing_output(tmp_path, monkeypatch):
    executable = _executable(tmp_path / "rubberband")
    source = tmp_path / "input.wav"
    destination = tmp_path / "output.wav"
    source.write_bytes(b"input")
    destination.write_bytes(b"existing")

    def fake_run(arguments, **kwargs):
        return subprocess.CompletedProcess(arguments, 7, "", "bad map")

    monkeypatch.setattr(rubberband_adapter.subprocess, "run", fake_run)

    with pytest.raises(RubberBandExecutionError, match="status 7: bad map"):
        render_with_rubberband(
            source,
            destination,
            anchors=[(0, 0), (48_000, 48_000)],
            sample_rate=48_000,
            executable=executable,
            overwrite=True,
        )

    assert destination.read_bytes() == b"existing"


def test_successful_render_does_not_clobber_a_racing_writer(tmp_path, monkeypatch):
    executable = _executable(tmp_path / "rubberband")
    source = tmp_path / "input.wav"
    destination = tmp_path / "output.wav"
    source.write_bytes(b"input")

    def fake_run(arguments, **kwargs):
        Path(arguments[-1]).write_bytes(b"rendered")
        destination.write_bytes(b"racing-writer")
        return subprocess.CompletedProcess(arguments, 0, "", "")

    monkeypatch.setattr(rubberband_adapter.subprocess, "run", fake_run)

    with pytest.raises(FileExistsError, match="appeared while rendering"):
        render_with_rubberband(
            source,
            destination,
            anchors=[(0, 0), (48_000, 48_000)],
            sample_rate=48_000,
            executable=executable,
        )

    assert destination.read_bytes() == b"racing-writer"


@pytest.mark.parametrize(
    ("anchors", "message"),
    [
        ([(1, 0), (2, 1)], "first anchor"),
        ([(0, 0), (2, 2), (1, 3)], "strictly increasing"),
        ([(0, 0), (2, 2), (3, 1)], "strictly increasing"),
        ([(0, 0)], "at least"),
    ],
)
def test_render_rejects_unsafe_time_maps_before_execution(tmp_path, monkeypatch, anchors, message):
    source = tmp_path / "input.wav"
    source.write_bytes(b"input")

    def unexpected_run(*args, **kwargs):
        raise AssertionError("subprocess must not run for an invalid map")

    monkeypatch.setattr(rubberband_adapter.subprocess, "run", unexpected_run)

    with pytest.raises(ValueError, match=message):
        render_with_rubberband(
            source,
            tmp_path / "output.wav",
            anchors=anchors,
            sample_rate=48_000,
            executable=tmp_path / "missing-rubberband",
        )


def test_target_frames_must_match_final_anchor(tmp_path):
    source = tmp_path / "input.wav"
    source.write_bytes(b"input")

    with pytest.raises(ValueError, match="final anchor"):
        render_with_rubberband(
            source,
            tmp_path / "output.wav",
            anchors=[(0, 0), (48_000, 47_000)],
            sample_rate=48_000,
            target_frames=48_000,
            executable=tmp_path / "missing-rubberband",
        )
