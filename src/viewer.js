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

// Shapes are drawn as PDF.js ink editors: a rectangle is just a closed
// polyline. That keeps them genuine /Ink annotations, so they persist, undo,
// re-colour and export exactly like freehand strokes with no extra machinery.
const TOOLS = {
  select:    { mode: AnnotationEditorType.NONE },
  highlight: { mode: AnnotationEditorType.HIGHLIGHT },
  draw:      { mode: AnnotationEditorType.INK },
  text:      { mode: AnnotationEditorType.FREETEXT },
  rect:      { mode: AnnotationEditorType.INK, shape: "rect" },
  ellipse:   { mode: AnnotationEditorType.INK, shape: "ellipse" },
  line:      { mode: AnnotationEditorType.INK, shape: "line" },
  arrow:     { mode: AnnotationEditorType.INK, shape: "arrow" },
  // The eraser keeps ink mode on so existing ink annotations are live editors
  // and can be removed directly.
  erase:     { mode: AnnotationEditorType.INK, erase: true },
};

const MODE_TO_TOOL = new Map([
  [AnnotationEditorType.NONE, "select"],
  [AnnotationEditorType.HIGHLIGHT, "highlight"],
  [AnnotationEditorType.INK, "draw"],
  [AnnotationEditorType.FREETEXT, "text"],
]);

const state = {
  file: null,
  docId: null,
  filename: "document.pdf",
  pdfDocument: null,
  pdfViewer: null,
  uiManager: null,
  diskHandle: null,
  tool: "select",
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

// --- shape geometry --------------------------------------------------------
// All points are in PDF user space (origin bottom-left), which is what
// InkDrawOutline.deserialize expects, and they must be typed arrays.

const ARROW_HEAD_MIN = 9;

function constrain(kind, x0, y0, x1, y1) {
  // Shift gives squares, circles, and 45-degree lines.
  if (kind === "line" || kind === "arrow") {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
    const len = Math.hypot(dx, dy);
    return [x0, y0, x0 + Math.cos(angle) * len, y0 + Math.sin(angle) * len];
  }
  const side = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  return [x0, y0, x0 + Math.sign(x1 - x0 || 1) * side, y0 + Math.sign(y1 - y0 || 1) * side];
}

// PDF.js smooths any ink path of more than two points into Bezier curves, which
// rounds off corners. Straight edges must therefore be emitted as separate
// two-point paths; only the ellipse wants the smoothing.
const seg = (ax, ay, bx, by) => new Float32Array([ax, ay, bx, by]);

function shapePaths(kind, x0, y0, x1, y1, thickness) {
  switch (kind) {
    case "rect":
      return [
        seg(x0, y0, x1, y0),
        seg(x1, y0, x1, y1),
        seg(x1, y1, x0, y1),
        seg(x0, y1, x0, y0),
      ];
    case "ellipse": {
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const rx = Math.abs(x1 - x0) / 2;
      const ry = Math.abs(y1 - y0) / 2;
      const steps = 64;
      const pts = new Float32Array((steps + 1) * 2);
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * 2 * Math.PI;
        pts[i * 2] = cx + rx * Math.cos(a);
        pts[i * 2 + 1] = cy + ry * Math.sin(a);
      }
      return [pts];
    }
    case "line":
      return [seg(x0, y0, x1, y1)];
    case "arrow": {
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const head = Math.max(ARROW_HEAD_MIN, thickness * 3.5);
      const spread = Math.PI / 7;
      // Shaft plus two head strokes, each straight.
      return [
        seg(x0, y0, x1, y1),
        seg(x1 - head * Math.cos(angle - spread), y1 - head * Math.sin(angle - spread), x1, y1),
        seg(x1 - head * Math.cos(angle + spread), y1 - head * Math.sin(angle + spread), x1, y1),
      ];
    }
    default:
      return [];
  }
}

