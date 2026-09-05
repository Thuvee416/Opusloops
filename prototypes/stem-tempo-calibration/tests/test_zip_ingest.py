from __future__ import annotations

import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from opusloops_stem_calibration.policy import DEFAULT_POLICY
from opusloops_stem_calibration.zip_ingest import (
    ExtractionProgress,
    ZipIngestError,
    ZipPolicyError,
    extract_zip_safe,
    inspect_zip,
)


def _make_zip(path: Path, members: list[tuple[str | zipfile.ZipInfo, bytes]]) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.comment = b"fixture-comment\x00"
        for name, contents in members:
            archive.writestr(name, contents)


class ZipIngestTests(unittest.TestCase):
    def test_default_mvp_policy_is_intentionally_narrow(self) -> None:
        self.assertEqual(DEFAULT_POLICY.max_archive_bytes, 2 * 1024**3)
        self.assertEqual(DEFAULT_POLICY.max_audio_entries, 16)
        self.assertEqual(DEFAULT_POLICY.max_audio_duration_seconds, 600)
        self.assertEqual(DEFAULT_POLICY.allowed_audio_extensions, (".mp3", ".wav"))

    def test_valid_nested_paths_are_streamed_and_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "stems.zip"
            _make_zip(
                archive,
                [
                    ("Band/Drums.mp3", b"drum-bytes"),
                    ("Band/Bass.WAV", b"bass-bytes"),
                    ("__MACOSX/._Drums.mp3", b"metadata"),
                    ("Band/.DS_Store", b"metadata"),
                ],
            )

            preflight = inspect_zip(archive)
            self.assertEqual(len(preflight.accepted_entries), 2)
            self.assertEqual(len(preflight.ignored_entries), 2)
            self.assertTrue(all(entry.sha256 is None for entry in preflight.accepted_entries))
            self.assertEqual(len(preflight.archive_sha256), 64)
            self.assertEqual(len(preflight.inventory_sha256), 64)

            output = root / "extracted"
            extracted = extract_zip_safe(archive, output)
            self.assertEqual((output / "Band/Drums.mp3").read_bytes(), b"drum-bytes")
            self.assertEqual((output / "Band/Bass.WAV").read_bytes(), b"bass-bytes")
            self.assertFalse((output / "__MACOSX").exists())
            self.assertTrue(all(entry.sha256 for entry in extracted.accepted_entries))
            self.assertNotEqual(preflight.inventory_sha256, extracted.inventory_sha256)

    def test_progress_is_measured_monotonic_and_outputs_are_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "stems.zip"
            _make_zip(
                archive,
                [
                    ("Band/Drums/room.wav", b"12345"),
                    ("Band/Bass.mp3", b"abcdefg"),
                ],
            )
            progress: list[ExtractionProgress] = []
            output = root / "output"

            extract_zip_safe(
                archive,
                output,
                DEFAULT_POLICY.with_overrides(copy_chunk_bytes=2),
                progress_callback=progress.append,
            )

            self.assertGreater(len(progress), 3)
            self.assertEqual(progress[0].completed_files, 0)
            self.assertEqual(progress[0].completed_uncompressed_bytes, 0)
            self.assertIsNone(progress[0].current_asset_id)
            self.assertTrue(all(event.total_files == 2 for event in progress))
            self.assertTrue(all(event.total_uncompressed_bytes == 12 for event in progress))
            measured = [
                (event.completed_uncompressed_bytes, event.completed_files) for event in progress
            ]
            self.assertEqual(
                [event.completed_uncompressed_bytes for event in progress],
                sorted(event.completed_uncompressed_bytes for event in progress),
            )
            self.assertEqual(
                [event.completed_files for event in progress],
                sorted(event.completed_files for event in progress),
            )
            self.assertEqual(measured[-1], (12, 2))
            self.assertTrue(all(event.current_asset_id is not None for event in progress[1:]))
            if os.name == "posix":
                for directory in (output, output / "Band", output / "Band/Drums"):
                    self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                for audio_file in (output / "Band/Drums/room.wav", output / "Band/Bass.mp3"):
                    self.assertEqual(stat.S_IMODE(audio_file.stat().st_mode), 0o600)

    def test_unsafe_paths_fail_preflight_without_extracting(self) -> None:
        unsafe_names = [
            "../escape.mp3",
            "/absolute.mp3",
            "C:/drive.mp3",
            "\\\\server\\share.mp3",
            "nested/../../escape.wav",
            "control\nname.mp3",
        ]
        for index, name in enumerate(unsafe_names):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / f"unsafe-{index}.zip"
                _make_zip(archive, [(name, b"unsafe")])
                output = root / "output"
                with self.assertRaises(ZipPolicyError):
                    extract_zip_safe(archive, output)
                self.assertFalse(output.exists())
                self.assertFalse((root.parent / "escape.mp3").exists())

    def test_symlink_and_special_members_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for file_type, label in ((stat.S_IFLNK, "symlink"), (stat.S_IFIFO, "fifo")):
                with self.subTest(kind=label):
                    info = zipfile.ZipInfo(f"{label}.mp3")
                    info.create_system = 3
                    info.external_attr = (file_type | 0o777) << 16
                    archive = root / f"{label}.zip"
                    _make_zip(archive, [(info, b"target")])
                    expected = label if label == "symlink" else "special"
                    with self.assertRaisesRegex(ZipPolicyError, expected):
                        inspect_zip(archive)

    def test_casefold_and_unicode_collisions_are_rejected(self) -> None:
        collision_sets = [
            [("Drums.mp3", b"one"), ("drums.MP3", b"two")],
            [
                ("caf\N{LATIN SMALL LETTER E WITH ACUTE}.wav", b"one"),
                ("cafe\N{COMBINING ACUTE ACCENT}.wav", b"two"),
            ],
        ]
        for members in collision_sets:
            with (
                self.subTest(members=[name for name, _ in members]),
                tempfile.TemporaryDirectory() as temporary,
            ):
                archive = Path(temporary) / "collision.zip"
                _make_zip(archive, members)
                with self.assertRaisesRegex(ZipPolicyError, "duplicate") as caught:
                    inspect_zip(archive)
                self.assertEqual(len(caught.exception.inventory.rejected_entries), 2)

    def test_nested_archive_and_unsupported_media_are_rejected(self) -> None:
        for name in ("nested.zip", "notes.txt", "audio.exe"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                archive = Path(temporary) / "bad.zip"
                _make_zip(archive, [(name, b"data")])
                with self.assertRaises(ZipPolicyError):
                    inspect_zip(archive)

    def test_count_size_and_ratio_limits_are_fail_closed(self) -> None:
        cases = [
            (
                [("one.mp3", b"1"), ("two.mp3", b"2")],
                DEFAULT_POLICY.with_overrides(max_total_entries=1, max_audio_entries=1),
                "entry count",
            ),
            (
                [("large.wav", b"12345")],
                DEFAULT_POLICY.with_overrides(max_entry_uncompressed_bytes=4),
                "per-entry",
            ),
            (
                [("bomb.wav", b"0" * 20_000)],
                DEFAULT_POLICY.with_overrides(max_compression_ratio=2),
                "compression ratio",
            ),
        ]
        for members, policy, message in cases:
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temporary:
                archive = Path(temporary) / "limited.zip"
                _make_zip(archive, members)
                with self.assertRaisesRegex(ZipPolicyError, message):
                    inspect_zip(archive, policy)

    def test_crc_corruption_cleans_staging_and_never_promotes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "corrupt.zip"
            payload = b"unique-payload-for-corruption"
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as writer:
                writer.writestr("drums.wav", payload)
            raw = archive.read_bytes()
            self.assertEqual(raw.count(payload), 1)
            archive.write_bytes(raw.replace(payload, b"X" + payload[1:], 1))

            output = root / "output"
            with self.assertRaisesRegex(ZipPolicyError, "CRC/decompression"):
                extract_zip_safe(archive, output)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".output.staging-*")), [])

    def test_encrypted_flag_and_corrupt_headers_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            encrypted = root / "encrypted.zip"
            with zipfile.ZipFile(encrypted, "w", compression=zipfile.ZIP_STORED) as writer:
                writer.writestr("stem.wav", b"fixture")
            raw = bytearray(encrypted.read_bytes())
            local = raw.index(b"PK\x03\x04")
            central = raw.index(b"PK\x01\x02")
            local_flags = int.from_bytes(raw[local + 6 : local + 8], "little") | 1
            central_flags = int.from_bytes(raw[central + 8 : central + 10], "little") | 1
            raw[local + 6 : local + 8] = local_flags.to_bytes(2, "little")
            raw[central + 8 : central + 10] = central_flags.to_bytes(2, "little")
            encrypted.write_bytes(raw)
            with self.assertRaisesRegex(ZipPolicyError, "encrypted"):
                inspect_zip(encrypted)

            corrupt = root / "corrupt-header.zip"
            corrupt.write_bytes(b"PK\x03\x04not-a-complete-archive")
            with self.assertRaisesRegex(ZipPolicyError, "invalid or unsupported"):
                inspect_zip(corrupt)

    def test_destination_is_never_overwritten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            _make_zip(archive, [("stem.wav", b"data")])
            output = root / "output"
            output.mkdir()
            marker = output / "keep"
            marker.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ZipIngestError, "refusing to overwrite"):
                extract_zip_safe(archive, output)
            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")

    def test_destination_created_during_extraction_wins_without_clobber(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            _make_zip(archive, [("stem.wav", b"audio")])
            output = root / "output"
            raced = False

            def create_destination(progress: ExtractionProgress) -> None:
                nonlocal raced
                if raced or progress.completed_files != progress.total_files:
                    return
                raced = True
                output.mkdir()
                (output / "winner").write_text("keep", encoding="utf-8")

            with self.assertRaisesRegex(ZipIngestError, "already exists"):
                extract_zip_safe(archive, output, progress_callback=create_destination)

            self.assertEqual((output / "winner").read_text(encoding="utf-8"), "keep")
            self.assertFalse((output / "stem.wav").exists())
            self.assertEqual(list(root.glob(".output.staging-*")), [])

    def test_in_place_archive_mutation_is_detected_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            _make_zip(archive, [("stem.wav", b"audio")])
            output = root / "output"
            mutated = False

            def mutate_archive(progress: ExtractionProgress) -> None:
                nonlocal mutated
                if mutated or progress.completed_uncompressed_bytes == 0:
                    return
                mutated = True
                raw = bytearray(archive.read_bytes())
                raw[-1] ^= 1
                archive.write_bytes(raw)

            with self.assertRaisesRegex(ZipIngestError, "archive changed"):
                extract_zip_safe(archive, output, progress_callback=mutate_archive)

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".output.staging-*")), [])

    def test_inspection_uses_pinned_descriptor_and_rejects_path_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            replacement = root / "replacement.zip"
            parked = root / "parked.zip"
            _make_zip(archive, [("stem.wav", b"approved")])
            _make_zip(replacement, [("notes.txt", b"attacker")])
            real_zip_file = zipfile.ZipFile
            opened_on: list[object] = []

            def swap_before_parse(file: object, *args: object, **kwargs: object) -> zipfile.ZipFile:
                opened_on.append(file)
                archive.rename(parked)
                replacement.rename(archive)
                return real_zip_file(file, *args, **kwargs)

            with (
                mock.patch(
                    "opusloops_stem_calibration.zip_ingest.zipfile.ZipFile",
                    side_effect=swap_before_parse,
                ),
                self.assertRaisesRegex(ZipIngestError, "archive changed"),
            ):
                inspect_zip(archive)

            self.assertEqual(len(opened_on), 1)
            self.assertTrue(hasattr(opened_on[0], "fileno"))

    def test_archive_swap_and_restore_cannot_redirect_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            replacement = root / "replacement.zip"
            parked = root / "parked.zip"
            _make_zip(archive, [("stem.wav", b"approved")])
            _make_zip(replacement, [("stem.wav", b"attacker")])
            output = root / "output"
            swapped = False

            def swap_and_restore(progress: ExtractionProgress) -> None:
                nonlocal swapped
                if swapped or progress.completed_uncompressed_bytes == 0:
                    return
                swapped = True
                archive.rename(parked)
                replacement.rename(archive)
                archive.rename(replacement)
                parked.rename(archive)

            try:
                extract_zip_safe(archive, output, progress_callback=swap_and_restore)
            except ZipIngestError as error:
                self.assertIn("archive changed", str(error))
                self.assertFalse(output.exists())
            else:
                self.assertEqual((output / "stem.wav").read_bytes(), b"approved")
            self.assertEqual(list(root.glob(".output.staging-*")), [])

    def test_callback_failure_cleans_owned_staging_without_crc_mislabel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            _make_zip(archive, [("stem.wav", b"audio")])
            output = root / "output"

            def fail_callback(progress: ExtractionProgress) -> None:
                if progress.completed_uncompressed_bytes:
                    raise RuntimeError("observer unavailable")

            with self.assertRaisesRegex(ZipIngestError, "progress callback failed"):
                extract_zip_safe(archive, output, progress_callback=fail_callback)

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".output.staging-*")), [])

    def test_scratch_space_is_checked_before_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "valid.zip"
            _make_zip(archive, [("stem.wav", b"data")])
            # shutil.disk_usage returns a named tuple; any object with .free works.
            with (
                mock.patch(
                    "opusloops_stem_calibration.zip_ingest.shutil.disk_usage",
                    return_value=mock.Mock(free=0),
                ),
                self.assertRaisesRegex(ZipPolicyError, "scratch"),
            ):
                extract_zip_safe(archive, root / "output")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_archive_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            real = root / "real.zip"
            _make_zip(real, [("stem.wav", b"data")])
            link = root / "link.zip"
            link.symlink_to(real)
            with self.assertRaisesRegex(ZipPolicyError, "regular file"):
                inspect_zip(link)


if __name__ == "__main__":
    unittest.main()
