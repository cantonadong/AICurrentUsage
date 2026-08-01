// Service worker: fetches usage data directly from claude.ai's own JSON API
// using the browser's existing claude.ai session cookies — no tab, no
// window, no page rendering. This also drives the 5-minute auto-refresh so
// it keeps working while the popup is closed.

const CLAUDE_ORIGIN = "https://claude.ai";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_SESSION_URL = `${CHATGPT_ORIGIN}/api/auth/session`;
const CODEX_USAGE_URL = `${CHATGPT_ORIGIN}/backend-api/wham/usage`;
const ALARM_NAME = "ai-usage-refresh";
const LEGACY_ALARM_NAME = "claude-usage-refresh";
const REFRESH_PERIOD_MINUTES = 5;
const DEFAULT_PROVIDER = "claude";

// Deliberately does NOT kick off a refreshClaudeUsage() network call here.
// onInstalled fires on every extension reload (including "reload" clicks in
// chrome://extensions during development) — if that fetch happens to
// resolve at the exact moment the user clicks the toolbar icon, the
// resulting badge/icon update makes Chrome redraw the toolbar mid-click,
// which is exactly the flicker/missed-click bug this was causing. The first
// real fetch now only ever happens from a user-initiated refresh click or
// the periodic alarm below — both deterministic, neither racing a click.
chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  restoreBadgeFromCache();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  restoreBadgeFromCache();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshActiveUsage().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "refresh-claude") {
    refreshClaudeUsage()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the message channel open for the async response
  }
  if (message && message.type === "refresh-provider") {
    refreshProviderUsage(message.provider)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message && message.type === "set-provider") {
    setActiveProvider(message.provider)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

// popup.js opens this port on load and holds it for as long as the popup
// stays open. An active port keeps this service worker from being
// terminated as idle, so opening the popup doesn't have to respawn it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  console.log(`[sw] popup connected at ${new Date().toLocaleTimeString()}`);
  port.onDisconnect.addListener(() => {
    console.log(`[sw] popup disconnected at ${new Date().toLocaleTimeString()}`);
  });
});

function ensureAlarm() {
  chrome.alarms.clear(LEGACY_ALARM_NAME);
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
    }
  });
}

async function restoreBadgeFromCache() {
  const provider = await getActiveProvider();
  const data = await getCachedUsage(provider);
  if (data) await updateBadge(data);
}

async function getActiveProvider() {
  const { activeProvider } = await chrome.storage.local.get("activeProvider");
  return activeProvider === "codex" ? "codex" : DEFAULT_PROVIDER;
}

async function setActiveProvider(provider) {
  const normalized = provider === "codex" ? "codex" : DEFAULT_PROVIDER;
  await chrome.storage.local.set({ activeProvider: normalized });
  const data = await getCachedUsage(normalized);
  if (data) await updateBadge(data);
}

function storageKeyForProvider(provider) {
  return provider === "codex" ? "codexUsage" : "claudeUsage";
}

async function getCachedUsage(provider) {
  const key = storageKeyForProvider(provider);
  const cached = await chrome.storage.local.get(key);
  return cached[key];
}

async function saveUsage(provider, data) {
  const key = storageKeyForProvider(provider);
  await chrome.storage.local.set({ [key]: data });
}

async function refreshActiveUsage() {
  return refreshProviderUsage(await getActiveProvider());
}

async function refreshProviderUsage(provider) {
  return provider === "codex" ? refreshCodexUsage() : refreshClaudeUsage();
}

// 0-20 green, >20-40 blue, >40-60 yellow, >60-80 orange, >80-90 red,
// >90-100 deep red, as a last-call warning.
function badgeColorForPercent(percent) {
  if (percent <= 20) return "#22C55E";
  if (percent <= 40) return "#0284C7";
  if (percent <= 60) return "#FACC15";
  if (percent <= 80) return "#F97316";
  if (percent <= 90) return "#EF4444";
  return "#7F1D1D";
}

// The badge always reflects the session (5-hour) limit, since that's the
// one users hit most often day-to-day; "all models" (7-day) is shown only
// inside the popup. Wrapped in try/catch so a badge-API hiccup can't fail
// the whole refresh (data is already saved to storage by the time this runs).
async function updateBadge(data) {
  const percent = data && data.ok && data.session ? data.session.percent : null;
  if (percent == null) return;
  console.log(`[icon] updateBadge percent=${percent} at ${new Date().toLocaleTimeString()}`);
  try {
    // Zero-padded to 2 digits so the badge's rendered width stays constant
    // across the 0-99 range (only 100 itself is a 3rd character) — a
    // changing badge width can shift the toolbar icon's bounding box and
    // ripple into neighboring icons.
    const text = percent >= 100 ? "100" : String(percent).padStart(2, "0");
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: badgeColorForPercent(percent) });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } catch (e) {
    console.error("updateBadge failed", e);
  }
}

