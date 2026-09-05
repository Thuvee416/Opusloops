(() => {
  "use strict";

  const config = window.OPUSLOOPS_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const publishableKey = String(config.supabasePublishableKey || "");
  const SESSION_KEY = "opusloops.auth.session.v1";
  const SESSION_EVENT = "opusloops:auth-session-change";
  const REFRESH_MARGIN_SECONDS = 60;
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

  async function accessToken(expectedUserId) {
    const activeSession = assertSessionUser(expectedUserId);
    if (activeSession.expires_at - Math.floor(Date.now() / 1000) <= REFRESH_MARGIN_SECONDS) {
      await refreshSession(expectedUserId);
    }
    return assertSessionUser(expectedUserId).access_token;
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
    syncProjects
  });
})();
