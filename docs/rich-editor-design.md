# Notes rich editor — design contract

Date: 2026-10-09. Single source of truth for the 8 parallel work streams. Change it
only through the coordinator (note-mytasks-89).

## Problem

The Notes editor is a raw `<textarea>`: toolbar buttons insert Markdown markers
(`**`, `# `) and the user sees symbols, not formatting (bold is not bold until the
"Xem" tab). Users expect a word-processor: formatting visible while typing, case
changes, images, meeting recordings.

## Decisions

1. **WYSIWYG on `contenteditable`, Markdown stays the storage format.** `notes.content`
   remains Markdown: search vector (`notes.search`), snippets, checklist progress,
   export, backup and task-from-checklist all keep working unchanged.
2. **No new runtime dependency** (ARCHITECTURE.md: runtime deps are supabase-js +
   chart.js only). The editor, serializer and commands are our own code.
   Dev dependency `happy-dom` is installed for DOM unit tests (`// @vitest-environment happy-dom`).
3. **Modes**: `edit` (WYSIWYG, default) · `source` (the old Markdown textarea, for power
   users) · `preview` (read-only render). `split` is removed (WYSIWYG makes it moot);
   a stored `nm.notes.mode = 'split'` falls back to `edit`.
4. **Media** (images, audio) live in a private Storage bucket and are referenced from
   Markdown with the `nm-media:` scheme; the renderer resolves them to signed URLs.

## Markdown dialect (canonical serialization)

The serializer MUST output exactly this form, so `md → DOM → md` is stable (idempotent
after one pass) and diffs/autosave stay quiet.

