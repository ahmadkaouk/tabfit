// Optional integration check. Run with Playwright and a Chromium build that supports --load-extension.
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createGateway } from "../server/server.mjs";
import { makePdf } from "./pdf-fixture.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const profile = await mkdtemp(join(tmpdir(), "tabfit-extension-test-"));
const out = resolve("test-results");
await mkdir(out, { recursive: true });
const token = "browser-test-connection-token-12345678";
const requests = [];
let holdResolve;
let failed = false;
const gateway = createGateway({ apiKey: "fake-browser-test-key", token, transport: async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  if (body.state.page.title.includes("Delayed")) await new Promise(resolve => { holdResolve = resolve; });
  if (failed) return new Response("unavailable", { status: 503 });
  const choice = body.state.page.title.includes("Tutorial") || (body.state.page.description.startsWith("PDF text excerpt") && body.state.page.text.includes("inference")) ? "on_task" : body.state.page.title.includes("Unclear") ? "uncertain" : "off_task";
  return new Response(JSON.stringify({ model: "jev-browser-fixture", answers: { relevance: { type: "choice", choice, confidence: 0.9,
    probabilities: Object.fromEntries(["on_task", "off_task", "uncertain"].map(label => [label, label === choice ? 0.94 : 0.03])) } } }));
} });
gateway.listen(0, "127.0.0.1");
await once(gateway, "listening");
// Keep the installed extension and the user's running gateway untouched.
const extensionPath = join(profile, "extension");
await cp(resolve("extension"), extensionPath, { recursive: true });
const backgroundPath = join(extensionPath, "background.js");
await writeFile(backgroundPath, (await readFile(backgroundPath, "utf8")).replace("127.0.0.1:4318", `127.0.0.1:${gateway.address().port}`));
const pdfDownloads = [];
let delayedPdfResolve;
const pdfFixture = process.env.PDF_FIXTURE_PATH ? await readFile(process.env.PDF_FIXTURE_PATH) : makePdf();
const pdfServer = http.createServer((request, response) => {
  const path = new URL(request.url, "http://fixture").pathname;
  const isReader = request.headers.accept === "application/pdf";
  if (isReader) pdfDownloads.push(path);
  const deliver = () => {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
    response.end(path === "/scanned.pdf" ? makePdf([""]) : path === "/broken.pdf" ? Buffer.from("%PDF-broken") :
      path === "/long.pdf" ? makePdf(["GPU inference and software engineering experience. ".repeat(100)]) :
      path === "/entertainment.pdf" ? makePdf(["Celebrity gossip and funny videos unrelated to work"]) : pdfFixture);
  };
  if (path === "/delayed.pdf" && isReader) delayedPdfResolve = deliver;
  else deliver();
});
pdfServer.listen(0, "127.0.0.1");
await once(pdfServer, "listening");
const pdfOrigin = `http://pdf.focus-example.com:${pdfServer.address().port}`;
let context;
const errors = [];

