import { buildJevRequest, parseJevResponse } from "./core.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const KEY_REQUIRED = "Add your TypeSafe API key in Settings & privacy first.";

export function normalizeApiKey(value) {
  if (typeof value !== "string") throw new Error("Enter a valid TypeSafe API key.");
  const key = value.trim();
  if (key && (!/^[\x21-\x7e]+$/.test(key) || key.length > 2048 || key === "replace-with-your-typesafe-key")) {
    throw new Error("Paste only your TypeSafe API key, without spaces or line breaks.");
  }
  return key;
}

function interruption(signal, timeout) {
  if (timeout.aborted) return new Error("Jev took too long. This page is still accessible.");
  if (signal.aborted) return new Error("The focus session stopped.");
  return new Error("Could not reach Jev. This page is still accessible.");
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

// Only the extension's trusted background worker calls this fixed endpoint.
// Provider bodies and transport errors are never forwarded to the UI or pages.
export async function askJev({ apiKey, model = "jev-latest", goal, page, transport = fetch, signal: cancellation,
  timeoutMs = 11000, retryMs = 750 }) {
  apiKey = normalizeApiKey(apiKey);
  if (!apiKey) throw new Error(KEY_REQUIRED);
  const payload = buildJevRequest(goal, page, model);
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      signal.throwIfAborted();
      response = await transport(ENDPOINT, {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if ([429, 529].includes(response.status) && attempt === 0) {
        await response.body?.cancel().catch(() => {});
        await delay(retryMs, signal);
        continue;
      }
    } catch { throw interruption(signal, timeout); }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("TypeSafe did not accept the API key. Update it in Settings & privacy.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error([429, 529].includes(response.status) ? "Jev is busy. Please try again shortly." : "Jev is temporarily unavailable.");
    }
    const reader = response.body?.getReader();
    let size = 0;
    const decoder = new TextDecoder();
    let text = "";
    try {
      if (!reader) throw new Error();
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 32000) { await reader.cancel(); throw new Error(); }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return parseJevResponse(JSON.parse(text));
    } catch {
      if (signal.aborted) throw interruption(signal, timeout);
      throw new Error("Jev returned an unusable response. This page is still accessible.");
    } finally { reader?.releaseLock(); }
  }
}

export class JevClient {
  constructor({ transport = fetch, now = Date.now } = {}) {
    this.transport = transport;
    this.now = now;
    this.active = new Set();
    this.times = [];
  }

  async classify(request) {
    this.times = this.times.filter(time => time > this.now() - 60000);
    if (this.active.size >= 4 || this.times.length >= 60) throw new Error("Too many checks. Please try again shortly.");
    const controller = new AbortController();
    this.active.add(controller);
    this.times.push(this.now());
    try { return await askJev({ ...request, transport: this.transport, signal: controller.signal }); }
    finally { this.active.delete(controller); }
  }

  cancel() {
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
