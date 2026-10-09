// Shopping list — a planning layer. Money only counts once an expense is
// recorded: ticking an item off (1 tap) marks it purchased AND files the
// expense at the planned price (undoable); "Đã mua với giá khác…" records the
// price actually paid. Purchased history links back to the expense.
import { html, mount, on } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, catLabel, categoryOptions, prio, popMenu, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, loadingBlock, statTileSkeleton } from '../components/states.js';
import { openModal, field, input, select, textarea, confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import * as store from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged, disposeOnAbort } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import {
  listShopping, createItem, updateItem, deleteItem, purchaseWithPrice, revertPurchase, SHOP_STATUS, SHOP_PRIORITY,
} from '../services/shopping.js';
import { PAYMENT_METHODS, getExpensesByIds, updateExpense } from '../services/expenses.js';
import { parseShoppingInput } from '../services/smart/expenseParser.js';
import { suggestCategory as suggestLocal } from '../services/smart/categorizer.js';
import { today, startOfMonth } from '../utils/date.js';
import { money, moneyShort, monthLabel, relDay, num, parseMoney } from '../utils/format.js';

const TABS = ['planned', 'wishlist', 'purchased', 'cancelled'];
const TAB_LABEL = { planned: 'Cần mua', wishlist: 'Mong muốn', purchased: 'Đã mua', cancelled: 'Bỏ qua' };
const PRIO_ORDER = ['must_buy', 'high', 'medium', 'low'];
const PM_KEY = 'nm:xp:pm';

function readPm() { try { return localStorage.getItem(PM_KEY) || 'cash'; } catch { return 'cash'; } }
function writePm(v) { try { localStorage.setItem(PM_KEY, v); } catch { /* private mode */ } }

