# Contributing to Opusloops

Thank you for helping improve Opusloops.

## Before you start

Open an issue before investing in a substantial change. Describe the problem, the proposed result, and any user-facing or compatibility impact. Small bug fixes and documentation corrections can go directly to a pull request when the scope is clear.

## Contributions we welcome

- Bug fixes with a reproducible case
- Documentation and accessibility improvements
- Performance improvements with before-and-after evidence
- Focused features discussed with the maintainers
- Tests that cover real regressions or compatibility requirements

Avoid mixing unrelated changes, broad rewrites, or new third-party service dependencies into a focused pull request.

## Development setup

The production app is a static PWA in `mobile/`. A local HTTP server is enough to run it:

```bash
git clone https://github.com/Thuvee416/Opusloops.git
cd Opusloops
python3 -m http.server 4173 --directory mobile
```

This serves only the frontend. The checked-in configuration targets the hosted AWS API, which requires an authorized account. It does not create a local backend. Use fixture-backed tests for contributions rather than production accounts or private audio. See [README.md](README.md#quick-start) for setup and test commands, and [ROADMAP.md](ROADMAP.md) for proposed priorities.

Run `bash scripts/validate-mobile.sh` before submitting changes. For UI changes, also run the browser tests described in the README and include screenshots at mobile and desktop widths. Backend and worker changes need their corresponding tests under `infra/aws-backend/tests/` and `worker/tests/`.

## Pull request guidelines

1. Keep each pull request focused on one concern.
2. Explain what changed, why it changed, and how you verified it.
3. Add regression tests for bug fixes when practical.
4. Preserve compatibility for locally saved projects unless a migration is explicitly designed and tested.
5. Verify a narrow mobile viewport and desktop layout, relevant mouse/keyboard/touch input, reduced motion, and offline failure handling. Do not test against production accounts or deploy infrastructure without maintainer authorization.
6. Never put secrets, private audio, API keys, or credentials in a commit or issue.

Suggested branch names are `feat/<description>`, `fix/<description>`, and `docs/<description>`.

## Web Audio and mobile requirements

- Start or resume audio only after a user gesture.
- Schedule against the audio clock rather than visual animation timing.
- Handle background, foreground, interrupted-audio, and reduced-motion states.
- Keep primary controls touch-sized and avoid hover-only or right-click interactions.
- Treat browser-storage, service-worker, and project-format changes as data-safety work.

The retained C++ desktop source is non-production. Changes to it require an issue that explicitly scopes legacy compatibility or removal work. Desktop browser improvements belong in the responsive web app under `mobile/`.

## Good first contributions

- Reproduce a browser-specific issue using synthetic audio.
- Add a focused regression test for an existing control.
- Improve a keyboard label, focus state, or reduced-motion behavior.
- Correct setup documentation after following it from a fresh clone.

Describe the expected result and test plan before starting a larger audio or infrastructure change. Keep discussions respectful and focused on observable behavior. Never attach private user projects or audio without redistribution rights.

## Contribution terms

Opusloops does not use the former upstream contributor license agreement. Contributions to this repository are accepted under the [GNU General Public License v3.0](LICENSE) only. By submitting a contribution, you represent that you have the right to provide it under that license.

The upstream project's historical contribution terms are not transferred to Opusloops. See [CLA.md](CLA.md) and [NOTICE.md](NOTICE.md) for clarification and provenance.
