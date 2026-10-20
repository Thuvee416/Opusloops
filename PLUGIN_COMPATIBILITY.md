# Producer Plug-ins And OPUS LOOPS Compatibility

Researched October 20, 2026. This is a shortlist of widely used products, not an audited worldwide sales ranking. KVR's popularity listings and MusicRadar's 2026 synth coverage are the popularity signals; vendor documentation is authoritative for formats and requirements.

| Category | Product | Production Use | Current OPUS Status |
| --- | --- | --- | --- |
| Synth | Xfer Serum 2 | Wavetable/hybrid basses, leads, moving textures | Desktop VST3/AU/AAX. Not hosted in the browser. |
| Synth | Arturia Pigments | Layered synthesis, evolving pads, sound design | Desktop standalone/VST/AU/AAX. Not hosted in the browser. |
| Synth | u-he Diva | Analog-style basses, chords and pads | Desktop VST3/AU/CLAP/AAX. Not hosted in the browser. |
| Effect | FabFilter Pro-Q 4 | Detailed corrective and dynamic EQ | Desktop host required. Not hosted in the browser. |
| Effect | Valhalla VintageVerb | Spacious algorithmic reverb | Desktop VST/VST3/AU/AAX. Not hosted in the browser. |
| Effect | Soundtoys EchoBoy | Character delay and rhythmic space | Desktop VST/VST3/AU/AAX. Not hosted in the browser. |

## What Works Today

OPUS can exchange exported MIDI and rendered WAV/stem audio with a desktop DAW running these plug-ins. The audio then plays, edits and exports through OPUS's ordinary audio path. This is file interchange, not editable plug-in hosting or preset compatibility. No listed commercial plug-in was installed in the standard local plug-in folders during this build, and none was used to produce the new demo. No vendor binary, preset library or sample content is bundled.

The browser build now has original OPUS synthesis patches (analog-style stacked voices, spectral coloring and decaying FM), plus Studio EQ, Studio Space and Studio Echo. These run in the shared playback/export engine, appear in the existing device/preset controls and are addressable by Odesa's shared actions. They are independent processors, not the six commercial products or claimed sound-identical replacements.

## Actual Desktop Plug-in Hosting: Still Required

An optional native companion is the practical route for these desktop binaries. The user has been asked whether that installation requirement fits the product. No companion has been built or advertised as supported in this release.

The implementation must include:

1. A signed native VST3 host with user-installed/licensed plug-in discovery, isolated scanning, per-instance state and native editor windows.
2. An explicitly paired, authenticated loopback connection, limited to trusted OPUS origins. No unauthenticated browser-to-local file or process API.
3. Sample-accurate MIDI/transport dispatch, audio buffering, reported latency and compensation, automation, state recall and crash recovery.
4. Deterministic bounce/freeze into OPUS audio assets so projects remain playable without the plug-in or companion. Unfreeze must preserve original MIDI and plug-in state.
5. Separate validation for each product/version: load, authorize, sound, automate, save/reopen, offline render, missing-license behavior, missing-plug-in behavior and failure isolation. Commercial vendor licenses and installers are dependencies; a generic host test does not prove those six products work.
6. A clear browser/mobile fallback. Companions are not available merely because the website opens on a phone.

Server hosting would additionally require vendor permission for the service/distribution model and reliable per-session compute; purchasing one desktop license does not establish those rights. Do not publish a compatibility badge until the real installed product passes the workflow above.

## Sources

- [KVR popularity index](https://www.kvraudio.com/plugin-ranks.php)
- [KVR popular effects](https://www.kvraudio.com/plugins/best-effect-plugins)
- [MusicRadar synth comparison](https://www.musicradar.com/music-tech/soft-synth-showdown-repub)
- [Serum 2 formats and requirements](https://xferrecords.com/products/serum-2)
- [Arturia instrument compatibility](https://support.arturia.com/hc/en-us/articles/4405748310034-Virtual-Instruments-Compatibility)
- [Diva formats and requirements](https://u-he.com/products/diva/)
- [Pro-Q 4](https://www.fabfilter.com/products/pro-q-4-equalizer-plug-in)
- [VintageVerb](https://valhalladsp.com/shop/reverb/valhalla-vintage-verb/)
- [EchoBoy](https://www.soundtoys.com/product/echoboy/)
