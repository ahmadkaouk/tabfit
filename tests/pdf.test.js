import test from "node:test";
import assert from "node:assert/strict";
import { downloadPdf, extractPdfText, pdfFailure } from "../extension/pdf-reader.js";

const pdf = new TextEncoder().encode("%PDF-1.7\nexample binary contents");

test("PDF downloads preserve the original URL only for its host and reject redirects", async () => {
  let sent;
  const url = "https://example.com/resume.pdf?download=private-token";
  const result = await downloadPdf(url, { fetcher: async (...args) => { sent = args; return new Response(pdf); } });
  assert.deepEqual(result, pdf);
  assert.equal(sent[0], url);
  assert.equal(sent[1].redirect, "error");
  assert.equal(sent[1].credentials, "include");
  let calls = 0;
  for (const address of ["file:///private/doc.pdf", "http://127.0.0.1/doc.pdf", "https://me:secret@example.com/doc.pdf"]) {
    await assert.rejects(downloadPdf(address, { fetcher: () => { calls++; } }), /download/);
  }
  assert.equal(calls, 0);
});

test("PDF downloads bound both declared and streamed sizes and reject HTML sign-in pages", async () => {
  await assert.rejects(downloadPdf("https://example.com/doc.pdf", { maxBytes: 20,
    fetcher: async () => new Response(pdf, { headers: { "Content-Length": "1000" } }) }), /too_large/);
  await assert.rejects(downloadPdf("https://example.com/doc.pdf", { maxBytes: 20,
    fetcher: async () => new Response(pdf) }), /too_large/);
  await assert.rejects(downloadPdf("https://example.com/doc.pdf", {
    fetcher: async () => new Response("<html>Please sign in</html>") }), /unreadable/);
});

function fakePdf(pages) {
  let destroyed = 0;
  let pageCalls = 0;
  let options;
  const task = { destroy: async () => { destroyed++; }, promise: Promise.resolve({ numPages: pages.length,
    getPage: async n => { pageCalls++; return { cleanup() {}, streamTextContent: () => new ReadableStream({
      start(controller) { controller.enqueue({ items: pages[n - 1].map(str => ({ str })) }); controller.close(); },
    }) }; },
  }) };
  return { getDocument: args => { options = args; return task; }, assetBase: "chrome-extension://test/vendor/",
    stats: () => ({ destroyed, pageCalls, options }) };
}

test("text extraction respects page/character budgets and always destroys the parser", async () => {
  const reader = fakePdf([[" First  page ", "has text"], ["Second page"], ["Third page"]]);
  const result = await extractPdfText(pdf, { ...reader, limits: { pages: 2, characters: 24 } });
  assert.equal(result.text, "First page has text Seco");
  assert.equal(result.pagesRead, 2);
  assert.equal(result.totalPages, 3);
  assert.equal(result.truncated, true);
  assert.equal(reader.stats().pageCalls, 2);
  assert.equal(reader.stats().destroyed, 1);
  assert.equal(reader.stats().options.isEvalSupported, false);
  assert.equal(reader.stats().options.enableXfa, false);
  const limited = fakePdf([["A"], ["B"], ["C"]]);
  assert.equal((await extractPdfText(pdf, { ...limited, limits: { pages: 1, characters: 4000 } })).text, "A");
  assert.equal(limited.stats().pageCalls, 1);
});

test("empty, password-protected and failed PDFs have an extraction message, never a model judgment", async () => {
  const reader = fakePdf([[], [" "]]);
  await assert.rejects(extractPdfText(pdf, reader), /no_text/);
  assert.equal(reader.stats().destroyed, 1);
  for (const error of [{ reason: "no_text" }, { name: "PasswordException" }, { name: "TimeoutError" }, new Error("secret server details")]) {
    const result = pdfFailure(error);
    assert.equal(result.status, "unreadable");
    assert.doesNotMatch(result.message, /Jev|secret server details/);
  }
});
