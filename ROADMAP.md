# OPUS LOOPS feature-parity roadmap

Updated 2026-10-17. The active goal is a browser DAW covering Ableton Live's workflows and feature categories. Full parity is **not achieved**. Build the core music-making workflow first; do not treat a feature label, menu entry, or narrow passing test as proof of a complete workflow.

## Current production source

AWS Amplify publishes `web-studio/`. The older application in `mobile/` remains historical and does not establish functionality in the published studio. `web-studio/release.json` records the artifact revision; live `version.json` records the actual deployed commit. Hosting success and live runtime checks are separate evidence.

## Core-first gates

| Gate | Current scope and remaining verification |
| --- | --- |
| Project and playback reliability | Local project storage, embedded media, project files, transport, loop/seek, and undo exist. Release 0.118 adds validated session-start recovery. Multi-track long-playback stress tests, interruption matrices and device measurements remain incomplete. |
| Compose and arrange a song | Session clips/scenes, Arrangement editing, capture, MIDI editing and sample import exist as subsets. Release 0.119 adds additive multi-region selection, grouped movement/duplication/deletion/activation and Select All. Release 0.120 adds an internal region clipboard. Marquee selection, track-limited time editing, region fades/crossfades and full workflow coverage remain unfinished. |
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
2. Extend Arrangement selection with marquee selection and track-limited time editing.
3. Complete group/routing workflows and verify the audio output of live and offline paths.
4. Add performance/recording measurements across actual browsers and input/output devices.

Keep this objective active until every requested feature category and workflow has current implementation and verification evidence.

## 0.119 — Arrangement clip groups

Ctrl/Cmd-click toggles clips in an additive selection; Ctrl/Cmd+A and Edit → Select All select every Arrangement clip when the timeline has focus. Selected clips move together with the pointer or quarter-beat arrow nudges, preserving relative time, track spacing, lengths and source offsets. Ctrl/Cmd+D duplicates the selection after its bounding span (rounded up to the next quarter beat for fractional takes) with independent clip content for each copy. Delete and Activate/Deactivate operate on the selected group. Mixed activation becomes all active; an all-active group becomes inactive. Group loop selection spans its earliest start to latest end. Each committed group edit is one history step; held nudges retain the existing grouped-history behavior.

Group previews include clips beyond the current viewport. Collisions, upper timeline limits and track bounds reject the complete operation. Moving left clamps the group at beat zero without collapsing its spacing. Ordinary clicks select one clip; dragging an already-selected clip retains the group. Resize grips, inspector fields, Split and Consolidate still act on the primary clip and the inspector explicitly says so. Shift-drag time selection is retained. Region clipboard/marquee, group trim, track-limited time edits and full native workflow fidelity remain unfinished.

Evidence: six `tests/region-group.test.cjs` model tests cover preservation, bounds, collision atomicity, independent duplication and batch operations. `tests/region-group.cjs` exercises real Chromium selection, keyboard edits, cross-track drag, whole-edit collision rejection, offscreen selected clips and one-step Undo. Nine pre-existing Arrangement model regressions were also run against the published modules, including fractional playback slicing, inactive playback and source alignment. This release verifies editing state; it does not add new physical-device or audible live/export comparison evidence.

## 0.120 — Arrangement clip clipboard

Ctrl/Cmd+C, X and V now copy, cut and paste the selected Arrangement clips when the timeline has focus. Edit → Cut/Copy/Paste follows timeline or MIDI-note context; Paste Clip(s) explicitly uses the Arrangement clipboard. The internal clipboard retains relative timing, track spacing, lengths, source offsets, activation, MIDI notes, clip settings and embedded media. Each pasted region gets independently editable clip content. The snapshot survives source edits/deletion and New/Open operations in the same page, allowing cross-set transfer; it is not a system clipboard and does not survive page reloads.

Click or select an empty time range on the destination track before pasting. Without a time selection, paste starts at the stopped playhead. Destination track instruments, effects, sends and automation remain in effect; track settings and Arrangement automation are not copied. A successful paste advances the stopped playhead to the next quarter-beat boundary after the copied span for consecutive pastes. Existing clips are not replaced or shifted. A collision, insufficient destination tracks, timeline overflow or the existing 512-clip project limit rejects the complete paste. Cut and paste are separate Undo steps, and copying makes no project/history edit. Editing is locked during playback, recording and active operations.

Evidence: six `tests/region-clipboard.test.cjs` cases cover immutable media snapshots, independent region/clip IDs, relative destinations, cross-set transfer, shared-source independence, limits and failure atomicity. `tests/region-clipboard.cjs` runs both keyboard and Edit-menu paths in Chromium against IndexedDB with MIDI and an embedded WAV; it verifies copy without history changes, cut/paste Undo, collision rejection, playhead advancement, and transfer to a new set. `tests/region-clipboard-audio.cjs` compares offline renders of a source fixture and its pasted copy on equivalent destination tracks: 176400 stereo frames at 44.1 kHz, non-silent audio and zero maximum sample difference in the tested Chromium runtime. This is a focused offline fixture, not a full live/export or physical-device equivalence claim.

Still required: native/system clipboard interchange, overwrite/ripple paste semantics, track-scoped time edits, marquee selection and the broader core-song completion gate.
