import { listDocs, forgetDoc, forgetAll, usage, getFileHandle, clearFileHandle } from "./store.js";
import { supported as fsaSupported, unavailableReason } from "./disk.js";

const $ = (id) => document.getElementById(id);

const formatBytes = (n) => {
  if (!n) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
};

const formatWhen = (ts) => {
  if (!ts) return "—";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ts).toLocaleDateString();
};

function statusRow(kind, label, extra) {
  const li = document.createElement("li");
  const dot = document.createElement("span");
  dot.className = `dot ${kind}`;
  const text = document.createElement("span");
  text.textContent = label;
  li.append(dot, text);
  if (extra) li.append(extra);
  return li;
}

async function renderStatus() {
  const list = $("status");
  list.replaceChildren();

  const res = await chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
  if (!res?.ok) {
    list.append(statusRow("warn", "Could not reach the extension's background worker."));
    return;
  }

  const { settings, rules, fileAccess } = res;

  list.append(
    settings.enabled
      ? statusRow("ok", `Taking over PDF navigations (${rules.length} rule${rules.length === 1 ? "" : "s"} active).`)
      : statusRow("off", "Turned off — PDFs open in Brave's built-in viewer.")
  );

  if (settings.enabled) {
    list.append(
      settings.ctypeFallback
        ? statusRow("warn", "PDFs without a .pdf address are caught by a fallback, so they may flash the built-in viewer first.")
        : statusRow("ok", "PDFs are detected by both address and content type.")
    );
  }

  if (fsaSupported) {
    list.append(statusRow("ok", "Annotated PDFs can be written back to a file on disk."));
  } else {
    const why = await unavailableReason();
    const extra = document.createElement("code");
    if (why.flagUrl) extra.textContent = why.flagUrl;
    list.append(
      statusRow(
        "warn",
        why.flagUrl
          ? "Writing back to a file on disk is switched off in this browser. Annotations still save automatically. To enable it:"
          : "Writing back to a file on disk is unavailable here. Annotations still save automatically.",
        why.flagUrl ? extra : null
      )
    );
  }

  if (fileAccess) {
    list.append(statusRow("ok", "Local files (file://) can be opened."));
  } else {
    const help = document.createElement("code");
    help.textContent = `brave://extensions/?id=${chrome.runtime.id}`;
    const row = statusRow("warn", "Local PDFs need “Allow access to file URLs”. Copy this address to fix it:", help);
    list.append(row);
  }
}

async function renderDocs() {
  const docs = (await listDocs()).sort((a, b) => (b.lastSaved || 0) - (a.lastSaved || 0));
  const tbody = $("docs");
  tbody.replaceChildren();

  $("docsTable").hidden = docs.length === 0;
  $("noDocs").hidden = docs.length > 0;
  $("clearAll").hidden = docs.length === 0;

  for (const doc of docs) {
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "name";
    name.textContent = doc.filename || doc.docId.slice(0, 12);
    const src = document.createElement("small");
    src.textContent = doc.sourceUrl || "";
    name.append(src);

    const handle = await getFileHandle(doc.docId);
    if (handle) {
      const synced = document.createElement("small");
      synced.className = "synced";
      synced.textContent = `synced to ${handle.name} on disk`;
      name.append(synced);
    }

    const size = document.createElement("td");
    size.textContent = formatBytes(doc.byteSize);

    const when = document.createElement("td");
    when.textContent = formatWhen(doc.lastSaved);

    const actions = document.createElement("td");
    const open = document.createElement("button");
    open.className = "link";
    open.textContent = "Open";
    open.addEventListener("click", () => {
      chrome.tabs.create({ url: `${chrome.runtime.getURL("src/viewer.html")}?file=${doc.sourceUrl}` });
    });
    const remove = document.createElement("button");
    remove.className = "link";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await forgetDoc(doc.docId);
      render();
    });
    actions.append(open, " ", remove);

    if (handle) {
      const unlink = document.createElement("button");
      unlink.className = "link";
      unlink.textContent = "Unlink";
      unlink.title = "Stop updating the file on disk. The annotated copy stays here.";
      unlink.addEventListener("click", async () => {
        await clearFileHandle(doc.docId);
        render();
      });
      actions.append(" ", unlink);
    }

    tr.append(name, size, when, actions);
    tbody.append(tr);
  }

  const { count, bytes, estimate } = await usage();
  const quota = estimate?.quota ? ` of about ${formatBytes(estimate.quota)} available` : "";
  $("usage").textContent = count
    ? `${count} document${count === 1 ? "" : "s"}, ${formatBytes(bytes)}${quota}.`
    : "";
}

async function renderSettings() {
  const { enabled = true, excludedDomains = [] } = await chrome.storage.local.get({
    enabled: true,
    excludedDomains: [],
  });
  $("enabled").checked = enabled;
  $("excluded").value = excludedDomains.join("\n");
}

function render() {
  renderStatus();
  renderDocs();
  renderSettings();
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  setTimeout(renderStatus, 150); // let the worker re-register rules first
});

$("saveExcluded").addEventListener("click", async () => {
  const domains = $("excluded")
    .value.split("\n")
    .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  await chrome.storage.local.set({ excludedDomains: domains });
  $("excluded").value = domains.join("\n");
  const btn = $("saveExcluded");
  btn.textContent = "Saved";
  setTimeout(() => (btn.textContent = "Save site list"), 1200);
  setTimeout(renderStatus, 150);
});

$("clearAll").addEventListener("click", async () => {
  await forgetAll();
  render();
});

render();