export default async function shoppingPage(root, { query, signal }) {
  let tab = TABS.includes(query.tab) ? query.tab : 'planned';
  let items = [];
  let expMap = new Map();
  let alive = true;
  let loaded = false;
  const busy = new Set();
  const f = { q: '', cat: '', sort: 'priority', group: 'priority' };
  const qa = { status: 'planned', catId: null, manual: false };
  const disposers = [];
  disposeOnAbort(signal, disposers); // released on navigation even if this page never returns
  const t0 = today();

  mount(root, html`
    ${pageHead({
      kicker: 'Mua sắm',
      title: 'Danh sách cần mua',
      lede: 'Lên kế hoạch trước khi chi. Chạm vào ô tròn khi đã mua — món được ghi thành khoản chi ngay, và bạn luôn có thể hoàn tác hay sửa giá thực tế.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Thêm món</button>`,
    })}
    <form class="sp-quick" data-quick autocomplete="off">
      <div class="sp-quick__bar">
        <span class="sp-quick__glyph" aria-hidden="true">${icon('cart')}</span>
        <input class="sp-quick__input" data-quick-input type="text" enterkeyhint="done" spellcheck="false"
          placeholder="Thêm nhanh, ví dụ: sữa tắm 120k x2" aria-label="Thêm nhanh món cần mua" aria-describedby="sp-quick-preview" />
        <div class="segmented sp-quick__seg" role="group" aria-label="Thêm vào">
          <button type="button" data-qstatus="planned" aria-pressed="true">Cần mua</button>
          <button type="button" data-qstatus="wishlist" aria-pressed="false">Mong muốn</button>
        </div>
        <button type="submit" class="btn btn--primary btn--sm" data-quick-go disabled>${icon('plus')} Thêm</button>
      </div>
      <div class="sp-quick__preview" id="sp-quick-preview" data-quick-preview aria-live="polite"></div>
    </form>
    <section class="grid grid-4 sp-stats" data-stats>${statTileSkeleton(4)}</section>
    <div class="tabs" role="tablist" data-tabs style="margin-top:var(--s-6)"></div>
    <div class="toolbar sp-toolbar" data-toolbar>
      <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Tìm món, ghi chú…" data-f="q" aria-label="Tìm món" /></div>
      <select class="select" data-f="cat" aria-label="Lọc danh mục">${categoryOptions('expense', { all: 'Mọi danh mục', none: 'Chưa phân loại' }).map((o) => html`<option value="${o.value}">${o.label}</option>`)}</select>
      <select class="select" data-f="sort" aria-label="Sắp xếp">
        <option value="priority">Ưu tiên cao trước</option>
        <option value="price">Giá cao trước</option>
        <option value="recent">Mới thêm</option>
        <option value="name">Tên A–Z</option>
      </select>
      <span class="toolbar__spacer"></span>
      <div class="segmented" role="group" aria-label="Nhóm theo" data-groupby></div>
    </div>
    <div data-body>${loadingBlock(300)}</div>`);

  const $ = (s) => root.querySelector(s);
  const cats = () => store.categoriesOf('expense');
  const catName = (id) => store.categoryById(id)?.name || 'Chưa phân loại';
  const isOpen = (i) => i.status === 'planned' || i.status === 'wishlist';
  const actualOf = (i) => (i.expense_id && expMap.has(i.expense_id) ? Number(expMap.get(i.expense_id).amount) : null);
  const spentOf = (i) => actualOf(i) ?? Number(i.total_price);

  /* ---------- quick add ---------- */
  function parsedQuick() {
    const text = $('[data-quick-input]').value.trim();
    if (!text) return null;
    const p = parseShoppingInput(text);
    if (!qa.manual) {
      const hist = items.filter((i) => i.category_id).map((i) => ({ description: i.name, category_id: i.category_id }));
      qa.catId = p.name ? suggestLocal(p.name, { history: hist, categories: cats() })[0]?.category_id || null : null;
    }
    return p;
  }

  function renderQuick() {
    const p = parsedQuick();
    const box = $('[data-quick-preview]');
    $('[data-quick-go]').disabled = !p?.name;
    root.querySelectorAll('[data-qstatus]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.qstatus === qa.status)));
    if (!p) {
      mount(box, html`<span class="sp-quick__hint"><kbd>x2</kbd> số lượng · <kbd>!</kbd> ưu tiên cao · <kbd>!!</kbd> hoặc “gấp” = phải mua · giá như <kbd>120k</kbd>, <kbd>2,5tr</kbd></span>`);
      return;
    }
    const total = (p.unit_price || 0) * p.quantity;
    mount(box, html`
      <span class="sp-pill sp-pill--strong">${p.name || 'Thiếu tên món'}</span>
      <span class="sp-pill">${p.unit_price ? html`${p.quantity > 1 ? `${p.quantity} × ${moneyShort(p.unit_price)} = ` : ''}<strong class="num">${money(total)}</strong>` : html`<span class="faint">Chưa có giá</span>`}</span>
      ${p.priority ? html`<span class="sp-pill">${prio(p.priority, SHOP_PRIORITY)}</span>` : ''}
      <button type="button" class="sp-pill sp-pill--btn" data-act="qcat" style="--c:${store.categoryById(qa.catId)?.color || 'var(--ink-4)'}"><i class="sp-pill__dot"></i>${catName(qa.catId)}${!qa.manual && qa.catId ? html`<span class="sp-pill__tag">${icon('sparkle')} gợi ý</span>` : ''}${icon('chevronDown')}</button>
      <span class="sp-pill sp-pill--ghost">→ ${TAB_LABEL[qa.status]}</span>`);
  }

  async function saveQuick() {
    const p = parsedQuick();
    if (!p?.name) { toast.error('Hãy nhập tên món.'); return; }
    const go = $('[data-quick-go]');
    go.disabled = true;
    try {
      await createItem({ name: p.name, unit_price: p.unit_price || 0, quantity: p.quantity, priority: p.priority || 'medium', status: qa.status, category_id: qa.catId || null });
      toast(`Đã thêm “${p.name}” vào ${TAB_LABEL[qa.status].toLowerCase()}.`);
      $('[data-quick-input]').value = '';
      qa.manual = false; qa.catId = null;
      if (tab !== qa.status) { tab = qa.status; setQuery({ tab: tab === 'planned' ? null : tab }); }
      renderQuick();
      await load();
      $('[data-quick-input]')?.focus();
    } catch (err) { toast.error(err); go.disabled = false; }
  }

  /* ---------- stats ---------- */
  function renderStats() {
    const open = (st) => items.filter((i) => i.status === st);
    const tot = (list) => list.reduce((s, i) => s + Number(i.total_price), 0);
    const planned = open('planned');
    const noPrice = planned.filter((i) => !(i.total_price > 0)).length;
    const must = items.filter((i) => i.priority === 'must_buy' && isOpen(i));
    const m0 = startOfMonth(t0);
    const bought = items.filter((i) => i.status === 'purchased' && i.purchased_on >= m0);
    const boughtActual = bought.reduce((s, i) => s + spentOf(i), 0);
    const boughtPlanned = tot(bought);
    const diff = boughtActual - boughtPlanned;
    mount($('[data-stats]'), html`
      <div class="stat stat--accent"><div class="stat__label"><span class="eyebrow">Cần mua</span><span class="stat__icon">${icon('cart')}</span></div>
        <div class="stat__value sp-stat__v">${money(tot(planned))}</div>
        <div class="stat__meta"><span>${num(planned.length)} món${noPrice ? ` · ${noPrice} chưa có giá` : ''}</span></div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Phải mua</span><span class="stat__icon">${icon('flag')}</span></div>
        <div class="stat__value sp-stat__v ${must.length ? 'danger-text' : ''}">${num(must.length)}<small>món</small></div>
        <div class="stat__meta"><span>${must.length ? money(tot(must)) : 'Không có món gấp'}</span></div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Mong muốn</span><span class="stat__icon">${icon('sparkle')}</span></div>
        <div class="stat__value sp-stat__v">${money(tot(open('wishlist')))}</div>
        <div class="stat__meta"><span>${num(open('wishlist').length)} món để dành</span></div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Đã mua tháng này</span><span class="stat__icon">${icon('bag')}</span></div>
        <div class="stat__value sp-stat__v">${money(boughtActual)}</div>
        <div class="stat__meta">${bought.length
          ? html`<span>${num(bought.length)} món</span>${Math.abs(diff) >= 1 ? html`<span class="delta ${diff > 0 ? 'delta--down' : 'delta--up'}">${diff > 0 ? 'vượt' : 'tiết kiệm'} ${moneyShort(Math.abs(diff))}</span><span>so với dự tính</span>` : html`<span>đúng dự tính</span>`}`
          : html`<span>Chưa mua món nào</span>`}</div></div>`);
  }

  /* ---------- list ---------- */
  function visible() {
    const q = f.q.trim().toLowerCase();
    return items.filter((i) => i.status === tab &&
      (!f.cat || (f.cat === 'none' ? !i.category_id : i.category_id === f.cat)) &&
      (!q || i.name.toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q)));
  }
  const sorters = {
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.total_price - a.total_price,
    price: (a, b) => b.total_price - a.total_price,
    recent: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
    name: (a, b) => a.name.localeCompare(b.name, 'vi'),
  };

  function render() {
    mount($('[data-tabs]'), html`${TABS.map((t) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${tab === t}">${TAB_LABEL[t]}<span class="count">${items.filter((i) => i.status === t).length}</span></button>`)}`);
    mount($('[data-groupby]'), isOpen({ status: tab })
      ? html`<button type="button" data-group="priority" aria-pressed="${f.group === 'priority'}">Ưu tiên</button><button type="button" data-group="category" aria-pressed="${f.group === 'category'}">Danh mục</button>`
      : '');
    $('[data-groupby]').hidden = !isOpen({ status: tab });
    // The purchased tab is always ordered by purchase date (grouped by month).
    $('[data-f="sort"]').hidden = tab === 'purchased';
    if (!items.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'cart', title: 'Danh sách đang trống', text: 'Gõ vào ô “Thêm nhanh” phía trên — ví dụ “sữa tắm 120k x2” — để mỗi lần chi tiêu đều có chủ đích.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Thêm món đầu tiên</button>` })}</div>`);
      return;
    }
    const list = visible();
    if (!list.length) {
      const any = items.some((i) => i.status === tab);
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'cart', small: true, title: any ? 'Không có món phù hợp bộ lọc' : tab === 'planned' ? 'Đã mua hết — tuyệt!' : `Chưa có món nào ở mục “${TAB_LABEL[tab]}”`, action: any ? html`<button class="btn btn--sm" data-act="clear">Xóa bộ lọc</button>` : '' })}</div>`);
      return;
    }
    if (tab === 'purchased') return renderPurchased(list);
    list.sort(sorters[f.sort]);
    const groups = new Map();
    if (tab === 'cancelled') groups.set('all', list);
    else if (f.group === 'category') {
      list.forEach((i) => { const k = i.category_id || 'none'; (groups.get(k) || groups.set(k, []).get(k)).push(i); });
    } else {
      PRIO_ORDER.forEach((p) => { const g = list.filter((i) => i.priority === p); if (g.length) groups.set(p, g); });
    }
    const total = list.reduce((s, i) => s + Number(i.total_price), 0);
    const noPrice = list.filter((i) => !(i.total_price > 0)).length;
    mount($('[data-body]'), html`
      <div class="sp-groups">
        ${[...groups.entries()].map(([k, g]) => html`
          <section class="sheet sp-group">
            <header class="sp-group__head">
              ${tab === 'cancelled' ? html`<span class="sp-group__title">Đã bỏ qua</span>`
                : f.group === 'category' ? html`<span class="sp-group__title">${catLabel(k === 'none' ? null : k)}</span>`
                : html`<span class="sp-group__title">${prio(k, SHOP_PRIORITY)}</span>`}
              <span class="sp-group__meta"><span>${num(g.length)} món</span><strong class="num">${money(g.reduce((s, i) => s + Number(i.total_price), 0))}</strong></span>
            </header>
            <ul class="list sp-rows">${g.map(rowTpl)}</ul>
          </section>`)}
      </div>
      <div class="sp-total">
        <span>${num(list.length)} món${noPrice ? html` · <span class="faint">${noPrice} chưa có giá</span>` : ''}</span>
        <span>${tab === 'cancelled' ? 'Đã bỏ qua' : 'Tổng dự tính'} <strong class="num">${money(total)}</strong></span>
      </div>`);
  }

  function rowTpl(i) {
    const open = isOpen(i);
    return html`<li class="sp-row ${busy.has(i.id) ? 'is-busy' : ''} ${i.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${i.id}">
      ${open
        ? html`<button type="button" class="sp-check" data-act="buy" aria-label="Đã mua “${i.name}”" title="${i.total_price > 0 ? `Đã mua · ghi ${money(i.total_price)} vào chi tiêu` : 'Đã mua · nhập giá thực tế'}">${icon('check')}</button>`
        : html`<button type="button" class="sp-check sp-check--muted" data-act="restore" aria-label="Khôi phục “${i.name}”" title="Đưa lại vào danh sách cần mua">${icon('undo')}</button>`}
      <div class="sp-row__main" data-act="edit" role="button" tabindex="0" aria-label="Sửa “${i.name}”">
        <span class="sp-row__name">${i.name}</span>
        <span class="sp-row__meta">
          ${f.group === 'category' && open ? prio(i.priority, SHOP_PRIORITY) : catLabel(i.category_id)}
          ${i.quantity > 1 ? html`<span class="faint num">${i.quantity} × ${moneyShort(i.unit_price)}</span>` : ''}
          ${i.url ? html`<a href="${i.url}" target="_blank" rel="noopener noreferrer" class="sp-row__link" title="Mở liên kết sản phẩm">${icon('link')}<span>Liên kết</span></a>` : ''}
          ${i.note ? html`<span class="faint truncate">${i.note}</span>` : ''}
        </span>
      </div>
      <span class="sp-row__price num ${i.total_price > 0 ? '' : 'faint'}">${i.total_price > 0 ? money(i.total_price) : 'Chưa có giá'}</span>
      <button type="button" class="icon-btn icon-btn--sm sp-row__menu" data-act="menu" aria-label="Thao tác cho “${i.name}”">${icon('more')}</button>
    </li>`;
  }

  function renderPurchased(list) {
    list.sort((a, b) => (b.purchased_on || '').localeCompare(a.purchased_on || '') || (b.updated_at || '').localeCompare(a.updated_at || ''));
    const months = new Map();
    list.forEach((i) => { const k = (i.purchased_on || t0).slice(0, 7); (months.get(k) || months.set(k, []).get(k)).push(i); });
    const total = list.reduce((s, i) => s + spentOf(i), 0);
    mount($('[data-body]'), html`
      <div class="sp-groups">
        ${[...months.entries()].map(([m, g]) => {
          const actual = g.reduce((s, i) => s + spentOf(i), 0);
          return html`<section class="sheet sp-group">
            <header class="sp-group__head"><span class="sp-group__title sp-group__title--month">${monthLabel(m)}</span>
              <span class="sp-group__meta"><span>${num(g.length)} món</span><strong class="num">${money(actual)}</strong></span></header>
            <ul class="list sp-rows">${g.map(boughtTpl)}</ul>
          </section>`;
        })}
      </div>
      <div class="sp-total"><span>${num(list.length)} món đã mua</span><span>Thực chi <strong class="num">${money(total)}</strong></span></div>`);
  }

  function boughtTpl(i) {
    const actual = actualOf(i);
    const planned = Number(i.total_price);
    const diff = actual != null ? actual - planned : 0;
    return html`<li class="sp-row is-bought" data-id="${i.id}">
      <span class="sp-check is-done" aria-hidden="true">${icon('check')}</span>
      <div class="sp-row__main" data-act="edit" role="button" tabindex="0" aria-label="Sửa “${i.name}”">
        <span class="sp-row__name">${i.name}</span>
        <span class="sp-row__meta">
          <span class="faint">${relDay(i.purchased_on)}</span>
          ${catLabel(i.category_id)}
          ${i.expense_id
            ? html`<a class="sp-row__exp" href="#/expenses?period=day&date=${i.purchased_on}&focus=${i.expense_id}" title="Xem khoản chi đã ghi">${icon('wallet')}<span>Khoản chi</span>${icon('arrowRight')}</a>`
            : html`<span class="badge badge--muted">Không ghi chi</span>`}
        </span>
      </div>
      <span class="sp-row__price num">
        ${money(actual ?? planned)}
        ${actual != null && Math.abs(diff) >= 1 ? html`<small class="${diff > 0 ? 'danger-text' : 'success-text'}">${diff > 0 ? '+' : '−'}${moneyShort(Math.abs(diff))} so với ${moneyShort(planned)}</small>` : ''}
      </span>
      <button type="button" class="icon-btn icon-btn--sm sp-row__menu" data-act="menu" aria-label="Thao tác cho “${i.name}”">${icon('more')}</button>
    </li>`;
  }

  /* ---------- actions ---------- */
  async function quickBuy(i) {
    if (busy.has(i.id)) return;
    if (!(i.total_price > 0)) return openBuyForm(i);
    busy.add(i.id);
    root.querySelector(`.sp-row[data-id="${CSS.escape(i.id)}"]`)?.classList.add('is-busy');
    const prevStatus = i.status;
    const pm = readPm();
    try {
      const row = await purchaseWithPrice(i, { paymentMethod: pm, createExpense: true });
      toast(`Đã mua “${i.name}” · ghi ${money(i.total_price)} (${PAYMENT_METHODS[pm]}).`, {
        duration: 6000,
        action: { label: 'Hoàn tác', onClick: () => undoBuy(row, prevStatus) },
      });
    } catch (err) { toast.error(err); }
    busy.delete(i.id);
    if (alive) load();
  }

  async function undoBuy(row, status) {
    try { await revertPurchase(row, { status, removeExpense: true }); toast.info('Đã hoàn tác — món trở lại danh sách.'); } catch (err) { toast.error(err); }
    if (alive) load();
  }

  function openBuyForm(i) {
    const planned = Number(i.total_price);
    openModal({
      eyebrow: 'Đánh dấu đã mua',
      title: i.name,
      size: 'narrow',
      body: html`<div class="form">
        <div class="buy-sum"><span class="eyebrow">Dự tính</span><strong class="display">${planned > 0 ? money(planned) : '—'}</strong>${i.quantity > 1 ? html`<span class="muted num">${i.quantity} × ${money(i.unit_price)}</span>` : ''}</div>
        ${field({ label: 'Giá thực tế (tổng)', name: 'actual', hint: ' ', control: html`<div class="input-group"><input id="__ID__" class="input has-suffix num sp-buy__amt" name="actual" value="${planned > 0 ? String(Math.round(planned)) : ''}" inputmode="decimal" autocomplete="off" placeholder="Ví dụ: 250k" /><span class="input-group__suffix">${store.get().profile?.currency || 'VND'}</span></div>` })}
        ${field({ label: 'Ngày mua', name: 'purchased_on', control: input('purchased_on', t0, `type="date" required max="${t0}"`) })}
        <label class="check"><input type="checkbox" name="create_expense" checked /> Ghi thành khoản chi</label>
        <div class="form-row" data-exp-fields>
          ${field({ label: 'Danh mục chi', name: 'expense_category', control: select('expense_category', categoryOptions('expense', { all: '— Chưa phân loại —' }), i.category_id) })}
          ${field({ label: 'Thanh toán', name: 'payment_method', control: select('payment_method', Object.entries(PAYMENT_METHODS).map(([v, l]) => ({ value: v, label: l })), readPm()) })}
        </div>
      </div>`,
      submitLabel: 'Xác nhận đã mua',
      onOpen(el) {
        const cb = el.querySelector('[name=create_expense]');
        const box = el.querySelector('[data-exp-fields]');
        const amt = el.querySelector('[name=actual]');
        const hint = amt.closest('.field').querySelector('.field__hint');
        const upd = () => {
          box.style.display = cb.checked ? '' : 'none';
          const n = parseMoney(amt.value);
          if (!amt.value || !Number.isFinite(n)) { hint.textContent = 'Gõ “k” cho nghìn, “tr” cho triệu'; return; }
          const d = n - planned;
          hint.textContent = planned > 0 && Math.abs(d) >= 1 ? `= ${money(n)} · ${d > 0 ? 'cao hơn' : 'thấp hơn'} dự tính ${money(Math.abs(d))}` : `= ${money(n)}`;
        };
        cb.addEventListener('change', upd); amt.addEventListener('input', upd); upd();
        amt.select?.();
      },
      validate(v) {
        const e = {};
        if (!v.purchased_on) e.purchased_on = 'Chọn ngày mua.';
        const n = v.actual ? parseMoney(v.actual) : 0;
        if (v.actual && !(n >= 0)) e.actual = 'Giá không hợp lệ.';
        if (v.create_expense && !(n > 0)) e.actual = 'Nhập giá để ghi thành khoản chi (hoặc bỏ chọn “Ghi thành khoản chi”).';
        return e;
      },
      async onSubmit(v) {
        const actual = v.actual ? parseMoney(v.actual) : null;
        if (v.payment_method) writePm(v.payment_method);
        const prevStatus = i.status;
        const row = await purchaseWithPrice(i, { actualTotal: actual, spentOn: v.purchased_on, paymentMethod: v.payment_method || 'cash', createExpense: v.create_expense, expenseCategoryId: v.expense_category || null });
        toast(v.create_expense ? `Đã mua và ghi ${money(actual)} vào chi tiêu.` : 'Đã đánh dấu đã mua.', { action: { label: 'Hoàn tác', onClick: () => undoBuy(row, prevStatus) } });
        if (alive) load();
      },
    });
  }

  function openActualForm(i) {
    const cur = actualOf(i) ?? Number(i.total_price);
    openModal({
      eyebrow: 'Giá thực tế',
      title: i.name,
      size: 'narrow',
      body: html`<div class="form">
        <p class="muted">Cập nhật số tiền của khoản chi đã ghi. Giá dự tính của món (${money(i.total_price)}) được giữ nguyên để so sánh.</p>
        ${field({ label: 'Số tiền đã trả', name: 'amount', hint: ' ', control: html`<div class="input-group"><input id="__ID__" class="input has-suffix num" name="amount" value="${String(Math.round(cur))}" inputmode="decimal" autocomplete="off" /><span class="input-group__suffix">${store.get().profile?.currency || 'VND'}</span></div>` })}
      </div>`,
      submitLabel: 'Lưu giá',
      onOpen(el) {
        const amt = el.querySelector('[name=amount]');
        const hint = amt.closest('.field').querySelector('.field__hint');
        const upd = () => { const n = parseMoney(amt.value); hint.textContent = Number.isFinite(n) ? `= ${money(n)}` : ''; };
        amt.addEventListener('input', upd); upd(); amt.select?.();
      },
      validate: (v) => (parseMoney(v.amount) > 0 ? {} : { amount: 'Nhập số tiền lớn hơn 0.' }),
      async onSubmit(v) {
        await updateExpense(i.expense_id, { amount: parseMoney(v.amount) });
        toast('Đã cập nhật giá thực tế.');
        if (alive) load();
      },
    });
  }

  function openItemForm(i = null, preset = {}) {
    openModal({
      eyebrow: i ? 'Sửa món' : 'Món mới',
      title: i ? i.name : 'Thêm vào danh sách mua sắm',
      body: html`<div class="form">
        ${field({ label: 'Tên món', name: 'name', control: input('name', i?.name ?? preset.name ?? '', 'maxlength="200" required placeholder="Ví dụ: Tai nghe chống ồn"') })}
        <div class="form-row">
          ${field({ label: 'Đơn giá (ước tính)', name: 'unit_price', hint: ' ', control: input('unit_price', i ? (i.unit_price ? String(Math.round(i.unit_price)) : '') : '', 'inputmode="decimal" placeholder="Ví dụ: 2,5tr"') })}
          ${field({ label: 'Số lượng', name: 'quantity', control: input('quantity', i?.quantity ?? 1, 'type="number" min="1" max="9999" step="1" required inputmode="numeric"') })}
        </div>
        <div class="form-row">
          ${field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(SHOP_STATUS).filter(([v]) => v !== 'purchased' || i?.status === 'purchased').map(([v]) => ({ value: v, label: TAB_LABEL[v] })), i?.status || (tab === 'wishlist' ? 'wishlist' : 'planned')) })}
          ${field({ label: 'Độ ưu tiên', name: 'priority', control: select('priority', Object.entries(SHOP_PRIORITY).map(([v, l]) => ({ value: v, label: l })), i?.priority || 'medium') })}
        </div>
        ${field({ label: 'Danh mục chi tiêu', name: 'category_id', control: select('category_id', categoryOptions('expense', { all: '— Chưa phân loại —' }), i?.category_id) })}
        ${field({ label: 'Liên kết sản phẩm', name: 'url', optional: true, control: input('url', i?.url, 'type="url" placeholder="https://…"') })}
        ${field({ label: 'Ghi chú', name: 'note', optional: true, control: textarea('note', i?.note, 'rows="2" maxlength="1000"') })}
      </div>`,
      submitLabel: i ? 'Lưu' : 'Thêm món',
      footExtra: i ? html`<button type="button" class="btn btn--danger-ghost btn--sm" data-del data-close>${icon('trash')} Xóa</button>` : '',
      onOpen(el) {
        const inp = el.querySelector('[name=unit_price]');
        const q = el.querySelector('[name=quantity]');
        const hint = inp.closest('.field').querySelector('.field__hint');
        const upd = () => { const n = parseMoney(inp.value); hint.textContent = Number.isFinite(n) ? `Thành tiền: ${money(n * (Number(q.value) || 1))}` : 'Gõ “k” cho nghìn, “tr” cho triệu'; };
        inp.addEventListener('input', upd); q.addEventListener('input', upd); upd();
        el.querySelector('[data-del]')?.addEventListener('click', () => removeItem(i));
      },
      validate(v) {
        const e = {};
        if (!v.name) e.name = 'Hãy nhập tên món.';
        if (v.unit_price && !(parseMoney(v.unit_price) >= 0)) e.unit_price = 'Giá không hợp lệ.';
        if (!(Number.isInteger(Number(v.quantity)) && v.quantity >= 1 && v.quantity <= 9999)) e.quantity = 'Từ 1 đến 9999.';
        if (v.url && !/^https?:\/\//i.test(v.url)) e.url = 'Liên kết phải bắt đầu bằng http:// hoặc https://';
        return e;
      },
      async onSubmit(v) {
        const payload = { name: v.name, unit_price: v.unit_price ? parseMoney(v.unit_price) : 0, quantity: Number(v.quantity), status: v.status, priority: v.priority, category_id: v.category_id || null, url: v.url || null, note: v.note || null, purchased_on: v.status === 'purchased' ? i?.purchased_on || t0 : null };
        if (i && i.status === 'purchased' && payload.status !== 'purchased') {
          // Leaving "purchased" un-does the purchase: offer to drop the filed expense so it isn't counted twice on re-buy.
          let removeExpense = false;
          if (i.expense_id) {
            removeExpense = await confirmDialog({
              title: 'Xóa khoản chi đã ghi?',
              message: `“${i.name}” sẽ không còn ở mục Đã mua. Xóa luôn khoản chi ${money(spentOf(i))} đã ghi cho món này?`,
              confirmLabel: 'Xóa khoản chi', cancelLabel: 'Giữ khoản chi',
            });
          }
          await revertPurchase(i, { status: payload.status, removeExpense });
          const { status, purchased_on, ...rest } = payload;
          await updateItem(i.id, rest);
        } else if (i) await updateItem(i.id, payload); else await createItem(payload);
        toast(i ? 'Đã lưu món.' : 'Đã thêm vào danh sách.');
        if (!i && payload.status !== tab) { tab = payload.status; setQuery({ tab: tab === 'planned' ? null : tab }); }
        if (alive) load();
      },
    });
  }

  async function removeItem(i) {
    if (!(await confirmDialog({ title: 'Xóa món này?', message: `“${i.name}” sẽ bị xóa khỏi danh sách.${i.expense_id ? ' Khoản chi đã ghi vẫn được giữ.' : ''}` }))) return;
    try { await deleteItem(i.id); toast('Đã xóa.'); if (alive) load(); } catch (err) { toast.error(err); }
  }

  async function move(i, s) {
    try {
      await updateItem(i.id, { status: s, purchased_on: null });
      toast(`Đã chuyển sang “${TAB_LABEL[s]}”.`, { action: { label: 'Hoàn tác', onClick: async () => { try { await updateItem(i.id, { status: i.status, purchased_on: null }); if (alive) load(); } catch (err) { toast.error(err); } } } });
      if (alive) load();
    } catch (err) { toast.error(err); }
  }

  /* ---------- data ---------- */
  async function load() {
    try {
      const all = await listShopping();
      const ids = all.filter((i) => i.status === 'purchased' && i.expense_id).sort((a, b) => (b.purchased_on || '').localeCompare(a.purchased_on || '')).slice(0, 500).map((i) => i.expense_id);
      const exps = ids.length ? await getExpensesByIds(ids).catch(() => []) : [];
      if (!alive) return;
      items = all.map((i) => ({ ...i, unit_price: Number(i.unit_price), total_price: Number(i.total_price), quantity: Number(i.quantity) }));
      expMap = new Map(exps.map((x) => [x.id, x]));
      loaded = true;
      renderStats();
      render();
    } catch (err) {
      if (!alive) return;
      if (!loaded) mount($('[data-stats]'), '');
      mount($('[data-body]'), errorState(err));
    }
  }

  /* ---------- events ---------- */
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    if (e.target.closest('a')) return; // product / expense links navigate normally
    const a = el.dataset.act;
    if (a === 'new') return openItemForm();
    if (a === 'retry') return load();
    if (a === 'clear') {
      Object.assign(f, { q: '', cat: '' });
      root.querySelector('[data-f="q"]').value = ''; root.querySelector('[data-f="cat"]').value = '';
      return render();
    }
    if (a === 'qcat') {
      const pick = (id) => () => { qa.catId = id; qa.manual = true; renderQuick(); $('[data-quick-input]').focus(); };
      return popMenu(el, [...cats().map((c) => ({ label: c.name, icon: c.id === qa.catId ? 'check' : 'tag', onClick: pick(c.id) })), 'sep', { label: 'Chưa phân loại', icon: 'x', onClick: pick(null) }]);
    }
    const i = items.find((x) => x.id === el.closest('[data-id]')?.dataset.id);
    if (!i) return;
    if (a === 'edit') return openItemForm(i);
    if (a === 'buy') return quickBuy(i);
    if (a === 'restore') return move(i, 'planned');
    if (a === 'menu') {
      const open = isOpen(i);
      popMenu(el, [
        { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openItemForm(i) },
        ...(open ? [
          { label: i.total_price > 0 ? `Đã mua · ${moneyShort(i.total_price)}` : 'Đã mua…', icon: 'bag', onClick: () => quickBuy(i) },
          { label: 'Đã mua với giá khác…', icon: 'coin', onClick: () => openBuyForm(i) },
        ] : []),
        ...(i.status === 'purchased' && i.expense_id ? [
          { label: 'Sửa giá thực tế…', icon: 'coin', onClick: () => openActualForm(i) },
          { label: 'Xem khoản chi', icon: 'wallet', onClick: () => { location.hash = `#/expenses?period=day&date=${i.purchased_on}&focus=${i.expense_id}`; } },
        ] : []),
        ...(i.status === 'purchased' ? [{ label: i.expense_id ? 'Hoàn tác mua (xóa khoản chi)' : 'Hoàn tác mua', icon: 'undo', onClick: async () => {
          if (i.expense_id && !(await confirmDialog({ title: 'Hoàn tác mua?', message: `“${i.name}” trở lại danh sách cần mua và khoản chi ${money(spentOf(i))} đã ghi sẽ bị xóa.`, confirmLabel: 'Hoàn tác' }))) return;
          undoBuy(i, 'planned');
        } }] : []),
        'sep',
        ...['planned', 'wishlist', 'cancelled'].filter((s) => s !== i.status && i.status !== 'purchased').map((s) => ({ label: `Chuyển sang “${TAB_LABEL[s]}”`, icon: s === 'cancelled' ? 'x' : 'arrowRight', onClick: () => move(i, s) })),
        { label: 'Xóa', icon: 'trash', danger: true, onClick: () => removeItem(i) },
      ]);
    }
  }));
  disposers.push(on(root, 'keydown', '.sp-row__main', (e, el) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const i = items.find((x) => x.id === el.closest('[data-id]')?.dataset.id);
    if (i) openItemForm(i);
  }));
  disposers.push(on(root, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; setQuery({ tab: tab === 'planned' ? null : tab }); render(); }));
  disposers.push(on(root, 'click', '[data-group]', (e, el) => { f.group = el.dataset.group; render(); }));
  disposers.push(on(root, 'click', '[data-qstatus]', (e, el) => { qa.status = el.dataset.qstatus; renderQuick(); $('[data-quick-input]').focus(); }));
  disposers.push(on(root, 'submit', '[data-quick]', (e) => { e.preventDefault(); saveQuick(); }));
  disposers.push(on(root, 'input', '[data-quick-input]', (e, el) => { if (!el.value.trim()) qa.manual = false; renderQuick(); }));
  const onSearch = debounce(() => { if (alive) render(); }, 140);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', 'select[data-f]', (e, el) => { f[el.dataset.f] = el.value; render(); }));
  disposers.push(onDataChanged(() => { if (alive) load(); }));

  renderQuick();
  await load();
  if (query.new) { setQuery({ new: null }); openItemForm(); }
  return () => { alive = false; disposers.forEach((d) => d()); };
}

