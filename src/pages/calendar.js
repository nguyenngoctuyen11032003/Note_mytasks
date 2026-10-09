// Calendar ("Lịch") — Month, Week and Agenda views over existing rows only:
// tasks by due_date, time entries by start day, expenses by spent_on.
// Deep link: #/calendar?view=month|week|agenda&date=YYYY-MM-DD (legacy ?m=&d= still read).
import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, catLabel, prio, statusBadge, TASK_PRIORITY } from '../components/ui.js';
import { emptyState, errorState, loadingBlock } from '../components/states.js';
import { openTaskForm } from '../components/taskForm.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { onDataChanged, notifyDataChanged } from '../core/events.js';
import { listTasks, getTask, setTaskStatus, updateTask } from '../services/tasks.js';
import { listEntries, entrySeconds } from '../services/timeEntries.js';
import { listExpenses } from '../services/expenses.js';
import {
  today, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, daysBetween, dayOf,
  dayStartInstant, dayEndInstant, weekdayLabels, toLocalInput, weekday,
} from '../utils/date.js';
import { monthLabel, day, relDay, minutes, money, moneyShort, time, num } from '../utils/format.js';

const VIEWS = { month: 'Tháng', week: 'Tuần', agenda: 'Danh sách' };
const AGENDA_DAYS = 21;
const LAYERS_KEY = 'nm.calendar.layers';
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isOpen = (t) => t.status === 'todo' || t.status === 'in_progress';
const NEAR = new Set(['Hôm nay', 'Ngày mai', 'Hôm qua']);
const nearLabel = (d) => (NEAR.has(relDay(d)) ? relDay(d) : '');

function readLayers() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYERS_KEY) || 'null');
    if (v && typeof v === 'object') return { tasks: v.tasks !== false, time: v.time !== false, money: v.money !== false };
  } catch {}
  return { tasks: true, time: true, money: true };
}
function writeLayers(v) {
  try { localStorage.setItem(LAYERS_KEY, JSON.stringify(v)); } catch {}
}

/** Visible range of a view anchored on `d`. */
function rangeOf(view, d) {
  if (view === 'week') return { from: startOfWeek(d), to: endOfWeek(d) };
  if (view === 'agenda') return { from: d, to: addDays(d, AGENDA_DAYS - 1) };
  return { from: startOfWeek(startOfMonth(d)), to: endOfWeek(endOfMonth(d)) };
}

function titleOf(view, d) {
  if (view === 'month') return monthLabel(d);
  const { from, to } = rangeOf(view, d);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${Number(from.slice(8))} – ${day(to, 'medium')}`;
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${day(from, sameYear ? 'short' : 'medium')} – ${day(to, 'medium')}`;
}

