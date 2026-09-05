(() => {
  "use strict";

  const STORAGE_CURRENT = "opusloops.mobile.current.v1";
  const STORAGE_PROJECTS = "opusloops.mobile.projects.v1";
  const STORAGE_RECOVERY = "opusloops.mobile.recovery.v1";
  const STORAGE_DELETIONS = "opusloops.mobile.deletions.v1";
  const PROJECT_SCHEMA_VERSION = 2;
  const AUDIO_ENGINE_VERSION = 1;
  const CLOUD_SAVE_DELAY = 650;
  const FUTURE_TIMESTAMP_WINDOW = 23 * 60 * 60 * 1000;
  const STEPS = 16;
  const TRACKS = [
    { id: "kick", name: "Kick", kind: "kick", color: "#ff6b9d" },
    { id: "snare", name: "Snare", kind: "snare", color: "#ffad42" },
    { id: "bass", name: "Bass", kind: "bass", color: "#20c7ef" },
    { id: "chords", name: "Chords", kind: "chords", color: "#3b82f6" }
  ];
  const KEYS = ["C minor", "D minor", "E minor", "F minor", "G minor", "A minor"];

  const defaultPatterns = () => [
    [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]
  ];

  const makeProject = () => ({
    schemaVersion: PROJECT_SCHEMA_VERSION,
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
    updatedAt: new Date().toISOString()
  });

  const cloud = window.OpusloopsCloud || null;
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
    persistentCurrentTime: document.querySelector("#persistent-current-time"),
    persistentDuration: document.querySelector("#persistent-duration"),
    keyButton: document.querySelector("#key-button"),
    sequencer: document.querySelector("#sequencer"),
    mixer: document.querySelector("#mixer"),
    projectsList: document.querySelector("#projects-list"),
    saveStatusButton: document.querySelector("#save-status"),
    saveStatus: document.querySelector("#save-status span:last-child"),
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
    accountButton: document.querySelector("#account-button"),
    accountInitial: document.querySelector("#account-initial"),
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
    accountCardEyebrow: document.querySelector("#account-card-eyebrow"),
    accountCardTitle: document.querySelector("#account-card-title"),
    accountCardCopy: document.querySelector("#account-card-copy"),
    accountCardButton: document.querySelector("#account-card-button"),
    projectsEyebrow: document.querySelector("#projects-eyebrow"),
    projectsLede: document.querySelector("#projects-lede")
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

  function normalizeProject(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const base = makeProject();
    const patterns = Array.isArray(candidate.patterns) ? candidate.patterns : base.patterns;
    const rawId = String(candidate.id || "");
    const candidateId = isUuid(rawId) ? rawId : rawId ? legacyProjectId(rawId) : base.id;
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      audioEngineVersion: AUDIO_ENGINE_VERSION,
      audioSeed: Number.isFinite(Number(candidate.audioSeed)) ? Number(candidate.audioSeed) >>> 0 : hashText(candidateId),
      id: candidateId,
      name: cleanName(candidate.name) || base.name,
      prompt: String(candidate.prompt || "").replace(/\s+/g, " ").trim().slice(0, 180),
      tempo: clamp(Number(candidate.tempo) || base.tempo, 56, 180),
      key: KEYS.includes(candidate.key) ? candidate.key : base.key,
      swing: clamp(Number(candidate.swing) || 0, 0, 0.28),
      patterns: TRACKS.map((_, trackIndex) =>
        Array.from({ length: STEPS }, (_, stepIndex) =>
          patterns[trackIndex]?.[stepIndex] ? 1 : 0
        )
      ),
      volumes: TRACKS.map((_, index) => clamp(Number(candidate.volumes?.[index] ?? base.volumes[index]), 0, 1)),
      muted: TRACKS.map((_, index) => Boolean(candidate.muted?.[index])),
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
    return writeJson(scopedStorageKey(STORAGE_CURRENT), project);
  }

  function writeProjects(projects) {
    return writeJson(scopedStorageKey(STORAGE_PROJECTS), projects);
  }

  function writeDeletions(deletions) {
    return writeJson(scopedStorageKey(STORAGE_DELETIONS), deletions);
  }

  function localSyncSnapshot() {
    return JSON.stringify({ projects: readProjects(), deletions: readDeletions() });
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
      setSaveStatus(currentUser ? "Saved on device" : "Saved on device", currentUser ? "syncing" : "local");
      renderRecent();
      renderProjects();
      if (sync && currentUser) queueCloudSync();
      if (announce) showToast(currentUser ? "Saved — syncing privately" : "Saved on this device");
    }
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

  function setSaveStatus(label, status = "local") {
    if (dom.saveStatus) dom.saveStatus.textContent = label;
    if (dom.saveStatusButton) {
      dom.saveStatusButton.dataset.state = status;
      dom.saveStatusButton.setAttribute("aria-label", `Open saved projects. ${label}`);
    }
    if (dom.saveAnnouncer && dom.saveAnnouncer.textContent !== label) dom.saveAnnouncer.textContent = label;
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    toastTimer = window.setTimeout(() => dom.toast.classList.remove("is-visible"), 2200);
  }

  function showView(name, { focus = true } = {}) {
    document.querySelectorAll("[data-view]").forEach((view) => {
      view.classList.toggle("is-active", view.dataset.view === name);
    });
    document.querySelectorAll(".nav-item").forEach((item) => {
      const active = item.dataset.viewTarget === name;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    if (focus) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      document.querySelector(`#view-${name}`)?.focus({ preventScroll: true });
    }
    if (name === "projects") renderProjects();
  }

  function projectTimestamp(project) {
    const timestamp = Date.parse(project?.updatedAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function projectDocument(project) {
    const normalized = normalizeProject(project);
    if (!normalized) return null;
    return {
      schemaVersion: normalized.schemaVersion,
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
      setSaveStatus("Offline — sync pending", "offline");
      return;
    }
    setSaveStatus("Syncing…", "syncing");
    cloudTimer = window.setTimeout(() => {
      cloudTimer = 0;
      syncCloud();
    }, CLOUD_SAVE_DELAY);
  }

  async function syncCloud({ announce = false } = {}) {
    if (!currentUser || !cloud?.configured()) return false;
    if (!navigator.onLine) {
      setSaveStatus("Offline — sync pending", "offline");
      if (announce) showToast("Offline — your changes will sync later");
      return false;
    }
    if (cloudSyncPromise) {
      cloudSyncQueued = true;
      return cloudSyncPromise;
    }

    const syncUserId = currentUser.id;
    setSaveStatus("Syncing…", "syncing");
    cloudSyncPromise = (async () => {
      flushSave();
      const localProjects = readProjects();
      const deletions = readDeletions();
      const localSnapshot = JSON.stringify({ projects: localProjects, deletions });
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
        setSaveStatus("Saved — sync pending", "syncing");
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
      const audioChanged = playbackAudioFingerprint(nextState) !== playbackAudioFingerprint(state);
      const playbackSnapshot = audioChanged ? capturePlaybackMutation() : null;
      state = nextState;
      writeCurrent(state);
      renderAll();
      if (playbackSnapshot) restorePlaybackMutation(playbackSnapshot);
      setSaveStatus("Saved to account", "synced");
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
        setSaveStatus("Saved — sync pending", "error");
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
    const playbackSnapshot = capturePlaybackMutation();
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
    renderAuth();
    queueCloudSync();
    showToast(`${guests.length} device ${guests.length === 1 ? "loop" : "loops"} moved to your account`);
  }

  function switchUser(user) {
    flushSave();
    resetPlaybackSession();
    window.clearTimeout(cloudTimer);
    cloudTimer = 0;
    currentUser = user?.id ? { id: String(user.id), email: String(user.email || "") } : null;
    const stored = readCurrent();
    state = stored || makeProject();
    hasSavedState = Boolean(stored);
    renderAll();
    renderAuth();
    if (currentUser) syncCloud();
    else setSaveStatus("Saved on device", "local");
  }

  function renderAuth() {
    const signedIn = Boolean(currentUser);
    dom.accountForm.hidden = signedIn;
    dom.signedInPanel.hidden = !signedIn;
    dom.accountButton.classList.toggle("is-signed-in", signedIn);
    dom.accountInitial.hidden = !signedIn;
    const initial = (currentUser?.email || "O").trim().charAt(0).toUpperCase() || "O";
    dom.accountInitial.textContent = initial;
    dom.accountButton.setAttribute("aria-label", signedIn ? `Account: ${currentUser.email}` : "Sign in to Opusloops");
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
    dom.studioTitle.textContent = state.name;
    dom.tempoOutput.textContent = `${state.tempo} BPM`;
    dom.keyButton.textContent = state.key;
    renderSequencer();
    renderMixer();
    renderRecent();
    renderProjects();
    renderPlaybackMetadata();
  }

  function renderRecent() {
    dom.recentName.textContent = state.name;
    dom.recentMeta.textContent = `${state.tempo} BPM · ${state.key}`;
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

  function renderMixer() {
    dom.mixer.replaceChildren();
    TRACKS.forEach((track, index) => {
      const channel = document.createElement("section");
      channel.className = "mixer-channel";
      channel.style.setProperty("--track-color", track.color);
      channel.innerHTML = `
        <div class="mixer-label">
          <strong>${track.name}</strong>
          <span>${Math.round(state.volumes[index] * 100)}%</span>
        </div>
        <label class="sr-only" for="volume-${track.id}">${track.name} volume</label>
        <input id="volume-${track.id}" type="range" min="0" max="100" value="${Math.round(state.volumes[index] * 100)}" data-volume-track="${index}" />
        <button class="mute-button" type="button" data-mute-track="${index}" aria-label="${state.muted[index] ? "Unmute" : "Mute"} ${track.name}" aria-pressed="${state.muted[index]}">M</button>`;
      dom.mixer.append(channel);
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
      row.innerHTML = `
        <button class="project-load" type="button" data-load-project="${escapeAttribute(project.id)}">
          <strong>${escapeHtml(project.name)}</strong>
          <span>${project.tempo} BPM · ${escapeHtml(project.key)} · ${date}</span>
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
    return STEPS * (60 / project.tempo / 4);
  }

  function wrapPlaybackOffset(offset, duration = loopDuration()) {
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || duration <= 0) return 0;
    const wrapped = offset % duration;
    return wrapped < 0 ? wrapped + duration : wrapped;
  }

  function currentPlaybackPosition() {
    const duration = loopDuration();
    if (playing && audioContext && playbackAnchorTime > 0) {
      const elapsed = Math.max(0, audioContext.currentTime - playbackAnchorTime);
      return wrapPlaybackOffset(playbackOffset + elapsed, duration);
    }
    return clamp(playbackOffset, 0, duration);
  }

  function formatPlaybackTime(seconds) {
    const totalTenths = Math.max(0, Math.round(seconds * 10));
    const minutes = Math.floor(totalTenths / 600);
    const wholeSeconds = Math.floor((totalTenths % 600) / 10);
    return `${minutes}:${String(wholeSeconds).padStart(2, "0")}.${totalTenths % 10}`;
  }

  function renderPlaybackPosition(position = currentPlaybackPosition(), { forceSeek = false } = {}) {
    if (playbackScrubbing && !forceSeek) return;
    const duration = loopDuration();
    const bounded = clamp(position, 0, duration);
    const ratio = duration > 0 ? bounded / duration : 0;
    const rangeValue = Math.round(ratio * 1000);
    const stepIndex = Math.min(STEPS - 1, Math.floor(Math.min(ratio, 0.999999) * STEPS));
    const currentLabel = formatPlaybackTime(bounded);
    const durationLabel = formatPlaybackTime(duration);

    dom.persistentSeek.value = String(rangeValue);
    dom.persistentSeek.style.setProperty("--seek-progress", `${ratio * 100}%`);
    dom.persistentSeek.setAttribute(
      "aria-valuetext",
      `${currentLabel} of ${durationLabel}, step ${stepIndex + 1} of ${STEPS}`
    );
    dom.persistentCurrentTime.textContent = currentLabel;
    dom.persistentDuration.textContent = durationLabel;
  }

  function renderPlaybackMetadata() {
    dom.persistentPlayerTitle.textContent = state.name;
    renderPlaybackPosition();
  }

  function renderPlaybackControls() {
    const active = playing || playbackStarting;
    [dom.playButton, dom.persistentPlayButton].forEach((button) => {
      button.classList.toggle("is-playing", active);
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", active ? "Pause loop" : "Play loop");
    });
    dom.persistentPlayer.hidden = !playbackSessionVisible;
    document.body.classList.toggle("has-persistent-player", playbackSessionVisible);
    renderPlaybackMetadata();
  }

  function stopProgressTicker() {
    window.cancelAnimationFrame(playbackProgressFrame);
    playbackProgressFrame = 0;
  }

  function startProgressTicker() {
    stopProgressTicker();
    const tick = () => {
      if (!playing) {
        playbackProgressFrame = 0;
        return;
      }
      renderPlaybackPosition();
      playbackProgressFrame = window.requestAnimationFrame(tick);
    };
    playbackProgressFrame = window.requestAnimationFrame(tick);
  }

  function playbackAudioFingerprint(project) {
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
    const ratio = engaged && duration > 0 ? currentPlaybackPosition() / duration : 0;
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
    playbackSessionVisible = false;
    playbackProjectId = null;
    playbackScrubbing = false;
    resumeAfterSeek = false;
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
    const requestId = ++playbackStartRequest;
    playbackStarting = true;
    renderPlaybackControls();
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
    const stoppedAt = resetPosition ? 0 : currentPlaybackPosition();
    playbackStartRequest += 1;
    playbackResumeRequest += 1;
    playbackStarting = false;
    playing = false;
    window.clearInterval(schedulerTimer);
    schedulerTimer = 0;
    stopProgressTicker();
    uiTimers.forEach(window.clearTimeout);
    uiTimers.clear();

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

  function togglePlayback() {
    if (playing || playbackStarting) stopPlayback({ resetPosition: false });
    else startPlayback();
  }

  function previewPlaybackSeek() {
    if (!playbackScrubbing) {
      playbackScrubbing = true;
      resumeAfterSeek = playing || playbackStarting;
      if (resumeAfterSeek) stopPlayback({ resetPosition: false });
    }
    const ratio = Number(dom.persistentSeek.value) / 1000;
    playbackOffset = clamp(ratio, 0, 1) * loopDuration();
    renderPlaybackPosition(playbackOffset, { forceSeek: true });
  }

  function commitPlaybackSeek() {
    if (!playbackScrubbing) return;
    const shouldResume = resumeAfterSeek;
    playbackScrubbing = false;
    resumeAfterSeek = false;
    renderPlaybackPosition(playbackOffset);
    if (shouldResume) schedulePlaybackResume();
  }

  function changeTempo(amount) {
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

    if (target.dataset.loadProject) {
      const project = readProjects().find((item) => item.id === target.dataset.loadProject);
      if (project) {
        resetPlaybackSession();
        state = normalizeProject(project);
        writeCurrent(state);
        renderAll();
        showView("studio");
        showToast("Project opened");
      }
    }

    if (target.dataset.deleteProject) {
      const projects = readProjects();
      const project = projects.find((item) => item.id === target.dataset.deleteProject);
      const locationLabel = currentUser ? "your account and this device" : "this device";
      if (project && window.confirm(`Delete “${project.name}” from ${locationLabel}?`)) {
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
    const slider = event.target.closest("[data-volume-track]");
    if (!slider) return;
    const trackIndex = Number(slider.dataset.volumeTrack);
    state.volumes[trackIndex] = Number(slider.value) / 100;
    slider.closest(".mixer-channel").querySelector(".mixer-label span").textContent = `${slider.value}%`;
    queueSave();
  });

  dom.composerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = dom.ideaInput.value.trim();
    if (!prompt) return;
    resetPlaybackSession();
    composeFromPrompt(prompt);
    showView("studio");
    showToast("Your loop is ready to play");
  });

  dom.playButton.addEventListener("click", togglePlayback);
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
    state.volumes = [0.88, 0.68, 0.6, 0.48];
    state.muted = [false, false, false, false];
    renderMixer();
    renderSequencer();
    queueSave();
    showToast("Mix reset");
  });

  document.querySelector("#new-project-button").addEventListener("click", () => {
    resetPlaybackSession();
    state = makeProject();
    renderAll();
    persist();
    showView("create");
    dom.ideaInput.value = "";
    dom.ideaInput.focus();
  });

  document.querySelector("#refine-button").addEventListener("click", () => {
    dom.refineInput.value = "";
    if (typeof dom.refineDialog.showModal === "function") dom.refineDialog.showModal();
    else dom.refineDialog.setAttribute("open", "");
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

  dom.accountButton.addEventListener("click", () => openAccountDialog("signin"));
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
      if (playing || playbackStarting) stopPlayback();
      else renderPlaybackControls();
      flushSave();
    }
  });

  window.addEventListener("pagehide", () => {
    flushSave();
    clearPendingAudioExport();
    if (audioContext?.state === "running") audioContext.suspend().catch(() => {});
  });
  window.addEventListener("online", () => {
    if (currentUser) syncCloud();
  });
  window.addEventListener("offline", () => {
    if (currentUser) setSaveStatus("Offline — sync pending", "offline");
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
  else setSaveStatus(currentUser ? "Syncing…" : "Saved on device", currentUser ? "syncing" : "local");
  if (storageReadWarning) showToast(storageReadWarning);
  showView("create", { focus: false });

  if (cloud?.configured()) {
    cloud.restoreSession().then((session) => {
      const restoredUser = session?.user || null;
      if (restoredUser?.id !== currentUser?.id) switchUser(restoredUser);
      else if (restoredUser) syncCloud();
      else if (currentUser) switchUser(null);
    });
  }
})();
