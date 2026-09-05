from __future__ import annotations

import json
import os
import stat
import struct
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from opusloops_stem_calibration.audio_probe import (
    AudioProbeError,
    decode_canonical,
    probe_audio,
)
from opusloops_stem_calibration.policy import DEFAULT_POLICY


def _write_tool(path: Path, body: str) -> Path:
    script = f"#!{sys.executable}\n" + textwrap.dedent(body)
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def _ffprobe_payload(*, duration: float = 1.0, channels: int = 2) -> dict:
    return {
        "streams": [
            {
                "index": 1,
                "codec_name": "mp3",
                "codec_long_name": "MP3",
                "profile": "Layer 3",
                "sample_fmt": "fltp",
                "sample_rate": "48000",
                "channels": channels,
                "channel_layout": "stereo" if channels == 2 else None,
                "time_base": "1/14112000",
                "start_time": "0.023021",
                "duration": str(duration),
                "bit_rate": "320000",
                "tags": {"encoder": "Suno"},
            }
        ],
        "packets": [
            {
                "stream_index": 1,
                "pts": 0,
                "pts_time": "0.000000",
                "duration_time": "0.024",
                "side_data_list": [{"side_data_type": "Skip Samples", "skip_samples": 1105}],
            },
            {
                "stream_index": 1,
                "pts": 1,
                "pts_time": str(max(0, duration - 0.024)),
                "duration_time": "0.024",
                "side_data_list": [{"side_data_type": "Skip Samples", "discard_padding": 731}],
            },
        ],
        "format": {"duration": str(duration), "bit_rate": "321000"},
    }


def _make_ffprobe(path: Path, payload: dict, *, malformed: bool = False) -> Path:
    serialized = json.dumps(payload)
    output = "not-json" if malformed else serialized
    return _write_tool(
        path,
        f"""
        import sys
        if '-version' in sys.argv:
            print('ffprobe version fixture-1')
            print('configuration: --fixture-safe')
        elif '-nostdin' in sys.argv:
            print('ffprobe does not support -nostdin', file=sys.stderr)
            raise SystemExit(1)
        else:
            print({output!r})
        """,
    )


def _float_wave_bytes(
    samples: list[float], *, channels: int = 2, sample_rate: int = 48_000
) -> bytes:
    data = struct.pack("<" + "f" * len(samples), *samples)
    block_align = channels * 4
    fmt = struct.pack(
        "<HHIIHH", 3, channels, sample_rate, sample_rate * block_align, block_align, 32
    )
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    chunks += b"data" + struct.pack("<I", len(data)) + data
    if len(data) & 1:
        chunks += b"\x00"
    return b"RIFF" + struct.pack("<I", len(chunks) + 4) + b"WAVE" + chunks


def _make_ffmpeg(path: Path, samples: list[float] | None, *, fail: bool = False) -> Path:
    packed = _float_wave_bytes(samples or [])
    return _write_tool(
        path,
        f"""
        import pathlib
        import stat
        import sys
        if '-version' in sys.argv:
            print('ffmpeg version fixture-1')
            print('configuration: --fixture-safe')
        elif {fail!r}:
            print('synthetic decode failure', file=sys.stderr)
            raise SystemExit(7)
        else:
            output = pathlib.Path(sys.argv[-1])
            if stat.S_IMODE(output.parent.stat().st_mode) != 0o700:
                print('staging directory is not owner-only', file=sys.stderr)
                raise SystemExit(8)
            output.write_bytes({packed!r})
        """,
    )


