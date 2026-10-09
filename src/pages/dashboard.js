// Dashboard ("Tổng quan") — the daily command center.
// Editorial masthead with a data-generated headline, today's focus, KPI tiles,
// charts (14-day rhythm, spending mix, budget burn-down), smart insights,
// recent notes and activity. Every secondary block degrades on its own: only
// tasks / time / expenses are required for the page to render.
import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { sheetHead, dueLabel, prio, ring } from '../components/ui.js';
import { emptyState, errorState, loadingRows, loadingBlock } from '../components/states.js';
import { openTaskForm } from '../components/taskForm.js';
import { makeChart, palette } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { navigate } from '../core/router.js';
import { onDataChanged, notifyDataChanged, disposeOnAbort } from '../core/events.js';
import { listTasks, setTaskStatus, focusTasks, listCompletedBetween } from '../services/tasks.js';
import { listEntries, entrySeconds } from '../services/timeEntries.js';
import { listExpenses, listRecent, anomalies as expenseAnomalies } from '../services/expenses.js';
import { budgetStatus, budgetState, oneOffThreshold, projectMonth, routineRate } from '../services/budgets.js';
import { kpiForecast } from '../services/kpis.js';
import { recentActivity } from '../services/activity.js';
import { summary as dashSummary, streaks as streakRpc, dailyAllowance, burnDown, streakFrom } from '../services/dashboard.js';
import { buildInsights, focusScore } from '../services/smart/index.js';
import {
  today, addDays, startOfWeek, startOfMonth, endOfMonth, daysBetween, dayOf, dayStartInstant, dayEndInstant,
  diffDays, parseDay, getTimezone,
} from '../utils/date.js';
import { money, moneyShort, minutes, num, day, ago, clock, pct, dec } from '../utils/format.js';

const OPEN = ['todo', 'in_progress'];

const REASON = {
  overdue: ['Quá hạn', 'danger'],
  due_today: ['Hạn hôm nay', 'accent'],
  due_tomorrow: ['Hạn ngày mai', 'warning'],
  due_soon: ['Sắp đến hạn', 'muted'],
  priority_urgent: ['Khẩn cấp', 'danger'],
  priority_high: ['Ưu tiên cao', 'accent'],
  in_progress: ['Đang dở', 'info'],
  quick_win: ['Việc nhanh', 'success'],
  stale: ['Tồn đọng', 'muted'],
};

const SEVERITY = {
  critical: { icon: 'alert', label: 'Cần xử lý' },
  warning: { icon: 'alert', label: 'Lưu ý' },
  success: { icon: 'checkCircle', label: 'Tín hiệu tốt' },
  info: { icon: 'info', label: 'Thông tin' },
};

const ACT_ICON = { task: 'tasks', expense: 'wallet', shopping_item: 'cart', kpi: 'target', note: 'note' };
const ACT_VERB = {
  'task:created': 'Tạo công việc', 'task:completed': 'Hoàn thành',
  'expense:created': 'Ghi khoản chi', 'shopping_item:created': 'Thêm vào danh sách mua',
  'shopping_item:completed': 'Đã mua', 'kpi:updated': 'Cập nhật KPI', 'note:created': 'Tạo ghi chú',
};

/** Deep link for an activity row (entity may have been deleted since). */
function actHref(a) {
  const id = encodeURIComponent(a.entity_id || '');
  if (a.entity_type === 'task') return id ? `#/tasks?id=${id}` : '#/tasks';
  if (a.entity_type === 'expense') return id ? `#/expenses?focus=${id}` : '#/expenses';
  if (a.entity_type === 'shopping_item') return '#/shopping';
  if (a.entity_type === 'kpi') return id ? `#/kpi?kpi=${id}` : '#/kpi';
  if (a.entity_type === 'note') return id ? `#/notes?id=${id}` : '#/notes';
  return null;
}

/** Non-critical call: logs and resolves `fallback` instead of rejecting. */
const soft = (fn, fallback = null) =>
  Promise.resolve()
    .then(fn)
    .catch((e) => {
      if (e?.sessionExpired) throw e;
      console.warn('[dashboard]', e?.message || e);
      return fallback;
    });

