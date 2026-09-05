from __future__ import annotations

import hashlib
import json
import os
import sys
import types
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest

import opusloops_stem_calibration.beat_tracker as beat_tracker_module
from opusloops_stem_calibration.beat_tracker import BeatThisAdapter, BeatTrackerError
from opusloops_stem_calibration.reference import ReferenceStem, build_reference, write_float32_file


class _Tensor:
    def __init__(self, values: list[float]) -> None:
        self._values = np.asarray(values, dtype=np.float32)

    def detach(self) -> _Tensor:
        return self

    def cpu(self) -> _Tensor:
        return self

    def numpy(self) -> np.ndarray:
        return self._values


def _build_reference(tmp_path: Path):
    source = tmp_path / "source.wav"
    write_float32_file(source, [0.1, -0.1] * 480)
    stem = ReferenceStem(
        asset_id="source",
        output_path=source,
        sample_rate=48_000,
        channels=2,
        frames=480,
        sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        canonical_format="wav-f32le-interleaved",
    )
    return build_reference([stem], tmp_path / "reference.wav", method="full-mix")


def _install_fake_beat_this(
    monkeypatch: pytest.MonkeyPatch,
    *,
    observe_signal: Callable[[np.ndarray], None],
    observe_checkpoint: Callable[[Path], None] | None = None,
    mutate_after_inference: Callable[[Path], None] | None = None,
    hub_dir: Path | None = None,
) -> None:
    class Audio2Frames:
        def __init__(self, **kwargs: object) -> None:
            self.checkpoint_path = Path(str(kwargs["checkpoint_path"]))
            if observe_checkpoint is not None:
                observe_checkpoint(self.checkpoint_path)

        def __call__(self, signal: np.ndarray, sample_rate: int) -> tuple[_Tensor, _Tensor]:
            assert sample_rate == 48_000
            observe_signal(np.asarray(signal).copy())
            if mutate_after_inference is not None:
                mutate_after_inference(self.checkpoint_path)
            return _Tensor([0.0, 1.0]), _Tensor([1.0, 0.0])

    class Postprocessor:
        def __init__(self, **kwargs: object) -> None:
            del kwargs

        def __call__(self, *args: object) -> tuple[list[float], list[float]]:
            del args
            return [0.0, 0.005], [0.0]

    torch = types.ModuleType("torch")
    torch.__version__ = "fixture-torch"
    torch.hub = types.SimpleNamespace(get_dir=lambda: str(hub_dir or Path.cwd()))
    package = types.ModuleType("beat_this")
    package.__path__ = []
    inference = types.ModuleType("beat_this.inference")
    inference.Audio2Frames = Audio2Frames
    model = types.ModuleType("beat_this.model")
    model.__path__ = []
    postprocessor = types.ModuleType("beat_this.model.postprocessor")
    postprocessor.Postprocessor = Postprocessor
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "beat_this", package)
    monkeypatch.setitem(sys.modules, "beat_this.inference", inference)
    monkeypatch.setitem(sys.modules, "beat_this.model", model)
    monkeypatch.setitem(sys.modules, "beat_this.model.postprocessor", postprocessor)
    monkeypatch.setattr(beat_tracker_module.importlib.metadata, "version", lambda name: "1.1.0")


def _checkpoint(tmp_path: Path) -> tuple[Path, str]:
    checkpoint = tmp_path / "checkpoint.ckpt"
    checkpoint.write_bytes(b"checkpoint")
    return checkpoint, hashlib.sha256(checkpoint.read_bytes()).hexdigest()


