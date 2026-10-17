import { isPublicPage } from "./core.js";

export const PDF_LIMITS = Object.freeze({ bytes: 12 * 1024 * 1024, pages: 10, characters: 4000, timeoutMs: 12000 });

export class PdfReadError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export function pdfFailure(error) {
  const reason = error?.name === "PasswordException" ? "password" : error?.reason ||
    (error?.name === "TimeoutError" ? "timeout" : error?.name === "AbortError" ? "cancelled" : "unreadable");
  const messages = {
    password: "This PDF needs a password. TabFit couldn't read it, so it stays accessible.",
    no_text: "TabFit found no readable text in this PDF excerpt. It may be a scan; it stays accessible.",
    too_large: "This PDF is larger than TabFit's 12 MB reading limit, so it stays accessible.",
    timeout: "Reading this PDF took too long. It stays accessible; you can try again.",
    download: "TabFit couldn't download this PDF for a text check. It stays accessible.",
    unreadable: "TabFit couldn't read this PDF. It stays accessible.",
    cancelled: "The PDF check was cancelled. It stays accessible.",
  };
  return { status: "unreadable", reason: reason in messages ? reason : "unreadable", message: messages[reason] || messages.unreadable };
}

// Fetch only the tab's validated public URL; download and parsing stay local.
// Redirects are refused so a public PDF cannot redirect the reader to a private host.
export async function downloadPdf(url, { signal, fetcher = fetch, maxBytes = PDF_LIMITS.bytes } = {}) {
  if (!isPublicPage(url)) throw new PdfReadError("download");
  let response;
  try {
    response = await fetcher(url, { signal, credentials: "include", redirect: "error", headers: { Accept: "application/pdf" } });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new PdfReadError("download");
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new PdfReadError("download"); }
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body.cancel();
    throw new PdfReadError("too_large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new PdfReadError("too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  if (!new TextDecoder().decode(data.subarray(0, 1024)).includes("%PDF-")) throw new PdfReadError("unreadable");
  return data;
}

// The injected PDF.js API keeps this module testable without loading a renderer in Node.
export async function extractPdfText(data, { getDocument, assetBase, signal, limits = PDF_LIMITS }) {
  signal?.throwIfAborted();
  const task = getDocument({
    data, verbosity: 0, useWasm: false, isEvalSupported: false, enableXfa: false,
    disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    cMapUrl: `${assetBase}cmaps/`, cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
  });
  const stop = () => { void task.destroy().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const doc = await task.promise;
    let text = "";
    let pagesRead = 0;
    for (let index = 1; index <= Math.min(doc.numPages, limits.pages) && text.length < limits.characters; index++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(index);
      const reader = page.streamTextContent().getReader();
      try {
        // Drain the current page even once the excerpt is full. Cancelling here
        // races PDF.js's queued enqueue/close messages and produces stray errors.
        // The document timeout and download limit still bound this work.
        while (true) {
          signal?.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== "string") continue;
            const part = item.str.replace(/\s+/g, " ").trim();
            if (part) text += `${text ? " " : ""}${part}`.slice(0, limits.characters - text.length);
            if (text.length >= limits.characters) break;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        page.cleanup();
      }
      pagesRead++;
    }
    signal?.throwIfAborted();
    if (!text.trim()) throw new PdfReadError("no_text");
    return { text: text.trim(), pagesRead, totalPages: doc.numPages,
      truncated: text.length >= limits.characters || pagesRead < doc.numPages };
  } finally {
    signal?.removeEventListener("abort", stop);
    await task.destroy().catch(() => {});
  }
}
