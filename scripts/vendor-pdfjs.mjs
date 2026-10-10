import { cp, mkdir, readFile, writeFile } from "node:fs/promises";

const source = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const target = new URL("../extension/vendor/pdfjs/", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", source), "utf8"));
await mkdir(target, { recursive: true });
for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  await cp(new URL(`legacy/build/${name}`, source), new URL(name, target));
}
for (const name of ["LICENSE", "cmaps", "standard_fonts"]) {
  await cp(new URL(name, source), new URL(name, target), { recursive: true });
}
await writeFile(new URL("VERSION", target), `${pkg.version}\n`);
console.log(`Bundled PDF.js ${pkg.version}, worker, character maps, fonts and licenses.`);
