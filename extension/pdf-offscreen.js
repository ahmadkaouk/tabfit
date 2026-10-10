import { getDocument, GlobalWorkerOptions } from "./vendor/pdfjs/pdf.min.mjs";
import { downloadPdf, extractPdfText, pdfFailure, PDF_LIMITS } from "./pdf-reader.js";

GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
const jobs = new Map();

async function read(message) {
  if (jobs.size >= 2) return pdfFailure(new Error("PDF reader busy"));
  const controller = new AbortController();
  jobs.set(message.id, controller);
  const timer = setTimeout(() => controller.abort(new DOMException("PDF timeout", "TimeoutError")), PDF_LIMITS.timeoutMs);
  try {
    const data = await downloadPdf(message.url, { signal: controller.signal });
    const excerpt = await extractPdfText(data, { getDocument, signal: controller.signal,
      assetBase: chrome.runtime.getURL("vendor/pdfjs/") });
    return { status: "read", ...excerpt };
  } catch (error) { return pdfFailure(controller.signal.aborted ? controller.signal.reason : error); }
  finally { clearTimeout(timer); jobs.delete(message.id); }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "pdf-offscreen" || sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL("background.js"))) return;
  if (message.type === "CANCEL_PDF") { jobs.get(message.id)?.abort(); return; }
  if (message.type !== "READ_PDF") return;
  read(message).then(respond, error => respond(pdfFailure(error)));
  return true;
});