function errorData(message, debugText) {
  return { ok: false, error: message, debugText, updatedAt: Date.now() };
}

// claude.ai stores the active organization id in this cookie, in plain text,
// so there's no need to open a tab just to discover it.
async function getActiveOrgId() {
  const cookie = await chrome.cookies.get({ url: CLAUDE_ORIGIN, name: "lastActiveOrg" });
  return cookie ? cookie.value : null;
}

async function refreshClaudeUsage() {
  const orgId = await getActiveOrgId();
  if (!orgId) {
    const data = errorData(chrome.i18n.getMessage("notLoggedIn"));
    await saveUsage("claude", data);
    return data;
  }

  const url = `${CLAUDE_ORIGIN}/api/organizations/${orgId}/usage`;
  let resp;
  try {
    resp = await fetch(url, {
      credentials: "include",
      headers: {
        accept: "application/json",
        "anthropic-client-platform": "web_claude_ai"
      }
    });
  } catch (e) {
    const data = errorData(chrome.i18n.getMessage("requestFailed", [e.message]));
    await saveUsage("claude", data);
    return data;
  }

  if (resp.status === 401 || resp.status === 403) {
    const data = errorData(chrome.i18n.getMessage("notLoggedIn"));
    await saveUsage("claude", data);
    return data;
  }
  if (!resp.ok) {
    const data = errorData(chrome.i18n.getMessage("httpError", [String(resp.status)]));
    await saveUsage("claude", data);
    return data;
  }

  const payload = await resp.json();
  const sessionRaw = payload && payload.five_hour;
  if (!sessionRaw || typeof sessionRaw.utilization !== "number") {
    const data = errorData(
      chrome.i18n.getMessage("missingSessionField"),
      JSON.stringify(payload, null, 2).slice(0, 3000)
    );
    await saveUsage("claude", data);
    return data;
  }

  // "All models" is the 7-day limit shared across every Claude model. Some
  // plans don't expose it (payload.seven_day is null), so it's optional.
  const weeklyRaw = payload && payload.seven_day;
  const allModels =
    weeklyRaw && typeof weeklyRaw.utilization === "number" && weeklyRaw.resets_at
      ? { percent: Math.round(weeklyRaw.utilization), resetTimestamp: new Date(weeklyRaw.resets_at).getTime() }
      : null;

  // resets_at is null when there's no session currently in progress (nothing
  // sent since the last reset) — utilization is 0 and there's no countdown
  // to show, as opposed to a parse failure.
  const data = {
    ok: true,
    updatedAt: Date.now(),
    session: {
      percent: Math.round(sessionRaw.utilization),
      resetTimestamp: sessionRaw.resets_at ? new Date(sessionRaw.resets_at).getTime() : null
    },
    allModels
  };

  await saveUsage("claude", data);
  await updateBadge(data);
  return data;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.includes("T")) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const n = asNumber(value);
  if (n == null) return null;
  return n > 10 ** 11 ? n : n * 1000;
}

function firstObject(container, keys) {
  if (!container || typeof container !== "object") return null;
  for (const key of keys) {
    if (container[key] && typeof container[key] === "object") return container[key];
  }
  return null;
}

function unwrapWindow(raw) {
  if (!raw || typeof raw !== "object") return null;
  return raw.primary_window && typeof raw.primary_window === "object" ? raw.primary_window : raw;
}

function inferCodexWindowName(info) {
  const seconds = asNumber(info && info.limit_window_seconds);
  if (seconds == null) return null;
  if (seconds <= 6 * 3600) return "session";
  if (seconds >= 6 * 24 * 3600) return "weekly";
  return null;
}

function parseCodexWindow(raw) {
  const info = unwrapWindow(raw);
  if (!info) return null;

  let used = asNumber(info.used_percent);
  if (used == null) {
    const remaining = asNumber(info.percent_left ?? info.remaining_percent);
    if (remaining != null) used = 100 - remaining;
  }
  if (used == null) return null;

  const resetTimestamp = timestampToMs(
    info.reset_time_ms ?? info.reset_at ?? info.resetAfterSeconds
  );
  const resetAfterSeconds = asNumber(info.reset_after_seconds);

  return {
    percent: Math.round(Math.min(100, Math.max(0, used))),
    resetTimestamp: resetTimestamp ?? (resetAfterSeconds == null ? null : Date.now() + resetAfterSeconds * 1000),
    limitWindowSeconds: asNumber(info.limit_window_seconds)
  };
}

