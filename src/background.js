// Service worker: takes over PDF navigations and points them at our viewer.
//
// Rules are registered at runtime rather than in a static rules.json because the
// redirect target needs chrome.runtime.getURL() and the extension ID is not known
// when the rules are authored.

const RULE_FILE_PDF = 1; // file:// URLs ending in .pdf
const RULE_PDF_CTYPE = 2; // http(s) served as application/pdf
const RULE_PDF_EXT = 3; // http(s) ending in .pdf but mislabelled content-type
const BYPASS_RULE_BASE = 1000; // session rules that let a URL through untouched

const DEFAULTS = {
  enabled: true,
  excludedDomains: [],
  // Set when the browser rejects response-header conditions and we fall back
  // to a non-blocking webRequest observer instead.
  ctypeFallback: false,
};

const viewerUrl = () => chrome.runtime.getURL("src/viewer.html");

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

function redirectAction() {
  // \0 is the whole matched URL. It is inserted raw, so the viewer parses
  // ?file= to the end of the query string rather than using URLSearchParams.
  return { type: "redirect", redirect: { regexSubstitution: `${viewerUrl()}?file=\\0` } };
}

// A PDF the server explicitly marked as a download should stay a download.
const NOT_AN_ATTACHMENT = {
  excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
};

function buildRules({ excludedDomains }) {
  const shared = { resourceTypes: ["main_frame"] };
  const excluded = excludedDomains.length ? { excludedRequestDomains: excludedDomains } : {};

  // Local files cannot carry a content-disposition header, so this one stays on
  // the fast request-time path.
  const filePdf = {
    id: RULE_FILE_PDF,
    priority: 1,
    action: redirectAction(),
    condition: {
      ...shared,
      // Spelled out per-character so it matches .PDF too, regardless of how the
      // browser defaults isUrlFilterCaseSensitive.
      regexFilter: "^file://[^#?]*\\.[pP][dD][fF]$",
    },
  };

  // The main web rule: catches every PDF regardless of what the URL looks like.
  const byContentType = {
    id: RULE_PDF_CTYPE,
    priority: 2,
    action: redirectAction(),
    condition: {
      ...shared,
      ...excluded,
      ...NOT_AN_ATTACHMENT,
      regexFilter: "^https?://",
      responseHeaders: [{ header: "content-type", values: ["application/pdf", "application/pdf;*"] }],
    },
  };

  // Backstop for servers that send a .pdf URL with the wrong content-type.
  // Response-stage too, so attachments are still excluded.
  const byExtension = {
    id: RULE_PDF_EXT,
    priority: 3,
    action: redirectAction(),
    condition: {
      ...shared,
      ...excluded,
      ...NOT_AN_ATTACHMENT,
      regexFilter: "^https?://[^#]*\\.[pP][dD][fF]([?].*)?$",
    },
  };

  return { filePdf, byContentType, byExtension };
}

async function clearDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const ids = existing.map((r) => r.id);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  }
}

const signature = (rules) =>
  JSON.stringify([...rules].sort((a, b) => a.id - b.id).map(({ id, priority, action, condition }) => ({ id, priority, action, condition })));

// onInstalled and the module-level call can fire at the same moment. Without
// this, the second one's addRules hits "rule with id N already exists" and gets
// mistaken for the browser refusing response-header conditions.
let syncQueue = Promise.resolve();

/**
 * Dynamic rules persist in the profile, and onStartup is not reliable for
 * command-line-loaded extensions, so this runs on every worker wake and does
 * nothing when the registered rules already match what we want.
 */
export function syncRules(options = {}) {
  const run = () => doSync(options);
  syncQueue = syncQueue.then(run, run);
  return syncQueue;
}

