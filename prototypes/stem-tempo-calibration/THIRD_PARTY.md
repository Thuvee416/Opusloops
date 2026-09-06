# Third-party calibration dependencies

- **Beat This 1.1.0** — MIT code and published weights. The optional madmom DBN
  path is not used. Pin the `final0` checkpoint hash in every run manifest.
- **librosa 0.11.0** — ISC. Diagnostic tempo/onset cross-check only; it never
  silently replaces the approved primary beat grid.
- **jsonschema 4.25.1** — MIT. Runtime Draft 2020-12 validation for every run
  manifest load and write boundary, plus Gate-B approval validation.
- **referencing 0.37.0** — MIT. Offline registry for the packaged canonical
  Gate-B schema referenced by the run-manifest schema.
- **FFmpeg / ffprobe** — external calibration executables. Capture binary hashes
  and build configuration; choose and audit a distributable build before worker use.
- **Signalsmith Stretch 1.3.2** — MIT, already vendored at
  `third_party/signalsmith-stretch`. The harness compares linked multichannel and
  independent stereo-stem processing.
- **Igor Pavlov SHA-256 (2010-06-11)** — public domain, reused from the vendored
  upstream implementation and kept with the native renderer under
  `native/third_party/sha256`. It is self-contained so renderer and worker builds
  do not depend on the optional llama.cpp submodule. The native renderer uses it
  only to verify its bound TSV inputs and canonical source WAVs.
- **Rubber Band** — optional external quality-ceiling comparison only. It is not
  vendored or shipped. Proprietary deployment requires a commercial-license decision.

See each upstream project for its complete license and notices.
