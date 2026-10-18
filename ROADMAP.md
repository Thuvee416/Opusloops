# OPUS LOOPS feature-parity roadmap

Updated 2026-10-17. The active goal is OPUS LOOPS: a browser DAW covering Ableton Live's workflows and feature categories, with natural-language agent control built into every aspect of the application. Full parity is **not achieved**. Build the core music-making workflow first; do not treat a feature label, menu entry, or narrow passing test as proof of a complete workflow.

## Current production source

AWS Amplify publishes `web-studio/`. The older application in `mobile/` remains historical and does not establish functionality in the published studio. `web-studio/release.json` records the artifact revision; live `version.json` records the actual deployed commit. Hosting success and live runtime checks are separate evidence.

## Application-wide natural-language control requirement

Natural-language control is a requirement of the overall goal and of every existing and future feature. It is not confined to the Studio agent panel or to a separate mixing feature. Every core-first gate and every feature-parity category below includes its agent interface and verification work. A working manual UI alone does not complete a feature for this goal.

Coverage must include:

- Projects and files: create/open, naming, templates, saving, autosave, backups, recovery, version management, cloud synchronization where implemented, and project interchange.
- Library and media: search, browsing, import, organization, sample and preset selection, metadata, and media management.
- Composition and editing: Session and Arrangement, tracks/groups/returns, scenes, clips, selections, clipboard operations, song sections, time edits, notes, expressive MIDI, recording, take/comp workflows, audio edits and warping.
- Sound and production: instruments, samplers, drum racks, audio/MIDI effects, racks/macros, routing, sends, automation, modulation, mixing, mastering and reference-guided arrangement or production.
- Performance and delivery: transport, tempo, meter, launch behavior, live performance, controller mappings, synchronization, render settings, mix/stem/MIDI export and delivery checks.
- Application operation: navigation, views, selections, configuration, preferences, device setup, account/project settings, accessibility, supported integrations, and diagnosing or recovering from errors.

Implementation and completion requirements:

1. Expose actual supported operations and inspectable state through one validated command/capability layer shared with the manual interface. Add agent access when adding a UI feature, and audit existing features for missing access.
2. Resolve natural language into multi-step plans using current project, selection, transport, routing and relevant audio/MIDI analysis. Maintain conversational context and ask focused questions when necessary. Reference-song claims require actual reference evidence; state assumptions otherwise.
3. Execute real application operations, observe their results, and use errors or measured output to repair plans. Verify that the requested musical or application outcome occurred; a generated plan or success message alone is insufficient.
4. Preserve project integrity through validation, stale-state protection, cancellation and grouped Undo/Redo wherever supported. Respect browser/OS permissions and required user gestures; guide the user through those steps and resume the workflow, without claiming unattended execution.
5. Keep model credentials server-side, disclose transmitted session/analysis data, enforce account/usage boundaries, and surface truthful progress, failures, limitations and completed actions.
6. Maintain a coverage matrix for each feature (current audit: `AGENT_COVERAGE.md`): manual operation, agent command/state access, multi-step workflow evidence, Undo/recovery behavior, and browser/platform limitations. Missing agent access or verification keeps that feature incomplete.
7. Verify authenticated production workflows and representative musical outcomes, including stem mixing and reference-guided restructuring. Include audible/rendered-output review where quality is part of the request; parameter edits alone do not establish professional mix quality.

Goal completion requires both the requested DAW feature scope and application-wide natural-language control to be implemented and verified. The first agent release is partial and does not satisfy this completion condition.

## Agentic control as a core workflow

Release 0.122 introduces a real model-backed studio agent, not a keyword command parser: media-free session inspection, source peak/RMS analysis, bounded action plans, validation/repair, stale-session and cancellation protection, one Undo per project-edit request, and runtime controls. AWS Cognito protects the Bedrock endpoint; account usage is bounded. See `web-studio/AGENT.md` for the implemented action surface, test boundaries and limitations. Full application coverage, reference-audio structure analysis, rendered mix evaluation and representative end-to-end production/music-quality benchmarks remain open. Natural-language access must grow with each core capability and never claim an unsupported operation executed.

## Core-first gates

| Gate | Current scope and remaining verification |
| --- | --- |
| Project and playback reliability | Local project storage, embedded media, project files, transport, loop/seek, and undo exist. Release 0.118 adds validated session-start recovery. Multi-track long-playback stress tests, interruption matrices and device measurements remain incomplete. |
| Compose and arrange a song | Session clips/scenes, Arrangement editing, capture, MIDI editing and sample import exist as subsets. Release 0.119 adds additive multi-region selection, grouped movement/duplication/deletion/activation and Select All. Release 0.120 adds an internal region clipboard. Release 0.121 adds chosen-track time insertion/deletion/duplication and scoped time copy/cut/paste. Release 0.122 adds marquee selection with additive selection and scrolling. Region fades/crossfades and full workflow coverage remain unfinished. |
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

