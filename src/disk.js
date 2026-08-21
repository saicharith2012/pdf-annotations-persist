// Writing annotated bytes back to a real file via the File System Access API.
//
// We keep one FileSystemFileHandle per document rather than a directory handle:
// the API never exposes absolute paths, so mapping file:///home/.../a.pdf onto a
// granted folder would mean guessing at filenames. A per-file handle hits the
// exact file with no path arithmetic.

import { getFileHandle, setFileHandle, clearFileHandle } from "./store.js";

// Brave ships with the File System Access pickers disabled for privacy; Chrome
// enables them. Everything else in the extension works either way — only the
// "keep the file on disk in sync" feature depends on this.
export const supported = typeof window !== "undefined" && "showSaveFilePicker" in window;

async function isBrave() {
  try {
    return Boolean(await navigator.brave?.isBrave?.());
  } catch {
    return false;
  }
}

/** Actionable explanation for why disk sync is unavailable. */
export async function unavailableReason() {
  if (supported) return null;
  return (await isBrave())
    ? {
        message:
          "Brave keeps the file-picker API switched off by default, so the extension cannot write to a file on disk yet. " +
          "Enable “File System Access API” at brave://flags/#file-system-access-api and restart Brave. " +
          "Your annotations are still saved automatically inside the browser either way.",
        flagUrl: "brave://flags/#file-system-access-api",
      }
    : {
        message:
          "This browser does not offer the file-picker API, so the extension cannot write to a file on disk. " +
          "Your annotations are still saved automatically inside the browser, and “Save a copy” still works.",
        flagUrl: null,
      };
}

const PDF_TYPE = {
  description: "PDF document",
  accept: { "application/pdf": [".pdf"] },
};

/**
 * Permission survives across sessions only as a "prompt" state, so the first
 * save after a browser restart needs a click. Must be called from a user gesture
 * when it is going to prompt.
 */
export async function ensurePermission(handle, { prompt = false } = {}) {
  if (!handle) return false;
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!prompt) return false;
  try {
    return (await handle.requestPermission(opts)) === "granted";
  } catch {
    return false;
  }
}

/** Ask the user to point at the file to keep in sync. Needs a user gesture. */
export async function pickFileFor(docId, suggestedName) {
  const handle = await window.showSaveFilePicker({
    id: "pdfAnnotTarget",
    suggestedName,
    types: [PDF_TYPE],
    excludeAcceptAllOption: false,
  });
  await setFileHandle(docId, handle);
  return handle;
}

export async function handleFor(docId) {
  return getFileHandle(docId);
}

export const forgetHandle = clearFileHandle;

export async function writeToDisk(handle, bytes) {
  const w = await handle.createWritable();
  try {
    await w.write(bytes);
    await w.close();
  } catch (err) {
    await w.abort?.().catch(() => {});
    throw err;
  }
  return handle.name;
}

/** Last resort when the user declines every picker. */
export function downloadFallback(filename, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      // Revoking too early cancels the download, so give it a moment.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id);
    });
  });
}

/** file:///home/me/report.pdf -> report.pdf ; falls back to a sane default. */
export function filenameFromUrl(url, fallback = "document.pdf") {
  try {
    const path = new URL(url).pathname;
    const name = decodeURIComponent(path.split("/").pop() || "");
    if (!name) return fallback;
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  } catch {
    return fallback;
  }
}
