// Ghi chú — three-pane notes workspace (library · list · editor).
// Desktop: 3 panes. ≤ 1100px: library becomes a drawer. ≤ 720px: one pane at a
// time (list ↔ editor) with a back button and a thumb-reachable format bar.
import { html, mount, on, raw, fragment } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, popMenu, closeMenu, tagInput, bindTagInput, SWATCHES, TASK_STATUS, dueLabel } from '../components/ui.js';
import { emptyState, errorState, loadingRows } from '../components/states.js';
import { openModal, confirmDialog, field, input } from '../components/modal.js';
import { openTaskForm } from '../components/taskForm.js';
import { toast } from '../components/toast.js';
import { setQuery, navigate } from '../core/router.js';
import { onDataChanged, notifyDataChanged, disposeOnAbort } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { today, dayOf, diffDays } from '../utils/date.js';
import { time as fmtTime, relDay, dateTime, num, monthLabel, ago } from '../utils/format.js';
import * as N from '../services/notes.js';
import { listTasks, getTask, createTask, OPEN_STATUSES } from '../services/tasks.js';
import * as E from '../components/noteEditor.js';
import * as M from '../services/noteMedia.js';
import { createRichEditor } from '../components/rich/editor.js';
import * as IMG from '../components/rich/images.js';
import * as REC from '../components/rich/recorder.js';
import { bindRowGestures, trackKeyboard } from './notesMobile.js';

