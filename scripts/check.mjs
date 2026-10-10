import { readFile, access, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("extension/manifest.json", root), "utf8"));
if (manifest.manifest_version !== 3 || manifest.background.type !== "module") throw new Error("Expected a Manifest V3 module worker.");
const assets = [manifest.background.service_worker, manifest.action.default_popup,
  "pdf-offscreen.html", "pdf-offscreen.js", "pdf-client.js", "pdf-reader.js",
  "vendor/pdfjs/pdf.min.mjs", "vendor/pdfjs/pdf.worker.min.mjs", "vendor/pdfjs/LICENSE", "vendor/pdfjs/VERSION",
  ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons ?? {})];
for (const asset of assets) await access(new URL(`extension/${asset}`, root));
for (const folder of ["extension", "server", "scripts"]) {
  for (const file of await readdir(new URL(`${folder}/`, root))) {
    if (/\.m?js$/.test(file)) execFileSync(process.execPath, ["--check", new URL(`${folder}/${file}`, root).pathname]);
  }
}
console.log("Manifest assets and JavaScript syntax are valid.");