1. Use `AGENT_COVERAGE.md` to close existing control gaps and verify the authenticated production agent workflow.
2. Audit the whole representative-song core workflow through both manual and natural-language operation, preserving reproducible project/audio fixtures.
3. Extend Arrangement group trim and region fades/crossfades with matching agent commands and verification.
4. Complete group/routing workflows and their agent access; verify the audio output of live and offline paths.
5. Add performance/recording measurements and natural-language workflow checks across actual browsers and input/output devices.

Keep this objective active until every requested feature category and workflow, including natural-language control across all aspects of the application, has current implementation and verification evidence.

## 0.119 — Arrangement clip groups

Ctrl/Cmd-click toggles clips in an additive selection; Ctrl/Cmd+A and Edit → Select All select every Arrangement clip when the timeline has focus. Selected clips move together with the pointer or quarter-beat arrow nudges, preserving relative time, track spacing, lengths and source offsets. Ctrl/Cmd+D duplicates the selection after its bounding span (rounded up to the next quarter beat for fractional takes) with independent clip content for each copy. Delete and Activate/Deactivate operate on the selected group. Mixed activation becomes all active; an all-active group becomes inactive. Group loop selection spans its earliest start to latest end. Each committed group edit is one history step; held nudges retain the existing grouped-history behavior.

Group previews include clips beyond the current viewport. Collisions, upper timeline limits and track bounds reject the complete operation. Moving left clamps the group at beat zero without collapsing its spacing. Ordinary clicks select one clip; dragging an already-selected clip retains the group. Resize grips, inspector fields, Split and Consolidate still act on the primary clip and the inspector explicitly says so. Shift-drag time selection is retained. At 0.119, region clipboard/marquee, group trim, track-limited time edits and full native workflow fidelity remain unfinished.

Evidence: six `tests/region-group.test.cjs` model tests cover preservation, bounds, collision atomicity, independent duplication and batch operations. `tests/region-group.cjs` exercises real Chromium selection, keyboard edits, cross-track drag, whole-edit collision rejection, offscreen selected clips and one-step Undo. Nine pre-existing Arrangement model regressions were also run against the published modules, including fractional playback slicing, inactive playback and source alignment. This release verifies editing state; it does not add new physical-device or audible live/export comparison evidence.

## 0.120 — Arrangement clip clipboard

Ctrl/Cmd+C, X and V now copy, cut and paste the selected Arrangement clips when the timeline has focus. Edit → Cut/Copy/Paste follows timeline or MIDI-note context; Paste Clip(s) explicitly uses the Arrangement clipboard. The internal clipboard retains relative timing, track spacing, lengths, source offsets, activation, MIDI notes, clip settings and embedded media. Each pasted region gets independently editable clip content. The snapshot survives source edits/deletion and New/Open operations in the same page, allowing cross-set transfer; it is not a system clipboard and does not survive page reloads.

Click or select an empty time range on the destination track before pasting. Without a time selection, paste starts at the stopped playhead. Destination track instruments, effects, sends and automation remain in effect; track settings and Arrangement automation are not copied. A successful paste advances the stopped playhead to the next quarter-beat boundary after the copied span for consecutive pastes. Existing clips are not replaced or shifted. A collision, insufficient destination tracks, timeline overflow or the existing 512-clip project limit rejects the complete paste. Cut and paste are separate Undo steps, and copying makes no project/history edit. Editing is locked during playback, recording and active operations.

Evidence: six `tests/region-clipboard.test.cjs` cases cover immutable media snapshots, independent region/clip IDs, relative destinations, cross-set transfer, shared-source independence, limits and failure atomicity. `tests/region-clipboard.cjs` runs both keyboard and Edit-menu paths in Chromium against IndexedDB with MIDI and an embedded WAV; it verifies copy without history changes, cut/paste Undo, collision rejection, playhead advancement, and transfer to a new set. `tests/region-clipboard-audio.cjs` compares offline renders of a source fixture and its pasted copy on equivalent destination tracks: 176400 stereo frames at 44.1 kHz, non-silent audio and zero maximum sample difference in the tested Chromium runtime. This is a focused offline fixture, not a full live/export or physical-device equivalence claim.

Still required at 0.120: native/system clipboard interchange, overwrite/ripple paste semantics, track-scoped time edits, marquee selection and the broader core-song completion gate.

## 0.121 — Chosen-track Arrangement time edits

Arrangement → Time edits now has an explicit Whole song / Chosen tracks scope. Choose one or more tracks in the list to insert silence, delete time, duplicate time, or copy/cut a passage on only those tracks. Clips crossing a boundary split with preserved source phase; selected-track mixer, device and send automation follows the edit. Unchosen tracks, return-channel automation, locators, loop bounds and the stopped playhead remain unchanged. Choosing every regular track still excludes global markers and return automation; choose Whole song to move the full song timeline. Whole song remains the default and retains the existing global behavior.

Time-range highlighting and its readout reflect the chosen scope. Chosen mode requires an explicit nonempty track selection; controls are locked during playback and recording. A time clipboard records its source track IDs/scope. Paste inserts only in that saved scope even when the current Scope control differs, and rejects missing tracks or mismatched contents before changing the project. Each destructive operation has one Undo step. This extends time-range editing; it does not provide track remapping or system-clipboard interoperability.