const VIEWS = [
  { id: 'all', label: 'Tất cả ghi chú', icon: 'note' },
  { id: 'pinned', label: 'Đã ghim', icon: 'pin' },
  { id: 'checklist', label: 'Danh sách kiểm', icon: 'tasks' },
  { id: 'journal', label: 'Nhật ký', icon: 'calendar' },
  { id: 'meeting', label: 'Họp', icon: 'user' },
  { id: 'archived', label: 'Lưu trữ', icon: 'archive' },
  { id: 'trash', label: 'Thùng rác', icon: 'trash' },
];
const KIND_LABEL = { note: 'Ghi chú', checklist: 'Danh sách kiểm', journal: 'Nhật ký', meeting: 'Họp' };
const SORTS = [
  { id: 'updated', label: 'Sửa gần nhất' },
  { id: 'created', label: 'Ngày tạo' },
  { id: 'title', label: 'Tiêu đề A–Z' },
];
// edit = WYSIWYG (rich editor) · source = Markdown textarea · preview = read-only render.
const MODES = ['edit', 'source', 'preview'];
const MODE_LABEL = { edit: 'Soạn thảo', source: 'Markdown', preview: 'Xem' };
const CASES = [
  { id: 'upper', label: 'CHỮ HOA' },
  { id: 'lower', label: 'chữ thường' },
  { id: 'title', label: 'Viết Hoa Mỗi Từ' },
  { id: 'sentence', label: 'Viết hoa đầu câu' },
];
const PRUNE_DELAY = 60_000; // media no longer referenced is removed after a quiet minute (or on leave)
/** nm-media: references in Markdown (images and audio links). */
const mediaRefs = (md) => new Set(String(md || '').match(/nm-media:[^\s)"']+/g) || []);
const STATUS_TEXT = { saved: 'Đã lưu', dirty: 'Chưa lưu', saving: 'Đang lưu…', error: 'Lỗi lưu · thử lại' };
const LS_LAYOUT = 'nm.notes.layout';
const LS_MODE = 'nm.notes.mode';
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const mqPhone = window.matchMedia('(max-width: 720px)');

export default async function notesPage(root, { query, signal }) {
  const f = {
    view: VIEWS.some((v) => v.id === query.view) ? query.view : 'all',
    nb: query.nb || '',
    tag: query.tag || '',
    q: query.q || '',
    sort: SORTS.some((s) => s.id === query.sort) ? query.sort : 'updated',
    layout: store.get(LS_LAYOUT, 'list') === 'grid' ? 'grid' : 'list',
  };
  if (f.nb) f.view = 'nb';
  else if (f.tag) f.view = 'tag';
  // A stored 'split' (old editor) or anything unknown falls back to 'edit'.
  let mode = MODES.includes(store.get(LS_MODE)) ? store.get(LS_MODE) : 'edit';
  let editMode = mode === 'source' ? 'source' : 'edit'; // where Ctrl+/ returns from preview

  let notes = [];
  let overview = null;
  let loaded = false;
  let cur = null;          // note open in the editor (same object as in `notes` when listed)
  let pending = {};        // unsaved patch for `cur`
  let saveTimer = null;
  let saving = null;       // in-flight save promise (never rejects)
  let saveState = 'saved';
  let freshId = null;      // note created in this session — discarded if left blank
  let tagObs = null;
  let listToken = 0;
  const taskCache = new Map();
  const disposers = [];
  disposeOnAbort(signal, disposers); // released on navigation even if this page never returns
  let ed = null;           // rich editor of `cur` (null when read-only / no note)
  let edNote = null;       // the note `ed` was created for
  let edMd = '';           // last Markdown known to be inside `ed`
  let edSrc = null;        // the content last loaded into `ed` (before its normalisation)
  let edState = null;      // last activeState() from the editor
  let imgUi = null;        // bindImageUi() handle
  let recorder = null;     // open recorder dialog
  let findUi = null;       // find & replace state
  let savedRefs = new Set(); // media referenced by the last saved content of `cur`
  const pruneIds = new Set(); // note ids whose Storage folder may hold unreferenced media
  let uploads = 0;         // in-flight media uploads (no pruning meanwhile)
  let pruneTimer = null;
  disposers.push(() => { destroyEditor(); clearTimeout(pruneTimer); });

  mount(root, html`
    <div class="nb-page">
      ${pageHead({
        title: 'Ghi chú',
        actions: html`
          <button class="btn btn--ghost" data-act="new-blank" title="Mở ngay một trang trắng">${icon('edit')} Viết nhanh</button>
          <button class="btn btn--primary" data-act="templates" title="Chọn mẫu cho ghi chú mới (N)">${icon('plus')} Ghi chú mới <kbd class="nb-kbd">N</kbd></button>`,
      })}
      <div class="nb" data-pane="list" data-nav="closed" data-layout="${f.layout}">
        <aside class="nb-side" id="nb-side" data-side aria-label="Thư viện ghi chú"></aside>
        <div class="nb-scrim" data-act="nav-close" aria-hidden="true"></div>
        <section class="nb-list" aria-label="Danh sách ghi chú">
          <header class="nb-list__head" data-listhead></header>
          <div class="nb-search">
            <div class="input-group">${icon('search')}<input class="input" type="search" data-search placeholder="Tìm tiêu đề, nội dung, #thẻ…" value="${f.q}" aria-label="Tìm ghi chú" autocomplete="off" enterkeyhint="search" /></div>
          </div>
          <nav class="nb-chips" data-chips aria-label="Lọc nhanh"></nav>
          <div class="nb-list__scroll" data-items>${loadingRows(5)}</div>
        </section>
        <section class="nb-editor" data-editor aria-label="Trình soạn thảo ghi chú"></section>
      </div>
    </div>`);

  const $ = (s) => root.querySelector(s);
  const ws = $('.nb');
  const isPhone = () => mqPhone.matches;
  const byId = (id) => notes.find((x) => x.id === id);

  /* ================================================================
     Layout helpers
     ================================================================ */
  function fit() {
    // Sticky offsets follow the real top bar (it is shorter on phones than --topbar-h).
    const bar = document.querySelector('.topbar');
    if (bar) root.style.setProperty('--nb-top', Math.round(bar.getBoundingClientRect().height) + 'px');
    if (isPhone()) { ws.style.removeProperty('--nb-h'); return; }
    // offsetTop ignores transforms, so the entrance slide-in (which shifts the
    // workspace down while it plays) can't shorten the measured height.
    let top = 0;
    for (let el = ws; el; el = el.offsetParent) top += el.offsetTop;
    ws.style.setProperty('--nb-h', Math.max(520, Math.floor(window.innerHeight - top - 16)) + 'px');
  }
  // Phones: opening the editor pushes a same-URL history entry so the browser
  // Back button returns to the list instead of leaving the page. pushState with
  // an unchanged hash fires no hashchange, so the hash router is unaffected.
  let navPushed = false;
  let ignorePop = false;
  function showPane(p) {
    ws.dataset.pane = p;
    if (isPhone()) window.scrollTo({ top: 0 });
    // The editor may have been rendered while its pane was hidden (phones):
    // size the textareas again now that they have a layout.
    if (p === 'editor') { autosize($('.nb-title')); autosize($('.nb-text')); }
    if (p === 'editor' && isPhone() && !navPushed) {
      history.pushState({ nbEditor: true }, '', location.href);
      navPushed = true;
    } else if (p === 'list' && navPushed) {
      navPushed = false; // closed in-app (delete, empty trash…) → drop the extra entry
      ignorePop = true;
      history.back();
    }
  }
  const onPopState = async () => {
    if (ignorePop) { ignorePop = false; setQuery({ id: cur?.id || null }); return; }
    if (!navPushed || !root.isConnected || !location.hash.startsWith('#/notes')) return;
    navPushed = false;
    if (ws.dataset.pane !== 'editor') return;
    await closeEditor();
    if (cur) showPane('editor'); // user kept unsaved changes → re-arm Back
  };
  window.addEventListener('popstate', onPopState);
  disposers.push(() => window.removeEventListener('popstate', onPopState));
  const openNav = () => { ws.dataset.nav = 'open'; $('.nb-side__item[aria-current="true"], .nb-side__item')?.focus(); };
  const closeNav = () => { ws.dataset.nav = 'closed'; };

  function autosize(el) {
    if (!el) return;
    // Hidden (display:none pane) → scrollHeight is 0; keep the natural height.
    if (!el.getClientRects().length) { el.style.removeProperty('height'); return; }
    const sc = el.closest('[data-scroll]');
    const top = sc ? sc.scrollTop : window.scrollY;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    if (sc) sc.scrollTop = top;
    else if (window.scrollY !== top) window.scrollTo({ top });
  }

  /* ================================================================
     Filters / sorting / grouping
     ================================================================ */
  function filters() {
    const base = { search: f.q.trim() || undefined };
    switch (f.view) {
      case 'pinned': return { ...base, pinned: true };
      case 'checklist': case 'journal': case 'meeting': return { ...base, kind: f.view };
      case 'archived': return { ...base, archived: true };
      case 'trash': return { ...base, trashed: true };
      case 'nb': return { ...base, notebook: f.nb };
      case 'tag': return { ...base, tag: f.tag };
      default: return base;
    }
  }
  function viewLabel() {
    if (f.view === 'nb') return f.nb;
    if (f.view === 'tag') return `#${f.tag}`;
    return VIEWS.find((v) => v.id === f.view)?.label || 'Ghi chú';
  }
  const ts = (iso) => (iso ? new Date(iso).getTime() : 0);

  function sorted() {
    const rows = [...notes];
    if (f.view === 'trash') return rows.sort((a, b) => ts(b.trashed_at) - ts(a.trashed_at));
    const cmp = {
      updated: (a, b) => ts(b.updated_at) - ts(a.updated_at),
      created: (a, b) => ts(b.created_at) - ts(a.created_at),
      title: (a, b) => E.displayTitle(a).localeCompare(E.displayTitle(b), 'vi'),
    }[f.sort];
    return rows.sort((a, b) => (b.pinned - a.pinned) || cmp(a, b));
  }

  function groupsOf(rows) {
    if (f.view === 'trash' || f.sort === 'title') return [{ title: null, rows }];
    const key = f.sort === 'created' ? 'created_at' : 'updated_at';
    const t0 = today();
    const out = [];
    const pinnedFirst = f.view !== 'pinned';
    const pinned = pinnedFirst ? rows.filter((n) => n.pinned) : [];
    if (pinned.length) out.push({ title: 'Đã ghim', rows: pinned });
    let g = null;
    for (const n of rows) {
      if (pinnedFirst && n.pinned) continue;
      const d = dayOf(n[key]);
      const diff = diffDays(t0, d);
      const label = diff <= 0 ? 'Hôm nay' : diff === 1 ? 'Hôm qua' : diff < 7 ? '7 ngày qua' : diff < 30 ? '30 ngày qua' : monthLabel(d);
      if (!g || g.title !== label) { g = { title: label, rows: [] }; out.push(g); }
      g.rows.push(n);
    }
    return out;
  }

  function stamp(n) {
    const iso = f.view === 'trash' ? n.trashed_at : f.sort === 'created' ? n.created_at : n.updated_at;
    if (!iso) return '';
    const d = dayOf(iso);
    return diffDays(today(), d) === 0 ? fmtTime(iso) : relDay(d);
  }

  /* ================================================================
     Library (sidebar)
     ================================================================ */
  function renderSide(err) {
    const c = overview?.counts || {};
    const nbs = overview?.notebooks || [];
    const tags = overview?.tags || [];
    mount($('[data-side]'), html`
      <div class="nb-side__head">
        <span class="eyebrow">Thư viện</span>
        <button type="button" class="icon-btn icon-btn--sm nb-side__close" data-act="nav-close" aria-label="Đóng thư viện">${icon('x')}</button>
      </div>
      <nav class="nb-side__nav" aria-label="Chế độ xem">
        ${VIEWS.map((v) => html`
          ${v.id === 'archived' ? html`<span class="nb-side__rule" aria-hidden="true"></span>` : ''}
          <button type="button" class="nb-side__item" data-view="${v.id}" aria-current="${f.view === v.id}">
            ${icon(v.icon)}<span class="truncate">${v.label}</span><span class="nb-side__count">${c[v.id] ? num(c[v.id]) : ''}</span>
          </button>`)}
      </nav>
      <div class="nb-side__sect">
        <span class="eyebrow">Sổ ghi chú</span>
        <button type="button" class="icon-btn icon-btn--sm" data-act="new-notebook" aria-label="Tạo sổ mới" title="Tạo sổ mới">${icon('plus')}</button>
      </div>
      <nav class="nb-side__nav" aria-label="Sổ ghi chú">
        ${nbs.length
          ? nbs.map((nb) => html`
            <button type="button" class="nb-side__item" data-nb="${nb.name}" aria-current="${f.view === 'nb' && f.nb === nb.name}">
              ${icon('folder')}<span class="truncate">${nb.name}</span><span class="nb-side__count">${num(nb.count)}</span>
            </button>`)
          : html`<p class="nb-side__hint">Gom ghi chú theo dự án, khách hàng hay chủ đề.</p>`}
      </nav>
      <div class="nb-side__sect"><span class="eyebrow">Thẻ</span></div>
      <div class="nb-side__tags">
        ${tags.length
          ? tags.slice(0, 40).map((t) => html`<button type="button" class="tag ${f.view === 'tag' && f.tag === t.tag ? 'is-on' : ''}" data-tagf="${t.tag}" aria-pressed="${f.view === 'tag' && f.tag === t.tag}">${t.tag}<span class="nb-side__tagn">${t.count}</span></button>`)
          : html`<p class="nb-side__hint">Thêm thẻ cho ghi chú để lọc nhanh theo chủ đề.</p>`}
      </div>
      ${err ? html`<p class="nb-side__hint danger-text">Không tải được thư viện.</p>` : ''}`);
    renderChips();
  }

  /** Phones: the library's views and notebooks as one scrollable chip row (no drawer trip). */
  function renderChips() {
    const box = $('[data-chips]');
    if (!box) return;
    const c = overview?.counts || {};
    const count = (n) => (n ? html`<span>${num(n)}</span>` : '');
    mount(box, html`
      ${VIEWS.filter((v) => v.id !== 'trash' || c.trash).map((v) => html`
        <button type="button" class="nb-chip-f ${f.view === v.id ? 'is-on' : ''}" data-view="${v.id}" aria-pressed="${f.view === v.id}">${v.id === 'all' ? 'Tất cả' : v.label}${v.id === 'all' ? '' : count(c[v.id])}</button>`)}
      ${(overview?.notebooks || []).map((nb) => html`
        <button type="button" class="nb-chip-f ${f.view === 'nb' && f.nb === nb.name ? 'is-on' : ''}" data-nb="${nb.name}" aria-pressed="${f.view === 'nb' && f.nb === nb.name}">${icon('folder')}${nb.name}</button>`)}
      ${f.view === 'tag' ? html`<button type="button" class="nb-chip-f is-on" data-tagf="${f.tag}" aria-pressed="true" aria-label="Bỏ lọc thẻ ${f.tag}">#${f.tag}${icon('x')}</button>` : ''}`);
    // Keep the active chip in view without scrolling the page itself.
    const on = box.querySelector('.is-on');
    if (on) box.scrollLeft = Math.max(0, on.offsetLeft - (box.clientWidth - on.offsetWidth) / 2);
  }

  async function loadOverview() {
    try {
      overview = await N.noteOverview();
      renderSide();
    } catch (err) {
      renderSide(err);
    }
  }

  /* ================================================================
     List pane
     ================================================================ */
  function renderListHead() {
    const sortLabel = SORTS.find((s) => s.id === f.sort)?.label;
    mount($('[data-listhead]'), html`
      <button type="button" class="icon-btn nb-navbtn" data-act="nav-open" aria-label="Mở thư viện" aria-controls="nb-side">${icon('menu')}</button>
      <div class="nb-list__title">
        <span class="eyebrow">${f.view === 'nb' ? 'Sổ' : f.view === 'tag' ? 'Thẻ' : 'Thư viện'} · ${loaded ? num(notes.length) : '…'}</span>
        <h2 class="truncate" title="${viewLabel()}">${viewLabel()}</h2>
      </div>
      <div class="nb-list__tools">
        ${f.view !== 'trash' ? html`<button type="button" class="icon-btn" data-act="sort" aria-label="Sắp xếp: ${sortLabel}" title="Sắp xếp: ${sortLabel}" aria-haspopup="menu">${icon('filter')}</button>` : ''}
        <button type="button" class="icon-btn" data-act="layout" aria-label="${f.layout === 'grid' ? 'Xem dạng danh sách' : 'Xem dạng lưới'}" title="${f.layout === 'grid' ? 'Dạng danh sách' : 'Dạng lưới'}">${icon(f.layout === 'grid' ? 'list' : 'dashboard')}</button>
        ${f.view === 'nb' ? html`<button type="button" class="icon-btn" data-act="nb-menu" aria-label="Tùy chọn sổ" aria-haspopup="menu">${icon('more')}</button>` : ''}
        ${f.view === 'trash'
          ? (notes.length ? html`<button type="button" class="btn btn--danger-ghost btn--sm" data-act="empty-trash">${icon('trash')} Dọn sạch</button>` : '')
          : html`<button type="button" class="btn btn--primary btn--sm nb-list__new" data-act="templates" aria-label="Ghi chú mới" title="Ghi chú mới (N)">${icon('plus')}<span>Mới</span></button>`}
      </div>`);
  }

  function snippetTpl(n, max) {
    const q = f.q.trim().toLowerCase();
    const plain = E.snippet(n.content, n.title, 600);
    if (q) {
      const i = plain.toLowerCase().indexOf(q);
      if (i >= 0) {
        const s = Math.max(0, i - 36);
        return html`${s > 0 ? '…' : ''}${plain.slice(s, i)}<mark>${plain.slice(i, i + q.length)}</mark>${plain.slice(i + q.length, i + q.length + max)}`;
      }
    }
    if (!plain) return html`<span class="faint">Chưa có nội dung</span>`;
    return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
  }

  function itemTpl(n) {
    const p = E.checklistProgress(n.content);
    const active = cur?.id === n.id;
    return html`
      <button type="button" class="nb-item ${active ? 'is-active' : ''} ${n.color ? 'has-color' : ''}" data-id="${n.id}" ${active ? raw('aria-current="true"') : ''} style="${n.color ? `--c:${n.color}` : ''}">
        <span class="nb-item__top">
          <span class="nb-item__title">${E.displayTitle(n)}</span>
          ${n.pinned && f.view !== 'trash' ? html`<span class="nb-item__pin" title="Đã ghim">${icon('pin')}</span>` : ''}
        </span>
        <span class="nb-item__snip">${snippetTpl(n, f.layout === 'grid' ? 260 : 140)}</span>
        <span class="nb-item__meta">
          <time>${stamp(n)}</time>
          ${n.kind !== 'note' ? html`<span class="nb-item__kind" data-kind="${n.kind}">${KIND_LABEL[n.kind]}</span>` : ''}
          ${n.notebook && f.view !== 'nb' ? html`<span class="nb-item__nb">${icon('folder')}<span class="truncate">${n.notebook}</span></span>` : ''}
          ${p.total ? html`<span class="nb-item__prog ${p.done === p.total ? 'is-done' : ''}" title="Checklist ${p.done}/${p.total}">${icon('check')}${p.done}/${p.total}</span>` : ''}
          ${n.task_id ? html`<span class="nb-item__link" title="Có liên kết công việc">${icon('link')}</span>` : ''}
        </span>
      </button>`;
  }

  function emptyListTpl() {
    if (f.q.trim()) {
      return emptyState({ art: 'note', small: true, title: 'Không tìm thấy ghi chú', text: `Không có ghi chú nào khớp “${f.q.trim()}”.`, action: html`<button type="button" class="btn btn--sm" data-act="clear-search">Xóa tìm kiếm</button>` });
    }
    const map = {
      trash: ['Thùng rác trống', 'Ghi chú bị xóa sẽ nằm ở đây cho đến khi bạn dọn sạch.'],
      archived: ['Chưa có ghi chú lưu trữ', 'Lưu trữ những ghi chú đã xong việc để danh sách gọn gàng.'],
      pinned: ['Chưa ghim ghi chú nào', 'Ghim những ghi chú bạn mở hằng ngày để chúng luôn ở trên cùng.'],
    };
    const [title, text] = map[f.view] || ['Trang giấy còn trắng', 'Ghi lại ý tưởng, biên bản họp hay nhật ký — mọi thứ được lưu tự động.'];
    const canCreate = f.view !== 'trash' && f.view !== 'archived';
    return emptyState({
      art: 'note', small: true, title, text,
      action: canCreate ? html`<div class="row-wrap" style="justify-content:center"><button type="button" class="btn btn--primary btn--sm" data-act="new-blank">${icon('plus')} Ghi chú mới</button><button type="button" class="btn btn--sm" data-act="templates">Chọn mẫu</button></div>` : '',
    });
  }

  function renderList() {
    renderListHead();
    const box = $('[data-items]');
    if (!loaded) return;
    const rows = sorted();
    if (!rows.length) { mount(box, emptyListTpl()); return; }
    mount(box, html`
      ${f.view === 'trash' ? html`<p class="nb-trashnote">${icon('info')} Ghi chú trong thùng rác có thể khôi phục bất cứ lúc nào.</p>` : ''}
      ${groupsOf(rows).map((g) => html`
        ${g.title ? html`<div class="nb-group"><span>${g.title}</span><span class="nb-group__n">${g.rows.length}</span></div>` : ''}
        <div class="nb-items">${g.rows.map(itemTpl)}</div>`)}`);
  }

  function updateItem(n) {
    const el = $(`[data-items] [data-id="${n.id}"]`);
    if (el) el.replaceWith(fragment(itemTpl(n)));
  }
  function markActive() {
    root.querySelectorAll('.nb-item').forEach((el) => {
      const on = el.dataset.id === cur?.id;
      el.classList.toggle('is-active', on);
      if (on) el.setAttribute('aria-current', 'true'); else el.removeAttribute('aria-current');
    });
  }

  async function loadList() {
    const token = ++listToken;
    if (!loaded) mount($('[data-items]'), loadingRows(5));
    try {
      const rows = await N.listNotes(filters());
      if (token !== listToken) return;
      notes = rows.map((r) => (cur && r.id === cur.id ? cur : r));
      loaded = true;
      renderList();
    } catch (err) {
      if (token !== listToken) return;
      loaded = false;
      renderListHead();
      mount($('[data-items]'), html`<div class="nb-pad">${errorState(err)}</div>`);
    }
  }

  /* ================================================================
     Saving
     ================================================================ */
  function setStatus(s) {
    saveState = s;
    const el = $('[data-status]');
    if (!el) return;
    el.dataset.state = s;
    el.querySelector('span').textContent = STATUS_TEXT[s];
    el.title = s === 'error' ? 'Bấm để thử lưu lại' : s === 'saved' && cur ? `Lưu lúc ${fmtTime(cur.updated_at)}` : 'Ctrl+S để lưu ngay';
  }

  function queue(patch, { now = false } = {}) {
    if (!cur || cur.trashed_at) return;
    Object.assign(cur, patch);
    Object.assign(pending, patch);
    cur.updated_at = new Date().toISOString();
    if (saveState !== 'error') setStatus('dirty');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, now ? 0 : 800);
  }

  async function flush() {
    clearTimeout(saveTimer);
    syncEditor(); // the editor's onChange is debounced: take its latest Markdown now
    while (saving) await saving;
    if (!cur || !Object.keys(pending).length) return;
    const note = cur;
    const patch = pending;
    pending = {};
    const wasError = saveState === 'error';
    setStatus('saving');
    saving = (async () => {
      try {
        const saved = await N.updateNote(note.id, patch);
        note.updated_at = saved.updated_at;
        if ('content' in patch && cur === note) {
          const refs = mediaRefs(patch.content);
          if ([...savedRefs].some((u) => !refs.has(u))) schedulePrune(note.id); // a save that removed media
          savedRefs = refs;
        }
        if (cur === note && !Object.keys(pending).length) setStatus('saved');
        updateItem(note);
        renderFoot();
        if (['notebook', 'tags', 'kind', 'pinned'].some((k) => k in patch)) loadOverview();
      } catch (err) {
        if (cur === note) pending = { ...patch, ...pending };
        setStatus('error');
        if (!wasError) toast.error(err);
      } finally {
        saving = null;
      }
    })();
    await saving;
  }

  const isBlank = (n) => !String(n.title || '').trim() && !E.plainText(n.content).replace(/[☐•\s]/g, '')
    && !mediaRefs(n.content).size && !/!\[[^\]]*\]\(/.test(n.content || '') && !(n.tags || []).length && !n.task_id;

  /* ---------- media lifecycle (best effort: Storage problems never block notes) ---------- */
  function schedulePrune(id) {
    if (id) pruneIds.add(id);
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(() => runPrune(), PRUNE_DELAY);
  }
  /**
   * Remove Storage files a note no longer references (marked notes, or only `onlyId`).
   * Always decides on the content saved on the server (unsaved / discarded edits never
   * count). The note still open is skipped: Ctrl+Z may bring a removed image back, so
   * its files are pruned once the user leaves it (leaveCurrent / page exit).
   */
  async function runPrune(onlyId) {
    if (uploads > 0) { schedulePrune(); return; }
    for (const id of [...pruneIds]) {
      if (onlyId ? id !== onlyId : cur?.id === id) continue;
      try {
        const n = await N.getNote(id);
        pruneIds.delete(id);
        if (n) await M.pruneUnused?.(id, n.content);
      } catch { /* best effort */ }
    }
  }
  function dropMedia(ids) {
    for (const id of [].concat(ids)) {
      pruneIds.delete(id);
      Promise.resolve().then(() => M.deleteNoteMedia?.(id)).catch(() => {});
    }
  }
  /** Upload wrappers bound to a note: count in-flight uploads, mark the note for pruning. */
  function trackUpload(id, run) {
    uploads++;
    return Promise.resolve().then(run).finally(() => { uploads--; schedulePrune(id); });
  }
/** Markdown referencing other notes' nm-media: files → copies under note `id` (links whose copy failed stay unchanged). */
  function copyMediaInto(id, md) {
    if (!/nm-media:/.test(md || '')) return md;
    return trackUpload(id, () => M.copyNoteMedia(md, id)).catch((err) => {
      console.warn('[notes] copyNoteMedia', err);
      return typeof err?.details?.markdown === 'string' ? err.details.markdown : md; // keep the copies already made
    });
  }
  const uploadImageFor = (id) => (file, opts) => trackUpload(id, () => M.uploadImage(id, file, opts));
  // recorder.js may call uploadAudio(blob, opts) or the service form uploadAudio(noteId, blob, opts).
  const uploadAudioFor = (id) => (a, b, c) => trackUpload(id, () => (typeof a === 'string' ? M.uploadAudio(a, b, c) : M.uploadAudio(id, a, b)));
  function mediaError(err) {
    toast.error(err?.code === 'storage_unavailable' ? 'Kho lưu trữ ảnh/ghi âm chưa sẵn sàng. Hãy thử lại sau.' : err);
  }

  const confirmDropUnsaved = () => confirmDialog({
    title: 'Chưa lưu được thay đổi',
    message: 'Thay đổi gần nhất chưa được lưu (có thể do mất kết nối). Rời ghi chú này và bỏ thay đổi đó?',
    confirmLabel: 'Bỏ thay đổi',
  });

  /** Flush before an action removes note `id` from the list; false = keep it (unsaved edits kept). */
  async function settleBeforeDrop(id) {
    await flush();
    if (cur?.id !== id || !Object.keys(pending).length) return true;
    return !!(await confirmDropUnsaved());
  }

  /** Flush, then release the current note (discarding a brand-new blank one). */
  async function leaveCurrent() {
    if (!cur) return true;
    await flush();
    if (Object.keys(pending).length) {
      const ok = await confirmDropUnsaved();
      if (!ok) return false;
      pending = {};
    }
    const old = cur;
    if (freshId === old.id && isBlank(old)) {
      freshId = null;
      notes = notes.filter((x) => x.id !== old.id);
      $(`[data-items] [data-id="${old.id}"]`)?.remove();
      pruneIds.delete(old.id);
      N.deleteNote(old.id).then(() => { dropMedia(old.id); loadOverview(); }).catch(() => {});
    } else if (pruneIds.has(old.id)) {
      setTimeout(() => runPrune(old.id), 1500);
    }
    setStatus('saved');
    return true;
  }

  /* ================================================================
     Editor pane
     ================================================================ */
  const bodyMode = () => $('[data-body]')?.dataset.mode || null;
  const hydrate = (el) => { if (el) Promise.resolve().then(() => M.hydrateMedia?.(el)).catch(() => {}); };

  /** Read-only render + signed URLs for nm-media: images / audio. */
  function mountPreview() {
    const pv = $('[data-preview]');
    if (!pv || !cur) return;
    mount(pv, cur.content.trim() ? E.renderMarkdown(cur.content) : html`<p class="nb-preview__empty">Chưa có nội dung để xem trước.</p>`);
    if (cur.trashed_at) pv.querySelectorAll('input[type=checkbox]').forEach((c) => { c.disabled = true; });
    hydrate(pv);
  }

  function renderFoot() {
    const foot = $('[data-foot]');
    if (!foot || !cur) return;
    const s = E.noteStats(cur.content);
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    mount(foot, html`
      <span>${num(s.words)} từ</span>
      <span class="nb-foot__hide-sm">${num(s.chars)} ký tự</span>
      ${s.words ? html`<span>~${s.minutes} phút đọc</span>` : ''}
      ${s.total ? html`<span class="nb-foot__prog" title="Checklist hoàn thành ${pct}%"><span class="nb-foot__bar"><span style="width:${pct}%"></span></span>${s.done}/${s.total}</span>` : ''}
      <span class="grow"></span>
      <span class="nb-foot__hide-sm">Sửa ${ago(cur.updated_at)}</span>`);
  }

  function renderEmptyEditor() {
    const box = $('[data-editor]');
    box.dataset.empty = '1';
    delete box.dataset.mode;
    mount(box, html`
      <div class="nb-ed__empty">
        ${emptyState({
          art: 'note',
          title: 'Chọn một ghi chú',
          text: '…hoặc mở một trang mới. Mọi thay đổi được lưu tự động.',
          action: html`<div class="row-wrap" style="justify-content:center"><button type="button" class="btn btn--primary" data-act="new-blank">${icon('plus')} Ghi chú mới</button><button type="button" class="btn" data-act="templates">${icon('sparkle')} Chọn mẫu</button></div>`,
        })}
        <dl class="nb-keys" aria-label="Phím tắt">
          <div><dt><kbd>N</kbd></dt><dd>Ghi chú mới</dd></div>
          <div><dt><kbd>/</kbd></dt><dd>Tìm ghi chú · trong bài: chèn khối</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>B</kbd> · <kbd>I</kbd> · <kbd>U</kbd></dt><dd>Đậm · nghiêng · gạch chân</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>8</kbd> / <kbd>9</kbd></dt><dd>Danh sách · việc cần làm</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>F</kbd> · <kbd>H</kbd></dt><dd>Tìm · thay thế</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>/</kbd></dt><dd>Soạn thảo ↔ Xem</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>S</kbd></dt><dd>Lưu ngay</dd></div>
        </dl>
      </div>`);
  }

  function renderEditor({ focus } = {}) {
    tagObs?.disconnect();
    tagObs = null;
    E.closePopover();
    closeFind({ restore: false });
    destroyEditor();
    if (!cur) return renderEmptyEditor();
    const box = $('[data-editor]');
    delete box.dataset.empty;
    const n = cur;
    const ro = Boolean(n.trashed_at);
    const m = ro ? 'preview' : mode;
    box.dataset.mode = m;
    mount(box, html`
      <header class="nb-ed__bar">
        <button type="button" class="icon-btn nb-back" data-act="back" aria-label="Quay lại danh sách">${icon('chevronLeft')}</button>
        <button type="button" class="nb-crumb" data-act="notebook" ${ro ? raw('disabled') : ''} aria-haspopup="dialog" title="Chuyển sổ ghi chú">
          ${icon('folder')}<span class="truncate" data-nbname>${n.notebook || 'Không có sổ'}</span>${ro ? '' : icon('chevronDown')}
        </button>
        ${ro ? '' : html`<button type="button" class="nb-status" data-status data-act="save-now" data-state="saved" aria-live="polite"><i aria-hidden="true"></i><span>${STATUS_TEXT.saved}</span></button>`}
        <span class="grow"></span>
        ${ro ? '' : html`
          <div class="segmented nb-mode" role="group" aria-label="Chế độ soạn thảo">
            <button type="button" data-mode="edit" aria-pressed="${m === 'edit'}" aria-label="${MODE_LABEL.edit}" title="Soạn thảo trực quan">${icon('edit')}<span>${MODE_LABEL.edit}</span></button>
            <button type="button" data-mode="source" aria-pressed="${m === 'source'}" aria-label="${MODE_LABEL.source}" title="Sửa trực tiếp mã Markdown"><b class="nb-mode__md" aria-hidden="true">M↓</b><span>${MODE_LABEL.source}</span></button>
            <button type="button" data-mode="preview" aria-pressed="${m === 'preview'}" aria-label="${MODE_LABEL.preview}" title="Xem (Ctrl+/)">${icon('eye')}<span>${MODE_LABEL.preview}</span></button>
          </div>
          <button type="button" class="icon-btn nb-modebtn" data-act="mode-toggle" aria-label="Chuyển giữa Xem và Soạn thảo" title="Xem ↔ Soạn thảo">${icon('eye')}${icon('edit')}</button>
          <button type="button" class="icon-btn nb-pinbtn" data-act="pin" aria-pressed="${n.pinned}" aria-label="${n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}" title="${n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}">${icon('pin')}</button>
          <button type="button" class="icon-btn" data-act="color" aria-label="Nhãn màu" title="Nhãn màu" aria-haspopup="dialog"><span class="nb-swatch ${n.color ? 'has-color' : ''}" data-swatch style="${n.color ? `--c:${n.color}` : ''}"></span></button>`}
        <button type="button" class="icon-btn" data-act="more" aria-label="Thêm thao tác" aria-haspopup="menu">${icon('more')}</button>
      </header>
      ${ro
        ? html`<div class="nb-banner nb-banner--danger">${icon('trash')}<span>Ghi chú đang ở Thùng rác · chỉ xem.</span><span class="grow"></span><button type="button" class="btn btn--sm" data-act="restore">${icon('undo')} Khôi phục</button><button type="button" class="btn btn--sm btn--danger-ghost" data-act="destroy">Xóa vĩnh viễn</button></div>`
        : n.archived ? html`<div class="nb-banner">${icon('archive')}<span>Ghi chú đã lưu trữ.</span><span class="grow"></span><button type="button" class="btn btn--sm" data-act="archive">Bỏ lưu trữ</button></div>` : ''}
      ${ro ? '' : html`
        <div class="nb-tools" role="toolbar" aria-label="Định dạng văn bản" aria-orientation="horizontal" data-tools>${E.toolbarTpl()}</div>
        <div class="nb-find" data-find role="search" aria-label="Tìm và thay thế trong ghi chú" hidden></div>`}
      <div class="nb-ed__scroll" data-scroll>
        <div class="nb-ed__sheet" style="${n.color ? `--c:${n.color}` : ''}">
          <div class="nb-ed__eyebrow">
            ${ro
              ? html`<span class="eyebrow">${KIND_LABEL[n.kind]}</span>`
              : html`<label class="nb-kind" title="Loại ghi chú"><span class="sr-only">Loại ghi chú</span><select data-field="kind">${Object.entries(KIND_LABEL).map(([v, l]) => html`<option value="${v}" ${v === n.kind ? raw('selected') : ''}>${l}</option>`)}</select>${icon('chevronDown')}</label>`}
            <span class="nb-ed__date">Tạo ${dateTime(n.created_at)}</span>
          </div>
          <textarea class="nb-title" data-field="title" rows="1" maxlength="200" placeholder="Tiêu đề" aria-label="Tiêu đề ghi chú" ${ro ? raw('readonly') : ''}>${n.title}</textarea>
          <div class="nb-meta" data-meta>
            ${ro
              ? (n.tags || []).map((t) => html`<span class="tag">${t}</span>`)
              : tagInput('tags', n.tags || [], 'nb-tag-input')}
            <span class="nb-taskslot" data-taskslot></span>
          </div>
          <div class="nb-body" data-body data-mode="${m}">
            ${ro ? '' : html`
              <div class="nb-rich" data-rich></div>
              <textarea class="nb-text" data-field="content" maxlength="${N.NOTE_LIMITS.content}" spellcheck="true" placeholder="Markdown: # Tiêu đề · **đậm** · _nghiêng_ · ++gạch chân++ · - [ ] việc cần làm · [liên kết](https://…)" aria-label="Nội dung ghi chú (mã Markdown)">${n.content}</textarea>`}
            <article class="nb-preview md" data-preview></article>
          </div>
        </div>
      </div>
      <footer class="nb-ed__foot" data-foot></footer>`);

    if (!ro) {
      bindTags();
      createEditor(n);
      // Record button only where MediaRecorder works (the slash item still opens the dialog, which explains why).
      if (REC.isRecordingSupported && !REC.isRecordingSupported()) $('[data-tool="record"]')?.setAttribute('hidden', '');
    }
    setStatus(Object.keys(pending).length ? 'dirty' : 'saved');
    autosize($('.nb-title'));
    if (m === 'source') autosize($('.nb-text'));
    if (m === 'preview') mountPreview();
    paintTools(m === 'edit' ? safeState() : null);
    watchTools();
    renderFoot();
    renderTaskSlot();
    $('[data-scroll]').scrollTop = 0;

    if (focus === 'title') {
      const t = $('.nb-title');
      t?.focus();
      t?.setSelectionRange(t.value.length, t.value.length);
    } else if (focus === 'body') focusBody();
  }

  function focusBody() {
    const m = bodyMode();
    if (m === 'edit' && ed) { ed.focus(); return; }
    if (m !== 'source') return;
    const ta = $('.nb-text');
    if (!ta) return;
    const mm = ta.value.match(/(\*\* |- \[ \] |- |1\. |> )(?=\n|$)/);
    const at = mm ? mm.index + mm[0].length : ta.value.length;
    ta.focus();
    ta.setSelectionRange(at, at);
  }

  /* ---------- rich editor lifecycle ---------- */
  function safeState() {
    if (!ed) return null;
    try { return ed.state(); } catch { return null; }
  }

  function createEditor(n) {
    const host = $('[data-rich]');
    if (!host) return;
    const note = n;
    try {
      ed = createRichEditor(host, {
        markdown: n.content,
        placeholder: 'Bắt đầu viết… Gõ “/” để chèn tiêu đề, danh sách, bảng, ảnh hay ghi âm.',
        onChange: (md) => onEditorChange(note, md),
        onSelectionChange: (st) => {
          if (cur !== note || ed == null) return;
          edState = st;
          paintTools(st);
        },
        uploadImage: uploadImageFor(note.id),
        // paste / drop of image files → images.js placeholders with progress
        onImageFiles: (files, o) => (imgUi?.insert ? imgUi.insert(files, o) : null),
        // Pasted Markdown that points at another note's files gets its own copies.
        transformPastedMarkdown: (md) => copyMediaInto(note.id, md),
      });
    } catch (err) {
      // The page stays usable in Markdown mode if the editor cannot start.
      console.error(err);
      ed = null;
      return;
    }
    edNote = note;
    edSrc = n.content;
    try { edMd = ed.getMarkdown(); } catch { edMd = n.content; }
    ed.el.classList.add('rt-content');
    if (!ed.el.hasAttribute('aria-label')) ed.el.setAttribute('aria-label', 'Nội dung ghi chú');
    ed.el.addEventListener('rt:request-image', onRequestImage);
    ed.el.addEventListener('rt:request-record', onRequestRecord);
    ed.el.addEventListener('rt:request-link', onRequestLink);
    ed.el.addEventListener('rt:render', onRender);
    try {
      // images.js toasts its own upload errors.
      imgUi = IMG.bindImageUi?.(ed, { uploadImage: uploadImageFor(note.id), onError: () => {} }) || null;
    } catch (err) { console.error(err); imgUi = null; }
    hydrate(ed.el);
  }

  function destroyEditor() {
    syncEditor();
    try { imgUi?.destroy?.(); } catch { /* ignore */ }
    imgUi = null;
    if (ed) {
      ed.el?.removeEventListener('rt:request-image', onRequestImage);
      ed.el?.removeEventListener('rt:request-record', onRequestRecord);
      ed.el?.removeEventListener('rt:request-link', onRequestLink);
      ed.el?.removeEventListener('rt:render', onRender);
      try { ed.destroy(); } catch (err) { console.error(err); }
    }
    ed = null;
    edNote = null;
    edMd = '';
    edSrc = null;
    edState = null;
    lastRange = null;
  }

  function onEditorChange(note, md) {
    if (cur !== note || !ed || edNote !== note || bodyMode() !== 'edit') return;
    edMd = md;
    if (md !== cur.content) {
      queue({ content: md });
      refreshFoot();
    }
    paintHistory();
    if (findUi) refindSoon();
  }

  /** Copy the editor's current Markdown into `cur` (onChange is debounced). */
  function syncEditor() {
    if (!ed || !cur || edNote !== cur || cur.trashed_at || bodyMode() !== 'edit') return;
    let md;
    try { md = ed.getMarkdown(); } catch { return; }
    if (md === edMd) return;
    edMd = md;
    if (md !== cur.content) queue({ content: md });
  }

  /** Make the (hidden) editor show cur.content if it changed elsewhere (source / preview checkboxes). */
  function loadEditorFromContent() {
    if (!ed || edNote !== cur) return;
    if (cur.content === edMd || cur.content === edSrc) return;
    try {
      ed.setMarkdown(cur.content, { history: 'push' }); // Ctrl+Z can undo edits made in Markdown mode
      edSrc = cur.content;
      edMd = ed.getMarkdown();
    } catch (err) { console.error(err); }
    hydrate(ed.el);
  }

  // Remember the last caret/selection inside the editor, so toolbar popovers (link,
  // case menu) can put it back after focus moved to their inputs.
  let lastRange = null;
  const onSelChange = () => {
    if (!ed) return;
    const sel = document.getSelection();
    if (sel?.rangeCount && ed.el.contains(sel.anchorNode)) lastRange = sel.getRangeAt(0).cloneRange();
  };
  document.addEventListener('selectionchange', onSelChange);
  disposers.push(() => document.removeEventListener('selectionchange', onSelChange));

  function restoreSel() {
    if (!ed) return;
    const sel = document.getSelection();
    if (sel?.rangeCount && ed.el.contains(sel.anchorNode) && document.activeElement === ed.el) return;
    if (lastRange && ed.el.contains(lastRange.startContainer)) {
      ed.el.focus({ preventScroll: true });
      sel.removeAllRanges();
      sel.addRange(lastRange);
    } else ed.focus();
  }

  /* ---------- modes ---------- */
  function setMode(m, { focus = false } = {}) {
    if (!MODES.includes(m) || !cur || cur.trashed_at) return;
    const prev = bodyMode();
    // Never lose text: take the outgoing surface's latest Markdown first.
    if (prev === 'edit') syncEditor();
    else if (prev === 'source') {
      const ta = $('.nb-text');
      if (ta && ta.value !== cur.content) queue({ content: ta.value });
    }
    mode = m;
    if (m !== 'preview') editMode = m;
    store.set(LS_MODE, m);
    $('[data-editor]').dataset.mode = m;
    const body = $('[data-body]');
    if (body) body.dataset.mode = m;
    root.querySelectorAll('.nb-mode [data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    if (m === 'preview') closeFind({ restore: false });
    if (m === 'edit') {
      loadEditorFromContent();
      paintTools(safeState());
      if (focus) ed?.focus();
    } else if (m === 'source') {
      const ta = $('.nb-text');
      if (ta) {
        if (ta.value !== cur.content) ta.value = cur.content;
        autosize(ta);
        if (focus) ta.focus();
      }
      paintTools(null);
    } else {
      mountPreview();
    }
    if (findUi) runFind();
  }

  /* ---------- toolbar ---------- */
  const PRESSED = {
    bold: (s) => s.bold, italic: (s) => s.italic, underline: (s) => s.underline, strike: (s) => s.strike,
    mark: (s) => s.mark, code: (s) => s.code || s.block === 'code', link: (s) => s.link,
    h1: (s) => s.block === 'h1', h2: (s) => s.block === 'h2', h3: (s) => s.block === 'h3', quote: (s) => s.block === 'quote',
    ul: (s) => s.list === 'ul', ol: (s) => s.list === 'ol', task: (s) => s.list === 'task',
  };
  function paintTools(st) {
    const bar = $('[data-tools]');
    if (!bar) return;
    const s = st || {};
    bar.querySelectorAll('[data-tool][aria-pressed]').forEach((b) => {
      const v = String(Boolean(PRESSED[b.dataset.tool]?.(s)));
      if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
    });
    const blk = bar.querySelector('[data-tool="block"]');
    if (blk) {
      const name = st ? BLOCK_LABEL[s.block] || BLOCK_LABEL.p : bodyMode() === 'source' ? BLOCK_LABEL[currentBlock()] : BLOCK_LABEL.p;
      const lab = blk.querySelector('[data-block-label]');
      if (lab && lab.textContent !== name) lab.textContent = name;
      blk.setAttribute('aria-label', `Kiểu chữ: ${name}`);
    }
    bar.querySelector('[data-tool="more"]')?.classList.toggle('has-active', overflowTools().some((b) => b.getAttribute('aria-pressed') === 'true'));
    paintHistory();
  }
  function paintHistory() {
    const bar = $('[data-tools]');
    if (!bar) return;
    const rich = bodyMode() === 'edit' && ed;
    const set = (id, can) => {
      const b = bar.querySelector(`[data-tool="${id}"]`);
      if (b && b.disabled === can) b.disabled = !can;
    };
    // Source mode uses the textarea's native undo stack (always offered).
    set('undo', rich ? Boolean(ed.canUndo?.() ?? true) : true);
    set('redo', rich ? Boolean(ed.canRedo?.() ?? true) : true);
  }

  function exec(cmd, ...args) {
    if (!ed) return;
    restoreSel();
    try { ed.exec(cmd, ...args); } catch (err) { console.error(err); }
    paintTools(safeState());
  }

  function runTool(id, el) {
    if (!cur || cur.trashed_at) return;
    if (id === 'more') return openMoreTools(el);
    if (id === 'line-task') return taskFromLine();
    if (id === 'find') return openFind({ replace: Boolean(findUi?.replace) });
    if (id === 'block') {
      if (bodyMode() === 'preview') setMode(editMode);
      return openBlockMenu(el);
    }
    if (bodyMode() === 'preview') setMode(editMode);
    if (bodyMode() === 'source') return sourceTool(id, el);
    if (!ed) return;
    switch (id) {
      case 'bold': case 'italic': case 'underline': case 'strike': case 'mark': case 'code':
        return exec('toggleMark', id);
      case 'h1': case 'h2': case 'h3': case 'quote':
        return exec('setBlock', id);
      case 'ul': case 'ol': case 'task':
        return exec('toggleList', id);
      case 'hr': return exec('insertHr');
      case 'table': return exec('insertTable', 3, 3);
      case 'clear': return exec('clearFormatting');
      case 'case': return openCaseMenu(el, (c) => exec('transformCase', c));
      case 'link': return openLinkPopover(el);
      case 'undo': ed.undo(); return paintTools(safeState());
      case 'redo': ed.redo(); return paintTools(safeState());
      case 'image': return insertImage();
      case 'record': return startRecording();
    }
  }

  /* ---------- "Kiểu chữ" (block style) menu and "⋯ Thêm" overflow menu ---------- */
  const BLOCK_LABEL = Object.fromEntries(E.BLOCK_STYLES.map((b) => [b.id, b.label]));

  /** role=menu popover; items: [{ id, label, checked?: bool|null, radio?, disabled? }]. */
  function toolMenu(anchor, items, { label, onPick }) {
    anchor.setAttribute('aria-expanded', 'true');
    const pop = E.openPopover(anchor, html`
      <div class="nb-tmenu" role="menu" aria-label="${label}">
        ${items.map((it) => html`<button type="button" class="nb-tmenu__item" data-pick="${it.id}"
          role="${it.checked == null ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox'}"
          ${it.checked == null ? '' : raw(`aria-checked="${it.checked}"`)} ${it.disabled ? raw('disabled') : ''} tabindex="-1">
          <span class="nb-tmenu__ico" aria-hidden="true">${it.glyph || ''}</span><span class="nb-tmenu__label">${it.label}</span>${it.keys ? html`<kbd>${it.keys}</kbd>` : ''}</button>`)}
      </div>`, {
      label,
      className: 'nb-pop--menu',
      onOpen: (el, close) => {
        const btns = () => [...el.querySelectorAll('.nb-tmenu__item:not([disabled])')];
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-pick]');
          if (!b || b.disabled) return;
          close();
          onPick(b.dataset.pick);
        });
        el.addEventListener('keydown', (e) => {
          const list = btns();
          const i = list.indexOf(document.activeElement);
          const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length]?.focus(); };
          if (e.key === 'ArrowDown') go(i + 1);
          else if (e.key === 'ArrowUp') go(i - 1);
          else if (e.key === 'Home') go(0);
          else if (e.key === 'End') go(list.length - 1);
          else if (e.key === 'Tab') { e.preventDefault(); close(); anchor.focus(); }
        });
        (el.querySelector('[aria-checked="true"]:not([disabled])') || btns()[0])?.focus();
      },
    });
    // aria-expanded back to false whenever the popover goes away
    const mo = new MutationObserver(() => { if (!pop.el.isConnected) { anchor.setAttribute('aria-expanded', 'false'); mo.disconnect(); } });
    mo.observe(document.body, { childList: true });
    return pop;
  }

  function currentBlock() {
    if (bodyMode() === 'source') {
      const ta = $('.nb-text');
      const t = ta ? E.currentLine(ta).text : '';
      const h = t.match(/^\s{0,3}(#{1,3})\s/);
      return h ? `h${h[1].length}` : /^\s{0,3}>/.test(t) ? 'quote' : 'p';
    }
    return (safeState() || edState || {}).block || 'p';
  }

  function openBlockMenu(anchor) {
    const curB = currentBlock();
    toolMenu(anchor, E.BLOCK_STYLES.map((b) => ({ ...b, checked: b.id === curB, radio: true })), {
      label: 'Kiểu chữ',
      onPick: (id) => applyBlock(id),
    });
  }

  function applyBlock(id) {
    if (!cur || cur.trashed_at) return;
    if (bodyMode() === 'preview') setMode(editMode);
    if (bodyMode() === 'source') {
      const ta = $('.nb-text');
      if (!ta) return;
      if (id === 'code') return E.insertBlock(ta, 'code');
      if (id !== 'p') return currentBlock() === id ? undefined : E.toggleLines(ta, id);
      const v = ta.value;
      const ls = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const { text } = E.currentLine(ta);
      const plain = text.replace(/^\s{0,3}(#{1,6}\s+|>\s?)/, '');
      if (plain !== text) E.replaceRange(ta, ls, ls + text.length, plain, ls + plain.length);
      return;
    }
    if (!ed) return;
    const st = safeState() || {};
    if (id === 'p') { if (st.block && st.block !== 'p') exec('setBlock', st.block); return; } // toggling the current block returns to p
    if (st.block === id) return;
    exec('setBlock', id);
  }

  /** Tools currently moved into the overflow menu, in toolbar order. */
  function overflowTools() {
    const bar = $('[data-tools]');
    return bar ? [...bar.querySelectorAll('[data-tool][data-overflow]')] : [];
  }

  function openMoreTools(anchor) {
    const items = overflowTools().map((b) => ({
      id: b.dataset.tool,
      label: b.getAttribute('aria-label'),
      glyph: raw(b.innerHTML),
      checked: b.hasAttribute('aria-pressed') ? b.getAttribute('aria-pressed') === 'true' : null,
      disabled: b.disabled,
      keys: (b.title.match(/\(([^)]+)\)$/) || [])[1] || '',
    }));
    if (!items.length) return;
    toolMenu(anchor, items, { label: 'Thêm công cụ', onPick: (id) => runTool(id, anchor) });
  }

  /**
   * Priority+ toolbar (wide screens): one row; when it overflows, tools move into
   * "⋯ Thêm", highest data-prio first (then right-most first). Phones keep the
   * horizontally scrolling bar with every tool.
   */
  function fitTools() {
    const bar = $('[data-tools]');
    if (!bar || !bar.getClientRects().length) return;
    const more = bar.querySelector('[data-tool="more"]');
    const tools = [...bar.querySelectorAll('[data-tool]')].filter((b) => b !== more);
    tools.forEach((b) => b.removeAttribute('data-overflow'));
    if (more) more.hidden = true;
    const fixSeps = () => {
      let seenBtn = false;
      let lastSep = null;
      for (const n of bar.children) {
        if (n.classList.contains('nb-tools__sep')) {
          n.hidden = !seenBtn; // no leading / doubled separators
          if (seenBtn) lastSep = n;
          seenBtn = false;
        } else if (n.getClientRects().length && n !== more) { seenBtn = true; lastSep = null; }
      }
      if (lastSep) lastSep.hidden = true; // nothing after it
    };
    fixSeps();
    if (isPhone() || !more || bar.scrollWidth <= bar.clientWidth + 1) return;
    more.hidden = false;
    const order = tools
      .map((b, i) => ({ b, i, p: Number(b.dataset.prio) || 0 }))
      .filter((x) => x.p > 0 && x.b.getClientRects().length)
      .sort((a, z) => z.p - a.p || z.i - a.i);
    const moved = [];
    for (const { b } of order) {
      if (bar.scrollWidth <= bar.clientWidth + 1) break;
      moved.push(b);
      b.setAttribute('data-overflow', '');
      if (b.tabIndex === 0) { b.tabIndex = -1; bar.querySelector('[data-tool]:not([data-overflow]):not([hidden])')?.setAttribute('tabindex', '0'); }
      fixSeps();
    }
    // Second pass: give back the slack — a smaller, lower-priority tool may still fit.
    for (const b of moved.reverse()) {
      b.removeAttribute('data-overflow');
      fixSeps();
      if (bar.scrollWidth > bar.clientWidth + 1) { b.setAttribute('data-overflow', ''); fixSeps(); }
    }
    const pressed = overflowTools().some((b) => b.getAttribute('aria-pressed') === 'true');
    more.classList.toggle('has-active', pressed); // a hidden active format still shows on "⋯"
  }
  let toolsRO = null;
  function watchTools() {
    toolsRO?.disconnect();
    const bar = $('[data-tools]');
    if (!bar || typeof ResizeObserver !== 'function') { fitTools(); return; }
    let raf = 0;
    toolsRO = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(fitTools); });
    toolsRO.observe(bar);
    fitTools();
  }
  disposers.push(() => toolsRO?.disconnect());
  const onPhoneChange = () => fitTools();
  mqPhone.addEventListener('change', onPhoneChange);
  disposers.push(() => mqPhone.removeEventListener('change', onPhoneChange));

  function openCaseMenu(anchor, apply) {
    popMenu(anchor, CASES.map((c) => ({ label: c.label, onClick: () => apply(c.id) })), { align: 'center' });
  }

  /** Normalise a typed link: bare domains get https://; only http(s)/mailto are accepted. */
  function normalizeUrl(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (/^(https?:\/\/|mailto:)/i.test(s)) return s;
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(s)) return `mailto:${s}`;
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) return `https://${s}`;
    return null;
  }

  function openLinkPopover(anchor, req = null) {
    const st = safeState() || {};
    let href = req?.href || st.href || '';
    const sel = document.getSelection();
    const a = sel?.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.('a[href]');
    if (!href && a && ed?.el.contains(a)) href = a.getAttribute('href') || '';
    const apply = (url) => {
      if (req?.apply) { req.apply(url); paintTools(safeState()); } else exec('setLink', url);
    };
    E.openPopover(anchor, html`
      <form class="nb-linkpop" novalidate>
        <div class="nb-pop__head">${st.link ? 'Sửa liên kết' : 'Chèn liên kết'}</div>
        <input class="input input--sm" type="url" inputmode="url" value="${href}" placeholder="https://… hoặc email" aria-label="Địa chỉ liên kết" autocomplete="off" spellcheck="false" />
        <p class="nb-linkpop__err" role="alert" hidden>Chỉ hỗ trợ liên kết http(s) hoặc email.</p>
        <div class="nb-linkpop__acts">
          ${st.link || href ? html`<button type="button" class="btn btn--sm btn--danger-ghost" data-unlink>Bỏ liên kết</button>` : ''}
          <span class="grow"></span>
          <button type="submit" class="btn btn--sm btn--primary">Áp dụng</button>
        </div>
      </form>`, {
      label: 'Liên kết',
      onOpen: (el, close) => {
        const inp = el.querySelector('input');
        el.querySelector('[data-unlink]')?.addEventListener('click', () => { close(); apply(null); });
        el.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const url = normalizeUrl(inp.value);
          if (url === '') { close(); apply(null); return; }
          if (!url) { el.querySelector('.nb-linkpop__err').hidden = false; inp.focus(); return; }
          close();
          apply(url);
        });
        inp.focus();
        inp.select();
      },
    });
  }

  /* ---------- images & recordings ---------- */
  // preventDefault: images.js also listens; only one file picker may open (it needs the user activation).
  const onRequestImage = (e) => { e.preventDefault(); insertImage(); };
  const onRequestRecord = () => startRecording();
  const onRender = () => { if (ed) hydrate(ed.el); };
  // Ctrl+K inside the editor: our popover instead of window.prompt.
  const onRequestLink = (e) => {
    e.preventDefault();
    const anchor = $('[data-tool="link"]');
    openLinkPopover(anchor && anchor.getClientRects().length ? anchor : ed.el, e.detail);
  };

  async function insertImage() {
    if (!cur || cur.trashed_at) return;
    const note = cur;
    const range = lastRange;
    const ta = $('.nb-text');
    const at = ta ? [ta.selectionStart, ta.selectionEnd, ta.value] : null;
    let files = [];
    try {
      files = IMG.pickImageFiles ? await IMG.pickImageFiles({ multiple: true }) : [await IMG.pickImageFile()].filter(Boolean);
    } catch (err) { mediaError(err); }
    if (!files?.length || cur !== note) return;
    if (bodyMode() === 'edit' && ed) {
      if (range && ed.el.contains(range.startContainer)) lastRange = range;
      restoreSel();
      if (imgUi?.insert) imgUi.insert(files);
      else IMG.insertImages?.(ed, files, { uploadImage: uploadImageFor(note.id), onError: (err) => mediaError(err) });
      return;
    }
    // Markdown mode: upload, then insert the references on their own lines at the caret.
    toast('Đang tải ảnh lên…');
    const lines = [];
    for (const file of files) {
      try {
        const { url } = await uploadImageFor(note.id)(file);
        const alt = String(file.name || '').replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '').slice(0, 120);
        lines.push(`![${alt}](${url})`);
      } catch (err) { mediaError(err); }
    }
    if (lines.length && cur === note && bodyMode() === 'source') insertSourceBlock(lines.join('\n\n'), at);
  }

  /**
   * `at` = [start, end, value] captured before an await → those offsets while the text is
   * unchanged; once the user typed meanwhile, the current caret (collapsed, so nothing
   * typed is replaced) or the end of the text when the textarea lost focus.
   */
  function sourceRange(ta, at) {
    if (!at) return [ta.selectionStart, ta.selectionEnd];
    if (at.length < 3 || ta.value === at[2]) return [at[0], at[1]];
    const p = document.activeElement === ta ? ta.selectionEnd : ta.value.length;
    return [p, p];
  }

  /** Markdown mode: insert a block at the caret (or `at` [start, end, value]) with blank lines around it. */
  function insertSourceBlock(md, at) {
    const ta = $('.nb-text');
    if (!ta) return;
    const v = ta.value;
    const [s, e] = sourceRange(ta, at);
    const before = v.slice(0, s);
    const pre = !before.trim() ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    const after = v.slice(e);
    const post = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
    const text = pre + md.trim() + post;
    E.replaceRange(ta, s, e, text, s + text.length);
  }

  const appendBlock = (content, md) => {
    const base = String(content || '').replace(/\s+$/, '');
    return `${base ? `${base}\n\n` : ''}${md.trim()}\n`;
  };

  function startRecording() {
    if (!cur || cur.trashed_at) return;
    if (typeof REC.openRecorder !== 'function') return;
    const note = cur;
    try { recorder?.close?.(); } catch { /* already closed */ }
    try {
      recorder = REC.openRecorder({
        noteId: note.id,
        uploadAudio: uploadAudioFor(note.id),
        onInsert: (md) => insertRecording(note, md),
        onError: (err) => console.warn('[recorder]', err), // the dialog shows every error itself
      });
    } catch (err) { mediaError(err); }
  }

  async function insertRecording(note, md) {
    if (!md) return;
    if (cur === note && !note.trashed_at) {
      const m = bodyMode();
      if (m === 'edit' && ed) {
        restoreSel();
        try { ed.insertMarkdown(md); } catch (err) { console.error(err); }
        syncEditor();
        hydrate(ed.el);
        renderFoot();
      } else if (m === 'source') {
        insertSourceBlock(md);
      } else {
        queue({ content: appendBlock(cur.content, md) }, { now: true });
        mountPreview();
        renderFoot();
      }
      return flush();
    }
    // The note is no longer open: append the recording to what is saved.
    try {
      const fresh = await N.getNote(note.id);
      if (!fresh) return;
      const content = appendBlock(fresh.content, md);
      const saved = await N.updateNote(note.id, { content });
      Object.assign(note, { content, updated_at: saved.updated_at });
      updateItem(note);
      toast(`Đã thêm bản ghi âm vào “${E.displayTitle(note)}”.`);
    } catch (err) { toast.error(err); }
  }

  /* ---------- Markdown (source) mode tools ---------- */
  function caseText(s, kind) {
    const lower = s.toLocaleLowerCase('vi');
    if (kind === 'upper') return s.toLocaleUpperCase('vi');
    if (kind === 'lower') return lower;
    if (kind === 'title') return lower.replace(/(^|[\s([{“"'\-/])(\p{L})/gu, (_, p, c) => p + c.toLocaleUpperCase('vi'));
    return lower.replace(/(^\s*|[.!?…]\s+|\n\s*(?:[-*+>]\s+|\d+[.)]\s+|#{1,6}\s+|\[[ xX]\]\s+)*)(\p{L})/gu, (_, p, c) => p + c.toLocaleUpperCase('vi'));
  }
  function sourceCase(ta, kind) {
    const { selectionStart: s, selectionEnd: e } = ta;
    let a = s, b = e;
    if (a === b) { // no selection: the word at the caret
      const v = ta.value;
      while (a > 0 && /[\p{L}\p{N}]/u.test(v[a - 1])) a--;
      while (b < v.length && /[\p{L}\p{N}]/u.test(v[b])) b++;
    }
    const text = caseText(ta.value.slice(a, b), kind);
    E.replaceRange(ta, a, b, text, s === e ? s : a, s === e ? s : a + text.length);
  }
  function sourceClear(ta) {
    const { selectionStart: s, selectionEnd: e } = ta;
    const { text } = E.currentLine(ta);
    if (s === e) {
      const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
      const plain = text.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d{1,9}[.)]\s+)/, '').replace(/(\*\*|__|~~|==|\+\+|`)/g, '');
      E.replaceRange(ta, ls, ls + text.length, plain, ls + plain.length);
      return;
    }
    const sel = ta.value.slice(s, e).replace(/(\*\*|__|~~|==|\+\+|`)/g, '').replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, '$1$2');
    E.replaceRange(ta, s, e, sel, s, s + sel.length);
  }
  const TABLE_MD = '| Cột 1 | Cột 2 | Cột 3 |\n|---|---|---|\n|  |  |  |\n|  |  |  |';

  function sourceTool(id, el) {
    const ta = $('.nb-text');
    if (!ta) return;
    switch (id) {
      case 'bold': return E.wrapSelection(ta, '**');
      case 'italic': return E.wrapSelection(ta, '_');
      case 'underline': return E.wrapSelection(ta, '++');
      case 'strike': return E.wrapSelection(ta, '~~');
      case 'mark': return E.wrapSelection(ta, '==');
      case 'code': return ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? E.insertBlock(ta, 'code') : E.wrapSelection(ta, '`', '`', 'mã');
      case 'link': return E.insertLink(ta);
      case 'hr': return E.insertBlock(ta, 'hr');
      case 'table': return insertSourceBlock(TABLE_MD);
      case 'h1': case 'h2': case 'h3': case 'ul': case 'ol': case 'task': case 'quote': return E.toggleLines(ta, id);
      case 'clear': return sourceClear(ta);
      case 'case': return openCaseMenu(el, (c) => { ta.focus(); sourceCase(ta, c); });
      case 'undo': case 'redo':
        ta.focus();
        try { document.execCommand(id); } catch { /* not supported */ }
        return;
      case 'image': return insertImage();
      case 'record': return startRecording();
    }
  }

  /* ---------- find & replace ---------- */
  const hasHighlights = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  function clearHighlights() {
    if (!hasHighlights()) return;
    CSS.highlights.delete('nb-find');
    CSS.highlights.delete('nb-find-cur');
  }

  function findTpl() {
    return html`
      <div class="nb-find__row">
        <label class="nb-find__field">${icon('search')}<span class="sr-only">Tìm</span>
          <input type="text" data-find-q placeholder="Tìm trong ghi chú" autocomplete="off" spellcheck="false" />
          <span class="nb-find__count" data-find-count aria-live="polite"></span>
        </label>
        <button type="button" class="nb-find__btn nb-find__case" data-find-act="case" aria-pressed="false" title="Phân biệt hoa / thường" aria-label="Phân biệt hoa thường">Aa</button>
        <button type="button" class="nb-find__btn nb-find__up" data-find-act="prev" title="Kết quả trước (Shift+Enter)" aria-label="Kết quả trước">${icon('chevronDown')}</button>
        <button type="button" class="nb-find__btn" data-find-act="next" title="Kết quả sau (Enter)" aria-label="Kết quả sau">${icon('chevronDown')}</button>
        <button type="button" class="nb-find__btn nb-find__more" data-find-act="toggle" aria-expanded="false" title="Thay thế (Ctrl+H)" aria-label="Hiện ô thay thế">${icon('repeat')}</button>
        <button type="button" class="nb-find__btn" data-find-act="close" title="Đóng (Esc)" aria-label="Đóng tìm kiếm">${icon('x')}</button>
      </div>
      <div class="nb-find__row nb-find__rep" data-find-rep hidden>
        <label class="nb-find__field"><span class="sr-only">Thay bằng</span>
          <input type="text" data-find-r placeholder="Thay bằng…" autocomplete="off" spellcheck="false" />
        </label>
        <button type="button" class="btn btn--sm" data-find-act="replace">Thay</button>
        <button type="button" class="btn btn--sm" data-find-act="replace-all">Thay tất cả</button>
      </div>`;
  }

  function selectedText() {
    if (bodyMode() === 'source') {
      const ta = $('.nb-text');
      return ta && document.activeElement === ta ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
    }
    const sel = document.getSelection();
    return ed && sel?.rangeCount && ed.el.contains(sel.anchorNode) ? sel.toString() : '';
  }

  function openFind({ replace = false } = {}) {
    if (!cur || cur.trashed_at) return;
    if (bodyMode() === 'preview') setMode(editMode);
    const bar = $('[data-find]');
    if (!bar) return;
    const pre = selectedText();
    if (!findUi) {
      mount(bar, findTpl());
      findUi = { matches: [], idx: -1, cs: false, replace: false };
    }
    findUi.replace = replace || findUi.replace;
    bar.hidden = false;
    bar.querySelector('[data-find-rep]').hidden = !findUi.replace;
    bar.querySelector('[data-find-act="toggle"]').setAttribute('aria-expanded', String(findUi.replace));
    const q = bar.querySelector('[data-find-q]');
    if (pre && !pre.includes('\n') && pre.length <= 120) q.value = pre;
    runFind();
    (replace && q.value ? bar.querySelector('[data-find-r]') : q).focus();
    q.select?.();
  }

  function closeFind({ restore = true } = {}) {
    clearHighlights();
    const bar = $('[data-find]');
    const was = Boolean(findUi);
    findUi = null;
    if (bar) { bar.hidden = true; mount(bar, ''); }
    if (restore && was) {
      if (bodyMode() === 'edit') restoreSel();
      else if (bodyMode() === 'source') $('.nb-text')?.focus();
    }
  }

  /** Recompute matches for the current surface; keeps the current index when possible. */
  function runFind({ keep = false } = {}) {
    if (!findUi) return;
    const bar = $('[data-find]');
    const q = bar?.querySelector('[data-find-q]')?.value || '';
    const m = bodyMode();
    let matches = [];
    if (q) {
      if (m === 'edit' && ed) {
        try { matches = ed.exec('findAll', q, { caseSensitive: findUi.cs }) || []; } catch { matches = []; }
      } else if (m === 'source') {
        const ta = $('.nb-text');
        const hay = findUi.cs ? ta.value : ta.value.toLocaleLowerCase('vi');
        const needle = findUi.cs ? q : q.toLocaleLowerCase('vi');
        for (let i = hay.indexOf(needle); i >= 0 && matches.length < 5000; i = hay.indexOf(needle, i + needle.length)) {
          matches.push({ start: i, end: i + q.length });
        }
      }
    }
    findUi.matches = matches;
    if (!matches.length) findUi.idx = -1;
    else if (keep && findUi.idx >= 0) findUi.idx = Math.min(findUi.idx, matches.length - 1);
    else findUi.idx = 0;
    paintFind();
  }
  const refindSoon = debounce(() => runFind({ keep: true }), 200);

  function paintFind({ reveal = false } = {}) {
    if (!findUi) return;
    const bar = $('[data-find]');
    const { matches, idx } = findUi;
    const q = bar?.querySelector('[data-find-q]')?.value || '';
    const count = bar?.querySelector('[data-find-count]');
    if (count) count.textContent = !q ? '' : matches.length ? `${num(idx + 1)}/${num(matches.length)}` : 'Không thấy';
    bar?.classList.toggle('is-miss', Boolean(q) && !matches.length);
    bar?.querySelectorAll('[data-find-act="prev"],[data-find-act="next"],[data-find-act="replace"],[data-find-act="replace-all"]').forEach((b) => { b.disabled = !matches.length; });
    clearHighlights();
    if (!matches.length) return;
    const curM = matches[idx];
    if (bodyMode() === 'edit') {
      if (hasHighlights()) {
        CSS.highlights.set('nb-find', new Highlight(...matches.filter((r) => r !== curM)));
        CSS.highlights.set('nb-find-cur', new Highlight(curM));
      }
      if (reveal) {
        const el = curM.startContainer.nodeType === 1 ? curM.startContainer : curM.startContainer.parentElement;
        el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      }
    } else if (bodyMode() === 'source' && reveal) {
      const ta = $('.nb-text');
      ta.setSelectionRange(curM.start, curM.end);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28;
      const line = ta.value.slice(0, curM.start).split('\n').length - 1;
      const y = ta.getBoundingClientRect().top + line * lh;
      const sc = $('[data-scroll]');
      const scrolls = sc && sc.scrollHeight > sc.clientHeight && getComputedStyle(sc).overflowY !== 'visible';
      const view = scrolls ? sc.getBoundingClientRect() : { top: 0, height: window.innerHeight };
      const delta = y - (view.top + view.height / 2);
      if (Math.abs(delta) > view.height / 3) (scrolls ? sc : window).scrollBy({ top: delta, behavior: 'smooth' });
    }
  }

  function gotoMatch(dir) {
    if (!findUi?.matches.length) return;
    const n = findUi.matches.length;
    findUi.idx = (findUi.idx + dir + n) % n;
    paintFind({ reveal: true });
  }

  function replaceOne() {
    if (!findUi?.matches.length) return;
    const bar = $('[data-find]');
    const repl = bar.querySelector('[data-find-r]').value;
    const curM = findUi.matches[findUi.idx];
    if (bodyMode() === 'source') {
      E.replaceRange($('.nb-text'), curM.start, curM.end, repl);
    } else if (ed) {
      try { ed.exec('replaceRange', curM, repl); } catch (err) { console.error(err); }
      syncEditor();
    }
    runFind({ keep: true });
    paintFind({ reveal: true });
    bar.querySelector('[data-find-r]').focus();
  }

  function replaceEvery() {
    if (!findUi?.matches.length) return;
    const bar = $('[data-find]');
    const q = bar.querySelector('[data-find-q]').value;
    const repl = bar.querySelector('[data-find-r]').value;
    let count = 0;
    if (bodyMode() === 'source') {
      const ta = $('.nb-text');
      const parts = [];
      let last = 0;
      for (const mm of findUi.matches) { parts.push(ta.value.slice(last, mm.start), repl); last = mm.end; count++; }
      parts.push(ta.value.slice(last));
      E.replaceRange(ta, 0, ta.value.length, parts.join(''), 0);
    } else if (ed) {
      try { count = Number(ed.exec('replaceAll', q, repl, { caseSensitive: findUi.cs })) || 0; } catch (err) { console.error(err); count = 0; }
      syncEditor();
    }
    runFind();
    toast(count ? `Đã thay ${num(count)} chỗ.` : 'Không có gì để thay.');
  }

  disposers.push(on(root, 'click', '[data-find-act]', (e, el) => {
    switch (el.dataset.findAct) {
      case 'next': return gotoMatch(1);
      case 'prev': return gotoMatch(-1);
      case 'close': return closeFind();
      case 'replace': return replaceOne();
      case 'replace-all': return replaceEvery();
      case 'case':
        findUi.cs = !findUi.cs;
        el.setAttribute('aria-pressed', String(findUi.cs));
        return runFind();
      case 'toggle': {
        findUi.replace = !findUi.replace;
        el.setAttribute('aria-expanded', String(findUi.replace));
        const rep = $('[data-find-rep]');
        rep.hidden = !findUi.replace;
        if (findUi.replace) rep.querySelector('input').focus();
      }
    }
  }));
  disposers.push(on(root, 'input', '[data-find-q]', () => runFind()));
  disposers.push(on(root, 'keydown', '[data-find]', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); return; }
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (e.target.matches('[data-find-r]')) {
      if (e.ctrlKey || e.metaKey) replaceEvery(); else replaceOne();
    } else gotoMatch(e.shiftKey ? -1 : 1);
  }));

  function bindTags() {
    const meta = $('[data-meta]');
    const box = meta?.querySelector('[data-tag-input]');
    if (!box) return;
    bindTagInput(meta);
    const hidden = box.querySelector('input[type=hidden]');
    tagObs = new MutationObserver(() => {
      let tags;
      try { tags = JSON.parse(hidden.value || '[]'); } catch { return; }
      if (cur && JSON.stringify(tags) !== JSON.stringify(cur.tags || [])) queue({ tags }, { now: true });
    });
    tagObs.observe(box, { childList: true });
  }

  async function renderTaskSlot() {
    const slot = $('[data-taskslot]');
    if (!slot || !cur) return;
    const id = cur.task_id;
    const ro = Boolean(cur.trashed_at);
    if (!id) {
      mount(slot, ro ? '' : html`<button type="button" class="nb-chip nb-chip--ghost" data-act="link-task">${icon('link')} Liên kết công việc</button>`);
      return;
    }
    if (!taskCache.has(id)) {
      mount(slot, html`<span class="nb-chip">${icon('tasks')} Đang tải công việc…</span>`);
      try { taskCache.set(id, (await getTask(id)) || null); } catch { taskCache.set(id, null); }
      if (cur?.task_id !== id) return;
    }
    const t = taskCache.get(id);
    if (!t) {
      mount(slot, html`<span class="nb-chip">${icon('alert')} Công việc không còn tồn tại${ro ? '' : html`<button type="button" class="nb-chip__x" data-act="unlink-task" aria-label="Bỏ liên kết">${icon('x')}</button>`}</span>`);
      return;
    }
    mount(slot, html`
      <span class="nb-chip nb-chip--task" data-status="${t.status}">
        <button type="button" class="nb-chip__main" data-act="open-task" title="Mở trong Công việc">${icon('tasks')}<span class="truncate">${t.title}</span><span class="nb-chip__st">${TASK_STATUS[t.status]?.label || t.status}</span></button>
        ${ro ? '' : html`<button type="button" class="nb-chip__x" data-act="unlink-task" aria-label="Bỏ liên kết công việc" title="Bỏ liên kết">${icon('x')}</button>`}
      </span>`);
  }

  const refreshFoot = debounce(renderFoot, 300);

  /* ================================================================
     Open / create / close
     ================================================================ */
  async function openNote(id, { focus } = {}) {
    if (cur?.id === id) { showPane('editor'); return; }
    if (!(await leaveCurrent())) return;
    let n = byId(id);
    if (!n) {
      try { n = await N.getNote(id); } catch (err) { toast.error(err); return; }
      if (!n) {
        toast.error('Không tìm thấy ghi chú (có thể đã bị xóa).');
        setQuery({ id: null });
        return;
      }
    }
    cur = n;
    pending = {};
    savedRefs = mediaRefs(n.content);
    setQuery({ id: n.id });
    markActive();
    showPane('editor'); // first, so the textareas have a layout to size / focus
    renderEditor({ focus });
  }

  async function closeEditor() {
    if (!(await leaveCurrent())) return;
    cur = null;
    setQuery({ id: null });
    markActive();
    renderEditor();
    showPane('list');
  }

  /** After removing `id` from the list: open its neighbour on wide screens, else close. */
  function dropFromList(id) {
    const rows = sorted();
    const i = rows.findIndex((x) => x.id === id);
    notes = notes.filter((x) => x.id !== id);
    if (cur?.id === id) {
      clearTimeout(saveTimer);
      pending = {};
      cur = null;
      const next = !isPhone() ? (rows[i + 1] || rows[i - 1]) : null;
      renderList();
      if (next && next.id !== id) openNote(next.id);
      else { setQuery({ id: null }); renderEditor(); showPane('list'); }
    } else renderList();
  }

  function viewAccepts(n) {
    if (f.q.trim()) return false;
    switch (f.view) {
      case 'trash': case 'archived': return false;
      case 'pinned': return n.pinned;
      case 'checklist': case 'journal': case 'meeting': return n.kind === f.view;
      case 'nb': return n.notebook === f.nb;
      case 'tag': return (n.tags || []).includes(f.tag);
      default: return true;
    }
  }

  async function createFrom(tpl, extra = {}) {
    if (!(await leaveCurrent())) return;
    const kindView = ['checklist', 'journal', 'meeting'].includes(f.view) ? f.view : null;
    const row = {
      title: tpl.title,
      content: tpl.content,
      kind: tpl.id === 'blank' && kindView ? kindView : tpl.kind,
      notebook: extra.notebook ?? (f.view === 'nb' ? f.nb : null),
      tags: extra.tags ?? (f.view === 'tag' ? [f.tag] : []),
      task_id: extra.task_id || null,
      pinned: f.view === 'pinned',
    };
    let n;
    try { n = await N.createNote(row); } catch (err) { toast.error(err); return; }
    freshId = n.id;
    if (!viewAccepts(n)) {
      Object.assign(f, { view: 'all', nb: '', tag: '', q: '' });
      $('[data-search]').value = '';
      cur = n;
      persist();
      renderSide();
      await loadList();
    } else {
      notes.unshift(n);
      cur = n;
      renderList();
    }
    cur = byId(n.id) || n;
    pending = {};
    savedRefs = mediaRefs(cur.content);
    setQuery({ id: n.id });
    markActive();
    showPane('editor');
    renderEditor({ focus: !n.title || /[:—]\s*$/.test(n.title) ? 'title' : 'body' });
    loadOverview();
  }

  function openTemplates(extra = {}) {
    const tpls = E.noteTemplates();
    const dlg = openModal({
      eyebrow: 'Mẫu ghi chú',
      title: 'Bắt đầu từ đâu?',
      size: 'wide',
      onSubmit: null,
      body: html`
        <div class="nb-tpls">
          ${tpls.map((t, i) => {
            const outline = E.templateOutline(t.content);
            return html`
              <button type="button" class="nb-tpl" data-tpl="${t.id}">
                <span class="nb-tpl__top">${icon(t.icon)}</span>
                <span class="nb-tpl__name">${t.label}</span>
                <span class="nb-tpl__desc">${t.desc}</span>
                ${outline.length ? html`<span class="nb-tpl__outline">${outline.map((o) => html`<span>${o}</span>`)}</span>` : ''}
              </button>`;
          })}
        </div>`,
    });
    dlg.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tpl]');
      if (!b) return;
      dlg.close();
      createFrom(tpls.find((t) => t.id === b.dataset.tpl), extra);
    });
    dlg.el.querySelector('[data-tpl]')?.focus();
  }

  /* ================================================================
     Note actions
     ================================================================ */
  function setNotebook(name) {
    const v = name ? String(name).trim().slice(0, 60) : null;
    if ((cur.notebook || null) === v) return;
    queue({ notebook: v }, { now: true });
    const s = $('[data-nbname]');
    if (s) s.textContent = v || 'Không có sổ';
    updateItem(cur);
  }

  function openNotebookPicker(anchor) {
    const list = overview?.notebooks || [];
    E.openPopover(anchor, html`
      <div class="nb-pop__head">Chuyển vào sổ</div>
      <div class="nb-pop__list">
        <button type="button" class="nb-pop__item" data-pick="" aria-pressed="${!cur.notebook}">${icon('x')}<span>Không có sổ</span></button>
        ${list.map((nb) => html`<button type="button" class="nb-pop__item" data-pick="${nb.name}" aria-pressed="${cur.notebook === nb.name}">${icon('folder')}<span class="truncate">${nb.name}</span><span class="nb-pop__n">${nb.count}</span></button>`)}
      </div>
      <form class="nb-pop__new" novalidate>
        <input class="input input--sm" maxlength="60" placeholder="Sổ mới…" aria-label="Tên sổ mới" />
        <button type="submit" class="btn btn--sm">Tạo</button>
      </form>`, {
      label: 'Chọn sổ ghi chú',
      onOpen: (el, close) => {
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-pick]');
          if (!b) return;
          setNotebook(b.dataset.pick || null);
          close();
        });
        el.querySelector('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const v = e.target.querySelector('input').value.trim();
          if (!v) return;
          setNotebook(v);
          close();
        });
        (el.querySelector('[aria-pressed="true"]') || el.querySelector('button'))?.focus();
      },
    });
  }

  function setColor(c) {
    queue({ color: c || null }, { now: true });
    const sw = $('[data-swatch]');
    if (sw) { sw.style.cssText = c ? `--c:${c}` : ''; sw.classList.toggle('has-color', Boolean(c)); }
    const sheet = $('.nb-ed__sheet');
    if (sheet) sheet.style.cssText = c ? `--c:${c}` : '';
    updateItem(cur);
  }

  function openColorPicker(anchor) {
    const curC = (cur.color || '').toUpperCase();
    E.openPopover(anchor, html`
      <div class="nb-pop__head">Nhãn màu</div>
      <div class="nb-colors" role="radiogroup" aria-label="Nhãn màu">
        <button type="button" class="nb-color nb-color--none" data-color="" role="radio" aria-checked="${!curC}" aria-label="Không màu" title="Không màu">${icon('x')}</button>
        ${SWATCHES.map((c) => html`<button type="button" class="nb-color" data-color="${c}" role="radio" aria-checked="${curC === c}" style="--c:${c}" aria-label="Màu ${c}" title="${c}"></button>`)}
      </div>`, {
      label: 'Nhãn màu',
      onOpen: (el, close) => {
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-color]');
          if (!b) return;
          setColor(b.dataset.color);
          close();
        });
        (el.querySelector('[aria-checked="true"]') || el.querySelector('button'))?.focus();
      },
    });
  }

  function togglePin() {
    if (!cur) return;
    queue({ pinned: !cur.pinned }, { now: true });
    const b = $('.nb-pinbtn');
    if (b) {
      b.setAttribute('aria-pressed', String(cur.pinned));
      b.setAttribute('aria-label', cur.pinned ? 'Bỏ ghim' : 'Ghim lên đầu');
      b.title = cur.pinned ? 'Bỏ ghim' : 'Ghim lên đầu';
    }
    toast(cur.pinned ? 'Đã ghim ghi chú.' : 'Đã bỏ ghim.');
    if (f.view === 'pinned' && !cur.pinned) {
      const id = cur.id;
      settleBeforeDrop(id).then((ok) => (ok ? dropFromList(id) : renderList()));
    } else renderList();
  }

  /** Edits typed while a trash / archive request was in flight: save them before the note leaves. */
  async function saveTyped(id) {
    if (cur?.id === id && Object.keys(pending).length) await flush();
  }

  async function setArchived(n, archived) {
    const leaves = (f.view === 'archived') !== archived;
    if (leaves) { if (!(await settleBeforeDrop(n.id))) return; } else await flush();
    try {
      const saved = await N.updateNote(n.id, { archived });
      Object.assign(n, saved);
      if (leaves) { await saveTyped(n.id); dropFromList(n.id); } else { renderList(); if (cur?.id === n.id) renderEditor(); }
      loadOverview();
      toast(archived ? 'Đã lưu trữ ghi chú.' : 'Đã đưa ghi chú trở lại.', {
        action: { label: 'Hoàn tác', onClick: () => setArchived(n, !archived).then(() => { if (!byId(n.id)) loadList(); }) },
      });
    } catch (err) { toast.error(err); }
  }

  async function trash(n) {
    if (!(await settleBeforeDrop(n.id))) return;
    try {
      await N.trashNote(n.id);
      if (freshId === n.id) freshId = null;
      await saveTyped(n.id);
      dropFromList(n.id);
      loadOverview();
      toast('Đã chuyển vào Thùng rác.', {
        action: { label: 'Hoàn tác', onClick: async () => { try { await N.restoreNote(n.id); await loadList(); loadOverview(); openNote(n.id); } catch (err) { toast.error(err); } } },
      });
    } catch (err) { toast.error(err); }
  }

  async function restore(n) {
    try {
      await N.restoreNote(n.id);
      dropFromList(n.id);
      loadOverview();
      toast('Đã khôi phục ghi chú.', { action: { label: 'Mở', onClick: () => navigate('/notes', { id: n.id }) } });
    } catch (err) { toast.error(err); }
  }

  async function destroy(n) {
    const ok = await confirmDialog({ title: 'Xóa vĩnh viễn?', message: `“${E.displayTitle(n)}” sẽ bị xóa hẳn và không thể khôi phục.`, confirmLabel: 'Xóa vĩnh viễn' });
    if (!ok) return;
    try {
      await N.deleteNote(n.id);
      dropMedia(n.id); // best effort: the note's Storage folder
      dropFromList(n.id);
      loadOverview();
      toast('Đã xóa vĩnh viễn.');
    } catch (err) { toast.error(err); }
  }

  async function emptyTrash() {
    const ok = await confirmDialog({ title: 'Dọn sạch Thùng rác?', message: `${num(notes.length)} ghi chú sẽ bị xóa vĩnh viễn. Không thể hoàn tác.`, confirmLabel: 'Dọn sạch' });
    if (!ok) return;
    try {
      const ids = await N.emptyTrashIds();
      const count = ids.length;
      for (const id of ids) pruneIds.delete(id);
      Promise.resolve().then(() => M.deleteMediaForNotes?.(ids)).then(() => M.purgeOrphanMedia?.()).catch(() => {});
      cur = null;
      setQuery({ id: null });
      renderEditor();
      showPane('list');
      await loadList();
      loadOverview();
      toast(`Đã xóa vĩnh viễn ${num(count)} ghi chú.`);
    } catch (err) { toast.error(err); }
  }

  async function duplicate(n) {
    await flush();
    try {
      const copy = await N.createNote({
        title: (n.title ? `${n.title} (bản sao)` : '').slice(0, 200),
        content: n.content, notebook: n.notebook, tags: n.tags, color: n.color, kind: n.kind, task_id: n.task_id,
      });
      // The copy gets its own media files, so deleting the original never breaks it.
      if (mediaRefs(copy.content).size) {
        try {
          // copyMediaInto keeps every copy that succeeded (and schedules a prune of the copy's folder).
          const content = await copyMediaInto(copy.id, copy.content);
          if (content !== copy.content) Object.assign(copy, await N.updateNote(copy.id, { content }));
        } catch { /* best effort: links whose copy failed keep pointing at the original's files */ }
      }
      if (viewAccepts(copy)) { notes.unshift(copy); renderList(); }
      loadOverview();
      openNote(copy.id, { focus: 'title' });
      toast('Đã nhân bản ghi chú.');
    } catch (err) { toast.error(err); }
  }

  const markdownOf = (n) => `${n.title ? `# ${n.title}\n\n` : ''}${n.content}`;

  async function copyMarkdown(n) {
    syncEditor();
    try {
      await navigator.clipboard.writeText(markdownOf(n));
      toast('Đã sao chép Markdown.');
    } catch {
      toast.error('Trình duyệt không cho phép sao chép.');
    }
  }

  function exportMarkdown(n) {
    syncEditor();
    const name = (E.displayTitle(n).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'ghi-chu').slice(0, 60);
    const url = URL.createObjectURL(new Blob([markdownOf(n)], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- tasks ---------- */
  function linkTask(t) {
    taskCache.set(t.id, t);
    queue({ task_id: t.id }, { now: true });
    renderTaskSlot();
    updateItem(cur);
  }

  async function openLinkTask() {
    if (!cur) return;
    let tasks;
    try { tasks = await listTasks({ status: OPEN_STATUSES, limit: 500 }); } catch (err) { toast.error(err); return; }
    const linked = cur.task_id && taskCache.get(cur.task_id);
    if (linked && !tasks.some((t) => t.id === linked.id)) tasks.unshift(linked);
    openModal({
      eyebrow: 'Liên kết',
      title: 'Gắn ghi chú với công việc',
      submitLabel: 'Liên kết',
      body: html`
        <div class="input-group nb-tfilter">${icon('search')}<input class="input" type="search" data-tfilter placeholder="Lọc công việc đang mở…" aria-label="Lọc công việc" /></div>
        ${tasks.length
          ? html`<div class="nb-tasklist" role="radiogroup" aria-label="Công việc">
              ${tasks.map((t) => html`
                <label class="nb-taskopt" data-title="${t.title.toLowerCase()}">
                  <input type="radio" name="task_id" value="${t.id}" ${t.id === cur.task_id ? raw('checked') : ''} />
                  <span class="nb-taskopt__t">${t.title}</span>
                  ${dueLabel(t.due_date, t.status)}
                </label>`)}
            </div>`
          : emptyState({ art: 'tasks', small: true, title: 'Không có công việc đang mở', text: 'Dùng “Tạo công việc từ dòng này” để tạo việc mới ngay từ ghi chú.' })}`,
      onOpen: (el) => {
        el.querySelector('[data-tfilter]')?.addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          el.querySelectorAll('.nb-taskopt').forEach((o) => { o.hidden = Boolean(q) && !o.dataset.title.includes(q); });
        });
      },
      onSubmit: (v) => {
        const t = tasks.find((x) => x.id === v.task_id);
        if (!t) { toast.info('Hãy chọn một công việc.'); return false; }
        if (cur) linkTask(t);
        toast('Đã liên kết công việc.');
      },
    });
  }

  function taskFromLine() {
    if (!cur) return;
    let title = '';
    const m = bodyMode();
    if (m === 'source') {
      const ta = $('.nb-text');
      if (ta) title = E.lineToTaskTitle(E.currentLine(ta).text);
    } else if (m === 'edit') title = E.lineToTaskTitle(currentBlockText());
    const note = cur;
    openTaskForm({
      defaults: { title: title || E.displayTitle(note).slice(0, 200), tags: (note.tags || []).slice(0, 20), description: `Từ ghi chú: ${E.displayTitle(note)}` },
      onSaved: (task) => {
        notifyDataChanged('tasks');
        if (cur === note && !note.task_id) linkTask(task);
      },
    });
  }

  /** Text of the editor block holding the caret (a list item without its nested lists). */
  function currentBlockText() {
    if (!ed) return '';
    const sel = document.getSelection();
    let node = sel?.rangeCount && ed.el.contains(sel.anchorNode) ? sel.anchorNode : lastRange?.startContainer;
    if (!node || !ed.el.contains(node)) return '';
    if (node.nodeType !== 1) node = node.parentElement;
    const block = node?.closest('li, p, h1, h2, h3, td, th, pre, blockquote');
    if (!block || !ed.el.contains(block)) return '';
    const c = block.cloneNode(true);
    c.querySelectorAll('ul, ol, [contenteditable="false"]').forEach((x) => x.remove());
    return c.textContent.replace(/ /g, ' ').trim();
  }

  async function tasksFromChecklist() {
    if (!cur) return;
    syncEditor();
    const items = E.openChecklistItems(cur.content);
    if (!items.length) { toast.info('Không có mục checklist nào chưa hoàn thành.'); return; }
    const ok = await confirmDialog({
      eyebrow: 'Công việc',
      title: `Tạo ${num(items.length)} công việc?`,
      message: `Mỗi mục “- [ ]” chưa xong sẽ thành một công việc${cur.tags?.length ? ' (kèm thẻ của ghi chú)' : ''}.`,
      confirmLabel: 'Tạo công việc',
      danger: false,
    });
    if (!ok) return;
    const note = cur;
    let made = 0;
    let first = null;
    for (const it of items) {
      try {
        const t = await createTask({ title: it.text.slice(0, 200), tags: (note.tags || []).slice(0, 20), description: `Từ ghi chú: ${E.displayTitle(note)}` });
        first ??= t;
        made++;
      } catch (err) { toast.error(err); break; }
    }
    if (!made) return;
    notifyDataChanged('tasks');
    if (made === 1 && first && cur === note && !note.task_id) linkTask(first);
    toast(`Đã tạo ${num(made)} công việc.`, { action: { label: 'Xem', onClick: () => navigate('/tasks') } });
  }

  function openMore(anchor) {
    const n = cur;
    if (!n) return;
    if (n.trashed_at) {
      popMenu(anchor, [
        { label: 'Khôi phục', icon: 'undo', onClick: () => restore(n) },
        { label: 'Tải về .md', icon: 'download', onClick: () => exportMarkdown(n) },
        'sep',
        { label: 'Xóa vĩnh viễn', icon: 'trash', danger: true, onClick: () => destroy(n) },
      ]);
      return;
    }
    // Phones hide the colour button and the edit / Markdown / preview switch: offer them here.
    const phoneOnly = isPhone() ? [
      { label: 'Nhãn màu…', icon: 'sparkle', onClick: () => openColorPicker(anchor) },
      bodyMode() === 'source'
        ? { label: 'Soạn thảo trực quan', icon: 'edit', onClick: () => setMode('edit') }
        : { label: 'Sửa mã Markdown', icon: 'note', onClick: () => setMode('source') },
      'sep',
    ] : [];
    popMenu(anchor, [
      ...phoneOnly,
      { label: n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu', icon: 'pin', onClick: togglePin },
      { label: n.task_id ? 'Đổi công việc liên kết…' : 'Liên kết công việc…', icon: 'link', onClick: openLinkTask },
      { label: 'Tạo công việc từ dòng này', icon: 'tasks', onClick: taskFromLine },
      { label: 'Tạo công việc từ checklist', icon: 'checkCircle', onClick: tasksFromChecklist },
      'sep',
      { label: 'Nhân bản', icon: 'copy', onClick: () => duplicate(n) },
      { label: 'Sao chép Markdown', icon: 'note', onClick: () => copyMarkdown(n) },
      { label: 'Tải về .md', icon: 'download', onClick: () => exportMarkdown(n) },
      'sep',
      { label: n.archived ? 'Bỏ lưu trữ' : 'Lưu trữ', icon: 'archive', onClick: () => setArchived(n, !n.archived) },
      { label: 'Chuyển vào Thùng rác', icon: 'trash', danger: true, onClick: () => trash(n) },
    ]);
  }

  /* ---------- list-row actions (swipe / long-press) ---------- */
  async function pinListed(n) {
    if (cur?.id === n.id) return togglePin();
    try {
      Object.assign(n, await N.updateNote(n.id, { pinned: !n.pinned }));
      toast(n.pinned ? 'Đã ghim ghi chú.' : 'Đã bỏ ghim.');
      if (f.view === 'pinned' && !n.pinned) dropFromList(n.id); else renderList();
      loadOverview();
    } catch (err) { toast.error(err); }
  }

  function rowActions(id) {
    const n = byId(id);
    if (!n) return null;
    if (n.trashed_at) {
      return { right: { label: 'Khôi phục', icon: icon('undo'), tone: 'ok', leaves: true, run: () => restore(n) } };
    }
    return {
      right: { label: n.pinned ? 'Bỏ ghim' : 'Ghim', icon: icon('pin'), tone: 'accent', leaves: f.view === 'pinned' && n.pinned, run: () => pinListed(n) },
      left: n.archived
        ? { label: 'Bỏ lưu trữ', icon: icon('archive'), tone: 'info', leaves: true, run: () => setArchived(n, false) }
        : { label: 'Thùng rác', icon: icon('trash'), tone: 'danger', leaves: true, run: () => trash(n) },
    };
  }

  function rowMenu(id, anchor) {
    const n = byId(id);
    if (!n) return;
    if (n.trashed_at) {
      popMenu(anchor, [
        { label: 'Khôi phục', icon: 'undo', onClick: () => restore(n) },
        'sep',
        { label: 'Xóa vĩnh viễn', icon: 'trash', danger: true, onClick: () => destroy(n) },
      ], { align: 'center' });
      return;
    }
    popMenu(anchor, [
      { label: 'Mở', icon: 'edit', onClick: () => openNote(n.id) },
      { label: n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu', icon: 'pin', onClick: () => pinListed(n) },
      { label: 'Nhân bản', icon: 'copy', onClick: () => duplicate(n) },
      { label: 'Sao chép Markdown', icon: 'note', onClick: () => copyMarkdown(n) },
      'sep',
      { label: n.archived ? 'Bỏ lưu trữ' : 'Lưu trữ', icon: 'archive', onClick: () => setArchived(n, !n.archived) },
      { label: 'Chuyển vào Thùng rác', icon: 'trash', danger: true, onClick: () => trash(n) },
    ], { align: 'center' });
  }

  /* ---------- notebooks ---------- */
  function newNotebook() {
    openModal({
      eyebrow: 'Sổ ghi chú',
      title: 'Tạo sổ mới',
      size: 'narrow',
      submitLabel: 'Tạo & viết ghi chú đầu tiên',
      body: html`${field({ label: 'Tên sổ', name: 'name', hint: 'Ví dụ: Dự án Alpha, Khách hàng, Học tập', control: input('name', '', 'maxlength="60" autofocus autocomplete="off"') })}`,
      validate: (v) => (v.name ? {} : { name: 'Hãy nhập tên sổ.' }),
      onSubmit: (v) => {
        const name = v.name.slice(0, 60);
        closeNav();
        Object.assign(f, { view: 'nb', nb: name, tag: '' });
        persist();
        renderSide();
        loaded = false;
        loadList().then(() => createFrom(E.noteTemplates()[0], { notebook: name }));
      },
    });
  }

  function notebookMenu(anchor) {
    const name = f.nb;
    popMenu(anchor, [
      { label: 'Ghi chú mới trong sổ', icon: 'plus', onClick: () => createFrom(E.noteTemplates()[0], { notebook: name }) },
      { label: 'Đổi tên sổ…', icon: 'edit', onClick: () => renameNotebookDialog(name) },
      { label: 'Gỡ sổ (giữ ghi chú)', icon: 'folder', onClick: () => removeNotebook(name) },
    ]);
  }

  function renameNotebookDialog(name) {
    openModal({
      eyebrow: 'Sổ ghi chú',
      title: 'Đổi tên sổ',
      size: 'narrow',
      body: html`${field({ label: 'Tên mới', name: 'name', control: input('name', name, 'maxlength="60" autofocus autocomplete="off"') })}`,
      validate: (v) => (v.name ? {} : { name: 'Hãy nhập tên sổ.' }),
      onSubmit: async (v) => {
        if (v.name === name) return;
        await flush();
        const count = await N.renameNotebook(name, v.name);
        f.nb = v.name;
        if (cur?.notebook === name) cur.notebook = v.name;
        persist();
        await Promise.all([loadList(), loadOverview()]);
        if (cur) { const s = $('[data-nbname]'); if (s) s.textContent = cur.notebook || 'Không có sổ'; }
        toast(`Đã đổi tên sổ (${num(count)} ghi chú).`);
      },
    });
  }

  async function removeNotebook(name) {
    const ok = await confirmDialog({ title: `Gỡ sổ “${name}”?`, message: 'Các ghi chú vẫn được giữ nguyên, chỉ không còn thuộc sổ này.', confirmLabel: 'Gỡ sổ', danger: false });
    if (!ok) return;
    try {
      await flush();
      await N.renameNotebook(name, null);
      if (cur?.notebook === name) cur.notebook = null;
      setScope({ view: 'all' });
      loadOverview();
      toast('Đã gỡ sổ.');
    } catch (err) { toast.error(err); }
  }

  /* ================================================================
     Scope / query
     ================================================================ */
  function persist() {
    setQuery({
      view: ['all', 'nb', 'tag'].includes(f.view) ? null : f.view,
      nb: f.view === 'nb' ? f.nb : null,
      tag: f.view === 'tag' ? f.tag : null,
      q: f.q.trim() || null,
      sort: f.sort === 'updated' ? null : f.sort,
      id: cur?.id || null,
      new: null,
      task: null,
    });
  }

  function setScope({ view, nb = '', tag = '' }) {
    Object.assign(f, { view, nb, tag });
    closeNav();
    persist();
    renderSide();
    loaded = false;
    renderListHead();
    loadList();
    if (isPhone()) showPane('list');
  }

  /* ================================================================
     Events
     ================================================================ */
  disposers.push(on(root, 'click', '[data-act]', (e, el) => {
    const act = el.dataset.act;
    switch (act) {
      case 'new-blank': return createFrom(E.noteTemplates()[0]);
      case 'templates': return openTemplates();
      case 'nav-open': return openNav();
      case 'nav-close': return closeNav();
      case 'new-notebook': return newNotebook();
      case 'nb-menu': return notebookMenu(el);
      case 'empty-trash': return emptyTrash();
      case 'clear-search': f.q = ''; $('[data-search]').value = ''; persist(); return loadList();
      case 'sort':
        return popMenu(el, SORTS.map((s) => ({ label: `${s.id === f.sort ? '✓ ' : ''}${s.label}`, icon: s.id === 'title' ? 'list' : 'clock', onClick: () => { f.sort = s.id; persist(); renderList(); } })));
      case 'layout':
        f.layout = f.layout === 'grid' ? 'list' : 'grid';
        store.set(LS_LAYOUT, f.layout);
        ws.dataset.layout = f.layout;
        return renderList();
      case 'back': if (navPushed) { history.back(); return; } return closeEditor();
      case 'retry': return loadList();
    }
    if (!cur) return;
    switch (act) {
      case 'save-now': return flush();
      case 'notebook': return openNotebookPicker(el);
      case 'color': return openColorPicker(el);
      case 'pin': return togglePin();
      case 'more': return openMore(el);
      case 'mode-toggle': return setMode(mode === 'preview' ? editMode : 'preview');
      case 'archive': return setArchived(cur, !cur.archived);
      case 'restore': return restore(cur);
      case 'destroy': return destroy(cur);
      case 'link-task': return openLinkTask();
      case 'unlink-task':
        queue({ task_id: null }, { now: true });
        renderTaskSlot();
        updateItem(cur);
        return;
      case 'open-task': {
        return navigate('/tasks', { id: cur.task_id });
      }
    }
  }));

  disposers.push(on(root, 'click', '.nb-item[data-id]', (e, el) => openNote(el.dataset.id)));
  // Phones: swipe a row right to pin (restore in the trash), left to trash; long-press for more.
  disposers.push(bindRowGestures($('[data-items]'), {
    enabled: () => isPhone() && f.layout === 'list',
    actions: rowActions,
    onMenu: rowMenu,
  }));
  disposers.push(trackKeyboard(ws));
  disposers.push(on(root, 'click', '[data-view]', (e, el) => setScope({ view: el.dataset.view })));
  disposers.push(on(root, 'click', '[data-nb]', (e, el) => setScope({ view: 'nb', nb: el.dataset.nb })));
  disposers.push(on(root, 'click', '[data-tagf]', (e, el) => (f.view === 'tag' && f.tag === el.dataset.tagf ? setScope({ view: 'all' }) : setScope({ view: 'tag', tag: el.dataset.tagf }))));
  disposers.push(on(root, 'click', '[data-mode]', (e, el) => el.tagName === 'BUTTON' && setMode(el.dataset.mode)));

  disposers.push(on(root, 'click', '[data-tool]', (e, el) => { if (!el.disabled) runTool(el.dataset.tool, el); }));
  // Keep the caret / selection in the editor when pressing toolbar buttons.
  disposers.push(on(root, 'mousedown', '[data-tool]', (e) => e.preventDefault()));
  // Toolbar: one tab stop, arrow keys move between buttons (WAI-ARIA toolbar pattern).
  disposers.push(on(root, 'keydown', '[data-tools]', (e, bar) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const btns = [...bar.querySelectorAll('[data-tool]:not([disabled]):not([hidden]):not([data-overflow])')].filter((b) => b.getClientRects().length);
    if (!btns.length) return;
    const i = btns.indexOf(document.activeElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1
      : (Math.max(i, 0) + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    e.preventDefault();
    btns[j].focus();
  }));
  disposers.push(on(root, 'focusin', '[data-tool]', (e, el) => {
    el.closest('[data-tools]')?.querySelectorAll('[data-tool]').forEach((b) => { b.tabIndex = b === el ? 0 : -1; });
  }));
  // Preview: click an image to see it full size.
  disposers.push(on(root, 'click', '[data-preview] img', (e, img) => {
    if (img.currentSrc || img.src) IMG.openLightbox?.(img.currentSrc || img.src, img.alt || '');
  }));

  disposers.push(on(root, 'input', '[data-field]', (e, el) => {
    if (!cur || cur.trashed_at) return;
    const k = el.dataset.field;
    if (k === 'title') {
      autosize(el);
      queue({ title: el.value.replace(/\n/g, ' ') });
      const it = $(`[data-items] [data-id="${cur.id}"] .nb-item__title`);
      if (it) it.textContent = E.displayTitle(cur);
    } else if (k === 'content') {
      autosize(el);
      queue({ content: el.value });
      refreshFoot();
      if (findUi) refindSoon();
    }
  }));
  // Markdown mode: pasting text with another note's nm-media: links copies those files first.
  disposers.push(on(root, 'paste', '.nb-text', (e, ta) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!cur || cur.trashed_at || !/nm-media:/.test(text)) return;
    e.preventDefault();
    const note = cur;
    const at = [ta.selectionStart, ta.selectionEnd, ta.value];
    Promise.resolve(copyMediaInto(note.id, text)).then((out) => {
      const t = $('.nb-text');
      if (cur !== note || bodyMode() !== 'source' || !t) return;
      const [s, end] = sourceRange(t, at); // the user may have typed during the copy
      E.replaceRange(t, s, end, out);
    });
  }));
  disposers.push(on(root, 'change', 'select[data-field="kind"]', (e, el) => {
    queue({ kind: el.value }, { now: true });
    updateItem(cur);
  }));
  disposers.push(on(root, 'change', '[data-preview] input[type=checkbox][data-line]', (e, el) => {
    if (!cur || cur.trashed_at) return;
    const next = E.toggleTaskLine(cur.content, Number(el.dataset.line));
    if (next === cur.content) return;
    const ta = $('.nb-text');
    if (ta) ta.value = next;
    el.closest('li')?.classList.toggle('is-done', el.checked);
    queue({ content: next });
    renderFoot();
  }));

  disposers.push(on(root, 'keydown', '.nb-title', (e, el) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const m = bodyMode();
      if (m === 'edit' && ed) ed.focus();
      else if (m === 'source') { const ta = $('.nb-text'); ta?.focus(); ta?.setSelectionRange(0, 0); }
    }
  }));

  disposers.push(on(root, 'keydown', '.nb-text', (e, ta) => {
    const mod = e.ctrlKey || e.metaKey;
    const run = (fn) => { e.preventDefault(); fn(); };
    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') return run(() => sourceTool('bold', ta));
      if (k === 'u') return run(() => sourceTool('underline', ta));
      if (k === 'i') return run(() => sourceTool('italic', ta));
      if (k === 'k') return run(() => sourceTool('link', ta));
      if (k === 'e') return run(() => sourceTool('code', ta));
    }
    if (mod && e.shiftKey && !e.altKey) {
      const map = { Digit8: 'ul', Digit7: 'ol', Digit9: 'task', Period: 'quote', KeyX: 'strike', KeyH: 'mark' };
      if (map[e.code]) return run(() => sourceTool(map[e.code], ta));
    }
    if (mod && e.altKey && /^Digit[1-3]$/.test(e.code)) return run(() => sourceTool(`h${e.code.slice(-1)}`, ta));
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      if (E.continueList(ta)) e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const inList = /^\s*([-*+]|\d{1,9}[.)])\s/.test(E.currentLine(ta).text);
      if (inList || ta.selectionStart !== ta.selectionEnd) {
        e.preventDefault();
        E.indentLines(ta, e.shiftKey ? -1 : 1);
      }
    }
  }));

  const onSearch = debounce(() => { persist(); loadList(); }, 280);
  disposers.push(on(root, 'input', '[data-search]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'keydown', '[data-search]', (e, el) => {
    if (e.key === 'Escape' && el.value) { e.preventDefault(); el.value = ''; f.q = ''; onSearch(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); $('.nb-item')?.focus(); }
  }));
  // Arrow keys move through the list.
  disposers.push(on(root, 'keydown', '.nb-item', (e, el) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...root.querySelectorAll('.nb-item')];
    const i = items.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1);
    if (items[i]) { e.preventDefault(); items[i].focus(); }
  }));

  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') {
      if (!cur) return;
      e.preventDefault();
      flush();
      return;
    }
    if (mod && e.key === '/') {
      if (!cur || cur.trashed_at) return;
      e.preventDefault();
      setMode(mode === 'preview' ? editMode : 'preview', { focus: true });
      return;
    }
    // Find / replace inside the open note (Ctrl+F / Ctrl+H); elsewhere the browser keeps its own.
    if (mod && !e.altKey && !e.shiftKey && ['f', 'h'].includes(e.key.toLowerCase())) {
      if (!cur || cur.trashed_at || !e.target.closest?.('[data-editor]')) return;
      e.preventDefault();
      openFind({ replace: e.key.toLowerCase() === 'h' });
      return;
    }
    if (e.key === 'Escape' && ws.dataset.nav === 'open') { closeNav(); return; }
    if (mod || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openTemplates(); }
    if (e.key === '/') { e.preventDefault(); if (isPhone()) showPane('list'); $('[data-search]')?.focus(); }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  const onBeforeUnload = (e) => {
    syncEditor(); // keystrokes still inside the editor's 300 ms onChange debounce
    if (!Object.keys(pending).length && !saving) return;
    flush();
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  // Mobile / PWA: timers freeze in the background and the OS may kill the page without a
  // beforeunload → save as soon as the page is hidden.
  const saveOnHide = (e) => {
    if (e?.type !== 'pagehide' && document.visibilityState !== 'hidden') return;
    syncEditor();
    if (Object.keys(pending).length) flush();
  };
  document.addEventListener('visibilitychange', saveOnHide);
  window.addEventListener('pagehide', saveOnHide);
  disposers.push(() => {
    document.removeEventListener('visibilitychange', saveOnHide);
    window.removeEventListener('pagehide', saveOnHide);
  });

  const onResize = debounce(fit, 120);
  window.addEventListener('resize', onResize);
  disposers.push(() => window.removeEventListener('resize', onResize));
  const onMq = () => { fit(); if (!isPhone()) ws.dataset.pane = cur ? 'editor' : 'list'; };
  mqPhone.addEventListener('change', onMq);
  disposers.push(() => mqPhone.removeEventListener('change', onMq));

  disposers.push(onDataChanged((k) => {
    if (k === 'notes') { loadList(); loadOverview(); }
    if (k === 'tasks' && cur?.task_id) { taskCache.delete(cur.task_id); renderTaskSlot(); }
  }));

  /* ================================================================
     Boot
     ================================================================ */
  renderSide();
  renderListHead();
  renderEditor();
  fit();
  requestAnimationFrame(fit);
  await Promise.all([loadList(), loadOverview()]);

  if (query.new === '1') {
    setQuery({ new: null, task: null });
    openTemplates({ task_id: query.task || null, notebook: f.view === 'nb' ? f.nb : undefined });
  } else if (query.id) {
    await openNote(query.id);
  } else if (!isPhone() && f.view !== 'trash') {
    const first = sorted()[0];
    if (first) await openNote(first.id);
  }

  return () => {
    closeFind({ restore: false });
    try { recorder?.close?.(); } catch { /* already closed */ }
    disposers.forEach((d) => d());
    tagObs?.disconnect();
    E.closePopover();
    closeMenu();
    // Leaving the page right after "Viết nhanh" must not leave an empty note behind.
    if (cur && freshId === cur.id && isBlank(cur)) {
      clearTimeout(saveTimer);
      pending = {};
      const id = cur.id;
      Promise.resolve(saving).then(() => N.deleteNote(id)).then(() => dropMedia(id)).catch(() => {});
    } else {
      // Save what is left, then prune media the open note no longer references.
      const id = cur?.id;
      Promise.resolve(Object.keys(pending).length ? flush() : null)
        .then(() => { if (id && pruneIds.has(id)) return runPrune(id); })
        .then(() => (pruneIds.size ? runPrune() : null))
        .catch(() => {});
    }
  };
}
