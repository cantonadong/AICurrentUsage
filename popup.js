// Holds the service worker awake for as long as this popup stays open,
// instead of letting Chrome terminate it after ~30s idle and having to
// respawn it on the next click (that respawn is what was making the
// toolbar icon visibly redraw/flicker on open).
chrome.runtime.connect({ name: "popup" });

function applyI18n() {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
  });
}
applyI18n();

const refreshBtn = document.getElementById("refresh-btn");
const statusLine = document.getElementById("status-line");
const lastUpdatedEl = document.getElementById("last-updated");
const debugDetails = document.getElementById("debug-details");
const debugText = document.getElementById("debug-text");
const allModelsCard = document.getElementById("all-models-card");

const sessionBlock = {
  fillEl: document.getElementById("session-fill"),
  percentEl: document.getElementById("session-percent"),
  resetEl: document.getElementById("session-reset-time"),
  remainingEl: document.getElementById("session-remaining-time"),
  tickHandle: null
};

const weeklyBlock = {
  fillEl: document.getElementById("weekly-fill"),
  percentEl: document.getElementById("weekly-percent"),
  resetEl: document.getElementById("weekly-reset-time"),
  remainingEl: document.getElementById("weekly-remaining-time"),
  tickHandle: null
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "周三" (this week) / "下周三" (next week) relative to whatever week `now`
// falls in, falling back to "MM-DD" for anything further out than that
// (shouldn't happen for a 7-day rolling window, but keeps this safe if it
// ever does). Each label is a fully pre-composed i18n message (rather than
// concatenating a prefix + weekday name) since that composition doesn't
// translate cleanly across languages.
function weekLabel(d, now) {
  const mondayOffset = (now.getDay() + 6) % 7; // days since the most recent Monday
  const thisMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset);
  const nextMonday = new Date(thisMonday);
  nextMonday.setDate(thisMonday.getDate() + 7);
  const weekAfterNext = new Date(thisMonday);
  weekAfterNext.setDate(thisMonday.getDate() + 14);

  if (d >= thisMonday && d < nextMonday) return chrome.i18n.getMessage(`thisWeekday${d.getDay()}`);
  if (d >= nextMonday && d < weekAfterNext) return chrome.i18n.getMessage(`nextWeekday${d.getDay()}`);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "HH:MM" for a same-day reset (the 5-hour session limit always is);
// "Tomorrow HH:MM" for tomorrow; otherwise "Wed HH:MM" / "Next Wed HH:MM"
// (always one of these last two for the 7-day "all models" limit).
function formatResetClock(timestamp) {
  const d = new Date(timestamp);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (isSameCalendarDay(d, now)) return hm;

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (isSameCalendarDay(d, tomorrow)) return `${chrome.i18n.getMessage("tomorrow")} ${hm}`;

  return `${weekLabel(d, now)} ${hm}`;
}

// Same-day reset -> "X hr X min", or just "X min" once under an hour.
// Reset on another day -> "X d X hr", or just "X hr" once under a day.
function formatRemaining(resetTimestamp) {
  const ms = resetTimestamp - Date.now();
  if (ms <= 0) return chrome.i18n.getMessage("alreadyReset");

  if (isSameCalendarDay(new Date(resetTimestamp), new Date())) {
    const totalMinutes = Math.round(ms / 60000);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h === 0) return chrome.i18n.getMessage("remainingMinutesOnly", [String(m)]);
    return chrome.i18n.getMessage("remainingSameDay", [String(h), String(m)]);
  }

  const totalHours = Math.floor(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return chrome.i18n.getMessage("remainingHoursOnly", [String(hours)]);
  return chrome.i18n.getMessage("remainingOtherDay", [String(days), String(hours)]);
}

function setBusy(busy) {
  refreshBtn.disabled = busy;
}

function clearBlock(block) {
  block.percentEl.textContent = "--%";
  block.fillEl.style.width = "0%";
  block.resetEl.textContent = "--:--";
  block.remainingEl.textContent = "--:--";
  if (block.tickHandle) {
    clearInterval(block.tickHandle);
    block.tickHandle = null;
  }
}

function tickBlock(block, info) {
  block.resetEl.textContent = formatResetClock(info.resetTimestamp);
  block.remainingEl.textContent = formatRemaining(info.resetTimestamp);
}

function renderBlock(block, info) {
  const pct = Math.min(100, Math.max(0, info.percent));
  block.percentEl.textContent = `${info.percent}%`;
  block.fillEl.style.width = `${pct}%`;

  tickBlock(block, info);
  if (block.tickHandle) clearInterval(block.tickHandle);
  block.tickHandle = setInterval(() => tickBlock(block, info), 30 * 1000);
}

function renderError(message, debug) {
  statusLine.textContent = message || chrome.i18n.getMessage("noDataYet");
  clearBlock(sessionBlock);
  clearBlock(weeklyBlock);
  // Deliberately doesn't touch allModelsCard.hidden here: whether a plan has
  // the "all models" limit is only known after a successful fetch, so an
  // error/placeholder state leaves the card in whatever state it was already
  // in (visible by default) instead of forcing a hide/show that would resize
  // the popup.
  if (debug) {
    debugDetails.hidden = false;
    debugText.textContent = debug;
  } else {
    debugDetails.hidden = true;
  }
}

function renderSuccess(data) {
  statusLine.textContent = "";
  renderBlock(sessionBlock, data.session);

  if (data.allModels) {
    allModelsCard.hidden = false;
    renderBlock(weeklyBlock, data.allModels);
  } else {
    allModelsCard.hidden = true;
    clearBlock(weeklyBlock);
  }

  lastUpdatedEl.textContent = chrome.i18n.getMessage("lastUpdatedPrefix", [formatResetClock(data.updatedAt)]);
  debugDetails.hidden = true;
}

function render(data) {
  if (!data || !data.ok) {
    renderError(data && data.error, data && data.debugText);
    return;
  }
  renderSuccess(data);
}

async function loadCached() {
  const { claudeUsage } = await chrome.storage.local.get("claudeUsage");
  if (claudeUsage) render(claudeUsage);
}

// Actual fetching happens in background.js (a direct fetch() to claude.ai's
// own usage API, using the browser's existing session cookies) so the popup
// never has to show or wait on any extra browser UI, and so the 5-minute
// auto-refresh alarm keeps working while the popup is closed.
refreshBtn.addEventListener("click", async () => {
  setBusy(true);
  statusLine.textContent = chrome.i18n.getMessage("queryingStatus");
  debugDetails.hidden = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "refresh-claude" });
    if (resp && resp.ok) {
      render(resp.data);
    } else {
      const message = resp && resp.error
        ? chrome.i18n.getMessage("errorPrefix", [resp.error])
        : chrome.i18n.getMessage("refreshFailed");
      renderError(message);
    }
  } catch (e) {
    renderError(chrome.i18n.getMessage("errorPrefix", [e.message]));
  } finally {
    setBusy(false);
  }
});

// Keeps the popup in sync if the background alarm refreshes data while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.claudeUsage) {
    render(changes.claudeUsage.newValue);
  }
});

// Stop the 30s tick timers the instant the popup starts closing, instead of
// letting Chrome garbage-collect them whenever it gets around to it. This
// guarantees no DOM mutation is in flight in this popup's last moments.
window.addEventListener("pagehide", () => {
  if (sessionBlock.tickHandle) clearInterval(sessionBlock.tickHandle);
  if (weeklyBlock.tickHandle) clearInterval(weeklyBlock.tickHandle);
});

loadCached();
