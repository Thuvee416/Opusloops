"""Fail-closed Linux process controls protecting worker credentials from decoders."""

from __future__ import annotations

import ctypes
import resource
import sys
from collections.abc import Callable

from .errors import WorkerError

PR_GET_DUMPABLE = 3
PR_SET_DUMPABLE = 4
PR_SET_NO_NEW_PRIVS = 38
PR_GET_NO_NEW_PRIVS = 39


class IsolationError(WorkerError):
    """The container could not establish its required process boundary."""

    def __init__(self) -> None:
        super().__init__(
            "process_isolation_failed",
            "Worker process isolation could not be established",
            retryable=False,
        )


def _apply_linux_controls(prctl: Callable[..., int]) -> None:
    if prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise IsolationError
    if prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise IsolationError
    if prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise IsolationError
    if prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1:
        raise IsolationError


def harden_process() -> None:
    """Block same-UID descendants from ptrace-gated parent proc files on Linux."""

    if sys.platform != "linux":
        return
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        libc = ctypes.CDLL(None, use_errno=True)
        _apply_linux_controls(libc.prctl)
    except IsolationError:
        raise
    except (OSError, ValueError, AttributeError):
        raise IsolationError from None