async function doSync({ force = false } = {}) {
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();

  if (!settings.enabled) {
    if (existing.length) await clearDynamicRules();
    await setCtypeFallback(false);
    updateBadge(false);
    return { enabled: false, ctypeFallback: false };
  }

  const { filePdf, byContentType, byExtension } = buildRules(settings);
  const wanted = [filePdf, byContentType, byExtension];

  if (!force && signature(existing) === signature(wanted)) {
    updateBadge(true);
    return { enabled: true, ctypeFallback: settings.ctypeFallback, unchanged: true };
  }

  let ctypeFallback = false;
  try {
    await replaceRules(wanted);
  } catch (err) {
    // Response-header conditions need Chrome 128+, and pairing them with a
    // redirect action is the part most likely to be refused. Everything else
    // deserves one clean retry before giving up the good path.
    console.warn("[pdf-annot] rule install failed, retrying:", err?.message || err);
    try {
      await replaceRules(wanted);
    } catch (err2) {
      console.warn("[pdf-annot] response-header rules unavailable, using webRequest fallback:", err2?.message || err2);
      ctypeFallback = true;
      // Without response-header matching we can only key off the URL, so the
      // webRequest observer below takes over content-type and attachment duty.
      await replaceRules([filePdf]);
    }
  }

  await setCtypeFallback(ctypeFallback);
  updateBadge(true);
  return { enabled: true, ctypeFallback };
}

async function replaceRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: rules,
  });
}

// --- content-type fallback -------------------------------------------------
// MV3 allows observational webRequest listeners; only the blocking form is
// restricted. We cannot cancel the response, so the native viewer may flash
// briefly before the tab is redirected.

function looksLikePdf(headers) {
  let isPdf = false;
  let isAttachment = false;
  for (const h of headers || []) {
    const name = h.name.toLowerCase();
    if (name === "content-type" && /^application\/pdf\b/i.test((h.value || "").trim())) isPdf = true;
    if (name === "content-disposition" && /^\s*attachment\b/i.test(h.value || "")) isAttachment = true;
  }
  return isPdf && !isAttachment;
}

async function onHeadersReceived(details) {
  if (details.tabId < 0 || details.type !== "main_frame") return;
  if (!looksLikePdf(details.responseHeaders)) return;

  const settings = await getSettings();
  if (!settings.enabled || !settings.ctypeFallback) return;
  if (isExcluded(details.url, settings.excludedDomains)) return;
  if (await isBypassed(details.url)) return;

  chrome.tabs.update(details.tabId, { url: `${viewerUrl()}?file=${details.url}` }).catch(() => {});
}

function isExcluded(url, domains) {
  if (!domains.length) return false;
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function setCtypeFallback(value) {
  return chrome.storage.local.set({ ctypeFallback: value });
}

function registerFallbackListener() {
  if (chrome.webRequest?.onHeadersReceived.hasListener(onHeadersReceived)) return;
  chrome.webRequest?.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["responseHeaders"]
  );
}

// --- one-shot bypass -------------------------------------------------------
// Used by the viewer's "Show original" / "Open in native viewer" escape hatch.

async function bypassOnce(url) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const id = BYPASS_RULE_BASE + (existing.length % 100);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 100,
        action: { type: "allow" },
        condition: { urlFilter: url, resourceTypes: ["main_frame"] },
      },
    ],
  });
  // Long enough for the navigation to start, short enough that the takeover
  // comes back on its own.
  setTimeout(() => {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }, 15000);
  return id;
}

async function isBypassed(url) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.condition?.urlFilter === url);
}

function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? "" : "off" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#888888" }).catch(() => {});
}

// --- wiring ----------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => syncRules({ force: true }));
chrome.runtime.onStartup.addListener(() => syncRules());

// The worker is torn down and revived constantly; syncRules is a no-op when the
// rules are already correct, so this is the reliable place to keep them fresh.
registerFallbackListener();
syncRules();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("enabled" in changes || "excludedDomains" in changes) syncRules();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "bypassOnce":
        sendResponse({ ok: true, id: await bypassOnce(msg.url) });
        break;
      case "syncRules":
        sendResponse({ ok: true, ...(await syncRules({ force: true })) });
        break;
      case "status":
        sendResponse({
          ok: true,
          settings: await getSettings(),
          rules: await chrome.declarativeNetRequest.getDynamicRules(),
          fileAccess: await chrome.extension.isAllowedFileSchemeAccess(),
        });
        break;
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // async response
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
