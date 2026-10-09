// Shopping list — planning layer. Money is only counted once an expense is
// created (atomically, by RPC purchase_shopping_item). total_price is generated.
import { today } from '../utils/date.js';
import {
  AppError, db, run, rpc, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vDay, vUrl, vUuidOrNull, numify, single, searchOr,
} from './errors.js';

export const SHOP_STATUS = { wishlist: 'Mong muốn', planned: 'Dự định mua', purchased: 'Đã mua', cancelled: 'Bỏ qua' };
export const SHOP_PRIORITY = { low: 'Thấp', medium: 'Vừa', high: 'Cao', must_buy: 'Phải mua' };
const STATUSES = Object.keys(SHOP_STATUS);
const PRIORITIES = Object.keys(SHOP_PRIORITY);
const METHODS = ['cash', 'bank', 'credit_card', 'e_wallet', 'other'];

export const SHOP_COLS =
  'id, name, category_id, unit_price, quantity, total_price, priority, status, purchased_on, url, note, expense_id, created_at, updated_at';
const SELECT = `${SHOP_COLS}, category:categories(id, name, color)`;
/** expense_id is managed by purchase(); total_price is a generated column. */
export const SHOP_WRITABLE = ['name', 'category_id', 'unit_price', 'quantity', 'priority', 'status', 'purchased_on', 'url', 'note'];

export function validateItem(input, { partial = false } = {}) {
  const p = pick(input, SHOP_WRITABLE);
  if (!partial || 'name' in p) p.name = vText(p.name, 'name', { required: true, max: 200, label: 'Tên món' });
  if ('category_id' in p) p.category_id = vUuidOrNull(p.category_id, 'category_id');
  if ('unit_price' in p) p.unit_price = vNumber(p.unit_price, 'unit_price', { min: 0, max: 999_999_999_999.99, label: 'Đơn giá' }) ?? 0;
  if ('quantity' in p) p.quantity = vNumber(p.quantity, 'quantity', { required: true, min: 1, max: 9999, integer: true, label: 'Số lượng' });
  if ('priority' in p) p.priority = vEnum(p.priority, 'priority', PRIORITIES, { required: true, label: 'Độ ưu tiên' });
  if ('status' in p) p.status = vEnum(p.status, 'status', STATUSES, { required: true, label: 'Trạng thái' });
  if ('purchased_on' in p) p.purchased_on = vDay(p.purchased_on, 'purchased_on', { label: 'Ngày mua' });
  if ('url' in p) p.url = vUrl(p.url, 'url');
  if ('note' in p) p.note = vText(p.note, 'note', { max: 1000, label: 'Ghi chú' });
  // CHECK (status <> 'purchased' or purchased_on is not null)
  if (p.status === 'purchased' && !p.purchased_on) p.purchased_on = today();
  return p;
}

const normalize = (rows) => numify(rows, ['unit_price', 'quantity', 'total_price']);

const LIST_PAGE = 1000; // PostgREST max_rows
const LIST_CAP = 5000;

export async function listItems(filters = {}) {
  const { status, categoryId, search } = filters || {};
  let q = db().from('shopping_items').select(SELECT);
  if (Array.isArray(status)) {
    if (status.length) q = q.in('status', status);
  } else if (status) q = q.eq('status', status);
  if (categoryId === 'none') q = q.is('category_id', null);
  else if (categoryId) q = q.eq('category_id', categoryId);
  const s = typeof search === 'string' ? search.trim() : '';
  if (s) q = q.or(searchOr(s, ['name', 'note']));
  q = q.order('created_at', { ascending: false }).order('id', { ascending: true });
  // PostgREST caps each response at max_rows (1000): page so nothing is silently dropped.
  const out = [];
  while (out.length < LIST_CAP) {
    const want = Math.min(LIST_PAGE, LIST_CAP - out.length);
    const rows = (await run(q.range(out.length, out.length + want - 1))) || [];
    out.push(...rows);
    if (rows.length < want) break;
  }
  return normalize(out);
}

export async function createItem(input) {
  const row = validateItem(input);
  return normalize(await run(db().from('shopping_items').insert(row).select(SELECT).single()));
}

export async function updateItem(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validateItem(patch, { partial: true }));
  return normalize(await run(db().from('shopping_items').update(row).eq('id', id).select(SELECT).single()));
}

export async function deleteItem(id) {
  requireId(id);
  await run(db().from('shopping_items').delete().eq('id', id));
  return true;
}

/**
 * Mark purchased (RPC purchase_shopping_item, atomic). With createExpense
 * (default) an expense of total_price is recorded and linked via expense_id.
 * Returns the updated shopping_items row.
 */
export async function purchase(id, { spentOn = null, paymentMethod = 'cash', createExpense = true } = {}) {
  requireId(id);
  const row = await rpc('purchase_shopping_item', {
    p_item_id: id,
    p_purchased_on: vDay(spentOn, 'spentOn', { label: 'Ngày mua' }),
    p_payment_method: vEnum(paymentMethod, 'paymentMethod', METHODS, { label: 'Phương thức thanh toán' }) ?? 'cash',
    p_create_expense: createExpense !== false,
  });
  return normalize(single(row));
}

