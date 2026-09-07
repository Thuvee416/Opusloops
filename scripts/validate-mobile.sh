#!/usr/bin/env bash

set -euo pipefail

for required in index.html frame-guard.js styles.css pixel-dock.css pixel-dock.mjs grainient-mixer.css grainient-mixer.mjs REACT_BITS_LICENSE.md config.js cloud-client.js stem-import-core.js stem-player.js stem-import.js app.js manifest.webmanifest service-worker.js icons/icon-192.png icons/icon-512.png icons/apple-touch-icon.png; do
  if [[ ! -s "mobile/$required" ]]; then
    echo "Required mobile asset is missing or empty: mobile/$required" >&2
    exit 1
  fi
done

python3 - <<'PY'
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.has_viewport = False
        self.has_manifest = False
        self.local_assets = []
        self.ids = []
        self.dock_palettes = []
        self.pixel_canvases = 0

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if attributes.get("id"):
            self.ids.append(attributes["id"])
        if tag == "meta" and attributes.get("name", "").lower() == "viewport":
            self.has_viewport = True
        if tag == "link" and "manifest" in attributes.get("rel", "").lower().split():
            self.has_manifest = True
        if tag == "button" and "nav-item" in attributes.get("class", "").split():
            self.dock_palettes.append(attributes.get("data-pixel-card"))
        if tag == "canvas" and "pixel-canvas" in attributes.get("class", "").split():
            self.pixel_canvases += 1
        for attribute in ("href", "src"):
            value = attributes.get(attribute)
            if value:
                self.local_assets.append(value)


root = Path("mobile")
root_resolved = root.resolve()
index_path = root / "index.html"
manifest_path = root / "manifest.webmanifest"
service_worker_path = root / "service-worker.js"
cloud_client_path = root / "cloud-client.js"
stem_import_path = root / "stem-import.js"
stem_player_path = root / "stem-player.js"
pixel_dock_path = root / "pixel-dock.mjs"
pixel_dock_css_path = root / "pixel-dock.css"
grainient_mixer_path = root / "grainient-mixer.mjs"
grainient_mixer_css_path = root / "grainient-mixer.css"
react_bits_license_path = root / "REACT_BITS_LICENSE.md"
app_path = root / "app.js"
styles_path = root / "styles.css"


def local_path(reference, label):
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    if parsed.path.startswith("/"):
        raise SystemExit(
            f"{label}: production assets must use portable relative paths, got {reference!r}"
        )
    candidate = (root / unquote(parsed.path)).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise SystemExit(f"{label}: asset path escapes mobile/: {reference!r}")
    return candidate


parser = PageParser()
index_source = index_path.read_text(encoding="utf-8")
service_worker_source = service_worker_path.read_text(encoding="utf-8")
cloud_client_source = cloud_client_path.read_text(encoding="utf-8")
stem_import_source = stem_import_path.read_text(encoding="utf-8")
stem_player_source = stem_player_path.read_text(encoding="utf-8")
pixel_dock_source = pixel_dock_path.read_text(encoding="utf-8")
pixel_dock_css_source = pixel_dock_css_path.read_text(encoding="utf-8")
grainient_mixer_source = grainient_mixer_path.read_text(encoding="utf-8")
grainient_mixer_css_source = grainient_mixer_css_path.read_text(encoding="utf-8")
react_bits_license_source = react_bits_license_path.read_text(encoding="utf-8")
app_source = app_path.read_text(encoding="utf-8")
styles_source = styles_path.read_text(encoding="utf-8")
parser.feed(index_source)
if not parser.has_viewport:
    raise SystemExit(f"{index_path}: mobile viewport metadata is required")
if not parser.has_manifest:
    raise SystemExit(f"{index_path}: the PWA manifest must be linked")
duplicate_ids = sorted({value for value in parser.ids if parser.ids.count(value) > 1})
if duplicate_ids:
    raise SystemExit(f"{index_path}: duplicate element ids: {', '.join(duplicate_ids)}")
if parser.dock_palettes != ["create", "studio", "mix", "projects"]:
    raise SystemExit(f"{index_path}: all four dock buttons need distinct PixelCard palettes")
if parser.pixel_canvases != 4:
    raise SystemExit(f"{index_path}: each dock button needs its own PixelCard canvas")

for asset in (
    "frame-guard.js",
    "styles.css",
    "pixel-dock.css",
    "pixel-dock.mjs",
    "grainient-mixer.css",
    "grainient-mixer.mjs",
    "config.js",
    "cloud-client.js",
    "stem-import-core.js",
    "stem-player.js",
    "stem-import.js",
    "app.js",
):
    pattern = re.compile(rf"\./{re.escape(asset)}\?v=(\d+)")
    index_match = pattern.search(index_source)
    worker_match = pattern.search(service_worker_source)
    if not index_match or not worker_match or index_match.group(1) != worker_match.group(1):
        raise SystemExit(
            f"{asset}: index and service-worker asset versions must exist and match"
        )

if 'matchMedia("(prefers-reduced-motion: reduce)")' not in pixel_dock_source:
    raise SystemExit(f"{pixel_dock_path}: reduced-motion handling is required")
if "ResizeObserver" not in pixel_dock_source or "requestAnimationFrame" not in pixel_dock_source:
    raise SystemExit(f"{pixel_dock_path}: responsive canvas animation is required")
if "gradient(" in pixel_dock_css_source:
    raise SystemExit(f"{pixel_dock_css_path}: gradient dock styling must not return")
if "gap: 0" not in pixel_dock_css_source or "border-radius: 0" not in pixel_dock_css_source:
    raise SystemExit(f"{pixel_dock_css_path}: dock segments must remain edge-to-edge")
for retired_path in (
    "color-bends.css",
    "color-bends.mjs",
    "vendor/three.core.min.js",
    "vendor/three.module.min.js",
    "vendor/three.LICENSE.txt",
    "vendor/README.md",
):
    if (root / retired_path).exists():
        raise SystemExit(f"{root / retired_path}: retired ColorBends asset must be removed")
if "color-bends" in index_source.lower() or "color_bends" in service_worker_source.lower():
    raise SystemExit("ColorBends wiring must not remain in the mobile app shell")

if index_source.count('class="mixer-grainient-canvas"') != 1:
    raise SystemExit(f"{index_path}: the mixer must use exactly one shared Grainient canvas")
for token in (
    'getContext("webgl2"',
    "gl.viewport(",
    "gl.scissor(",
    "uViewportOrigin",
    "roundedMask",
    'matchMedia("(prefers-reduced-motion: reduce)")',
    "IntersectionObserver",
    'document.addEventListener("visibilitychange"',
    'this.canvas.addEventListener("webglcontextlost"',
    'this.canvas.addEventListener("webglcontextrestored"',
    "MAX_DEVICE_PIXEL_RATIO = 1.25",
):
    if token not in grainient_mixer_source:
        raise SystemExit(f"{grainient_mixer_path}: shared mobile Grainient requirement is missing: {token}")
for token in (
    ".mixer-grainient-canvas",
    "pointer-events: none",
    "@media (forced-colors: active)",
    'data-grainient-state="fallback"',
):
    if token not in grainient_mixer_css_source:
        raise SystemExit(f"{grainient_mixer_css_path}: Grainient presentation requirement is missing: {token}")
for token in ("data-grainient-mixer", "grainient-mixer.mjs?v=1", "grainient-mixer.css?v=1"):
    if token not in index_source:
        raise SystemExit(f"{index_path}: Grainient mixer wiring is missing: {token}")
for token in ("tile.dataset.mixColor", "tile.dataset.mixIndex", "tile.dataset.mixLevel", "tile.dataset.mixMuted"):
    if token not in app_source:
        raise SystemExit(f"{app_path}: live Grainient mixer metadata is missing: {token}")
if "Grainient" not in react_bits_license_source:
    raise SystemExit(f"{react_bits_license_path}: Grainient attribution is required")

for token in (
    "function createMixerTile",
    "function mixerPercentFromDrag",
    'slider.type = "range"',
    'slider.setAttribute("aria-orientation", "vertical")',
    "activateMixerTile(tile);",
    'window.addEventListener("pointermove", moveMixerDrag, { passive: false })',
    'window.addEventListener("pointerup", finishMixerDrag)',
    "Window-level listeners keep the drag alive when capture is unavailable.",
    'stemPlayer?.setMix(track.assetId, track.volume, track.muted)',
):
    if token not in app_source:
        raise SystemExit(f"{app_path}: mobile tile mixer requirement is missing: {token}")
