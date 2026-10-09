// § 05 Mục tiêu KPI — forecast-driven KPI board: summary strip, cards with
// ring + sparkline + projection, detail view with history chart and records.
import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, ring, popMenu } from '../components/ui.js';
import { emptyState, errorState, loadingBlock } from '../components/states.js';
import { openModal, field, input, textarea, select, confirmDialog } from '../components/modal.js';
import { makeChart, palette } from '../components/chart.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import {
  listKpis, createKpi, updateKpi, deleteKpi, listAllRecords, addRecord, updateRecord, deleteRecord, forecastAll,
} from '../services/kpis.js';
import { today, diffDays, addDays, addMonths, startOfMonth, endOfMonth } from '../utils/date.js';
import { dec, day, pct, num } from '../utils/format.js';

const STATUS = {
  active: { label: 'Đang theo đuổi', badge: 'accent' },
  paused: { label: 'Tạm dừng', badge: 'warning' },
  completed: { label: 'Đã hoàn tất', badge: 'success' },
  archived: { label: 'Lưu trữ', badge: 'muted' },
};

/** Forecast status (kpi_forecast.status) → presentation. */
const FC = {
  on_track: { label: 'Đúng tiến độ', badge: 'info', color: 'var(--indigo)', rank: 3 },
  at_risk: { label: 'Có rủi ro', badge: 'warning', color: 'var(--ochre)', rank: 1 },
  off_track: { label: 'Chệch hướng', badge: 'danger', color: 'var(--clay)', rank: 0 },
  no_data: { label: 'Chưa đủ dữ liệu', badge: 'muted', color: 'var(--ink-3)', rank: 2 },
  achieved: { label: 'Đã đạt', badge: 'success', color: 'var(--moss)', rank: 4 },
};
const FC_ORDER = ['on_track', 'at_risk', 'off_track', 'no_data', 'achieved'];

/** Templates: span 'month' = calendar month; 'quarter'/'year' = from today. */
const TEMPLATES = [
  { name: 'Doanh số tháng', unit: 'triệu ₫', target: 100, span: 'month', icon: 'coin', desc: 'Tổng doanh số cộng dồn từ đầu tháng.' },
  { name: 'Số khách hàng mới', unit: 'khách', target: 20, span: 'month', icon: 'user', desc: 'Khách hàng mới chốt được trong tháng (cộng dồn).' },
  { name: 'Giờ học', unit: 'giờ', target: 60, span: 'quarter', icon: 'clock', desc: 'Tổng giờ học tập trung — xem số giờ ở trang Thời gian.' },
  { name: 'Giảm cân', unit: 'kg', target: 5, span: 'quarter', icon: 'activity', desc: 'Ghi tổng số kg đã giảm so với lúc bắt đầu (không phải cân nặng hiện tại).' },
  { name: 'Số bài viết', unit: 'bài', target: 8, span: 'month', icon: 'note', desc: 'Số bài đã xuất bản trong tháng.' },
  { name: 'Đọc sách', unit: 'cuốn', target: 12, span: 'year', icon: 'folder', desc: 'Số cuốn sách đã đọc xong.' },
  { name: 'Tiết kiệm', unit: 'triệu ₫', target: 50, span: 'year', icon: 'piggy', desc: 'Tổng số tiền đã để dành được.' },
  { name: 'Chạy bộ', unit: 'km', target: 100, span: 'month', icon: 'trend', desc: 'Tổng quãng đường chạy trong tháng.' },
];
const SPAN_LABEL = { month: 'Tháng này', quarter: '3 tháng', year: '12 tháng' };

function spanDates(span) {
  const t = today();
  if (span === 'month') return [startOfMonth(t), endOfMonth(t)];
  if (span === 'quarter') return [t, addDays(addMonths(t, 3), -1)];
  return [t, addDays(addMonths(t, 12), -1)];
}

