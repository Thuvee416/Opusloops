from __future__ import annotations

import json
import math
import os
import tempfile
import unittest
from pathlib import Path

from opusloops_stem_calibration.manifest import (
    ANALYSIS_SELECTION_SCHEMA_VERSION,
    MANIFEST_SCHEMA_VERSION,
    ManifestError,
    RunManifest,
    append_event,
    approval_binding,
    artifact_reference,
    atomic_create_json,
    atomic_write_json,
    canonical_json_bytes,
    load_json,
    run_manifest_schema,
    sha256_file,
    tempo_approval_schema,
    validate_analysis_selection,
    validate_tempo_approval_schema,
    verify_approval_binding,
    verify_artifact_reference,
    verify_event_journal,
)


def _digest(character: str) -> str:
    return character * 64


def _selection() -> dict:
    return {
        "schema_version": ANALYSIS_SELECTION_SCHEMA_VERSION,
        "approval_id": "approval-1",
        "approved_at": "2026-09-05T12:34:56.000Z",
        "approved_by": "fixture-user",
        "upstream": {
            "run_manifest_sha256": _digest("a"),
            "source_archive_sha256": _digest("b"),
            "inventory_sha256": _digest("c"),
        },
        "selection": {
            "reference_method": "selected-stem-sum",
            "assets": [
                {"asset_id": "drums", "role": "drums", "included": True, "gain_db": 0},
                {"asset_id": "bass", "role": "bass", "included": True, "gain_db": -1.5},
            ],
            "full_mix_asset_id": None,
            "drum_crosscheck_asset_id": "drums",
            "sum": {"headroom_db": -12, "normalize_peak_dbfs": -3},
        },
        "confirmations": {
            "files_and_hashes_reviewed": True,
            "roles_reviewed": True,
            "reference_method_reviewed": True,
            "originals_unchanged": True,
        },
    }


