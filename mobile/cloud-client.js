(() => {
  "use strict";

  const config = window.OPUSLOOPS_CONFIG || {};
  const awsBackend = config.provider === "aws";
  const baseUrl = String((awsBackend ? config.apiUrl : config.supabaseUrl) || "").replace(/\/$/, "");
  const publishableKey = String(config.supabasePublishableKey || "");
  const stemImportUrl = `${baseUrl}/functions/v1/stem-import`;
  const SESSION_KEY = awsBackend ? "opusloops.auth.session.aws.v1" : "opusloops.auth.session.v1";
  const SESSION_EVENT = "opusloops:auth-session-change";
  const REFRESH_MARGIN_SECONDS = 60;
  const STEM_DISPATCH_TOKEN_SECONDS = 3000;
  const STEM_ASSET_PAGE_SIZE = 500;
  const DEFAULT_TUS_CHUNK_SIZE = 6 * 1024 * 1024;
  let session = normalizeSession(readSession());
  let sessionVersion = 0;
  let refreshOperation = null;
  let accountMutationOperation = null;

  class CloudError extends Error {
    constructor(message, status = 0, code = "") {
      super(message);
      this.name = "CloudError";
      this.status = status;
      this.code = code;
    }
  }

  function configured() {
    if (awsBackend) return /^https:\/\/[a-z0-9]+\.execute-api\.us-east-1\.amazonaws\.com$/.test(baseUrl)
      && /^opusloops-uploads-\d{12}-us-east-1$/.test(config.uploadsBucket || "");
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
      detail: {
        user: session?.user
          ? { ...session.user, user_metadata: { ...session.user.user_metadata } }
          : null
      }
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
      user: normalizeUser(candidate.user)
    };
  }

  function cleanDisplayName(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase().slice(0, 254);
  }

  function normalizeUser(candidate) {
    const displayName = cleanDisplayName(candidate?.user_metadata?.display_name);
    return {
      id: String(candidate?.id || ""),
      email: normalizeEmail(candidate?.email),
      new_email: normalizeEmail(candidate?.new_email),
      created_at: String(candidate?.created_at || "").slice(0, 40),
      user_metadata: displayName ? { display_name: displayName } : {}
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

  async function timedFetch(url, options, timeoutMs = 15000, consumeResponse = null) {
    const externalSignal = options?.signal;
    const controller = new AbortController();
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (typeof consumeResponse !== "function") return response;
      return { response, body: await consumeResponse(response) };
    } catch (error) {
      if (error?.name === "AbortError" && timedOut) {
        throw new CloudError("Cloud request timed out", 0, "network_timeout");
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", forwardAbort);
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
    const { response, body: result } = await timedFetch(`${baseUrl}/auth/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }, 15000, readResponse);
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

  async function updateAuthenticatedUser(attributes, expectedUserId = session?.user?.id) {
    await accessToken(expectedUserId);
    const activeSession = assertSessionUser(expectedUserId);
    const expectedVersion = sessionVersion;
    const user = await authFetch("/user", {
      method: "PUT",
      token: activeSession.access_token,
      body: attributes
    });
    assertSessionUser(expectedUserId);
    if (!user?.id || String(user.id) !== String(expectedUserId)) {
      throw new CloudError("The active account changed", 409, "session_changed");
    }
    return storeSession({ ...activeSession, user }, expectedVersion);
  }

  async function reauthenticate(currentPassword, expectedUserId = session?.user?.id) {
    const activeSession = assertSessionUser(expectedUserId);
    const expectedVersion = sessionVersion;
    const result = await authFetch("/token?grant_type=password", {
      body: {
        email: activeSession.user.email,
        password: String(currentPassword || "")
      }
    });
    if (!result?.user?.id || String(result.user.id) !== String(expectedUserId)) {
      throw new CloudError("The active account changed", 409, "session_changed");
    }
    return storeSession(result, expectedVersion);
  }

  async function performProfileUpdate({ displayName, email, currentPassword } = {}) {
    const activeSession = assertSessionUser();
    const expectedUserId = activeSession.user.id;
    const normalizedName = cleanDisplayName(displayName);
    if (!normalizedName) {
      throw new CloudError("Enter a display name", 400, "display_name_required");
    }
    const normalizedEmail = normalizeEmail(email || activeSession.user.email);
    const emailChanged = normalizedEmail !== activeSession.user.email;
    if (emailChanged) {
      if (!normalizedEmail || !normalizedEmail.includes("@")) {
        throw new CloudError("Enter a valid email address", 400, "email_address_invalid");
      }
      if (!String(currentPassword || "")) {
        throw new CloudError("Enter your current password", 400, "current_password_required");
      }
      await reauthenticate(currentPassword, expectedUserId);
    }
    const attributes = { data: { display_name: normalizedName } };
    if (emailChanged) attributes.email = normalizedEmail;
    return updateAuthenticatedUser(attributes, expectedUserId);
  }

  async function performPasswordUpdate({ currentPassword, password } = {}) {
    const activeSession = assertSessionUser();
    const current = String(currentPassword || "");
    const next = String(password || "");
    if (!current) {
      throw new CloudError("Enter your current password", 400, "current_password_required");
    }
    if (next.length < 8) {
      throw new CloudError("Choose a password with at least 8 characters", 400, "weak_password");
    }
    if (current === next) {
      throw new CloudError("Choose a password you have not used for this session", 400, "same_password");
    }
    await reauthenticate(current, activeSession.user.id);
    return updateAuthenticatedUser({ current_password: current, password: next }, activeSession.user.id);
  }

  async function runAccountMutation(action) {
    if (accountMutationOperation) {
      throw new CloudError("Another account update is still finishing", 409, "account_update_in_progress");
    }
    const operation = Promise.resolve().then(action);
    accountMutationOperation = operation;
    try {
      return await operation;
    } finally {
      if (accountMutationOperation === operation) accountMutationOperation = null;
    }
  }

  function updateProfile(fields) {
    return runAccountMutation(() => performProfileUpdate(fields));
  }

  function updatePassword(fields) {
    return runAccountMutation(() => performPasswordUpdate(fields));
  }

  async function signOut() {
    const token = session?.access_token;
    const refreshToken = session?.refresh_token;
    storeSession(null);
    if (!token) return;
    try {
      await authFetch("/logout?scope=local", { token, body: awsBackend ? { refresh_token: refreshToken } : {} });
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
    return session
      ? { ...session, user: { ...session.user, user_metadata: { ...session.user.user_metadata } } }
      : null;
  }

  async function syncProjects(rows) {
    return dataFetch("/rpc/sync_projects", {
      method: "POST",
      body: { p_changes: rows }
    });
  }

  async function stemAction(action, fields = {}, boundUserId = session?.user?.id, requestOptions = {}) {
    if (!configured()) throw new CloudError("Stem import is not configured");
    assertSessionUser(boundUserId);
    const requiresWorkerDispatch = [
      "finalize-upload", "retry-inspection", "retry-proposal", "repair-render-proposal", "retry-render", "approve-analysis", "request-proposal", "approve-tempo", "dispatch"
    ].includes(action);
    const tokenLifetime = requiresWorkerDispatch && !awsBackend ? STEM_DISPATCH_TOKEN_SECONDS : REFRESH_MARGIN_SECONDS;
    const token = await accessToken(boundUserId, tokenLifetime);
    const response = await timedFetch(stemImportUrl, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Client-Info": "opusloops-web/1.0"
      },
      body: JSON.stringify({ action, ...fields }),
      signal: requestOptions.signal
    }, requestOptions.timeoutMs || 30000);
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
        body: JSON.stringify({ action, ...fields }),
        signal: requestOptions.signal
      }, requestOptions.timeoutMs || 30000);
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
    if (awsBackend) return uploadAwsArchive({ file, upload, jobId, onProgress, signal, userId });
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

  async function uploadAwsArchive({ file, upload, jobId, onProgress, signal, userId }) {
    const chunkSize = 8 * 1024 * 1024;
    const pieces = String(upload.objectName).split("/");
    if (upload.protocol !== "s3-multipart" || upload.endpoint !== stemImportUrl
        || upload.bucketName !== "opusloops-stem-uploads" || upload.chunkSize !== chunkSize
        || pieces.length !== 4 || pieces[0] !== userId || pieces[2] !== jobId || pieces[3] !== "source.zip") {
      throw new CloudError("Upload instructions do not match this account", 500, "invalid_upload_contract");
    }
    const checkActive = () => {
      if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
      assertSessionUser(userId);
    };
    const action = (name, fields = {}) => stemAction(name, { jobId, ...fields }, userId, { signal });
    const acceptedParts = (status) => {
      if (!Array.isArray(status.parts) || status.chunkSize !== chunkSize) {
        throw new CloudError("Upload progress could not be verified", 502, "invalid_upload_offset");
      }
      const result = new Set();
      for (const part of status.parts || []) {
        const index = Number(part.partNumber);
        const expected = Math.min(chunkSize, file.size - (index - 1) * chunkSize);
        if (!Number.isSafeInteger(index) || index < 1 || expected <= 0 || part.bytes !== expected || result.has(index)) {
          throw new CloudError("Upload progress could not be verified", 502, "invalid_upload_offset");
        }
        result.add(index);
      }
      return result;
    };
    const report = (parts) => {
      const confirmed = [...parts].reduce((total, index) => total + Math.min(chunkSize, file.size - (index - 1) * chunkSize), 0);
      onProgress?.(confirmed, file.size);
    };
    checkActive();
    let status = await action("upload-status");
    checkActive();
    if (status.complete) {
      if (status.confirmedBytes !== file.size) throw new CloudError("Completed upload size does not match this file", 502, "invalid_upload_offset");
      onProgress?.(file.size, file.size);
      return { bytesUploaded: file.size, resumed: true };
    }
    let accepted = acceptedParts(status);
    const resumed = accepted.size > 0;
    report(accepted);
    for (let partNumber = 1; partNumber <= Math.ceil(file.size / chunkSize); partNumber += 1) {
      if (accepted.has(partNumber)) continue;
      checkActive();
      const signed = await action("upload-part", { partNumber });
      checkActive();
      const url = new URL(String(signed.url || ""));
      const expectedHost = `${config.uploadsBucket}.s3.us-east-1.amazonaws.com`;
      if (url.protocol !== "https:" || url.hostname !== expectedHost || url.port || url.username || url.password
          || decodeURIComponent(url.pathname) !== `/${upload.objectName}` || signed.partNumber !== partNumber) {
        throw new CloudError("Upload URL is outside your private storage", 502, "invalid_upload_contract");
      }
      const start = (partNumber - 1) * chunkSize;
      const uploaded = await xhrRequest("PUT", url.href, { body: file.slice(start, Math.min(file.size, start + chunkSize)), signal });
      checkActive();
      if (uploaded.status < 200 || uploaded.status >= 300) throw uploadError(uploaded);
      status = await action("upload-status");
      checkActive();
      if (status.complete) {
        if (status.confirmedBytes !== file.size) throw new CloudError("Completed upload size does not match this file", 502, "invalid_upload_offset");
        onProgress?.(file.size, file.size);
        return { bytesUploaded: file.size, resumed };
      }
      accepted = acceptedParts(status);
      if (!accepted.has(partNumber)) throw new CloudError("Storage has not confirmed this upload part", 502, "invalid_upload_offset");
      report(accepted);
    }
    checkActive();
    const complete = await action("upload-complete");
    checkActive();
    if (complete.complete !== true || complete.confirmedBytes !== file.size) {
      throw new CloudError("Storage has not confirmed the completed archive", 502, "invalid_upload_offset");
    }
    onProgress?.(file.size, file.size);
    return { bytesUploaded: file.size, resumed };
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

  function retryStemProposal(jobId, revision) {
    return stemAction("retry-proposal", { jobId, revision });
  }

  function repairStemRenderProposal(jobId, revision, proposalManifestSha256) {
    return stemAction("repair-render-proposal", { jobId, revision, proposalManifestSha256 });
  }

  function retryStemRender(jobId, revision, proposalManifestSha256, tempoApprovalSha256) {
    return stemAction("retry-render", {
      jobId,
      revision,
      proposalManifestSha256,
      tempoApprovalSha256
    });
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
    const snapshot = await dataFetch("/rpc/get_stem_import_event_snapshot", {
      method: "POST",
      body: { p_job_id: String(jobId), p_after_sequence: sequence }
    });
    if (!snapshot?.job) throw new CloudError("Stem import was not found", 404, "not_found");
    // The asset read follows the atomic job/event snapshot. If the job is
    // terminal, its transaction has therefore committed before assets load.
    const assets = await fetchStemAssets(encodedJobId);
    return {
      job: snapshot.job,
      events: Array.isArray(snapshot.events) ? snapshot.events : [],
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

  function signStemArtifact(jobId, assetId, expiresInSeconds = 900, requestOptions = {}) {
    return stemAction(
      "signed-download",
      { jobId, assetId, expiresInSeconds },
      session?.user?.id,
      { ...requestOptions, timeoutMs: requestOptions.timeoutMs || 15000 }
    );
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
    updateProfile,
    updatePassword,
    signOut,
    syncProjects,
    createStemImport,
    uploadStemArchive,
    forgetStemArchiveUpload,
    finalizeStemUpload,
    retryStemInspection,
    retryStemProposal,
    repairStemRenderProposal,
    retryStemRender,
    getStemImport,
    approveStemAnalysis,
    requestStemProposal,
    approveStemTempo,
    dispatchStemImport,
    cancelStemImport,
    signStemArtifact
  });
})();
