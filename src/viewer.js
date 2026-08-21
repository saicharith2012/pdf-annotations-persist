// The viewer. Wraps PDF.js's own annotation editor with document identity,
// auto-save, and write-back to disk.

import {
  getDocument,
  GlobalWorkerOptions,
  AnnotationEditorType,
  AnnotationEditorParamsType,
} from "../vendor/pdf.mjs";

import {
  computeDocId,
  readAnnotated,
  writeAnnotated,
  saveDoc,
  docIdForUrl,
} from "./store.js";

import {
  supported as fsaSupported,
  unavailableReason,
  ensurePermission,
  pickFileFor,
  handleFor,
  forgetHandle,
  writeToDisk,
  downloadFallback,
  filenameFromUrl,
} from "./disk.js";

// pdf_viewer.mjs has no imports of its own; it reads globalThis.pdfjsLib, which
// the static import above has already installed. Dynamic import keeps that
// ordering obvious rather than relying on the reader knowing module semantics.
const { EventBus, PDFViewer, PDFLinkService, PDFFindController } = await import("../vendor/pdf_viewer.mjs");

const V = (p) => chrome.runtime.getURL(`vendor/${p}`);
GlobalWorkerOptions.workerSrc = V("pdf.worker.mjs");

// pdf.js wants these as "name=#RRGGBB" pairs; the names show up in the editor's
// own accessibility labels.
const HIGHLIGHT_COLORS = [
  ["yellow", "#FFFF98"],
  ["green", "#53FFBC"],
  ["blue", "#80EBFF"],
  ["pink", "#FFCBE6"],
  ["red", "#F4A2FF"],
];
const HIGHLIGHT_COLOR_SPEC = HIGHLIGHT_COLORS.map(([n, v]) => `${n}=${v}`).join(",");
const HIGHLIGHT_PALETTE = HIGHLIGHT_COLORS.map(([, v]) => v);
const INK_COLORS = ["#E03131", "#1971C2", "#2F9E44", "#F08C00", "#1E1E1E"];

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  docId: null,
  filename: "document.pdf",
  pdfDocument: null,
  pdfViewer: null,
  uiManager: null,
  diskHandle: null,
  mode: AnnotationEditorType.NONE,
  dirty: false,
  saving: false,
  savePending: false,
  saveTimer: null,
  usingStored: false,
  colors: {
    [AnnotationEditorType.HIGHLIGHT]: HIGHLIGHT_PALETTE[0],
    [AnnotationEditorType.INK]: INK_COLORS[0],
    [AnnotationEditorType.FREETEXT]: INK_COLORS[4],
  },
};

// --- url parsing -----------------------------------------------------------

function parseParams() {
  // The DNR rule substitutes the original URL raw, so it can contain & and =.
  // "file" is therefore always last: everything after it belongs to the
  // document URL, and any flags go in front of it.
  const marker = /[?&]file=/.exec(location.search);
  let file = marker ? location.search.slice(marker.index + marker[0].length) : "";
  if (file && !/^(https?|file|blob|data):/i.test(file)) {
    try {
      file = decodeURIComponent(file);
    } catch {
      /* leave as-is */
    }
  }
  const params = new URLSearchParams(location.search);
  return {
    file,
    forceOriginal: params.get("original") === "1",
    keepDocId: params.get("keep") || null,
    hash: location.hash.slice(1),
  };
}

// --- byte loading ----------------------------------------------------------

/**
 * Chrome's fetch() rejects file:// URLs outright, so local PDFs go through XHR,
 * which extensions may use when "Allow access to file URLs" is enabled.
 */
function loadViaXhr(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => {
      // file:// responses report status 0 on success.
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
        resolve(new Uint8Array(xhr.response));
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Could not read the file."));
    xhr.send();
  });
}

async function loadBytes(url) {
  if (/^file:/i.test(url)) return loadViaXhr(url);
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

// --- notices ---------------------------------------------------------------

function notice(kind, message, actions = []) {
  const el = document.createElement("div");
  el.className = `notice ${kind}`;
  const p = document.createElement("p");
  p.textContent = message;
  el.append(p);
  for (const { label, onClick } of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", () => onClick(el));
    el.append(b);
  }
  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => el.remove());
  el.append(close);
  $("notices").append(el);
  return el;
}

function fatal(message, detail) {
  $("loading").hidden = true;
  notice("error", detail ? `${message} (${detail})` : message);
}

// --- save status -----------------------------------------------------------

