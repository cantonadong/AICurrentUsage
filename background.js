// Service worker: fetches usage data directly from claude.ai's own JSON API
// using the browser's existing claude.ai session cookies — no tab, no
// window, no page rendering. This also drives the 5-minute auto-refresh so
// it keeps working while the popup is closed.

const CLAUDE_ORIGIN = "https://claude.ai";
const ALARM_NAME = "claude-usage-refresh";
const REFRESH_PERIOD_MINUTES = 5;

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  restoreBadgeFromCache();
  refreshClaudeUsage().catch(() => {});
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

// 0-20 green, >20-40 olive/lime, >40-60 amber, >60-80 orange, >80-90 red,
// >90-100 deep red. The >20-40 tier deliberately leans yellow (not just a
// lighter green) so it reads as visibly different from the 0-20 tier at
// badge size; the >90 tier is a noticeably darker red than >80-90 as a
// last-call warning.
function badgeColorForPercent(percent) {
  if (percent <= 20) return "#2e7d32";
  if (percent <= 40) return "#9e9d24";
  if (percent <= 60) return "#f57f17";
  if (percent <= 80) return "#ef6c00";
  if (percent <= 90) return "#c62828";
  return "#7f0000";
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
    await chrome.action.setBadgeText({ text: String(percent) });
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
