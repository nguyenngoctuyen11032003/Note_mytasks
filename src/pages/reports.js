// Báo cáo — periodic review with comparison, narrative summary, CSV per
// section and a print / PDF layout (see css/pages/reports.css @media print).
import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, bar, popMenu } from '../components/ui.js';
import { errorState, loadingBlock, statTileSkeleton, emptyState } from '../components/states.js';
import { makeChart, palette, series } from '../components/chart.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { productivityReport, financeReport, kpiReport, notesReport } from '../services/reports.js';
import { PAYMENT_METHODS } from '../services/expenses.js';
import { toCSV, downloadText } from '../utils/csv.js';
import { today, addDays, addMonths, startOfMonth, endOfMonth, startOfWeek, daysBetween, diffDays, weekday, getWeekStart } from '../utils/date.js';
import { money, moneyShort, minutes as fmtMinutes, hours, num, pct, dec, day, monthLabel, dateTime } from '../utils/format.js';

const KINDS = [
  { id: 'week', label: 'Tuần' },
  { id: 'month', label: 'Tháng' },
  { id: 'quarter', label: 'Quý' },
  { id: 'year', label: 'Năm' },
  { id: 'custom', label: 'Tùy chọn' },
];
const WEEKDAY_LONG = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const WEEKDAY_SHORT = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const FORECAST = {
  achieved: { label: 'Đã đạt', badge: 'success' },
  on_track: { label: 'Đúng tiến độ', badge: 'success' },
  at_risk: { label: 'Có rủi ro', badge: 'warning' },
  off_track: { label: 'Chậm tiến độ', badge: 'danger' },
  no_data: { label: 'Chưa đủ dữ liệu', badge: 'muted' },
};
const KPI_STATUS = { active: 'Đang theo đuổi', paused: 'Tạm dừng', completed: 'Đã hoàn thành' };
const MAX_DAYS = 731;

const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
const dmy = (d) => `${dm(d)}/${d.slice(0, 4)}`;
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const sum = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const catName = (n) => n || 'Chưa phân loại';

/* ------------------------------------------------------------------ */
/* Period maths                                                        */
/* ------------------------------------------------------------------ */

function periodOf(kind, anchor, custom) {
  let from, to;
  if (kind === 'week') { from = startOfWeek(anchor); to = addDays(from, 6); }
  else if (kind === 'month') { from = startOfMonth(anchor); to = endOfMonth(anchor); }
  else if (kind === 'quarter') {
    const m = Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) * 3 + 1;
    from = `${anchor.slice(0, 4)}-${String(m).padStart(2, '0')}-01`;
    to = endOfMonth(addMonths(from, 2));
  } else if (kind === 'year') { from = `${anchor.slice(0, 4)}-01-01`; to = `${anchor.slice(0, 4)}-12-31`; }
  else { from = custom.from; to = custom.to; }

  const t0 = today();
  const fullLen = diffDays(to, from) + 1;
  const partial = from <= t0 && to > t0;
  const effTo = partial ? t0 : to;
  const len = diffDays(effTo, from) + 1;
  const prevStart = kind === 'week' ? addDays(from, -7)
    : kind === 'month' ? addMonths(from, -1)
    : kind === 'quarter' ? addMonths(from, -3)
    : kind === 'year' ? addMonths(from, -12)
    : addDays(from, -fullLen);
  // Like-for-like: an in-progress period is compared with the same number of
  // elapsed days at the start of the previous one.
  let prevTo = addDays(prevStart, len - 1);
  if (prevTo >= from) prevTo = addDays(from, -1);

  let title;
  const q = Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1;
  if (kind === 'week') title = `Tuần ${dm(from)} – ${dmy(to)}`;
  else if (kind === 'month') title = monthLabel(from);
  else if (kind === 'quarter') title = `Quý ${q} năm ${from.slice(0, 4)}`;
  else if (kind === 'year') title = `Năm ${from.slice(0, 4)}`;
  else title = `${dmy(from)} – ${dmy(to)}`;
  const noun = { week: 'tuần', month: 'tháng', quarter: 'quý', year: 'năm' }[kind] || 'kỳ';

  return { kind, from, to: effTo, fullTo: to, len, partial, future: from > t0, prevFrom: prevStart, prevTo, title, noun };
}

function shiftAnchor(kind, anchor, dir, custom) {
  if (kind === 'week') return addDays(anchor, 7 * dir);
  if (kind === 'month') return addMonths(anchor, dir);
  if (kind === 'quarter') return addMonths(anchor, 3 * dir);
  if (kind === 'year') return addMonths(anchor, 12 * dir);
  const len = diffDays(custom.to, custom.from) + 1;
  return { from: addDays(custom.from, len * dir), to: addDays(custom.to, len * dir) };
}

const modeFor = (len) => (len <= 62 ? 'day' : len <= 190 ? 'week' : 'month');
const keyFn = (mode) => (d) => (mode === 'day' ? d : mode === 'week' ? startOfWeek(d) : d.slice(0, 7));

/** points [{day, v}] → { keys, values } summed per bucket. */
function bucketize(points, from, to, mode) {
  const k = keyFn(mode);
  const keys = [...new Set(daysBetween(from, to).map(k))];
  const m = new Map(keys.map((x) => [x, 0]));
  points.forEach((p) => { const x = k(p.day); if (m.has(x)) m.set(x, m.get(x) + (Number(p.v) || 0)); });
  return { keys, values: keys.map((x) => m.get(x)) };
}
const bucketLabel = (k, mode) => (mode === 'month' ? `T${Number(k.slice(5, 7))}/${k.slice(2, 4)}` : dm(k));
const bucketTitle = (k, mode) => (mode === 'day' ? day(k, 'weekday') : mode === 'week' ? `Tuần từ ${day(k)}` : monthLabel(k));
const fit = (arr, n) => Array.from({ length: n }, (_, i) => (i < arr.length ? arr[i] : null));

