import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, catLabel, dueLabel, prio, statusBadge, categoryOptions, popMenu, TASK_STATUS, TASK_PRIORITY, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, loadingRows } from '../components/states.js';
import { openTaskForm } from '../components/taskForm.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { listTasks, setTaskStatus, deleteTask, updateTask } from '../services/tasks.js';
import { today, addDays } from '../utils/date.js';
import { minutes, num } from '../utils/format.js';

const SCOPES = [
  { id: 'open', label: 'Đang mở' },
  { id: 'overdue', label: 'Quá hạn' },
  { id: 'done', label: 'Hoàn thành' },
  { id: 'all', label: 'Tất cả' },
];
const SORTS = [
  { value: 'due', label: 'Sắp đến hạn' },
  { value: 'priority', label: 'Độ ưu tiên' },
  { value: 'created', label: 'Mới tạo' },
  { value: 'title', label: 'Tên A–Z' },
];
const BOARD_COLS = ['todo', 'in_progress', 'completed', 'cancelled'];

export default async function tasksPage(root, { query }) {
  const f = {
    view: query.view === 'board' ? 'board' : 'list',
    scope: SCOPES.some((s) => s.id === query.scope) ? query.scope : query.view === 'overdue' ? 'overdue' : 'open',
    cat: query.cat || '',
    prio: query.prio || '',
    sort: query.sort || 'due',
    q: query.q || '',
    tag: query.tag || '',
  };
  let tasks = [];
  let loaded = false;
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '02',
      kicker: 'Công việc',
      title: 'Những việc <em>cần làm</em>',
      lede: 'Lập kế hoạch, ưu tiên và đánh dấu hoàn thành. Bấm giờ trực tiếp từ từng việc.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Công việc mới <kbd style="margin-left:4px;background:transparent;color:inherit;border-color:currentColor;opacity:.5">N</kbd></button>`,
    })}
    <div class="toolbar">
      <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Tìm theo tiêu đề, mô tả…" value="${f.q}" data-f="q" aria-label="Tìm công việc" /></div>
      <select class="select" data-f="cat" aria-label="Danh mục">${categoryOptions('task', { all: 'Mọi danh mục', none: 'Chưa phân loại' }).map((o) => html`<option value="${o.value}" ${o.value === f.cat ? 'selected' : ''}>${o.label}</option>`)}</select>
      <select class="select" data-f="prio" aria-label="Độ ưu tiên">
        <option value="">Mọi mức ưu tiên</option>
        ${Object.entries(TASK_PRIORITY).map(([v, l]) => html`<option value="${v}" ${v === f.prio ? 'selected' : ''}>${l}</option>`)}
      </select>
      <select class="select" data-f="sort" aria-label="Sắp xếp">${SORTS.map((s) => html`<option value="${s.value}" ${s.value === f.sort ? 'selected' : ''}>${s.label}</option>`)}</select>
      <div class="toolbar__spacer"></div>
      <div class="segmented" role="group" aria-label="Kiểu hiển thị">
        <button type="button" data-view="list" aria-pressed="${f.view === 'list'}">${icon('list')} Danh sách</button>
        <button type="button" data-view="board" aria-pressed="${f.view === 'board'}">${icon('board')} Bảng</button>
      </div>
    </div>
    <div class="tabs" role="tablist" data-scopes></div>
    <div data-tagbar></div>
    <div data-body>${html`<div class="sheet">${loadingRows(6)}</div>`}</div>`);

  const $ = (s) => root.querySelector(s);

  /* ---------- filtering ---------- */
  function inScope(t, scope = f.scope) {
    const t0 = today();
    if (scope === 'open') return t.status === 'todo' || t.status === 'in_progress';
    if (scope === 'overdue') return (t.status === 'todo' || t.status === 'in_progress') && t.due_date && t.due_date < t0;
    if (scope === 'done') return t.status === 'completed';
    return true;
  }
  function filtered({ ignoreScope = false } = {}) {
    const q = f.q.trim().toLowerCase();
    let rows = tasks.filter((t) =>
      (ignoreScope || inScope(t)) &&
      (!f.cat || (f.cat === 'none' ? !t.category_id : t.category_id === f.cat)) &&
      (!f.prio || t.priority === f.prio) &&
      (!f.tag || (t.tags || []).includes(f.tag)) &&
      (!q || t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || (t.tags || []).some((g) => g.toLowerCase().includes(q))));
    const by = {
      due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.due_date || '9999').localeCompare(b.due_date || '9999'),
      created: (a, b) => b.created_at.localeCompare(a.created_at),
      title: (a, b) => a.title.localeCompare(b.title, 'vi'),
    }[f.sort];
    if (f.scope === 'done') rows.sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
    else rows.sort(by);
    return rows;
  }

  /* ---------- render ---------- */
  function render() {
    if (!loaded) return;
    renderScopes();
    renderTagbar();
    const rows = filtered({ ignoreScope: f.view === 'board' });
    $('[data-scopes]').style.display = f.view === 'board' ? 'none' : '';
    if (!tasks.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'tasks', title: 'Chưa có công việc nào', text: 'Bắt đầu bằng việc nhỏ nhất bạn có thể làm hôm nay.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Tạo công việc đầu tiên</button>` })}</div>`);
      return;
    }
    if (f.view === 'board') return renderBoard(rows);
    if (!rows.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'tasks', small: true, title: f.scope === 'overdue' ? 'Không có việc quá hạn' : 'Không có việc phù hợp', text: f.scope === 'overdue' ? 'Tuyệt vời — bạn đang theo kịp mọi hạn chót.' : 'Thử bỏ bớt bộ lọc hoặc tìm với từ khóa khác.', action: hasFilters() ? html`<button class="btn btn--sm" data-act="clear">Xóa bộ lọc</button>` : '' })}</div>`);
      return;
    }
    renderList(rows);
  }

  function hasFilters() {
    return Boolean(f.q || f.cat || f.prio || f.tag);
  }

  function renderScopes() {
    mount($('[data-scopes]'), html`${SCOPES.map((s) => html`<button type="button" role="tab" data-scope="${s.id}" aria-selected="${f.scope === s.id}">${s.label}<span class="count">${num(tasks.filter((t) => inScope(t, s.id)).length)}</span></button>`)}`);
  }

  function renderTagbar() {
    const tags = [...new Set(tasks.flatMap((t) => t.tags || []))].sort();
    const bar = $('[data-tagbar]');
    if (!tags.length) { bar.innerHTML = ''; return; }
    mount(bar, html`<div class="row-wrap" style="margin:-8px 0 var(--s-5)"><span class="eyebrow" style="margin-right:4px">Thẻ</span>
      ${tags.slice(0, 16).map((t) => html`<button type="button" class="tag ${f.tag === t ? 'is-on' : ''}" data-tag="${t}" aria-pressed="${f.tag === t}">${t}</button>`)}
      ${f.tag ? html`<button type="button" class="btn btn--ghost btn--sm" data-tag="">${icon('x')} Bỏ lọc thẻ</button>` : ''}</div>`);
  }

  function groupsFor(rows) {
    if (f.scope === 'done' || f.sort !== 'due') return [{ title: null, rows }];
    const t0 = today(), wk = addDays(t0, 7);
    const g = [
      { title: 'Quá hạn', tone: 'danger', rows: [] },
      { title: 'Hôm nay', tone: 'accent', rows: [] },
      { title: '7 ngày tới', rows: [] },
      { title: 'Sau này', rows: [] },
      { title: 'Không có hạn', rows: [] },
    ];
    for (const t of rows) {
      const open = t.status === 'todo' || t.status === 'in_progress';
      if (!t.due_date) g[4].rows.push(t);
      else if (t.due_date < t0 && open) g[0].rows.push(t);
      else if (t.due_date === t0) g[1].rows.push(t);
      else if (t.due_date <= wk) g[2].rows.push(t);
      else g[3].rows.push(t);
    }
    return g.filter((x) => x.rows.length);
  }

  function rowTpl(t) {
    const done = t.status === 'completed';
    const running = store.get().runningEntry?.task_id === t.id;
    return html`
      <li class="task-row ${done ? 'is-done' : ''} ${t.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${t.id}">
        <button class="tick" role="checkbox" aria-checked="${done}" data-act="toggle" data-p="${t.priority}" aria-label="${done ? 'Mở lại' : 'Hoàn thành'}: ${t.title}">${icon('check')}</button>
        <div class="task-row__main" data-act="edit">
          <div class="task-row__title">${t.title}</div>
          ${t.description ? html`<div class="task-row__desc">${t.description}</div>` : ''}
          <div class="task-row__meta">
            ${t.status === 'in_progress' || t.status === 'cancelled' ? statusBadge(t.status) : ''}
            ${dueLabel(t.due_date, t.status)}
            ${prio(t.priority)}
            ${catLabel(t.category_id)}
            ${t.estimated_minutes || t.actual_minutes ? html`<span class="due" title="Thực tế / ước tính">${icon('clock')}${minutes(t.actual_minutes)}${t.estimated_minutes ? html` / ${minutes(t.estimated_minutes)}` : ''}</span>` : ''}
            ${(t.tags || []).slice(0, 4).map((g) => html`<span class="tag">${g}</span>`)}
          </div>
        </div>
        <div class="task-row__side">
          ${!done && t.status !== 'cancelled' ? html`<button class="icon-btn icon-btn--sm ${running ? 'is-running' : ''}" data-act="${running ? 'pause' : 'timer'}" title="${running ? 'Tạm dừng bấm giờ' : 'Bấm giờ'}" aria-label="${running ? 'Tạm dừng bấm giờ' : 'Bấm giờ'}">${icon(running ? 'pause' : 'play')}</button>` : ''}
          <button class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thêm thao tác" aria-haspopup="menu">${icon('more')}</button>
        </div>
      </li>`;
  }

  function renderList(rows) {
    const groups = groupsFor(rows);
    mount($('[data-body]'), html`
      <div class="sheet">
        ${groups.map((g) => html`
          ${g.title ? html`<div class="group-head"><span class="group-head__day ${g.tone === 'danger' ? 'danger-text' : ''}">${g.title}</span><span class="group-head__sum">${g.rows.length} việc</span></div>` : ''}
          <ul class="list">${g.rows.map(rowTpl)}</ul>`)}
        <div class="sheet__foot"><span>${rows.length} / ${tasks.length} công việc</span><span>Mẹo: nhấn <kbd>N</kbd> để tạo nhanh</span></div>
      </div>`);
  }

  function renderBoard(rows) {
    mount($('[data-body]'), html`
      <div class="board">
        ${BOARD_COLS.map((s) => {
          const items = rows.filter((t) => t.status === s);
          return html`
            <section class="board__col" data-col="${s}" aria-label="${TASK_STATUS[s].label}">
              <header class="board__head"><span class="badge badge--${TASK_STATUS[s].badge}">${TASK_STATUS[s].label}</span><span class="num faint">${items.length}</span></header>
              <div class="board__list" data-drop="${s}">
                ${items.map((t) => html`
                  <article class="card-task" draggable="true" data-id="${t.id}" data-p="${t.priority}">
                    <div class="row between" style="align-items:flex-start">
                      <div class="card-task__title" data-act="edit">${t.title}</div>
                      <button class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thêm thao tác">${icon('more')}</button>
                    </div>
                    <div class="task-row__meta">${dueLabel(t.due_date, t.status)}${prio(t.priority)}</div>
                    <div class="row between" style="margin-top:8px">${catLabel(t.category_id)}${t.actual_minutes ? html`<span class="due">${icon('clock')}${minutes(t.actual_minutes)}</span>` : ''}</div>
                  </article>`)}
                ${!items.length ? html`<div class="board__empty">Kéo thả công việc vào đây</div>` : ''}
              </div>
              ${s === 'todo' ? html`<button class="btn btn--ghost btn--sm btn--block" data-act="new">${icon('plus')} Thêm việc</button>` : ''}
            </section>`;
        })}
      </div>`);
  }

  /* ---------- data ---------- */
  async function load() {
    try {
      tasks = await listTasks({ limit: 1000 });
      loaded = true;
      render();
    } catch (err) {
      mount($('[data-body]'), errorState(err));
    }
  }

  const replace = (saved) => {
    const i = tasks.findIndex((t) => t.id === saved.id);
    if (i >= 0) tasks[i] = saved; else tasks.unshift(saved);
    render();
  };
  const removeLocal = (id) => { tasks = tasks.filter((t) => t.id !== id); render(); };

  async function changeStatus(t, status, { undo = true } = {}) {
    const prev = t.status;
    try {
      const saved = await setTaskStatus(t.id, status);
      replace(saved);
      if (status === 'completed' && undo) {
        toast(`Đã hoàn thành “${t.title}”.`, { action: { label: 'Hoàn tác', onClick: () => changeStatus(saved, prev, { undo: false }) } });
      }
      if (status === 'completed' && store.get().runningEntry?.task_id === t.id) await timer.stop();
    } catch (err) {
      toast.error(err);
      render();
    }
  }

  const byId = (id) => tasks.find((t) => t.id === id);

  /* ---------- events ---------- */
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    const id = el.closest('[data-id]')?.dataset.id;
    const t = id && byId(id);
    if (act === 'new') openTaskForm({ defaults: f.cat && f.cat !== 'none' ? { category_id: f.cat } : {}, onSaved: replace });
    if (act === 'retry') load();
    if (act === 'clear') { Object.assign(f, { q: '', cat: '', prio: '', tag: '' }); syncControls(); persist(); render(); }
    if (!t) return;
    if (act === 'edit') openTaskForm({ task: t, onSaved: replace, onDeleted: removeLocal });
    if (act === 'toggle') {
      el.setAttribute('aria-checked', String(t.status !== 'completed'));
      changeStatus(t, t.status === 'completed' ? 'todo' : 'completed');
    }
    if (act === 'timer') {
      try { await timer.start({ taskId: t.id }); toast.info(`Bắt đầu bấm giờ: ${t.title}`); if (t.status === 'todo') changeStatus(t, 'in_progress', { undo: false }); else render(); } catch (err) { toast.error(err); }
    }
    if (act === 'pause') { try { await timer.pause(); render(); } catch (err) { toast.error(err); } }
    if (act === 'menu') {
      popMenu(el, [
        { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openTaskForm({ task: t, onSaved: replace, onDeleted: removeLocal }) },
        'sep',
        ...BOARD_COLS.filter((s) => s !== t.status).map((s) => ({ label: `Chuyển sang “${TASK_STATUS[s].label}”`, icon: s === 'completed' ? 'checkCircle' : s === 'cancelled' ? 'x' : 'arrowRight', onClick: () => changeStatus(t, s) })),
        { label: 'Dời hạn sang ngày mai', icon: 'calendar', onClick: async () => { try { replace(await updateTask(t.id, { due_date: addDays(today(), 1) })); toast('Đã dời hạn sang ngày mai.'); } catch (err) { toast.error(err); } } },
        'sep',
        { label: 'Xóa', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: 'Xóa công việc?', message: `“${t.title}” sẽ bị xóa vĩnh viễn.` }))) return;
          try { await deleteTask(t.id); removeLocal(t.id); toast('Đã xóa công việc.'); } catch (err) { toast.error(err); }
        } },
      ]);
    }
  }));

  disposers.push(on(root, 'click', '[data-scope]', (e, el) => { f.scope = el.dataset.scope; persist(); render(); }));
  disposers.push(on(root, 'click', '[data-tag]', (e, el) => { f.tag = f.tag === el.dataset.tag ? '' : el.dataset.tag; persist(); render(); }));
  disposers.push(on(root, 'click', '[data-view]', (e, el) => {
    f.view = el.dataset.view;
    root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === f.view)));
    persist(); render();
  }));
  const onSearch = debounce(() => { persist(); render(); }, 160);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', 'select[data-f]', (e, el) => { f[el.dataset.f] = el.value; persist(); render(); }));

  // Drag & drop between board columns
  let dragId = null;
  disposers.push(on(root, 'dragstart', '.card-task', (e, el) => { dragId = el.dataset.id; el.classList.add('is-dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); }));
  disposers.push(on(root, 'dragend', '.card-task', (e, el) => { el.classList.remove('is-dragging'); root.querySelectorAll('.is-over').forEach((x) => x.classList.remove('is-over')); }));
  disposers.push(on(root, 'dragover', '[data-drop]', (e, el) => { e.preventDefault(); el.classList.add('is-over'); }));
  disposers.push(on(root, 'dragleave', '[data-drop]', (e, el) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-over'); }));
  disposers.push(on(root, 'drop', '[data-drop]', (e, el) => {
    e.preventDefault();
    el.classList.remove('is-over');
    const t = byId(dragId || e.dataTransfer.getData('text/plain'));
    if (t && t.status !== el.dataset.drop) changeStatus(t, el.dataset.drop);
    dragId = null;
  }));

  const onKey = (e) => {
    if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable], dialog')) return;
    e.preventDefault();
    openTaskForm({ onSaved: replace });
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));
  disposers.push(store.subscribe((_, patch) => { if ('runningEntry' in patch) render(); }));
  disposers.push(onDataChanged((k) => k === 'tasks' && load()));

  function syncControls() {
    $('[data-f="q"]').value = f.q;
    root.querySelectorAll('select[data-f]').forEach((s) => (s.value = f[s.dataset.f]));
  }
  function persist() {
    setQuery({ view: f.view === 'list' ? null : f.view, scope: f.scope === 'open' ? null : f.scope, cat: f.cat || null, prio: f.prio || null, sort: f.sort === 'due' ? null : f.sort, q: f.q || null, tag: f.tag || null });
  }

  await load();
  return () => disposers.forEach((d) => d());
}
