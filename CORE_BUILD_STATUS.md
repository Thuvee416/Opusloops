# Core DAW And Odesa Tempo Build Status

Updated 2026-10-19. The replacement Codex goal is active. Scope and acceptance: GOAL.md. Preserve existing features, designs and user projects; defer enhancements and advanced production work.

## Evidence From The Initial Audit

- 14 existing source-level tests pass: session-start checkpoint/recovery (including invalid data and storage failure), transport Stop/Continue/seek/start cancellation, Session arrow boundaries, atomic agent transport validation, and a serialized 32-bar study with embedded media and actual MIDI-file content checks. Command: `node --test tests/session-recovery.test.cjs tests/transport-controls.test.cjs tests/core-song-roundtrip.test.cjs`.
- Normal Chrome on an isolated localhost origin (4210), using the real application with no auth or model stubs: edited the initial demo project name with keyboard input and Enter/blur, saved through File → Save Live Set, normally reloaded, closed the welcome dialog and saved again. Both downloaded projects were 5,615 identical bytes, SHA256 `35b6baf7b8a9713138f7983279a617b8c07d0f6e44d10a62b48532900735cce2`, with name Core Tempo Audit 20261019 X, 120 BPM, four tracks, 14 clips and no Arrangement. No page warnings/errors were observed.
- Source-level checks do not establish browser audio, recording, output quality or authenticated model execution. The native reload check uses the initial generated-loop demo, not the representative imported/recorded multitrack song. It does not establish file-chooser Open, explicit close/reopen in a new browser tab, input-device timing or export fidelity.
- An initial automation value-only name fill did not commit a project rename. A normal native keyboard edit, Enter and blur did commit it, and the downloaded project/reload matched. This is not recorded as an application defect; do not patch the app solely to accommodate a synthetic input action.

## Next Core Audit Step

1. Continue on an isolated origin; keep the user's production project untouched.
2. Verify opening an actual downloaded .opusloop file through File → Open Live Set, including embedded media, content/selection recovery, failure handling and subsequent save equality.
3. Start an empty set and work through import, basic tracks/MIDI/editing, Session/Arrangement, recording, basic mix, save/reopen and mix/stem delivery. Repair the earliest reproduced core failure with meaningful coverage.
4. Verify Tempo against each accepted core operation. Retained known model-fidelity gaps include missing region clipId in a compound setup, wrong preset/instrument choice and a first-beat onset mismatch (ROADMAP.md, 0.152 signed-in verification). Fix these as core Tempo correctness work after the corresponding manual behavior is established. Use actual saved projects and output files; keep model requests within existing limits.

No core gate is accepted yet. No model request was consumed in this initial audit, and no product implementation or visual change was made.
