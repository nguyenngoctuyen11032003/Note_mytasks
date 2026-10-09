import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel, dueLabel, prio, ring, bar, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, statTileSkeleton, loadingRows, loadingBlock } from '../components/states.js';
import { openTaskForm } from '../components/taskForm.js';
import { makeChart, palette, series } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { onDataChanged } from '../core/events.js';
import { listTasks, setTaskStatus } from '../services/tasks.js';
import { listEntries, entrySeconds } from '../services/timeEntries.js';
import { listExpenses } from '../services/expenses.js';
import { listBudgets, resolveBudgets } from '../services/budgets.js';
import { listKpis, kpiProgress } from '../services/kpis.js';
import { listShopping } from '../services/shopping.js';
import { recentActivity } from '../services/activity.js';
import { today, addDays, startOfWeek, startOfMonth, endOfMonth, daysBetween, dayOf, dayStartInstant, dayEndInstant, diffDays } from '../utils/date.js';
import { money, moneyShort, minutes, hours, num, day, ago, clock, pct, dec } from '../utils/format.js';

export default async function dashboard(root) {
  const disposers = [];
  let charts = [];

  const greet = () => {
    const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: undefined }).format(new Date()));
    if (h < 11) return 'Chào buổi sáng';
    if (h < 14) return 'Chào buổi trưa';
    if (h < 18) return 'Chào buổi chiều';
    return 'Chào buổi tối';
  };

  mount(root, html`
    ${pageHead({
      num: '01',
      kicker: 'Tổng quan',
      title: `${greet()}, <em>${escapeHtml(store.displayName())}</em>.`,
      lede: `${day(today(), 'long')} — đây là bức tranh toàn cảnh của bạn hôm nay.`,
      actions: html`<button class="btn" data-act="go-time">${icon('timer')} Bấm giờ</button><button class="btn btn--primary" data-act="new-task">${icon('plus')} Công việc mới</button>`,
    })}
    <section class="grid grid-4" data-stats>${statTileSkeleton(4)}</section>
    <section class="grid grid-12" style="margin-top:var(--s-5)">
      <article class="sheet span-7" data-agenda>${sheetHead('A.1', 'Việc cần làm')}${loadingRows(5)}</article>
      <div class="span-5 stack">
        <article class="sheet sheet--ticked" data-timer-card>${sheetHead('A.2', 'Đồng hồ')}<div class="sheet__body">${loadingBlock(110)}</div></article>
        <article class="sheet" data-activity>${sheetHead('A.3', 'Hoạt động gần đây')}${loadingRows(3)}</article>
      </div>
      <article class="sheet span-7" data-week>${sheetHead('B.1', '14 ngày qua')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-5" data-spend>${sheetHead('B.2', 'Chi tiêu tháng này')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-7" data-kpi>${sheetHead('C.1', 'Mục tiêu đang theo đuổi')}${loadingRows(3)}</article>
      <article class="sheet span-5" data-shop>${sheetHead('C.2', 'Danh sách mua sắm')}${loadingRows(3)}</article>
    </section>`);

  const $ = (s) => root.querySelector(s);

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    if (act === 'new-task') openTaskForm({ defaults: { due_date: today() }, onSaved: load });
    if (act === 'go-time') location.hash = '#/time';
    if (act === 'retry') load();
    if (act === 'tick') {
      const t = state.open.find((x) => x.id === el.dataset.id);
      if (!t) return;
      el.setAttribute('aria-checked', 'true');
      try {
        await setTaskStatus(t.id, 'completed');
        toast(`Đã hoàn thành “${t.title}”.`, {
          action: { label: 'Hoàn tác', onClick: async () => { await setTaskStatus(t.id, t.status); load(); } },
        });
        load();
      } catch (err) {
        el.setAttribute('aria-checked', 'false');
        toast.error(err);
      }
    }
    if (act === 'open-task') {
      const t = state.open.find((x) => x.id === el.dataset.id);
      if (t) openTaskForm({ task: t, onSaved: load, onDeleted: load });
    }
    if (act === 'timer-start') runTimer(() => timer.start({ taskId: el.dataset.task || null }));
    if (act === 'timer-pause') runTimer(timer.pause);
    if (act === 'timer-resume') runTimer(timer.resume);
    if (act === 'timer-stop') runTimer(async () => { await timer.stop(); toast('Đã lưu phiên tính giờ.'); load(); });
  }));

  async function runTimer(fn) {
    try { await fn(); renderTimer(); } catch (err) { toast.error(err); }
  }

  let state = { open: [] };

  async function load() {
    const t0 = today();
    const weekStart = startOfWeek(t0);
    const from14 = addDays(t0, -13);
    const mStart = startOfMonth(t0);
    try {
      const [open, completed, entries, expenses, budgets, kpis, shopping, activity] = await Promise.all([
        listTasks({ status: ['todo', 'in_progress'], limit: 1000 }),
        listTasks({ status: ['completed'], limit: 1000 }).then((rows) => rows.filter((t) => t.completed_at && dayOf(t.completed_at) >= addDays(weekStart, -7))),
        listEntries(dayStartInstant(from14).toISOString(), dayEndInstant(t0).toISOString()),
        listExpenses({ from: mStart, to: endOfMonth(t0) }),
        listBudgets(),
        listKpis(),
        listShopping(),
        recentActivity(8),
      ]);
      state = { open, completed, entries, expenses, budgets, kpis, shopping, activity, t0, weekStart, from14, mStart };
      renderAll();
    } catch (err) {
      mount($('[data-stats]'), html`<div style="grid-column:1/-1">${errorState(err)}</div>`);
    }
  }

  function renderAll() {
    charts.forEach((d) => d());
    charts = [];
    renderStats();
    renderAgenda();
    renderTimer();
    renderActivity();
    renderWeek();
    renderSpend();
    renderKpi();
    renderShop();
  }

  function renderStats() {
    const { open, completed, entries, expenses, budgets, t0, weekStart, mStart } = state;
    const dueToday = open.filter((t) => t.due_date && t.due_date <= t0);
    const overdue = open.filter((t) => t.due_date && t.due_date < t0).length;
    const doneThis = completed.filter((t) => dayOf(t.completed_at) >= weekStart).length;
    const doneLast = completed.length - doneThis;
    const weekSecs = entries.filter((e) => dayOf(e.started_at) >= weekStart).reduce((s, e) => s + entrySeconds(e), 0);
    const spent = expenses.reduce((s, x) => s + Number(x.amount), 0);
    const { overall } = resolveBudgets(budgets, mStart);
    const delta = doneThis - doneLast;

    mount($('[data-stats]'), html`
      <div class="stat stat--accent">
        <div class="stat__label"><span class="eyebrow">Việc hôm nay</span><span class="stat__icon">${icon('flag')}</span></div>
        <div class="stat__value">${num(dueToday.length)}<small>việc</small></div>
        <div class="stat__meta">${overdue ? html`<span class="delta delta--down">${overdue} quá hạn</span>` : html`<span>Không có việc quá hạn</span>`}</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Hoàn thành tuần này</span><span class="stat__icon">${icon('checkCircle')}</span></div>
        <div class="stat__value">${num(doneThis)}<small>việc</small></div>
        <div class="stat__meta">${delta !== 0 ? html`<span class="delta ${delta > 0 ? 'delta--up' : 'delta--down'}">${delta > 0 ? '+' : ''}${delta}</span>` : ''}<span>so với tuần trước (${doneLast})</span></div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Giờ làm tuần này</span><span class="stat__icon">${icon('clock')}</span></div>
        <div class="stat__value">${dec(Math.round((weekSecs / 3600) * 10) / 10)}<small>giờ</small></div>
        <div class="stat__meta"><span>${minutes(weekSecs / 60)} từ ${entries.filter((e) => dayOf(e.started_at) >= weekStart).length} phiên</span></div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Chi tiêu tháng</span><span class="stat__icon">${icon('wallet')}</span></div>
        <div class="stat__value" style="font-size:var(--fs-2xl)">${money(spent)}</div>
        <div class="stat__meta" style="display:grid;gap:6px">
          ${overall ? html`${bar((spent / overall) * 100, { thin: true, over: spent > overall, color: 'var(--accent)' })}<span>${pct((spent / overall) * 100)} ngân sách ${money(overall, { compact: true })}</span>` : html`<span>Chưa đặt ngân sách — <a href="#/expenses">đặt ngay</a></span>`}
        </div>
      </div>`);
  }

  function renderAgenda() {
    const { open, t0 } = state;
    const horizon = addDays(t0, 7);
    const rows = open
      .filter((t) => !t.due_date || t.due_date <= horizon)
      .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
      .slice(0, 8);
    const overdue = open.filter((t) => t.due_date && t.due_date < t0).length;
    const head = sheetHead('A.1', 'Việc cần làm', html`<a class="btn btn--ghost btn--sm" href="#/tasks">Tất cả (${open.length}) ${icon('arrowRight')}</a>`);
    if (!rows.length) {
      mount($('[data-agenda]'), html`${head}${emptyState({ art: 'tasks', small: true, title: 'Một ngày thật thoáng', text: 'Không có việc nào đến hạn trong 7 ngày tới.', action: html`<button class="btn btn--sm" data-act="new-task">${icon('plus')} Thêm việc</button>` })}`);
      return;
    }
    mount($('[data-agenda]'), html`${head}
      <ul class="list">
        ${rows.map((t) => html`
          <li class="task-row">
            <button class="tick" role="checkbox" aria-checked="false" data-act="tick" data-id="${t.id}" data-p="${t.priority}" aria-label="Hoàn thành ${t.title}">${icon('check')}</button>
            <div class="task-row__main" data-act="open-task" data-id="${t.id}">
              <div class="task-row__title">${t.title}</div>
              <div class="task-row__meta">${dueLabel(t.due_date, t.status)}${prio(t.priority)}${catLabel(t.category_id)}${t.status === 'in_progress' ? html`<span class="badge badge--info">Đang làm</span>` : ''}</div>
            </div>
            <div class="task-row__side">
              <button class="icon-btn icon-btn--sm" data-act="timer-start" data-task="${t.id}" title="Bấm giờ cho việc này" aria-label="Bấm giờ">${icon('play')}</button>
            </div>
          </li>`)}
      </ul>
      ${overdue ? html`<div class="sheet__foot"><span class="danger-text">${icon('alert', '')} ${overdue} việc đã quá hạn</span><a href="#/tasks?view=overdue">Xem</a></div>` : ''}`);
  }

  function renderTimer() {
    const run = store.get().runningEntry;
    const paused = !run && timer.pausedSession();
    const box = $('[data-timer-card]');
    if (!box) return;
    const secs = timer.sessionSeconds();
    mount(box, html`
      ${sheetHead('A.2', 'Đồng hồ', run ? html`<span class="badge badge--accent">Đang chạy</span>` : paused ? html`<span class="badge badge--warning">Tạm dừng</span>` : '')}
      <div class="sheet__body dash-timer">
        <div class="dash-timer__clock num" data-clock>${clock(secs)}</div>
        <div class="dash-timer__task truncate">${run ? run.task?.title || run.description || 'Không gắn công việc' : paused ? paused.title || 'Phiên tạm dừng' : 'Chưa có phiên nào đang chạy'}</div>
        <div class="row" style="margin-top:var(--s-4)">
          ${run
            ? html`<button class="btn" data-act="timer-pause">${icon('pause')} Tạm dừng</button><button class="btn btn--accent" data-act="timer-stop">${icon('stop')} Dừng & lưu</button>`
            : paused
              ? html`<button class="btn btn--primary" data-act="timer-resume">${icon('play')} Tiếp tục</button><button class="btn" data-act="timer-stop">${icon('stop')} Kết thúc</button>`
              : html`<button class="btn btn--primary" data-act="timer-start">${icon('play')} Bắt đầu nhanh</button><a class="btn btn--ghost" href="#/time">Chọn công việc</a>`}
        </div>
      </div>`);
  }
  disposers.push(timer.onTick(() => {
    const el = root.querySelector('[data-clock]');
    if (el) el.textContent = clock(timer.sessionSeconds());
  }));
  disposers.push(store.subscribe((_, patch) => { if ('runningEntry' in patch) renderTimer(); }));

  function renderActivity() {
    const { activity } = state;
    const ICON = { task: 'tasks', expense: 'wallet', shopping_item: 'cart', kpi: 'target' };
    const VERB = {
      'task:created': 'Tạo công việc', 'task:completed': 'Hoàn thành',
      'expense:created': 'Ghi khoản chi', 'shopping_item:created': 'Thêm vào danh sách mua',
      'shopping_item:completed': 'Đã mua', 'kpi:updated': 'Cập nhật KPI',
    };
    const head = sheetHead('A.3', 'Hoạt động gần đây');
    if (!activity.length) {
      mount($('[data-activity]'), html`${head}${emptyState({ art: 'activity', small: true, title: 'Chưa có hoạt động', text: 'Mọi thay đổi quan trọng sẽ được ghi lại ở đây.' })}`);
      return;
    }
    mount($('[data-activity]'), html`${head}
      <ol class="timeline">
        ${activity.map((a) => html`
          <li class="timeline__item">
            <span class="timeline__icon">${icon(ICON[a.entity_type] || 'activity')}</span>
            <div class="grow">
              <div class="timeline__text"><span class="muted">${VERB[`${a.entity_type}:${a.action}`] || a.action}</span> <strong>${a.title}</strong>
                ${a.metadata?.amount ? html` · <span class="num">${money(a.metadata.amount)}</span>` : ''}
                ${a.metadata?.total ? html` · <span class="num">${money(a.metadata.total)}</span>` : ''}
                ${a.metadata?.value != null ? html` → <span class="num">${dec(a.metadata.value)}</span>` : ''}
              </div>
              <div class="timeline__time">${ago(a.created_at)}</div>
            </div>
          </li>`)}
      </ol>`);
  }

  function renderWeek() {
    const { entries, completed, from14, t0 } = state;
    const days = daysBetween(from14, t0);
    const mins = Object.fromEntries(days.map((d) => [d, 0]));
    entries.forEach((e) => { const d = dayOf(e.started_at); if (d in mins) mins[d] += entrySeconds(e) / 60; });
    const done = Object.fromEntries(days.map((d) => [d, 0]));
    completed.forEach((t) => { const d = dayOf(t.completed_at); if (d in done) done[d]++; });
    const totalMin = Object.values(mins).reduce((a, b) => a + b, 0);
    const totalDone = Object.values(done).reduce((a, b) => a + b, 0);

    mount($('[data-week]'), html`
      ${sheetHead('B.1', '14 ngày qua', html`<div class="chart-key"><span><i style="background:var(--ink)"></i>Giờ làm</span><span><i style="background:var(--accent);border-radius:50%"></i>Việc xong</span></div>`)}
      <div class="sheet__body">
        <div class="row" style="gap:var(--s-7);margin-bottom:var(--s-4)">
          <div><div class="eyebrow">Tổng giờ</div><div class="display" style="font-size:var(--fs-xl)">${minutes(totalMin)}</div></div>
          <div><div class="eyebrow">Việc hoàn thành</div><div class="display" style="font-size:var(--fs-xl)">${num(totalDone)}</div></div>
          <div><div class="eyebrow">TB / ngày</div><div class="display" style="font-size:var(--fs-xl)">${hours(totalMin / 14)}</div></div>
        </div>
        <div class="chart-box" data-chart-week></div>
      </div>`);
    const p = palette();
    charts.push(makeChart($('[data-chart-week]'), {
      type: 'bar',
      data: {
        labels: days.map((d) => day(d).replace(' thg ', '/')),
        datasets: [
          { type: 'bar', label: 'Giờ làm', data: days.map((d) => Math.round((mins[d] / 60) * 10) / 10), backgroundColor: days.map((d) => (d === t0 ? p.accent : p.ink)), borderRadius: 3, maxBarThickness: 22, yAxisID: 'y' },
          { type: 'line', label: 'Việc xong', data: days.map((d) => done[d]), borderColor: p.accent, backgroundColor: p.surface, pointBorderColor: p.accent, pointRadius: 3, pointBorderWidth: 1.5, borderWidth: 1.5, tension: 0.35, yAxisID: 'y1' },
        ],
      },
      options: {
        scales: {
          y: { ticks: { callback: (v) => v + 'g' } },
          y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { precision: 0, maxTicksLimit: 4 } },
        },
        plugins: { tooltip: { callbacks: { label: (c) => (c.datasetIndex === 0 ? ` ${c.raw} giờ` : ` ${c.raw} việc`) } } },
      },
    }));
  }

  function renderSpend() {
    const { expenses, budgets, mStart } = state;
    const cats = store.categoriesOf('expense');
    const byCat = new Map();
    expenses.forEach((x) => byCat.set(x.category_id || 'none', (byCat.get(x.category_id || 'none') || 0) + Number(x.amount)));
    const total = [...byCat.values()].reduce((a, b) => a + b, 0);
    const rows = [...byCat.entries()].map(([id, v]) => {
      const c = cats.find((k) => k.id === id);
      return { id, name: c?.name || 'Chưa phân loại', color: c?.color || palette().ink4, v };
    }).sort((a, b) => b.v - a.v);
    const { overall } = resolveBudgets(budgets, mStart);
    const head = sheetHead('B.2', 'Chi tiêu tháng này', html`<a class="btn btn--ghost btn--sm" href="#/expenses">Chi tiết ${icon('arrowRight')}</a>`);
    if (!rows.length) {
      mount($('[data-spend]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có khoản chi', text: 'Ghi lại khoản chi đầu tiên để thấy phân bổ theo danh mục.', action: html`<a class="btn btn--sm" href="#/expenses?new=1">${icon('plus')} Ghi khoản chi</a>` })}`);
      return;
    }
    mount($('[data-spend]'), html`${head}
      <div class="sheet__body">
        <div class="donut">
          <div class="chart-box chart-box--sm donut__chart" data-chart-spend></div>
          <div class="donut__center"><span class="eyebrow">Đã chi</span><strong class="num">${moneyShort(total)}</strong>${overall ? html`<span class="faint" style="font-size:var(--fs-2xs)">/ ${moneyShort(overall)}</span>` : ''}</div>
        </div>
        <div class="legend" style="margin-top:var(--s-4)">
          ${rows.slice(0, 5).map((r) => html`<div class="legend__row"><span class="legend__dot" style="--c:${r.color}"></span><span class="truncate">${r.name}</span><span class="legend__val">${money(r.v)}</span><span class="legend__pct">${pct((r.v / total) * 100)}</span></div>`)}
          ${rows.length > 5 ? html`<div class="faint" style="font-size:var(--fs-xs)">+ ${rows.length - 5} danh mục khác</div>` : ''}
        </div>
      </div>`);
    charts.push(makeChart($('[data-chart-spend]'), {
      type: 'doughnut',
      data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => r.v), backgroundColor: rows.map((r) => r.color), borderWidth: 2, borderColor: palette().surface, hoverOffset: 4 }] },
      options: { plugins: { tooltip: { callbacks: { label: (c) => ` ${money(c.raw)}` } } } },
    }));
  }

  function renderKpi() {
    const active = state.kpis.filter((k) => k.status === 'active').slice(0, 5);
    const head = sheetHead('C.1', 'Mục tiêu đang theo đuổi', html`<a class="btn btn--ghost btn--sm" href="#/kpi">Tất cả ${icon('arrowRight')}</a>`);
    if (!active.length) {
      mount($('[data-kpi]'), html`${head}${emptyState({ art: 'target', small: true, title: 'Chưa có mục tiêu', text: 'Đặt một KPI để theo dõi tiến độ — số trang đọc, số km chạy, doanh số…', action: html`<a class="btn btn--sm" href="#/kpi?new=1">${icon('plus')} Tạo KPI</a>` })}`);
      return;
    }
    const s = series();
    mount($('[data-kpi]'), html`${head}
      <ul class="list">
        ${active.map((k, i) => {
          const p = kpiProgress(k);
          const left = k.end_date ? diffDays(k.end_date, state.t0) : null;
          return html`<li class="kpi-mini">
            ${ring(p, { size: 52, color: p >= 100 ? 'var(--moss)' : s[i % s.length] })}
            <div class="grow">
              <div class="kpi-mini__name truncate">${k.name}</div>
              <div class="kpi-mini__meta"><span class="num">${dec(k.current_value)} / ${dec(k.target_value)} ${k.unit}</span>${left != null ? html`<span class="${left < 0 ? 'danger-text' : 'muted'}">${left < 0 ? `trễ ${-left} ngày` : left === 0 ? 'hạn hôm nay' : `còn ${left} ngày`}</span>` : ''}</div>
            </div>
          </li>`;
        })}
      </ul>`);
  }

  function renderShop() {
    const pending = state.shopping.filter((s) => s.status === 'planned' || s.status === 'wishlist');
    const planned = pending.filter((s) => s.status === 'planned');
    const plannedTotal = planned.reduce((a, b) => a + Number(b.total_price), 0);
    const top = [...pending].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]).slice(0, 5);
    const head = sheetHead('C.2', 'Danh sách mua sắm', html`<a class="btn btn--ghost btn--sm" href="#/shopping">Mở ${icon('arrowRight')}</a>`);
    if (!pending.length) {
      mount($('[data-shop]'), html`${head}${emptyState({ art: 'cart', small: true, title: 'Danh sách trống', text: 'Ghi lại những thứ bạn định mua để lên kế hoạch chi tiêu.', action: html`<a class="btn btn--sm" href="#/shopping?new=1">${icon('plus')} Thêm món</a>` })}`);
      return;
    }
    mount($('[data-shop]'), html`${head}
      <div class="sheet__body" style="padding-bottom:var(--s-3)">
        <div class="row between"><span class="eyebrow">Dự định mua · ${planned.length} món</span><strong class="num">${money(plannedTotal)}</strong></div>
      </div>
      <ul class="list">
        ${top.map((s) => html`<li class="shop-mini">${prio(s.priority, { low: 'Thấp', medium: 'Vừa', high: 'Cao', must_buy: 'Phải mua' })}<span class="grow truncate">${s.name}${s.quantity > 1 ? html` <span class="faint">×${s.quantity}</span>` : ''}</span><span class="num muted">${money(s.total_price)}</span></li>`)}
      </ul>
      <div class="sheet__foot"><span>Không tính vào chi tiêu cho đến khi đã mua.</span></div>`);
  }

  disposers.push(onDataChanged(load));
  await load();

  return () => {
    disposers.forEach((d) => d());
    charts.forEach((d) => d());
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