/**
 * Compat: markPurchased(item, {purchased_on, createExpenseRow, payment_method}).
 * Delegates to the atomic RPC; the expense uses the item's own category
 * (expenseCategoryId, when different, is applied to the new expense afterwards).
 */
export async function markPurchased(item, { purchased_on = null, createExpenseRow = false, expenseCategoryId = null, payment_method = 'cash' } = {}) {
  const id = typeof item === 'string' ? item : item?.id;
  const row = await purchase(id, { spentOn: purchased_on, paymentMethod: payment_method, createExpense: Boolean(createExpenseRow) });
  const itemCategory = typeof item === 'object' && item ? item.category_id ?? null : row?.category_id ?? null;
  const hadExpense = typeof item === 'object' && item ? item.expense_id ?? null : null;
  // The RPC files the expense under the item's category; honour an explicit different one.
  if (createExpenseRow && expenseCategoryId && expenseCategoryId !== itemCategory && row?.expense_id && row.expense_id !== hadExpense) {
    await run(db().from('expenses').update({ category_id: expenseCategoryId }).eq('id', row.expense_id));
  }
  return row;
}

/**
 * Purchase with the price actually paid. The planned price stays on the item;
 * the linked expense records the real amount:
 * - item without a planned price → its unit price is set from the actual total
 *   first (the RPC only files an expense when total_price > 0);
 * - actual ≠ planned → the expense created by the RPC is corrected afterwards.
 * Returns the updated shopping_items row.
 */
export async function purchaseWithPrice(item, opts = {}) {
  const { actualTotal = null, spentOn = null, paymentMethod = 'cash', createExpense = true, expenseCategoryId = null } = opts || {};
  const it = await loadItem(item);
  const id = it.id;
  const planned = Number(it.total_price) || 0;
  const qty = Math.max(1, Number(it.quantity) || 1);
  const actual = actualTotal == null || actualTotal === ''
    ? null
    : vNumber(actualTotal, 'actualTotal', { min: 0, max: 999_999_999_999.99, label: 'Giá thực tế' });
  // Re-purchase of an item that still has its expense: never file a second one.
  const linked = it.expense_id || null;
  const fileNew = createExpense !== false && !linked;
  if (fileNew && planned <= 0 && actual > 0) {
    // The RPC only files an expense when total_price > 0.
    await run(db().from('shopping_items').update({ unit_price: Math.round((actual / qty) * 100) / 100 }).eq('id', id));
  }
  const row = await markPurchased(it, { purchased_on: spentOn, createExpenseRow: fileNew, expenseCategoryId, payment_method: paymentMethod });
  if (createExpense !== false && actual > 0) {
    if (linked) {
      await run(db().from('expenses').update({ amount: actual }).eq('id', linked));
    } else if (row?.expense_id) {
      // The RPC filed unit_price × quantity (possibly rounded); record what was actually paid.
      const filed = Number(row.total_price) || 0;
      if (Math.abs(actual - filed) >= 0.005) await run(db().from('expenses').update({ amount: actual }).eq('id', row.expense_id));
    }
  }
  return row;
}

/** Item object as given, or fetched by id (when only an id / no expense_id is known). */
async function loadItem(item) {
  const id = typeof item === 'string' ? item : item?.id;
  requireId(id);
  if (typeof item === 'object' && item && 'expense_id' in item && 'total_price' in item) return item;
  const row = await run(db().from('shopping_items').select(SHOP_COLS).eq('id', id).maybeSingle());
  if (!row) throw new AppError('not_found');
  return normalize(row);
}

/**
 * Undo a purchase: optionally delete the linked expense, then move the item
 * back to an open status (purchased_on cleared).
 */
export async function revertPurchase(item, opts = {}) {
  const { status = 'planned', removeExpense = true } = opts || {};
  const id = typeof item === 'string' ? item : item?.id;
  requireId(id);
  const next = vEnum(status, 'status', STATUSES.filter((s) => s !== 'purchased'), { required: true, label: 'Trạng thái' });
  if (removeExpense) {
    // An id (or an object without expense_id) → look the linked expense up first.
    const expenseId = typeof item === 'object' && item && 'expense_id' in item
      ? item.expense_id
      : (await run(db().from('shopping_items').select('id, expense_id').eq('id', id).maybeSingle()))?.expense_id;
    if (expenseId) await run(db().from('expenses').delete().eq('id', expenseId));
  }
  return normalize(await run(db().from('shopping_items').update({ status: next, purchased_on: null }).eq('id', id).select(SELECT).single()));
}

export { listItems as listShopping, listItems as list, createItem as create, updateItem as update, deleteItem as remove, deleteItem as delete };