for token in (
    "grid-template-columns: repeat(2, minmax(0, 1fr))",
    ".mixer-tile.is-active .mixer-gesture",
    "touch-action: none",
    "@keyframes mixer-wave",
    "animation: none !important",
):
    if token not in styles_source:
        raise SystemExit(f"{styles_path}: responsive mixer presentation is missing: {token}")
if "data-mixer-step" in app_source or "mixer-step-button" in styles_source:
    raise SystemExit("Mixer step buttons must not return; level changes are direct drag controls")

for token in (
    "context.createBufferSource()",
    "context.createGain()",
    "source.start(launch.when",
    "source.playbackRate.value = rateCorrection",
    "scheduleEdgeEnvelope(envelope.gain, when",
    "setTargetAtTime(bounded, now, MIX_RAMP_SECONDS)",
    "pending.get(segment.index)",
    "runBounded(async (signal) =>",
    "PREVIEW_FETCH_TIMEOUT_MS",
    "raceWithAbort(() => work.callback(controller.signal)",
    "MAX_ESTIMATED_SEGMENT_BYTES",
    "MAX_RESIDENT_DECODED_BYTES",
    "decodedReservations.set(segment.index, { bytes: required, requestId, token })",
    "if (context.state !== \"running\")",
    "releaseBuffers",
    "const lateBy = Math.max(0, context.currentTime - plannedWhen)",
    "fillLookahead(segment, requestId)",
    "MAX_PREVIEW_BYTES",
    "validateSegments(project, segments)",
):
    if token not in stem_player_source:
        raise SystemExit(f"{stem_player_path}: synchronized Web Audio stem playback is missing: {token}")
if "new Audio(" in stem_player_source or "audio.volume" in stem_player_source:
    raise SystemExit(f"{stem_player_path}: iPhone-incompatible HTML media mixing must not return")
for token in (
    "const externalSignal = options?.signal",
    'signal: requestOptions.signal',
    "requestOptions.timeoutMs || 15000",
):
    if token not in cloud_client_source:
        raise SystemExit(f"{cloud_client_path}: cancellable private preview signing is missing: {token}")
for token in (
    'dom.stemStudio.dataset.density = stem.tracks.length > 6 ? "compact" : "comfortable"',
    'dom.stemStudio.dataset.columns = stem.tracks.length > 10 ? "3" : stem.tracks.length > 6 ? "2" : "1"',
    '#view-studio.is-large-stem-project',
    '.stem-studio[data-density="compact"] .stem-arrangement',
    'repeat(var(--studio-columns, 2), minmax(0, 1fr))',
    '.stem-studio[data-columns="3"] .stem-arrangement',
    'arrangementScrollFrame = window.requestAnimationFrame',
    'min-height: 44px',
    "width: calc(100% - 104px)",
    'if (playing || playbackStarting) stopPlayback({ fade: false, resetPosition: false })',
    "stemPlayer?.releaseBuffers()",
):
    if token not in f"{app_source}\n{styles_source}":
        raise SystemExit(f"Large-project Studio layout requirement is missing: {token}")

for reference in parser.local_assets:
    asset_path = local_path(reference, index_path)
    if asset_path is None:
        continue
    if not asset_path.is_file():
        raise SystemExit(f"{index_path}: referenced asset is missing: {asset_path}")

upload_return = cloud_client_source.index("return { bytesUploaded: file.size, uploadUrl };")
resume_clear = cloud_client_source.index("function forgetStemArchiveUpload")
if resume_clear < upload_return:
    raise SystemExit(f"{cloud_client_path}: completed TUS state must survive until API finalization")
finalize_call = stem_import_source.index("await cloud.finalizeStemUpload")
resume_forget = stem_import_source.index("cloud.forgetStemArchiveUpload", finalize_call)
if resume_forget < finalize_call:
    raise SystemExit(f"{stem_import_path}: TUS state must clear only after finalization succeeds")

proposal_regions_start = stem_import_source.index("function proposalRegions()")
proposal_regions_end = stem_import_source.index("function renderRegions()", proposal_regions_start)
proposal_regions_source = stem_import_source[proposal_regions_start:proposal_regions_end]
canonical_regions = proposal_regions_source.index("job?.regions")
raw_document_regions = proposal_regions_source.index("proposalDocument?.decision?.regions")
if canonical_regions > raw_document_regions:
    raise SystemExit(f"{stem_import_path}: Gate B must prefer canonical job regions")

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
for field in ("name", "short_name", "start_url", "display", "icons"):
    if not manifest.get(field):
        raise SystemExit(f"{manifest_path}: missing required PWA field {field!r}")
if manifest["name"] != "Opusloops" or manifest["short_name"] != "Opusloops":
    raise SystemExit(f"{manifest_path}: PWA name and short_name must both be Opusloops")

for field in ("id", "start_url", "scope"):
    value = manifest.get(field)
    if value != "./":
        raise SystemExit(
            f"{manifest_path}: {field} must be './' for origin-portable hosting, got {value!r}"
        )

for icon in manifest["icons"]:
    source = icon.get("src", "").split("?", 1)[0].split("#", 1)[0]
    icon_path = local_path(source, manifest_path) if source else None
    if icon_path is None:
        raise SystemExit(f"{manifest_path}: icons must use relative local paths, got {source!r}")
    if not icon_path.is_file() or icon_path.stat().st_size == 0:
        raise SystemExit(f"{manifest_path}: referenced icon is missing: {icon_path}")
PY

node --check mobile/app.js
node --check mobile/pixel-dock.mjs
node --check mobile/grainient-mixer.mjs
node --check mobile/config.js
node --check mobile/cloud-client.js
node --check mobile/stem-import-core.js
node --check mobile/stem-player.js
node --check mobile/stem-import.js
node --check mobile/frame-guard.js
node --check mobile/service-worker.js
node --check supabase/functions/create-opusloops-account/handler.mjs
node --check supabase/functions/create-opusloops-account/policy.mjs
node --check supabase/functions/stem-import/aws-dispatch.mjs
node --check supabase/functions/stem-import/storage-credential.mjs
node --test \
  supabase/functions/create-opusloops-account/handler.test.mjs \
  supabase/functions/create-opusloops-account/policy.test.mjs \
  supabase/functions/stem-import/aws-dispatch.test.mjs \
  supabase/functions/stem-import/storage-credential.test.mjs
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { DOCK_PIXEL_PALETTES } from './mobile/pixel-dock.mjs';

assert.deepEqual(Object.keys(DOCK_PIXEL_PALETTES), ['create', 'studio', 'mix', 'projects']);
const signatures = Object.values(DOCK_PIXEL_PALETTES).map((palette) => palette.colors.join(','));
assert.equal(new Set(signatures).size, 4, 'every dock button must use a different pixel palette');
Object.values(DOCK_PIXEL_PALETTES).forEach((palette) => {
  assert.ok(palette.speed > 0, 'every PixelCard palette must animate');
  assert.ok(palette.gap >= 3, 'PixelCard gap must remain usable at dock scale');
  assert.equal(palette.colors.length, 3);
});
NODE

node <<'NODE'
const assert = require('node:assert/strict');
const core = require('./mobile/stem-import-core.js');

