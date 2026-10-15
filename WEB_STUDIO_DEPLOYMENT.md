# Web studio deployment

Amplify now publishes `web-studio/` at opusloops.com. Release 0.111.0 is copied from the OPUS LOOPS studio source commit `11f6543a7bcf960471633a3b3236934d9da92604`. The previous application remains in `mobile/`; backend resources are unchanged. The new studio stores projects locally and supports project downloads; it does not integrate the older cloud processing or account system.

`release.json` identifies the studio source. `version.json` is stamped by Amplify with the deployment commit and job. Build validation checks the artifact root, JavaScript syntax and local module/HTML dependencies. Hosting permits same-origin microphone/MIDI access and the blob audio worklet/WebAssembly used for stretching. The retirement service worker removes only legacy app-shell caches, never user project storage.

For rollback, revert this deployment commit and redeploy main. Browser-local projects on the ChatGPT Sites origin do not automatically transfer to opusloops.com; download a project there and use File > Open Live Set here.
