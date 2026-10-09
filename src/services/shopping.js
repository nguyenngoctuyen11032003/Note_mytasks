// Shopping list — planning layer. Money is only counted once an expense is
// created (atomically, by RPC purchase_shopping_item). total_price is generated.
import { today } from '../utils/date.js';
import {
  db, run, rpc, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vDay, vUrl, vUuidOrNull, numify, single, searchOr,
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

export async function listItems({ status, categoryId, search } = {}) {
  let q = db().from('shopping_items').select(SELECT);
  if (Array.isArray(status)) {
    if (status.length) q = q.in('status', status);
  } else if (status) q = q.eq('status', status);
  if (categoryId === 'none') q = q.is('category_id', null);
  else if (categoryId) q = q.eq('category_id', categoryId);
  const s = typeof search === 'string' ? search.trim() : '';
  if (s) q = q.or(searchOr(s, ['name', 'note']));
  q = q.order('created_at', { ascending: false }).limit(2000);
  return normalize(await run(q));
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

export { listItems as listShopping, listItems as list, createItem as create, updateItem as update, deleteItem as remove, deleteItem as delete };