function boundsOf(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) {
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
  }
  return [minX, minY, maxX, maxY];
}

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Build a real ink annotation from computed geometry and register an undo. */
async function addShape(pageIndex, paths, colorHex, thickness) {
  const pageView = state.pdfViewer.getPageView(pageIndex);
  const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
  if (!layer) return;

  const editor = await layer.deserialize({
    annotationType: AnnotationEditorType.INK,
    color: hexToRgb(colorHex),
    opacity: 1,
    thickness,
    paths: { points: paths },
    pageIndex,
    rect: boundsOf(paths),
    rotation: 0,
  });
  if (!editor) return;

  state.uiManager?.addCommands({
    cmd: () => layer.addOrRebuild(editor),
    undo: () => editor.remove(),
    mustExec: true,
  });
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

function setTool(name) {
  if (!state.pdfViewer || !TOOLS[name]) return;
  state.tool = name;
  const { mode } = TOOLS[name];
  if (state.mode !== mode) {
    // The setter takes an options object, unlike the constructor option.
    state.pdfViewer.annotationEditorMode = { mode };
  }
  reflectTool();
}

function reflectTool() {
  for (const b of document.querySelectorAll(".tool")) {
    b.classList.toggle("active", b.dataset.tool === state.tool);
  }
  syncOverlay();
  // Shapes are ink, so they share ink's colour and thickness controls.
  renderToolParams(TOOLS[state.tool].erase ? AnnotationEditorType.NONE : TOOLS[state.tool].mode);
}

// --- drawing overlay -------------------------------------------------------
// Shapes and the eraser need their own pointer handling, so a transparent
// layer sits above the pages and intercepts events before PDF.js sees them.

const drag = { active: false, pageIndex: -1, x0: 0, y0: 0, x1: 0, y1: 0, shift: false };

function positionOverlay() {
  const r = $("viewerContainer").getBoundingClientRect();
  const o = $("shapeOverlay");
  o.style.top = `${r.top}px`;
  o.style.left = `${r.left}px`;
  o.style.width = `${r.width}px`;
  o.style.height = `${r.height}px`;
}

function overlayActive() {
  const t = TOOLS[state.tool];
  return Boolean(t?.shape || t?.erase);
}

function syncOverlay() {
  const on = overlayActive();
  $("shapeOverlay").hidden = !on;
  $("shapeOverlay").classList.toggle("erasing", TOOLS[state.tool]?.erase === true);
  if (on) positionOverlay();
  clearPreview();
}

/** The page element under a client point, plus its index. */
function pageAt(clientX, clientY) {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const pageDiv = el.closest?.(".page");
    if (pageDiv?.dataset.pageNumber) {
      return { pageDiv, pageIndex: Number(pageDiv.dataset.pageNumber) - 1 };
    }
  }
  return null;
}

/** Client coordinates -> PDF user space for a given page. */
function toPdfPoint(pageIndex, pageDiv, clientX, clientY) {
  const pageView = state.pdfViewer.getPageView(pageIndex);
  const r = pageDiv.getBoundingClientRect();
  return pageView.viewport.convertToPdfPoint(clientX - r.left, clientY - r.top);
}

function clearPreview() {
  $("shapePreview").replaceChildren();
}

