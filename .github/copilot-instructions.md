# GitHub Copilot Instructions for Opusloops

Opusloops is a mobile-first, installable web loop studio. The production application lives in `mobile/` and deploys to `https://thuvee416.github.io/Opusloops/`.

The repository also retains a large GPL-licensed C++ desktop codebase from its upstream history. Treat that code as legacy/non-production unless an issue explicitly scopes migration or removal work there.

## Product boundary

Production work should preserve these constraints:

- Touch-first phone and tablet interaction
- Built-in Web Audio sounds and loops
- A focused sequencer and compact mixer
- Local project persistence in browser-managed storage
- PWA installation and offline reopening after a successful first load
- Calm visual hierarchy, warm neutrals, restrained motion, and one clear primary action

Do not reintroduce desktop-only assumptions into `mobile/`, including:

- External plugin hosting or VST, Audio Unit, and LV2 scanning
- Hover-only, right-click, desktop menu, or keyboard-only interactions
- Native desktop packaging, window management, or audio-driver setup
- MCP, OSC, WebSocket, or Lua control surfaces as core product features
- App Store or Play Store claims

## Review priorities

### Correctness and data safety

- Protect locally saved projects during schema or cache changes.
- Make local-storage migrations explicit and version stored project data.
- Never silently replace a saved project with defaults after a parse failure.
- Test first-run, reload, update, offline, and storage-denied states.
- Avoid network dependencies for core playback after the app shell is cached.

### Web Audio

- Start or resume the audio context only after a user gesture.
- Reuse nodes and schedules; avoid unbounded node creation each loop.
- Keep timing based on the audio clock rather than animation frames.
- Cancel scheduled work cleanly when playback stops or a project changes.
- Handle suspended/interrupted contexts when the app backgrounds and returns.
- Clamp volume and timing inputs before using them in the audio graph.

### Mobile interaction

- Keep primary touch targets at least 44 CSS pixels in each dimension.
- Do not require hover or precision pointing.
- Respect safe-area insets and narrow portrait viewports.
- Prevent accidental destructive actions and make project deletion explicit.
- Preserve scroll and gesture behavior; do not block page gestures globally without a concrete need.
- Test with touch input and at least one narrow viewport, not desktop resizing alone.

### PWA and deployment

- All production paths must work under the `/Opusloops/` GitHub Pages base path.
- Keep the web manifest, icons, start URL, scope, and service-worker paths aligned.
- Version caches deliberately and remove obsolete caches during activation.
- Do not cache failed or opaque responses as if they were valid assets.
- A successful build is not production proof; verify the deployed URL and active revision.

### Accessibility

- Give every interactive control an accessible name and visible focus state.
- Preserve keyboard access even though touch is primary.
- Respect reduced-motion preferences.
- Do not use color as the only indication of an active step, mute state, or error.
- Keep text legible at system zoom and with mobile text scaling.

### Security and privacy

- Do not commit secrets, credentials, private audio, or user project data.
- Treat browser-stored project data as untrusted input.
- Avoid analytics, fingerprinting, or network calls that are not necessary for the requested feature.
- Never claim cloud or file backup: production projects are local and this release has no export/import path.

## Change discipline

- Keep changes focused and explain the user-visible result.
- Add a regression test or a reproducible manual check for every substantive fix.
- Prefer the smallest reliable implementation over broad abstraction.
- Do not rename persisted legacy identifiers without a migration and compatibility test.
- Preserve GPL and third-party notices; see `NOTICE.md` and `LICENSE`.

## Review comments

Prioritize reproducible data loss, broken playback, offline/install failures, mobile interaction blockers, accessibility regressions, and security problems. Provide a specific code path, failing scenario, or test. Do not label speculative concerns as critical.
