#!/usr/bin/env node
// Checks that "Keep a file on disk in sync" really wrote annotations into the
// file you picked. Run after pairing a document in the viewer.
//
//   node scripts/verify-disk-sync.mjs ~/pdf-annot-test/disk-test.pdf
//
// Re-run it after each further edit: the mtime and the annotation count should
// both move without you being prompted again.

import { statSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error("usage: node scripts/verify-disk-sync.mjs <path-to-pdf>");
  process.exit(2);
}

// The browser build needs DOM globals; the legacy build runs in Node.
const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const { getDocument } = await import(pdfjsPath);

const st = statSync(target);
const bytes = new Uint8Array(readFileSync(target));

const doc = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;

const found = [];
for (let p = 1; p <= doc.numPages; p++) {
  for (const a of await (await doc.getPage(p)).getAnnotations()) {
    found.push({ page: p, subtype: a.subtype, color: a.color ? [...a.color] : null });
  }
}

const age = Math.round((Date.now() - st.mtimeMs) / 1000);
console.log(`file      ${target}`);
console.log(`size      ${st.size.toLocaleString()} bytes`);
console.log(`modified  ${st.mtime.toLocaleString()}  (${age}s ago)`);
console.log(`pages     ${doc.numPages}`);
console.log(`incremental updates appended: ${(readFileSync(target).toString("latin1").match(/%%EOF/g) || []).length - 1}`);

if (!found.length) {
  console.log("\nNo annotations in this file — the disk write did not happen.");
  process.exit(1);
}
console.log(`\n${found.length} annotation(s) written into the file:`);
for (const f of found) {
  console.log(`  page ${f.page}  ${f.subtype}${f.color ? `  rgb(${f.color})` : ""}`);
}
console.log("\nThe marks are in the file itself, so any PDF reader will show them.");