function setSaveStatus(status, detail = "") {
  const dot = $("saveDot");
  const text = $("saveText");
  dot.className = "dot";
  switch (status) {
    case "saving":
      dot.classList.add("saving");
      text.textContent = "Saving…";
      break;
    case "saved": {
      dot.classList.add("saved");
      const where = state.diskHandle ? `Saved to ${state.diskHandle.name}` : "Saved";
      text.textContent = where;
      break;
    }
    case "pending":
      text.textContent = "Unsaved changes";
      break;
    case "error":
      dot.classList.add("error");
      text.textContent = "Save failed";
      break;
    case "regrant":
      text.textContent = "Click to resume file sync";
      break;
    case "diskOnly":
      dot.classList.add("error");
      text.textContent = "Saved to disk only";
      break;
    default:
      text.textContent = status;
  }
  $("saveChip").title = detail || "Where your changes are saved";
}

// --- saving ----------------------------------------------------------------

function scheduleSave() {
  state.dirty = true;
  setSaveStatus("pending");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => save(), 800);
}

const isQuotaError = (err) => err?.name === "QuotaExceededError" || err?.code === 22;

let storageWarningShown = false;

function reportStorageProblem() {
  if (storageWarningShown) return;
  storageWarningShown = true;
  notice(
    "error",
    "There is not enough room to save this document in the browser. Free up disk space, " +
      "or delete annotated copies you no longer need.",
    [{ label: "Open settings", onClick: () => chrome.runtime.openOptionsPage() }]
  );
}

async function save({ force = false, promptForPermission = false } = {}) {
  if (!state.pdfDocument) return;
  if (!state.dirty && !force) return;
  if (state.saving) {
    state.savePending = true;
    return;
  }

  state.saving = true;
  clearTimeout(state.saveTimer);
  setSaveStatus("saving");

  try {
    // Writes real /Highlight and /Ink annotation objects into the PDF, which is
    // why the marks survive in any other PDF reader too.
    let bytes;
    try {
      bytes = await state.pdfDocument.saveDocument();
    } catch (err) {
      console.error("[pdf-annot] could not serialise the document", err);
      setSaveStatus("error", `Could not prepare the PDF: ${err?.message || err}`);
      return;
    }

    // The two destinations fail independently: running out of browser storage
    // must not stop the file on disk from being updated, and vice versa.
    let browserOk = false;
    let browserErr = null;
    try {
      await writeAnnotated(state.docId, bytes);
      await saveDoc({
        docId: state.docId,
        sourceUrl: state.file,
        filename: state.filename,
        byteSize: bytes.byteLength,
      });
      browserOk = true;
    } catch (err) {
      browserErr = err;
      console.error("[pdf-annot] browser copy failed", err);
    }

    let diskState = "none";
    if (state.diskHandle) {
      if (await ensurePermission(state.diskHandle, { prompt: promptForPermission })) {
        try {
          await writeToDisk(state.diskHandle, bytes);
          diskState = "ok";
        } catch (err) {
          diskState = "error";
          console.error("[pdf-annot] disk write failed", err);
        }
      } else {
        diskState = "denied";
      }
    }

    if (!browserOk && diskState !== "ok") {
      if (isQuotaError(browserErr)) reportStorageProblem();
      setSaveStatus("error", String(browserErr?.message || browserErr || "Could not save."));
      return;
    }

    // At least one destination has the bytes, so the editor state is safe to clear.
    state.pdfDocument.annotationStorage.resetModified();
    state.dirty = false;

    if (!browserOk) {
      if (isQuotaError(browserErr)) reportStorageProblem();
      setSaveStatus("diskOnly", `Written to ${state.diskHandle.name}, but not stored in the browser.`);
    } else if (diskState === "denied") {
      setSaveStatus("regrant", "Saved in the browser. Click to write to the file on disk again.");
    } else if (diskState === "error") {
      setSaveStatus("saved", "Saved in the browser, but the file on disk could not be updated.");
    } else {
      setSaveStatus("saved");
    }
  } finally {
    state.saving = false;
    if (state.savePending) {
      state.savePending = false;
      scheduleSave();
    }
  }
}

// --- toolbar ---------------------------------------------------------------

function paramTypesFor(mode) {
  switch (mode) {
    case AnnotationEditorType.HIGHLIGHT:
      return { color: AnnotationEditorParamsType.HIGHLIGHT_COLOR, size: AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, palette: HIGHLIGHT_PALETTE, min: 8, max: 24, def: 12 };
    case AnnotationEditorType.INK:
      return { color: AnnotationEditorParamsType.INK_COLOR, size: AnnotationEditorParamsType.INK_THICKNESS, palette: INK_COLORS, min: 1, max: 20, def: 3 };
    case AnnotationEditorType.FREETEXT:
      return { color: AnnotationEditorParamsType.FREETEXT_COLOR, size: AnnotationEditorParamsType.FREETEXT_SIZE, palette: INK_COLORS, min: 6, max: 48, def: 14 };
    default:
      return null;
  }
}

