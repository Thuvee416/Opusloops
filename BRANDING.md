# OPUS LOOPS Identity

The approved identity is the solid circle and separate vertical bar supplied on October 18, 2026. `web-studio/assets/opus-logo.jpg` preserves the original supplied lockup, including the wordmark. `opus-mark.svg` is the transparent black interface mark; `opus-mark-light.svg` is its cream counterpart for dark surfaces. The mark uses a 524 × 388 view box. Preserve the aspect ratio and separation between the shapes.

The studio header, footer, welcome frame, notices page and redirect document share this identity. The repository README lockups and retained legacy mobile icons are updated too. The existing teal interaction accents remain independent of the black logo.

`scripts/build-brand-assets.mjs` exports all favicons and iOS/PWA icons from the canonical SVG, including a separately padded maskable icon. It requires the `sharp` package; `OPUS_SHARP_MODULE` may specify its installed module path. Icon URLs are versioned to avoid reusing the former mark from browser caches. Existing installed home-screen shortcuts may require re-adding when the operating system retains its icon.

The two intro graphics were edited with the built-in image-generation tool. Prompt intent: replace only the old linked-loop symbol with the supplied solid circle and separate vertical bar, black for the landscape banner and cream for the dark studio poster; retain the ocean, grid, DAW graphics, text, composition and palette. The resulting assets are `opus-brand-landscape-v2.jpg` and `opus-brand-studio-v2.jpg`; the original old-logo assets are retired. Interface marks and icon exports use deterministic SVG geometry rather than generated artwork.

Verification for 0.141.1: artifact/module validation; every local HTML/welcome image reference resolves; manifest icon dimensions match their declared sizes; desktop and 390 × 844 intro and studio header inspected in normal Chrome; no preview page errors observed. The icon exports preserve a circular circle and proportional vertical bar, with safe padding for maskable cropping. These viewport checks are not physical iOS installation tests.
