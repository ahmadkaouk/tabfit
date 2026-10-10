import { pdfFailure } from "./pdf-reader.js";

let creating;
async function ensureReader() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("pdf-offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: "pdf-offscreen.html", reasons: ["WORKERS"],
      justification: "Extract text from the active PDF locally using a bundled PDF.js worker." });
  })();
  try { await creating; } finally { creating = null; }
}

export class PdfReader {
  constructor() { this.cache = new Map(); this.pending = new Map(); }

  clear() {
    this.cache.clear();
    for (const job of this.pending.values()) job.controller.abort();
    this.pending.clear();
  }

  async prepare(page) {
    if (page.kind !== "pdf") return page;
    let result = this.cache.get(page.url);
    if (!result || result.expiresAt <= Date.now()) {
      let job = this.pending.get(page.url);
      if (!job) {
        const controller = new AbortController();
        const id = crypto.randomUUID();
        const cancel = () => { void chrome.runtime.sendMessage({ target: "pdf-offscreen", type: "CANCEL_PDF", id }).catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        job = { controller };
        job.promise = (async () => {
          try {
            await ensureReader();
            controller.signal.throwIfAborted();
            const result = await chrome.runtime.sendMessage({ target: "pdf-offscreen", type: "READ_PDF", id, url: page.url });
            controller.signal.throwIfAborted();
            if (!result || !["read", "unreadable"].includes(result.status)) throw new Error("PDF reader unavailable");
            const entry = { ...result, expiresAt: Date.now() + (result.status === "read" ? 5 * 60000 : 30000) };
            this.cache.set(page.url, entry);
            if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
            return entry;
          } catch (error) { return pdfFailure(error); }
          finally {
            controller.signal.removeEventListener("abort", cancel);
            if (this.pending.get(page.url) === job) this.pending.delete(page.url);
          }
        })();
        this.pending.set(page.url, job);
      }
      result = await job.promise;
    }
    if (result.status === "unreadable") return result;
    return { ...page, text: result.text,
      description: `PDF text excerpt: first ${result.pagesRead} of ${result.totalPages} pages${result.truncated ? "; excerpt is partial" : ""}.` };
  }
}
