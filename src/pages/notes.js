// § 02 Ghi chú — three-pane notes workspace (library · list · editor).
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
import { onDataChanged, notifyDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { today, dayOf, diffDays } from '../utils/date.js';
import { time as fmtTime, relDay, dateTime, num, monthLabel, ago } from '../utils/format.js';
import * as N from '../services/notes.js';
import { listTasks, getTask, createTask, OPEN_STATUSES } from '../services/tasks.js';
import * as E from '../components/noteEditor.js';

const VIEWS = [
  { id: 'all', label: 'Tất cả ghi chú', icon: 'note' },
  { id: 'pinned', label: 'Đã ghim', icon: 'pin' },
  { id: 'checklist', label: 'Checklist', icon: 'tasks' },
  { id: 'journal', label: 'Nhật ký', icon: 'calendar' },
  { id: 'meeting', label: 'Họp', icon: 'user' },
  { id: 'archived', label: 'Lưu trữ', icon: 'archive' },
  { id: 'trash', label: 'Thùng rác', icon: 'trash' },
];
const KIND_LABEL = { note: 'Ghi chú', checklist: 'Checklist', journal: 'Nhật ký', meeting: 'Họp' };
const SORTS = [
  { id: 'updated', label: 'Sửa gần nhất' },
  { id: 'created', label: 'Ngày tạo' },
  { id: 'title', label: 'Tiêu đề A–Z' },
];
const MODES = ['edit', 'preview', 'split'];
const STATUS_TEXT = { saved: 'Đã lưu', dirty: 'Chưa lưu', saving: 'Đang lưu…', error: 'Lỗi lưu · thử lại' };
const LS_LAYOUT = 'nm.notes.layout';
const LS_MODE = 'nm.notes.mode';
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const mqPhone = window.matchMedia('(max-width: 720px)');

export default async function notesPage(root, { query }) {
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
  let mode = MODES.includes(store.get(LS_MODE)) ? store.get(LS_MODE) : 'edit';

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

  mount(root, html`
    <div class="nb-page">
      ${pageHead({
        num: '02',
        kicker: 'Ghi chú',
        title: 'Sổ tay <em>ghi chép</em>',
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
            <div class="input-group">${icon('search')}<input class="input" type="search" data-search placeholder="Tìm tiêu đề, nội dung, #thẻ…" value="${f.q}" aria-label="Tìm ghi chú" autocomplete="off" /></div>
          </div>
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
    if (isPhone()) { ws.style.removeProperty('--nb-h'); return; }
    const top = ws.getBoundingClientRect().top + window.scrollY;
    ws.style.setProperty('--nb-h', Math.max(520, Math.floor(window.innerHeight - top - 20)) + 'px');
  }
  function showPane(p) {
    ws.dataset.pane = p;
    if (isPhone()) window.scrollTo({ top: 0 });
  }
  const openNav = () => { ws.dataset.nav = 'open'; $('.nb-side__item[aria-current="true"], .nb-side__item')?.focus(); };
  const closeNav = () => { ws.dataset.nav = 'closed'; };

  function autosize(el) {
    if (!el) return;
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
        <span class="eyebrow">§ Thư viện</span>
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
        <span class="eyebrow">§ Sổ ghi chú</span>
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
      <div class="nb-side__sect"><span class="eyebrow">§ Thẻ</span></div>
      <div class="nb-side__tags">
        ${tags.length
          ? tags.slice(0, 40).map((t) => html`<button type="button" class="tag ${f.view === 'tag' && f.tag === t.tag ? 'is-on' : ''}" data-tagf="${t.tag}" aria-pressed="${f.view === 'tag' && f.tag === t.tag}">${t.tag}<span class="nb-side__tagn">${t.count}</span></button>`)
          : html`<p class="nb-side__hint">Thêm thẻ cho ghi chú để lọc nhanh theo chủ đề.</p>`}
      </div>
      ${err ? html`<p class="nb-side__hint danger-text">Không tải được thư viện.</p>` : ''}`);
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

  /** Flush, then release the current note (discarding a brand-new blank one). */
  async function leaveCurrent() {
    if (!cur) return true;
    await flush();
    if (Object.keys(pending).length) {
      const ok = await confirmDialog({
        title: 'Chưa lưu được thay đổi',
        message: 'Thay đổi gần nhất chưa được lưu (có thể do mất kết nối). Rời ghi chú này và bỏ thay đổi đó?',
        confirmLabel: 'Bỏ thay đổi',
      });
      if (!ok) return false;
      pending = {};
    }
    const old = cur;
    const blank = !old.title.trim() && !E.plainText(old.content).replace(/[☐•\s]/g, '') && !(old.tags || []).length && !old.task_id;
    if (freshId === old.id && blank) {
      freshId = null;
      notes = notes.filter((x) => x.id !== old.id);
      $(`[data-items] [data-id="${old.id}"]`)?.remove();
      N.deleteNote(old.id).then(loadOverview).catch(() => {});
    }
    setStatus('saved');
    return true;
  }

  /* ================================================================
     Editor pane
     ================================================================ */
  function renderPreview() {
    return cur.content.trim() ? E.renderMarkdown(cur.content) : html`<p class="nb-preview__empty">Chưa có nội dung để xem trước.</p>`;
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
          <div><dt><kbd>/</kbd></dt><dd>Tìm kiếm</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>B</kbd> · <kbd>I</kbd> · <kbd>K</kbd></dt><dd>Đậm · nghiêng · liên kết</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>8</kbd> / <kbd>9</kbd></dt><dd>Danh sách · việc cần làm</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>/</kbd></dt><dd>Sửa ↔ Xem trước</dd></div>
          <div><dt><kbd>Ctrl</kbd><kbd>S</kbd></dt><dd>Lưu ngay</dd></div>
        </dl>
      </div>`);
  }

  function renderEditor({ focus } = {}) {
    tagObs?.disconnect();
    tagObs = null;
    E.closePopover();
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
          <div class="segmented nb-mode" role="group" aria-label="Chế độ hiển thị">
            <button type="button" data-mode="edit" aria-pressed="${m === 'edit'}" title="Soạn thảo">${icon('edit')}<span>Sửa</span></button>
            <button type="button" data-mode="preview" aria-pressed="${m === 'preview'}" title="Xem trước (Ctrl+/)">${icon('eye')}<span>Xem</span></button>
            <button type="button" data-mode="split" class="nb-mode__split" aria-pressed="${m === 'split'}" title="Soạn và xem song song">${icon('board')}<span>Song song</span></button>
          </div>
          <button type="button" class="icon-btn nb-pinbtn" data-act="pin" aria-pressed="${n.pinned}" aria-label="${n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}" title="${n.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}">${icon('pin')}</button>
          <button type="button" class="icon-btn" data-act="color" aria-label="Nhãn màu" title="Nhãn màu" aria-haspopup="dialog"><span class="nb-swatch ${n.color ? 'has-color' : ''}" data-swatch style="${n.color ? `--c:${n.color}` : ''}"></span></button>`}
        <button type="button" class="icon-btn" data-act="more" aria-label="Thêm thao tác" aria-haspopup="menu">${icon('more')}</button>
      </header>
      ${ro
        ? html`<div class="nb-banner nb-banner--danger">${icon('trash')}<span>Ghi chú đang ở Thùng rác · chỉ xem.</span><span class="grow"></span><button type="button" class="btn btn--sm" data-act="restore">${icon('undo')} Khôi phục</button><button type="button" class="btn btn--sm btn--danger-ghost" data-act="destroy">Xóa vĩnh viễn</button></div>`
        : n.archived ? html`<div class="nb-banner">${icon('archive')}<span>Ghi chú đã lưu trữ.</span><span class="grow"></span><button type="button" class="btn btn--sm" data-act="archive">Bỏ lưu trữ</button></div>` : ''}
      ${ro ? '' : html`<div class="nb-tools" role="toolbar" aria-label="Định dạng Markdown">${E.toolbarTpl()}</div>`}
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
              : raw(String(tagInput('tags', n.tags || [])).replace('__ID__', 'nb-tag-input'))}
            <span class="nb-taskslot" data-taskslot></span>
          </div>
          <div class="nb-body" data-body data-mode="${m}">
            ${ro ? '' : html`<textarea class="nb-text" data-field="content" maxlength="${N.NOTE_LIMITS.content}" spellcheck="true" placeholder="Bắt đầu viết…&#10;&#10;# Tiêu đề · **đậm** · _nghiêng_ · - [ ] việc cần làm · [liên kết](https://…)" aria-label="Nội dung ghi chú (Markdown)">${n.content}</textarea>`}
            <article class="nb-preview md" data-preview>${m !== 'edit' ? renderPreview() : ''}</article>
          </div>
        </div>
      </div>
      <footer class="nb-ed__foot" data-foot></footer>`);

    if (ro) root.querySelectorAll('[data-preview] input[type=checkbox]').forEach((c) => { c.disabled = true; });
    else bindTags();
    setStatus(Object.keys(pending).length ? 'dirty' : 'saved');
    autosize($('.nb-title'));
    autosize($('.nb-text'));
    renderFoot();
    renderTaskSlot();
    $('[data-scroll]').scrollTop = 0;

    if (focus === 'title') {
      const t = $('.nb-title');
      t?.focus();
      t?.setSelectionRange(t.value.length, t.value.length);
    } else if (focus === 'body' && m !== 'preview') {
      const ta = $('.nb-text');
      if (ta) {
        const mm = ta.value.match(/(\*\* |- \[ \] |- |1\. |> )(?=\n|$)/);
        const at = mm ? mm.index + mm[0].length : ta.value.length;
        ta.focus();
        ta.setSelectionRange(at, at);
      }
    }
  }

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

  const refreshPreview = debounce(() => {
    const pv = $('[data-preview]');
    if (pv && cur && (ws.querySelector('[data-body]')?.dataset.mode || 'edit') !== 'edit') mount(pv, renderPreview());
  }, 140);
  const refreshFoot = debounce(renderFoot, 300);

  function setMode(m) {
    if (!MODES.includes(m) || !cur || cur.trashed_at) return;
    mode = m;
    store.set(LS_MODE, m);
    $('[data-editor]').dataset.mode = m;
    const body = $('[data-body]');
    if (body) body.dataset.mode = m;
    root.querySelectorAll('[data-mode]').forEach((b) => b.tagName === 'BUTTON' && b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    if (m !== 'edit') mount($('[data-preview]'), renderPreview());
    else autosize($('.nb-text'));
    if (m === 'split') autosize($('.nb-text'));
  }

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
    setQuery({ id: n.id });
    markActive();
    renderEditor({ focus });
    showPane('editor');
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
    setQuery({ id: n.id });
    markActive();
    renderEditor({ focus: !n.title || /[:—]\s*$/.test(n.title) ? 'title' : 'body' });
    showPane('editor');
    loadOverview();
  }

  function openTemplates(extra = {}) {
    const tpls = E.noteTemplates();
    const dlg = openModal({
      eyebrow: '§ Mẫu ghi chú',
      title: 'Bắt đầu từ đâu?',
      size: 'wide',
      onSubmit: null,
      body: html`
        <div class="nb-tpls">
          ${tpls.map((t, i) => {
            const outline = E.templateOutline(t.content);
            return html`
              <button type="button" class="nb-tpl" data-tpl="${t.id}">
                <span class="nb-tpl__top"><span class="nb-tpl__num">${String(i + 1).padStart(2, '0')}</span>${icon(t.icon)}</span>
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
    if (f.view === 'pinned' && !cur.pinned) { const id = cur.id; flush().then(() => dropFromList(id)); }
    else renderList();
  }

  async function setArchived(n, archived) {
    await flush();
    try {
      const saved = await N.updateNote(n.id, { archived });
      Object.assign(n, saved);
      const leaves = (f.view === 'archived') !== archived;
      if (leaves) dropFromList(n.id); else { renderList(); if (cur?.id === n.id) renderEditor(); }
      loadOverview();
      toast(archived ? 'Đã lưu trữ ghi chú.' : 'Đã đưa ghi chú trở lại.', {
        action: { label: 'Hoàn tác', onClick: () => setArchived(n, !archived).then(() => { if (!byId(n.id)) loadList(); }) },
      });
    } catch (err) { toast.error(err); }
  }

  async function trash(n) {
    await flush();
    try {
      await N.trashNote(n.id);
      if (freshId === n.id) freshId = null;
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
      dropFromList(n.id);
      loadOverview();
      toast('Đã xóa vĩnh viễn.');
    } catch (err) { toast.error(err); }
  }

  async function emptyTrash() {
    const ok = await confirmDialog({ title: 'Dọn sạch Thùng rác?', message: `${num(notes.length)} ghi chú sẽ bị xóa vĩnh viễn. Không thể hoàn tác.`, confirmLabel: 'Dọn sạch' });
    if (!ok) return;
    try {
      const count = await N.emptyTrash();
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
      if (viewAccepts(copy)) { notes.unshift(copy); renderList(); }
      loadOverview();
      openNote(copy.id, { focus: 'title' });
      toast('Đã nhân bản ghi chú.');
    } catch (err) { toast.error(err); }
  }

  const markdownOf = (n) => `${n.title ? `# ${n.title}\n\n` : ''}${n.content}`;

  async function copyMarkdown(n) {
    try {
      await navigator.clipboard.writeText(markdownOf(n));
      toast('Đã sao chép Markdown.');
    } catch {
      toast.error('Trình duyệt không cho phép sao chép.');
    }
  }

  function exportMarkdown(n) {
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
      eyebrow: '§ Liên kết',
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
    const ta = $('.nb-text');
    let title = '';
    if (ta && mode !== 'preview') title = E.lineToTaskTitle(E.currentLine(ta).text);
    const note = cur;
    openTaskForm({
      defaults: { title: title || E.displayTitle(note).slice(0, 200), tags: (note.tags || []).slice(0, 20), description: `Từ ghi chú: ${E.displayTitle(note)}` },
      onSaved: (task) => {
        notifyDataChanged('tasks');
        if (cur === note && !note.task_id) linkTask(task);
      },
    });
  }

  async function tasksFromChecklist() {
    if (!cur) return;
    const items = E.openChecklistItems(cur.content);
    if (!items.length) { toast.info('Không có mục checklist nào chưa hoàn thành.'); return; }
    const ok = await confirmDialog({
      eyebrow: '§ Công việc',
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
    popMenu(anchor, [
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

  /* ---------- notebooks ---------- */
  function newNotebook() {
    openModal({
      eyebrow: '§ Sổ ghi chú',
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
      eyebrow: '§ Sổ ghi chú',
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
      case 'back': return closeEditor();
      case 'retry': return loadList();
    }
    if (!cur) return;
    switch (act) {
      case 'save-now': return flush();
      case 'notebook': return openNotebookPicker(el);
      case 'color': return openColorPicker(el);
      case 'pin': return togglePin();
      case 'more': return openMore(el);
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
        const t = taskCache.get(cur.task_id);
        return navigate('/tasks', { q: t?.title || null, scope: t && !OPEN_STATUSES.includes(t.status) ? 'all' : null });
      }
    }
  }));

  disposers.push(on(root, 'click', '.nb-item[data-id]', (e, el) => openNote(el.dataset.id)));
  disposers.push(on(root, 'click', '[data-view]', (e, el) => setScope({ view: el.dataset.view })));
  disposers.push(on(root, 'click', '[data-nb]', (e, el) => setScope({ view: 'nb', nb: el.dataset.nb })));
  disposers.push(on(root, 'click', '[data-tagf]', (e, el) => (f.view === 'tag' && f.tag === el.dataset.tagf ? setScope({ view: 'all' }) : setScope({ view: 'tag', tag: el.dataset.tagf }))));
  disposers.push(on(root, 'click', '[data-mode]', (e, el) => el.tagName === 'BUTTON' && setMode(el.dataset.mode)));

  disposers.push(on(root, 'click', '[data-tool]', (e, el) => {
    const ta = $('.nb-text');
    if (!ta) return;
    if (mode === 'preview') setMode('edit');
    applyTool(el.dataset.tool, ta);
  }));
  // Keep the caret in the textarea when tapping toolbar buttons.
  disposers.push(on(root, 'mousedown', '[data-tool]', (e) => e.preventDefault()));

  function applyTool(id, ta) {
    switch (id) {
      case 'bold': return E.wrapSelection(ta, '**');
      case 'italic': return E.wrapSelection(ta, '_');
      case 'strike': return E.wrapSelection(ta, '~~');
      case 'mark': return E.wrapSelection(ta, '==');
      case 'code': return ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? E.insertBlock(ta, 'code') : E.wrapSelection(ta, '`', '`', 'mã');
      case 'link': return E.insertLink(ta);
      case 'hr': return E.insertBlock(ta, 'hr');
      case 'h1': case 'h2': case 'h3': case 'ul': case 'ol': case 'task': case 'quote': return E.toggleLines(ta, id);
      case 'line-task': return taskFromLine();
    }
  }

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
      refreshPreview();
      refreshFoot();
    }
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
      const ta = $('.nb-text');
      if (ta && mode !== 'preview') { ta.focus(); ta.setSelectionRange(0, 0); }
    }
  }));

  disposers.push(on(root, 'keydown', '.nb-text', (e, ta) => {
    const mod = e.ctrlKey || e.metaKey;
    const run = (fn) => { e.preventDefault(); fn(); };
    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'b') return run(() => applyTool('bold', ta));
      if (k === 'i') return run(() => applyTool('italic', ta));
      if (k === 'k') return run(() => applyTool('link', ta));
      if (k === 'e') return run(() => applyTool('code', ta));
    }
    if (mod && e.shiftKey && !e.altKey) {
      const map = { Digit8: 'ul', Digit7: 'ol', Digit9: 'task', Period: 'quote', KeyX: 'strike', KeyH: 'mark' };
      if (map[e.code]) return run(() => applyTool(map[e.code], ta));
    }
    if (mod && e.altKey && /^Digit[1-3]$/.test(e.code)) return run(() => applyTool(`h${e.code.slice(-1)}`, ta));
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
      setMode(mode === 'preview' ? 'edit' : 'preview');
      if (mode === 'edit') $('.nb-text')?.focus();
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
    if (!Object.keys(pending).length && !saving) return;
    flush();
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  disposers.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

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
    disposers.forEach((d) => d());
    tagObs?.disconnect();
    E.closePopover();
    closeMenu();
    if (Object.keys(pending).length) flush();
  };
}
