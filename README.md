<p align="center">
  <img src="assets/Banner.png" alt="Opusloops" width="520">
</p>

<p align="center">
  <a href="https://github.com/Thuvee416/Opusloops/actions/workflows/pages.yml"><img src="https://img.shields.io/github/actions/workflow/status/Thuvee416/Opusloops/pages.yml?branch=main&label=production" alt="Production deployment"></a>
  <a href="https://github.com/Thuvee416/Opusloops/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="GPL-3.0"></a>
</p>

<p align="center">Create · Arrange · Evolve</p>

Opusloops is a calm, touch-first loop studio that runs as an installable mobile web app. Build patterns with Web Audio, arrange ideas, shape a compact mix, and keep projects on your device.

<p align="center">
  <strong><a href="https://thuvee416.github.io/Opusloops/">Launch Opusloops</a></strong>
</p>

- **English** | [简体中文](README_CN.md)
- [Issues](https://github.com/Thuvee416/Opusloops/issues) · [Source](https://github.com/Thuvee416/Opusloops)

## Mobile-first by design

- **Touch sequencer** — place and clear steps without desktop-sized controls
- **Built-in loops and sounds** — powered by Web Audio, with no plugin scanning or installation
- **Compact mixer** — balance levels and mute parts from a phone-sized surface
- **Local projects** — save work in browser-managed storage on the current device
- **Offline installability** — add the PWA to a home screen and reopen it after the first successful load
- **Calm interface** — quiet hierarchy, warm neutrals, restrained motion, and one clear action at a time

Opusloops does not require an App Store or Play Store download. Open the production URL in a supported mobile browser and use the browser's **Add to Home Screen** or **Install App** action.

## Run locally

The production PWA lives in [`mobile/`](mobile/). It has no package-manager or native-toolchain requirement.

```bash
git clone https://github.com/Thuvee416/Opusloops.git
cd Opusloops
python3 -m http.server 4173 --directory mobile
```

Then open `http://localhost:4173`. Use a local server rather than opening `mobile/index.html` directly so the service worker and offline paths behave like production.

## Production

Pushes to `main` deploy the contents of `mobile/` to [https://thuvee416.github.io/Opusloops/](https://thuvee416.github.io/Opusloops/). A green workflow proves deployment; a fresh production fetch is still required to verify the live revision.

## Legacy desktop source

This repository retains GPL-licensed C++ DAW source and compatibility identifiers from its upstream history. That desktop application, external plugin hosting, plugin scanning, MCP, OSC, Lua controller surfaces, and desktop packaging are not part of the Opusloops mobile production target.

The legacy source remains available for provenance and migration work. Internal directory names may retain historical identifiers where changing them would break saved projects or protocols. See [NOTICE.md](NOTICE.md) and the [legacy compatibility note](manual/docs/legacy-desktop.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License and provenance

Opusloops is distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for the license and [NOTICE.md](NOTICE.md) for upstream provenance and third-party notices.