function dispatchParam(type, value) {
  state.pdfViewer?.eventBus.dispatch("switchannotationeditorparams", { source: window, type, value });
}

function renderToolParams(mode) {
  const spec = paramTypesFor(mode);
  const wrap = $("toolParams");
  if (!spec) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const swatches = $("swatches");
  swatches.replaceChildren();
  for (const colour of spec.palette) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = colour;
    b.setAttribute("role", "radio");
    b.title = colour;
    b.setAttribute("aria-checked", String(state.colors[mode] === colour));
    b.addEventListener("click", () => {
      state.colors[mode] = colour;
      dispatchParam(spec.color, colour);
      for (const s of swatches.children) s.setAttribute("aria-checked", String(s === b));
    });
    swatches.append(b);
  }

  const slider = $("thickness");
  $("thicknessWrap").hidden = false;
  slider.min = spec.min;
  slider.max = spec.max;
  slider.value = spec.def;

  // Apply the remembered colour so the editor matches what the toolbar shows.
  dispatchParam(spec.color, state.colors[mode]);
  slider.oninput = () => dispatchParam(spec.size, Number(slider.value));
}

function setMode(mode) {
  if (!state.pdfViewer) return;
  // The setter takes an options object, unlike the constructor option.
  state.pdfViewer.annotationEditorMode = { mode };
}

function reflectMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll(".tool")) {
    b.classList.toggle("active", Number(b.dataset.mode) === mode);
  }
  renderToolParams(mode);
}

// --- find ------------------------------------------------------------------

function runFind(type = "") {
  const query = $("findInput").value;
  state.pdfViewer?.eventBus.dispatch("find", {
    source: window,
    type,
    query,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: type === "again-previous",
    matchDiacritics: false,
  });
}

function toggleFindbar(show) {
  const bar = $("findbar");
  bar.hidden = show === undefined ? !bar.hidden : !show;
  if (!bar.hidden) $("findInput").focus();
}

// --- menu ------------------------------------------------------------------

function toggleMenu(show) {
  const menu = $("menu");
  menu.hidden = show === undefined ? !menu.hidden : !show;
  $("menuToggle").setAttribute("aria-expanded", String(!menu.hidden));
}

function reflectDiskPairing() {
  $("unsyncFile").hidden = !state.diskHandle;
}

async function stopSyncingFile() {
  toggleMenu(false);
  await forgetHandle(state.docId);
  state.diskHandle = null;
  reflectDiskPairing();
  setSaveStatus("saved", "Still saving inside the browser. The file on disk is no longer updated.");
  notice("info", "Stopped syncing to the file on disk. Your annotations are still saved here.");
}

async function syncToFile() {
  toggleMenu(false);
  if (!fsaSupported) {
    const why = await unavailableReason();
    const actions = why.flagUrl
      ? [
          {
            // brave://flags cannot be opened by an extension, so hand over the
            // address instead of pretending we can navigate there.
            label: "Copy the address",
            onClick: (el) => {
              navigator.clipboard.writeText(why.flagUrl).catch(() => {});
              el.querySelector("button").textContent = "Copied";
            },
          },
        ]
      : [];
    notice("info", why.message, actions);
    return;
  }
  try {
    state.diskHandle = await pickFileFor(state.docId, state.filename);
    reflectDiskPairing();
    await save({ force: true, promptForPermission: true });
  } catch (err) {
    if (err?.name !== "AbortError") notice("error", `Could not set up file sync: ${err.message}`);
  }
}

async function saveCopy() {
  toggleMenu(false);
  try {
    const bytes = await state.pdfDocument.saveDocument();
    if (fsaSupported) {
      const handle = await window.showSaveFilePicker({
        suggestedName: state.filename.replace(/\.pdf$/i, "") + "-annotated.pdf",
        types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
      });
      await writeToDisk(handle, bytes);
    } else {
      await downloadFallback(state.filename, bytes);
    }
  } catch (err) {
    if (err?.name !== "AbortError") notice("error", `Could not save a copy: ${err.message}`);
  }
}

async function openNative() {
  toggleMenu(false);
  await chrome.runtime.sendMessage({ type: "bypassOnce", url: state.file });
  location.href = state.file;
}

// --- boot ------------------------------------------------------------------

