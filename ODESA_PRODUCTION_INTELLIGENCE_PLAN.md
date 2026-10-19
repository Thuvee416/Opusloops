# Odesa — Production Intelligence Refactor

Status: implementation plan, not shipped capability. Audited 2026-10-19 against commit f3cf9e1 and the active AWS API configuration. The earlier core milestone establishes reliable DAW operations; it does not establish reference-guided production or engineer-quality mixing.

## First Build — 2026-10-19

Implemented in the 0.165.0 candidate:

- A focused musical-brief interpretation pass before the existing draft/review/execution pipeline. The brief carries goals, protected material, reference uncertainty, assumptions and the next step. First mentions of named references require clarification; an unheard reference cannot be promoted to analyzed evidence.
- Brief continuity within the current visit and set; account changes and New/Open clear it. This is not yet durable project-file storage.
- Local, post-master Arrangement rendering and worker-based measurements: sample peak, RMS, crest factor, clipped samples, stereo correlation, side energy, approximate band energy and short-window RMS. Bounded to the opening 32 beats or 60 seconds, whichever is shorter. No user audio is uploaded. Offline rendering cannot be interrupted midway; cancellation discards its result and stops subsequent work.
- OpenAI Responses and Google Gemini provider adapters, dedicated AWS secret references, explicit provider selection and no automatic fallback. Anthropic is excluded. Active production selection remains Nova until an external model wins actual acceptance tests.
- Artistic starter prompts and inline brief/measurement details. Existing atomic editing, grouped Undo, account binding, quotas and preflight remain the execution authority.

Verification: 94 backend tests, 43 focused client tests, static artifact checks, and a real Chrome audio test passed. The latter independently observed a -6.0206 dB fader change, a -6 dB Utility change, silence when muted, no source mutation, no Session substitution and cancellation before rendering. Nova passed four synthetic musical-intent/tool cases after separating brief interpretation from action planning; the first combined-schema attempt failed all four. One final sample per case is not a reliability estimate or proof of musical quality. Captured final results are in `tests/fixtures/production-intelligence-baseline.json`.

Still required: reference audio ingestion and semantic sections, persistent briefs, full-song/track observations, loudness-matched audition, candidate revisions, listening evaluation, richer editable composition and production model comparisons. This build does not fulfill the promise of an engineer-quality reference mix or exact named-song structure.

### Model Shortlist And Decision

| Candidate | Why Evaluate It | Current Evidence |
| --- | --- | --- |
| OpenAI `gpt-6.1-sol` | First planning candidate: tool use and complex multi-step reasoning with a lower-cost positioning than Astra | Official capability documentation; adapter contract tests only, no live OPUS result |
| OpenAI `gpt-6-astra` | Quality ceiling comparison for difficult production decisions | Official capability documentation; no live OPUS result |
| Google `gemini-4-argon` | Audio-input candidate for reference descriptions plus planning | Audio input and function calling documented; music-specific judgments still require listening evaluation |
| Google `gemini-3.8-flash` | Lower-latency comparison for brief interpretation and audio descriptions | Official capability documentation; no live OPUS result |
| Amazon Nova Pro | Existing operational baseline | Four final synthetic cases passed; not a perceptual-quality assessment |

Recommendation is provisional: evaluate Sol for planning and Argon for audio understanding, rather than choosing a single provider by reputation. Current adapters send text/session measurements only; audio input is future work requiring explicit upload UX. The previously shared OpenAI/Google keys were not found in this chat's saved user messages, local project configuration or shell profiles. External comparisons are pending the credential location. Never paste keys into reports or commit them.