async function eventually(check, message, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
    viewport: { width: 1280, height: 850 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-first-run", "--disable-background-networking",
      "--host-resolver-rules=MAP pdf.focus-example.com 127.0.0.1", "--no-proxy-server"],
  });
  context.on("weberror", error => errors.push(String(error.error())));
  if (process.env.TABFIT_TEST_DEBUG) context.on("console", msg => console.log("Browser console:", msg.type(), msg.text().slice(0, 300)));
  context.setDefaultTimeout(12000);
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  let popup = await context.newPage();
  await popup.setViewportSize({ width: 400, height: 760 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator("#connection-code").fill(token);
  await popup.locator("#save-settings").click();
  await popup.getByText("Gateway ready", { exact: true }).waitFor();
  await popup.locator("summary").click();
  await popup.locator("#goal").fill("Build the authentication flow for my React app");
  await popup.locator("body").screenshot({ path: join(out, "popup-setup.png") });
  assert.ok(await popup.locator("body").evaluate(el => el.scrollHeight) <= 600, "Setup should fit Chrome's popup height");
  await popup.locator("#start-button").click();
  await popup.locator("#session-view").waitFor({ state: "visible" });
  await popup.locator("body").screenshot({ path: join(out, "popup-session.png") });
  assert.ok(await popup.locator("body").evaluate(el => el.scrollHeight) <= 600, "Session should fit Chrome's popup height");

  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname !== "focus-example.com") return route.continue();
    if (process.env.TABFIT_TEST_DEBUG) console.log("Fixture request:", route.request().url());
    const path = new URL(route.request().url()).pathname;
    const title = path.includes("tutorial") ? "Tutorial: React authentication" : path.includes("unclear") ? "Unclear dashboard" : path.includes("delayed") ? "Delayed entertainment" : "Celebrity gossip and funny videos";
    return route.fulfill({ status: 200, contentType: "text/html", headers: { "Content-Security-Policy": "default-src 'self'; script-src 'none'; style-src 'none'" },
      body: `<!doctype html><html><head><title>${title}</title><meta name="description" content="${title}"></head><body><main><h1>${title}</h1><p>Sample page about ${title}.</p><form><label>FORM_SECRET<input value="PASSWORD_SECRET"></label></form><div contenteditable>EDITOR_SECRET</div><div hidden>HIDDEN_SECRET</div><button id="original">Original action</button></main></body></html>` });
  });
  const page = await context.newPage();
  page.on("requestfailed", request => console.error("Request failed:", request.url(), request.failure()));
  page.on("download", download => console.error("Unexpected download:", download.suggestedFilename()));
  if (process.env.TABFIT_TEST_DEBUG) page.on("response", response => {
    if (/^https?:/.test(response.url())) console.log("Fixture response:", response.status(), response.url());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  async function overlay() {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const walk = node => {
      if (node.attributes?.includes("data-tabfit-overlay")) return node;
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) { const found = walk(child); if (found) return found; }
    };
    return walk(root);
  }
  function allText(node) { return [node.nodeValue || "", ...(node.children ?? []).map(allText), ...(node.shadowRoots ?? []).map(allText)].join(" "); }
  async function hasText(text) { const node = await overlay(); return node ? allText(node).includes(text) : false; }
  async function clickOverlay(selector) {
    const node = await overlay();
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: node.shadowRoots[0].nodeId, selector });
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function() { this.click(); }" });
  }
  async function noticePosition() {
    const node = await overlay();
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: node.shadowRoots[0].nodeId, selector: ".notice" });
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, returnByValue: true,
      functionDeclaration: "function() { const rect = this.getBoundingClientRect(); return { top: rect.top, right: innerWidth - rect.right }; }" });
    return result.value;
  }

  await page.goto("https://focus-example.com/entertainment?token=URL_SECRET#private");
  await eventually(() => hasText("Come back to your focus."), "Off-task page was not blocked");
  assert.equal(await page.locator("main").evaluate(el => el.inert), true);
  await page.screenshot({ path: join(out, "blocked-page.png") });
  assert.doesNotMatch(JSON.stringify(requests), /FORM_SECRET|PASSWORD_SECRET|EDITOR_SECRET|HIDDEN_SECRET|URL_SECRET/);
  await clickOverlay("[data-allow]");
  await eventually(async () => !await overlay(), "Override did not release the page");
  assert.equal(await page.locator("main").evaluate(el => el.inert), false);
  await page.reload();
  await eventually(async () => (await worker.evaluate(async () => (await chrome.storage.session.get("focusState")).focusState.session.checked)) >= 1, "Missing session statistics");
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await overlay(), undefined, "Override should survive reload");

  await page.goto("https://focus-example.com/tutorial");
  await eventually(() => requests.some(r => r.state.page.title.startsWith("Tutorial")), "On-task page was not classified");
  await eventually(async () => !await overlay(), "On-task page should be accessible");

  // Real browser PDF viewer + real local PDF.js worker + mock Jev gateway.
  await page.goto(`${pdfOrigin}/resume.pdf?token=PDF_QUERY_SECRET`);
  await eventually(() => requests.some(r => r.state.page.description.startsWith("PDF text excerpt")), "PDF text never reached the gateway", 20000);
  const pdfRequest = requests.find(r => r.state.page.description.startsWith("PDF text excerpt"));
  assert.match(pdfRequest.state.page.text, /inference/);
  assert.ok(pdfRequest.state.page.text.length <= 4000);
  assert.doesNotMatch(JSON.stringify(pdfRequest), /PDF_QUERY_SECRET/);
  await eventually(async () => !await overlay(), "Readable on-task PDF should be accessible");
  await page.screenshot({ path: join(out, "pdf-readable.png") });

  await page.goto(`${pdfOrigin}/document-without-extension`);
  await eventually(() => requests.some(r => r.state.page.url.endsWith("/document-without-extension")), "PDF MIME detection failed without a .pdf suffix", 20000);
  await page.goto(`${pdfOrigin}/long.pdf`);
  await eventually(() => requests.some(r => r.state.page.url.endsWith("/long.pdf")), "Long PDF was not extracted", 20000);
  assert.equal(requests.find(r => r.state.page.url.endsWith("/long.pdf")).state.page.text.length, 4000);
  await eventually(async () => !await overlay(), "Long PDF reading did not finish cleanly");
  await page.goto(`${pdfOrigin}/entertainment.pdf`);
  await eventually(() => hasText("Come back to your focus."), "Off-task PDF was not blocked", 20000);
  assert.match(requests.find(r => r.state.page.url.endsWith("/entertainment.pdf")).state.page.text, /Celebrity gossip/);
  await clickOverlay("[data-allow]");
  await eventually(async () => !await overlay(), "PDF override did not release the document");
  const beforeUnreadable = requests.length;
  await page.goto(`${pdfOrigin}/scanned.pdf`);
  await eventually(() => hasText("no readable text"), "Image-only PDF should explain missing text", 20000);
  assert.equal(requests.length, beforeUnreadable, "Unreadable PDF must not go to Jev");
  await page.screenshot({ path: join(out, "pdf-unreadable.png") });
  await page.goto(`${pdfOrigin}/broken.pdf`);
  await eventually(() => hasText("couldn't read this PDF"), "Broken PDF should explain the extraction failure", 20000);
  assert.equal(requests.length, beforeUnreadable, "Broken PDF must not go to Jev");

  await page.goto(`${pdfOrigin}/delayed.pdf`);
  await eventually(() => Boolean(delayedPdfResolve), "Delayed PDF extraction never started");
  await page.goto("https://focus-example.com/tutorial-after-pdf");
  delayedPdfResolve();
  await eventually(() => requests.some(r => r.state.page.url.endsWith("/tutorial-after-pdf")), "Navigation away from PDF failed");
  assert.equal(requests.some(r => r.state.page.url.endsWith("/delayed.pdf")), false, "A stale PDF must not reach Jev");

  await page.goto("https://focus-example.com/unclear");
  await eventually(() => hasText("isn't sure"), "Uncertain page needs an accessible notice");
  assert.equal(await page.locator("main").evaluate(el => el.inert), false);
  await clickOverlay("button");

  // Simulate a client-side navigation and title update in an isolated test execution context.
  await page.evaluate(() => { history.pushState({}, "", "/entertainment-new"); document.title = "Celebrity gossip"; });
  await eventually(() => hasText("Come back to your focus."), "SPA navigation was not reassessed");

  await popup.bringToFront();
  await popup.locator("#pause-button").click();
  await page.bringToFront();
  await eventually(async () => !await overlay(), "Pausing did not release a block");
  await popup.bringToFront();
  await popup.locator("#pause-button").click();
  await page.bringToFront();
  await eventually(() => hasText("Come back to your focus."), "Resuming did not restore protection");

  await popup.bringToFront();
  await popup.locator("summary").click();
  await popup.locator("#exclusions").fill("focus-example.com");
  await popup.locator("#save-settings").click();
  await popup.getByText("Gateway ready. Describe your task and start a session.").waitFor();
  const beforeExcluded = requests.length;
  const beforePdfDownloads = pdfDownloads.length;
  await page.bringToFront();
  await eventually(async () => !await overlay(), "Excluding a site did not release its block");
  await page.goto("https://focus-example.com/private");
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(requests.length, beforeExcluded, "Excluded pages must never be sent to Jev");
  await page.goto(`${pdfOrigin}/excluded.pdf`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(pdfDownloads.length, beforePdfDownloads, "Excluded PDFs must not be downloaded for extraction");
  await popup.bringToFront();
  await popup.locator("#exclusions").fill("");
  await popup.locator("#save-settings").click();
  await popup.getByText("Gateway ready. Describe your task and start a session.").waitFor();
  await popup.locator("summary").click();
  await page.bringToFront();

  await page.goto("https://focus-example.com/delayed");
  await eventually(() => Boolean(holdResolve), "Delayed check never started");
  await clickOverlay("[data-end]");
  holdResolve();
  await eventually(async () => !await overlay(), "Ending the session did not release the page");
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await overlay(), undefined, "Late decision must not block after ending");

  // Start a new session and prove provider failures fail open in the real content script.
  await popup.bringToFront();
  await popup.locator("#start-button").click();
  await popup.locator("#session-view").waitFor({ state: "visible" });
  failed = true;
  await page.bringToFront();
  await page.goto("https://focus-example.com/provider-error");
  await eventually(() => hasText("unavailable"), "Provider failure needs a visible notice");
  assert.equal(await page.locator("main").evaluate(el => el.inert), false);
  assert.deepEqual(await noticePosition(), { top: 20, right: 20 }, "Notifications belong in the top right");
  await page.screenshot({ path: join(out, "notice-top-right.png") });
  await popup.bringToFront();
  await popup.locator("#end-button").click();
  await page.bringToFront();
  await eventually(async () => !await overlay(), "Ending a session must clear its error notice");
  const idleRequests = requests.length;
  await page.evaluate(() => { history.pushState({}, "", "/idle-after-error"); });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await overlay(), undefined, "Idle browsing must not revive an error notice");
  assert.equal(requests.length, idleRequests, "No checks are made without a session");

  // Reinject on a still-open page and prove old listeners/timers are replaced.
  failed = false;
  await popup.bringToFront();
  await popup.locator("#start-button").click();
  await page.bringToFront();
  await page.goto("https://focus-example.com/unclear-before-reinjection");
  await eventually(() => hasText("isn't sure"), "Missing pre-reinjection notice");
  await worker.evaluate(async url => {
    const [tab] = (await chrome.tabs.query({})).filter(tab => tab.url === url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  }, page.url());
  await eventually(() => hasText("isn't sure"), "Reinjected script did not reconnect");
  assert.equal(await page.locator("[data-tabfit-overlay]").count(), 1, "Reinjection must not duplicate controllers or notices");
  await popup.bringToFront();
  await popup.locator("#end-button").click();
  await page.bringToFront();
  await eventually(async () => !await overlay(), "Reinjected script did not clear the ended session");

  // Starting a fresh session must work on that same still-open document.
  await popup.bringToFront();
  await popup.locator("#start-button").click();
  await page.bringToFront();
  await eventually(() => hasText("isn't sure"), "Fresh session failed to reconnect the existing page");
  assert.equal(await page.locator("[data-tabfit-overlay]").count(), 1);

  // Simulate the local session deadline passing without a background RESET message.
  await worker.evaluate(async url => {
    const [tab] = (await chrome.tabs.query({})).filter(tab => tab.url === url);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const realNow = Date.now;
      Date.now = () => realNow() + 26 * 60000;
    } });
  }, page.url());
  await eventually(async () => !await overlay(), "A notice outlived the local session deadline");
  await page.evaluate(() => window.dispatchEvent(new Event("popstate")));
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(await overlay(), undefined, "Expired session state must not recreate a notice");
  await popup.bringToFront();
  await popup.locator("#end-button").click();

  // Finally invalidate the real extension context with runtime.reload. Keep the
  // webpage loaded and interact with it afterwards: the old script must stay quiet.
  // Some command-line Chromium builds don't reactivate unpacked extensions here.
  await popup.locator("#start-button").click();
  await page.bringToFront();
  await page.goto("https://focus-example.com/unclear-before-extension-reload");
  await eventually(() => hasText("isn't sure"), "Missing pre-reload notice");
  const reloadRequests = requests.length;
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await eventually(async () => !await overlay(), "Extension reload left an orphaned notice");
  await page.evaluate(() => { history.pushState({}, "", "/unclear-idle-after-reload"); window.dispatchEvent(new Event("popstate")); });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(await overlay(), undefined, "An invalidated script must remain quiet after tab reactivation");
  assert.equal(requests.length, reloadRequests, "Reloaded idle extension must not call Jev");
  assert.deepEqual(errors, [], `Browser errors: ${errors.join("; ")}`);
  console.log(`Browser smoke passed: setup, session, block, override, reload, on-task, PDF extraction, extensionless PDFs, scanned/broken PDFs, stale PDF read, uncertainty, SPA navigation, pause/resume, site exclusions, stale reply, active failure, top-right notices, idle cleanup, extension reload, reinjection and notice expiry. ${requests.length} mock Jev requests.`);
  console.log(`Screenshots: ${out}`);
} catch (error) {
  for (const [index, page] of (context?.pages() ?? []).entries()) {
    await page.screenshot({ path: join(out, `failure-${index}.png`) }).catch(() => {});
  }
  console.error("Browser errors:", errors);
  throw error;
} finally {
  holdResolve?.();
  delayedPdfResolve?.();
  await context?.close();
  gateway.closeAllConnections();
  gateway.close();
  pdfServer.closeAllConnections();
  pdfServer.close();
  await rm(profile, { recursive: true, force: true });
}
