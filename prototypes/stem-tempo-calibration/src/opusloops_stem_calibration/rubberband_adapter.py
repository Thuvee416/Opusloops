"""Opt-in adapter for a separately installed Rubber Band command-line tool.

Rubber Band is GPL-2.0-or-later or commercially licensed.  This calibration
harness therefore never downloads, builds, or vendors it.  A caller must pass
an executable, configure ``OPUSLOOPS_RUBBERBAND_BIN``, or explicitly allow PATH
discovery.  Every subprocess invocation uses an argument sequence with
``shell=False``.
"""

from __future__ import annotations

import math
import os
import shutil
import subprocess
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

PathLike = str | os.PathLike[str]
FrameAnchorPair = tuple[int, int]

RUBBERBAND_BINARY_ENV = "OPUSLOOPS_RUBBERBAND_BIN"
RUBBERBAND_LICENSE_NOTICE = (
    "Rubber Band is not bundled with Opusloops. Install it separately only after "
    "accepting its GPL-2.0-or-later terms or obtaining a commercial licence."
)


class RubberBandUnavailableError(RuntimeError):
    """Raised when no separately installed Rubber Band CLI can be resolved."""


class RubberBandExecutionError(RuntimeError):
    """Raised when the configured Rubber Band CLI cannot produce a render."""


@dataclass(frozen=True, slots=True)
class RubberBandInstallation:
    """Resolved executable and the configuration source that selected it."""

    executable: Path
    source: str


@dataclass(frozen=True, slots=True)
class RubberBandRenderResult:
    """Successful render metadata; objective audio checks live in ``metrics``."""

    output_path: Path
    requested_target_frames: int
    sample_rate: int
    anchor_count: int
    installation: RubberBandInstallation
    command: tuple[str, ...]
    stdout: str
    stderr: str


def _unavailable(message: str) -> RubberBandUnavailableError:
    return RubberBandUnavailableError(
        f"{message} {RUBBERBAND_LICENSE_NOTICE} "
        f"Pass executable=..., set {RUBBERBAND_BINARY_ENV}, or enable PATH discovery."
    )


def _resolve_candidate(candidate: str, *, search_path: str | None) -> Path | None:
    expanded = Path(candidate).expanduser()
    is_path = expanded.is_absolute() or any(
        separator and separator in candidate for separator in (os.sep, os.altsep)
    )
    if is_path:
        resolved = expanded.resolve()
        if resolved.is_file() and os.access(resolved, os.X_OK):
            return resolved
        return None

    discovered = shutil.which(candidate, path=search_path)
    if discovered is None:
        return None
    resolved = Path(discovered).resolve()
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        return None
    return resolved


def discover_rubberband(
    executable: PathLike | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    search_path: bool = False,
) -> RubberBandInstallation:
    """Resolve an existing Rubber Band CLI without installing or downloading it.

    Resolution order is an explicit ``executable`` argument, the
    ``OPUSLOOPS_RUBBERBAND_BIN`` environment variable, and—only when requested—
    ``rubberband-r3``/``rubberband`` on PATH.  A broken explicit configuration
    fails immediately instead of silently selecting a different binary.
    """

    environment = os.environ if environ is None else environ
    path_value = environment.get("PATH") if environ is None else environment.get("PATH", "")

    if executable is not None:
        candidate = os.fspath(executable)
        resolved = _resolve_candidate(candidate, search_path=path_value)
        if resolved is None:
            raise _unavailable(f"Configured Rubber Band executable was not found: {candidate!r}.")
        return RubberBandInstallation(executable=resolved, source="explicit")

    configured = environment.get(RUBBERBAND_BINARY_ENV)
    if configured:
        resolved = _resolve_candidate(configured, search_path=path_value)
        if resolved is None:
            raise _unavailable(
                f"{RUBBERBAND_BINARY_ENV} points to an unavailable executable: {configured!r}."
            )
        return RubberBandInstallation(executable=resolved, source="environment")

    if search_path:
        for command_name in ("rubberband-r3", "rubberband"):
            resolved = _resolve_candidate(command_name, search_path=path_value)
            if resolved is not None:
                return RubberBandInstallation(executable=resolved, source="PATH")

    raise _unavailable("No Rubber Band executable was configured or discovered.")