def test_beat_this_rejects_reference_changed_before_analysis(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    reference.output_path.write_bytes(b"x" * reference.bytes)
    analyzer_called = False

    def observe_signal(signal: np.ndarray) -> None:
        nonlocal analyzer_called
        del signal
        analyzer_called = True

    _install_fake_beat_this(monkeypatch, observe_signal=observe_signal)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)

    with pytest.raises(BeatTrackerError, match="hash changed"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert not analyzer_called


def test_beat_this_detects_reference_mutation_during_snapshot_consumption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    expected_first_sample = np.frombuffer(
        reference.output_path.read_bytes(), dtype="<f4", offset=reference.audio_data_offset_bytes
    )[0]
    observed_first_sample: float | None = None

    def observe_signal(signal: np.ndarray) -> None:
        nonlocal observed_first_sample
        observed_first_sample = float(signal[0, 0])
        reference.output_path.write_bytes(b"y" * reference.bytes)

    _install_fake_beat_this(monkeypatch, observe_signal=observe_signal)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)

    with pytest.raises(BeatTrackerError, match="snapshot was consumed"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert observed_first_sample == pytest.approx(float(expected_first_sample))
    assert not (tmp_path / "analysis" / "beat-this-logits.npy").exists()


def test_beat_this_binds_result_to_verified_reference_hash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    observed_shapes: list[tuple[int, ...]] = []
    checkpoint_paths: list[Path] = []
    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: observed_shapes.append(signal.shape),
        observe_checkpoint=lambda path: checkpoint_paths.append(path),
    )
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)

    result = BeatThisAdapter(
        checkpoint=str(checkpoint),
        expected_checkpoint_sha256=checkpoint_hash,
    ).analyze(reference, tmp_path / "analysis")

    assert observed_shapes == [(reference.frames, reference.channels)]
    assert len(checkpoint_paths) == 1
    assert checkpoint_paths[0] != checkpoint
    assert checkpoint_paths[0].name == "checkpoint.ckpt"
    assert not checkpoint_paths[0].exists()
    assert result.reference_sha256 == reference.sha256
    assert result.reference_frames == reference.frames
    assert result.checkpoint_sha256 == checkpoint_hash
    provenance = result.diagnostics["checkpoint_provenance"]
    assert provenance == {
        "resolution": "explicit-local-file",
        "original": {
            "bytes": len(b"checkpoint"),
            "sha256": checkpoint_hash,
            "identity_bound": True,
        },
        "snapshot": {
            "bytes": len(b"checkpoint"),
            "sha256": checkpoint_hash,
            "kind": "private-owned-temporary-copy",
            "identity_bound": True,
            "path_recorded": False,
        },
        "verification_points": [
            "before-model-load",
            "after-model-initialization",
            "after-inference",
        ],
    }
    durable_result = json.dumps(result.to_dict())
    assert str(checkpoint_paths[0]) not in durable_result
    assert str(checkpoint) not in durable_result
    assert (
        result.artifacts[0].sha256
        == hashlib.sha256((tmp_path / "analysis" / "beat-this-logits.npy").read_bytes()).hexdigest()
    )


def test_beat_this_requires_expected_checkpoint_hash_before_model_initialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, _ = _checkpoint(tmp_path)
    model_initialized = False

    def observe_checkpoint(path: Path) -> None:
        nonlocal model_initialized
        del path
        model_initialized = True

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=observe_checkpoint,
    )

    with pytest.raises(BeatTrackerError, match="requires an expected checkpoint SHA-256"):
        BeatThisAdapter(checkpoint=str(checkpoint)).analyze(reference, tmp_path / "analysis")

    assert not model_initialized


