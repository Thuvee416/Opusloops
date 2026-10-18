# OPUS LOOPS agent coverage

Audit: 2026-10-17. Source of truth: `web-studio/`, especially `agent-actions.js`, `agent-runner.js`, `agent-schema.js`, `app.js` and `menus.js`. This is a coverage audit, not a full-parity claim. Existing manual controls do not prove complete Ableton workflows. Disabled menu labels are not implemented features.

Evidence levels: **model** means an actual Bedrock plan was validated locally; **browser** means real application execution with deterministic mocked planning; **model + production** requires an authenticated real model request through the published studio, which remains unverified. Browser coverage does not establish musical quality or physical-device behavior.

| Area | Current agent control | Evidence | Remaining work |
| --- | --- | --- | --- |
| Project identity, tempo, master, loop/metronome | Project action; validated transport settings | Unit and browser; real-model tempo plan | Time signature, advanced configuration and broader workflow checks |
| Project save | Embedded-media project download; can follow edits in a plan | Sequence browser downloads and parses project (including captured model plan) | Reopen the agent-generated project in a fresh session; cloud project lifecycle |
| New/open/templates/default set | Manual controls exist; no agent workflow | Source audit | Guided file gestures, template selection, project lifecycle and replacement safeguards |
| Recovery/backups/previous set | Manual recovery exists; no agent workflow | Existing recovery tests apply only to manual path | Agent inspection and guided restore, with displaced-set recovery |
| Track/scene/return management | Add, rename/reorder/duplicate/delete tracks/scenes; add returns | Model composition; action unit tests; sequence browser | Return deletion/reordering, group tracks and full workflow coverage |
| Library/media/presets | Synth presets and existing audio clips can feed instruments | Action source audit | Search, browse, import gestures, organization and saved preset workflows |
| Session performance | Launch scene; play/pause/stop | Transport browser | Individual clip launch/stop, capture, slot transfer, follow actions and global performance workflows |
| Arrangement | Region add/update/remove, time edits, section markers | Action unit tests; composition sequence browser | Selection control, group trim, split/consolidate, clip/time clipboard commands and reference-based structure analysis |
| MIDI composition | Create/replace complete MIDI clips; note context capped at 256 | Model composition; unit; audible sequence export | Selection and expressive edits, safe large-clip transforms, generated drum clips and MIDI interchange workflow |
| Audio edits and warp | Clip audioEdit/warp/launch data can be changed | Validator/unit coverage is narrow | Complete argument schemas for every choice, warp preparation/result verification and representative audible checks |
| Instruments/drums/sampler | Synth preset/parameters, drum rack/pads, sampler from existing audio | Unit/source audit | Full parameter schema fidelity, pad samples, instrument automation, preset browsing and audible coverage |
| Audio/MIDI effects | Serial devices and complete MIDI-effect objects | Dynamics/routing units | Full choice/type schema coverage, default constructors for MIDI effects, chains/racks/macros and audible regression coverage |
| Routing/sends | Track output and sends; return creation | Routing unit | Group/submix/sidechain depth; send automation editing and return lifecycle |
| Automation | Track/return volume and pan envelope replacement | Unit | Device/send envelopes, modulation, automation recording/overrides and robust interaction with existing automation |
| Recording/input | Manual audio/MIDI and Session recording exist | Source audit | Agent recording workflow, permissions/device choices and measured timing. Current agent locks during takes/recording |
| Transport/navigation | Play/pause/stop/seek/scene/view; shared manual/agent runtime helpers | Browser, including stop → edit → play/pause | Selection/focus/panel controls and remaining navigation/preferences |
| Audio delivery | Default master WAV; edits and ordered playback/download commands in one request | Non-silent WAV sequence browser, sample peak and RMS checks | Agent export settings/ranges/channels, stems/MIDI, aligned output and quality assessment |
| Multi-step execution | Whole-plan preflight, stop/pause prerequisites, one atomic edit candidate, up to eight following runtime commands | Runner units; sequence browser; real-model plan → browser execution via captured fixture | Outcome-based musical evaluation, richer tool observation and production authenticated end-to-end proof |
| Undo/Redo/cancellation/errors | One manual Undo/Redo for agent project edits; stale-state and partial-progress reporting | Runner units and browser | Direct agent Undo/Redo controls and broader interruption/storage failures. Runtime/download effects are reported separately |
| Account/settings/accessibility/integrations | Account sign-in and accessible agent dialog; no general settings tools | Sign-in API/auth unit coverage; browser panel | Authenticated production agent proof, refresh/sign-out lifecycle, settings/device/a11y and supported integration commands |

Every feature added after this audit must add or update its agent command/state surface, coverage row, representative workflow evidence and limitations. Project success requires both manual and natural-language operation. Full application-wide coverage remains open.
