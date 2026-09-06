# Opusloops stem-tempo calibration

This is the production-isolated calibration harness for importing a Suno stem
ZIP, deriving one shared musical timeline, and comparing offline time-stretch
renders. It deliberately does not run in the Amplify frontend.

The workflow has two hard, hash-bound human approval gates:

1. **Gate A:** confirm the archive inventory, source hashes, track roles, included
   stems, and shared-reference method.
2. **Gate B:** listen to the click audition and confirm the beat grid, meter,
   first downbeat, tempo octave, target BPM, mode, flagged regions, and shared map.

Original ZIP members and canonical source stems are immutable. Analysis,
proposals, approvals, and renders are derived artifacts with SHA-256 provenance.
Opaque model work is reported as indeterminate; determinate stages report actual
bytes, files, frames, or artifacts instead of a simulated percentage.

## Local setup

Python 3.11 or newer, CMake, a C++17 compiler, and FFmpeg/ffprobe are required.
The analysis extra installs the pinned Beat This and librosa versions.

```bash
cd prototypes/stem-tempo-calibration
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e '.[analysis,dev]'

cmake -S native -B .build/native -DCMAKE_BUILD_TYPE=Release
cmake --build .build/native --parallel

.venv/bin/ruff format --check src tests
.venv/bin/ruff check src tests
.venv/bin/python -m compileall -q src tests
.venv/bin/pytest -q
```

Private source audio belongs under the ignored
`tests/fixtures/audio/stem-calibration/` tree or outside the repository. Never
commit a source ZIP, extracted member, canonical WAV, model output, or render.

## Calibration workflow

Every successful command writes a single JSON result to stdout. Work and
approval commands append durable stage events to the run; `verify-run` is a
read-only integrity check. Use a new run directory for a different source or
Gate-A decision.

### 1. Inspect and decode

```bash
.venv/bin/opus-stem-cal inspect \
  --zip /absolute/path/to/stems.zip \
  --run .local/runs/song-001 \
  --ffmpeg /absolute/path/to/ffmpeg \
  --ffprobe /absolute/path/to/ffprobe

.venv/bin/opus-stem-cal verify-run --run .local/runs/song-001
```

Inspection fails closed on unsafe paths, links, nested archives, unsupported
types, ambiguous names, archive bombs, resource ceilings, or malformed audio.
Accepted audio is decoded deterministically to channel-preserving 48 kHz
float32 WAV before Gate A. Matching channel layouts, timeline offsets, and frame
counts are enforced before a shared reference can be built. Review
`run-manifest.json` and
`analysis-selection.template.json`; edit the template if a role, inclusion
choice, gain, or reference method is wrong.

### 2. Approve Gate A and analyze

Only run this after the person named by `--approved-by` has confirmed all four
items represented by the flags.

```bash
.venv/bin/opus-stem-cal approve-analysis \
  --run .local/runs/song-001 \
  --selection .local/runs/song-001/analysis-selection.template.json \
  --approved-by USER_ID \
  --confirm-files \
  --confirm-roles \
  --confirm-reference \
  --confirm-originals-unchanged

.venv/bin/opus-stem-cal analyze \
  --run .local/runs/song-001 \
  --librosa
```

Beat This `final0` is the primary continuous beat/downbeat analyzer. Its exact
checkpoint hash is pinned. Librosa is diagnostic-only and can never silently
replace the primary grid. If Gate A names a drum cross-check stem, the diagnostic
also records results against that exact canonical stem.

Every invocation claims a private, unique
`analysis-attempts/<attempt-id>/` directory. Its reference, model artifacts,
analysis JSON, and review-grid template are immutable attempt outputs. A failed
attempt remains available for diagnosis but is not recorded as the run's
analysis, so the same Gate-A approval can be retried safely. The manifest binds
only a fully completed attempt; after that succeeds, another analysis is refused.
The command result and every analysis-stage event include the attempt ID so live
progress and failures can be correlated to the exact files.
Copy the returned `tempo-grid.template.json` to a new review file before
editing; files inside an analysis-attempt directory are provenance artifacts,
not mutable workspace files.

If the analysis process is terminated before it can record terminal events, the
next locked invocation verifies the orphaned attempt ID and directory, marks
each active stage failed at its last journaled counter, and then starts a new
attempt. Recovery never reports unobserved work as completed and refuses an
orphan whose event IDs and paths do not match.

### 3. Create and review a proposal

