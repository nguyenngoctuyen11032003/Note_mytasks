import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, ring, popMenu } from '../components/ui.js';
import { emptyState, errorState, loadingBlock } from '../components/states.js';
import { openModal, field, input, textarea, select, confirmDialog } from '../components/modal.js';
import { makeChart, palette, series } from '../components/chart.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { listKpis, createKpi, updateKpi, deleteKpi, listAllRecords, addRecord, deleteRecord, kpiProgress } from '../services/kpis.js';
import { today, diffDays } from '../utils/date.js';
import { dec, day, pct, num } from '../utils/format.js';

const STATUS = {
  active: { label: 'Đang theo đuổi', badge: 'accent' },
  paused: { label: 'Tạm dừng', badge: 'warning' },
  completed: { label: 'Đã đạt', badge: 'success' },
  archived: { label: 'Lưu trữ', badge: 'muted' },
};

export default async function kpiPage(root, { query }) {
  let tab = STATUS[query.tab] ? query.tab : 'active';
  let kpis = [];
  let records = [];
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '05',
      kicker: 'Mục tiêu KPI',
      title: 'Những con số <em>dẫn đường</em>',
      lede: 'Mỗi lần cập nhật là một ảnh chụp giá trị thực tế tại ngày đó. Tiến độ = giá trị mới nhất ÷ mục tiêu.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} KPI mới</button>`,
    })}
    <div class="tabs" role="tablist" data-tabs></div>
    <div data-body>${loadingBlock(320)}</div>`);

  const $ = (s) => root.querySelector(s);
  const recsOf = (id) => records.filter((r) => r.kpi_id === id);

  /** Expected progress if the KPI moved linearly from start to end date. */
  function pace(k) {
    if (!k.end_date) return null;
    const total = diffDays(k.end_date, k.start_date);
    if (total <= 0) return null;
    const elapsed = Math.min(total, Math.max(0, diffDays(today(), k.start_date)));
    return (elapsed / total) * 100;
  }

  function render() {
    mount($('[data-tabs]'), html`${Object.entries(STATUS).map(([k, s]) => html`<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${s.label}<span class="count">${kpis.filter((x) => x.status === k).length}</span></button>`)}`);
    const list = kpis.filter((k) => k.status === tab);
    if (!kpis.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'target', title: 'Đặt mục tiêu đầu tiên', text: 'Ví dụ: Đọc 24 cuốn sách năm nay · Chạy 100 km tháng này · Tiết kiệm 50 triệu.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Tạo KPI</button>` })}</div>`);
      return;
    }
    if (!list.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'target', small: true, title: `Không có KPI “${STATUS[tab].label.toLowerCase()}”` })}</div>`);
      return;
    }
    const colors = series();
    mount($('[data-body]'), html`<div class="kpi-grid">${list.map((k, i) => card(k, colors[i % colors.length]))}</div>`);
    list.forEach((k, i) => sparkline(k, colors[i % colors.length]));
  }

  function card(k, color) {
    const p = kpiProgress(k);
    const exp = pace(k);
    const left = k.end_date ? diffDays(k.end_date, today()) : null;
    const recs = recsOf(k.id);
    const last = recs[recs.length - 1];
    let paceBadge = '';
    if (k.status === 'active' && exp != null) {
      const gap = p - exp;
      paceBadge = gap >= 0 ? html`<span class="badge badge--success">Đúng tiến độ</span>` : gap > -15 ? html`<span class="badge badge--warning">Hơi chậm ${pct(-gap)}</span>` : html`<span class="badge badge--danger">Chậm ${pct(-gap)}</span>`;
    }
    return html`
      <article class="sheet kpi-card" data-id="${k.id}">
        <header class="kpi-card__head">
          ${ring(p, { size: 84, color: p >= 100 ? 'var(--moss)' : color })}
          <div class="grow" style="min-width:0">
            <span class="badge badge--${STATUS[k.status].badge}">${STATUS[k.status].label}</span>
            <h3 class="kpi-card__name" data-act="detail">${k.name}</h3>
            ${k.description ? html`<p class="kpi-card__desc">${k.description}</p>` : ''}
          </div>
          <button class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thao tác">${icon('more')}</button>
        </header>
        <div class="kpi-card__nums">
          <div><span class="eyebrow">Hiện tại</span><strong class="display">${dec(k.current_value)}</strong><small>${k.unit}</small></div>
          <div><span class="eyebrow">Mục tiêu</span><strong class="display">${dec(k.target_value)}</strong><small>${k.unit}</small></div>
          <div><span class="eyebrow">Còn thiếu</span><strong class="display">${dec(Math.max(0, k.target_value - k.current_value))}</strong><small>${k.unit}</small></div>
        </div>
        <div class="kpi-card__track">
          <div class="bar"><span style="width:${Math.min(100, p)}%;--c:${p >= 100 ? 'var(--moss)' : color}"></span>${exp != null ? html`<i class="bar__marker" style="left:${Math.min(100, exp)}%" title="Kỳ vọng theo thời gian: ${pct(exp)}"></i>` : ''}</div>
        </div>
        <div class="chart-box kpi-card__spark" data-spark="${k.id}">${recs.length < 2 ? html`<span class="faint" style="font-size:var(--fs-xs)">${recs.length ? 'Cần ít nhất 2 lần cập nhật để vẽ xu hướng' : 'Chưa có lần cập nhật nào'}</span>` : ''}</div>
        <footer class="kpi-card__foot">
          <span class="muted">${day(k.start_date, 'medium')} → ${k.end_date ? day(k.end_date, 'medium') : 'không thời hạn'}</span>
          ${left != null && k.status === 'active' ? html`<span class="${left < 0 ? 'danger-text' : ''}">${left < 0 ? `Trễ ${-left} ngày` : left === 0 ? 'Hạn hôm nay' : `Còn ${left} ngày`}</span>` : ''}
          ${paceBadge}
          <span class="grow"></span>
          ${last ? html`<span class="faint">Cập nhật ${day(last.recorded_on)}</span>` : ''}
          ${k.status !== 'archived' ? html`<button class="btn btn--sm btn--primary" data-act="record">${icon('plus')} Cập nhật số</button>` : ''}
        </footer>
      </article>`;
  }

  const sparkDisposers = [];
  function sparkline(k, color) {
    const recs = recsOf(k.id);
    if (recs.length < 2) return;
    const box = root.querySelector(`[data-spark="${k.id}"]`);
    const p = palette();
    sparkDisposers.push(makeChart(box, {
      type: 'line',
      data: {
        labels: recs.map((r) => day(r.recorded_on)),
        datasets: [
          { data: recs.map((r) => r.value), borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.3, pointRadius: 0, pointHoverRadius: 3, borderWidth: 1.5 },
          { data: recs.map(() => Number(k.target_value)), borderColor: p.ink4, borderDash: [3, 3], borderWidth: 1, pointRadius: 0, fill: false },
        ],
      },
      options: {
        scales: { x: { display: false }, y: { display: false, beginAtZero: false } },
        plugins: { tooltip: { filter: (c) => c.datasetIndex === 0, callbacks: { label: (c) => ` ${dec(c.raw)} ${k.unit}` } } },
        layout: { padding: 2 },
      },
    }));
  }

  function openKpiForm(k = null) {
    openModal({
      eyebrow: k ? 'Chỉnh sửa KPI' : 'KPI mới',
      title: k ? k.name : 'Đặt một mục tiêu đo được',
      body: html`<div class="form">
        ${field({ label: 'Tên mục tiêu', name: 'name', control: input('name', k?.name, 'maxlength="120" required placeholder="Ví dụ: Đọc sách"') })}
        ${field({ label: 'Mô tả', name: 'description', optional: true, control: textarea('description', k?.description, 'rows="2" maxlength="2000" placeholder="Vì sao mục tiêu này quan trọng?"') })}
        <div class="form-row form-row--3">
          ${field({ label: 'Giá trị mục tiêu', name: 'target_value', control: input('target_value', k?.target_value, 'type="number" step="any" min="0" required inputmode="decimal"') })}
          ${field({ label: 'Đơn vị', name: 'unit', optional: true, control: input('unit', k?.unit, 'maxlength="20" placeholder="cuốn, km, %…"') })}
          ${field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(STATUS).map(([v, s]) => ({ value: v, label: s.label })), k?.status || 'active') })}
        </div>
        <div class="form-row">
          ${field({ label: 'Bắt đầu', name: 'start_date', control: input('start_date', k?.start_date || today(), 'type="date" required') })}
          ${field({ label: 'Kết thúc', name: 'end_date', optional: true, control: input('end_date', k?.end_date, 'type="date"') })}
        </div>
      </div>`,
      submitLabel: k ? 'Lưu' : 'Tạo KPI',
      validate(v) {
        const e = {};
        if (!v.name) e.name = 'Hãy đặt tên.';
        if (!(Number(v.target_value) > 0)) e.target_value = 'Mục tiêu phải lớn hơn 0.';
        if (!v.start_date) e.start_date = 'Chọn ngày bắt đầu.';
        if (v.end_date && v.end_date < v.start_date) e.end_date = 'Phải sau ngày bắt đầu.';
        return e;
      },
      async onSubmit(v) {
        const payload = { name: v.name, description: v.description || null, target_value: Number(v.target_value), unit: v.unit || '', status: v.status, start_date: v.start_date, end_date: v.end_date || null };
        if (k) await updateKpi(k.id, payload); else await createKpi(payload);
        toast(k ? 'Đã lưu KPI.' : 'Đã tạo KPI.');
        load();
      },
    });
  }

  function openRecordForm(k) {
    const recs = recsOf(k.id);
    openModal({
      eyebrow: 'Cập nhật số liệu',
      title: k.name,
      size: 'narrow',
      body: html`<div class="form">
        <div class="notice">${icon('info')}<div>Nhập <strong>tổng giá trị thực tế</strong> tính đến ngày ghi nhận (không phải phần tăng thêm). Hiện tại: <strong class="num">${dec(k.current_value)} ${k.unit}</strong>.</div></div>
        <div class="form-row">
          ${field({ label: `Giá trị (${k.unit || 'đơn vị'})`, name: 'value', control: input('value', '', `type="number" step="any" required autofocus inputmode="decimal" placeholder="${dec(k.current_value)}"`) })}
          ${field({ label: 'Ngày ghi nhận', name: 'recorded_on', control: input('recorded_on', today(), `type="date" required max="${today()}"`) })}
        </div>
        ${field({ label: 'Ghi chú', name: 'note', optional: true, control: input('note', '', 'maxlength="1000"') })}
        ${recs.length ? html`<div><span class="eyebrow">Lần gần nhất</span><ul class="mini-list">${recs.slice(-3).reverse().map((r) => html`<li><span class="num muted">${day(r.recorded_on, 'medium')}</span><span class="grow truncate muted">${r.note || ''}</span><strong class="num">${dec(r.value)}</strong></li>`)}</ul></div>` : ''}
      </div>`,
      submitLabel: 'Ghi nhận',
      validate(v) {
        const e = {};
        if (v.value === '' || !Number.isFinite(Number(v.value))) e.value = 'Nhập một số.';
        if (!v.recorded_on) e.recorded_on = 'Chọn ngày.';
        return e;
      },
      async onSubmit(v) {
        await addRecord(k.id, { recorded_on: v.recorded_on, value: Number(v.value), note: v.note || null });
        const p = (Number(v.value) / k.target_value) * 100;
        toast(p >= 100 ? `Tuyệt vời! “${k.name}” đã đạt mục tiêu.` : `Đã cập nhật — ${pct(p)} mục tiêu.`);
        load();
      },
    });
  }

  function openDetail(k) {
    const recs = [...recsOf(k.id)].reverse();
    const m = openModal({
      eyebrow: 'Lịch sử KPI',
      title: k.name,
      size: 'wide',
      onSubmit: null,
      body: html`
        <div class="chart-box" data-detail-chart style="margin-bottom:var(--s-5)">${recs.length < 2 ? html`<p class="muted">Cần ít nhất 2 lần cập nhật để vẽ biểu đồ.</p>` : ''}</div>
        ${recs.length
          ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Ngày</th><th class="r">Giá trị</th><th class="r">% mục tiêu</th><th>Ghi chú</th><th></th></tr></thead><tbody>
              ${recs.map((r) => html`<tr data-rec="${r.id}"><td class="num">${day(r.recorded_on, 'medium')}</td><td class="r num">${dec(r.value)} ${k.unit}</td><td class="r num">${pct((r.value / k.target_value) * 100)}</td><td class="muted">${r.note || ''}</td><td class="actions"><button class="icon-btn icon-btn--sm" data-del-rec="${r.id}" aria-label="Xóa bản ghi">${icon('trash')}</button></td></tr>`)}
            </tbody></table></div>`
          : emptyState({ art: 'target', small: true, title: 'Chưa có bản ghi nào' })}`,
    });
    if (recs.length >= 2) {
      const asc = [...recs].reverse();
      const p = palette();
      const d = makeChart(m.el.querySelector('[data-detail-chart]'), {
        type: 'line',
        data: { labels: asc.map((r) => day(r.recorded_on)), datasets: [
          { label: 'Giá trị', data: asc.map((r) => r.value), borderColor: p.accent, backgroundColor: p.accent + '1f', fill: true, tension: 0.25, pointRadius: 3, pointBackgroundColor: p.surface, borderWidth: 2 },
          { label: 'Mục tiêu', data: asc.map(() => Number(k.target_value)), borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
        ] },
        options: { scales: { y: { beginAtZero: false } } },
      });
      m.el.addEventListener('close', d);
    }
    m.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-rec]');
      if (!b) return;
      if (!(await confirmDialog({ title: 'Xóa bản ghi?', message: 'Giá trị hiện tại của KPI sẽ được tính lại theo bản ghi mới nhất còn lại.' }))) return;
      try {
        await deleteRecord(b.dataset.delRec);
        b.closest('tr').remove();
        toast('Đã xóa bản ghi.');
        load();
      } catch (err) { toast.error(err); }
    });
  }

  async function load() {
    try {
      [kpis, records] = await Promise.all([listKpis(), listAllRecords()]);
      records = records.map((r) => ({ ...r, value: Number(r.value) }));
      kpis = kpis.map((k) => ({ ...k, target_value: Number(k.target_value), current_value: Number(k.current_value) }));
      sparkDisposers.splice(0).forEach((d) => d());
      render();
    } catch (err) {
      mount($('[data-body]'), errorState(err));
    }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'new') return openKpiForm();
    if (a === 'retry') return load();
    const k = kpis.find((x) => x.id === el.closest('[data-id]')?.dataset.id);
    if (!k) return;
    if (a === 'record') openRecordForm(k);
    if (a === 'detail') openDetail(k);
    if (a === 'menu') {
      const setStatus = (s, msg) => async () => { try { await updateKpi(k.id, { status: s }); toast(msg); load(); } catch (err) { toast.error(err); } };
      popMenu(el, [
        { label: 'Cập nhật số liệu', icon: 'plus', onClick: () => openRecordForm(k) },
        { label: 'Xem lịch sử', icon: 'history', onClick: () => openDetail(k) },
        { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openKpiForm(k) },
        'sep',
        ...(k.status !== 'active' ? [{ label: 'Tiếp tục theo đuổi', icon: 'play', onClick: setStatus('active', 'KPI đã hoạt động lại.') }] : []),
        ...(k.status === 'active' ? [{ label: 'Tạm dừng', icon: 'pause', onClick: setStatus('paused', 'Đã tạm dừng KPI.') }] : []),
        ...(k.status !== 'completed' ? [{ label: 'Đánh dấu đã đạt', icon: 'checkCircle', onClick: setStatus('completed', 'Chúc mừng! KPI đã đạt.') }] : []),
        ...(k.status !== 'archived' ? [{ label: 'Lưu trữ', icon: 'folder', onClick: setStatus('archived', 'Đã lưu trữ KPI.') }] : []),
        'sep',
        { label: 'Xóa KPI', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: 'Xóa KPI?', message: `“${k.name}” và toàn bộ ${num(recsOf(k.id).length)} bản ghi sẽ bị xóa vĩnh viễn.` }))) return;
          try { await deleteKpi(k.id); toast('Đã xóa KPI.'); load(); } catch (err) { toast.error(err); }
        } },
      ]);
    }
  }));
  disposers.push(on(root, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; setQuery({ tab: tab === 'active' ? null : tab }); sparkDisposers.splice(0).forEach((d) => d()); render(); }));
  disposers.push(onDataChanged(load));

  await load();
  if (query.new) { setQuery({ new: null }); openKpiForm(); }
  return () => { disposers.forEach((d) => d()); sparkDisposers.forEach((d) => d()); };
}