function drawPreview() {
  const svg = $("shapePreview");
  svg.replaceChildren();
  const kind = TOOLS[state.tool].shape;
  const oRect = $("shapeOverlay").getBoundingClientRect();
  let [x0, y0, x1, y1] = [drag.x0, drag.y0, drag.x1, drag.y1];
  if (drag.shift) [x0, y0, x1, y1] = constrain(kind, x0, y0, x1, y1);

  // Preview is drawn in overlay-local pixels; the committed shape is rebuilt
  // in PDF space, so the two agree once the page scale is applied.
  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs) => {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", state.colors[AnnotationEditorType.INK]);
    el.setAttribute("stroke-width", $("thickness").value || 3);
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("stroke-linejoin", "round");
    return el;
  };
  const [lx0, ly0, lx1, ly1] = [x0 - oRect.left, y0 - oRect.top, x1 - oRect.left, y1 - oRect.top];

  if (kind === "rect") {
    svg.append(mk("rect", { x: Math.min(lx0, lx1), y: Math.min(ly0, ly1), width: Math.abs(lx1 - lx0), height: Math.abs(ly1 - ly0) }));
  } else if (kind === "ellipse") {
    svg.append(mk("ellipse", { cx: (lx0 + lx1) / 2, cy: (ly0 + ly1) / 2, rx: Math.abs(lx1 - lx0) / 2, ry: Math.abs(ly1 - ly0) / 2 }));
  } else if (kind === "line") {
    svg.append(mk("line", { x1: lx0, y1: ly0, x2: lx1, y2: ly1 }));
  } else if (kind === "arrow") {
    const angle = Math.atan2(ly1 - ly0, lx1 - lx0);
    const head = Math.max(ARROW_HEAD_MIN, (Number($("thickness").value) || 3) * 3.5);
    const sp = Math.PI / 7;
    svg.append(mk("line", { x1: lx0, y1: ly0, x2: lx1, y2: ly1 }));
    svg.append(mk("polyline", {
      points: `${lx1 - head * Math.cos(angle - sp)},${ly1 - head * Math.sin(angle - sp)} ${lx1},${ly1} ${lx1 - head * Math.cos(angle + sp)},${ly1 - head * Math.sin(angle + sp)}`,
    }));
  }
}

async function commitShape() {
  const kind = TOOLS[state.tool].shape;
  const hit = pageAt(drag.x0, drag.y0);
  if (!hit) return;

  let [cx0, cy0, cx1, cy1] = [drag.x0, drag.y0, drag.x1, drag.y1];
  if (drag.shift) [cx0, cy0, cx1, cy1] = constrain(kind, cx0, cy0, cx1, cy1);
  // Ignore stray clicks.
  if (Math.hypot(cx1 - cx0, cy1 - cy0) < 4) return;

  const [px0, py0] = toPdfPoint(hit.pageIndex, hit.pageDiv, cx0, cy0);
  const [px1, py1] = toPdfPoint(hit.pageIndex, hit.pageDiv, cx1, cy1);
  const thickness = Number($("thickness").value) || 3;
  const paths = shapePaths(kind, px0, py0, px1, py1, thickness);
  await addShape(hit.pageIndex, paths, state.colors[AnnotationEditorType.INK], thickness);
}

// --- eraser ----------------------------------------------------------------

/**
 * Deletes whole marks rather than pixels: ink is vector, so partial erasure is
 * not meaningful. Live editors are removed outright; marks already baked into
 * the PDF get a deletion record that saveDocument acts on.
 */