| Element | Markdown | DOM in the editor |
|---|---|---|
| Paragraph | text lines; blocks separated by ONE blank line | `<p>` |
| Line break inside a paragraph | single `\n` | `<br>` |
| Headings | `# `, `## `, `### ` | `<h1>`–`<h3>` (h4–h6 read as h3) |
| Bold | `**x**` | `<strong>` |
| Italic | `_x_` (reads `*x*` too) | `<em>` |
| Underline | `++x++` | `<u>` |
| Strike | `~~x~~` | `<s>` (reads `<del>`) |
| Highlight | `==x==` | `<mark>` |
| Inline code | `` `x` `` | `<code>` |
| Link | `[text](https://…)` — http(s)/mailto only | `<a href>` |
| Bullet list | `- x` ; nesting = 2 spaces | `<ul><li>` |
| Ordered list | `1. x` (renumbered on save) | `<ol><li>` |
| Checklist | `- [ ] x` / `- [x] x` | `<ul data-type="task"><li data-checked="false\|true">` (checkbox is UI only, `contenteditable=false`) |
| Quote | `> x` | `<blockquote><p>` |
| Code block | ```` ``` ```` + optional lang | `<pre><code data-lang>` |
| Divider | `---` | `<hr>` |
| Table (GFM) | `\| a \| b \|` + `\|---\|---\|` | `<table><thead><tbody>` |
| Image | `![alt](nm-media:<path>)` or `![alt](https://…)`; optional width `![alt](nm-media:<path> "w=60")` (percent 10–100) | `<figure class="rt-img" contenteditable="false" data-src="nm-media:<path>" data-w="60"><img alt></figure>` |
| Audio | a paragraph that is ONLY `[label](nm-media:<path>.{webm,ogg,m4a,mp4,mp3,wav})` | `<figure class="rt-audio" contenteditable="false" data-src="nm-media:<path>"><audio controls></audio><figcaption>label</figcaption></figure>` |

Escaping: literal `* _ ~ = + \` [ ] # > |` that would otherwise be read as syntax are
backslash-escaped by the serializer; the reader un-escapes them. Unknown/unsafe HTML
never reaches the DOM: every text node goes through `esc()`; only tags built by our
code are emitted (same safety model as `noteEditor.js`).

Case transforms (UPPER / lower / Title / Sentence) change text only — no new syntax.

## Media: Storage bucket `note-media`

Migration `supabase/migrations/20261009001300_note_media_storage.sql`:
- private bucket `note-media`, `file_size_limit` 25 MB, allowed mime:
  `image/webp image/jpeg image/png image/gif audio/webm audio/ogg audio/mp4 audio/mpeg audio/wav`.
- object path: `<auth.uid()>/<note_id>/<uuid>.<ext>`; RLS on `storage.objects`:
  select/insert/update/delete only when `(storage.foldername(name))[1] = auth.uid()::text`.
- tests/db/harness.js already stubs `storage.*` (keep that stub).

Service `src/services/noteMedia.js` (only module that calls `supabase.storage`):
```js
export const MEDIA_SCHEME = 'nm-media:';
export const IMAGE_MAX_SOURCE = 15 * 1024 * 1024;   // before compression
export const AUDIO_MAX = 25 * 1024 * 1024;
isMediaUrl(url) -> boolean                           // starts with nm-media:
mediaPath(url) -> string|null                        // 'nm-media:a/b/c.webp' -> 'a/b/c.webp'
async uploadImage(noteId, file|Blob) -> { url: 'nm-media:…', width, height, bytes }
      // resizes to max 1600 px long side, re-encodes WebP (JPEG fallback), strips EXIF; GIF kept as-is if ≤ 5 MB
async uploadAudio(noteId, blob, { mimeType, durationSec }) -> { url, bytes }
async resolveMedia(url) -> string                    // signed URL (1 h), cached ~50 min; https URLs returned as-is
async hydrateMedia(rootEl)                           // fills src of [data-src^="nm-media:"] img/audio inside rootEl
async deleteNoteMedia(noteId)                        // removes <uid>/<noteId>/* (called on hard delete / empty trash)
async listNoteMedia(noteId) -> [{ name, bytes, url }]
async pruneUnused(noteId, markdown)                  // deletes files of this note no longer referenced in markdown
```
Errors are `AppError` (from `errors.js`): `invalid_input` (type/size), `storage_unavailable`
(bucket missing / storage down), `forbidden`, `network`, `server_error`.

## Editor API — `src/components/rich/`

### `markdown.js` (stream A1)
```js
mdToHtml(md, { editable = true } = {}) -> string      // editor DOM (table above); safe HTML string
htmlToMd(rootEl) -> string                            // canonical Markdown
normalizeMd(md) -> string                             // = htmlToMd(parse(mdToHtml(md)))
```
A1 also extends the preview renderer in `src/components/noteEditor.js` (`renderMarkdown`,
`inlineMd`, `plainText`, `snippet`, `noteStats`) to understand `++u++`, images and
audio (preview emits `<img data-src>` / `<audio data-src>`; the page calls `hydrateMedia`).
All other existing exports of `noteEditor.js` keep their names and behaviour.

### `commands.js` (stream A2) — pure DOM operations on an editor root + current Selection
```js
toggleMark(root, 'bold'|'italic'|'underline'|'strike'|'mark'|'code')
setBlock(root, 'p'|'h1'|'h2'|'h3'|'quote'|'code')    // toggles back to 'p' when already that block
toggleList(root, 'ul'|'ol'|'task')
indent(root) / outdent(root)                         // list nesting
setLink(root, url|null)                              // null = unlink
insertHr(root) ; insertTable(root, rows=3, cols=3)
transformCase(root, 'upper'|'lower'|'title'|'sentence')   // Vietnamese-aware (toLocaleUpperCase('vi'))
clearFormatting(root)                                 // remove marks + block → p
activeState(root) -> { bold, italic, underline, strike, mark, code, link, block: 'p'|'h1'|…, list: null|'ul'|'ol'|'task' }
findAll(root, query, { caseSensitive }) -> Range[] ; replaceAll(root, query, repl, opts) -> count
```
Commands keep the selection on the same text afterwards and never produce nested
duplicate marks (`<strong><strong>`), empty marks, or marks around block elements.

### `editor.js` (stream A3)
```js
createRichEditor(container, {
  markdown, readOnly = false, placeholder,
  onChange(markdown),           // debounced 300 ms, only when canonical md actually changed
  onSelectionChange(state),     // activeState() for toolbar highlighting
  uploadImage(file) -> Promise<{url}>,   // provided by the page (noteMedia.uploadImage bound to note id)
}) -> {
  getMarkdown(), setMarkdown(md), focus(), exec(cmd, ...args), state(),
  insertMarkdown(md),           // at caret, as blocks (used by recorder / templates)
  undo(), redo(), canUndo(), canRedo(),
  destroy(),
  el                           // the contenteditable element
}
```
Behaviour the editor owns: Enter/Backspace/Tab in lists & checklists (empty item exits
the list; Backspace at start of a heading/quote → paragraph), Markdown input rules while
typing (`# `, `## `, `### `, `- `, `* `, `1. `, `[] `/`[ ] `, `> `, ```` ``` ````, `---`,
`**x**`, `_x_`, `~~x~~`, `==x==`, `` `x` ``), keyboard shortcuts (Ctrl+B/I/U, Ctrl+Shift+X/H,
Ctrl+K, Ctrl+Z/Y, Ctrl+Shift+Z, Ctrl+Alt+1/2/3, Ctrl+Shift+7/8/9, Ctrl+Shift+U case
cycle, Ctrl+\\ clear formatting), checkbox click toggles `data-checked`, paste
(HTML from Word/Docs/web → sanitized to our dialect; plain text with Markdown → parsed;
images → `uploadImage`), drag-and-drop images, a "/" slash menu (Tiêu đề 1-3, Danh sách,
Danh sách số, Việc cần làm, Trích dẫn, Mã, Bảng, Đường kẻ, Ảnh, Ghi âm — the last two
emit `rt:request-image` / `rt:request-record` CustomEvents on the editor element), own
undo/redo stack (snapshots of canonical md + selection, coalesced typing), IME-safe
(no transforms during `compositionstart…end` — Vietnamese Telex/VNI).

### `images.js` (stream A5)
```js
pickImageFile() -> Promise<File|null>
bindImageUi(editor, { uploadImage, onError })   // figure toolbar: alt text, width 25/50/75/100 %, open full-size (lightbox), delete; upload placeholder with progress → replaced by final figure; failed upload removable
openLightbox(src, alt)
```

### `recorder.js` (stream A6)
```js
isRecordingSupported() -> boolean
isTranscriptionSupported() -> boolean            // webkitSpeechRecognition / SpeechRecognition
openRecorder({ noteId, uploadAudio, onInsert(markdown), onError }) -> { close() }
```
Recorder dialog: start / pause / resume / stop, elapsed timer, live level meter, max 60
min (auto-stop + warning at 55 min), mic permission errors in Vietnamese, optional live
Vietnamese transcription (`vi-VN`, continuous, interim results; opt-in toggle with a note
that the browser's speech service processes the audio), markers ("Đánh dấu" button adds a
timestamped bookmark), discard confirmation. On "Lưu vào ghi chú" it uploads the audio and
calls `onInsert` with:

```
## 🎙 Ghi âm cuộc họp — 14:05, 09/10/2026 (12:34)
[Ghi âm 12:34](nm-media:<path>.webm)
<!-- saved canonically with a blank line after the heading -->

**Bản chép lời**
- **[00:05]** …
- **[01:20]** ⭐ Đánh dấu: …
```
(the "Bản chép lời" section is omitted only when there are neither transcript lines nor bookmarks — bookmarks are kept even with transcription off). Audio: `audio/webm;codecs=opus`
(fallback `audio/mp4`), 32 kbps.

### Page integration (stream A7) — `src/pages/notes.js`, `src/css/pages/notes.css`, new `src/css/rich.css`
- Replace the body textarea with `createRichEditor` in `edit` mode; keep the textarea for
  `source` mode; `preview` uses `renderMarkdown` + `hydrateMedia`. Mode buttons: Soạn thảo ·
  Markdown · Xem. Switching modes never loses unsaved text.
- Autosave: `onChange(md)` → existing `queue({ content: md })`. Title/tags/kind unchanged.
- Toolbar (rebuild `TOOLS` in noteEditor.js — A7 owns `TOOLS` / `toolbarTpl`): H1 H2 H3 ·
  B I U S Highlight · Aa (case menu: CHỮ HOA, chữ thường, Viết Hoa Mỗi Từ, Viết hoa đầu câu) ·
  clear formatting · bullets, numbers, checklist, quote · code, link, table, divider · image,
  record · undo, redo · find & replace · "Việc" (task from line). Buttons show active state
  from `onSelectionChange`. Mobile: toolbar scrolls horizontally, 44 px targets.
- Find & replace bar (Ctrl+F / Ctrl+H inside the editor).
- Media lifecycle: `uploadImage`/`uploadAudio` bound to the open note id; `deleteNoteMedia`
  on permanent delete and empty trash; `pruneUnused` after a save that removed media
  (debounced, best effort).
- Existing features must keep working: checklist → tasks, task-from-line, templates (inserted
  through `setMarkdown`/`insertMarkdown`), word count footer, export/copy Markdown, read-only
  trash view, archive banner, keyboard shortcuts N and /.

## File ownership (parallel streams)

| Stream | Owns (create/edit) |
|---|---|
| A1 Markdown model | `src/components/rich/markdown.js`, renderer section of `src/components/noteEditor.js` (sections 1–2 only), `tests/rich/markdown.test.js` |
| A2 Commands | `src/components/rich/commands.js`, `tests/rich/commands.test.js` |
| A3 Editor core | `src/components/rich/editor.js`, `src/components/rich/slashMenu.js`, `tests/rich/editor.test.js` |
| A4 Media backend | `supabase/migrations/20261009001300_note_media_storage.sql`, `src/services/noteMedia.js`, `tests/integration/note_media.test.js`, `tests/db/note_media_storage.test.js`, `.github/workflows/ci.yml` (only: stop excluding `storage-api` in the integration job) |
| A5 Images UI | `src/components/rich/images.js`, `tests/rich/images.test.js` |
| A6 Recorder | `src/components/rich/recorder.js`, `tests/rich/recorder.test.js` |
| A7 Page integration | `src/pages/notes.js`, `src/css/pages/notes.css`, `src/css/rich.css` (+ its import), `TOOLS`/`toolbarTpl` + section 3–5 of `noteEditor.js`, `src/services/notes.js` (only if needed for media cleanup hooks) |
| A8 QA | Playwright E2E in the scratchpad (`…/scratchpad/e2e-editor/`), real Chromium against the LOCAL stack; reports bugs to the coordinator; may add `tests/rich/*.e2e-notes.md` test plans |

Rules for every stream: no git commands; no edits outside your files (ask the coordinator);
keep exports of existing modules stable; write files atomically (temp + rename) for files
Vite serves; Vietnamese UI copy; run `npx vitest run` before finishing; never touch the
hosted Supabase project (`.env`); local stack: `npx supabase status -o json`.

## Implementation status (2026-10-09)

Implemented by streams A1–A7, verified by A8 (real Chromium E2E, 142 cases, local stack).
Notes from integration:
- Toolbar: one row on desktop with a ResizeObserver "⋯ Thêm" overflow; block styles in the "Kiểu chữ" menu; phones keep a horizontally scrolling bar.
- Shortcuts in the WYSIWYG editor: Ctrl+E inline code, Ctrl+K link (the global palette ignores Ctrl+K inside `.rt[contenteditable]`).
- `rt:request-image` is cancelable; the page handles it (keeps the user activation) and `images.js` skips when `defaultPrevented`.
- Pasting Markdown with another note's `nm-media:` paths copies the files (`transformPastedMarkdown` → `noteMedia.copyNoteMedia`).
- Exported .md keeps `nm-media:` links (they only resolve inside the app).