/** Minutes since local midnight of an instant (user timezone). */
function localMinutes(instant) {
  const hm = toLocalInput(instant).slice(11);
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

export default async function calendarPage(root, { query }) {
  const t0 = today();
  let view = VIEWS[query.view] ? query.view : 'month';
  let date = isDay(query.date) ? query.date : isDay(query.d) ? query.d : /^\d{4}-\d{2}$/.test(query.m || '') ? query.m + '-01' : t0;
  let layers = readLayers();
  let data = { tasks: [], entries: [], expenses: [], from: null, to: null };
  let index = new Map();
  let loadedKey = '';
  let token = 0;
  let dragId = null;
  const taskNames = new Map(); // task_id → title, for entries whose task is due outside the range
  const disposers = [];

  mount(root, html`
    ${pageHead({
      kicker: 'Lịch',
      title: 'Lịch của bạn',
      lede: 'Công việc theo hạn chót, giờ đã làm và khoản chi trên cùng một lưới ngày.',
      actions: html`<button class="btn btn--primary" data-act="add">${icon('plus')} Thêm việc</button>`,
    })}
    <div class="calx-bar">
      <div class="calx-nav">
        <button class="icon-btn calx-nav__btn" data-act="prev" aria-label="Kỳ trước" title="Kỳ trước (←)">${icon('chevronLeft')}</button>
        <h2 class="calx-title" data-title aria-live="polite"></h2>
        <button class="icon-btn calx-nav__btn" data-act="next" aria-label="Kỳ sau" title="Kỳ sau (→)">${icon('chevronRight')}</button>
        <button class="btn btn--sm calx-today" data-act="today" title="Về hôm nay (T)">Hôm nay</button>
      </div>
      <div class="calx-bar__tools">
        <div class="segmented calx-views" role="group" aria-label="Chế độ xem">
          ${Object.entries(VIEWS).map(([k, label]) => html`<button type="button" data-view="${k}" aria-pressed="${k === view}">${label}</button>`)}
        </div>
        <div class="segmented calx-layers" role="group" aria-label="Lớp hiển thị">
          <button type="button" data-layer="tasks" aria-pressed="${layers.tasks}">${icon('tasks')}<span>Công việc</span></button>
          <button type="button" data-layer="time" aria-pressed="${layers.time}">${icon('clock')}<span>Thời gian</span></button>
          <button type="button" data-layer="money" aria-pressed="${layers.money}">${icon('wallet')}<span>Chi tiêu</span></button>
        </div>
      </div>
    </div>
    <div class="calx-layout" data-layout>
      <section class="sheet calx-main" data-main aria-busy="true">${loadingBlock(520)}</section>
      <aside class="sheet calx-day" data-day-sheet aria-label="Chi tiết ngày"></aside>
    </div>
    <p class="calx-hint"><kbd>←</kbd> <kbd>→</kbd> chuyển kỳ · <kbd>T</kbd> về hôm nay · <kbd>N</kbd> thêm việc cho ngày đang chọn · nhấp đúp vào ngày để thêm việc · kéo thả công việc sang ngày khác để dời hạn</p>`);

  const $ = (s) => root.querySelector(s);

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  function buildIndex() {
    const m = new Map();
    const get = (d) => {
      let v = m.get(d);
      if (!v) m.set(d, (v = { tasks: [], entries: [], expenses: [], secs: 0, spend: 0 }));
      return v;
    };
    data.tasks.forEach((t) => t.due_date && get(t.due_date).tasks.push(t));
    data.entries.forEach((e) => { const v = get(dayOf(e.started_at)); v.entries.push(e); v.secs += entrySeconds(e); });
    data.expenses.forEach((x) => { const v = get(x.spent_on); v.expenses.push(x); v.spend += Number(x.amount); });
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
    m.forEach((v) => {
      v.tasks.sort((a, b) => Number(!isOpen(a)) - Number(!isOpen(b)) || (rank[a.priority] ?? 4) - (rank[b.priority] ?? 4) || a.title.localeCompare(b.title, 'vi'));
      v.entries.sort((a, b) => a.started_at.localeCompare(b.started_at));
    });
    index = m;
  }
  async function loadTaskNames() {
    const have = new Set(data.tasks.map((t) => t.id));
    const missing = [...new Set(data.entries.map((e) => e.task_id).filter((id) => id && !have.has(id) && !taskNames.has(id)))].slice(0, 40);
    if (!missing.length) return;
    const got = await Promise.all(missing.map((id) => getTask(id).catch(() => null)));
    missing.forEach((id, i) => taskNames.set(id, got[i]?.title || ''));
  }
  const entryLabel = (e) => e.description || data.tasks.find((t) => t.id === e.task_id)?.title || taskNames.get(e.task_id) || 'Phiên làm việc';
  const at = (d) => index.get(d) || { tasks: [], entries: [], expenses: [], secs: 0, spend: 0 };

  async function load({ force = false } = {}) {
    const { from, to } = rangeOf(view, date);
    const key = `${from}|${to}`;
    syncChrome();
    if (!force && key === loadedKey) { renderMain(); renderDay(); return; }
    const my = ++token;
    $('[data-main]').setAttribute('aria-busy', 'true');
    if (key !== loadedKey) mount($('[data-main]'), loadingBlock(view === 'agenda' ? 360 : 520));
    try {
      const [tasks, entries, expenses] = await Promise.all([
        listTasks({ dueFrom: from, dueTo: to, limit: 3000 }),
        listEntries(dayStartInstant(from).toISOString(), dayEndInstant(to).toISOString()),
        listExpenses({ from, to, limit: 5000 }),
      ]);
      if (my !== token) return;
      data = { tasks, entries, expenses, from, to };
      await loadTaskNames();
      if (my !== token) return;
      loadedKey = key;
      buildIndex();
      renderMain();
      renderDay();
    } catch (err) {
      if (my !== token) return;
      if (err?.sessionExpired) throw err;
      loadedKey = '';
      mount($('[data-main]'), html`<div class="sheet__body">${errorState(err)}</div>`);
      mount($('[data-day-sheet]'), '');
    } finally {
      if (my === token) $('[data-main]')?.setAttribute('aria-busy', 'false');
    }
  }

  function syncChrome() {
    $('[data-title]').textContent = titleOf(view, date);
    root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    $('[data-layout]').classList.toggle('is-agenda', view === 'agenda');
    setQuery({ view, date, m: null, d: null });
  }

  /* ---------------------------------------------------------------- */
  /* Pieces                                                            */
  /* ---------------------------------------------------------------- */

  const chip = (t) => html`<span class="calx-chip ${t.status === 'completed' ? 'is-done' : ''} ${t.status === 'cancelled' ? 'is-cancelled' : ''}" data-task="${t.id}" data-p="${t.priority}" draggable="${isOpen(t) ? 'true' : 'false'}" title="${t.title} · ${TASK_PRIORITY[t.priority] || ''}">${t.title}</span>`;

  const dayLabel = (d, v) => {
    const bits = [day(d, 'long')];
    if (d === t0) bits.push('hôm nay');
    if (v.tasks.length) bits.push(`${v.tasks.length} việc`);
    if (v.secs) bits.push(`${minutes(v.secs / 60)} làm việc`);
    if (v.spend) bits.push(`chi ${money(v.spend)}`);
    return bits.join(', ');
  };

  function track(entries) {
    return html`<div class="calx-track" aria-hidden="true">${entries.map((e) => {
      const start = localMinutes(e.started_at);
      const dur = Math.min(entrySeconds(e) / 60, 1440 - start);
      return html`<i class="${e.ended_at ? '' : 'is-live'}" style="left:${((start / 1440) * 100).toFixed(2)}%;width:${Math.max(0.8, (dur / 1440) * 100).toFixed(2)}%"></i>`;
    })}</div>`;
  }

  /* ---------------------------------------------------------------- */
  /* Views                                                             */
  /* ---------------------------------------------------------------- */

  function renderMain() {
    if (view === 'week') renderWeek();
    else if (view === 'agenda') renderAgenda();
    else renderMonth();
  }

  function renderMonth() {
    const days = daysBetween(data.from, data.to);
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
    const maxSecs = Math.max(1, ...days.map((d) => at(d).secs));
    const mKey = date.slice(0, 7);
    mount($('[data-main]'), html`
      <div class="calx-dow" aria-hidden="true">${weekdayLabels().map((w) => html`<span>${w}</span>`)}</div>
      <div class="calx-month" role="grid" aria-label="${monthLabel(date)}">
        ${weeks.map((w) => html`<div class="calx-row" role="row">${w.map((d) => {
          const v = at(d);
          const out = d.slice(0, 7) !== mKey;
          const overdue = d < t0 && v.tasks.some(isOpen);
          const sel = d === date;
          return html`
            <div role="gridcell" class="calx-cell ${out ? 'is-out' : ''} ${d === t0 ? 'is-today' : ''} ${sel ? 'is-selected' : ''} ${weekday(d) === 0 || weekday(d) === 6 ? 'is-weekend' : ''}"
              data-day="${d}" tabindex="${sel ? '0' : '-1'}" aria-selected="${sel}" aria-label="${dayLabel(d, v)}">
              <div class="calx-cell__head">
                <span class="calx-num">${Number(d.slice(8))}</span>
                ${overdue ? html`<span class="calx-flag" title="Có việc quá hạn"></span>` : ''}
              </div>
              ${layers.tasks && v.tasks.length ? html`
                <div class="calx-chips">${v.tasks.slice(0, 3).map(chip)}${v.tasks.length > 3 ? html`<span class="calx-more">+${v.tasks.length - 3} việc</span>` : ''}</div>
                <div class="calx-dots" aria-hidden="true">${v.tasks.slice(0, 4).map((t) => html`<i data-p="${t.priority}" class="${isOpen(t) ? '' : 'is-done'}"></i>`)}</div>` : ''}
              <div class="calx-cell__foot">
                ${layers.time && v.secs ? html`<span class="calx-fig calx-fig--time">${minutes(v.secs / 60)}</span>` : ''}
                ${layers.money && v.spend ? html`<span class="calx-fig calx-fig--money">${moneyShort(v.spend)}</span>` : ''}
              </div>
              ${layers.time && v.secs ? html`<span class="calx-heat" style="--h:${Math.max(0.15, v.secs / maxSecs).toFixed(3)}"></span>` : ''}
            </div>`;
        })}</div>`)}
      </div>`);
  }

  function renderWeek() {
    const days = daysBetween(data.from, data.to);
    const labels = weekdayLabels();
    mount($('[data-main]'), html`
      <div class="calx-week" role="grid" aria-label="${titleOf('week', date)}"><div class="calx-week__row" role="row">
        ${days.map((d, i) => {
          const v = at(d);
          const sel = d === date;
          return html`
            <section role="gridcell" class="calx-wd ${d === t0 ? 'is-today' : ''} ${sel ? 'is-selected' : ''}" data-day="${d}" tabindex="${sel ? '0' : '-1'}" aria-selected="${sel}" aria-label="${dayLabel(d, v)}">
              <header class="calx-wd__head">
                <span class="calx-wd__dow">${labels[i]}</span>
                <span class="calx-wd__num">${Number(d.slice(8))}</span>
                ${layers.money && v.spend ? html`<span class="calx-fig calx-fig--money" title="Chi tiêu">${moneyShort(v.spend)}</span>` : ''}
              </header>
              ${layers.time ? html`
                <div class="calx-wd__time ${v.secs ? '' : 'is-empty'}" title="${v.entries.map((e) => `${time(e.started_at)}–${e.ended_at ? time(e.ended_at) : 'nay'} · ${minutes(entrySeconds(e) / 60)} · ${entryLabel(e)}`).join('\n')}">
                  ${track(v.entries)}
                  <span class="calx-fig calx-fig--time">${v.secs ? minutes(v.secs / 60) : '—'}</span>
                </div>` : ''}
              ${layers.tasks ? html`
                <div class="calx-wd__tasks">
                  ${v.tasks.map((t) => html`<div class="calx-card ${t.status === 'completed' ? 'is-done' : ''} ${t.status === 'cancelled' ? 'is-cancelled' : ''}" data-task="${t.id}" data-p="${t.priority}" draggable="${isOpen(t) ? 'true' : 'false'}" title="${t.title}">
                    <span class="calx-card__title">${t.title}</span>
                    <span class="calx-card__meta">${TASK_PRIORITY[t.priority] || ''}${t.estimated_minutes ? ` · ${minutes(t.estimated_minutes)}` : ''}</span>
                  </div>`)}
                </div>` : ''}
              <button type="button" class="calx-add" data-act="add-day" data-for="${d}" aria-label="Thêm việc cho ${day(d, 'weekday')}">${icon('plus')}<span>Thêm</span></button>
            </section>`;
        })}
      </div></div>`);
  }

  function renderAgenda() {
    const days = daysBetween(data.from, data.to).filter((d) => {
      const v = at(d);
      return d === t0 || (layers.tasks && v.tasks.length) || (layers.time && v.secs) || (layers.money && v.spend);
    });
    if (!days.length) {
      mount($('[data-main]'), emptyState({ art: 'calendar', title: 'Khoảng thời gian trống', text: `Không có việc, giờ làm hay khoản chi nào trong ${AGENDA_DAYS} ngày này.`, action: html`<button class="btn btn--sm" data-act="add">${icon('plus')} Thêm việc</button>` }));
      return;
    }
    mount($('[data-main]'), html`<div class="calx-agenda">${days.map((d) => {
      const v = at(d);
      const sums = [
        layers.tasks && v.tasks.length ? `${v.tasks.length} việc` : '',
        layers.time && v.secs ? minutes(v.secs / 60) : '',
        layers.money && v.spend ? moneyShort(v.spend) : '',
      ].filter(Boolean).join(' · ');
      return html`
        <section class="calx-ag ${d === t0 ? 'is-today' : ''}" aria-label="${day(d, 'long')}">
          <div class="group-head calx-ag__head">
            <span class="group-head__day">${day(d, 'weekday')}<small>${nearLabel(d)}</small></span>
            <span class="group-head__sum">${sums}</span>
          </div>
          ${layers.tasks ? taskList(v.tasks, d) : ''}
          ${layers.time && v.entries.length ? html`<div class="calx-ag__line">${icon('clock')}<span class="grow">${v.entries.length} phiên · ${minutes(v.secs / 60)}</span>${track(v.entries)}</div>` : ''}
          ${layers.money && v.expenses.length ? html`<div class="calx-ag__line">${icon('wallet')}<span class="grow truncate">${v.expenses.map((x) => x.description || x.category?.name || 'Khoản chi').slice(0, 3).join(', ')}${v.expenses.length > 3 ? '…' : ''}</span><span class="num">${money(v.spend)}</span></div>` : ''}
        </section>`;
    })}</div>`);
  }

  function taskList(tasks, d) {
    if (!tasks.length) {
      return html`<div class="calx-ag__empty"><span class="muted">Không có việc đến hạn.</span><button type="button" class="btn btn--ghost btn--sm" data-act="add-day" data-for="${d}">${icon('plus')} Thêm việc</button></div>`;
    }
    return html`<ul class="list">${tasks.map((t) => html`
      <li class="task-row calx-task ${t.status === 'completed' ? 'is-done' : ''} ${t.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${t.id}">
        <button class="tick" role="checkbox" aria-checked="${t.status === 'completed'}" data-act="toggle" data-p="${t.priority}" aria-label="Hoàn thành ${t.title}">${icon('check')}</button>
        <div class="task-row__main" data-act="edit" role="button" tabindex="0">
          <div class="task-row__title">${t.title}</div>
          <div class="task-row__meta">${prio(t.priority)}${catLabel(t.category_id)}${t.status === 'in_progress' ? statusBadge(t.status) : ''}</div>
        </div>
        <span></span>
      </li>`)}</ul>`;
  }

  /* ---------------------------------------------------------------- */
  /* Day sheet                                                         */
  /* ---------------------------------------------------------------- */

  function renderDay() {
    const box = $('[data-day-sheet]');
    if (view === 'agenda') { mount(box, ''); return; }
    const v = at(date);
    const open = v.tasks.filter(isOpen).length;
    mount(box, html`
      <div class="calx-day__head">
        <span class="calx-day__kicker">${nearLabel(date) || 'Ngày đã chọn'}</span>
        <h3>${day(date, 'weekday')}</h3>
        <dl class="calx-day__sum">
          <div><dt>Việc</dt><dd>${num(v.tasks.length)}${open && open !== v.tasks.length ? html`<small> · ${open} mở</small>` : ''}</dd></div>
          <div><dt>Đã làm</dt><dd>${minutes(v.secs / 60)}</dd></div>
          <div><dt>Đã chi</dt><dd>${moneyShort(v.spend)}</dd></div>
        </dl>
        <button type="button" class="btn btn--primary btn--block calx-day__add" data-act="add">${icon('plus')} Thêm việc cho ngày này</button>
      </div>
      <div class="calx-day__sect">
        <div class="calx-day__label"><span>Công việc đến hạn</span><a href="#/tasks">Mở danh sách</a></div>
        ${v.tasks.length ? taskList(v.tasks, date) : html`<p class="calx-day__none">Không có việc nào đến hạn.</p>`}
      </div>
      <div class="calx-day__sect">
        <div class="calx-day__label"><span>Phiên làm việc</span><a href="#/time">Bấm giờ</a></div>
        ${v.entries.length
          ? html`${track(v.entries)}<ul class="mini-list">${v.entries.map((e) => html`<li><span class="num muted">${time(e.started_at)}–${e.ended_at ? time(e.ended_at) : 'nay'}</span><span class="grow truncate">${entryLabel(e)}</span><span class="num">${minutes(entrySeconds(e) / 60)}</span></li>`)}</ul>`
          : html`<p class="calx-day__none">Chưa ghi nhận thời gian.</p>`}
      </div>
      <div class="calx-day__sect">
        <div class="calx-day__label"><span>Khoản chi</span><a href="#/expenses">Ghi khoản chi</a></div>
        ${v.expenses.length
          ? html`<ul class="mini-list">${v.expenses.map((x) => html`<li>${catLabel(x.category_id)}<span class="grow truncate">${x.description || ''}</span><span class="num">${money(x.amount)}</span></li>`)}</ul>${v.expenses.length > 1 ? html`<div class="calx-day__total"><span>Tổng</span><span class="num">${money(v.spend)}</span></div>` : ''}`
          : html`<p class="calx-day__none">Không có khoản chi.</p>`}
      </div>`);
  }

  /* ---------------------------------------------------------------- */
  /* Navigation                                                        */
  /* ---------------------------------------------------------------- */

  function setDate(d, { focus = false } = {}) {
    const { from, to } = rangeOf(view, date);
    const sameMonth = view !== 'month' || d.slice(0, 7) === date.slice(0, 7);
    date = d;
    if (d >= from && d <= to && sameMonth && view !== 'agenda') {
      // Same visible range: move the selection only.
      root.querySelectorAll('[data-day]').forEach((c) => {
        const on = c.dataset.day === d;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-selected', String(on));
        c.tabIndex = on ? 0 : -1;
      });
      syncChrome();
      renderDay();
      if (focus) root.querySelector(`[data-day="${d}"]`)?.focus();
      return;
    }
    load().then(() => { if (focus) root.querySelector(`[data-day="${d}"]`)?.focus(); });
  }

  function step(n) {
    if (view === 'month') date = addMonths(date, n);
    else if (view === 'week') date = addDays(date, 7 * n);
    else date = addDays(date, AGENDA_DAYS * n);
    load();
  }

  function goToday() {
    date = t0;
    load();
  }

  function addFor(d) {
    openTaskForm({ defaults: { due_date: d }, onSaved: () => { notifyDataChanged('tasks'); } });
  }

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'prev') step(-1);
    if (act === 'next') step(1);
    if (act === 'today') goToday();
    if (act === 'retry') load({ force: true });
    if (act === 'add') addFor(view === 'agenda' ? t0 : date);
    if (act === 'add-day') { e.stopPropagation(); addFor(el.dataset.for); }
    const id = el.closest('[data-id]')?.dataset.id;
    const t = id && data.tasks.find((x) => x.id === id);
    if (t && act === 'edit') openTaskForm({ task: t, onSaved: () => notifyDataChanged('tasks'), onDeleted: () => notifyDataChanged('tasks') });
    if (t && act === 'toggle') {
      const prev = t.status;
      const next = prev === 'completed' ? 'todo' : 'completed';
      el.setAttribute('aria-checked', String(next === 'completed'));
      try {
        await setTaskStatus(t.id, next);
        t.status = next;
        buildIndex();
        renderMain();
        renderDay();
        if (next === 'completed') toast(`Đã hoàn thành “${t.title}”.`);
      } catch (err) {
        el.setAttribute('aria-checked', String(prev === 'completed'));
        toast.error(err);
      }
    }
  }));

  // Chip / card click → edit the task (and select its day).
  disposers.push(on(root, 'click', '[data-task]', (e, el) => {
    const t = data.tasks.find((x) => x.id === el.dataset.task);
    if (t) openTaskForm({ task: t, onSaved: () => notifyDataChanged('tasks'), onDeleted: () => notifyDataChanged('tasks') });
  }));

  disposers.push(on(root, 'click', '[data-day]', (e, el) => {
    if (e.target.closest('[data-task], [data-act]')) return;
    setDate(el.dataset.day);
  }));
  disposers.push(on(root, 'dblclick', '[data-day]', (e, el) => {
    if (e.target.closest('[data-task], [data-act]')) return;
    addFor(el.dataset.day);
  }));
  disposers.push(on(root, 'keydown', '.task-row__main[data-act]', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  }));
  disposers.push(on(root, 'keydown', '[data-day]', (e, el) => {
    if (e.target !== el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDate(el.dataset.day); return; }
    const delta = view === 'week'
      ? { ArrowLeft: -1, ArrowRight: 1 }[e.key]
      : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!delta) return;
    e.preventDefault();
    e.stopPropagation();
    setDate(addDays(el.dataset.day, delta), { focus: true });
  }));

  disposers.push(on(root, 'click', '[data-view]', (e, el) => {
    if (el.dataset.view === view) return;
    view = el.dataset.view;
    load();
  }));
  disposers.push(on(root, 'click', '[data-layer]', (e, el) => {
    const k = el.dataset.layer;
    layers = { ...layers, [k]: !layers[k] };
    el.setAttribute('aria-pressed', String(layers[k]));
    writeLayers(layers);
    renderMain();
  }));

  // ←/→ anywhere on the page (not while typing or in a dialog).
  const onKey = (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!root.isConnected || document.querySelector('dialog[open]')) return;
    const tg = e.target;
    if (tg instanceof Element && tg.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .menu')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); goToday(); }
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addFor(view === 'agenda' ? t0 : date); }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  /* ---------- Drag & drop rescheduling (pointer: fine) ---------- */
  disposers.push(on(root, 'dragstart', '[data-task]', (e, el) => {
    if (el.getAttribute('draggable') !== 'true') { e.preventDefault(); return; }
    dragId = el.dataset.task;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
    el.classList.add('is-dragging');
    root.querySelector('[data-main]').classList.add('is-dragging');
  }));
  disposers.push(on(root, 'dragend', '[data-task]', (e, el) => {
    el.classList.remove('is-dragging');
    dragId = null;
    root.querySelector('[data-main]')?.classList.remove('is-dragging');
    root.querySelectorAll('.is-drop').forEach((c) => c.classList.remove('is-drop'));
  }));
  disposers.push(on(root, 'dragover', '[data-day]', (e, el) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!el.classList.contains('is-drop')) {
      root.querySelectorAll('.is-drop').forEach((c) => c.classList.remove('is-drop'));
      el.classList.add('is-drop');
    }
  }));
  disposers.push(on(root, 'dragleave', '[data-day]', (e, el) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop');
  }));
  disposers.push(on(root, 'drop', '[data-day]', (e, el) => {
    if (!dragId) return;
    e.preventDefault();
    el.classList.remove('is-drop');
    const id = dragId;
    dragId = null;
    reschedule(id, el.dataset.day);
  }));

  async function reschedule(id, d) {
    const t = data.tasks.find((x) => x.id === id);
    if (!t || t.due_date === d) return;
    const prev = t.due_date;
    const apply = (v) => { t.due_date = v; buildIndex(); renderMain(); renderDay(); };
    apply(d);
    try {
      await updateTask(id, { due_date: d });
      toast(`Đã dời “${t.title}” sang ${day(d, 'weekday')}.`, {
        action: {
          label: 'Hoàn tác',
          onClick: async () => {
            try { await updateTask(id, { due_date: prev }); apply(prev); } catch (err) { toast.error(err); }
          },
        },
      });
    } catch (err) {
      apply(prev);
      toast.error(err);
    }
  }

  disposers.push(onDataChanged(() => load({ force: true })));

  await load();
  return () => {
    token++;
    disposers.forEach((d) => d());
  };
}

