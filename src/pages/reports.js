import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel, bar } from '../components/ui.js';
import { errorState, loadingBlock, statTileSkeleton } from '../components/states.js';
import { makeChart, palette, series } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { listTasks } from '../services/tasks.js';
import { listEntries, entrySeconds } from '../services/timeEntries.js';
import { listExpenses, PAYMENT_METHODS } from '../services/expenses.js';
import { listKpis, listAllRecords, kpiProgress } from '../services/kpis.js';
import { listShopping, SHOP_STATUS } from '../services/shopping.js';
import { toCSV, downloadText } from '../utils/csv.js';
import { today, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, daysBetween, dayOf, dayStartInstant, dayEndInstant, diffDays } from '../utils/date.js';
import { money, moneyShort, minutes, hours, num, pct, dec, day, monthLabel, dateTime } from '../utils/format.js';
import { TASK_STATUS, TASK_PRIORITY } from '../components/ui.js';

const PRESETS = [
  { id: '7d', label: '7 ngày' },
  { id: '30d', label: '30 ngày' },
  { id: 'month', label: 'Tháng này' },
  { id: 'lastmonth', label: 'Tháng trước' },
  { id: '90d', label: '90 ngày' },
  { id: 'year', label: 'Năm nay' },
];

export default async function reportsPage(root, { query }) {
  const t0 = today();
  let preset = PRESETS.some((p) => p.id === query.r) ? query.r : '30d';
  let custom = query.from && query.to ? { from: query.from, to: query.to } : null;
  let data = null;
  let charts = [];
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '08',
      kicker: 'Báo cáo',
      title: 'Nhìn lại để <em>đi tiếp</em>',
      lede: 'Tổng hợp năng suất, thời gian và tài chính theo khoảng thời gian bạn chọn. Xuất CSV để lưu trữ hoặc phân tích thêm.',
      actions: html`<button class="btn" data-act="export" aria-haspopup="menu">${icon('download')} Xuất dữ liệu</button>`,
    })}
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Khoảng thời gian">${PRESETS.map((p) => html`<button type="button" data-preset="${p.id}" aria-pressed="${!custom && p.id === preset}">${p.label}</button>`)}</div>
      <div class="row" style="gap:6px">
        <input class="input input--sm" type="date" data-from aria-label="Từ ngày" />
        <span class="faint">→</span>
        <input class="input input--sm" type="date" data-to aria-label="Đến ngày" max="${t0}" />
        <button class="btn btn--sm" data-act="apply">Áp dụng</button>
      </div>
    </div>
    <p class="report-range" data-range></p>
    <section class="grid grid-4" data-kpis>${statTileSkeleton(4)}</section>

    <h2 class="section-title"><span class="eyebrow">Phần I</span>Năng suất</h2>
    <section class="grid grid-12">
      <article class="sheet span-8" data-c-tasks>${sheetHead('R.1', 'Công việc tạo mới & hoàn thành')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet span-4" data-c-taskcat>${sheetHead('R.2', 'Hoàn thành theo danh mục')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet span-8" data-c-hours>${sheetHead('R.3', 'Giờ làm theo ngày')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-4" data-c-weekday>${sheetHead('R.4', 'Nhịp trong tuần')}<div class="sheet__body">${loadingBlock(240)}</div></article>
    </section>

    <h2 class="section-title"><span class="eyebrow">Phần II</span>Tài chính</h2>
    <section class="grid grid-12">
      <article class="sheet span-7" data-c-months>${sheetHead('R.5', 'Chi tiêu 12 tháng gần nhất')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet span-5" data-c-pay>${sheetHead('R.6', 'Phương thức thanh toán')}<div class="sheet__body">${loadingBlock(260)}</div></article>
      <article class="sheet span-12" data-t-cats>${sheetHead('R.7', 'Chi tiêu theo danh mục')}<div class="sheet__body">${loadingBlock(200)}</div></article>
    </section>

    <h2 class="section-title"><span class="eyebrow">Phần III</span>Mục tiêu</h2>
    <article class="sheet" data-t-kpi>${sheetHead('R.8', 'Tiến độ KPI')}<div class="sheet__body">${loadingBlock(160)}</div></article>`);

  const $ = (s) => root.querySelector(s);

  function range() {
    if (custom) return [custom.from, custom.to];
    switch (preset) {
      case '7d': return [addDays(t0, -6), t0];
      case 'month': return [startOfMonth(t0), t0];
      case 'lastmonth': { const s = addMonths(startOfMonth(t0), -1); return [s, endOfMonth(s)]; }
      case '90d': return [addDays(t0, -89), t0];
      case 'year': return [t0.slice(0, 4) + '-01-01', t0];
      default: return [addDays(t0, -29), t0];
    }
  }

  async function load() {
    const [from, to] = range();
    $('[data-from]').value = from;
    $('[data-to]').value = to;
    const len = diffDays(to, from) + 1;
    const pFrom = addDays(from, -len), pTo = addDays(from, -1);
    $('[data-range]').textContent = `${day(from, 'long')} — ${day(to, 'long')} · ${len} ngày (so sánh với ${len} ngày liền trước)`;
    const yStart = addMonths(startOfMonth(t0), -11);
    try {
      const [tasks, entries, prevEntries, expenses12, kpis, records] = await Promise.all([
        listTasks({ limit: 1000 }),
        listEntries(dayStartInstant(from).toISOString(), dayEndInstant(to).toISOString()),
        listEntries(dayStartInstant(pFrom).toISOString(), dayEndInstant(pTo).toISOString()),
        listExpenses({ from: [yStart, pFrom].sort()[0], to: t0 > to ? t0 : to }),
        listKpis(),
        listAllRecords(),
      ]);
      const inR = (d) => d >= from && d <= to;
      const inP = (d) => d >= pFrom && d <= pTo;
      data = {
        from, to, len, yStart, tasks, entries, prevEntries, kpis, records,
        expenses: expenses12.filter((x) => inR(x.spent_on)),
        prevExpenses: expenses12.filter((x) => inP(x.spent_on)),
        expenses12: expenses12.filter((x) => x.spent_on >= yStart),
        created: tasks.filter((t) => inR(dayOf(t.created_at))),
        completed: tasks.filter((t) => t.completed_at && inR(dayOf(t.completed_at))),
        prevCompleted: tasks.filter((t) => t.completed_at && inP(dayOf(t.completed_at))),
      };
      renderAll();
    } catch (err) {
      mount($('[data-kpis]'), html`<div style="grid-column:1/-1">${errorState(err)}</div>`);
    }
  }

  const delta = (cur, prev, invert = false) => {
    if (!prev) return html`<span>kỳ trước: 0</span>`;
    const d = ((cur - prev) / prev) * 100;
    const good = invert ? d <= 0 : d >= 0;
    return html`<span class="delta ${good ? 'delta--up' : 'delta--down'}">${d > 0 ? '+' : ''}${pct(d)}</span><span>so với kỳ trước</span>`;
  };

  function renderAll() {
    charts.forEach((d) => d());
    charts = [];
    const d = data;
    const secs = d.entries.reduce((s, e) => s + entrySeconds(e), 0);
    const prevSecs = d.prevEntries.reduce((s, e) => s + entrySeconds(e), 0);
    const spent = d.expenses.reduce((s, x) => s + Number(x.amount), 0);
    const prevSpent = d.prevExpenses.reduce((s, x) => s + Number(x.amount), 0);
    const rate = d.created.length ? (d.created.filter((t) => t.status === 'completed').length / d.created.length) * 100 : null;

    mount($('[data-kpis]'), html`
      <div class="stat stat--accent"><div class="stat__label"><span class="eyebrow">Việc hoàn thành</span><span class="stat__icon">${icon('checkCircle')}</span></div><div class="stat__value">${num(d.completed.length)}</div><div class="stat__meta">${delta(d.completed.length, d.prevCompleted.length)}</div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Tỉ lệ hoàn thành</span><span class="stat__icon">${icon('target')}</span></div><div class="stat__value">${rate == null ? '—' : pct(rate)}</div><div class="stat__meta"><span>${num(d.created.length)} việc được tạo trong kỳ</span></div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Giờ làm</span><span class="stat__icon">${icon('clock')}</span></div><div class="stat__value">${hours(secs / 60)}</div><div class="stat__meta">${delta(secs, prevSecs)}</div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Chi tiêu</span><span class="stat__icon">${icon('wallet')}</span></div><div class="stat__value" style="font-size:var(--fs-2xl)">${money(spent)}</div><div class="stat__meta">${delta(spent, prevSpent, true)}</div></div>`);

    const p = palette();
    const s = series();
    const days = daysBetween(d.from, d.to);
    const weekly = days.length > 45;
    const bucket = (day0) => (weekly ? startOfWeek(day0) : day0);
    const keys = [...new Set(days.map(bucket))];
    const label = (k) => (weekly ? `Tuần ${day(k)}` : day(k).replace(' thg ', '/'));
    const count = (list, get) => { const m = Object.fromEntries(keys.map((k) => [k, 0])); list.forEach((x) => { const k = bucket(get(x)); if (k in m) m[k]++; }); return keys.map((k) => m[k]); };

    // R.1
    mount($('[data-c-tasks]'), html`${sheetHead('R.1', `Công việc tạo mới & hoàn thành${weekly ? ' (theo tuần)' : ''}`, html`<div class="chart-key"><span><i style="background:var(--ink-4)"></i>Tạo mới</span><span><i style="background:var(--moss)"></i>Hoàn thành</span></div>`)}<div class="sheet__body"><div class="chart-box" data-c></div></div>`);
    charts.push(makeChart($('[data-c-tasks] [data-c]'), {
      type: 'bar',
      data: { labels: keys.map(label), datasets: [
        { label: 'Tạo mới', data: count(d.created, (t) => dayOf(t.created_at)), backgroundColor: p.ink4, borderRadius: 2, maxBarThickness: 16 },
        { label: 'Hoàn thành', data: count(d.completed, (t) => dayOf(t.completed_at)), backgroundColor: p.moss, borderRadius: 2, maxBarThickness: 16 },
      ] },
      options: { scales: { y: { ticks: { precision: 0 } } } },
    }));

    // R.2
    const byCat = new Map();
    d.completed.forEach((t) => byCat.set(t.category_id || 'none', (byCat.get(t.category_id || 'none') || 0) + 1));
    const catRows = [...byCat.entries()].map(([id, n]) => ({ id, n, c: store.categoryById(id) })).sort((a, b) => b.n - a.n);
    mount($('[data-c-taskcat]'), html`${sheetHead('R.2', 'Hoàn thành theo danh mục')}<div class="sheet__body">
      ${catRows.length ? html`<div class="chart-box chart-box--sm" data-c></div><div class="legend" style="margin-top:var(--s-4)">${catRows.map((r) => html`<div class="legend__row"><span class="legend__dot" style="--c:${r.c?.color || p.ink4}"></span><span class="truncate">${r.c?.name || 'Chưa phân loại'}</span><span class="legend__val">${r.n}</span><span class="legend__pct">${pct((r.n / d.completed.length) * 100)}</span></div>`)}</div>` : html`<p class="muted">Chưa có việc hoàn thành trong kỳ.</p>`}
    </div>`);
    if (catRows.length) charts.push(makeChart($('[data-c-taskcat] [data-c]'), { type: 'doughnut', data: { labels: catRows.map((r) => r.c?.name || 'Chưa phân loại'), datasets: [{ data: catRows.map((r) => r.n), backgroundColor: catRows.map((r) => r.c?.color || p.ink4), borderColor: p.surface, borderWidth: 2 }] } }));

    // R.3
    const hm = Object.fromEntries(keys.map((k) => [k, 0]));
    d.entries.forEach((e) => { const k = bucket(dayOf(e.started_at)); if (k in hm) hm[k] += entrySeconds(e); });
    const avg = secs / 3600 / days.length;
    mount($('[data-c-hours]'), html`${sheetHead('R.3', `Giờ làm theo ${weekly ? 'tuần' : 'ngày'}`, html`<span class="muted" style="font-size:var(--fs-xs)">TB ${dec(Math.round(avg * 10) / 10)} giờ/ngày</span>`)}<div class="sheet__body"><div class="chart-box" data-c></div></div>`);
    charts.push(makeChart($('[data-c-hours] [data-c]'), {
      type: 'line',
      data: { labels: keys.map(label), datasets: [{ data: keys.map((k) => Math.round((hm[k] / 3600) * 10) / 10), borderColor: p.accent, backgroundColor: p.accent + '1f', fill: true, tension: 0.3, pointRadius: keys.length > 40 ? 0 : 2.5, pointBackgroundColor: p.surface, borderWidth: 2 }] },
      options: { scales: { y: { ticks: { callback: (v) => v + 'g' } } }, plugins: { tooltip: { callbacks: { label: (c) => ` ${c.raw} giờ` } } } },
    }));

    // R.4 weekday rhythm (Mon..Sun in configured order)
    const wd = [0, 0, 0, 0, 0, 0, 0];
    d.entries.forEach((e) => { wd[new Date(dayOf(e.started_at) + 'T12:00:00Z').getUTCDay()] += entrySeconds(e) / 3600; });
    const order = [1, 2, 3, 4, 5, 6, 0];
    const wlabels = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    mount($('[data-c-weekday]'), html`${sheetHead('R.4', 'Nhịp trong tuần')}<div class="sheet__body"><div class="chart-box" data-c></div></div>`);
    const maxWd = Math.max(...wd);
    charts.push(makeChart($('[data-c-weekday] [data-c]'), {
      type: 'bar',
      data: { labels: order.map((i) => wlabels[i]), datasets: [{ data: order.map((i) => Math.round(wd[i] * 10) / 10), backgroundColor: order.map((i) => (wd[i] === maxWd && maxWd > 0 ? p.accent : p.ink)), borderRadius: 3, maxBarThickness: 26 }] },
      options: { scales: { y: { ticks: { callback: (v) => v + 'g' } } }, plugins: { tooltip: { callbacks: { label: (c) => ` ${c.raw} giờ` } } } },
    }));

    // R.5 months
    const months = Array.from({ length: 12 }, (_, i) => addMonths(d.yStart, i).slice(0, 7));
    const mm = Object.fromEntries(months.map((m) => [m, 0]));
    d.expenses12.forEach((x) => { const k = x.spent_on.slice(0, 7); if (k in mm) mm[k] += Number(x.amount); });
    const mAvg = months.reduce((a, m) => a + mm[m], 0) / 12;
    mount($('[data-c-months]'), html`${sheetHead('R.5', 'Chi tiêu 12 tháng gần nhất', html`<span class="muted" style="font-size:var(--fs-xs)">TB ${money(mAvg, { compact: true })}/tháng</span>`)}<div class="sheet__body"><div class="chart-box" data-c></div></div>`);
    charts.push(makeChart($('[data-c-months] [data-c]'), {
      type: 'bar',
      data: { labels: months.map((m) => `T${Number(m.slice(5))}/${m.slice(2, 4)}`), datasets: [
        { type: 'bar', data: months.map((m) => mm[m]), backgroundColor: months.map((m) => (m === t0.slice(0, 7) ? p.accent : p.ink)), borderRadius: 3, maxBarThickness: 28 },
        { type: 'line', data: months.map(() => mAvg), borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      ] },
      options: { scales: { y: { ticks: { callback: (v) => moneyShort(v) } } }, plugins: { tooltip: { callbacks: { title: (c) => monthLabel(months[c[0].dataIndex]), label: (c) => (c.datasetIndex ? ` Trung bình: ${money(c.raw)}` : ` ${money(c.raw)}`) } } } },
    }));

    // R.6 payment methods
    const pm = new Map();
    d.expenses.forEach((x) => pm.set(x.payment_method, (pm.get(x.payment_method) || 0) + Number(x.amount)));
    const pmRows = [...pm.entries()].sort((a, b) => b[1] - a[1]);
    mount($('[data-c-pay]'), html`${sheetHead('R.6', 'Phương thức thanh toán')}<div class="sheet__body">
      ${pmRows.length ? html`<div class="chart-box chart-box--sm" data-c></div><div class="legend" style="margin-top:var(--s-4)">${pmRows.map(([k, v], i) => html`<div class="legend__row"><span class="legend__dot" style="--c:${s[i % s.length]}"></span><span>${PAYMENT_METHODS[k] || k}</span><span class="legend__val">${money(v)}</span><span class="legend__pct">${pct((v / spent) * 100)}</span></div>`)}</div>` : html`<p class="muted">Không có khoản chi trong kỳ.</p>`}
    </div>`);
    if (pmRows.length) charts.push(makeChart($('[data-c-pay] [data-c]'), { type: 'doughnut', data: { labels: pmRows.map(([k]) => PAYMENT_METHODS[k] || k), datasets: [{ data: pmRows.map(([, v]) => v), backgroundColor: pmRows.map((_, i) => s[i % s.length]), borderColor: p.surface, borderWidth: 2 }] }, options: { plugins: { tooltip: { callbacks: { label: (c) => ` ${money(c.raw)}` } } } } }));

    // R.7 categories table
    const ec = new Map(), ecPrev = new Map(), ecN = new Map();
    d.expenses.forEach((x) => { const k = x.category_id || 'none'; ec.set(k, (ec.get(k) || 0) + Number(x.amount)); ecN.set(k, (ecN.get(k) || 0) + 1); });
    d.prevExpenses.forEach((x) => { const k = x.category_id || 'none'; ecPrev.set(k, (ecPrev.get(k) || 0) + Number(x.amount)); });
    const ecRows = [...ec.entries()].sort((a, b) => b[1] - a[1]);
    const maxEc = ecRows[0]?.[1] || 1;
    mount($('[data-t-cats]'), html`${sheetHead('R.7', 'Chi tiêu theo danh mục')}
      ${ecRows.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>Danh mục</th><th class="r">Số khoản</th><th class="r">Tổng</th><th style="width:30%">Tỉ trọng</th><th class="r">Kỳ trước</th><th class="r">Thay đổi</th></tr></thead>
        <tbody>${ecRows.map(([k, v]) => {
          const prev = ecPrev.get(k) || 0;
          const ch = prev ? ((v - prev) / prev) * 100 : null;
          return html`<tr><td>${catLabel(k === 'none' ? null : k)}</td><td class="r num">${ecN.get(k)}</td><td class="r num"><strong>${money(v)}</strong></td><td><div class="row" style="gap:8px">${bar((v / maxEc) * 100, { thin: true, color: store.categoryById(k)?.color })}<span class="num faint" style="font-size:var(--fs-2xs);width:36px">${pct((v / spent) * 100)}</span></div></td><td class="r num muted">${money(prev)}</td><td class="r">${ch == null ? html`<span class="faint">mới</span>` : html`<span class="delta ${ch > 0 ? 'delta--down' : 'delta--up'}">${ch > 0 ? '+' : ''}${pct(ch)}</span>`}</td></tr>`;
        })}</tbody>
        <tfoot><tr><td><strong>Tổng</strong></td><td class="r num">${d.expenses.length}</td><td class="r num"><strong>${money(spent)}</strong></td><td></td><td class="r num muted">${money(prevSpent)}</td><td></td></tr></tfoot>
      </table></div>` : html`<div class="sheet__body muted">Không có khoản chi trong kỳ.</div>`}`);

    // R.8 KPI
    const kpis = d.kpis.filter((k) => k.status !== 'archived');
    mount($('[data-t-kpi]'), html`${sheetHead('R.8', 'Tiến độ KPI')}
      ${kpis.length ? html`<div class="table-wrap"><table class="table">
        <thead><tr><th>KPI</th><th>Trạng thái</th><th class="r">Hiện tại</th><th class="r">Mục tiêu</th><th style="width:26%">Tiến độ</th><th class="r">Cập nhật trong kỳ</th><th class="r">Hạn</th></tr></thead>
        <tbody>${kpis.map((k) => {
          const pr = kpiProgress(k);
          const inRange = d.records.filter((r) => r.kpi_id === k.id && r.recorded_on >= d.from && r.recorded_on <= d.to).length;
          return html`<tr><td><strong>${k.name}</strong></td><td><span class="badge badge--${k.status === 'completed' ? 'success' : k.status === 'paused' ? 'warning' : 'accent'}">${{ active: 'Đang theo đuổi', paused: 'Tạm dừng', completed: 'Đã đạt' }[k.status]}</span></td><td class="r num">${dec(k.current_value)} ${k.unit}</td><td class="r num">${dec(k.target_value)} ${k.unit}</td><td><div class="row" style="gap:8px">${bar(pr, { thin: true, color: pr >= 100 ? 'var(--moss)' : 'var(--accent)' })}<span class="num" style="font-size:var(--fs-xs);width:42px">${pct(pr)}</span></div></td><td class="r num">${inRange}</td><td class="r num muted">${k.end_date ? day(k.end_date, 'medium') : '—'}</td></tr>`;
        })}</tbody></table></div>` : html`<div class="sheet__body muted">Chưa có KPI nào.</div>`}`);
  }

  /* ---------- export ---------- */
  async function exportData(kind) {
    const stamp = t0;
    try {
      const catName = (id) => store.categoryById(id)?.name || '';
      if (kind === 'tasks') {
        const rows = data?.tasks || (await listTasks({ limit: 1000 }));
        downloadText(`cong-viec_${stamp}.csv`, toCSV(rows, [
          { label: 'Tiêu đề', key: 'title' }, { label: 'Mô tả', key: 'description' },
          { label: 'Trạng thái', value: (r) => TASK_STATUS[r.status]?.label }, { label: 'Ưu tiên', value: (r) => TASK_PRIORITY[r.priority] },
          { label: 'Danh mục', value: (r) => catName(r.category_id) }, { label: 'Thẻ', key: 'tags' },
          { label: 'Hạn chót', key: 'due_date' }, { label: 'Ước tính (phút)', key: 'estimated_minutes' }, { label: 'Thực tế (phút)', key: 'actual_minutes' },
          { label: 'Hoàn thành lúc', value: (r) => (r.completed_at ? dateTime(r.completed_at) : '') }, { label: 'Tạo lúc', value: (r) => dateTime(r.created_at) },
        ]));
      }
      if (kind === 'time') {
        const [from, to] = range();
        const rows = await listEntries(dayStartInstant(from).toISOString(), dayEndInstant(to).toISOString());
        const title = (id) => data?.tasks.find((t) => t.id === id)?.title || '';
        downloadText(`thoi-gian_${from}_${to}.csv`, toCSV(rows, [
          { label: 'Ngày', value: (r) => dayOf(r.started_at) }, { label: 'Bắt đầu', value: (r) => dateTime(r.started_at) }, { label: 'Kết thúc', value: (r) => (r.ended_at ? dateTime(r.ended_at) : 'đang chạy') },
          { label: 'Số phút', value: (r) => Math.round(entrySeconds(r) / 60) }, { label: 'Công việc', value: (r) => title(r.task_id) }, { label: 'Ghi chú', key: 'description' }, { label: 'Nguồn', value: (r) => (r.source === 'manual' ? 'Thủ công' : 'Bấm giờ') },
        ]));
      }
      if (kind === 'expenses') {
        const [from, to] = range();
        const rows = await listExpenses({ from, to });
        downloadText(`chi-tieu_${from}_${to}.csv`, toCSV(rows, [
          { label: 'Ngày', key: 'spent_on' }, { label: 'Số tiền', key: 'amount' }, { label: 'Danh mục', value: (r) => catName(r.category_id) },
          { label: 'Mô tả', key: 'description' }, { label: 'Thanh toán', value: (r) => PAYMENT_METHODS[r.payment_method] }, { label: 'Ghi chú', key: 'note' },
        ]));
      }
      if (kind === 'shopping') {
        const rows = await listShopping();
        downloadText(`mua-sam_${stamp}.csv`, toCSV(rows, [
          { label: 'Tên', key: 'name' }, { label: 'Trạng thái', value: (r) => SHOP_STATUS[r.status] }, { label: 'Đơn giá', key: 'unit_price' }, { label: 'Số lượng', key: 'quantity' },
          { label: 'Thành tiền', key: 'total_price' }, { label: 'Danh mục', value: (r) => catName(r.category_id) }, { label: 'Ngày mua', key: 'purchased_on' }, { label: 'Liên kết', key: 'url' }, { label: 'Ghi chú', key: 'note' },
        ]));
      }
      if (kind === 'kpi') {
        const [kpis, recs] = data ? [data.kpis, data.records] : await Promise.all([listKpis(), listAllRecords()]);
        const name = (id) => kpis.find((k) => k.id === id)?.name || '';
        const unit = (id) => kpis.find((k) => k.id === id)?.unit || '';
        downloadText(`kpi_${stamp}.csv`, toCSV(recs, [
          { label: 'KPI', value: (r) => name(r.kpi_id) }, { label: 'Ngày', key: 'recorded_on' }, { label: 'Giá trị', key: 'value' }, { label: 'Đơn vị', value: (r) => unit(r.kpi_id) }, { label: 'Ghi chú', key: 'note' },
        ]));
      }
      toast('Đã tải tệp CSV.');
    } catch (err) {
      toast.error(err);
    }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'retry') load();
    if (a === 'apply') {
      const from = $('[data-from]').value, to = $('[data-to]').value;
      if (!from || !to || from > to) return toast.error('Khoảng ngày không hợp lệ.');
      if (diffDays(to, from) > 730) return toast.error('Chọn tối đa 2 năm.');
      custom = { from, to };
      root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      setQuery({ r: null, from, to });
      load();
    }
    if (a === 'export') {
      const { popMenu } = await import('../components/ui.js');
      const [from, to] = range();
      popMenu(el, [
        { label: 'Công việc (tất cả)', icon: 'tasks', onClick: () => exportData('tasks') },
        { label: `Thời gian (${day(from)} – ${day(to)})`, icon: 'clock', onClick: () => exportData('time') },
        { label: `Chi tiêu (${day(from)} – ${day(to)})`, icon: 'wallet', onClick: () => exportData('expenses') },
        { label: 'Mua sắm (tất cả)', icon: 'cart', onClick: () => exportData('shopping') },
        { label: 'Lịch sử KPI', icon: 'target', onClick: () => exportData('kpi') },
      ]);
    }
  }));
  disposers.push(on(root, 'click', '[data-preset]', (e, el) => {
    preset = el.dataset.preset;
    custom = null;
    root.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
    setQuery({ r: preset === '30d' ? null : preset, from: null, to: null });
    load();
  }));

  await load();
  return () => { disposers.forEach((d) => d()); charts.forEach((d) => d()); };
}