function parseCodexUsage(payload) {
  const root = payload && typeof payload === "object" ? payload : {};
  const rateLimit = root.rate_limit && typeof root.rate_limit === "object" ? root.rate_limit : root;

  let session = parseCodexWindow(
    firstObject(rateLimit, ["five_hour", "five_hour_limit", "five_hour_rate_limit", "primary", "primary_window"])
  );
  let weekly = parseCodexWindow(
    firstObject(rateLimit, ["weekly", "weekly_limit", "weekly_rate_limit", "secondary", "secondary_window"])
  );

  if (!session || !weekly) {
    for (const value of Object.values(rateLimit)) {
      const parsed = parseCodexWindow(value);
      const name = inferCodexWindowName(parsed);
      if (name === "session" && !session) session = parsed;
      if (name === "weekly" && !weekly) weekly = parsed;
    }
  }

  if (session && weekly && session.limitWindowSeconds && weekly.limitWindowSeconds) {
    if (session.limitWindowSeconds > weekly.limitWindowSeconds) {
      const tmp = session;
      session = weekly;
      weekly = tmp;
    }
  }

  if (!session && !weekly) return null;
  return { session, allModels: weekly };
}

function findNestedString(value, keys) {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct) return direct;
  }
  for (const child of Object.values(value)) {
    const found = findNestedString(child, keys);
    if (found) return found;
  }
  return null;
}

function extractCodexAuth(sessionPayload) {
  const accessToken = findNestedString(sessionPayload, [
    "accessToken",
    "access_token",
    "accessTokenExpires"
  ]);
  const accountId = findNestedString(sessionPayload, [
    "account_id",
    "accountId",
    "accountID"
  ]);

  return {
    accessToken: accessToken && accessToken.startsWith("ey") ? accessToken : null,
    accountId
  };
}

async function readCodexAuth() {
  let resp;
  try {
    resp = await fetch(CHATGPT_SESSION_URL, {
      credentials: "include",
      headers: { accept: "application/json" }
    });
  } catch (e) {
    return {
      ok: false,
      data: errorData(chrome.i18n.getMessage("requestFailed", [e.message]))
    };
  }

  const bodyText = await resp.text();
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (e) {
    payload = null;
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      data: errorData(chrome.i18n.getMessage("codexNotLoggedIn"), bodyText.slice(0, 1000))
    };
  }
  if (!resp.ok) {
    return {
      ok: false,
      data: errorData(
        chrome.i18n.getMessage("httpError", [String(resp.status)]),
        bodyText.slice(0, 1000)
      )
    };
  }

  const auth = extractCodexAuth(payload);
  if (!auth.accessToken) {
    return {
      ok: false,
      data: errorData(
        chrome.i18n.getMessage("missingCodexAuthField"),
        JSON.stringify(payload, (key, value) => {
          if (String(key).toLowerCase().includes("token")) return "[redacted]";
          return value;
        }, 2).slice(0, 3000)
      )
    };
  }

  return { ok: true, auth };
}

async function refreshCodexUsage() {
  const authResult = await readCodexAuth();
  if (!authResult.ok) {
    await saveUsage("codex", authResult.data);
    return authResult.data;
  }

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${authResult.auth.accessToken}`,
    "openai-beta": "codex-1",
    originator: "Codex Desktop"
  };
  if (authResult.auth.accountId) {
    headers["chatgpt-account-id"] = authResult.auth.accountId;
  }

  let resp;
  try {
    resp = await fetch(CODEX_USAGE_URL, {
      credentials: "include",
      headers
    });
  } catch (e) {
    const data = errorData(chrome.i18n.getMessage("requestFailed", [e.message]));
    await saveUsage("codex", data);
    return data;
  }

  const bodyText = await resp.text();
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (e) {
    payload = null;
  }

  if (resp.status === 401 || resp.status === 403) {
    const data = errorData(chrome.i18n.getMessage("codexNotLoggedIn"), bodyText.slice(0, 1000));
    await saveUsage("codex", data);
    return data;
  }
  if (!resp.ok) {
    const data = errorData(
      chrome.i18n.getMessage("httpError", [String(resp.status)]),
      bodyText.slice(0, 1000)
    );
    await saveUsage("codex", data);
    return data;
  }

  const parsed = parseCodexUsage(payload);
  if (!parsed || !parsed.session) {
    const data = errorData(
      chrome.i18n.getMessage("missingCodexUsageField"),
      JSON.stringify(payload, null, 2).slice(0, 3000)
    );
    await saveUsage("codex", data);
    return data;
  }

  const data = {
    ok: true,
    updatedAt: Date.now(),
    session: parsed.session,
    allModels: parsed.allModels
  };

  await saveUsage("codex", data);
  await updateBadge(data);
  return data;
}
