from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from opusloops_worker.errors import HarnessError, TempoMapCompatibilityError
from opusloops_worker.harness import MAX_COMMAND_ERROR_BYTES, HarnessRunner


class _CompletedProcess:
    def __init__(self, returncode: int) -> None:
        self.returncode = returncode

    def poll(self) -> int:
        return self.returncode


def _runner(tmp_path: Path) -> HarnessRunner:
    runner = HarnessRunner.__new__(HarnessRunner)
    runner.run_dir = tmp_path / "run"
    runner.run_dir.mkdir()
    runner.work_dir = tmp_path / "work"
    runner.work_dir.mkdir()
    runner.emit = lambda _event: None
    runner.cli = Path("/unused/calibration-cli")
    runner.timeout_seconds = 5
    runner._seen_event_ids = set()
    return runner


def _complete_with(
    monkeypatch: pytest.MonkeyPatch,
    *,
    stdout_value: bytes,
    stderr_value: bytes,
    returncode: int,
) -> None:
    def popen(_arguments, **kwargs):
        kwargs["stdout"].write(stdout_value)
        kwargs["stderr"].write(stderr_value)
        return _CompletedProcess(returncode)

    monkeypatch.setattr(subprocess, "Popen", popen)


def test_nonzero_signalsmith_preroll_failure_has_safe_structured_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete_with(
        monkeypatch,
        stdout_value=b"",
        stderr_value=(
            b"opus-stem-cal: tempo approval cannot be rendered: first map region is shorter "
            b"than the Signalsmith pre-roll (needs source frame 7205, ends at 960)\n"
        ),
        returncode=2,
    )

    with pytest.raises(TempoMapCompatibilityError) as captured:
        _runner(tmp_path)._command(["render"])

    assert captured.value.code == "tempo_map_preroll_invalid"
    assert captured.value.public_message == (
        "The approved tempo map needs a renderer-safe proposal before rendering"
    )
    assert captured.value.retryable is False
    assert "7205" not in captured.value.public_message


def test_nonzero_generic_failure_precedes_stdout_parsing_and_hides_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_error = b"private object key and subprocess details"
    _complete_with(
        monkeypatch,
        stdout_value=b"not-json",
        stderr_value=private_error,
        returncode=2,
    )

    with pytest.raises(HarnessError) as captured:
        _runner(tmp_path)._command(["render"])

    assert captured.value.code == "calibration_stage_failed"
    assert captured.value.public_message == "calibration harness rejected the requested stage"
    assert private_error.decode() not in captured.value.public_message


def test_oversized_stderr_is_not_classified_from_unbounded_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete_with(
        monkeypatch,
        stdout_value=b"",
        stderr_value=(
            b"x" * (MAX_COMMAND_ERROR_BYTES + 1)
            + b"first map region is shorter than the Signalsmith pre-roll"
        ),
        returncode=2,
    )

    with pytest.raises(HarnessError) as captured:
        _runner(tmp_path)._command(["render"])

    assert type(captured.value) is HarnessError
    assert captured.value.public_message == "calibration harness rejected the requested stage"


def test_successful_exit_with_invalid_json_preserves_invalid_json_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete_with(
        monkeypatch,
        stdout_value=b"not-json",
        stderr_value=b"",
        returncode=0,
    )

    with pytest.raises(HarnessError, match="calibration command returned invalid JSON"):
        _runner(tmp_path)._command(["render"])


def test_successful_command_returns_json_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _complete_with(
        monkeypatch,
        stdout_value=b'{"status":"completed","frames":12000}\n',
        stderr_value=b"",
        returncode=0,
    )

    assert _runner(tmp_path)._command(["render"]) == {
        "status": "completed",
        "frames": 12000,
    }
