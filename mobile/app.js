(() => {
  "use strict";

  const STORAGE_CURRENT = "opusloops.mobile.current.v1";
  const STORAGE_PROJECTS = "opusloops.mobile.projects.v1";
  const STORAGE_RECOVERY = "opusloops.mobile.recovery.v1";
  const PROJECT_SCHEMA_VERSION = 1;
  const STEPS = 16;
  const TRACKS = [
    { id: "kick", name: "Kick", kind: "kick", color: "#ce7658" },
    { id: "snare", name: "Snare", kind: "snare", color: "#71826b" },
    { id: "bass", name: "Bass", kind: "bass", color: "#687e8d" },
    { id: "chords", name: "Chords", kind: "chords", color: "#856b81" }
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

  let storageReadWarning = "";
  let state = readCurrent() || makeProject();
  let saveTimer = 0;
  let toastTimer = 0;
  let installPrompt = null;

  let audioContext = null;
  let masterGain = null;
  let noiseBuffer = null;
  let schedulerTimer = 0;
  let nextStepTime = 0;
  let currentStep = 0;
  const uiTimers = new Set();
  let playing = false;

  const dom = {
    composerForm: document.querySelector("#composer-form"),
    ideaInput: document.querySelector("#idea-input"),
    studioTitle: document.querySelector("#studio-title"),
    tempoOutput: document.querySelector("#tempo-output"),
    playButton: document.querySelector("#play-button"),
    keyButton: document.querySelector("#key-button"),
    sequencer: document.querySelector("#sequencer"),
    mixer: document.querySelector("#mixer"),
    projectsList: document.querySelector("#projects-list"),
    saveStatus: document.querySelector("#save-status span:last-child"),
    recentName: document.querySelector("#recent-project-name"),
    recentMeta: document.querySelector("#recent-project-meta"),
    refineDialog: document.querySelector("#refine-dialog"),
    refineForm: document.querySelector("#refine-form"),
    refineInput: document.querySelector("#refine-input"),
    toast: document.querySelector("#toast"),
    installCard: document.querySelector("#install-card"),
    installButton: document.querySelector("#install-button")
  };

  function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `loop-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeProject(candidate) {
    if (!candidate || typeof candidate !== "object") return null;
    const base = makeProject();
    const patterns = Array.isArray(candidate.patterns) ? candidate.patterns : base.patterns;
    return {
      ...base,
      ...candidate,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: typeof candidate.id === "string" ? candidate.id : base.id,
      name: cleanName(candidate.name) || base.name,
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

  function normalizeTimestamp(value, fallback) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
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

  function readCurrent() {
    return normalizeProject(readJson(STORAGE_CURRENT, null));
  }

  function readProjects() {
    const projects = readJson(STORAGE_PROJECTS, []);
    if (!Array.isArray(projects)) return [];
    return projects.map(normalizeProject).filter(Boolean);
  }

  function persist({ announce = false } = {}) {
    state.updatedAt = new Date().toISOString();
    const projects = readProjects();
    const index = projects.findIndex((project) => project.id === state.id);
    const snapshot = clone(state);
    if (index >= 0) projects[index] = snapshot;
    else projects.push(snapshot);

    if (writeJson(STORAGE_CURRENT, snapshot) && writeJson(STORAGE_PROJECTS, projects)) {
      setSaveStatus("Saved in browser");
      renderRecent();
      renderProjects();
      if (announce) showToast("Saved in this browser");
    }
  }

  function queueSave() {
    setSaveStatus("Saving…");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => persist(), 260);
  }

  function flushSave() {
    if (!saveTimer) return;
    window.clearTimeout(saveTimer);
    saveTimer = 0;
    persist();
  }

  function setSaveStatus(label) {
    if (dom.saveStatus) dom.saveStatus.textContent = label;
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
    if (active) previewTrack(trackIndex);
    queueSave();
  }

  function toggleMute(trackIndex) {
    state.muted[trackIndex] = !state.muted[trackIndex];
    renderSequencer();
    renderMixer();
    queueSave();
  }

  async function ensureAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      showToast("Web Audio is not supported in this browser");
      return false;
    }
    if (!audioContext) {
      audioContext = new AudioContext();
      masterGain = audioContext.createGain();
      masterGain.gain.value = 0.72;
      masterGain.connect(audioContext.destination);
      noiseBuffer = createNoiseBuffer();
    }
    if (audioContext.state === "suspended") await audioContext.resume();
    return true;
  }

  function createNoiseBuffer() {
    const length = Math.floor(audioContext.sampleRate * 0.4);
    const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
    return buffer;
  }

  async function previewTrack(trackIndex) {
    if (!(await ensureAudio()) || state.muted[trackIndex]) return;
    scheduleVoice(trackIndex, audioContext.currentTime + 0.01, currentStep);
  }

  async function startPlayback() {
    if (!(await ensureAudio())) return;
    playing = true;
    currentStep = 0;
    nextStepTime = audioContext.currentTime + 0.06;
    dom.playButton.classList.add("is-playing");
    dom.playButton.setAttribute("aria-pressed", "true");
    dom.playButton.setAttribute("aria-label", "Pause loop");
    scheduleAhead();
    schedulerTimer = window.setInterval(scheduleAhead, 25);
  }

  function stopPlayback() {
    playing = false;
    window.clearInterval(schedulerTimer);
    schedulerTimer = 0;
    uiTimers.forEach(window.clearTimeout);
    uiTimers.clear();
    dom.playButton.classList.remove("is-playing");
    dom.playButton.setAttribute("aria-pressed", "false");
    dom.playButton.setAttribute("aria-label", "Play loop");
    document.querySelectorAll(".step.is-current").forEach((step) => step.classList.remove("is-current"));
  }

  function scheduleAhead() {
    if (!playing || !audioContext) return;
    const baseDuration = 60 / state.tempo / 4;
    while (nextStepTime < audioContext.currentTime + 0.12) {
      const swingDelay = currentStep % 2 === 1 ? baseDuration * state.swing : 0;
      const scheduledTime = nextStepTime + swingDelay;
      TRACKS.forEach((_, trackIndex) => {
        if (state.patterns[trackIndex][currentStep] && !state.muted[trackIndex]) {
          scheduleVoice(trackIndex, scheduledTime, currentStep);
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

  function scheduleVoice(trackIndex, time, stepIndex) {
    const level = state.volumes[trackIndex];
    if (level <= 0 || !audioContext) return;
    const kind = TRACKS[trackIndex].kind;
    if (kind === "kick") scheduleKick(time, level);
    if (kind === "snare") scheduleSnare(time, level);
    if (kind === "bass") scheduleBass(time, level, stepIndex);
    if (kind === "chords") scheduleChord(time, level, stepIndex);
  }

  function outputGain(level) {
    const gain = audioContext.createGain();
    gain.gain.value = level;
    gain.connect(masterGain);
    return gain;
  }

  function scheduleKick(time, level) {
    const oscillator = audioContext.createOscillator();
    const gain = outputGain(level * 0.9);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(130, time);
    oscillator.frequency.exponentialRampToValueAtTime(46, time + 0.13);
    gain.gain.setValueAtTime(level * 0.9, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
    oscillator.connect(gain);
    oscillator.start(time);
    oscillator.stop(time + 0.32);
  }

  function scheduleSnare(time, level) {
    const noise = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const gain = outputGain(level * 0.38);
    noise.buffer = noiseBuffer;
    filter.type = "highpass";
    filter.frequency.value = 1100;
    gain.gain.setValueAtTime(level * 0.38, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
    noise.connect(filter).connect(gain);
    noise.start(time);
    noise.stop(time + 0.18);

    const tone = audioContext.createOscillator();
    const toneGain = outputGain(level * 0.16);
    tone.type = "triangle";
    tone.frequency.value = 180;
    toneGain.gain.setValueAtTime(level * 0.16, time);
    toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
    tone.connect(toneGain);
    tone.start(time);
    tone.stop(time + 0.11);
  }

  function rootFrequency() {
    return { C: 65.41, D: 73.42, E: 82.41, F: 87.31, G: 98.0, A: 110.0 }[state.key[0]] || 65.41;
  }

  function scheduleBass(time, level, stepIndex) {
    const oscillator = audioContext.createOscillator();
    const filter = audioContext.createBiquadFilter();
    const gain = outputGain(level * 0.34);
    const intervals = [1, 1, 1.189, 1.335, 1.498];
    oscillator.type = "sawtooth";
    oscillator.frequency.value = rootFrequency() * intervals[Math.floor(stepIndex / 4) % intervals.length];
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(520, time);
    filter.Q.value = 2.1;
    gain.gain.setValueAtTime(0.001, time);
    gain.gain.exponentialRampToValueAtTime(level * 0.34, time + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
    oscillator.connect(filter).connect(gain);
    oscillator.start(time);
    oscillator.stop(time + 0.26);
  }

  function scheduleChord(time, level, stepIndex) {
    const root = rootFrequency() * 2 * (stepIndex >= 8 ? 1.335 : 1);
    const intervals = [1, Math.pow(2, 3 / 12), Math.pow(2, 7 / 12)];
    intervals.forEach((interval, index) => {
      const oscillator = audioContext.createOscillator();
      const filter = audioContext.createBiquadFilter();
      const gain = outputGain(level * 0.08);
      oscillator.type = index === 0 ? "triangle" : "sine";
      oscillator.frequency.value = root * interval;
      oscillator.detune.value = index * 3 - 3;
      filter.type = "lowpass";
      filter.frequency.value = 1400;
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.exponentialRampToValueAtTime(level * 0.08, time + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.48);
      oscillator.connect(filter).connect(gain);
      oscillator.start(time);
      oscillator.stop(time + 0.5);
    });
  }

  function applyRefinement(instruction) {
    const text = instruction.toLowerCase();
    const random = seededRandom(hashText(`${state.id}-${instruction}-${Date.now()}`));
    if (/sparse|less|minimal|space/.test(text)) {
      state.patterns = state.patterns.map((pattern, trackIndex) =>
        pattern.map((active, stepIndex) => (active && stepIndex !== 0 && random() < 0.42 + trackIndex * 0.05 ? 0 : active))
      );
    } else if (/busy|more|energy|driv/.test(text)) {
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
        stopPlayback();
        state = normalizeProject(project);
        writeJson(STORAGE_CURRENT, state);
        renderAll();
        showView("studio");
        showToast("Project opened");
      }
    }

    if (target.dataset.deleteProject) {
      const projects = readProjects();
      const project = projects.find((item) => item.id === target.dataset.deleteProject);
      if (project && window.confirm(`Delete “${project.name}” from this device?`)) {
        const remaining = projects.filter((item) => item.id !== project.id);
        writeJson(STORAGE_PROJECTS, remaining);
        if (state.id === project.id) {
          state = remaining[0] || makeProject();
          writeJson(STORAGE_CURRENT, state);
          renderAll();
        } else {
          renderProjects();
        }
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
    stopPlayback();
    composeFromPrompt(prompt);
    showView("studio");
    showToast("Your loop is ready to play");
  });

  dom.playButton.addEventListener("click", () => (playing ? stopPlayback() : startPlayback()));

  document.querySelector("#tempo-down").addEventListener("click", () => {
    state.tempo = clamp(state.tempo - 2, 56, 180);
    dom.tempoOutput.textContent = `${state.tempo} BPM`;
    queueSave();
  });

  document.querySelector("#tempo-up").addEventListener("click", () => {
    state.tempo = clamp(state.tempo + 2, 56, 180);
    dom.tempoOutput.textContent = `${state.tempo} BPM`;
    queueSave();
  });

  dom.keyButton.addEventListener("click", () => {
    state.key = KEYS[(KEYS.indexOf(state.key) + 1) % KEYS.length];
    dom.keyButton.textContent = state.key;
    queueSave();
  });

  dom.studioTitle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      dom.studioTitle.blur();
    }
  });

  dom.studioTitle.addEventListener("blur", () => {
    state.name = cleanName(dom.studioTitle.textContent) || "Untitled loop";
    dom.studioTitle.textContent = state.name;
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
    stopPlayback();
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
    applyRefinement(instruction);
    dom.refineDialog.close?.();
    dom.refineDialog.removeAttribute("open");
    showToast("Loop refined");
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
      if (playing) stopPlayback();
      flushSave();
    }
  });

  window.addEventListener("pagehide", flushSave);

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
  persist();
  if (storageReadWarning) showToast(storageReadWarning);
  showView("create", { focus: false });
})();
