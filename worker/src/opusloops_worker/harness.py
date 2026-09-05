"""Adapter around the hash-binding calibration CLI and its measured journal."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

from .callback import event_payload
from .errors import ContractError, HarnessError, IntegrityError
from .storage import sha256_file

BEAT_THIS_FINAL0_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
SIGNALSMITH_VERSION = "1.3.2"
MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024
UNIT_MAP = {
    "bytes": "bytes",
    "files": "files",
    "frames": "frames",
    "stem-frames": "frames",
    "checks": "artifacts",
}
EmitEvent = Callable[[Mapping[str, object]], None]


def _tool_path(configured: str, label: str) -> Path:
    resolved = shutil.which(configured) if "/" not in configured else configured
    if not resolved:
        raise HarnessError(f"{label} executable is unavailable")
    try:
        path = Path(resolved).resolve(strict=True)
        info = path.stat(follow_symlinks=False)
    except OSError as exc:
        raise HarnessError(f"{label} executable is unavailable") from exc
    if not stat.S_ISREG(info.st_mode) or not os.access(path, os.X_OK):
        raise HarnessError(f"{label} executable is invalid")
    return path


def _atomic_json(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        encoded = (
            json.dumps(dict(value), sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
        )
        view = memoryview(encoded)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise HarnessError("could not persist stage input")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class HarnessRunner:
    def __init__(
        self,
        *,
        run_dir: Path,
        work_dir: Path,
        emit: EmitEvent,
        cli: str = "opus-stem-cal",
        ffmpeg: str = "ffmpeg",
        ffprobe: str = "ffprobe",
        checkpoint: str = "/opt/opusloops/models/torch/hub/checkpoints/beat_this-final0.ckpt",
        renderer: str = "/opt/opusloops/bin/opusloops-signalsmith-render",
        timeout_seconds: float = 1680,
    ) -> None:
        if timeout_seconds <= 0 or timeout_seconds > 1740:
            raise ContractError("harness timeout must fit inside the 30-minute Batch timeout")
        self.run_dir = run_dir.resolve()
        self.work_dir = work_dir.resolve()
        self.emit = emit
        self.cli = _tool_path(cli, "calibration CLI")
        self.ffmpeg = _tool_path(ffmpeg, "FFmpeg")
        self.ffprobe = _tool_path(ffprobe, "ffprobe")
        self.checkpoint = Path(checkpoint).resolve(strict=True)
        self.renderer = Path(renderer).resolve(strict=True)
        checkpoint_sha, _ = sha256_file(self.checkpoint)
        if checkpoint_sha != BEAT_THIS_FINAL0_SHA256:
            raise IntegrityError("Beat This final0 checkpoint hash is not pinned")
        self.timeout_seconds = timeout_seconds
        self._seen_event_ids: set[str] = set()
        self._prime_existing_events()

    def _prime_existing_events(self) -> None:
        events = self.run_dir / "events.jsonl"
        if not events.is_file():
            return
        for event in self._read_journal(events):
            event_id = event.get("event_id")
            if isinstance(event_id, str):
                self._seen_event_ids.add(event_id)

    @staticmethod
    def _read_journal(path: Path) -> list[Mapping[str, object]]:
        try:
            if path.stat().st_size > 64 * 1024 * 1024:
                raise IntegrityError("harness event journal is unexpectedly large")
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            raise HarnessError("could not read harness progress journal") from exc
        events: list[Mapping[str, object]] = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                # A concurrently appended final line is retried at the next poll.
                continue
            if isinstance(value, Mapping):
                events.append(value)
        return events

    def _drain_events(self) -> None:
        journal = self.run_dir / "events.jsonl"
        if not journal.is_file():
            return
        for event in self._read_journal(journal):
            event_id = event.get("event_id")
            if not isinstance(event_id, str) or event_id in self._seen_event_ids:
                continue
            operation = event.get("stage")
            status = event.get("status")
            if not isinstance(operation, str) or not operation:
                raise IntegrityError("harness event has no operation")
            self._seen_event_ids.add(event_id)
            if status == "failed":
                continue
            progress = event.get("progress")
            callback_event: Mapping[str, object]
            if isinstance(progress, Mapping) and progress.get("unit") in UNIT_MAP:
                completed = progress.get("completed")
                total = progress.get("total")
                if type(completed) is not int or type(total) is not int:
                    raise IntegrityError("harness progress counters are invalid")
                callback_event = event_payload(
                    status="progress",
                    operation=operation,
                    determinate=True,
                    completed=completed,
                    total=total,
                    unit=UNIT_MAP[str(progress["unit"])],
                    detail={"source": f"harness-{status}"},
                )
            else:
                callback_event = event_payload(
                    status="progress",
                    operation=operation,
                    determinate=False,
                    detail={"source": f"harness-{status}"},
                )
            self.emit(callback_event)

    def _environment(self) -> dict[str, str]:
        home = self.work_dir / "home"
        temporary = self.work_dir / "tmp"
        numba_cache = self.work_dir / "numba-cache"
        for directory in (home, temporary, numba_cache):
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if os.name == "posix":
                os.chmod(directory, 0o700)
        return {
            "HOME": str(home),
            "TMPDIR": str(temporary),
            "TORCH_HOME": "/opt/opusloops/models/torch",
            "NUMBA_CACHE_DIR": str(numba_cache),
            "PATH": "/opt/opusloops/bin:/usr/local/bin:/usr/bin:/bin",
            "PYTHONUNBUFFERED": "1",
            "OMP_NUM_THREADS": "4",
            "OPENBLAS_NUM_THREADS": "4",
            "MKL_NUM_THREADS": "4",
            "NUMBA_NUM_THREADS": "4",
        }

    def _command(self, arguments: Sequence[str]) -> Mapping[str, object]:
        stdout_path = self.work_dir / f"command-{time.monotonic_ns()}-stdout.json"
        stderr_path = self.work_dir / f"command-{time.monotonic_ns()}-stderr.log"
        started = time.monotonic()
        with stdout_path.open("xb") as stdout_handle, stderr_path.open("xb") as stderr_handle:
            if os.name == "posix":
                os.chmod(stdout_path, 0o600)
                os.chmod(stderr_path, 0o600)
            try:
                process = subprocess.Popen(
                    [str(self.cli), *arguments],
                    cwd=self.work_dir,
                    env=self._environment(),
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_handle,
                    stderr=stderr_handle,
                    close_fds=True,
                )
            except OSError as exc:
                raise HarnessError("calibration process could not start", retryable=True) from exc
            while process.poll() is None:
                if time.monotonic() - started > self.timeout_seconds:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)
                    self._drain_events()
                    raise HarnessError(
                        "calibration stage exceeded its worker timeout", retryable=True
                    )
                self._drain_events()
                time.sleep(0.25)
            self._drain_events()
        if stdout_path.stat().st_size > MAX_COMMAND_OUTPUT_BYTES:
            raise HarnessError("calibration command output exceeded its bound")
        try:
            output = json.loads(stdout_path.read_bytes())
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HarnessError("calibration command returned invalid JSON") from exc
        if process.returncode != 0:
            raise HarnessError("calibration harness rejected the requested stage")
        if not isinstance(output, Mapping):
            raise HarnessError("calibration command result is invalid")
        return output

    def inspect(self, archive: Path) -> Mapping[str, object]:
        if self.run_dir.exists():
            raise IntegrityError("inspect requires a new run directory")
        return self._command(
            [
                "inspect",
                "--zip",
                str(archive),
                "--run",
                str(self.run_dir),
                "--ffmpeg",
                str(self.ffmpeg),
                "--ffprobe",
                str(self.ffprobe),
            ]
        )

    def approve_and_analyze(
        self, selection: Mapping[str, object], *, approved_by: str
    ) -> Mapping[str, object]:
        selection_path = self.work_dir / "analysis-selection.user.json"
        _atomic_json(selection_path, selection)
        self._command(
            [
                "approve-analysis",
                "--run",
                str(self.run_dir),
                "--selection",
                str(selection_path),
                "--approved-by",
                approved_by,
                "--confirm-files",
                "--confirm-roles",
                "--confirm-reference",
                "--confirm-originals-unchanged",
            ]
        )
        return self._command(
            [
                "analyze",
                "--run",
                str(self.run_dir),
                "--checkpoint",
                str(self.checkpoint),
                "--checkpoint-sha256",
                BEAT_THIS_FINAL0_SHA256,
                "--device",
                "cpu",
                "--librosa",
            ]
        )

    def propose(
        self,
        *,
        proposal_id: str,
        mode: str,
        target_bpm: float | None,
        reviewed_grid: Mapping[str, object] | None = None,
        meter_numerator: int | None = None,
        meter_denominator: int | None = None,
        first_downbeat: float | None = None,
    ) -> Mapping[str, object]:
        arguments = [
            "propose-map",
            "--run",
            str(self.run_dir),
            "--proposal-id",
            proposal_id,
            "--mode",
            mode,
        ]
        if target_bpm is not None:
            arguments.extend(["--target-bpm", f"{target_bpm:.9g}"])
        if reviewed_grid is not None:
            grid_path = self.work_dir / "tempo-grid.user.json"
            _atomic_json(grid_path, reviewed_grid)
            arguments.extend(["--grid", str(grid_path)])
        if meter_numerator is not None:
            arguments.extend(["--meter-numerator", str(meter_numerator)])
        if meter_denominator is not None:
            arguments.extend(["--meter-denominator", str(meter_denominator)])
        if first_downbeat is not None:
            arguments.extend(["--first-downbeat", f"{first_downbeat:.9f}"])
        return self._command(arguments)

    def approve_and_render(
        self, approval: Mapping[str, object], *, approved_by: str
    ) -> Mapping[str, object]:
        approval_path = self.work_dir / "tempo-approval.user.json"
        _atomic_json(approval_path, approval)
        self._command(
            [
                "approve-map",
                "--run",
                str(self.run_dir),
                "--approval",
                str(approval_path),
                "--approved-by",
                approved_by,
                "--confirm-click",
                "--confirm-beat-grid",
                "--confirm-meter-downbeat",
                "--confirm-tempo-octave",
                "--confirm-flags",
                "--confirm-target",
                "--confirm-shared-map",
                "--confirm-originals-unchanged",
            ]
        )
        return self._command(
            [
                "render-bakeoff",
                "--run",
                str(self.run_dir),
                "--binary",
                str(self.renderer),
            ]
        )

    def verify(self) -> Mapping[str, object]:
        return self._command(["verify-run", "--run", str(self.run_dir)])
