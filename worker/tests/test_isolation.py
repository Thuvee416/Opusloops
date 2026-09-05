from __future__ import annotations

import pytest

from opusloops_worker.isolation import (
    PR_GET_DUMPABLE,
    PR_GET_NO_NEW_PRIVS,
    PR_SET_DUMPABLE,
    PR_SET_NO_NEW_PRIVS,
    IsolationError,
    _apply_linux_controls,
)


def test_linux_controls_disable_dumpability_and_privilege_escalation() -> None:
    calls: list[tuple[int, int, int, int, int]] = []

    def prctl(option: int, *args: int) -> int:
        calls.append((option, *args))
        if option == PR_GET_NO_NEW_PRIVS:
            return 1
        return 0

    _apply_linux_controls(prctl)

    assert calls == [
        (PR_SET_DUMPABLE, 0, 0, 0, 0),
        (PR_GET_DUMPABLE, 0, 0, 0, 0),
        (PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0),
        (PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0),
    ]


@pytest.mark.parametrize(
    ("failed_option", "return_value"),
    [
        (PR_SET_DUMPABLE, -1),
        (PR_GET_DUMPABLE, 1),
        (PR_SET_NO_NEW_PRIVS, -1),
        (PR_GET_NO_NEW_PRIVS, 0),
    ],
)
def test_linux_controls_fail_closed(failed_option: int, return_value: int) -> None:
    def prctl(option: int, *_args: int) -> int:
        if option == failed_option:
            return return_value
        if option == PR_GET_NO_NEW_PRIVS:
            return 1
        return 0

    with pytest.raises(IsolationError):
        _apply_linux_controls(prctl)