Evidence: seven `tests/time-scope.test.cjs` cases cover track/automation isolation, boundary splitting, independent duplication, pinned clipboard scope, invalid selections, whole-song compatibility and unchosen material at the timeline limit. All 16 pre-existing time-edit/time-clipboard model regressions were rerun against the current published modules. `tests/time-scope.cjs` verifies the actual controls, chosen-lane highlighting, all five destructive operations, Edit-menu paste, scope retention, playhead/global bounds, Undo and playback locks in Chromium. Group editing, region clipboard, startup, welcome and session recovery browser regressions also pass.

`tests/time-scope-audio.cjs` renders non-silent embedded audio before/after a chosen-track insertion over a fixed 16-beat range at 44.1 kHz: the unchosen delay track has zero maximum sample difference across 352800 stereo frames; inserted silence has zero RMS; source-phase and volume-envelope alignment after the insertion differ by less than 1e-4 (observed maximum about 5.8e-11). These are focused offline checks, not full live/export equivalence or physical-device evidence. The core-song completion gate and broader parity work remain open.

## 0.123 — Sequenced agent workflows

Plans may stop/pause first, apply their validated project edits together, then execute up to eight ordered runtime commands. This permits composing/arranging, switching views, playing, pausing and downloading in one request. Entire-plan preflight rejects an invalid late command before any project or transport change. Manual and agent transport, project download and WAV export share runtime helpers. Agent work is locked during active recording/takes and pending playback startup.

Runtime operations are separate from project history: all project edits use one Undo/Redo step; failed exports or cancellation after editing retain those edits and report how to undo them, plus any runtime operations already completed. Full application coverage and authenticated production inference remain unverified. See `AGENT_COVERAGE.md` for the audited gaps.

## 0.124 — Agentic Session performance and explicit Session export

Individual trigger/toggle clip launch, per-track clip stop and all-clips stop are available through natural language. Scene and clip requests wait for native quantization receipts and the audio clock, including slower per-clip launch grids, before later plan steps proceed. No-Stop slots retain their clip. Native stopped-track stop no longer starts transport. Stop or cancellation during preparation prevents delayed launches; cancel during quantization removes only owned unscheduled events and reports already-started performance state.

Explicit Session WAV source exports the active clip snapshot even when an Arrangement exists; automatic source retains prior Arrangement preference. Session snapshots start each clip from its beginning for sixteen beats and bypass Arrangement automation. Manual WAV/stem export shares the Session source option. Gate/repeat holds, mixed Arrangement/Session capture, live phase preservation, broader performance workflows and authenticated production inference remain open.

Evidence: native/receipt unit tests and `tests/agent-session.cjs`, with generated tones and a captured real-model Session plan. The browser fixture checks slow clip quantization, retained no-stop slots, the new high-frequency clip in Session output, exactly muted Arrangement output, individual/all stops, and cancellation that does not leak a late clip launch into a subsequent render. These are scheduling and offline-output checks, not physical audio-device or perceptual-quality verification.


## 0.125 — Shared studio theme and inline agent

The welcome modal and Studio agent now share the application's neutral surfaces, accent token, Arial typography, compact borders, controls and black logo. The welcome keeps its SoftAurora band and per-visit dismissal behavior. Its agent description reflects the currently available experimental controls.

The Studio agent is a persistent workspace dock beside the timeline on wide screens and below it on smaller screens. It no longer uses a modal dialog or blocks the rest of the studio. Collapse preserves conversation, prompt and running work; explicit Cancel stops a request. Conversation updates scroll only their own feed. Account sign-in remains inline.

Evidence: `tests/agent-layout.cjs` checks desktop, tablet and small-phone bounds, shared theme, keyboard safety, background view switching, account access and a task completing while collapsed. Existing agent edit/Undo, stale-plan, cancellation, sequenced playback/export and Session performance suites remain covered with mocked/captured model responses; authenticated production model inference remains unverified.


## 0.125.1 — Global Interface Title Capitalization

A shared typography rule capitalizes every word in interface headings, buttons, menu items, tabs, labels, summaries, dropdown options and project/track headings, including controls created after startup. Stored names, option values, typed prompts and technical output retain their original contents.


## 0.125.2 — Mobile Vector Controls

Font-glyph control icons are replaced with a shared, monochrome SVG sprite for transport, clip/scene launch, recording, settings, navigation, menus, close/add/remove/reorder controls and template dialogs. The sprite is installed inside the existing startup gate with no external icon-font or image request. Browser category/result and slot-menu marks use CSS vector shapes. Icons inherit control colors, remain outside accessible names and cannot intercept touch/pointer events. Musical notation, mathematical units and keyboard-shortcut text stay as text.

Validation includes phone-sized layouts and touch Play/Pause/Stop, library clear/close, effect add/remove and export-dialog dismissal; accessible icon labels and symbol references; startup gating; sequenced agent playback/export and Session quantization/output checks.
