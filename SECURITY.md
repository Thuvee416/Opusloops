# Security Policy

## Supported versions

Opusloops is in active pre-1.0 development. Security fixes are applied to the current `main` branch and deployed to the live PWA. A previously cached offline build may remain active until its service worker updates.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow for the [Opusloops repository](https://github.com/Thuvee416/Opusloops/security/advisories/new). Include:

- A clear description and likely impact
- Affected versions, platforms, and configurations
- Reproduction steps or a proof of concept
- Any suggested mitigation, if known

Maintainers will acknowledge the report, investigate it, and coordinate disclosure based on severity and available release infrastructure. Please allow reasonable time for a fix before public disclosure and avoid accessing or modifying data without permission.

## Important security boundaries

### Stored projects

Treat browser-stored project data as untrusted input because extensions, developer tools, interrupted writes, or older releases can change it. Validate the schema, types, lengths, timestamps, and numeric ranges before replacing the active project. Preserve an unreadable value under the recovery key before replacing the active value with defaults.

### Browser storage

Projects are local to the browser. Clearing site data, private browsing, storage-pressure eviction, browser reset, or PWA uninstall can remove them. The current release has no cloud backup or file export, and the interface must state that boundary plainly. Destructive storage actions need explicit user confirmation.

### Service worker and cache

The service worker controls offline application code. Restrict it to the `/Opusloops/` scope, cache only expected same-origin assets, version caches deliberately, and delete obsolete Opusloops caches during activation. Never treat a failed response as a valid cached application asset.

### Web Audio

Clamp stored timing and gain values before using them in the audio graph. Bound scheduled work and release audio nodes when playback or projects change. Audio must begin only after a user gesture.

## Scope

This policy primarily covers the Opusloops PWA in `mobile/`, its deployment workflow, local project handling, and first-party documentation. The retained C++ desktop source is non-production but remains in scope for repository-level dependency, build, and source-distribution vulnerabilities. Report dependency vulnerabilities to the respective maintainers as well.

## Contributor checklist

- Do not commit API keys, passwords, tokens, certificates, or private user content.
- Validate untrusted input and preserve bounds checks.
- Release timers, audio nodes, event listeners, and other resources when their owning view or playback session ends.
- Review service-worker scope, cache updates, and local-storage migrations.
- Add focused tests for security-sensitive parsing and destructive project actions.

This policy is distributed under the repository's [GPL-3.0 license](LICENSE).
