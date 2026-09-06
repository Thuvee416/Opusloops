(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OpusloopsStemCore = Object.freeze(api);
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const ACTIVE_STATUSES = new Set([
    "uploading",
    "uploaded",
    "inspect_queued",
    "inspecting",
    "analysis_queued",
    "analyzing",
    "proposal_queued",
    "proposing",
    "render_queued",
    "rendering",
    "deletion_pending"
  ]);
  const WAITING_STATUSES = new Set([
    "awaiting_analysis_confirmation",
    "awaiting_map_request",
    "awaiting_tempo_confirmation"
  ]);
  const TERMINAL_STATUSES = new Set(["ready", "failed", "cancelled", "deleted"]);
  const RETRYABLE_INSPECTION_ERRORS = new Set([
    "batch_bootstrap_failed",
    "batch_queue_timeout"
  ]);
  const ROLES = Object.freeze([
    "drums",
    "bass",
    "vocals",
    "guitar",
    "keys",
    "synth",
    "percussion",
    "fx",
    "full-mix",
    "other"
  ]);
  const MODES = Object.freeze(["musical-4bar", "rigid-beat", "no-conform"]);

  function pick(object, ...names) {
    if (!object || typeof object !== "object") return undefined;
    for (const name of names) {
      if (object[name] !== undefined && object[name] !== null) return object[name];
    }
    return undefined;
  }

  function pickNullable(object, ...names) {
    if (!object || typeof object !== "object") return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(object, name) && object[name] !== undefined) {
        return object[name];
      }
    }
    return undefined;
  }

  function parseObject(value, fallback = null) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function finiteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function boundedString(value, maximum = 500) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
  }

  function timingSeconds(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400
      ? value
      : null;
  }

  function normalizeStatus(value) {
    const status = boundedString(value, 80).toLowerCase().replace(/[ -]+/g, "_");
    const aliases = {
      awaiting_analysis_approval: "awaiting_analysis_confirmation",
      analysis_ready_for_review: "awaiting_map_request",
      awaiting_map_approval: "awaiting_tempo_confirmation",
      awaiting_tempo_map_approval: "awaiting_tempo_confirmation",
      complete: "ready",
      completed: "ready",
      canceled: "cancelled"
    };
    return aliases[status] || status || "uploading";
  }

  function statusLabel(statusValue) {
    const status = normalizeStatus(statusValue);
    const labels = {
      uploading: "Uploading source ZIP",
      uploaded: "Upload received",
      inspect_queued: "Inspection queued",
      inspecting: "Inspecting and decoding stems",
      awaiting_analysis_confirmation: "File review required",
      analysis_queued: "Analysis queued",
      analyzing: "Analyzing musical timing",
      awaiting_map_request: "Choose a target tempo",
      proposal_queued: "Tempo proposal queued",
      proposing: "Building tempo proposal",
      awaiting_tempo_confirmation: "Tempo review required",
      render_queued: "Render queued",
      rendering: "Rendering aligned previews",
      ready: "Ready to arrange",
      failed: "Processing failed",
      cancelled: "Import cancelled",
      deletion_pending: "Removing import files",
      deleted: "Import removed"
    };
    return labels[status] || status.replace(/_/g, " ");
  }

  function statusKind(statusValue) {
    const status = normalizeStatus(statusValue);
    if (ACTIVE_STATUSES.has(status)) return "active";
    if (WAITING_STATUSES.has(status)) return "waiting";
    if (TERMINAL_STATUSES.has(status)) return "terminal";
    return "unknown";
  }

  function statusBadgeLabel(statusValue) {
    const status = normalizeStatus(statusValue);
    if (WAITING_STATUSES.has(status)) return "Needs you";
    if (status === "ready") return "Complete";
    if (status === "deleted") return "Removed";
    if (status === "failed" || status === "cancelled") return "Stopped";
    if (ACTIVE_STATUSES.has(status)) return "Live";
    return "Status";
  }

  function median(values) {
    const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!ordered.length) return null;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  function normalizeTimingEvents(eventsValue) {
    if (!Array.isArray(eventsValue)) return [];
    return eventsValue
      .map((event, index) => ({
        id: boundedString(event?.id, 200) || `beat-${index + 1}`,
        time: timingSeconds(event?.time),
        downbeat: event?.downbeat === true,
        sourceIndex: index
      }))
      .filter((event) => event.time !== null && event.time >= 0 && event.time <= 86_400)
      .sort((left, right) => left.time - right.time || left.sourceIndex - right.sourceIndex)
      .map(({ sourceIndex, ...event }) => event);
  }

  function timingGridDiagnostics(eventsValue, {
    meterNumerator = 4,
    firstDownbeatSeconds = null,
    minimumDownbeats = 2,
    requireFullDownbeatCoverage = true,
    requireStableBeatContinuity = true
  } = {}) {
    const sourceLength = Array.isArray(eventsValue) ? eventsValue.length : 0;
    const events = normalizeTimingEvents(eventsValue);
    const messages = [];
    const flaggedIds = new Set();
    const meter = Math.trunc(finiteNumber(meterNumerator, 0));
    if (events.length !== sourceLength) messages.push("Every timing event needs a valid non-negative time.");
    if (events.length < 2) messages.push("At least two beat events are required.");
    if (!Number.isInteger(meter) || meter < 1 || meter > 32) {
      messages.push("Beats per bar must be a whole number from 1 to 32.");
    }

    const gaps = events.slice(1).map((event, index) => event.time - events[index].time);
    const beatSeconds = median(gaps.filter((gap) => gap > 0.02 && gap < 3));
    const duplicateTolerance = beatSeconds === null
      ? 0.025
      : Math.min(0.2, Math.max(0.025, beatSeconds * 0.4));
    for (let index = 1; index < events.length; index += 1) {
      const gap = events[index].time - events[index - 1].time;
      if (gap < duplicateTolerance) {
        messages.push(`Events at ${events[index - 1].time.toFixed(2)}s and ${events[index].time.toFixed(2)}s are too close together.`);
        flaggedIds.add(events[index - 1].id);
        flaggedIds.add(events[index].id);
      } else if (requireStableBeatContinuity && beatSeconds !== null && gap > beatSeconds * 1.6) {
        messages.push(`A likely beat is missing between ${events[index - 1].time.toFixed(2)}s and ${events[index].time.toFixed(2)}s.`);
        flaggedIds.add(events[index - 1].id);
        flaggedIds.add(events[index].id);
      }
    }

    const downbeats = events
      .map((event, index) => ({ ...event, index }))
      .filter((event) => event.downbeat);
    const requiredDownbeats = Math.max(1, Math.trunc(finiteNumber(minimumDownbeats, 2)));
    if (downbeats.length < requiredDownbeats) {
      messages.push(`At least ${requiredDownbeats} reliable bar ${requiredDownbeats === 1 ? "start is" : "starts are"} required.`);
    }
    if (Number.isInteger(meter) && meter >= 1 && meter <= 32) {
      for (let index = 1; index < downbeats.length; index += 1) {
        const span = downbeats[index].index - downbeats[index - 1].index;
        if (span !== meter) {
          messages.push(`A detected bar contains ${span} beat ${span === 1 ? "event" : "events"}; ${meter} are expected.`);
          flaggedIds.add(downbeats[index - 1].id);
          flaggedIds.add(downbeats[index].id);
        }
      }
      const finalDownbeat = downbeats.at(-1);
      if (requireFullDownbeatCoverage && finalDownbeat && events.length - finalDownbeat.index > meter) {
        messages.push("Detected bar starts do not cover the full song.");
        flaggedIds.add(finalDownbeat.id);
      }
    }

    const first = firstDownbeatSeconds === null || firstDownbeatSeconds === undefined
      ? null
      : finiteNumber(firstDownbeatSeconds);
    if (first !== null && first < 0) messages.push("First downbeat must be a non-negative time in seconds.");
    else if (first !== null && downbeats.length && Math.abs(downbeats[0].time - first) > 0.0005) {
      messages.push("First downbeat must match the first detected bar start.");
    }
    return {
      messages: Array.from(new Set(messages)),
      flaggedIds: [...flaggedIds],
      medianBeatSeconds: beatSeconds,
      estimatedBpm: beatSeconds ? 60 / beatSeconds : null
    };
  }

  function autoRepairTimingGrid(eventsValue, { meterNumerator = 4 } = {}) {
    const source = normalizeTimingEvents(eventsValue);
    const original = source.map((event) => ({ ...event }));
    const meter = Math.trunc(finiteNumber(meterNumerator, 0));
    const noChange = (reason = "") => ({
      status: reason ? "ambiguous" : "clean",
      events: original.map((event) => ({ ...event })),
      summary: {
        algorithm: "opusloops-bar-grid-v1",
        removedBeats: 0,
        insertedBeats: 0,
        downbeatCorrections: 0,
        totalEdits: 0,
        estimatedBpm: null,
        reason
      }
    });
    if (source.length !== (Array.isArray(eventsValue) ? eventsValue.length : 0)
        || source.length < 2 || !Number.isInteger(meter) || meter < 1 || meter > 32) {
      return noChange("The detected grid is incomplete.");
    }
    if (source.length > 20_000 || source.filter((event) => event.downbeat).length > 5_000) {
      return noChange("The detected grid is too large for a safe browser review.");
    }

    const initialDownbeat = source.find((event) => event.downbeat)?.time ?? null;
    const initialDiagnostics = timingGridDiagnostics(source, {
      meterNumerator: meter,
      firstDownbeatSeconds: initialDownbeat
    });
    const beatSeconds = initialDiagnostics.medianBeatSeconds;
    if (!beatSeconds || beatSeconds < 0.08 || beatSeconds > 3) {
      return noChange("A stable beat interval could not be established.");
    }
    if (!initialDiagnostics.messages.length) {
      const result = noChange();
      result.summary.estimatedBpm = 60 / beatSeconds;
      return result;
    }

    const rawDownbeats = source.filter((event) => event.downbeat);
    if (rawDownbeats.length < 2) return noChange("At least two reliable bar starts are needed.");
    const expectedBarSeconds = beatSeconds * meter;
    const barGaps = rawDownbeats.slice(1).map((event, index) => event.time - rawDownbeats[index].time);
    const plausibleBarGaps = barGaps.filter((gap) =>
      gap > expectedBarSeconds * 0.6 && gap < expectedBarSeconds * 1.5
    );
    const barSeconds = median(plausibleBarGaps) || median(barGaps);
    if (!barSeconds) return noChange("A stable bar interval could not be established.");

    const acceptedDownbeats = [];
    const closeBarTolerance = Math.max(0.25, barSeconds * 0.45);
    for (let index = 0; index < rawDownbeats.length;) {
      let end = index;
      while (end + 1 < rawDownbeats.length
          && rawDownbeats[end + 1].time - rawDownbeats[end].time < closeBarTolerance) end += 1;
      if (end === index) {
        acceptedDownbeats.push(rawDownbeats[index]);
        index += 1;
        continue;
      }
      if (end - index > 2 || index === 0 || end === rawDownbeats.length - 1) {
        return noChange("Competing bar starts could not be resolved safely.");
      }
      const previous = rawDownbeats[index - 1].time;
      const next = rawDownbeats[end + 1].time;
      const scored = rawDownbeats.slice(index, end + 1)
        .map((candidate) => ({
          candidate,
          score: Math.abs(candidate.time - previous - barSeconds)
            + Math.abs(next - candidate.time - barSeconds)
        }))
        .sort((left, right) => left.score - right.score || left.candidate.time - right.candidate.time);
      const downbeatDecisionMargin = Math.max(0.02, beatSeconds * 0.04);
      if (scored.length > 1
          && Math.abs(scored[0].score - scored[1].score) <= downbeatDecisionMargin + 1e-9) {
        return noChange("Two bar-start candidates are equally plausible.");
      }
      acceptedDownbeats.push(scored[0].candidate);
      index = end + 1;
    }

    while (acceptedDownbeats.length >= 2) {
      const right = acceptedDownbeats.at(-1);
      const left = acceptedDownbeats.at(-2);
      const beatsInBar = source.filter((event) => event.time >= left.time - 0.000001
        && event.time < right.time - 0.000001).length;
      if (right.time - left.time >= barSeconds * 0.82 || beatsInBar >= meter) break;
      acceptedDownbeats.pop();
    }
    if (acceptedDownbeats.length < 2) return noChange("Too few complete bars remain after validation.");

    const result = [];
    const keptIds = new Set();
    let insertedBeats = 0;
    const append = (event) => {
      if (keptIds.has(event.id)) return;
      keptIds.add(event.id);
      result.push({ ...event });
    };
    source.filter((event) => event.time < acceptedDownbeats[0].time - 0.000001)
      .forEach((event) => append({ ...event, downbeat: false }));

    for (let barIndex = 0; barIndex < acceptedDownbeats.length - 1; barIndex += 1) {
      const left = acceptedDownbeats[barIndex];
      const right = acceptedDownbeats[barIndex + 1];
      const slotSeconds = (right.time - left.time) / meter;
      if (slotSeconds < beatSeconds * 0.55 || slotSeconds > beatSeconds * 1.6) {
        return noChange("One bar changes too sharply for an automatic correction.");
      }
      append({ ...left, downbeat: true });
      const candidates = source.filter((event) =>
        event.time > left.time + 0.000001 && event.time < right.time - 0.000001
      );
      const used = new Set();
      let barInsertions = 0;
      for (let slot = 1; slot < meter; slot += 1) {
        const expected = left.time + slotSeconds * slot;
        const ranked = candidates
          .filter((candidate) => !used.has(candidate.id))
          .map((candidate) => ({ candidate, distance: Math.abs(candidate.time - expected) }))
          .sort((a, b) => a.distance - b.distance || a.candidate.time - b.candidate.time);
        if (ranked[0] && ranked[0].distance <= slotSeconds * 0.35) {
          const beatDecisionMargin = Math.max(0.02, slotSeconds * 0.04);
          if (ranked[1]
              && Math.abs(ranked[0].distance - ranked[1].distance) <= beatDecisionMargin + 1e-9) {
            return noChange("Two beat candidates are equally plausible.");
          }
          used.add(ranked[0].candidate.id);
          append({ ...ranked[0].candidate, downbeat: false });
        } else {
          barInsertions += 1;
          if (barInsertions > 1) return noChange("A bar is missing more than one reliable beat.");
          insertedBeats += 1;
          append({
            id: `auto-bar-${barIndex + 1}-${slot}`,
            time: Number(expected.toFixed(6)),
            downbeat: false
          });
        }
      }
      const removals = candidates.filter((candidate) => !used.has(candidate.id)).length;
      if (removals > 2) return noChange("A bar contains too many competing beat candidates.");
    }

    const lastDownbeat = acceptedDownbeats.at(-1);
    append({ ...lastDownbeat, downbeat: true });
    const tail = source.filter((event) => event.time > lastDownbeat.time + 0.000001);
    let previousTime = lastDownbeat.time;
    tail.forEach((event, index) => {
      const gap = event.time - previousTime;
      const slots = Math.round(gap / beatSeconds);
      if ((slots === 2 || slots === 3)
          && Math.abs(gap / slots - beatSeconds) <= beatSeconds * 0.12) {
        for (let slot = 1; slot < slots; slot += 1) {
          insertedBeats += 1;
          append({
            id: `auto-tail-${index + 1}-${slot}`,
            time: Number((previousTime + (gap * slot) / slots).toFixed(6)),
            downbeat: false
          });
        }
      }
      append({ ...event, downbeat: false });
      previousTime = event.time;
    });

    result.sort((left, right) => left.time - right.time || left.id.localeCompare(right.id));
    const resultIds = new Set(result.map((event) => event.id));
    const removedBeats = source.filter((event) => !resultIds.has(event.id)).length;
    const acceptedTimes = acceptedDownbeats.map((event) => event.time);
    const downbeatCorrections = source.filter((event) => event.downbeat
      && !acceptedTimes.some((time) => Math.abs(time - event.time) < 0.000001)
      && resultIds.has(event.id)).length;
    const totalEdits = removedBeats + insertedBeats + downbeatCorrections;
    const editLimit = Math.max(8, Math.ceil(source.length * 0.03));
    if (totalEdits > editLimit) return noChange("The grid needs more changes than the automatic safety limit allows.");
    if (result.length > 20_000 || result.filter((event) => event.downbeat).length > 5_000) {
      return noChange("The corrected grid is too large for a safe browser review.");
    }

    const repairedFirstDownbeat = result.find((event) => event.downbeat)?.time ?? null;
    const finalDiagnostics = timingGridDiagnostics(result, {
      meterNumerator: meter,
      firstDownbeatSeconds: repairedFirstDownbeat
    });
    if (finalDiagnostics.messages.length) {
      return noChange("The automatic timing pass could not produce one unambiguous grid.");
    }
    return {
      status: totalEdits ? "repaired" : "clean",
      events: result.map((event) => ({ ...event })),
      summary: {
        algorithm: "opusloops-bar-grid-v1",
        removedBeats,
        insertedBeats,
        downbeatCorrections,
        totalEdits,
        estimatedBpm: finalDiagnostics.estimatedBpm,
        reason: ""
      }
    };
  }

  function canRetryInspection(jobValue) {
    const job = normalizeJob(jobValue);
    return job.status === "failed" && RETRYABLE_INSPECTION_ERRORS.has(job.errorCode);
  }

  function normalizeEvent(raw) {
    const determinate = pick(raw, "determinate") === true;
    const completed = finiteNumber(pick(raw, "completed"));
    const total = finiteNumber(pick(raw, "total"));
    const sequence = Math.max(0, Math.trunc(finiteNumber(pick(raw, "sequence"), 0)));
    return {
      sequence,
      attemptId: boundedString(pick(raw, "attemptId", "attempt_id"), 200),
      stage: boundedString(pick(raw, "stage"), 100),
      status: boundedString(pick(raw, "status"), 40),
      determinate: Boolean(determinate && completed !== null && total !== null && total > 0),
      completed,
      total,
      unit: boundedString(pick(raw, "unit"), 40),
      detail: parseObject(pick(raw, "detail", "details"), {}),
      createdAt: boundedString(pick(raw, "createdAt", "created_at"), 80)
    };
  }

  function eventProgress(eventValue) {
    const event = normalizeEvent(eventValue);
    if (!event.determinate) return null;
    const completed = Math.max(0, Math.min(event.completed, event.total));
    return {
      completed,
      total: event.total,
      unit: event.unit,
      percent: (completed / event.total) * 100
    };
  }

  function formatBytes(value) {
    const bytes = Math.max(0, finiteNumber(value, 0));
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let amount = bytes;
    let unit = -1;
    do {
      amount /= 1024;
      unit += 1;
    } while (amount >= 1024 && unit < units.length - 1);
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[unit]}`;
  }

  function formatDuration(value) {
    const seconds = Math.max(0, finiteNumber(value, 0));
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function normalizeTrack(raw, index = 0) {
    const metadata = parseObject(pick(raw, "metadata"), {});
    const source = { ...metadata, ...(raw && typeof raw === "object" ? raw : {}) };
    const assetId = boundedString(pick(source, "assetId", "asset_id", "id"), 200) || `stem-${index + 1}`;
    const roleValue = boundedString(pick(source, "role"), 30).toLowerCase();
    const role = ROLES.includes(roleValue) ? roleValue : "other";
    return {
      assetId,
      name: boundedString(pick(source, "originalName", "original_name", "name", "fileName", "file_name"), 220) || `Stem ${index + 1}`,
      role,
      included: pick(source, "included") !== false,
      gainDb: Math.max(-120, Math.min(24, finiteNumber(pick(source, "gainDb", "gain_db"), 0))),
      sha256: boundedString(pick(source, "sha256"), 64).toLowerCase(),
      durationSeconds: Math.max(0, finiteNumber(pick(source, "durationSeconds", "duration_seconds", "duration"), 0)),
      channels: Math.max(0, Math.trunc(finiteNumber(pick(source, "channels"), 0))),
      sampleRate: Math.max(0, Math.trunc(finiteNumber(pick(source, "sampleRate", "sample_rate"), 0))),
      muted: Boolean(pick(source, "muted")),
      volume: Math.max(0, Math.min(1, finiteNumber(pick(source, "volume"), 1))),
      color: boundedString(pick(source, "color"), 30)
    };
  }

  function normalizeRegion(raw, index = 0) {
    const regionIndex = Math.max(0, Math.trunc(finiteNumber(pick(raw, "index", "regionIndex", "region_index"), index)));
    const bars = Math.max(1, Math.trunc(finiteNumber(pick(raw, "bars", "barCount", "bar_count"), 4)));
    const startBar = Math.max(1, Math.trunc(finiteNumber(pick(raw, "startBar", "start_bar"), regionIndex * bars + 1)));
    const endBar = Math.max(startBar, Math.trunc(finiteNumber(pick(raw, "endBar", "end_bar"), startBar + bars - 1)));
    const ratio = Math.max(0, finiteNumber(pick(raw, "outputPerInputRatio", "output_per_input_ratio", "stretchRatio", "stretch_ratio"), 0));
    const residualMs = Math.max(0, finiteNumber(pick(raw, "maxInternalResidualMs", "max_internal_residual_ms", "residualMs", "residual_ms"), 0));
    const rawTargetBpm = pickNullable(raw, "targetBpm", "target_bpm");
    const targetBpm = rawTargetBpm === null
      ? null
      : Math.max(20, Math.min(400, finiteNumber(rawTargetBpm, 120)));
    return {
      id: boundedString(pick(raw, "id", "regionId", "region_id"), 200) || `region-${index + 1}`,
      index: regionIndex,
      bars,
      startBar,
      endBar,
      localBpm: Math.max(20, Math.min(400, finiteNumber(pick(raw, "localBpm", "local_bpm", "sourceBpm", "source_bpm"), 120))),
      targetBpm,
      ratio,
      residualMs,
      flagged: Boolean(pick(raw, "flagged", "requiresReview", "requires_review")) || (ratio > 0 && (ratio < 0.75 || ratio > 1.5)),
      note: boundedString(pick(raw, "note", "reason", "flagReason", "flag_reason"), 240)
    };
  }

  function normalizeAsset(raw, index = 0) {
    const metadata = parseObject(pick(raw, "metadata"), {});
    return {
      id: boundedString(pick(raw, "id", "assetId", "asset_id"), 200) || `artifact-${index + 1}`,
      kind: boundedString(pick(raw, "kind"), 80),
      variant: boundedString(pick(raw, "variant"), 100),
      contentType: boundedString(pick(raw, "contentType", "content_type"), 120),
      bytes: Math.max(0, finiteNumber(pick(raw, "bytes"), 0)),
      sha256: boundedString(pick(raw, "sha256"), 64),
      trackId: boundedString(pick(raw, "trackId", "track_id", "stemId", "stem_id") ?? pick(metadata, "trackAssetId", "track_asset_id", "trackId", "track_id", "stemId", "stem_id"), 200),
      segmentIndex: Math.max(0, Math.trunc(finiteNumber(pick(raw, "segmentIndex", "segment_index") ?? pick(metadata, "regionIndex", "region_index", "segmentIndex", "segment_index"), 0))),
      startSeconds: Math.max(0, finiteNumber(pick(raw, "startSeconds", "start_seconds") ?? pick(metadata, "startSeconds", "start_seconds"), 0)),
      durationSeconds: Math.max(0, finiteNumber(pick(raw, "durationSeconds", "duration_seconds") ?? pick(metadata, "durationSeconds", "duration_seconds"), 0)),
      metadata
    };
  }

  function normalizeJob(raw) {
    const payload = parseObject(pick(raw, "publicState", "public_state", "state", "payload"), {});
    const source = { ...payload, ...(raw && typeof raw === "object" ? raw : {}) };
    const inspection = parseObject(pick(source, "inspection", "inspectionSummary", "inspection_summary", "inspectionManifest", "inspection_manifest"), {});
    const analysis = parseObject(pick(source, "analysis", "analysisSummary", "analysis_summary"), {});
    const proposal = parseObject(pick(source, "proposal", "proposalSummary", "proposal_summary"), {});
    const result = parseObject(pick(source, "result", "renderResult", "render_result"), {});
    const tempoMap = parseObject(pick(proposal, "map", "tempoMap", "tempo_map", "decision"), {});
    const tracksRaw = pick(inspection, "tracks", "assets", "audioAssets", "audio_assets") || pick(source, "tracks", "stems") || [];
    const regionsRaw = pick(proposal, "regions", "flaggedRegions", "flagged_regions") || pick(tempoMap, "regions") || [];
    let rawTargetBpm = pickNullable(source, "targetBpm", "target_bpm");
    if (rawTargetBpm === undefined) rawTargetBpm = pickNullable(proposal, "targetBpm", "target_bpm");
    if (rawTargetBpm === undefined) rawTargetBpm = pickNullable(tempoMap, "targetBpm", "target_bpm");
    return {
      id: boundedString(pick(source, "id", "jobId", "job_id"), 200),
      projectId: boundedString(pick(source, "projectId", "project_id"), 200),
      status: normalizeStatus(pick(source, "status")),
      revision: Math.max(0, Math.trunc(finiteNumber(pick(source, "revision"), 0))),
      activeAttemptId: boundedString(pick(source, "activeAttemptId", "active_attempt_id"), 200),
      errorCode: boundedString(pick(source, "errorCode", "error_code"), 100),
      errorMessage: boundedString(pick(source, "errorMessage", "error_message"), 500),
      sourceName: boundedString(pick(source, "sourceName", "source_name", "sourceFileName", "source_file_name"), 220),
      sourceBytes: Math.max(0, finiteNumber(pick(source, "sourceBytes", "source_bytes"), 0)),
      sourceContentType: boundedString(pick(source, "sourceContentType", "source_content_type"), 120),
      sourceBucket: boundedString(pick(source, "sourceBucket", "source_bucket"), 120),
      sourceObjectPath: boundedString(pick(source, "sourceObjectPath", "source_object_path"), 600),
      inspectionManifestSha256: boundedString(pick(source, "inspectionManifestSha256", "inspection_manifest_sha256") ?? pick(inspection, "sha256", "manifestSha256", "manifest_sha256"), 64),
      analysisSha256: boundedString(pick(source, "analysisSha256", "analysis_sha256") ?? pick(analysis, "sha256", "analysisSha256", "analysis_sha256"), 64),
      proposalManifestSha256: boundedString(pick(source, "proposalManifestSha256", "proposal_manifest_sha256") ?? pick(proposal, "sha256", "manifestSha256", "manifest_sha256"), 64),
      targetBpm: rawTargetBpm === null ? null : finiteNumber(rawTargetBpm),
      mode: boundedString(pick(source, "mode", "conformMode", "conform_mode") ?? proposal.mode ?? tempoMap.mode, 40),
      durationSeconds: Math.max(0, finiteNumber(
        pick(source, "durationSeconds", "duration_seconds")
          ?? pick(result, "durationSeconds", "duration_seconds")
          ?? pick(analysis, "durationSeconds", "duration_seconds")
          ?? pick(inspection, "durationSeconds", "duration_seconds"),
        0
      )),
      inspection,
      analysis,
      proposal,
      result,
      tracks: Array.isArray(tracksRaw) ? tracksRaw.map(normalizeTrack) : [],
      regions: Array.isArray(regionsRaw) ? regionsRaw.map(normalizeRegion) : [],
      createdAt: boundedString(pick(source, "createdAt", "created_at"), 80),
      updatedAt: boundedString(pick(source, "updatedAt", "updated_at"), 80)
    };
  }

  function analysisSelection(jobValue, editedTracks, referenceMethod = "selected-stem-sum") {
    const job = normalizeJob(jobValue);
    const tracks = (Array.isArray(editedTracks) ? editedTracks : job.tracks).map(normalizeTrack);
    if (!tracks.length || !tracks.some((track) => track.included)) throw new Error("Include at least one stem");
    const method = referenceMethod === "full-mix" ? "full-mix" : "selected-stem-sum";
    const fullMix = tracks.find((track) => track.role === "full-mix" && track.included);
    if (method === "full-mix" && !fullMix) throw new Error("Include one stem with the Full mix role");
    return {
      referenceMethod: method,
      assets: tracks.map((track) => ({
        assetId: track.assetId,
        role: track.role,
        included: method === "full-mix" ? track.assetId === fullMix.assetId : track.included,
        gainDb: track.gainDb
      })),
      fullMixAssetId: method === "full-mix" ? fullMix.assetId : null,
      drumCrosscheckAssetId: method === "full-mix"
        ? null
        : tracks.find((track) => track.role === "drums" && track.included)?.assetId || null,
      sum: { headroomDb: -12, normalizePeakDbfs: -3 }
    };
  }

  function proposalRequest(targetBpmValue, modeValue, reviewedGrid = null) {
    const mode = MODES.includes(modeValue) ? modeValue : "musical-4bar";
    if (mode === "no-conform") return { targetBpm: null, mode, reviewedGrid };
    const targetBpm = finiteNumber(targetBpmValue);
    if (targetBpm === null || targetBpm < 20 || targetBpm > 400) {
      throw new Error("Choose a target BPM from 20 to 400");
    }
    return { targetBpm, mode, reviewedGrid };
  }

  function editedRegions(regionsValue) {
    if (!Array.isArray(regionsValue)) return [];
    return regionsValue.map((region, index) => {
      const normalized = normalizeRegion(region, index);
      const reviewed = {
        id: normalized.id,
        startBar: normalized.startBar,
        endBar: normalized.endBar,
        localBpm: normalized.localBpm,
        targetBpm: normalized.targetBpm,
        flagged: normalized.flagged
      };
      if (normalized.note) reviewed.note = normalized.note;
      return reviewed;
    });
  }

  function normalizeDisabledSegments(value, tracksValue = []) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const trackIds = new Set((Array.isArray(tracksValue) ? tracksValue : [])
      .map((track) => boundedString(track?.assetId ?? track?.asset_id, 200))
      .filter(Boolean));
    const result = {};
    Object.entries(source).forEach(([trackId, indexes]) => {
      if (!trackIds.has(trackId) || !Array.isArray(indexes)) return;
      const normalized = Array.from(new Set(indexes
        .map((index) => Number(index))
        .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < 512)))
        .sort((left, right) => left - right)
        .slice(0, 512);
      if (normalized.length) result[trackId] = normalized;
    });
    return result;
  }

  function toStemProject(jobValue, assetsValue = [], previous = null) {
    const job = normalizeJob(jobValue);
    const assets = Array.isArray(assetsValue) ? assetsValue.map(normalizeAsset) : [];
    const tracks = job.tracks.map((track) => {
      const previousTrack = previous?.stemImport?.tracks?.find((item) => item.assetId === track.assetId);
      return {
        ...track,
        volume: finiteNumber(previousTrack?.volume, track.volume),
        muted: Boolean(previousTrack?.muted ?? track.muted)
      };
    });
    const previewAssets = assets.filter((asset) =>
      /preview[_ -]?segment|aligned[_ -]?segment|playback/i.test(`${asset.kind} ${asset.variant}`)
    );
    const disabledSegments = normalizeDisabledSegments(previous?.stemImport?.disabledSegments, tracks);
    previewAssets.forEach((asset) => {
      if (!asset.trackId || !Number.isSafeInteger(asset.segmentIndex)) return;
      if (previous?.stemImport?.arrangement?.[asset.id] !== false) return;
      const indexes = new Set(disabledSegments[asset.trackId] || []);
      indexes.add(asset.segmentIndex);
      disabledSegments[asset.trackId] = [...indexes].sort((left, right) => left - right);
    });
    const analyzedTempo = finiteNumber(pick(job.analysis, "medianBpm", "median_bpm"), 120);
    return {
      schemaVersion: 3,
      kind: "stem-import",
      id: job.projectId,
      name: boundedString(previous?.name || job.sourceName.replace(/\.(zip)$/i, "") || "Imported stems", 48),
      prompt: "",
      tempo: job.targetBpm === null ? analyzedTempo : finiteNumber(job.targetBpm, analyzedTempo),
      key: boundedString(previous?.key || "—", 24),
      swing: 0,
      patterns: previous?.patterns,
      volumes: previous?.volumes,
      muted: previous?.muted,
      stemImport: {
        jobId: job.id,
        status: job.status,
        revision: job.revision,
        mode: job.mode || "musical-4bar",
        durationSeconds: job.durationSeconds,
        tracks,
        previewAssets,
        arrangement: Object.fromEntries(previewAssets.map((asset) => [
          asset.id,
          previous?.stemImport?.arrangement?.[asset.id] !== false
            && !(disabledSegments[asset.trackId] || []).includes(asset.segmentIndex)
        ])),
        disabledSegments,
        regions: job.regions,
        inspectionManifestSha256: job.inspectionManifestSha256,
        analysisSha256: job.analysisSha256,
        proposalManifestSha256: job.proposalManifestSha256
      },
      updatedAt: previous?.updatedAt || new Date().toISOString()
    };
  }

  return {
    ACTIVE_STATUSES,
    WAITING_STATUSES,
    TERMINAL_STATUSES,
    RETRYABLE_INSPECTION_ERRORS,
    ROLES,
    MODES,
    analysisSelection,
    autoRepairTimingGrid,
    boundedString,
    canRetryInspection,
    editedRegions,
    eventProgress,
    finiteNumber,
    formatBytes,
    formatDuration,
    normalizeAsset,
    normalizeDisabledSegments,
    normalizeEvent,
    normalizeJob,
    normalizeRegion,
    normalizeStatus,
    normalizeTrack,
    parseObject,
    proposalRequest,
    statusKind,
    statusBadgeLabel,
    statusLabel,
    timingSeconds,
    timingGridDiagnostics,
    toStemProject
  };
});
