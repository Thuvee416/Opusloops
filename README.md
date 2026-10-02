<p align="center">
  <img src="assets/opus-loops-logo.png" alt="Opusloops" width="200">
</p>

<h1 align="center">Your AI DAW. Built for what comes next.</h1>

<p align="center">An open-source, browser-based music workspace for turning stems into arrangements.<br>Upload. Find the tempo. Shape the mix. Make it yours.</p>

<p align="center">
  <a href="https://opusloops.com/">Open Studio</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="ROADMAP.md">Roadmap</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="https://github.com/Thuvee416/Opusloops/issues">Feedback</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-65d8bc" alt="GPL-3.0 license"></a>
  <a href="https://github.com/Thuvee416/Opusloops/actions/workflows/mobile.yml"><img src="https://github.com/Thuvee416/Opusloops/actions/workflows/mobile.yml/badge.svg" alt="Web app checks"></a>
  <img src="https://img.shields.io/badge/platform-browser-9b87f5" alt="Browser platform">
  <img src="https://img.shields.io/badge/status-early%20access-f5b65a" alt="Early access">
</p>

## From generated audio to your own arrangement

Generating a song is only the beginning. Working with its stems should not mean fighting drifting tempos, tiny controls, or a complicated setup before making a musical decision.

Opusloops focuses on that next step: bring in stems, review their timing, arrange in four- or eight-bar sections, and balance the mix. Start on your phone and use a roomier workspace on desktop. Web Audio powers playback, with an isolated server-side pipeline for stem analysis and tempo rendering.

**Open source, not open hype.** The source is public under GPL-3.0. The hosted app is early access and requires sign-in with invitation-based registration. This is a developing music tool, not a claim of feature parity with a mature desktop DAW. Star the repository if you want to follow its progress.

## What you can do today

| Workflow | Included in the current source |
| --- | --- |
| Bring your own stems | Import a ZIP with resumable uploads and confirmed-byte progress |
| Review before processing | Inspect files, choose roles and an analysis reference, then approve the timing proposal |
| Work with drifting tempo | Analyze timing and render included stems against a shared piecewise tempo map |
| Arrange in sections | Edit four- or eight-bar windows and loop the current section |
| Shape the mix | Levels, mute, and solo with touch-drag tiles or desktop faders |
| Keep playback in reach | Persistent playback and seeking across workspace views |
| Sketch a loop | Built-in Web Audio sounds and a step sequencer |
| Save your work | Account-scoped local project storage and private cloud project sync |
| Export a loop | Render the built-in four-bar loop workflow to WAV |
| Work across screens | Mobile dock, desktop navigation rail, project commands, and shortcuts |

### A stem-first workflow

1. **Start a project.** Name it and upload a stem ZIP. The current upload limit is 2 GiB.
2. **Review the files.** Confirm included stems, roles, and the analysis reference.
3. **Review the timing.** Listen to the click audition and check the beat grid, flagged regions, and target tempo.
4. **Approve the render.** Explicit approval binds rendering to the reviewed proposal. Analysis completion alone is not approval.
5. **Arrange and mix.** Work in four- or eight-bar sections, loop a passage, and adjust levels, mute, and solo.

The pipeline separates inspect, analyze, propose, and render stages. Progress distinguishes confirmed upload bytes from processing without a measurable completion percentage. Included stems share one tempo map to preserve relative alignment. Timing quality still needs listening and review, especially on unusual or weakly rhythmic material.

### Desktop controls, mobile reach

At 1024 px and wider, project and account commands stay visible above the workspace. Studio uses horizontal stem lanes, Mix exposes vertical faders, and the player stays at the bottom. Smaller screens retain the touch-first dock and compact mixer tiles.

| Shortcut | Action |
| --- | --- |
| `Alt+1` through `Alt+4` | Switch workspace sections |
| `Space` | Play or pause outside editable fields and interactive controls |
| `Ctrl+S` / `Cmd+S` | Save the active project outside dialogs |

Sign-out uses the save-and-sync flow and warns before leaving unsynced work.

## Project status and boundaries

- **Early access:** no hosted guest mode. Invitation-based registration is not unrestricted public signup.
- **An AI-stem workspace:** imported audio and assisted timing analysis are the focus. General prompt-to-full-song generation is not included.
- **Not a plugin host:** VST/AU hosting, plugin scanning, and native desktop packaging are not part of the production web app.
- **Export scope:** built-in loop WAV export is not a complete long-form stem-project mixdown workflow.
- **Online authentication:** cached app assets and local saves do not provide unrestricted offline studio access. Opening the studio requires an online session check.
- **Account options:** profile-name and password changes exist. Email-change verification and password-recovery UI remain follow-up work.
- **Performance:** large projects depend on device memory, browser audio behavior, and worker capacity. No universal track-count or latency guarantee is made.
- **Roadmap:** future features are proposals, not shipped functionality or delivery promises.

## Quick start

### Preview the web frontend

Prerequisites: Git and Python 3. The frontend is static HTML, CSS, and JavaScript. Serving it does not require a frontend build or npm installation.