async function main() {
  const { file, forceOriginal, keepDocId, hash } = parseParams();
  if (!file) {
    fatal("No PDF was specified.");
    return;
  }

  // Without this the browser may evict stored annotations under disk pressure.
  navigator.storage?.persist?.().catch(() => {});

  state.file = file;
  state.filename = filenameFromUrl(file);
  document.title = state.filename;

  let originalBytes;
  try {
    originalBytes = await loadBytes(file);
  } catch (err) {
    const isFile = /^file:/i.test(file);
    const allowed = isFile ? await chrome.extension.isAllowedFileSchemeAccess() : true;
    if (isFile && !allowed) {
      fatal(
        "This extension needs permission to read local files. Open brave://extensions, find " +
          "Persistent PDF Annotations, and turn on “Allow access to file URLs”, then reload."
      );
    } else {
      fatal("Could not load this PDF.", err.message);
    }
    return;
  }

  state.docId = await computeDocId(originalBytes);

  // The user chose to stay with the annotated version of a document whose
  // source has since changed.
  if (keepDocId) {
    const kept = await readAnnotated(keepDocId);
    if (kept) {
      state.docId = keepDocId;
      state.usingStored = true;
      await bootDocument(kept, hash);
      return;
    }
  }

  // A stored copy already contains the annotations, baked in as real PDF objects.
  let bytes = originalBytes;
  if (!forceOriginal) {
    const stored = await readAnnotated(state.docId);
    if (stored) {
      bytes = stored;
      state.usingStored = true;
    } else {
      // Same URL, different bytes: the source document changed under us. Never
      // drop the old annotations silently.
      const knownId = await docIdForUrl(file);
      if (knownId && knownId !== state.docId) {
        const hasPrevious = Boolean(await readAnnotated(knownId));
        if (hasPrevious) {
          notice(
            "info",
            "This document has changed since you annotated it. Your annotated version is kept.",
            [
              {
                label: "Open my annotated version",
                onClick: () => {
                  location.search = `?keep=${knownId}&file=${file}`;
                },
              },
            ]
          );
        }
      }
    }
  }

  await bootDocument(bytes, hash);
}

async function bootDocument(bytes, hash) {
  const container = $("viewerContainer");
  const viewer = $("viewer");
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  const findController = new PDFFindController({ eventBus, linkService });

  const pdfViewer = new PDFViewer({
    container,
    viewer,
    eventBus,
    linkService,
    findController,
    annotationEditorMode: AnnotationEditorType.NONE,
    annotationEditorHighlightColors: HIGHLIGHT_COLOR_SPEC,
    imageResourcesPath: V("images/"),
  });
  linkService.setViewer(pdfViewer);
  state.pdfViewer = pdfViewer;

  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "auto";
    if (hash) linkService.setHash(hash);
    $("loading").hidden = true;
  });

  eventBus.on("pagechanging", ({ pageNumber }) => {
    $("pageNumber").value = pageNumber;
  });

  eventBus.on("scalechanging", () => {
    const v = pdfViewer.currentScaleValue;
    if (["auto", "page-fit", "page-width"].includes(v)) $("zoomLevel").value = v;
  });

  eventBus.on("annotationeditoruimanager", ({ uiManager }) => {
    state.uiManager = uiManager;
  });

  eventBus.on("annotationeditormodechanged", ({ mode }) => reflectMode(mode));

  // Editors dispatch this when the user double-clicks an existing annotation.
  eventBus.on("switchannotationeditormode", ({ mode, editId }) => {
    pdfViewer.annotationEditorMode = { mode, editId };
  });

  eventBus.on("editingstateschanged", ({ details }) => {
    $("undo").disabled = !details.hasSomethingToUndo;
    $("redo").disabled = !details.hasSomethingToRedo;
  });

  eventBus.on("updatefindmatchescount", ({ matchesCount }) => {
    $("findStatus").textContent = matchesCount?.total
      ? `${matchesCount.current} of ${matchesCount.total}`
      : "";
  });

  eventBus.on("updatefindcontrolstate", ({ state: findState, matchesCount }) => {
    if (findState === 1 /* NOT_FOUND */) $("findStatus").textContent = "No matches";
    else if (matchesCount?.total) $("findStatus").textContent = `${matchesCount.current} of ${matchesCount.total}`;
  });

  try {
    const loadingTask = getDocument({
      data: bytes,
      cMapUrl: V("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: V("standard_fonts/"),
      wasmUrl: V("wasm/"),
      iccUrl: V("iccs/"),
    });
    loadingTask.onProgress = ({ loaded, total }) => {
      if (total) $("loadingText").textContent = `Opening PDF… ${Math.round((loaded / total) * 100)}%`;
    };

    const pdfDocument = await loadingTask.promise;
    state.pdfDocument = pdfDocument;

    pdfViewer.setDocument(pdfDocument);
    linkService.setDocument(pdfDocument);

    $("pageCount").textContent = `/ ${pdfDocument.numPages}`;
    $("pageNumber").max = pdfDocument.numPages;

    // The one hook that drives every auto-save.
    pdfDocument.annotationStorage.onSetModified = () => scheduleSave();

    state.diskHandle = await handleFor(state.docId);
    reflectDiskPairing();
    if (state.diskHandle && !(await ensurePermission(state.diskHandle))) {
      setSaveStatus("regrant", "Click to let the extension write to the file on disk again.");
    } else {
      setSaveStatus(state.usingStored ? "saved" : "No changes yet");
    }

    if (state.usingStored) {
      notice("info", "Showing your annotated copy of this document.", [
        {
          label: "Show the original",
          onClick: () => {
            location.search = `?original=1&file=${state.file}`;
          },
        },
      ]);
    }
  } catch (err) {
    console.error("[pdf-annot] load failed", err);
    fatal("This PDF could not be opened.", err?.message);
  }
}

