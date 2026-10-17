import { DEFAULT_EXCLUSIONS, isExcluded, parseExclusions } from "./core.js";
import { FocusSession } from "./session.js";
import { PdfReader } from "./pdf-client.js";
import { JevClient, KEY_REQUIRED, normalizeApiKey } from "./jev-client.js";

const jev = new JevClient();
let settings;
let apiKey = "";
let engine;
let saves = Promise.resolve();
let controls = Promise.resolve();
const pdfReader = new PdfReader();
// Content scripts can't read extension files unless every page can, so the focus screen
// receives the bundled font as data and registers it with the FontFace API.
const LATIN = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT = "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";
const FONT_FILES = [
  ["TabFit Instrument Sans", "400 700", "instrument-sans-latin-wght-normal.woff2", LATIN],
  ["TabFit Instrument Sans", "400 700", "instrument-sans-latin-ext-wght-normal.woff2", LATIN_EXT],
  ["TabFit JetBrains Mono", "100 800", "jetbrains-mono-latin-wght-normal.woff2", LATIN],
  ["TabFit JetBrains Mono", "100 800", "jetbrains-mono-latin-ext-wght-normal.woff2", LATIN_EXT],
];
let fonts;

function loadFonts() {
  fonts ??= Promise.all(FONT_FILES.map(async ([family, weight, file, unicodeRange]) => {
    const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL(`vendor/fonts/${file}`))).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { family, weight, data: btoa(binary), unicodeRange };
  })).catch(error => { fonts = null; throw error; });
  return fonts;
}

function requireKey() {
  if (!apiKey) throw new Error(KEY_REQUIRED);
}

function clearChecks() {
  jev.cancel();
  pdfReader.clear();
  engine.epoch++;
  engine.pending.clear();
  engine.state.cache = {};
  engine.state.lastDecision = null;
  engine.cooldownUntil = 0;
}

function control(action) {
  const result = controls.then(action);
  controls = result.catch(() => {});
  return result;
}

const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const [local, memory] = await Promise.all([
    chrome.storage.local.get(["settings", "typeSafeApiKey"]), chrome.storage.session.get("focusState"),
  ]);
  const saved = local.settings || {};
  settings = { exclusions: saved.exclusions ?? DEFAULT_EXCLUSIONS, lastGoal: saved.lastGoal ?? "", minutes: saved.minutes ?? 25 };
  // Drop obsolete pairing data without returning or copying credentials to pages.
  await chrome.storage.local.set({ settings });
  try { apiKey = normalizeApiKey(local.typeSafeApiKey ?? ""); } catch { apiKey = ""; }
  engine = new FocusSession({
    state: memory.focusState,
    preparePage: page => pdfReader.prepare(page),
    classify: (goal, page) => {
      requireKey();
      if (!engine.active()) throw new Error("The focus session stopped.");
      return jev.classify({ apiKey, goal, page });
    },
    save: state => {
      const next = saves.catch(() => {}).then(() => chrome.storage.session.set({ focusState: state }));
      saves = next;
      return next;
    },
  });
  if (engine.state.session && !engine.state.session.paused && !engine.active()) await engine.end();
  if (engine.active() && !apiKey) await engine.pause();
  await setAlarm();
})();

async function setAlarm() {
  await chrome.alarms.clear("focus-end");
  if (engine.active()) await chrome.alarms.create("focus-end", { when: engine.state.session.endsAt });
  await chrome.action.setBadgeBackgroundColor({ color: engine.active() ? "#2f5bff" : "#5f6678" });
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setBadgeText({ text: engine.active() ? "ON" : engine.state.session?.paused ? "Ⅱ" : "" });
}

async function nudge(tabId, reset = false) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url ?? "")) return;
  // Sleeping tabs can take seconds to answer; their pages check again when shown.
  if (tab.discarded || tab.frozen) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: reset ? "RESET" : "INSPECT" });
  } catch {
    // Background tabs get their script when they are activated.
    if (!tab.active) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { type: reset ? "RESET" : "INSPECT" });
    } catch { /* Browser pages and protected pages cannot run content scripts. */ }
  }
}

// Never awaited by anything a person waits on: a slow tab must not hold up the popup or other pages.
async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.map(tab => nudge(tab.id, !engine.active())));
}

async function expire() {
  if (engine.state.session && !engine.state.session.paused && !engine.active()) {
    pdfReader.clear();
    await engine.end();
    jev.cancel();
    await setAlarm();
    void refreshTabs();
  }
}

