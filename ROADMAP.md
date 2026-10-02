# Opusloops roadmap

Last reviewed: October 2, 2026.

## Direction

Make the journey from a folder of stems to an intentional arrangement feel direct on a phone or desktop. Keep musical decisions visible, preserve source audio, and make processing understandable.

This is a proposed direction, not a release schedule. Items below are not shipped unless identified as an existing foundation. No dates or contributor commitments are implied. Discuss scope and acceptance tests in issues before implementation.

## Existing foundation

The source includes a responsive studio, authenticated project storage, resumable ZIP uploads, staged timing analysis and approval, shared-map tempo rendering, four- or eight-bar editing windows, section looping, mute and solo, and a persistent player. Desktop adds project commands, horizontal lanes, and mixer faders.

See the [current limitations](README.md#project-status-and-boundaries). These capabilities do not guarantee that every large or unusual project will process correctly.

## Priority 1: Trust the session

| Proposed work | Success criteria |
| --- | --- |
| Large-project playback hardening | Documented device/browser tests with measured memory use, synchronization, and seek behavior |
| Audible mixer regression tests | Gain, mute, solo, and section edits verified against audio, not just UI values |
| Recoverable processing failures | Clear failure stages and safe retries without duplicate jobs or silent data loss |
| Better timing confidence | Ambiguous sections identified with short auditions and corrections that avoid editing hundreds of events |
| Account recovery | Verified password recovery and email-change flows with expired-link and account-isolation tests |

## Priority 2: Finish arrangements with less friction

| Proposed work | Success criteria |
| --- | --- |
| Section operations | A coherent workflow for duplicating, moving, splitting, and removing sections on touch and desktop |
| Undo and redo | Recoverable edits with a documented history model and clear server-operation boundaries |
| Navigation and selection | Predictable zoom, selection, and keyboard focus without accidental edits |
| Full stem-project export | Whole-arrangement mixdown with progress, cancellation, headroom controls, and verified duration/alignment |
| Portable project backup | Documented export/import format preserving arrangement data and explaining audio dependencies |

## Priority 3: Make contribution and self-hosting easier

| Proposed work | Success criteria |
| --- | --- |
| Contributor demo mode | Synthetic audio fixtures and a local-only demo that never bypasses production authentication |
| Reproducible backend setup | Parameterized deployment and a successful clean-account installation guide |
| Cost transparency | Measured processing examples, retention choices, and resource teardown instructions |
| Accessibility coverage | Keyboard and screen-reader workflows plus reduced-motion and contrast checks |
| Release documentation | Versioned release notes and an honest browser/project-format compatibility matrix |

## Longer-term exploration

These are ideas to evaluate, not approved implementation plans:

- Assisted arrangement suggestions that users can preview, edit, and reject.
- Additional tempo/downbeat analysis approaches evaluated on rights-cleared material.
- Level and transition automation with understandable touch controls.
- Audio effects that fit browser CPU budgets and export consistently.
- Optional project sharing with explicit ownership, storage, and permission rules.
- Interchange with other music tools through documented exports.

Native plugin hosting, full-song generative model training, and real-time collaboration are not current commitments. Each needs its own technical, licensing, cost, and product review.

## Help set priorities

Open a [feature request](https://github.com/Thuvee416/Opusloops/issues/new?template=feature_request.yml) describing the musical outcome, current workaround, device, and a small example. Link an existing issue where appropriate. Reproducible failures and real workflows help prioritize work more than broad wish lists.

For a contribution, agree on a small scope and acceptance tests first. See [CONTRIBUTING.md](CONTRIBUTING.md). A roadmap item is not assigned work or a promise of acceptance.
