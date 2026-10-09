// Shopping list — a planning layer. Money only counts once an expense is
// recorded (optionally, when an item is marked purchased).
import { html, mount, on, raw } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, catLabel, categoryOptions, prio, popMenu, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, loadingBlock, statTileSkeleton } from '../components/states.js';
import { openModal, field, input, select, textarea, confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { debounce } from '../utils/debounce.js';
import { listShopping, createItem, updateItem, deleteItem, markPurchased, SHOP_STATUS, SHOP_PRIORITY } from '../services/shopping.js';
import { PAYMENT_METHODS } from '../services/expenses.js';
import { today, startOfMonth } from '../utils/date.js';
import { money, day, num, parseMoney } from '../utils/format.js';

const TABS = ['planned', 'wishlist', 'purchased', 'cancelled'];
const TONE = { wishlist: 'plum', planned: 'info', purchased: 'success', cancelled: 'muted' };

export default async function shoppingPage(root, { query }) {
  let tab = TABS.includes(query.tab) ? query.tab : 'planned';
  let items = [];
  const f = { q: '', sort: 'priority' };
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '07',
      kicker: 'Mua sắm',
      title: 'Danh sách <em>cần mua</em>',
      lede: 'Lên kế hoạch trước khi chi. Món hàng chỉ được tính vào chi tiêu khi bạn đánh dấu “đã mua” và chọn ghi thành khoản chi.',
      actions: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Thêm món</button>`,
    })}
    <section class="grid grid-4" data-stats>${statTileSkeleton(4)}</section>
    <div class="tabs" role="tablist" data-tabs style="margin-top:var(--s-6)"></div>
    <div class="toolbar">
      <div class="input-group">${icon('search')}<input class="input" type="search" placeholder="Tìm món…" data-f="q" aria-label="Tìm món" /></div>
      <select class="select" data-f="sort" aria-label="Sắp xếp">
        <option value="priority">Ưu tiên cao trước</option>
        <option value="price">Giá cao trước</option>
        <option value="recent">Mới thêm</option>
        <option value="name">Tên A–Z</option>
      </select>
    </div>
    <div data-body>${loadingBlock(300)}</div>`);

  const $ = (s) => root.querySelector(s);

  function renderStats() {
    const sum = (st) => items.filter((i) => i.status === st).reduce((s, i) => s + Number(i.total_price), 0);
    const m0 = startOfMonth(today());
    const boughtMonth = items.filter((i) => i.status === 'purchased' && i.purchased_on >= m0);
    const must = items.filter((i) => i.priority === 'must_buy' && (i.status === 'planned' || i.status === 'wishlist'));
    mount($('[data-stats]'), html`
      <div class="stat stat--accent"><div class="stat__label"><span class="eyebrow">Dự định mua</span><span class="stat__icon">${icon('cart')}</span></div><div class="stat__value" style="font-size:var(--fs-2xl)">${money(sum('planned'))}</div><div class="stat__meta">${num(items.filter((i) => i.status === 'planned').length)} món</div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Mong muốn</span><span class="stat__icon">${icon('sparkle')}</span></div><div class="stat__value" style="font-size:var(--fs-2xl)">${money(sum('wishlist'))}</div><div class="stat__meta">${num(items.filter((i) => i.status === 'wishlist').length)} món</div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Đã mua tháng này</span><span class="stat__icon">${icon('bag')}</span></div><div class="stat__value" style="font-size:var(--fs-2xl)">${money(boughtMonth.reduce((s, i) => s + Number(i.total_price), 0))}</div><div class="stat__meta">${num(boughtMonth.length)} món · ${num(boughtMonth.filter((i) => i.expense_id).length)} đã ghi chi tiêu</div></div>
      <div class="stat"><div class="stat__label"><span class="eyebrow">Phải mua</span><span class="stat__icon">${icon('flag')}</span></div><div class="stat__value">${num(must.length)}<small>món</small></div><div class="stat__meta">${must.length ? money(must.reduce((s, i) => s + Number(i.total_price), 0)) : 'Không có món gấp'}</div></div>`);
  }

  function render() {
    mount($('[data-tabs]'), html`${TABS.map((t) => html`<button type="button" role="tab" data-tab="${t}" aria-selected="${tab === t}">${SHOP_STATUS[t]}<span class="count">${items.filter((i) => i.status === t).length}</span></button>`)}`);
    const q = f.q.toLowerCase();
    const list = items.filter((i) => i.status === tab && (!q || i.name.toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q)));
    const sorters = {
      priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.total_price - a.total_price,
      price: (a, b) => b.total_price - a.total_price,
      recent: (a, b) => b.created_at.localeCompare(a.created_at),
      name: (a, b) => a.name.localeCompare(b.name, 'vi'),
    };
    list.sort(tab === 'purchased' && f.sort === 'priority' ? (a, b) => (b.purchased_on || '').localeCompare(a.purchased_on || '') : sorters[f.sort]);
    if (!items.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'cart', title: 'Danh sách đang trống', text: 'Thêm món bạn định mua, ước tính giá và mức ưu tiên — để mỗi lần chi tiêu đều có chủ đích.', action: html`<button class="btn btn--primary" data-act="new">${icon('plus')} Thêm món đầu tiên</button>` })}</div>`);
      return;
    }
    if (!list.length) {
      mount($('[data-body]'), html`<div class="sheet">${emptyState({ art: 'cart', small: true, title: `Không có món nào ở mục “${SHOP_STATUS[tab]}”` })}</div>`);
      return;
    }
    const total = list.reduce((s, i) => s + Number(i.total_price), 0);
    mount($('[data-body]'), html`
      <div class="shop-grid">${list.map(card)}</div>
      <p class="muted" style="margin-top:var(--s-4);font-size:var(--fs-sm);text-align:right">${list.length} món · Tổng <strong class="num" style="color:var(--ink)">${money(total)}</strong></p>`);
  }

  function card(i) {
    const open = i.status === 'planned' || i.status === 'wishlist';
    return html`
      <article class="sheet shop-card ${i.status === 'purchased' ? 'is-bought' : ''} ${i.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${i.id}">
        <div class="shop-card__top">
          <span class="badge badge--${TONE[i.status]}">${SHOP_STATUS[i.status]}</span>
          ${prio(i.priority, SHOP_PRIORITY)}
          <span class="grow"></span>
          <button class="icon-btn icon-btn--sm" data-act="menu" aria-label="Thao tác">${icon('more')}</button>
        </div>
        <h3 class="shop-card__name" data-act="edit">${i.name}</h3>
        <div class="shop-card__price">
          <strong class="display">${money(i.total_price)}</strong>
          ${i.quantity > 1 ? html`<span class="muted num">${i.quantity} × ${money(i.unit_price)}</span>` : ''}
        </div>
        ${i.note ? html`<p class="shop-card__note">${i.note}</p>` : ''}
        <div class="shop-card__foot">
          ${catLabel(i.category_id)}
          ${i.url ? html`<a href="${i.url}" target="_blank" rel="noopener noreferrer" class="shop-card__link">${icon('link')} Liên kết</a>` : ''}
          <span class="grow"></span>
          ${i.status === 'purchased' ? html`<span class="muted" style="font-size:var(--fs-xs)">${icon('check', '')} ${day(i.purchased_on, 'medium')}${i.expense_id ? ' · đã ghi chi' : ''}</span>` : ''}
          ${open ? html`<button class="btn btn--sm btn--primary" data-act="buy">${icon('bag')} Đã mua</button>` : ''}
        </div>
      </article>`;
  }

  function openItemForm(i = null) {
    openModal({
      eyebrow: i ? 'Sửa món' : 'Món mới',
      title: i ? i.name : 'Thêm vào danh sách mua sắm',
      body: html`<div class="form">
        ${field({ label: 'Tên món', name: 'name', control: input('name', i?.name, 'maxlength="200" required placeholder="Ví dụ: Tai nghe chống ồn"') })}
        <div class="form-row">
          ${field({ label: 'Đơn giá (ước tính)', name: 'unit_price', hint: ' ', control: input('unit_price', i ? String(Math.round(i.unit_price)) : '', 'inputmode="decimal" placeholder="Ví dụ: 2,5tr"') })}
          ${field({ label: 'Số lượng', name: 'quantity', control: input('quantity', i?.quantity ?? 1, 'type="number" min="1" max="9999" step="1" required') })}
        </div>
        <div class="form-row">
          ${field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(SHOP_STATUS).filter(([v]) => v !== 'purchased' || i?.status === 'purchased').map(([v, l]) => ({ value: v, label: l })), i?.status || (tab === 'wishlist' ? 'wishlist' : 'planned')) })}
          ${field({ label: 'Độ ưu tiên', name: 'priority', control: select('priority', Object.entries(SHOP_PRIORITY).map(([v, l]) => ({ value: v, label: l })), i?.priority || 'medium') })}
        </div>
        ${field({ label: 'Danh mục chi tiêu', name: 'category_id', control: select('category_id', categoryOptions('expense', { all: '— Chưa phân loại —' }), i?.category_id) })}
        ${field({ label: 'Liên kết sản phẩm', name: 'url', optional: true, control: input('url', i?.url, 'type="url" placeholder="https://…"') })}
        ${field({ label: 'Ghi chú', name: 'note', optional: true, control: textarea('note', i?.note, 'rows="2" maxlength="1000"') })}
      </div>`,
      submitLabel: i ? 'Lưu' : 'Thêm món',
      onOpen(el) {
        const inp = el.querySelector('[name=unit_price]');
        const q = el.querySelector('[name=quantity]');
        const hint = inp.closest('.field').querySelector('.field__hint');
        const upd = () => { const n = parseMoney(inp.value); hint.textContent = Number.isFinite(n) ? `Thành tiền: ${money(n * (Number(q.value) || 1))}` : 'Gõ “k” cho nghìn, “tr” cho triệu'; };
        inp.addEventListener('input', upd); q.addEventListener('input', upd); upd();
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
        const payload = { name: v.name, unit_price: v.unit_price ? parseMoney(v.unit_price) : 0, quantity: Number(v.quantity), status: v.status, priority: v.priority, category_id: v.category_id || null, url: v.url || null, note: v.note || null };
        if (i) await updateItem(i.id, payload); else await createItem(payload);
        toast(i ? 'Đã lưu món.' : 'Đã thêm vào danh sách.');
        if (!i && payload.status !== tab) { tab = payload.status; setQuery({ tab }); }
        load();
      },
    });
  }

  function openBuyForm(i) {
    const total = Number(i.total_price);
    openModal({
      eyebrow: 'Đánh dấu đã mua',
      title: i.name,
      size: 'narrow',
      body: html`<div class="form">
        <div class="buy-sum"><span class="eyebrow">Thành tiền</span><strong class="display">${money(total)}</strong>${i.quantity > 1 ? html`<span class="muted num">${i.quantity} × ${money(i.unit_price)}</span>` : ''}</div>
        ${field({ label: 'Ngày mua', name: 'purchased_on', control: input('purchased_on', today(), `type="date" required max="${today()}"`) })}
        <label class="check"><input type="checkbox" name="create_expense" ${total > 0 ? raw('checked') : raw('disabled')} /> Ghi thành khoản chi ${money(total)}</label>
        <div class="form-row" data-exp-fields>
          ${field({ label: 'Danh mục chi', name: 'expense_category', control: select('expense_category', categoryOptions('expense', { all: '— Chưa phân loại —' }), i.category_id) })}
          ${field({ label: 'Thanh toán', name: 'payment_method', control: select('payment_method', Object.entries(PAYMENT_METHODS).map(([v, l]) => ({ value: v, label: l })), 'cash') })}
        </div>
        ${total <= 0 ? html`<p class="field__hint">Món chưa có giá nên không thể ghi chi tiêu. Hãy sửa đơn giá nếu cần.</p>` : ''}
      </div>`,
      submitLabel: 'Xác nhận đã mua',
      onOpen(el) {
        const cb = el.querySelector('[name=create_expense]');
        const box = el.querySelector('[data-exp-fields]');
        const upd = () => { box.style.display = cb.checked ? '' : 'none'; };
        cb.addEventListener('change', upd); upd();
      },
      validate: (v) => (v.purchased_on ? {} : { purchased_on: 'Chọn ngày mua.' }),
      async onSubmit(v) {
        await markPurchased(i, { purchased_on: v.purchased_on, createExpenseRow: v.create_expense, expenseCategoryId: v.expense_category || null, payment_method: v.payment_method });
        toast(v.create_expense ? `Đã mua và ghi ${money(total)} vào chi tiêu.` : 'Đã đánh dấu đã mua.');
        load();
      },
    });
  }

  async function load() {
    try {
      items = (await listShopping()).map((i) => ({ ...i, unit_price: Number(i.unit_price), total_price: Number(i.total_price), quantity: Number(i.quantity) }));
      renderStats();
      render();
    } catch (err) {
      mount($('[data-body]'), errorState(err));
    }
  }

  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    if (a === 'new') return openItemForm();
    if (a === 'retry') return load();
    const i = items.find((x) => x.id === el.closest('[data-id]')?.dataset.id);
    if (!i) return;
    if (a === 'edit') openItemForm(i);
    if (a === 'buy') openBuyForm(i);
    if (a === 'menu') {
      const move = (s) => async () => { try { await updateItem(i.id, { status: s, ...(s !== 'purchased' ? { purchased_on: null } : {}) }); toast(`Đã chuyển sang “${SHOP_STATUS[s]}”.`); load(); } catch (err) { toast.error(err); } };
      popMenu(el, [
        { label: 'Chỉnh sửa', icon: 'edit', onClick: () => openItemForm(i) },
        ...(i.status !== 'purchased' ? [{ label: 'Đánh dấu đã mua…', icon: 'bag', onClick: () => openBuyForm(i) }] : []),
        'sep',
        ...['planned', 'wishlist', 'cancelled'].filter((s) => s !== i.status).map((s) => ({ label: `Chuyển sang “${SHOP_STATUS[s]}”`, icon: s === 'cancelled' ? 'x' : 'arrowRight', onClick: move(s) })),
        ...(i.expense_id ? [{ label: 'Xem khoản chi', icon: 'wallet', onClick: () => { location.hash = `#/expenses?m=${(i.purchased_on || today()).slice(0, 7)}`; } }] : []),
        'sep',
        { label: 'Xóa', icon: 'trash', danger: true, onClick: async () => {
          if (!(await confirmDialog({ title: 'Xóa món này?', message: `“${i.name}” sẽ bị xóa khỏi danh sách.${i.expense_id ? ' Khoản chi đã ghi vẫn được giữ.' : ''}` }))) return;
          try { await deleteItem(i.id); toast('Đã xóa.'); load(); } catch (err) { toast.error(err); }
        } },
      ]);
    }
  }));
  disposers.push(on(root, 'click', '[data-tab]', (e, el) => { tab = el.dataset.tab; setQuery({ tab: tab === 'planned' ? null : tab }); render(); }));
  const onSearch = debounce(render, 140);
  disposers.push(on(root, 'input', '[data-f="q"]', (e, el) => { f.q = el.value; onSearch(); }));
  disposers.push(on(root, 'change', '[data-f="sort"]', (e, el) => { f.sort = el.value; render(); }));
  disposers.push(onDataChanged(load));

  await load();
  if (query.new) { setQuery({ new: null }); openItemForm(); }
  return () => disposers.forEach((d) => d());
}
