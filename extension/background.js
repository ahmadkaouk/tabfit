import { DEFAULT_EXCLUSIONS, isExcluded, parseExclusions } from "./core.js";
import { FocusSession } from "./session.js";
import { PdfReader } from "./pdf-client.js";

const GATEWAY = "http://127.0.0.1:4318";
let settings;
let engine;
let saves = Promise.resolve();
const pdfReader = new PdfReader();

async function gateway(path, body, code = settings.connectionCode) {
  if (!code) throw new Error("Connect to the local gateway first. Open Connection & privacy below.");
  let response;
  try {
    response = await fetch(`${GATEWAY}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "X-TabFit-Token": code, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(body ? 14000 : 3000),
    });
  } catch { throw new Error("Gateway unavailable. Run npm start in chrome-extension and keep the terminal open."); }
  let data;
  try { data = await response.json(); } catch { throw new Error("The gateway returned an invalid response."); }
  if (!response.ok) throw new Error(data.error || "The gateway could not check this page.");
  return data;
}

const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const [local, memory] = await Promise.all([
    chrome.storage.local.get("settings"), chrome.storage.session.get("focusState"),
  ]);
  settings = { connectionCode: "", exclusions: DEFAULT_EXCLUSIONS, lastGoal: "", minutes: 25, ...local.settings };
  engine = new FocusSession({
    state: memory.focusState,
    preparePage: page => pdfReader.prepare(page),
    classify: (goal, page) => gateway("/classify", { goal, page }),
    save: state => {
      const next = saves.catch(() => {}).then(() => chrome.storage.session.set({ focusState: state }));
      saves = next;
      return next;
    },
  });
  if (engine.state.session && !engine.state.session.paused && !engine.active()) await engine.end();
  await setAlarm();
})();

async function setAlarm() {
  await chrome.alarms.clear("focus-end");
  if (engine.active()) await chrome.alarms.create("focus-end", { when: engine.state.session.endsAt });
  await chrome.action.setBadgeBackgroundColor({ color: "#49644e" });
  await chrome.action.setBadgeText({ text: engine.active() ? "ON" : engine.state.session?.paused ? "Ⅱ" : "" });
}

async function nudge(tabId, reset = false) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.incognito || !/^https?:\/\//.test(tab.url ?? "")) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: reset ? "RESET" : "INSPECT" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tabId, { type: reset ? "RESET" : "INSPECT" });
    } catch { /* Browser pages and protected pages cannot run content scripts. */ }
  }
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.allSettled(tabs.map(tab => nudge(tab.id, !engine.active())));
}

async function expire() {
  if (engine.state.session && !engine.state.session.paused && !engine.active()) {
    pdfReader.clear();
    await engine.end();
    await setAlarm();
    await refreshTabs();
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
  await expire();
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") throw new Error("Invalid request.");
  const isPopup = sender.url === chrome.runtime.getURL("popup.html");
  if (sender.tab && !isPopup) {
    const tab = await eligibleTab(sender, message.url);
    if (!tab) return { status: "excluded" };
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
      pdfReader.clear();
      await engine.end();
      await setAlarm();
      await refreshTabs();
      return { status: "idle" };
    }
    throw new Error("Unsupported page request.");
  }

  if (!isPopup) throw new Error("Open TabFit to change settings.");
  switch (message.type) {
    case "GET_STATE":
      return { session: engine.state.session, lastDecision: engine.state.lastDecision,
        settings: { hasConnection: Boolean(settings.connectionCode), exclusions: settings.exclusions,
          lastGoal: settings.lastGoal, minutes: settings.minutes } };
    case "HEALTH": return gateway("/health");
    case "SAVE_SETTINGS": {
      const exclusions = parseExclusions(message.exclusions);
      const connectionCode = message.connectionCode?.trim() || settings.connectionCode;
      if (connectionCode && !/^[a-zA-Z0-9_-]{24,128}$/.test(connectionCode)) throw new Error("Paste the connection code printed by the gateway.");
      settings = { ...settings, connectionCode, exclusions };
      await chrome.storage.local.set({ settings });
      engine.epoch++;
      pdfReader.clear();
      engine.cooldownUntil = 0;
      await refreshTabs();
      return gateway("/health");
    }
    case "START_SESSION":
      await gateway("/health");
      pdfReader.clear();
      await engine.start(message.goal, message.minutes);
      settings = { ...settings, lastGoal: engine.state.session.goal, minutes: message.minutes };
      await chrome.storage.local.set({ settings });
      break;
    case "PAUSE_SESSION": pdfReader.clear(); await engine.pause(); break;
    case "RESUME_SESSION": await gateway("/health"); await engine.resume(); break;
    case "END_SESSION": pdfReader.clear(); await engine.end(); break;
    default: throw new Error("Unknown action.");
  }
  await setAlarm();
  await refreshTabs();
  return { session: engine.state.session };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "pdf-offscreen") return;
  route(message, sender).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "focus-end") void ready.then(expire).catch(() => {});
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
