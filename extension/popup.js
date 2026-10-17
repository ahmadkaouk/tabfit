import { remainingTime } from "./core.js";

const $ = selector => document.querySelector(selector);
let session = null;
let hasApiKey = false;
let hydrated = false;
let busy = false;
let messageTimer;

async function rpc(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "Could not reach TabFit. Reload the extension and try again.");
  return result.data;
}

function message(text, success = false) {
  clearTimeout(messageTimer);
  $("#message").textContent = text;
  $("#message").classList.toggle("success", success);
  $("#message").hidden = !text;
  // Confirmations clear themselves; errors stay until the next action.
  if (text && success) messageTimer = setTimeout(() => message(""), 5000);
}

const pad = value => String(value).padStart(2, "0");

function goalCount() {
  // The counter only appears once the limit is close.
  const length = $("#goal").value.length;
  $("#goal-count").textContent = `${length}/600`;
  $("#goal-count").hidden = length < 500;
}

function tick() {
  if (!session) return;
  const ms = remainingTime(session);
  const seconds = Math.ceil(ms / 1000);
  // A separate colon lets CSS close the gap a monospace colon leaves.
  $("#timer").replaceChildren(pad(Math.floor(seconds / 60)), Object.assign(document.createElement("span"), { textContent: ":" }), pad(seconds % 60));
  $("#progress-fill").style.width = `${Math.max(0, Math.min(100, ms / session.durationMs * 100))}%`;
  if (ms <= 0 && !session.paused) void refresh();
}

async function refresh() {
  const data = await rpc("GET_STATE");
  session = data.session;
  hasApiKey = data.settings.hasApiKey;
  $("#connection-status").hidden = hasApiKey;
  $("#api-key").placeholder = hasApiKey ? "Saved · paste a new key to replace" : "Paste your TypeSafe API key";
  $("#remove-key").hidden = !hasApiKey;
  $("#key-status").textContent = hasApiKey ? "Saved" : "Required";
  $("#key-status").classList.toggle("ready", hasApiKey);
  $("#setup-view").hidden = Boolean(session);
  $("#session-view").hidden = !session;
  if (!hydrated) {
    $("#goal").value = data.settings.lastGoal;
    goalCount();
    const duration = document.querySelector(`input[name="minutes"][value="${data.settings.minutes}"]`);
    if (duration) duration.checked = true;
    $("#exclusions").value = data.settings.exclusions.join("\n");
    hydrated = true;
  }
  if (session) {
    $("#active-goal").textContent = session.goal;
    $("#session-view").classList.toggle("paused", session.paused);
    $("#session-label").textContent = session.paused ? "Paused" : "Focusing";
    $("#session-length").textContent = `of ${Math.round(session.durationMs / 60000)} min`;
    $("#session-stats").textContent = `${session.checked} checked · ${session.blocked} blocked`;
    // Resuming is the next step after a pause, so it becomes the main action.
    $("#pause-button").textContent = session.paused ? "Resume" : "Pause";
    $("#pause-button").className = session.paused ? "primary" : "secondary";
    const last = data.lastDecision;
    const labels = { allow: "On task", block: "Blocked", uncertain: "Unsure, allowed", unreadable: "Couldn’t read PDF", error: "Check failed" };
    const [label, detail] = session.paused ? ["Paused", "Pages aren’t checked"] : last ? [labels[last.status], last.host] : ["Ready", "Checks the page you’re viewing"];
    const decision = $("#last-decision");
    decision.replaceChildren(Object.assign(document.createElement("b"), { textContent: label }), Object.assign(document.createElement("span"), { textContent: detail }));
    decision.title = `${label}: ${detail}`;
    decision.dataset.status = session.paused ? "paused" : last?.status ?? "";
    tick();
  }
  return data;
}

async function act(button, action) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  message("");
  try { await action(); await refresh(); }
  catch (error) {
    message(error.message);
    if (!hasApiKey) { $("#settings-panel").open = true; $("#api-key").focus(); }
  }
  finally { busy = false; button.disabled = false; }
}

$("#goal").addEventListener("input", goalCount);
$("#settings-panel").addEventListener("toggle", () => {
  if (!$("#settings-panel").open && $("#message").classList.contains("success")) message("");
});
$("#session-form").addEventListener("submit", event => {
  event.preventDefault();
  void act($("#start-button"), async () => {
    await rpc("START_SESSION", { goal: $("#goal").value, minutes: Number(new FormData(event.target).get("minutes")) });
    $("#settings-panel").open = false;
  });
});
$("#pause-button").onclick = event => { void act(event.currentTarget, () => rpc(session?.paused ? "RESUME_SESSION" : "PAUSE_SESSION")); };
$("#end-button").onclick = event => { void act(event.currentTarget, () => rpc("END_SESSION")); };
$("#remove-key").onclick = event => {
  void act(event.currentTarget, async () => {
    await rpc("REMOVE_API_KEY");
    $("#api-key").value = "";
    message("API key removed. Page checks are paused until you add a key and resume.", true);
  });
};
$("#settings-form").addEventListener("submit", event => {
  event.preventDefault();
  void act($("#save-settings"), async () => {
    await rpc("SAVE_SETTINGS", { apiKey: $("#api-key").value, exclusions: $("#exclusions").value });
    $("#api-key").value = "";
    message("Settings saved. Your key will be used when you focus.", true);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.focusState) void refresh().catch(() => {});
});
setInterval(tick, 1000);
try { await refresh(); }
catch (error) { message(error.message); }