function cycleText(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} phút`;
  if (h < 48) return `${dec(Math.round(h * 10) / 10)} giờ`;
  return `${dec(Math.round((h / 24) * 10) / 10)} ngày`;
}

/* ------------------------------------------------------------------ */

export default async function reportsPage(root, { query }) {
  const t0 = today();
  let kind = KINDS.some((k) => k.id === query.p) ? query.p : 'month';
  let anchor = isDay(query.d) && query.d <= t0 ? query.d : t0;
  let custom = isDay(query.from) && isDay(query.to) && query.from <= query.to
    ? { from: query.from, to: query.to }
    : { from: addDays(t0, -29), to: t0 };
  if (kind === 'custom' && diffDays(custom.to, custom.from) + 1 > MAX_DAYS) custom = { from: addDays(custom.to, -(MAX_DAYS - 1)), to: custom.to };
  let cmp = query.cmp !== '0';
  let P = null;
  let loadToken = 0;
  const S = { prod: undefined, fin: undefined, kpi: undefined, notes: undefined };
  const charts = { prod: [], time: [], fin: [], notes: [] };
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '08',
      kicker: 'Báo cáo',
      title: 'Nhìn lại để <em>đi tiếp</em>',
      lede: 'Năng suất, thời gian, tài chính, mục tiêu và ghi chú trong một kỳ — có so sánh với kỳ trước, tóm tắt bằng lời và bản in gọn gàng.',
      actions: html`
        <button type="button" class="btn" data-act="csv-menu" aria-haspopup="menu">${icon('download')} Xuất CSV</button>
        <button type="button" class="btn btn--primary" data-act="print">${icon('printer')} In / Lưu PDF</button>`,
    })}
    <div class="rp-bar rp-noprint">
      <div class="segmented" role="group" aria-label="Loại kỳ báo cáo">
        ${KINDS.map((k) => html`<button type="button" data-kind="${k.id}" aria-pressed="${k.id === kind}">${k.label}</button>`)}
      </div>
      <div class="rp-nav">
        <button type="button" class="icon-btn" data-act="prev" aria-label="Kỳ trước">${icon('chevronLeft')}</button>
        <strong class="rp-nav__title" data-title aria-live="polite"></strong>
        <button type="button" class="icon-btn" data-act="next" aria-label="Kỳ sau">${icon('chevronRight')}</button>
        <button type="button" class="btn btn--sm btn--ghost" data-act="now">Hiện tại</button>
      </div>
      <form class="rp-custom" data-custom ${kind === 'custom' ? '' : raw('hidden')}>
        <input class="input input--sm" type="date" name="from" aria-label="Từ ngày" max="${t0}" />
        <span class="faint" aria-hidden="true">→</span>
        <input class="input input--sm" type="date" name="to" aria-label="Đến ngày" max="${t0}" />
        <button class="btn btn--sm" type="submit">Áp dụng</button>
      </form>
      <label class="check rp-cmp"><input type="checkbox" data-cmp ${cmp ? raw('checked') : ''} /> So sánh với kỳ trước</label>
    </div>
    <p class="rp-range" data-range></p>

    <article class="report" data-report>
      <header class="rp-print-head" aria-hidden="true">
        <span class="eyebrow">Note_mytasks · Báo cáo</span>
        <h1 data-print-title></h1>
        <p data-print-meta></p>
      </header>

      <section class="rp-sec rp-sec--summary" data-sec="summary" aria-labelledby="rp-h-summary">
        ${secHead('01', 'Tóm tắt', 'Diễn giải tự động từ các con số bên dưới.', 'summary', 'rp-h-summary')}
        <div class="rp-summary" data-body>${loadingBlock(96)}</div>
      </section>

      <section class="rp-sec" data-sec="prod" aria-labelledby="rp-h-prod">
        ${secHead('02', 'Năng suất', 'Công việc hoàn thành, tỉ lệ hoàn thành, đúng hạn và chu kỳ xử lý.', 'prod', 'rp-h-prod')}
        <div data-body><div class="rp-tiles">${statTileSkeleton(5)}</div>${loadingBlock(240)}</div>
      </section>

      <section class="rp-sec" data-sec="time" aria-labelledby="rp-h-time">
        ${secHead('03', 'Thời gian', 'Giờ ghi nhận theo ngày và theo danh mục công việc.', 'time', 'rp-h-time')}
        <div data-body><div class="rp-tiles">${statTileSkeleton(4)}</div>${loadingBlock(240)}</div>
      </section>

      <section class="rp-sec" data-sec="fin" aria-labelledby="rp-h-fin">
        ${secHead('04', 'Tài chính', 'Chi tiêu theo danh mục, xu hướng theo ngày, mức tuân thủ ngân sách và 10 khoản lớn nhất.', 'fin', 'rp-h-fin')}
        <div data-body><div class="rp-tiles">${statTileSkeleton(4)}</div>${loadingBlock(260)}</div>
      </section>

      <section class="rp-sec" data-sec="kpi" aria-labelledby="rp-h-kpi">
        ${secHead('05', 'Mục tiêu KPI', 'Tiến độ hiện tại, thay đổi trong kỳ và dự báo hoàn thành.', 'kpi', 'rp-h-kpi')}
        <div data-body>${loadingBlock(160)}</div>
      </section>

      <section class="rp-sec" data-sec="notes" aria-labelledby="rp-h-notes">
        ${secHead('06', 'Ghi chú', 'Số ghi chú bạn đã viết trong kỳ.', 'notes', 'rp-h-notes')}
        <div data-body>${loadingBlock(120)}</div>
      </section>
    </article>`);

  const $ = (s) => root.querySelector(s);
  const body = (sec) => root.querySelector(`[data-sec="${sec}"] [data-body]`);
  const killCharts = (sec) => { charts[sec].forEach((d) => d()); charts[sec] = []; };

  function syncControls() {
    root.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
    const form = $('[data-custom]');
    form.hidden = kind !== 'custom';
    form.elements.from.value = custom.from;
    form.elements.to.value = custom.to;
    const next = periodOf(kind, kind === 'custom' ? t0 : shiftAnchor(kind, anchor, 1), kind === 'custom' ? shiftAnchor(kind, null, 1, custom) : null);
    $('[data-act="next"]').disabled = next.from > t0;
    $('[data-act="now"]').hidden = kind === 'custom' || (P && P.from <= t0 && P.fullTo >= t0);
  }

  function persistQuery() {
    setQuery({
      p: kind === 'month' ? null : kind,
      d: kind !== 'custom' && anchor !== t0 ? anchor : null,
      from: kind === 'custom' ? custom.from : null,
      to: kind === 'custom' ? custom.to : null,
      cmp: cmp ? null : '0',
    });
  }

  /* ---------- loading ---------- */
  async function load() {
    const token = ++loadToken;
    P = periodOf(kind, anchor, custom);
    syncControls();
    $('[data-title]').textContent = P.title;
    $('[data-print-title]').textContent = P.title;
    $('[data-print-meta]').textContent = `${day(P.from, 'medium')} – ${day(P.to, 'medium')}${cmp ? ` · so với ${day(P.prevFrom, 'medium')} – ${day(P.prevTo, 'medium')}` : ''} · In lúc ${dateTime(new Date())}`;
    $('[data-range]').innerHTML = String(html`
      <span>${day(P.from, 'long')} → ${day(P.to, 'long')}</span>
      <span>${num(P.len)} ngày${P.partial ? ' · tính đến hôm nay' : ''}</span>
      ${cmp && !P.future ? html`<span>so với ${dm(P.prevFrom)} – ${dmy(P.prevTo)}</span>` : ''}`);

    Object.keys(charts).forEach(killCharts);
    if (P.future) {
      ['summary', 'prod', 'time', 'fin', 'kpi', 'notes'].forEach((s) => mount(body(s), s === 'summary'
        ? emptyState({ art: 'chart', title: 'Kỳ này chưa bắt đầu', text: 'Hãy chọn một kỳ đã diễn ra hoặc bấm “Hiện tại”.', small: true })
        : html``));
      return;
    }
    Object.keys(S).forEach((k) => { S[k] = undefined; });
    mount(body('summary'), loadingBlock(96));

    // The previous period is always loaded (the narrative uses it); `cmp`
    // only toggles the visible comparison (deltas, dashed series, columns).
    const full = { from: P.from, to: P.to, prevFrom: P.prevFrom, prevTo: P.prevTo };
    const jobs = [
      ['prod', productivityReport(full), renderProd],
      ['fin', financeReport(full), renderFin],
      ['kpi', kpiReport(full), renderKpi],
      ['notes', notesReport(full), renderNotes],
    ];
    await Promise.allSettled(jobs.map(async ([key, promise, render]) => {
      try {
        const data = await promise;
        if (token !== loadToken) return;
        S[key] = data;
        render();
      } catch (err) {
        if (token !== loadToken) return;
        S[key] = null;
        if (key === 'prod') mount(body('time'), errorState(err));
        mount(body(key), errorState(err));
      }
    }));
    if (token !== loadToken) return;
    renderSummary();
  }

  /* ---------- helpers ---------- */
  function delta(cur, prev, { invert = false, points = false } = {}) {
    if (!cmp || cur == null || prev == null) return '';
    let d;
    let text;
    if (points) {
      d = cur - prev;
      text = `${d > 0 ? '+' : ''}${dec(Math.round(d * 10) / 10)} điểm`;
    } else {
      if (!prev) return cur ? html`<span class="delta rp-delta--flat">mới</span>` : '';
      d = ((cur - prev) / prev) * 100;
      text = `${d > 0 ? '+' : ''}${pct(d)}`;
    }
    if (Math.abs(d) < 0.05) return html`<span class="delta rp-delta--flat">±0</span><span>so với kỳ trước</span>`;
    const good = invert ? d < 0 : d > 0;
    return html`<span class="delta ${good ? 'delta--up' : 'delta--down'}">${text}</span><span>so với kỳ trước</span>`;
  }

  const tile = ({ label, ic, value, meta = '', accent = false, small = false }) => html`
    <div class="stat ${accent ? 'stat--accent' : ''}">
      <div class="stat__label"><span class="eyebrow">${label}</span><span class="stat__icon">${icon(ic)}</span></div>
      <div class="stat__value ${small ? 'rp-val--sm' : ''}">${value}</div>
      <div class="stat__meta">${meta}</div>
    </div>`;

  const chartOpts = (mode, keys, fmt) => ({
    scales: { y: { ticks: { callback: (v) => fmt(v, true) } } },
    plugins: {
      tooltip: {
        callbacks: {
          title: (items) => bucketTitle(keys[items[0].dataIndex], mode),
          label: (c) => (c.raw == null ? null : ` ${c.dataset.label}: ${fmt(c.raw)}`),
        },
      },
    },
  });

  function trendChart(el, { cur, prev, mode, color, label, fmt, highlightMax = false }) {
    const p = palette();
    const max = Math.max(...cur.values);
    const datasets = [{
      type: 'bar', label, data: cur.values,
      backgroundColor: highlightMax ? cur.values.map((v) => (v === max && v > 0 ? p.accent : color)) : color,
      borderRadius: 2, maxBarThickness: 22, order: 2,
    }];
    if (cmp && prev) {
      datasets.push({
        type: 'line', label: 'Kỳ trước', data: fit(prev.values, cur.keys.length),
        borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.25, spanGaps: true, order: 1,
      });
    }
    return makeChart(el, { type: 'bar', data: { labels: cur.keys.map((k) => bucketLabel(k, mode)), datasets }, options: chartOpts(mode, cur.keys, fmt) });
  }

  function doughnut(el, rows, fmt) {
    const p = palette();
    return makeChart(el, {
      type: 'doughnut',
      data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => r.v), backgroundColor: rows.map((r) => r.color), borderColor: p.surface, borderWidth: 2 }] },
      options: { plugins: { tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmt(c.raw)}` } } } },
    });
  }

  const withColors = (rows) => {
    const s = series();
    return rows.map((r, i) => ({ ...r, color: r.color || s[(i + 2) % s.length] }));
  };

  const legend = (rows, fmt, total) => html`<div class="legend rp-legend">${rows.map((r) => html`
    <div class="legend__row"><span class="legend__dot" style="--c:${r.color}"></span><span class="truncate">${r.name}</span><span class="legend__val">${fmt(r.v)}</span><span class="legend__pct">${total ? pct((r.v / total) * 100) : '—'}</span></div>`)}</div>`;

  /* ---------- § 02 Productivity ---------- */
  function renderProd() {
    killCharts('prod');
    const { cur, prev } = S.prod;
    const done = sum(cur.completed_by_day, (x) => x.count);
    const prevDone = prev ? sum(prev.completed_by_day, (x) => x.count) : null;
    const rate = cur.completion_rate == null ? null : cur.completion_rate * 100;
    const prevRate = prev?.completion_rate == null ? null : prev.completion_rate * 100;
    const onTime = cur.on_time_rate == null ? null : cur.on_time_rate * 100;
    const prevOnTime = prev?.on_time_rate == null ? null : prev.on_time_rate * 100;
    const mode = modeFor(P.len);
    const curB = bucketize(cur.completed_by_day.map((x) => ({ day: x.day, v: x.count })), P.from, P.to, mode);
    const prevB = prev ? bucketize(prev.completed_by_day.map((x) => ({ day: x.day, v: x.count })), P.prevFrom, P.prevTo, mode) : null;
    const wd = [0, 0, 0, 0, 0, 0, 0];
    cur.completed_by_day.forEach((x) => { wd[weekday(x.day)] += x.count; });
    const ws = getWeekStart();
    const order = Array.from({ length: 7 }, (_, i) => (ws + i) % 7);

    mount(body('prod'), html`
      <div class="rp-tiles">
        ${tile({ label: 'Hoàn thành', ic: 'checkCircle', value: num(done), meta: delta(done, prevDone), accent: true })}
        ${tile({ label: 'Tỉ lệ hoàn thành', ic: 'target', value: rate == null ? '—' : pct(rate), meta: rate == null ? html`<span>Chưa tạo việc nào trong kỳ</span>` : delta(rate, prevRate, { points: true }) || html`<span>việc tạo trong kỳ đã xong</span>` })}
        ${tile({ label: 'Đúng hạn', ic: 'calendar', value: onTime == null ? '—' : pct(onTime), meta: onTime == null ? html`<span>Không có việc có hạn được xong</span>` : delta(onTime, prevOnTime, { points: true }) || html`<span>trên số việc có hạn chót</span>` })}
        ${tile({ label: 'Chu kỳ trung bình', ic: 'hourglass', value: cycleText(cur.avg_cycle_hours), small: true, meta: delta(cur.avg_cycle_hours, prev?.avg_cycle_hours, { invert: true }) || html`<span>từ lúc tạo đến khi xong</span>` })}
        ${tile({ label: 'Ngày bận nhất', ic: 'activity', value: cur.busiest_weekday == null ? '—' : WEEKDAY_LONG[cur.busiest_weekday], small: true, meta: html`<span>nhiều việc xong & giờ làm nhất</span>` })}
      </div>
      <div class="rp-grid">
        <figure class="rp-fig rp-fig--wide">
          <figcaption><span>Công việc hoàn thành theo ${mode === 'day' ? 'ngày' : mode === 'week' ? 'tuần' : 'tháng'}</span>${cmp ? html`<span class="chart-key"><span><i style="background:var(--moss)"></i>Kỳ này</span><span><i class="rp-key-dash"></i>Kỳ trước</span></span>` : ''}</figcaption>
          ${done || prevDone ? html`<div class="chart-box" data-c="trend"></div>` : html`<p class="rp-empty">Chưa có công việc nào được hoàn thành trong kỳ.</p>`}
        </figure>
        <figure class="rp-fig">
          <figcaption><span>Nhịp trong tuần</span></figcaption>
          ${done ? html`<div class="chart-box chart-box--sm" data-c="weekday"></div>` : html`<p class="rp-empty">Chưa đủ dữ liệu.</p>`}
        </figure>
      </div>
      ${cur.source === 'local' ? html`<p class="rp-foot">Số liệu tính trực tiếp trên trình duyệt (máy chủ chưa hỗ trợ thống kê cho khoảng này).</p>` : ''}`);

    const p = palette();
    const tEl = body('prod').querySelector('[data-c="trend"]');
    if (tEl) charts.prod.push(trendChart(tEl, { cur: curB, prev: prevB, mode, color: p.moss, label: 'Hoàn thành', fmt: (v) => num(v) }));
    const wEl = body('prod').querySelector('[data-c="weekday"]');
    if (wEl) {
      const max = Math.max(...wd);
      charts.prod.push(makeChart(wEl, {
        type: 'bar',
        data: { labels: order.map((i) => WEEKDAY_SHORT[i]), datasets: [{ label: 'Hoàn thành', data: order.map((i) => wd[i]), backgroundColor: order.map((i) => (wd[i] === max && max > 0 ? p.accent : p.ink)), borderRadius: 3, maxBarThickness: 24 }] },
        options: { scales: { y: { ticks: { precision: 0 } } }, plugins: { tooltip: { callbacks: { title: (c) => WEEKDAY_LONG[order[c[0].dataIndex]], label: (c) => ` ${num(c.raw)} việc` } } } },
      }));
    }
    renderTime();
  }

  /* ---------- § 03 Time ---------- */
  function renderTime() {
    killCharts('time');
    const { cur, prev } = S.prod;
    const mins = sum(cur.minutes_by_day, (x) => x.minutes);
    const prevMins = prev ? sum(prev.minutes_by_day, (x) => x.minutes) : null;
    const activeDays = cur.minutes_by_day.filter((x) => x.minutes > 0).length;
    const prevActive = prev ? prev.minutes_by_day.filter((x) => x.minutes > 0).length : null;
    const cats = withColors(cur.minutes_by_category.filter((c) => c.minutes > 0).map((c) => ({ name: c.name || 'Không gắn danh mục', color: c.color, v: c.minutes })));
    const top = cats[0];
    const mode = modeFor(P.len);
    const curB = bucketize(cur.minutes_by_day.map((x) => ({ day: x.day, v: x.minutes / 60 })), P.from, P.to, mode);
    const prevB = prev ? bucketize(prev.minutes_by_day.map((x) => ({ day: x.day, v: x.minutes / 60 })), P.prevFrom, P.prevTo, mode) : null;
    curB.values = curB.values.map((v) => Math.round(v * 10) / 10);
    if (prevB) prevB.values = prevB.values.map((v) => Math.round(v * 10) / 10);

    mount(body('time'), html`
      <div class="rp-tiles">
        ${tile({ label: 'Tổng giờ', ic: 'clock', value: hours(mins), meta: delta(mins, prevMins), accent: true })}
        ${tile({ label: 'Trung bình / ngày', ic: 'timer', value: fmtMinutes(mins / P.len), small: true, meta: delta(mins / P.len, prevMins == null ? null : prevMins / P.len) })}
        ${tile({ label: 'Ngày có ghi giờ', ic: 'calendar', value: html`${num(activeDays)}<small>/ ${num(P.len)}</small>`, meta: delta(activeDays, prevActive) || html`<span>${pct((activeDays / P.len) * 100)} số ngày</span>` })}
        ${tile({ label: 'Danh mục chính', ic: 'tag', value: top ? top.name : '—', small: true, meta: top ? html`<span>${fmtMinutes(top.v)} · ${pct((top.v / mins) * 100)}</span>` : html`<span>Chưa có giờ ghi nhận</span>` })}
      </div>
      <div class="rp-grid">
        <figure class="rp-fig rp-fig--wide">
          <figcaption><span>Giờ làm theo ${mode === 'day' ? 'ngày' : mode === 'week' ? 'tuần' : 'tháng'}</span>${cmp ? html`<span class="chart-key"><span><i style="background:var(--indigo)"></i>Kỳ này</span><span><i class="rp-key-dash"></i>Kỳ trước</span></span>` : ''}</figcaption>
          ${mins || prevMins ? html`<div class="chart-box" data-c="trend"></div>` : html`<p class="rp-empty">Chưa có phiên tính giờ nào trong kỳ.</p>`}
        </figure>
        <figure class="rp-fig">
          <figcaption><span>Theo danh mục</span></figcaption>
          ${cats.length ? html`<div class="chart-box chart-box--sm" data-c="cats"></div>${legend(cats.slice(0, 6), fmtMinutes, mins)}` : html`<p class="rp-empty">Chưa có dữ liệu.</p>`}
        </figure>
      </div>`);
    const p = palette();
    const tEl = body('time').querySelector('[data-c="trend"]');
    if (tEl) charts.time.push(trendChart(tEl, { cur: curB, prev: prevB, mode, color: p.indigo, label: 'Giờ', fmt: (v, axis) => (axis ? `${v}g` : `${dec(v)} giờ`) }));
    const cEl = body('time').querySelector('[data-c="cats"]');
    if (cEl) charts.time.push(doughnut(cEl, cats, fmtMinutes));
  }

  /* ---------- § 04 Finance ---------- */
  function renderFin() {
    killCharts('fin');
    const f = S.fin;
    const mode = modeFor(P.len);
    const curB = bucketize(f.by_day.map((x) => ({ day: x.day, v: x.total })), P.from, P.to, mode);
    const prevB = bucketize(f.prev_by_day.map((x) => ({ day: x.day, v: x.total })), P.prevFrom, P.prevTo, mode);
    const used = f.budget.overall ? (f.total / f.budget.overall) * 100 : null;
    const cats = withColors(f.by_category.filter((c) => c.total > 0).map((c) => ({ ...c, name: catName(c.name), v: c.total })));
    const tableRows = f.by_category.filter((c) => c.total > 0 || c.budget);
    const maxCat = Math.max(1, ...tableRows.map((c) => c.total));
    const over = tableRows.filter((c) => c.budget && c.total > c.budget);

    mount(body('fin'), html`
      <div class="rp-tiles">
        ${tile({ label: 'Tổng chi', ic: 'wallet', value: money(f.total, { compact: true }), meta: delta(f.total, f.prev_total, { invert: true }), accent: true })}
        ${tile({ label: 'Trung bình / ngày', ic: 'coin', value: money(f.daily_avg, { compact: true }), small: true, meta: delta(f.daily_avg, f.prev_total / P.len, { invert: true }) })}
        ${tile({ label: 'Số khoản chi', ic: 'list', value: num(f.count), meta: delta(f.count, f.prev_count, { invert: true }) })}
        ${tile({
          label: 'Ngân sách đã dùng', ic: 'piggy',
          value: used == null ? '—' : pct(used),
          meta: used == null
            ? html`<span>${f.budget.has_any ? 'Chỉ có ngân sách theo danh mục' : 'Chưa đặt ngân sách'}</span>`
            : html`<span class="${used > 100 ? 'rp-bad' : used > 90 ? 'rp-warn' : ''}">${money(f.total, { compact: true })} / ${money(f.budget.overall, { compact: true })}</span>`,
        })}
      </div>
      ${f.count || f.prev_count ? html`
        <div class="rp-grid">
          <figure class="rp-fig rp-fig--wide">
            <figcaption><span>Chi tiêu theo ${mode === 'day' ? 'ngày' : mode === 'week' ? 'tuần' : 'tháng'}</span>${cmp ? html`<span class="chart-key"><span><i style="background:var(--accent)"></i>Kỳ này</span><span><i class="rp-key-dash"></i>Kỳ trước</span></span>` : ''}</figcaption>
            <div class="chart-box" data-c="trend"></div>
          </figure>
          <figure class="rp-fig">
            <figcaption><span>Cơ cấu theo danh mục</span></figcaption>
            ${cats.length ? html`<div class="chart-box chart-box--sm" data-c="cats"></div>${legend(cats.slice(0, 6), (v) => money(v, { compact: true }), f.total)}` : html`<p class="rp-empty">Không có khoản chi trong kỳ.</p>`}
          </figure>
          ${f.budget.overall ? html`
            <figure class="rp-fig rp-fig--full">
              <figcaption><span>Lũy kế chi tiêu so với nhịp ngân sách</span><span class="chart-key"><span><i style="background:var(--accent)"></i>Đã chi (lũy kế)</span><span><i class="rp-key-dash"></i>Nhịp ngân sách</span></span></figcaption>
              <div class="chart-box chart-box--sm" data-c="pace"></div>
            </figure>` : ''}
        </div>

        <h3 class="rp-sub">Theo danh mục & ngân sách</h3>
        <div class="table-wrap rp-table"><table class="table">
          <thead><tr><th>Danh mục</th><th class="r">Số khoản</th><th class="r">Đã chi</th><th class="rp-col-share">Tỉ trọng</th><th class="r">Ngân sách kỳ</th><th class="r">Đã dùng</th>${cmp ? html`<th class="r">Kỳ trước</th><th class="r">Thay đổi</th>` : ''}</tr></thead>
          <tbody>${tableRows.map((c) => {
            const u = c.budget ? (c.total / c.budget) * 100 : null;
            const ch = c.prev_total ? ((c.total - c.prev_total) / c.prev_total) * 100 : null;
            return html`<tr>
              <td><span class="cat" style="--c:${c.color || 'var(--ink-4)'}"><span class="cat__dot"></span><span class="truncate">${catName(c.name)}</span></span></td>
              <td class="r num">${num(c.count)}</td>
              <td class="r num"><strong>${money(c.total)}</strong></td>
              <td class="rp-col-share"><div class="row" style="gap:8px">${bar((c.total / maxCat) * 100, { thin: true, color: c.color || undefined })}<span class="num faint rp-pct">${pct(c.pct)}</span></div></td>
              <td class="r num muted">${c.budget ? money(c.budget) : '—'}</td>
              <td class="r">${u == null ? html`<span class="faint">—</span>` : html`<span class="badge badge--${u > 100 ? 'danger' : u >= 80 ? 'warning' : 'success'}">${pct(u)}</span>`}</td>
              ${cmp ? html`<td class="r num muted">${money(c.prev_total)}</td><td class="r">${ch == null ? html`<span class="faint">${c.total ? 'mới' : '—'}</span>` : html`<span class="delta ${ch > 0 ? 'delta--down' : 'delta--up'}">${ch > 0 ? '+' : ''}${pct(ch)}</span>`}</td>` : ''}
            </tr>`;
          })}</tbody>
          <tfoot><tr><td><strong>Tổng</strong></td><td class="r num">${num(f.count)}</td><td class="r num"><strong>${money(f.total)}</strong></td><td class="rp-col-share"></td><td class="r num muted">${f.budget.overall ? money(f.budget.overall) : '—'}</td><td class="r">${used == null ? '' : html`<span class="badge badge--${used > 100 ? 'danger' : used >= 80 ? 'warning' : 'success'}">${pct(used)}</span>`}</td>${cmp ? html`<td class="r num muted">${money(f.prev_total)}</td><td class="r">${f.change_pct == null ? '' : html`<span class="delta ${f.change_pct > 0 ? 'delta--down' : 'delta--up'}">${f.change_pct > 0 ? '+' : ''}${pct(f.change_pct)}</span>`}</td>` : ''}</tr></tfoot>
        </table></div>
        ${f.budget.has_any ? html`<p class="rp-foot">Ngân sách tháng được phân bổ theo số ngày của kỳ${P.partial ? ' (đến hôm nay)' : ''}.${over.length ? html` <strong class="rp-bad">Vượt ngân sách: ${over.map((c) => catName(c.name)).join(', ')}.</strong>` : ''}</p>` : ''}

        <h3 class="rp-sub">10 khoản chi lớn nhất</h3>
        ${f.top.length ? html`<div class="table-wrap rp-table"><table class="table">
          <thead><tr><th class="rp-rank">#</th><th>Ngày</th><th>Mô tả</th><th>Danh mục</th><th>Thanh toán</th><th class="r">Số tiền</th></tr></thead>
          <tbody>${f.top.map((x, i) => html`<tr>
            <td class="num faint rp-rank">${String(i + 1).padStart(2, '0')}</td>
            <td class="num">${dm(x.spent_on)}</td>
            <td class="rp-desc">${x.description || html`<span class="faint">Không mô tả</span>`}</td>
            <td><span class="cat" style="--c:${x.category?.color || 'var(--ink-4)'}"><span class="cat__dot"></span><span class="truncate">${catName(x.category?.name)}</span></span></td>
            <td class="muted">${PAYMENT_METHODS[x.payment_method] || x.payment_method}</td>
            <td class="r num"><strong>${money(x.amount)}</strong></td>
          </tr>`)}</tbody></table></div>` : html`<p class="rp-empty">Không có khoản chi trong kỳ.</p>`}`
      : emptyState({ art: 'wallet', title: 'Không có khoản chi', text: 'Kỳ này và kỳ trước chưa ghi nhận khoản chi nào.', small: true })}`);

    const p = palette();
    const el = (k) => body('fin').querySelector(`[data-c="${k}"]`);
    if (el('trend')) charts.fin.push(trendChart(el('trend'), { cur: curB, prev: prevB, mode, color: p.accent, label: 'Chi', fmt: (v, axis) => (axis ? moneyShort(v) : money(v)) }));
    if (el('cats')) charts.fin.push(doughnut(el('cats'), cats, (v) => money(v)));
    if (el('pace')) {
      const days = daysBetween(P.from, P.to);
      let run = 0;
      const cum = f.by_day.map((x) => (run += x.total));
      const paceFull = f.budget.overall;
      charts.fin.push(makeChart(el('pace'), {
        type: 'line',
        data: {
          labels: days.map(dm),
          datasets: [
            { label: 'Đã chi', data: cum, borderColor: p.accent, backgroundColor: p.accentSoft, fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2 },
            { label: 'Nhịp ngân sách', data: days.map((_, i) => (paceFull * (i + 1)) / days.length), borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0 },
          ],
        },
        options: {
          scales: { y: { ticks: { callback: (v) => moneyShort(v) } } },
          plugins: { tooltip: { callbacks: { title: (c) => day(days[c[0].dataIndex], 'weekday'), label: (c) => ` ${c.dataset.label}: ${money(c.raw)}` } } },
        },
      }));
    }
  }

  /* ---------- § 05 KPI ---------- */
  function renderKpi() {
    const list = S.kpi;
    if (!list.length) {
      mount(body('kpi'), emptyState({ art: 'target', title: 'Chưa có KPI', text: 'Tạo KPI để theo dõi mục tiêu và xem dự báo hoàn thành ở đây.', action: html`<a class="btn btn--sm" href="#/kpi">${icon('plus')} Tạo KPI</a>`, small: true }));
      return;
    }
    const counts = { on: 0, risk: 0, off: 0 };
    list.forEach((k) => {
      if (['achieved', 'on_track'].includes(k.forecast_status)) counts.on += 1;
      else if (k.forecast_status === 'at_risk') counts.risk += 1;
      else if (k.forecast_status === 'off_track') counts.off += 1;
    });
    const updated = list.filter((k) => k.records_in_period > 0).length;
    mount(body('kpi'), html`
      <div class="rp-tiles">
        ${tile({ label: 'KPI đang theo dõi', ic: 'target', value: num(list.length), accent: true, meta: html`<span>${num(list.filter((k) => k.status === 'active').length)} đang theo đuổi</span>` })}
        ${tile({ label: 'Đúng tiến độ', ic: 'checkCircle', value: num(counts.on), meta: html`<span>gồm cả KPI đã đạt</span>` })}
        ${tile({ label: 'Cần chú ý', ic: 'alert', value: num(counts.risk + counts.off), meta: html`<span>${num(counts.risk)} rủi ro · ${num(counts.off)} chậm</span>` })}
        ${tile({ label: 'Cập nhật trong kỳ', ic: 'history', value: html`${num(updated)}<small>/ ${num(list.length)}</small>`, meta: html`<span>KPI có bản ghi mới</span>` })}
      </div>
      <div class="table-wrap rp-table"><table class="table">
        <thead><tr><th>KPI</th><th class="rp-col-share">Tiến độ</th><th class="r">Hiện tại / Mục tiêu</th><th class="r">Thay đổi trong kỳ</th><th class="r">Bản ghi</th><th>Dự báo</th><th class="r">Hạn</th></tr></thead>
        <tbody>${list.map((k) => {
          const fc = FORECAST[k.forecast_status];
          return html`<tr>
            <td><strong>${k.name}</strong><div class="faint rp-mini">${KPI_STATUS[k.status] || k.status}</div></td>
            <td class="rp-col-share"><div class="row" style="gap:8px">${bar(k.progress, { thin: true, color: k.progress >= 100 ? 'var(--moss)' : 'var(--accent)' })}<span class="num rp-pct">${pct(k.progress)}</span></div></td>
            <td class="r num">${dec(k.current_value)} / ${dec(k.target_value)} ${k.unit}</td>
            <td class="r num">${k.records_in_period ? html`<span class="${k.change > 0 ? 'rp-good' : k.change < 0 ? 'rp-bad' : ''}">${k.change > 0 ? '+' : ''}${dec(k.change)} ${k.unit}</span>` : html`<span class="faint">—</span>`}</td>
            <td class="r num">${num(k.records_in_period)}</td>
            <td>${fc ? html`<span class="badge badge--${fc.badge}">${fc.label}</span>${k.projected_completion && k.forecast_status !== 'achieved' ? html`<div class="faint rp-mini">Dự kiến đạt ${day(k.projected_completion, 'medium')}</div>` : ''}` : html`<span class="faint">—</span>`}</td>
            <td class="r num muted">${k.end_date ? dmy(k.end_date) : '—'}</td>
          </tr>`;
        })}</tbody></table></div>`);
  }

  /* ---------- § 06 Notes ---------- */
  function renderNotes() {
    killCharts('notes');
    const n = S.notes;
    if (!n) {
      mount(body('notes'), html`<p class="rp-empty">${icon('info')} Chưa đọc được dữ liệu ghi chú — tính năng Ghi chú có thể chưa được bật trên máy chủ. Các phần khác của báo cáo không bị ảnh hưởng.</p>`);
      return;
    }
    const mode = modeFor(P.len);
    const curB = bucketize(n.by_day.map((x) => ({ day: x.day, v: x.count })), P.from, P.to, mode);
    mount(body('notes'), html`
      <div class="rp-grid">
        <div class="rp-tiles rp-tiles--stack">
          ${tile({ label: 'Ghi chú mới', ic: 'note', value: num(n.count), meta: delta(n.count, n.prev), accent: true })}
          ${tile({ label: 'Tổng số ghi chú', ic: 'archive', value: num(n.total), meta: html`<span>không tính thùng rác</span>` })}
        </div>
        <figure class="rp-fig rp-fig--wide">
          <figcaption><span>Ghi chú tạo theo ${mode === 'day' ? 'ngày' : mode === 'week' ? 'tuần' : 'tháng'}</span></figcaption>
          ${n.count ? html`<div class="chart-box chart-box--sm" data-c="trend"></div>` : html`<p class="rp-empty">Chưa có ghi chú mới trong kỳ.</p>`}
          ${n.latest.length ? html`<ul class="mini-list rp-latest">${n.latest.map((x) => html`<li><span class="grow truncate">${x.title || 'Không tiêu đề'}</span><span class="num faint">${dm(x.created_at.slice(0, 10))}</span></li>`)}</ul>` : ''}
        </figure>
      </div>`);
    const el = body('notes').querySelector('[data-c="trend"]');
    if (el) charts.notes.push(trendChart(el, { cur: curB, prev: null, mode, color: palette().plum, label: 'Ghi chú', fmt: (v) => num(v) }));
  }

  /* ---------- § 01 Summary ---------- */
  function summaryParts() {
    const out = [];
    const tips = [];
    const facts = []; // [label, cur, prev] for CSV
    const prd = S.prod;
    const when = P.partial && P.kind !== 'custom' ? `Từ đầu ${P.noun} đến nay`
      : P.kind === 'custom' ? 'Trong khoảng thời gian này'
      : `Trong ${P.title.charAt(0).toLowerCase()}${P.title.slice(1)}`;
    const trend = (cur, prev, up = 'tăng', down = 'giảm') => {
      if (!cmp || prev == null || !prev) return '';
      const d = ((cur - prev) / prev) * 100;
      if (Math.abs(d) < 1) return ', tương đương kỳ trước';
      return `, ${d > 0 ? up : down} ${pct(Math.abs(d))} so với kỳ trước`;
    };
    if (prd) {
      const done = sum(prd.cur.completed_by_day, (x) => x.count);
      const prevDone = prd.prev ? sum(prd.prev.completed_by_day, (x) => x.count) : null;
      facts.push(['Công việc hoàn thành', done, prevDone]);
      if (done) {
        out.push(html`${when}, bạn đã hoàn thành <strong>${num(done)} công việc</strong>${trend(done, prevDone, 'nhiều hơn', 'ít hơn')}${prd.cur.on_time_rate != null ? html`; <strong>${pct(prd.cur.on_time_rate * 100)}</strong> việc có hạn được xong đúng hạn` : ''}.`);
      } else {
        out.push(html`${when}, chưa có công việc nào được đánh dấu hoàn thành.`);
      }
      if (prd.cur.busiest_weekday != null) out.push(html` Ngày làm việc hiệu quả nhất là <strong>${WEEKDAY_LONG[prd.cur.busiest_weekday]}</strong>.`);
      if (prd.cur.completion_rate != null && prd.cur.completion_rate < 0.5) tips.push('số việc tạo mới đang nhiều hơn số việc hoàn thành — cân nhắc thu gọn danh sách hoặc chia nhỏ việc lớn');
      if (prd.cur.on_time_rate != null && prd.cur.on_time_rate < 0.6) tips.push('nhiều việc trễ hạn — hãy đặt hạn chót thực tế hơn hoặc ưu tiên việc sắp đến hạn');
      facts.push(['Tỉ lệ hoàn thành (%)', prd.cur.completion_rate == null ? '' : Math.round(prd.cur.completion_rate * 1000) / 10, prd.prev?.completion_rate == null ? '' : Math.round(prd.prev.completion_rate * 1000) / 10]);
      facts.push(['Đúng hạn (%)', prd.cur.on_time_rate == null ? '' : Math.round(prd.cur.on_time_rate * 1000) / 10, prd.prev?.on_time_rate == null ? '' : Math.round(prd.prev.on_time_rate * 1000) / 10]);

      const mins = sum(prd.cur.minutes_by_day, (x) => x.minutes);
      const prevMins = prd.prev ? sum(prd.prev.minutes_by_day, (x) => x.minutes) : null;
      facts.push(['Số phút làm việc', mins, prevMins]);
      if (mins) {
        const top = prd.cur.minutes_by_category.filter((c) => c.minutes > 0)[0];
        out.push(html` Tổng thời gian ghi nhận là <strong>${fmtMinutes(mins)}</strong> (trung bình ${fmtMinutes(mins / P.len)} mỗi ngày)${trend(mins, prevMins)}${top ? html`, nhiều nhất cho “${top.name || 'Không gắn danh mục'}” (${pct((top.minutes / mins) * 100)})` : ''}.`);
      } else {
        out.push(html` Chưa có giờ làm nào được ghi nhận.`);
      }
    }
    const f = S.fin;
    if (f) {
      facts.push(['Tổng chi', f.total, f.prev_total]);
      if (f.total) {
        const top = f.by_category.find((c) => c.total > 0);
        out.push(html` Về tài chính, bạn đã chi <strong>${money(f.total)}</strong>${trend(f.total, f.prev_total)}${top ? html`; khoản lớn nhất thuộc “${catName(top.name)}” (${pct(top.pct)})` : ''}.`);
        if (f.budget.overall) {
          const used = (f.total / f.budget.overall) * 100;
          out.push(html` Mức chi bằng <strong>${pct(used)}</strong> ngân sách của kỳ${used > 100 ? ' — đã vượt ngân sách' : used > 90 ? ' — sát ngưỡng' : ', vẫn trong tầm kiểm soát'}.`);
          if (used > 90) tips.push('chi tiêu đang chạm ngưỡng ngân sách — xem lại các khoản lớn trong mục Tài chính');
        }
        const over = f.by_category.filter((c) => c.budget && c.total > c.budget);
        if (over.length) out.push(html` Danh mục vượt ngân sách: ${over.map((c) => catName(c.name)).join(', ')}.`);
      } else {
        out.push(html` Không có khoản chi nào trong kỳ.`);
      }
    }
    const k = S.kpi;
    if (k && k.length) {
      const on = k.filter((x) => ['achieved', 'on_track'].includes(x.forecast_status)).length;
      const risky = k.filter((x) => ['at_risk', 'off_track'].includes(x.forecast_status));
      facts.push(['KPI đúng tiến độ', on, '']);
      out.push(html` Với mục tiêu, <strong>${num(on)}/${num(k.length)} KPI</strong> đang đúng tiến độ hoặc đã đạt${risky.length ? html`; cần chú ý: ${risky.slice(0, 3).map((x) => `“${x.name}”`).join(', ')}${risky.length > 3 ? '…' : ''}` : ''}.`);
    }
    const n = S.notes;
    if (n) {
      facts.push(['Ghi chú mới', n.count, n.prev ?? '']);
      if (n.count) out.push(html` Bạn đã viết <strong>${num(n.count)} ghi chú</strong> mới${trend(n.count, n.prev, 'nhiều hơn', 'ít hơn')}.`);
    }
    return { out, tips, facts };
  }

  function renderSummary() {
    const { out, tips } = summaryParts();
    const failed = Object.entries(S).filter(([key, v]) => v === null && key !== 'notes').length;
    mount(body('summary'), out.length
      ? html`
        <p class="rp-lede">${out}</p>
        ${tips.length ? html`<p class="rp-tip">${icon('sparkle')}<span><strong>Gợi ý:</strong> ${tips.slice(0, 2).join('; ')}.</span></p>` : ''}
        ${failed ? html`<p class="rp-foot">Một số phần chưa tải được nên tóm tắt có thể chưa đầy đủ.</p>` : ''}
        <div class="rp-summary__actions rp-noprint"><button type="button" class="btn btn--sm btn--ghost" data-act="copy-summary">${icon('link')} Sao chép tóm tắt</button></div>`
      : html`<p class="rp-empty">Chưa đủ dữ liệu để tóm tắt kỳ này.</p>`);
  }

  /* ---------- CSV ---------- */
  function csvOptions(key) {
    const stamp = `${P.from}_${P.to}`;
    const o = [];
    const prd = S.prod;
    if (key === 'summary') {
      o.push({ label: 'Chỉ số tóm tắt', file: `bao-cao_tom-tat_${stamp}.csv`, rows: summaryParts().facts.map(([a, b, c]) => ({ a, b, c })), cols: [{ label: 'Chỉ số', key: 'a' }, { label: 'Kỳ này', key: 'b' }, { label: 'Kỳ trước', key: 'c' }] });
    }
    if (key === 'prod' && prd) {
      const prevMap = new Map((prd.prev?.completed_by_day || []).map((x, i) => [i, x.count]));
      o.push({ label: 'Hoàn thành theo ngày', file: `bao-cao_nang-suat_${stamp}.csv`, rows: prd.cur.completed_by_day.map((x, i) => ({ ...x, prev: prevMap.get(i) ?? '' })), cols: [{ label: 'Ngày', key: 'day' }, { label: 'Việc hoàn thành', key: 'count' }, { label: 'Kỳ trước (cùng vị trí)', key: 'prev' }] });
    }
    if (key === 'time' && prd) {
      o.push({ label: 'Giờ theo ngày', file: `bao-cao_thoi-gian-ngay_${stamp}.csv`, rows: prd.cur.minutes_by_day, cols: [{ label: 'Ngày', key: 'day' }, { label: 'Phút', key: 'minutes' }, { label: 'Giờ', value: (r) => Math.round((r.minutes / 60) * 100) / 100 }] });
      o.push({ label: 'Giờ theo danh mục', file: `bao-cao_thoi-gian-danh-muc_${stamp}.csv`, rows: prd.cur.minutes_by_category, cols: [{ label: 'Danh mục', value: (r) => r.name || 'Không gắn danh mục' }, { label: 'Phút', key: 'minutes' }, { label: 'Giờ', value: (r) => Math.round((r.minutes / 60) * 100) / 100 }] });
    }
    if (key === 'fin' && S.fin) {
      o.push({ label: 'Chi tiêu theo danh mục', file: `bao-cao_chi-tieu-danh-muc_${stamp}.csv`, rows: S.fin.by_category, cols: [{ label: 'Danh mục', value: (r) => catName(r.name) }, { label: 'Số khoản', key: 'count' }, { label: 'Đã chi', key: 'total' }, { label: 'Tỉ trọng (%)', value: (r) => Math.round(r.pct * 10) / 10 }, { label: 'Ngân sách kỳ', value: (r) => (r.budget == null ? '' : Math.round(r.budget)) }, { label: 'Kỳ trước', key: 'prev_total' }] });
      o.push({ label: 'Chi tiêu theo ngày', file: `bao-cao_chi-tieu-ngay_${stamp}.csv`, rows: S.fin.by_day, cols: [{ label: 'Ngày', key: 'day' }, { label: 'Đã chi', key: 'total' }] });
      o.push({ label: 'Tất cả khoản chi trong kỳ', file: `bao-cao_khoan-chi_${stamp}.csv`, rows: S.fin.rows, cols: [{ label: 'Ngày', key: 'spent_on' }, { label: 'Số tiền', key: 'amount' }, { label: 'Danh mục', value: (r) => catName(r.category?.name) }, { label: 'Mô tả', key: 'description' }, { label: 'Thanh toán', value: (r) => PAYMENT_METHODS[r.payment_method] || r.payment_method }, { label: 'Ghi chú', key: 'note' }] });
    }
    if (key === 'kpi' && S.kpi) {
      o.push({ label: 'Tiến độ KPI', file: `bao-cao_kpi_${stamp}.csv`, rows: S.kpi, cols: [{ label: 'KPI', key: 'name' }, { label: 'Đơn vị', key: 'unit' }, { label: 'Hiện tại', key: 'current_value' }, { label: 'Mục tiêu', key: 'target_value' }, { label: 'Tiến độ (%)', value: (r) => Math.round(r.progress * 10) / 10 }, { label: 'Thay đổi trong kỳ', key: 'change' }, { label: 'Bản ghi trong kỳ', key: 'records_in_period' }, { label: 'Dự báo', value: (r) => FORECAST[r.forecast_status]?.label || '' }, { label: 'Hạn', key: 'end_date' }] });
    }
    if (key === 'notes' && S.notes) {
      o.push({ label: 'Ghi chú theo ngày', file: `bao-cao_ghi-chu_${stamp}.csv`, rows: S.notes.by_day, cols: [{ label: 'Ngày', key: 'day' }, { label: 'Ghi chú mới', key: 'count' }] });
    }
    return o;
  }
  const download = (opt) => { downloadText(opt.file, toCSV(opt.rows, opt.cols)); toast(`Đã tải “${opt.label}”.`); };
  function csvFor(key, anchorEl) {
    const opts = csvOptions(key);
    if (!opts.length) return toast.info('Phần này chưa có dữ liệu để xuất.');
    if (opts.length === 1) return download(opts[0]);
    popMenu(anchorEl, opts.map((o) => ({ label: o.label, icon: 'download', onClick: () => download(o) })));
  }

  /* ---------- events ---------- */
  disposers.push(on(root, 'click', '[data-kind]', (e, el) => {
    kind = el.dataset.kind;
    if (kind !== 'custom') anchor = t0;
    persistQuery();
    load();
  }));
  disposers.push(on(root, 'submit', '[data-custom]', (e, form) => {
    e.preventDefault();
    const from = form.elements.from.value, to = form.elements.to.value;
    if (!isDay(from) || !isDay(to) || from > to) return toast.error('Khoảng ngày không hợp lệ.');
    if (diffDays(to, from) + 1 > MAX_DAYS) return toast.error('Chọn tối đa 2 năm.');
    custom = { from, to };
    persistQuery();
    load();
  }));
  disposers.push(on(root, 'change', '[data-cmp]', (e, el) => {
    cmp = el.checked;
    persistQuery();
    load();
  }));
  disposers.push(on(root, 'click', '[data-csv]', (e, el) => csvFor(el.dataset.csv, el)));
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'retry') load();
    if (a === 'prev' || a === 'next') {
      const dir = a === 'prev' ? -1 : 1;
      if (kind === 'custom') custom = shiftAnchor(kind, null, dir, custom);
      else anchor = shiftAnchor(kind, anchor, dir);
      if (kind !== 'custom' && anchor > t0) anchor = t0;
      persistQuery();
      load();
    }
    if (a === 'now') { anchor = t0; persistQuery(); load(); }
    if (a === 'print') printReport();
    if (a === 'csv-menu') {
      const all = ['summary', 'prod', 'time', 'fin', 'kpi', 'notes'].flatMap(csvOptions);
      if (!all.length) return toast.info('Chưa có dữ liệu để xuất.');
      popMenu(el, all.map((o) => ({ label: o.label, icon: 'download', onClick: () => download(o) })));
    }
    if (a === 'copy-summary') {
      const text = root.querySelector('.rp-lede')?.textContent.replace(/\s+/g, ' ').trim();
      try {
        await navigator.clipboard.writeText(`${P.title}: ${text}`);
        toast('Đã sao chép tóm tắt.');
      } catch {
        toast.error('Trình duyệt không cho phép sao chép.');
      }
    }
  }));

  function printReport() {
    const docEl = document.documentElement;
    docEl.dataset.print = 'report';
    const done = () => { delete docEl.dataset.print; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    // Let layout settle with print rules before the dialog snapshots it.
    requestAnimationFrame(() => window.print());
  }

  let reloadTimer = null;
  disposers.push(onDataChanged(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400); }));

  await load();
  return () => {
    clearTimeout(reloadTimer);
    loadToken++;
    disposers.forEach((d) => d());
    Object.keys(charts).forEach(killCharts);
    delete document.documentElement.dataset.print;
  };
}

function secHead(n, title, sub, key, id) {
  return html`
    <header class="rp-sec__head">
      <div class="rp-sec__titles"><h2 id="${id}">${title}</h2><p>${sub}</p></div>
      <button type="button" class="btn btn--sm btn--ghost rp-noprint" data-csv="${key}" aria-label="Xuất CSV phần ${title}">${icon('download')} CSV</button>
    </header>`;
}
