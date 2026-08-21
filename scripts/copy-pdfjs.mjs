// Vendors the pieces of pdfjs-dist the extension actually loads into vendor/.
// MV3 forbids remote code, so everything must ship inside the extension.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "vendor");

// pdfjs-dist v6 keeps cmaps/standard_fonts/wasm/iccs at the package root,
// not under web/. Missing them breaks CJK, non-embedded fonts and scanned PDFs.
const entries = [
  ["build/pdf.mjs", "pdf.mjs"],
  ["build/pdf.worker.mjs", "pdf.worker.mjs"],
  ["web/pdf_viewer.mjs", "pdf_viewer.mjs"],
  ["web/pdf_viewer.css", "pdf_viewer.css"],
  ["web/images", "images"],
  ["cmaps", "cmaps"],
  ["standard_fonts", "standard_fonts"],
  ["wasm", "wasm"],
  ["iccs", "iccs"],
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const [from, to] of entries) {
  const src = join(pkg, from);
  try {
    await stat(src);
  } catch {
    console.error(`  MISSING ${from} — pdfjs-dist layout changed?`);
    process.exitCode = 1;
    continue;
  }
  await cp(src, join(out, to), { recursive: true });
  console.log(`  ${from} -> vendor/${to}`);
}
console.log("vendor/ ready");