class AudioProbeTests(unittest.TestCase):
    def test_probe_records_timing_padding_tags_and_tool_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"not-private-audio")
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            probe = probe_audio(source, ffprobe_bin=ffprobe)
            self.assertEqual(probe.codec, "mp3")
            self.assertEqual(probe.sample_rate, 48_000)
            self.assertEqual(probe.channels, 2)
            self.assertEqual(probe.skip_samples, 1105)
            self.assertEqual(probe.discard_padding, 731)
            self.assertEqual(probe.first_packet_timestamp, 0.0)
            self.assertEqual(probe.timeline_start_seconds, 0.023021)
            self.assertEqual(probe.duration_source, "packet-timeline")
            self.assertAlmostEqual(probe.packet_timeline_duration_seconds or 0, 1.0)
            self.assertEqual(probe.tags, {"encoder": "Suno"})
            self.assertEqual(len(probe.source_sha256), 64)
            self.assertNotIn(str(source), probe.sanitized_arguments)
            self.assertIn("fixture-1", probe.ffprobe.version)
            self.assertEqual(probe.ffprobe.build_configuration, "--fixture-safe")

    def test_probe_prefers_packet_timeline_over_unreliable_declared_duration(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            payload = _ffprobe_payload(duration=1.0)
            payload["streams"][0]["duration"] = "0.2"
            payload["format"]["duration"] = "0.3"
            ffprobe = _make_ffprobe(root / "ffprobe", payload)

            probe = probe_audio(source, ffprobe_bin=ffprobe)

            self.assertAlmostEqual(probe.duration_seconds, 1.0)
            self.assertEqual(probe.duration_source, "packet-timeline")
            self.assertEqual(probe.stream_declared_duration_seconds, 0.2)
            self.assertEqual(probe.format_declared_duration_seconds, 0.3)

    def test_probe_rejects_duration_channels_multiple_streams_and_bad_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            cases = [
                (
                    _ffprobe_payload(duration=2),
                    DEFAULT_POLICY.with_overrides(max_audio_duration_seconds=1),
                    "duration",
                ),
                (_ffprobe_payload(channels=3), DEFAULT_POLICY, "channels"),
            ]
            duplicate = _ffprobe_payload()
            duplicate["streams"].append(dict(duplicate["streams"][0], index=2))
            cases.append((duplicate, DEFAULT_POLICY, "audio streams"))
            for index, (payload, policy, expected) in enumerate(cases):
                with self.subTest(expected=expected):
                    tool = _make_ffprobe(root / f"ffprobe-{index}", payload)
                    with self.assertRaisesRegex(AudioProbeError, expected):
                        probe_audio(source, policy, ffprobe_bin=tool)
            malformed = _make_ffprobe(root / "ffprobe-malformed", {}, malformed=True)
            with self.assertRaisesRegex(AudioProbeError, "valid JSON"):
                probe_audio(source, ffprobe_bin=malformed)

    def test_decode_is_atomic_exact_and_preserves_leading_silence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem;touch SHOULD_NOT_EXIST.mp3"
            source.write_bytes(b"fixture")
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            samples = [0.0, 0.0, 0.0, 0.0, 0.25, -0.5]
            ffmpeg = _make_ffmpeg(root / "ffmpeg", samples)
            output = root / "canonical.wav"
            probe = probe_audio(source, ffprobe_bin=ffprobe)
            canonical = decode_canonical(
                source,
                output,
                ffmpeg_bin=ffmpeg,
                ffprobe_bin=ffprobe,
                probe=probe,
            )
            self.assertTrue(output.is_file())
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            self.assertEqual(canonical.frames, 3)
            self.assertEqual(canonical.audio_data_bytes, 24)
            self.assertEqual(canonical.bytes, 68)
            self.assertEqual(canonical.leading_silence_frames, 2)
            self.assertAlmostEqual(canonical.peak_absolute_sample, 0.5)
            self.assertEqual(canonical.timeline_offset_frames, round(0.023021 * 48_000))
            self.assertNotIn(str(source), canonical.sanitized_arguments)
            self.assertNotIn(str(ffmpeg), canonical.sanitized_arguments)
            self.assertEqual(canonical.ffmpeg.path, str(ffmpeg.resolve()))
            self.assertFalse((root / "SHOULD_NOT_EXIST.mp3").exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_refuses_overwrite_and_cleans_failed_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            output = root / "canonical.wav"
            output.write_bytes(b"keep")
            with self.assertRaisesRegex(AudioProbeError, "refusing to overwrite"):
                decode_canonical(source, output, ffprobe_bin=ffprobe)
            self.assertEqual(output.read_bytes(), b"keep")

            output.unlink()
            ffmpeg = _make_ffmpeg(root / "ffmpeg", [], fail=True)
            with self.assertRaisesRegex(AudioProbeError, "exited with 7"):
                decode_canonical(source, output, ffmpeg_bin=ffmpeg, ffprobe_bin=ffprobe)
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_rejects_partial_frames_and_nonfinite_samples(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            partial_wave = _float_wave_bytes([0.0, 0.0])
            # Change the data declaration/payload to three bytes while keeping a
            # structurally valid, padded RIFF container.
            partial_wave = partial_wave[:40] + struct.pack("<I", 3) + b"123\x00"
            partial_wave = (
                partial_wave[:4] + struct.pack("<I", len(partial_wave) - 8) + partial_wave[8:]
            )
            partial = _write_tool(
                root / "ffmpeg-partial",
                f"""
                import pathlib, sys
                if '-version' in sys.argv: print('ffmpeg version fixture-partial')
                else: pathlib.Path(sys.argv[-1]).write_bytes({partial_wave!r})
                """,
            )
            with self.assertRaisesRegex(AudioProbeError, "byte/frame"):
                decode_canonical(
                    source,
                    root / "partial.wav",
                    ffmpeg_bin=partial,
                    ffprobe_bin=ffprobe,
                )
            self.assertFalse((root / "partial.wav").exists())
            nonfinite = _make_ffmpeg(root / "ffmpeg-nan", [float("nan"), 0.0])
            with self.assertRaisesRegex(AudioProbeError, "NaN"):
                decode_canonical(
                    source,
                    root / "nan.wav",
                    ffmpeg_bin=nonfinite,
                    ffprobe_bin=ffprobe,
                )
            self.assertFalse((root / "nan.wav").exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_requires_valid_ffmpeg_and_ffprobe_identity_before_decode(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            output = root / "canonical.wav"
            decode_marker = root / "decode-started"
            valid_ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            bad_ffmpeg = _write_tool(
                root / "ffmpeg-bad-version",
                f"""
                import pathlib, sys
                if '-version' in sys.argv:
                    print('untrusted executable')
                else:
                    pathlib.Path({str(decode_marker)!r}).write_text('started')
                """,
            )
            with self.assertRaisesRegex(AudioProbeError, "did not identify"):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=bad_ffmpeg,
                    ffprobe_bin=valid_ffprobe,
                )
            self.assertFalse(decode_marker.exists())
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

            valid_ffmpeg = _write_tool(
                root / "ffmpeg",
                f"""
                import pathlib, sys
                if '-version' in sys.argv:
                    print('ffmpeg version fixture-1')
                else:
                    pathlib.Path({str(decode_marker)!r}).write_text('started')
                """,
            )
            bad_ffprobe = _write_tool(
                root / "ffprobe-bad-version",
                """
                import sys
                if '-version' in sys.argv:
                    print('not ffprobe')
                """,
            )
            with self.assertRaisesRegex(AudioProbeError, "did not identify"):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=valid_ffmpeg,
                    ffprobe_bin=bad_ffprobe,
                )
            self.assertFalse(decode_marker.exists())
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_rejects_ffmpeg_replacement_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            output = root / "canonical.wav"
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            ffmpeg = root / "ffmpeg"
            packed = _float_wave_bytes([0.1, -0.1])
            _write_tool(
                ffmpeg,
                f"""
                import os, pathlib, sys
                if '-version' in sys.argv:
                    print('ffmpeg version fixture-replacing')
                else:
                    pathlib.Path(sys.argv[-1]).write_bytes({packed!r})
                    original = pathlib.Path({str(ffmpeg)!r})
                    replacement = original.with_name('ffmpeg-replacement')
                    replacement.write_bytes(b'replacement executable')
                    replacement.chmod(0o700)
                    os.replace(replacement, original)
                """,
            )

            with self.assertRaisesRegex(AudioProbeError, "identity changed"):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=ffmpeg,
                    ffprobe_bin=ffprobe,
                )

            self.assertEqual(ffmpeg.read_bytes(), b"replacement executable")
            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_rejects_ffprobe_replacement_after_probing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            output = root / "canonical.wav"
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            probe = probe_audio(source, ffprobe_bin=ffprobe)
            replacement_payload = _ffprobe_payload()
            replacement_payload["streams"][0]["tags"] = {"replacement": "true"}
            replacement = _make_ffprobe(root / "ffprobe-replacement", replacement_payload)
            os.replace(replacement, ffprobe)
            ffmpeg = _make_ffmpeg(root / "ffmpeg", [0.1, -0.1])

            with self.assertRaisesRegex(AudioProbeError, "provenance no longer matches"):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=ffmpeg,
                    ffprobe_bin=ffprobe,
                    probe=probe,
                )

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_rejects_source_tamper_before_publication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            output = root / "canonical.wav"
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            packed = _float_wave_bytes([0.1, -0.1])
            ffmpeg = _write_tool(
                root / "ffmpeg",
                f"""
                import pathlib, sys
                if '-version' in sys.argv:
                    print('ffmpeg version fixture-tamper')
                else:
                    pathlib.Path(sys.argv[-1]).write_bytes({packed!r})
                    source = pathlib.Path({str(source)!r})
                    source.write_bytes(source.read_bytes() + b'-tampered')
                """,
            )

            with self.assertRaisesRegex(AudioProbeError, "audio source .*changed"):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=ffmpeg,
                    ffprobe_bin=ffprobe,
                )

            self.assertFalse(output.exists())
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_decode_publication_race_never_clobbers_destination(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            output = root / "canonical.wav"
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            ffmpeg = _make_ffmpeg(root / "ffmpeg", [0.1, -0.1])
            real_link = os.link

            def racing_link(*args: object, **kwargs: object) -> None:
                output.write_bytes(b"racer-owned")
                real_link(*args, **kwargs)

            with (
                mock.patch(
                    "opusloops_stem_calibration.audio_probe.os.link", side_effect=racing_link
                ),
                self.assertRaisesRegex(AudioProbeError, "refusing to overwrite"),
            ):
                decode_canonical(
                    source,
                    output,
                    ffmpeg_bin=ffmpeg,
                    ffprobe_bin=ffprobe,
                )

            self.assertEqual(output.read_bytes(), b"racer-owned")
            self.assertEqual(list(root.glob(".*.decode-*")), [])

    def test_probe_timeout_terminates_the_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            slow = _write_tool(
                root / "ffprobe-slow",
                """
                import time
                time.sleep(5)
                """,
            )
            policy = DEFAULT_POLICY.with_overrides(probe_timeout_seconds=0.05)
            with self.assertRaisesRegex(AudioProbeError, "timed out"):
                probe_audio(source, policy, ffprobe_bin=slow)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_probe_rejects_audio_source_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "stem.mp3"
            source.write_bytes(b"fixture")
            link = root / "link.mp3"
            link.symlink_to(source)
            ffprobe = _make_ffprobe(root / "ffprobe", _ffprobe_payload())
            with self.assertRaisesRegex(AudioProbeError, "regular file"):
                probe_audio(link, ffprobe_bin=ffprobe)


if __name__ == "__main__":
    unittest.main()
