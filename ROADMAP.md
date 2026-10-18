# OPUS LOOPS feature-parity roadmap

Updated 2026-10-17. The active goal is a browser DAW covering Ableton Live's workflows and feature categories. Full parity is **not achieved**. Build the core music-making workflow first; do not treat a feature label, menu entry, or narrow passing test as proof of a complete workflow.

## Current production source

AWS Amplify publishes `web-studio/`. The older application in `mobile/` remains historical and does not establish functionality in the published studio. `web-studio/release.json` records the artifact revision; live `version.json` records the actual deployed commit. Hosting success and live runtime checks are separate evidence.

## Core-first gates

| Gate | Current scope and remaining verification |
| --- | --- |
| Project and playback reliability | Local project storage, embedded media, project files, transport, loop/seek, and undo exist. Release 0.118 adds validated session-start recovery. Multi-track long-playback stress tests, interruption matrices and device measurements remain incomplete. |
| Compose and arrange a song | Session clips/scenes, Arrangement editing, capture, MIDI editing and sample import exist as subsets. Multi-region selection, track-limited time editing, region fades/crossfades and full workflow coverage remain unfinished. |
| Record and edit performances | Browser audio/MIDI recording, input controls and count-in exist as subsets. Physical-device timing, monitoring/latency measurements, take lanes, comping and broader expressive MIDI remain unfinished. |
| Finish the sound and mix | Synth, sampler, drums, serial effects, sends/returns and automation exist as subsets. Track grouping, broader routing/device families and representative audible live/export comparisons remain unfinished. |
| Deliver and recover | WAV, MIDI and stem exports and project downloads exist as subsets. Session-start checkpoints and corrupt-autosave fallback have current browser evidence. A fresh-session complete-song round trip, aligned audible exports and device/browser reliability matrix remain required. |

Core completion requires creating a representative multitrack song from an empty set using imported and recorded audio, MIDI, Session-to-Arrangement work, edits, instruments, effects and automation; saving, closing, reopening, continuing edits and exporting a mix plus aligned stems. Record project size, timing/content preservation, audible results, keyboard/menu behavior and browser/device limits.

## Full feature scope after the core gates

Maintain investigations and implementation for Arrangement and Session depth; audio recording/comping/warping; expressive MIDI and editing; instruments and audio/MIDI effects; racks/macros; groups and routing; automation/modulation; browser/media management; project/version recovery; export/interchange; controller/MIDI mappings, sync/Link and external devices; browser plug-ins and native bridging; a scripting/modular equivalent to Max workflows; accessibility, performance and reliability. Native VST/AU/Max compatibility is unproven and needs separate runtime work. Browser and platform limitations must be documented, not counted as parity.

The reference baseline is the Ableton Live 12 manual and installed Live version recorded by each focused investigation. Use REA when an authorized investigation needs observed behavior; record the actual target/version and evidence. Do not infer current parity from historical release notes.

## 0.118 — Session-start recovery

On opening a valid browser-local project, save one validated checkpoint in the existing project database. Keep it separate from the previous set retained by New/Open. Subsequent autosaves leave it unchanged until the next page session. File → Open Live Set Backups → Restore Session Start restores it and keeps the displaced current set as Previous Set. If current autosave validation fails, startup tries the checkpoint without overwriting it. Storage failure during checkpoint creation retains the valid current project and reports that recovery backup was unavailable.

Evidence: `tests/session-recovery.test.cjs` verifies independent snapshots, fallback validation, checkpoint-write failure and missing/corrupt data. `tests/session-recovery.cjs` verifies actual IndexedDB, an embedded WAV, unchanged checkpoints after edits, File-menu restore, preservation of the displaced set and corrupt-current reload recovery in Chromium. These checks do not establish physical-device behavior, quota capacity or full crash/eviction durability. Browser-local copies share the browser's storage failure/eviction risk; project downloads remain the portable backup.

## Next work

1. Audit the whole representative-song core workflow and preserve reproducible project/audio fixtures.
2. Implement Arrangement multi-region selection and track-limited editing with grouped undo.
3. Complete group/routing workflows and verify the audio output of live and offline paths.
4. Add performance/recording measurements across actual browsers and input/output devices.

Keep this objective active until every requested feature category and workflow has current implementation and verification evidence.
