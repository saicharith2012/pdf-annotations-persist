# Persistent PDF Annotations

Highlight and doodle on PDFs in the browser and have the marks still be there
next time — because they are written **into the PDF file itself** as real PDF
annotation objects, not stored in a browser-only side channel.

Open the saved file in Acrobat, Firefox, or Brave's own built-in viewer and the
marks are there too.

## Why it replaces the built-in viewer

Brave's native PDF viewer has doodle and highlight tools, but nothing can
persist them:

- The viewer runs inside Chromium's internal PDF extension origin, which
  extensions are forbidden from scripting.
- The ink state lives in the PDFium plugin process, not in any DOM or storage an
  extension can reach.
- Google's own documentation confirms annotations survive only if you pick
  *Download → With your changes* or *Save to Drive*.

So this extension intercepts PDF navigations and opens its own viewer, built on
[PDF.js](https://mozilla.github.io/pdf.js/), whose annotation editor produces
genuine `/Highlight` and `/Ink` objects and can serialise them back into the file.

## Install

```bash
npm install
npm run build      # vendors pdf.js into vendor/
```

Then in Brave: **brave://extensions** → enable *Developer mode* → *Load
unpacked* → pick this folder.

To annotate PDFs stored on your computer, also switch on **Allow access to file
URLs** on the extension's card. The extension detects when this is off and says so.

## Using it

| | |
|---|---|
| Select | `Esc` |
| Highlight | `H` |
| Draw | `D` |
| Text box | `T` |
| Find | `Ctrl+F` |
| Save now | `Ctrl+S` |
| Next / previous page | `N` / `P` |

Saving is automatic — every change is written about a second after you stop.
The chip in the toolbar shows where things stand.

## Where the annotations live

Every change is saved automatically inside the browser (in OPFS), keyed by a
**SHA-256 hash of the document's contents** rather than its address. Annotations
therefore follow a document when it is renamed, moved, or fetched from a
different URL — annotate a PDF over `https://` and you will see the same marks
when you open the identical file from disk.

Web PDFs cannot be written back to their server, so the annotated copy is shown
automatically the next time you open that address, with a *Show the original*
escape hatch.

If the source document changes underneath an annotated copy, nothing is thrown
away: the extension offers a choice between the new version and your annotated one.

### Writing back to the file on disk

`Menu → Keep a file on disk in sync…` points the extension at a real file and
mirrors every auto-save into it. The pairing survives restarts (one click to
re-grant permission), and `Menu → Stop syncing this file` undoes it. The options
page marks synced documents and offers *Unlink*.

**This needs the File System Access API, which Brave ships switched off.** Turn on
*File System Access API* at `brave://flags/#file-system-access-api` and restart.
Chrome has it on already. Without it everything else still works, and
`Menu → Save a copy…` can still write a file wherever you choose.

## Notes

- Annotations are stored as an incremental update appended to the PDF, so the
  file grows a little with each editing session. That is ordinary PDF behaviour
  and keeps every save non-destructive.
- The two save destinations are independent: if the browser runs out of storage
  the file on disk is still updated, and vice versa. Running out of room gives a
  clear message rather than a silent failure.
- The extension requests persistent storage so the browser will not evict your
  annotations when disk space runs low.
- PDFs served as downloads (`Content-Disposition: attachment`) are left alone.
- Per-site opt-outs and a global off switch are on the options page.

## Layout

```
manifest.json          MV3
src/background.js      intercepts PDF navigations (declarativeNetRequest)
src/viewer.{html,js,css}  the viewer and its annotation toolbar
src/store.js           content hashing, OPFS bytes, IndexedDB metadata
src/disk.js            File System Access write-back
src/options.{html,js,css}  settings and saved-document manager
scripts/copy-pdfjs.mjs vendors pdf.js from node_modules
```
