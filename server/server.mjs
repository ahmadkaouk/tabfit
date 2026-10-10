import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildJevRequest, parseJevResponse } from "../extension/core.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY = 24000;

export async function askJev({ apiKey, model, goal, page, transport = fetch, timeoutMs = 11000 }) {
  const payload = buildJevRequest(goal, page, model);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await transport(ENDPOINT, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error(signal.aborted ? "Jev took too long. This page is still accessible." : "Could not reach Jev. This page is still accessible.");
    }
    if ([429, 529].includes(response.status) && attempt === 0) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 750));
      continue;
    }
    if ([401, 403].includes(response.status)) throw new Error("TypeSafe did not accept the API key. Update the gateway's .env and restart it.");
    if (!response.ok) throw new Error([429, 529].includes(response.status) ? "Jev is busy. Please try again shortly." : "Jev is temporarily unavailable.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 32000) { await reader.cancel(); throw new Error("Oversized Jev response."); }
        chunks.push(value);
      }
      return parseJevResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      throw new Error("Jev returned an unusable response. This page is still accessible.");
    }
  }
}

function equalToken(a, b) {
  const left = Buffer.from(typeof a === "string" ? a : "");
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJSON(request) {
  let length = 0;
  const parts = [];
  for await (const part of request) {
    length += part.length;
    if (length > MAX_BODY) throw new Error("Request is too large.");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export function createGateway({ apiKey, token, model = "jev-latest", transport = fetch }) {
  if (!token || token.length < 24) throw new Error("A connection code of at least 24 characters is required.");
  let active = 0;
  let requestTimes = [];
  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(JSON.stringify(body));
    };
    // Loopback binding plus Host validation prevents remote access and DNS rebinding.
    if (!/^127\.0\.0\.1:\d+$/.test(request.headers.host ?? "")) return reply(403, { error: "Local access only." });
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return reply(403, { error: "Extension access only." });
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TabFit-Token");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      response.writeHead(204);
      return response.end();
    }
    if (!equalToken(request.headers["x-tabfit-token"], token)) return reply(401, { error: "Connection code not accepted. Copy it from the gateway terminal." });
    if (request.method === "GET" && request.url === "/health") {
      return reply(apiKey ? 200 : 503, apiKey ? { ready: true, model } : { error: "Add TYPESAFE_API_KEY to .env, then restart the gateway." });
    }
    if (request.method !== "POST" || request.url !== "/classify") return reply(404, { error: "Not found." });
    if (!apiKey) return reply(503, { error: "Add TYPESAFE_API_KEY to .env, then restart the gateway." });
    if (!request.headers["content-type"]?.startsWith("application/json")) return reply(415, { error: "JSON required." });
    if (Number(request.headers["content-length"]) > MAX_BODY) return reply(413, { error: "Request is too large." });
    requestTimes = requestTimes.filter(time => time > Date.now() - 60000);
    if (active >= 4 || requestTimes.length >= 60) return reply(429, { error: "Too many checks. Please try again shortly." });
    active++;
    requestTimes.push(Date.now());
    try {
      let body;
      try {
        body = await readJSON(request);
        buildJevRequest(body.goal, body.page, model);
      } catch { return reply(400, { error: "Invalid page or focus goal." }); }
      try {
        const decision = await askJev({ apiKey, model, goal: body.goal, page: body.page, transport });
        reply(200, decision);
      } catch (error) { reply(502, { error: error.message }); }
    } finally { active--; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function main() {
  const tokenFile = new URL("../.gateway-token", import.meta.url);
  let token;
  try { token = (await readFile(tokenFile, "utf8")).trim(); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    token = randomBytes(24).toString("hex");
    await writeFile(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
  }
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  const server = createGateway({ apiKey: apiKey === "replace-with-your-typesafe-key" ? "" : apiKey, token,
    model: process.env.TYPESAFE_MODEL || "jev-latest" });
  server.on("error", error => { console.error(`Cannot start TabFit gateway: ${error.code ?? "server error"}`); process.exitCode = 1; });
  server.listen(4318, "127.0.0.1", () => {
    console.log("TabFit gateway is listening on http://127.0.0.1:4318");
    console.log(`Connection code: ${token}`);
    console.log("Paste this code in the extension's Connection settings. Keep this terminal open.");
    if (!apiKey || apiKey === "replace-with-your-typesafe-key") console.log("Add your TypeSafe API key to .env and restart before starting a session.");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Could not read or create the local connection code."); process.exitCode = 1; });