Primary sources checked on 2026-10-19: [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model), [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), [Gemini audio](https://ai.google.dev/gemini-api/docs/audio), and [Gemini generateContent/tool schema](https://ai.google.dev/api/generate-content).

### Reproducible Provider Evaluation

From `infra/aws-backend`, run `node operator/evaluate-production.mjs PROVIDER MODEL_ID`. The provider must be `bedrock`, `openai` or `gemini`. External keys come from the process environment or an explicit `OPUS_PROVIDER_KEYS_FILE` pointing to private JSON (0600). This runs four bounded paid synthetic cases, no real project/audio. It saves results under ignored `.operator/`. Use the same cases and independent protected-material checks for every candidate; follow with repeated cases and blinded listening before ranking production quality.

For a tested external deployment, store the selected key in a dedicated `opusloops/ai/...` Secrets Manager secret and pass its ARN as `OPUS_PLANNER_SECRET_ARN`, with `OPUS_PLANNER_PROVIDER` and `OPUS_PLANNER_MODEL` to the normal deployment command. The template grants access to that one secret, removes unused Bedrock inference permission, and keeps secret values out of Lambda environment configuration. Later code deployments preserve the selected provider. No external provider is enabled by this build alone.

## Product Outcome

Odesa should accept an artistic brief, investigate the current music and any reference, make production decisions, execute them in an editable DAW, and evaluate the result. The artist should not need to translate “make the chorus lift” into individual fader, device and automation commands.

Primary acceptance briefs:

1. “Make this mix sound like a Dave Pensado mix.”
2. “Create a house song with the same structure as Don't You Worry Child by Swedish House Mafia.”
3. Follow-ups such as “less bright,” “keep the vocal intimate,” or “make the second drop bigger without making it louder.”

Simple commands remain useful tools underneath these workflows. They should not define the onboarding or the product's intelligence. New music should be editable tracks, MIDI, clips, routing and automation, with optional rendered audio. A stereo-only generated song does not satisfy this brief.

## What Exists And What Is Missing

| Layer | Verified current state | Required change |
| --- | --- | --- |
| Model | Active Lambda uses `amazon.nova-pro-v1:0`. `web-studio/odesa.js` correctly identifies Tempo as an OPUS configuration of a provider model, not independently trained weights. | Benchmark production reasoning; separate provider identity from Odesa release and workflow contracts. A provider swap alone cannot supply missing audio tools. |
| Inputs | `agentContext` strips encoded media; the browser sends project/selection state, MIDI, action capabilities and raw source peak/RMS/clipping. | Add versioned analysis of the audible mix, stems, sections and references, including provenance and confidence. |
| Planning | `studio-agent.mjs` submits a text/JSON snapshot for a draft and textual review. Up to 80 actions, 6,000 output tokens and a 180 KB request. Client allows two plan repairs. | Introduce a persistent musical brief and staged production job. Compile each stage into bounded existing actions rather than requesting a whole finished song as one enormous action array. |
| Feedback | Current validation checks project correctness and command results. No automatic rendered-output musical assessment. | Render candidate results, measure them, compare with baseline and reference, and revise or reject. Correct JSON is not proof of a better mix. |
| References | Current instructions explicitly prohibit pretending to have analyzed a named song. No reference-audio analysis in the web agent. | Resolve the actual recording/version, obtain supported reference audio or a user-confirmed structure, and create a reference profile. |
| Execution | Shared actions, typed musical units, devices, MIDI, Arrangement, imports, exports, cancellation, stale checks and grouped Undo already exist. | Reuse these boundaries. Add only missing processing or composition tools required by measured production tests. |
| Musical materials | Existing instruments/presets, sampler/drum support, MIDI creation and effects can produce editable sketches. | Curated commercially usable sounds, instrument roles, coherent motifs, phrase development and transitions. Rendered quality must be auditioned, not inferred from note counts. |
| UX | Welcome and empty-agent examples feature BPM, a bass track and stem export. | Outcome-led briefs, visible analysis/progress, reference attachment, auditionable alternatives, and context-aware follow-ups. |

Evidence: `web-studio/app.js` near `installAgent`/`analyze`; `agent-actions.js:agentContext`; `agent-panel.js`; `agent-runner.js`; `infra/aws-backend/runtime/studio-agent.mjs`; `web-studio/AGENT.md`; `web-studio/odesa.js`; `infra/aws-backend/application.mjs`. AWS read-only configuration confirmed the active model on the audit date. No production model was changed.

The repository also contains exploratory native REA mix-analysis tests with richer measurements (`tests/test_mix_analysis_agent.cpp`, `test_mix_analysis_audio.cpp`). They are leads for reuse, not proof of an implemented web capability; the corresponding native headers were not present in this checkout. Separately, AWS stem-import inspection/conform infrastructure exists, but its reference/approval fields do not establish mix-reference intelligence. Audit those implementations before adopting any code.

## Intended Experience For The Two Briefs

### Reference-Guided Mixing

“Dave Pensado” is an artistic direction, not one fixed EQ curve or preset. Odesa should identify whether the user means a particular credited mix, genre or sonic traits. If a suitable reference is already attached, use it; otherwise ask one useful question for the track/version, or offer clearly labeled assumptions and proceed with a broad direction when authorized. Do not invent his signal chain or claim to have reproduced his decisions.

1. Inspect available stems, routing, roles, automation and input quality. Identify which material is actually editable. A stereo master permits narrower changes than multitracks; do not imply isolated vocal control without stems or an explicitly enabled separation workflow.
2. Analyze representative quiet, dense and transition sections of the current rendered mix and reference. Separate differences caused by arrangement/performance from problems that processing can address.
3. Build a brief with priorities, such as vocal intelligibility, kick/bass separation, transient preservation, depth or section contrast. These are user-confirmed or measured goals, not assumed characteristics of the named engineer.
4. Propose a concise direction, then produce a candidate using supported EQ, dynamics, routing, sends and automation. Avoid asking approval for every parameter. Preview substantial creative changes and preserve a reversible baseline.
5. Render the actual candidate, compare at matched perceived loudness, check technical regressions, and revise within the job budget. Offer “Original / Odesa,” a short explanation of audible changes, and “Keep / Refine / Undo.”
6. Interpret “warmer, but keep the vocal clear” against the retained brief and prior comparison; do not restart with a generic preset.

Initial launch claim: reference-guided mix assistance with audition and revision. “As good as a top engineer” requires controlled listening evaluation and cannot be promised by changing the system prompt.

### Reference-Guided Song Structure And Creation

The named song can have radio, album, extended and remix versions. Exact structure must be tied to the chosen recording. A title alone is insufficient evidence for exact bars or timestamps.

1. Resolve the version; accept a reference file, a verified analysis from an accessible catalog, or a user-confirmed section map. A pasted streaming link is a reference identifier, not automatically downloadable audio. Never silently substitute a generic house template and call it the song's structure.
2. Extract beat/downbeat grid, tempo changes, section boundaries, repeated material, energy/density curve and transition lengths. Store confidence and provide editable markers; uncertain boundaries can be corrected by the user.
3. Convert that into an editable structural blueprint: sections, bar lengths, relative energy, instrument entrances/exits, breakdown/build/drop relationships. Do not claim a concrete map of this song until its version has actually been analyzed.
4. Build original musical material to that blueprint: compatible kick/bass, chords, original melodic motifs, drums, fills and transitions. Preserve relationships across sections and develop motifs rather than repeat an unchanged loop for the full song.
5. Instantiate real tracks, MIDI, instrument choices, clips, routing and automation in OPUS. Use the user's existing material when requested; lock any protected vocals, motifs or sections. Use authorized sample assets and record their provenance. Matching structure does not require copying the reference's recording, melody, lyrics or hook.
6. Render section previews and a complete candidate; check all regions, source references, transitions and exports. Let the artist refine sections in natural language while retaining manual editability.

First achievable deliverable: a musically coherent editable house arrangement with a verified reference structure. A release-ready vocal house record also needs suitable vocals, sound assets and additional production decisions; do not conceal those dependencies.

## Architecture

```mermaid
flowchart LR
  A[Artist Brief + Current Project + Optional Reference] --> B[Intent And Evidence]
  B --> C[Musical Brief + Section And Mix Targets]
  C --> D[Production Planner]
  D --> E[Compile To Validated DAW Actions]
  E --> F[Render Isolated Candidate]
  F --> G[Measure And Compare]
  G -->|Revise Within Budget| D
  G --> H[Level-Matched Audition]
  H --> I[Keep Or Refine]
```

Use logical modules inside one orchestrated workflow initially, not a swarm of independent agents. Split providers only where benchmarks demonstrate a benefit.

### Persistent Contracts

- `ProductionBrief`: mix/arrange/compose intent; requested outcome; reference/version; user constraints; protected content; assumed versus observed facts; unresolved questions; scope and version.
- `AudioObservation`: project revision and render hash; engine/analysis versions; source/range/sample rate; raw/pre/post-fader/post-master stage; measured features; method, confidence and coverage. Distinguish a full-song measurement from an excerpt. Invalidate dependent observations when MIDI, devices, routing, automation or source media change.
- `ReferenceProfile`: reference identity/provenance; audio hash when available; selected version; beat/section map; tonal/dynamic/stereo descriptors; confidence; missing evidence. Reference audio stays separate from exported project media by default.
- `ProductionJob`: job ID; owner; brief version; base project revision; candidate revisions; stage; operation IDs; cancellation state; compute budget; observed results and checkpoints.
- `ProductionProposal`: intended musical change; allowed action groups; dependencies; protected-field assertions; expected observations; uncertainty; preview artifacts and comparison metadata.

Use one-based bars/beats in user and model contracts, and the existing canonical conversion at execution. Do not reintroduce model arithmetic on internal zero-based coordinates. Track roles inferred from names or classifiers must carry confidence and allow correction.

### Audio And Reference Analysis

Add `web-studio/production-analysis.js` plus worker-backed analysis and a render adapter in `audio.js`. Measure post-processing bus/master and selected stems through the real engine, including instruments, automation and effect history. Raw clip RMS alone misses these entirely.

Initial observations: integrated/short-term loudness, true peak, crest/dynamic behavior, frequency-band energy over time, stereo correlation/width, transient density, activity and silence, and section-level differences. Add beat/downbeat, tonal/chroma and repetition descriptors for structure. Frequency overlap is evidence for possible masking, not proof that a cut will sound better. Use targeted solo/routed renders to test hypotheses.

Cache by source/project/render/analysis version. Analyze a few useful sections before whole-song refinement. Run CPU-heavy work off the UI thread, with cancellation and memory limits. Introduce cloud workers only for measurements/inference that exceed practical browser budgets, with explicit audio-upload consent, retention controls and tenant isolation. Keep the existing no-audio-upload behavior until that path is implemented and disclosed.

Candidate tools: librosa documents a reproducible music-structure segmentation baseline, but segmentation clusters do not by themselves identify a “chorus” or “drop”; semantic labeling and correction are additional work. Essentia offers relevant music descriptors, but its library, pretrained models and dependencies need separate license review before commercial integration. Loudness measurement should use validated standards-based implementations; EBU R128's broadcast target is not a default target for every house track. Sources are linked below.

### Planning And Execution Refactor

Keep the current fast direct-command path. Add a versioned production-intent path in the backend and panel for broad briefs. Route by capability/evidence, not artist-name keyword matching.

Refactor the large `studio-agent.mjs` prompt into independently testable brief, analysis, arrangement, mix and action-compilation policies. The musical planner decides what to achieve; the existing compiler/runner handles exact IDs, units and supported operations. Make the structured brief authoritative instead of relying on an expanding chat transcript.

The current draft/review pair reviews text, not sound. Add an actual loop: baseline observation → candidate plan → isolated render → new observation → comparison → bounded revision. Preserve the best valid candidate, stop when improvements flatten, and report when evidence is inconclusive. Do not optimize one scalar loudness/spectral score as a proxy for taste.

Stages may exceed a single 80-action response, but should compile to bounded action batches on an isolated candidate. Live installation remains one atomic production revision. User edits invalidate dependent analysis; offer reanalysis/rebase rather than overwriting. Cancel leaves the live song intact; recoverable job checkpoints survive a lost connection. One Undo after Keep restores the pre-production song, including routing and automation. Persist crash-recoverable revisions rather than assuming today's in-memory Undo survives reload.

### Model Strategy And Odesa Branding

Retain Odesa as the product identity. Benchmark the current Nova configuration against stronger available reasoning/tool models on these actual music tasks; choose using musical outcomes, constraint adherence, latency and cost, not generic leaderboard scores. Any new provider/model requires its own authorized configuration and least-privilege IAM update. Do not silently relabel a provider swap as a new trained model.

Tempo must understand an artistic brief and identify missing evidence even when deeper execution is unavailable. Do not force users to translate it into commands. Forte can later identify deeper multi-pass production, but the product intent should not be deferred behind an unavailable name. Prelude remains explicitly experimental. Version the brief/analysis/compiler/evaluation stack independently of base-model IDs.

Fine-tuning is not the first dependency. First establish audio tools, grounded references, a capable planner and an evaluation corpus. If repeated reasoning failures remain, collect consented producer demonstrations (brief, source, decisions, revisions, results) and evaluate fine-tuning against the unchanged baseline. An audio-aware model can contribute descriptive assessment, but must be benchmarked for music and never substitute for objective metering or human listening.

## Implementation Sequence And Gates

| Phase | Work | Acceptance before continuing |
| --- | --- | --- |
| 0 — Briefs And Evaluation | Add `production-brief.js`, backend brief schema/policy, persistent brief UI and a fixed benchmark set. Keep direct actions intact. | Both named examples route to the correct workflow. Missing reference/version is surfaced without invented analysis; existing command regression suite passes. |
| 1 — Hear The Current Session | Candidate render adapter, section/stem observations, worker/cache and comparison metadata. | Known synthetic signals match independent meter oracles; effects, automation, buses and synths change observations correctly; stale observations cannot authorize edits. |
| 2 — Reference Structure | Reference picker/storage boundary, audio analysis, editable section map and blueprint compiler. | A chosen authorized recording yields an auditable map; corrected markers survive save/reopen; no title-only exact-structure claims. Rearranging existing material works before adding new generation. |
| 3 — Mix And Refine | Bounded production jobs, contextual mix policies, isolated candidate render, matched A/B, feedback and Keep/Undo. | Blind comparisons show improvement beyond a static-preset baseline; no clipping/content loss; protected material and job cancellation remain intact. |
| 4 — Compose To Structure | Sound/asset catalog, original motif/harmony/rhythm generation, section development and deterministic Arrangement compilation. | A full editable house arrangement follows the approved map, has intentional variation and transitions, retains sound sources and survives reopen/export. Producer listening passes. |
| 5 — Launch And Scale | Real signed-in jobs, quotas/cost visibility, recovery, mobile performance, onboarding and release claims. | Two example briefs and follow-ups succeed end-to-end on representative sessions with observed audio artifacts and documented limits. |

Phase0 and a browser-analysis spike are the first implementation slice. Mix and reference-structure development share the observations/contracts but have separate release gates; neither waits for a speculative foundation-model training project.

## Evaluation And Release Criteria

Create an initial evaluation set of at least20 authorized multitrack sessions across several source qualities/genres,10 authorized reference arrangements/versions, and50 brief/follow-up cases. Use a held-out subset; do not tune and score the same songs. These are proposed minimums, not a statistically sufficient universal-quality claim.

- **Execution:** no lost source media or forbidden changes; all cases pass explicit stale-state, cancel, history, reopen and export assertions. Record first-pass and repaired success separately.
- **Reference grounding:** zero claimed exact analysis without the right source/version; structure boundaries scored against producer annotations, with a proposed one-bar tolerance on at least90% of unambiguous annotated boundaries. Report ambiguous cases separately rather than deleting them from results.
- **Mix quality:** blind, level-matched original/candidate/static-baseline comparisons with at least three experienced listeners; rate balance, clarity, dynamics, depth, artifacts and adherence to brief. Provisional release threshold: candidate preferred on at least70% of held-out mix briefs, with uncertainty reported and no severe technical regressions. Calibrate this threshold with the pilot; it is not a claim of parity with the referenced engineer.
- **Composition:** exact accepted section order/bar lengths, editable stems/MIDI and no missing sources; listeners score motif coherence, transitions, groove, tonal clashes and reference-structure adherence. A valid project with audible notes is not sufficient.
- **Control:** “less bright,” “protect the vocal,” “only the second drop” retain earlier constraints and affect only the intended scope. Matched A/B must not let a louder candidate win merely by gain.
- **Operations:** log model/analysis/compiler versions, passes, repairs, render time, cost and cancellation/recovery results. Measure p50/p95 latency and cost before choosing a budget. Initial cap: three candidate revisions per job, with no hidden unbounded model/render loop. Preserve normal per-account limits until the new job policy is explicitly designed.

Primary release demos should be these production briefs, not BPM changes. Replace the three screenshot prompts with outcome-led examples only when their corresponding workflow is available, such as “Give This Mix More Clarity And Depth,” “Build A House Arrangement From A Reference,” and “Make The Second Drop Feel Bigger.” Before then, clearly identify a planning/preview flow; do not advertise unimplemented mixing as completed capability.

## What Is Needed From The Product Side

1. A small authorized multitrack/reference evaluation library, including the exact Don't You Worry Child version when testing that named request. No paid catalog or streaming extraction is assumed.
2. A few concrete mix references representing the desired Pensado-associated direction, rather than one supposed universal engineer preset.
3. Commercially usable drums, instruments, patches and transition assets; optional vocals/stems when the brief needs them. Audit current processor gaps before promising advanced sidechain, dynamic-EQ, de-essing or mastering behavior.
4. Experienced producer/mixer listening feedback and permission to retain selected examples for evaluation. Fine-tuning consent is a separate decision from ordinary project use.
5. Pilot latency/cost measurements and a product spending ceiling before enabling larger inference/render jobs. Start with existing browser rendering and CPU analysis; dedicated GPUs are not automatically required. Heavy audio models/generation may introduce separate compute/licensing costs.

No new infrastructure spending, model migration, training run, audio-upload flow or production behavior change is performed by this plan. The immediate recommendation is to build the brief-and-evaluation foundation, then actual processed-audio observation; a prompt-only rebrand would leave the central capability gap unchanged.

## Primary Technical References

- [librosa: music-structure segmentation example](https://librosa.org/doc/main/auto_tutorials/03-advanced/plot_segmentation.html) — candidate baseline, not validated song-specific structure.
- [Essentia: music extractor](https://essentia.upf.edu/streaming_extractor_music.html) and [licensing information](https://essentia.upf.edu/licensing_information.html) — descriptor options and adoption constraints.
- [EBU R128](https://tech.ebu.ch/publications/r128) — loudness, range and true-peak terminology; not a genre-specific mastering target.
- [AWS Nova documentation](https://docs.aws.amazon.com/nova/latest/userguide/) — provider capabilities must be checked for the actual selected model/version. Current OPUS inference sends text/JSON regardless of other provider modalities.
