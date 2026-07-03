// Service worker: fetches usage data directly from claude.ai's own JSON API
// using the browser's existing claude.ai session cookies — no tab, no
// window, no page rendering. This also drives the 5-minute auto-refresh so
// it keeps working while the popup is closed.

const CLAUDE_ORIGIN = "https://claude.ai";
const ALARM_NAME = "claude-usage-refresh";
const REFRESH_PERIOD_MINUTES = 5;

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
    refreshClaudeUsage().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "refresh-claude") {
    refreshClaudeUsage()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep the message channel open for the async response
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
  chrome.alarms.get(ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
    }
  });
}

async function restoreBadgeFromCache() {
  const { claudeUsage } = await chrome.storage.local.get("claudeUsage");
  if (claudeUsage) await updateBadge(claudeUsage);
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
    await chrome.storage.local.set({ claudeUsage: data });
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
    await chrome.storage.local.set({ claudeUsage: data });
    return data;
  }

  if (resp.status === 401 || resp.status === 403) {
    const data = errorData(chrome.i18n.getMessage("notLoggedIn"));
    await chrome.storage.local.set({ claudeUsage: data });
    return data;
  }
  if (!resp.ok) {
    const data = errorData(chrome.i18n.getMessage("httpError", [String(resp.status)]));
    await chrome.storage.local.set({ claudeUsage: data });
    return data;
  }

  const payload = await resp.json();
  const sessionRaw = payload && payload.five_hour;
  if (!sessionRaw || typeof sessionRaw.utilization !== "number" || !sessionRaw.resets_at) {
    const data = errorData(
      chrome.i18n.getMessage("missingSessionField"),
      JSON.stringify(payload, null, 2).slice(0, 3000)
    );
    await chrome.storage.local.set({ claudeUsage: data });
    return data;
  }

  // "All models" is the 7-day limit shared across every Claude model. Some
  // plans don't expose it (payload.seven_day is null), so it's optional.
  const weeklyRaw = payload && payload.seven_day;
  const allModels =
    weeklyRaw && typeof weeklyRaw.utilization === "number" && weeklyRaw.resets_at
      ? { percent: Math.round(weeklyRaw.utilization), resetTimestamp: new Date(weeklyRaw.resets_at).getTime() }
      : null;

  const data = {
    ok: true,
    updatedAt: Date.now(),
    session: {
      percent: Math.round(sessionRaw.utilization),
      resetTimestamp: new Date(sessionRaw.resets_at).getTime()
    },
    allModels
  };

  await chrome.storage.local.set({ claudeUsage: data });
  await updateBadge(data);
  return data;
}