assert.equal(core.normalizeStatus('analysis-ready-for-review'), 'awaiting_map_request');
assert.equal(core.statusLabel('analyzing'), 'Analyzing musical timing');
assert.equal(core.statusBadgeLabel('inspect_queued'), 'Live');
assert.equal(core.statusBadgeLabel('awaiting_tempo_confirmation'), 'Needs you');
assert.equal(core.statusBadgeLabel('ready'), 'Complete');
assert.equal(core.statusBadgeLabel('failed'), 'Stopped');
assert.equal(core.statusBadgeLabel('cancelled'), 'Stopped');
assert.equal(core.statusBadgeLabel('deleted'), 'Removed');
assert.equal(core.statusBadgeLabel('unexpected_state'), 'Status');
assert.equal(core.canRetryInspection({
  status: 'failed', error_code: 'batch_bootstrap_failed'
}), true);
assert.equal(core.canRetryInspection({
  status: 'failed', error_code: 'batch_queue_timeout'
}), true);
assert.equal(core.canRetryInspection({
  status: 'failed', error_code: 'internal_worker_error'
}), false);
assert.equal(core.canRetryInspection({
  status: 'inspecting', error_code: 'batch_bootstrap_failed'
}), false);
const failedProposalEvents = [
  { sequence: 4, stage: 'inspect', status: 'failed' },
  { sequence: 12, stage: 'propose', status: 'failed' }
];
assert.equal(core.canRetryProposal({
  status: 'failed', error_code: 'callback_failed'
}, failedProposalEvents), true);
assert.equal(core.canRetryProposal({
  status: 'failed', error_code: 'callback_failed'
}, [...failedProposalEvents, { sequence: 13, stage: 'render', status: 'failed' }]), false);
assert.equal(core.canRetryProposal({
  status: 'failed', error_code: 'internal_worker_error'
}, failedProposalEvents), false);
assert.equal(core.canRetryProposal({
  status: 'proposing', error_code: 'callback_failed'
}, failedProposalEvents), false);
const failedRenderEvents = [
  { sequence: 12, stage: 'propose', status: 'completed' },
  { sequence: 20, stage: 'render', status: 'failed' }
];
assert.equal(core.canRepairRenderProposal({
  status: 'failed',
  error_code: 'tempo_map_preroll_invalid',
  proposal_manifest_sha256: 'a'.repeat(64)
}, failedRenderEvents), true);
assert.equal(core.canRepairRenderProposal({
  status: 'failed',
  error_code: 'tempo_map_preroll_invalid',
  proposal_manifest_sha256: 'a'.repeat(64)
}, [...failedRenderEvents, { sequence: 21, stage: 'propose', status: 'failed' }]), false);
assert.equal(core.canRepairRenderProposal({
  status: 'failed',
  error_code: 'calibration_stage_failed',
  proposal_manifest_sha256: 'a'.repeat(64)
}, failedRenderEvents), false);
assert.equal(core.canRepairRenderProposal({
  status: 'failed', error_code: 'tempo_map_preroll_invalid'
}, failedRenderEvents), false);
assert.equal(core.canRetryRender({
  status: 'failed',
  error_code: 'canonical_wav_extensible_unsupported',
  proposal_manifest_sha256: 'a'.repeat(64),
  tempo_approval_sha256: 'b'.repeat(64),
  gate_b_approved_at: '2026-09-06T21:25:51Z'
}, failedRenderEvents), true);
assert.equal(core.canRetryRender({
  status: 'failed',
  error_code: 'calibration_stage_failed',
  proposal_manifest_sha256: 'a'.repeat(64),
  tempo_approval_sha256: 'b'.repeat(64),
  gate_b_approved_at: '2026-09-06T21:25:51Z'
}, failedRenderEvents), false);
assert.equal(core.canRetryRender({
  status: 'failed',
  error_code: 'canonical_wav_extensible_unsupported',
  proposal_manifest_sha256: 'a'.repeat(64),
  tempo_approval_sha256: 'b'.repeat(64),
  gate_b_approved_at: '2026-09-06T21:25:51Z'
}, [...failedRenderEvents, { sequence: 21, stage: 'propose', status: 'failed' }]), false);
assert.equal(core.canRetryRender({
  status: 'failed',
  error_code: 'canonical_wav_extensible_unsupported',
  proposal_manifest_sha256: 'a'.repeat(64),
  gate_b_approved_at: '2026-09-06T21:25:51Z'
}, failedRenderEvents), false);
assert.equal(core.eventProgress({ determinate: false, completed: 1, total: 2 }), null);
assert.deepEqual(
  core.eventProgress({ determinate: true, completed: 3, total: 4, unit: 'files' }),
  { completed: 3, total: 4, unit: 'files', percent: 75 }
);
assert.equal(core.proposalRequest(120, 'musical-4bar').targetBpm, 120);
assert.equal(core.proposalRequest(120, 'no-conform').targetBpm, null);
assert.throws(() => core.proposalRequest(10, 'rigid-beat'), /20 to 400/);
assert.equal(core.normalizeRegion({ targetBpm: null }).targetBpm, null);
assert.deepEqual(core.editedRegions([{
  id: 'region-1', startBar: 1, endBar: 4, localBpm: 109.25,
  targetBpm: null, flagged: false
}]), [{
  id: 'region-1', startBar: 1, endBar: 4, localBpm: 109.25,
  targetBpm: null, flagged: false
}]);
const job = core.normalizeJob({
  id: 'job', project_id: 'project', status: 'awaiting_analysis_confirmation', revision: 2,
  source_name: 'song.zip', inspection: { audio_assets: [{ asset_id: 'drums', original_name: 'Drums.wav', role: 'drums' }] }
});
assert.equal(job.projectId, 'project');
assert.equal(job.tracks[0].name, 'Drums.wav');
assert.equal(core.analysisSelection(job).assets[0].role, 'drums');
assert.equal(core.normalizeJob({ target_bpm: null, mode: 'no-conform' }).targetBpm, null);
const analyzedNoConformJob = core.normalizeJob({
  id: 'no-conform-job', project_id: 'no-conform-project', source_name: 'free-time.zip',
  target_bpm: null, mode: 'no-conform',
  analysis: { median_bpm: 107.143, duration_seconds: 184.25 }
});
assert.equal(analyzedNoConformJob.durationSeconds, 184.25);
const analyzedNoConformProject = core.toStemProject(analyzedNoConformJob);
assert.equal(analyzedNoConformProject.tempo, 107.143);
assert.equal(analyzedNoConformProject.stemImport.durationSeconds, 184.25);
const fullMixSelection = core.analysisSelection(job, [
  { ...job.tracks[0], included: true },
  { assetId: 'mix', name: 'Mix.wav', role: 'full-mix', included: true, gainDb: 0 }
], 'full-mix');
assert.deepEqual(fullMixSelection.assets.map((item) => item.included), [false, true]);
assert.equal(fullMixSelection.fullMixAssetId, 'mix');
assert.equal(fullMixSelection.drumCrosscheckAssetId, null);
assert.deepEqual(
  core.normalizeDisabledSegments({ drums: [4, 2, 2, -1], unknown: [1] }, [job.tracks[0]]),
  { drums: [2, 4] }
);
const asset = core.normalizeAsset({
  asset_id: 'preview', kind: 'preview_segment', content_type: 'audio/mp4',
  metadata: { trackAssetId: 'drums', regionIndex: 4, durationSeconds: 8 }
});
assert.equal(asset.trackId, 'drums');
assert.equal(asset.segmentIndex, 4);
assert.equal(asset.durationSeconds, 8);

