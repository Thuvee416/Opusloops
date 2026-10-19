# OPUS LOOPS — Core DAW And Odesa Tempo First

Updated 2026-10-19 at the user's direction. This is the current delivery priority; read it before choosing work from the larger roadmap.

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

See CORE_BUILD_STATUS.md and the production proof fixtures for exact scope. Release 0.161.0 is live and verified: Session recording startup now preserves the existing Arrangement on preparation failure/cancellation, and native production capture plus one Undo passed with actual downloaded-project comparison. The original Test Thuvee 1 project is restored byte-for-byte. Compact desktop preview controls passed; physical mobile/device acceptance remains separate. Next: core Odesa Session-performance recording coverage through shared capture logic. The goal remains active and its acceptance gates are unchanged.