const sumOver = (days, map) => days.reduce((s, d) => s + (map[d] || 0), 0);

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: getTimezone() }).format(new Date()));
  if (h < 5) return 'Khuya rồi';
  if (h < 11) return 'Chào buổi sáng';
  if (h < 14) return 'Chào buổi trưa';
  if (h < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

/** ISO-8601 week number of a 'YYYY-MM-DD' day. */
function isoWeek(d) {
  const date = parseDay(d);
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4, 12));
  return 1 + Math.round(((date - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

/** Only hex colours or known palette names may reach a style attribute. */
function safeColor(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return s;
  if (/^(accent|moss|ochre|indigo|clay|plum|ink-3|ink-4)$/.test(s)) return `var(--${s})`;
  return null;
}

/** Strip the most common Markdown so excerpts read as prose. */
function excerpt(text, max = 150) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]\s+\[[ xX]\]|[-*+]|\d+\.)\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

const spark = (vals, { hi = -1, future = -1 } = {}) => {
  const max = Math.max(1, ...vals);
  return html`<span class="dash-spark" aria-hidden="true">${vals.map((v, i) => html`<i class="${i === hi ? 'is-hi' : ''} ${future >= 0 && i > future ? 'is-future' : ''}" style="--h:${(v / max).toFixed(3)}"></i>`)}</span>`;
};

const deltaChip = (d, fmt = (x) => num(x)) =>
  d === 0
    ? html`<span class="delta dash-delta--flat">±0</span>`
    : html`<span class="delta ${d > 0 ? 'delta--up' : 'delta--down'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d))}</span>`;

/* ================================================================== */

export default async function dashboard(root, { signal } = {}) {
  const disposers = [];
  disposeOnAbort(signal, disposers); // released on navigation even if this page never returns
  const charts = new Map();
  let token = 0;
  let S = null; // derived state of the last successful load

  const t0 = today();
  mount(root, html`
    <header class="page-head dash-head">
      <div>
        <h1>${greeting()}, ${store.displayName()}.</h1>
        <p class="dash-head__date">${day(t0, 'long')} · Tuần ${isoWeek(t0)}</p>
        <p class="dash-head__line" data-headline aria-live="polite"><span class="skeleton sk-line" style="width:min(520px,90%);height:16px"></span></p>
      </div>
      <div class="page-head__actions dash-head__actions">
        <button class="btn btn--primary" data-act="new-task">${icon('plus')} Việc mới</button>
        <button class="btn" data-act="new-note">${icon('note')} Ghi chú</button>
        <button class="btn" data-act="new-expense">${icon('wallet')} Khoản chi</button>
      </div>
    </header>

    <div class="dash">
      <section class="dash__tiles dash-tiles" data-tiles aria-label="Chỉ số chính">
        ${[0, 1, 2, 3].map(() => html`<div class="stat dash-tile"><div class="skeleton sk-line" style="width:45%"></div><div class="skeleton" style="height:36px;width:55%"></div><div class="skeleton sk-line" style="width:70%"></div></div>`)}
      </section>
      <article class="sheet sheet--ticked dash__focus" data-focus>${sheetHead('', 'Tiêu điểm hôm nay')}${loadingRows(5)}</article>
      <article class="sheet dash__timer" data-timer>${sheetHead('', 'Đồng hồ')}<div class="sheet__body">${loadingBlock(64)}</div></article>
      <article class="sheet dash__insights" data-insights>${sheetHead('', 'Gợi ý thông minh')}${loadingRows(3)}</article>
      <article class="sheet dash__trend" data-trend>${sheetHead('', 'Nhịp 14 ngày')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet dash__spend" data-spend>${sheetHead('', 'Chi tiêu theo danh mục')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet dash__burn" data-burn>${sheetHead('', 'Ngân sách tháng')}<div class="sheet__body">${loadingBlock(220)}</div></article>
      <article class="sheet dash__activity" data-activity>${sheetHead('', 'Hoạt động gần đây')}${loadingRows(4)}</article>
      <article class="sheet dash__notes" data-notes>${sheetHead('', 'Ghi chú gần đây')}<div class="sheet__body">${loadingBlock(120)}</div></article>
    </div>`);

  const $ = (s) => root.querySelector(s);

  /* ---------------------------------------------------------------- */
  /* Events                                                            */
  /* ---------------------------------------------------------------- */

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (act === 'new-task') openTaskForm({ defaults: { due_date: today() }, onSaved: () => notifyDataChanged('tasks') });
    if (act === 'new-note') navigate('/notes', { new: '1' });
    if (act === 'new-expense') navigate('/expenses', { new: '1' });
    if (act === 'retry') load();
    if (act === 'open-task') {
      const t = S?.openById.get(id);
      if (t) openTaskForm({ task: t, onSaved: () => notifyDataChanged('tasks'), onDeleted: () => notifyDataChanged('tasks') });
    }
    if (act === 'done') completeTask(id, el);
    if (act === 'focus-timer') {
      const run = store.get().runningEntry;
      if (run && run.task_id === id) runTimer(timer.pause);
      else runTimer(() => timer.start({ taskId: id }), 'Đã bắt đầu tính giờ.');
    }
    if (act === 'timer-start') runTimer(() => timer.start({}));
    if (act === 'timer-pause') runTimer(timer.pause);
    if (act === 'timer-resume') runTimer(timer.resume);
    if (act === 'timer-stop') runTimer(async () => { await timer.stop(); notifyDataChanged('time'); }, 'Đã lưu phiên tính giờ.');
  }));

  async function runTimer(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      renderTimer();
      renderFocus();
    } catch (err) {
      toast.error(err);
    }
  }

  async function completeTask(id, el) {
    const t = S?.openById.get(id);
    if (!t) return;
    el.setAttribute('aria-checked', 'true');
    el.closest('.focus-row')?.classList.add('is-leaving');
    try {
      await setTaskStatus(id, 'completed');
      toast(`Đã hoàn thành “${t.title}”.`, {
        action: {
          label: 'Hoàn tác',
          onClick: async () => {
            try { await setTaskStatus(id, t.status); notifyDataChanged('tasks'); } catch (err) { toast.error(err); }
          },
        },
      });
      notifyDataChanged('tasks');
    } catch (err) {
      el.setAttribute('aria-checked', 'false');
      el.closest('.focus-row')?.classList.remove('is-leaving');
      toast.error(err);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Data                                                              */
  /* ---------------------------------------------------------------- */

  async function load() {
    const my = ++token;
    const t = today();
    const weekStart = startOfWeek(t);
    const prevWeekStart = addDays(weekStart, -7);
    const from14 = addDays(t, -13);
    const from = prevWeekStart < from14 ? prevWeekStart : from14;
    const mStart = startOfMonth(t);
    const mEnd = endOfMonth(t);
    const fromIso = dayStartInstant(from).toISOString();
    const toIso = dayEndInstant(t).toISOString();

    loadNotes(my);
    try {
      const [open, completed, entries, expenses, sum, focus, budgets, kpis, anomalies, streak, activity, history] = await Promise.all([
        listTasks({ status: OPEN, limit: 1000 }),
        listCompletedBetween(fromIso, toIso),
        listEntries(fromIso, toIso),
        listExpenses({ from: mStart, to: mEnd }),
        soft(() => dashSummary()),
        soft(() => focusTasks(6)),
        soft(() => budgetStatus(mStart)),
        soft(() => kpiForecast()),
        soft(() => expenseAnomalies(30)),
        soft(() => streakRpc()),
        soft(() => recentActivity(10), []),
        soft(() => listRecent({ days: 180, limit: 600 })),
      ]);
      if (my !== token) return;
      S = derive({ t, weekStart, prevWeekStart, from, from14, mStart, mEnd, open, completed, entries, expenses, sum, focus, budgets, kpis, anomalies, streak, activity, history });
      renderAll();
    } catch (err) {
      if (my !== token) return;
      if (err?.sessionExpired) throw err;
      console.error('[dashboard]', err);
      S = null;
      charts.forEach((d) => d());
      charts.clear();
      mount($('[data-headline]'), html`<span class="muted">Không tải được dữ liệu hôm nay.</span>`);
      mount($('[data-tiles]'), '');
      mount($('[data-focus]'), html`${sheetHead('', 'Tiêu điểm hôm nay')}<div class="sheet__body">${errorState(err)}</div>`);
      const failed = (sel, title) => mount($(sel), html`${sheetHead('', title)}<div class="sheet__body"><p class="muted dash-quiet">Chưa tải được dữ liệu. <button class="btn btn--ghost btn--sm" data-act="retry">${icon('refresh')} Thử lại</button></p></div>`);
      failed('[data-insights]', 'Gợi ý thông minh');
      failed('[data-trend]', 'Nhịp 14 ngày');
      failed('[data-spend]', 'Chi tiêu theo danh mục');
      failed('[data-burn]', 'Ngân sách tháng');
      failed('[data-activity]', 'Hoạt động gần đây');
      // The clock works without the rest of the data: keep it usable.
      renderTimer();
    }
  }

  function derive(r) {
    const { t, weekStart, prevWeekStart, from, from14, mStart, mEnd } = r;
    const openById = new Map(r.open.map((x) => [x.id, x]));
    const overdue = r.open.filter((x) => x.due_date && x.due_date < t);
    const dueToday = r.open.filter((x) => x.due_date === t);

    const doneBy = {};
    r.completed.forEach((x) => { const d = dayOf(x.completed_at); doneBy[d] = (doneBy[d] || 0) + 1; });
    const minBy = {};
    r.entries.forEach((e) => { const d = dayOf(e.started_at); minBy[d] = (minBy[d] || 0) + entrySeconds(e) / 60; });
    const spendBy = {};
    r.expenses.forEach((x) => { spendBy[x.spent_on] = (spendBy[x.spent_on] || 0) + Number(x.amount); });

    const elapsed = diffDays(t, weekStart);
    const weekDays = daysBetween(weekStart, addDays(weekStart, 6));
    const thisWeek = daysBetween(weekStart, t);
    const lastWeekSame = daysBetween(prevWeekStart, addDays(prevWeekStart, elapsed));

    const monthSpent = r.expenses.reduce((s, x) => s + Number(x.amount), 0);
    const todaySpent = spendBy[t] || 0;
    // Month-end forecast: same model as the Expenses page (routine daily rate x
    // days left, one-offs such as rent counted once) instead of the RPC's plain
    // linear projection, so both pages show the same number.
    const hist = Array.isArray(r.history) ? r.history : [];
    const threshold = oneOffThreshold(hist);
    const forecast = (catId) => {
      const mine = (x) => catId === undefined || (x.category_id || null) === catId;
      const baseRate = routineRate(hist.filter(mine), { month: mStart, threshold });
      return projectMonth(r.expenses.filter(mine), { month: mStart, today: t, threshold, baseRate: baseRate ?? null });
    };
    if (Array.isArray(r.budgets)) {
      r.budgets = r.budgets.map((x) => {
        if (x.budget == null) return x;
        const projected = forecast(x.category_id ? x.category_id : undefined);
        return { ...x, projected, status: budgetState(x.budget, x.spent, projected) };
      });
    }
    const totalRow = (r.budgets || []).find((b) => b.category_id == null && b.budget != null);
    const budget = totalRow ? totalRow.budget : r.sum?.money?.month_budget ?? null;
    let burn = burnDown({ byDay: spendBy, month: mStart, budget, today: t });
    if (burn.elapsed > 0 && burn.elapsed < burn.total) {
      const fc = Math.round(forecast());
      const span = burn.total - burn.elapsed;
      burn = {
        ...burn,
        projectedTotal: fc,
        projected: burn.days.map((_, i) => (i + 1 < burn.elapsed ? null : Math.round(burn.spent + ((fc - burn.spent) * (i + 1 - burn.elapsed)) / span))),
      };
    }
    const allowance = dailyAllowance({ budget, monthSpent, todaySpent, today: t, monthEnd: mEnd });

    // Streak: server RPC when available, else from the loaded window.
    const active = new Set(daysBetween(from, t).filter((d) => (doneBy[d] || 0) > 0 || (minBy[d] || 0) >= 15));
    const local = streakFrom(active, t, from);
    const streak = r.streak ? { current: r.streak.current, longest: Math.max(r.streak.longest, r.streak.current), capped: false } : local;

    // Focus: RPC ranking, or the client mirror of the same formula.
    let focus = r.focus;
    if (!Array.isArray(focus)) {
      focus = r.open
        .map((x) => ({ task_id: x.id, title: x.title, priority: x.priority, due_date: x.due_date, status: x.status, ...focusScore(x, t) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || (a.due_date || '9999').localeCompare(b.due_date || '9999'))
        .slice(0, 6);
    }

    const insightSummary = {
      ...(r.sum || {}),
      tasks: { overdue: overdue.length, due_today: dueToday.length, completed_today: doneBy[t] || 0 },
      money: { month_spent: monthSpent, month_budget: budget, month_projected: burn.projectedTotal },
      streak: { current: streak.current, longest: streak.longest },
    };
    const insights = buildInsights({
      summary: insightSummary,
      budgets: r.budgets || undefined,
      kpis: Array.isArray(r.kpis) ? r.kpis : undefined,
      anomalies: r.anomalies || undefined,
      limit: 4,
    });

    return {
      ...r, openById, overdue, dueToday, doneBy, minBy, spendBy, weekDays, thisWeek, lastWeekSame, elapsed,
      monthSpent, todaySpent, budget, burn, allowance, streak, focus, insights, from14,
      days14: daysBetween(from14, t),
    };
  }

  async function loadNotes(my) {
    const box = $('[data-notes]');
    const head = sheetHead('', 'Ghi chú gần đây', html`<a class="btn btn--ghost btn--sm" href="#/notes">Tất cả ${icon('arrowRight')}</a>`);
    let rows = null;
    try {
      const mod = await import('../services/notes.js');
      // "Recent" means last edited: let the server order and stop at 4 (was 40 full notes).
      rows = ((await mod.listNotes({ limit: 4, recent: true })) || []).slice(0, 4);
    } catch (e) {
      console.warn('[dashboard] notes', e?.message || e);
    }
    if (my !== token || !box.isConnected) return;
    if (!Array.isArray(rows)) {
      mount(box, html`${head}<div class="sheet__body"><p class="muted dash-quiet">Chưa tải được ghi chú. Mở trang <a href="#/notes">Ghi chú</a> để xem.</p></div>`);
      return;
    }
    if (!rows.length) {
      mount(box, html`${head}${emptyState({ art: 'tasks', small: true, title: 'Chưa có ghi chú', text: 'Ý tưởng, biên bản họp, danh sách… ghi lại để không quên.', action: html`<button class="btn btn--sm" data-act="new-note">${icon('plus')} Viết ghi chú</button>` })}`);
      return;
    }
    mount(box, html`${head}
      <ul class="dash-notes">
        ${rows.map((n) => {
          const c = safeColor(n.color);
          return html`<li>
            <a class="dash-note" href="#/notes?id=${encodeURIComponent(n.id)}" style="${c ? `--c:${c}` : ''}">
              <span class="dash-note__top">
                ${n.pinned ? html`<span class="dash-note__pin" title="Đã ghim">${icon('pin')}</span>` : ''}
                <span class="dash-note__time">${n.updated_at ? ago(n.updated_at) : ''}</span>
              </span>
              <span class="dash-note__title">${n.title || 'Không tiêu đề'}</span>
              <span class="dash-note__text">${excerpt(n.content) || 'Ghi chú trống.'}</span>
            </a>
          </li>`;
        })}
      </ul>`);
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  function renderAll() {
    renderHeadline();
    renderTiles();
    renderFocus();
    renderTimer();
    renderInsights();
    renderTrend();
    renderSpend();
    renderBurn();
    renderActivity();
  }

  function setChart(key, el, cfg) {
    charts.get(key)?.();
    charts.delete(key);
    if (el) charts.set(key, makeChart(el, cfg));
  }

  function renderHeadline() {
    const { overdue, dueToday, minBy, t, budget, todaySpent, allowance } = S;
    const total = overdue.length + dueToday.length;
    const parts = [];
    parts.push(total
      ? html`Hôm nay bạn có <b>${num(total)} việc</b>${overdue.length ? html`, <b class="is-danger">${num(overdue.length)} quá hạn</b>` : ''}`
      : html`Hôm nay không có việc nào đến hạn`);
    const mToday = minBy[t] || 0;
    if (mToday >= 1) parts.push(html`đã tập trung <b>${minutes(mToday)}</b>`);
    if (budget > 0 && allowance != null) {
      parts.push(html`đã chi <b class="${todaySpent > allowance ? 'is-danger' : ''}">${moneyShort(todaySpent)}</b> / ngân sách ngày <b>${moneyShort(allowance)}</b>`);
    } else if (todaySpent > 0) {
      parts.push(html`đã chi <b>${moneyShort(todaySpent)}</b>`);
    } else {
      parts.push(html`chưa có khoản chi nào`);
    }
    mount($('[data-headline]'), html`${parts.map((p, i) => html`${i ? '; ' : ''}${p}`)}.`);
  }

  function renderTiles() {
    const { doneBy, minBy, weekDays, thisWeek, lastWeekSame, elapsed, monthSpent, budget, burn, streak, t, from14 } = S;
    const doneThis = sumOver(thisWeek, doneBy);
    const doneLast = sumOver(lastWeekSame, doneBy);
    const minThis = sumOver(thisWeek, minBy);
    const minLast = sumOver(lastWeekSame, minBy);
    const hrs = (m) => dec(Math.round((m / 60) * 10) / 10);
    const used = budget > 0 ? (monthSpent / budget) * 100 : null;
    const ringColor = used == null ? 'var(--accent)' : used > 100 ? 'var(--danger)' : used >= 80 ? 'var(--warning)' : 'var(--moss)';
    const last14 = daysBetween(from14, t);

    mount($('[data-tiles]'), html`
      <div class="stat dash-tile">
        <div class="stat__label"><span class="eyebrow">Xong tuần này</span>${spark(weekDays.map((d) => doneBy[d] || 0), { hi: elapsed, future: elapsed })}</div>
        <div class="stat__value">${num(doneThis)}<small>việc</small></div>
        <div class="stat__meta">${deltaChip(doneThis - doneLast)}<span>so với cùng kỳ tuần trước</span></div>
      </div>
      <div class="stat dash-tile">
        <div class="stat__label"><span class="eyebrow">Giờ tập trung</span>${spark(weekDays.map((d) => minBy[d] || 0), { hi: elapsed, future: elapsed })}</div>
        <div class="stat__value">${hrs(minThis)}<small>giờ</small></div>
        <div class="stat__meta">${deltaChip(Math.round((minThis - minLast) / 6) / 10, (x) => dec(x) + 'g')}<span>tuần này · ${minutes(minLast)} cùng kỳ</span></div>
      </div>
      <div class="stat dash-tile dash-tile--money">
        <div class="dash-tile__split">
          <div class="dash-tile__main">
            <div class="stat__label"><span class="eyebrow">Chi tiêu tháng</span></div>
            <div class="stat__value dash-tile__money">${moneyShort(monthSpent)}</div>
            <div class="stat__meta">${budget > 0
              ? html`<span>/ ${moneyShort(budget)} · ${monthSpent > budget ? html`<span class="danger-text">vượt ${moneyShort(monthSpent - budget)}</span>` : html`còn ${moneyShort(budget - monthSpent)}`}</span>`
              : html`<span>Chưa đặt ngân sách · <a href="#/expenses?tab=budgets">Đặt ngay</a></span>`}</div>
          </div>
          ${used != null ? ring(used, { size: 60, color: ringColor, label: pct(used) }) : ''}
        </div>
        ${budget > 0 && burn.projectedTotal > budget && monthSpent <= budget ? html`<div class="dash-tile__note">Dự báo cuối tháng ${moneyShort(burn.projectedTotal)}</div>` : ''}
      </div>
      <div class="stat stat--accent dash-tile">
        <div class="stat__label"><span class="eyebrow">Chuỗi ngày</span><span class="stat__icon">${icon('sparkle')}</span></div>
        <div class="stat__value">${streak.capped ? '≥' : ''}${num(streak.current)}<small>ngày</small></div>
        <div class="dash-streak" aria-hidden="true">${last14.map((d) => html`<i class="${(doneBy[d] || 0) > 0 || (minBy[d] || 0) >= 15 ? 'is-on' : ''} ${d === t ? 'is-today' : ''}"></i>`)}</div>
        <div class="stat__meta"><span>Kỷ lục ${num(streak.longest)} ngày · 14 ngày gần nhất</span></div>
      </div>`);
  }

  function renderFocus() {
    if (!S) return;
    const { focus, overdue, openById } = S;
    const run = store.get().runningEntry;
    const box = $('[data-focus]');
    const head = sheetHead('', 'Tiêu điểm hôm nay', html`<a class="btn btn--ghost btn--sm" href="#/tasks">Tất cả (${num(openById.size)}) ${icon('arrowRight')}</a>`);
    const warn = overdue.length
      ? html`<div class="dash-overdue" role="status">${icon('alert')}<span><b>${num(overdue.length)} việc quá hạn</b> — xử lý hoặc dời hạn để danh sách phản ánh đúng thực tế.</span><a href="#/tasks?scope=overdue">Xem</a></div>`
      : '';
    if (!focus.length) {
      mount(box, html`${head}${warn}${emptyState({ art: 'tasks', small: true, title: 'Một ngày thật thoáng', text: 'Không có việc nào cần ưu tiên. Thêm việc mới hoặc tận hưởng khoảng trống này.', action: html`<button class="btn btn--sm" data-act="new-task">${icon('plus')} Thêm việc</button>` })}`);
      return;
    }
    mount(box, html`${head}${warn}
      <ol class="list focus-list">
        ${focus.map((f) => {
          const full = openById.get(f.task_id);
          const running = run && run.task_id === f.task_id;
          return html`
            <li class="focus-row ${running ? 'is-running' : ''}">
              <button class="tick" role="checkbox" aria-checked="false" data-act="done" data-id="${f.task_id}" data-p="${f.priority}" aria-label="Hoàn thành ${f.title}">${icon('check')}</button>
              <div class="focus-row__main" data-act="open-task" data-id="${f.task_id}" role="button" tabindex="0">
                <div class="focus-row__title">${f.title}</div>
                <div class="focus-row__meta">
                  ${dueLabel(f.due_date, f.status)}${prio(f.priority)}
                  ${(f.reasons || []).filter((x) => REASON[x] && !['overdue', 'due_today', 'priority_urgent', 'priority_high'].includes(x)).slice(0, 2).map((x) => html`<span class="focus-chip focus-chip--${REASON[x][1]}">${REASON[x][0]}</span>`)}
                  ${full?.estimated_minutes ? html`<span class="focus-row__est">${icon('hourglass')}${minutes(full.estimated_minutes)}</span>` : ''}
                </div>
              </div>
              <div class="focus-row__side">
                <span class="focus-row__score" title="Điểm ưu tiên">${Math.round(f.score)}</span>
                <button class="icon-btn focus-row__play ${running ? 'is-running' : ''}" data-act="focus-timer" data-id="${f.task_id}" aria-label="${running ? 'Tạm dừng' : 'Bấm giờ'} ${f.title}" title="${running ? 'Tạm dừng' : 'Bấm giờ cho việc này'}">${icon(running ? 'pause' : 'play')}</button>
              </div>
            </li>`;
        })}
      </ol>`);
    // Keyboard: Enter/Space on a row opens it.
    box.querySelectorAll('.focus-row__main').forEach((el) => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
    });
  }

  function renderTimer() {
    const box = $('[data-timer]');
    if (!box) return;
    const run = store.get().runningEntry;
    const paused = !run && timer.pausedSession();
    const label = run ? run.task?.title || run.description || 'Không gắn công việc' : paused ? paused.title || 'Phiên tạm dừng' : 'Chưa có phiên nào đang chạy';
    mount(box, html`
      ${sheetHead('', 'Đồng hồ', run ? html`<span class="badge badge--accent">Đang chạy</span>` : paused ? html`<span class="badge badge--warning">Tạm dừng</span>` : html`<a class="btn btn--ghost btn--sm" href="#/time">Nhật ký ${icon('arrowRight')}</a>`)}
      <div class="sheet__body dash-clock ${run ? 'is-running' : ''}">
        <div class="dash-clock__read">
          <div class="dash-clock__time num" data-clock>${clock(timer.sessionSeconds())}</div>
          <div class="dash-clock__task truncate">${label}</div>
        </div>
        <div class="dash-clock__ctl">
          ${run
            ? html`<button class="btn" data-act="timer-pause">${icon('pause')} Tạm dừng</button><button class="btn btn--accent" data-act="timer-stop">${icon('stop')} Lưu</button>`
            : paused
              ? html`<button class="btn btn--primary" data-act="timer-resume">${icon('play')} Tiếp tục</button><button class="btn" data-act="timer-stop">${icon('stop')} Kết thúc</button>`
              : html`<button class="btn btn--primary" data-act="timer-start">${icon('play')} Bắt đầu</button>`}
        </div>
      </div>`);
  }
  disposers.push(timer.onTick(() => {
    const el = root.querySelector('[data-clock]');
    if (el) el.textContent = clock(timer.sessionSeconds());
  }));
  disposers.push(store.subscribe((_, patch) => {
    if ('runningEntry' in patch) { renderTimer(); renderFocus(); }
  }));

  function renderInsights() {
    const { insights } = S;
    const box = $('[data-insights]');
    const head = sheetHead('', 'Gợi ý thông minh');
    if (!insights.length) {
      mount(box, html`${head}<div class="insight insight--success insight--calm">
        <span class="insight__icon">${icon('checkCircle')}</span>
        <div class="insight__body"><div class="insight__title">Mọi thứ trong tầm kiểm soát</div><p class="insight__detail">Không có cảnh báo nào về công việc, ngân sách hay mục tiêu.</p></div>
      </div>`);
      return;
    }
    mount(box, html`${head}
      <ul class="insights">
        ${insights.map((x) => html`
          <li class="insight insight--${x.severity}">
            <span class="insight__icon" title="${SEVERITY[x.severity]?.label || ''}">${icon(SEVERITY[x.severity]?.icon || 'info')}</span>
            <div class="insight__body">
              <div class="insight__title">${x.title}</div>
              ${x.detail ? html`<p class="insight__detail">${x.detail}</p>` : ''}
              ${x.action?.route && /^#\//.test(x.action.route) ? html`<a class="insight__action" href="${x.action.route}">${x.action.label} ${icon('arrowRight')}</a>` : ''}
            </div>
          </li>`)}
      </ul>`);
  }

  function renderTrend() {
    const { days14, minBy, doneBy, t } = S;
    const totalMin = sumOver(days14, minBy);
    const totalDone = sumOver(days14, doneBy);
    const activeDays = days14.filter((d) => (minBy[d] || 0) > 0).length;
    mount($('[data-trend]'), html`
      ${sheetHead('', 'Nhịp 14 ngày', html`<div class="chart-key"><span><i style="background:var(--ink-2)"></i>Giờ làm</span><span><i style="background:var(--accent);border-radius:50%"></i>Việc xong</span></div>`)}
      <div class="sheet__body">
        <dl class="dash-figures">
          <div><dt>Tổng giờ</dt><dd>${minutes(totalMin)}</dd></div>
          <div><dt>Việc hoàn thành</dt><dd>${num(totalDone)}</dd></div>
          <div><dt>TB / ngày làm</dt><dd>${minutes(activeDays ? totalMin / activeDays : 0)}</dd></div>
        </dl>
        <div class="chart-box" data-chart-trend role="img" aria-label="Biểu đồ giờ làm và số việc hoàn thành trong 14 ngày: tổng ${minutes(totalMin)}, ${totalDone} việc."></div>
      </div>`);
    const p = palette();
    setChart('trend', $('[data-chart-trend]'), {
      type: 'bar',
      data: {
        labels: days14.map((d) => `${d.slice(8)}/${d.slice(5, 7)}`),
        datasets: [
          { type: 'bar', label: 'Giờ làm', data: days14.map((d) => Math.round(((minBy[d] || 0) / 60) * 10) / 10), backgroundColor: days14.map((d) => (d === t ? p.accent : p.ink2)), borderRadius: 2, maxBarThickness: 18, yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Việc xong', data: days14.map((d) => doneBy[d] || 0), borderColor: p.accent, backgroundColor: p.surface, pointBackgroundColor: p.surface, pointBorderColor: p.accent, pointRadius: 3, pointHoverRadius: 5, pointBorderWidth: 1.5, borderWidth: 1.5, cubicInterpolationMode: 'monotone', yAxisID: 'y1', order: 1 },
        ],
      },
      options: {
        scales: {
          y: { beginAtZero: true, ticks: { callback: (v) => v + 'g' } },
          y1: { position: 'right', beginAtZero: true, suggestedMax: Math.max(3, ...days14.map((d) => doneBy[d] || 0)) + 1, grid: { display: false }, border: { display: false }, ticks: { precision: 0, maxTicksLimit: 4 } },
        },
        plugins: { tooltip: { callbacks: { label: (c) => (c.datasetIndex === 0 ? ` ${minutes(c.raw * 60)} làm việc` : ` ${c.raw} việc xong`) } } },
      },
    });
  }

  function renderSpend() {
    const { expenses, monthSpent, budget } = S;
    const byCat = new Map();
    expenses.forEach((x) => {
      const k = x.category_id || 'none';
      const cur = byCat.get(k) || { v: 0, cat: x.category };
      cur.v += Number(x.amount);
      byCat.set(k, cur);
    });
    const p = palette();
    const rows = [...byCat.entries()].map(([id, o]) => {
      const c = store.categoryById(id) || o.cat;
      const hex = safeColor(c?.color);
      return { id, name: c?.name || 'Chưa phân loại', color: hex && hex.startsWith('#') ? hex : p.ink4, v: o.v };
    }).sort((a, b) => b.v - a.v);
    const head = sheetHead('', 'Chi tiêu theo danh mục', html`<a class="btn btn--ghost btn--sm" href="#/expenses">Chi tiết ${icon('arrowRight')}</a>`);
    if (!rows.length) {
      charts.get('spend')?.(); charts.delete('spend');
      mount($('[data-spend]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có khoản chi', text: 'Ghi lại khoản chi đầu tiên để thấy phân bổ theo danh mục.', action: html`<button class="btn btn--sm" data-act="new-expense">${icon('plus')} Ghi khoản chi</button>` })}`);
      return;
    }
    const top = rows.slice(0, 5);
    const rest = rows.slice(5).reduce((s, r) => s + r.v, 0);
    mount($('[data-spend]'), html`${head}
      <div class="sheet__body dash-donut">
        <div class="donut">
          <div class="chart-box chart-box--sm donut__chart" data-chart-spend role="img" aria-label="Biểu đồ tròn chi tiêu tháng theo danh mục, tổng ${money(monthSpent)}"></div>
          <div class="donut__center"><span class="eyebrow">Đã chi</span><strong class="num">${moneyShort(monthSpent)}</strong>${budget > 0 ? html`<span class="faint dash-donut__of">/ ${moneyShort(budget)}</span>` : ''}</div>
        </div>
        <div class="legend">
          ${top.map((r) => html`<div class="legend__row"><span class="legend__dot" style="--c:${r.color}"></span><span class="truncate">${r.name}</span><span class="legend__val">${moneyShort(r.v)}</span><span class="legend__pct">${pct((r.v / monthSpent) * 100)}</span></div>`)}
          ${rest > 0 ? html`<div class="legend__row"><span class="legend__dot" style="--c:var(--rule-strong)"></span><span class="truncate muted">${rows.length - 5} danh mục khác</span><span class="legend__val">${moneyShort(rest)}</span><span class="legend__pct">${pct((rest / monthSpent) * 100)}</span></div>` : ''}
        </div>
      </div>`);
    setChart('spend', $('[data-chart-spend]'), {
      type: 'doughnut',
      data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => r.v), backgroundColor: rows.map((r) => r.color), borderWidth: 2, borderColor: p.surface, hoverOffset: 4 }] },
      options: { plugins: { tooltip: { callbacks: { label: (c) => ` ${money(c.raw)}` } } } },
    });
  }

  function renderBurn() {
    const { burn, budget, monthSpent, t, mEnd } = S;
    const daysLeft = diffDays(mEnd, t) + 1;
    const over = budget > 0 && burn.projectedTotal > budget;
    const head = sheetHead('', 'Ngân sách tháng', html`<div class="chart-key">
      <span><i style="background:var(--accent)"></i>Thực tế</span>
      ${budget > 0 ? html`<span><i class="dash-key-dash"></i>Lý tưởng</span>` : ''}
      <span><i class="dash-key-dash dash-key-dash--accent"></i>Dự báo</span></div>`);
    mount($('[data-burn]'), html`${head}
      <div class="sheet__body">
        <dl class="dash-figures">
          <div><dt>Đã chi</dt><dd>${moneyShort(monthSpent)}</dd></div>
          <div><dt>Dự báo cuối tháng</dt><dd class="${over ? 'danger-text' : ''}">${moneyShort(burn.projectedTotal)}</dd></div>
          <div><dt>${budget > 0 ? (monthSpent > budget ? 'Đã vượt' : 'Còn lại') : 'Ngân sách'}</dt><dd>${budget > 0 ? moneyShort(Math.abs(budget - monthSpent)) : '—'}</dd></div>
          <div><dt>Ngày còn lại</dt><dd>${num(daysLeft)}</dd></div>
        </dl>
        <div class="chart-box chart-box--sm" data-chart-burn role="img" aria-label="Chi tiêu cộng dồn trong tháng so với ngân sách lý tưởng"></div>
        ${budget > 0 ? '' : html`<p class="dash-quiet muted">Đặt ngân sách tháng để thấy đường lý tưởng. <a href="#/expenses?tab=budgets">Đặt ngân sách</a></p>`}
      </div>`);
    const p = palette();
    const datasets = [
      { label: 'Thực tế', data: burn.actual, borderColor: p.accent, backgroundColor: p.accentSoft, fill: 'origin', pointRadius: 0, pointHoverRadius: 4, borderWidth: 2, tension: 0.25, spanGaps: false },
      { label: 'Dự báo', data: burn.projected, borderColor: p.accent, borderDash: [3, 4], borderWidth: 1.25, pointRadius: 0, fill: false, tension: 0 },
    ];
    if (burn.ideal) datasets.push({ label: 'Lý tưởng', data: burn.ideal, borderColor: p.ink3, borderDash: [6, 5], borderWidth: 1, pointRadius: 0, fill: false, tension: 0 });
    setChart('burn', $('[data-chart-burn]'), {
      type: 'line',
      data: { labels: burn.days.map((d) => String(Number(d.slice(8)))), datasets },
      options: {
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { ticks: { callback: (v) => moneyShort(v) } },
        },
        plugins: { tooltip: { callbacks: { title: (c) => day(burn.days[c[0].dataIndex], 'short'), label: (c) => (c.raw == null ? null : ` ${c.dataset.label}: ${money(c.raw)}`) } } },
      },
    });
  }

  function renderActivity() {
    const { activity } = S;
    const box = $('[data-activity]');
    const head = sheetHead('', 'Hoạt động gần đây');
    if (!activity?.length) {
      mount(box, html`${head}${emptyState({ art: 'activity', small: true, title: 'Chưa có hoạt động', text: 'Mọi thay đổi quan trọng sẽ được ghi lại ở đây.' })}`);
      return;
    }
    mount(box, html`${head}
      <ol class="timeline">
        ${activity.map((a) => {
          const href = actHref(a);
          const title = a.title && a.title !== 'Expense' ? a.title : a.entity_type === 'expense' ? 'Khoản chi' : 'Không tên';
          const body = html`
            <span class="timeline__icon">${icon(ACT_ICON[a.entity_type] || 'activity')}</span>
            <div class="grow">
              <div class="timeline__text"><span class="muted">${ACT_VERB[`${a.entity_type}:${a.action}`] || 'Cập nhật'}</span> <strong>${title}</strong>
                ${Number(a.metadata?.amount) > 0 ? html` · <span class="num">${money(a.metadata.amount)}</span>` : ''}
                ${Number(a.metadata?.total) > 0 ? html` · <span class="num">${money(a.metadata.total)}</span>` : ''}
                ${a.metadata?.value != null ? html` → <span class="num">${dec(Number(a.metadata.value))}</span>` : ''}
              </div>
              <div class="timeline__time" title="${a.created_at ? new Date(a.created_at).toLocaleString('vi-VN') : ''}">${ago(a.created_at)}</div>
            </div>`;
          return html`<li class="timeline__item">${href ? html`<a class="dash-act" href="${href}">${body}</a>` : body}</li>`;
        })}
      </ol>`);
  }

  // Coalesce bursts (complete + undo, quick-add, settings saving several kinds)
  // into one reload: each reload is 12 requests and three charts.
  let reloadTimer = null;
  disposers.push(() => clearTimeout(reloadTimer));
  disposers.push(onDataChanged(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 350); }));
  await load();

  return () => {
    token++;
    disposers.forEach((d) => d());
    charts.forEach((d) => d());
    charts.clear();
  };
}