const events = (times, downbeats = []) => {
  const downbeatSet = new Set(downbeats.map(String));
  return times.map((time, index) => ({
    id: `beat-${index + 1}`,
    time,
    downbeat: downbeatSet.has(String(time))
  }));
};
const cleanGrid = events(
  Array.from({ length: 13 }, (_, index) => index * 0.5),
  [0, 2, 4, 6]
);
assert.deepEqual(core.timingGridDiagnostics(cleanGrid, {
  meterNumerator: 4, firstDownbeatSeconds: 0
}).messages, []);
assert.deepEqual(core.autoRepairTimingGrid(cleanGrid, { meterNumerator: 4 }), {
  status: 'clean',
  events: cleanGrid,
  summary: {
    algorithm: 'opusloops-bar-grid-v1', removedBeats: 0, insertedBeats: 0,
    downbeatCorrections: 0, totalEdits: 0, estimatedBpm: 120, reason: ''
  }
});
for (const invalidTime of [null, '', false, true, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
  const malformedGrid = cleanGrid.map((event) => ({ ...event }));
  malformedGrid[0].time = invalidTime;
  assert.ok(core.timingGridDiagnostics(malformedGrid, { meterNumerator: 4 }).messages.length > 0);
  assert.equal(core.autoRepairTimingGrid(malformedGrid, { meterNumerator: 4 }).status, 'ambiguous');
}
assert.equal(core.timingSeconds('0'), null);
assert.equal(core.timingSeconds(0), 0);

const productionExcerpt = events([
  107.42, 107.96, 108.56, 109.02, 109.12, 109.68, 110.12, 110.24,
  110.66, 111.22, 111.76, 112.34, 112.88, 113.44, 113.98, 114.26,
  114.54, 115.08, 115.62, 116.18, 116.72
], [107.96, 110.12, 110.24, 112.34, 114.54, 116.72]);
const productionSnapshot = JSON.stringify(productionExcerpt);
const repairedExcerpt = core.autoRepairTimingGrid(productionExcerpt, { meterNumerator: 4 });
assert.equal(repairedExcerpt.status, 'repaired');
assert.deepEqual(repairedExcerpt.events.map((event) => event.time), [
  107.42, 107.96, 108.56, 109.02, 109.68, 110.12, 110.66, 111.22,
  111.76, 112.34, 112.88, 113.44, 113.98, 114.54, 115.08, 115.62,
  116.18, 116.72
]);
assert.deepEqual(repairedExcerpt.events.filter((event) => event.downbeat).map((event) => event.time),
  [107.96, 110.12, 112.34, 114.54, 116.72]);
assert.equal(JSON.stringify(productionExcerpt), productionSnapshot, 'repair must not mutate model output');
assert.deepEqual(
  core.autoRepairTimingGrid(productionExcerpt, { meterNumerator: 4 }),
  repairedExcerpt,
  'repair output must be deterministic'
);

const productionGrid = require('./scripts/fixtures/timing-grid-anomaly.json');
const productionDownbeats = new Set(productionGrid.downbeats_seconds.map(String));
const productionEvents = productionGrid.beats_seconds.map((time, index) => ({
  id: `production-beat-${index + 1}`,
  time,
  downbeat: productionDownbeats.has(String(time))
}));
const repairedProductionGrid = core.autoRepairTimingGrid(productionEvents, { meterNumerator: 4 });
assert.equal(repairedProductionGrid.status, 'repaired');
assert.equal(repairedProductionGrid.events.length, 328);
assert.equal(repairedProductionGrid.events.filter((event) => event.downbeat).length, 82);
assert.deepEqual(repairedProductionGrid.summary, {
  algorithm: 'opusloops-bar-grid-v1', removedBeats: 3, insertedBeats: 2,
  downbeatCorrections: 1, totalEdits: 6, estimatedBpm: 107.14285714285806, reason: ''
});
assert.deepEqual(
  productionEvents.filter((event) => !new Set(repairedProductionGrid.events.map((item) => item.id)).has(event.id))
    .map((event) => event.time),
  [109.12, 110.24, 114.26]
);
assert.deepEqual(
  repairedProductionGrid.events.filter((event) => event.id.startsWith('auto-')).map((event) => event.time),
  [99.675, 179.5]
);
assert.deepEqual(core.timingGridDiagnostics(repairedProductionGrid.events, {
  meterNumerator: 4,
  firstDownbeatSeconds: repairedProductionGrid.events.find((event) => event.downbeat).time,
  minimumDownbeats: 5
}).messages, []);

const missingBeatExcerpt = events([
  96.88, 97.42, 98, 98.56, 99.12, 100.26, 100.82, 101.34,
  101.86, 102.46, 103, 103.52
], [96.88, 99.12, 101.34, 103.52]);
const repairedMissingBeat = core.autoRepairTimingGrid(missingBeatExcerpt, { meterNumerator: 4 });
assert.equal(repairedMissingBeat.status, 'repaired');
assert.ok(repairedMissingBeat.events.some((event) => event.time === 99.675));

const tailExcerpt = events([
  173.96, 174.54, 175.1, 175.64, 176.18, 176.72, 177.28, 177.84,
  178.4, 178.94, 180.06
], [173.96, 176.18, 178.4, 180.06]);
const repairedTail = core.autoRepairTimingGrid(tailExcerpt, { meterNumerator: 4 });
assert.equal(repairedTail.status, 'repaired');
assert.ok(repairedTail.events.some((event) => event.time === 179.5));
assert.equal(repairedTail.events.find((event) => event.time === 180.06).downbeat, false);

const threeFour = events([0, 0.5, 1, 1.5, 2, 2.5, 3], [0, 1.5, 3]);
assert.equal(core.autoRepairTimingGrid(threeFour, { meterNumerator: 3 }).status, 'clean');
const ambiguousDownbeat = events(
  [0, 0.5, 1, 1.5, 2, 2.2, 2.7, 3.2, 3.7, 4.2],
  [0, 2, 2.2, 4.2]
);
assert.equal(core.autoRepairTimingGrid(ambiguousDownbeat, { meterNumerator: 4 }).status, 'ambiguous');
const tooManyMissing = events([0, 2, 2.5, 3, 3.5, 4], [0, 2, 4]);
assert.equal(core.autoRepairTimingGrid(tooManyMissing, { meterNumerator: 4 }).status, 'ambiguous');
const oneFrameApart = events(
  [0, 0.49, 0.53, 1, 1.5, 2, 2.5, 3, 3.5, 4],
  [0, 2, 4]
);
assert.equal(core.autoRepairTimingGrid(oneFrameApart, { meterNumerator: 4 }).status, 'ambiguous');
const oneBarStart = events(
  Array.from({ length: 21 }, (_, index) => index * 0.5),
  [0]
);
assert.equal(core.autoRepairTimingGrid(oneBarStart, { meterNumerator: 4 }).status, 'ambiguous');
assert.deepEqual(core.timingGridDiagnostics(oneBarStart, {
  meterNumerator: 4,
  firstDownbeatSeconds: 0,
  minimumDownbeats: 1,
  requireFullDownbeatCoverage: false
}).messages, []);
const missingRigidBeat = events([0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5], [0]);
assert.match(core.timingGridDiagnostics(missingRigidBeat, {
  meterNumerator: 4,
  firstDownbeatSeconds: 0,
  minimumDownbeats: 1,
  requireFullDownbeatCoverage: false,
  requireStableBeatContinuity: true
}).messages.join(' '), /likely beat is missing/i);
assert.deepEqual(core.timingGridDiagnostics(missingRigidBeat, {
  meterNumerator: 4,
  firstDownbeatSeconds: 0,
  minimumDownbeats: 1,
  requireFullDownbeatCoverage: false,
  requireStableBeatContinuity: false
}).messages, []);
const partialBarStarts = events(
  Array.from({ length: 41 }, (_, index) => index * 0.5),
  [0, 2, 4, 6, 8]
);
assert.equal(core.autoRepairTimingGrid(partialBarStarts, { meterNumerator: 4 }).status, 'ambiguous');
assert.ok(core.timingGridDiagnostics(partialBarStarts, { meterNumerator: 4 })
  .messages.includes('Detected bar starts do not cover the full song.'));
assert.ok(core.timingGridDiagnostics(cleanGrid, { meterNumerator: 4, minimumDownbeats: 5 })
  .messages.includes('At least 5 reliable bar starts are required.'));
const oversizedGrid = Array.from({ length: 20_001 }, (_, index) => ({
  id: `oversized-${index}`,
  time: index * 0.5,
  downbeat: index % 4 === 0
}));
assert.match(core.autoRepairTimingGrid(oversizedGrid, { meterNumerator: 4 }).summary.reason, /too large/i);

const excessiveEdits = [];
for (let index = 0; index <= 40; index += 1) {
  excessiveEdits.push({ id: `regular-${index}`, time: index * 0.5, downbeat: index % 4 === 0 });
  if (index % 4 === 1 && index < 36) {
    excessiveEdits.push({ id: `extra-${index}`, time: index * 0.5 + 0.18, downbeat: false });
  }
}
assert.equal(core.autoRepairTimingGrid(excessiveEdits, { meterNumerator: 4 }).status, 'ambiguous');
NODE

node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { window: { OpusloopsStemCore: require('./mobile/stem-import-core.js') } };
vm.runInNewContext(fs.readFileSync('./mobile/stem-import.js', 'utf8'), context);
const advance = context.window.OpusloopsStemImport.advanceAuditionListening;
const selectArtifact = context.window.OpusloopsStemImport.selectArtifact;

let progress = advance();
progress = advance(progress, { currentTime: 0, playing: true, seeking: false });
progress = advance(progress, { currentTime: 0.15, playing: true, seeking: false });
assert.equal(progress.complete, false, 'brief playback must not satisfy the listening gate');
const heardBeforeSeek = progress.listenedSeconds;
progress = advance(progress, { currentTime: 12, playing: true, seeking: true });
assert.equal(progress.listenedSeconds, heardBeforeSeek, 'seeking must not count as listening');
assert.equal(progress.complete, false, 'seeking forward must not unlock Gate B');
progress = advance(progress, { currentTime: 12, playing: true, seeking: false });
progress = advance(progress, { currentTime: 12.11, playing: true, seeking: false });
assert.equal(progress.complete, true, 'actual forward playback may complete the listening gate');

const oldProposal = { id: 'old', kind: 'proposal_manifest', variant: 'proposal-old', content_type: 'application/json' };
const currentProposal = { id: 'current', kind: 'proposal_manifest', variant: 'proposal-current', content_type: 'application/json' };
assert.equal(
  selectArtifact([oldProposal, currentProposal], /proposal_manifest/i, 'json', 'proposal-current').id,
  'current',
  'a repaired job must select artifacts for its current proposal id'
);
assert.equal(
  selectArtifact([oldProposal], /proposal_manifest/i, 'json', 'proposal-current'),
  undefined,
  'the old proposal must never substitute for a current repaired proposal'
);
NODE

node <<'NODE'
const assert = require('node:assert/strict');

class FakeParam {
  constructor(value = 1) {
    this.value = value;
    this.events = [];
  }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push(['set', value, time]);
  }
  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.events.push(['target', value, time, constant]);
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push(['linear', value, time]);
  }
}

