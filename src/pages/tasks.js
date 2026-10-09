// Tasks — list (grouped by due), Kanban board and grouped views, smart quick-add,
// detail drawer, bulk actions and keyboard control.
import { html, raw, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, catLabel, dueLabel, prio, statusBadge, categoryOptions, popMenu, closeMenu, TASK_STATUS, TASK_PRIORITY, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, loadingRows } from '../components/states.js';
import { openTaskForm, RECURRENCE_LABELS, RECURRENCE_SHORT } from '../components/taskForm.js';
import { openTaskDrawer, checklistStats } from '../components/taskDrawer.js';
import { openModal, confirmDialog, field, input } from '../components/modal.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import {
  listTasks, getTask, createTask, updateTask, setTaskStatus, deleteTask,
  bulkUpdateTasks, bulkSetTaskStatus, bulkDeleteTasks, restoreTask, duplicateTask,
} from '../services/tasks.js';
import { parseTaskInput } from '../services/smart/quickAdd.js';
import { normalizeVi } from '../services/smart/text.js';
import { today, addDays, startOfWeek, endOfWeek, dayOf } from '../utils/date.js';
import { minutes, num, relDay, day as fmtDay } from '../utils/format.js';

/* ------------------------------------------------------------------ */

const LS_PREFS = 'nm.tasks.prefs';
const LS_COLLAPSED = 'nm.tasks.collapsed';

const VIEWS = [
  { id: 'list', label: 'Danh sách', icon: 'list' },
  { id: 'board', label: 'Bảng', icon: 'board' },
  { id: 'group', label: 'Nhóm', icon: 'layers' },
];
const SCOPES = [
  { id: 'open', label: 'Đang mở' },
  { id: 'in_progress', label: 'Đang làm' },
  { id: 'done', label: 'Hoàn thành' },
  { id: 'cancelled', label: 'Đã hủy' },
  { id: 'all', label: 'Tất cả' },
];
const SORTS = [
  { value: 'due', label: 'Theo hạn chót' },
  { value: 'priority', label: 'Theo ưu tiên' },
  { value: 'created', label: 'Mới tạo' },
  { value: 'updated', label: 'Cập nhật gần đây' },
  { value: 'title', label: 'Tên A–Z' },
];
const DUES = [
  { value: '', label: 'Mọi thời hạn' },
  { value: 'overdue', label: 'Quá hạn' },
  { value: 'today', label: 'Hôm nay' },
  { value: 'tomorrow', label: 'Ngày mai' },
  { value: 'week', label: '7 ngày tới' },
  { value: 'month', label: 'Tháng này' },
  { value: 'none', label: 'Không có hạn' },
];
const GROUP_BY = [
  { value: 'category', label: 'Theo danh mục' },
  { value: 'priority', label: 'Theo ưu tiên' },
];
const BOARD_COLS = ['todo', 'in_progress', 'completed'];
const BOARD_DONE_LIMIT = 20;
const PRIO_ORDER = ['urgent', 'high', 'medium', 'low'];
const DEFAULTS = { view: 'list', scope: 'open', group: 'category', sort: 'due', cat: '', prio: '', tag: '', due: '', q: '' };
const QA_EXAMPLE = 'Gửi báo giá cho khách mai 9h #sales !cao ~30p hằng tuần';

