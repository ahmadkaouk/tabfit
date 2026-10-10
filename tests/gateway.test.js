import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { askJev, createGateway } from "../server/server.mjs";

const token = "test-connection-token-at-least-24-characters";
const apiKey = "fake-upstream-key-for-tests";
const body = { goal: "Build a login page", page: { url: "https://example.com/news?token=private#fragment", title: "Unrelated news", text: "Today's news" } };
const upstream = { model: "jev-test", answers: { relevance: { type: "choice", choice: "off_task", confidence: 0.9, probabilities: { on_task: 0.03, off_task: 0.94, uncertain: 0.03 } } } };
const ok = () => new Response(JSON.stringify(upstream), { status: 200 });

async function setup(t, transport = async () => ok(), key = apiKey) {
  const server = createGateway({ token, apiKey: key, transport });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-TabFit-Token": token, "Content-Type": "application/json", Origin: `chrome-extension://${"a".repeat(32)}` };
  return { base, headers };
}

test("gateway sends the documented Jev request and never returns its API key", async t => {
  let sent;
  const { base, headers } = await setup(t, async (url, options) => { sent = { url, options }; return ok(); });
  const result = await fetch(`${base}/classify`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "block");
  assert.equal(sent.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent.options.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(sent.options.redirect, "error");
  const requestBody = JSON.parse(sent.options.body);
  assert.equal(requestBody.state.page.url, "https://example.com/news");
  assert.equal(requestBody.questions.relevance.type, "choice");
  const health = await fetch(`${base}/health`, { headers });
  const text = await health.text();
  assert.doesNotMatch(text, new RegExp(apiKey));
  assert.doesNotMatch(text, new RegExp(token));
});

test("unpaired requests, webpage origins and rebinding hosts are rejected before inference", async t => {
  let calls = 0;
  const { base, headers } = await setup(t, async () => { calls++; return ok(); });
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/classify`, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify(body) })).status, 403);
  // Fetch implementations can overwrite Host; use the raw HTTP client for this boundary check.
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/health`, { headers: { ...headers, Host: "attacker.example" } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal(calls, 0);
});

test("missing key, bad input and non-JSON requests are handled without inference", async t => {
  const missing = await setup(t, async () => { throw new Error("must not call"); }, "");
  assert.equal((await fetch(`${missing.base}/health`, { headers: missing.headers })).status, 503);
  const { base, headers } = await setup(t);
  assert.equal((await fetch(`${base}/classify`, { method: "POST", headers, body: "{" })).status, 400);
  assert.equal((await fetch(`${base}/classify`, { method: "POST", headers, body: JSON.stringify({ ...body, page: { url: "http://localhost" } }) })).status, 400);
  assert.equal((await fetch(`${base}/classify`, { method: "POST", headers: { ...headers, "Content-Type": "text/plain" }, body: "anything" })).status, 415);
});

test("upstream authentication failure is actionable and does not expose response bodies", async t => {
  const { base, headers } = await setup(t, async () => new Response("sensitive debug details", { status: 401 }));
  const result = await fetch(`${base}/classify`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(result.status, 502);
  const text = await result.text();
  assert.match(text, /API key/);
  assert.doesNotMatch(text, /sensitive/);
});

test("rate limits receive one bounded retry", async () => {
  let calls = 0;
  const result = await askJev({ apiKey, ...body, transport: async () => ++calls === 1 ? new Response("busy", { status: 429 }) : ok() });
  assert.equal(result.status, "block");
  assert.equal(calls, 2);
});

test("a hung provider times out without manufacturing a decision", async () => {
  await assert.rejects(askJev({ apiKey, ...body, timeoutMs: 20, transport: (_url, { signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("late")), 200);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });
  }) }), /too long/);
});

test("malformed model output is never interpreted as a block", async () => {
  await assert.rejects(askJev({ apiKey, ...body, transport: async () => new Response('{"answers":{}}') }), /unusable/);
});
