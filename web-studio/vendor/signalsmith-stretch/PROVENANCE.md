Signalsmith Stretch 1.3.2

Source package: signalsmith-stretch@1.3.2 (npm), pinned in package-lock.json.
Upstream gitHead: 222093b4cc13ddb4d07c826bc3c1559326091731
Runtime file is SignalsmithStretch.mjs renamed .js for static ES-module serving, with the documented scheduling patch below.
Upstream SHA-256: 97530b11d5bc01015af4cde40d6aa55ff10c40aa1294ca4c8c5762027d517a46

Stretch license copied from the pinned upstream commit. Linear and Emscripten notices are included from their official repositories. WASM is embedded in the runtime file; no CDN or runtime package download is used.

Local patch (0.87): in remoteMethods.schedule, prune obsolete segments against the worklet currentTime, not the requested future outputTime. Previously, scheduling multiple future points discarded earlier points before rendering began. The process-loop pruning still uses its latency-compensated outputTime. No WASM/DSP binary changes.
Patched SHA-256: 9ae8aadab3f849c9834b814caf493cfb4d1ba43cdf35518e6dd209f8422c69c1
