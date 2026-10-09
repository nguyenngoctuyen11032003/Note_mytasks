// Month calendar: tasks by due_date, tracked time and spending per day.
// No extra table — everything is derived from existing rows.
import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel, prio, statusBadge } from '../components/ui.js';
import { emptyState, errorState, loadingBlock } from '../components/states.js';
import { openTaskForm } from '../components/taskForm.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { categoryById } from '../core/store.js';
import { onDataChanged } from '../core/events.js';
import { listTasks, setTaskStatus } from '../services/tasks.js';
import { listEntries, entrySeconds } from '../services/timeEntries.js';
import { listExpenses } from '../services/expenses.js';
import { today, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, daysBetween, dayOf, dayStartInstant, dayEndInstant, weekdayLabels } from '../utils/date.js';
import { monthLabel, day, minutes, money, moneyShort, time } from '../utils/format.js';

export default async function calendarPage(root, { query }) {
  const t0 = today();
  let month = /^\d{4}-\d{2}$/.test(query.m || '') ? query.m + '-01' : startOfMonth(t0);
  let selected = /^\d{4}-\d{2}-\d{2}$/.test(query.d || '') ? query.d : month === startOfMonth(t0) ? t0 : month;
  let data = { tasks: [], entries: [], expenses: [] };
  let layers = { tasks: true, time: true, money: true };
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '03',
      kicker: 'Lịch',
      title: 'Nhìn tháng như một <em>bản vẽ</em>',
      lede: 'Công việc theo hạn chót, giờ đã làm và khoản chi — xếp trên cùng một lưới ngày.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Việc cho ngày đã chọn</button>`,
    })}
    <div class="toolbar">
      <div class="row" style="gap:4px">
        <button class="icon-btn" data-act="prev" aria-label="Tháng trước">${icon('chevronLeft')}</button>
        <h2 class="cal-title" data-title></h2>
        <button class="icon-btn" data-act="next" aria-label="Tháng sau">${icon('chevronRight')}</button>
      </div>
      <button class="btn btn--sm" data-act="today">Hôm nay</button>
      <div class="toolbar__spacer"></div>
      <div class="segmented" role="group" aria-label="Lớp hiển thị">
        <button type="button" data-layer="tasks" aria-pressed="true">${icon('tasks')} Việc</button>
        <button type="button" data-layer="time" aria-pressed="true">${icon('clock')} Giờ</button>
        <button type="button" data-layer="money" aria-pressed="true">${icon('wallet')} Chi tiêu</button>
      </div>
    </div>
    <div class="cal-layout">
      <section class="sheet cal" data-grid>${loadingBlock(520)}</section>
      <aside class="sheet cal-side" data-side></aside>
    </div>`);

  const $ = (s) => root.querySelector(s);

  async function load() {
    const from = startOfWeek(month), to = endOfWeek(endOfMonth(month));
    $('[data-title]').textContent = monthLabel(month);
    try {
      const [tasks, entries, expenses] = await Promise.all([
        listTasks({ dueFrom: from, dueTo: to, limit: 1000 }),
        listEntries(dayStartInstant(from).toISOString(), dayEndInstant(to).toISOString()),
        listExpenses({ from, to }),
      ]);
      data = { tasks, entries, expenses, from, to };
      renderGrid();
      renderSide();
    } catch (err) {
      mount($('[data-grid]'), html`<div class="sheet__body">${errorState(err)}</div>`);
    }
  }

  function byDay() {
    const m = new Map();
    const get = (d) => m.get(d) || (m.set(d, { tasks: [], secs: 0, spend: 0 }), m.get(d));
    data.tasks.forEach((t) => t.due_date && get(t.due_date).tasks.push(t));
    data.entries.forEach((e) => (get(dayOf(e.started_at)).secs += entrySeconds(e)));
    data.expenses.forEach((x) => (get(x.spent_on).spend += Number(x.amount)));
    return m;
  }

  function renderGrid() {
    const map = byDay();
    const days = daysBetween(data.from, data.to);
    const maxSecs = Math.max(1, ...[...map.values()].map((v) => v.secs));
    mount($('[data-grid]'), html`
      <div class="cal__dow">${weekdayLabels().map((w) => html`<span>${w}</span>`)}</div>
      <div class="cal__grid" role="grid" aria-label="${monthLabel(month)}">
        ${days.map((d) => {
          const v = map.get(d) || { tasks: [], secs: 0, spend: 0 };
          const out = d.slice(0, 7) !== month.slice(0, 7);
          const open = v.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
          const overdue = d < t0 && open.length;
          return html`
            <button type="button" role="gridcell" class="cal__day ${out ? 'is-out' : ''} ${d === t0 ? 'is-today' : ''} ${d === selected ? 'is-selected' : ''}" data-day="${d}" aria-label="${day(d, 'long')}${v.tasks.length ? `, ${v.tasks.length} việc` : ''}" aria-selected="${d === selected}">
              <span class="cal__num">${Number(d.slice(8))}</span>
              ${layers.time && v.secs ? html`<span class="cal__heat" style="--h:${Math.max(0.12, v.secs / maxSecs)}" title="${minutes(v.secs / 60)}"></span>` : ''}
              <span class="cal__items">
                ${layers.tasks ? v.tasks.slice(0, 3).map((t) => html`<span class="cal__task ${t.status === 'completed' ? 'is-done' : ''}" style="--c:${categoryById(t.category_id)?.color || 'var(--ink-3)'}">${t.title}</span>`) : ''}
                ${layers.tasks && v.tasks.length > 3 ? html`<span class="cal__more">+${v.tasks.length - 3} việc</span>` : ''}
              </span>
              <span class="cal__foot">
                ${layers.time && v.secs ? html`<span class="cal__time">${minutes(v.secs / 60)}</span>` : html`<span></span>`}
                ${layers.money && v.spend ? html`<span class="cal__money">${moneyShort(v.spend)}</span>` : ''}
              </span>
              ${overdue ? html`<span class="cal__flag" title="Có việc quá hạn"></span>` : ''}
            </button>`;
        })}
      </div>`);
  }

  function renderSide() {
    const v = byDay().get(selected) || { tasks: [], secs: 0, spend: 0 };
    const entries = data.entries.filter((e) => dayOf(e.started_at) === selected).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const exps = data.expenses.filter((x) => x.spent_on === selected);
    mount($('[data-side]'), html`
      <div class="cal-side__head">
        <span class="eyebrow">${selected === t0 ? 'Hôm nay' : 'Ngày đã chọn'}</span>
        <h3 class="display">${day(selected, 'weekday')}</h3>
        <div class="cal-side__sum">
          <span><strong class="num">${v.tasks.length}</strong> việc</span>
          <span><strong class="num">${minutes(v.secs / 60)}</strong> đã làm</span>
          <span><strong class="num">${money(v.spend, { compact: true })}</strong> đã chi</span>
        </div>
      </div>
      <div class="cal-side__sect">
        <div class="row between"><span class="eyebrow">Công việc đến hạn</span><button class="btn btn--ghost btn--sm" data-act="new">${icon('plus')} Thêm</button></div>
        ${v.tasks.length
          ? html`<ul class="list">${v.tasks.map((t) => html`
              <li class="task-row ${t.status === 'completed' ? 'is-done' : ''}" data-id="${t.id}" style="padding-left:0;padding-right:0">
                <button class="tick" role="checkbox" aria-checked="${t.status === 'completed'}" data-act="toggle" aria-label="Hoàn thành ${t.title}">${icon('check')}</button>
                <div class="task-row__main" data-act="edit"><div class="task-row__title">${t.title}</div><div class="task-row__meta">${prio(t.priority)}${catLabel(t.category_id)}${t.status === 'in_progress' ? statusBadge(t.status) : ''}</div></div>
                <span></span>
              </li>`)}</ul>`
          : html`<p class="muted" style="font-size:var(--fs-sm);padding:var(--s-3) 0">Không có việc nào đến hạn.</p>`}
      </div>
      <div class="cal-side__sect">
        <span class="eyebrow">Phiên làm việc</span>
        ${entries.length
          ? html`<ul class="mini-list">${entries.map((e) => html`<li><span class="num muted">${time(e.started_at)}–${e.ended_at ? time(e.ended_at) : 'nay'}</span><span class="grow truncate">${e.description || data.tasks.find((t) => t.id === e.task_id)?.title || 'Phiên làm việc'}</span><span class="num">${minutes(entrySeconds(e) / 60)}</span></li>`)}</ul>`
          : html`<p class="muted" style="font-size:var(--fs-sm);padding:var(--s-3) 0">Chưa ghi nhận thời gian.</p>`}
      </div>
      <div class="cal-side__sect">
        <span class="eyebrow">Khoản chi</span>
        ${exps.length
          ? html`<ul class="mini-list">${exps.map((x) => html`<li>${catLabel(x.category_id)}<span class="grow truncate">${x.description || ''}</span><span class="num">${money(x.amount)}</span></li>`)}</ul>`
          : html`<p class="muted" style="font-size:var(--fs-sm);padding:var(--s-3) 0">Không có khoản chi.</p>`}
      </div>`);
  }

  function go(m) {
    month = m;
    setQuery({ m: month.slice(0, 7), d: selected });
    load();
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'prev') { selected = addMonths(month, -1); go(addMonths(month, -1)); }
    if (act === 'next') { selected = addMonths(month, 1); go(addMonths(month, 1)); }
    if (act === 'today') { selected = t0; go(startOfMonth(t0)); }
    if (act === 'retry') load();
    if (act === 'new') openTaskForm({ defaults: { due_date: selected }, onSaved: load });
    const id = el.closest('[data-id]')?.dataset.id;
    const t = id && data.tasks.find((x) => x.id === id);
    if (t && act === 'edit') openTaskForm({ task: t, onSaved: load, onDeleted: load });
    if (t && act === 'toggle') {
      try { await setTaskStatus(t.id, t.status === 'completed' ? 'todo' : 'completed'); load(); } catch (err) { toast.error(err); }
    }
  }));
  disposers.push(on(root, 'click', '[data-day]', (e, el) => {
    const d = el.dataset.day;
    if (d.slice(0, 7) !== month.slice(0, 7)) { selected = d; go(startOfMonth(d)); return; }
    selected = d;
    setQuery({ m: month.slice(0, 7), d });
    root.querySelectorAll('.cal__day').forEach((b) => { b.classList.toggle('is-selected', b.dataset.day === d); b.setAttribute('aria-selected', String(b.dataset.day === d)); });
    renderSide();
  }));
  disposers.push(on(root, 'dblclick', '[data-day]', (e, el) => openTaskForm({ defaults: { due_date: el.dataset.day }, onSaved: load })));
  disposers.push(on(root, 'keydown', '[data-day]', (e, el) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    const d = addDays(el.dataset.day, step);
    const next = root.querySelector(`[data-day="${d}"]`);
    if (next) { next.focus(); next.click(); }
  }));
  disposers.push(on(root, 'click', '[data-layer]', (e, el) => {
    const k = el.dataset.layer;
    layers[k] = !layers[k];
    el.setAttribute('aria-pressed', String(layers[k]));
    renderGrid();
  }));
  disposers.push(onDataChanged(load));

  await load();
  return () => disposers.forEach((d) => d());
}
