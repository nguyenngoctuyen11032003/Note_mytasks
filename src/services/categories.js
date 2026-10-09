// Categories (kind 'task' | 'expense').
//
// Decision on default categories (is_default = true): they may be renamed,
// recoloured, reordered AND deleted — the DB allows it and FKs degrade safely
// (tasks/expenses/shopping → category NULL; budgets for it are removed).
// deleteCategory() returns { id, wasDefault, warning } so the UI can tell the
// user a built-in category is gone (it is not re-created automatically).
import {
  db, run, invalid, pick, requireId, requireNonEmpty, vText, vNumber, vEnum, vColor, AppError,
} from './errors.js';

export const CATEGORY_KINDS = ['task', 'expense'];
export const CATEGORY_COLS = 'id, kind, name, color, sort_order, is_default, created_at, updated_at';
/** kind is only writable on create (DB refuses changing it while in use). */
export const CATEGORY_WRITABLE = ['name', 'color', 'sort_order'];

function validate(input, { partial }) {
  const p = pick(input, partial ? CATEGORY_WRITABLE : ['kind', ...CATEGORY_WRITABLE]);
  if (!partial) p.kind = vEnum(p.kind, 'kind', CATEGORY_KINDS, { required: true, label: 'Loại danh mục' });
  if (!partial || 'name' in p) p.name = vText(p.name, 'name', { required: true, max: 50, label: 'Tên danh mục' });
  if ('color' in p) p.color = vColor(p.color, 'color');
  if ('sort_order' in p) p.sort_order = vNumber(p.sort_order, 'sort_order', { required: true, integer: true, min: -2147483648, max: 2147483647, label: 'Thứ tự' });
  return p;
}

/** listCategories(kind?) — all kinds when omitted. */
export async function listCategories(kind) {
  let q = db().from('categories').select(CATEGORY_COLS);
  if (kind) q = q.eq('kind', vEnum(kind, 'kind', CATEGORY_KINDS, { label: 'Loại danh mục' }));
  return run(q.order('kind', { ascending: true }).order('sort_order', { ascending: true }).order('name', { ascending: true }));
}

export async function createCategory(input = {}) {
  const row = validate({ sort_order: 100, ...input }, { partial: false });
  return run(db().from('categories').insert(row).select(CATEGORY_COLS).single());
}

export async function updateCategory(id, patch) {
  requireId(id);
  const row = requireNonEmpty(validate(patch, { partial: true }));
  return run(db().from('categories').update(row).eq('id', id).select(CATEGORY_COLS).single());
}

/** Returns { id, wasDefault, warning }. Throws not_found when nothing was deleted. */
export async function deleteCategory(id) {
  requireId(id);
  const rows = await run(db().from('categories').delete().eq('id', id).select('id, kind, name, is_default'));
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new AppError('not_found');
  const wasDefault = Boolean(row.is_default);
  return {
    id: row.id,
    wasDefault,
    warning: wasDefault ? `Đã xóa danh mục mặc định "${row.name}". Danh mục này sẽ không tự tạo lại.` : null,
  };
}

/** Persist a new order: ids[i] gets sort_order (i + 1) * 10. */
export async function reorder(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw invalid('ids', 'Danh sách sắp xếp trống.');
  if (ids.some((x) => typeof x !== 'string' || !x)) throw invalid('ids', 'Danh sách sắp xếp không hợp lệ.');
  if (new Set(ids).size !== ids.length) throw invalid('ids', 'Danh sách sắp xếp bị trùng.');
  const c = db();
  await Promise.all(ids.map((id, i) => run(c.from('categories').update({ sort_order: (i + 1) * 10 }).eq('id', id))));
  return true;
}

export {
  listCategories as list, createCategory as create, updateCategory as update,
  deleteCategory as remove, deleteCategory as delete,
};
