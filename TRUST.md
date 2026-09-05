# Project Commitments

*Last updated: 2026-09-05*

These commitments describe how the Opusloops repository is intended to be maintained. The repository history remains the authoritative record of changes.

## Licensing and provenance

- Opusloops is distributed under the GNU General Public License v3.0.
- Released GPL-licensed source remains available under that license.
- Upstream authorship and third-party notices are preserved; see [NOTICE.md](NOTICE.md).
- Opusloops does not use the upstream project's former contributor license agreement. New contributions are accepted under GPL-3.0 only.

## Engineering

- Audio-thread code is reviewed for real-time safety, including allocations, blocking work, and synchronization.
- Locally saved projects are treated as compatibility-sensitive.
- Bug fixes should include regression coverage when practical.
- Human-written and AI-assisted changes are held to the same review, testing, licensing, and provenance standards.
- Suspected license or provenance problems should be reported promptly through an issue or private security report, depending on sensitivity.

## User control and privacy

- Opusloops does not intentionally collect usage analytics or telemetry.
- The installed PWA checks its GitHub Pages origin for updated application assets when it reconnects.
- Projects and settings save first in browser-managed local storage. Invited, signed-in users can sync those project documents through Supabase; an application claim, an atomic sync boundary, and Row Level Security restrict access to the owning account.
- Four-bar WAV export is rendered entirely on the device. Audio is not uploaded, and a WAV file is not an editable project backup.
- Opusloops sends account and project-sync requests only to its dedicated Supabase project. It does not send loop audio or usage analytics.
- Direct public account signup is disabled during early access. Email verification and password recovery remain unavailable until production SMTP is configured.
- The core loop workflow does not require microphone, contacts, location, remote-control, or external AI-provider access.

## Maintenance

- Breaking changes should include migration notes.
- Reproducible defects on supported platforms take priority over speculative reports.
- Material changes to governance, licensing, privacy behavior, or supported platforms should be documented publicly.

## Supported platforms

The production target is a modern mobile browser with Web Audio, service workers, and local storage. iPhone and iPad installation uses Safari's home-screen flow; Android installation uses a compatible browser's PWA flow. Opusloops makes no App Store or Play Store availability claim.

Questions about these commitments can be raised in the [Opusloops issue tracker](https://github.com/Thuvee416/Opusloops/issues).