// --- events ----------------------------------------------------------------

function wireUi() {
  $("prevPage").addEventListener("click", () => state.pdfViewer && state.pdfViewer.currentPageNumber--);
  $("nextPage").addEventListener("click", () => state.pdfViewer && state.pdfViewer.currentPageNumber++);
  $("pageNumber").addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (state.pdfViewer && n >= 1 && n <= state.pdfDocument.numPages) state.pdfViewer.currentPageNumber = n;
  });

  $("zoomIn").addEventListener("click", () => state.pdfViewer && (state.pdfViewer.currentScale *= 1.1));
  $("zoomOut").addEventListener("click", () => state.pdfViewer && (state.pdfViewer.currentScale /= 1.1));
  $("zoomLevel").addEventListener("change", (e) => {
    if (state.pdfViewer) state.pdfViewer.currentScaleValue = e.target.value;
  });

  for (const b of document.querySelectorAll(".tool")) {
    b.addEventListener("click", () => setMode(Number(b.dataset.mode)));
  }

  $("undo").addEventListener("click", () => state.uiManager?.undo());
  $("redo").addEventListener("click", () => state.uiManager?.redo());

  $("findToggle").addEventListener("click", () => toggleFindbar());
  $("findClose").addEventListener("click", () => toggleFindbar(false));
  $("findInput").addEventListener("input", () => runFind(""));
  $("findInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runFind(e.shiftKey ? "again-previous" : "again");
    if (e.key === "Escape") toggleFindbar(false);
  });
  $("findNext").addEventListener("click", () => runFind("again"));
  $("findPrev").addEventListener("click", () => runFind("again-previous"));

  $("menuToggle").addEventListener("click", () => toggleMenu());
  document.addEventListener("click", (e) => {
    if (!$("menu").hidden && !$("menu").contains(e.target) && e.target !== $("menuToggle")) toggleMenu(false);
  });

  $("syncFile").addEventListener("click", syncToFile);
  $("unsyncFile").addEventListener("click", stopSyncingFile);
  if (!fsaSupported) {
    $("syncFile").textContent = "Keep a file on disk in sync (unavailable)…";
  }
  $("saveCopy").addEventListener("click", saveCopy);
  $("showOriginal").addEventListener("click", () => {
    location.search = `?original=1&file=${state.file}`;
  });
  $("openNative").addEventListener("click", openNative);
  $("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

  // The chip doubles as the re-grant button after a browser restart.
  $("saveChip").addEventListener("click", () => save({ force: true, promptForPermission: true }));

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      toggleFindbar(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save({ force: true, promptForPermission: true });
      return;
    }
    if (typing) return;
    if (e.key === "Escape") setMode(AnnotationEditorType.NONE);
    if (e.key === "h" || e.key === "H") setMode(AnnotationEditorType.HIGHLIGHT);
    if (e.key === "d" || e.key === "D") setMode(AnnotationEditorType.INK);
    if (e.key === "t" || e.key === "T") setMode(AnnotationEditorType.FREETEXT);
    if (e.key === "n" || e.key === "N") state.pdfViewer && state.pdfViewer.currentPageNumber++;
    if (e.key === "p" || e.key === "P") state.pdfViewer && state.pdfViewer.currentPageNumber--;
  });

  // Best effort flush when the tab goes away; saveDocument cannot be awaited here.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) save();
  });
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

wireUi();
main();
