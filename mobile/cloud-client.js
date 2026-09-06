(() => {
  "use strict";

  const config = window.OPUSLOOPS_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const publishableKey = String(config.supabasePublishableKey || "");
  const stemImportUrl = `${baseUrl}/functions/v1/stem-import`;
  const SESSION_KEY = "opusloops.auth.session.v1";
  const SESSION_EVENT = "opusloops:auth-session-change";
  const REFRESH_MARGIN_SECONDS = 60;
  const STEM_DISPATCH_TOKEN_SECONDS = 3000;
  const STEM_ASSET_PAGE_SIZE = 500;
  const DEFAULT_TUS_CHUNK_SIZE = 6 * 1024 * 1024;
  let session = readSession();
  let sessionVersion = 0;
  let refreshOperation = null;

  class CloudError extends Error {
    constructor(message, status = 0, code = "") {
      super(message);
      this.name = "CloudError";
      this.status = status;
      this.code = code;
    }
  }

  function configured() {
    return /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(baseUrl)
      && publishableKey.startsWith("sb_publishable_");
  }

  function readSession() {
    try {
      const value = localStorage.getItem(SESSION_KEY);
      const candidate = value ? JSON.parse(value) : null;
      if (!candidate?.access_token || !candidate?.refresh_token || !candidate?.user?.id) return null;
      return candidate;
    } catch {
      return null;
    }
  }

  function announceSessionChange() {
    if (typeof window.dispatchEvent !== "function" || typeof window.CustomEvent !== "function") return;
    window.dispatchEvent(new window.CustomEvent(SESSION_EVENT, {
      detail: { user: session?.user ? { ...session.user } : null }
    }));
  }

  function storeSession(nextSession, expectedVersion = null) {
    if (expectedVersion !== null && expectedVersion !== sessionVersion) {
      throw new CloudError("The active account changed", 409, "session_changed");
    }
    session = normalizeSession(nextSession);
    sessionVersion += 1;
    try {
      if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // A private browsing mode can reject persistence. The in-memory session still works.
    }
    announceSessionChange();
    return session;
  }

  function normalizeSession(candidate) {
    if (!candidate?.access_token || !candidate?.refresh_token || !candidate?.user?.id) return null;
    const expiresIn = Number(candidate.expires_in) || 3600;
    const expiresAt = Number(candidate.expires_at) || Math.floor(Date.now() / 1000) + expiresIn;
    return {
      access_token: String(candidate.access_token),
      refresh_token: String(candidate.refresh_token),
      token_type: String(candidate.token_type || "bearer"),
      expires_in: expiresIn,
      expires_at: expiresAt,
      user: {
        id: String(candidate.user.id),
        email: String(candidate.user.email || "")
      }
    };
  }

  async function readResponse(response) {
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function errorFrom(response, body) {
    const message = body?.msg || body?.message || body?.error_description || body?.error
      || `Cloud request failed (${response.status})`;
    const code = body?.code || body?.error_code || "";
    return new CloudError(String(message), response.status, String(code));
  }

  function isTerminalSessionError(error) {
    return error instanceof CloudError && [400, 401, 403].includes(error.status);
  }

  function assertSessionUser(expectedUserId) {
    if (!session) throw new CloudError("Sign in to use cloud sync", 401, "session_missing");
    if (expectedUserId && session.user.id !== expectedUserId) {
      throw new CloudError("The active account changed", 409, "session_changed");
    }
    return session;
  }

  async function timedFetch(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new CloudError("Cloud request timed out", 0, "network_timeout");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function authFetch(path, { method = "POST", body, token } = {}) {
    if (!configured()) throw new CloudError("Cloud sync is not configured");
    const headers = {
      apikey: publishableKey,
      "Content-Type": "application/json",
      "X-Client-Info": "opusloops-web/1.0"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await timedFetch(`${baseUrl}/auth/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await readResponse(response);
    if (!response.ok) throw errorFrom(response, result);
    return result;
  }

  async function refreshSession(expectedUserId = session?.user?.id) {
    const startingSession = assertSessionUser(expectedUserId);
    if (!startingSession.refresh_token) throw new CloudError("Your session has ended", 401, "session_missing");
    if (refreshOperation
        && refreshOperation.userId === expectedUserId
        && refreshOperation.version === sessionVersion) {
      return refreshOperation.promise;
    }

    const operation = {
      userId: expectedUserId,
      version: sessionVersion,
      promise: null
    };
    operation.promise = authFetch("/token?grant_type=refresh_token", {
      body: { refresh_token: startingSession.refresh_token }
    })
      .then((result) => {
        assertSessionUser(operation.userId);
        return storeSession(result, operation.version);
      })
      .catch((error) => {
        if (isTerminalSessionError(error)
            && sessionVersion === operation.version
            && session?.user?.id === operation.userId) {
          storeSession(null, operation.version);
        }
        throw error;
      })
      .finally(() => {
        if (refreshOperation === operation) refreshOperation = null;
      });
    refreshOperation = operation;
    return operation.promise;
  }

  async function accessToken(expectedUserId, minimumLifetimeSeconds = REFRESH_MARGIN_SECONDS) {
    const activeSession = assertSessionUser(expectedUserId);
    if (activeSession.expires_at - Math.floor(Date.now() / 1000) <= minimumLifetimeSeconds) {
      await refreshSession(expectedUserId);
    }
    const refreshed = assertSessionUser(expectedUserId);
    if (refreshed.expires_at - Math.floor(Date.now() / 1000) <= minimumLifetimeSeconds) {
      throw new CloudError("Your session could not be refreshed for audio processing. Sign in again and retry", 401, "session_refresh_required");
    }
    return refreshed.access_token;
  }

  async function dataFetch(path, { method = "GET", body, prefer, retry = true } = {}, boundUserId = session?.user?.id) {
    if (!configured()) throw new CloudError("Cloud sync is not configured");
    assertSessionUser(boundUserId);
    const token = await accessToken(boundUserId);
    const headers = {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Client-Info": "opusloops-web/1.0"
    };
    if (prefer) headers.Prefer = prefer;
    const response = await timedFetch(`${baseUrl}/rest/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }, 20000);
    const result = await readResponse(response);
    assertSessionUser(boundUserId);
    if (response.status === 401 && retry && session?.refresh_token) {
      await refreshSession(boundUserId);
      assertSessionUser(boundUserId);
      return dataFetch(path, { method, body, prefer, retry: false }, boundUserId);
    }
    if (!response.ok) throw errorFrom(response, result);
    return result;
  }

  async function signUp(email, password, inviteCode) {
    const expectedVersion = sessionVersion;
    const normalizedEmail = String(email).trim();
    const response = await timedFetch(`${baseUrl}/functions/v1/create-opusloops-account`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "Content-Type": "application/json",
        "X-Client-Info": "opusloops-web/1.0"
      },
      body: JSON.stringify({
        email: normalizedEmail,
        password: String(password),
        inviteCode: String(inviteCode || "").trim()
      })
    });
    const body = await readResponse(response);
    if (!response.ok) throw errorFrom(response, body);
    if (expectedVersion !== sessionVersion) {
      throw new CloudError("The active account changed", 409, "session_changed");
    }
    const result = await authFetch("/token?grant_type=password", {
      body: { email: normalizedEmail, password: String(password) }
    });
    const createdSession = storeSession(result, expectedVersion);
    return { session: createdSession, user: createdSession?.user || null };
  }

  async function signIn(email, password) {
    const expectedVersion = sessionVersion;
    const result = await authFetch("/token?grant_type=password", {
      body: { email: String(email).trim(), password: String(password) }
    });
    return storeSession(result, expectedVersion);
  }

  async function signOut() {
    const token = session?.access_token;
    storeSession(null);
    if (!token) return;
    try {
      await authFetch("/logout?scope=local", { token, body: {} });
    } catch {
      // Local sign-out is authoritative even if the device is offline.
    }
  }

  async function restoreSession() {
    if (!session) return null;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return session;
    const expectedUserId = session.user.id;
    const expectedVersion = sessionVersion;
    try {
      if (session.expires_at - Math.floor(Date.now() / 1000) <= REFRESH_MARGIN_SECONDS) {
        await refreshSession(expectedUserId);
      } else {
        const user = await authFetch("/user", { method: "GET", token: session.access_token });
        if (!user?.id) throw new CloudError("Your session has ended", 401, "invalid_user");
        assertSessionUser(expectedUserId);
        storeSession({ ...session, user }, expectedVersion);
      }
      return session;
    } catch (error) {
      if (error?.code === "session_changed") return session;
      if (isTerminalSessionError(error)
          && sessionVersion === expectedVersion
          && session?.user?.id === expectedUserId) {
        storeSession(null, expectedVersion);
        return null;
      }
      return session;
    }
  }

  function getSession() {
    return session ? { ...session, user: { ...session.user } } : null;
  }

  async function syncProjects(rows) {
    return dataFetch("/rpc/sync_projects", {
      method: "POST",
      body: { p_changes: rows }
    });
  }

  async function stemAction(action, fields = {}, boundUserId = session?.user?.id) {
    if (!configured()) throw new CloudError("Stem import is not configured");
    assertSessionUser(boundUserId);
    const requiresWorkerDispatch = [
      "finalize-upload", "retry-inspection", "approve-analysis", "request-proposal", "approve-tempo", "dispatch"
    ].includes(action);
    const tokenLifetime = requiresWorkerDispatch ? STEM_DISPATCH_TOKEN_SECONDS : REFRESH_MARGIN_SECONDS;
    const token = await accessToken(boundUserId, tokenLifetime);
    const response = await timedFetch(stemImportUrl, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Client-Info": "opusloops-web/1.0"
      },
      body: JSON.stringify({ action, ...fields })
    }, 30000);
    const result = await readResponse(response);
    assertSessionUser(boundUserId);
    if (response.status === 401 && session?.refresh_token) {
      await refreshSession(boundUserId);
      assertSessionUser(boundUserId);
      const retryToken = await accessToken(boundUserId, tokenLifetime);
      const retryResponse = await timedFetch(stemImportUrl, {
        method: "POST",
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${retryToken}`,
          "Content-Type": "application/json",
          "X-Client-Info": "opusloops-web/1.0"
        },
        body: JSON.stringify({ action, ...fields })
      }, 30000);
      const retryResult = await readResponse(retryResponse);
      assertSessionUser(boundUserId);
      if (!retryResponse.ok) throw errorFrom(retryResponse, retryResult);
      return retryResult;
    }
    if (!response.ok) throw errorFrom(response, result);
    return result;
  }

  function createStemImport({ projectId, file }) {
    if (!file || typeof file.size !== "number") throw new CloudError("Choose a stem ZIP", 400, "invalid_request");
    return stemAction("create", {
      projectId,
      file: {
        name: String(file.name || "stems.zip"),
        size: file.size,
        type: String(file.type || "application/zip"),
        lastModified: Number(file.lastModified) || 0
      }
    });
  }

  function encodeTusMetadata(value) {
    const bytes = new TextEncoder().encode(String(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function tusMetadataHeader(metadata) {
    return Object.entries(metadata)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key} ${encodeTusMetadata(value)}`)
      .join(",");
  }

  function fingerprintTusUpload(upload, file, jobId, userId) {
    const text = [
      userId,
      jobId,
      upload.endpoint,
      upload.bucketName,
      upload.objectName,
      file.name,
      file.size,
      file.lastModified
    ].join("|");
    let hash = 2166136261;
    for (const character of text) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `opusloops.tus.v1.${userId}.${(hash >>> 0).toString(16)}`;
  }

  function readTusLocation(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function writeTusLocation(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // Upload remains usable in private browsing; only cross-reload resume is unavailable.
    }
  }

  function xhrRequest(method, url, { headers = {}, body = null, signal, onUploadProgress } = {}) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => request.abort();
      request.open(method, url, true);
      Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, String(value)));
      request.timeout = 120000;
      if (onUploadProgress) request.upload.addEventListener("progress", onUploadProgress);
      request.addEventListener("load", () => finish(resolve, request));
      request.addEventListener("error", () => finish(reject, new CloudError("Upload connection failed", 0, "network_error")));
      request.addEventListener("timeout", () => finish(reject, new CloudError("Upload request timed out", 0, "network_timeout")));
      request.addEventListener("abort", () => finish(reject, new DOMException("Upload cancelled", "AbortError")));
      if (signal?.aborted) {
        finish(reject, new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      request.send(body);
    });
  }

  async function tusRequest(method, url, options, boundUserId, retry = true) {
    const token = await accessToken(boundUserId);
    const response = await xhrRequest(method, url, {
      ...options,
      headers: {
        ...options.headers,
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        "Tus-Resumable": "1.0.0",
        "X-Client-Info": "opusloops-web/1.0"
      }
    });
    assertSessionUser(boundUserId);
    if (response.status === 401 && retry && session?.refresh_token) {
      await refreshSession(boundUserId);
      return tusRequest(method, url, options, boundUserId, false);
    }
    return response;
  }

  function uploadError(response) {
    let body = null;
    try {
      body = response.responseText ? JSON.parse(response.responseText) : null;
    } catch {
      body = response.responseText;
    }
    return errorFrom({ status: response.status }, body);
  }

  function readUploadOffset(response) {
    const rawOffset = response.getResponseHeader("Upload-Offset");
    const offset = rawOffset === null || rawOffset === "" ? Number.NaN : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new CloudError("Upload server returned an invalid offset", 502, "invalid_upload_offset");
    }
    return offset;
  }

  async function uploadStemArchive({ file, upload, jobId, onProgress, signal } = {}) {
    const userId = session?.user?.id;
    assertSessionUser(userId);
    if (!file || typeof file.slice !== "function" || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new CloudError("Choose a non-empty stem ZIP", 400, "invalid_request");
    }
    if (!upload?.endpoint || !upload?.bucketName || !upload?.objectName || !jobId) {
      throw new CloudError("Upload instructions are incomplete", 500, "invalid_upload_contract");
    }
    const endpoint = new URL(String(upload.endpoint), baseUrl).href;
    const endpointUrl = new URL(endpoint);
    const projectHost = new URL(baseUrl).hostname.split(".")[0];
    const allowedUploadHosts = new Set([
      new URL(baseUrl).hostname,
      `${projectHost}.storage.supabase.co`
    ]);
    if (endpointUrl.protocol !== "https:" || !allowedUploadHosts.has(endpointUrl.hostname)) {
      throw new CloudError("Upload endpoint is outside the configured private storage", 500, "invalid_upload_contract");
    }
    const chunkSize = Number(upload.chunkSize) === DEFAULT_TUS_CHUNK_SIZE
      ? DEFAULT_TUS_CHUNK_SIZE
      : DEFAULT_TUS_CHUNK_SIZE;
    const fingerprint = fingerprintTusUpload(upload, file, jobId, userId);
    let uploadUrl = readTusLocation(fingerprint);
    let offset = 0;
    let reportedBytes = 0;
    const report = (bytes) => {
      reportedBytes = Math.max(reportedBytes, Math.min(file.size, Number(bytes) || 0));
      onProgress?.(reportedBytes, file.size);
    };

    if (uploadUrl) {
      let savedUrl = null;
      try {
        savedUrl = new URL(uploadUrl);
      } catch {
        // A damaged or tampered local resume record is never trusted with a bearer token.
      }
      if (!savedUrl || savedUrl.origin !== endpointUrl.origin) {
        writeTusLocation(fingerprint, "");
        uploadUrl = "";
      }
    }

    if (uploadUrl) {
      const head = await tusRequest("HEAD", uploadUrl, { signal }, userId);
      if (head.status >= 200 && head.status < 300) {
        offset = readUploadOffset(head);
        const rawLength = head.getResponseHeader("Upload-Length");
        const length = rawLength === null || rawLength === "" ? null : Number(rawLength);
        if ((length !== null && (!Number.isSafeInteger(length) || length !== file.size)) || offset > file.size) {
          writeTusLocation(fingerprint, "");
          throw new CloudError("Saved upload does not match this file", 409, "upload_identity_mismatch");
        }
        report(offset);
      } else if (head.status === 404 || head.status === 410) {
        writeTusLocation(fingerprint, "");
        uploadUrl = "";
      } else {
        throw uploadError(head);
      }
    }

    if (!uploadUrl) {
      const initialEnd = Math.min(file.size, chunkSize);
      const initialBody = file.slice(0, initialEnd);
      const metadata = {
        bucketName: upload.bucketName,
        objectName: upload.objectName,
        contentType: file.type || "application/zip",
        cacheControl: "no-store",
        metadata: JSON.stringify({ jobId })
      };
      const created = await tusRequest("POST", endpoint, {
        signal,
        body: initialBody,
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Upload-Length": file.size,
          "Upload-Offset": 0,
          "Upload-Metadata": tusMetadataHeader(metadata),
          "X-Upsert": "false"
        }
      }, userId);
      if (created.status !== 201) throw uploadError(created);
      const location = created.getResponseHeader("Location");
      if (!location) throw new CloudError("Upload server omitted the resume URL", 502, "invalid_upload_contract");
      uploadUrl = new URL(location, endpoint).href;
      if (new URL(uploadUrl).origin !== endpointUrl.origin) {
        throw new CloudError("Upload resume URL changed origin", 502, "invalid_upload_contract");
      }
      offset = readUploadOffset(created);
      if (offset !== initialEnd) throw new CloudError("Upload server offset disagrees with sent bytes", 502, "invalid_upload_offset");
      writeTusLocation(fingerprint, uploadUrl);
      report(offset);
    }

    while (offset < file.size) {
      const start = offset;
      const end = Math.min(file.size, start + chunkSize);
      const patched = await tusRequest("PATCH", uploadUrl, {
        signal,
        body: file.slice(start, end),
        headers: {
          "Content-Type": "application/offset+octet-stream",
          "Upload-Offset": start
        }
      }, userId);
      if (patched.status !== 204) throw uploadError(patched);
      offset = readUploadOffset(patched);
      if (offset !== end) throw new CloudError("Upload server offset disagrees with sent bytes", 502, "invalid_upload_offset");
      report(offset);
    }

    report(file.size);
    return { bytesUploaded: file.size, uploadUrl };
  }

  function forgetStemArchiveUpload({ file, upload, jobId } = {}) {
    const userId = session?.user?.id;
    assertSessionUser(userId);
    if (!file || !upload?.endpoint || !upload?.bucketName || !upload?.objectName || !jobId) return;
    writeTusLocation(fingerprintTusUpload(upload, file, jobId, userId), "");
  }

  function finalizeStemUpload(jobId, revision) {
    return stemAction("finalize-upload", { jobId, revision });
  }

  function retryStemInspection(jobId, revision) {
    return stemAction("retry-inspection", { jobId, revision });
  }

  async function fetchStemAssets(encodedJobId) {
    const assets = [];
    for (let offset = 0; ; offset += STEM_ASSET_PAGE_SIZE) {
      const page = await dataFetch(
        `/stem_import_assets?select=*&job_id=eq.${encodedJobId}`
          + `&order=created_at.asc,asset_id.asc&limit=${STEM_ASSET_PAGE_SIZE}&offset=${offset}`
      );
      if (!Array.isArray(page)) throw new CloudError("Stem assets could not be loaded", 503, "invalid_response");
      assets.push(...page);
      if (page.length < STEM_ASSET_PAGE_SIZE) return assets;
    }
  }

  async function getStemImport(jobId, { afterSequence = 0 } = {}) {
    const encodedJobId = encodeURIComponent(String(jobId));
    const sequence = Math.max(0, Math.trunc(Number(afterSequence) || 0));
    const [jobs, events, assets] = await Promise.all([
      dataFetch(`/stem_import_jobs?select=*&id=eq.${encodedJobId}&limit=1`),
      dataFetch(`/stem_import_events?select=*&job_id=eq.${encodedJobId}&sequence=gt.${sequence}&order=sequence.asc&limit=200`),
      fetchStemAssets(encodedJobId)
    ]);
    if (!Array.isArray(jobs) || !jobs[0]) throw new CloudError("Stem import was not found", 404, "not_found");
    return {
      job: jobs[0],
      events: Array.isArray(events) ? events : [],
      assets: Array.isArray(assets) ? assets : []
    };
  }

  function approveStemAnalysis(fields) {
    return stemAction("approve-analysis", fields);
  }

  function requestStemProposal(fields) {
    return stemAction("request-proposal", fields);
  }

  function approveStemTempo(fields) {
    return stemAction("approve-tempo", fields);
  }

  function dispatchStemImport(jobId) {
    return stemAction("dispatch", { jobId });
  }

  function cancelStemImport(jobId, revision) {
    return stemAction("cancel", { jobId, revision });
  }

  function signStemArtifact(jobId, assetId, expiresInSeconds = 900) {
    return stemAction("signed-download", { jobId, assetId, expiresInSeconds });
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", (event) => {
      if (event.key !== SESSION_KEY) return;
      try {
        session = normalizeSession(event.newValue ? JSON.parse(event.newValue) : null);
      } catch {
        session = null;
      }
      sessionVersion += 1;
      refreshOperation = null;
      announceSessionChange();
    });
  }

  window.OpusloopsCloud = Object.freeze({
    CloudError,
    configured,
    getSession,
    restoreSession,
    signUp,
    signIn,
    signOut,
    syncProjects,
    createStemImport,
    uploadStemArchive,
    forgetStemArchiveUpload,
    finalizeStemUpload,
    retryStemInspection,
    getStemImport,
    approveStemAnalysis,
    requestStemProposal,
    approveStemTempo,
    dispatchStemImport,
    cancelStemImport,
    signStemArtifact
  });
})();