function eraseAt(clientX, clientY) {
  const hit = pageAt(clientX, clientY);
  if (!hit) return false;

  const candidates = [];
  for (const el of hit.pageDiv.querySelectorAll('.annotationEditorLayer [id^="pdfjs_internal_editor_"]')) {
    candidates.push({ el, kind: "editor" });
  }
  for (const el of hit.pageDiv.querySelectorAll(".annotationLayer section[data-annotation-id]")) {
    if (el.style.display !== "none") candidates.push({ el, kind: "annotation" });
  }

  // Hit-test by box, and prefer the tightest match so overlapping marks stay
  // individually erasable. A thin stroke is nearly impossible to hit exactly.
  let best = null;
  for (const cand of candidates) {
    const r = cand.el.getBoundingClientRect();
    if (clientX < r.left - 2 || clientX > r.right + 2 || clientY < r.top - 2 || clientY > r.bottom + 2) continue;
    const area = Math.max(r.width * r.height, 1);
    // Editors sit above annotations, so break ties in their favour.
    const score = area - (cand.kind === "editor" ? 0.5 : 0);
    if (!best || score < best.score) best = { ...cand, score };
  }
  if (!best) return false;

  if (best.kind === "editor") {
    const editor = state.uiManager?.getEditor(best.el.id);
    if (!editor) return false;
    const layer = editor.parent;
    const uiManager = state.uiManager;
    // An editor standing in for an annotation already in the file needs an
    // explicit deletion record. Without it removeEditor simply drops the
    // storage entry and the mark reappears on the next save.
    const fromFile = Boolean(editor.annotationElementId);
    uiManager.addCommands({
      cmd: () => {
        if (fromFile) {
          uiManager.addToAnnotationStorage(editor);
          uiManager.addDeletedAnnotationElement(editor);
        }
        editor.remove();
        scheduleSave();
      },
      undo: () => {
        if (fromFile) uiManager.removeDeletedAnnotationElement(editor);
        layer?.addOrRebuild(editor);
        scheduleSave();
      },
      mustExec: true,
    });
    return true;
  }

  const id = best.el.dataset.annotationId;
  const storage = state.pdfDocument.annotationStorage;
  // The key must carry PDF.js's editor prefix or the worker ignores the entry.
  const key = `${"pdfjs_internal_editor_"}deleted_${id}`;
  const el = best.el;
  state.uiManager?.addCommands({
    cmd: () => {
      storage.setValue(key, { id, deleted: true, pageIndex: hit.pageIndex, popupRef: "" });
      el.style.display = "none";
      scheduleSave();
    },
    undo: () => {
      storage.remove(key);
      el.style.display = "";
      scheduleSave();
    },
    mustExec: true,
  });
  return true;
}

// --- overlay events --------------------------------------------------------

function wireOverlay() {
  const overlay = $("shapeOverlay");

  overlay.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (TOOLS[state.tool]?.erase) {
      eraseAt(e.clientX, e.clientY);
      drag.active = true; // allow dragging across several marks
      return;
    }
    drag.active = true;
    drag.shift = e.shiftKey;
    drag.x0 = drag.x1 = e.clientX;
    drag.y0 = drag.y1 = e.clientY;
    overlay.setPointerCapture?.(e.pointerId);
  });

  overlay.addEventListener("pointermove", (e) => {
    if (!drag.active) return;
    if (TOOLS[state.tool]?.erase) {
      eraseAt(e.clientX, e.clientY);
      return;
    }
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    drag.shift = e.shiftKey;
    drawPreview();
  });

  const finish = async (e) => {
    if (!drag.active) return;
    drag.active = false;
    if (TOOLS[state.tool]?.erase) return;
    drag.x1 = e.clientX;
    drag.y1 = e.clientY;
    drag.shift = e.shiftKey;
    clearPreview();
    await commitShape();
  };
  overlay.addEventListener("pointerup", finish);
  overlay.addEventListener("pointercancel", () => {
    drag.active = false;
    clearPreview();
  });

  window.addEventListener("resize", () => overlayActive() && positionOverlay());
  $("viewerContainer").addEventListener("scroll", () => overlayActive() && clearPreview());
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

  eventBus.on("annotationeditormodechanged", ({ mode }) => {
    state.mode = mode;
    // Only follow PDF.js when it moved somewhere our current tool does not
    // already cover, so shape and eraser tools are not reset by their own
    // switch into ink mode.
    if (TOOLS[state.tool].mode !== mode) {
      state.tool = MODE_TO_TOOL.get(mode) ?? "select";
    }
    reflectTool();
  });

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
    b.addEventListener("click", () => setTool(b.dataset.tool));
  }
  wireOverlay();

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
    const byKey = { escape: "select", h: "highlight", d: "draw", t: "text", r: "rect", o: "ellipse", l: "line", a: "arrow", e: "erase" };
    const tool = byKey[e.key.toLowerCase()];
    if (tool) setTool(tool);
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