const isOpen = (t) => t.status === 'todo' || t.status === 'in_progress';
const prRank = (t) => PRIORITY_RANK[t.priority] ?? 2;
const dueKey = (t) => t.due_date || '9999-12-31';
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readLS = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? fb; } catch { return fb; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

const SORTERS = {
  due: (a, b) => dueKey(a).localeCompare(dueKey(b)) || prRank(a) - prRank(b) || (b.created_at || '').localeCompare(a.created_at || ''),
  priority: (a, b) => prRank(a) - prRank(b) || dueKey(a).localeCompare(dueKey(b)),
  created: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
  updated: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
  title: (a, b) => a.title.localeCompare(b.title, 'vi'),
};

function readPrefs(query) {
  const saved = readLS(LS_PREFS, {}) || {};
  const fromUrl = Object.keys(DEFAULTS).some((k) => query[k] != null) || query.filter != null;
  const src = fromUrl ? query : saved;
  const f = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (typeof src[k] === 'string') f[k] = src[k];
  if (!fromUrl) f.q = '';
  // legacy / external links: ?view=overdue, ?scope=overdue, ?filter=overdue|today
  if (query.view === 'overdue' || query.scope === 'overdue' || query.filter === 'overdue') Object.assign(f, { view: 'list', scope: 'open', due: 'overdue' });
  if (query.filter === 'today') Object.assign(f, { scope: 'open', due: 'today' });
  if (!VIEWS.some((v) => v.id === f.view)) f.view = 'list';
  if (!SCOPES.some((s) => s.id === f.scope)) f.scope = 'open';
  if (!SORTS.some((s) => s.value === f.sort)) f.sort = 'due';
  if (!DUES.some((d) => d.value === f.due)) f.due = '';
  if (!GROUP_BY.some((g) => g.value === f.group)) f.group = 'category';
  if (f.prio && !TASK_PRIORITY[f.prio]) f.prio = '';
  return f;
}

/* ------------------------------------------------------------------ */

export default async function tasksPage(root, { query }) {
  const f = readPrefs(query);
  let tasks = [];
  let loaded = false;
  let loadError = null;
  let drawer = null;
  let cursorId = null;
  let anchorId = null;
  let selecting = false;
  let filtersOpen = false;
  const selected = new Set();
  const collapsed = new Set(readLS(LS_COLLAPSED, []));
  const disposers = [];
  let destroyed = false;

  mount(root, html`
    <div class="tk-page">
    ${pageHead({
      num: '03',
      kicker: 'Công việc',
      title: 'Những việc <em>cần làm</em>',
      lede: 'Gõ như nói chuyện để thêm việc, kéo thả để đổi trạng thái, bấm giờ ngay trên từng việc.',
      actions: html`
        <button type="button" class="btn btn--ghost" data-act="help" title="Phím tắt và cú pháp (?)">${icon('keyboard')}<span class="tk-hide-sm">Phím tắt</span></button>
        <button type="button" class="btn btn--primary" data-act="new">${icon('plus')} Công việc mới</button>`,
    })}

    <div class="tk-ledger" data-ledger aria-label="Tổng quan"></div>

    <form class="tk-qa" data-qa autocomplete="off" novalidate>
      <div class="tk-qa__row">
        <span class="tk-qa__icon" aria-hidden="true">${icon('plus')}</span>
        <input class="tk-qa__input" name="qa" type="text" maxlength="300" enterkeyhint="done" spellcheck="false"
          placeholder="Thêm việc nhanh — vd: Gửi báo giá mai 9h #sales !cao ~30p"
          aria-label="Thêm công việc nhanh" aria-describedby="tk-qa-preview" />
        <kbd class="tk-qa__kbd" aria-hidden="true">N</kbd>
        <button type="button" class="icon-btn icon-btn--sm tk-qa__help" data-act="help" aria-label="Cú pháp nhập nhanh">${icon('info')}</button>
        <button type="submit" class="btn btn--primary btn--sm tk-qa__submit">Thêm</button>
      </div>
      <div class="tk-qa__preview" id="tk-qa-preview" data-qa-preview aria-live="polite"></div>
    </form>

    <div class="tk-toolbar">
      <div class="input-group tk-search">${icon('search')}<input class="input" type="search" placeholder="Tìm tiêu đề, mô tả, thẻ…" value="${f.q}" data-f="q" aria-label="Tìm công việc" /><kbd class="tk-search__kbd" aria-hidden="true">/</kbd></div>
      <button type="button" class="btn tk-filter-toggle" data-act="filters" aria-expanded="false">${icon('filter')} Bộ lọc<span class="tk-count" data-fcount></span></button>
      <div class="tk-filters" data-filters>
        <select class="select select--sm" data-f="cat" aria-label="Danh mục"></select>
        <select class="select select--sm" data-f="prio" aria-label="Độ ưu tiên">
          <option value="">Mọi ưu tiên</option>
          ${PRIO_ORDER.map((v) => html`<option value="${v}">${TASK_PRIORITY[v]}</option>`)}
        </select>
        <select class="select select--sm" data-f="due" aria-label="Thời hạn">${DUES.map((d) => html`<option value="${d.value}">${d.label}</option>`)}</select>
        <select class="select select--sm" data-f="tag" aria-label="Thẻ"></select>
        <select class="select select--sm" data-f="sort" aria-label="Sắp xếp">${SORTS.map((s) => html`<option value="${s.value}">${s.label}</option>`)}</select>
      </div>
    </div>

    <div class="tk-subbar">
      <div class="tabs tk-scopes" role="tablist" aria-label="Trạng thái" data-scopes></div>
      <div class="tk-subbar__right">
        <select class="select select--sm tk-groupby" data-f="group" aria-label="Nhóm theo">${GROUP_BY.map((g) => html`<option value="${g.value}">${g.label}</option>`)}</select>
        <button type="button" class="btn btn--ghost btn--sm tk-select-toggle" data-act="selecting" aria-pressed="false" title="Chọn nhiều (X)">${icon('checkSquare')}<span class="tk-hide-sm">Chọn</span></button>
        <div class="segmented tk-views" role="group" aria-label="Kiểu hiển thị">
          ${VIEWS.map((v) => html`<button type="button" data-view="${v.id}" aria-pressed="${f.view === v.id}" title="${v.label}">${icon(v.icon)}<span class="tk-hide-sm">${v.label}</span></button>`)}
        </div>
      </div>
    </div>

    <div class="tk-chipsbar" data-chips></div>
    <div class="tk-body" data-body></div>
    <div class="tk-bulkhost" data-bulk></div>
    </div>`);

  const $ = (s) => root.querySelector(s);
  const qaInput = $('.tk-qa__input');
  // Phones: the long example placeholder gets clipped — use a shorter one below 600px.
  const mqNarrow = window.matchMedia('(max-width: 599px)');
  const QA_PH_LONG = qaInput.placeholder;
  const syncQaPlaceholder = () => { qaInput.placeholder = mqNarrow.matches ? 'Thêm việc… vd: Gọi khách 9h mai' : QA_PH_LONG; };
  syncQaPlaceholder();
  mqNarrow.addEventListener?.('change', syncQaPlaceholder);
  disposers.push(() => mqNarrow.removeEventListener?.('change', syncQaPlaceholder));

  /* ================================================================ */
  /* Filtering / grouping                                              */
  /* ================================================================ */

  function inScope(t, scope = f.scope) {
    if (scope === 'open') return isOpen(t);
    if (scope === 'in_progress') return t.status === 'in_progress';
    if (scope === 'done') return t.status === 'completed';
    if (scope === 'cancelled') return t.status === 'cancelled';
    return true;
  }
  function dueMatch(t) {
    const t0 = today();
    switch (f.due) {
      case 'overdue': return isOpen(t) && t.due_date && t.due_date < t0;
      case 'today': return t.due_date === t0;
      case 'tomorrow': return t.due_date === addDays(t0, 1);
      case 'week': return t.due_date && t.due_date >= t0 && t.due_date <= addDays(t0, 6);
      case 'month': return t.due_date && t.due_date.slice(0, 7) === t0.slice(0, 7);
      case 'none': return !t.due_date;
      default: return true;
    }
  }
  function matches(t, { ignoreScope = false } = {}) {
    if (!ignoreScope && !inScope(t)) return false;
    if (f.cat && (f.cat === 'none' ? t.category_id : t.category_id !== f.cat)) return false;
    if (f.prio && t.priority !== f.prio) return false;
    if (f.tag && !(t.tags || []).some((g) => g.toLocaleLowerCase('vi') === f.tag.toLocaleLowerCase('vi'))) return false;
    if (!dueMatch(t)) return false;
    const q = normalizeVi(f.q);
    if (q) {
      const hay = normalizeVi(`${t.title} ${t.description || ''} ${(t.tags || []).join(' ')}`);
      if (!q.split(' ').every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function sortRows(rows) {
    const by = f.scope === 'done' && f.sort === 'due'
      ? (a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')
      : SORTERS[f.sort] || SORTERS.due;
    return rows.sort(by);
  }
  const visible = (opts) => sortRows(tasks.filter((t) => matches(t, opts)));
  const hasFilters = () => Boolean(f.q || f.cat || f.prio || f.tag || f.due);

  function dueGroups(rows) {
    const t0 = today(), t1 = addDays(t0, 1), wkEnd = endOfWeek(t0);
    const G = {
      overdue: { key: 'overdue', title: 'Quá hạn', tone: 'danger', rows: [] },
      past: { key: 'past', title: 'Đã qua', rows: [] },
      today: { key: 'today', title: 'Hôm nay', sub: fmtDay(t0, 'weekday'), tone: 'accent', rows: [] },
      tomorrow: { key: 'tomorrow', title: 'Ngày mai', sub: fmtDay(t1, 'weekday'), rows: [] },
      week: { key: 'week', title: 'Tuần này', sub: `đến ${fmtDay(wkEnd)}`, rows: [] },
      later: { key: 'later', title: 'Sau này', rows: [] },
      none: { key: 'none', title: 'Không có hạn', rows: [] },
    };
    for (const t of rows) {
      const d = t.due_date;
      if (!d) G.none.rows.push(t);
      else if (d < t0) (isOpen(t) ? G.overdue : G.past).rows.push(t);
      else if (d === t0) G.today.rows.push(t);
      else if (d === t1) G.tomorrow.rows.push(t);
      else if (d <= wkEnd) G.week.rows.push(t);
      else G.later.rows.push(t);
    }
    return Object.values(G).filter((g) => g.rows.length).map((g) => ({ ...g, key: `due:${g.key}` }));
  }
  function doneGroups(rows) {
    const t0 = today(), wk = startOfWeek(t0);
    const G = [
      { key: 'done:today', title: 'Xong hôm nay', tone: 'success', rows: [] },
      { key: 'done:week', title: 'Tuần này', rows: [] },
      { key: 'done:older', title: 'Trước đó', rows: [] },
    ];
    for (const t of rows) {
      const d = t.completed_at ? dayOf(t.completed_at) : '';
      (d === t0 ? G[0] : d >= wk ? G[1] : G[2]).rows.push(t);
    }
    return G.filter((g) => g.rows.length);
  }
  function categoryGroups(rows) {
    const cats = store.categoriesOf('task');
    const map = new Map(cats.map((c) => [c.id, { key: `cat:${c.id}`, title: c.name, color: c.color, rows: [] }]));
    const none = { key: 'cat:none', title: 'Chưa phân loại', color: 'var(--ink-4)', rows: [] };
    for (const t of rows) (map.get(t.category_id) || none).rows.push(t);
    return [...map.values(), none].filter((g) => g.rows.length);
  }
  function priorityGroups(rows) {
    return PRIO_ORDER.map((p) => ({ key: `prio:${p}`, title: TASK_PRIORITY[p], prio: p, tone: p === 'urgent' ? 'danger' : '', rows: rows.filter((t) => t.priority === p) })).filter((g) => g.rows.length);
  }

  /* ================================================================ */
  /* Templates                                                         */
  /* ================================================================ */

  const runningId = () => store.get().runningEntry?.task_id || null;

  function timeChip(t) {
    const est = Number(t.estimated_minutes) || 0, act = Number(t.actual_minutes) || 0;
    if (!est && !act) return '';
    const over = est && act > est;
    return html`<span class="tk-time-chip ${over ? 'is-over' : ''}" title="Thực tế / ước tính">${icon('clock')}${act ? minutes(act) : '0p'}${est ? html`<span class="faint">/${minutes(est)}</span>` : ''}</span>`;
  }

  function firstLine(desc) {
    if (!desc) return '';
    const line = desc.split('\n').map((l) => l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,3}\s+|>\s?)/, '').replace(/[*_`~]/g, '').trim()).find(Boolean);
    return line || '';
  }

  function rowTpl(t) {
    const done = t.status === 'completed';
    const cancelled = t.status === 'cancelled';
    const running = runningId() === t.id;
    const sel = selected.has(t.id);
    const ck = checklistStats(t.description || '');
    const pending = String(t.id).startsWith('tmp-');
    const desc = firstLine(t.description);
    return html`
      <li class="tk-row ${done ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''} ${sel ? 'is-selected' : ''} ${cursorId === t.id ? 'is-cursor' : ''} ${pending ? 'is-pending' : ''}" data-id="${t.id}" data-p="${t.priority}" tabindex="-1" aria-selected="${sel}">
        <label class="tk-sel" title="Chọn (X)"><input type="checkbox" data-act="select" ${sel ? raw('checked') : ''} aria-label="Chọn: ${t.title}" /><span aria-hidden="true">${icon('check')}</span></label>
        <button type="button" class="tick tk-tick" role="checkbox" aria-checked="${done}" data-act="toggle" data-p="${t.priority}" aria-label="${done ? 'Mở lại' : 'Hoàn thành'}: ${t.title}" ${pending ? raw('disabled') : ''}>${icon('check')}</button>
        <div class="tk-row__main" data-act="open">
          <div class="tk-row__title"><span class="tk-row__text">${t.title}</span>${t.recurrence ? html`<span class="tk-rec" title="Lặp lại: ${RECURRENCE_LABELS[t.recurrence] || t.recurrence}">${icon('repeat')}<span>${RECURRENCE_SHORT[t.recurrence] || ''}</span></span>` : ''}</div>
          ${desc ? html`<div class="tk-row__desc">${desc}</div>` : ''}
          <div class="tk-row__meta">
            ${t.status === 'in_progress' ? html`<span class="tk-state">Đang làm</span>` : ''}
            ${cancelled ? statusBadge('cancelled') : ''}
            ${dueLabel(t.due_date, t.status)}
            ${t.priority !== 'medium' ? prio(t.priority) : ''}
            ${t.category_id ? catLabel(t.category_id) : ''}
            ${timeChip(t)}
            ${ck.total ? html`<span class="tk-ck ${ck.done === ck.total ? 'is-full' : ''}" title="Việc con">${icon('checkSquare')}${ck.done}/${ck.total}</span>` : ''}
            ${(t.tags || []).slice(0, 3).map((g) => html`<button type="button" class="tag tk-tag" data-tag="${g}" title="Lọc theo thẻ ${g}">${g}</button>`)}
            ${running ? html`<span class="tk-running"><i></i>Đang bấm giờ</span>` : ''}
          </div>
        </div>
        <div class="tk-row__side">
          ${!done && !cancelled && !pending ? html`<button type="button" class="icon-btn icon-btn--sm ${running ? 'is-running' : ''}" data-act="${running ? 'pause' : 'timer'}" title="${running ? 'Tạm dừng bấm giờ' : 'Bấm giờ'}" aria-label="${running ? 'Tạm dừng bấm giờ' : 'Bấm giờ'}">${icon(running ? 'pause' : 'play')}</button>` : ''}
          <button type="button" class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thêm thao tác" aria-haspopup="menu" ${pending ? raw('disabled') : ''}>${icon('more')}</button>
        </div>
      </li>`;
  }

  function groupTpl(g) {
    const isCollapsed = collapsed.has(g.key);
    const est = g.rows.filter(isOpen).reduce((s, t) => s + (Number(t.estimated_minutes) || 0), 0);
    return html`
      <section class="tk-group ${isCollapsed ? 'is-collapsed' : ''}" data-group="${g.key}">
        <h2 class="tk-group__head">
          <button type="button" class="tk-group__btn" data-act="collapse" aria-expanded="${!isCollapsed}">
            <span class="tk-group__chev">${icon('chevronDown')}</span>
            ${g.color ? html`<span class="cat__dot" style="--c:${g.color}"></span>` : ''}
            ${g.prio ? html`<span class="prio" data-p="${g.prio}"><span class="prio__bars"><i></i><i></i><i></i></span></span>` : ''}
            <span class="tk-group__title ${g.tone ? `tone-${g.tone}` : ''}">${g.title}</span>
            ${g.sub ? html`<span class="tk-group__sub">${g.sub}</span>` : ''}
            <span class="tk-group__count">${num(g.rows.length)}</span>
            ${est ? html`<span class="tk-group__est">${icon('hourglass')}${minutes(est)}</span>` : ''}
          </button>
        </h2>
        <ul class="tk-list" ${isCollapsed ? raw('hidden') : ''}>${g.rows.map(rowTpl)}</ul>
      </section>`;
  }

  function cardTpl(t) {
    const done = t.status === 'completed';
    const sel = selected.has(t.id);
    const running = runningId() === t.id;
    const est = Number(t.estimated_minutes) || 0, act = Number(t.actual_minutes) || 0;
    const ck = checklistStats(t.description || '');
    const pending = String(t.id).startsWith('tmp-');
    return html`
      <article class="tk-card ${done ? 'is-done' : ''} ${sel ? 'is-selected' : ''} ${cursorId === t.id ? 'is-cursor' : ''} ${pending ? 'is-pending' : ''}" data-id="${t.id}" data-p="${t.priority}" data-act="open" tabindex="-1" aria-selected="${sel}" aria-roledescription="thẻ kéo được">
        <div class="tk-card__top">
          <button type="button" class="tick tk-tick" role="checkbox" aria-checked="${done}" data-act="toggle" data-p="${t.priority}" aria-label="${done ? 'Mở lại' : 'Hoàn thành'}: ${t.title}" ${pending ? raw('disabled') : ''}>${icon('check')}</button>
          <div class="tk-card__title">${t.title}${t.recurrence ? html` <span class="tk-rec" title="${RECURRENCE_LABELS[t.recurrence] || ''}">${icon('repeat')}</span>` : ''}</div>
          <button type="button" class="icon-btn icon-btn--sm tk-card__more" data-act="menu" aria-label="Thêm thao tác" aria-haspopup="menu" ${pending ? raw('disabled') : ''}>${icon('more')}</button>
        </div>
        <div class="tk-card__meta">
          ${dueLabel(t.due_date, t.status)}
          ${t.priority !== 'medium' ? prio(t.priority) : ''}
          ${ck.total ? html`<span class="tk-ck">${icon('checkSquare')}${ck.done}/${ck.total}</span>` : ''}
          ${running ? html`<span class="tk-running"><i></i>Đang chạy</span>` : ''}
        </div>
        ${t.category_id || est || act ? html`<div class="tk-card__foot">${t.category_id ? catLabel(t.category_id) : html`<span></span>`}${timeChip(t)}</div>` : ''}
        ${est ? html`<div class="tk-card__bar ${act > est ? 'is-over' : ''}"><span style="width:${Math.min(100, (act / est) * 100)}%"></span></div>` : ''}
      </article>`;
  }

  /* ================================================================ */
  /* Rendering                                                         */
  /* ================================================================ */

  function render() {
    if (destroyed) return;
    syncControls();
    renderLedger();
    renderScopes();
    renderChips();
    renderBulk();
    root.querySelector('.tk-page').classList.toggle('is-selecting', selecting || selected.size > 0);
    root.querySelector('.tk-page').dataset.view = f.view;
    if (loadError) { mount($('[data-body]'), errorState(loadError)); return; }
    if (!loaded) { renderSkeleton(); return; }

    // keep focus on the same row/control across re-renders
    const ae = document.activeElement;
    const focusId = ae && root.contains(ae) ? ae.closest('[data-id]')?.dataset.id : null;
    const focusAct = focusId ? ae.dataset.act || (ae.matches('[data-id]') ? '__row' : null) : null;

    if (!tasks.length) renderFirstRun();
    else if (f.view === 'board') renderBoard();
    else renderList();

    if (focusId) {
      const row = root.querySelector(`[data-body] [data-id="${CSS.escape(focusId)}"]`);
      const target = focusAct === '__row' ? row : row?.querySelector(`[data-act="${focusAct}"]`);
      (target || row)?.focus({ preventScroll: true });
    }
  }

  function renderSkeleton() {
    if (f.view === 'board') {
      mount($('[data-body]'), html`<div class="tk-board" aria-busy="true" aria-label="Đang tải">${BOARD_COLS.map((s, i) => html`
        <section class="tk-col"><header class="tk-col__head"><span class="badge badge--${TASK_STATUS[s].badge}">${TASK_STATUS[s].label}</span></header>
          <div class="tk-col__list">${Array.from({ length: 3 - i % 2 }, () => html`<div class="tk-card tk-card--sk"><div class="skeleton sk-line" style="width:80%"></div><div class="skeleton sk-line" style="width:45%;height:8px"></div></div>`)}</div></section>`)}</div>`);
    } else {
      mount($('[data-body]'), html`<div class="sheet tk-sheet">${loadingRows(7)}</div>`);
    }
  }

  function renderFirstRun() {
    mount($('[data-body]'), html`<div class="sheet tk-sheet">${emptyState({
      art: 'tasks',
      title: 'Bắt đầu danh sách của bạn',
      text: html`Gõ vào ô phía trên như đang nói chuyện — ví dụ “<span class="mono">${QA_EXAMPLE}</span>”. Ngày, ưu tiên, thẻ, thời lượng và lặp lại được nhận diện tự động.`,
      action: html`<div class="row-wrap" style="justify-content:center"><button type="button" class="btn btn--primary" data-act="try-example">${icon('sparkle')} Thử câu ví dụ</button><button type="button" class="btn" data-act="new">Dùng biểu mẫu</button></div>`,
    })}</div>`);
  }

  function emptyFor() {
    if (hasFilters()) {
      return emptyState({ small: true, art: 'tasks', title: 'Không có việc phù hợp', text: 'Không việc nào khớp với bộ lọc hiện tại. Thử nới bớt điều kiện.', action: html`<button type="button" class="btn btn--sm" data-act="clear">${icon('x')} Xóa bộ lọc</button>` });
    }
    const E = {
      open: ['Đã xong hết việc!', 'Không còn việc nào đang mở. Nghỉ ngơi một chút hoặc lên kế hoạch cho ngày mai.', 'target'],
      in_progress: ['Chưa có việc đang làm', 'Bấm giờ một việc hoặc kéo nó sang cột “Đang làm” trên Bảng.', 'clock'],
      done: ['Chưa hoàn thành việc nào', 'Đánh dấu ✓ một việc và nó sẽ xuất hiện ở đây.', 'tasks'],
      cancelled: ['Không có việc bị hủy', 'Những việc bạn quyết định không làm nữa sẽ nằm ở đây.', 'tasks'],
      all: ['Chưa có công việc', 'Thêm việc đầu tiên bằng ô nhập nhanh ở trên.', 'tasks'],
    }[f.scope];
    return emptyState({ small: true, art: E[2], title: E[0], text: E[1] });
  }

  function renderList() {
    const rows = visible();
    if (!rows.length) { mount($('[data-body]'), html`<div class="sheet tk-sheet">${emptyFor()}</div>`); return; }
    let groups;
    if (f.view === 'group') groups = f.group === 'priority' ? priorityGroups(rows) : categoryGroups(rows);
    else if (f.scope === 'done') groups = doneGroups(rows);
    else groups = dueGroups(rows);
    const total = tasks.filter((t) => inScope(t)).length;
    mount($('[data-body]'), html`
      <div class="sheet tk-sheet">
        ${groups.map(groupTpl)}
        <div class="sheet__foot tk-foot"><span class="mono">${num(rows.length)} / ${num(total)} công việc</span><span class="tk-hide-sm"><kbd>J</kbd><kbd>K</kbd> di chuyển · <kbd>Space</kbd> hoàn thành · <kbd>Enter</kbd> mở · <kbd>?</kbd> trợ giúp</span></div>
      </div>`);
  }

  function renderBoard() {
    const rows = visible({ ignoreScope: true }).filter((t) => t.status !== 'cancelled');
    mount($('[data-body]'), html`
      <div class="tk-board" data-board>
        ${BOARD_COLS.map((s) => {
          let items = rows.filter((t) => t.status === s);
          let more = 0;
          if (s === 'completed') {
            items = items.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
            more = Math.max(0, items.length - BOARD_DONE_LIMIT);
            items = items.slice(0, BOARD_DONE_LIMIT);
          }
          const est = items.reduce((sum, t) => sum + (Number(t.estimated_minutes) || 0), 0);
          return html`
            <section class="tk-col tk-col--${s}" data-col="${s}" aria-label="${TASK_STATUS[s].label}">
              <header class="tk-col__head">
                <span class="tk-col__dot"></span><span class="tk-col__title">${TASK_STATUS[s].label}</span>
                <span class="tk-col__count mono">${num(items.length + more)}</span>
                ${est && s !== 'completed' ? html`<span class="tk-col__est mono">${minutes(est)}</span>` : ''}
              </header>
              <div class="tk-col__list" data-drop="${s}">
                ${items.map(cardTpl)}
                ${!items.length ? html`<div class="tk-col__empty">${s === 'todo' ? 'Không còn việc chờ — thêm việc ở ô phía trên.' : s === 'in_progress' ? 'Kéo một thẻ vào đây khi bắt đầu làm.' : 'Thả thẻ vào đây khi xong việc.'}</div>` : ''}
                ${more ? html`<button type="button" class="tk-col__more" data-act="see-done">+ ${num(more)} việc đã xong khác · Xem tất cả</button>` : ''}
              </div>
              ${s === 'todo' ? html`<button type="button" class="btn btn--ghost btn--sm btn--block tk-col__add" data-act="focus-qa">${icon('plus')} Thêm việc</button>` : ''}
            </section>`;
        })}
      </div>
      <p class="tk-board-hint">${icon('info')} Kéo thả thẻ để đổi trạng thái. Trên điện thoại: nhấn giữ thẻ rồi kéo, hoặc dùng menu ⋯.</p>`);
  }

  function renderLedger() {
    const t0 = today();
    const open = tasks.filter(isOpen);
    const stats = [
      { k: 'open', label: 'Đang mở', n: open.length, apply: { scope: 'open', due: '' } },
      { k: 'overdue', label: 'Quá hạn', n: open.filter((t) => t.due_date && t.due_date < t0).length, tone: 'danger', apply: { scope: 'open', due: 'overdue' } },
      { k: 'today', label: 'Hôm nay', n: open.filter((t) => t.due_date === t0).length, tone: 'accent', apply: { scope: 'open', due: 'today' } },
      { k: 'doing', label: 'Đang làm', n: tasks.filter((t) => t.status === 'in_progress').length, apply: { scope: 'in_progress', due: '' } },
      { k: 'done', label: 'Xong hôm nay', n: tasks.filter((t) => t.status === 'completed' && t.completed_at && dayOf(t.completed_at) === t0).length, tone: 'success', apply: { scope: 'done', due: '' } },
    ];
    const activeKey = stats.find((s) => s.apply.scope === f.scope && s.apply.due === f.due && f.view !== 'board')?.k;
    mount($('[data-ledger]'), loaded ? html`${stats.map((s) => html`
      <button type="button" class="tk-ledger__item ${s.tone ? `tone-${s.tone}` : ''} ${activeKey === s.k ? 'is-active' : ''} ${s.n ? '' : 'is-zero'}" data-ledger="${s.k}">
        <span class="tk-ledger__n">${num(s.n)}</span><span class="tk-ledger__l">${s.label}</span>
      </button>`)}` : html`${stats.map(() => html`<div class="tk-ledger__item"><span class="skeleton" style="width:32px;height:28px;display:block"></span><span class="skeleton sk-line" style="width:60px"></span></div>`)}`);
    ledgerState.stats = stats;
  }
  const ledgerState = { stats: [] };

  function renderScopes() {
    const box = $('[data-scopes]');
    box.hidden = f.view === 'board';
    mount(box, html`${SCOPES.map((s) => html`<button type="button" role="tab" data-scope="${s.id}" aria-selected="${f.scope === s.id}">${s.label}<span class="count">${loaded ? num(tasks.filter((t) => inScope(t, s.id) && matches(t, { ignoreScope: true })).length) : '·'}</span></button>`)}`);
  }

  function renderChips() {
    const chips = [];
    if (f.q) chips.push({ k: 'q', label: html`Tìm: “${f.q}”` });
    if (f.cat) chips.push({ k: 'cat', label: html`Danh mục: ${f.cat === 'none' ? 'Chưa phân loại' : store.categoryById(f.cat)?.name || '—'}` });
    if (f.prio) chips.push({ k: 'prio', label: html`Ưu tiên: ${TASK_PRIORITY[f.prio]}` });
    if (f.due) chips.push({ k: 'due', label: html`Hạn: ${DUES.find((d) => d.value === f.due)?.label}` });
    if (f.tag) chips.push({ k: 'tag', label: html`#${f.tag}` });
    const n = chips.filter((c) => c.k !== 'q').length;
    $('[data-fcount]').textContent = n ? String(n) : '';
    mount($('[data-chips]'), chips.length ? html`
      <span class="eyebrow">Đang lọc</span>
      ${chips.map((c) => html`<button type="button" class="tk-fchip" data-unfilter="${c.k}" aria-label="Bỏ lọc">${c.label}${icon('x')}</button>`)}
      <button type="button" class="btn btn--ghost btn--sm" data-act="clear">Xóa tất cả</button>` : '');
  }

  function syncControls() {
    // categories / tags lists can change between renders
    const catSel = $('select[data-f="cat"]');
    catSel.innerHTML = String(html`${categoryOptions('task', { all: 'Mọi danh mục', none: 'Chưa phân loại' }).map((o) => html`<option value="${o.value}">${o.label}</option>`)}`);
    const tags = [...new Set(tasks.flatMap((t) => t.tags || []).map((g) => g.toLocaleLowerCase('vi')))].sort((a, b) => a.localeCompare(b, 'vi'));
    if (f.tag && !tags.includes(f.tag.toLocaleLowerCase('vi'))) tags.unshift(f.tag);
    const tagSel = $('select[data-f="tag"]');
    tagSel.innerHTML = String(html`<option value="">Mọi thẻ</option>${tags.map((g) => html`<option value="${g}">#${g}</option>`)}`);
    tagSel.disabled = !tags.length;
    root.querySelectorAll('select[data-f]').forEach((s) => { s.value = f[s.dataset.f]; });
    const q = $('[data-f="q"]');
    if (document.activeElement !== q) q.value = f.q;
    root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === f.view)));
    $('.tk-groupby').hidden = f.view !== 'group';
    $('[data-act="selecting"]').setAttribute('aria-pressed', String(selecting || selected.size > 0));
    $('[data-filters]').classList.toggle('is-open', filtersOpen);
    $('[data-act="filters"]').setAttribute('aria-expanded', String(filtersOpen));
  }

  function renderBulk() {
    const host = $('[data-bulk]');
    if (!selected.size) { host.innerHTML = ''; return; }
    const n = selected.size;
    const pool = f.view === 'board' ? visible({ ignoreScope: true }) : visible();
    const allSelected = pool.length && pool.every((t) => selected.has(t.id));
    mount(host, html`
      <div class="tk-bulk" role="toolbar" aria-label="Thao tác với ${n} việc đã chọn">
        <span class="tk-bulk__count"><strong class="mono">${num(n)}</strong> đã chọn</span>
        <button type="button" class="tk-bulk__btn tk-bulk__all" data-bulk="${allSelected ? 'none' : 'all'}">${allSelected ? 'Bỏ chọn' : `Chọn tất cả (${num(pool.length)})`}</button>
        <span class="tk-bulk__sep" aria-hidden="true"></span>
        <button type="button" class="tk-bulk__btn" data-bulk="complete" title="Hoàn thành">${icon('checkCircle')}<span>Hoàn thành</span></button>
        <button type="button" class="tk-bulk__btn" data-bulk="prio" title="Đổi ưu tiên" aria-haspopup="menu">${icon('flag')}<span>Ưu tiên</span></button>
        <button type="button" class="tk-bulk__btn" data-bulk="cat" title="Đổi danh mục" aria-haspopup="menu">${icon('folder')}<span>Danh mục</span></button>
        <button type="button" class="tk-bulk__btn" data-bulk="due" title="Đặt hạn" aria-haspopup="menu">${icon('calendar')}<span>Hạn</span></button>
        <button type="button" class="tk-bulk__btn tk-bulk__btn--danger" data-bulk="delete" title="Xóa">${icon('trash')}<span>Xóa</span></button>
        <button type="button" class="tk-bulk__btn tk-bulk__close" data-bulk="clear" aria-label="Bỏ chọn (Esc)">${icon('x')}</button>
      </div>`);
  }

  /* ================================================================ */
  /* Data + mutations                                                  */
  /* ================================================================ */

  const byId = (id) => tasks.find((t) => t.id === id);

  async function load({ silent = false } = {}) {
    if (!silent) { loaded = false; loadError = null; render(); }
    try {
      const rows = await listTasks({ limit: 2000 });
      if (destroyed) return;
      // keep optimistic temp rows that are still in flight
      tasks = [...tasks.filter((t) => String(t.id).startsWith('tmp-')), ...rows];
      loaded = true;
      loadError = null;
      for (const id of [...selected]) if (!byId(id)) selected.delete(id);
    } catch (err) {
      if (silent && loaded) { toast.error(err); return; }
      loadError = err;
    }
    render();
  }

  function replaceLocal(saved, { fromDrawer = false } = {}) {
    if (!saved) return;
    const i = tasks.findIndex((t) => t.id === saved.id);
    if (i >= 0) tasks[i] = saved; else tasks.unshift(saved);
    if (!fromDrawer && drawer?.taskId() === saved.id) drawer.update(saved);
  }
  function removeLocal(id) {
    tasks = tasks.filter((t) => t.id !== id);
    selected.delete(id);
    if (cursorId === id) cursorId = null;
    if (drawer?.taskId() === id) drawer.close();
  }

  async function changeStatus(t, status, { undo = true, animateEl = null } = {}) {
    if (!t || t.status === status) return;
    const prev = { ...t };
    const req = setTaskStatus(t.id, status);
    req.catch(() => {});
    if (animateEl && status === 'completed' && !reduced()) {
      animateEl.classList.add('is-completing');
      await wait(620);
    }
    replaceLocal({ ...t, status, completed_at: status === 'completed' ? new Date().toISOString() : null });
    render();
    try {
      const saved = await req;
      replaceLocal(saved);
      render();
      if (status === 'completed') {
        if (runningId() === t.id) timer.stop().catch(() => {});
        if (prev.recurrence) load({ silent: true });
        if (undo) {
          toast(prev.recurrence ? `Đã hoàn thành “${t.title}” · đã lên lịch lần kế tiếp.` : `Đã hoàn thành “${t.title}”.`, {
            action: { label: 'Hoàn tác', onClick: () => changeStatus(byId(t.id) || saved, prev.status, { undo: false }) },
          });
        }
      }
    } catch (err) {
      replaceLocal(prev);
      render();
      toast.error(err);
    }
  }

  async function patchTask(t, patch, message) {
    const prev = { ...t };
    replaceLocal({ ...t, ...patch });
    render();
    try {
      replaceLocal(await updateTask(t.id, patch));
      render();
      if (message) toast(message, { action: { label: 'Hoàn tác', onClick: () => patchTask(byId(t.id) || t, pickKeys(prev, Object.keys(patch))) } });
    } catch (err) {
      replaceLocal(prev);
      render();
      toast.error(err);
    }
  }
  const pickKeys = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

  async function removeTask(t) {
    if ((Number(t.actual_minutes) || 0) > 0) {
      const ok = await confirmDialog({ title: 'Xóa công việc này?', message: `“${t.title}” đã có ${minutes(t.actual_minutes)} bấm giờ. Các phiên tính giờ vẫn được giữ nhưng sẽ không còn gắn với công việc.` });
      if (!ok) return;
    }
    const snap = { ...t };
    const idx = tasks.findIndex((x) => x.id === t.id);
    removeLocal(t.id);
    render();
    try {
      await deleteTask(t.id);
      toast(`Đã xóa “${t.title}”.`, { duration: 6000, action: { label: 'Hoàn tác', onClick: () => restoreMany([snap]) } });
    } catch (err) {
      tasks.splice(Math.max(0, idx), 0, snap);
      render();
      toast.error(err);
    }
  }

  async function restoreMany(snaps) {
    try {
      // a completed recurring task would spawn a new occurrence on insert → drop recurrence
      const restored = await Promise.all(snaps.map((s) => restoreTask({ ...s, recurrence: s.status === 'completed' ? null : s.recurrence })));
      restored.forEach((r) => replaceLocal(r));
      render();
      toast(snaps.length > 1 ? `Đã khôi phục ${snaps.length} công việc.` : 'Đã khôi phục công việc.');
    } catch (err) {
      toast.error(err);
      load({ silent: true });
    }
  }

  async function quickAdd(text, { full = false } = {}) {
    const raw0 = text.trim();
    if (!raw0) return;
    const p = parseTaskInput(raw0, { categories: store.get().categories });
    const ctx = contextDefaults();
    const payload = {
      title: p.title.slice(0, 200),
      priority: p.priority || 'medium',
      due_date: p.due_date || ctx.due_date || null,
      category_id: p.category_id || ctx.category_id || null,
      tags: p.tags,
      estimated_minutes: p.estimated_minutes,
      status: ctx.status || 'todo',
    };
    if (p.recurrence) payload.recurrence = p.recurrence;
    if (full) {
      openTaskForm({ defaults: payload, onSaved: (s) => { replaceLocal(s); render(); } });
      qaInput.value = '';
      renderPreview();
      return;
    }
    const temp = { ...payload, id: `tmp-${Date.now()}`, description: null, actual_minutes: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: null };
    tasks.unshift(temp);
    qaInput.value = '';
    renderPreview();
    render();
    try {
      const saved = await createTask(payload);
      tasks = tasks.filter((t) => t.id !== temp.id);
      replaceLocal(saved);
      cursorId = saved.id;
      render();
      flashRow(saved.id);
      const shown = matches(saved, { ignoreScope: f.view === 'board' });
      toast(shown ? `Đã thêm “${saved.title}”.` : `Đã thêm “${saved.title}” — đang bị ẩn bởi bộ lọc.`, {
        action: { label: 'Mở', onClick: () => openDrawer(byId(saved.id) || saved) },
      });
    } catch (err) {
      tasks = tasks.filter((t) => t.id !== temp.id);
      render();
      qaInput.value = raw0;
      renderPreview();
      toast.error(err);
    }
  }

  /** New tasks inherit the context the user is looking at (Things-style). */
  function contextDefaults() {
    const d = {};
    if (f.cat && f.cat !== 'none') d.category_id = f.cat;
    if (f.due === 'today') d.due_date = today();
    if (f.due === 'tomorrow') d.due_date = addDays(today(), 1);
    if (f.scope === 'in_progress' && f.view !== 'board') d.status = 'in_progress';
    return d;
  }

  function flashRow(id) {
    const el = root.querySelector(`[data-body] [data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add('is-new');
    el.scrollIntoView({ block: 'nearest', behavior: reduced() ? 'auto' : 'smooth' });
    setTimeout(() => el.classList.remove('is-new'), 1400);
  }

  /* ---------- bulk ---------- */

  const selectedTasks = () => [...selected].map(byId).filter(Boolean);

  async function bulkPatch(patch, label) {
    const items = selectedTasks();
    if (!items.length) return;
    const prev = items.map((t) => ({ ...t }));
    items.forEach((t) => replaceLocal({ ...t, ...patch }));
    render();
    try {
      const rows = await bulkUpdateTasks(items.map((t) => t.id), patch);
      rows.forEach((r) => replaceLocal(r));
      render();
      toast(`${label} · ${items.length} việc.`, {
        action: { label: 'Hoàn tác', onClick: () => undoBulk(prev, Object.keys(patch)) },
      });
    } catch (err) {
      prev.forEach((t) => replaceLocal(t));
      render();
      toast.error(err);
    }
  }

  async function undoBulk(prev, keys) {
    try {
      const rows = await Promise.all(prev.map((t) => (keys.length === 1 && keys[0] === 'status' ? setTaskStatus(t.id, t.status) : updateTask(t.id, pickKeys(t, keys)))));
      rows.forEach((r) => replaceLocal(r));
      render();
      toast('Đã hoàn tác.');
    } catch (err) {
      toast.error(err);
      load({ silent: true });
    }
  }

  async function bulkComplete() {
    const items = selectedTasks().filter((t) => t.status !== 'completed');
    if (!items.length) { toast.info('Các việc đã chọn đều đã hoàn thành.'); return; }
    const prev = items.map((t) => ({ ...t }));
    const now = new Date().toISOString();
    items.forEach((t) => replaceLocal({ ...t, status: 'completed', completed_at: now }));
    selected.clear();
    render();
    try {
      const rows = await bulkSetTaskStatus(items.map((t) => t.id), 'completed');
      rows.forEach((r) => replaceLocal(r));
      render();
      if (items.some((t) => runningId() === t.id)) timer.stop().catch(() => {});
      if (items.some((t) => t.recurrence)) load({ silent: true });
      toast(`Đã hoàn thành ${items.length} việc.`, { action: { label: 'Hoàn tác', onClick: () => undoBulk(prev, ['status']) } });
    } catch (err) {
      prev.forEach((t) => replaceLocal(t));
      render();
      toast.error(err);
    }
  }

  async function bulkDelete() {
    const items = selectedTasks();
    if (!items.length) return;
    const tracked = items.filter((t) => Number(t.actual_minutes) > 0).length;
    const ok = await confirmDialog({
      title: `Xóa ${items.length} công việc?`,
      message: `Các việc đã chọn sẽ bị xóa.${tracked ? ` ${tracked} việc có giờ đã bấm — các phiên tính giờ vẫn được giữ nhưng không còn gắn với công việc.` : ''} Bạn có thể hoàn tác ngay sau đó.`,
      confirmLabel: `Xóa ${items.length} việc`,
    });
    if (!ok) return;
    const snaps = items.map((t) => ({ ...t }));
    items.forEach((t) => removeLocal(t.id));
    selected.clear();
    render();
    try {
      await bulkDeleteTasks(snaps.map((t) => t.id));
      toast(`Đã xóa ${snaps.length} công việc.`, { duration: 7000, action: { label: 'Hoàn tác', onClick: () => restoreMany(snaps) } });
    } catch (err) {
      tasks = [...snaps, ...tasks];
      render();
      toast.error(err);
    }
  }

  function pickDate(title, initial, onPick) {
    openModal({
      eyebrow: 'Chọn ngày',
      title,
      size: 'narrow',
      body: html`<div class="form">${field({ label: 'Hạn chót', name: 'due', control: input('due', initial || today(), 'type="date" required') })}</div>`,
      submitLabel: 'Áp dụng',
      validate: (v) => (v.due ? {} : { due: 'Hãy chọn một ngày.' }),
      onSubmit: (v) => { onPick(v.due); },
    });
  }

  function dueMenuItems(apply) {
    const t0 = today();
    const nextMon = addDays(startOfWeek(t0), 7);
    return [
      { label: `Hôm nay · ${fmtDay(t0)}`, icon: 'sun', onClick: () => apply(t0) },
      { label: `Ngày mai · ${fmtDay(addDays(t0, 1))}`, icon: 'calendar', onClick: () => apply(addDays(t0, 1)) },
      { label: `Tuần sau · ${fmtDay(nextMon)}`, icon: 'arrowRight', onClick: () => apply(nextMon) },
      { label: 'Chọn ngày…', icon: 'calendar', onClick: () => pickDate('Đặt hạn chót', null, apply) },
      'sep',
      { label: 'Bỏ hạn chót', icon: 'x', onClick: () => apply(null) },
    ];
  }

  function onBulk(act, el) {
    if (act === 'clear' || act === 'none') { selected.clear(); selecting = false; render(); return; }
    if (act === 'all') { (f.view === 'board' ? visible({ ignoreScope: true }) : visible()).forEach((t) => selected.add(t.id)); render(); return; }
    if (act === 'complete') return bulkComplete();
    if (act === 'delete') return bulkDelete();
    if (act === 'prio') {
      return popMenu(el, PRIO_ORDER.map((p) => ({ label: TASK_PRIORITY[p], icon: 'flag', onClick: () => bulkPatch({ priority: p }, `Ưu tiên → ${TASK_PRIORITY[p]}`) })));
    }
    if (act === 'cat') {
      return popMenu(el, [
        ...store.categoriesOf('task').map((c) => ({ label: c.name, icon: 'folder', onClick: () => bulkPatch({ category_id: c.id }, `Danh mục → ${c.name}`) })),
        'sep',
        { label: 'Bỏ danh mục', icon: 'x', onClick: () => bulkPatch({ category_id: null }, 'Đã bỏ danh mục') },
      ]);
    }
    if (act === 'due') return popMenu(el, dueMenuItems((d) => bulkPatch({ due_date: d }, d ? `Hạn → ${relDay(d)}` : 'Đã bỏ hạn chót')));
  }

  /* ---------- selection ---------- */

  const orderIds = () => [...root.querySelectorAll('[data-body] [data-id]')].filter((el) => el.offsetParent !== null).map((el) => el.dataset.id).filter((id) => !id.startsWith('tmp-'));

  function toggleSelect(id, { range = false } = {}) {
    if (range && anchorId && anchorId !== id) {
      const ids = orderIds();
      const a = ids.indexOf(anchorId), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => selected.add(x));
        render();
        return;
      }
    }
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchorId = id;
    render();
  }

  /* ---------- drawer ---------- */

  function openDrawer(t, opts = {}) {
    if (!t || String(t.id).startsWith('tmp-')) return;
    cursorId = t.id;
    setQuery({ id: t.id });
    drawer = openTaskDrawer({
      task: t,
      focus: opts.focus,
      onSaved: (s, meta = {}) => {
        replaceLocal(s, { fromDrawer: true });
        render();
        if (meta.serverConfirmed && meta.prev && meta.prev.status !== 'completed' && s.status === 'completed' && s.recurrence) {
          toast(`Đã hoàn thành “${s.title}” · đã lên lịch lần kế tiếp.`);
          load({ silent: true });
        }
      },
      onDeleted: (victim, meta = {}) => {
        if (meta.alreadyDeleted) { removeLocal(victim.id); render(); } else removeTask(victim);
      },
      onClose: (info) => {
        drawer = null;
        if (!info?.replaced && !destroyed) setQuery({ id: null });
      },
    });
    render();
  }

  async function openFromQuery(id) {
    if (!id) return;
    let t = byId(id);
    if (!t) {
      try { t = await getTask(id); } catch { t = null; }
      if (t) replaceLocal(t);
    }
    if (!t) { toast.error('Không tìm thấy công việc này — có thể nó đã bị xóa.'); setQuery({ id: null }); return; }
    openDrawer(t);
    requestAnimationFrame(() => flashRow(t.id));
  }

  /* ---------- row menu ---------- */

  function rowMenu(el, t) {
    const running = runningId() === t.id;
    const open = isOpen(t);
    popMenu(el, [
      { label: 'Mở chi tiết', icon: 'arrowRight', onClick: () => openDrawer(t) },
      { label: 'Sửa bằng biểu mẫu', icon: 'edit', onClick: () => openTaskForm({ task: t, onSaved: (s) => { replaceLocal(s); render(); }, onDeleted: (id) => { removeLocal(id); render(); } }) },
      ...(open ? [{ label: running ? 'Tạm dừng bấm giờ' : 'Bắt đầu bấm giờ', icon: running ? 'pause' : 'play', onClick: () => (running ? pauseTimer() : startTimer(t)) }] : []),
      'sep',
      ...Object.keys(TASK_STATUS).filter((s) => s !== t.status).map((s) => ({ label: `Chuyển sang “${TASK_STATUS[s].label}”`, icon: s === 'completed' ? 'checkCircle' : s === 'cancelled' ? 'x' : s === 'in_progress' ? 'play' : 'undo', onClick: () => changeStatus(byId(t.id) || t, s) })),
      'sep',
      { label: 'Đặt hạn…', icon: 'calendar', onClick: () => popMenu(el, dueMenuItems((d) => patchTask(byId(t.id) || t, { due_date: d }, d ? `Đã dời hạn sang ${relDay(d).toLowerCase()}.` : 'Đã bỏ hạn chót.'))) },
      { label: 'Đổi ưu tiên…', icon: 'flag', onClick: () => popMenu(el, PRIO_ORDER.map((p) => ({ label: TASK_PRIORITY[p], icon: 'flag', onClick: () => patchTask(byId(t.id) || t, { priority: p }) }))) },
      { label: 'Nhân bản', icon: 'copy', onClick: async () => { try { const c = await duplicateTask(t); replaceLocal(c); render(); flashRow(c.id); toast('Đã nhân bản công việc.'); } catch (err) { toast.error(err); } } },
      { label: 'Chọn', icon: 'checkSquare', onClick: () => toggleSelect(t.id) },
      'sep',
      { label: 'Xóa', icon: 'trash', danger: true, onClick: () => removeTask(byId(t.id) || t) },
    ]);
  }

  async function startTimer(t) {
    try {
      await timer.start({ taskId: t.id });
      toast.info(`Bắt đầu bấm giờ: ${t.title}`);
      if (t.status === 'todo') changeStatus(t, 'in_progress', { undo: false }); else render();
    } catch (err) { toast.error(err); }
  }
  async function pauseTimer() {
    try { await timer.pause(); render(); } catch (err) { toast.error(err); }
  }

  /* ================================================================ */
  /* Quick-add preview                                                 */
  /* ================================================================ */

  function renderPreview() {
    const box = $('[data-qa-preview]');
    const text = qaInput.value.trim();
    $('.tk-qa').classList.toggle('has-text', Boolean(text));
    if (!text) {
      mount(box, html`<span class="tk-qa__hint"><span class="tk-hide-sm">Nhận diện: ngày <b>mai · thứ 6 · 20/10</b> · ưu tiên <b>!cao</b> · thẻ <b>#sales</b> · ước tính <b>~30p</b> · lặp <b>hằng tuần</b>.</span> <button type="button" class="tk-qa__try" data-act="try-example">Thử ví dụ</button></span>`);
      return;
    }
    const p = parseTaskInput(text, { categories: store.get().categories });
    const ctx = contextDefaults();
    const due = p.due_date || ctx.due_date;
    const cat = p.category_id || ctx.category_id;
    const chips = [];
    if (due) chips.push(html`<span class="tk-pchip tk-pchip--due ${due < today() ? 'is-bad' : ''}">${icon('calendar')}${relDay(due)}${p.due_time ? html` · ${p.due_time}` : ''}${!p.due_date ? html`<em>mặc định</em>` : ''}</span>`);
    else if (p.due_time) chips.push(html`<span class="tk-pchip">${icon('clock')}${p.due_time}</span>`);
    if (p.priority) chips.push(html`<span class="tk-pchip">${prio(p.priority)}</span>`);
    if (cat) chips.push(html`<span class="tk-pchip">${catLabel(cat)}${!p.category_id ? html`<em>mặc định</em>` : ''}</span>`);
    p.tags.forEach((g) => chips.push(html`<span class="tk-pchip tk-pchip--tag">#${g}</span>`));
    if (p.estimated_minutes) chips.push(html`<span class="tk-pchip">${icon('hourglass')}${minutes(p.estimated_minutes)}</span>`);
    if (p.recurrence) chips.push(html`<span class="tk-pchip tk-pchip--rec">${icon('repeat')}${RECURRENCE_LABELS[p.recurrence]}</span>`);
    mount(box, html`
      <span class="tk-pchip tk-pchip--title" title="Tiêu đề">${p.title || '—'}</span>
      ${chips}
      <span class="tk-qa__keys tk-hide-sm"><kbd>Enter</kbd> thêm · <kbd>Shift</kbd>+<kbd>Enter</kbd> mở biểu mẫu · <kbd>Esc</kbd> xóa</span>`);
  }

  /* ================================================================ */
  /* Help                                                              */
  /* ================================================================ */

  function openHelp() {
    const syntax = [
      ['mai · ngày kia · thứ 6 · CN · 20/10', 'Hạn chót'],
      ['tuần sau · cuối tuần · cuối tháng', 'Hạn chót tương đối'],
      ['lúc 9h · 14:00 · 3h chiều', 'Giờ (giữ trong tiêu đề)'],
      ['!thấp · !tb · !cao · !gấp · !1…!4', 'Ưu tiên (!1 = gấp nhất)'],
      ['#sales', 'Thẻ — trùng tên danh mục thì gán luôn danh mục'],
      ['@công việc', 'Danh mục'],
      ['~30p · ~1h30 · ~2g', 'Thời gian ước tính'],
      ['hằng ngày · ngày làm việc · hằng tuần · hằng tháng · mỗi thứ 3', 'Lặp lại'],
    ];
    const keys = [
      ['N', 'Thêm việc nhanh'], ['/', 'Tìm kiếm'], ['J / K', 'Xuống / lên'], ['Enter', 'Mở chi tiết'],
      ['Space', 'Hoàn thành / mở lại'], ['E', 'Sửa bằng biểu mẫu'], ['X', 'Chọn / bỏ chọn'], ['Shift + nhấp', 'Chọn một dải'],
      ['Esc', 'Bỏ chọn · đóng'], ['?', 'Bảng trợ giúp này'],
    ];
    openModal({
      eyebrow: 'Trợ giúp',
      title: 'Phím tắt & cú pháp',
      size: 'wide',
      onSubmit: null,
      body: html`
        <div class="tk-help">
          <section>
            <h3 class="tk-help__h">Nhập nhanh</h3>
            <p class="muted tk-help__ex">Ví dụ: <span class="mono">${QA_EXAMPLE}</span></p>
            <dl class="tk-help__dl">${syntax.map(([k, v]) => html`<dt class="mono">${k}</dt><dd>${v}</dd>`)}</dl>
          </section>
          <section>
            <h3 class="tk-help__h">Phím tắt</h3>
            <dl class="tk-help__dl tk-help__dl--keys">${keys.map(([k, v]) => html`<dt>${k.split(' / ').map((x, i) => html`${i ? ' / ' : ''}<kbd>${x}</kbd>`)}</dt><dd>${v}</dd>`)}</dl>
          </section>
        </div>`,
    });
  }

  /* ================================================================ */
  /* Events                                                            */
  /* ================================================================ */

  function persist() {
    const q = {};
    for (const k of Object.keys(DEFAULTS)) q[k] = f[k] === DEFAULTS[k] ? null : f[k];
    setQuery({ ...q, filter: null });
    const { q: _q, ...rest } = f;
    writeLS(LS_PREFS, rest);
  }
  function setF(patch) {
    Object.assign(f, patch);
    persist();
    render();
  }

  let suppressClick = false;

  disposers.push(on(root, 'click', '[data-act]', (e, el) => {
    if (suppressClick) { e.preventDefault(); return; }
    if (e.target.closest('.tk-tag')) return; // tag chips filter instead of opening the task
    const act = el.dataset.act;
    const id = el.closest('[data-id]')?.dataset.id;
    const t = id && byId(id);

    switch (act) {
      case 'new': return openTaskForm({ defaults: contextDefaults(), onSaved: (s) => { replaceLocal(s); render(); flashRow(s.id); } });
      case 'help': return openHelp();
      case 'retry': return load();
      case 'clear': return setF({ q: '', cat: '', prio: '', tag: '', due: '' });
      case 'filters': filtersOpen = !filtersOpen; return syncControls();
      case 'selecting': selecting = !(selecting || selected.size); if (!selecting) selected.clear(); return render();
      case 'focus-qa': qaInput.focus(); qaInput.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); return;
      case 'try-example': qaInput.value = QA_EXAMPLE; renderPreview(); qaInput.focus(); return;
      case 'see-done': return setF({ view: 'list', scope: 'done' });
      case 'collapse': {
        const g = el.closest('[data-group]');
        const key = g.dataset.group;
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
        writeLS(LS_COLLAPSED, [...collapsed]);
        g.classList.toggle('is-collapsed', collapsed.has(key));
        g.querySelector('.tk-list').hidden = collapsed.has(key);
        el.setAttribute('aria-expanded', String(!collapsed.has(key)));
        return;
      }
    }
    if (!t) return;
    if (act !== 'select') cursorId = t.id;
    if (act === 'select') return; // handled by change
    if (act === 'open') {
      if (e.shiftKey) { e.preventDefault(); window.getSelection()?.removeAllRanges(); return toggleSelect(t.id, { range: true }); }
      if (e.ctrlKey || e.metaKey || selected.size || selecting) return toggleSelect(t.id);
      return openDrawer(t);
    }
    if (act === 'toggle') {
      const done = t.status === 'completed';
      el.setAttribute('aria-checked', String(!done));
      const hides = !done && f.view !== 'board' && f.scope !== 'done' && f.scope !== 'all';
      return changeStatus(t, done ? 'todo' : 'completed', { animateEl: hides || f.view === 'board' ? el.closest('[data-id]') : null });
    }
    if (act === 'timer') return startTimer(t);
    if (act === 'pause') return pauseTimer();
    if (act === 'menu') return rowMenu(el, t);
  }));

  disposers.push(on(root, 'click', 'input[data-act="select"]', (e, el) => {
    const id = el.closest('[data-id]').dataset.id;
    toggleSelect(id, { range: e.shiftKey });
  }));
  // shift-click on the checkbox label → range
  disposers.push(on(root, 'click', '.tk-sel', (e, el) => {
    if (!e.shiftKey || e.target.tagName === 'INPUT') return;
    e.preventDefault();
    toggleSelect(el.closest('[data-id]').dataset.id, { range: true });
  }));

  disposers.push(on(root, 'click', '[data-bulk]', (e, el) => onBulk(el.dataset.bulk, el)));
  disposers.push(on(root, 'click', '[data-scope]', (e, el) => setF({ scope: el.dataset.scope })));
  disposers.push(on(root, 'click', '[data-view]', (e, el) => setF({ view: el.dataset.view })));
  disposers.push(on(root, 'click', '[data-unfilter]', (e, el) => setF({ [el.dataset.unfilter]: '' })));
  disposers.push(on(root, 'click', '.tk-tag[data-tag]', (e, el) => { e.stopPropagation(); setF({ tag: f.tag === el.dataset.tag ? '' : el.dataset.tag }); }));
  disposers.push(on(root, 'click', '[data-ledger]', (e, el) => {
    const s = ledgerState.stats.find((x) => x.k === el.dataset.ledger);
    if (s) setF({ ...s.apply, view: f.view === 'board' ? 'list' : f.view });
  }));
  const onSearch = debounce(() => { persist(); render(); }, 140);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', 'select[data-f]', (e, el) => setF({ [el.dataset.f]: el.value })));

  // quick add
  const qaForm = $('[data-qa]');
  qaForm.addEventListener('submit', (e) => { e.preventDefault(); quickAdd(qaInput.value); });
  qaInput.addEventListener('input', renderPreview);
  qaInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); quickAdd(qaInput.value, { full: true }); }
    if (e.key === 'Escape') { e.stopPropagation(); if (qaInput.value) { qaInput.value = ''; renderPreview(); } else qaInput.blur(); }
  });

  /* ---------- board drag & drop (pointer events: mouse, touch, pen) ---------- */

  let dnd = null;
  const blockTouch = (e) => { if (dnd?.active) e.preventDefault(); };

  function onPointerDown(e) {
    const card = e.target.closest('.tk-card');
    if (!card || !root.contains(card) || e.button !== 0 || card.classList.contains('is-pending') || card.classList.contains('tk-card--sk')) return;
    if (e.target.closest('button, a, input, select, textarea')) return;
    dnd = { card, id: card.dataset.id, x: e.clientX, y: e.clientY, pid: e.pointerId, type: e.pointerType, active: false, over: null, timer: 0 };
    if (e.pointerType !== 'mouse') dnd.timer = setTimeout(beginDrag, 340);
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', cancelDnd);
  }
  function beginDrag() {
    if (!dnd || dnd.active) return;
    dnd.active = true;
    const r = dnd.card.getBoundingClientRect();
    dnd.ox = dnd.x - r.left;
    dnd.oy = dnd.y - r.top;
    const ghost = dnd.card.cloneNode(true);
    ghost.classList.add('tk-ghost');
    ghost.removeAttribute('data-id');
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    dnd.ghost = ghost;
    dnd.card.classList.add('is-dragging');
    root.querySelector('.tk-page').classList.add('is-dnd');
    document.addEventListener('touchmove', blockTouch, { passive: false });
    navigator.vibrate?.(8);
    moveGhost(dnd.x, dnd.y);
  }
  function onPointerMove(e) {
    if (!dnd || e.pointerId !== dnd.pid) return;
    const dist = Math.hypot(e.clientX - dnd.x, e.clientY - dnd.y);
    if (!dnd.active) {
      if (dnd.type === 'mouse') { if (dist > 6) beginDrag(); else return; } else { if (dist > 10) cancelDnd(); return; }
    }
    e.preventDefault();
    moveGhost(e.clientX, e.clientY);
  }
  function moveGhost(x, y) {
    dnd.ghost.style.transform = `translate3d(${x - dnd.ox}px, ${y - dnd.oy}px, 0) rotate(1.2deg)`;
    const under = document.elementFromPoint(x, y)?.closest('[data-drop]');
    const over = under && root.contains(under) ? under.dataset.drop : null;
    if (over !== dnd.over) {
      root.querySelectorAll('.tk-col.is-over').forEach((c) => c.classList.remove('is-over'));
      if (over) under.closest('.tk-col').classList.add('is-over');
      dnd.over = over;
    }
    const board = root.querySelector('[data-board]');
    if (board) {
      const br = board.getBoundingClientRect();
      if (x < br.left + 36) board.scrollLeft -= 14;
      else if (x > br.right - 36) board.scrollLeft += 14;
    }
    if (y < 70) window.scrollBy(0, -12); else if (y > window.innerHeight - 50) window.scrollBy(0, 12);
  }
  function teardownDnd() {
    if (!dnd) return;
    clearTimeout(dnd.timer);
    dnd.ghost?.remove();
    dnd.card.classList.remove('is-dragging');
    root.querySelector('.tk-page')?.classList.remove('is-dnd');
    root.querySelectorAll('.tk-col.is-over').forEach((c) => c.classList.remove('is-over'));
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', cancelDnd);
    document.removeEventListener('touchmove', blockTouch);
    dnd = null;
  }
  function cancelDnd() { teardownDnd(); }
  function onPointerUp(e) {
    if (!dnd || e.pointerId !== dnd.pid) return;
    const d = dnd;
    teardownDnd();
    if (!d.active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    const t = byId(d.id);
    if (t && d.over && d.over !== t.status) {
      changeStatus(t, d.over);
      if (d.over === 'in_progress') toast.info(`“${t.title}” → Đang làm.`);
    }
  }
  root.addEventListener('pointerdown', onPointerDown);
  disposers.push(() => root.removeEventListener('pointerdown', onPointerDown));
  disposers.push(on(root, 'contextmenu', '.tk-card', (e) => { if (dnd) e.preventDefault(); }));
  disposers.push(teardownDnd);

  /* ---------- keyboard ---------- */

  function moveCursor(step) {
    const ids = orderIds();
    if (!ids.length) return;
    let i = ids.indexOf(cursorId);
    i = i < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + step));
    cursorId = ids[i];
    root.querySelectorAll('[data-body] .is-cursor').forEach((el) => el.classList.remove('is-cursor'));
    const el = root.querySelector(`[data-body] [data-id="${CSS.escape(cursorId)}"]`);
    if (el) {
      el.classList.add('is-cursor');
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (drawer || document.querySelector('dialog[open], .menu')) return;
    if (!root.isConnected) return;
    const tgt = e.target;
    if (tgt.closest?.('input, textarea, select, [contenteditable="true"]')) {
      if (e.key === 'Escape' && tgt.matches('[data-f="q"]')) { tgt.blur(); }
      return;
    }
    const onControl = tgt.closest?.('button, a') && !tgt.matches('[data-id]');
    const cur = cursorId && byId(cursorId);
    switch (e.key) {
      case 'n': case 'N':
        e.preventDefault();
        if (e.shiftKey) openTaskForm({ defaults: contextDefaults(), onSaved: (s) => { replaceLocal(s); render(); } });
        else { qaInput.focus(); qaInput.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' }); }
        return;
      case '/': e.preventDefault(); $('[data-f="q"]').focus(); return;
      case '?': e.preventDefault(); openHelp(); return;
      case 'j': case 'J': e.preventDefault(); moveCursor(1); return;
      case 'k': case 'K': e.preventDefault(); moveCursor(-1); return;
      case 'Escape':
        if (selected.size || selecting) { selected.clear(); selecting = false; render(); }
        else if (cursorId) { cursorId = null; root.querySelectorAll('[data-body] .is-cursor').forEach((el) => el.classList.remove('is-cursor')); }
        return;
    }
    if (!cur || onControl) return;
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); toggleSelect(cur.id, { range: e.shiftKey }); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); openTaskForm({ task: cur, onSaved: (s) => { replaceLocal(s); render(); }, onDeleted: (id) => { removeLocal(id); render(); } }); }
    else if (e.key === 'Enter') { e.preventDefault(); openDrawer(cur); }
    else if (e.key === ' ') {
      e.preventDefault();
      const el = root.querySelector(`[data-body] [data-id="${CSS.escape(cur.id)}"]`);
      const done = cur.status === 'completed';
      const hides = !done && f.view !== 'board' && f.scope !== 'done' && f.scope !== 'all';
      changeStatus(cur, done ? 'todo' : 'completed', { animateEl: hides ? el : null });
    }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  disposers.push(store.subscribe((_, patch) => { if ('runningEntry' in patch || 'categories' in patch) render(); }));
  disposers.push(onDataChanged((k) => { if (k === 'tasks') load({ silent: true }); }));
  disposers.push(() => { drawer?.close({ silent: true }); closeMenu(); });

  /* ---------- go ---------- */
  renderPreview();
  render();
  if (query.new === '1') { setQuery({ new: null }); setTimeout(() => qaInput.focus(), 50); }
  await load();
  if (query.id) openFromQuery(query.id);

  return () => {
    destroyed = true;
    disposers.forEach((d) => d());
  };
}
