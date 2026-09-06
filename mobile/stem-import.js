(() => {
  "use strict";

  const core = window.OpusloopsStemCore;

  function create({
    cloud,
    getUser,
    makeId,
    openSignIn,
    showView,
    findProject,
    saveProject,
    prepareProject,
    discardProject,
    showToast
  } = {}) {
    const dom = {
      uploadPanel: document.querySelector("#stem-upload-panel"),
      fileInput: document.querySelector("#stem-zip-input"),
      fileName: document.querySelector("#stem-file-name"),
      uploadButton: document.querySelector("#stem-upload-button"),
      uploadNote: document.querySelector("#stem-upload-note"),
      processPanel: document.querySelector("#stem-process-panel"),
      processTitle: document.querySelector("#stem-process-title"),
      processState: document.querySelector("#stem-process-state"),
      processProgress: document.querySelector("#stem-process-progress"),
      processProgressFill: document.querySelector("#stem-process-progress-fill"),
      processProgressLabel: document.querySelector("#stem-process-progress-label"),
      processProgressPercent: document.querySelector("#stem-process-progress-percent"),
      indeterminateCopy: document.querySelector("#stem-indeterminate-copy"),
      processEvents: document.querySelector("#stem-process-events"),
      processError: document.querySelector("#stem-process-error"),
      retryInspection: document.querySelector("#stem-retry-inspection"),
      cancelButton: document.querySelector("#stem-cancel-button"),
      gateAPanel: document.querySelector("#stem-gate-a-panel"),
      reviewList: document.querySelector("#stem-review-list"),
      referenceMethod: document.querySelector("#stem-reference-method"),
      approveAnalysis: document.querySelector("#approve-stem-analysis"),
      proposalPanel: document.querySelector("#stem-proposal-panel"),
      gridIssue: document.querySelector("#stem-grid-issue"),
      gridIssueCopy: document.querySelector("#stem-grid-issue-copy"),
      gridEditor: document.querySelector("#stem-grid-editor"),
      gridEventList: document.querySelector("#stem-grid-event-list"),
      addGridEvent: document.querySelector("#stem-add-grid-event"),
      meterNumerator: document.querySelector("#stem-meter-numerator"),
      meterDenominator: document.querySelector("#stem-meter-denominator"),
      firstDownbeat: document.querySelector("#stem-first-downbeat"),
      targetBpm: document.querySelector("#stem-target-bpm"),
      conformMode: document.querySelector("#stem-conform-mode"),
      requestProposal: document.querySelector("#request-stem-proposal"),
      gateBPanel: document.querySelector("#stem-gate-b-panel"),
      clickAudition: document.querySelector("#stem-click-audition"),
      clickAuditionIcon: document.querySelector("#stem-click-audition .click-audition-icon"),
      clickAuditionCopy: document.querySelector("#stem-click-audition-copy"),
      clickAudio: document.querySelector("#stem-click-audio"),
      regionList: document.querySelector("#stem-region-list"),
      approveTempo: document.querySelector("#approve-stem-tempo"),
      readyPanel: document.querySelector("#stem-ready-panel"),
      openReady: document.querySelector("#open-ready-stems")
    };
    const gateAConfirmationIds = [
      "confirm-stem-files",
      "confirm-stem-roles",
      "confirm-stem-reference",
      "confirm-stem-originals"
    ];
    const gateBConfirmationIds = [
      "confirm-tempo-click",
      "confirm-tempo-grid",
      "confirm-tempo-meter",
      "confirm-tempo-octave",
      "confirm-tempo-flags",
      "confirm-tempo-target",
      "confirm-tempo-map",
      "confirm-tempo-originals"
    ];
    const queuedStatuses = new Set([
      "inspect_queued", "analysis_queued", "proposal_queued", "render_queued"
    ]);

    let selectedFile = null;
    let rawJob = null;
    let job = null;
    let assets = [];
    let events = [];
    let lastSequence = 0;
    let pollingTimer = 0;
    let generation = 0;
    let uploadController = null;
    let uploadInstructions = null;
    let uploadProgress = null;
    let inspectionDocument = null;
    let gridDocument = null;
    let proposalDocument = null;
    let gridEvents = [];
    let gridDirty = false;
    let gridSettingsInitialized = false;
    let renderedTrackFingerprint = "";
    let renderedGridFingerprint = "";
    let renderedRegionFingerprint = "";
    let clickObjectUrl = "";
    let clickAssetId = "";
    let clickPlayed = false;
    let dispatchSatisfiedKey = "";
    let dispatchRetryAt = 0;
    let dispatchRetryDelay = 1500;
    let dispatchInFlight = null;
    const jsonArtifacts = new Map();

    function field(id) {
      return document.getElementById(id);
    }

    function currentProject() {
      return job?.projectId ? findProject?.(job.projectId) : null;
    }

    function friendlyError(error) {
      const code = String(error?.code || "");
      if (code === "stale_revision") return "This import changed on another device. Refreshing the latest state.";
      if (code === "invalid_state") return "This action no longer matches the import’s current stage.";
      if (code === "request_too_large" || error?.status === 413) return "This ZIP is larger than the current import limit.";
      if (code === "dispatch_unavailable") return "Audio processing is temporarily unavailable. Your upload is safe.";
      if (code === "upload_identity_mismatch") return "The saved upload belongs to a different file. Choose the original ZIP again.";
      if (code === "authentication_required" || error?.status === 401) return "Sign in again to continue this private import.";
      if (code === "forbidden" || error?.status === 403) return "This account cannot access that stem import.";
      if (error?.name === "AbortError") return "Upload paused before completion.";
      if (!navigator.onLine || error instanceof TypeError) return "Connection lost. The resumable upload can continue when you are online.";
      return core.boundedString(error?.message || "Stem processing could not continue.", 300);
    }

    function setBusy(button, busy, label) {
      if (!button) return;
      if (busy) {
        if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
        button.textContent = label;
      } else if (button.dataset.idleLabel) {
        button.textContent = button.dataset.idleLabel;
      }
      button.disabled = busy;
    }

    function setError(message = "") {
      dom.processError.textContent = message;
      dom.processError.hidden = !message;
    }

    function resetConfirmations(ids) {
      ids.forEach((id) => {
        const input = field(id);
        if (input) input.checked = false;
      });
    }

    function allConfirmed(ids) {
      return ids.every((id) => field(id)?.checked);
    }

    function stageCopy(event) {
      const stage = String(event?.stage || "").replace(/-/g, " ");
      const detail = event?.detail || {};
      if (event?.status === "failed") return `${stage || "stage"} failed`;
      if (event?.status === "completed") return `${stage || "stage"} complete`;
      if (event?.status === "waiting") return `${stage || "review"} waiting for you`;
      if (event?.status === "progress" && detail.name) return `${stage}: ${core.boundedString(detail.name, 80)}`;
      return stage || core.statusLabel(job?.status);
    }

    function progressLabel(progress) {
      if (!progress) return "";
      if (/byte/i.test(progress.unit)) return `${core.formatBytes(progress.completed)} of ${core.formatBytes(progress.total)}`;
      const unit = progress.unit || "items";
      return `${Math.trunc(progress.completed).toLocaleString()} of ${Math.trunc(progress.total).toLocaleString()} ${unit}`;
    }

    function renderEvents() {
      dom.processEvents.replaceChildren();
      const visible = events.filter((event) => event.status !== "progress").slice(-8);
      visible.forEach((event) => {
        const item = document.createElement("li");
        item.className = `process-event is-${event.status || "update"}`;
        const marker = document.createElement("span");
        marker.className = "process-event-marker";
        marker.setAttribute("aria-hidden", "true");
        const copy = document.createElement("span");
        copy.textContent = stageCopy(event);
        item.append(marker, copy);
        dom.processEvents.append(item);
      });
    }

    function renderProgress() {
      if (uploadProgress && job?.status === "uploading") {
        const percent = uploadProgress.total > 0 ? uploadProgress.completed / uploadProgress.total * 100 : 0;
        dom.processProgress.hidden = false;
        dom.indeterminateCopy.hidden = true;
        dom.processProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.processProgressLabel.textContent = `${core.formatBytes(uploadProgress.completed)} of ${core.formatBytes(uploadProgress.total)} confirmed`;
        dom.processProgressPercent.textContent = `${Math.floor(percent)}%`;
        dom.processProgress.setAttribute("aria-valuenow", String(Math.floor(percent)));
        dom.processProgress.setAttribute("aria-valuetext", `${core.formatBytes(uploadProgress.completed)} of ${core.formatBytes(uploadProgress.total)} confirmed by storage`);
        return;
      }
      const activeEvents = job?.activeAttemptId
        ? events.filter((event) => event.attemptId === job.activeAttemptId)
        : events;
      const lastStarted = [...activeEvents].reverse().find((event) => event.status === "started");
      const latest = [...activeEvents].reverse().find((event) =>
        event.status === "progress" && (!lastStarted || event.sequence >= lastStarted.sequence)
      );
      const progress = latest ? core.eventProgress(latest) : null;
      const active = core.statusKind(job?.status) === "active";
      dom.processProgress.hidden = !active || !progress;
      dom.indeterminateCopy.hidden = !active || Boolean(progress);
      if (progress) {
        dom.processProgressFill.style.width = `${Math.max(0, Math.min(100, progress.percent))}%`;
        dom.processProgressLabel.textContent = progressLabel(progress);
        dom.processProgressPercent.textContent = `${Math.floor(progress.percent)}%`;
        dom.processProgress.setAttribute("aria-valuenow", String(Math.floor(progress.percent)));
        dom.processProgress.setAttribute("aria-valuetext", progressLabel(progress));
      } else if (active) {
        dom.indeterminateCopy.textContent = `${core.statusLabel(job.status)} — this stage has not reported a measurable percentage.`;
      }
    }

    function renderTracks() {
      const tracks = job?.tracks || [];
      const fingerprint = JSON.stringify(tracks);
      if (fingerprint === renderedTrackFingerprint) return;
      renderedTrackFingerprint = fingerprint;
      dom.reviewList.replaceChildren();
      tracks.forEach((track, index) => {
        const row = document.createElement("section");
        row.className = "stem-review-row";
        row.dataset.assetId = track.assetId;

        const heading = document.createElement("div");
        heading.className = "stem-review-heading";
        const included = document.createElement("input");
        included.type = "checkbox";
        included.checked = track.included;
        included.className = "stem-included";
        included.id = `stem-included-${index}`;
        included.setAttribute("aria-label", `Include ${track.name}`);
        const name = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = track.name;
        const meta = document.createElement("span");
        const audioMeta = [
          track.durationSeconds ? core.formatDuration(track.durationSeconds) : "",
          track.channels ? `${track.channels === 1 ? "Mono" : `${track.channels}-channel`}` : "",
          track.sampleRate ? `${Math.round(track.sampleRate / 100) / 10} kHz` : ""
        ].filter(Boolean).join(" · ");
        meta.textContent = audioMeta || "Decoded source stem";
        name.append(strong, meta);
        heading.append(included, name);

        const controls = document.createElement("div");
        controls.className = "stem-review-controls";
        const roleLabel = document.createElement("label");
        roleLabel.textContent = "Role";
        const role = document.createElement("select");
        role.className = "stem-role";
        core.ROLES.forEach((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value === "full-mix" ? "Full mix" : value.charAt(0).toUpperCase() + value.slice(1);
          option.selected = value === track.role;
          role.append(option);
        });
        roleLabel.append(role);
        const gainLabel = document.createElement("label");
        gainLabel.textContent = "Gain dB";
        const gain = document.createElement("input");
        gain.className = "stem-gain";
        gain.type = "number";
        gain.inputMode = "decimal";
        gain.min = "-120";
        gain.max = "24";
        gain.step = "0.1";
        gain.value = String(track.gainDb);
        gainLabel.append(gain);
        controls.append(roleLabel, gainLabel);

        const hash = document.createElement("code");
        hash.className = "stem-hash";
        hash.textContent = track.sha256 ? `SHA-256 ${track.sha256}` : "SHA-256 recorded in the inspection manifest";
        row.append(heading, controls, hash);
        dom.reviewList.append(row);
      });
    }

    function collectTracks() {
      return Array.from(dom.reviewList.querySelectorAll(".stem-review-row")).map((row, index) => {
        const original = job.tracks.find((track) => track.assetId === row.dataset.assetId) || job.tracks[index];
        return {
          ...original,
          included: row.querySelector(".stem-included").checked,
          role: row.querySelector(".stem-role").value,
          gainDb: Number(row.querySelector(".stem-gain").value)
        };
      });
    }

    function selectFullMixReference() {
      if (dom.referenceMethod.value !== "full-mix") return;
      const rows = Array.from(dom.reviewList.querySelectorAll(".stem-review-row"));
      const fullMixRows = rows.filter((row) => row.querySelector(".stem-role")?.value === "full-mix");
      if (fullMixRows.length !== 1) {
        showToast?.(fullMixRows.length
          ? "Choose exactly one Full mix role before using it as the reference"
          : "Assign one file the Full mix role before using it as the reference");
        dom.referenceMethod.value = "selected-stem-sum";
        return;
      }
      rows.forEach((row) => {
        row.querySelector(".stem-included").checked = row === fullMixRows[0];
      });
    }

    function gridFromDocument(documentValue) {
      if (!documentValue || typeof documentValue !== "object") return [];
      const primary = documentValue.primary && typeof documentValue.primary === "object" ? documentValue.primary : {};
      const beats = documentValue.beats_seconds || documentValue.beatsSeconds || documentValue.beats
        || primary.beats_seconds || primary.beatsSeconds || primary.beats || [];
      const downbeats = documentValue.downbeats_seconds || documentValue.downbeatsSeconds || documentValue.downbeats
        || primary.downbeats_seconds || primary.downbeatsSeconds || primary.downbeats || [];
      if (!Array.isArray(beats) || !Array.isArray(downbeats)) return [];
      const downbeatTimes = downbeats.map((item) => Number(item?.time ?? item)).filter(Number.isFinite);
      const result = beats
        .map((item) => Number(item?.time ?? item))
        .filter(Number.isFinite)
        .map((time, index) => ({
          id: `beat-${index + 1}`,
          time,
          downbeat: downbeatTimes.some((candidate) => Math.abs(candidate - time) < 0.0005)
        }));
      downbeatTimes.forEach((time) => {
        if (!result.some((event) => Math.abs(event.time - time) < 0.0005)) {
          result.push({ id: `downbeat-${result.length + 1}`, time, downbeat: true });
        }
      });
      return result.sort((left, right) => left.time - right.time);
    }

    function initializeGridSettings() {
      if (!gridDocument || gridSettingsInitialized) return;
      const meter = gridDocument.meter || job?.analysis?.meter || job?.analysis?.primary?.meter || {};
      const numerator = Number(meter.numerator ?? gridDocument.meter_numerator ?? gridDocument.meterNumerator ?? 4);
      const denominator = Number(meter.denominator ?? gridDocument.meter_denominator ?? gridDocument.meterDenominator ?? 4);
      const first = Number(
        gridDocument.first_downbeat_seconds
          ?? gridDocument.firstDownbeatSeconds
          ?? gridEvents.find((event) => event.downbeat)?.time
          ?? 0
      );
      dom.meterNumerator.value = String(Number.isInteger(numerator) && numerator >= 1 && numerator <= 32 ? numerator : 4);
      dom.meterDenominator.value = [1, 2, 4, 8, 16, 32].includes(denominator) ? String(denominator) : "4";
      dom.firstDownbeat.value = String(Number.isFinite(first) && first >= 0 ? Number(first.toFixed(6)) : 0);
      gridSettingsInitialized = true;
    }

    function estimatedGridBpm() {
      const intervals = gridEvents
        .slice(1)
        .map((event, index) => event.time - gridEvents[index].time)
        .filter((gap) => Number.isFinite(gap) && gap > 0.08 && gap < 3)
        .sort((left, right) => left - right);
      if (!intervals.length) return null;
      return 60 / intervals[Math.floor(intervals.length / 2)];
    }

    function gridDiagnostics() {
      const sorted = [...gridEvents].sort((left, right) => left.time - right.time);
      const messages = [];
      const flaggedIds = new Set();
      if (sorted.length < 2) messages.push("Add at least two detected beat events.");
      const intervals = sorted
        .slice(1)
        .map((event, index) => event.time - sorted[index].time)
        .filter((gap) => gap > 0.02)
        .sort((left, right) => left - right);
      const medianGap = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0.5;
      const duplicateTolerance = Math.min(0.2, Math.max(0.025, medianGap * 0.45));
      for (let index = 1; index < sorted.length; index += 1) {
        const gap = sorted[index].time - sorted[index - 1].time;
        if (gap < duplicateTolerance) {
          messages.push(`Events at ${sorted[index - 1].time.toFixed(2)}s and ${sorted[index].time.toFixed(2)}s are only ${gap.toFixed(2)}s apart.`);
          flaggedIds.add(sorted[index - 1].id);
          flaggedIds.add(sorted[index].id);
        }
      }
      const downbeats = sorted.filter((event) => event.downbeat);
      if (!downbeats.length) messages.push("Mark at least one timing event as a downbeat.");
      for (let index = 1; index < downbeats.length; index += 1) {
        const gap = downbeats[index].time - downbeats[index - 1].time;
        const expectedBarSeconds = medianGap * Math.max(1, Number(dom.meterNumerator.value) || 4);
        if (gap < Math.max(0.25, expectedBarSeconds * 0.35)) {
          messages.push(`Downbeats at ${downbeats[index - 1].time.toFixed(2)}s and ${downbeats[index].time.toFixed(2)}s may be duplicates.`);
          flaggedIds.add(downbeats[index - 1].id);
          flaggedIds.add(downbeats[index].id);
        }
      }
      const meterNumerator = Math.trunc(Number(dom.meterNumerator.value));
      if (!Number.isInteger(meterNumerator) || meterNumerator < 1 || meterNumerator > 32) {
        messages.push("Beats per bar must be a whole number from 1 to 32.");
      } else {
        for (let index = 1; index < downbeats.length; index += 1) {
          const left = downbeats[index - 1];
          const right = downbeats[index];
          const count = sorted.filter((event) => event.time >= left.time - 0.0005 && event.time < right.time - 0.0005).length;
          if (count !== meterNumerator) {
            messages.push(`The bar from ${left.time.toFixed(2)}s to ${right.time.toFixed(2)}s contains ${count} beat ${count === 1 ? "event" : "events"}; the selected meter expects ${meterNumerator}.`);
            flaggedIds.add(left.id);
            flaggedIds.add(right.id);
          }
        }
      }
      const firstDownbeat = Number(dom.firstDownbeat.value);
      if (!Number.isFinite(firstDownbeat) || firstDownbeat < 0) {
        messages.push("First downbeat must be a non-negative time in seconds.");
      } else if (downbeats.length && Math.abs(downbeats[0].time - firstDownbeat) > 0.0005) {
        messages.push("First downbeat must match the first event marked as a downbeat.");
      }
      return { messages: Array.from(new Set(messages)), flaggedIds };
    }

    function gridIssues() {
      const issues = [...gridDiagnostics().messages];
      const reported = job?.analysis?.issues || job?.analysis?.flags || [];
      if (Array.isArray(reported)) reported.forEach((issue) => issues.push(core.boundedString(issue?.message || issue, 240)));
      return Array.from(new Set(issues.filter(Boolean)));
    }

    function renderGridIssues() {
      const issues = gridIssues();
      dom.gridIssue.hidden = !issues.length;
      dom.gridIssueCopy.textContent = issues.slice(0, 3).join(" ");
      if (issues.length) dom.gridEditor.open = true;
      return issues;
    }

    function renderGrid() {
      initializeGridSettings();
      const diagnostics = gridDiagnostics();
      const fingerprint = JSON.stringify([gridEvents, [...diagnostics.flaggedIds]]);
      if (fingerprint === renderedGridFingerprint) return;
      renderedGridFingerprint = fingerprint;
      dom.gridEventList.replaceChildren();
      renderGridIssues();
      gridEvents.forEach((event, index) => {
        const row = document.createElement("div");
        row.className = `grid-event-row${diagnostics.flaggedIds.has(event.id) ? " is-flagged" : ""}`;
        row.dataset.gridId = event.id;
        const number = document.createElement("span");
        number.className = "grid-event-number";
        number.textContent = String(index + 1);
        const time = document.createElement("input");
        time.className = "grid-event-time";
        time.type = "number";
        time.inputMode = "decimal";
        time.min = "0";
        time.step = "0.001";
        time.value = event.time.toFixed(3);
        time.setAttribute("aria-label", `Timing event ${index + 1} in seconds`);
        const type = document.createElement("select");
        type.className = "grid-event-type";
        type.setAttribute("aria-label", `Timing event ${index + 1} type`);
        [[false, "Beat"], [true, "Downbeat"]].forEach(([value, label]) => {
          const option = document.createElement("option");
          option.value = value ? "downbeat" : "beat";
          option.textContent = label;
          option.selected = event.downbeat === value;
          type.append(option);
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "grid-event-remove";
        remove.dataset.removeGridEvent = event.id;
        remove.setAttribute("aria-label", `Remove timing event ${index + 1} at ${event.time.toFixed(3)} seconds`);
        remove.textContent = "×";
        row.append(number, time, type, remove);
        dom.gridEventList.append(row);
      });
    }

    function syncGridFromDom() {
      const rows = Array.from(dom.gridEventList.querySelectorAll(".grid-event-row"));
      if (!rows.length) return;
      gridEvents = rows
        .map((row) => ({
          id: row.dataset.gridId,
          time: Number(row.querySelector(".grid-event-time").value),
          downbeat: row.querySelector(".grid-event-type").value === "downbeat"
        }))
        .filter((event) => Number.isFinite(event.time) && event.time >= 0)
        .sort((left, right) => left.time - right.time);
      gridDirty = true;
      renderGridIssues();
    }

    function reviewedGrid() {
      if (!gridDocument) throw new Error("The analyzed beat grid is still loading");
      syncGridFromDom();
      const diagnostics = gridDiagnostics();
      if (diagnostics.messages.length) throw new Error("Resolve the flagged beat and downbeat issues before building a proposal");
      return {
        schema_version: gridDocument.schema_version || "opusloops.tempo-grid-review.v1",
        analysis_sha256: gridDocument.analysis_sha256 || job.analysisSha256,
        attempt_id: gridDocument.attempt_id || job.analysis.attemptId || job.analysis.attempt_id,
        beats_seconds: gridEvents.map((event) => Number(event.time.toFixed(6))),
        downbeats_seconds: gridEvents.filter((event) => event.downbeat).map((event) => Number(event.time.toFixed(6))),
        notes: gridDirty ? "Edited and reviewed in the Opusloops timing editor." : "Reviewed in the Opusloops timing editor.",
        reviewed: true
      };
    }

    function proposalRegions() {
      const source = job?.regions
        || proposalDocument?.decision?.regions
        || proposalDocument?.map?.regions
        || proposalDocument?.tempo_map?.regions
        || proposalDocument?.tempoMap?.regions
        || job?.proposal?.decision?.regions
        || job?.proposal?.map?.regions
        || [];
      return Array.isArray(source)
        ? source.map((region, index) => {
            const normalized = core.normalizeRegion(region, index);
            const jobTarget = typeof job?.targetBpm === "number" && Number.isFinite(job.targetBpm)
              ? job.targetBpm
              : normalized.targetBpm;
            return {
              ...normalized,
              targetBpm: job?.mode === "no-conform" ? null : jobTarget
            };
          })
        : [];
    }

    function renderRegions() {
      const regions = proposalRegions();
      const fingerprint = JSON.stringify(regions);
      if (fingerprint === renderedRegionFingerprint) return;
      renderedRegionFingerprint = fingerprint;
      dom.regionList.replaceChildren();
      if (!regions.length) {
        const empty = document.createElement("p");
        empty.className = "fine-print";
        empty.textContent = "This mode has no derived four-bar stretch regions. Review the click and confirmations below.";
        dom.regionList.append(empty);
        return;
      }
      regions.forEach((region, index) => {
        const card = document.createElement("section");
        card.className = `region-card${region.flagged ? " is-flagged" : ""}`;
        card.dataset.regionId = region.id;
        const heading = document.createElement("div");
        heading.className = "region-heading";
        const strong = document.createElement("strong");
        strong.textContent = `Bars ${region.startBar}–${region.endBar}`;
        const badge = document.createElement("span");
        badge.textContent = region.flagged ? "Review" : "Stable";
        heading.append(strong, badge);
        const controls = document.createElement("dl");
        controls.className = "region-metrics";
        [
          ["Detected", `${Math.round(region.localBpm * 100) / 100} BPM`],
          ["Global target", region.targetBpm === null ? "Original timing" : `${Math.round(region.targetBpm * 100) / 100} BPM`],
          ["Stretch", region.ratio ? `${region.ratio.toFixed(4)}×` : "Derived"],
          ["Max residual", region.residualMs ? `${region.residualMs.toFixed(1)} ms` : "None reported"]
        ].forEach(([label, value]) => {
          const metric = document.createElement("div");
          const term = document.createElement("dt");
          const description = document.createElement("dd");
          term.textContent = label;
          description.textContent = value;
          metric.append(term, description);
          controls.append(metric);
        });
        if (region.note) {
          const note = document.createElement("p");
          note.textContent = region.note;
          card.append(heading, controls, note);
        } else card.append(heading, controls);
        dom.regionList.append(card);
      });
    }

    function collectRegions() {
      return proposalRegions();
    }

    function artifactMatching(pattern, contentType = "") {
      return assets.find((asset) => {
        const normalized = core.normalizeAsset(asset);
        return pattern.test(`${normalized.kind} ${normalized.variant}`)
          && (!contentType || normalized.contentType.includes(contentType));
      });
    }

    function tracksFromPublishedAssets() {
      const candidates = assets.filter((assetValue) => {
        const asset = core.normalizeAsset(assetValue);
        return /^(source_member|canonical|source_stem)$/i.test(asset.kind)
          && !/template|manifest|index/i.test(asset.variant);
      });
      const tracks = new Map();
      candidates.forEach((assetValue, index) => {
        const asset = core.normalizeAsset(assetValue, index);
        const metadata = asset.metadata || {};
        const track = core.normalizeTrack({
          ...metadata,
          assetId: asset.trackId || metadata.assetId || metadata.asset_id || asset.variant || asset.id,
          sha256: metadata.sha256 || asset.sha256,
          name: metadata.originalName || metadata.original_name || metadata.name || metadata.fileName || metadata.file_name
        }, index);
        if (!tracks.has(track.assetId) || asset.kind === "source_member") tracks.set(track.assetId, track);
      });
      return [...tracks.values()];
    }

    async function sha256(blob) {
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    }

    async function fetchArtifact(assetValue, { json = false } = {}) {
      const asset = core.normalizeAsset(assetValue);
      if (jsonArtifacts.has(asset.id)) return jsonArtifacts.get(asset.id);
      const signed = await cloud.signStemArtifact(job.id, asset.id, 900);
      const response = await fetch(signed.signedUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Artifact download failed (${response.status})`);
      const blob = await response.blob();
      if (asset.sha256 && crypto.subtle) {
        const actual = await sha256(blob);
        if (actual !== asset.sha256.toLowerCase()) throw new Error("Downloaded review artifact did not match its SHA-256");
      }
      const result = json ? JSON.parse(await blob.text()) : blob;
      jsonArtifacts.set(asset.id, result);
      return result;
    }

    async function hydrateReviewArtifacts(localGeneration) {
      if (!job || localGeneration !== generation) return;
      if (job.status === "awaiting_analysis_confirmation" && !job.tracks.length) {
        const manifest = artifactMatching(/run_manifest inspection|inspection run_manifest|inspection_manifest/i, "json");
        if (manifest) inspectionDocument = await fetchArtifact(manifest, { json: true });
        const publishedTracks = tracksFromPublishedAssets();
        if (!inspectionDocument && publishedTracks.length) rawJob = { ...rawJob, tracks: publishedTracks };
      }
      if (["awaiting_map_request", "proposal_queued", "proposing", "awaiting_tempo_confirmation"].includes(job.status) && !gridDocument) {
        const grid = artifactMatching(/\bgrid\b|tempo_grid|reviewed_grid/i, "json");
        if (grid) {
          gridDocument = await fetchArtifact(grid, { json: true });
          gridEvents = gridFromDocument(gridDocument);
          renderedGridFingerprint = "";
          gridSettingsInitialized = false;
        } else {
          const inlineGrid = job.analysis?.grid || job.analysis?.gridTemplate || job.analysis?.grid_template || job.analysis?.primary;
          if (gridFromDocument(inlineGrid).length) {
            gridDocument = { ...inlineGrid, analysis_sha256: inlineGrid.analysis_sha256 || job.analysisSha256 };
            gridEvents = gridFromDocument(gridDocument);
            renderedGridFingerprint = "";
            gridSettingsInitialized = false;
          }
        }
      }
      if (job.status === "awaiting_tempo_confirmation") {
        const proposal = artifactMatching(/proposal_manifest|tempo.*proposal|tempo.*approval/i, "json");
        if (proposal) proposalDocument = await fetchArtifact(proposal, { json: true });
        else if (!proposalDocument && Object.keys(job.proposal || {}).length) proposalDocument = job.proposal;
        await prepareClickAudition();
      }
      if (inspectionDocument) {
        rawJob = { ...rawJob, inspection: inspectionDocument };
      }
      job = core.normalizeJob(rawJob);
    }

    async function prepareClickAudition() {
      const rawAsset = artifactMatching(/\bclick\b|click_audition/i);
      if (!rawAsset) {
        dom.clickAudition.disabled = true;
        dom.clickAuditionCopy.textContent = "Click audition is not available yet";
        return;
      }
      const asset = core.normalizeAsset(rawAsset);
      if (clickAssetId === asset.id && dom.clickAudio.src) return;
      clearClick();
      const blob = await fetchArtifact(rawAsset);
      clickObjectUrl = URL.createObjectURL(blob);
      clickAssetId = asset.id;
      dom.clickAudio.src = clickObjectUrl;
      dom.clickAudition.disabled = false;
      dom.clickAuditionCopy.textContent = `${core.formatDuration(job.durationSeconds)} timing reference`;
    }

    function clearClick() {
      dom.clickAudio.pause();
      dom.clickAudio.removeAttribute("src");
      dom.clickAudio.load();
      if (clickObjectUrl) URL.revokeObjectURL(clickObjectUrl);
      clickObjectUrl = "";
      clickAssetId = "";
      clickPlayed = false;
      const confirmation = field("confirm-tempo-click");
      if (confirmation) {
        confirmation.checked = false;
        confirmation.disabled = true;
      }
      dom.clickAuditionIcon.textContent = "▶";
    }

    function updateProject() {
      if (!job?.projectId) return;
      const project = core.toStemProject(job, assets, currentProject());
      saveProject?.(project);
    }

    function render() {
      const status = job?.status || "";
      const retryableInspection = core.canRetryInspection(job);
      dom.uploadPanel.hidden = Boolean(job && !["uploading", "failed", "cancelled", "deleted"].includes(status));
      dom.processPanel.hidden = !job;
      dom.gateAPanel.hidden = status !== "awaiting_analysis_confirmation";
      dom.proposalPanel.hidden = status !== "awaiting_map_request";
      dom.gateBPanel.hidden = status !== "awaiting_tempo_confirmation";
      dom.readyPanel.hidden = status !== "ready";
      if (!job) return;

      if (!uploadController) dom.uploadButton.textContent = status === "uploading" ? "Resume upload" : "Upload and inspect";
      if (status === "uploading") {
        dom.uploadNote.textContent = "Choose the same ZIP to resume from the byte offset already confirmed by private storage.";
      }

      dom.processTitle.textContent = core.statusLabel(status);
      dom.processState.textContent = core.statusKind(status) === "waiting" ? "Needs you" : status === "ready" ? "Complete" : status === "failed" ? "Stopped" : "Live";
      dom.processState.dataset.kind = core.statusKind(status);
      dom.retryInspection.hidden = !retryableInspection;
      dom.cancelButton.hidden = ["ready", "failed", "cancelled", "deleted", "deletion_pending"].includes(status);
      const failureMessage = job.errorMessage || "Processing stopped. The recorded events remain available for review.";
      setError(status === "failed"
        ? `${failureMessage}${retryableInspection ? " Retry can reuse the original upload if it remains available." : ""}`
        : "");
      renderEvents();
      renderProgress();

      if (status === "awaiting_analysis_confirmation") {
        renderTracks();
        dom.approveAnalysis.disabled = !job.tracks.length;
      }
      if (status === "awaiting_map_request") {
        const suggested = Number(job.analysis?.medianBpm ?? job.analysis?.median_bpm ?? estimatedGridBpm() ?? job.targetBpm);
        if (Number.isFinite(suggested) && !dom.targetBpm.dataset.touched) dom.targetBpm.value = String(Math.round(suggested * 10) / 10);
        dom.requestProposal.disabled = !gridDocument;
        if (gridDocument) renderGrid();
        else {
          dom.gridIssue.hidden = false;
          dom.gridIssueCopy.textContent = "Loading the hash-bound analysis grid before this proposal can be requested.";
        }
      }
      if (status === "awaiting_tempo_confirmation") renderRegions();
      updateProject();
    }

    function schedulePoll(delay = 1500) {
      window.clearTimeout(pollingTimer);
      if (!job || ["ready", "failed", "cancelled", "deleted"].includes(job.status)) return;
      const localGeneration = generation;
      pollingTimer = window.setTimeout(() => poll(localGeneration), delay);
    }

    function currentDispatchKey() {
      if (!job || !queuedStatuses.has(job.status)) return "";
      return [job.id, job.activeAttemptId || job.revision, job.status].join(":");
    }

    function observeDispatch(response) {
      const key = currentDispatchKey();
      if (!key) {
        dispatchSatisfiedKey = "";
        dispatchRetryAt = 0;
        dispatchRetryDelay = 1500;
        return;
      }
      if (response?.dispatch?.state === "submitted") {
        dispatchSatisfiedKey = key;
        dispatchRetryAt = 0;
        dispatchRetryDelay = 1500;
      } else if (response?.dispatch?.state === "pending") {
        dispatchSatisfiedKey = "";
        dispatchRetryAt = Date.now() + dispatchRetryDelay;
        dispatchRetryDelay = Math.min(30_000, dispatchRetryDelay * 2);
      }
    }

    async function ensureQueuedDispatch(localGeneration) {
      const key = currentDispatchKey();
      if (!key || key === dispatchSatisfiedKey || dispatchInFlight || Date.now() < dispatchRetryAt) return;
      const operation = cloud.dispatchStemImport(job.id);
      dispatchInFlight = operation;
      try {
        const response = await operation;
        if (localGeneration !== generation || !response?.job) return;
        rawJob = response.job;
        job = core.normalizeJob(rawJob);
        observeDispatch(response);
        render();
      } catch (error) {
        if (localGeneration !== generation) return;
        dispatchRetryAt = Date.now() + dispatchRetryDelay;
        dispatchRetryDelay = Math.min(30_000, dispatchRetryDelay * 2);
        setError(friendlyError(error));
      } finally {
        if (dispatchInFlight === operation) dispatchInFlight = null;
      }
    }

    async function poll(localGeneration = generation) {
      if (!job?.id || localGeneration !== generation || !getUser?.()) return;
      try {
        const snapshot = await cloud.getStemImport(job.id, { afterSequence: lastSequence });
        if (localGeneration !== generation) return;
        rawJob = snapshot.job;
        job = core.normalizeJob(rawJob);
        const nextEvents = (snapshot.events || []).map(core.normalizeEvent);
        const bySequence = new Map(events.map((event) => [event.sequence, event]));
        nextEvents.forEach((event) => bySequence.set(event.sequence, event));
        events = Array.from(bySequence.values()).sort((left, right) => left.sequence - right.sequence);
        lastSequence = events.at(-1)?.sequence || lastSequence;
        assets = snapshot.assets || assets;
        await hydrateReviewArtifacts(localGeneration);
        if (localGeneration !== generation) return;
        render();
        await ensureQueuedDispatch(localGeneration);
        schedulePoll();
      } catch (error) {
        if (localGeneration !== generation) return;
        setError(friendlyError(error));
        if (error?.code === "stale_revision") schedulePoll(150);
        else schedulePoll(3500);
      }
    }

    function adoptResponse(response) {
      if (!response?.job) return;
      rawJob = response.job;
      job = core.normalizeJob(rawJob);
      observeDispatch(response);
      render();
      schedulePoll(100);
    }

    function uploadContractForJob() {
      if (uploadInstructions) return uploadInstructions;
      if (!job?.sourceBucket || !job?.sourceObjectPath) return null;
      const projectUrl = String(window.OPUSLOOPS_CONFIG?.supabaseUrl || "").replace(/\/$/, "");
      try {
        const projectHost = new URL(projectUrl).hostname.split(".")[0];
        return {
          endpoint: `https://${projectHost}.storage.supabase.co/storage/v1/upload/resumable`,
          bucketName: job.sourceBucket,
          objectName: job.sourceObjectPath,
          chunkSize: 6 * 1024 * 1024
        };
      } catch {
        return null;
      }
    }

    async function transferAndFinalize(file, upload) {
      uploadController = new AbortController();
      uploadProgress = { completed: 0, total: file.size };
      render();
      setBusy(dom.uploadButton, true, "Uploading…");
      await cloud.uploadStemArchive({
        file,
        upload,
        jobId: job.id,
        signal: uploadController.signal,
        onProgress(completed, total) {
          uploadProgress = { completed, total };
          renderProgress();
        }
      });
      setBusy(dom.uploadButton, true, "Finalizing upload…");
      const finalized = await cloud.finalizeStemUpload(job.id, job.revision);
      cloud.forgetStemArchiveUpload({ file, upload, jobId: job.id });
      uploadProgress = null;
      uploadInstructions = null;
      adoptResponse(finalized);
      showToast?.("Upload complete. Inspection has started");
    }

    async function beginUpload() {
      if (!getUser?.()) {
        openSignIn?.();
        showToast?.("Sign in to keep imported stems private");
        return;
      }
      const file = selectedFile || dom.fileInput.files?.[0];
      if (!file || !/\.zip$/i.test(file.name)) {
        showToast?.("Choose a ZIP file of stems");
        dom.fileInput.focus();
        return;
      }
      if (file.size <= 0) {
        showToast?.("That ZIP is empty");
        return;
      }
      selectedFile = file;
      let preparedProjectId = "";
      try {
        if (job?.status === "uploading") {
          if ((job.sourceName && file.name !== job.sourceName) || (job.sourceBytes && file.size !== job.sourceBytes)) {
            throw new Error("Choose the same ZIP originally assigned to this import");
          }
          const upload = uploadContractForJob();
          if (!upload) throw new Error("Upload details are still loading. Try again in a moment");
          await transferAndFinalize(file, upload);
          return;
        }
        stop({ preserveJob: false });
        const projectId = makeId();
        preparedProjectId = projectId;
        setBusy(dom.uploadButton, true, "Saving private project…");
        await prepareProject?.({ projectId, file });
        setBusy(dom.uploadButton, true, "Creating private import…");
        const created = await cloud.createStemImport({ projectId, file });
        uploadInstructions = created.upload;
        rawJob = { ...created.job, sourceName: file.name, sourceBytes: file.size };
        job = core.normalizeJob(rawJob);
        saveProject?.(core.toStemProject(job, [], findProject?.(projectId)));
        showView?.("import");
        await transferAndFinalize(file, created.upload);
      } catch (error) {
        if (!job && preparedProjectId) discardProject?.(preparedProjectId);
        setError(friendlyError(error));
        if (error?.code === "stale_revision" && job) schedulePoll(100);
      } finally {
        uploadController = null;
        setBusy(dom.uploadButton, false);
        if (job?.status === "uploading") dom.uploadButton.textContent = "Resume upload";
      }
    }

    async function approveAnalysis() {
      if (!job || !allConfirmed(gateAConfirmationIds)) {
        showToast?.("Confirm all four file-review items first");
        return;
      }
      try {
        const selection = core.analysisSelection(job, collectTracks(), dom.referenceMethod.value);
        setBusy(dom.approveAnalysis, true, "Recording approval…");
        const response = await cloud.approveStemAnalysis({
          jobId: job.id,
          revision: job.revision,
          inspectionManifestSha256: job.inspectionManifestSha256,
          selection,
          confirmations: { files: true, roles: true, reference: true, originalsUnchanged: true }
        });
        resetConfirmations(gateAConfirmationIds);
        adoptResponse(response);
      } catch (error) {
        setError(friendlyError(error));
        if (error?.code === "stale_revision") schedulePoll(100);
      } finally {
        setBusy(dom.approveAnalysis, false);
      }
    }

    async function retryInspection() {
      if (!job || !core.canRetryInspection(job)) return;
      const localGeneration = generation;
      try {
        setBusy(dom.retryInspection, true, "Retrying inspection…");
        const response = await cloud.retryStemInspection(job.id, job.revision);
        if (localGeneration !== generation) return;
        adoptResponse(response);
        showToast?.("Inspection restarted using your original upload");
      } catch (error) {
        if (localGeneration !== generation) return;
        setError(friendlyError(error));
        window.setTimeout(() => poll(localGeneration), 100);
      } finally {
        setBusy(dom.retryInspection, false);
      }
    }

    async function requestProposal() {
      if (!job) return;
      try {
        const meterNumerator = Math.trunc(Number(dom.meterNumerator.value));
        const meterDenominator = Math.trunc(Number(dom.meterDenominator.value));
        const grid = reviewedGrid();
        const firstDownbeatSeconds = grid.downbeats_seconds[0];
        if (!Number.isInteger(meterNumerator) || meterNumerator < 1 || meterNumerator > 32) {
          throw new Error("Choose 1 to 32 beats per bar");
        }
        if (![1, 2, 4, 8, 16, 32].includes(meterDenominator)) throw new Error("Choose a valid beat unit");
        if (!Number.isFinite(firstDownbeatSeconds) || firstDownbeatSeconds < 0) throw new Error("Choose a valid first downbeat");
        const request = core.proposalRequest(dom.targetBpm.value, dom.conformMode.value, grid);
        setBusy(dom.requestProposal, true, "Building request…");
        const response = await cloud.requestStemProposal({
          jobId: job.id,
          revision: job.revision,
          analysisSha256: job.analysisSha256,
          proposalId: `mobile-${Date.now().toString(36)}-${makeId().slice(0, 8)}`,
          targetBpm: request.targetBpm,
          mode: request.mode,
          reviewedGrid: request.reviewedGrid,
          meterNumerator,
          meterDenominator,
          firstDownbeatSeconds
        });
        adoptResponse(response);
      } catch (error) {
        setError(friendlyError(error));
        if (error?.code === "stale_revision") schedulePoll(100);
      } finally {
        setBusy(dom.requestProposal, false);
        if (!gridDocument) dom.requestProposal.disabled = true;
      }
    }

    async function approveTempo() {
      if (!job || !allConfirmed(gateBConfirmationIds)) {
        showToast?.("Confirm each listening and timing item first");
        return;
      }
      try {
        const regions = core.editedRegions(collectRegions());
        setBusy(dom.approveTempo, true, "Recording approval…");
        const response = await cloud.approveStemTempo({
          jobId: job.id,
          revision: job.revision,
          proposalManifestSha256: job.proposalManifestSha256,
          approval: {
            proposalId: proposalDocument?.proposal_id || proposalDocument?.proposalId || job.proposal?.proposalId || job.proposal?.proposal_id,
            reviewedRegions: regions
          },
          confirmations: {
            click: true,
            beatGrid: true,
            meterDownbeat: true,
            tempoOctave: true,
            flags: true,
            target: true,
            sharedMap: true,
            originalsUnchanged: true
          }
        });
        resetConfirmations(gateBConfirmationIds);
        adoptResponse(response);
      } catch (error) {
        setError(friendlyError(error));
        if (error?.code === "stale_revision") schedulePoll(100);
      } finally {
        setBusy(dom.approveTempo, false);
      }
    }

    async function cancel() {
      if (!job || !window.confirm("Cancel this import? Uploaded source files will follow the server retention policy.")) return;
      uploadController?.abort();
      try {
        setBusy(dom.cancelButton, true, "Cancelling…");
        const response = await cloud.cancelStemImport(job.id, job.revision);
        adoptResponse(response);
      } catch (error) {
        setError(friendlyError(error));
      } finally {
        setBusy(dom.cancelButton, false);
      }
    }

    function stop({ preserveJob = true } = {}) {
      generation += 1;
      window.clearTimeout(pollingTimer);
      pollingTimer = 0;
      uploadController?.abort();
      uploadController = null;
      dispatchInFlight = null;
      dispatchSatisfiedKey = "";
      dispatchRetryAt = 0;
      dispatchRetryDelay = 1500;
      clearClick();
      if (!preserveJob) {
        rawJob = null;
        job = null;
        assets = [];
        events = [];
        lastSequence = 0;
        uploadInstructions = null;
        uploadProgress = null;
        inspectionDocument = null;
        gridDocument = null;
        proposalDocument = null;
        gridEvents = [];
        gridDirty = false;
        gridSettingsInitialized = false;
        delete dom.targetBpm.dataset.touched;
        jsonArtifacts.clear();
        renderedTrackFingerprint = "";
        renderedGridFingerprint = "";
        renderedRegionFingerprint = "";
      }
    }

    function resumeProject(project) {
      const stem = project?.kind === "stem-import" ? project.stemImport : null;
      if (!stem?.jobId || !getUser?.()) return;
      if (job?.id === stem.jobId) {
        render();
        schedulePoll(0);
        return;
      }
      stop({ preserveJob: false });
      rawJob = {
        id: stem.jobId,
        projectId: project.id,
        status: stem.status,
        revision: stem.revision,
        targetBpm: project.tempo,
        mode: stem.mode,
        durationSeconds: stem.durationSeconds,
        tracks: stem.tracks,
        inspectionManifestSha256: stem.inspectionManifestSha256,
        analysisSha256: stem.analysisSha256,
        proposalManifestSha256: stem.proposalManifestSha256
      };
      job = core.normalizeJob(rawJob);
      assets = stem.previewAssets || [];
      generation += 1;
      render();
      poll(generation);
    }

    function accountChanged() {
      stop({ preserveJob: false });
      render();
    }

    dom.fileInput.addEventListener("change", () => {
      selectedFile = dom.fileInput.files?.[0] || null;
      dom.fileName.textContent = selectedFile ? `${selectedFile.name} · ${core.formatBytes(selectedFile.size)}` : "No file selected";
      dom.uploadNote.textContent = selectedFile
        ? "Ready for a private resumable upload. Closing this page may require choosing the same file again."
        : "Byte progress comes from the resumable transfer; the service confirms every completed chunk.";
    });
    dom.uploadButton.addEventListener("click", beginUpload);
    dom.retryInspection.addEventListener("click", retryInspection);
    dom.referenceMethod.addEventListener("change", selectFullMixReference);
    dom.approveAnalysis.addEventListener("click", approveAnalysis);
    dom.requestProposal.addEventListener("click", requestProposal);
    dom.approveTempo.addEventListener("click", approveTempo);
    dom.cancelButton.addEventListener("click", cancel);
    dom.targetBpm.addEventListener("input", () => { dom.targetBpm.dataset.touched = "true"; });
    [dom.meterNumerator, dom.meterDenominator, dom.firstDownbeat].forEach((input) => {
      input.addEventListener("input", () => {
        gridDirty = true;
        renderGridIssues();
      });
      input.addEventListener("change", () => {
        renderedGridFingerprint = "";
        renderGrid();
      });
    });
    dom.gridEventList.addEventListener("input", () => { syncGridFromDom(); });
    dom.gridEventList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-grid-event]");
      if (!button) return;
      syncGridFromDom();
      gridEvents = gridEvents.filter((item) => item.id !== button.dataset.removeGridEvent);
      gridDirty = true;
      renderedGridFingerprint = "";
      renderGrid();
    });
    dom.addGridEvent.addEventListener("click", () => {
      syncGridFromDom();
      const lastTime = gridEvents.at(-1)?.time || 0;
      gridEvents.push({ id: `manual-${Date.now().toString(36)}`, time: lastTime + 0.5, downbeat: false });
      gridDirty = true;
      renderedGridFingerprint = "";
      renderGrid();
      dom.gridEventList.lastElementChild?.querySelector("input")?.focus();
    });
    dom.clickAudition.addEventListener("click", async () => {
      try {
        if (!dom.clickAudio.src) await prepareClickAudition();
        if (dom.clickAudio.paused) await dom.clickAudio.play();
        else dom.clickAudio.pause();
      } catch (error) {
        setError(friendlyError(error));
      }
    });
    dom.clickAudio.addEventListener("play", () => {
      dom.clickAuditionIcon.textContent = "Ⅱ";
      dom.clickAuditionCopy.textContent = "Click audition playing";
    });
    dom.clickAudio.addEventListener("pause", () => {
      dom.clickAuditionIcon.textContent = "▶";
      if (clickPlayed) dom.clickAuditionCopy.textContent = "Listened · replay the timing reference";
    });
    dom.clickAudio.addEventListener("timeupdate", () => {
      if (clickPlayed || dom.clickAudio.currentTime < 0.25) return;
      clickPlayed = true;
      const confirmation = field("confirm-tempo-click");
      if (confirmation) confirmation.disabled = false;
    });
    dom.openReady.addEventListener("click", () => showView?.("studio"));

    field("confirm-tempo-click").disabled = true;

    return Object.freeze({ accountChanged, resumeProject, stop });
  }

  window.OpusloopsStemImport = Object.freeze({ create });
})();
