# OPUS LOOPS — Core DAW And Odesa Tempo First

Updated 2026-10-19 at the user's direction. This is the current delivery priority; read it before choosing work from the larger roadmap.

## Current Work Direction — 2026-10-19

The bounded core milestone below is complete. The user has now asked to continue the rest of the application build and leave the music-model build for later. Continue practical manual DAW/project workflows, preserving the existing Odesa integration. No further provider evaluation, credential changes or music-model work is part of this increment. Historical acceptance records below remain intact.

## Active Continuation

Product boundary confirmed by the user: **Stay Browser-Based.** Improve the original browser-native instruments, effects and editable demo. The researched commercial synths/effects are production references, not bundled or hosted products. Do not introduce a desktop companion or native plug-in hosting without a new explicit change of direction.

The user resumed the core-first goal after release 0.166.0. Continue closing practical manual project/editing/transport/recording/mixing/delivery gaps and publish bounded increments. Preserve the existing Odesa integration; further music-model work remains deferred. The remaining native browser verification was waived by the user and must be reported as unverified rather than blocking these releases. Keep source-level safety checks and the deployment result distinct from workflow proof.

Current increments: Recent Sets shipped in 0.166.0, shared Undo History in 0.167.0, and precise Arrangement clip editing in 0.168.0. Release 0.169.0 repairs recording click/count-in behavior and adds Tap Tempo and metronome settings. Release 0.170.0 adds precise inline mixer levels and pan entry with shared automation and history behavior. Release 0.171.0 connects selected-track Mute/Solo across mixer, menus and keyboard and adds optional exclusive solo. Release 0.172.0 makes empty MIDI clip creation work from a fresh set and respect Session slots or Arrangement time/track selection. The 0.173.0 increment adds aligned batch stem import and repairs original-speed timing for ordinary audio import. Release 0.174.0 corrects track-header Edit-menu targeting, adds grouped track Duplicate/Delete and track Rename/Select All shortcuts, and preserves routing and source ownership in one Undo. Release 0.175.0 adds exclusive input-track arming and exact Session-slot recording with bound Odesa receipts. Release 0.176.0 adds direct audio/MIDI input recording into empty Arrangement time with linear accompaniment, count-in, bounded capture and negotiated Odesa command support. Prioritize existing menu/workflow gaps over new model capabilities or visual redesigns.

## Working Goal

Make the basic Ableton-style music-production functions in the published OPUS LOOPS Studio work reliably, together, and build Odesa Tempo 1.0 to control those same core operations accurately. Both are included in the current goal, before further enhancements or advanced features. Keep everything already built. Fix and verify the existing foundations rather than expanding feature breadth or redesigning the interface.

## Work Order

1. **Projects And Transport:** New/open/save, portable project downloads, autosave/recovery, close/reopen, Play/Stop, seek, loop, tempo and metronome. Protect the user's existing projects and media.
2. **Tracks And Media:** Import audio; add, rename and remove tracks; select clips; adjust volume/pan and Mute/Solo; retain usable master output. Verify real playback and consistent state.
3. **Basic MIDI And Arrangement:** Create and edit MIDI notes with an existing instrument; move, trim, split, duplicate and delete audio/MIDI clips; snapping, selections and Undo/Redo. Keep edits predictable through menus, keyboard and pointer interaction.
4. **Session And Recording:** Launch/stop clips and scenes, transfer or capture a simple Session performance into Arrangement, and record basic audio/MIDI takes. Check actual supported input devices, monitoring, timing and playback; document platform limits.
5. **Basic Mix And Delivery:** Make existing basic effects and volume automation dependable, save/reopen a song without lost content, and export a playable WAV plus aligned stems through the existing export path.

Start with an audit of the existing published workflow. Treat data loss, incorrect playback/editing, broken controls and failed save/reopen/export as blockers. Fix the first failed core step before adding capabilities. Each item above is pending end-to-end acceptance, even where partial implementations or isolated tests already exist.

## First Milestone: A Reliable Basic Song Workflow

From an empty set, import audio, record a take, create MIDI with an existing instrument, arrange a short multitrack song, make ordinary clip and mixer edits, exercise Undo/Redo, add a basic effect and volume change, save, close, reopen, continue editing, then export a mix and aligned stems. Verify content and timing preservation, audible/rendered output, and desktop/mobile controls. Check supported browser/device combinations and record limits. A menu label, generated plan, parameter change or narrow test alone is not acceptance.

## Odesa Tempo Build And Acceptance

After each manual core operation is verified, make Tempo reliably inspect and control the same operation through the shared command layer. Keep it inline, use current project/selection/transport state, and verify actual results. Cover ordinary multi-step clip/track/MIDI/Arrangement/mixer/transport/save/export requests, correct instrument/preset choices and musical coordinates. Failed or cancelled plans must not leave partial edits; retain stale-state safeguards and one grouped Undo for project-edit requests. Respect normal account limits and permissions.

The core DAW and its Odesa Tempo counterpart are both acceptance gates for this new goal. Local mocked planning, source tests and real-model planning are distinct from authenticated published execution; verify both the saved project and resulting audio/files, not just a success message. Preserve the existing Odesa experience throughout. Full application-wide natural-language coverage remains a later requirement; new advanced agent capabilities do not displace basic workflow repairs.

