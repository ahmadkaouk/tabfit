import { deflateSync } from "node:zlib";

// A real, compressed, multi-page PDF: no third-party personal data in test fixtures.
export function makePdf(pages = ["Alex Example - Software Engineer", "Career: GPU inference, systems and performance."]) {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const pageIds = [];
  for (const text of pages) {
    const pageId = objects.length;
    pageIds.push(pageId);
    const lines = (text.match(/.{1,80}/g) ?? []).map(line => `(${line.replace(/([\\()])/g, "\\$1")}) Tj`);
    const stream = deflateSync(text ? `BT /F1 10 Tf 10 TL 50 750 Td ${lines.join(" T* ")} ET` : "0 0 0 rg 50 50 100 100 re f");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")]));
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  const chunks = [Buffer.from("%PDF-1.7\n")];
  const offsets = [0];
  let length = chunks[0].length;
  for (let i = 1; i < objects.length; i++) {
    offsets.push(length);
    const body = Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i]);
    const chunk = Buffer.concat([Buffer.from(`${i} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(chunk); length += chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
