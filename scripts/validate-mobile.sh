#!/usr/bin/env bash

set -euo pipefail

for required in index.html frame-guard.js styles.css pixel-dock.css pixel-dock.mjs REACT_BITS_LICENSE.md config.js cloud-client.js stem-import-core.js stem-player.js stem-import.js app.js manifest.webmanifest service-worker.js icons/icon-192.png icons/icon-512.png icons/apple-touch-icon.png; do
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
pixel_dock_path = root / "pixel-dock.mjs"
pixel_dock_css_path = root / "pixel-dock.css"


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
pixel_dock_source = pixel_dock_path.read_text(encoding="utf-8")
pixel_dock_css_source = pixel_dock_css_path.read_text(encoding="utf-8")
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
NODE

node <<'NODE'
const assert = require('node:assert/strict');

class FakeAudio {
  static instances = [];

  constructor() {
    this.readyState = 1;
    this.currentTime = 0;
    this.volume = 1;
    this.muted = false;
    this.paused = true;
    this.preload = '';
    this.listeners = new Map();
    this.source = '';
    FakeAudio.instances.push(this);
  }

  get src() { return this.source; }
  set src(value) { this.source = String(value); }

  addEventListener(name, handler, options = {}) {
    const listeners = this.listeners.get(name) || [];
    listeners.push({ handler, once: Boolean(options.once) });
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, handler) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry.handler !== handler));
  }

  emit(name) {
    const listeners = [...(this.listeners.get(name) || [])];
    listeners.forEach((entry) => entry.handler());
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => !entry.once));
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() { this.paused = true; }
  removeAttribute(name) { if (name === 'src') this.source = ''; }
  load() {}
}

global.Audio = FakeAudio;
global.window = {
  OpusloopsStemCore: require('./mobile/stem-import-core.js'),
  setTimeout,
  clearTimeout,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {}
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
    tracks: [{ assetId: 'stem', volume: 1, muted: false }],
    arrangement: {},
    previewAssets: Array.from({ length: 4 }, (_, index) => ({
      id: `segment-${index}`,
      kind: 'preview_segment',
      contentType: 'audio/mp4',
      trackId: 'stem',
      segmentIndex: index,
      startSeconds: index * 4,
      durationSeconds: 4
    }))
  }
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
const activeAudio = (assetId) => FakeAudio.instances.find((audio) =>
  !audio.paused && audio.src.endsWith(`/${assetId}.m4a`)
);

(async () => {
  const player = window.OpusloopsStemPlayer.create({ cloud });
  player.loadProject(project);
  await settle();
  await player.play(0);
  await settle();
  assert.deepEqual(signedAssetIds, ['segment-0', 'segment-1']);
  assert.equal(activeAudio('segment-0').preload, 'auto');

  const first = activeAudio('segment-0');
  const remixedProject = JSON.parse(JSON.stringify(project));
  remixedProject.stemImport.tracks[0].volume = 0.35;
  remixedProject.stemImport.tracks[0].muted = true;
  player.loadProject(remixedProject);
  assert.equal(first.volume, 0.35, 'a synced volume change must update loaded audio');
  assert.equal(first.muted, true, 'a synced mute change must update loaded audio');
  assert.equal(first.paused, false, 'a mix-only reload must preserve active playback');

  first.emit('ended');
  await settle();
  await settle();
  assert.ok(signedAssetIds.includes('segment-2'), 'the third segment must preload during the first transition');
  assert.equal(first.src, '', 'the completed segment must be evicted after its successor starts');

  const second = activeAudio('segment-1');
  second.emit('ended');
  await settle();
  await settle();
  assert.ok(signedAssetIds.includes('segment-3'), 'rolling preload must continue beyond the first successor');
  assert.equal(second.src, '', 'the two-segment playback window must evict older media');
  player.destroy();
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
for method in createStemImport uploadStemArchive forgetStemArchiveUpload finalizeStemUpload retryStemInspection getStemImport approveStemAnalysis requestStemProposal approveStemTempo dispatchStemImport cancelStemImport signStemArtifact; do
  grep -Fq "$method" mobile/cloud-client.js
done
grep -Fq 'order=created_at.asc,asset_id.asc' mobile/cloud-client.js
grep -Fq 'disabledSegments: normalized.stemImport.disabledSegments' mobile/app.js
grep -Fq 'this stage does not expose a measurable percentage' mobile/index.html
grep -Fq 'data-remove-grid-event' mobile/stem-import.js
grep -Fq 'meterNumerator' mobile/stem-import.js
grep -Fq 'firstDownbeatSeconds' mobile/stem-import.js
grep -Fq 'previewAssets' mobile/stem-import-core.js
grep -Fq 'id="stem-retry-inspection"' mobile/index.html
grep -Fq 'await cloud.retryStemInspection(job.id, job.revision)' mobile/stem-import.js

inspection_retry='supabase/migrations/20260905230000_add_failed_inspection_retry.sql'
inspection_retry_test='supabase/tests/stem_inspection_retry.sql'
stem_import_function='supabase/functions/stem-import/index.ts'
test -s "$inspection_retry" -a -s "$inspection_retry_test"
grep -Fq 'action === "retry-inspection"' "$stem_import_function"
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
