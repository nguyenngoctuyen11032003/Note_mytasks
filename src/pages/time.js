import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel } from '../components/ui.js';
import { emptyState, errorState, loadingRows, loadingBlock } from '../components/states.js';
import { openModal, field, input, select, confirmDialog } from '../components/modal.js';
import { makeChart, palette } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { listTasks } from '../services/tasks.js';
import { listEntries, entrySeconds, createManualEntry, updateEntry, deleteEntry } from '../services/timeEntries.js';
import { today, addDays, startOfWeek, startOfMonth, endOfMonth, daysBetween, dayOf, dayStartInstant, dayEndInstant, toLocalInput, fromLocalInput } from '../utils/date.js';
import { clock, minutes, hours, day, time, relDay, dec } from '../utils/format.js';

const RANGES = [
  { id: 'week', label: 'Tuần này' },
  { id: 'lastweek', label: 'Tuần trước' },
  { id: 'month', label: 'Tháng này' },
  { id: '30d', label: '30 ngày' },
];

export default async function timePage(root, { query }) {
  let range = RANGES.some((r) => r.id === query.range) ? query.range : 'week';
  let tasks = [];
  let entries = [];
  let charts = [];
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '04',
      kicker: 'Thời gian',
      title: 'Đo đếm từng <em>khoảnh khắc</em>',
      lede: 'Bấm giờ khi bắt tay vào việc, tạm dừng khi bị gián đoạn. Thời gian được cộng dồn vào từng công việc.',
      actions: html`<button class="btn" data-act="manual">${icon('edit')} Ghi giờ thủ công</button>`,
    })}
    <section class="grid grid-12">
      <article class="sheet sheet--ticked span-7 stopwatch" data-watch>${loadingBlock(260)}</article>
      <div class="span-5 grid" style="grid-template-rows:auto 1fr" data-summary>${loadingBlock(260)}</div>
    </section>
    <div class="row between" style="margin:var(--s-7) 0 var(--s-4);flex-wrap:wrap;gap:var(--s-3)">
      <h2 class="display" style="font-size:var(--fs-2xl);font-weight:400">Nhật ký <em style="color:var(--accent)">thời gian</em></h2>
      <div class="segmented" role="group" aria-label="Khoảng thời gian">${RANGES.map((r) => html`<button type="button" data-range="${r.id}" aria-pressed="${r.id === range}">${r.label}</button>`)}</div>
    </div>
    <section class="grid grid-12">
      <article class="sheet span-8" data-log>${loadingRows(6)}</article>
      <div class="span-4 stack">
        <article class="sheet" data-chart-card>${sheetHead('T.2', 'Theo ngày')}<div class="sheet__body">${loadingBlock(200)}</div></article>
        <article class="sheet" data-bytask>${sheetHead('T.3', 'Theo công việc')}${loadingRows(3)}</article>
      </div>
    </section>`);

  const $ = (s) => root.querySelector(s);
  const taskById = (id) => tasks.find((t) => t.id === id);

  function bounds() {
    const t0 = today();
    if (range === 'lastweek') { const s = addDays(startOfWeek(t0), -7); return [s, addDays(s, 6)]; }
    if (range === 'month') return [startOfMonth(t0), endOfMonth(t0)];
    if (range === '30d') return [addDays(t0, -29), t0];
    return [startOfWeek(t0), addDays(startOfWeek(t0), 6)];
  }

  /* ---------- stopwatch ---------- */
  function renderWatch() {
    const run = store.get().runningEntry;
    const paused = !run && timer.pausedSession();
    const openTasks = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
    const curTask = run ? run.task_id : paused ? paused.task_id : '';
    const state = run ? 'running' : paused ? 'paused' : 'idle';
    mount($('[data-watch]'), html`
      ${sheetHead('T.1', 'Đồng hồ bấm giờ', html`<span class="badge ${state === 'running' ? 'badge--accent' : state === 'paused' ? 'badge--warning' : 'badge--muted'}">${state === 'running' ? 'Đang chạy' : state === 'paused' ? 'Tạm dừng' : 'Sẵn sàng'}</span>`)}
      <div class="sheet__body stopwatch__body" data-state="${state}">
        <div class="stopwatch__dial" aria-hidden="true">${dial()}</div>
        <div class="stopwatch__main">
          <div class="stopwatch__clock num" data-clock aria-live="off">${clock(timer.sessionSeconds())}</div>
          ${state === 'idle'
            ? html`
              <div class="form" style="gap:var(--s-3)">
                <select class="select" data-task aria-label="Công việc">
                  <option value="">— Không gắn công việc —</option>
                  ${openTasks.map((t) => html`<option value="${t.id}" ${t.id === query.task ? raw('selected') : ''}>${t.title}</option>`)}
                </select>
                <input class="input" data-desc maxlength="500" placeholder="Bạn đang làm gì? (không bắt buộc)" aria-label="Mô tả phiên" />
              </div>`
            : html`<div class="stopwatch__task">
                <span class="eyebrow">Đang tính cho</span>
                <strong>${(run ? run.task?.title : taskById(curTask)?.title) || (run ? run.description : paused.description) || 'Phiên không gắn công việc'}</strong>
                ${run ? html`<span class="muted" style="font-size:var(--fs-xs)">Bắt đầu lúc ${time(run.started_at)}</span>` : ''}
              </div>`}
          <div class="stopwatch__ctrl">
            ${state === 'running' ? html`<button class="btn btn--lg" data-act="pause">${icon('pause')} Tạm dừng</button><button class="btn btn--lg btn--accent" data-act="stop">${icon('stop')} Dừng & lưu</button>` : ''}
            ${state === 'paused' ? html`<button class="btn btn--lg btn--primary" data-act="resume">${icon('play')} Tiếp tục</button><button class="btn btn--lg" data-act="stop">${icon('stop')} Kết thúc phiên</button>` : ''}
            ${state === 'idle' ? html`<button class="btn btn--lg btn--primary btn--block" data-act="start">${icon('play')} Bắt đầu</button>` : ''}
          </div>
        </div>
      </div>`);
  }

  function dial() {
    const ticks = Array.from({ length: 60 }, (_, i) => {
      const a = (i / 60) * Math.PI * 2, r1 = i % 5 ? 92 : 86, r2 = 98;
      return `<line x1="${100 + Math.sin(a) * r1}" y1="${100 - Math.cos(a) * r1}" x2="${100 + Math.sin(a) * r2}" y2="${100 - Math.cos(a) * r2}" ${i % 5 ? 'opacity=".45"' : ''}/>`;
    }).join('');
    const s = timer.sessionSeconds() % 60;
    const a = (s / 60) * 360;
    return raw(`<svg viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="1"><circle cx="100" cy="100" r="99" opacity=".25"/>${ticks}<g data-hand style="transform:rotate(${a}deg);transform-origin:100px 100px"><line x1="100" y1="112" x2="100" y2="22" stroke="var(--accent)" stroke-width="1.5"/><circle cx="100" cy="100" r="4" fill="var(--accent)" stroke="none"/></g></svg>`);
  }

  disposers.push(timer.onTick(() => {
    const s = timer.sessionSeconds();
    const el = root.querySelector('[data-clock]');
    if (el) el.textContent = clock(s);
    const hand = root.querySelector('[data-hand]');
    if (hand) hand.style.transform = `rotate(${(s % 60) * 6}deg)`;
  }));
  disposers.push(store.subscribe((_, p) => { if ('runningEntry' in p) renderWatch(); }));

  /* ---------- summary ---------- */
  function renderSummary() {
    const t0 = today(), ws = startOfWeek(t0);
    const all = entries;
    const sumFor = (pred) => all.filter(pred).reduce((s, e) => s + entrySeconds(e), 0);
    const todaySecs = sumFor((e) => dayOf(e.started_at) === t0);
    const weekSecs = sumFor((e) => dayOf(e.started_at) >= ws);
    const est = tasks.filter((t) => t.status !== 'cancelled' && t.estimated_minutes && t.actual_minutes);
    const acc = est.length ? est.reduce((s, t) => s + t.actual_minutes, 0) / est.reduce((s, t) => s + t.estimated_minutes, 0) : null;
    mount($('[data-summary]'), html`
      <div class="grid grid-2" style="gap:var(--s-4)">
        <div class="stat stat--accent"><div class="stat__label"><span class="eyebrow">Hôm nay</span><span class="stat__icon">${icon('clock')}</span></div><div class="stat__value">${hours(todaySecs / 60)}</div><div class="stat__meta">${minutes(todaySecs / 60)}</div></div>
        <div class="stat"><div class="stat__label"><span class="eyebrow">Tuần này</span><span class="stat__icon">${icon('calendar')}</span></div><div class="stat__value">${hours(weekSecs / 60)}</div><div class="stat__meta">TB ${hours(weekSecs / 60 / Math.max(1, daysBetween(ws, t0).length))} / ngày</div></div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Độ chính xác ước tính</span><span class="stat__icon">${icon('target')}</span></div>
        ${acc == null
          ? html`<p class="muted" style="font-size:var(--fs-sm)">Đặt “thời gian ước tính” cho công việc và bấm giờ để xem bạn ước lượng sát đến đâu.</p>`
          : html`<div class="stat__value">${dec(Math.round(acc * 100) / 100)}<small>× ước tính</small></div>
                 <div class="stat__meta">${acc > 1.15 ? 'Bạn thường mất nhiều thời gian hơn dự kiến — hãy cộng thêm dư địa.' : acc < 0.85 ? 'Bạn thường xong sớm hơn dự kiến.' : 'Ước tính của bạn khá sát thực tế.'} (${est.length} việc)</div>`}
      </div>`);
  }

  /* ---------- log ---------- */
  function renderLog() {
    const [from, to] = bounds();
    const rows = entries.filter((e) => { const d = dayOf(e.started_at); return d >= from && d <= to; });
    const total = rows.reduce((s, e) => s + entrySeconds(e), 0);
    const head = sheetHead('T.4', `Các phiên · ${day(from)} – ${day(to)}`, html`<span class="num muted" style="font-size:var(--fs-sm)">${minutes(total / 60)}</span>`);
    if (!rows.length) {
      mount($('[data-log]'), html`${head}${emptyState({ art: 'clock', small: true, title: 'Chưa có phiên nào', text: 'Bấm “Bắt đầu” ở trên hoặc ghi giờ thủ công cho khoảng thời gian bạn đã làm.', action: html`<button class="btn btn--sm" data-act="manual">${icon('plus')} Ghi giờ thủ công</button>` })}`);
      return;
    }
    const groups = new Map();
    rows.forEach((e) => { const d = dayOf(e.started_at); (groups.get(d) || groups.set(d, []).get(d)).push(e); });
    mount($('[data-log]'), html`${head}
      ${[...groups.entries()].map(([d, list]) => html`
        <div class="group-head"><span class="group-head__day">${relDay(d)}<small>${day(d, 'numeric')}</small></span><span class="group-head__sum">${minutes(list.reduce((s, e) => s + entrySeconds(e), 0) / 60)}</span></div>
        <ul class="list">
          ${list.map((e) => {
            const t = taskById(e.task_id);
            const running = !e.ended_at;
            return html`<li class="entry-row" data-id="${e.id}">
              <span class="entry-row__time num">${time(e.started_at)}<span class="faint"> – </span>${running ? html`<span class="success-text">đang chạy</span>` : time(e.ended_at)}</span>
              <div class="grow" style="min-width:0">
                <div class="truncate" style="font-weight:500">${t?.title || e.description || html`<span class="muted">Không gắn công việc</span>`}</div>
                <div class="row-wrap" style="margin-top:2px">${t ? catLabel(t.category_id) : ''}${t && e.description ? html`<span class="muted truncate" style="font-size:var(--fs-xs)">${e.description}</span>` : ''}${e.source === 'manual' ? html`<span class="badge badge--plain badge--outline">Thủ công</span>` : ''}</div>
              </div>
              <span class="entry-row__dur num">${minutes(entrySeconds(e) / 60)}</span>
              <span class="row" style="gap:0">
                ${running ? '' : html`<button class="icon-btn icon-btn--sm" data-act="edit-entry" aria-label="Sửa phiên">${icon('edit')}</button><button class="icon-btn icon-btn--sm" data-act="del-entry" aria-label="Xóa phiên">${icon('trash')}</button>`}
              </span>
            </li>`;
          })}
        </ul>`)}`);
  }

  function renderCharts() {
    charts.forEach((d) => d());
    charts = [];
    const [from, to] = bounds();
    const days = daysBetween(from, to);
    const per = Object.fromEntries(days.map((d) => [d, 0]));
    const perTask = new Map();
    entries.forEach((e) => {
      const d = dayOf(e.started_at);
      if (!(d in per)) return;
      const s = entrySeconds(e);
      per[d] += s;
      const k = e.task_id || '__none';
      perTask.set(k, (perTask.get(k) || 0) + s);
    });
    mount($('[data-chart-card]'), html`${sheetHead('T.2', 'Theo ngày')}<div class="sheet__body"><div class="chart-box chart-box--sm" data-c></div></div>`);
    const p = palette();
    charts.push(makeChart($('[data-chart-card] [data-c]'), {
      type: 'bar',
      data: { labels: days.map((d) => (days.length > 8 ? d.slice(8) : day(d).replace(' thg ', '/'))), datasets: [{ data: days.map((d) => Math.round((per[d] / 3600) * 10) / 10), backgroundColor: days.map((d) => (d === today() ? p.accent : p.ink)), borderRadius: 3, maxBarThickness: 18 }] },
      options: { scales: { y: { ticks: { callback: (v) => v + 'g' } } }, plugins: { tooltip: { callbacks: { label: (c) => ` ${c.raw} giờ` } } } },
    }));
    const top = [...perTask.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const max = top[0]?.[1] || 1;
    mount($('[data-bytask]'), html`${sheetHead('T.3', 'Theo công việc')}
      ${top.length ? html`<ul class="list bytask">${top.map(([id, s]) => {
        const t = id === '__none' ? null : taskById(id);
        return html`<li><div class="row between"><span class="truncate">${t?.title || (id === '__none' ? 'Không gắn công việc' : 'Công việc đã xóa')}</span><span class="num muted">${minutes(s / 60)}</span></div><div class="bar bar--thin" style="margin-top:6px"><span style="width:${(s / max) * 100}%;--c:var(--accent)"></span></div></li>`;
      })}</ul>` : html`<p class="muted sheet__body" style="font-size:var(--fs-sm)">Chưa có dữ liệu.</p>`}`);
  }

  /* ---------- manual / edit entry ---------- */
  function openEntryForm(entry = null) {
    const now = new Date();
    const start = entry ? new Date(entry.started_at) : new Date(now.getTime() - 60 * 60000);
    const end = entry ? new Date(entry.ended_at) : now;
    const opts = [{ value: '', label: '— Không gắn công việc —' }, ...tasks.filter((t) => t.status !== 'cancelled' || t.id === entry?.task_id).map((t) => ({ value: t.id, label: t.title }))];
    openModal({
      eyebrow: entry ? 'Sửa phiên' : 'Ghi giờ thủ công',
      title: entry ? 'Chỉnh sửa phiên làm việc' : 'Thêm khoảng thời gian đã làm',
      body: html`<div class="form">
        ${field({ label: 'Công việc', name: 'task_id', control: select('task_id', opts, entry?.task_id || query.task || '') })}
        <div class="form-row">
          ${field({ label: 'Bắt đầu', name: 'started_at', control: input('started_at', toLocalInput(start), 'type="datetime-local" required') })}
          ${field({ label: 'Kết thúc', name: 'ended_at', control: input('ended_at', toLocalInput(end), 'type="datetime-local" required') })}
        </div>
        ${field({ label: 'Ghi chú', name: 'description', optional: true, control: input('description', entry?.description || '', 'maxlength="500" placeholder="Ví dụ: Họp với khách hàng"') })}
        <p class="field__hint" data-dur></p>
      </div>`,
      submitLabel: entry ? 'Lưu' : 'Thêm phiên',
      onOpen(el) {
        const upd = () => {
          const a = el.querySelector('[name=started_at]').value, b = el.querySelector('[name=ended_at]').value;
          if (a && b) { const m = (fromLocalInput(b) - fromLocalInput(a)) / 60000; el.querySelector('[data-dur]').textContent = m > 0 ? `Thời lượng: ${minutes(m)}` : ''; }
        };
        el.addEventListener('input', upd);
        upd();
      },
      validate(v) {
        const e = {};
        if (!v.started_at) e.started_at = 'Chọn thời điểm bắt đầu.';
        if (!v.ended_at) e.ended_at = 'Chọn thời điểm kết thúc.';
        else if (v.started_at && fromLocalInput(v.ended_at) <= fromLocalInput(v.started_at)) e.ended_at = 'Kết thúc phải sau bắt đầu.';
        else if (fromLocalInput(v.ended_at) > new Date(Date.now() + 60000)) e.ended_at = 'Không thể ghi giờ trong tương lai.';
        return e;
      },
      async onSubmit(v) {
        const payload = { task_id: v.task_id || null, description: v.description || null, started_at: fromLocalInput(v.started_at).toISOString(), ended_at: fromLocalInput(v.ended_at).toISOString() };
        if (entry) await updateEntry(entry.id, payload); else await createManualEntry(payload);
        toast(entry ? 'Đã lưu phiên.' : 'Đã thêm phiên làm việc.');
        await load();
      },
    });
  }

  /* ---------- data ---------- */
  async function load() {
    const t0 = today();
    const from = [addDays(startOfWeek(t0), -7), startOfMonth(t0), addDays(t0, -29)].sort()[0];
    try {
      const [tk, en] = await Promise.all([
        listTasks({ limit: 1000 }),
        listEntries(dayStartInstant(from).toISOString(), dayEndInstant(t0).toISOString()),
      ]);
      tasks = tk;
      entries = en;
      renderWatch();
      renderSummary();
      renderLog();
      renderCharts();
    } catch (err) {
      mount($('[data-log]'), html`<div class="sheet__body">${errorState(err)}</div>`);
    }
  }

  async function act(fn, msg) {
    try { await fn(); if (msg) toast(msg); } catch (err) { toast.error(err); }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'start') {
      const taskId = root.querySelector('[data-task]')?.value || null;
      const desc = root.querySelector('[data-desc]')?.value.trim() || null;
      await act(() => timer.start({ taskId, description: desc }));
      load();
    }
    if (a === 'pause') await act(timer.pause);
    if (a === 'resume') await act(timer.resume);
    if (a === 'stop') { await act(timer.stop, 'Đã lưu phiên làm việc.'); load(); }
    if (a === 'manual') openEntryForm();
    if (a === 'retry') load();
    const id = el.closest('[data-id]')?.dataset.id;
    const entry = id && entries.find((x) => x.id === id);
    if (entry && a === 'edit-entry') openEntryForm(entry);
    if (entry && a === 'del-entry') {
      if (!(await confirmDialog({ title: 'Xóa phiên này?', message: `Phiên ${minutes(entrySeconds(entry) / 60)} sẽ bị xóa và thời gian thực tế của công việc được tính lại.` }))) return;
      await act(() => deleteEntry(entry.id), 'Đã xóa phiên.');
      load();
    }
  }));
  disposers.push(on(root, 'click', '[data-range]', (e, el) => {
    range = el.dataset.range;
    root.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    setQuery({ range: range === 'week' ? null : range });
    renderLog();
    renderCharts();
  }));
  disposers.push(onDataChanged(load));

  await load();
  if (query.new) { setQuery({ new: null }); openEntryForm(); }

  return () => { disposers.forEach((d) => d()); charts.forEach((d) => d()); };
}