```bash
git clone https://github.com/Thuvee416/Opusloops.git
cd Opusloops
python3 -m http.server 4173 --bind 127.0.0.1 --directory mobile
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

**This serves the frontend, not a complete local backend.** The checked-in `mobile/config.js` points to the hosted AWS API. Cloning does not grant account access, provision cloud resources, or run audio workers. Do not use production for automated tests or load tests. Browser regression tests use isolated cloud fixtures instead.

### Run checks without a production account

Prerequisites: Node.js, Python 3, and Bash. See [.github/workflows/mobile.yml](.github/workflows/mobile.yml) for the CI configuration.

```bash
bash scripts/validate-mobile.sh
```

For browser tests, keep the local server running in another terminal and install Playwright outside the checkout:

```bash
npm install --prefix /tmp/opusloops-browser-tests playwright --no-save --no-package-lock
/tmp/opusloops-browser-tests/node_modules/.bin/playwright install chromium
PLAYWRIGHT_MODULE=/tmp/opusloops-browser-tests/node_modules/playwright/index.mjs \
  node --test scripts/test-create-flow.mjs scripts/test-welcome.mjs
```

The current harness uses installed Google Chrome on macOS and Playwright Chromium elsewhere. These tests cover fixture-backed auth, project creation, navigation, mixer controls, and responsive behavior. Passing them does not prove a successful production audio-processing run.

### Operate your own backend

Full self-hosting is currently an operator-level task, not a one-command install. It requires your own AWS infrastructure, auth configuration, private storage, workers, and updated frontend configuration. AWS resources incur costs. Deployment scripts contain account-specific guards that must be reviewed for another deployment.

- [Native AWS backend and verification](infra/aws-backend/README.md)
- [Stem worker infrastructure](infra/stem-worker/)
- [Audio worker source and tests](worker/)
- [Amplify frontend build specification](amplify.yml)

Do not copy credentials into the frontend, weaken auth to make setup work, or run operator scripts blindly.

## Architecture

| Layer | Technology and responsibility |
| --- | --- |
| Web app | HTML, CSS, JavaScript, Web Audio, and a service worker |
| Visual effects | Adapted React Bits effects with retained [license notices](mobile/REACT_BITS_LICENSE.md) |
| Frontend hosting | AWS Amplify publishes `mobile/` from GitHub `main` |
| Identity | Amazon Cognito |
| Application API | API Gateway and Lambda |
| Project data | Private RDS PostgreSQL with account ownership and Row Level Security |
| Audio storage | Private S3 objects with authorized upload and playback access |
| Audio processing | Isolated AWS Batch Fargate jobs |
| Background operations | EventBridge and Lambda for lifecycle and cleanup work |

The browser receives no AWS account keys or database credentials. Historical SQL under `supabase/migrations/` is compiled for native PostgreSQL. Supabase is not required at runtime.

### Repository map

```text
mobile/                 Production web app
scripts/                Frontend validation and browser tests
worker/                 Audio-processing implementation and tests
infra/aws-backend/      Native AWS API, identity, database, and operator tooling
infra/stem-worker/      Audio-worker infrastructure
supabase/migrations/    Historical SQL used by the native database build
.github/                CI and contribution templates
manual/                 Additional documentation and legacy context
```

The repository also retains C++ DAW source from its upstream history. That source is not the application deployed at opusloops.com. Read the [legacy compatibility note](manual/docs/legacy-desktop.md) before assuming native features are available in the web app.

## Where we want to take it

The direction is a stem-first DAW with less setup between an idea and a finished arrangement. Proposed priorities include reliable large-project playback, simpler timing review, clearer arrangement editing, complete project export, and easier contributor setup.

The [public roadmap](ROADMAP.md) groups this work by outcome and defines success criteria. Priorities can change based on reproducible bugs, musical use cases, and contributor capacity.

## Help build it

You do not need to be an audio-engine developer to contribute.

- **Musicians:** describe editing friction with a small rights-cleared example where possible.
- **Frontend developers:** improve keyboard access, layouts, error states, and interaction tests.
- **Audio developers:** help with timing quality, synchronization, memory use, and repeatable audio tests.
- **Infrastructure contributors:** improve deployment reproducibility, isolation, observability, and cost documentation.
- **Writers and testers:** help new contributors get from clone to a meaningful passing test.

Read [CONTRIBUTING.md](CONTRIBUTING.md), browse [issues](https://github.com/Thuvee416/Opusloops/issues), or propose a focused improvement. Open an issue before a substantial rewrite. Never share private recordings, credentials, or audio you lack permission to redistribute.

If the direction resonates, **star Opusloops**, share it with someone working on stems, or contribute a reproducible bug report. Useful feedback and small, well-tested improvements matter more than feature count.

## Security, license, and credits

Report vulnerabilities privately using [SECURITY.md](SECURITY.md), not a public issue.

Opusloops is distributed under the **GNU General Public License v3.0**. See [LICENSE](LICENSE). Contributions use that same license, with no separate contributor license agreement. Open source does not mean free hosted infrastructure or unrestricted rights to imported audio.

Opusloops is a modified distribution of [MAGDA](https://github.com/Conceptual-Machines/magda-core). Original code remains credited to its respective contributors. Opusloops is independently maintained and does not claim affiliation with Conceptual Machines. See [NOTICE.md](NOTICE.md). Third-party assets and components retain their applicable licenses.

The [Chinese README](README_CN.md) is retained as historical documentation and may not reflect the current web app. This English README is the current product overview.
