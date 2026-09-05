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

Projects save locally first. Clearing site data, private browsing, storage-pressure eviction, browser reset, or PWA uninstall can remove an unsigned-in project. Signed-in projects are reconciled with the user's private Supabase rows when the app reconnects. Account-scoped local caches must never be displayed after another user signs in. Destructive storage actions need explicit user confirmation and durable deletion tombstones.

### Cloud identity and data

The PWA may contain only the dedicated Supabase URL and publishable key. Secret, service-role, management, and database credentials stay outside the browser and repository. Direct public signup is disabled. Early-access accounts require an email-bound, single-use invitation and receive a fixed Opusloops application claim; the atomic project-sync function requires that claim in addition to an authenticated user ID. Every exposed project table must revoke anonymous and authenticated direct writes and retain explicit owner-only Row Level Security policies. Email verification and recovery mail require production SMTP before they can be treated as trusted identity signals.

The official production origin is the dedicated `https://opusloops.com` domain on AWS Amplify. Account sessions and account-scoped device caches must remain isolated to approved Opusloops origins; adding a preview or alternate host requires an explicit Auth redirect and Edge Function CORS review.

### Service worker and cache

The service worker controls offline application code. Restrict it to the production app scope, cache only expected same-origin assets, version caches deliberately, and delete obsolete Opusloops caches during activation. Never treat a failed response as a valid cached application asset.

### Web Audio

Clamp stored timing and gain values before using them in the audio graph. Bound scheduled work and release audio nodes when playback or projects change. Audio must begin only after a user gesture.

## Scope

This policy primarily covers the Opusloops PWA in `mobile/`, its deployment workflow, local project handling, and first-party documentation. The retained C++ desktop source is non-production but remains in scope for repository-level dependency, build, and source-distribution vulnerabilities. Report dependency vulnerabilities to the respective maintainers as well.

## Contributor checklist

- Do not commit secret or service-role API keys, passwords, tokens, certificates, or private user content. A reviewed Supabase publishable client key is the only exception.
- Validate untrusted input and preserve bounds checks.
- Release timers, audio nodes, event listeners, and other resources when their owning view or playback session ends.
- Review service-worker scope, cache updates, and local-storage migrations.
- Add focused tests for security-sensitive parsing and destructive project actions.

This policy is distributed under the repository's [GPL-3.0 license](LICENSE).