async function eligibleTab(sender, url) {
  if (!sender.tab || sender.frameId !== 0 || sender.tab.incognito ||
      (sender.documentLifecycle && sender.documentLifecycle !== "active")) return null;
  try {
    const tab = await chrome.tabs.get(sender.tab.id);
    if (!tab.active || tab.url !== url || isExcluded(url, settings.exclusions)) return null;
    return tab;
  } catch { return null; }
}

async function route(message, sender) {
  await ready;
  await control(expire);
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") throw new Error("Invalid request.");
  const isPopup = sender.url === chrome.runtime.getURL("popup.html");
  if (sender.tab && !isPopup) {
    const tab = await eligibleTab(sender, message.url);
    if (!tab) return { status: "excluded" };
    if (message.type === "FONT") return loadFonts();
    if (message.type === "CONTEXT") {
      return engine.active() ? { status: "active", session: engine.state.session } : { status: "idle" };
    }
    if (message.type === "CHECK_PAGE") {
      return engine.check({ tabId: tab.id, url: message.url, sessionId: message.sessionId,
        page: { ...message.page, url: message.url },
        isCurrent: async () => Boolean(await eligibleTab(sender, message.url)),
      });
    }
    if (message.type === "ALLOW_PAGE") {
      engine.invalidate(tab.id);
      const result = await engine.override(message.url, message.sessionId);
      void refreshTabs();
      return result;
    }
    if (message.type === "END_SESSION" && engine.state.session?.id === message.sessionId) {
      return control(async () => {
        if (engine.state.session?.id === message.sessionId) {
          pdfReader.clear();
          await engine.end();
          jev.cancel();
          await setAlarm();
          void refreshTabs();
        }
        return { status: "idle" };
      });
    }
    throw new Error("Unsupported page request.");
  }

  if (!isPopup) throw new Error("Open TabFit to change settings.");
  if (message.type === "GET_STATE") {
    return { session: engine.state.session, lastDecision: engine.state.lastDecision,
      settings: { hasApiKey: Boolean(apiKey), exclusions: settings.exclusions,
        lastGoal: settings.lastGoal, minutes: settings.minutes } };
  }
  return control(() => popupAction(message));
}

async function popupAction(message) {
  try {
    switch (message.type) {
      case "SAVE_SETTINGS": {
        const exclusions = parseExclusions(message.exclusions);
        const replacement = normalizeApiKey(message.apiKey ?? "");
        const next = { ...settings, exclusions };
        await chrome.storage.local.set({ settings: next, ...(replacement ? { typeSafeApiKey: replacement } : {}) });
        settings = next;
        if (replacement) apiKey = replacement;
        clearChecks();
        await engine.persist();
        break;
      }
      case "REMOVE_API_KEY":
        await chrome.storage.local.remove("typeSafeApiKey");
        apiKey = "";
        clearChecks();
        await engine.pause();
        await engine.persist();
        break;
      case "START_SESSION":
        requireKey();
        clearChecks();
        await engine.start(message.goal, message.minutes);
        settings = { ...settings, lastGoal: engine.state.session.goal, minutes: message.minutes };
        await chrome.storage.local.set({ settings });
        break;
      case "PAUSE_SESSION": pdfReader.clear(); await engine.pause(); break;
      case "RESUME_SESSION":
        requireKey();
        await engine.resume();
        break;
      case "END_SESSION": pdfReader.clear(); await engine.end(); break;
      default: throw new Error("Unknown action.");
    }
    return { session: engine.state.session };
  } finally {
    if (!engine.active()) jev.cancel();
    await setAlarm();
    void refreshTabs();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "pdf-offscreen") return;
  route(message, sender).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "focus-end") void ready.then(() => control(expire)).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void ready.then(() => nudge(tabId, !engine.active())).catch(() => {});
});
chrome.tabs.onRemoved.addListener(tabId => { engine?.invalidate(tabId); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  void ready.then(async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await nudge(tab.id, !engine.active());
  }).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) engine?.invalidate(details.tabId);
});
for (const event of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
  event.addListener(details => {
    if (details.frameId !== 0) return;
    engine?.invalidate(details.tabId);
    void ready.then(() => nudge(details.tabId, !engine.active())).catch(() => {});
  });
}
chrome.runtime.onInstalled.addListener(() => { void ready.then(refreshTabs).catch(() => {}); });