`musical-4bar` is the default product behavior. It anchors approximately every
four bars to keep phrasing musical. `rigid-beat` is the optional tighter mode;
`no-conform` records an identity decision when the source is already suitable.
Tempo-map v2 replaces a reviewed downbeat inside the pinned renderer's pre-roll
with a deterministic identity guard while retaining that downbeat as reviewed
metadata and in the logical four-bar diagnostics.

```bash
.venv/bin/opus-stem-cal propose-map \
  --run .local/runs/song-001 \
  --proposal-id first-listen \
  --mode musical-4bar \
  --target-bpm 120
```

Each attempt claims a new immutable `proposals/<proposal-id>/` directory with:

- the exact reviewed beat/downbeat grid;
- a click-audition WAV;
- the proposed shared map; and
- an editable approval template bound to the other artifacts.

To revise detected events, copy the generated grid to a new file, edit the copy,
set `reviewed` to `true`, and pass it to another `propose-map` call with a new
proposal ID. Existing analysis attempts and proposal IDs are never overwritten.
Proposal creation is serialized with a crash-released lock. If a process dies
mid-map or mid-click, the next invocation records those stages as failed at their
last persisted counters, retains the orphan proposal directory, and requires a
new proposal ID.

### 4. Approve Gate B and render the bakeoff

When more than one proposal exists, `--approval` is required so the chosen
revision is unambiguous. Beat-grid, meter/downbeat, and tempo-octave review are
separate attestations; no one flag silently confirms another.

```bash
.venv/bin/opus-stem-cal approve-map \
  --run .local/runs/song-001 \
  --approval .local/runs/song-001/proposals/first-listen/tempo-approval.template.json \
  --approved-by USER_ID \
  --confirm-click \
  --confirm-beat-grid \
  --confirm-meter-downbeat \
  --confirm-tempo-octave \
  --confirm-flags \
  --confirm-target \
  --confirm-shared-map \
  --confirm-originals-unchanged

.venv/bin/opus-stem-cal render-bakeoff \
  --run .local/runs/song-001 \
  --binary .build/native/opusloops-signalsmith-render

.venv/bin/opus-stem-cal verify-run --run .local/runs/song-001
.venv/bin/opus-stem-cal report --run .local/runs/song-001
```

The render plan applies one frame-exact map to every stem. The native process
re-hashes its map, plan, TSV inputs, and every source WAV before rendering and
again before atomic publication. Linked multichannel and independent-stem modes
are written to separate new directories for objective and listening comparison.
Both modes execute one owner-private snapshot of the selected renderer; its exact
SHA-256 is recorded, its engine/version response must be Signalsmith Stretch
1.3.2, and the temporary executable is removed after the bake-off.
The metrics artifact checks format/frame agreement, finite samples, boundary
discontinuities, and per-stem linked-versus-independent residuals. Each bake-off
uses a new owner-private `render-attempts/render-<id>/` directory containing its
bound inputs, both mode outputs, and metrics. Failed attempts remain intact and
a retry uses a different ID; only the complete attempt is bound into the run
manifest. A run with a published bake-off cannot be rendered again—create a new
run for another immutable comparison. A retry after process death first records
any orphan render or metric stage as failed at its last persisted counter. The
manifest and verifier require the results, artifact paths, renderer provenance,
Gate-B decision, and metrics payload to name that same successful attempt.

## Intended production split

The approved product architecture keeps the mobile client and DSP worker
separate:

- **Amplify/mobile:** select ZIP, show inventory and both confirmations, edit
  four-bar regions, audition, and display the global compact player.
- **Supabase Pro:** authentication, per-user projects, row-level authorization,
  resumable TUS upload, immutable object keys, job/event records, and signed URLs.
- **AWS Batch/Fargate:** isolated FFmpeg, Beat This, and Signalsmith processing
  with explicit CPU, memory, scratch-space, and runtime limits.

The original ZIP can be deleted after the configured recovery window. Canonical
source stems remain until the user deletes the project. Internal renderer staging
files are disposable; calibration bake-off attempts are retained as immutable
evidence, including attempts which fail before manifest publication.

## Production boundary

Nothing in this directory is imported by `mobile/`, the root native build,
Supabase, or `amplify.yml`. Amplify publishes only `mobile/`. Calibration must
pass the private Suno fixture gates and quality review before the worker, database
schema, and mobile import UI are integrated or production is changed.
