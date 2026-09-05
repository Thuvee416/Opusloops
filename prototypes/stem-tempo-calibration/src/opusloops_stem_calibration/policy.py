"""Versioned, fail-closed resource policy for calibration imports.

The values in :data:`DEFAULT_POLICY` are calibration-harness ceilings, not
production product promises.  Callers may construct a policy with explicit
overrides, and the resulting complete policy is serializable into provenance.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, replace
from typing import Any

POLICY_VERSION = "policy.v1"
GIB = 1024**3
MIB = 1024**2


@dataclass(frozen=True, slots=True)
class IngestPolicy:
    """All limits which can affect archive acceptance or canonical decoding."""

    version: str = POLICY_VERSION
    max_archive_bytes: int = 2 * GIB
    max_total_entries: int = 64
    max_audio_entries: int = 16
    max_entry_compressed_bytes: int = 2 * GIB
    max_entry_uncompressed_bytes: int = 2 * GIB
    max_aggregate_compressed_bytes: int = 2 * GIB
    max_aggregate_uncompressed_bytes: int = 16 * GIB
    max_compression_ratio: float = 200.0
    scratch_space_multiplier: float = 2.0
    max_audio_duration_seconds: float = 10 * 60.0
    max_channels_per_stem: int = 2
    max_decoded_channels: int = 64
    max_audio_streams_per_file: int = 1
    canonical_sample_rate: int = 48_000
    canonical_sample_width_bytes: int = 4
    silence_epsilon: float = 1e-7
    copy_chunk_bytes: int = MIB
    max_probe_output_bytes: int = 64 * MIB
    probe_timeout_seconds: float = 60.0
    decode_timeout_seconds: float = 20 * 60.0
    max_subprocess_memory_bytes: int = 8 * GIB
    max_subprocess_cpu_seconds: int = 20 * 60
    max_member_name_bytes: int = 1024
    max_path_component_bytes: int = 255
    allowed_audio_extensions: tuple[str, ...] = (".mp3", ".wav")
    rejected_archive_extensions: tuple[str, ...] = (
        ".7z",
        ".bz2",
        ".gz",
        ".rar",
        ".tar",
        ".tgz",
        ".xz",
        ".zip",
    )
    allowed_zip_compression_methods: tuple[int, ...] = (0, 8)  # stored, deflate

    def __post_init__(self) -> None:
        if not self.version:
            raise ValueError("policy version must be non-empty")
        positive_ints = (
            "max_archive_bytes",
            "max_total_entries",
            "max_audio_entries",
            "max_entry_compressed_bytes",
            "max_entry_uncompressed_bytes",
            "max_aggregate_compressed_bytes",
            "max_aggregate_uncompressed_bytes",
            "max_channels_per_stem",
            "max_decoded_channels",
            "max_audio_streams_per_file",
            "canonical_sample_rate",
            "canonical_sample_width_bytes",
            "copy_chunk_bytes",
            "max_probe_output_bytes",
            "max_subprocess_memory_bytes",
            "max_subprocess_cpu_seconds",
            "max_member_name_bytes",
            "max_path_component_bytes",
        )
        for field_name in positive_ints:
            if getattr(self, field_name) <= 0:
                raise ValueError(f"{field_name} must be positive")
        if not math.isfinite(self.max_compression_ratio) or self.max_compression_ratio < 1:
            raise ValueError("max_compression_ratio must be at least 1")
        if not math.isfinite(self.scratch_space_multiplier) or self.scratch_space_multiplier < 1:
            raise ValueError("scratch_space_multiplier must be at least 1")
        if (
            not math.isfinite(self.max_audio_duration_seconds)
            or self.max_audio_duration_seconds <= 0
        ):
            raise ValueError("max_audio_duration_seconds must be positive")
        if (
            not math.isfinite(self.probe_timeout_seconds)
            or not math.isfinite(self.decode_timeout_seconds)
            or self.probe_timeout_seconds <= 0
            or self.decode_timeout_seconds <= 0
        ):
            raise ValueError("subprocess timeouts must be positive")
        if not math.isfinite(self.silence_epsilon) or not 0 <= self.silence_epsilon < 1:
            raise ValueError("silence_epsilon must be in [0, 1)")
        if self.max_audio_entries > self.max_total_entries:
            raise ValueError("max_audio_entries cannot exceed max_total_entries")
        if self.max_channels_per_stem > self.max_decoded_channels:
            raise ValueError("per-stem channels cannot exceed aggregate decoded channels")
        if self.canonical_sample_width_bytes != 4:
            raise ValueError("the v1 canonical format is fixed at float32 (4 bytes)")
        for extension in (*self.allowed_audio_extensions, *self.rejected_archive_extensions):
            if not extension.startswith(".") or extension != extension.casefold():
                raise ValueError("extensions must be lowercase and start with a dot")
        if len(set(self.allowed_audio_extensions)) != len(self.allowed_audio_extensions):
            raise ValueError("allowed_audio_extensions contains duplicates")
        if set(self.allowed_audio_extensions) & set(self.rejected_archive_extensions):
            raise ValueError("audio and rejected archive extensions overlap")
        if len(set(self.allowed_zip_compression_methods)) != len(
            self.allowed_zip_compression_methods
        ):
            raise ValueError("allowed_zip_compression_methods contains duplicates")

    def with_overrides(self, **overrides: Any) -> IngestPolicy:
        """Return a validated copy and fail on misspelled/unknown overrides."""

        known = set(self.__dataclass_fields__)
        unknown = sorted(set(overrides) - known)
        if unknown:
            raise TypeError(f"unknown policy override(s): {', '.join(unknown)}")
        return replace(self, **overrides)

    def to_dict(self) -> dict[str, Any]:
        """Return the complete JSON-safe policy, including every default."""

        result = asdict(self)
        # json handles tuples, but explicit lists make the provenance contract clear.
        result["allowed_audio_extensions"] = list(self.allowed_audio_extensions)
        result["rejected_archive_extensions"] = list(self.rejected_archive_extensions)
        result["allowed_zip_compression_methods"] = list(self.allowed_zip_compression_methods)
        return result

    @property
    def max_canonical_output_bytes_per_stem(self) -> int:
        """Worst-case canonical bytes allowed for one decoded stem."""

        audio_bytes = int(
            self.max_audio_duration_seconds
            * self.canonical_sample_rate
            * self.max_channels_per_stem
            * self.canonical_sample_width_bytes
        )
        # A canonical RIFF/WAVE contains a small header and optional alignment
        # chunks. Reserve a bounded MiB rather than leaving container overhead
        # unconstrained.
        return audio_bytes + MIB


DEFAULT_POLICY = IngestPolicy()
