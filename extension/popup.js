import { remainingTime } from "./core.js";

const $ = selector => document.querySelector(selector);
let session = null;
let hydrated = false;
let busy = false;

async function rpc(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "Could not reach TabFit. Reload the extension and try again.");
  return result.data;
}

function message(text, success = false) {
  $("#message").textContent = text;
  $("#message").classList.toggle("success", success);
  $("#message").hidden = !text;
}

function connected(ready) {
  const element = $("#connection-status");
  element.classList.toggle("ready", ready);
  element.replaceChildren(document.createElement("i"), document.createTextNode(ready ? "Gateway ready" : "Not connected"));
}

function tick() {
  if (!session) return;
  const ms = remainingTime(session);
  const seconds = Math.ceil(ms / 1000);
  $("#timer").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  $("#progress-ring").style.strokeDashoffset = 496.37 * (1 - Math.max(0, Math.min(1, ms / session.durationMs)));
  if (ms <= 0 && !session.paused) void refresh();
}

async function refresh() {
  const data = await rpc("GET_STATE");
  session = data.session;
  $("#setup-view").hidden = Boolean(session);
  $("#session-view").hidden = !session;
  if (!hydrated) {
    $("#goal").value = data.settings.lastGoal;
    $("#goal-count").textContent = `${$("#goal").value.length} / 600`;
    const duration = document.querySelector(`input[name="minutes"][value="${data.settings.minutes}"]`);
    if (duration) duration.checked = true;
    $("#exclusions").value = data.settings.exclusions.join("\n");
    $("#connection-code").placeholder = data.settings.hasConnection ? "Saved on this device · paste to replace" : "Paste your connection code";
    $("#settings-panel").open = !data.settings.hasConnection;
    hydrated = true;
  }
  if (session) {
    $("#active-goal").textContent = session.goal;
    $("#session-label").textContent = session.paused ? "Take a breath" : "You’re in focus";
    $("#live-label").textContent = session.paused ? "PAUSED" : "LIVE";
    $("#timer-caption").textContent = session.paused ? "your time is on hold" : "time for what matters";
    $("#pause-button").textContent = session.paused ? "Resume session" : "Pause session";
    $("#checked-count").textContent = session.checked;
    $("#blocked-count").textContent = session.blocked;
    const last = data.lastDecision;
    const descriptions = { allow: "On task", block: "Distraction caught", uncertain: "Uncertain · allowed", unreadable: "PDF unreadable · allowed", error: "Check unavailable · allowed" };
    $("#last-decision").textContent = session.paused ? "Browsing is unrestricted while paused." : last ? `${descriptions[last.status]} · ${last.host}` : "Jev will check the page you’re viewing.";
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
  catch (error) { message(error.message); }
  finally { busy = false; button.disabled = false; }
}

$("#goal").addEventListener("input", () => { $("#goal-count").textContent = `${$("#goal").value.length} / 600`; });
$("#settings-panel").addEventListener("toggle", () => {
  if (!$("#settings-panel").open && $("#message").classList.contains("success")) message("");
});
$("#session-form").addEventListener("submit", event => {
  event.preventDefault();
  void act($("#start-button"), async () => {
    await rpc("START_SESSION", { goal: $("#goal").value, minutes: Number(new FormData(event.target).get("minutes")) });
    connected(true);
    $("#settings-panel").open = false;
  });
});
$("#pause-button").onclick = event => { void act(event.currentTarget, () => rpc(session?.paused ? "RESUME_SESSION" : "PAUSE_SESSION")); };
$("#end-button").onclick = event => { void act(event.currentTarget, () => rpc("END_SESSION")); };
$("#settings-form").addEventListener("submit", event => {
  event.preventDefault();
  void act($("#save-settings"), async () => {
    try {
      await rpc("SAVE_SETTINGS", { connectionCode: $("#connection-code").value, exclusions: $("#exclusions").value });
      connected(true);
      $("#connection-code").value = "";
      $("#connection-code").placeholder = "Saved on this device · paste to replace";
      message("Gateway ready. Describe your task and start a session.", true);
    } catch (error) { connected(false); throw error; }
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.focusState) void refresh().catch(() => {});
});
setInterval(tick, 1000);
try {
  const data = await refresh();
  if (data.settings.hasConnection) {
    try { await rpc("HEALTH"); connected(true); }
    catch (error) { connected(false); message(error.message); }
  }
} catch (error) { message(error.message); }
