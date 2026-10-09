// Expenses — "Sổ thu chi". Record spending in seconds (quick-entry bar /
// phone bottom sheet), then read it by day, week, month, year or a custom
// range: summary strip, rhythm & cumulative charts, category mix, weekday
// habits, payment methods, budgets with forecast, anomalies and a day-grouped
// ledger with inline edit and undoable delete.
import { html, mount, on, raw, formData } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel, categoryOptions, popMenu } from '../components/ui.js';
import { emptyState, errorState, loadingRows, loadingBlock, statTileSkeleton } from '../components/states.js';
import { openModal, field, input, textarea } from '../components/modal.js';
import { makeChart, palette, series } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { toCSV, downloadText } from '../utils/csv.js';
import {
  listExpenses, createExpense, updateExpense, deleteExpense, summary, anomalies as fetchAnomalies,
  suggestCategory as suggestRemote, listRecent, PAYMENT_METHODS,
} from '../services/expenses.js';
import { listBudgets, resolveBudgets, setBudget, status as budgetStatus } from '../services/budgets.js';
import { parseExpenseEntry } from '../services/smart/expenseParser.js';
import { suggestCategory as suggestLocal, rankCategories, topPaymentMethod } from '../services/smart/categorizer.js';
import { today, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, endOfWeek, daysBetween, diffDays, weekday, getWeekStart } from '../utils/date.js';
import { money, moneyShort, monthLabel, relDay, day, pct, parseMoney, num, dec } from '../utils/format.js';

const PERIODS = { day: 'Ngày', week: 'Tuần', month: 'Tháng', year: 'Năm', custom: 'Tùy chọn' };
const PREV_LABEL = { day: 'hôm trước', week: 'tuần trước', month: 'tháng trước', year: 'năm trước', custom: 'kỳ trước' };
const WD_FULL = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const WD_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const PM_ICON = { cash: 'coin', bank: 'refresh', credit_card: 'wallet', e_wallet: 'monitor', other: 'more' };
const STATUS = { ok: ['Ổn', 'success'], warning: ['Cần chú ý', 'warning'], over: ['Vượt', 'danger'], no_budget: ['Chưa đặt', 'muted'] };
const QUICK_EXAMPLES = ['cafe 45k', 'grab 120.000 hôm qua', 'ăn trưa 60k #ăn uống tm', 'điện 1tr2 ck'];
const PM_KEY = 'nm:xp:pm';
const LIST_STEP = 250;

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const minDay = (a, b) => (a < b ? a : b);
const maxDay = (a, b) => (a > b ? a : b);
const lenOf = (r) => diffDays(r.to, r.from) + 1;
const sum = (list) => list.reduce((s, x) => s + Number(x.amount), 0);
const inRange = (x, a, b) => x.spent_on >= a && x.spent_on <= b;
const daysIn = (d) => Number(endOfMonth(d).slice(8));

function readPm() { try { return localStorage.getItem(PM_KEY) || null; } catch { return null; } }
function writePm(v) { try { localStorage.setItem(PM_KEY, v); } catch { /* private mode */ } }

