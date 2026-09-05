"""Repository guards which keep private calibration audio out of build contexts."""

from __future__ import annotations

import subprocess
from pathlib import Path, PurePosixPath

PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PRIVATE_MEDIA_SUFFIXES = {
    ".aif",
    ".aiff",
    ".flac",
    ".m4a",
    ".mp3",
    ".ogg",
    ".wav",
    ".zip",
}


def test_private_calibration_paths_are_excluded_from_root_docker_context() -> None:
    patterns = {
        line.strip()
        for line in (REPOSITORY_ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }

    assert {
        "**/.build/",
        "**/.local/",
        "**/.venv/",
        "**/tests/fixtures/audio/",
    } <= patterns
    for suffix in PRIVATE_MEDIA_SUFFIXES:
        assert f"prototypes/stem-tempo-calibration/**/*{suffix}" in patterns


def test_no_private_calibration_media_is_tracked() -> None:
    completed = subprocess.run(
        ["git", "ls-files", "-z", "--", "prototypes/stem-tempo-calibration"],
        cwd=REPOSITORY_ROOT,
        check=True,
        capture_output=True,
    )
    tracked = [
        PurePosixPath(value.decode("utf-8")) for value in completed.stdout.split(b"\0") if value
    ]

    forbidden = [
        path
        for path in tracked
        if path.suffix.casefold() in PRIVATE_MEDIA_SUFFIXES
        or ".local" in path.parts
        or ".venv" in path.parts
        or ".build" in path.parts
        or "tests/fixtures/audio" in path.as_posix()
    ]
    assert forbidden == []