## Deferred Until Both Core Gates Pass

Only then resume enhancements and advanced production work: deeper warping/time stretching, take lanes and comping, expressive MIDI, advanced routing/racks/modulation, new instruments/effects, reference-guided production, automated mastering, external synchronization/controllers, plug-in/native bridges and further visual/motion redesigns. Existing implementations in these categories remain in place and are preserved during core repairs. Full Ableton feature parity remains a later roadmap, not the first milestone's completion condition.

## Execution Rule

Choose the next task by the earliest failing core workflow step. Report what actually works, the failure repaired, the relevant verification and remaining limits. No broad parity or professional-quality claims without matching evidence. Preserve normal authentication, permissions and usage limits. Do not mark this goal complete until the representative manual song round trip and corresponding Odesa Tempo workflows pass. See CORE_BUILD_STATUS.md for the current evidence and next audit step.

## Latest Verified Progress — 2026-10-19

See CORE_BUILD_STATUS.md and the production proof fixtures for exact scope. Release 0.161.0 is live and verified: Session recording startup now preserves the existing Arrangement on preparation failure/cancellation, and native production capture plus one Undo passed with actual downloaded-project comparison. The original Test Thuvee 1 project is restored byte-for-byte. Compact desktop preview controls passed; physical mobile/device acceptance remains separate. Odesa Session-performance start/launch/finish/cancel subsequently passed authenticated 0.162/0.162.1 checks with exact Undo/Cancel file preservation. Shared natural-language Undo/Redo subsequently passed authenticated 0.163.0 checks, including actual saved files, manual-control interoperability and stale-history protection. Next confirmed gap: New/Open/Import through Odesa using the shared native lifecycle/file-choice paths, then the remaining bounded acceptance audit. The goal remains active and its acceptance gates are unchanged.

Shared import preparation was subsequently deployed as 0.163.1 and verified with native production files: failed audio import is unchanged, successful new-track audio import is one Undo. Odesa project/file-command integration remains next; see CORE_BUILD_STATUS.md.

0.164.0 now deploys Odesa New/Open/Audio Import/MIDI Import. Native authenticated New+Save is verified from its actual downloaded empty set; Open/import/cancellation/stale chooser acceptance remains pending. The original Test Thuvee 1 is restored and survives refresh, with a new saved copy matching the original exactly. Continue production acceptance on the separate www origin after normal sign-in, preserving the apex user's project. CORE_BUILD_STATUS.md now contains the requirement-by-requirement completion audit and explicit remaining evidence gaps. No core gate or goal scope has been removed.

The remaining-core audit then reproduced and repaired track/source rename scope, structural track deletion and main-view/detail-panel confusion. 0.164.1 is deployed and its three bounded real-provider cases pass independent candidate/command checks, with 438 core and 86 backend regressions passing. Authenticated native acceptance remains pending on the isolated www origin; the apex user project is preserved. See CORE_BUILD_STATUS.md and core-controls-provider/hosting proof files.

0.164.2 adds explicit model schemas for relative Arrangement operations and rejects empty clarification markup. Native drag snapping, move/duplicate/delete/end-trim and exact Undo/Redo now have actual downloaded-file proof. Three corresponding real-provider plan checks pass after repair; hosting is verified separately. Authenticated I/O, ordinary core-control and Arrangement execution still await separate www sign-in. Core goals and all remaining acceptance requirements stay intact.

2026-10-19: Authenticated www acceptance now verifies Odesa Open/Save, audio/MIDI imports, chooser Cancel/stale rejection, mixer/rename/remove, exact bar9 seek/Play/Stop and relative Arrangement move/trim/duplicate/delete/selection. Actual downloads and one-Undo comparisons preserve every unmentioned field. 0.164.3 fixes detail selection feedback; 0.164.4 fixes stale file-choice false-success reporting and passes the production retest. Goal remains active; finish the recording/input and complete requirements audit with explicit platform/audio limits. No scope reduction or completion claim.


### 2026-10-19 — Core DAW And Odesa Tempo Milestone Accepted

The core-first acceptance audit is complete for verified Chrome/macOS behavior, with explicit device/mobile/listening limits. Authenticated production audio Start/Finish and exact Undo/Redo passed; microphone input was disconnected. The saved6.8second stereo take was placed at bar13 through Odesa, survived closing/reopening the production tab byte-for-byte, and remained correct through a subsequent native mix edit and16-bar WAV/four aligned stem export. Actual recorded-source/stem correlation at bar13 is0.9999656. No captured media was uploaded or committed; original apex project remains untouched. See CORE_BUILD_STATUS.md final acceptance and tests/fixtures/core-audio-production-proof.json for exact artifacts, session-auth boundary, account usage and limitations.

This closes the bounded core DAW + Tempo milestone, not full Ableton parity or professional-quality/mobile/hardware certification. Existing features remain; no enhancement work starts automatically. Broader features, device/browser expansion and Forte/Prelude remain future work. This evidence-only update makes no new production release;0.164.4 remains the verified deployed build.
