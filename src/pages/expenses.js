import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, catLabel, categoryOptions, bar, popMenu } from '../components/ui.js';
import { emptyState, errorState, loadingRows, loadingBlock, statTileSkeleton } from '../components/states.js';
import { openModal, field, input, select, textarea, confirmDialog } from '../components/modal.js';
import { makeChart, palette } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { listExpenses, createExpense, updateExpense, deleteExpense, PAYMENT_METHODS } from '../services/expenses.js';
import { listBudgets, resolveBudgets, setBudget } from '../services/budgets.js';
import { today, addMonths, startOfMonth, endOfMonth, daysBetween, diffDays } from '../utils/date.js';
import { money, moneyShort, monthLabel, relDay, day, pct, parseMoney, num } from '../utils/format.js';

export default async function expensesPage(root, { query }) {
  const t0 = today();
  let month = /^\d{4}-\d{2}$/.test(query.m || '') ? query.m + '-01' : startOfMonth(t0);
  let rows = [], prevRows = [], budgets = [];
  let charts = [];
  const f = { q: query.q || '', cat: query.cat || '', pm: query.pm || '' };
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '06',
      kicker: 'Chi tiêu',
      title: 'Sổ <em>thu chi</em> hằng ngày',
      lede: 'Ghi lại từng khoản chi, đặt ngân sách theo danh mục và theo dõi bạn còn bao nhiêu cho tháng này.',
      actions: html`<button class="btn" data-act="budget">${icon('piggy')} Ngân sách</button><button class="btn btn--primary" data-act="new">${icon('plus')} Khoản chi mới</button>`,
    })}
    <div class="toolbar">
      <div class="row" style="gap:4px">
        <button class="icon-btn" data-act="prev" aria-label="Tháng trước">${icon('chevronLeft')}</button>
        <h2 class="cal-title" data-title></h2>
        <button class="icon-btn" data-act="next" aria-label="Tháng sau">${icon('chevronRight')}</button>
      </div>
      <button class="btn btn--sm" data-act="this-month">Tháng này</button>
    </div>
    <section class="grid grid-4" data-stats>${statTileSkeleton(4)}</section>
    <section class="grid grid-12" style="margin-top:var(--s-5)">
      <article class="sheet span-7" data-daily>${sheetHead('E.1', 'Nhịp chi tiêu')}<div class="sheet__body">${loadingBlock(240)}</div></article>
      <article class="sheet span-5" data-cats>${sheetHead('E.2', 'Theo danh mục')}${loadingRows(5)}</article>
    </section>
    <div class="toolbar" style="margin-top:var(--s-7)">
      <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Tìm mô tả, ghi chú…" value="${f.q}" data-f="q" aria-label="Tìm khoản chi" /></div>
      <select class="select" data-f="cat" aria-label="Danh mục">${categoryOptions('expense', { all: 'Mọi danh mục', none: 'Chưa phân loại' }).map((o) => html`<option value="${o.value}" ${o.value === f.cat ? raw('selected') : ''}>${o.label}</option>`)}</select>
      <select class="select" data-f="pm" aria-label="Phương thức"><option value="">Mọi phương thức</option>${Object.entries(PAYMENT_METHODS).map(([v, l]) => html`<option value="${v}" ${v === f.pm ? raw('selected') : ''}>${l}</option>`)}</select>
    </div>
    <article class="sheet" data-list>${loadingRows(6)}</article>`);

  const $ = (s) => root.querySelector(s);
  const cats = () => store.categoriesOf('expense');

  function filtered() {
    const q = f.q.toLowerCase();
    return rows.filter((x) =>
      (!f.cat || (f.cat === 'none' ? !x.category_id : x.category_id === f.cat)) &&
      (!f.pm || x.payment_method === f.pm) &&
      (!q || (x.description || '').toLowerCase().includes(q) || (x.note || '').toLowerCase().includes(q)));
  }

  function renderStats() {
    const spent = rows.reduce((s, x) => s + Number(x.amount), 0);
    const prev = prevRows.reduce((s, x) => s + Number(x.amount), 0);
    const { overall, byCategory } = resolveBudgets(budgets, month);
    const budget = overall ?? ([...byCategory.values()].reduce((a, b) => a + b, 0) || null);
    const isCurrent = month === startOfMonth(t0);
    const daysIn = daysBetween(month, endOfMonth(month)).length;
    const elapsed = isCurrent ? diffDays(t0, month) + 1 : month < startOfMonth(t0) ? daysIn : 0;
    const avg = elapsed ? spent / elapsed : 0;
    const projected = isCurrent ? avg * daysIn : spent;
    const change = prev ? ((spent - prev) / prev) * 100 : null;
    const remaining = budget != null ? budget - spent : null;

    mount($('[data-stats]'), html`
      <div class="stat stat--accent">
        <div class="stat__label"><span class="eyebrow">Đã chi</span><span class="stat__icon">${icon('wallet')}</span></div>
        <div class="stat__value" style="font-size:var(--fs-2xl)">${money(spent)}</div>
        <div class="stat__meta">${change != null ? html`<span class="delta ${change > 0 ? 'delta--down' : 'delta--up'}">${change > 0 ? '+' : ''}${pct(change)}</span><span>so với tháng trước</span>` : html`<span>${num(rows.length)} khoản chi</span>`}</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Ngân sách</span><span class="stat__icon">${icon('piggy')}</span></div>
        <div class="stat__value" style="font-size:var(--fs-2xl)">${budget != null ? money(budget) : '—'}</div>
        <div class="stat__meta" style="display:grid;gap:6px;width:100%">${budget != null ? html`${bar((spent / budget) * 100, { thin: true, over: spent > budget, color: 'var(--ink)' })}<span>${pct((spent / budget) * 100)} đã dùng${overall == null ? ' · tổng theo danh mục' : ''}</span>` : html`<button class="btn btn--sm" data-act="budget">Đặt ngân sách</button>`}</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Còn lại</span><span class="stat__icon">${icon('coin')}</span></div>
        <div class="stat__value ${remaining != null && remaining < 0 ? 'danger-text' : ''}" style="font-size:var(--fs-2xl)">${remaining != null ? money(remaining) : '—'}</div>
        <div class="stat__meta">${remaining != null && isCurrent && remaining > 0 ? html`<span>≈ ${money(remaining / Math.max(1, daysIn - elapsed + 1))} / ngày cho ${daysIn - elapsed + 1} ngày còn lại</span>` : remaining != null && remaining < 0 ? html`<span class="danger-text">Vượt ngân sách</span>` : html`<span></span>`}</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">${isCurrent ? 'Dự kiến cuối tháng' : 'Trung bình / ngày'}</span><span class="stat__icon">${icon('trend')}</span></div>
        <div class="stat__value" style="font-size:var(--fs-2xl)">${money(isCurrent ? projected : avg)}</div>
        <div class="stat__meta">${isCurrent ? html`<span>TB ${money(avg)} / ngày</span>${budget != null && projected > budget ? html`<span class="delta delta--down">vượt ${moneyShort(projected - budget)}</span>` : ''}` : html`<span>${daysIn} ngày</span>`}</div>
      </div>`);
  }

  function renderDaily() {
    const days = daysBetween(month, endOfMonth(month));
    const per = Object.fromEntries(days.map((d) => [d, 0]));
    rows.forEach((x) => { if (x.spent_on in per) per[x.spent_on] += Number(x.amount); });
    let acc = 0;
    const cum = days.map((d) => (d <= t0 ? (acc += per[d]) : null));
    const { overall, byCategory } = resolveBudgets(budgets, month);
    const budget = overall ?? ([...byCategory.values()].reduce((a, b) => a + b, 0) || null);
    mount($('[data-daily]'), html`${sheetHead('E.1', 'Nhịp chi tiêu', html`<div class="chart-key"><span><i style="background:var(--ink)"></i>Mỗi ngày</span><span><i style="background:var(--accent);height:2px"></i>Lũy kế</span>${budget ? html`<span><i style="border-top:1px dashed var(--ink-3);height:0"></i>Ngân sách</span>` : ''}</div>`)}<div class="sheet__body"><div class="chart-box" data-c></div></div>`);
    const p = palette();
    const ds = [
      { type: 'bar', label: 'Chi trong ngày', data: days.map((d) => per[d]), backgroundColor: days.map((d) => (d === t0 ? p.accent : p.ink)), borderRadius: 2, maxBarThickness: 14, yAxisID: 'y' },
      { type: 'line', label: 'Lũy kế', data: cum, borderColor: p.accent, borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'y1' },
    ];
    if (budget) ds.push({ type: 'line', label: 'Ngân sách', data: days.map(() => budget), borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, yAxisID: 'y1' });
    charts.push(makeChart($('[data-daily] [data-c]'), {
      type: 'bar',
      data: { labels: days.map((d) => Number(d.slice(8))), datasets: ds },
      options: {
        scales: { y: { ticks: { callback: (v) => moneyShort(v) } }, y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, ticks: { callback: (v) => moneyShort(v), maxTicksLimit: 4 } } },
        plugins: { tooltip: { callbacks: { title: (c) => day(days[c[0].dataIndex], 'weekday'), label: (c) => ` ${c.dataset.label}: ${money(c.raw)}` } } },
      },
    }));
  }

  function renderCats() {
    const { byCategory } = resolveBudgets(budgets, month);
    const sums = new Map();
    rows.forEach((x) => sums.set(x.category_id || 'none', (sums.get(x.category_id || 'none') || 0) + Number(x.amount)));
    const list = cats().map((c) => ({ c, spent: sums.get(c.id) || 0, budget: byCategory.get(c.id) ?? null }))
      .concat(sums.has('none') ? [{ c: null, spent: sums.get('none'), budget: null }] : [])
      .filter((r) => r.spent > 0 || r.budget)
      .sort((a, b) => b.spent - a.spent);
    const head = sheetHead('E.2', 'Theo danh mục', html`<button class="btn btn--ghost btn--sm" data-act="budget">${icon('edit')} Ngân sách</button>`);
    if (!list.length) {
      mount($('[data-cats]'), html`${head}${emptyState({ art: 'wallet', small: true, title: 'Chưa có dữ liệu', text: 'Chưa có khoản chi hay ngân sách nào cho tháng này.' })}`);
      return;
    }
    const max = Math.max(...list.map((r) => Math.max(r.spent, r.budget || 0)));
    mount($('[data-cats]'), html`${head}
      <ul class="list catbars">
        ${list.map((r) => {
          const over = r.budget != null && r.spent > r.budget;
          return html`<li data-cat="${r.c?.id || 'none'}">
            <div class="row between">
              ${r.c ? catLabel(r.c.id) : catLabel(null)}
              <span class="num ${over ? 'danger-text' : ''}">${money(r.spent)}${r.budget != null ? html`<span class="faint"> / ${moneyShort(r.budget)}</span>` : ''}</span>
            </div>
            <div class="catbars__track">
              <span class="catbars__fill" style="width:${(r.spent / max) * 100}%;--c:${over ? 'var(--danger)' : r.c?.color || 'var(--ink-4)'}"></span>
              ${r.budget != null ? html`<i class="catbars__budget" style="left:${(r.budget / max) * 100}%" title="Ngân sách ${money(r.budget)}"></i>` : ''}
            </div>
            ${r.budget != null ? html`<div class="catbars__note ${over ? 'danger-text' : 'muted'}">${over ? `Vượt ${money(r.spent - r.budget)}` : `Còn ${money(r.budget - r.spent)} · ${pct((r.spent / r.budget) * 100)}`}</div>` : ''}
          </li>`;
        })}
      </ul>`);
  }

  function renderList() {
    const list = filtered();
    const total = list.reduce((s, x) => s + Number(x.amount), 0);
    if (!rows.length) {
      mount($('[data-list]'), html`${emptyState({ art: 'wallet', title: 'Chưa có khoản chi nào trong tháng', text: 'Ghi lại khoản chi đầu tiên — bạn có thể gõ “45k” hoặc “1,2tr” cho nhanh.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Ghi khoản chi</button>` })}`);
      return;
    }
    if (!list.length) {
      mount($('[data-list]'), html`${emptyState({ art: 'wallet', small: true, title: 'Không có khoản chi phù hợp', action: html`<button class="btn btn--sm" data-act="clear">Xóa bộ lọc</button>` })}`);
      return;
    }
    const groups = new Map();
    list.forEach((x) => (groups.get(x.spent_on) || groups.set(x.spent_on, []).get(x.spent_on)).push(x));
    mount($('[data-list]'), html`
      ${[...groups.entries()].map(([d, items]) => html`
        <div class="group-head"><span class="group-head__day">${relDay(d)}<small>${day(d, 'numeric')}</small></span><span class="group-head__sum">${money(items.reduce((s, x) => s + Number(x.amount), 0))}</span></div>
        <ul class="list">${items.map((x) => html`
          <li class="expense-row" data-id="${x.id}">
            <span class="expense-row__icon" style="--c:${store.categoryById(x.category_id)?.color || 'var(--ink-4)'}">${icon('coin')}</span>
            <div class="grow" style="min-width:0" data-act="edit">
              <div class="truncate" style="font-weight:500">${x.description || store.categoryById(x.category_id)?.name || 'Khoản chi'}</div>
              <div class="row-wrap" style="margin-top:2px">${catLabel(x.category_id)}<span class="faint" style="font-size:var(--fs-xs)">· ${PAYMENT_METHODS[x.payment_method]}</span>${x.note ? html`<span class="muted truncate" style="font-size:var(--fs-xs)">· ${x.note}</span>` : ''}</div>
            </div>
            <span class="expense-row__amt num">−${money(x.amount)}</span>
            <button class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thao tác">${icon('more')}</button>
          </li>`)}</ul>`)}
      <div class="sheet__foot"><span>${list.length} khoản chi</span><strong class="num">${money(total)}</strong></div>`);
  }

  function renderAll() {
    charts.forEach((d) => d());
    charts = [];
    $('[data-title]').textContent = monthLabel(month);
    renderStats();
    renderDaily();
    renderCats();
    renderList();
  }

  /* ---------- forms ---------- */
  function moneyInput(name, value) {
    return html`<div class="input-group"><input id="__ID__" class="input has-suffix num" name="${name}" value="${value ? String(Math.round(value)) : ''}" inputmode="decimal" autocomplete="off" placeholder="Ví dụ: 45k, 1,2tr, 250000" /><span class="input-group__suffix">${store.get().profile?.currency || 'VND'}</span></div>`;
  }

  function bindMoneyPreview(el, name) {
    const inp = el.querySelector(`[name="${name}"]`);
    const hint = inp.closest('.field').querySelector('.field__hint');
    const upd = () => { const n = parseMoney(inp.value); hint.textContent = inp.value && Number.isFinite(n) ? `= ${money(n)}` : 'Gõ “k” cho nghìn, “tr” cho triệu'; };
    inp.addEventListener('input', upd);
    upd();
  }

  function openExpenseForm(x = null) {
    openModal({
      eyebrow: x ? 'Sửa khoản chi' : 'Khoản chi mới',
      title: x ? x.description || 'Khoản chi' : 'Ghi một khoản chi',
      body: html`<div class="form">
        <div class="form-row">
          ${field({ label: 'Số tiền', name: 'amount', hint: ' ', control: moneyInput('amount', x?.amount) })}
          ${field({ label: 'Ngày chi', name: 'spent_on', control: input('spent_on', x?.spent_on || (month === startOfMonth(t0) ? t0 : month), 'type="date" required') })}
        </div>
        ${field({ label: 'Mô tả', name: 'description', optional: true, control: input('description', x?.description, 'maxlength="200" placeholder="Ví dụ: Cà phê với đồng nghiệp"') })}
        <div class="form-row">
          ${field({ label: 'Danh mục', name: 'category_id', control: select('category_id', categoryOptions('expense', { all: '— Chưa phân loại —' }), x?.category_id || f.cat.replace('none', '')) })}
          ${field({ label: 'Thanh toán bằng', name: 'payment_method', control: select('payment_method', Object.entries(PAYMENT_METHODS).map(([v, l]) => ({ value: v, label: l })), x?.payment_method || 'cash') })}
        </div>
        ${field({ label: 'Ghi chú', name: 'note', optional: true, control: textarea('note', x?.note, 'rows="2" maxlength="1000"') })}
      </div>`,
      submitLabel: x ? 'Lưu' : 'Ghi khoản chi',
      footExtra: x ? html`<button type="button" class="btn btn--danger-ghost btn--sm" data-del>${icon('trash')} Xóa</button>` : '',
      onOpen(el) {
        bindMoneyPreview(el, 'amount');
        el.querySelector('[name=amount]').focus();
        el.querySelector('[data-del]')?.addEventListener('click', async () => {
          if (await removeExpense(x)) el.close(), el.remove();
        });
      },
      validate(v) {
        const e = {};
        const n = parseMoney(v.amount);
        if (!Number.isFinite(n) || n <= 0) e.amount = 'Nhập số tiền lớn hơn 0.';
        if (!v.spent_on) e.spent_on = 'Chọn ngày.';
        return e;
      },
      async onSubmit(v) {
        const payload = { amount: parseMoney(v.amount), spent_on: v.spent_on, description: v.description || null, category_id: v.category_id || null, payment_method: v.payment_method, note: v.note || null };
        if (x) await updateExpense(x.id, payload); else await createExpense(payload);
        toast(x ? 'Đã lưu khoản chi.' : `Đã ghi ${money(payload.amount)}.`);
        if (startOfMonth(payload.spent_on) !== month) { month = startOfMonth(payload.spent_on); setQuery({ m: month.slice(0, 7) }); }
        load();
      },
    });
  }

  async function removeExpense(x) {
    if (!(await confirmDialog({ title: 'Xóa khoản chi?', message: `${money(x.amount)} — ${x.description || 'khoản chi'} ngày ${day(x.spent_on, 'medium')} sẽ bị xóa.` }))) return false;
    try { await deleteExpense(x.id); toast('Đã xóa khoản chi.'); load(); return true; } catch (err) { toast.error(err); return false; }
  }

  function openBudgetForm() {
    const { overall, byCategory } = resolveBudgets(budgets, month);
    const sums = new Map();
    rows.forEach((x) => sums.set(x.category_id, (sums.get(x.category_id) || 0) + Number(x.amount)));
    openModal({
      eyebrow: `Ngân sách từ ${monthLabel(month)}`,
      title: 'Đặt ngân sách',
      size: 'wide',
      body: html`
        <div class="notice" style="margin-bottom:var(--s-5)">${icon('info')}<div>Ngân sách <strong>áp dụng từ tháng này trở đi</strong> cho đến khi bạn thay đổi — các tháng trước giữ nguyên. Để trống hoặc 0 = không đặt ngân sách.</div></div>
        <div class="form">
          ${field({ label: 'Ngân sách tổng cho cả tháng', name: 'overall', hint: ' ', control: moneyInput('overall', overall) })}
          <div class="budget-grid">
            ${cats().map((c) => html`
              <div class="budget-grid__row">
                ${catLabel(c.id)}
                <span class="faint num" style="font-size:var(--fs-xs)">đã chi ${moneyShort(sums.get(c.id) || 0)}</span>
                <input class="input input--sm num" name="cat_${c.id}" value="${byCategory.get(c.id) ? String(Math.round(byCategory.get(c.id))) : ''}" inputmode="decimal" placeholder="—" aria-label="Ngân sách ${c.name}" />
              </div>`)}
          </div>
        </div>`,
      submitLabel: 'Lưu ngân sách',
      onOpen: (el) => bindMoneyPreview(el, 'overall'),
      validate(v) {
        const e = {};
        for (const [k, val] of Object.entries(v)) if (val && !(parseMoney(val) >= 0)) e[k] = 'Số tiền không hợp lệ.';
        return e;
      },
      async onSubmit(v) {
        const jobs = [];
        const want = (val) => (val ? parseMoney(val) : 0);
        if (want(v.overall) !== (overall ?? 0)) jobs.push(setBudget({ month, categoryId: null, amount: want(v.overall) }));
        for (const c of cats()) {
          const n = want(v[`cat_${c.id}`]);
          if (n !== (byCategory.get(c.id) ?? 0)) jobs.push(setBudget({ month, categoryId: c.id, amount: n }));
        }
        if (!jobs.length) return;
        await Promise.all(jobs);
        toast(`Đã cập nhật ${jobs.length} ngân sách.`);
        load();
      },
    });
  }

  /* ---------- data ---------- */
  async function load() {
    try {
      const pm = addMonths(month, -1);
      [rows, prevRows, budgets] = await Promise.all([
        listExpenses({ from: month, to: endOfMonth(month) }),
        listExpenses({ from: pm, to: endOfMonth(pm) }),
        listBudgets(),
      ]);
      renderAll();
    } catch (err) {
      mount($('[data-stats]'), html`<div style="grid-column:1/-1">${errorState(err)}</div>`);
    }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'new') return openExpenseForm();
    if (a === 'budget') return openBudgetForm();
    if (a === 'retry') return load();
    if (a === 'prev' || a === 'next' || a === 'this-month') {
      month = a === 'this-month' ? startOfMonth(t0) : addMonths(month, a === 'prev' ? -1 : 1);
      setQuery({ m: month === startOfMonth(t0) ? null : month.slice(0, 7) });
      return load();
    }
    if (a === 'clear') { Object.assign(f, { q: '', cat: '', pm: '' }); root.querySelectorAll('[data-f]').forEach((i) => (i.value = '')); persist(); return renderList(); }
    const x = rows.find((r) => r.id === el.closest('[data-id]')?.dataset.id);
    if (!x) return;
    if (a === 'edit') openExpenseForm(x);
    if (a === 'menu') popMenu(el, [
      { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openExpenseForm(x) },
      { label: 'Nhân bản cho hôm nay', icon: 'refresh', onClick: async () => {
        try { const { id, created_at, updated_at, category, ...rest } = x; await createExpense({ ...rest, spent_on: t0 }); toast('Đã nhân bản khoản chi.'); load(); } catch (err) { toast.error(err); }
      } },
      'sep',
      { label: 'Xóa', icon: 'trash', danger: true, onClick: () => removeExpense(x) },
    ]);
  }));
  disposers.push(on(root, 'click', '.catbars li', (e, el) => {
    f.cat = el.dataset.cat === f.cat ? '' : el.dataset.cat;
    root.querySelector('[data-f="cat"]').value = f.cat;
    persist(); renderList();
    root.querySelector('[data-list]').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const onSearch = debounce(() => { persist(); renderList(); }, 160);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', 'select[data-f]', (e, el) => { f[el.dataset.f] = el.value; persist(); renderList(); }));
  disposers.push(onDataChanged(load));
  function persist() { setQuery({ q: f.q || null, cat: f.cat || null, pm: f.pm || null }); }

  await load();
  if (query.new) { setQuery({ new: null }); openExpenseForm(); }
  return () => { disposers.forEach((d) => d()); charts.forEach((d) => d()); };
}
