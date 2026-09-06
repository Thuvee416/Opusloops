"""Worker error types with intentionally bounded public messages."""

from __future__ import annotations


class WorkerError(RuntimeError):
    """An expected, safely reportable worker failure."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.public_message = message
        self.retryable = retryable


class ContractError(WorkerError):
    """A fail-closed job payload or callback contract violation."""

    def __init__(self, message: str) -> None:
        super().__init__("invalid_job_contract", message, retryable=False)


class IntegrityError(WorkerError):
    """An immutable object or artifact did not match its binding."""

    def __init__(self, message: str) -> None:
        super().__init__("integrity_check_failed", message, retryable=False)


class StorageError(WorkerError):
    """A bounded storage operation failed."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__("storage_operation_failed", message, retryable=retryable)


class HarnessError(WorkerError):
    """The pinned calibration harness rejected or failed a stage."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__("calibration_stage_failed", message, retryable=retryable)


class TempoMapCompatibilityError(WorkerError):
    """An approved tempo map cannot be consumed safely by the pinned renderer."""

    def __init__(self) -> None:
        super().__init__(
            "tempo_map_preroll_invalid",
            "The approved tempo map needs a renderer-safe proposal before rendering",
            retryable=False,
        )