def test_beat_this_rejects_wrong_checkpoint_hash_before_model_initialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, _ = _checkpoint(tmp_path)
    model_initialized = False

    def observe_checkpoint(path: Path) -> None:
        nonlocal model_initialized
        del path
        model_initialized = True

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=observe_checkpoint,
    )

    with pytest.raises(BeatTrackerError, match="does not match the pinned expected hash"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256="0" * 64,
        ).analyze(reference, tmp_path / "analysis")

    assert not model_initialized
    assert not (tmp_path / "analysis" / "beat-this-logits.npy").exists()


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="symbolic links are unavailable")
def test_beat_this_rejects_symlink_checkpoint_before_model_initialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)
    checkpoint_link = tmp_path / "checkpoint-link.ckpt"
    checkpoint_link.symlink_to(checkpoint)
    model_initialized = False

    def observe_checkpoint(path: Path) -> None:
        nonlocal model_initialized
        del path
        model_initialized = True

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=observe_checkpoint,
    )

    with pytest.raises(BeatTrackerError, match="Beat This checkpoint"):
        BeatThisAdapter(
            checkpoint=str(checkpoint_link),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert not model_initialized


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot replace an open checkpoint")
def test_beat_this_rejects_original_checkpoint_path_substitution_during_model_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)

    def substitute_original(snapshot_path: Path) -> None:
        assert snapshot_path != checkpoint
        replacement = tmp_path / "replacement.ckpt"
        replacement.write_bytes(b"checkpoint")
        os.replace(replacement, checkpoint)

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=substitute_original,
    )

    with pytest.raises(BeatTrackerError, match="checkpoint source.*identity changed"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert not (tmp_path / "analysis" / "beat-this-logits.npy").exists()


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot replace an open checkpoint")
def test_beat_this_rejects_private_snapshot_substitution_during_model_init(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)
    snapshot_path: Path | None = None

    def substitute_snapshot(path: Path) -> None:
        nonlocal snapshot_path
        snapshot_path = path
        assert path.read_bytes() == b"checkpoint"
        replacement = path.parent / "replacement.ckpt"
        replacement.write_bytes(b"checkpoint")
        replacement.chmod(0o400)
        os.replace(replacement, path)

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=substitute_snapshot,
    )

    with pytest.raises(BeatTrackerError, match="private Beat This checkpoint snapshot.*changed"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert snapshot_path is not None
    assert not snapshot_path.exists()
    assert not (tmp_path / "analysis" / "beat-this-logits.npy").exists()


@pytest.mark.skipif(os.name == "nt", reason="Windows cannot replace an open checkpoint")
def test_beat_this_rechecks_private_snapshot_after_inference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    checkpoint, checkpoint_hash = _checkpoint(tmp_path)

    def substitute_snapshot(path: Path) -> None:
        replacement = path.parent / "replacement.ckpt"
        replacement.write_bytes(b"changed checkpoint")
        replacement.chmod(0o400)
        os.replace(replacement, path)

    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        mutate_after_inference=substitute_snapshot,
    )

    with pytest.raises(BeatTrackerError, match="private Beat This checkpoint snapshot.*changed"):
        BeatThisAdapter(
            checkpoint=str(checkpoint),
            expected_checkpoint_sha256=checkpoint_hash,
        ).analyze(reference, tmp_path / "analysis")

    assert not (tmp_path / "analysis" / "beat-this-logits.npy").exists()


def test_beat_this_resolves_final0_from_torch_hub_cache_without_loading_shortname(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reference = _build_reference(tmp_path)
    hub_dir = tmp_path / "torch-hub"
    cached_checkpoint = hub_dir / "checkpoints" / "beat_this-final0.ckpt"
    cached_checkpoint.parent.mkdir(parents=True)
    cached_checkpoint.write_bytes(b"cached checkpoint")
    checkpoint_hash = hashlib.sha256(cached_checkpoint.read_bytes()).hexdigest()
    loaded_paths: list[Path] = []
    _install_fake_beat_this(
        monkeypatch,
        observe_signal=lambda signal: None,
        observe_checkpoint=lambda path: loaded_paths.append(path),
        hub_dir=hub_dir,
    )

    result = BeatThisAdapter(
        checkpoint="final0",
        expected_checkpoint_sha256=checkpoint_hash,
    ).analyze(reference, tmp_path / "analysis")

    assert len(loaded_paths) == 1
    assert loaded_paths[0] != cached_checkpoint
    assert result.model == "final0"
    assert result.checkpoint_sha256 == checkpoint_hash
    assert result.diagnostics["checkpoint_provenance"]["resolution"] == (
        "torch-hub-shortname-cache"
    )
