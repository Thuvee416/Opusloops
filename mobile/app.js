(() => {
  "use strict";

  const STORAGE_CURRENT = "opusloops.mobile.current.v1";
  const STORAGE_PROJECTS = "opusloops.mobile.projects.v1";
  const STORAGE_RECOVERY = "opusloops.mobile.recovery.v1";
  const STORAGE_DELETIONS = "opusloops.mobile.deletions.v1";
  const PROJECT_SCHEMA_VERSION = 3;
  const AUDIO_ENGINE_VERSION = 1;
  const CLOUD_SAVE_DELAY = 650;
  const STEM_PREVIEW_ASSET_LIMIT = 16 * 512;
  const FUTURE_TIMESTAMP_WINDOW = 23 * 60 * 60 * 1000;
  const STEPS = 16;
  const TRACKS = [
    { id: "kick", name: "Kick", kind: "kick", color: "#ff6b9d" },
    { id: "snare", name: "Snare", kind: "snare", color: "#ffad42" },
    { id: "bass", name: "Bass", kind: "bass", color: "#20c7ef" },
    { id: "chords", name: "Chords", kind: "chords", color: "#3b82f6" }
  ];
  const KEYS = ["C minor", "D minor", "E minor", "F minor", "G minor", "A minor"];
  const STEM_COLORS = ["#ff6b9d", "#ffad42", "#4de3c2", "#c79cff", "#ff876f", "#d8e66b", "#79a8ff", "#f083d1", "#b7b3aa"];
  const stemCore = window.OpusloopsStemCore || null;

  const defaultPatterns = () => [
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
  ];

  const makeProject = () => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    kind: "generated",
    audioEngineVersion: AUDIO_ENGINE_VERSION,
    audioSeed: makeAudioSeed(),
    id: makeId(),
    name: "Untitled loop",
    prompt: "",
    tempo: 96,
    key: "C minor",
    swing: 0.08,
    patterns: defaultPatterns(),
    volumes: [0.88, 0.68, 0.6, 0.48],
    muted: [false, false, false, false],
    stemImport: null,
    updatedAt: new Date().toISOString()
  });

  const cloud = window.OpusloopsCloud || null;
  const stemAssetsByJob = new Map();
  let currentUser = cloud?.getSession()?.user || null;
  let storageReadWarning = "";
  const storedState = readCurrent();
  let state = storedState || makeProject();
  let hasSavedState = Boolean(storedState);
  let saveTimer = 0;
  let cloudTimer = 0;
  let cloudSyncPromise = null;
  let cloudSyncQueued = false;
  let authMode = "signin";
  let toastTimer = 0;
  let installPrompt = null;

  let audioContext = null;
  let masterGain = null;
  let masterLimiter = null;
  let noiseBuffer = null;
  let noiseSeed = null;
  const activeVoices = new Map();
  let schedulerTimer = 0;
  let audioResetTimer = 0;
  let audioSuspendTimer = 0;
  let nextStepTime = 0;
  let currentStep = 0;
  const uiTimers = new Set();
  let playing = false;
  let playbackStarting = false;
  let pendingAudioExport = null;
  let playbackStartRequest = 0;
  let playbackResumeRequest = 0;
  let playbackOffset = 0;
  let playbackAnchorTime = 0;
  let playbackProgressFrame = 0;
  let playbackSessionVisible = false;
  let playbackProjectId = null;
  let playbackScrubbing = false;
  let resumeAfterSeek = false;
  let playbackScrubPosition = 0;
  let playbackScrubSource = "project";
  let playbackScrubAuditionKey = "";
  let playbackSource = "project";
  let auditionPlayback = null;
  let auditionErrorKey = "";
  let stemPlayer = null;
  let stemImportController = null;
  let preparedStemProject = null;
  let activeMixerKey = "";
  let mixerDrag = null;
  let suppressedMixerClick = { key: "", until: 0 };

  const dom = {
    composerForm: document.querySelector("#composer-form"),
    ideaInput: document.querySelector("#idea-input"),
    studioTitle: document.querySelector("#studio-title"),
    tempoOutput: document.querySelector("#tempo-output"),
    playButton: document.querySelector("#play-button"),
    persistentPlayer: document.querySelector("#persistent-player"),
    persistentPlayButton: document.querySelector("#persistent-play-button"),
    persistentPlayerTitle: document.querySelector("#persistent-player-title"),
    persistentSeek: document.querySelector("#persistent-seek"),
    persistentSeekLabel: document.querySelector("#persistent-seek-label"),
    persistentCurrentTime: document.querySelector("#persistent-current-time"),
    persistentDuration: document.querySelector("#persistent-duration"),
    keyButton: document.querySelector("#key-button"),
    sequencer: document.querySelector("#sequencer"),
    mixer: document.querySelector("#mixer"),
    projectsList: document.querySelector("#projects-list"),
    saveAnnouncer: document.querySelector("#save-announcer"),
    saveCopy: document.querySelector("#save-copy"),
    recentName: document.querySelector("#recent-project-name"),
    recentMeta: document.querySelector("#recent-project-meta"),
    refineDialog: document.querySelector("#refine-dialog"),
    refineForm: document.querySelector("#refine-form"),
    refineInput: document.querySelector("#refine-input"),
    toast: document.querySelector("#toast"),
    installCard: document.querySelector("#install-card"),
    installButton: document.querySelector("#install-button"),
    exportAudioButton: document.querySelector("#export-audio-button"),
    exportReady: document.querySelector("#audio-export-ready"),
    exportReadyCopy: document.querySelector("#audio-export-ready-copy"),
    shareAudioButton: document.querySelector("#share-audio-button"),
    downloadAudioLink: document.querySelector("#download-audio-link"),
    accountDialog: document.querySelector("#account-dialog"),
    accountForm: document.querySelector("#account-form"),
    accountEmail: document.querySelector("#account-email"),
    accountPassword: document.querySelector("#account-password"),
    accountInviteField: document.querySelector("#account-invite-field"),
    accountInvite: document.querySelector("#account-invite"),
    accountNote: document.querySelector("#account-note"),
    accountError: document.querySelector("#account-error"),
    accountEyebrow: document.querySelector("#account-eyebrow"),
    accountTitle: document.querySelector("#account-title"),
    accountIntro: document.querySelector("#account-intro"),
    accountSubmit: document.querySelector("#account-submit"),
    accountSwitch: document.querySelector("#account-switch-button"),
    signedInPanel: document.querySelector("#signed-in-panel"),
    signedInAvatar: document.querySelector("#signed-in-avatar"),
    signedInEmail: document.querySelector("#signed-in-email"),
    accountCardMark: document.querySelector("#account-card-mark"),
    accountCardInitial: document.querySelector("#account-card-initial"),
    accountCardEyebrow: document.querySelector("#account-card-eyebrow"),
    accountCardTitle: document.querySelector("#account-card-title"),
    accountCardCopy: document.querySelector("#account-card-copy"),
    accountCardButton: document.querySelector("#account-card-button"),
    projectsEyebrow: document.querySelector("#projects-eyebrow"),
    projectsLede: document.querySelector("#projects-lede"),
    generatedStudio: document.querySelector("#generated-studio"),
    stemStudio: document.querySelector("#stem-studio"),
    stemArrangement: document.querySelector("#stem-arrangement"),
    stemArrangementRuler: document.querySelector("#stem-arrangement-ruler"),
    stemArrangementDuration: document.querySelector("#stem-arrangement-duration"),
    tempoAdjustments: document.querySelector("#tempo-adjustments"),
    keyDetail: document.querySelector("#key-detail"),
    mixEyebrow: document.querySelector("#mix-eyebrow"),
    mixTitle: document.querySelector("#mix-title"),
    mixLede: document.querySelector("#mix-lede")
  };

  function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function makeAudioSeed() {
    const values = new Uint32Array(1);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(values);
      return values[0];
    }
    return Math.floor(Math.random() * 0x100000000) >>> 0;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeStemImport(candidate) {
    if (!candidate || typeof candidate !== "object" || !stemCore) return null;
    const jobId = String(candidate.jobId || "").slice(0, 200);
    const tracks = Array.isArray(candidate.tracks)
      ? candidate.tracks.slice(0, 16).map((track, index) => ({
          ...stemCore.normalizeTrack(track, index),
          color: String(track?.color || STEM_COLORS[index % STEM_COLORS.length])
        }))
      : [];
    const incomingAssets = Array.isArray(candidate.previewAssets)
      ? candidate.previewAssets.slice(0, STEM_PREVIEW_ASSET_LIMIT).map(stemCore.normalizeAsset)
      : [];
    if (jobId && incomingAssets.length) stemAssetsByJob.set(jobId, incomingAssets);
    const previewAssets = incomingAssets.length ? incomingAssets : stemAssetsByJob.get(jobId) || [];
    const disabledSegments = stemCore.normalizeDisabledSegments(candidate.disabledSegments, tracks);
    previewAssets.forEach((asset) => {
      if (candidate.arrangement?.[asset.id] !== false || !asset.trackId
          || !Number.isSafeInteger(asset.segmentIndex)) return;
      const indexes = new Set(disabledSegments[asset.trackId] || []);
      indexes.add(asset.segmentIndex);
      disabledSegments[asset.trackId] = [...indexes].sort((left, right) => left - right).slice(0, 512);
    });
    const arrangement = Object.fromEntries(previewAssets.map((asset) => [
      asset.id,
      !(disabledSegments[asset.trackId] || []).includes(asset.segmentIndex)
    ]));
    return {
      jobId,
      status: stemCore.normalizeStatus(candidate.status),
      revision: Math.max(0, Math.trunc(Number(candidate.revision) || 0)),
      mode: stemCore.MODES.includes(candidate.mode) ? candidate.mode : "musical-4bar",
      durationSeconds: Math.max(0, Number(candidate.durationSeconds) || 0),
      tracks,
      previewAssets,
      arrangement,
      disabledSegments,
      regions: Array.isArray(candidate.regions) ? candidate.regions.slice(0, 256).map(stemCore.normalizeRegion) : [],
      inspectionManifestSha256: String(candidate.inspectionManifestSha256 || "").slice(0, 64),
      analysisSha256: String(candidate.analysisSha256 || "").slice(0, 64),
      proposalManifestSha256: String(candidate.proposalManifestSha256 || "").slice(0, 64)
    };
  }

  function normalizeProject(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const base = makeProject();
    const stemImport = normalizeStemImport(candidate.stemImport);
    const kind = candidate.kind === "stem-import" && stemImport?.jobId ? "stem-import" : "generated";
    const patterns = Array.isArray(candidate.patterns) ? candidate.patterns : base.patterns;
    const rawId = String(candidate.id || "");
    const candidateId = isUuid(rawId) ? rawId : rawId ? legacyProjectId(rawId) : base.id;
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      kind,
      audioEngineVersion: AUDIO_ENGINE_VERSION,
      audioSeed: Number.isFinite(Number(candidate.audioSeed)) ? Number(candidate.audioSeed) >>> 0 : hashText(candidateId),
      id: candidateId,
      name: cleanName(candidate.name) || base.name,
      prompt: String(candidate.prompt || "").replace(/\s+/g, " ").trim().slice(0, 180),
      tempo: clamp(Number(candidate.tempo) || base.tempo, kind === "stem-import" ? 20 : 56, kind === "stem-import" ? 400 : 180),
      key: kind === "stem-import"
        ? String(candidate.key || "—").replace(/\s+/g, " ").trim().slice(0, 24) || "—"
        : KEYS.includes(candidate.key) ? candidate.key : base.key,
      swing: clamp(Number(candidate.swing) || 0, 0, 0.28),
      patterns: TRACKS.map((_, trackIndex) =>
        Array.from({ length: STEPS }, (_, stepIndex) =>
          patterns[trackIndex]?.[stepIndex] ? 1 : 0
        )
      ),
      volumes: TRACKS.map((_, index) => clamp(Number(candidate.volumes?.[index] ?? base.volumes[index]), 0, 1)),
      muted: TRACKS.map((_, index) => Boolean(candidate.muted?.[index])),
      stemImport: kind === "stem-import" ? stemImport : null,
      updatedAt: normalizeTimestamp(candidate.updatedAt, base.updatedAt)
    };
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
  }

  function legacyProjectId(value) {
    const text = `opusloops:${String(value)}`;
    const seeds = [2166136261, 2246822507, 3266489909, 668265263];
    const bytes = new Uint8Array(16);
    seeds.forEach((seed, wordIndex) => {
      let hash = seed;
      for (const char of text) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
      }
      for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        bytes[wordIndex * 4 + byteIndex] = (hash >>> (byteIndex * 8)) & 0xff;
      }
    });
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function normalizeTimestamp(value, fallback) {
    const timestamp = Date.parse(value);
    // Bucket the ceiling by minute so it advances in long-running PWAs without
    // changing between repeated reads in the same save/sync pass.
    const currentMinute = Math.floor(Date.now() / 60000) * 60000;
    const futureCeiling = currentMinute + FUTURE_TIMESTAMP_WINDOW;
    return Number.isFinite(timestamp) ? new Date(Math.min(timestamp, futureCeiling)).toISOString() : fallback;
  }

  function nextTimestamp(previous) {
    const now = Date.now();
    const previousTime = Date.parse(previous);
    const monotonicTime = Number.isFinite(previousTime) ? previousTime + 1 : now;
    return new Date(Math.min(Math.max(now, monotonicTime), now + FUTURE_TIMESTAMP_WINDOW)).toISOString();
  }

  function cleanName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 48);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function readJson(key, fallback) {
    let value = null;
    try {
      value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      if (value) preserveUnreadableValue(key, value);
      else storageReadWarning = "Browser storage could not be read";
      return fallback;
    }
  }

  function preserveUnreadableValue(key, value) {
    storageReadWarning = "A damaged local save was preserved for recovery";
    try {
      const existing = localStorage.getItem(STORAGE_RECOVERY);
      const records = existing ? JSON.parse(existing) : [];
      const safeRecords = Array.isArray(records) ? records : [];
      safeRecords.push({ key, value, preservedAt: new Date().toISOString() });
      localStorage.setItem(STORAGE_RECOVERY, JSON.stringify(safeRecords.slice(-4)));
    } catch {
      storageReadWarning = "A local save could not be read";
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      showToast("This browser could not save the project");
      return false;
    }
  }

  function scopedStorageKey(key, user = currentUser) {
    return user?.id ? `${key}.user.${user.id}` : key;
  }

  function readCurrent() {
    return normalizeProject(readJson(scopedStorageKey(STORAGE_CURRENT), null));
  }

  function readProjects() {
    const projects = readJson(scopedStorageKey(STORAGE_PROJECTS), []);
    if (!Array.isArray(projects)) return [];
    return projects.map(normalizeProject).filter(Boolean);
  }

  function readDeletions() {
    const value = readJson(scopedStorageKey(STORAGE_DELETIONS), {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function writeCurrent(project) {
    return writeJson(scopedStorageKey(STORAGE_CURRENT), projectDocument(project));
  }

  function writeProjects(projects) {
    return writeJson(scopedStorageKey(STORAGE_PROJECTS), projects.map(projectDocument).filter(Boolean));
  }

  function writeDeletions(deletions) {
    return writeJson(scopedStorageKey(STORAGE_DELETIONS), deletions);
  }

  function localSyncSnapshot() {
    return JSON.stringify({
      projects: readProjects().map(projectDocument).filter(Boolean),
      deletions: readDeletions()
    });
  }

  function persist({ announce = false, touch = true, sync = true } = {}) {
    if (touch) state.updatedAt = nextTimestamp(state.updatedAt);
    const projects = readProjects();
    const index = projects.findIndex((project) => project.id === state.id);
    const snapshot = clone(state);
    if (index >= 0) projects[index] = snapshot;
    else projects.push(snapshot);

    if (writeCurrent(snapshot) && writeProjects(projects)) {
      hasSavedState = true;
      setSaveStatus("Saved on device");
      renderRecent();
      renderProjects();
      if (sync && currentUser) queueCloudSync();
      if (announce) showToast(currentUser ? "Saved — syncing privately" : "Saved on this device");
    }
  }

  function findProjectById(id) {
    if (state.id === id) return state;
    return readProjects().find((project) => project.id === id) || null;
  }

  function comparableProject(project) {
    const document = projectDocument(project);
    if (document) delete document.updatedAt;
    return JSON.stringify(document);
  }

  function saveStemProject(candidate) {
    const normalized = normalizeProject(candidate);
    if (!normalized || normalized.kind !== "stem-import") return;
    const projects = readProjects();
    const index = projects.findIndex((project) => project.id === normalized.id);
    const existing = index >= 0 ? projects[index] : null;
    if (existing && comparableProject(existing) === comparableProject(normalized)) {
      if (state.id === normalized.id
          && state.stemImport?.previewAssets?.length !== normalized.stemImport.previewAssets.length) {
        const playbackSnapshot = capturePlaybackMutation();
        state = normalized;
        renderAll();
        restorePlaybackMutation(playbackSnapshot);
      }
      return;
    }
    normalized.updatedAt = nextTimestamp(existing?.updatedAt || normalized.updatedAt);
    if (index >= 0) projects[index] = clone(normalized);
    else projects.push(clone(normalized));
    if (!writeProjects(projects)) return;
    const shouldOpen = !existing || state.id === normalized.id;
    if (shouldOpen) {
      const playbackSnapshot = state.id === normalized.id ? capturePlaybackMutation() : null;
      if (!existing) resetPlaybackSession();
      state = normalized;
      writeCurrent(state);
      renderAll();
      if (playbackSnapshot) restorePlaybackMutation(playbackSnapshot);
    } else {
      renderProjects();
    }
    if (preparedStemProject?.projectId === normalized.id) preparedStemProject = null;
    setSaveStatus("Saved on device");
    if (currentUser) queueCloudSync();
  }

  async function prepareStemProject({ projectId, file }) {
    if (!currentUser || !isUuid(projectId)) throw new Error("Sign in to create a private stem project");
    const sourceName = cleanName(String(file?.name || "Imported stems").replace(/\.zip$/i, "")) || "Imported stems";
    const previousState = clone(state);
    const shell = normalizeProject({
      ...makeProject(),
      id: projectId,
      name: sourceName,
      prompt: ""
    });
    preparedStemProject = { projectId, previousState };
    resetPlaybackSession();
    state = shell;
    renderAll();
    persist({ touch: false });
    const synced = await drainCloudSync(20000);
    if (!synced) throw new Error("The private project could not be saved before upload");
    return shell;
  }

  function discardPreparedStemProject(projectId) {
    if (!preparedStemProject || preparedStemProject.projectId !== projectId) return;
    const projects = readProjects();
    const discarded = projects.find((project) => project.id === projectId);
    const remaining = projects.filter((project) => project.id !== projectId);
    const deletedAt = nextTimestamp(discarded?.updatedAt);
    writeProjects(remaining);
    writeDeletions({ ...readDeletions(), [projectId]: deletedAt });
    state = normalizeProject(preparedStemProject.previousState) || remaining[0] || makeProject();
    preparedStemProject = null;
    writeCurrent(state);
    renderAll();
    if (state.kind === "stem-import") stemImportController?.resumeProject(state);
    else stemImportController?.stop({ preserveJob: false });
    queueCloudSync();
  }

  function queueSave() {
    setSaveStatus("Saving…");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      persist();
    }, 260);
  }

  function flushSave() {
    if (!saveTimer) return;
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    persist();
  }

  function setSaveStatus(label) {
    if (dom.saveAnnouncer && dom.saveAnnouncer.textContent !== label) dom.saveAnnouncer.textContent = label;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 2200);
  }

  function showView(name, { focus = true } = {}) {
    if (name !== "mix") finishMixerDrag();
    const navigationName = name === "import" ? "create" : name;
    document.querySelectorAll("[data-view]").forEach((view) => {
      view.classList.toggle("is-active", view.dataset.view === name);
    });
    document.querySelectorAll(".nav-item").forEach((item) => {
      const active = item.dataset.viewTarget === navigationName;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    if (focus) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      document.querySelector(`#view-${name}`)?.focus({ preventScroll: true });
    }
    if (name === "projects") renderProjects();
    if (name === "import" && state.kind === "stem-import") stemImportController?.resumeProject(state);
  }

  function projectTimestamp(project) {
    const timestamp = Date.parse(project?.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function projectDocument(project) {
    const normalized = normalizeProject(project);
    if (!normalized) return null;
    const persistedStemImport = normalized.stemImport ? {
      jobId: normalized.stemImport.jobId,
      status: normalized.stemImport.status,
      revision: normalized.stemImport.revision,
      mode: normalized.stemImport.mode,
      durationSeconds: normalized.stemImport.durationSeconds,
      tracks: normalized.stemImport.tracks,
      disabledSegments: normalized.stemImport.disabledSegments,
      // Review/render details are authoritative in stem_import_jobs and hydrate on open.
      regions: [],
      inspectionManifestSha256: normalized.stemImport.inspectionManifestSha256,
      analysisSha256: normalized.stemImport.analysisSha256,
      proposalManifestSha256: normalized.stemImport.proposalManifestSha256
    } : null;
    return {
      schemaVersion: normalized.schemaVersion,
      kind: normalized.kind,
      audioEngineVersion: normalized.audioEngineVersion,
      audioSeed: normalized.audioSeed,
      id: normalized.id,
      name: normalized.name,
      prompt: normalized.prompt,
      tempo: normalized.tempo,
      key: normalized.key,
      swing: normalized.swing,
      patterns: normalized.patterns,
      volumes: normalized.volumes,
      muted: normalized.muted,
      stemImport: persistedStemImport,
      updatedAt: normalized.updatedAt
    };
  }

  function projectRow(project) {
    const document = projectDocument(project);
    return {
      id: document.id,
      name: document.name,
      schema_version: document.schemaVersion,
      document,
      client_updated_at: document.updatedAt,
      deleted_at: null
    };
  }

  function tombstoneRow(id, deletedAt) {
    return {
      id,
      name: "Deleted loop",
      schema_version: PROJECT_SCHEMA_VERSION,
      document: { id, schemaVersion: PROJECT_SCHEMA_VERSION },
      client_updated_at: deletedAt,
      deleted_at: deletedAt
    };
  }

  function projectFromRow(row) {
    return normalizeProject({
      ...(row?.document && typeof row.document === "object" ? row.document : {}),
      id: row?.id,
      name: row?.name,
      updatedAt: row?.client_updated_at
    });
  }

  function queueCloudSync() {
    if (!currentUser || !cloud?.configured()) return;
    window.clearTimeout(cloudTimer);
    if (!navigator.onLine) {
      setSaveStatus("Offline — sync pending");
      return;
    }
    setSaveStatus("Syncing…");
    cloudTimer = window.setTimeout(() => {
      cloudTimer = 0;
      syncCloud();
    }, CLOUD_SAVE_DELAY);
  }

  async function syncCloud({ announce = false } = {}) {
    if (!currentUser || !cloud?.configured()) return false;
    if (!navigator.onLine) {
      setSaveStatus("Offline — sync pending");
      if (announce) showToast("Offline — your changes will sync later");
      return false;
    }
    if (cloudSyncPromise) {
      cloudSyncQueued = true;
      return cloudSyncPromise;
    }

    const syncUserId = currentUser.id;
    setSaveStatus("Syncing…");
    cloudSyncPromise = (async () => {
      flushSave();
      const localProjects = readProjects();
      const deletions = readDeletions();
      const localSnapshot = localSyncSnapshot();
      const changes = localProjects.map(projectRow);
      for (const [id, deletedAt] of Object.entries(deletions)) {
        if (isUuid(id) && Number.isFinite(Date.parse(deletedAt))) {
          changes.push(tombstoneRow(id, new Date(deletedAt).toISOString()));
        }
      }
      const rows = await cloud.syncProjects(changes);
      if (currentUser?.id !== syncUserId) return false;
      if (!Array.isArray(rows)) throw new Error("Cloud sync returned an invalid project snapshot");
      const latestSnapshot = localSyncSnapshot();
      if (saveTimer || latestSnapshot !== localSnapshot) {
        cloudSyncQueued = true;
        setSaveStatus("Saved — sync pending");
        return false;
      }

      const merged = [];
      const nextDeletions = {};
      for (const row of rows) {
        if (!isUuid(row?.id)) continue;
        const serverTime = Date.parse(row.client_updated_at);
        if (!Number.isFinite(serverTime)) continue;
        if (row.deleted_at) {
          nextDeletions[row.id] = new Date(serverTime).toISOString();
          continue;
        }
        const project = projectFromRow(row);
        if (project) merged.push(project);
      }

      merged.sort((a, b) => projectTimestamp(b) - projectTimestamp(a));
      writeProjects(merged);
      writeDeletions(nextDeletions);

      const current = merged.find((project) => project.id === state.id);
      let nextState = current || state;
      if (!current && nextDeletions[state.id]) nextState = merged[0] || makeProject();
      const projectChanged = nextState.id !== state.id;
      const audioChanged = playbackAudioFingerprint(nextState) !== playbackAudioFingerprint(state);
      const playbackSnapshot = audioChanged && !projectChanged ? capturePlaybackMutation() : null;
      if (projectChanged) resetPlaybackSession();
      state = nextState;
      writeCurrent(state);
      renderAll();
      if (playbackSnapshot) restorePlaybackMutation(playbackSnapshot);
      if (projectChanged) {
        if (state.kind === "stem-import") stemImportController?.resumeProject(state);
        else stemImportController?.stop({ preserveJob: false });
      }
      setSaveStatus("Saved to account");
      if (announce) showToast("Your projects are synced");
      return true;
    })()
      .catch((error) => {
        if (currentUser?.id !== syncUserId) return false;
        if (!cloud.getSession()) {
          showToast("Your session ended. Sign in again to sync");
          switchUser(null);
          return false;
        }
        setSaveStatus("Saved — sync pending");
        if (announce) showToast(friendlyCloudError(error));
        return false;
      })
      .finally(() => {
        cloudSyncPromise = null;
        if (cloudSyncQueued) {
          cloudSyncQueued = false;
          queueCloudSync();
        }
      });
    return cloudSyncPromise;
  }

  async function drainCloudSync(timeoutMs = 10000) {
    if (!currentUser || !navigator.onLine) return false;
    const userId = currentUser.id;
    const deadline = Date.now() + timeoutMs;
    flushSave();

    for (let pass = 0; pass < 3 && Date.now() < deadline; pass += 1) {
      window.clearTimeout(cloudTimer);
      cloudTimer = 0;
      const before = localSyncSnapshot();
      const remaining = Math.max(1, deadline - Date.now());
      let timeout = 0;
      const outcome = await Promise.race([
        syncCloud().then((synced) => ({ finished: true, synced })),
        new Promise((resolve) => {
          timeout = window.setTimeout(() => resolve({ finished: false, synced: false }), remaining);
        })
      ]);
      window.clearTimeout(timeout);
      if (!outcome.finished || currentUser?.id !== userId) return false;

      window.clearTimeout(cloudTimer);
      cloudTimer = 0;
      if (outcome.synced && !saveTimer && localSyncSnapshot() === before) return true;
    }
    return false;
  }

  function friendlyCloudError(error) {
    const code = String(error?.code || "");
    if (code === "invalid_credentials") return "Email or password is incorrect";
    if (["user_already_exists", "email_exists", "account_exists"].includes(code)) return "An account already uses this email";
    if (code === "weak_password") return "Choose a stronger password with at least 8 characters";
    if (code === "invalid_account_details") return "Check the email and password, then try again";
    if (code === "email_address_invalid") return "Enter a valid email address";
    if (code === "invite_invalid") return "That invitation is invalid, expired, or assigned to another email";
    if (code === "signup_unavailable") return "Account creation is temporarily unavailable";
    if (code === "session_changed") return "The active account changed. Try again";
    if (error?.status === 429) return "Please wait a moment before trying again";
    if (!navigator.onLine || error instanceof TypeError) return "You are offline — try again when connected";
    return "Cloud sync could not finish. Your device copy is safe";
  }

  function readGuestProjects() {
    const projects = readJson(STORAGE_PROJECTS, []);
    if (!Array.isArray(projects)) return [];
    return projects.map(normalizeProject).filter(Boolean);
  }

  function guestImportCount() {
    return currentUser ? readGuestProjects().length : 0;
  }

  function importGuestProjects() {
    if (!currentUser) return;
    const guests = readGuestProjects();
    if (!guests.length) return;
    const merged = new Map(readProjects().map((project) => [project.id, project]));
    guests.forEach((project) => {
      const existing = merged.get(project.id);
      if (!existing || projectTimestamp(project) > projectTimestamp(existing)) merged.set(project.id, project);
    });
    const projects = Array.from(merged.values()).sort((a, b) => projectTimestamp(b) - projectTimestamp(a));
    const nextState = projects[0] || state;
    const projectsSaved = writeProjects(projects);
    const currentSaved = writeCurrent(nextState);
    if (!projectsSaved || !currentSaved) {
      showToast("The device loops are still safe. Free some browser storage and try again");
      return;
    }
    const projectChanged = nextState.id !== state.id;
    const playbackSnapshot = projectChanged ? null : capturePlaybackMutation();
    if (projectChanged) resetPlaybackSession();
    state = nextState;
    try {
      localStorage.removeItem(STORAGE_CURRENT);
      localStorage.removeItem(STORAGE_PROJECTS);
      localStorage.removeItem(STORAGE_DELETIONS);
    } catch {
      // The account-scoped copies are already safe even if guest cleanup is blocked.
    }
    renderAll();
    restorePlaybackMutation(playbackSnapshot);
    if (projectChanged) {
      if (state.kind === "stem-import") stemImportController?.resumeProject(state);
      else stemImportController?.stop({ preserveJob: false });
    }
    renderAuth();
    queueCloudSync();
    showToast(`${guests.length} device ${guests.length === 1 ? "loop" : "loops"} moved to your account`);
  }

  function switchUser(user) {
    flushSave();
    resetPlaybackSession();
    stemPlayer?.destroy();
    stemImportController?.accountChanged();
    stemAssetsByJob.clear();
    window.clearTimeout(cloudTimer);
    cloudTimer = 0;
    currentUser = user?.id ? { id: String(user.id), email: String(user.email || "") } : null;
    const stored = readCurrent();
    state = stored || makeProject();
    hasSavedState = Boolean(stored);
    renderAll();
    renderAuth();
    if (currentUser) {
      syncCloud();
      if (state.kind === "stem-import") stemImportController?.resumeProject(state);
    }
    else setSaveStatus("Saved on device");
  }

  function renderAuth() {
    const signedIn = Boolean(currentUser);
    dom.accountForm.hidden = signedIn;
    dom.signedInPanel.hidden = !signedIn;
    const initial = (currentUser?.email || "O").trim().charAt(0).toUpperCase() || "O";
    dom.accountCardMark.classList.toggle("is-signed-in", signedIn);
    dom.accountCardMark.querySelector("svg").toggleAttribute("hidden", signedIn);
    dom.accountCardInitial.hidden = !signedIn;
    dom.accountCardInitial.textContent = initial;
    dom.saveCopy.textContent = signedIn ? "Saved locally, synced privately" : "Saved on this device";

    if (signedIn) {
      dom.signedInAvatar.textContent = initial;
      dom.signedInEmail.textContent = currentUser.email || "Opusloops account";
      dom.accountEyebrow.textContent = "Private cloud sync";
      dom.accountTitle.textContent = "Your account";
      const importCount = guestImportCount();
      if (importCount) {
        dom.accountCardEyebrow.textContent = "Ready to import";
        dom.accountCardTitle.textContent = `${importCount} device ${importCount === 1 ? "loop is" : "loops are"} waiting.`;
        dom.accountCardCopy.textContent = "Move them into this account once, then they will sync with your other projects.";
        dom.accountCardButton.textContent = "Move to my account";
        dom.accountCardButton.dataset.action = "import";
      } else {
        dom.accountCardEyebrow.textContent = "Private cloud sync";
        dom.accountCardTitle.textContent = "Your loops travel with you.";
        dom.accountCardCopy.textContent = `Signed in as ${currentUser.email}. Device saves sync whenever you are online.`;
        dom.accountCardButton.textContent = "Manage account";
        dom.accountCardButton.dataset.action = "manage";
      }
      dom.projectsEyebrow.textContent = "Private cloud library";
      dom.projectsLede.textContent = "Available offline here and synced privately to your account when connected.";
    } else {
      dom.accountCardEyebrow.textContent = "Private cloud sync";
      dom.accountCardTitle.textContent = "Keep every loop with you.";
      dom.accountCardCopy.textContent = "Sign in to bring your projects to another phone without giving up offline access.";
      dom.accountCardButton.textContent = "Sign in";
      dom.accountCardButton.dataset.action = "signin";
      dom.projectsEyebrow.textContent = "Device first";
      dom.projectsLede.textContent = "Create and play offline. Sign in to privately sync your work across devices.";
    }
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    const signingUp = authMode === "signup";
    dom.accountEyebrow.textContent = signingUp ? "One private library" : "Private cloud sync";
    dom.accountTitle.textContent = signingUp ? "Create your account" : "Sign in to Opusloops";
    dom.accountIntro.textContent = signingUp
      ? "Start with your device loops, then keep them privately synced wherever you create."
      : "Your loops remain playable offline and sync privately when you are connected.";
    dom.accountSubmit.textContent = signingUp ? "Create account" : "Sign in";
    dom.accountSwitch.textContent = signingUp ? "I already have an account" : "Create an account";
    dom.accountPassword.autocomplete = signingUp ? "new-password" : "current-password";
    dom.accountInviteField.hidden = !signingUp;
    dom.accountInvite.required = signingUp;
    dom.accountNote.textContent = signingUp
      ? "Accounts are invitation-only during early access. Each invitation works once for its assigned email."
      : "At least 8 characters. Cloud saves are protected by your account.";
    dom.accountError.hidden = true;
  }

  function openAccountDialog(mode = authMode) {
    if (!currentUser) setAuthMode(mode);
    if (typeof dom.accountDialog.showModal === "function") dom.accountDialog.showModal();
    else dom.accountDialog.setAttribute("open", "");
    if (!currentUser) window.setTimeout(() => dom.accountEmail.focus(), 0);
  }

  function closeAccountDialog() {
    dom.accountDialog.close?.();
    dom.accountDialog.removeAttribute("open");
  }

  function hashText(text) {
    let hash = 2166136261;
    for (const char of text.toLowerCase()) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function seededRandom(seed) {
    let value = seed || 1;
    return () => {
      value += 0x6d2b79f5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  function projectNameFromPrompt(prompt) {
    const ignored = new Set(["a", "an", "the", "with", "and", "that", "for", "loop", "groove"]);
    const words = prompt
      .replace(/[^a-zA-Z0-9' -]/g, " ")
      .split(/\s+/)
      .filter((word) => word && !ignored.has(word.toLowerCase()))
      .slice(0, 4);
    if (!words.length) return "New loop";
    return words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  }

  function composeFromPrompt(prompt) {
    const text = prompt.toLowerCase();
    const seed = hashText(prompt);
    const random = seededRandom(seed);
    const ambient = /ambient|spacious|soft|calm|slow|dream|airy/.test(text);
    const driving = /driving|fast|club|dance|techno|house|energy/.test(text);
    const playful = /playful|funk|syncopat|bounce|bright|quirky/.test(text);
    const warm = /warm|soul|late.?night|mellow|cozy|patient/.test(text);

    const density = ambient ? 0.15 : driving ? 0.36 : playful ? 0.31 : 0.24;
    const patterns = Array.from({ length: TRACKS.length }, () => Array(STEPS).fill(0));

    patterns[0][0] = 1;
    patterns[0][8] = 1;
    if (!ambient) patterns[0][4] = 1;
    if (driving) patterns[0][12] = 1;
    if (playful) patterns[0][10] = 1;

    patterns[1][4] = 1;
    patterns[1][12] = 1;
    if (driving || playful) patterns[1][15] = 1;

    for (let step = 0; step < STEPS; step += 1) {
      if (random() < density && step % 2 === 0) patterns[2][step] = 1;
      if (random() < density * 0.45 && step % 4 === 0) patterns[3][step] = 1;
    }
    patterns[2][0] = 1;
    patterns[2][8] = 1;
    patterns[3][0] = 1;
    patterns[3][8] = 1;

    if (warm) {
      patterns[2][6] = 1;
      patterns[2][14] = 1;
    }

    state = normalizeProject({
      ...state,
      kind: "generated",
      stemImport: null,
      id: makeId(),
      audioEngineVersion: AUDIO_ENGINE_VERSION,
      audioSeed: seed,
      name: projectNameFromPrompt(prompt),
      prompt,
      tempo: ambient ? 74 + Math.floor(random() * 12) : driving ? 118 + Math.floor(random() * 14) : 88 + Math.floor(random() * 20),
      key: KEYS[seed % KEYS.length],
      swing: playful ? 0.18 : warm ? 0.12 : 0.06,
      patterns,
      updatedAt: new Date().toISOString()
    });

    renderAll();
    persist();
  }

  function renderAll() {
    const stems = state.kind === "stem-import";
    dom.studioTitle.textContent = state.name;
    dom.tempoOutput.textContent = `${Math.round(state.tempo * 10) / 10} BPM`;
    dom.keyButton.textContent = state.key;
    dom.generatedStudio.hidden = stems;
    dom.stemStudio.hidden = !stems;
    dom.tempoAdjustments.classList.toggle("is-readonly", stems);
    dom.keyDetail.hidden = stems;
    if (stems) {
      renderStemArrangement();
      stemPlayer?.loadProject(state);
    } else {
      renderSequencer();
    }
    renderMixer();
    renderRecent();
    renderProjects();
    renderPlaybackMetadata();
  }

  function renderRecent() {
    dom.recentName.textContent = state.name;
    dom.recentMeta.textContent = state.kind === "stem-import"
      ? `${Math.round(state.tempo * 10) / 10} BPM · ${state.stemImport.tracks.length} stems · ${stemCore.statusLabel(state.stemImport.status)}`
      : `${state.tempo} BPM · ${state.key}`;
  }

  function renderSequencer() {
    dom.sequencer.replaceChildren();
    TRACKS.forEach((track, trackIndex) => {
      const card = document.createElement("section");
      card.className = `track-card${state.muted[trackIndex] ? " is-muted" : ""}`;
      card.style.setProperty("--track-color", track.color);
      card.dataset.trackIndex = String(trackIndex);

      const header = document.createElement("div");
      header.className = "track-header";
      header.innerHTML = `
        <span class="track-title"><span class="track-swatch"></span>${track.name}</span>
        <span class="track-actions">
          <button type="button" data-mute-track="${trackIndex}" aria-label="${state.muted[trackIndex] ? "Unmute" : "Mute"} ${track.name}" aria-pressed="${state.muted[trackIndex]}">
            ${state.muted[trackIndex] ? "Muted" : "Mute"}
          </button>
        </span>`;

      const scroll = document.createElement("div");
      scroll.className = "steps-scroll";
      const grid = document.createElement("div");
      grid.className = "step-grid";
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", `${track.name} steps`);

      state.patterns[trackIndex].forEach((active, stepIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `step${active ? " is-on" : ""}`;
        button.dataset.track = String(trackIndex);
        button.dataset.step = String(stepIndex);
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.setAttribute("aria-label", `${track.name}, step ${stepIndex + 1}, ${active ? "on" : "off"}`);
        grid.append(button);
      });

      scroll.append(grid);
      scroll.addEventListener(
        "scroll",
        () => {
          dom.sequencer.querySelectorAll(".steps-scroll").forEach((other) => {
            if (other !== scroll && other.scrollLeft !== scroll.scrollLeft) other.scrollLeft = scroll.scrollLeft;
          });
        },
        { passive: true }
      );
      card.append(header, scroll);
      dom.sequencer.append(card);
    });
  }

  function mixerPresentation(percent) {
    const level = clamp(Number(percent) || 0, 0, 100) / 100;
    return {
      percent: Math.round(level * 100),
      energy: 0.08 + level * 0.92,
      floor: 0.05 + level * 0.13,
      duration: 2.35 - level * 1.08,
      opacity: 0.28 + level * 0.72
    };
  }

  function setMixerTilePresentation(tile, percent, muted) {
    if (!tile) return;
    const presentation = mixerPresentation(percent);
    tile.style.setProperty("--mix-level", `${presentation.percent}%`);
    tile.style.setProperty("--mix-energy", presentation.energy.toFixed(3));
    tile.style.setProperty("--mix-floor", presentation.floor.toFixed(3));
    tile.style.setProperty("--mix-duration", `${presentation.duration.toFixed(2)}s`);
    tile.style.setProperty("--mix-opacity", presentation.opacity.toFixed(3));
    tile.classList.toggle("is-silent", presentation.percent === 0);
    tile.classList.toggle("is-muted", Boolean(muted));
    const amount = tile.querySelector("[data-mixer-amount]");
    if (amount) amount.textContent = `${presentation.percent}%`;
    const slider = tile.querySelector('input[type="range"]');
    if (slider) slider.setAttribute("aria-valuetext", `${presentation.percent} percent${muted ? ", muted" : ""}`);
  }

  function updateMixerTileSelection() {
    let activeTile = null;
    dom.mixer.querySelectorAll(".mixer-tile").forEach((tile) => {
      const active = tile.dataset.mixerKey === activeMixerKey;
      tile.classList.toggle("is-active", active);
      const hint = tile.querySelector("[data-mixer-hint]");
      if (hint) hint.textContent = "Drag up or down";
      if (active) activeTile = tile;
    });
    if (!activeTile) activeMixerKey = "";
  }

  function activateMixerTile(tile, { focus = true } = {}) {
    if (!tile) return;
    activeMixerKey = tile.dataset.mixerKey || "";
    updateMixerTileSelection();
    if (focus) tile.querySelector('input[type="range"]')?.focus({ preventScroll: true });
  }

  function createMixerTile({ key, index, name, color, percent, muted, stemAssetId = "", trackIndex = null }) {
    const tile = document.createElement("article");
    const idPrefix = stemAssetId ? "stem" : "track";
    const labelId = `mixer-${idPrefix}-label-${index}`;
    const hintId = `mixer-${idPrefix}-hint-${index}`;
    tile.className = "mixer-tile";
    tile.dataset.mixerKey = key;
    tile.style.setProperty("--track-color", color);
    tile.setAttribute("role", "group");
    tile.setAttribute("aria-labelledby", labelId);

    const header = document.createElement("header");
    header.className = "mixer-tile-header";
    const label = document.createElement("div");
    label.className = "mixer-tile-label";
    const number = document.createElement("span");
    number.className = "mixer-tile-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("strong");
    title.id = labelId;
    title.textContent = name;
    title.title = name;
    label.append(number, title);

    const mute = document.createElement("button");
    mute.className = "mute-button";
    mute.type = "button";
    if (stemAssetId) mute.dataset.muteStem = stemAssetId;
    else mute.dataset.muteTrack = String(trackIndex);
    mute.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${name}`);
    mute.setAttribute("aria-pressed", String(muted));
    mute.textContent = "M";
    header.append(label, mute);

    const gesture = document.createElement("div");
    gesture.className = "mixer-gesture";
    gesture.dataset.mixerGesture = "";
    const waveform = document.createElement("span");
    waveform.className = "mixer-waveform";
    waveform.setAttribute("aria-hidden", "true");
    for (let barIndex = 0; barIndex < 7; barIndex += 1) {
      const bar = document.createElement("i");
      bar.className = "mixer-wave-bar";
      waveform.append(bar);
    }
    const amount = document.createElement("span");
    amount.className = "mixer-amount";
    amount.dataset.mixerAmount = "";
    amount.setAttribute("aria-hidden", "true");
    const hint = document.createElement("span");
    hint.className = "mixer-hint";
    hint.id = hintId;
    hint.dataset.mixerHint = "";
    gesture.append(waveform, amount, hint);

    const slider = document.createElement("input");
    slider.className = "sr-only mixer-native-range";
    slider.id = `mixer-${idPrefix}-volume-${index}`;
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(percent));
    slider.setAttribute("aria-label", `${name} volume`);
    slider.setAttribute("aria-describedby", hintId);
    slider.setAttribute("aria-orientation", "vertical");
    if (stemAssetId) slider.dataset.volumeStem = stemAssetId;
    else slider.dataset.volumeTrack = String(trackIndex);

    tile.append(header, gesture, slider);
    setMixerTilePresentation(tile, percent, muted);
    return tile;
  }

  function mixerPercentFromDrag(startValue, startY, currentY, travel) {
    const delta = ((startY - currentY) / Math.max(travel, 1)) * 100;
    return clamp(Math.round(startValue + delta), 0, 100);
  }

  function beginMixerDrag(event) {
    const gesture = event.target.closest("[data-mixer-gesture]");
    const tile = gesture?.closest(".mixer-tile");
    if (!gesture || !tile) return;
    if (event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    const slider = tile.querySelector('input[type="range"]');
    if (!slider) return;
    finishMixerDrag();
    activateMixerTile(tile);
    mixerDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startValue: Number(slider.value),
      gesture,
      tile,
      slider,
      adjusting: false
    };
    tile.classList.add("is-gesture-ready");
    try {
      gesture.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level listeners keep the drag alive when capture is unavailable.
    }
  }

  function moveMixerDrag(event) {
    if (!mixerDrag || event.pointerId !== mixerDrag.pointerId) return;
    const distance = mixerDrag.startY - event.clientY;
    if (!mixerDrag.adjusting && Math.abs(distance) < 7) return;
    mixerDrag.adjusting = true;
    mixerDrag.tile.classList.remove("is-gesture-ready");
    mixerDrag.tile.classList.add("is-adjusting");
    const nextPercent = mixerPercentFromDrag(
      mixerDrag.startValue,
      mixerDrag.startY,
      event.clientY,
      mixerDrag.gesture.clientHeight
    );
    if (Number(mixerDrag.slider.value) !== nextPercent) {
      mixerDrag.slider.value = String(nextPercent);
      mixerDrag.slider.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (event.cancelable) event.preventDefault();
  }

  function finishMixerDrag(event) {
    if (!mixerDrag || (event && event.pointerId !== mixerDrag.pointerId)) return;
    const finished = mixerDrag;
    mixerDrag = null;
    finished.tile.classList.remove("is-gesture-ready", "is-adjusting");
    if (finished.adjusting) {
      suppressedMixerClick = {
        key: finished.tile.dataset.mixerKey || "",
        until: performance.now() + 300
      };
    }
    try {
      if (finished.gesture.hasPointerCapture?.(finished.pointerId)) {
        finished.gesture.releasePointerCapture(finished.pointerId);
      }
    } catch {
      // Pointer capture may already be released after cancellation.
    }
  }

  function renderMixer() {
    finishMixerDrag();
    dom.mixer.replaceChildren();
    if (state.kind === "stem-import") {
      dom.mixEyebrow.textContent = "Aligned stem mix";
      dom.mixTitle.textContent = "Balance every part.";
      dom.mixLede.textContent = "Drag up or down on any stem. The number and motion follow your finger live.";
      state.stemImport.tracks.forEach((track, index) => {
        dom.mixer.append(createMixerTile({
          key: `stem:${track.assetId}`,
          index,
          name: track.name,
          color: track.color || STEM_COLORS[index % STEM_COLORS.length],
          percent: track.volume * 100,
          muted: track.muted,
          stemAssetId: track.assetId
        }));
      });
    } else {
      dom.mixEyebrow.textContent = "Keep it simple";
      dom.mixTitle.textContent = "Mix by feel.";
      dom.mixLede.textContent = "Drag up or down on any tile. The number and motion follow your finger live.";
      TRACKS.forEach((track, index) => {
        dom.mixer.append(createMixerTile({
          key: `track:${track.id}`,
          index,
          name: track.name,
          color: track.color,
          percent: state.volumes[index] * 100,
          muted: state.muted[index],
          trackIndex: index
        }));
      });
    }
    updateMixerTileSelection();
  }

  function renderStemArrangement() {
    const stem = state.stemImport;
    const assets = stem.previewAssets || [];
    const regionIndexes = Array.from(new Set(assets.map((asset) => asset.segmentIndex))).sort((a, b) => a - b);
    const regionCount = Math.max(regionIndexes.length, stem.regions.length, 1);
    dom.stemArrangementDuration.textContent = stem.durationSeconds ? formatPlaybackTime(stem.durationSeconds).replace(/\.0$/, "") : "Processing";
    dom.stemArrangementRuler.replaceChildren();
    for (let index = 0; index < regionCount; index += 1) {
      const marker = document.createElement("span");
      marker.textContent = String(index * 4 + 1);
      dom.stemArrangementRuler.append(marker);
    }
    dom.stemArrangementRuler.style.setProperty("--region-count", String(regionCount));
    dom.stemArrangement.replaceChildren();
    stem.tracks.forEach((track, trackIndex) => {
      const row = document.createElement("section");
      row.className = `arrangement-track${track.muted ? " is-muted" : ""}`;
      row.style.setProperty("--track-color", track.color || STEM_COLORS[trackIndex % STEM_COLORS.length]);
      const heading = document.createElement("div");
      heading.className = "arrangement-track-heading";
      const swatch = document.createElement("span");
      swatch.className = "track-swatch";
      const name = document.createElement("strong");
      name.textContent = track.name;
      const role = document.createElement("span");
      role.textContent = track.role;
      heading.append(swatch, name, role);
      const scroller = document.createElement("div");
      scroller.className = "arrangement-scroll";
      const clips = document.createElement("div");
      clips.className = "arrangement-clips";
      clips.style.setProperty("--region-count", String(regionCount));
      const trackAssets = assets.filter((asset) => asset.trackId === track.assetId);
      for (let index = 0; index < regionCount; index += 1) {
        const asset = trackAssets.find((candidate) => candidate.segmentIndex === (regionIndexes[index] ?? index));
        if (!asset) {
          const gap = document.createElement("span");
          gap.className = "arrangement-gap";
          clips.append(gap);
          continue;
        }
        const enabled = stem.arrangement[asset.id] !== false;
        const clip = document.createElement("button");
        clip.type = "button";
        clip.className = `arrangement-clip${enabled ? " is-enabled" : ""}`;
        clip.dataset.toggleStemSegment = asset.id;
        clip.setAttribute("aria-pressed", String(enabled));
        clip.setAttribute("aria-label", `${enabled ? "Remove" : "Add"} ${track.name}, bars ${index * 4 + 1} to ${index * 4 + 4}`);
        clip.innerHTML = `<span aria-hidden="true"></span><small>${index * 4 + 1}–${index * 4 + 4}</small>`;
        clips.append(clip);
      }
      scroller.append(clips);
      scroller.addEventListener("scroll", () => {
        dom.stemArrangement.querySelectorAll(".arrangement-scroll").forEach((other) => {
          if (other !== scroller && other.scrollLeft !== scroller.scrollLeft) other.scrollLeft = scroller.scrollLeft;
        });
        dom.stemArrangementRuler.scrollLeft = scroller.scrollLeft;
      }, { passive: true });
      row.append(heading, scroller);
      dom.stemArrangement.append(row);
    });
  }

  function renderProjects() {
    const projects = readProjects().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    dom.projectsList.replaceChildren();
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.innerHTML = "<h2>No saved loops yet.</h2><p>Your first idea will appear here automatically.</p>";
      dom.projectsList.append(empty);
      return;
    }

    projects.forEach((project) => {
      const row = document.createElement("article");
      row.className = "project-row";
      const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(project.updatedAt));
      const projectMeta = project.kind === "stem-import"
        ? `${Math.round(project.tempo * 10) / 10} BPM · ${project.stemImport.tracks.length} stems · ${stemCore.statusLabel(project.stemImport.status)} · ${date}`
        : `${project.tempo} BPM · ${project.key} · ${date}`;
      row.innerHTML = `
        <button class="project-load" type="button" data-load-project="${escapeAttribute(project.id)}">
          <strong>${escapeHtml(project.name)}</strong>
          <span>${escapeHtml(projectMeta)}</span>
        </button>
        <button class="project-delete" type="button" data-delete-project="${escapeAttribute(project.id)}" aria-label="Delete ${escapeAttribute(project.name)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m2 0-1 13H8L7 7m3 4v5m4-5v5" /></svg>
        </button>`;
      dom.projectsList.append(row);
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function toggleStep(trackIndex, stepIndex) {
    state.patterns[trackIndex][stepIndex] = state.patterns[trackIndex][stepIndex] ? 0 : 1;
    const button = dom.sequencer.querySelector(`[data-track="${trackIndex}"][data-step="${stepIndex}"]`);
    const active = Boolean(state.patterns[trackIndex][stepIndex]);
    if (button) {
      button.classList.toggle("is-on", active);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${TRACKS[trackIndex].name}, step ${stepIndex + 1}, ${active ? "on" : "off"}`);
    }
    if (active) previewTrack(trackIndex, stepIndex);
    queueSave();
  }

  function toggleMute(trackIndex) {
    state.muted[trackIndex] = !state.muted[trackIndex];
    renderSequencer();
    renderMixer();
    queueSave();
  }

  function stemTrack(assetId) {
    return state.kind === "stem-import"
      ? state.stemImport.tracks.find((track) => track.assetId === assetId)
      : null;
  }

  function toggleStemMute(assetId) {
    const track = stemTrack(assetId);
    if (!track) return;
    track.muted = !track.muted;
    stemPlayer?.setMix(track.assetId, track.volume, track.muted);
    renderMixer();
    renderStemArrangement();
    queueSave();
  }

  function toggleStemSegment(assetId) {
    if (state.kind !== "stem-import" || !(assetId in state.stemImport.arrangement)) return;
    const playbackSnapshot = capturePlaybackMutation();
    state.stemImport.arrangement[assetId] = state.stemImport.arrangement[assetId] === false;
    const asset = state.stemImport.previewAssets.find((candidate) => candidate.id === assetId);
    if (asset?.trackId && Number.isSafeInteger(asset.segmentIndex)) {
      const disabled = new Set(state.stemImport.disabledSegments[asset.trackId] || []);
      if (state.stemImport.arrangement[assetId] === false) disabled.add(asset.segmentIndex);
      else disabled.delete(asset.segmentIndex);
      if (disabled.size) {
        state.stemImport.disabledSegments[asset.trackId] = [...disabled].sort((left, right) => left - right);
      } else {
        delete state.stemImport.disabledSegments[asset.trackId];
      }
    }
    stemPlayer?.loadProject(state);
    renderStemArrangement();
    queueSave();
    restorePlaybackMutation(playbackSnapshot);
  }

  function createMasterChain(context, destination) {
    const input = context.createGain();
    const limiter = context.createDynamicsCompressor();
    input.gain.value = 0.68;
    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.08;
    input.connect(limiter).connect(destination);
    return { input, limiter };
  }

  function loopDuration(project = state) {
    if (project.kind === "stem-import") {
      return Math.max(0, Number(project.stemImport?.durationSeconds) || stemPlayer?.duration() || 0);
    }
    return STEPS * (60 / project.tempo / 4);
  }

  function wrapPlaybackOffset(offset, duration = loopDuration()) {
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || duration <= 0) return 0;
    const wrapped = offset % duration;
    return wrapped < 0 ? wrapped + duration : wrapped;
  }

  function activeAuditionState() {
    if (playbackSource !== "tempo-audition") return null;
    const current = stemImportController?.getAuditionState?.();
    if (current) auditionPlayback = current;
    return auditionPlayback?.engaged ? auditionPlayback : null;
  }

  function currentProjectPlaybackPosition() {
    const duration = loopDuration();
    if (state.kind === "stem-import") {
      return clamp(stemPlayer?.position() ?? playbackOffset, 0, duration);
    }
    if (playing && audioContext && playbackAnchorTime > 0) {
      const elapsed = Math.max(0, audioContext.currentTime - playbackAnchorTime);
      return wrapPlaybackOffset(playbackOffset + elapsed, duration);
    }
    return clamp(playbackOffset, 0, duration);
  }

  function activePlaybackDuration() {
    const audition = activeAuditionState();
    return audition ? Math.max(0, Number(audition.duration) || 0) : loopDuration();
  }

  function currentPlaybackPosition() {
    const audition = activeAuditionState();
    if (audition) return clamp(Number(audition.position) || 0, 0, activePlaybackDuration());
    return currentProjectPlaybackPosition();
  }

  function activePlaybackPlaying() {
    const audition = activeAuditionState();
    return audition ? Boolean(audition.playing) : playing;
  }

  function activePlaybackStarting() {
    const audition = activeAuditionState();
    return audition ? Boolean(audition.loading) : playbackStarting;
  }

  function formatPlaybackTime(seconds) {
    const totalTenths = Math.max(0, Math.round(seconds * 10));
    const minutes = Math.floor(totalTenths / 600);
    const wholeSeconds = Math.floor((totalTenths % 600) / 10);
    return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${totalTenths % 10}`;
  }

  function renderPlaybackPosition(position = currentPlaybackPosition(), { forceSeek = false } = {}) {
    if (playbackScrubbing && !forceSeek) return;
    const audition = activeAuditionState();
    const duration = activePlaybackDuration();
    const bounded = clamp(position, 0, duration);
    const ratio = duration > 0 ? bounded / duration : 0;
    const rangeValue = Math.round(ratio * 1000);
    const stepIndex = Math.min(STEPS - 1, Math.floor(Math.min(ratio, 0.999999) * STEPS));
    const currentLabel = formatPlaybackTime(bounded);
    const durationLabel = formatPlaybackTime(duration);

    dom.persistentSeek.value = String(rangeValue);
    dom.persistentSeek.style.setProperty("--seek-progress", `${ratio * 100}%`);
    dom.persistentSeek.setAttribute("aria-valuetext", audition || state.kind === "stem-import"
      ? `${currentLabel} of ${durationLabel}`
      : `${currentLabel} of ${durationLabel}, step ${stepIndex + 1} of ${STEPS}`);
    dom.persistentCurrentTime.textContent = currentLabel;
    dom.persistentDuration.textContent = durationLabel;
  }

  function renderPlaybackMetadata() {
    const audition = activeAuditionState();
    dom.persistentPlayerTitle.textContent = audition?.title || state.name;
    renderPlaybackPosition();
  }

  function renderPlaybackControls() {
    const audition = activeAuditionState();
    const projectActive = playing || playbackStarting;
    const persistentActive = activePlaybackPlaying() || activePlaybackStarting();
    const playerVisible = Boolean(audition) || playbackSessionVisible;
    dom.playButton.classList.toggle("is-playing", projectActive);
    dom.playButton.setAttribute("aria-pressed", String(projectActive));
    dom.playButton.setAttribute("aria-label", projectActive ? "Pause project" : "Play project");
    dom.persistentPlayButton.classList.toggle("is-playing", persistentActive);
    dom.persistentPlayButton.setAttribute("aria-pressed", String(persistentActive));
    dom.persistentPlayButton.setAttribute("aria-label", audition
      ? `${persistentActive ? "Pause" : "Play"} timing audition`
      : `${persistentActive ? "Pause" : "Play"} project`);
    dom.persistentPlayer.setAttribute("aria-label", audition ? "Timing audition player" : "Project player");
    dom.persistentSeekLabel.textContent = audition ? "Seek within timing audition" : "Seek within project";
    dom.persistentSeek.disabled = activePlaybackDuration() <= 0 || Boolean(audition && !audition.canSeek);
    dom.persistentPlayer.hidden = !playerVisible;
    document.body.classList.toggle("has-persistent-player", playerVisible);
    renderPlaybackMetadata();
  }

  function stopProgressTicker() {
    window.cancelAnimationFrame(playbackProgressFrame);
    playbackProgressFrame = 0;
  }

  function startProgressTicker() {
    stopProgressTicker();
    const tick = () => {
      if (!activePlaybackPlaying()) {
        playbackProgressFrame = 0;
        return;
      }
      renderPlaybackPosition();
      playbackProgressFrame = window.requestAnimationFrame(tick);
    };
    playbackProgressFrame = window.requestAnimationFrame(tick);
  }

  function handleAuditionState(snapshot) {
    const nextAudition = snapshot && typeof snapshot === "object" ? snapshot : null;
    if (
      playbackScrubbing
      && playbackScrubSource === "tempo-audition"
      && (!nextAudition?.engaged || nextAudition.key !== playbackScrubAuditionKey)
    ) {
      playbackScrubbing = false;
      resumeAfterSeek = false;
      playbackScrubPosition = 0;
      playbackScrubSource = "project";
      playbackScrubAuditionKey = "";
    }
    auditionPlayback = nextAudition;
    if (auditionPlayback?.engaged) {
      playbackSource = "tempo-audition";
      if (playing || playbackStarting) stopPlayback({ resetPosition: false });
    } else if (playbackSource === "tempo-audition") {
      playbackSource = "project";
    }

    if (playbackSource === "tempo-audition" && auditionPlayback?.playing) {
      if (!playbackProgressFrame) startProgressTicker();
    } else if (!playing) {
      stopProgressTicker();
    }

    const nextErrorKey = auditionPlayback?.error
      ? `${auditionPlayback.key || auditionPlayback.jobId}:${auditionPlayback.error}`
      : "";
    if (nextErrorKey && nextErrorKey !== auditionErrorKey) showToast(auditionPlayback.error);
    auditionErrorKey = nextErrorKey;
    renderPlaybackControls();
  }

  function playbackAudioFingerprint(project) {
    if (project.kind === "stem-import") {
      return JSON.stringify([
        project.id,
        project.kind,
        project.tempo,
        project.stemImport?.jobId,
        project.stemImport?.status,
        project.stemImport?.tracks,
        project.stemImport?.previewAssets,
        project.stemImport?.arrangement
      ]);
    }
    return JSON.stringify([
      project.id,
      project.audioSeed,
      project.tempo,
      project.key,
      project.swing,
      project.patterns,
      project.volumes,
      project.muted
    ]);
  }

  function capturePlaybackMutation() {
    const engaged = playbackSessionVisible && playbackProjectId === state.id;
    const duration = loopDuration();
    const wasPlaying = engaged && (playing || playbackStarting);
    const ratio = engaged && duration > 0 ? currentProjectPlaybackPosition() / duration : 0;
    const snapshot = { engaged, projectId: state.id, ratio, wasPlaying };
    if (wasPlaying) stopPlayback({ resetPosition: false });
    return snapshot;
  }

  function restorePlaybackMutation(snapshot) {
    if (!snapshot?.engaged) {
      renderPlaybackControls();
      return;
    }
    if (snapshot.projectId !== state.id) {
      resetPlaybackSession();
      return;
    }
    playbackSessionVisible = true;
    playbackProjectId = state.id;
    playbackOffset = snapshot.ratio * loopDuration();
    renderPlaybackControls();
    if (snapshot.wasPlaying) schedulePlaybackResume();
  }

  function schedulePlaybackResume() {
    const requestId = ++playbackResumeRequest;
    const projectId = state.id;
    window.setTimeout(() => {
      if (
        requestId === playbackResumeRequest &&
        !document.hidden &&
        playbackSessionVisible &&
        playbackProjectId === projectId &&
        state.id === projectId &&
        !playing &&
        !playbackStarting
      ) {
        startPlayback();
      }
    }, 24);
  }

  function resetPlaybackSession({ fade = true } = {}) {
    if (activeAuditionState()) stemImportController?.deactivateAudition?.({ resetPosition: false });
    playbackSource = "project";
    playbackSessionVisible = false;
    playbackProjectId = null;
    playbackScrubbing = false;
    resumeAfterSeek = false;
    playbackScrubPosition = 0;
    playbackScrubSource = "project";
    playbackScrubAuditionKey = "";
    stopPlayback({ fade, resetPosition: true });
  }

  async function ensureAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      showToast("Web Audio is not supported in this browser");
      return false;
    }
    try {
      window.clearTimeout(audioResetTimer);
      window.clearTimeout(audioSuspendTimer);
      audioResetTimer = 0;
      audioSuspendTimer = 0;
      if (!audioContext || audioContext.state === "closed") {
        const context = new AudioContext({ latencyHint: "interactive" });
        audioContext = context;
        const master = createMasterChain(audioContext, audioContext.destination);
        masterGain = master.input;
        masterLimiter = master.limiter;
        noiseBuffer = createNoiseBuffer(audioContext, state.audioSeed);
        noiseSeed = state.audioSeed;
        context.addEventListener("statechange", () => {
          if ((context.state === "closed" || context.state === "interrupted") && playing) {
            stopPlayback({ fade: false });
          }
        });
      }
      if (audioContext.state !== "running") await audioContext.resume();
      if (audioContext.state !== "running") throw new Error(`Audio context is ${audioContext.state}`);
      const now = audioContext.currentTime;
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(0.68, now);
      if (noiseSeed !== state.audioSeed) {
        noiseBuffer = createNoiseBuffer(audioContext, state.audioSeed);
        noiseSeed = state.audioSeed;
      }
      return true;
    } catch {
      stopPlayback({ fade: false });
      audioContext = null;
      masterGain = null;
      masterLimiter = null;
      noiseBuffer = null;
      noiseSeed = null;
      showToast("Audio could not start. Tap play again");
      return false;
    }
  }

  function createNoiseBuffer(context, seed) {
    const length = Math.floor(context.sampleRate * 0.4);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    const random = seededRandom(seed || 1);
    for (let index = 0; index < length; index += 1) data[index] = random() * 2 - 1;
    return buffer;
  }

  function liveAudioGraph() {
    return { context: audioContext, destination: masterGain, noiseBuffer, trackSources: true };
  }

  function trackAudioSource(graph, source, nodes = []) {
    if (!graph.trackSources) return;
    const voiceNodes = [source, ...nodes];
    activeVoices.set(source, voiceNodes);
    source.addEventListener("ended", () => {
      activeVoices.delete(source);
      voiceNodes.forEach((node) => {
        try { node.disconnect(); } catch { /* A browser may already have disconnected it. */ }
      });
    }, { once: true });
  }

  async function previewTrack(trackIndex, stepIndex) {
    if (!(await ensureAudio()) || state.muted[trackIndex]) return;
    scheduleVoice(liveAudioGraph(), state, trackIndex, audioContext.currentTime + 0.01, stepIndex);
  }

  async function startPlayback() {
    if (playing || playbackStarting) return;
    if (activeAuditionState()) stemImportController?.deactivateAudition?.({ resetPosition: false });
    const requestId = ++playbackStartRequest;
    playbackStarting = true;
    renderPlaybackControls();
    if (state.kind === "stem-import") {
      if (state.stemImport.status !== "ready") {
        playbackStarting = false;
        renderPlaybackControls();
        showToast("Aligned previews are still processing");
        return;
      }
      if (!currentUser) {
        playbackStarting = false;
        renderPlaybackControls();
        openAccountDialog("signin");
        showToast("Sign in to play private stem previews");
        return;
      }
      try {
        if (playbackProjectId !== state.id) playbackOffset = 0;
        playbackProjectId = state.id;
        playbackSessionVisible = true;
        stemPlayer.loadProject(state);
        await stemPlayer.play(playbackOffset);
        if (requestId !== playbackStartRequest) return;
        playbackStarting = false;
        playing = true;
        renderPlaybackControls();
        startProgressTicker();
      } catch (error) {
        if (requestId === playbackStartRequest) {
          playbackStarting = false;
          playing = false;
          renderPlaybackControls();
          showToast(error?.name === "NotAllowedError" ? "Tap play again to start audio" : "Private preview audio could not start");
        }
      }
      return;
    }
    const ready = await ensureAudio();
    if (!ready || !playbackStarting || requestId !== playbackStartRequest) {
      if (requestId === playbackStartRequest) playbackStarting = false;
      renderPlaybackControls();
      return;
    }
    if (playbackProjectId !== state.id) playbackOffset = 0;
    playbackProjectId = state.id;
    playbackSessionVisible = true;
    playbackStarting = false;
    playing = true;
    const duration = loopDuration();
    const baseDuration = duration / STEPS;
    playbackOffset = playbackOffset >= duration ? 0 : wrapPlaybackOffset(playbackOffset, duration);
    playbackAnchorTime = audioContext.currentTime + 0.06;
    const nextBoundary = Math.ceil(playbackOffset / baseDuration - 0.000001);
    currentStep = nextBoundary % STEPS;
    nextStepTime = playbackAnchorTime + Math.max(0, nextBoundary * baseDuration - playbackOffset);
    renderPlaybackControls();
    window.clearInterval(schedulerTimer);
    scheduleAhead();
    schedulerTimer = window.setInterval(scheduleAhead, 25);
    startProgressTicker();
  }

  function stopPlayback({ fade = true, resetPosition = false } = {}) {
    const stoppedAt = resetPosition ? 0 : currentProjectPlaybackPosition();
    playbackStartRequest += 1;
    playbackResumeRequest += 1;
    playbackStarting = false;
    playing = false;
    window.clearInterval(schedulerTimer);
    schedulerTimer = 0;
    stopProgressTicker();
    uiTimers.forEach(window.clearTimeout);
    uiTimers.clear();

    if (state.kind === "stem-import") {
      stemPlayer?.pause();
      if (resetPosition) stemPlayer?.seek(0, { resume: false }).catch(() => {});
      playbackOffset = stoppedAt;
      playbackAnchorTime = 0;
      renderPlaybackControls();
      return;
    }

    const context = audioContext;
    const now = context?.currentTime || 0;
    const fadeDuration = fade && context?.state === "running" ? 0.018 : 0;
    if (context && masterGain && fadeDuration) {
      masterGain.gain.cancelScheduledValues(now);
      masterGain.gain.setValueAtTime(Math.max(masterGain.gain.value, 0.001), now);
      masterGain.gain.exponentialRampToValueAtTime(0.001, now + fadeDuration);
    }

    activeVoices.forEach((_, source) => {
      try { source.stop(now + fadeDuration); } catch { /* Already ended. */ }
    });
    window.clearTimeout(audioResetTimer);
    window.clearTimeout(audioSuspendTimer);
    audioResetTimer = window.setTimeout(() => {
      if (masterGain && audioContext === context && context?.state === "running" && !playing) {
        masterGain.gain.value = 0.68;
      }
    }, Math.ceil(fadeDuration * 1000) + 8);
    audioSuspendTimer = window.setTimeout(() => {
      if (audioContext === context && context?.state === "running" && !playing && !playbackStarting) {
        context.suspend().catch(() => {});
      }
    }, 120);
    playbackOffset = stoppedAt;
    playbackAnchorTime = 0;
    renderPlaybackControls();
    document.querySelectorAll(".step.is-current").forEach((step) => step.classList.remove("is-current"));
  }

  function toggleProjectPlayback() {
    if (playing || playbackStarting) stopPlayback({ resetPosition: false });
    else startPlayback();
  }

  function togglePlayback() {
    if (activeAuditionState()) {
      stemImportController?.toggleAudition?.().catch((error) => {
        showToast(error?.name === "NotAllowedError" ? "Tap play again to start audio" : "Timing audition could not play");
      });
      return;
    }
    toggleProjectPlayback();
  }

  function previewPlaybackSeek() {
    if (!playbackScrubbing) {
      playbackScrubbing = true;
      playbackScrubSource = activeAuditionState() ? "tempo-audition" : "project";
      playbackScrubAuditionKey = playbackScrubSource === "tempo-audition"
        ? String(activeAuditionState()?.key || "")
        : "";
      resumeAfterSeek = activePlaybackPlaying() || activePlaybackStarting();
      if (resumeAfterSeek) {
        if (playbackScrubSource === "tempo-audition") stemImportController?.pauseAudition?.();
        else stopPlayback({ resetPosition: false });
      }
    }
    const ratio = Number(dom.persistentSeek.value) / 1000;
    playbackScrubPosition = clamp(ratio, 0, 1) * activePlaybackDuration();
    if (playbackScrubSource === "project") playbackOffset = playbackScrubPosition;
    renderPlaybackPosition(playbackScrubPosition, { forceSeek: true });
  }

  function commitPlaybackSeek() {
    if (!playbackScrubbing) return;
    const shouldResume = resumeAfterSeek;
    const source = playbackScrubSource;
    const position = playbackScrubPosition;
    playbackScrubbing = false;
    resumeAfterSeek = false;
    playbackScrubPosition = 0;
    playbackScrubSource = "project";
    playbackScrubAuditionKey = "";
    renderPlaybackPosition(position);
    if (source === "tempo-audition") {
      stemImportController?.seekAudition?.(position, { resume: shouldResume }).catch(() => {
        showToast("Could not seek the timing audition");
      });
      return;
    }
    if (state.kind === "stem-import") {
      stemPlayer?.seek(playbackOffset, { resume: shouldResume }).then(() => {
        playing = shouldResume;
        renderPlaybackControls();
      }).catch(() => showToast("Could not seek the private preview"));
    } else if (shouldResume) schedulePlaybackResume();
  }

  function changeTempo(amount) {
    if (state.kind === "stem-import") return;
    const playbackSnapshot = capturePlaybackMutation();
    state.tempo = clamp(state.tempo + amount, 56, 180);
    dom.tempoOutput.textContent = `${state.tempo} BPM`;
    queueSave();
    restorePlaybackMutation(playbackSnapshot);
  }

  function scheduleAhead() {
    if (!playing || !audioContext || audioContext.state !== "running") return;
    const baseDuration = 60 / state.tempo / 4;
    while (nextStepTime < audioContext.currentTime + 0.12) {
      const swingDelay = currentStep % 2 === 1 ? baseDuration * state.swing : 0;
      const scheduledTime = nextStepTime + swingDelay;
      TRACKS.forEach((_, trackIndex) => {
        if (state.patterns[trackIndex][currentStep] && !state.muted[trackIndex]) {
          scheduleVoice(liveAudioGraph(), state, trackIndex, scheduledTime, currentStep);
        }
      });
      schedulePlayhead(currentStep, scheduledTime);
      currentStep = (currentStep + 1) % STEPS;
      nextStepTime += baseDuration;
    }
  }

  function schedulePlayhead(stepIndex, time) {
    const delay = Math.max(0, (time - audioContext.currentTime) * 1000);
    const timer = window.setTimeout(() => {
      uiTimers.delete(timer);
      document.querySelectorAll(".step.is-current").forEach((step) => step.classList.remove("is-current"));
      document.querySelectorAll(`[data-step="${stepIndex}"]`).forEach((step) => step.classList.add("is-current"));
    }, delay);
    uiTimers.add(timer);
  }

  function scheduleVoice(graph, project, trackIndex, time, stepIndex) {
    const level = project.volumes[trackIndex];
    if (level <= 0 || !graph.context) return;
    const kind = TRACKS[trackIndex].kind;
    if (kind === "kick") scheduleKick(graph, time, level);
    if (kind === "snare") scheduleSnare(graph, time, level);
    if (kind === "bass") scheduleBass(graph, project, time, level, stepIndex);
    if (kind === "chords") scheduleChord(graph, project, time, level, stepIndex);
  }

  function outputGain(graph) {
    const gain = graph.context.createGain();
    gain.connect(graph.destination);
    return gain;
  }

  function scheduleKick(graph, time, level) {
    const oscillator = graph.context.createOscillator();
    const gain = outputGain(graph);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(130, time);
    oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.13);
    gain.gain.setValueAtTime(Math.max(level * 0.9, 0.001), time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    oscillator.connect(gain);
    trackAudioSource(graph, oscillator, [gain]);
    oscillator.start(time);
    oscillator.stop(time + 0.32);
  }

  function scheduleSnare(graph, time, level) {
    const noise = graph.context.createBufferSource();
    const filter = graph.context.createBiquadFilter();
    const gain = outputGain(graph);
    noise.buffer = graph.noiseBuffer;
    filter.type = "highpass";
    filter.frequency.value = 1100;
    gain.gain.setValueAtTime(Math.max(level * 0.38, 0.001), time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    noise.connect(filter).connect(gain);
    trackAudioSource(graph, noise, [filter, gain]);
    noise.start(time);
    noise.stop(time + 0.18);

    const tone = graph.context.createOscillator();
    const toneGain = outputGain(graph);
    tone.type = "triangle";
    tone.frequency.value = 180;
    toneGain.gain.setValueAtTime(Math.max(level * 0.16, 0.001), time);
    toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    tone.connect(toneGain);
    trackAudioSource(graph, tone, [toneGain]);
    tone.start(time);
    tone.stop(time + 0.11);
  }

  function rootFrequency(project) {
    return { C: 65.41, D: 73.42, E: 82.41, F: 87.31, G: 98.0, A: 110.0 }[project.key[0]] || 65.41;
  }

  function scheduleBass(graph, project, time, level, stepIndex) {
    const oscillator = graph.context.createOscillator();
    const filter = graph.context.createBiquadFilter();
    const gain = outputGain(graph);
    const intervals = [1, 1, 1.189, 1.335, 1.498];
    oscillator.type = "sawtooth";
    oscillator.frequency.value = rootFrequency(project) * intervals[Math.floor(stepIndex / 4) % intervals.length];
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(520, time);
    filter.Q.value = 2.1;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(level * 0.34, 0.001), time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
    oscillator.connect(filter).connect(gain);
    trackAudioSource(graph, oscillator, [filter, gain]);
    oscillator.start(time);
    oscillator.stop(time + 0.26);
  }

  function scheduleChord(graph, project, time, level, stepIndex) {
    const root = rootFrequency(project) * 2 * (stepIndex >= 8 ? 1.335 : 1);
    const intervals = [1, Math.pow(2, 3 / 12), Math.pow(2, 7 / 12)];
    intervals.forEach((interval, index) => {
      const oscillator = graph.context.createOscillator();
      const filter = graph.context.createBiquadFilter();
      const gain = outputGain(graph);
      oscillator.type = index === 0 ? "triangle" : "sine";
      oscillator.frequency.value = root * interval;
      oscillator.detune.value = index * 3 - 3;
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.exponentialRampToValueAtTime(Math.max(level * 0.08, 0.001), time + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.48);
      oscillator.connect(filter).connect(gain);
      trackAudioSource(graph, oscillator, [filter, gain]);
      oscillator.start(time);
      oscillator.stop(time + 0.5);
    });
  }

  async function renderProjectAudio(project, bars = 4) {
    const OfflineAudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineAudioContext) throw new Error("Offline audio rendering is not supported");
    const sampleRate = 44100;
    const stepDuration = 60 / project.tempo / 4;
    const loopFrames = Math.round(stepDuration * STEPS * sampleRate);
    const loopDuration = loopFrames / sampleRate;
    const renderedBars = bars + 1;
    const context = new OfflineAudioContext(2, loopFrames * renderedBars, sampleRate);
    const master = createMasterChain(context, context.destination);
    const graph = {
      context,
      destination: master.input,
      noiseBuffer: createNoiseBuffer(context, project.audioSeed),
      trackSources: false
    };

    for (let bar = 0; bar < renderedBars; bar += 1) {
      for (let stepIndex = 0; stepIndex < STEPS; stepIndex += 1) {
        const swingDelay = stepIndex % 2 === 1 ? stepDuration * project.swing : 0;
        const time = bar * loopDuration + stepIndex * stepDuration + swingDelay;
        TRACKS.forEach((_, trackIndex) => {
          if (project.patterns[trackIndex][stepIndex] && !project.muted[trackIndex]) {
            scheduleVoice(graph, project, trackIndex, time, stepIndex);
          }
        });
      }
    }

    const frameCount = loopFrames * bars;
    const buffer = context.createBuffer(2, frameCount, sampleRate);
    const renderedBuffer = await context.startRendering();
    for (let channel = 0; channel < renderedBuffer.numberOfChannels; channel += 1) {
      const source = renderedBuffer.getChannelData(channel).subarray(loopFrames, loopFrames + frameCount);
      buffer.getChannelData(channel).set(source);
    }
    let peak = 0;
    let sumSquares = 0;
    let samples = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const values = buffer.getChannelData(channel);
      for (let index = 0; index < values.length; index += 1) {
        const value = values[index];
        if (!Number.isFinite(value)) throw new Error("Audio rendering produced an invalid sample");
        peak = Math.max(peak, Math.abs(value));
        sumSquares += value * value;
      }
      samples += values.length;
    }
    const rms = Math.sqrt(sumSquares / Math.max(samples, 1));
    if (peak < 0.0001 || rms < 0.00001) throw new Error("Audio rendering was silent");
    return { buffer, peak, rms, duration: frameCount / sampleRate };
  }

  function audioBufferToWav(buffer, scale = 1) {
    const channels = buffer.numberOfChannels;
    const frameCount = buffer.length;
    const bytesPerSample = 2;
    const dataSize = frameCount * channels * bytesPerSample;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeText = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
    view.setUint16(32, channels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    const channelData = Array.from({ length: channels }, (_, index) => buffer.getChannelData(index));
    let offset = 44;
    let fullScaleSamples = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const scaled = channelData[channel][frame] * scale;
        if (Math.abs(scaled) >= 1) fullScaleSamples += 1;
        const sample = clamp(scaled, -0.98, 0.98);
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
      }
    }
    return {
      blob: new Blob([arrayBuffer], { type: "audio/wav" }),
      fullScaleSamples
    };
  }

  function clearPendingAudioExport() {
    if (pendingAudioExport?.url) URL.revokeObjectURL(pendingAudioExport.url);
    pendingAudioExport = null;
    dom.exportReady.hidden = true;
    dom.downloadAudioLink.removeAttribute("href");
    dom.downloadAudioLink.removeAttribute("download");
  }

  function canShareAudio(file) {
    if (!file || typeof navigator.share !== "function" || typeof navigator.canShare !== "function") return false;
    try {
      return navigator.canShare({ files: [file] });
    } catch {
      return false;
    }
  }

  function sharePreparedAudio() {
    const prepared = pendingAudioExport;
    if (!prepared?.file || !canShareAudio(prepared.file)) {
      showToast("Use Save WAV below to keep the audio file");
      return;
    }
    try {
      const result = navigator.share({
        files: [prepared.file],
        title: prepared.file.name,
        text: "Made with Opusloops"
      });
      Promise.resolve(result)
        .then(() => showToast("WAV shared"))
        .catch((error) => {
          if (error?.name !== "AbortError") showToast("Sharing was unavailable — use Save WAV instead");
        });
    } catch (error) {
      if (error?.name !== "AbortError") showToast("Sharing was unavailable — use Save WAV instead");
    }
  }

  async function exportAudio() {
    const snapshot = clone(state);
    const originalLabel = dom.exportAudioButton.querySelector("span").textContent;
    dom.exportAudioButton.disabled = true;
    dom.exportAudioButton.querySelector("span").textContent = "Rendering audio…";
    try {
      const rendered = await renderProjectAudio(snapshot, 4);
      const scale = Math.min(1, 0.98 / rendered.peak);
      const encoded = audioBufferToWav(rendered.buffer, scale);
      if (encoded.fullScaleSamples) throw new Error("Audio encoding would clip");
      const blob = encoded.blob;
      const fileName = `${cleanName(snapshot.name).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "opusloop"}.wav`;
      const file = typeof File === "function" ? new File([blob], fileName, { type: "audio/wav" }) : null;
      const url = URL.createObjectURL(blob);
      clearPendingAudioExport();
      pendingAudioExport = { file, url, fileName };
      dom.downloadAudioLink.href = url;
      dom.downloadAudioLink.download = fileName;
      dom.shareAudioButton.hidden = !canShareAudio(file);
      dom.exportReadyCopy.textContent = `${fileName} · ${rendered.duration.toFixed(2)} seconds`;
      dom.exportReady.hidden = false;
      dom.exportAudioButton.dataset.lastExportBytes = String(blob.size);
      dom.exportAudioButton.dataset.lastExportPeak = (rendered.peak * scale).toFixed(6);
      dom.exportAudioButton.dataset.lastExportRms = (rendered.rms * scale).toFixed(6);
      dom.exportAudioButton.dataset.lastExportDuration = rendered.duration.toFixed(6);
      dom.exportAudioButton.dataset.lastExportFullScaleSamples = String(encoded.fullScaleSamples);
      document.dispatchEvent(new CustomEvent("opusloops:audio-exported", {
        detail: {
          bytes: blob.size,
          duration: rendered.duration,
          peak: rendered.peak * scale,
          rms: rendered.rms * scale,
          fullScaleSamples: encoded.fullScaleSamples,
          fileName
        }
      }));
      showToast("Four-bar WAV ready to share or save");
    } catch {
      showToast("Audio export is not available in this browser");
    } finally {
      dom.exportAudioButton.disabled = false;
      dom.exportAudioButton.querySelector("span").textContent = originalLabel;
    }
  }

  function applyRefinement(instruction) {
    const text = instruction.toLowerCase();
    const random = seededRandom(hashText(`${state.id}-${instruction}-${Date.now()}`));
    if (/sparse|less|minimal|space/.test(text)) {
      state.patterns = state.patterns.map((pattern, trackIndex) =>
        pattern.map((active, stepIndex) => (active && stepIndex !== 0 && random() < 0.42 + trackIndex * 0.05 ? 0 : active))
      );
    } else if (/busy|busier|more|energy|driv/.test(text)) {
      state.patterns = state.patterns.map((pattern, trackIndex) =>
        pattern.map((active, stepIndex) => active || (random() < 0.16 + trackIndex * 0.025 && stepIndex % 2 === 0) ? 1 : 0)
      );
      state.tempo = clamp(state.tempo + 6, 56, 180);
    } else if (/warm|soft|mellow/.test(text)) {
      state.tempo = clamp(state.tempo - 4, 56, 180);
      state.volumes = state.volumes.map((value, index) => clamp(value - (index === 1 ? 0.12 : 0.03), 0, 1));
      state.swing = clamp(state.swing + 0.04, 0, 0.28);
    } else {
      composeFromPrompt(`${state.prompt || state.name} ${instruction || "surprising variation"}`);
      return;
    }
    renderAll();
    persist();
  }

  if (window.OpusloopsStemPlayer && stemCore) {
    stemPlayer = window.OpusloopsStemPlayer.create({
      cloud,
      onState(snapshot) {
        if (state.kind !== "stem-import") return;
        playbackOffset = snapshot.position;
        playing = Boolean(snapshot.playing);
        playbackStarting = Boolean(snapshot.loading);
        if (snapshot.ended) playbackOffset = snapshot.duration;
        renderPlaybackControls();
        if (snapshot.error) showToast("Private preview playback stopped");
      }
    });
  }

  if (window.OpusloopsStemImport && stemCore) {
    stemImportController = window.OpusloopsStemImport.create({
      cloud,
      getUser: () => currentUser,
      makeId,
      openSignIn: () => openAccountDialog("signin"),
      showView,
      findProject: findProjectById,
      saveProject: saveStemProject,
      prepareProject: prepareStemProject,
      discardProject: discardPreparedStemProject,
      showToast,
      onAuditionState: handleAuditionState
    });
  }

  dom.mixer.addEventListener("click", (event) => {
    const tile = event.target.closest(".mixer-tile");
    if (!tile) return;
    if (event.target.closest(".mute-button")) return;
    if (
      event.target.closest("[data-mixer-gesture]")
      && suppressedMixerClick.key === tile.dataset.mixerKey
      && performance.now() < suppressedMixerClick.until
    ) {
      event.preventDefault();
      return;
    }
    activateMixerTile(tile);
  });
  dom.mixer.addEventListener("focusin", (event) => {
    const tile = event.target.closest(".mixer-tile");
    if (tile) activateMixerTile(tile, { focus: false });
  });
  dom.mixer.addEventListener("pointerdown", beginMixerDrag);
  window.addEventListener("pointermove", moveMixerDrag, { passive: false });
  window.addEventListener("pointerup", finishMixerDrag);
  window.addEventListener("pointercancel", finishMixerDrag);
  window.addEventListener("blur", () => finishMixerDrag());
  window.addEventListener("pagehide", () => finishMixerDrag());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) finishMixerDrag();
  });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.viewTarget) showView(target.dataset.viewTarget);

    if (target.dataset.prompt) {
      dom.ideaInput.value = target.dataset.prompt;
      dom.ideaInput.focus();
    }

    if (target.dataset.track !== undefined && target.dataset.step !== undefined) {
      toggleStep(Number(target.dataset.track), Number(target.dataset.step));
    }

    if (target.dataset.muteTrack !== undefined) toggleMute(Number(target.dataset.muteTrack));

    if (target.dataset.muteStem) toggleStemMute(target.dataset.muteStem);

    if (target.dataset.toggleStemSegment) toggleStemSegment(target.dataset.toggleStemSegment);

    if (target.dataset.loadProject) {
      const project = readProjects().find((item) => item.id === target.dataset.loadProject);
      if (project) {
        resetPlaybackSession();
        state = normalizeProject(project);
        writeCurrent(state);
        renderAll();
        if (state.kind === "stem-import") stemImportController?.resumeProject(state);
        else stemImportController?.stop({ preserveJob: false });
        showView(state.kind === "stem-import" && state.stemImport.status !== "ready" ? "import" : "studio");
        showToast("Project opened");
      }
    }

    if (target.dataset.deleteProject) {
      const projects = readProjects();
      const project = projects.find((item) => item.id === target.dataset.deleteProject);
      const locationLabel = currentUser ? "your account and this device" : "this device";
      if (project && window.confirm(`Delete “${project.name}” from ${locationLabel}?`)) {
        if (project.kind === "stem-import" && currentUser && project.stemImport?.jobId) {
          cloud?.cancelStemImport(project.stemImport.jobId, project.stemImport.revision).catch(() => {
            showToast("Project removed here; server cleanup will retry later");
          });
        }
        const deletedAt = nextTimestamp(project.updatedAt);
        const remaining = projects.filter((item) => item.id !== project.id);
        writeProjects(remaining);
        if (currentUser) {
          const deletions = readDeletions();
          deletions[project.id] = deletedAt;
          writeDeletions(deletions);
        }
        if (state.id === project.id) {
          resetPlaybackSession();
          state = remaining[0] || makeProject();
          writeCurrent(state);
          renderAll();
          if (state.kind === "stem-import") stemImportController?.resumeProject(state);
          else stemImportController?.stop({ preserveJob: false });
        } else {
          renderProjects();
        }
        if (currentUser) queueCloudSync();
        renderAuth();
        showToast("Project deleted");
      }
    }

    if (target.dataset.refine) {
      dom.refineInput.value = target.dataset.refine;
      dom.refineInput.focus();
    }
  });

  document.addEventListener("input", (event) => {
    const stemSlider = event.target.closest("[data-volume-stem]");
    if (stemSlider) {
      const track = stemTrack(stemSlider.dataset.volumeStem);
      if (!track) return;
      track.volume = Number(stemSlider.value) / 100;
      setMixerTilePresentation(stemSlider.closest(".mixer-tile"), stemSlider.value, track.muted);
      stemPlayer?.setMix(track.assetId, track.volume, track.muted);
      queueSave();
      return;
    }
    const slider = event.target.closest("[data-volume-track]");
    if (!slider) return;
    const trackIndex = Number(slider.dataset.volumeTrack);
    state.volumes[trackIndex] = Number(slider.value) / 100;
    setMixerTilePresentation(slider.closest(".mixer-tile"), slider.value, state.muted[trackIndex]);
    queueSave();
  });

  dom.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = dom.ideaInput.value.trim();
    if (!prompt) return;
    resetPlaybackSession();
    stemImportController?.stop({ preserveJob: false });
    composeFromPrompt(prompt);
    showView("studio");
    showToast("Your loop is ready to play");
  });

  dom.playButton.addEventListener("click", toggleProjectPlayback);
  dom.persistentPlayButton.addEventListener("click", togglePlayback);
  dom.persistentSeek.addEventListener("input", previewPlaybackSeek);
  dom.persistentSeek.addEventListener("change", commitPlaybackSeek);
  dom.persistentSeek.addEventListener("blur", commitPlaybackSeek);
  dom.exportAudioButton.addEventListener("click", exportAudio);
  dom.shareAudioButton.addEventListener("click", sharePreparedAudio);
  dom.downloadAudioLink.addEventListener("click", () => showToast("Saving WAV"));

  document.querySelector("#tempo-down").addEventListener("click", () => {
    changeTempo(-2);
  });

  document.querySelector("#tempo-up").addEventListener("click", () => {
    changeTempo(2);
  });

  dom.keyButton.addEventListener("click", () => {
    if (state.kind === "stem-import") return;
    const playbackSnapshot = capturePlaybackMutation();
    state.key = KEYS[(KEYS.indexOf(state.key) + 1) % KEYS.length];
    dom.keyButton.textContent = state.key;
    queueSave();
    restorePlaybackMutation(playbackSnapshot);
  });

  dom.studioTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.studioTitle.blur();
    }
  });

  dom.studioTitle.addEventListener("input", () => {
    state.name = cleanName(dom.studioTitle.textContent) || "Untitled loop";
    renderPlaybackMetadata();
    queueSave();
  });

  dom.studioTitle.addEventListener("blur", () => {
    state.name = cleanName(dom.studioTitle.textContent) || "Untitled loop";
    dom.studioTitle.textContent = state.name;
    renderPlaybackMetadata();
    queueSave();
  });

  document.querySelector("#save-project-button").addEventListener("click", () => persist({ announce: true }));

  document.querySelector("#reset-mix").addEventListener("click", () => {
    if (state.kind === "stem-import") {
      state.stemImport.tracks.forEach((track) => {
        track.volume = 1;
        track.muted = false;
        stemPlayer?.setMix(track.assetId, 1, false);
      });
      renderMixer();
      renderStemArrangement();
      queueSave();
      showToast("Stem mix reset");
      return;
    }
    state.volumes = [0.88, 0.68, 0.6, 0.48];
    state.muted = [false, false, false, false];
    renderMixer();
    renderSequencer();
    queueSave();
    showToast("Mix reset");
  });

  document.querySelector("#new-project-button").addEventListener("click", () => {
    resetPlaybackSession();
    stemImportController?.stop({ preserveJob: false });
    state = makeProject();
    renderAll();
    persist();
    showView("create");
    dom.ideaInput.value = "";
    dom.ideaInput.focus();
  });

  document.querySelector("#refine-button").addEventListener("click", () => {
    if (state.kind === "stem-import") return;
    dom.refineInput.value = "";
    if (typeof dom.refineDialog.showModal === "function") dom.refineDialog.showModal();
    else dom.refineDialog.setAttribute("open", "");
  });

  document.querySelector("#review-stem-analysis").addEventListener("click", () => {
    if (state.kind !== "stem-import") return;
    stemImportController?.resumeProject(state);
    showView("import");
  });

  document.querySelector("#refine-close-button").addEventListener("click", () => {
    dom.refineDialog.close?.();
    dom.refineDialog.removeAttribute("open");
  });

  dom.refineForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const instruction = dom.refineInput.value.trim() || "surprise me";
    const playbackSnapshot = capturePlaybackMutation();
    applyRefinement(instruction);
    restorePlaybackMutation(playbackSnapshot);
    dom.refineDialog.close?.();
    dom.refineDialog.removeAttribute("open");
    showToast("Loop refined");
  });

  document.querySelector("#account-close-button").addEventListener("click", closeAccountDialog);
  dom.accountSwitch.addEventListener("click", () => setAuthMode(authMode === "signin" ? "signup" : "signin"));

  dom.accountCardButton.addEventListener("click", () => {
    if (dom.accountCardButton.dataset.action === "import") importGuestProjects();
    else openAccountDialog("signin");
  });

  dom.accountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.accountError.hidden = true;
    if (!cloud?.configured()) {
      dom.accountError.textContent = "Cloud sync is not configured.";
      dom.accountError.hidden = false;
      return;
    }
    const email = dom.accountEmail.value.trim();
    const password = dom.accountPassword.value;
    const inviteCode = dom.accountInvite.value.trim();
    if (!email || password.length < 8 || (authMode === "signup" && !/^[A-Za-z0-9_-]{22,64}$/.test(inviteCode))) return;
    dom.accountSubmit.disabled = true;
    dom.accountSwitch.disabled = true;
    dom.accountSubmit.textContent = authMode === "signup" ? "Creating…" : "Signing in…";
    try {
      flushSave();
      const result = authMode === "signup"
        ? await cloud.signUp(email, password, inviteCode)
        : { session: await cloud.signIn(email, password) };
      if (!result.session) {
        dom.accountError.textContent = "Check your email to finish creating the account.";
        dom.accountError.hidden = false;
        return;
      }
      if (result.session.user?.id !== currentUser?.id) switchUser(result.session.user);
      else syncCloud();
      closeAccountDialog();
      dom.accountPassword.value = "";
      dom.accountInvite.value = "";
      showToast(authMode === "signup" ? "Account created — cloud sync is on" : "Signed in — syncing your loops");
    } catch (error) {
      dom.accountError.textContent = friendlyCloudError(error);
      dom.accountError.hidden = false;
    } finally {
      dom.accountSubmit.disabled = false;
      dom.accountSwitch.disabled = false;
      if (!currentUser) setAuthMode(authMode);
    }
  });

  document.querySelector("#sync-now-button").addEventListener("click", async () => {
    await syncCloud({ announce: true });
  });

  document.querySelector("#sign-out-button").addEventListener("click", async () => {
    flushSave();
    if (navigator.onLine) {
      const synced = await drainCloudSync();
      if (!synced && currentUser && !window.confirm(
        "Cloud sync has not finished. Sign out anyway? Unsynced loops will remain on this device."
      )) {
        showToast("Sync is still pending. You are still signed in");
        return;
      }
    } else if (!window.confirm("You have offline changes on this device. Sign out before they sync?")) {
      return;
    }
    await cloud?.signOut();
    if (!cloud?.getSession() && currentUser) switchUser(null);
    closeAccountDialog();
    showToast("Signed out. Account projects are hidden on this device");
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    dom.installCard.hidden = false;
  });

  dom.installButton.addEventListener("click", async () => {
    if (installPrompt) {
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
    } else {
      showToast("Use your browser menu, then Add to Home Screen");
    }
  });

  window.addEventListener("appinstalled", () => {
    dom.installCard.hidden = true;
    showToast("Opusloops installed");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      playbackResumeRequest += 1;
      resumeAfterSeek = false;
      playbackScrubbing = false;
      playbackScrubPosition = 0;
      playbackScrubSource = "project";
      playbackScrubAuditionKey = "";
      if (activeAuditionState() && (activePlaybackPlaying() || activePlaybackStarting())) {
        stemImportController?.pauseAudition?.();
      } else if (playing || playbackStarting) stopPlayback();
      else renderPlaybackControls();
      flushSave();
    }
  });

  window.addEventListener("pagehide", () => {
    stemImportController?.deactivateAudition?.({ resetPosition: false });
    flushSave();
    clearPendingAudioExport();
    if (audioContext?.state === "running") audioContext.suspend().catch(() => {});
  });
  window.addEventListener("online", () => {
    if (currentUser) {
      syncCloud();
      if (state.kind === "stem-import") stemImportController?.resumeProject(state);
    }
  });
  window.addEventListener("offline", () => {
    if (currentUser) setSaveStatus("Offline — sync pending");
  });
  window.addEventListener("opusloops:auth-session-change", (event) => {
    const nextUser = event.detail?.user || null;
    if ((nextUser?.id || null) !== (currentUser?.id || null)) switchUser(nextUser);
  });

  if (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone) {
    dom.installCard.hidden = true;
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {
        // The app remains fully usable online if service-worker registration is blocked.
      });
    });
  }

  renderAll();
  renderAuth();
  if (!hasSavedState) persist({ touch: false, sync: false });
  else setSaveStatus(currentUser ? "Syncing…" : "Saved on device");
  if (storageReadWarning) showToast(storageReadWarning);
  showView("create", { focus: false });
  if (currentUser && state.kind === "stem-import") stemImportController?.resumeProject(state);

  if (cloud?.configured()) {
    cloud.restoreSession().then((session) => {
      const restoredUser = session?.user || null;
      if (restoredUser?.id !== currentUser?.id) switchUser(restoredUser);
      else if (restoredUser) {
        syncCloud();
        if (state.kind === "stem-import") stemImportController?.resumeProject(state);
      }
      else if (currentUser) switchUser(null);
    });
  }
})();
