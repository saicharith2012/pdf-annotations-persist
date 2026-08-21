// Persistence for annotated PDFs.
//
// Bytes live in OPFS (better than IndexedDB blobs for multi-megabyte files);
// metadata and FileSystemFileHandles live in IndexedDB, which is the only place
// a handle can survive a browser restart.

const DB_NAME = "pdf-annot";
const DB_VERSION = 1;
const OPFS_DIR = "annotated";

const STORE_DOCS = "docs"; // docId -> metadata
const STORE_URLS = "urls"; // sourceUrl -> docId
const STORE_HANDLES = "handles"; // docId -> FileSystemFileHandle

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) db.createObjectStore(STORE_DOCS, { keyPath: "docId" });
      if (!db.objectStoreNames.contains(STORE_URLS)) db.createObjectStore(STORE_URLS, { keyPath: "url" });
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES, { keyPath: "docId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result?.result ?? result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
const all = (store) => tx(store, "readonly", (s) => s.getAll());

// --- document identity -----------------------------------------------------

/**
 * Content hash of the *original* bytes. Using content rather than URL means
 * annotations follow a document through renames, moves and mirrored URLs.
 */
export async function computeDocId(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Pass a real ArrayBuffer so a view over a larger buffer is not over-read.
  const buf = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- OPFS ------------------------------------------------------------------

async function opfsDir(create = true) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create });
}

export async function readAnnotated(docId) {
  try {
    const dir = await opfsDir(false);
    const fh = await dir.getFileHandle(`${docId}.pdf`);
    const file = await fh.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null; // no stored copy
  }
}

export async function writeAnnotated(docId, bytes) {
  const dir = await opfsDir(true);
  const fh = await dir.getFileHandle(`${docId}.pdf`, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
  return bytes.byteLength;
}

export async function deleteAnnotated(docId) {
  try {
    const dir = await opfsDir(false);
    await dir.removeEntry(`${docId}.pdf`);
  } catch {
    /* already gone */
  }
}

// --- records ---------------------------------------------------------------

export const getDoc = (docId) => get(STORE_DOCS, docId);
export const listDocs = () => all(STORE_DOCS);

export async function saveDoc(record) {
  await put(STORE_DOCS, { ...record, lastSaved: Date.now() });
  if (record.sourceUrl) await put(STORE_URLS, { url: record.sourceUrl, docId: record.docId });
}

export async function docIdForUrl(url) {
  const row = await get(STORE_URLS, url);
  return row?.docId ?? null;
}

export async function forgetDoc(docId) {
  const record = await getDoc(docId);
  await deleteAnnotated(docId);
  await del(STORE_DOCS, docId);
  await del(STORE_HANDLES, docId);
  if (record?.sourceUrl) await del(STORE_URLS, record.sourceUrl);
}

export async function forgetAll() {
  for (const doc of await listDocs()) await forgetDoc(doc.docId);
}

export async function usage() {
  const docs = await listDocs();
  const bytes = docs.reduce((sum, d) => sum + (d.byteSize || 0), 0);
  const estimate = await navigator.storage.estimate().catch(() => null);
  return { count: docs.length, bytes, estimate };
}

// --- file handles ----------------------------------------------------------

export async function getFileHandle(docId) {
  const row = await get(STORE_HANDLES, docId);
  return row?.handle ?? null;
}

export const setFileHandle = (docId, handle) => put(STORE_HANDLES, { docId, handle });
export const clearFileHandle = (docId) => del(STORE_HANDLES, docId);
