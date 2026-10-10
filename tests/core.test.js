import test from "node:test";
import assert from "node:assert/strict";
import { buildJevRequest, isExcluded, isPublicPage, parseExclusions, parseJevResponse, sanitizePage } from "../extension/core.js";

const response = (choice, probabilities) => ({ model: "jev-test", answers: { relevance: { type: "choice", choice, probabilities, confidence: 0.9 } } });

test("a specific page is classified against the user's goal, without query secrets", () => {
  const body = buildJevRequest("Build a React login page", { url: "https://youtube.com/watch?v=abc&token=secret#private", title: "React login tutorial", text: "x".repeat(6000) });
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.focus_goal, "Build a React login page");
  assert.equal(body.state.page.url, "https://youtube.com/watch");
  assert.equal(body.state.page.text.length, 4000);
  assert.deepEqual(Object.keys(body.questions.relevance.criteria), ["on_task", "off_task", "uncertain"]);
  assert.doesNotMatch(JSON.stringify(body), /secret|private/);
});

test("only a sufficiently strong off-task result blocks", () => {
  assert.equal(parseJevResponse(response("off_task", { on_task: 0.04, off_task: 0.9, uncertain: 0.06 })).status, "block");
  assert.equal(parseJevResponse(response("off_task", { on_task: 0.2, off_task: 0.65, uncertain: 0.15 })).status, "uncertain");
  assert.equal(parseJevResponse(response("on_task", { on_task: 0.8, off_task: 0.1, uncertain: 0.1 })).status, "allow");
  assert.equal(parseJevResponse(response("uncertain", { on_task: 0.1, off_task: 0.1, uncertain: 0.8 })).status, "uncertain");
});

test("malformed distributions cannot produce a block", () => {
  for (const p of [
    { on_task: 0.2, off_task: 0.9, uncertain: 0.1 },
    { on_task: 0.5, off_task: 0.4, uncertain: 0.1 },
    { on_task: -0.1, off_task: 0.9, uncertain: 0.2 },
    { off_task: 1 },
    { on_task: NaN, off_task: 1, uncertain: 0 },
  ]) assert.throws(() => parseJevResponse(response("off_task", p)));
  assert.throws(() => parseJevResponse({ answers: {} }));
});

test("local pages, credentials and sensitive exclusions are not sent", () => {
  for (const url of ["chrome://settings", "file:///private/doc", "http://localhost:3000", "http://127.0.0.1", "https://192.168.1.1", "http://[::1]", "https://admin.internal", "https://host.local", "https://name:password@example.com"]) {
    assert.equal(isPublicPage(url), false, url);
    assert.throws(() => sanitizePage({ url }));
  }
  assert.equal(isExcluded("https://docs.example.com", ["example.com"]), true);
  assert.equal(isExcluded("https://notexample.com", ["example.com"]), false);
  assert.equal(isPublicPage("https://example.com/article"), true);
});

test("exclusion entry is normalized and rejects paths", () => {
  assert.deepEqual(parseExclusions("MAIL.GOOGLE.COM\nhttps://example.com/\nmail.google.com"), ["mail.google.com", "example.com"]);
  for (const input of ["example.com/private", "javascript:alert(1)", "https://user:secret@example.com"]) assert.throws(() => parseExclusions(input));
});