def _validate_positive_int(value: int, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _validate_anchors(anchors: Sequence[FrameAnchorPair]) -> tuple[FrameAnchorPair, ...]:
    if len(anchors) < 2:
        raise ValueError("anchors must contain at least the first and final frame mappings")

    normalized: list[FrameAnchorPair] = []
    previous_source = -1
    previous_target = -1
    for index, anchor in enumerate(anchors):
        if len(anchor) != 2:
            raise ValueError(f"anchor {index} must contain source and target frame integers")
        source_frame, target_frame = anchor
        if (
            isinstance(source_frame, bool)
            or isinstance(target_frame, bool)
            or not isinstance(source_frame, int)
            or not isinstance(target_frame, int)
        ):
            raise ValueError(f"anchor {index} must contain source and target frame integers")
        if source_frame < 0 or target_frame < 0:
            raise ValueError(f"anchor {index} frame numbers must be non-negative")
        if source_frame <= previous_source or target_frame <= previous_target:
            raise ValueError("anchor source and target frames must both be strictly increasing")
        normalized.append((source_frame, target_frame))
        previous_source = source_frame
        previous_target = target_frame

    if normalized[0] != (0, 0):
        raise ValueError("the first anchor must map source frame 0 to target frame 0")
    return tuple(normalized)


def build_rubberband_command(
    installation: RubberBandInstallation,
    *,
    input_wav: PathLike,
    output_wav: PathLike,
    time_map_path: PathLike,
    sample_rate: int,
    target_frames: int,
    engine: str = "r3",
    channels_together: bool = True,
) -> tuple[str, ...]:
    """Build, but do not execute, the Rubber Band CLI argument vector."""

    sample_rate = _validate_positive_int(sample_rate, name="sample_rate")
    target_frames = _validate_positive_int(target_frames, name="target_frames")
    if engine not in {"r2", "r3"}:
        raise ValueError("engine must be 'r2' or 'r3'")

    duration_seconds = target_frames / sample_rate
    arguments = [
        str(installation.executable),
        "--quiet",
        "--fine" if engine == "r3" else "--fast",
    ]
    if channels_together:
        arguments.append("--centre-focus")
    arguments.extend(
        [
            "--duration",
            format(duration_seconds, ".17g"),
            "--timemap",
            os.fspath(time_map_path),
            os.fspath(input_wav),
            os.fspath(output_wav),
        ]
    )
    return tuple(arguments)


def render_with_rubberband(
    input_wav: PathLike,
    output_wav: PathLike,
    *,
    anchors: Sequence[FrameAnchorPair],
    sample_rate: int,
    target_frames: int | None = None,
    executable: PathLike | RubberBandInstallation | None = None,
    search_path: bool = False,
    engine: str = "r3",
    channels_together: bool = True,
    overwrite: bool = False,
    timeout_seconds: float | None = None,
    environ: Mapping[str, str] | None = None,
) -> RubberBandRenderResult:
    """Render one WAV using a frame-keyed Rubber Band time map.

    The output is written to a temporary WAV in the destination directory and
    atomically moved into place only after a successful zero-exit render.  This
    adapter intentionally does not claim the requested frame count was met;
    callers must verify the resulting WAV with :func:`metrics.inspect_wav` and
    residual/boundary metrics.
    """

    normalized_anchors = _validate_anchors(anchors)
    sample_rate = _validate_positive_int(sample_rate, name="sample_rate")
    expected_target_frames = normalized_anchors[-1][1]
    if target_frames is None:
        target_frames = expected_target_frames
    target_frames = _validate_positive_int(target_frames, name="target_frames")
    if target_frames != expected_target_frames:
        raise ValueError(
            "target_frames must equal the target frame of the final anchor "
            f"({expected_target_frames})"
        )
    if timeout_seconds is not None and (
        not math.isfinite(timeout_seconds) or timeout_seconds <= 0.0
    ):
        raise ValueError("timeout_seconds must be finite and greater than zero")

    source_path = Path(input_wav)
    destination_path = Path(output_wav)
    if not source_path.is_file():
        raise FileNotFoundError(f"Input WAV does not exist: {source_path}")
    if source_path.resolve() == destination_path.resolve():
        raise ValueError("input_wav and output_wav must be different files")
    if source_path.suffix.lower() != ".wav" or destination_path.suffix.lower() != ".wav":
        raise ValueError("Rubber Band calibration input and output must use .wav files")
    if not destination_path.parent.is_dir():
        raise FileNotFoundError(f"Output directory does not exist: {destination_path.parent}")
    if destination_path.exists() and not overwrite:
        raise FileExistsError(
            f"Output WAV already exists; pass overwrite=True to replace it: {destination_path}"
        )

    if isinstance(executable, RubberBandInstallation):
        installation = executable
    else:
        installation = discover_rubberband(
            executable,
            environ=environ,
            search_path=search_path,
        )

    completed: subprocess.CompletedProcess[str]
    command: tuple[str, ...]
    try:
        with tempfile.TemporaryDirectory(
            prefix=".opusloops-rubberband-", dir=destination_path.parent
        ) as temporary_directory:
            temporary_root = Path(temporary_directory)
            time_map_path = temporary_root / "timemap.txt"
            temporary_output = temporary_root / "render.wav"
            time_map_path.write_text(
                "".join(f"{source} {target}\n" for source, target in normalized_anchors),
                encoding="ascii",
            )

            command = build_rubberband_command(
                installation,
                input_wav=source_path,
                output_wav=temporary_output,
                time_map_path=time_map_path,
                sample_rate=sample_rate,
                target_frames=target_frames,
                engine=engine,
                channels_together=channels_together,
            )
            completed = subprocess.run(
                list(command),
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                shell=False,
            )
            if completed.returncode != 0:
                detail = completed.stderr.strip() or completed.stdout.strip() or "no output"
                raise RubberBandExecutionError(
                    f"Rubber Band exited with status {completed.returncode}: {detail}"
                )
            if not temporary_output.is_file() or temporary_output.stat().st_size == 0:
                raise RubberBandExecutionError(
                    "Rubber Band reported success but did not create a non-empty output WAV"
                )

            if overwrite:
                os.replace(temporary_output, destination_path)
            else:
                # The temporary file lives beside the destination, so a hard
                # link gives us atomic no-clobber publication on one filesystem.
                # A second writer that wins the race causes FileExistsError;
                # unlike os.replace(), it cannot be overwritten accidentally.
                try:
                    os.link(temporary_output, destination_path)
                except FileExistsError as exc:
                    raise FileExistsError(
                        f"Output WAV appeared while rendering and was not replaced: "
                        f"{destination_path}"
                    ) from exc
                temporary_output.unlink()
    except subprocess.TimeoutExpired as exc:
        raise RubberBandExecutionError(
            f"Rubber Band exceeded the {timeout_seconds:g}-second timeout"
        ) from exc
    except FileExistsError:
        raise
    except OSError as exc:
        raise RubberBandExecutionError(f"Unable to execute Rubber Band: {exc}") from exc

    return RubberBandRenderResult(
        output_path=destination_path,
        requested_target_frames=target_frames,
        sample_rate=sample_rate,
        anchor_count=len(normalized_anchors),
        installation=installation,
        command=command,
        stdout=completed.stdout,
        stderr=completed.stderr,
    )