class ManifestTests(unittest.TestCase):
    def test_atomic_json_is_stable_and_invalid_json_preserves_previous_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "value.json"
            atomic_write_json(path, {"z": 1, "a": "é"})
            self.assertEqual(load_json(path), {"a": "é", "z": 1})
            previous = path.read_bytes()
            with self.assertRaises(ManifestError):
                atomic_write_json(path, {"bad": math.nan})
            self.assertEqual(path.read_bytes(), previous)
            self.assertEqual(canonical_json_bytes({"b": 2, "a": 1}), b'{"a":1,"b":2}')

            create_once = Path(temporary) / "create-once.json"
            atomic_create_json(create_once, {"version": 1})
            with self.assertRaisesRegex(ManifestError, "already exists"):
                atomic_create_json(create_once, {"version": 2})
            self.assertEqual(load_json(create_once), {"version": 1})

    def test_artifact_references_are_run_relative_and_tamper_evident(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            artifact = run / "nested" / "beats.json"
            artifact.parent.mkdir()
            artifact.write_text("[]\n", encoding="utf-8")
            reference = artifact_reference(artifact, run)
            self.assertEqual(reference["path"], "nested/beats.json")
            self.assertEqual(verify_artifact_reference(reference, run), artifact.resolve())
            artifact.write_text("[1]\n", encoding="utf-8")
            with self.assertRaisesRegex(ManifestError, "mismatch"):
                verify_artifact_reference(reference, run)
            with self.assertRaisesRegex(ManifestError, "run-relative"):
                verify_artifact_reference(
                    {"path": "../escape", "bytes": 0, "sha256": _digest("a")}, run
                )

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks unavailable")
    def test_artifacts_cannot_escape_via_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            run.mkdir()
            outside = root / "outside"
            outside.write_bytes(b"secret")
            link = run / "link"
            link.symlink_to(outside)
            with self.assertRaises(ManifestError):
                artifact_reference(link, run)
            with self.assertRaises(ManifestError):
                sha256_file(link)

            event_target = root / "outside-events.jsonl"
            event_link = run / "events.jsonl"
            event_link.symlink_to(event_target)
            with self.assertRaisesRegex(ManifestError, "safely open"):
                append_event(run, "inspect", "started")
            self.assertFalse(event_target.exists())

    def test_approval_binding_detects_stale_manifest_or_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "run-manifest.json"
            atomic_write_json(path, {"state": 1})
            expected = approval_binding(
                path,
                source_archive_sha256=_digest("b"),
                inventory_sha256=_digest("c"),
            )
            approval = _selection()
            approval["upstream"] = expected
            verify_approval_binding(approval, expected)
            validate_analysis_selection(approval, expected_binding=expected)
            changed = dict(expected, inventory_sha256=_digest("d"))
            with self.assertRaisesRegex(ManifestError, "stale"):
                verify_approval_binding(approval, changed)

    def test_analysis_selection_enforces_both_semantics_and_confirmations(self) -> None:
        valid = _selection()
        validate_analysis_selection(valid)
        invalid_cases = []
        no_assets = json.loads(json.dumps(valid))
        no_assets["selection"]["assets"] = []
        invalid_cases.append(no_assets)
        duplicate = json.loads(json.dumps(valid))
        duplicate["selection"]["assets"][1]["asset_id"] = "drums"
        invalid_cases.append(duplicate)
        false_confirmation = json.loads(json.dumps(valid))
        false_confirmation["confirmations"]["roles_reviewed"] = False
        invalid_cases.append(false_confirmation)
        wrong_normalization = json.loads(json.dumps(valid))
        wrong_normalization["selection"]["sum"]["normalize_peak_dbfs"] = -1
        invalid_cases.append(wrong_normalization)
        bad_full_mix = json.loads(json.dumps(valid))
        bad_full_mix["selection"]["reference_method"] = "full-mix"
        bad_full_mix["selection"]["full_mix_asset_id"] = "missing"
        invalid_cases.append(bad_full_mix)
        mixed_full_mix = json.loads(json.dumps(valid))
        mixed_full_mix["selection"]["reference_method"] = "full-mix"
        mixed_full_mix["selection"]["full_mix_asset_id"] = "drums"
        invalid_cases.append(mixed_full_mix)
        excluded_drum = json.loads(json.dumps(valid))
        excluded_drum["selection"]["assets"][0]["included"] = False
        invalid_cases.append(excluded_drum)
        wrongly_labelled_drum = json.loads(json.dumps(valid))
        wrongly_labelled_drum["selection"]["assets"][0]["role"] = "percussion"
        invalid_cases.append(wrongly_labelled_drum)
        for invalid in invalid_cases:
            with self.subTest(invalid=invalid), self.assertRaises(ManifestError):
                validate_analysis_selection(invalid)

    def test_analysis_selection_requires_exact_fields_and_nonempty_approver(self) -> None:
        for approved_by in (None, "", "   "):
            with self.subTest(approved_by=approved_by):
                invalid = _selection()
                invalid["approved_by"] = approved_by
                with self.assertRaisesRegex(ManifestError, "non-empty approved_by"):
                    validate_analysis_selection(invalid)

        missing = _selection()
        missing.pop("approved_by")
        with self.assertRaisesRegex(ManifestError, "missing or unsupported"):
            validate_analysis_selection(missing)

    def test_events_are_monotonic_and_progress_is_stage_specific(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            started = append_event(
                run,
                "uploading",
                "started",
                completed=0,
                total=128,
                unit="bytes",
            )
            first = append_event(
                run,
                "uploading",
                "progress",
                completed=64,
                total=128,
                unit="bytes",
            )
            second = append_event(run, "queued", "waiting", message="Awaiting worker")
            self.assertEqual(
                (started["sequence"], first["sequence"], second["sequence"]), (1, 2, 3)
            )
            self.assertTrue(first["determinate"])
            self.assertFalse(second["determinate"])
            self.assertEqual(second["previous_event_sha256"], first["event_sha256"])
            self.assertNotIn("progress", second)
            lines = [json.loads(line) for line in (run / "events.jsonl").read_text().splitlines()]
            self.assertEqual([line["sequence"] for line in lines], [1, 2, 3])
            with self.assertRaises(ManifestError):
                append_event(run, "uploading", "progress", completed=1)

            lines[0]["stage"] = "tampered"
            (run / "events.jsonl").write_text(
                "\n".join(json.dumps(line) for line in lines) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ManifestError, "hash does not match"):
                verify_event_journal(run)
            with self.assertRaisesRegex(ManifestError, "hash does not match"):
                append_event(run, "failed", "failed")

    def test_manifest_anchors_event_prefix_and_accepts_valid_chained_extension(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            first = append_event(
                run,
                "decoding",
                "started",
                completed=0,
                total=2,
                unit="files",
            )
            second = append_event(
                run,
                "decoding",
                "progress",
                completed=1,
                total=2,
                unit="files",
            )
            manifest = RunManifest.create(run_id="event-anchor")
            manifest_path = manifest.write(run / "run-manifest.json")
            anchor = dict(manifest.data["events"])
            anchored_bytes = (run / "events.jsonl").read_bytes()

            self.assertEqual(
                set(anchor),
                {
                    "path",
                    "entries",
                    "bytes_at_anchor",
                    "journal_sha256_at_anchor",
                    "head_event_sha256",
                },
            )
            self.assertEqual(anchor["path"], "events.jsonl")
            self.assertEqual(anchor["entries"], 2)
            self.assertEqual(anchor["bytes_at_anchor"], len(anchored_bytes))
            self.assertEqual(anchor["head_event_sha256"], second["event_sha256"])
            self.assertNotEqual(first["event_sha256"], second["event_sha256"])

            append_event(
                run,
                "decoding",
                "completed",
                completed=2,
                total=2,
                unit="files",
            )
            loaded = RunManifest.load(manifest_path)
            self.assertEqual(loaded.data["events"], anchor)
            verified = loaded.verify_artifacts(run)
            self.assertIn((run / "events.jsonl").resolve(), verified)
            self.assertEqual(len(verify_event_journal(run, anchor=anchor)), 3)

    def test_manifest_rejects_missing_or_rewritten_anchored_event_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root / "run"
            run.mkdir()
            append_event(run, "inspect", "started")
            append_event(run, "inspect", "completed")
            manifest_path = RunManifest.create(run_id="anchored-events").write(
                run / "run-manifest.json"
            )
            original = (run / "events.jsonl").read_bytes()
            loaded = RunManifest.load(manifest_path)

            (run / "events.jsonl").unlink()
            with self.assertRaisesRegex(ManifestError, "anchored event journal is missing"):
                loaded.verify_artifacts(run)
            (run / "events.jsonl").write_bytes(original)

            replacement = root / "replacement"
            replacement.mkdir()
            append_event(replacement, "inspect", "started")
            append_event(replacement, "inspect", "completed")
            (run / "events.jsonl").write_bytes((replacement / "events.jsonl").read_bytes())
            with self.assertRaisesRegex(ManifestError, "anchored prefix was rewritten"):
                loaded.verify_artifacts(run)
            with self.assertRaisesRegex(ManifestError, "anchored prefix was rewritten"):
                loaded.write()

    def test_determinate_progress_cannot_change_scale_or_regress_within_stage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            append_event(
                run,
                "rendering",
                "started",
                completed=0,
                total=10,
                unit="frames",
            )
            append_event(
                run,
                "rendering",
                "progress",
                completed=5,
                total=10,
                unit="frames",
            )
            before_invalid = (run / "events.jsonl").read_bytes()
            invalid_progress = (
                (6, 11, "frames", "total/unit changed"),
                (6, 10, "samples", "total/unit changed"),
                (4, 10, "frames", "regressed"),
            )
            for completed, total, unit, message in invalid_progress:
                with self.subTest(total=total, unit=unit, completed=completed):
                    with self.assertRaisesRegex(ManifestError, message):
                        append_event(
                            run,
                            "rendering",
                            "progress",
                            completed=completed,
                            total=total,
                            unit=unit,
                        )
                    self.assertEqual((run / "events.jsonl").read_bytes(), before_invalid)

            append_event(
                run,
                "rendering",
                "completed",
                completed=10,
                total=10,
                unit="frames",
            )
            append_event(
                run,
                "rendering",
                "started",
                completed=0,
                total=20,
                unit="samples",
            )
            self.assertEqual(len(verify_event_journal(run)), 4)

    def test_progress_and_determinate_terminal_require_an_active_started_stage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            with self.assertRaisesRegex(ManifestError, "progress has no active started stage"):
                append_event(
                    run,
                    "uploading",
                    "progress",
                    completed=1,
                    total=2,
                    unit="files",
                )
            self.assertEqual((run / "events.jsonl").read_bytes(), b"")
            with self.assertRaisesRegex(
                ManifestError, "determinate event has no active started stage"
            ):
                append_event(
                    run,
                    "uploading",
                    "completed",
                    completed=2,
                    total=2,
                    unit="files",
                )
            self.assertEqual((run / "events.jsonl").read_bytes(), b"")

            append_event(run, "reporting", "completed")
            self.assertEqual(len(verify_event_journal(run)), 1)

    def test_run_manifest_round_trip_and_recursive_artifact_verification(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            artifact = run / "analysis" / "beats.json"
            artifact.parent.mkdir()
            artifact.write_bytes(b"[]")
            manifest = RunManifest.create(run_id="fixture-run")
            reference = artifact_reference(artifact, run)
            manifest.data["analysis"] = {
                "attempt_id": "fixture-analysis",
                "artifact": reference,
                "reference": reference,
                "grid_template": reference,
                "artifacts": {"primary": [reference], "diagnostics": {}},
            }
            extracted = run / "extracted" / "stem.wav"
            extracted.parent.mkdir()
            extracted.write_bytes(b"stem")
            stem_sha256, _ = sha256_file(extracted)
            manifest.data["entries"] = [
                {
                    "asset_id": "stem",
                    "original_name": "stem.wav",
                    "outcome": "accepted",
                    "normalized_name": "stem.wav",
                    "compressed_bytes": 4,
                    "sha256": stem_sha256,
                    "uncompressed_bytes": 4,
                    "crc32": "00000000",
                    "compression_method": 0,
                    "reason": None,
                }
            ]
            append_event(run, "inspect", "completed")
            path = manifest.write(run / "run-manifest.json")
            loaded = RunManifest.load(path)
            self.assertEqual(loaded.data["schema_version"], MANIFEST_SCHEMA_VERSION)
            verified = loaded.verify_artifacts(run)
            self.assertEqual(verified.count(artifact.resolve()), 4)
            self.assertIn(extracted.resolve(), verified)
            self.assertIn((run / "events.jsonl").resolve(), verified)
            digest, byte_length = sha256_file(path)
            self.assertEqual(len(digest), 64)
            self.assertEqual(byte_length, path.stat().st_size)

    def test_declared_schemas_are_valid_json_and_match_runtime_versions(self) -> None:
        schema_dir = Path(__file__).parents[1] / "schemas"
        analysis = json.loads((schema_dir / "analysis-selection.v1.schema.json").read_text())
        manifest_forwarder = json.loads((schema_dir / "run-manifest.v1.schema.json").read_text())
        tempo_forwarder = json.loads((schema_dir / "tempo-approval.v1.schema.json").read_text())
        manifest = run_manifest_schema()
        tempo = tempo_approval_schema()
        self.assertEqual(
            analysis["properties"]["schema_version"]["const"],
            ANALYSIS_SELECTION_SCHEMA_VERSION,
        )
        self.assertIn("approved_by", analysis["required"])
        self.assertEqual(analysis["properties"]["approved_by"]["type"], "string")
        self.assertEqual(analysis["properties"]["approved_by"]["minLength"], 1)
        self.assertEqual(
            manifest["properties"]["schema_version"]["const"],
            MANIFEST_SCHEMA_VERSION,
        )
        self.assertEqual(
            manifest_forwarder["$ref"],
            "../src/opusloops_stem_calibration/schemas/run-manifest.v1.schema.json",
        )
        self.assertEqual(
            tempo_forwarder["$ref"],
            "../src/opusloops_stem_calibration/schemas/tempo-approval.v1.schema.json",
        )
        self.assertEqual(
            tempo["properties"]["schema_version"]["const"],
            "opusloops.tempo-approval.v1",
        )
        self.assertIn("beat_grid_reviewed", tempo["properties"]["confirmations"]["required"])

    def test_tempo_decision_contract_is_shared_with_run_manifest(self) -> None:
        approval = {
            "schema_version": "opusloops.tempo-approval.v1",
            "approval_id": "approval-1",
            "approved_at": "2026-09-05T12:34:56.000Z",
            "approved_by": "fixture-user",
            "notice": "No audio has been altered yet.",
            "upstream": {
                "analysis_artifact": "analysis.json",
                "analysis_sha256": _digest("a"),
                "reference_sha256": _digest("b"),
                "click_audition": {
                    "path": "click.wav",
                    "bytes": 1,
                    "sha256": _digest("c"),
                },
                "tempo_grid": {
                    "path": "grid.json",
                    "bytes": 1,
                    "sha256": _digest("d"),
                },
            },
            "decision": {
                "map_algorithm_version": "opusloops.shared-tempo-map.v1",
                "mode": "no-conform",
                "meter": {"numerator": 4, "denominator": 4},
                "first_downbeat_seconds": 0,
                "tempo_octave": "normal",
                "target_bpm": None,
                "sample_rate": 48_000,
                "total_source_frames": 100,
                "total_target_frames": 100,
                "anchors": [
                    {"source_frame": 0, "target_frame": 0, "kind": "user-bar"},
                    {"source_frame": 100, "target_frame": 100, "kind": "timeline-end"},
                ],
                "notes": "reviewed manual bar",
            },
            "confirmations": {
                "click_auditioned": True,
                "beat_grid_reviewed": True,
                "meter_and_first_downbeat_reviewed": True,
                "tempo_octave_reviewed": True,
                "flagged_regions_reviewed": True,
                "target_and_mode_reviewed": True,
                "shared_map_for_all_stems": True,
                "originals_unchanged": True,
            },
        }
        validate_tempo_approval_schema(approval)

        manifest = RunManifest.create(run_id="shared-tempo-contract")
        manifest.data["tempo_map"] = {
            "approval": {"path": "approval.json", "bytes": 1, "sha256": _digest("e")},
            "decision": approval["decision"],
        }
        manifest.validate()

        missing_notes = json.loads(json.dumps(approval))
        missing_notes["decision"].pop("notes")
        with self.assertRaisesRegex(ManifestError, "tempo approval schema validation.*notes"):
            validate_tempo_approval_schema(missing_notes)
        manifest.data["tempo_map"]["decision"] = missing_notes["decision"]
        with self.assertRaisesRegex(ManifestError, "run manifest schema validation"):
            manifest.validate()

    def test_run_manifest_runtime_schema_rejects_extra_and_wrong_types_on_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            extra = RunManifest.create(run_id="extra-field")
            extra.data["unexpected"] = True
            with self.assertRaisesRegex(ManifestError, "schema validation.*unexpected"):
                extra.write(run / "extra.json")

            wrong_type = RunManifest.create(run_id="wrong-type")
            wrong_type.data["audio_assets"] = "not-a-list"
            with self.assertRaisesRegex(ManifestError, "schema validation.*audio_assets"):
                wrong_type.write(run / "wrong-type.json")

    def test_run_manifest_runtime_schema_rejects_invalid_loaded_json(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "run-manifest.json"
            manifest = RunManifest.create(run_id="load-boundary")
            manifest.write(path)
            payload = load_json(path)
            payload["metrics"] = []
            atomic_write_json(path, payload)

            with self.assertRaisesRegex(ManifestError, "schema validation.*metrics"):
                RunManifest.load(path)


if __name__ == "__main__":
    unittest.main()