export default async function expensesPage(root, { query }) {
  const t0 = today();
  let period = PERIODS[query.period] ? query.period : 'month';
  let date = isDay(query.date) ? query.date : t0;
  if (/^\d{4}-\d{2}$/.test(query.m || '')) { period = 'month'; date = query.m + '-01'; }
  let custom = { from: isDay(query.from) ? query.from : addDays(t0, -29), to: isDay(query.to) ? query.to : t0 };
  if (custom.from > custom.to) custom = { from: custom.to, to: custom.from };

  let rows = [];            // every expense in the fetched window (period ∪ prev ∪ context ∪ budget month)
  let budgets = [];         // carry-forward rows (listBudgets)
  let statusRows = null;    // budget_status for the budget month
  let statusErr = null;
  let anomalies = null;
  let learn = [];           // recent history → smart suggestions & recent chips
  let prevYearTotal = null; // year view: previous-year comparison from spending_summary
  let loaded = false;
  let alive = true;
  let token = 0;
  let editingId = null;
  let listLimit = LIST_STEP;
  let focusId = query.focus || null;
  const pendingDel = new Map(); // id → { x, timer }
  const f = { q: query.q || '', cat: query.cat || '', pm: query.pm || '' };
  const disposers = [];
  const charts = new Map();

  mount(root, html`
    ${pageHead({
      num: '06',
      kicker: 'Chi tiêu',
      title: 'Sổ <em>thu chi</em> hằng ngày',
      lede: 'Ghi mỗi khoản chi trong vài giây, rồi xem lại theo ngày, tuần, tháng hay năm — biết tiền đi đâu, còn bao nhiêu và tháng này sẽ kết thúc thế nào.',
      actions: html`<button class="btn" data-act="budget">${icon('piggy')} Ngân sách</button><button class="btn btn--primary" data-act="new">${icon('plus')} Khoản chi mới</button>`,
    })}
    <section class="xp-quick" data-quick aria-label="Ghi nhanh khoản chi">
      <form class="xp-quick__bar" data-quick-form autocomplete="off">
        <span class="xp-quick__glyph" aria-hidden="true">₫</span>
        <input class="xp-quick__input" data-quick-input type="text" enterkeyhint="done" spellcheck="false"
          placeholder="Ghi nhanh: cafe 45k · grab 120.000 hôm qua · ăn trưa 60k #ăn uống tm" aria-label="Ghi nhanh khoản chi" aria-describedby="xp-quick-preview" />
        <button type="submit" class="btn btn--primary btn--sm xp-quick__go" data-quick-go disabled>Ghi <kbd>↵</kbd></button>
      </form>
      <div class="xp-quick__preview" id="xp-quick-preview" data-quick-preview aria-live="polite"></div>
    </section>
    <div class="xp-period" data-period></div>
    <section class="grid grid-4 xp-stats" data-stats>${statTileSkeleton(4)}</section>
    <section class="grid grid-12 xp-charts">
      <article class="sheet span-8" data-c1>${sheetHead('E.1', 'Nhịp chi tiêu')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-4" data-c2>${sheetHead('E.2', 'Cơ cấu danh mục')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-5" data-c3>${sheetHead('E.3', 'Lũy kế & ngân sách')}<div class="sheet__body">${loadingBlock(220)}</div></article>
      <article class="sheet span-4" data-c4>${sheetHead('E.4', 'Theo thứ trong tuần')}<div class="sheet__body">${loadingBlock(220)}</div></article>
      <article class="sheet span-3" data-c5>${sheetHead('E.5', 'Thanh toán')}${loadingRows(4)}</article>
    </section>
    <h2 class="section-title"><span class="eyebrow">§ 06.B</span>Ngân sách &amp; cảnh báo</h2>
    <section class="grid grid-12">
      <article class="sheet span-7" data-budget>${sheetHead('E.6', 'Ngân sách')}${loadingRows(5)}</article>
      <article class="sheet span-5" data-anom>${sheetHead('E.7', 'Khoản chi bất thường')}${loadingRows(4)}</article>
    </section>
    <h2 class="section-title"><span class="eyebrow">§ 06.C</span>Sổ chi tiết</h2>
    <div class="toolbar xp-filters">
      <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Tìm mô tả, ghi chú…" value="${f.q}" data-f="q" aria-label="Tìm khoản chi" /></div>
      <select class="select" data-f="cat" aria-label="Lọc danh mục">${categoryOptions('expense', { all: 'Mọi danh mục', none: 'Chưa phân loại' }).map((o) => html`<option value="${o.value}" ${o.value === f.cat ? raw('selected') : ''}>${o.label}</option>`)}</select>
      <select class="select" data-f="pm" aria-label="Lọc phương thức"><option value="">Mọi phương thức</option>${Object.entries(PAYMENT_METHODS).map(([v, l]) => html`<option value="${v}" ${v === f.pm ? raw('selected') : ''}>${l}</option>`)}</select>
      <span class="toolbar__spacer"></span>
      <button class="btn" data-act="csv">${icon('download')} Xuất CSV</button>
    </div>
    <article class="sheet" data-list>${loadingRows(6)}</article>
    <button type="button" class="xp-fab" data-act="new" aria-label="Ghi khoản chi mới">${icon('plus')}</button>`);

  const $ = (s) => root.querySelector(s);
  const cats = () => store.categoriesOf('expense');
  const catName = (id) => store.categoryById(id)?.name || 'Chưa phân loại';
  const live = () => rows.filter((x) => !pendingDel.has(x.id));
  const currency = () => store.get().profile?.currency || 'VND';
  const lastPm = () => readPm() || topPaymentMethod(learn) || 'cash';
  const killCharts = () => { charts.forEach((d) => d()); charts.clear(); };
  const setChart = (k, d) => { charts.get(k)?.(); charts.set(k, d); };

  /* ================= period model ================= */
  function range() {
    switch (period) {
      case 'day': return { from: date, to: date };
      case 'week': return { from: startOfWeek(date), to: endOfWeek(date) };
      case 'year': return { from: date.slice(0, 4) + '-01-01', to: date.slice(0, 4) + '-12-31' };
      case 'custom': return { ...custom };
      default: return { from: startOfMonth(date), to: endOfMonth(date) };
    }
  }
  function prevRange(r) {
    if (period === 'month') { const m = addMonths(r.from, -1); return { from: m, to: endOfMonth(m) }; }
    if (period === 'year') return { from: addMonths(r.from, -12), to: addMonths(r.to, -12) };
    const n = lenOf(r);
    return { from: addDays(r.from, -n), to: addDays(r.from, -1) };
  }
  const isCurrent = (r) => r.from <= t0 && t0 <= r.to;
  /** End of the previous period to compare with — same elapsed length while the current one is running. */
  function compareTo(r, pr) {
    return isCurrent(r) ? minDay(pr.to, addDays(pr.from, diffDays(t0, r.from))) : pr.to;
  }
  function budgetMonth(r) {
    if (period === 'year' || period === 'custom') return startOfMonth(r.to < t0 ? r.to : r.from > t0 ? r.from : t0);
    return startOfMonth(date);
  }
  function monthBudget(m) {
    const { overall, byCategory } = resolveBudgets(budgets, startOfMonth(m));
    const catSum = [...byCategory.values()].reduce((a, b) => a + b, 0);
    return overall ?? (catSum || null);
  }
  function periodTitle(r) {
    if (period === 'day') return day(date, 'long');
    if (period === 'week') return `${day(r.from, 'short')} – ${day(r.to, 'medium')}`;
    if (period === 'month') return monthLabel(r.from);
    if (period === 'year') return `Năm ${r.from.slice(0, 4)}`;
    return `${day(r.from, 'medium')} – ${day(r.to, 'medium')}`;
  }
  function periodKicker(r) {
    if (period === 'day') return relDay(date);
    const tag = isCurrent(r) ? 'Kỳ hiện tại' : r.to < t0 ? 'Đã qua' : 'Sắp tới';
    return `${tag} · ${num(lenOf(r))} ngày`;
  }
  function shift(dir) {
    if (period === 'day') date = addDays(date, dir);
    else if (period === 'week') date = addDays(date, 7 * dir);
    else if (period === 'month') date = addMonths(startOfMonth(date), dir);
    else if (period === 'year') date = addMonths(date.slice(0, 4) + '-01-01', 12 * dir);
    else { const n = lenOf(custom); custom = { from: addDays(custom.from, dir * n), to: addDays(custom.to, dir * n) }; }
  }
  function syncQuery() {
    setQuery({
      period: period === 'month' ? null : period,
      date: period === 'custom' || date === t0 ? null : date,
      from: period === 'custom' ? custom.from : null,
      to: period === 'custom' ? custom.to : null,
      m: null, focus: null,
    });
  }
  function goTo(p) {
    if (p.period) period = p.period;
    if (p.date) date = p.date;
    if (p.focus) focusId = p.focus;
    editingId = null;
    listLimit = LIST_STEP;
    syncQuery();
    renderPeriodBar();
    load();
  }

  /* ================= period bar ================= */
  function renderPeriodBar() {
    const r = range();
    mount($('[data-period]'), html`
      <div class="segmented xp-period__seg" role="group" aria-label="Xem theo">
        ${Object.entries(PERIODS).map(([k, l]) => html`<button type="button" data-period="${k}" aria-pressed="${period === k}">${l}</button>`)}
      </div>
      <div class="xp-period__nav">
        <button type="button" class="icon-btn" data-act="prev" aria-label="Kỳ trước">${icon('chevronLeft')}</button>
        <div class="xp-period__title"><span class="eyebrow">${periodKicker(r)}</span><h2>${periodTitle(r)}</h2></div>
        <button type="button" class="icon-btn" data-act="next" aria-label="Kỳ sau">${icon('chevronRight')}</button>
      </div>
      ${period === 'custom'
        ? html`<div class="xp-period__custom">
            <input class="input input--sm" type="date" data-cf="from" value="${custom.from}" aria-label="Từ ngày" />
            <span class="faint">→</span>
            <input class="input input--sm" type="date" data-cf="to" value="${custom.to}" aria-label="Đến ngày" />
          </div>`
        : ''}
      <button type="button" class="btn btn--sm" data-act="today" ${isCurrent(r) && period !== 'custom' ? raw('disabled') : ''}>Hôm nay</button>`);
  }

  /* ================= quick entry ================= */
  const q = { parsed: null, catId: null, manual: false, source: null, remote: [], text: '' };

  function quickSuggestions(desc) {
    if (!desc || desc.trim().length < 2) return [];
    const local = suggestLocal(desc, { history: learn, categories: cats() });
    if (local.length) return local;
    return q.remote;
  }

  function updateQuick() {
    const text = $('[data-quick-input]').value.trim();
    if (text !== q.text) q.remote = q.text && text.startsWith(q.text) ? q.remote : [];
    q.text = text;
    if (!text) { Object.assign(q, { parsed: null, catId: null, manual: false, source: null, remote: [] }); renderQuickPreview(); return; }
    const p = parseExpenseEntry(text, { today: t0, categories: cats() });
    q.parsed = p;
    if (p.category_id) { q.catId = p.category_id; q.source = 'tag'; }
    else if (!q.manual) {
      const s = quickSuggestions(p.description);
      q.catId = s[0]?.category_id || null;
      q.source = s[0] ? 'smart' : null;
      if (!s.length && p.description.length >= 2) fetchRemote(p.description, text);
    }
    renderQuickPreview();
  }
  const fetchRemote = debounce(async (desc, text) => {
    try {
      const res = await suggestRemote(desc);
      if (!alive || q.text !== text || q.manual || q.parsed?.category_id) return;
      q.remote = res.map((r) => ({ category_id: r.category_id, confidence: r.confidence, source: 'history' }));
      if (q.remote[0]) { q.catId = q.remote[0].category_id; q.source = 'smart'; renderQuickPreview(); }
    } catch { /* suggestion is best-effort */ }
  }, 350);

  function renderQuickPreview() {
    const box = $('[data-quick-preview]');
    const go = $('[data-quick-go]');
    const p = q.parsed;
    if (!p) {
      go.disabled = true;
      const last = learn[0] || live()[0];
      mount(box, html`
        <span class="xp-quick__label">Thử:</span>
        ${QUICK_EXAMPLES.map((ex) => html`<button type="button" class="xp-pill xp-pill--ghost" data-example="${ex}">${ex}</button>`)}
        ${last ? html`<span class="grow"></span><button type="button" class="xp-pill" data-act="repeat-last" title="Ghi lại khoản này cho hôm nay">${icon('refresh')} Lặp lại: ${last.description || catName(last.category_id)} · ${moneyShort(last.amount)}</button>` : ''}`);
      return;
    }
    go.disabled = !(p.amount > 0);
    const sugg = p.category_id ? [] : quickSuggestions(p.description).filter((s) => s.category_id !== q.catId).slice(0, 2);
    const pm = p.payment_method || lastPm();
    mount(box, html`
      <span class="xp-pill ${p.amount ? 'xp-pill--strong' : 'xp-pill--warn'}">${p.amount ? money(p.amount) : 'Thiếu số tiền'}</span>
      <span class="xp-pill">${icon('calendar')} ${relDay(p.spent_on)}</span>
      <button type="button" class="xp-pill ${q.catId ? 'is-on' : ''}" data-act="quick-cat" style="--c:${store.categoryById(q.catId)?.color || 'var(--ink-4)'}" title="Đổi danh mục">
        <i class="xp-pill__dot"></i>${catName(q.catId)}${q.source === 'smart' ? html`<span class="xp-pill__tag">${icon('sparkle')} gợi ý</span>` : q.source === 'tag' ? html`<span class="xp-pill__tag">#</span>` : ''}${icon('chevronDown')}
      </button>
      ${sugg.map((s) => html`<button type="button" class="xp-pill xp-pill--ghost" data-qcat="${s.category_id}" style="--c:${store.categoryById(s.category_id)?.color || 'var(--ink-4)'}"><i class="xp-pill__dot"></i>${catName(s.category_id)}</button>`)}
      <span class="xp-pill">${icon(PM_ICON[pm] || 'wallet')} ${PAYMENT_METHODS[pm]}${p.payment_method ? '' : html`<span class="faint">&nbsp;· mặc định</span>`}</span>
      ${p.description ? html`<span class="xp-quick__desc truncate">“${p.description}”</span>` : ''}`);
  }

  async function saveQuick() {
    const p = q.parsed;
    const inp = $('[data-quick-input]');
    if (!p) return;
    if (!(p.amount > 0)) { toast.error('Chưa thấy số tiền — ví dụ: “cafe 45k”.'); inp.focus(); return; }
    const go = $('[data-quick-go]');
    go.disabled = true;
    const payload = { amount: p.amount, spent_on: p.spent_on, description: p.description || null, category_id: q.catId || null, payment_method: p.payment_method || lastPm(), note: null };
    try {
      const created = await createExpense(payload);
      if (p.payment_method) writePm(p.payment_method);
      inp.value = '';
      updateQuick();
      announceCreated(created);
      if (!alive) return;
      await load({ full: true });
    } catch (err) {
      toast.error(err);
      go.disabled = false;
    }
  }

  function announceCreated(x) {
    const r = range();
    const outside = !inRange(x, r.from, r.to);
    toast(`Đã ghi ${money(x.amount)} · ${catName(x.category_id)} · ${relDay(x.spent_on)}${outside ? ' (ngoài kỳ đang xem)' : ''}.`, {
      action: { label: 'Hoàn tác', onClick: async () => { try { await deleteExpense(x.id); toast.info('Đã hoàn tác.'); if (alive) load({ full: true }); } catch (err) { toast.error(err); } } },
    });
  }

  async function repeatLast() {
    const last = learn[0] || live()[0];
    if (!last) return;
    try {
      const created = await createExpense({ amount: last.amount, description: last.description, category_id: last.category_id, payment_method: last.payment_method, spent_on: t0, note: null });
      announceCreated(created);
      if (alive) load({ full: true });
    } catch (err) { toast.error(err); }
  }

  /* ================= summary strip ================= */
  function renderStats() {
    const r = range();
    const all = live();
    const pr = prevRange(r);
    const cmpTo = compareTo(r, pr);
    const list = all.filter((x) => inRange(x, r.from, r.to));
    const total = sum(list);
    const prev = period === 'year' ? prevYearTotal : sum(all.filter((x) => inRange(x, pr.from, cmpTo)));
    const change = prev ? ((total - prev) / prev) * 100 : null;
    const running = isCurrent(r);
    const elapsed = r.from > t0 ? 0 : running ? diffDays(t0, r.from) + 1 : lenOf(r);
    const avg = elapsed ? total / elapsed : 0;
    const biggest = list.reduce((m, x) => (!m || x.amount > m.amount ? x : m), null);

    const bm = budgetMonth(r);
    const mRows = all.filter((x) => inRange(x, bm, endOfMonth(bm)));
    const mSpent = sum(mRows);
    const mBudget = monthBudget(bm);
    const mDays = daysIn(bm);
    const mCurrent = bm === startOfMonth(t0);
    const mElapsed = bm > t0 ? 0 : mCurrent ? diffDays(t0, bm) + 1 : mDays;
    const projected = mCurrent ? (mElapsed ? (mSpent / mElapsed) * mDays : 0) : bm > t0 ? 0 : mSpent;
    const remaining = mBudget != null ? mBudget - mSpent : null;
    const daysLeft = mCurrent ? mDays - mElapsed + 1 : 0;
    const usedPct = mBudget ? (mSpent / mBudget) * 100 : 0;
    const mShort = `T${Number(bm.slice(5, 7))}/${bm.slice(0, 4)}`;

    const deltaTpl = change == null
      ? html`<span>${prev === 0 && total > 0 ? `${PREV_LABEL[period]} chưa chi gì` : `${num(list.length)} khoản chi`}</span>`
      : html`<span class="delta ${change > 0 ? 'delta--down' : 'delta--up'}">${change > 0 ? '▲' : '▼'} ${pct(Math.abs(change))}</span><span>so với ${running ? 'cùng kỳ ' : ''}${PREV_LABEL[period]}</span>`;

    mount($('[data-stats]'), html`
      <div class="stat stat--accent">
        <div class="stat__label"><span class="eyebrow">Tổng chi · ${PERIODS[period].toLowerCase()}</span><span class="stat__icon">${icon('wallet')}</span></div>
        <div class="stat__value xp-stat__v">${money(total)}</div>
        <div class="stat__meta">${deltaTpl}</div>
      </div>
      ${period === 'day'
        ? html`<div class="stat">
            <div class="stat__label"><span class="eyebrow">Số khoản chi</span><span class="stat__icon">${icon('list')}</span></div>
            <div class="stat__value xp-stat__v">${num(list.length)}<small>khoản</small></div>
            <div class="stat__meta">${biggest ? html`<span>Lớn nhất ${moneyShort(biggest.amount)} · ${biggest.description || catName(biggest.category_id)}</span>` : html`<span>Chưa có khoản nào</span>`}</div>
          </div>`
        : html`<div class="stat">
            <div class="stat__label"><span class="eyebrow">Trung bình / ngày</span><span class="stat__icon">${icon('activity')}</span></div>
            <div class="stat__value xp-stat__v">${money(avg)}</div>
            <div class="stat__meta"><span>${num(list.length)} khoản · ${num(elapsed)} ngày${running ? ' đã qua' : ''}</span></div>
          </div>`}
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Ngân sách còn · ${mShort}</span><span class="stat__icon">${icon('piggy')}</span></div>
        ${mBudget != null
          ? html`<div class="stat__value xp-stat__v ${remaining < 0 ? 'danger-text' : ''}">${money(remaining)}</div>
            <div class="stat__meta xp-stat__meta-col">
              ${meter(usedPct, { over: remaining < 0, warn: usedPct >= 80, proj: mCurrent && mBudget ? (projected / mBudget) * 100 : null })}
              <span>${remaining < 0 ? html`<span class="danger-text">Vượt ${money(-remaining)}</span>` : mCurrent && daysLeft > 0 ? `≈ ${money(remaining / daysLeft)} / ngày cho ${daysLeft} ngày còn lại` : `${pct(usedPct)} đã dùng`}</span>
            </div>`
          : html`<div class="stat__value xp-stat__v faint">—</div><div class="stat__meta"><button type="button" class="btn btn--sm" data-act="budget">${icon('plus')} Đặt ngân sách</button></div>`}
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">${mCurrent ? 'Dự báo cuối tháng' : bm > t0 ? 'Tháng sắp tới' : `Chi cả ${mShort}`}</span><span class="stat__icon">${icon('trend')}</span></div>
        <div class="stat__value xp-stat__v">${money(projected)}</div>
        <div class="stat__meta">${mBudget != null && bm <= t0
          ? projected > mBudget
            ? html`<span class="delta delta--down">vượt ${moneyShort(projected - mBudget)}</span><span>so với ngân sách</span>`
            : html`<span class="delta delta--up">dư ${moneyShort(mBudget - projected)}</span><span>so với ngân sách</span>`
          : html`<span>${mCurrent ? `theo nhịp ${moneyShort(mElapsed ? mSpent / mElapsed : 0)}/ngày` : `${num(mRows.length)} khoản`}</span>`}</div>
      </div>`);
  }

  function meter(p, { over = false, warn = false, proj = null, color } = {}) {
    const w = Math.max(0, Math.min(100, p || 0));
    const cls = over ? 'is-over' : warn ? 'is-warn' : '';
    return html`<div class="xp-meter ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p || 0)}" style="${color ? `--c:${color}` : ''}">
      <span class="xp-meter__fill" style="width:${w}%"></span>
      ${proj != null && proj > 0 ? html`<i class="xp-meter__proj ${proj > 100 ? 'is-over' : ''}" style="left:${Math.min(100, proj)}%" title="Dự báo cuối tháng: ${pct(proj)}"></i>` : ''}
    </div>`;
  }

  /* ================= E.1 rhythm ================= */
  function buckets(r) {
    const all = live();
    const monthly = period === 'year' || (period === 'custom' && lenOf(r) > 92);
    const out = [];
    if (monthly) {
      for (let m = startOfMonth(r.from); m <= r.to; m = addMonths(m, 1)) {
        const a = maxDay(m, r.from), b = minDay(endOfMonth(m), r.to);
        const mb = monthBudget(m);
        out.push({
          from: a, to: b, label: period === 'year' ? `Th${Number(m.slice(5, 7))}` : `${m.slice(5, 7)}/${m.slice(2, 4)}`,
          title: monthLabel(m), future: a > t0, drill: { period: 'month', date: m },
          guide: mb != null ? (mb * (diffDays(b, a) + 1)) / daysIn(m) : null,
        });
      }
    } else {
      const days = period === 'day' ? daysBetween(addDays(date, -13), date) : daysBetween(r.from, r.to);
      const spansMonths = days[0].slice(0, 7) !== days[days.length - 1].slice(0, 7);
      for (const d of days) {
        const mb = monthBudget(d);
        out.push({
          from: d, to: d,
          label: period === 'week' ? `${WD_SHORT[weekday(d)]} ${Number(d.slice(8))}` : spansMonths ? `${Number(d.slice(8))}/${Number(d.slice(5, 7))}` : String(Number(d.slice(8))),
          title: day(d, 'weekday'), future: d > t0, drill: { period: 'day', date: d }, sel: period === 'day' && d === date,
          guide: mb != null ? mb / daysIn(d) : null,
        });
      }
    }
    for (const b of out) b.total = sum(all.filter((x) => inRange(x, b.from, b.to)));
    return out;
  }

  function renderRhythm() {
    const r = range();
    const bs = buckets(r);
    const p = palette();
    const hasGuide = bs.some((b) => b.guide);
    const peak = bs.reduce((m, b) => (b.total > (m?.total || 0) ? b : m), null);
    const over = bs.filter((b) => b.guide && b.total > b.guide && !b.future).length;
    const unit = period === 'year' || (period === 'custom' && lenOf(r) > 92) ? 'tháng' : 'ngày';
    const title = period === 'day' ? '14 ngày gần đây' : 'Nhịp chi tiêu';
    mount($('[data-c1]'), html`
      ${sheetHead('E.1', title, html`<div class="chart-key">
        <span><i style="background:var(--ink)"></i>Chi mỗi ${unit}</span>
        <span><i style="background:var(--clay)"></i>Vượt mức</span>
        ${hasGuide ? html`<span><i class="xp-key-dash"></i>Ngân sách / ${unit}</span>` : ''}
      </div>`)}
      <div class="sheet__body">
        <div class="chart-box" data-c></div>
        <p class="xp-insight">${peak
          ? html`Cao nhất <strong>${peak.title}</strong> · <span class="num">${money(peak.total)}</span>${hasGuide ? html` — <strong>${num(over)}</strong> ${unit} vượt mức ngân sách` : ''}. <span class="faint">Chạm vào cột để xem chi tiết.</span>`
          : 'Chưa có khoản chi nào trong khoảng này.'}</p>
      </div>`);
    const ds = [{
      type: 'bar', label: 'Đã chi', data: bs.map((b) => b.total), order: 2,
      backgroundColor: bs.map((b) => (b.sel || (unit === 'ngày' && b.from === t0) ? p.accent : b.guide && b.total > b.guide ? p.clay : p.ink)),
      borderRadius: 2, maxBarThickness: period === 'week' ? 36 : 18,
    }];
    if (hasGuide) ds.push({ type: 'line', label: 'Ngân sách', data: bs.map((b) => b.guide), order: 1, borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1.25, pointRadius: 0, stepped: 'middle', fill: false });
    setChart('c1', makeChart($('[data-c1] [data-c]'), {
      type: 'bar',
      data: { labels: bs.map((b) => b.label), datasets: ds },
      options: {
        onClick: (e, els) => { const b = bs[els?.[0]?.index]; if (b) setTimeout(() => alive && goTo(b.drill), 0); },
        onHover: (e, els) => { if (e.native?.target) e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
        scales: { y: { ticks: { callback: (v) => moneyShort(v) } }, x: { ticks: { autoSkip: true, maxTicksLimit: period === 'month' ? 16 : 14 } } },
        plugins: { tooltip: { callbacks: { title: (c) => bs[c[0].dataIndex].title, label: (c) => (c.raw == null ? null : ` ${c.dataset.label}: ${money(c.raw)}`) } } },
      },
    }));
  }

  /* ================= E.2 categories ================= */
  function catBreakdown(list) {
    const m = new Map();
    for (const x of list) {
      const k = x.category_id || 'none';
      const o = m.get(k) || { id: x.category_id || null, total: 0, count: 0 };
      o.total += Number(x.amount); o.count++;
      m.set(k, o);
    }
    const fallback = series();
    return [...m.values()].sort((a, b) => b.total - a.total).map((o, i) => ({
      ...o, name: catName(o.id), color: store.categoryById(o.id)?.color || (o.id ? fallback[i % fallback.length] : palette().ink4),
    }));
  }

  function renderCats() {
    const r = range();
    const list = live().filter((x) => inRange(x, r.from, r.to));
    const total = sum(list);
    const data = catBreakdown(list);
    const head = sheetHead('E.2', 'Cơ cấu danh mục', f.cat ? html`<button type="button" class="btn btn--ghost btn--sm" data-act="clear-cat">${icon('x')} Bỏ lọc</button>` : '');
    if (!data.length) {
      mount($('[data-c2]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có dữ liệu', text: 'Các khoản chi trong kỳ sẽ được chia theo danh mục ở đây.' })}`);
      return;
    }
    mount($('[data-c2]'), html`${head}
      <div class="sheet__body xp-donut">
        <div class="donut"><div class="chart-box chart-box--sm" data-c></div>
          <div class="donut__center"><span class="eyebrow">Tổng</span><strong class="display">${moneyShort(total)}</strong><span class="faint xp-donut__sub">${num(data.length)} danh mục</span></div>
        </div>
        <ul class="xp-legend">
          ${data.slice(0, 8).map((c) => html`
            <li><button type="button" class="xp-legend__row ${f.cat && f.cat === (c.id || 'none') ? 'is-on' : ''}" data-fcat="${c.id || 'none'}" style="--c:${c.color}" title="Lọc sổ chi theo ${c.name}">
              <i class="legend__dot"></i><span class="truncate">${c.name}</span>
              <span class="legend__val">${moneyShort(c.total)}</span><span class="legend__pct">${pct((c.total / total) * 100)}</span>
            </button></li>`)}
          ${data.length > 8 ? html`<li class="faint xp-legend__more">+ ${data.length - 8} danh mục khác · ${moneyShort(data.slice(8).reduce((s, c) => s + c.total, 0))}</li>` : ''}
        </ul>
      </div>`);
    setChart('c2', makeChart($('[data-c2] [data-c]'), {
      type: 'doughnut',
      data: { labels: data.map((c) => c.name), datasets: [{ data: data.map((c) => c.total), backgroundColor: data.map((c) => c.color), borderColor: palette().surface, borderWidth: 2, hoverOffset: 4 }] },
      options: {
        onClick: (e, els) => { const c = data[els?.[0]?.index]; if (c) setTimeout(() => alive && setCatFilter(c.id || 'none'), 0); },
        plugins: { tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.raw)} · ${pct((c.raw / total) * 100)}` } } },
      },
    }));
  }

  /* ================= E.3 cumulative ================= */
  function renderCumulative() {
    const r = range();
    const all = live();
    const p = palette();
    let labels = [], actual = [], pace = [], proj = [], titles = [], heading, budgetTotal = null;
    if (period === 'year') {
      const y = r.from.slice(0, 4);
      let acc = 0, accB = 0, any = false;
      const yearDays = diffDays(r.to, r.from) + 1;
      const elapsed = r.from > t0 ? 0 : r.to < t0 ? yearDays : diffDays(t0, r.from) + 1;
      for (let i = 0; i < 12; i++) {
        const m = `${y}-${String(i + 1).padStart(2, '0')}-01`;
        const mb = monthBudget(m);
        if (mb != null) any = true;
        accB += mb || 0;
        acc += sum(all.filter((x) => inRange(x, m, endOfMonth(m))));
        labels.push(`Th${i + 1}`); titles.push(monthLabel(m));
        actual.push(m <= t0 ? acc : null);
        pace.push(any ? accB : null);
      }
      budgetTotal = any ? accB : null;
      const curIdx = y === t0.slice(0, 4) ? Number(t0.slice(5, 7)) - 1 : -1;
      if (curIdx >= 0 && elapsed) {
        const rate = actual[curIdx] / elapsed;
        proj = labels.map((_, i) => (i < curIdx ? null : i === curIdx ? actual[curIdx] : rate * (diffDays(endOfMonth(`${y}-${String(i + 1).padStart(2, '0')}-01`), r.from) + 1)));
      }
      heading = `Lũy kế năm ${y}`;
    } else {
      const span = period === 'custom' ? r : { from: budgetMonth(r), to: endOfMonth(budgetMonth(r)) };
      const days = daysBetween(span.from, span.to);
      let acc = 0, accB = 0, any = false;
      days.forEach((d) => {
        const mb = monthBudget(d);
        if (mb != null) any = true;
        accB += mb != null ? mb / daysIn(d) : 0;
        acc += sum(all.filter((x) => x.spent_on === d));
        labels.push(String(Number(d.slice(8)))); titles.push(day(d, 'weekday'));
        actual.push(d <= t0 ? acc : null);
        pace.push(any ? accB : null);
      });
      budgetTotal = any ? accB : null;
      const ti = days.indexOf(t0);
      if (ti >= 0) {
        const rate = actual[ti] / (ti + 1);
        proj = days.map((d, i) => (i < ti ? null : actual[ti] + rate * (i - ti)));
      }
      heading = period === 'custom' ? 'Lũy kế trong kỳ' : `Lũy kế · ${monthLabel(span.from)}`;
    }
    const lastIdx = actual.reduce((k, v, i) => (v != null ? i : k), -1);
    const now = lastIdx >= 0 ? actual[lastIdx] : 0;
    const paceNow = lastIdx >= 0 ? pace[lastIdx] : null;
    const end = proj.length ? proj[proj.length - 1] : now;
    let insight;
    if (lastIdx < 0) insight = html`Kỳ này chưa bắt đầu.`;
    else if (paceNow) {
      const d = ((now - paceNow) / paceNow) * 100;
      insight = d > 3
        ? html`Đang chi <strong class="danger-text">nhanh hơn ${pct(d)}</strong> so với nhịp ngân sách${budgetTotal && end > budgetTotal ? html` — dự báo vượt <strong class="num">${moneyShort(end - budgetTotal)}</strong>` : ''}.`
        : d < -3
          ? html`Đang chi <strong class="success-text">chậm hơn ${pct(-d)}</strong> so với nhịp ngân sách — tốt lắm.`
          : html`Đang bám sát nhịp ngân sách.`;
    } else insight = html`Đặt ngân sách để thấy đường nhịp chi tiêu lý tưởng. <button type="button" class="btn btn--ghost btn--sm" data-act="budget">Đặt ngay</button>`;

    mount($('[data-c3]'), html`
      ${sheetHead('E.3', heading, html`<div class="chart-key">
        <span><i style="background:var(--accent);height:3px"></i>Thực chi</span>
        ${proj.length ? html`<span><i class="xp-key-dash xp-key-dash--accent"></i>Dự báo</span>` : ''}
        ${budgetTotal ? html`<span><i class="xp-key-dash"></i>Nhịp ngân sách</span>` : ''}
      </div>`)}
      <div class="sheet__body"><div class="chart-box chart-box--sm" data-c></div><p class="xp-insight">${insight}</p></div>`);
    const ds = [
      { type: 'line', label: 'Thực chi', data: actual, borderColor: p.accent, backgroundColor: p.accentSoft, fill: 'origin', borderWidth: 2, pointRadius: 0, tension: 0.25 },
    ];
    if (proj.length) ds.push({ type: 'line', label: 'Dự báo', data: proj, borderColor: p.accent, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, fill: false });
    if (budgetTotal) ds.push({ type: 'line', label: 'Nhịp ngân sách', data: pace, borderColor: p.ink3, borderDash: [2, 3], borderWidth: 1.25, pointRadius: 0, fill: false });
    setChart('c3', makeChart($('[data-c3] [data-c]'), {
      type: 'line',
      data: { labels, datasets: ds },
      options: {
        scales: { y: { ticks: { callback: (v) => moneyShort(v) } }, x: { ticks: { autoSkip: true, maxTicksLimit: 10 } } },
        plugins: { tooltip: { callbacks: { title: (c) => titles[c[0].dataIndex], label: (c) => (c.raw == null ? null : ` ${c.dataset.label}: ${money(c.raw)}`) } } },
      },
    }));
  }

  /* ================= E.4 weekday ================= */
  function renderWeekday() {
    const r = range();
    const endD = minDay(r.to, t0);
    const long = ['month', 'year'].includes(period) || (period === 'custom' && lenOf(r) >= 28);
    const from = long ? r.from : addDays(endD, -55);
    const label = long ? 'trong kỳ' : '8 tuần gần nhất';
    const all = live();
    const totals = Array(7).fill(0), counts = Array(7).fill(0);
    if (from <= endD) {
      for (const d of daysBetween(from, endD)) counts[weekday(d)]++;
      for (const x of all) if (inRange(x, from, endD)) totals[weekday(x.spent_on)] += Number(x.amount);
    }
    const ws = getWeekStart();
    const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);
    const avg = order.map((w) => (counts[w] ? totals[w] / counts[w] : 0));
    const head = sheetHead('E.4', 'Theo thứ trong tuần', html`<span class="eyebrow">${label}</span>`);
    if (!avg.some((v) => v > 0)) {
      mount($('[data-c4]'), html`${head}${emptyState({ art: 'calendar', small: true, title: 'Chưa đủ dữ liệu', text: 'Ghi chi tiêu vài ngày để thấy thói quen theo thứ.' })}`);
      return;
    }
    const maxV = Math.max(...avg);
    const nonZero = avg.filter((v) => v > 0);
    const minV = Math.min(...nonZero);
    const top = order[avg.indexOf(maxV)];
    const weekend = order.filter((w) => w === 0 || w === 6).reduce((s, w) => s + (counts[w] ? totals[w] / counts[w] : 0), 0) / 2;
    const weekdays = order.filter((w) => w > 0 && w < 6).reduce((s, w) => s + (counts[w] ? totals[w] / counts[w] : 0), 0) / 5;
    const p = palette();
    mount($('[data-c4]'), html`${head}
      <div class="sheet__body">
        <p class="xp-callout">Bạn chi nhiều nhất vào <strong>${WD_FULL[top]}</strong></p>
        <div class="chart-box chart-box--sm" data-c></div>
        <p class="xp-insight">Trung bình <span class="num">${money(maxV)}</span>/ngày${minV > 0 && maxV / minV >= 1.2 ? html`, gấp <strong>${dec(Math.round((maxV / minV) * 10) / 10)}×</strong> ngày chi ít nhất` : ''}. ${weekdays > 0 && weekend > 0
          ? weekend > weekdays ? html`Cuối tuần chi nhiều hơn ngày thường <strong>${pct(((weekend - weekdays) / weekdays) * 100)}</strong>.` : html`Ngày thường chi nhiều hơn cuối tuần.`
          : ''}</p>
      </div>`);
    setChart('c4', makeChart($('[data-c4] [data-c]'), {
      type: 'bar',
      data: { labels: order.map((w) => WD_SHORT[w]), datasets: [{ label: 'TB / ngày', data: avg, backgroundColor: order.map((w) => (w === top ? p.accent : p.ink)), borderRadius: 2, maxBarThickness: 26 }] },
      options: {
        scales: { y: { ticks: { callback: (v) => moneyShort(v), maxTicksLimit: 4 } } },
        plugins: { tooltip: { callbacks: { title: (c) => WD_FULL[order[c[0].dataIndex]], label: (c) => ` Trung bình: ${money(c.raw)} · ${counts[order[c.dataIndex]]} ngày` } } },
      },
    }));
  }

  /* ================= E.5 payment ================= */
  function renderPayment() {
    const r = range();
    const list = live().filter((x) => inRange(x, r.from, r.to));
    const total = sum(list);
    const m = new Map();
    for (const x of list) { const o = m.get(x.payment_method) || { total: 0, count: 0 }; o.total += Number(x.amount); o.count++; m.set(x.payment_method, o); }
    const data = [...m.entries()].sort((a, b) => b[1].total - a[1].total);
    const head = sheetHead('E.5', 'Thanh toán');
    if (!data.length) { mount($('[data-c5]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có dữ liệu' })}`); return; }
    mount($('[data-c5]'), html`${head}
      <ul class="xp-pay">
        ${data.map(([k, o]) => html`<li>
          <button type="button" class="xp-pay__row ${f.pm === k ? 'is-on' : ''}" data-fpm="${k}" title="Lọc sổ chi theo ${PAYMENT_METHODS[k] || k}">
            <span class="xp-pay__icon">${icon(PM_ICON[k] || 'wallet')}</span>
            <span class="xp-pay__name">${PAYMENT_METHODS[k] || k}<small>${num(o.count)} khoản</small></span>
            <span class="xp-pay__amt num">${moneyShort(o.total)}<small>${pct((o.total / total) * 100)}</small></span>
            <span class="xp-pay__track"><span style="width:${(o.total / data[0][1].total) * 100}%"></span></span>
          </button>
        </li>`)}
      </ul>`);
  }

  /* ================= E.6 budgets ================= */
  function renderBudget() {
    const bm = budgetMonth(range());
    const head = sheetHead('E.6', `Ngân sách · ${monthLabel(bm)}`, html`<button type="button" class="btn btn--ghost btn--sm" data-act="budget">${icon('edit')} Điều chỉnh</button>`);
    if (statusErr) { mount($('[data-budget]'), html`${head}<div class="sheet__body">${errorState(statusErr)}</div>`); return; }
    if (!statusRows) { mount($('[data-budget]'), html`${head}${loadingRows(4)}`); return; }
    const overall = statusRows.find((x) => !x.category_id);
    const catRows = statusRows.filter((x) => x.category_id);
    const withB = catRows.filter((x) => x.budget != null).sort((a, b) => (b.used_pct ?? 0) - (a.used_pct ?? 0));
    const noB = catRows.filter((x) => x.budget == null && x.spent > 0).sort((a, b) => b.spent - a.spent);
    if (!overall?.budget && !withB.length) {
      mount($('[data-budget]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có ngân sách cho tháng này', text: 'Đặt ngân sách tổng hoặc theo từng danh mục để nhận cảnh báo trước khi chi vượt.', action: html`<button type="button" class="btn btn--primary btn--sm" data-act="budget">${icon('piggy')} Đặt ngân sách</button>` })}`);
      return;
    }
    const over = statusRows.filter((x) => x.status === 'over');
    const warn = statusRows.filter((x) => x.status === 'warning');
    const nm = (x) => (x.category_id ? x.category_name || catName(x.category_id) : 'Tổng');
    const ovSpent = overall?.spent ?? catRows.reduce((s, x) => s + x.spent, 0);
    mount($('[data-budget]'), html`${head}
      <div class="sheet__body xp-budget">
        ${over.length ? html`<div class="notice notice--danger">${icon('alert')}<div><strong>Đã vượt ngân sách:</strong> ${over.map((x, i) => html`${i ? ', ' : ''}${nm(x)} <span class="num">(+${moneyShort(x.spent - x.budget)})</span>`)}</div></div>` : ''}
        ${warn.length ? html`<div class="notice notice--warning">${icon('info')}<div><strong>Cần chú ý:</strong> ${warn.map((x, i) => html`${i ? ', ' : ''}${nm(x)} <span class="num">(${x.projected > x.budget ? `dự báo ${moneyShort(x.projected)}` : pct(x.used_pct)} / ${moneyShort(x.budget)})</span>`)}</div></div>` : ''}
        ${overall?.budget != null ? html`
          <div class="xp-budget__hero">
            <div class="row between xp-budget__hero-top">
              <div><span class="eyebrow">Toàn bộ chi tiêu</span><div class="xp-budget__big"><span class="num">${money(ovSpent)}</span><span class="faint"> / ${money(overall.budget)}</span></div></div>
              ${statusBadge(overall.status)}
            </div>
            ${meter(overall.used_pct, { over: overall.status === 'over', warn: overall.status === 'warning', proj: overall.budget ? (overall.projected / overall.budget) * 100 : null })}
            <div class="xp-budget__foot"><span>${overall.remaining >= 0 ? `Còn ${money(overall.remaining)}` : `Vượt ${money(-overall.remaining)}`}</span><span>Dự báo ${money(overall.projected)}</span></div>
          </div>` : ''}
        ${withB.length ? html`<ul class="xp-blist">
          ${withB.map((x) => html`<li>
            <div class="xp-blist__top">${catLabel(x.category_id, x.category_name || undefined)}<span class="num xp-blist__amt ${x.status === 'over' ? 'danger-text' : ''}">${moneyShort(x.spent)}<span class="faint"> / ${moneyShort(x.budget)}</span></span>${statusBadge(x.status)}</div>
            ${meter(x.used_pct, { over: x.status === 'over', warn: x.status === 'warning', proj: x.budget ? (x.projected / x.budget) * 100 : null, color: x.color || store.categoryById(x.category_id)?.color })}
          </li>`)}
        </ul>` : ''}
        ${noB.length ? html`<div class="xp-budget__nob"><span class="eyebrow">Chưa đặt ngân sách</span>
          <div class="row-wrap">${noB.slice(0, 6).map((x) => html`<span class="xp-pill xp-pill--ghost" style="--c:${x.color || 'var(--ink-4)'}"><i class="xp-pill__dot"></i>${nm(x)} · <span class="num">${moneyShort(x.spent)}</span></span>`)}</div></div>` : ''}
        <p class="faint xp-budget__legend"><i class="xp-meter__proj-key"></i> vạch đứng = dự báo cuối tháng theo nhịp hiện tại</p>
      </div>`);
  }
  const statusBadge = (s) => html`<span class="badge badge--${(STATUS[s] || STATUS.no_budget)[1]}">${(STATUS[s] || STATUS.no_budget)[0]}</span>`;

  /* ================= E.7 anomalies ================= */
  function renderAnomalies() {
    const head = sheetHead('E.7', 'Khoản chi bất thường', html`<span class="eyebrow">60 ngày</span>`);
    if (anomalies == null) { mount($('[data-anom]'), html`${head}${loadingRows(3)}`); return; }
    if (anomalies instanceof Error) { mount($('[data-anom]'), html`${head}<div class="sheet__body">${errorState(anomalies)}</div>`); return; }
    if (!anomalies.length) {
      mount($('[data-anom]'), html`${head}${emptyState({ art: 'target', small: true, title: 'Không có gì bất thường', text: 'Không khoản chi nào cao vượt hẳn mức thường lệ của danh mục trong 60 ngày qua.' })}`);
      return;
    }
    mount($('[data-anom]'), html`${head}
      <ul class="list xp-anom">
        ${anomalies.slice(0, 6).map((a) => {
          const ratio = a.baseline > 0 ? a.amount / a.baseline : null;
          return html`<li><button type="button" class="xp-anom__row" data-goto="${a.spent_on}" data-eid="${a.expense_id}">
            <span class="xp-anom__x num">${ratio ? `${dec(Math.round(ratio * 10) / 10)}×` : '!'}</span>
            <span class="xp-anom__main"><span class="truncate xp-anom__title">${a.description || a.category_name || 'Khoản chi'}</span>
              <span class="xp-anom__meta">${catLabel(a.category_id, a.category_name || undefined)}<span class="faint">· ${relDay(a.spent_on)}${a.baseline ? ` · thường ${moneyShort(a.baseline)}` : ''}</span></span></span>
            <span class="num xp-anom__amt">${money(a.amount)}</span>
          </button></li>`;
        })}
      </ul>
      <div class="sheet__foot"><span>So với trung vị 180 ngày trước của cùng danh mục</span></div>`);
  }

  /* ================= ledger ================= */
  function filtered() {
    const r = range();
    const qq = f.q.trim().toLowerCase();
    return live().filter((x) => inRange(x, r.from, r.to) &&
      (!f.cat || (f.cat === 'none' ? !x.category_id : x.category_id === f.cat)) &&
      (!f.pm || x.payment_method === f.pm) &&
      (!qq || (x.description || '').toLowerCase().includes(qq) || (x.note || '').toLowerCase().includes(qq) || catName(x.category_id).toLowerCase().includes(qq)));
  }

  function renderList() {
    const r = range();
    const inPeriod = live().filter((x) => inRange(x, r.from, r.to));
    const list = filtered();
    if (!inPeriod.length) {
      mount($('[data-list]'), html`${emptyState({ art: 'wallet', title: 'Chưa có khoản chi nào trong kỳ', text: 'Gõ vào ô ghi nhanh phía trên — ví dụ “cafe 45k” rồi nhấn Enter.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Ghi khoản chi</button>` })}`);
      return;
    }
    if (!list.length) {
      mount($('[data-list]'), html`${emptyState({ art: 'wallet', small: true, title: 'Không có khoản chi phù hợp bộ lọc', action: html`<button class="btn btn--sm" data-act="clear">Xóa bộ lọc</button>` })}`);
      return;
    }
    const total = sum(list);
    const shown = list.slice(0, listLimit);
    const groups = new Map();
    shown.forEach((x) => (groups.get(x.spent_on) || groups.set(x.spent_on, []).get(x.spent_on)).push(x));
    const dayTotals = new Map();
    list.forEach((x) => dayTotals.set(x.spent_on, (dayTotals.get(x.spent_on) || 0) + Number(x.amount)));
    const filteredOn = f.q || f.cat || f.pm;
    mount($('[data-list]'), html`
      ${[...groups.entries()].map(([d, items]) => html`
        <div class="group-head xp-dayhead"><span class="group-head__day">${relDay(d)}<small>${day(d, 'numeric')}</small></span><span class="group-head__sum">${num(items.length)} khoản · <strong>${money(dayTotals.get(d))}</strong></span></div>
        <ul class="list xp-rows">${items.map(rowTpl)}</ul>`)}
      ${list.length > shown.length ? html`<div class="xp-more"><button type="button" class="btn btn--sm" data-act="more">Xem thêm ${num(Math.min(LIST_STEP, list.length - shown.length))} khoản (còn ${num(list.length - shown.length)})</button></div>` : ''}
      <div class="sheet__foot"><span>${num(list.length)} khoản chi${filteredOn ? ' (đã lọc)' : ''}</span><strong class="num">${money(total)}</strong></div>`);
    if (editingId) root.querySelector('[data-inline] [name=amount]')?.focus();
    if (focusId) {
      const el = root.querySelector(`.xp-row[data-id="${CSS.escape(focusId)}"]`);
      focusId = null;
      setQuery({ focus: null });
      if (el) { el.classList.add('is-flash'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
  }

  function rowTpl(x) {
    if (x.id === editingId) return inlineTpl(x);
    const c = store.categoryById(x.category_id);
    return html`<li class="xp-row" data-id="${x.id}">
      <span class="xp-row__icon" style="--c:${c?.color || 'var(--ink-4)'}" aria-hidden="true">${(c?.name || '•').charAt(0)}</span>
      <button type="button" class="xp-row__main" data-act="edit" title="Sửa nhanh">
        <span class="xp-row__title truncate">${x.description || c?.name || 'Khoản chi'}</span>
        <span class="xp-row__meta">${catLabel(x.category_id)}<span class="faint">· ${PAYMENT_METHODS[x.payment_method] || x.payment_method}</span>${x.note ? html`<span class="faint truncate">· ${x.note}</span>` : ''}</span>
      </button>
      <span class="xp-row__amt num">−${money(x.amount)}</span>
      <button type="button" class="icon-btn icon-btn--sm xp-row__menu" data-act="menu" aria-label="Thao tác cho khoản chi">${icon('more')}</button>
    </li>`;
  }

  function inlineTpl(x) {
    return html`<li class="xp-row is-editing" data-id="${x.id}">
      <form class="xp-inline" data-inline novalidate>
        <label class="xp-inline__f xp-inline__f--amt"><span class="eyebrow">Số tiền</span><input class="input input--sm num" name="amount" value="${String(Math.round(x.amount))}" inputmode="decimal" autocomplete="off" required /></label>
        <label class="xp-inline__f xp-inline__f--desc"><span class="eyebrow">Mô tả</span><input class="input input--sm" name="description" value="${x.description || ''}" maxlength="200" placeholder="Mô tả" /></label>
        <label class="xp-inline__f"><span class="eyebrow">Danh mục</span><select class="select select--sm" name="category_id">${categoryOptions('expense', { all: '— Chưa phân loại —' }).map((o) => html`<option value="${o.value}" ${o.value === (x.category_id || '') ? raw('selected') : ''}>${o.label}</option>`)}</select></label>
        <label class="xp-inline__f"><span class="eyebrow">Thanh toán</span><select class="select select--sm" name="payment_method">${Object.entries(PAYMENT_METHODS).map(([v, l]) => html`<option value="${v}" ${v === x.payment_method ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="xp-inline__f"><span class="eyebrow">Ngày</span><input class="input input--sm" type="date" name="spent_on" value="${x.spent_on}" required /></label>
        <div class="xp-inline__acts">
          <button type="button" class="btn btn--danger-ghost btn--sm" data-act="inline-del">${icon('trash')} Xóa</button>
          <span class="grow"></span>
          <button type="button" class="btn btn--ghost btn--sm" data-act="inline-more">Chi tiết…</button>
          <button type="button" class="btn btn--ghost btn--sm" data-act="inline-cancel">Hủy</button>
          <button type="submit" class="btn btn--primary btn--sm">Lưu</button>
        </div>
      </form>
    </li>`;
  }

  async function saveInline(form) {
    const id = form.closest('[data-id]').dataset.id;
    const v = formData(form);
    const amount = parseMoney(v.amount);
    if (!(amount > 0)) { toast.error('Nhập số tiền lớn hơn 0.'); form.querySelector('[name=amount]').focus(); return; }
    if (!v.spent_on) { toast.error('Chọn ngày chi.'); return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await updateExpense(id, { amount, description: v.description || null, category_id: v.category_id || null, payment_method: v.payment_method, spent_on: v.spent_on });
      editingId = null;
      toast('Đã lưu khoản chi.');
      await load({ full: true });
    } catch (err) { toast.error(err); btn.disabled = false; }
  }

  function removeWithUndo(x) {
    if (!x || pendingDel.has(x.id)) return;
    if (editingId === x.id) editingId = null;
    const timer = setTimeout(() => commitDelete(x.id), 5200);
    pendingDel.set(x.id, { x, timer });
    renderData();
    toast(`Đã xóa ${money(x.amount)} — ${x.description || catName(x.category_id)}.`, {
      type: 'info', duration: 5000,
      action: { label: 'Hoàn tác', onClick: () => { const p = pendingDel.get(x.id); if (!p) return; clearTimeout(p.timer); pendingDel.delete(x.id); if (alive) renderData(); } },
    });
  }
  async function commitDelete(id) {
    if (!pendingDel.has(id)) return;
    try { await deleteExpense(id); } catch (err) { toast.error(err); }
    pendingDel.delete(id);
    if (alive) load({ full: true });
  }

  async function duplicate(x, spent_on = t0) {
    try {
      const created = await createExpense({ amount: x.amount, description: x.description, category_id: x.category_id, payment_method: x.payment_method, note: x.note, spent_on });
      announceCreated(created);
      if (alive) load({ full: true });
    } catch (err) { toast.error(err); }
  }

  function exportCsv() {
    const r = range();
    const list = filtered().slice().sort((a, b) => a.spent_on.localeCompare(b.spent_on) || (a.created_at || '').localeCompare(b.created_at || ''));
    if (!list.length) { toast.info('Không có khoản chi nào để xuất.'); return; }
    const csv = toCSV(list, [
      { label: 'Ngày', key: 'spent_on' },
      { label: 'Mô tả', value: (x) => x.description || '' },
      { label: 'Danh mục', value: (x) => catName(x.category_id) },
      { label: `Số tiền (${currency()})`, value: (x) => Number(x.amount) },
      { label: 'Phương thức', value: (x) => PAYMENT_METHODS[x.payment_method] || x.payment_method },
      { label: 'Ghi chú', value: (x) => x.note || '' },
    ]);
    downloadText(`chi-tieu_${r.from}_${r.to}.csv`, csv);
    toast(`Đã xuất ${num(list.length)} khoản chi.`);
  }

  function setCatFilter(id) {
    f.cat = f.cat === id ? '' : id;
    root.querySelector('[data-f="cat"]').value = f.cat;
    persist();
    listLimit = LIST_STEP;
    renderCats();
    renderList();
    $('[data-list]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ================= entry sheet (phone-first form) ================= */
  function recentCatIds() {
    const ranked = rankCategories(learn);
    const ids = cats().map((c) => c.id);
    return [...ranked.filter((id) => ids.includes(id)), ...ids.filter((id) => !ranked.includes(id))];
  }

  function openEntry(x = null, preset = {}) {
    const r = range();
    const dflt = r.from <= t0 && t0 <= r.to ? t0 : r.to < t0 ? r.to : t0;
    const curDay = x?.spent_on || preset.spent_on || dflt;
    const curCat = x ? x.category_id || '' : preset.category_id || '';
    const curPm = x?.payment_method || preset.payment_method || lastPm();
    const ids = recentCatIds();
    const quickDays = [[t0, 'Hôm nay'], [addDays(t0, -1), 'Hôm qua'], [addDays(t0, -2), 'Hôm kia']];
    let manualCat = Boolean(x?.category_id || preset.category_id);
    openModal({
      eyebrow: x ? 'Sửa khoản chi' : 'Khoản chi mới',
      title: x ? x.description || 'Khoản chi' : 'Ghi một khoản chi',
      size: 'narrow',
      body: html`<div class="xp-entry">
        <div class="field xp-entry__amount">
          <label class="sr-only" for="xp-amt">Số tiền</label>
          <div class="xp-entry__amt-wrap">
            <input id="xp-amt" class="xp-entry__amt num" name="amount" value="${x ? String(Math.round(x.amount)) : preset.amount ? String(preset.amount) : ''}" inputmode="decimal" enterkeyhint="next" autocomplete="off" placeholder="0" />
            <span class="xp-entry__cur">${currency()}</span>
          </div>
          <span class="field__hint xp-entry__hint" data-hint>Gõ 45k, 1tr2 hoặc 120.000</span>
          <span class="field__error" role="alert"></span>
        </div>
        <div class="xp-chips xp-chips--amt" aria-label="Số tiền nhanh">
          <button type="button" class="xp-chip-btn" data-amt="000">+000</button>
          ${[20000, 50000, 100000, 200000, 500000].map((v) => html`<button type="button" class="xp-chip-btn" data-amt="${v}">${moneyShort(v)}</button>`)}
        </div>
        ${field({ label: 'Mô tả', name: 'description', optional: true, control: input('description', x?.description ?? preset.description ?? '', 'maxlength="200" placeholder="Ví dụ: cà phê, grab, ăn trưa…" enterkeyhint="done"') })}
        <div class="xp-entry__sect"><span class="eyebrow">Danh mục</span><span class="xp-entry__sugg" data-sugg></span></div>
        <div class="xp-chips xp-chips--scroll" role="radiogroup" aria-label="Danh mục">
          ${ids.map((id) => { const c = store.categoryById(id); return html`<label class="xp-chip" style="--c:${c?.color || 'var(--ink-4)'}"><input type="radio" name="category_id" value="${id}" ${id === curCat ? raw('checked') : ''} /><span><i></i>${c?.name}</span></label>`; })}
          <label class="xp-chip"><input type="radio" name="category_id" value="" ${!curCat ? raw('checked') : ''} /><span><i></i>Chưa phân loại</span></label>
        </div>
        <div class="xp-entry__sect"><span class="eyebrow">Ngày chi</span></div>
        <div class="xp-chips">
          ${quickDays.map(([d, l]) => html`<label class="xp-chip"><input type="radio" name="day_pick" value="${d}" ${d === curDay ? raw('checked') : ''} /><span>${l}</span></label>`)}
          <div class="field xp-entry__date"><input class="input input--sm" type="date" name="spent_on" value="${curDay}" max="${addDays(t0, 366)}" aria-label="Ngày chi" required /><span class="field__error" role="alert"></span></div>
        </div>
        <div class="xp-entry__sect"><span class="eyebrow">Thanh toán</span></div>
        <div class="xp-chips" role="radiogroup" aria-label="Phương thức thanh toán">
          ${Object.entries(PAYMENT_METHODS).map(([v, l]) => html`<label class="xp-chip"><input type="radio" name="payment_method" value="${v}" ${v === curPm ? raw('checked') : ''} /><span>${icon(PM_ICON[v] || 'wallet')}${l}</span></label>`)}
        </div>
        <details class="xp-entry__more" ${x?.note ? raw('open') : ''}><summary>${icon('note')} Ghi chú</summary>
          ${field({ label: 'Ghi chú', name: 'note', optional: true, control: textarea('note', x?.note ?? '', 'rows="2" maxlength="1000"') })}
        </details>
      </div>`,
      submitLabel: x ? 'Lưu thay đổi' : 'Ghi khoản chi',
      footExtra: x ? html`<button type="button" class="btn btn--danger-ghost btn--sm" data-del data-close>${icon('trash')} Xóa</button>` : '',
      onOpen(el) {
        const amt = el.querySelector('[name=amount]');
        const desc = el.querySelector('[name=description]');
        const hint = el.querySelector('[data-hint]');
        const submit = el.querySelector('[data-submit]');
        const dateInp = el.querySelector('[name=spent_on]');
        const suggBox = el.querySelector('[data-sugg]');
        const upd = () => {
          const n = parseMoney(amt.value);
          const ok = amt.value && Number.isFinite(n) && n > 0;
          hint.textContent = ok ? `= ${money(n)}` : 'Gõ 45k, 1tr2 hoặc 120.000';
          submit.textContent = ok ? `${x ? 'Lưu' : 'Ghi'} ${money(n)}` : x ? 'Lưu thay đổi' : 'Ghi khoản chi';
        };
        const pickCat = (id, smart) => {
          const radio = el.querySelector(`[name=category_id][value="${CSS.escape(id || '')}"]`);
          if (radio) radio.checked = true;
          suggBox.innerHTML = smart && id ? String(html`${icon('sparkle')} gợi ý: ${catName(id)}`) : '';
        };
        const suggest = debounce(() => {
          if (manualCat || !alive) return;
          const s = suggestLocal(desc.value, { history: learn, categories: cats() });
          if (s[0]) pickCat(s[0].category_id, true);
          else if (desc.value.trim().length >= 2) suggestRemote(desc.value).then((res) => { if (!manualCat && res[0] && el.isConnected) pickCat(res[0].category_id, true); }).catch(() => {});
        }, 220);
        amt.addEventListener('input', upd);
        desc.addEventListener('input', suggest);
        // "cafe 45k hôm qua" typed into the description → split it into the fields.
        desc.addEventListener('blur', () => {
          if (!desc.value.trim()) return;
          const p = parseExpenseEntry(desc.value, { today: t0, categories: cats() });
          if (!(p.amount > 0) || (amt.value && parseMoney(amt.value) > 0)) return;
          amt.value = String(p.amount); desc.value = p.description;
          dateInp.value = p.spent_on; syncDay();
          if (p.payment_method) { const pm = el.querySelector(`[name=payment_method][value="${p.payment_method}"]`); if (pm) pm.checked = true; }
          if (p.category_id) { manualCat = true; pickCat(p.category_id, false); }
          upd();
        });
        el.querySelectorAll('[name=category_id]').forEach((rd) => rd.addEventListener('change', () => { manualCat = true; suggBox.innerHTML = ''; }));
        el.querySelectorAll('[data-amt]').forEach((b) => b.addEventListener('click', () => {
          const v = b.dataset.amt;
          if (v === '000') amt.value = (amt.value.replace(/\s/g, '') || '1') + '000';
          else amt.value = v;
          upd(); amt.focus();
        }));
        const syncDay = () => el.querySelectorAll('[name=day_pick]').forEach((rd) => { rd.checked = rd.value === dateInp.value; });
        el.querySelectorAll('[name=day_pick]').forEach((rd) => rd.addEventListener('change', () => { dateInp.value = rd.value; }));
        dateInp.addEventListener('change', syncDay);
        el.querySelector('[data-del]')?.addEventListener('click', () => removeWithUndo(x));
        upd();
        amt.focus();
        if (!x && preset.description) suggest();
      },
      validate(v) {
        const e = {};
        const n = parseMoney(v.amount);
        if (!Number.isFinite(n) || n <= 0) e.amount = 'Nhập số tiền lớn hơn 0.';
        if (!v.spent_on) e.spent_on = 'Chọn ngày.';
        return e;
      },
      async onSubmit(v) {
        const payload = { amount: parseMoney(v.amount), spent_on: v.spent_on, description: v.description || null, category_id: v.category_id || null, payment_method: v.payment_method || 'cash', note: v.note || null };
        writePm(payload.payment_method);
        if (x) { await updateExpense(x.id, payload); toast('Đã lưu khoản chi.'); }
        else announceCreated(await createExpense(payload));
        if (alive) load({ full: true });
      },
    });
  }

  /* ================= budget form ================= */
  function openBudgetForm() {
    const bm = budgetMonth(range());
    const { overall, byCategory } = resolveBudgets(budgets, bm);
    const spentBy = new Map();
    live().filter((x) => inRange(x, bm, endOfMonth(bm))).forEach((x) => spentBy.set(x.category_id, (spentBy.get(x.category_id) || 0) + Number(x.amount)));
    openModal({
      eyebrow: `Ngân sách từ ${monthLabel(bm)}`,
      title: 'Đặt ngân sách',
      size: 'wide',
      body: html`
        <div class="notice" style="margin-bottom:var(--s-5)">${icon('info')}<div>Ngân sách <strong>áp dụng từ tháng này trở đi</strong> cho đến khi bạn thay đổi — các tháng trước giữ nguyên. Để trống hoặc 0 = không đặt.</div></div>
        <div class="form">
          ${field({ label: 'Ngân sách tổng cho cả tháng', name: 'overall', hint: ' ', control: html`<div class="input-group"><input id="__ID__" class="input has-suffix num" name="overall" value="${overall ? String(Math.round(overall)) : ''}" inputmode="decimal" autocomplete="off" placeholder="Ví dụ: 8tr" /><span class="input-group__suffix">${currency()}</span></div>` })}
          <div class="budget-grid">
            ${cats().map((c) => html`
              <div class="budget-grid__row">
                ${catLabel(c.id)}
                <span class="faint num" style="font-size:var(--fs-xs)">đã chi ${moneyShort(spentBy.get(c.id) || 0)}</span>
                <input class="input input--sm num" name="cat_${c.id}" value="${byCategory.get(c.id) ? String(Math.round(byCategory.get(c.id))) : ''}" inputmode="decimal" placeholder="—" aria-label="Ngân sách ${c.name}" />
              </div>`)}
          </div>
        </div>`,
      submitLabel: 'Lưu ngân sách',
      onOpen(el) {
        const inp = el.querySelector('[name=overall]');
        const hint = inp.closest('.field').querySelector('.field__hint');
        const upd = () => { const n = parseMoney(inp.value); hint.textContent = inp.value && Number.isFinite(n) ? `= ${money(n)}` : 'Gõ “k” cho nghìn, “tr” cho triệu'; };
        inp.addEventListener('input', upd); upd();
      },
      validate(v) {
        const e = {};
        for (const [k, val] of Object.entries(v)) if (val && !(parseMoney(val) >= 0)) e[k] = 'Số tiền không hợp lệ.';
        return e;
      },
      async onSubmit(v) {
        const jobs = [];
        const want = (val) => (val ? parseMoney(val) : 0);
        if (want(v.overall) !== (overall ?? 0)) jobs.push(setBudget({ month: bm, categoryId: null, amount: want(v.overall) }));
        for (const c of cats()) {
          const n = want(v[`cat_${c.id}`]);
          if (n !== (byCategory.get(c.id) ?? 0)) jobs.push(setBudget({ month: bm, categoryId: c.id, amount: n }));
        }
        if (!jobs.length) return;
        await Promise.all(jobs);
        toast(`Đã cập nhật ${jobs.length} ngân sách.`);
        if (alive) load();
      },
    });
  }

  /* ================= data ================= */
  function renderData() {
    killCharts();
    renderStats();
    renderRhythm();
    renderCats();
    renderCumulative();
    renderWeekday();
    renderPayment();
    renderBudget();
    renderList();
  }

  async function load({ full = false } = {}) {
    const my = ++token;
    const r = range();
    const pr = prevRange(r);
    const bm = budgetMonth(r);
    let from = r.from, to = r.to;
    if (period !== 'year') from = minDay(from, pr.from);
    if (period === 'day' || period === 'week' || (period === 'custom' && lenOf(r) < 28)) from = minDay(from, addDays(minDay(r.to, t0), -55));
    if (period === 'day') from = minDay(from, addDays(date, -13));
    from = minDay(from, bm);
    to = maxDay(to, endOfMonth(bm));
    const cmpTo = compareTo(r, pr);
    const yearPrev = period === 'year'
      ? summary(pr.from, cmpTo).then((s) => s.total).catch(() => listExpenses({ from: pr.from, to: cmpTo }).then(sum))
      : Promise.resolve(null);
    statusErr = null;
    const st = budgetStatus(bm).then((x) => x, (err) => { statusErr = err; return null; });
    const extra = full || !loaded
      ? [
          listRecent({ days: 180, limit: 600 }).catch(() => learn),
          fetchAnomalies(60).catch((err) => (err instanceof Error ? err : new Error(String(err)))),
        ]
      : [Promise.resolve(learn), Promise.resolve(anomalies)];
    try {
      const [rws, bgs, yp, s, lr, an] = await Promise.all([listExpenses({ from, to, limit: 5000 }), listBudgets(), yearPrev, st, ...extra]);
      if (my !== token || !alive) return;
      rows = rws; budgets = bgs; prevYearTotal = yp; statusRows = s; learn = lr; anomalies = an;
      loaded = true;
      renderData();
      renderAnomalies();
      if (!$('[data-quick-input]').value) renderQuickPreview();
    } catch (err) {
      if (my !== token || !alive) return;
      killCharts();
      mount($('[data-stats]'), html`<div style="grid-column:1/-1">${errorState(err)}</div>`);
      mount($('[data-list]'), html`<div class="sheet__body">${errorState(err)}</div>`);
    }
  }

  /* ================= events ================= */
  disposers.push(on(root, 'click', '[data-period]', (e, el) => {
    const p = el.dataset.period;
    if (!PERIODS[p] || p === period) return;
    if (p === 'custom') { const r = range(); custom = period === 'day' ? { from: addDays(date, -29), to: date } : { from: r.from, to: minDay(r.to, maxDay(t0, r.from)) }; }
    goTo({ period: p });
  }));
  disposers.push(on(root, 'change', '[data-cf]', (e, el) => {
    if (!isDay(el.value)) return;
    custom[el.dataset.cf] = el.value;
    if (custom.from > custom.to) custom = { from: custom.to, to: custom.from };
    if (lenOf(custom) > 3660) custom.from = addDays(custom.to, -3659);
    goTo({});
  }));
  disposers.push(on(root, 'click', '[data-example]', (e, el) => {
    const inp = $('[data-quick-input]');
    inp.value = el.dataset.example; inp.focus(); updateQuick();
  }));
  disposers.push(on(root, 'click', '[data-qcat]', (e, el) => { q.catId = el.dataset.qcat; q.manual = true; q.source = null; renderQuickPreview(); $('[data-quick-input]').focus(); }));
  disposers.push(on(root, 'click', '[data-fcat]', (e, el) => setCatFilter(el.dataset.fcat)));
  disposers.push(on(root, 'click', '[data-fpm]', (e, el) => {
    f.pm = f.pm === el.dataset.fpm ? '' : el.dataset.fpm;
    root.querySelector('[data-f="pm"]').value = f.pm;
    persist(); listLimit = LIST_STEP; renderPayment(); renderList();
    $('[data-list]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  disposers.push(on(root, 'click', '[data-goto]', (e, el) => goTo({ period: 'day', date: el.dataset.goto, focus: el.dataset.eid })));
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'new') return openEntry();
    if (a === 'budget') return openBudgetForm();
    if (a === 'retry') return load({ full: true });
    if (a === 'csv') return exportCsv();
    if (a === 'repeat-last') return repeatLast();
    if (a === 'more') { listLimit += LIST_STEP; return renderList(); }
    if (a === 'prev' || a === 'next') { shift(a === 'prev' ? -1 : 1); return goTo({}); }
    if (a === 'today') {
      if (period === 'custom') { const n = lenOf(custom); custom = { from: addDays(t0, -(n - 1)), to: t0 }; return goTo({}); }
      return goTo({ date: t0 });
    }
    if (a === 'clear-cat') return setCatFilter(f.cat);
    if (a === 'clear') {
      Object.assign(f, { q: '', cat: '', pm: '' });
      root.querySelectorAll('[data-f]').forEach((i) => (i.value = ''));
      persist(); renderCats(); renderPayment(); return renderList();
    }
    if (a === 'quick-cat') {
      const opts = recentCatIds().map((id) => ({ label: catName(id), icon: id === q.catId ? 'check' : 'tag', onClick: () => { q.catId = id; q.manual = true; q.source = null; renderQuickPreview(); $('[data-quick-input]').focus(); } }));
      return popMenu(el, [...opts, 'sep', { label: 'Chưa phân loại', icon: 'x', onClick: () => { q.catId = null; q.manual = true; q.source = null; renderQuickPreview(); } }]);
    }
    if (a === 'inline-cancel') { editingId = null; return renderList(); }
    const x = rows.find((r) => r.id === el.closest('[data-id]')?.dataset.id);
    if (!x) return;
    if (a === 'edit') { editingId = x.id; return renderList(); }
    if (a === 'inline-more') { editingId = null; renderList(); return openEntry(x); }
    if (a === 'inline-del') return removeWithUndo(x);
    if (a === 'menu') {
      popMenu(el, [
        { label: 'Sửa nhanh', icon: 'edit', onClick: () => { editingId = x.id; renderList(); } },
        { label: 'Sửa chi tiết…', icon: 'note', onClick: () => openEntry(x) },
        { label: 'Nhân bản cho hôm nay', icon: 'refresh', onClick: () => duplicate(x, t0) },
        ...(x.spent_on !== t0 ? [{ label: `Nhân bản cho ${relDay(x.spent_on).toLowerCase()}`, icon: 'calendar', onClick: () => duplicate(x, x.spent_on) }] : []),
        'sep',
        { label: 'Xóa', icon: 'trash', danger: true, onClick: () => removeWithUndo(x) },
      ]);
    }
  }));
  disposers.push(on(root, 'submit', '[data-inline]', (e, el) => { e.preventDefault(); saveInline(el); }));
  disposers.push(on(root, 'keydown', '[data-inline]', (e) => { if (e.key === 'Escape') { e.preventDefault(); editingId = null; renderList(); } }));
  disposers.push(on(root, 'submit', '[data-quick-form]', (e) => { e.preventDefault(); saveQuick(); }));
  disposers.push(on(root, 'input', '[data-quick-input]', () => updateQuick()));
  disposers.push(on(root, 'keydown', '[data-quick-input]', (e, el) => { if (e.key === 'Escape' && el.value) { el.value = ''; updateQuick(); } }));
  const onSearch = debounce(() => { if (!alive) return; persist(); listLimit = LIST_STEP; renderList(); }, 160);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', 'select[data-f]', (e, el) => { f[el.dataset.f] = el.value; persist(); listLimit = LIST_STEP; renderCats(); renderPayment(); renderList(); }));
  disposers.push(onDataChanged(() => { if (alive) load({ full: true }); }));
  function persist() { setQuery({ q: f.q || null, cat: f.cat || null, pm: f.pm || null }); }

  // "/" focuses the quick-entry bar (when not typing elsewhere).
  const onKey = (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable], dialog')) return;
    const inp = $('[data-quick-input]');
    if (inp && inp.offsetParent) { e.preventDefault(); inp.focus(); }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  renderPeriodBar();
  renderQuickPreview();
  if (query.m) syncQuery();
  await load({ full: true });
  if (query.new) { setQuery({ new: null }); openEntry(); }

  return () => {
    alive = false;
    disposers.forEach((d) => d());
    killCharts();
    // Deletes still waiting for "Hoàn tác" are committed when leaving the page.
    for (const [id, p] of pendingDel) { clearTimeout(p.timer); deleteExpense(id).catch(() => {}); }
    pendingDel.clear();
  };
}
