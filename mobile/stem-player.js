(() => {
  "use strict";

  const core = window.OpusloopsStemCore;

  function create({ cloud, onState } = {}) {
    let project = null;
    let fingerprint = "";
    let segments = [];
    let loaded = new Map();
    let activeIndex = -1;
    let position = 0;
    let playing = false;
    let loading = false;
    let operation = 0;
    let frame = 0;
    let lastDriftCheck = 0;

    function emit(extra = {}) {
      onState?.({
        playing,
        loading,
        position: currentPosition(),
        duration: duration(),
        available: segments.length > 0,
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
        stem?.arrangement,
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
        const key = asset.segmentIndex;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(asset);
      });
      let cursor = 0;
      return Array.from(groups.entries())
        .sort(([left], [right]) => left - right)
        .map(([index, items]) => {
          const explicitStart = Math.min(...items.map((item) => item.startSeconds || Number.POSITIVE_INFINITY));
          const start = Number.isFinite(explicitStart) ? explicitStart : cursor;
          const explicitDuration = Math.max(...items.map((item) => item.durationSeconds || 0));
          const duration = explicitDuration || 16;
          cursor = Math.max(cursor, start + duration);
          const stemItems = items.filter((item) => item.trackId);
          return {
            index,
            start,
            duration,
            items: stemItems.length ? stemItems : [items[0]]
          };
        });
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
        if (bounded < segment.start + segment.duration) {
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

    function applyMix(entry) {
      entry.media.forEach(({ audio, asset }) => {
        const arranged = project?.stemImport?.arrangement?.[asset.id] !== false;
        if (!asset.trackId) {
          audio.muted = !arranged;
          audio.volume = 1;
          return;
        }
        const mix = trackMix(asset.trackId);
        audio.muted = mix.muted || !arranged;
        audio.volume = mix.volume;
      });
    }

    function waitForMetadata(audio) {
      if (audio.readyState >= 1) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => finish(reject, new Error("Preview audio timed out")), 20000);
        const finish = (callback, value) => {
          window.clearTimeout(timeout);
          audio.removeEventListener("loadedmetadata", loadedMetadata);
          audio.removeEventListener("error", failed);
          callback(value);
        };
        const loadedMetadata = () => finish(resolve);
        const failed = () => finish(reject, new Error("Preview audio could not load"));
        audio.addEventListener("loadedmetadata", loadedMetadata, { once: true });
        audio.addEventListener("error", failed, { once: true });
      });
    }

    function destroyEntry(entry) {
      entry?.media?.forEach(({ audio }) => {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      });
    }

    async function loadSegment(segment, requestId = operation) {
      if (!segment || !project?.stemImport?.jobId) throw new Error("Aligned preview audio is not ready");
      const cached = loaded.get(segment.index);
      const refreshAt = cached?.expiresAt ? Date.parse(cached.expiresAt) - 60000 : 0;
      if (cached && (!refreshAt || refreshAt > Date.now())) {
        applyMix(cached);
        return cached;
      }
      if (cached) {
        destroyEntry(cached);
        loaded.delete(segment.index);
      }
      const signed = await Promise.all(segment.items.map((asset) =>
        cloud.signStemArtifact(project.stemImport.jobId, asset.id, 900)
      ));
      if (requestId !== operation) throw new DOMException("Playback changed", "AbortError");
      const media = signed.map((response, index) => {
        const audio = new Audio();
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        audio.src = response.signedUrl;
        audio.playsInline = true;
        return { audio, asset: segment.items[index] };
      });
      const entry = {
        segment,
        media,
        expiresAt: signed.map((item) => item.expiresAt).filter(Boolean).sort()[0] || ""
      };
      applyMix(entry);
      await Promise.all(media.map(({ audio }) => waitForMetadata(audio)));
      if (requestId !== operation) {
        destroyEntry(entry);
        throw new DOMException("Playback changed", "AbortError");
      }
      const leader = media[0]?.audio;
      if (leader) {
        leader.addEventListener("ended", () => {
          if (playing && activeIndex === segment.index) advanceFrom(segment);
        });
      }
      loaded.set(segment.index, entry);
      return entry;
    }

    function currentEntry() {
      return loaded.get(activeIndex) || null;
    }

    function currentPosition() {
      const entry = currentEntry();
      const leader = entry?.media?.[0]?.audio;
      if (leader && Number.isFinite(leader.currentTime)) {
        return Math.max(0, Math.min(duration(), entry.segment.start + leader.currentTime));
      }
      return Math.max(0, Math.min(duration(), position));
    }

    function stopTicker() {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }

    function startTicker() {
      stopTicker();
      const tick = (timestamp) => {
        if (!playing) {
          frame = 0;
          return;
        }
        const entry = currentEntry();
        const leader = entry?.media?.[0]?.audio;
        if (leader && timestamp - lastDriftCheck > 500) {
          lastDriftCheck = timestamp;
          entry.media.slice(1).forEach(({ audio }) => {
            if (Math.abs(audio.currentTime - leader.currentTime) > 0.075) audio.currentTime = leader.currentTime;
          });
        }
        position = currentPosition();
        emit();
        frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    }

    function successorFor(segment) {
      const index = segments.findIndex((candidate) => candidate.index === segment?.index);
      return index >= 0 ? segments[index + 1] || null : null;
    }

    function preloadSuccessor(segment, requestId) {
      const successor = successorFor(segment);
      const retained = new Set([segment.index]);
      if (successor) retained.add(successor.index);
      loaded.forEach((entry, index) => {
        if (retained.has(index)) return;
        destroyEntry(entry);
        loaded.delete(index);
      });
      if (successor) loadSegment(successor, requestId).catch(() => {});
    }

    async function advanceFrom(segment) {
      const previous = currentEntry();
      previous?.media?.forEach(({ audio }) => audio.pause());
      const next = successorFor(segment);
      if (!next) {
        playing = false;
        position = duration();
        stopTicker();
        emit({ ended: true });
        return;
      }
      const requestId = operation;
      try {
        const entry = await loadSegment(next, requestId);
        if (!playing || requestId !== operation) return;
        activeIndex = next.index;
        position = next.start;
        entry.media.forEach(({ audio }) => { audio.currentTime = 0; });
        await Promise.all(entry.media.map(({ audio }) => audio.play()));
        if (playing && requestId === operation) preloadSuccessor(next, requestId);
      } catch (error) {
        playing = false;
        stopTicker();
        emit({ error });
      }
    }

    async function play(fromPosition = position) {
      if (playing || loading) return;
      const total = duration();
      if (!segments.length || !total) throw new Error("Aligned preview audio is not ready");
      if (fromPosition >= total) fromPosition = 0;
      position = Math.max(0, Math.min(total, Number(fromPosition) || 0));
      const segment = segmentForPosition(position);
      const requestId = ++operation;
      loading = true;
      emit();
      try {
        const entry = await loadSegment(segment, requestId);
        if (requestId !== operation) return;
        activeIndex = segment.index;
        const localTime = Math.max(0, Math.min(segment.duration, position - segment.start));
        entry.media.forEach(({ audio }) => { audio.currentTime = localTime; });
        await Promise.all(entry.media.map(({ audio }) => audio.play()));
        if (requestId !== operation) {
          entry.media.forEach(({ audio }) => audio.pause());
          return;
        }
        playing = true;
        startTicker();
        preloadSuccessor(segment, requestId);
      } catch (error) {
        playing = false;
        emit({ error });
        throw error;
      } finally {
        if (requestId === operation) loading = false;
        emit();
      }
    }

    function pause() {
      position = currentPosition();
      operation += 1;
      playing = false;
      loading = false;
      stopTicker();
      loaded.forEach((entry) => entry.media.forEach(({ audio }) => audio.pause()));
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
      loaded.forEach(applyMix);
    }

    function loadProject(nextProject) {
      const nextFingerprint = projectFingerprint(nextProject);
      if (nextFingerprint === fingerprint) {
        project = nextProject;
        loaded.forEach(applyMix);
        emit();
        return;
      }
      pause();
      loaded.forEach(destroyEntry);
      loaded = new Map();
      activeIndex = -1;
      position = 0;
      project = nextProject;
      fingerprint = nextFingerprint;
      segments = buildSegments(project);
      emit();
      if (segments[0]) loadSegment(segments[0], operation).catch(() => {});
    }

    function destroy() {
      pause();
      loaded.forEach(destroyEntry);
      loaded.clear();
      project = null;
      fingerprint = "";
      segments = [];
      activeIndex = -1;
      position = 0;
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
      seek,
      setMix
    });
  }

  window.OpusloopsStemPlayer = Object.freeze({ create });
})();
