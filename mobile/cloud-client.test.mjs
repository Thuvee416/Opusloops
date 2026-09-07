import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const CLIENT_SOURCE = await readFile(new URL("./cloud-client.js", import.meta.url), "utf8");
const SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_key";
const SESSION_KEY = "opusloops.auth.session.v1";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function sessionFixture({
  accessToken = "access-a",
  refreshToken = "refresh-a",
  email = "person@example.com",
  displayName = "Original Name",
  newEmail = "",
} = {}) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      email,
      new_email: newEmail,
      user_metadata: {
        display_name: displayName,
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return entries.has(String(key)) ? entries.get(String(key)) : null;
    },
    setItem(key, value) {
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      entries.delete(String(key));
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function requestDetails(input, init = {}) {
  return {
    url: String(input),
    method: String(init.method || "GET").toUpperCase(),
    headers: new Headers(init.headers),
    body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

function loadClient({
  initialSession = sessionFixture(),
  fetchImpl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  const storage = memoryStorage({ [SESSION_KEY]: JSON.stringify(initialSession) });
  const listeners = new Map();
  class TestCustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const window = {
    OPUSLOOPS_CONFIG: {
      supabaseUrl: SUPABASE_URL,
      supabasePublishableKey: PUBLISHABLE_KEY,
    },
    CustomEvent: TestCustomEvent,
    addEventListener(type, listener) {
      const group = listeners.get(type) || [];
      group.push(listener);
      listeners.set(type, group);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    },
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
  };
  window.window = window;

  const context = vm.createContext({
    AbortController,
    DOMException,
    Headers,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    Uint8Array,
    atob,
    btoa,
    fetch: fetchImpl,
    localStorage: storage,
    navigator: { onLine: true },
    window,
  });
  vm.runInContext(CLIENT_SOURCE, context, { filename: "mobile/cloud-client.js" });
  return { cloud: window.OpusloopsCloud, storage };
}

test("getSession keeps only a bounded profile name and pending email", () => {
  const longDisplayName = `\u0000${"A".repeat(60)}\n`;
  const longPendingEmail = `pending+${"x".repeat(260)}@example.com`;
  const initialSession = sessionFixture({
    displayName: longDisplayName,
    newEmail: longPendingEmail,
  });
  initialSession.user.user_metadata.is_admin = true;
  initialSession.user.user_metadata.preferences = { hidden: true };

  const { cloud } = loadClient({
    initialSession,
    fetchImpl: async () => {
      throw new Error("getSession must not make a network request");
    },
  });
  const user = cloud.getSession().user;

  assert.deepEqual(plain(user.user_metadata), { display_name: "A".repeat(40) });
  assert.equal(user.new_email, longPendingEmail.slice(0, 254));
  assert.doesNotMatch(user.user_metadata.display_name, /[\u0000-\u001f\u007f]/);
});

test("updateProfile skips password reauthentication when the email is unchanged", async () => {
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      assert.equal(new URL(call.url).pathname, "/auth/v1/user");
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body, { data: { display_name: "New Name" } });
      assert.equal(call.headers.get("Authorization"), "Bearer access-a");
      return jsonResponse({
        id: USER_ID,
        email: "person@example.com",
        user_metadata: { display_name: "New Name", ignored: "server-value" },
      });
    },
  });

  await cloud.updateProfile({
    displayName: "  New    Name  ",
    email: "person@example.com",
    currentPassword: "should-not-be-sent",
  });

  assert.equal(calls.length, 1);
  const session = cloud.getSession();
  assert.equal(session.access_token, "access-a");
  assert.equal(session.refresh_token, "refresh-a");
  assert.deepEqual(plain(session.user.user_metadata), { display_name: "New Name" });
});

test("updateProfile reauthenticates before requesting an email change", async () => {
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === "/auth/v1/token") {
        assert.equal(url.searchParams.get("grant_type"), "password");
        assert.equal(call.method, "POST");
        assert.deepEqual(call.body, {
          email: "person@example.com",
          password: "current-password",
        });
        return jsonResponse(sessionFixture({
          accessToken: "reauthenticated-access",
          refreshToken: "reauthenticated-refresh",
        }));
      }
      assert.equal(url.pathname, "/auth/v1/user");
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body, {
        email: "next@example.com",
        data: { display_name: "Next Name" },
      });
      assert.match(call.headers.get("Authorization") || "", /^Bearer /);
      return jsonResponse({
        id: USER_ID,
        email: "person@example.com",
        new_email: "next@example.com",
        user_metadata: { display_name: "Next Name" },
      });
    },
  });

  await cloud.updateProfile({
    displayName: "Next Name",
    email: " Next@Example.com ",
    currentPassword: "current-password",
  });

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/auth/v1/token");
  assert.equal(new URL(calls[1].url).pathname, "/auth/v1/user");
  assert.equal(cloud.getSession().user.email, "person@example.com");
  assert.equal(cloud.getSession().user.new_email, "next@example.com");
});