class FakeNode {
  constructor() {
    this.connections = [];
    this.disconnected = false;
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() { this.disconnected = true; }
}

class FakeGain extends FakeNode {
  constructor() {
    super();
    this.gain = new FakeParam(1);
  }
}

class FakeCompressor extends FakeNode {
  constructor() {
    super();
    this.threshold = new FakeParam();
    this.knee = new FakeParam();
    this.ratio = new FakeParam();
    this.attack = new FakeParam();
    this.release = new FakeParam();
  }
}

class FakeSource extends FakeNode {
  constructor(context) {
    super();
    this.context = context;
    this.buffer = null;
    this.playbackRate = new FakeParam(1);
    this.starts = [];
    this.stopped = false;
  }
  start(...args) {
    this.starts.push(args);
    this.context.started.push(this);
  }
  stop() { this.stopped = true; }
}

class FakeAudioContext {
  static instances = [];
  constructor() {
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = new FakeNode();
    this.gains = [];
    this.sources = [];
    this.started = [];
    this.decodeCount = 0;
    FakeAudioContext.instances.push(this);
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createDynamicsCompressor() { return new FakeCompressor(); }
  createBufferSource() {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }
  decodeAudioData(_bytes, success) {
    this.decodeCount += 1;
    const buffer = { duration: this.decodeCount % 2 ? 4.005333 : 3.989333 };
    success?.(buffer);
    return Promise.resolve(buffer);
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  addEventListener() {}
}

let intervalHandler = null;
global.window = {
  OpusloopsStemCore: require('./mobile/stem-import-core.js'),
  AudioContext: FakeAudioContext,
  fetch: async () => ({
    ok: true,
    status: 200,
    headers: { get: () => '16' },
    arrayBuffer: async () => new ArrayBuffer(16)
  }),
  setTimeout,
  clearTimeout,
  setInterval(handler) {
    intervalHandler = handler;
    return 1;
  },
  clearInterval() { intervalHandler = null; }
};
require('./mobile/stem-player.js');

const signedAssetIds = [];
const cloud = {
  async signStemArtifact(_jobId, assetId) {
    signedAssetIds.push(assetId);
    return {
      signedUrl: `https://audio.example/${assetId}.m4a`,
      expiresAt: new Date(Date.now() + 900_000).toISOString()
    };
  }
};
const project = {
  id: 'project',
  stemImport: {
    jobId: 'job',
    status: 'ready',
    durationSeconds: 16,
    tracks: [
      { assetId: 'stem-a', volume: 1, muted: false },
      { assetId: 'stem-b', volume: 1, muted: false }
    ],
    arrangement: {},
    previewAssets: Array.from({ length: 4 }, (_, segmentIndex) => ['stem-a', 'stem-b'].map((trackId) => ({
      id: `segment-${segmentIndex}-${trackId}`,
      kind: 'preview_segment',
      contentType: 'audio/mp4',
      trackId,
      segmentIndex,
      startSeconds: segmentIndex * 4,
      durationSeconds: 4
    }))).flat()
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  const player = window.OpusloopsStemPlayer.create({ cloud });
  player.loadProject(project);
  assert.equal(FakeAudioContext.instances.length, 0, 'loading project metadata must not allocate audio memory');
  await player.play(0);
  await settle();
  assert.deepEqual(signedAssetIds, [
    'segment-0-stem-a', 'segment-0-stem-b',
    'segment-1-stem-a', 'segment-1-stem-b'
  ]);
  const context = FakeAudioContext.instances[0];
  assert.equal(context.started.length, 4, 'current and successor segments must be decoded and scheduled once');
  assert.deepEqual(context.started.slice(0, 2).map((source) => source.starts[0][0]), [0.08, 0.08],
    'every stem in a segment must share one sample clock start');
  assert.deepEqual(context.started.slice(2, 4).map((source) => source.starts[0][0]), [4.08, 4.08],
    'the successor must be scheduled without an ended-event restart');
  context.started.forEach((source) => {
    const [when, offset, bufferDuration] = source.starts[0];
    assert.equal(offset, 0);
    assert.ok(Math.abs(bufferDuration / source.playbackRate.value - 4.008) < 1e-9,
      `AAC timing correction must retain the short boundary overlap at ${when}`);
  });

  const stemAEnvelope = context.started[0].connections[0];
  const stemBEnvelope = context.started[1].connections[0];
  const stemAGain = stemAEnvelope.connections[0];
  const stemBGain = stemBEnvelope.connections[0];
  assert.notEqual(stemAGain, stemBGain, 'each stem needs an independent persistent gain');
  assert.deepEqual(stemAEnvelope.gain.events.slice(-4), [
    ['set', 0, 0.08],
    ['linear', 1, 0.088],
    ['set', 1, 4.08],
    ['linear', 0, 4.088]
  ], 'adjacent decoded segments must crossfade over a short shared boundary');
  const startsBeforeMix = context.started.length;
  player.setMix('stem-a', 0.25, false);
  assert.equal(stemAGain.gain.value, 0.25, 'live mixer changes must reach the audible GainNode');
  assert.equal(stemBGain.gain.value, 1, 'changing one stem must not alter another');
  assert.equal(context.started.length, startsBeforeMix, 'mixing must not restart the transport');
  player.setMix('stem-a', 0.25, true);
  assert.equal(stemAGain.gain.value, 0, 'mute must silence the same audible GainNode');

  const remixedProject = JSON.parse(JSON.stringify(project));
  remixedProject.stemImport.tracks[0].volume = 0.35;
  remixedProject.stemImport.tracks[0].muted = false;
  player.loadProject(remixedProject);
  assert.equal(stemAGain.gain.value, 0.35, 'a cloud-synced mix update must reach active playback');
  assert.equal(context.started.length, startsBeforeMix, 'a mix-only project refresh must preserve playback');

  context.currentTime = 4.1;
  const advance = intervalHandler;
  advance();
  advance();
  await settle();
  await settle();
  assert.equal(signedAssetIds.filter((id) => id === 'segment-2-stem-a').length, 1,
    'concurrent scheduler checks must deduplicate in-flight segment loads');
  assert.equal(signedAssetIds.filter((id) => id === 'segment-2-stem-b').length, 1);
  assert.equal(context.started.length, 6, 'only one copy of the rolling successor may be scheduled');
  assert.deepEqual(context.started.slice(4).map((source) => source.starts[0][0]), [8.08, 8.08]);
  const activeSources = context.started.slice(2);
  player.pause();
  assert.ok(activeSources.every((source) => source.stopped), 'pause must atomically stop every scheduled stem');
  const pausedAt = player.position();
  const signedBeforeArrangement = signedAssetIds.length;
  const startsBeforeArrangement = context.started.length;
  const rearrangedProject = JSON.parse(JSON.stringify(remixedProject));
  rearrangedProject.stemImport.arrangement['segment-1-stem-a'] = false;
  player.loadProject(rearrangedProject);
  assert.equal(player.position(), pausedAt,
    'an arrangement-only edit must preserve the paused transport position');
  await player.play(pausedAt);
  assert.equal(signedAssetIds.length, signedBeforeArrangement,
    'an arrangement-only edit must reuse decoded audio instead of downloading it again');
  assert.equal(context.started.length - startsBeforeArrangement, 3,
    'replay must omit the disabled stem segment while keeping the other cached segments');
  player.pause();
  const signedBeforeRelease = signedAssetIds.length;
  const startsBeforeRelease = context.started.length;
  player.releaseBuffers();
  await player.play(pausedAt);
  assert.equal(signedAssetIds.length, signedBeforeRelease + 4,
    'explicit background memory release must reacquire every needed stem exactly once');
  assert.equal(context.started.length - startsBeforeRelease, 3,
    'reacquisition must preserve the disabled arrangement segment');
  player.pause();
  player.destroy();
  assert.equal(context.state, 'closed');

  let releaseLateSegment;
  const lateSegmentGate = new Promise((resolve) => { releaseLateSegment = resolve; });
  const lateCloud = {
    async signStemArtifact(_jobId, assetId) {
      if (assetId.startsWith('segment-2-')) await lateSegmentGate;
      return {
        signedUrl: `https://audio.example/${assetId}.m4a`,
        expiresAt: new Date(Date.now() + 900_000).toISOString()
      };
    }
  };
  const latePlayer = window.OpusloopsStemPlayer.create({ cloud: lateCloud });
  const lateProject = JSON.parse(JSON.stringify(project));
  lateProject.id = 'late-project';
  latePlayer.loadProject(lateProject);
  await latePlayer.play(0);
  const lateContext = FakeAudioContext.instances[1];
  lateContext.currentTime = 4.1;
  const requestLateSegment = intervalHandler;
  requestLateSegment();
  await settle();
  lateContext.currentTime = 8.205;
  releaseLateSegment();
  await settle();
  await settle();
  const lateSources = lateContext.started.slice(4, 6);
  assert.equal(lateSources.length, 2, 'the delayed successor must still schedule every stem together');
  lateSources.forEach((source) => {
    const [when, offset, bufferDuration] = source.starts[0];
    const lateBy = lateContext.currentTime - 8.08;
    assert.equal(when, lateContext.currentTime, 'a delayed decode must never schedule a source in the past');
    assert.ok(Math.abs(offset - lateBy * source.playbackRate.value) < 1e-9,
      'a delayed decode must skip the same elapsed timeline on every stem');
    assert.ok(Math.abs((bufferDuration / source.playbackRate.value) + lateBy - 4.008) < 1e-9,
      'late-start compensation must retain the shared boundary overlap');
  });
  latePlayer.destroy();

  const invalid = JSON.parse(JSON.stringify(project));
  invalid.id = 'invalid-project';
  invalid.stemImport.previewAssets = invalid.stemImport.previewAssets.filter((asset) =>
    !(asset.segmentIndex === 2 && asset.trackId === 'stem-b')
  );
  const invalidPlayer = window.OpusloopsStemPlayer.create({ cloud });
  invalidPlayer.loadProject(invalid);
  await assert.rejects(() => invalidPlayer.play(0), /missing one or more stems/,
    'partial segment manifests must fail instead of playing an unmixable project');
  invalidPlayer.destroy();

  const gapped = JSON.parse(JSON.stringify(project));
  gapped.id = 'gapped-project';
  gapped.stemImport.previewAssets.forEach((asset) => {
    if (asset.segmentIndex === 2) asset.startSeconds = 10;
  });
  const gappedPlayer = window.OpusloopsStemPlayer.create({ cloud });
  gappedPlayer.loadProject(gapped);
  await assert.rejects(() => gappedPlayer.play(0), /gap or overlap/,
    'a discontinuous manifest must fail before playback begins');
  gappedPlayer.destroy();

  const dense = JSON.parse(JSON.stringify(project));
  dense.id = 'dense-project';
  dense.stemImport.durationSeconds = 48;
  dense.stemImport.tracks = Array.from({ length: 9 }, (_, index) => ({
    assetId: `dense-stem-${index}`,
    volume: 1,
    muted: false
  }));
  dense.stemImport.previewAssets = dense.stemImport.tracks.map((track, index) => ({
    id: `dense-segment-${index}`,
    kind: 'preview_segment',
    contentType: 'audio/mp4',
    trackId: track.assetId,
    segmentIndex: 0,
    startSeconds: 0,
    durationSeconds: 48
  }));
  const densePlayer = window.OpusloopsStemPlayer.create({ cloud });
  densePlayer.loadProject(dense);
  await assert.rejects(() => densePlayer.play(0), /too dense/,
    'a decoded segment that can exhaust mobile memory must fail before allocation');
  densePlayer.destroy();

  class RefusingAudioContext extends FakeAudioContext {
    resume() { return Promise.resolve(); }
  }
  window.AudioContext = RefusingAudioContext;
  const refusingPlayer = window.OpusloopsStemPlayer.create({ cloud });
  refusingPlayer.loadProject(project);
  await assert.rejects(
    () => refusingPlayer.play(0),
    (error) => error?.name === 'NotAllowedError',
    'playback must not report success when Safari leaves AudioContext suspended'
  );
  refusingPlayer.destroy();
  window.AudioContext = FakeAudioContext;

  let releaseOldSigners;
  const oldSignerGate = new Promise((resolve) => { releaseOldSigners = resolve; });
  const cancellationCalls = [];
  let cancellationAborts = 0;
  let activeCancellationSigners = 0;
  let maxCancellationSigners = 0;
  const cancellationCloud = {
    async signStemArtifact(_jobId, assetId, _expires, options = {}) {
      cancellationCalls.push(assetId);
      activeCancellationSigners += 1;
      maxCancellationSigners = Math.max(maxCancellationSigners, activeCancellationSigners);
      try {
        if (assetId.startsWith('old-')) {
          await new Promise((resolve, reject) => {
            const cancel = () => {
              cancellationAborts += 1;
              reject(new DOMException('Playback changed', 'AbortError'));
            };
            options.signal?.addEventListener('abort', cancel, { once: true });
            oldSignerGate.then(resolve);
          });
        }
        return { signedUrl: `https://audio.example/${assetId}.m4a` };
      } finally {
        activeCancellationSigners -= 1;
      }
    }
  };
  const oldTracks = Array.from({ length: 8 }, (_, index) => ({
    assetId: `old-stem-${index}`,
    volume: 1,
    muted: false
  }));
  const oldProject = {
    id: 'old-project',
    stemImport: {
      jobId: 'old-job',
      status: 'ready',
      durationSeconds: 4,
      tracks: oldTracks,
      arrangement: {},
      previewAssets: oldTracks.map((track, index) => ({
        id: `old-segment-${index}`,
        kind: 'preview_segment',
        contentType: 'audio/mp4',
        trackId: track.assetId,
        segmentIndex: 0,
        startSeconds: 0,
        durationSeconds: 4
      }))
    }
  };
  const replacementProject = {
    id: 'replacement-project',
    stemImport: {
      jobId: 'replacement-job',
      status: 'ready',
      durationSeconds: 4,
      tracks: [{ assetId: 'replacement-stem', volume: 1, muted: false }],
      arrangement: {},
      previewAssets: [{
        id: 'replacement-segment',
        kind: 'preview_segment',
        contentType: 'audio/mp4',
        trackId: 'replacement-stem',
        segmentIndex: 0,
        startSeconds: 0,
        durationSeconds: 4
      }]
    }
  };
  const cancellationPlayer = window.OpusloopsStemPlayer.create({ cloud: cancellationCloud });
  cancellationPlayer.loadProject(oldProject);
  const abandonedPlay = cancellationPlayer.play(0);
  await settle();
  await settle();
  assert.equal(cancellationCalls.filter((id) => id.startsWith('old-')).length, 4,
    'the first load must occupy every bounded signing slot');
  cancellationPlayer.loadProject(replacementProject);
  const replacementPlay = cancellationPlayer.play(0);
  await settle();
  await settle();
  assert.equal(cancellationCalls.filter((id) => id === 'replacement-segment').length, 1,
    'cancelled signing work must not starve replacement playback');
  assert.equal(cancellationCalls.filter((id) => id.startsWith('old-')).length, 4,
    'queued work from a cancelled project must never begin');
  assert.equal(cancellationAborts, 4, 'every active stale signer must receive cancellation');
  assert.equal(maxCancellationSigners, 4, 'signing concurrency must stay bounded');
  await replacementPlay;
  releaseOldSigners();
  await abandonedPlay;
  cancellationPlayer.destroy();

  let releaseFinalSibling;
  const finalSiblingGate = new Promise((resolve) => { releaseFinalSibling = resolve; });
  const failedCalls = [];
  const failureCloud = {
    async signStemArtifact(_jobId, assetId) {
      failedCalls.push(assetId);
      if (assetId === 'failure-segment-0') throw new Error('expected signer failure');
      if (assetId === 'failure-segment-7') await finalSiblingGate;
      return { signedUrl: `https://audio.example/${assetId}.m4a` };
    }
  };
  const failureTracks = Array.from({ length: 8 }, (_, index) => ({
    assetId: `failure-stem-${index}`,
    volume: 1,
    muted: false
  }));
  const failureProject = {
    id: 'failure-project',
    stemImport: {
      jobId: 'failure-job',
      status: 'ready',
      durationSeconds: 4,
      tracks: failureTracks,
      arrangement: {},
      previewAssets: failureTracks.map((track, index) => ({
        id: `failure-segment-${index}`,
        kind: 'preview_segment',
        contentType: 'audio/mp4',
        trackId: track.assetId,
        segmentIndex: 0,
        startSeconds: 0,
        durationSeconds: 4
      }))
    }
  };
  const failurePlayer = window.OpusloopsStemPlayer.create({ cloud: failureCloud });
  failurePlayer.loadProject(failureProject);
  let failedPlaySettled = false;
  const failedPlay = failurePlayer.play(0);
  failedPlay.then(
    () => { failedPlaySettled = true; },
    () => { failedPlaySettled = true; }
  );
  for (let index = 0; index < 8; index += 1) await settle();
  assert.equal(new Set(failedCalls).size, 8, 'every sibling request must settle once before retry eligibility');
  assert.ok(failedCalls.every((id) => failedCalls.filter((value) => value === id).length === 1),
    'one failed asset must not duplicate sibling work');
  assert.equal(failedPlaySettled, false, 'the failed segment must stay pending until its last sibling settles');
  const failureContext = FakeAudioContext.instances.at(-1);
  assert.equal(failureContext.started.length, 0, 'a partial segment must never schedule audio');
  releaseFinalSibling();
  await assert.rejects(() => failedPlay, /expected signer failure/);
  assert.equal(failureContext.started.length, 0, 'a failed segment must remain inaudible after all siblings settle');
  failurePlayer.destroy();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE

if grep -RniE 'magda|conceptual machines|anthropic' mobile; then
  echo "Production mobile files contain retired or third-party product branding." >&2
  exit 1
fi

if grep -RniE 'sb_secret_|service[_-]?role' mobile; then
  echo "Production mobile files contain a privileged Supabase credential marker." >&2
  exit 1
fi

grep -Fq 'https://heryvahetgzfalmuprbw.supabase.co' mobile/index.html
grep -Fq 'https://heryvahetgzfalmuprbw.storage.supabase.co' mobile/index.html
grep -Fq "media-src 'self' blob:" mobile/index.html
grep -Fq 'https://heryvahetgzfalmuprbw.storage.supabase.co' customHttp.yml
grep -Fq "media-src 'self' blob:" customHttp.yml
grep -Fq 'sb_publishable_' mobile/config.js
grep -Fq 'const DEFAULT_TUS_CHUNK_SIZE = 6 * 1024 * 1024' mobile/cloud-client.js
grep -Fq '"Upload-Offset"' mobile/cloud-client.js
grep -Fq 'onUploadProgress' mobile/cloud-client.js
for method in createStemImport uploadStemArchive forgetStemArchiveUpload finalizeStemUpload retryStemInspection retryStemProposal repairStemRenderProposal retryStemRender getStemImport approveStemAnalysis requestStemProposal approveStemTempo dispatchStemImport cancelStemImport signStemArtifact; do
  grep -Fq "$method" mobile/cloud-client.js
done
grep -Fq 'order=created_at.asc,asset_id.asc' mobile/cloud-client.js
grep -Fq 'disabledSegments: normalized.stemImport.disabledSegments' mobile/app.js
grep -Fq 'this stage does not expose a measurable percentage' mobile/index.html
grep -Fq 'dom.processPanel.dataset.kind = statusKind' mobile/stem-import.js
grep -Fq 'dom.processPanel.dataset.status = status' mobile/stem-import.js
grep -Fq 'item.classList.add("is-current")' mobile/stem-import.js
grep -Fq 'button.setAttribute("aria-busy", "true")' mobile/stem-import.js
grep -Fq 'if (dom.gridEventList.contains(document.activeElement)) return' mobile/stem-import.js
grep -Fq 'if (gridIssues().length) throw new Error' mobile/stem-import.js
grep -Fq 'minimumDownbeats: naturalMode ? 5 : 1' mobile/stem-import.js
grep -Fq 'core.timingSeconds(item?.time ?? item)' mobile/stem-import.js
grep -Fq '.process-panel[data-kind="active"] .process-state::before' mobile/styles.css
grep -Fq '.process-event.is-current .process-event-marker' mobile/styles.css
grep -Fq '.import-panel button.is-busy::after' mobile/styles.css
grep -Fq 'id="account-card-button"' mobile/index.html
grep -Fq 'id="account-card-initial"' mobile/index.html
grep -Fq 'dom.accountCardButton.addEventListener' mobile/app.js
grep -Fq 'querySelector("svg").toggleAttribute("hidden", signedIn)' mobile/app.js
grep -Fq 'dom.accountCardInitial.textContent = initial' mobile/app.js
if grep -Eq 'id="(save-status|account-button)"|class="status-dot"' mobile/index.html; then
  echo "Header save/profile controls must remain in Projects" >&2
  exit 1
fi
grep -Fq 'data-remove-grid-event' mobile/stem-import.js
grep -Fq 'meterNumerator' mobile/stem-import.js
grep -Fq 'firstDownbeatSeconds' mobile/stem-import.js
grep -Fq 'previewAssets' mobile/stem-import-core.js
grep -Fq 'id="stem-retry-inspection"' mobile/index.html
grep -Fq 'await cloud.retryStemInspection(job.id, job.revision)' mobile/stem-import.js
grep -Fq 'id="stem-retry-proposal"' mobile/index.html
grep -Fq 'const retryableProposal = core.canRetryProposal(job, events)' mobile/stem-import.js
grep -Fq 'dom.retryProposal.hidden = !retryableProposal' mobile/stem-import.js
grep -Fq 'await cloud.retryStemProposal(job.id, job.revision)' mobile/stem-import.js
grep -Fq 'return stemAction("retry-proposal", { jobId, revision })' mobile/cloud-client.js
grep -Fq 'id="stem-repair-render"' mobile/index.html
grep -Fq 'const repairableRender = core.canRepairRenderProposal(job, events)' mobile/stem-import.js
grep -Fq 'dom.repairRender.hidden = !repairableRender' mobile/stem-import.js
grep -Fq 'retryableProposal || repairableRender || retryableRender' mobile/stem-import.js
grep -Fq 'await cloud.repairStemRenderProposal(' mobile/stem-import.js
grep -Fq 'repairRenderProposal(repairKey)' mobile/stem-import.js
grep -Fq 'if (scheduledGeneration !== generation || automaticRepairKey !== repairKey) return' mobile/stem-import.js
grep -Fq 'const existingRequest = repairRequests.get(requestKey)' mobile/stem-import.js
grep -Fq 'if (existingRequest?.generation === localGeneration) return existingRequest.operation' mobile/stem-import.js
grep -Fq 'repairRequests.get(requestKey)?.operation === operation' mobile/stem-import.js
grep -Fq 'return stemAction("repair-render-proposal", { jobId, revision, proposalManifestSha256 })' mobile/cloud-client.js
grep -Fq 'id="stem-retry-render"' mobile/index.html
grep -Fq 'const retryableRender = core.canRetryRender(job, events)' mobile/stem-import.js
grep -Fq 'dom.retryRender.hidden = !retryableRender' mobile/stem-import.js
grep -Fq 'await cloud.retryStemRender(' mobile/stem-import.js
grep -Fq 'return stemAction("retry-render", {' mobile/cloud-client.js
grep -Fq 'job.proposalId' mobile/stem-import.js
grep -Fq 'resetConfirmations(gateBConfirmationIds)' mobile/stem-import.js
grep -Fq 'documentProposalId !== job.proposalId' mobile/stem-import.js
grep -Fq 'proposalId: job.proposalId' mobile/stem-import.js
grep -Fq 'if (previousProposalId !== job.proposalId)' mobile/stem-import.js
grep -Fq 'const requestSequence = ++pollRequestSequence' mobile/stem-import.js
grep -Fq 'requestSequence !== pollRequestSequence' mobile/stem-import.js
grep -Fq 'nextJob.revision < job.revision' mobile/stem-import.js
grep -Fq 'dataFetch("/rpc/get_stem_import_event_snapshot"' mobile/cloud-client.js
grep -Fq 'events: Array.isArray(snapshot.events) ? snapshot.events : []' mobile/cloud-client.js
grep -Fq 'Your completed timing analysis is safe.' mobile/stem-import.js
grep -Fq 'onAuditionState: handleAuditionState' mobile/app.js
grep -Fq 'stemImportController?.toggleAudition?.()' mobile/app.js
grep -Fq 'stemImportController?.seekAudition?.(position, { resume: shouldResume })' mobile/app.js
grep -Fq 'dom.persistentSeekLabel.textContent = audition ? "Seek within timing audition" : "Seek within project"' mobile/app.js
grep -Fq 'advanceAuditionListening(clickListenProgress' mobile/stem-import.js
grep -Fq 'expectedGeneration !== generation || loadToken !== clickLoadToken' mobile/stem-import.js
grep -Fq 'if (!clickAuditionEngaged || dom.clickAudio.paused || dom.clickAudio.ended) return' mobile/stem-import.js
grep -Fq 'nextAudition.key !== playbackScrubAuditionKey' mobile/app.js
grep -Fq 'playbackScrubAuditionKey = ""' mobile/app.js
grep -Fq 'aria-pressed="false"' mobile/index.html
grep -Fq 'id="persistent-seek-label"' mobile/index.html
if grep -Fq 'dom.clickAudio.currentTime < 0.25' mobile/stem-import.js; then
  echo 'Gate B listening confirmation must not be unlocked by seeking.' >&2
  exit 1
fi

inspection_retry='supabase/migrations/20260905230000_add_failed_inspection_retry.sql'
inspection_retry_test='supabase/tests/stem_inspection_retry.sql'
stem_import_function='supabase/functions/stem-import/index.ts'
render_repair='supabase/migrations/20260906210000_add_render_proposal_repair.sql'
render_retry='supabase/migrations/20260906223000_retry_extensible_wav_render.sql'
snapshot_test='supabase/tests/stem_import_event_snapshot.sql'
test -s "$render_repair" -a -s "$render_retry" -a -s "$snapshot_test"
grep -Fq 'create function public.get_stem_import_event_snapshot' "$render_repair"
grep -Fq 'security invoker' "$render_repair"
grep -Fq 'to authenticated' "$render_repair"
test -s "$inspection_retry" -a -s "$inspection_retry_test"
grep -Fq 'action === "retry-inspection"' "$stem_import_function"
grep -Fq 'action === "repair-render-proposal"' "$stem_import_function"
grep -Fq 'job = await rpc("repair_stem_render_proposal"' "$stem_import_function"
grep -Fq 'action === "retry-render"' "$stem_import_function"
grep -Fq 'job = await rpc("retry_stem_render"' "$stem_import_function"
grep -Fq 'get_stem_inspection_retry_source' "$stem_import_function"
grep -Fq 'job = await rpc("retry_stem_inspection"' "$stem_import_function"
grep -Fq 'dispatchResult = await durableDispatch' "$stem_import_function"
grep -Fq 'v_job.error_code is null' "$inspection_retry"
grep -Fq "v_job.error_code not in ('batch_bootstrap_failed', 'batch_queue_timeout')" "$inspection_retry"
grep -Fq "v_attempt.stage <> 'inspect'" "$inspection_retry"
grep -Fq 'from public.stem_import_assets as asset' "$inspection_retry"
grep -Fq 'from private.stem_retention_items as item' "$inspection_retry"
grep -Fq 'from private.stem_retention_scopes as scope' "$inspection_retry"
grep -Fq 'from storage.objects as object' "$inspection_retry"
grep -Fq "private.opusloops_stem_begin_attempt(" "$inspection_retry"
grep -Fq 'to service_role' "$inspection_retry"
grep -Fq 'create function public.retry_stem_render' "$render_retry"
grep -Fq "canonical_wav_extensible_unsupported" "$render_retry"
grep -Fq 'p_tempo_approval_sha256 is distinct from v_job.tempo_approval_sha256' "$render_retry"
grep -Fq "v_failed_attempt.stage <> 'render'" "$render_retry"
grep -Fq "asset.kind in (" "$render_retry"
grep -Fq 'from storage.objects as object' "$render_retry"
grep -Fq "event.detail ->> 'operation' in ('publishing-state', 'publishing-assets')" "$render_retry"
grep -Fq "private.opusloops_stem_begin_attempt(" "$render_retry"
grep -Fq 'to service_role' "$render_retry"

migration='supabase/migrations/20260905110000_create_user_projects.sql'
test -s "$migration"
grep -Fq 'alter table public.projects enable row level security' "$migration"
grep -Fq 'revoke all on table public.projects from anon, authenticated' "$migration"
test "$(grep -c '^create policy ' "$migration")" -eq 4

atomic_sync='supabase/migrations/20260905123000_add_atomic_project_sync.sql'
membership='supabase/migrations/20260905135000_require_opusloops_membership_for_sync.sql'
invites='supabase/migrations/20260905130000_create_single_use_signup_invites.sql'
invite_recovery='supabase/migrations/20260905220000_add_signup_invite_reservation_recovery.sql'
test -s "$atomic_sync" -a -s "$membership" -a -s "$invites" -a -s "$invite_recovery"
grep -Fq 'pg_advisory_xact_lock' "$atomic_sync"
grep -Fq "'app_metadata' ->> 'opusloops'" "$membership"
grep -Fq 'grant execute on function public.sync_projects(jsonb) to authenticated' "$membership"
grep -Fq 'grant execute on function public.claim_opusloops_signup_invite(text, text) to service_role' "$invites"
grep -Fq 'returns boolean' "$invite_recovery"
grep -Fq 'drop function if exists public.claim_opusloops_signup_invite(text, text)' "$invite_recovery"
grep -Fq 'create unique index if not exists opusloops_signup_invites_reserved_user_id_key' "$invite_recovery"
grep -Fq 'grant execute on function public.reserve_opusloops_signup_invite(text, text)' "$invite_recovery"
grep -Fq 'grant execute on function public.release_opusloops_signup_invite(uuid)' "$invite_recovery"
account_handler='supabase/functions/create-opusloops-account/handler.mjs'
grep -Fq 'OPUSLOOPS_PUBLISHABLE_KEY_HASH' "$account_handler"
grep -Fq 'X-Supabase-Api-Version' "$account_handler"
grep -Fq '2024-01-01' "$account_handler"
grep -Fq '/rest/v1/rpc/reserve_opusloops_signup_invite' "$account_handler"
grep -Fq 'async function completeReservation' "$account_handler"
grep -Fq '      2,' "$account_handler"
if grep -Fq '/rest/v1/rpc/release_opusloops_signup_invite' "$account_handler"; then
  echo 'Account handler must preserve deterministic reservations for safe retries.' >&2
  exit 1
fi
test "$(grep -c '^enable_signup = false$' supabase/config.toml)" -eq 2
grep -Fq 'site_url = "https://opusloops.com/"' supabase/config.toml
grep -Fq '"https://www.opusloops.com/**"' supabase/config.toml
grep -Fq 'verify_jwt = false' supabase/config.toml
grep -Fq 'Deno.serve(createOpusloopsAccountHandler' supabase/functions/create-opusloops-account/index.ts
grep -Fq '"https://opusloops.com"' "$account_handler"
grep -Fq '"https://www.opusloops.com"' "$account_handler"
