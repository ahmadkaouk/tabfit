import test from "node:test";
import assert from "node:assert/strict";
import { askJev, JevClient, normalizeApiKey } from "../extension/jev-client.js";

const apiKey = "private-test-api-key";
const body = { apiKey, goal: "Build a login page", page: { url: "https://example.com/news?token=private#fragment", title: "Unrelated news", text: "Today's news" } };
const upstream = { model: "jev-test", answers: { relevance: { type: "choice", choice: "off_task", confidence: 0.9, probabilities: { on_task: 0.03, off_task: 0.94, uncertain: 0.03 } } } };
const ok = () => new Response(JSON.stringify(upstream));

test("direct requests use only the TypeSafe endpoint, omit credentials and minimize page data", async () => {
  let sent;
  const decision = await askJev({ ...body, transport: async (url, options) => { sent = { url, options }; return ok(); } });
  assert.equal(decision.status, "block");
  assert.equal(sent.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(sent.options.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(sent.options.credentials, "omit");
  assert.equal(sent.options.redirect, "error");
  assert.equal(sent.options.referrerPolicy, "no-referrer");
  assert.equal(sent.options.cache, "no-store");
  const payload = JSON.parse(sent.options.body);
  assert.equal(payload.model, "jev-latest");
  assert.equal(payload.state.page.url, "https://example.com/news");
  assert.equal(payload.questions.relevance.type, "choice");
  assert.ok(!sent.options.body.includes(apiKey));
  assert.ok(!JSON.stringify(decision).includes(apiKey));
});

test("missing keys and invalid page addresses fail before any network call", async () => {
  const transport = async () => { throw new Error("Unexpected network call"); };
  await assert.rejects(askJev({ ...body, apiKey: "", transport }), /Add your TypeSafe API key/);
  await assert.rejects(askJev({ ...body, page: { url: "http://localhost" }, transport }), /cannot be checked/);
  assert.equal(normalizeApiKey("  own-key  "), "own-key");
  for (const invalid of [null, "two words", "key\nheader", "x".repeat(2049), "replace-with-your-typesafe-key"]) {
    assert.throws(() => normalizeApiKey(invalid));
  }
});

for (const status of [401, 403, 500]) {
  test(`HTTP ${status} gives an actionable error without returning provider text or the key`, async () => {
    await assert.rejects(askJev({ ...body, transport: async () => new Response(apiKey + " PRIVATE_PROVIDER_DETAILS", { status }) }), error => {
      assert.match(error.message, status === 500 ? /unavailable/ : /Update it in Settings/);
      assert.ok(!error.message.includes(apiKey));
      assert.ok(!error.message.includes("PRIVATE_PROVIDER_DETAILS"));
      return true;
    });
  });
}

test("network errors do not expose transport details", async () => {
  await assert.rejects(askJev({ ...body, transport: async () => { throw new Error(apiKey); } }), /^Error: Could not reach Jev/);
});

test("rate limits receive at most one delayed retry", async () => {
  let calls = 0;
  assert.equal((await askJev({ ...body, retryMs: 1, transport: async () => ++calls === 1 ? new Response("busy", { status: 429 }) : ok() })).status, "block");
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(askJev({ ...body, retryMs: 1, transport: async () => { calls++; return new Response("busy", { status: 529 }); } }), /Jev is busy/);
  assert.equal(calls, 2);
});

test("malformed and oversized provider replies cannot manufacture a block", async () => {
  for (const value of ['{"answers":{}}', 'not json', JSON.stringify({ padding: "x".repeat(32001), ...upstream })]) {
    await assert.rejects(askJev({ ...body, transport: async () => new Response(value) }), /unusable/);
  }
});

test("a hung provider times out", async () => {
  await assert.rejects(askJev({ ...body, timeoutMs: 20, transport: (_url, { signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("late")), 200);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });
  }) }), /too long/);
});

test("session cancellation aborts all pending calls and releases concurrency slots", async () => {
  const signals = [];
  const client = new JevClient({ transport: (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const pending = Array.from({ length: 4 }, () => assert.rejects(client.classify(body), /session stopped/));
  await assert.rejects(client.classify(body), /Too many checks/);
  client.cancel();
  await Promise.all(pending);
  assert.ok(signals.every(signal => signal.aborted));
  client.transport = async () => ok();
  assert.equal((await client.classify(body)).status, "block");
});

test("cancellation during retry delay prevents a second paid request", async () => {
  let calls = 0;
  const controller = new AbortController();
  const pending = askJev({ ...body, signal: controller.signal, transport: async () => { calls++; return new Response("busy", { status: 429 }); } });
  const cancelled = assert.rejects(pending, /session stopped/);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await cancelled;
  assert.equal(calls, 1);
});

test("local rate limit recovers after a minute", async () => {
  let now = 100000;
  const client = new JevClient({ now: () => now, transport: async () => ok() });
  for (let i = 0; i < 60; i++) await client.classify(body);
  await assert.rejects(client.classify(body), /Too many checks/);
  now += 61000;
  assert.equal((await client.classify(body)).status, "block");
});