test("updatePassword reauthenticates before updating with the refreshed bearer", async () => {
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === "/auth/v1/token") {
        assert.equal(url.searchParams.get("grant_type"), "password");
        assert.equal(call.method, "POST");
        assert.deepEqual(call.body, {
          email: "person@example.com",
          password: "current-password",
        });
        return jsonResponse(sessionFixture({
          accessToken: "reauthenticated-access",
          refreshToken: "reauthenticated-refresh",
        }));
      }
      assert.equal(url.pathname, "/auth/v1/user");
      assert.equal(call.method, "PUT");
      assert.deepEqual(call.body, {
        current_password: "current-password",
        password: "a-new-strong-password",
      });
      assert.equal(call.headers.get("Authorization"), "Bearer reauthenticated-access");
      return jsonResponse({
        id: USER_ID,
        email: "person@example.com",
        user_metadata: { display_name: "Original Name" },
      });
    },
  });

  await cloud.updatePassword({
    currentPassword: "current-password",
    password: "a-new-strong-password",
  });

  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/auth/v1/token");
  assert.equal(new URL(calls[1].url).pathname, "/auth/v1/user");
  assert.equal(cloud.getSession().access_token, "reauthenticated-access");
  assert.equal(cloud.getSession().refresh_token, "reauthenticated-refresh");
});

test("updatePassword rejects a wrong current password without making a user update", async () => {
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      const url = new URL(call.url);
      assert.equal(url.pathname, "/auth/v1/token");
      assert.equal(url.searchParams.get("grant_type"), "password");
      assert.equal(call.method, "POST");
      return jsonResponse({
        error_code: "invalid_credentials",
        msg: "Invalid login credentials",
      }, 400);
    },
  });

  await assert.rejects(
    cloud.updatePassword({
      currentPassword: "wrong-password",
      password: "a-new-strong-password",
    }),
    (error) => error?.code === "invalid_credentials" && error?.status === 400,
  );

  assert.equal(calls.length, 1);
  assert.equal(cloud.getSession().access_token, "access-a");
  assert.equal(cloud.getSession().refresh_token, "refresh-a");
});

test("concurrent profile and password mutations allow only one server update", async () => {
  let resolveProfile;
  const profileResponse = new Promise((resolve) => {
    resolveProfile = resolve;
  });
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      const url = new URL(call.url);
      assert.equal(url.pathname, "/auth/v1/user");
      assert.deepEqual(call.body, { data: { display_name: "Delayed Profile" } });
      return profileResponse;
    },
  });

  const delayedProfile = cloud.updateProfile({
    displayName: "Delayed Profile",
    email: "person@example.com",
  });
  await assert.rejects(
    cloud.updatePassword({
      currentPassword: "current-password",
      password: "a-new-strong-password",
    }),
    (error) => error?.code === "account_update_in_progress" && error?.status === 409,
  );
  resolveProfile(jsonResponse({
    id: USER_ID,
    email: "person@example.com",
    user_metadata: { display_name: "Delayed Profile" },
  }));

  await delayedProfile;
  const active = cloud.getSession();
  assert.equal(active.access_token, "access-a");
  assert.equal(active.refresh_token, "refresh-a");
  assert.equal(active.user.user_metadata.display_name, "Delayed Profile");
  assert.equal(calls.length, 1);
});

test("a stale same-user profile response cannot replace a newer session", async () => {
  let resolveProfile;
  const profileResponse = new Promise((resolve) => {
    resolveProfile = resolve;
  });
  const calls = [];
  const { cloud } = loadClient({
    fetchImpl: async (input, init) => {
      const call = requestDetails(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === "/auth/v1/user") return profileResponse;
      assert.equal(url.pathname, "/auth/v1/token");
      assert.equal(url.searchParams.get("grant_type"), "password");
      return jsonResponse(sessionFixture({
        accessToken: "access-b",
        refreshToken: "refresh-b",
        displayName: "Fresh Session",
      }));
    },
  });

  const staleUpdate = cloud.updateProfile({
    displayName: "Stale Response",
    email: "person@example.com",
    currentPassword: "unused",
  });
  await Promise.resolve();
  await cloud.signIn("person@example.com", "new-session-password");
  resolveProfile(jsonResponse({
    id: USER_ID,
    email: "person@example.com",
    user_metadata: { display_name: "Stale Response" },
  }));

  await assert.rejects(staleUpdate, (error) => error?.code === "session_changed");
  const active = cloud.getSession();
  assert.equal(active.access_token, "access-b");
  assert.equal(active.refresh_token, "refresh-b");
  assert.equal(active.user.user_metadata.display_name, "Fresh Session");
  assert.equal(calls.length, 2);
});

test("a stalled auth response body times out and releases the account mutation lock", async () => {
  let requestCount = 0;
  const { cloud } = loadClient({
    setTimeoutImpl: (callback) => setTimeout(callback, 5),
    clearTimeoutImpl: clearTimeout,
    fetchImpl: async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: true,
          status: 200,
          text: () => new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("The request was aborted", "AbortError"));
            }, { once: true });
          }),
        };
      }
      return jsonResponse({
        id: USER_ID,
        email: "person@example.com",
        user_metadata: { display_name: "Recovered Profile" },
      });
    },
  });

  await assert.rejects(
    cloud.updateProfile({
      displayName: "Timed Out Profile",
      email: "person@example.com",
    }),
    (error) => error?.code === "network_timeout" && error?.status === 0,
  );

  const recovered = await cloud.updateProfile({
    displayName: "Recovered Profile",
    email: "person@example.com",
  });
  assert.equal(recovered.user.user_metadata.display_name, "Recovered Profile");
  assert.equal(requestCount, 2);
});
