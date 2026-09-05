# Legacy Desktop Compatibility

The production Opusloops application is the mobile web/PWA in [`mobile/`](https://github.com/Thuvee416/Opusloops-Mobile/tree/main/mobile).

The repository also contains a GPL-licensed C++ desktop DAW inherited from its upstream history. It is retained for provenance, compatibility research, and possible migration tooling; it is not deployed to the Opusloops production URL.

The following desktop systems are not features of the mobile production app:

- VST, Audio Unit, LV2, or other external plugin hosting and scanning
- Native macOS, Windows, or Linux installers and signing paths
- Desktop window, menu, keyboard-shortcut, and external-editor workflows
- MCP, WebSocket, OSC, and Lua remote-control surfaces
- Desktop controller profiles and multi-device audio routing

Historical names may remain inside source paths, serialized identifiers, protocol aliases, and third-party dependency names where changing them would break compatibility or misstate provenance. They do not identify the current product.

See [NOTICE.md](https://github.com/Thuvee416/Opusloops-Mobile/blob/main/NOTICE.md) for upstream attribution and [LICENSE](https://github.com/Thuvee416/Opusloops-Mobile/blob/main/LICENSE) for the GPL-3.0 terms.
