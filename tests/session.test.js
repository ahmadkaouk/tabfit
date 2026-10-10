import test from "node:test";
import assert from "node:assert/strict";
import { FocusSession } from "../extension/session.js";

const page = { url: "https://example.com/watch?id=1", title: "Funny videos", text: "Unrelated videos" };
const block = { status: "block", choice: "off_task" };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(classify = async () => block) {
  let now = 100000;
  let saved;
  const engine = new FocusSession({ classify, now: () => now, save: async state => { saved = state; } });
  await engine.start("Write the React authentication flow", 25);
  const check = (extra = {}) => engine.check({ tabId: 1, url: page.url, page, sessionId: engine.state.session?.id, ...extra });
  return { engine, check, advance: ms => { now += ms; }, saved: () => saved };
}

test("cache avoids repeated model calls and stores no page content or raw URL", async () => {
  let calls = 0;
  const { engine, check, saved } = await fixture(async () => { calls++; return block; });
  assert.equal((await check()).status, "block");
  assert.equal((await check()).status, "block");
  assert.equal(calls, 1);
  assert.equal(engine.state.session.checked, 1);
  assert.equal(engine.state.session.blocked, 1);
  assert.doesNotMatch(JSON.stringify(saved()), /Funny videos|Unrelated videos|id=1|https:/);
  const restored = new FocusSession({ state: saved(), classify: async () => { throw new Error("must not call"); }, now: () => 100001 });
  assert.equal((await restored.check({ tabId: 2, url: page.url, page, sessionId: engine.state.session.id })).status, "block");
});

test("concurrent tabs deduplicate matching page checks", async () => {
  let calls = 0;
  const pending = deferred();
  const { check, engine } = await fixture(async () => { calls++; return pending.promise; });
  const results = [check(), check({ tabId: 2 })];
  await new Promise(resolve => setTimeout(resolve, 15));
  pending.resolve(block);
  assert.deepEqual((await Promise.all(results)).map(r => r.status), ["block", "block"]);
  assert.equal(calls, 1);
  assert.equal(engine.state.session.checked, 1);
});

test("new content at the same URL is reassessed", async () => {
  let calls = 0;
  const { check } = await fixture(async () => { calls++; return block; });
  await check();
  await check({ page: { ...page, title: "Authentication tutorial", text: "Relevant content" } });
  assert.equal(calls, 2);
});

test("an override is exact-page and session scoped, including query identity", async () => {
  const { engine, check } = await fixture();
  await engine.override(page.url, engine.state.session.id);
  assert.equal((await check()).status, "overridden");
  assert.equal((await check({ url: "https://example.com/watch?id=2" })).status, "block");
  await engine.start("Different task", 25);
  assert.equal((await check()).status, "block");
});

for (const action of ["end", "pause", "navigate", "replace", "override", "expire"]) {
  test(`an in-flight response cannot block after ${action}`, async () => {
    const pending = deferred();
    const started = deferred();
    const { engine, check, advance } = await fixture(async () => { started.resolve(); return pending.promise; });
    const result = check();
    await started.promise;
    if (action === "end") await engine.end();
    if (action === "pause") await engine.pause();
    if (action === "navigate") engine.invalidate(1);
    if (action === "replace") await engine.start("Another focus goal", 25);
    if (action === "override") await engine.override(page.url, engine.state.session.id);
    if (action === "expire") advance(25 * 60000);
    pending.resolve(block);
    assert.notEqual((await result).status, "block");
    assert.equal(engine.state.session?.blocked ?? 0, 0);
  });
}

test("a session change during asynchronous tab validation is caught", async () => {
  const pending = deferred();
  const started = deferred();
  const { engine, check } = await fixture();
  const result = check({ isCurrent: async () => { started.resolve(); await pending.promise; return true; } });
  await started.promise;
  await engine.end();
  pending.resolve();
  assert.equal((await result).status, "idle");
});

test("pausing freezes the timer and resuming preserves the remaining time", async () => {
  const { engine, advance } = await fixture();
  advance(5000);
  await engine.pause();
  assert.equal(engine.active(), false);
  assert.equal(engine.state.session.remainingMs, 1495000);
  advance(9000000);
  await engine.resume();
  assert.equal(engine.active(), true);
  advance(1495000);
  assert.equal(engine.active(), false);
});

test("provider failure allows browsing and applies a cooldown", async () => {
  let calls = 0;
  const { check, advance } = await fixture(async () => { calls++; throw new Error("Offline"); });
  assert.equal((await check()).status, "error");
  assert.equal((await check()).status, "error");
  assert.equal(calls, 1);
  advance(31000);
  await check();
  assert.equal(calls, 2);
});

test("PDF evidence is extracted before classification; only the sanitized excerpt is sent or cached", async () => {
  let sent;
  let source;
  const engine = new FocusSession({ preparePage: async page => {
    source = page.url;
    return { ...page, text: "PDF_EXCERPT Software engineer working on inference", description: "PDF: first page" };
  }, classify: async (goal, page) => { sent = { goal, page }; return { status: "allow" }; } });
  await engine.start("Review software engineering resumes", 25);
  const url = "https://example.com/resume.pdf?token=PRIVATE_QUERY";
  const result = await engine.check({ tabId: 1, url, page: { url, kind: "pdf" }, sessionId: engine.state.session.id });
  assert.equal(result.status, "allow");
  assert.equal(source, url);
  assert.match(sent.page.text, /PDF_EXCERPT/);
  assert.equal(sent.page.url, "https://example.com/resume.pdf");
  assert.doesNotMatch(JSON.stringify(engine.state), /PDF_EXCERPT|PRIVATE_QUERY/);
});

test("unreadable PDFs bypass Jev and cannot create a block", async () => {
  let calls = 0;
  const engine = new FocusSession({ preparePage: async () => ({ status: "unreadable", reason: "no_text", message: "No readable PDF text" }),
    classify: async () => { calls++; return block; } });
  await engine.start("Review resumes", 25);
  const url = "https://example.com/scanned.pdf";
  const result = await engine.check({ tabId: 1, url, page: { url, kind: "pdf" }, sessionId: engine.state.session.id });
  assert.equal(result.status, "unreadable");
  assert.equal(calls, 0);
  assert.equal(engine.state.session.checked, 0);
  assert.equal(engine.state.lastDecision.status, "unreadable");
});

for (const action of ["end", "pause", "navigate", "override"]) {
  test(`PDF extraction finishing after ${action} never reaches Jev`, async () => {
    const pending = deferred();
    const started = deferred();
    let calls = 0;
    const engine = new FocusSession({ preparePage: async page => { started.resolve(); await pending.promise; return { ...page, text: "Extracted PDF" }; },
      classify: async () => { calls++; return block; } });
    await engine.start("Review resumes", 25);
    const url = "https://example.com/resume.pdf";
    const result = engine.check({ tabId: 1, url, page: { url, kind: "pdf" }, sessionId: engine.state.session.id });
    await started.promise;
    if (action === "end") await engine.end();
    if (action === "pause") await engine.pause();
    if (action === "navigate") engine.invalidate(1);
    if (action === "override") await engine.override(url, engine.state.session.id);
    pending.resolve();
    assert.notEqual((await result).status, "block");
    assert.equal(calls, 0);
  });
}