const unitTxt = (u) => (u ? ` ${u}` : '');
const fmtVal = (v, u) => `${dec(Math.round(Number(v) * 100) / 100)}${unitTxt(u)}`;
/** "1.250,5" / "1,5" / "1250.5" → number */
function parseNum(s) {
  let t = String(s ?? '').trim().replace(/\s/g, '');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
const rate = (perDay, u) => {
  if (perDay == null) return '—';
  const w = perDay * 7;
  return `${w > 0 ? '+' : ''}${dec(Math.round(w * 100) / 100)}${unitTxt(u)}/tuần`;
};

export default async function kpiPage(root, { query }) {
  let tab = STATUS[query.tab] ? query.tab : 'active';
  let fsFilter = FC[query.fs] ? query.fs : '';
  let kpis = [];
  let records = [];
  let fc = new Map();
  let detail = null; // { id, render, close }
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '05',
      kicker: 'Mục tiêu KPI',
      title: 'Những con số <em>dẫn đường</em>',
      lede: 'Mỗi lần cập nhật là một ảnh chụp giá trị thực tế. Hệ thống tính tốc độ bằng hồi quy tuyến tính để dự báo bạn có kịp hạn không.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} KPI mới</button>`,
    })}
    <section data-strip>${loadingBlock(150)}</section>
    <div class="tabs kp-tabs" role="tablist" data-tabs></div>
    <div data-body>${loadingBlock(320)}</div>`);

  const $ = (s) => root.querySelector(s);
  const recsOf = (id) => records.filter((r) => r.kpi_id === id);
  const fOf = (k) => fc.get(k.id) || { status: 'no_data', progress_pct: 0, records: 0 };
  const progressOf = (k) => (k.target_value > 0 ? (k.current_value / k.target_value) * 100 : 0);

  /* ================================================================ */
  /* Summary strip                                                     */
  /* ================================================================ */
  function renderStrip() {
    const active = kpis.filter((k) => k.status === 'active');
    const box = $('[data-strip]');
    if (!active.length) { box.innerHTML = ''; return; }
    const counts = Object.fromEntries(FC_ORDER.map((s) => [s, 0]));
    active.forEach((k) => { counts[fOf(k).status] = (counts[fOf(k).status] || 0) + 1; });
    const good = counts.on_track + counts.achieved;
    const risky = counts.at_risk + counts.off_track;
    const avg = active.reduce((s, k) => s + Math.min(100, progressOf(k)), 0) / active.length;
    const soon = active
      .filter((k) => k.end_date && fOf(k).status !== 'achieved' && diffDays(k.end_date, today()) >= 0)
      .sort((a, b) => a.end_date.localeCompare(b.end_date))[0];
    mount(box, html`
      <section class="sheet sheet--ticked kp-strip" aria-label="Tổng quan KPI">
        <div class="kp-strip__lead">
          <span class="eyebrow">§ 05.1 · Tổng quan</span>
          <p class="kp-strip__headline"><strong>${good}</strong><span class="kp-strip__of">/${active.length}</span><span class="kp-strip__cap">KPI đúng tiến độ${counts.achieved ? ` (${counts.achieved} đã đạt)` : ''}</span></p>
          <p class="kp-strip__note">${risky
            ? html`<span class="danger-text">${icon('alert')} ${risky} KPI có rủi ro hoặc chệch hướng</span> — ưu tiên cập nhật & tăng tốc.`
            : counts.no_data ? `${counts.no_data} KPI cần thêm số liệu để dự báo.` : 'Mọi mục tiêu đang đi đúng hướng.'}</p>
        </div>
        <div class="kp-strip__dist">
          <div class="kp-dist" role="img" aria-label="${FC_ORDER.map((s) => `${FC[s].label}: ${counts[s]}`).join(', ')}">
            ${FC_ORDER.filter((s) => counts[s]).map((s) => html`<i style="flex-grow:${counts[s]};--c:${FC[s].color}" title="${FC[s].label}: ${counts[s]}"></i>`)}
          </div>
          <div class="kp-legend" role="group" aria-label="Lọc theo dự báo">
            ${FC_ORDER.map((s) => html`<button type="button" class="kp-legend__item" data-fs="${s}" aria-pressed="${fsFilter === s}" ${counts[s] ? '' : raw('disabled')}>
              <i style="--c:${FC[s].color}"></i><span>${FC[s].label}</span><strong class="num">${counts[s]}</strong></button>`)}
          </div>
        </div>
        <div class="kp-strip__side">
          ${ring(avg, { size: 72, color: 'var(--accent)' })}
          <div>
            <span class="eyebrow">Tiến độ TB</span>
            ${soon ? html`<p class="kp-strip__soon">Gần hạn nhất: <strong>${soon.name}</strong><span class="num faint"> · ${diffDays(soon.end_date, today()) === 0 ? 'hôm nay' : `còn ${diffDays(soon.end_date, today())} ngày`}</span></p>` : html`<p class="kp-strip__soon faint">Không có hạn chót sắp tới.</p>`}
          </div>
        </div>
      </section>`);
  }

  /* ================================================================ */
  /* Cards                                                             */
  /* ================================================================ */
  function render() {
    renderStrip();
    mount($('[data-tabs]'), html`${Object.entries(STATUS).map(([k, s]) => html`<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${s.label}<span class="count">${kpis.filter((x) => x.status === k).length}</span></button>`)}`);
    if (!kpis.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({
        art: 'target',
        title: 'Đặt mục tiêu đầu tiên',
        text: 'Chọn một mẫu như Doanh số tháng, Giờ học hay Đọc sách — hoặc tự đặt con số của riêng bạn.',
        action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Tạo KPI</button>`,
      })}</div>`);
      return;
    }
    let list = kpis.filter((k) => k.status === tab);
    if (fsFilter && tab === 'active') list = list.filter((k) => fOf(k).status === fsFilter);
    list.sort((a, b) => FC[fOf(a).status].rank - FC[fOf(b).status].rank || String(a.end_date || '9999').localeCompare(String(b.end_date || '9999')));
    const filterNote = fsFilter && tab === 'active'
      ? html`<div class="kp-filter"><span>Đang lọc: <span class="badge badge--${FC[fsFilter].badge}">${FC[fsFilter].label}</span></span><button class="btn btn--sm btn--ghost" data-fs-clear>${icon('x')} Bỏ lọc</button></div>`
      : '';
    if (!list.length) {
      mount($('[data-body]'), html`${filterNote}<div class="sheet">${emptyState({ art: 'target', small: true, title: `Không có KPI “${STATUS[tab].label.toLowerCase()}”` })}</div>`);
      return;
    }
    mount($('[data-body]'), html`${filterNote}<div class="kp-grid">${list.map(card)}</div>`);
  }

  function card(k) {
    const f = fOf(k);
    const meta = FC[f.status];
    const p = progressOf(k);
    const recs = recsOf(k.id);
    const left = k.end_date ? diffDays(k.end_date, today()) : null;
    const exp = f.expected_pct;
    return html`
      <article class="sheet kp-card" data-id="${k.id}" data-forecast="${f.status}" style="--c:${meta.color}">
        <header class="kp-card__head">
          ${ring(p, { size: 76, color: meta.color })}
          <div class="grow">
            <div class="row-wrap">
              <span class="badge badge--${meta.badge}">${meta.label}</span>
              ${k.status !== 'active' ? html`<span class="badge badge--${STATUS[k.status].badge} badge--outline">${STATUS[k.status].label}</span>` : ''}
            </div>
            <h3 class="kp-card__name"><button type="button" data-act="detail">${k.name}</button></h3>
            <p class="kp-card__period num">${day(k.start_date)} → ${k.end_date ? day(k.end_date, 'medium') : 'không thời hạn'}${left != null && k.status === 'active'
              ? html` · <span class="${left < 0 ? 'danger-text' : left <= 7 ? 'kp-soon' : ''}">${left < 0 ? `trễ ${-left} ngày` : left === 0 ? 'hạn hôm nay' : `còn ${left} ngày`}</span>` : ''}</p>
          </div>
          <button class="icon-btn kp-touch" data-act="menu" aria-label="Thao tác với ${k.name}">${icon('more')}</button>
        </header>
        <dl class="kp-card__nums">
          <div><dt>Hiện tại</dt><dd><strong>${dec(k.current_value)}</strong><small>${k.unit}</small></dd></div>
          <div><dt>Mục tiêu</dt><dd><strong>${dec(k.target_value)}</strong><small>${k.unit}</small></dd></div>
          <div><dt>Dự báo cuối kỳ</dt><dd><strong class="${f.projected_value != null && f.projected_value < k.target_value ? 'kp-short' : ''}">${f.projected_value != null ? dec(Math.round(f.projected_value * 10) / 10) : '—'}</strong>${f.projected_value != null ? html`<small>${k.unit}</small>` : ''}</dd></div>
        </dl>
        <div class="kp-card__track">
          <div class="bar"><span style="width:${Math.min(100, p)}%;--c:${meta.color}"></span>${exp != null ? html`<i class="bar__marker" style="left:${Math.min(100, exp)}%"></i>` : ''}</div>
          <div class="kp-card__trackcap num"><span>${pct(p)} mục tiêu</span>${exp != null ? html`<span class="faint">kỳ vọng hôm nay ${pct(exp)}</span>` : ''}</div>
        </div>
        <div class="kp-card__spark" data-act="detail" title="Xem lịch sử">${spark(k, f, recs)}</div>
        <footer class="kp-card__foot">
          <span class="kp-card__eta">${eta(k, f)}</span>
          ${k.status !== 'archived' ? html`
            <form class="kp-quick" data-quick novalidate>
              <input class="input" name="value" inputmode="decimal" autocomplete="off" aria-label="Giá trị hôm nay${k.unit ? ` (${k.unit})` : ''}" placeholder="Giá trị hôm nay" />
              <button class="btn btn--primary" type="submit" aria-label="Ghi nhận giá trị hôm nay">${icon('plus')}<span>Ghi</span></button>
            </form>` : ''}
        </footer>
      </article>`;
  }

  function eta(k, f) {
    if (f.status === 'achieved') return html`${icon('checkCircle')}<span>Đã chạm mục tiêu</span>`;
    if (f.records < 2) return html`${icon('info')}<span class="faint">Ghi ≥ 2 ngày khác nhau để dự báo</span>`;
    if (f.projected_completion) {
      const late = k.end_date && f.projected_completion > k.end_date ? diffDays(f.projected_completion, k.end_date) : 0;
      return html`${icon('flag')}<span>Dự kiến đạt <strong class="num">${day(f.projected_completion, 'medium')}</strong>${late ? html` · <span class="danger-text">trễ ${late} ngày</span>` : ''}</span>`;
    }
    return html`${icon('alert')}<span class="danger-text">Chưa tăng — không thể chạm mục tiêu với tốc độ này</span>`;
  }

  /** Inline SVG sparkline: actual (area), target (dashed), projection (dashed). */
  function spark(k, f, recs) {
    const pts = latestPerDay(recs);
    if (pts.length < 2) {
      return html`<span class="kp-card__sparkempty">${pts.length ? 'Cần thêm một lần ghi để thấy xu hướng' : 'Chưa có lần ghi nào'}</span>`;
    }
    const W = 300, H = 64, P = 5;
    const s0 = 0;
    const lastX = diffDays(pts[pts.length - 1][0], k.start_date);
    const endX = k.end_date ? diffDays(k.end_date, k.start_date) : null;
    const todayX = diffDays(today(), k.start_date);
    const x1 = Math.max(lastX, endX ?? todayX, 1);
    const vals = pts.map(([, v]) => v);
    const proj = f.projected_value != null && endX != null && endX > lastX ? f.projected_value : null;
    const y0 = Math.min(0, ...vals);
    const y1 = Math.max(k.target_value, ...vals, proj ?? -Infinity) * 1.04 || 1;
    const X = (x) => (P + ((x - s0) / (x1 - s0)) * (W - 2 * P)).toFixed(1);
    const Y = (v) => (H - P - ((v - y0) / (y1 - y0 || 1)) * (H - 2 * P)).toFixed(1);
    const line = pts.map(([d, v], i) => `${i ? 'L' : 'M'}${X(diffDays(d, k.start_date))} ${Y(v)}`).join(' ');
    const firstX = X(diffDays(pts[0][0], k.start_date));
    const area = `${line} L${X(lastX)} ${H - P} L${firstX} ${H - P} Z`;
    const ty = Y(k.target_value);
    const last = pts[pts.length - 1];
    return raw(`<svg class="kp-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Xu hướng ${pts.length} lần ghi">
      <line class="kp-spark__target" x1="${P}" x2="${W - P}" y1="${ty}" y2="${ty}"/>
      ${todayX > 0 && todayX < x1 ? `<line class="kp-spark__today" x1="${X(todayX)}" x2="${X(todayX)}" y1="${P}" y2="${H - P}"/>` : ''}
      <path class="kp-spark__area" d="${area}"/>
      <path class="kp-spark__line" d="${line}"/>
      ${proj != null ? `<path class="kp-spark__proj" d="M${X(lastX)} ${Y(last[1])} L${X(endX)} ${Y(proj)}"/>` : ''}
      <circle class="kp-spark__dot" cx="${X(lastX)}" cy="${Y(last[1])}" r="3"/>
    </svg>`);
  }

  function latestPerDay(recs) {
    const m = new Map();
    [...recs].sort((a, b) => (a.recorded_on === b.recorded_on ? String(a.created_at).localeCompare(String(b.created_at)) : a.recorded_on.localeCompare(b.recorded_on)))
      .forEach((r) => m.set(r.recorded_on, Number(r.value)));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }

  /* ================================================================ */
  /* Detail                                                            */
  /* ================================================================ */
  function openDetail(k) {
    detail?.close();
    setQuery({ kpi: k.id });
    let destroy = null;
    const m = openModal({
      eyebrow: 'Chi tiết KPI',
      title: k.name,
      size: 'wide',
      onSubmit: null,
      body: html`<div class="kp-detail" data-detail></div>`,
      onClose() {
        destroy?.();
        if (detail?.id === k.id) detail = null;
        setQuery({ kpi: null });
      },
    });
    const box = m.body.querySelector('[data-detail]');
    const doRender = () => {
      const kk = kpis.find((x) => x.id === k.id);
      if (!kk) return m.close();
      m.el.querySelector('#dlg-title').textContent = kk.name;
      destroy?.();
      destroy = renderDetail(box, kk);
    };
    detail = { id: k.id, render: doRender, close: m.close };
    doRender();

    m.el.addEventListener('submit', async (e) => {
      const form = e.target.closest('[data-addrec]');
      if (!form) return;
      e.preventDefault();
      const kk = kpis.find((x) => x.id === k.id);
      const v = parseNum(form.value.value);
      if (!Number.isFinite(v)) { form.value.focus(); return toast.error('Nhập một số hợp lệ.'); }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await addRecord(kk.id, { recorded_on: form.recorded_on.value || today(), value: v, note: form.note.value.trim() || null });
        recordToast(kk, v);
        await load();
      } catch (err) { toast.error(err); } finally { btn.disabled = false; }
    });
    m.el.addEventListener('click', async (e) => {
      const kk = kpis.find((x) => x.id === k.id);
      const ed = e.target.closest('[data-edit-rec]');
      const del = e.target.closest('[data-del-rec]');
      if (e.target.closest('[data-edit-kpi]')) return openKpiForm(kk);
      if (ed) {
        const r = records.find((x) => x.id === ed.dataset.editRec);
        if (r) openRecordForm(kk, r);
      }
      if (del) {
        if (!(await confirmDialog({ title: 'Xóa bản ghi?', message: 'Giá trị hiện tại của KPI sẽ được tính lại theo bản ghi mới nhất còn lại.' }))) return;
        try { await deleteRecord(del.dataset.delRec); toast('Đã xóa bản ghi.'); await load(); } catch (err) { toast.error(err); }
      }
    });
  }

  function insight(k, f) {
    const u = k.unit;
    const left = k.end_date ? diffDays(k.end_date, today()) : null;
    const remaining = k.target_value - k.current_value;
    if (f.status === 'achieved') {
      return { tone: 'success', text: `Bạn đã đạt mục tiêu${left != null && left > 0 ? ` sớm ${left} ngày so với hạn` : ''}. Có thể nâng mục tiêu hoặc đánh dấu hoàn tất.` };
    }
    if (f.records < 2) return { tone: '', text: 'Cần ít nhất 2 lần ghi nhận ở 2 ngày khác nhau để tính tốc độ và dự báo ngày đạt.' };
    if (left != null && left < 0) return { tone: 'danger', text: `Đã quá hạn ${-left} ngày và còn thiếu ${fmtVal(remaining, u)}. Hãy gia hạn hoặc điều chỉnh mục tiêu.` };
    const need = left != null ? remaining / Math.max(1, left) : null;
    if (k.end_date == null) {
      return f.projected_completion
        ? { tone: 'success', text: `Không có hạn chót. Với tốc độ ${rate(f.slope_per_day, u)}, dự kiến đạt vào ${day(f.projected_completion, 'medium')}.` }
        : { tone: 'warning', text: 'Giá trị chưa tăng theo thời gian nên chưa thể dự báo ngày đạt.' };
    }
    if (f.status === 'on_track') {
      return { tone: 'success', text: `Tốc độ hiện tại ${rate(f.slope_per_day, u)} — dự báo đạt ${fmtVal(f.projected_value ?? k.current_value, u)} vào ${day(k.end_date, 'medium')}. Giữ nhịp này.` };
    }
    const projPct = f.projected_value != null ? (f.projected_value / k.target_value) * 100 : null;
    return {
      tone: f.status === 'at_risk' ? 'warning' : 'danger',
      text: `Dự báo cuối kỳ ${projPct != null ? `chỉ đạt khoảng ${pct(projPct)} mục tiêu` : 'chưa chạm mục tiêu'}. Cần khoảng ${rate(need, u)} trong ${left} ngày còn lại (hiện ${rate(f.slope_per_day, u)}).`,
    };
  }

  function renderDetail(box, k) {
    const f = fOf(k);
    const meta = FC[f.status];
    const pts = latestPerDay(recsOf(k.id));
    const recs = [...recsOf(k.id)].sort((a, b) => b.recorded_on.localeCompare(a.recorded_on) || String(b.created_at).localeCompare(String(a.created_at)));
    const ins = insight(k, f);
    const left = k.end_date ? diffDays(k.end_date, today()) : null;
    const prevOf = new Map();
    const asc = [...recs].reverse();
    asc.forEach((r, i) => prevOf.set(r.id, i ? asc[i - 1].value : null));

    mount(box, html`
      <div class="kp-detail__top">
        <div class="row-wrap">
          <span class="badge badge--${meta.badge}">${meta.label}</span>
          <span class="badge badge--${STATUS[k.status].badge} badge--outline">${STATUS[k.status].label}</span>
          <span class="num faint">${day(k.start_date, 'medium')} → ${k.end_date ? day(k.end_date, 'medium') : 'không thời hạn'}</span>
        </div>
        <button type="button" class="btn btn--sm" data-edit-kpi>${icon('edit')} Sửa KPI</button>
      </div>
      ${k.description ? html`<p class="kp-detail__desc">${k.description}</p>` : ''}
      <dl class="kp-detail__stats">
        <div><dt>Hiện tại</dt><dd>${dec(k.current_value)}<small>${k.unit}</small></dd></div>
        <div><dt>Mục tiêu</dt><dd>${dec(k.target_value)}<small>${k.unit}</small></dd></div>
        <div><dt>Tiến độ</dt><dd>${pct(progressOf(k))}</dd></div>
        <div><dt>Kỳ vọng hôm nay</dt><dd>${f.expected_pct != null ? pct(f.expected_pct) : '—'}</dd></div>
        <div><dt>Tốc độ</dt><dd class="kp-detail__rate">${rate(f.slope_per_day, k.unit)}</dd></div>
        <div><dt>Dự kiến đạt</dt><dd>${f.status === 'achieved' ? 'Đã đạt' : f.projected_completion ? day(f.projected_completion, 'medium') : '—'}</dd></div>
      </dl>
      <div class="notice ${ins.tone ? `notice--${ins.tone}` : ''}">${icon(ins.tone === 'danger' || ins.tone === 'warning' ? 'alert' : ins.tone === 'success' ? 'trend' : 'info')}<div>${ins.text}${left != null && left >= 0 && f.status !== 'achieved' ? html` <span class="faint">Còn ${left} ngày.</span>` : ''}</div></div>

      <div class="kp-detail__chartwrap">
        <div class="chart-key"><span><i style="background:var(--accent)"></i>Thực tế</span><span><i class="kp-key-dash" style="--c:var(--accent)"></i>Dự báo</span><span><i class="kp-key-dash" style="--c:var(--ink-3)"></i>Mục tiêu</span>${k.end_date ? html`<span><i class="kp-key-dot"></i>Lộ trình đều</span>` : ''}</div>
        ${pts.length ? html`<div class="chart-box" data-kchart></div>` : emptyState({ art: 'chart', small: true, title: 'Chưa có số liệu', text: 'Ghi giá trị đầu tiên ở ô bên dưới.' })}
      </div>

      ${k.status !== 'archived' ? html`
        <form class="kp-addrec" data-addrec novalidate>
          <div class="field"><label class="field__label" for="kp-v">Giá trị${k.unit ? ` (${k.unit})` : ''}</label><input id="kp-v" class="input" name="value" inputmode="decimal" autocomplete="off" required placeholder="${dec(k.current_value)}" /></div>
          <div class="field"><label class="field__label" for="kp-d">Ngày</label><input id="kp-d" class="input" type="date" name="recorded_on" value="${today()}" max="${today()}" required /></div>
          <div class="field kp-addrec__note"><label class="field__label" for="kp-n">Ghi chú</label><input id="kp-n" class="input" name="note" maxlength="1000" autocomplete="off" placeholder="Không bắt buộc" /></div>
          <button class="btn btn--primary" type="submit">${icon('plus')} Ghi nhận</button>
        </form>
        <p class="kp-hint faint">Nhập <strong>tổng giá trị tính đến ngày ghi</strong> (ảnh chụp), không phải phần tăng thêm. Ghi lại cùng ngày sẽ lấy giá trị mới nhất.</p>` : ''}

      <h3 class="kp-detail__h">Lịch sử <span class="num faint">${recs.length} lần ghi</span></h3>
      ${recs.length
        ? html`<div class="table-wrap"><table class="table kp-table">
            <thead><tr><th>Ngày</th><th class="r">Giá trị</th><th class="r">Thay đổi</th><th class="r">% mục tiêu</th><th>Ghi chú</th><th><span class="sr-only">Thao tác</span></th></tr></thead>
            <tbody>${recs.map((r) => {
              const prev = prevOf.get(r.id);
              const d = prev == null ? null : r.value - prev;
              return html`<tr>
                <td class="num">${day(r.recorded_on, 'medium')}</td>
                <td class="r num"><strong>${dec(r.value)}</strong> <span class="faint">${k.unit}</span></td>
                <td class="r num">${d == null ? html`<span class="faint">—</span>` : html`<span class="delta ${d >= 0 ? 'delta--up' : 'delta--down'}">${d > 0 ? '+' : ''}${dec(Math.round(d * 100) / 100)}</span>`}</td>
                <td class="r num">${pct((r.value / k.target_value) * 100)}</td>
                <td class="muted kp-table__note">${r.note || ''}</td>
                <td class="actions"><span class="row" style="gap:0;justify-content:flex-end">
                  <button type="button" class="icon-btn kp-touch" data-edit-rec="${r.id}" aria-label="Sửa bản ghi ngày ${day(r.recorded_on)}">${icon('edit')}</button>
                  <button type="button" class="icon-btn kp-touch" data-del-rec="${r.id}" aria-label="Xóa bản ghi ngày ${day(r.recorded_on)}">${icon('trash')}</button>
                </span></td>
              </tr>`;
            })}</tbody></table></div>`
        : html`<p class="muted">Chưa có bản ghi nào.</p>`}`);

    const chartBox = box.querySelector('[data-kchart]');
    if (!chartBox) return null;
    return detailChart(chartBox, k, f, pts);
  }

  function detailChart(boxEl, k, f, pts) {
    const p = palette();
    const idx = (d) => diffDays(d, k.start_date);
    const lastX = idx(pts[pts.length - 1][0]);
    const last = pts[pts.length - 1][1];
    const endX = k.end_date ? idx(k.end_date) : null;
    const pcX = f.projected_completion ? idx(f.projected_completion) : null;
    let xMax = Math.max(lastX, idx(today()), endX ?? 0, 1);
    if (endX == null && pcX != null) xMax = Math.max(xMax, Math.min(pcX, lastX + 365));
    const xMin = Math.min(0, idx(pts[0][0]));
    const datasets = [
      { label: 'Thực tế', data: pts.map(([d, v]) => ({ x: idx(d), y: v })), borderColor: p.accent, backgroundColor: p.accent, pointRadius: 3.5, pointHoverRadius: 5, pointBackgroundColor: p.surface, pointBorderWidth: 2, borderWidth: 2, tension: 0, order: 1 },
      { label: 'Mục tiêu', data: [{ x: xMin, y: k.target_value }, { x: xMax, y: k.target_value }], borderColor: p.ink3, borderDash: [5, 4], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, order: 3 },
    ];
    if (endX != null && endX > 0) {
      datasets.push({ label: 'Lộ trình đều', data: [{ x: 0, y: 0 }, { x: endX, y: k.target_value }], borderColor: p.ink4, borderDash: [1, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, order: 4 });
    }
    if (f.slope_per_day != null && f.status !== 'achieved') {
      let toX = endX != null && endX > lastX ? endX : pcX;
      if (toX != null && toX > lastX) {
        toX = Math.min(toX, xMax);
        datasets.push({ label: 'Dự báo', data: [{ x: lastX, y: last }, { x: toX, y: Math.round((last + f.slope_per_day * (toX - lastX)) * 100) / 100 }], borderColor: p.accent, borderDash: [6, 5], borderWidth: 1.5, pointRadius: [0, 3], pointBackgroundColor: p.accent, pointHoverRadius: 3, order: 2 });
      }
    }
    return makeChart(boxEl, {
      type: 'line',
      data: { datasets },
      options: {
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: {
          x: { type: 'linear', min: xMin, max: xMax, ticks: { maxTicksLimit: 6, callback: (v) => day(addDays(k.start_date, Math.round(v))) } },
          y: { beginAtZero: true, ticks: { callback: (v) => dec(v) } },
        },
        plugins: {
          tooltip: {
            filter: (c) => c.dataset.label === 'Thực tế' || (c.dataset.label === 'Dự báo' && c.dataIndex === 1),
            callbacks: {
              title: (c) => (c[0] ? day(addDays(k.start_date, Math.round(c[0].parsed.x)), 'medium') : ''),
              label: (c) => ` ${c.dataset.label}: ${fmtVal(c.parsed.y, k.unit)}`,
            },
          },
        },
      },
    });
  }

  /* ================================================================ */
  /* Forms                                                             */
  /* ================================================================ */
  function recordToast(k, v) {
    const p = (v / k.target_value) * 100;
    toast(p >= 100 ? `Tuyệt vời! “${k.name}” đã chạm mục tiêu.` : `Đã ghi ${fmtVal(v, k.unit)} — ${pct(p)} mục tiêu.`);
  }

  function openKpiForm(k = null) {
    const isNew = !k;
    openModal({
      eyebrow: k ? 'Chỉnh sửa KPI' : 'KPI mới',
      title: k ? k.name : 'Đặt một mục tiêu đo được',
      body: html`<div class="form">
        ${isNew ? html`
          <div class="kp-tpls">
            <span class="eyebrow">Bắt đầu từ mẫu</span>
            <div class="kp-tpls__list">${TEMPLATES.map((t, i) => html`<button type="button" class="kp-tpl" data-tpl="${i}">${icon(t.icon)}<span>${t.name}</span><small>${SPAN_LABEL[t.span]}</small></button>`)}</div>
          </div>` : ''}
        ${field({ label: 'Tên mục tiêu', name: 'name', control: input('name', k?.name, 'maxlength="120" required placeholder="Ví dụ: Đọc sách"') })}
        ${field({ label: 'Mô tả', name: 'description', optional: true, control: textarea('description', k?.description, 'rows="2" maxlength="2000" placeholder="Đo gì, vì sao quan trọng?"') })}
        <div class="form-row ${k ? 'form-row--3' : ''}">
          ${field({ label: 'Giá trị mục tiêu', name: 'target_value', control: input('target_value', k?.target_value, 'inputmode="decimal" required autocomplete="off" placeholder="100"') })}
          ${field({ label: 'Đơn vị', name: 'unit', optional: true, control: input('unit', k?.unit, 'maxlength="20" placeholder="cuốn, km, giờ…"') })}
          ${k ? field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(STATUS).map(([v, s]) => ({ value: v, label: s.label })), k.status) }) : ''}
        </div>
        <div class="form-row">
          ${field({ label: 'Bắt đầu', name: 'start_date', control: input('start_date', k?.start_date || today(), 'type="date" required') })}
          ${field({ label: 'Kết thúc', name: 'end_date', optional: true, hint: 'Có hạn chót thì mới dự báo được “kịp hay không”.', control: input('end_date', k?.end_date || (isNew ? endOfMonth(today()) : ''), 'type="date"') })}
        </div>
        <p class="kp-pace" data-pace></p>
      </div>`,
      submitLabel: k ? 'Lưu' : 'Tạo KPI',
      onOpen(el) {
        const get = (n) => el.querySelector(`[name=${n}]`);
        const pace = () => {
          const t = parseNum(get('target_value').value);
          const s = get('start_date').value, e = get('end_date').value;
          const out = el.querySelector('[data-pace]');
          if (!(t > 0) || !s || !e || e < s) { out.textContent = ''; return; }
          const days = diffDays(e, s) + 1;
          const u = get('unit').value.trim();
          out.textContent = `Lộ trình đều: ≈ ${dec(Math.round((t / days) * 7 * 100) / 100)}${unitTxt(u)}/tuần trong ${days} ngày.`;
        };
        el.addEventListener('input', pace);
        el.addEventListener('click', (e) => {
          const b = e.target.closest('[data-tpl]');
          if (!b) return;
          const t = TEMPLATES[Number(b.dataset.tpl)];
          const [s, en] = spanDates(t.span);
          get('name').value = t.name;
          get('unit').value = t.unit;
          get('target_value').value = String(t.target);
          get('description').value = t.desc;
          get('start_date').value = s;
          get('end_date').value = en;
          el.querySelectorAll('[data-tpl]').forEach((x) => x.classList.toggle('is-on', x === b));
          pace();
          get('target_value').focus();
          get('target_value').select();
        });
        pace();
      },
      validate(v) {
        const e = {};
        if (!v.name) e.name = 'Hãy đặt tên.';
        if (!(parseNum(v.target_value) > 0)) e.target_value = 'Mục tiêu phải là số lớn hơn 0.';
        if (!v.start_date) e.start_date = 'Chọn ngày bắt đầu.';
        if (v.end_date && v.start_date && v.end_date < v.start_date) e.end_date = 'Phải sau ngày bắt đầu.';
        return e;
      },
      async onSubmit(v) {
        const payload = { name: v.name, description: v.description || null, target_value: parseNum(v.target_value), unit: v.unit || '', start_date: v.start_date, end_date: v.end_date || null };
        if (k) payload.status = v.status;
        if (k) await updateKpi(k.id, payload); else await createKpi(payload);
        toast(k ? 'Đã lưu KPI.' : 'Đã tạo KPI. Ghi giá trị đầu tiên để bắt đầu theo dõi.');
        if (!k && tab !== 'active') { tab = 'active'; setQuery({ tab: null }); }
        await load();
      },
    });
  }

  function openRecordForm(k, r = null) {
    openModal({
      eyebrow: r ? 'Sửa bản ghi' : 'Cập nhật số liệu',
      title: k.name,
      size: 'narrow',
      body: html`<div class="form">
        ${r ? '' : html`<div class="notice">${icon('info')}<div>Nhập <strong>tổng giá trị thực tế</strong> tính đến ngày ghi (không phải phần tăng thêm). Hiện tại: <strong class="num">${fmtVal(k.current_value, k.unit)}</strong>.</div></div>`}
        <div class="form-row">
          ${field({ label: `Giá trị${k.unit ? ` (${k.unit})` : ''}`, name: 'value', control: input('value', r ? String(r.value).replace('.', ',') : '', `inputmode="decimal" required autofocus autocomplete="off" placeholder="${dec(k.current_value)}"`) })}
          ${field({ label: 'Ngày ghi nhận', name: 'recorded_on', control: input('recorded_on', r?.recorded_on || today(), `type="date" required max="${today()}"`) })}
        </div>
        ${field({ label: 'Ghi chú', name: 'note', optional: true, control: input('note', r?.note || '', 'maxlength="1000"') })}
      </div>`,
      submitLabel: r ? 'Lưu' : 'Ghi nhận',
      validate(v) {
        const e = {};
        if (!Number.isFinite(parseNum(v.value))) e.value = 'Nhập một số.';
        if (!v.recorded_on) e.recorded_on = 'Chọn ngày.';
        return e;
      },
      async onSubmit(v) {
        const payload = { recorded_on: v.recorded_on, value: parseNum(v.value), note: v.note || null };
        if (r) { await updateRecord(r.id, payload); toast('Đã lưu bản ghi.'); } else { await addRecord(k.id, payload); recordToast(k, payload.value); }
        await load();
      },
    });
  }

  /* ================================================================ */
  /* Data                                                              */
  /* ================================================================ */
  let seq = 0;
  async function load() {
    const my = ++seq;
    try {
      const [ks, rs] = await Promise.all([listKpis(), listAllRecords()]);
      const recs = rs.map((r) => ({ ...r, value: Number(r.value) }));
      const list = ks.map((k) => ({ ...k, target_value: Number(k.target_value), current_value: Number(k.current_value) }));
      const forecast = await forecastAll(list, recs, today());
      if (my !== seq) return;
      kpis = list;
      records = recs;
      fc = forecast;
      render();
      detail?.render();
    } catch (err) {
      if (my !== seq) return;
      mount($('[data-body]'), errorState(err));
      $('[data-strip]').innerHTML = '';
    }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'new') return openKpiForm();
    if (a === 'retry') return load();
    const k = kpis.find((x) => x.id === el.closest('[data-id]')?.dataset.id);
    if (!k) return;
    if (a === 'detail') openDetail(k);
    if (a === 'menu') {
      const setStatus = (s, msg) => async () => { try { await updateKpi(k.id, { status: s }); toast(msg); load(); } catch (err) { toast.error(err); } };
      popMenu(el, [
        { label: 'Xem chi tiết & lịch sử', icon: 'history', onClick: () => openDetail(k) },
        ...(k.status !== 'archived' ? [{ label: 'Cập nhật số liệu…', icon: 'plus', onClick: () => openRecordForm(k) }] : []),
        { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openKpiForm(k) },
        'sep',
        ...(k.status !== 'active' ? [{ label: 'Tiếp tục theo đuổi', icon: 'play', onClick: setStatus('active', 'KPI đã hoạt động lại.') }] : []),
        ...(k.status === 'active' ? [{ label: 'Tạm dừng', icon: 'pause', onClick: setStatus('paused', 'Đã tạm dừng KPI.') }] : []),
        ...(k.status !== 'completed' ? [{ label: 'Đánh dấu hoàn tất', icon: 'checkCircle', onClick: setStatus('completed', 'Chúc mừng! KPI đã hoàn tất.') }] : []),
        ...(k.status !== 'archived' ? [{ label: 'Lưu trữ', icon: 'archive', onClick: setStatus('archived', 'Đã lưu trữ KPI.') }] : []),
        'sep',
        { label: 'Xóa KPI', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: 'Xóa KPI?', message: `“${k.name}” và toàn bộ ${num(recsOf(k.id).length)} bản ghi sẽ bị xóa vĩnh viễn.` }))) return;
          try { await deleteKpi(k.id); toast('Đã xóa KPI.'); load(); } catch (err) { toast.error(err); }
        } },
      ]);
    }
  }));

  disposers.push(on(root, 'submit', '[data-quick]', async (e, form) => {
    e.preventDefault();
    const k = kpis.find((x) => x.id === form.closest('[data-id]')?.dataset.id);
    if (!k) return;
    const inp = form.querySelector('[name=value]');
    const v = parseNum(inp.value);
    if (!Number.isFinite(v)) { inp.focus(); inp.setAttribute('aria-invalid', 'true'); return toast.error('Nhập một số hợp lệ, ví dụ 12 hoặc 12,5.'); }
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await addRecord(k.id, { recorded_on: today(), value: v });
      recordToast(k, v);
      await load();
    } catch (err) { toast.error(err); btn.disabled = false; }
  }));

  disposers.push(on(root, 'click', '[data-tab]', (e, el) => {
    tab = el.dataset.tab;
    setQuery({ tab: tab === 'active' ? null : tab });
    render();
  }));
  disposers.push(on(root, 'click', '[data-fs]', (e, el) => {
    if (el.tagName !== 'BUTTON') return;
    fsFilter = fsFilter === el.dataset.fs ? '' : el.dataset.fs;
    if (fsFilter && tab !== 'active') tab = 'active';
    setQuery({ fs: fsFilter || null, tab: tab === 'active' ? null : tab });
    render();
  }));
  disposers.push(on(root, 'click', '[data-fs-clear]', () => { fsFilter = ''; setQuery({ fs: null }); render(); }));
  disposers.push(onDataChanged((kind) => { if (!kind || kind === 'kpis' || kind === 'kpi') load(); }));

  await load();
  if (query.new) { setQuery({ new: null }); openKpiForm(); }
  if (query.kpi) {
    const k = kpis.find((x) => x.id === query.kpi);
    if (k) openDetail(k); else setQuery({ kpi: null });
  }
  return () => {
    disposers.forEach((d) => d());
    detail?.close();
  };
}
