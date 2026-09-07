(() => {
  "use strict";

  const core = window.OpusloopsStemCore;
  const START_DELAY_SECONDS = 0.08;
  const SCHEDULER_INTERVAL_MS = 80;
  const FETCH_CONCURRENCY = 4;
  const STARTUP_BUFFER_SECONDS = 6;
  const LOOKAHEAD_SECONDS = 12;
  const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
  const PREVIEW_FETCH_TIMEOUT_MS = 12000;
  const PREVIEW_RETRY_DELAY_MS = 240;
  const MIX_RAMP_SECONDS = 0.012;
  const SEGMENT_EDGE_FADE_SECONDS = 0.008;
  const TIMELINE_TOLERANCE_SECONDS = 0.05;
  const MAX_MIXABLE_STEMS = 16;
  const MAX_ESTIMATED_SEGMENT_BYTES = 64 * 1024 * 1024;
  const MAX_RESIDENT_DECODED_BYTES = 128 * 1024 * 1024;
  const BUFFER_RETENTION_MS = 30000;

  function abortError() {
    return new DOMException("Playback changed", "AbortError");
  }

  function create({ cloud, onState } = {}) {
    let project = null;
    let fingerprint = "";
    let segments = [];
    let manifestError = null;
    let decoded = new Map();
    let decodedReservations = new Map();
    let pending = new Map();
    let scheduled = new Map();
    let preparing = new Set();
    let preloadFailures = new Map();
    let abortControllers = new Set();
    let retryingLoads = new Set();
    let workQueue = [];
    let activeWork = 0;
    let context = null;
    let masterGain = null;
    let limiter = null;
    let trackGains = new Map();
    let activeIndex = -1;
    let position = 0;
    let anchorPosition = 0;
    let anchorContextTime = 0;
    let playing = false;
    let loading = false;
    let operation = 0;
    let schedulerTimer = 0;
    let suspendTimer = 0;
    let bufferReleaseTimer = 0;

    function emit(extra = {}) {
      onState?.({
        playing,
        loading,
        position: currentPosition(),
        duration: duration(),
        available: segments.length > 0 && !manifestError,
        retrying: retryingLoads.size > 0,
        ...extra
      });
    }

    function projectFingerprint(value) {
      const stem = value?.stemImport;
      return JSON.stringify([
        value?.id,
        stem?.jobId,
        stem?.status,
        stem?.durationSeconds,
        stem?.tracks?.map((track) => track.assetId),
        stem?.previewAssets
      ]);
    }

    function buildSegments(value) {
      const stem = value?.stemImport || {};
      const assets = Array.isArray(stem.previewAssets)
        ? stem.previewAssets.map((asset, index) => core.normalizeAsset(asset, index))
        : [];
      const groups = new Map();
      assets.forEach((asset) => {
        if (!asset.id || !/^audio\//i.test(asset.contentType || "audio/unknown")) return;
        if (!groups.has(asset.segmentIndex)) groups.set(asset.segmentIndex, []);
        groups.get(asset.segmentIndex).push(asset);
      });
      let cursor = 0;
      return Array.from(groups.entries())
        .sort(([left], [right]) => left - right)
        .map(([index, items]) => {
          const starts = items.map((item) => Number(item.startSeconds)).filter(Number.isFinite);
          const start = starts.length ? Math.min(...starts) : cursor;
          const explicitDuration = Math.max(...items.map((item) => Number(item.durationSeconds) || 0));
          const segmentDuration = explicitDuration || 16;
          cursor = Math.max(cursor, start + segmentDuration);
          const stemItems = items.filter((item) => item.trackId);
          return {
            index,
            start,
            duration: segmentDuration,
            items: stemItems.length ? stemItems : [items[0]]
          };
        });
    }

    function validateSegments(value, builtSegments) {
      const expectedTracks = new Set((value?.stemImport?.tracks || []).map((track) => track.assetId).filter(Boolean));
      if (!expectedTracks.size) return new Error("This project has no mixable stems");
      if (expectedTracks.size > MAX_MIXABLE_STEMS) {
        return new Error(`Mobile playback supports up to ${MAX_MIXABLE_STEMS} stems per project`);
      }
      if (!builtSegments.length) return new Error("This project has no aligned preview audio");
      let expectedStart = 0;
      for (let positionIndex = 0; positionIndex < builtSegments.length; positionIndex += 1) {
        const segment = builtSegments[positionIndex];
        if (!Number.isSafeInteger(segment.index) || segment.index !== positionIndex) {
          return new Error("Aligned preview audio has a missing or invalid segment");
        }
        if (!Number.isFinite(segment.start) || !Number.isFinite(segment.duration) || segment.duration <= 0) {
          return new Error("Aligned preview audio has invalid timing");
        }
        const estimatedDecodedBytes = (segment.duration + SEGMENT_EDGE_FADE_SECONDS)
          * 48_000 * 2 * 4 * expectedTracks.size;
        if (estimatedDecodedBytes > MAX_ESTIMATED_SEGMENT_BYTES) {
          return new Error("This preview is too dense for reliable mobile playback");
        }
        if (Math.abs(segment.start - expectedStart) > TIMELINE_TOLERANCE_SECONDS) {
          return new Error("Aligned preview audio has a gap or overlap in its timeline");
        }
        const seen = new Set();
        for (const asset of segment.items) {
          if (!asset.trackId || !expectedTracks.has(asset.trackId)) {
            return new Error("Aligned preview audio does not match the project tracks");
          }
          if (seen.has(asset.trackId)) {
            return new Error("An aligned preview segment contains the same stem twice");
          }
          if (
            !Number.isFinite(asset.startSeconds)
            || !Number.isFinite(asset.durationSeconds)
            || asset.durationSeconds <= 0
            || Math.abs(asset.startSeconds - segment.start) > TIMELINE_TOLERANCE_SECONDS
            || Math.abs(asset.durationSeconds - segment.duration) > TIMELINE_TOLERANCE_SECONDS
          ) {
            return new Error("Aligned preview stems disagree about segment timing");
          }
          seen.add(asset.trackId);
        }
        if (seen.size !== expectedTracks.size) {
          return new Error("An aligned preview segment is missing one or more stems");
        }
        expectedStart = segment.start + segment.duration;
      }
      const declaredDuration = Number(value?.stemImport?.durationSeconds);
      if (
        Number.isFinite(declaredDuration)
        && declaredDuration > 0
        && Math.abs(expectedStart - declaredDuration) > TIMELINE_TOLERANCE_SECONDS
      ) {
        return new Error("Aligned preview duration does not match the project");
      }
      return null;
    }

    function duration() {
      const declared = Number(project?.stemImport?.durationSeconds);
      if (Number.isFinite(declared) && declared > 0) return declared;
      const last = segments[segments.length - 1];
      return last ? last.start + last.duration : 0;
    }

    function segmentForPosition(value) {
      const bounded = Math.max(0, Math.min(duration(), Number(value) || 0));
      let selected = segments[segments.length - 1];
      for (const segment of segments) {
        if (bounded < segment.start + segment.duration - 0.0005) {
          selected = segment;
          break;
        }
      }
      return selected || null;
    }

    function trackMix(trackId) {
      const track = project?.stemImport?.tracks?.find((candidate) => candidate.assetId === trackId);
      return {
        muted: Boolean(track?.muted),
        volume: Math.max(0, Math.min(1, Number(track?.volume ?? 1)))
      };
    }

    function targetGain(trackId) {
      const mix = trackMix(trackId);
      return mix.muted ? 0 : mix.volume;
    }

    function setParamValue(param, value, { smooth = false } = {}) {
      if (!param) return;
      const bounded = Math.max(0, Math.min(1, Number(value) || 0));
      const now = context?.currentTime || 0;
      try {
        param.cancelScheduledValues?.(now);
        if (smooth && context?.state === "running" && typeof param.setTargetAtTime === "function") {
          param.setTargetAtTime(bounded, now, MIX_RAMP_SECONDS);
        } else if (typeof param.setValueAtTime === "function") {
          param.setValueAtTime(bounded, now);
        } else {
          param.value = bounded;
        }
      } catch {
        param.value = bounded;
      }
    }

    function applyMix({ smooth = playing } = {}) {
      trackGains.forEach((gain, trackId) => {
        setParamValue(gain.gain, targetGain(trackId), { smooth });
      });
    }

    function ensureTrackGain(trackId) {
      let gain = trackGains.get(trackId);
      if (gain || !context || !masterGain) return gain || null;
      gain = context.createGain();
      gain.gain.value = targetGain(trackId);
      gain.connect(masterGain);
      trackGains.set(trackId, gain);
      return gain;
    }

    function configureLimiter(node) {
      if (!node) return;
      node.threshold.value = -6;
      node.knee.value = 0;
      node.ratio.value = 20;
      node.attack.value = 0.002;
      node.release.value = 0.08;
    }

    async function ensureContext() {
      window.clearTimeout(suspendTimer);
      window.clearTimeout(bufferReleaseTimer);
      suspendTimer = 0;
      bufferReleaseTimer = 0;
      if (!context || context.state === "closed") {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) throw new Error("Web Audio is not supported in this browser");
        try {
          context = new AudioContext({ latencyHint: "playback", sampleRate: 48_000 });
        } catch {
          context = new AudioContext();
        }
        masterGain = context.createGain();
        masterGain.gain.value = 0.68;
        limiter = context.createDynamicsCompressor();
        configureLimiter(limiter);
        masterGain.connect(limiter).connect(context.destination);
        const ownedContext = context;
        ownedContext.addEventListener?.("statechange", () => {
          if (context !== ownedContext || !playing) return;
          if (ownedContext.state === "interrupted" || ownedContext.state === "closed") {
            pause();
            emit({ interrupted: true });
          }
        });
      }
      if (context.state !== "running") await context.resume();
      if (context.state !== "running") {
        throw new DOMException("Tap play again to start audio", "NotAllowedError");
      }
      return context;
    }

    function scheduleSuspend() {
      window.clearTimeout(suspendTimer);
      const ownedContext = context;
      suspendTimer = window.setTimeout(() => {
        suspendTimer = 0;
        if (context === ownedContext && !playing && !loading && ownedContext?.state === "running") {
          ownedContext.suspend().catch(() => {});
        }
      }, 160);
    }

    function scheduleBufferRelease() {
      window.clearTimeout(bufferReleaseTimer);
      bufferReleaseTimer = window.setTimeout(() => {
        bufferReleaseTimer = 0;
        if (playing || loading) return;
        clearDecoded();
        emit({ buffersReleased: true });
      }, BUFFER_RETENTION_MS);
    }

    async function decodeAudio(bytes) {
      const activeContext = context;
      if (!activeContext) throw new Error("Audio engine is unavailable");
      return new Promise((resolve, reject) => {
        let settled = false;
        const accept = (buffer) => {
          if (settled) return;
          settled = true;
          if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
            reject(new Error("Preview audio decoded without playable samples"));
            return;
          }
          resolve(buffer);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error("Preview audio could not be decoded"));
        };
        try {
          const result = activeContext.decodeAudioData(bytes, accept, fail);
          if (result?.then) result.then(accept, fail);
        } catch (error) {
          fail(error);
        }
      });
    }

    function raceWithAbort(callback, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener?.("abort", cancel);
          handler(value);
        };
        const cancel = () => finish(reject, abortError());
        signal?.addEventListener?.("abort", cancel, { once: true });
        Promise.resolve()
          .then(callback)
          .then((value) => finish(resolve, value), (error) => finish(reject, error));
      });
    }

    function retryDelay(requestId, signal) {
      return raceWithAbort(() => new Promise((resolve) => {
        window.setTimeout(resolve, PREVIEW_RETRY_DELAY_MS);
      }), signal).then(() => {
        if (requestId !== operation) throw abortError();
      });
    }

    async function fetchPreview(url, requestId, parentSignal) {
      let lastError = null;
      let retryToken = null;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (requestId !== operation || parentSignal?.aborted) throw abortError();
          const controller = new AbortController();
          let timedOut = false;
          const cancelAttempt = () => controller.abort();
          parentSignal?.addEventListener?.("abort", cancelAttempt, { once: true });
          const timeout = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, PREVIEW_FETCH_TIMEOUT_MS);
          try {
            const response = await window.fetch(url, {
              cache: "no-store",
              credentials: "omit",
              signal: controller.signal
            });
            if (!response.ok) throw new Error(`Preview audio request failed (${response.status})`);
            const declaredBytes = Number(response.headers?.get?.("content-length"));
            if (Number.isFinite(declaredBytes) && declaredBytes > MAX_PREVIEW_BYTES) {
              throw new Error("Preview audio segment is unexpectedly large");
            }
            const bytes = await response.arrayBuffer();
            if (!bytes.byteLength || bytes.byteLength > MAX_PREVIEW_BYTES) {
              throw new Error("Preview audio segment has an invalid size");
            }
            if (requestId !== operation) throw abortError();
            return await decodeAudio(bytes);
          } catch (error) {
            if (requestId !== operation || parentSignal?.aborted) throw abortError();
            lastError = timedOut
              ? new Error("Preview audio download timed out")
              : error;
            if (attempt === 1) throw lastError;
          } finally {
            window.clearTimeout(timeout);
            parentSignal?.removeEventListener?.("abort", cancelAttempt);
          }
          retryToken = {};
          retryingLoads.add(retryToken);
          emit();
          await retryDelay(requestId, parentSignal);
        }
        throw lastError || new Error("Preview audio could not load");
      } finally {
        if (retryToken) {
          retryingLoads.delete(retryToken);
          if (requestId === operation) emit();
        }
      }
    }

    function pumpWorkQueue() {
      while (activeWork < FETCH_CONCURRENCY && workQueue.length) {
        const work = workQueue.shift();
        if (work.requestId !== operation) {
          work.reject(abortError());
          continue;
        }
        const controller = new AbortController();
        abortControllers.add(controller);
        activeWork += 1;
        raceWithAbort(() => work.callback(controller.signal), controller.signal)
          .then(work.resolve, work.reject)
          .finally(() => {
            abortControllers.delete(controller);
            activeWork -= 1;
            pumpWorkQueue();
          });
      }
    }

    function runBounded(callback, requestId) {
      return new Promise((resolve, reject) => {
        workQueue.push({ callback, reject, requestId, resolve });
        pumpWorkQueue();
      });
    }

    function rejectQueuedWork() {
      const queued = workQueue;
      workQueue = [];
      queued.forEach((work) => work.reject(abortError()));
    }

    function estimatedSegmentBytes(segment) {
      const sampleRate = Number(context?.sampleRate) || 48_000;
      return Math.ceil(
        (segment.duration + SEGMENT_EDGE_FADE_SECONDS)
        * sampleRate
        * 2
        * Float32Array.BYTES_PER_ELEMENT
        * segment.items.length
      );
    }

    function decodedEntryBytes(buffers) {
      return buffers.reduce((total, { buffer }) => {
        const frames = Number(buffer?.length);
        const channels = Number(buffer?.numberOfChannels);
        if (Number.isFinite(frames) && frames > 0 && Number.isFinite(channels) && channels > 0) {
          return total + frames * channels * Float32Array.BYTES_PER_ELEMENT;
        }
        const sampleRate = Number(buffer?.sampleRate) || Number(context?.sampleRate) || 48_000;
        return total + Math.ceil(
          Math.max(0, Number(buffer?.duration) || 0)
          * sampleRate
          * 2
          * Float32Array.BYTES_PER_ELEMENT
        );
      }, 0);
    }

    function residentDecodedBytes() {
      let total = 0;
      decoded.forEach((entry) => { total += Number(entry.decodedBytes) || 0; });
      decodedReservations.forEach((reservation) => { total += Number(reservation.bytes) || 0; });
      return total;
    }

    function reserveDecodedCapacity(segment, requestId) {
      const required = estimatedSegmentBytes(segment);
      const candidates = Array.from(decoded.entries())
        .filter(([index]) => !scheduled.has(index))
        .sort(([, left], [, right]) => {
          const current = currentPosition();
          return Math.abs(right.segment.start - current) - Math.abs(left.segment.start - current);
        });
      for (const [index] of candidates) {
        if (residentDecodedBytes() + required <= MAX_RESIDENT_DECODED_BYTES) break;
        decoded.delete(index);
      }
      if (residentDecodedBytes() + required > MAX_RESIDENT_DECODED_BYTES) {
        throw new Error("This preview exceeds the safe mobile audio memory limit");
      }
      const token = {};
      decodedReservations.set(segment.index, { bytes: required, requestId, token });
      return token;
    }

    async function loadSegment(segment, requestId = operation) {
      if (!segment || !project?.stemImport?.jobId) throw new Error("Aligned preview audio is not ready");
      const cached = decoded.get(segment.index);
      if (cached) return cached;
      const existing = pending.get(segment.index);
      if (existing?.requestId === requestId) return existing.promise;

      const reservationToken = reserveDecodedCapacity(segment, requestId);
      const token = {};
      const promise = (async () => {
        const results = await Promise.allSettled(segment.items.map((asset) => runBounded(async (signal) => {
          const signed = await cloud.signStemArtifact(
            project.stemImport.jobId,
            asset.id,
            900,
            { signal, timeoutMs: PREVIEW_FETCH_TIMEOUT_MS }
          );
          if (signal.aborted) throw abortError();
          if (requestId !== operation) throw abortError();
          const buffer = await fetchPreview(signed.signedUrl, requestId, signal);
          return { asset, buffer };
        }, requestId)));
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        const buffers = results.map((result) => result.value);
        if (requestId !== operation) throw abortError();
        const entry = { segment, buffers, decodedBytes: decodedEntryBytes(buffers) };
        if (decodedReservations.get(segment.index)?.token === reservationToken) {
          decodedReservations.delete(segment.index);
        }
        if (residentDecodedBytes() + entry.decodedBytes > MAX_RESIDENT_DECODED_BYTES) {
          throw new Error("This preview exceeds the safe mobile audio memory limit");
        }
        decoded.set(segment.index, entry);
        return entry;
      })();
      pending.set(segment.index, { requestId, promise, token });
      try {
        return await promise;
      } finally {
        if (decodedReservations.get(segment.index)?.token === reservationToken) {
          decodedReservations.delete(segment.index);
        }
        if (pending.get(segment.index)?.token === token) pending.delete(segment.index);
      }
    }

    function disconnectNode(node) {
      try { node?.disconnect(); } catch { /* The node may already be disconnected. */ }
    }

    function scheduleEdgeEnvelope(param, when, nominalDuration, overlapDuration) {
      if (!param) return;
      const fadeIn = Math.min(SEGMENT_EDGE_FADE_SECONDS, nominalDuration / 4);
      if (fadeIn <= 0 || typeof param.linearRampToValueAtTime !== "function") {
        param.value = 1;
        return;
      }
      param.cancelScheduledValues?.(when);
      param.setValueAtTime(0, when);
      param.linearRampToValueAtTime(1, when + fadeIn);
      if (overlapDuration > 0) {
        const boundary = when + nominalDuration;
        param.setValueAtTime(1, boundary);
        param.linearRampToValueAtTime(0, boundary + overlapDuration);
        return;
      }
      const fadeOut = Math.min(SEGMENT_EDGE_FADE_SECONDS, nominalDuration / 4);
      const end = when + nominalDuration;
      param.setValueAtTime(1, end - fadeOut);
      param.linearRampToValueAtTime(0, end);
    }

    function disposeGroup(group, { stop = true } = {}) {
      group?.sources?.forEach((source) => {
        if (stop) {
          try { source.stop(); } catch { /* A source may already have ended. */ }
        }
        disconnectNode(source);
        try { source.buffer = null; } catch { /* Some engines keep the completed buffer read-only. */ }
      });
      group?.segmentGains?.forEach(disconnectNode);
    }

    function stopScheduled() {
      scheduled.forEach((group) => disposeGroup(group));
      scheduled.clear();
    }

    function scheduleEntry(entry, requestId) {
      if (!context || !masterGain || (!playing && !loading) || requestId !== operation) return null;
      if (scheduled.has(entry.segment.index)) return scheduled.get(entry.segment.index);
      const playbackStart = Math.max(anchorPosition, entry.segment.start);
      const plannedWhen = playbackStart > anchorPosition
        ? anchorContextTime + (playbackStart - anchorPosition)
        : anchorContextTime;
      const lateBy = Math.max(0, context.currentTime - plannedWhen);
      const offset = Math.max(0, playbackStart - entry.segment.start + lateBy);
      const nominalDuration = Math.max(0, entry.segment.duration - offset);
      if (nominalDuration <= 0.001) {
        throw new Error("Preview audio missed its playback window");
      }
      const when = Math.max(plannedWhen, context.currentTime);
      const sources = [];
      const segmentGains = [];
      const launches = [];
      const segmentPosition = segments.findIndex((segment) => segment.index === entry.segment.index);
      const nextSegment = segmentPosition >= 0 ? segments[segmentPosition + 1] || null : null;
      let endsAt = when + nominalDuration;
      try {
        entry.buffers.forEach(({ asset, buffer }) => {
          if (project?.stemImport?.arrangement?.[asset.id] === false) return;
          const nextAsset = nextSegment?.items.find((candidate) => candidate.trackId === asset.trackId);
          const continues = Boolean(nextAsset && project?.stemImport?.arrangement?.[nextAsset.id] !== false);
          const fullOverlap = continues
            ? Math.min(SEGMENT_EDGE_FADE_SECONDS, entry.segment.duration / 4)
            : 0;
          const overlap = Math.min(fullOverlap, nominalDuration / 4);
          const rateCorrection = buffer.duration / (entry.segment.duration + fullOverlap);
          if (!Number.isFinite(rateCorrection) || rateCorrection < 0.8 || rateCorrection > 1.2) {
            throw new Error("Preview audio timing does not match its aligned segment");
          }
          const bufferOffset = Math.min(offset * rateCorrection, Math.max(0, buffer.duration - 0.001));
          const requestedPlaybackDuration = nominalDuration + overlap;
          const bufferDuration = Math.min(
            requestedPlaybackDuration * rateCorrection,
            Math.max(0, buffer.duration - bufferOffset)
          );
          if (bufferDuration <= 0.001) return;
          const playbackDuration = bufferDuration / rateCorrection;
          const actualOverlap = Math.max(0, playbackDuration - nominalDuration);
          const source = context.createBufferSource();
          const envelope = context.createGain();
          source.buffer = buffer;
          source.playbackRate.value = rateCorrection;
          scheduleEdgeEnvelope(envelope.gain, when, nominalDuration, actualOverlap);
          if (asset.trackId) {
            const gain = ensureTrackGain(asset.trackId);
            if (!gain) return;
            envelope.connect(gain);
          } else {
            envelope.connect(masterGain);
          }
          source.connect(envelope);
          segmentGains.push(envelope);
          launches.push({ source, when, bufferOffset, bufferDuration });
          sources.push(source);
          endsAt = Math.max(endsAt, when + playbackDuration);
        });
        launches.forEach((launch) => {
          launch.source.start(launch.when, launch.bufferOffset, launch.bufferDuration);
        });
      } catch (error) {
        disposeGroup({ sources, segmentGains });
        throw error;
      }
      const group = {
        segment: entry.segment,
        sources,
        segmentGains,
        when,
        endsAt
      };
      scheduled.set(entry.segment.index, group);
      return group;
    }

    function startupWindow(firstSegment, fromPosition) {
      const firstIndex = segments.findIndex((candidate) => candidate.index === firstSegment?.index);
      if (firstIndex < 0) return [];
      const result = [];
      for (let index = firstIndex; index < segments.length; index += 1) {
        const segment = segments[index];
        result.push(segment);
        const coveredSeconds = segment.start + segment.duration - fromPosition;
        if (coveredSeconds >= STARTUP_BUFFER_SECONDS) break;
      }
      return result;
    }

    function pruneWindow(timelinePosition) {
      const cutoff = Math.max(0, timelinePosition - 0.001);
      decoded.forEach((entry, index) => {
        if (entry.segment.start + entry.segment.duration <= cutoff) decoded.delete(index);
      });
      scheduled.forEach((group, index) => {
        if (!context || group.endsAt > context.currentTime + 0.001) return;
        disposeGroup(group, { stop: false });
        scheduled.delete(index);
      });
    }

    function abortPending() {
      abortControllers.forEach((controller) => controller.abort());
      abortControllers.clear();
      rejectQueuedWork();
      pending.clear();
      decodedReservations.clear();
      preparing.clear();
      preloadFailures.clear();
      retryingLoads.clear();
    }

    function currentPosition() {
      if (playing && context && Number.isFinite(context.currentTime)) {
        const elapsed = Math.max(0, context.currentTime - anchorContextTime);
        return Math.max(0, Math.min(duration(), anchorPosition + elapsed));
      }
      return Math.max(0, Math.min(duration(), position));
    }

    function stopScheduler() {
      window.clearInterval(schedulerTimer);
      schedulerTimer = 0;
    }

    function failPlayback(error) {
      position = currentPosition();
      operation += 1;
      playing = false;
      loading = false;
      stopScheduler();
      abortPending();
      stopScheduled();
      scheduleSuspend();
      scheduleBufferRelease();
      emit({ error });
    }

    async function prepareSuccessor(segment, requestId) {
      if (!segment || scheduled.has(segment.index) || preparing.has(segment.index)) return;
      const failed = preloadFailures.get(segment.index);
      if (failed && failed.retryAt > Date.now()) return;
      preparing.add(segment.index);
      try {
        const entry = await loadSegment(segment, requestId);
        if (!playing || requestId !== operation) return;
        scheduleEntry(entry, requestId);
        preloadFailures.delete(segment.index);
      } catch (error) {
        if (error?.name !== "AbortError" && requestId === operation) {
          preloadFailures.set(segment.index, { error, retryAt: Date.now() + 900 });
        }
      } finally {
        preparing.delete(segment.index);
      }
    }

    function fillLookahead(currentSegment, requestId) {
      if (!currentSegment) return;
      const timelinePosition = currentPosition();
      const horizon = Math.min(
        LOOKAHEAD_SECONDS,
        Math.max(STARTUP_BUFFER_SECONDS, currentSegment.duration)
      );
      const limit = timelinePosition + horizon;
      for (const segment of segments) {
        if (segment.start > limit + 0.001) break;
        if (segment.start + segment.duration <= timelinePosition + 0.001) continue;
        if (!scheduled.has(segment.index)) prepareSuccessor(segment, requestId);
      }
    }

    function tick(requestId) {
      if (!playing || requestId !== operation) return;
      position = currentPosition();
      const total = duration();
      if (position >= total - 0.001) {
        position = total;
        operation += 1;
        playing = false;
        stopScheduler();
        abortPending();
        stopScheduled();
        scheduleSuspend();
        scheduleBufferRelease();
        emit({ ended: true });
        return;
      }
      const current = segmentForPosition(position);
      if (!current) return;
      if (!scheduled.has(current.index)) {
        failPlayback(new Error("Preview audio could not stay buffered"));
        return;
      }
      if (activeIndex !== current.index) {
        activeIndex = current.index;
      }
      pruneWindow(position);
      fillLookahead(current, requestId);
      for (const candidate of segments) {
        if (candidate.start <= position + 0.001 || candidate.start - position > 0.35) continue;
        const failed = preloadFailures.get(candidate.index);
        if (failed && !scheduled.has(candidate.index)) {
          failPlayback(failed.error);
          return;
        }
      }
    }

    function startScheduler(requestId) {
      stopScheduler();
      schedulerTimer = window.setInterval(() => tick(requestId), SCHEDULER_INTERVAL_MS);
    }

    async function play(fromPosition = position) {
      if (playing || loading) return;
      if (manifestError) throw manifestError;
      const total = duration();
      if (!segments.length || !total) throw new Error("Aligned preview audio is not ready");
      if (fromPosition >= total) fromPosition = 0;
      position = Math.max(0, Math.min(total, Number(fromPosition) || 0));
      const segment = segmentForPosition(position);
      const requestId = ++operation;
      loading = true;
      emit();
      try {
        await ensureContext();
        const entries = await Promise.all(
          startupWindow(segment, position).map((candidate) => loadSegment(candidate, requestId))
        );
        if (requestId !== operation) return;
        if (context.state !== "running") await context.resume();
        if (context.state !== "running") {
          throw new DOMException("Tap play again to start audio", "NotAllowedError");
        }
        if (requestId !== operation) return;
        stopScheduled();
        trackGains.forEach(disconnectNode);
        trackGains = new Map();
        anchorPosition = position;
        anchorContextTime = context.currentTime + START_DELAY_SECONDS;
        activeIndex = segment.index;
        loading = false;
        playing = true;
        entries.forEach((entry) => scheduleEntry(entry, requestId));
        pruneWindow(position);
        fillLookahead(segment, requestId);
        startScheduler(requestId);
        emit();
      } catch (error) {
        if (requestId !== operation || error?.name === "AbortError") return;
        operation += 1;
        playing = false;
        loading = false;
        abortPending();
        stopScheduled();
        scheduleSuspend();
        scheduleBufferRelease();
        emit({ error });
        throw error;
      } finally {
        if (requestId === operation && loading) {
          loading = false;
          emit();
        }
      }
    }

    function pause() {
      position = currentPosition();
      operation += 1;
      playing = false;
      loading = false;
      stopScheduler();
      abortPending();
      stopScheduled();
      scheduleSuspend();
      scheduleBufferRelease();
      emit();
    }

    async function seek(nextPosition, { resume = playing } = {}) {
      const total = duration();
      const target = Math.max(0, Math.min(total, Number(nextPosition) || 0));
      pause();
      position = target;
      emit();
      if (resume) await play(target);
    }

    function setMix(trackId, volume, muted) {
      const track = project?.stemImport?.tracks?.find((candidate) => candidate.assetId === trackId);
      if (track) {
        track.volume = Math.max(0, Math.min(1, Number(volume) || 0));
        track.muted = Boolean(muted);
      }
      const gain = trackGains.get(trackId);
      if (gain) setParamValue(gain.gain, targetGain(trackId), { smooth: playing });
    }

    function clearDecoded() {
      decoded.clear();
      decodedReservations.clear();
      pending.clear();
    }

    function releaseBuffers() {
      if (playing || loading) pause();
      else {
        abortPending();
        stopScheduled();
      }
      window.clearTimeout(bufferReleaseTimer);
      bufferReleaseTimer = 0;
      clearDecoded();
      if (context?.state === "running") context.suspend().catch(() => {});
      emit();
    }

    function loadProject(nextProject) {
      const nextFingerprint = projectFingerprint(nextProject);
      if (nextFingerprint === fingerprint) {
        project = nextProject;
        applyMix();
        emit();
        return;
      }
      pause();
      clearDecoded();
      trackGains.forEach(disconnectNode);
      trackGains = new Map();
      activeIndex = -1;
      position = 0;
      anchorPosition = 0;
      anchorContextTime = 0;
      project = nextProject;
      fingerprint = nextFingerprint;
      segments = buildSegments(project);
      manifestError = validateSegments(project, segments);
      emit();
    }

    function destroy() {
      pause();
      window.clearTimeout(suspendTimer);
      window.clearTimeout(bufferReleaseTimer);
      suspendTimer = 0;
      bufferReleaseTimer = 0;
      clearDecoded();
      trackGains.forEach(disconnectNode);
      trackGains.clear();
      disconnectNode(masterGain);
      disconnectNode(limiter);
      const ownedContext = context;
      context = null;
      masterGain = null;
      limiter = null;
      if (ownedContext && ownedContext.state !== "closed") ownedContext.close().catch(() => {});
      project = null;
      fingerprint = "";
      segments = [];
      manifestError = null;
      activeIndex = -1;
      position = 0;
      anchorPosition = 0;
      anchorContextTime = 0;
      emit();
    }

    return Object.freeze({
      destroy,
      duration,
      isPlaying: () => playing,
      isLoading: () => loading,
      loadProject,
      pause,
      play,
      position: currentPosition,
      releaseBuffers,
      seek,
      setMix
    });
  }

  window.OpusloopsStemPlayer = Object.freeze({ create });
})();
