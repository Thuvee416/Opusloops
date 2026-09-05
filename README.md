<p align="center">
  <img src="assets/Banner.png" alt="Opusloops" width="520">
</p>

<p align="center">
  <a href="https://opusloops.com/"><img src="https://img.shields.io/badge/production-AWS%20Amplify-ff9900?logo=amazonaws&logoColor=white" alt="AWS Amplify production"></a>
  <a href="https://github.com/Thuvee416/Opusloops/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="GPL-3.0"></a>
</p>

<p align="center">Create · Arrange · Evolve</p>

Opusloops is a calm, touch-first loop studio that runs as an installable mobile web app. Build patterns with Web Audio, arrange ideas, shape a compact mix, export WAV audio, and optionally sync projects through a private account.

<p align="center">
  <strong><a href="https://opusloops.com/">Launch Opusloops</a></strong>
</p>

- **English** | [简体中文](README_CN.md)
- [Issues](https://github.com/Thuvee416/Opusloops/issues) · [Source](https://github.com/Thuvee416/Opusloops)

## Mobile-first by design

- **Touch sequencer** — place and clear steps without desktop-sized controls
- **Built-in loops and sounds** — powered by Web Audio, with no plugin scanning or installation
- **Compact mixer** — balance levels and mute parts from a phone-sized surface
- **Offline-first projects** — save instantly on the device, with private account sync across devices
- **WAV export** — render a reproducible four-bar audio file directly in the browser
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

The committed Supabase URL and publishable key are intentionally public client
configuration. Access is enforced in Postgres with per-user Row Level Security;
secret and service-role keys must never be shipped to the browser. Database
migrations and operating notes live in [`supabase/`](supabase/).

Account creation is invitation-only during early access. Supabase's direct
public signup endpoint is disabled; an email-bound invitation creates an
Opusloops-tagged account through the server-side function. Password recovery and
email verification remain unavailable until production SMTP is configured.

## Production

Pushes to `main` are built automatically by the existing AWS Amplify app and deploy the contents of `mobile/` to [https://opusloops.com/](https://opusloops.com/). The repository-owned [`amplify.yml`](amplify.yml) validates the PWA before publishing it and stamps `version.json` with the deployed commit. A successful Amplify job is still followed by a fresh production fetch to verify the live revision.

## Legacy desktop source

This repository retains GPL-licensed C++ DAW source and compatibility identifiers from its upstream history. That desktop application, external plugin hosting, plugin scanning, MCP, OSC, Lua controller surfaces, and desktop packaging are not part of the Opusloops mobile production target.

The legacy source remains available for provenance and migration work. Internal directory names may retain historical identifiers where changing them would break saved projects or protocols. See [NOTICE.md](NOTICE.md) and the [legacy compatibility note](manual/docs/legacy-desktop.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License and provenance

Opusloops is distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for the license and [NOTICE.md](NOTICE.md) for upstream provenance and third-party notices.
