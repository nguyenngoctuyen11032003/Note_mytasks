// Create / edit task dialog — shared by Tasks, Dashboard and Calendar.
import { html } from '../utils/dom.js';
import { openModal, field, input, textarea, select, confirmDialog } from './modal.js';
import { TASK_STATUS, TASK_PRIORITY, categoryOptions, tagInput, bindTagInput } from './ui.js';
import { createTask, updateTask, deleteTask } from '../services/tasks.js';
import { toast } from './toast.js';
import { minutes as fmtMinutes } from '../utils/format.js';
import { icon } from './icons.js';

export const RECURRENCE_LABELS = {
  daily: 'Hằng ngày',
  weekdays: 'Ngày làm việc (T2–T6)',
  weekly: 'Hằng tuần',
  monthly: 'Hằng tháng',
};
export const RECURRENCE_SHORT = { daily: 'Hằng ngày', weekdays: 'T2–T6', weekly: 'Hằng tuần', monthly: 'Hằng tháng' };
export const ESTIMATE_PRESETS = [15, 30, 60, 90, 120, 240];

/** Fields of the form → write payload (recurrence only sent when it means something). */
function toPayload(v, task) {
  const p = {
    title: v.title,
    description: v.description || null,
    status: v.status,
    priority: v.priority,
    category_id: v.category_id || null,
    due_date: v.due_date || null,
    estimated_minutes: v.estimated_minutes === '' ? null : Number(v.estimated_minutes),
    tags: JSON.parse(v.tags || '[]'),
  };
  // Older databases (before migration 000300) have no recurrence column: never send a no-op null.
  if (v.recurrence || task?.recurrence) p.recurrence = v.recurrence || null;
  return p;
}

/**
 * openTaskForm({ task?, defaults?, onSaved(task), onDeleted(id) })
 */
export function openTaskForm({ task = null, defaults = {}, onSaved, onDeleted } = {}) {
  const t = task || { status: 'todo', priority: 'medium', tags: [], ...defaults };
  const isEdit = Boolean(task);

  const est = t.estimated_minutes ?? '';
  const body = html`
    <div class="form">
      ${field({ label: 'Tiêu đề', name: 'title', control: input('title', t.title, 'maxlength="200" required autofocus placeholder="Ví dụ: Hoàn thiện báo cáo quý"') })}
      ${field({ label: 'Mô tả', name: 'description', optional: true, hint: 'Hỗ trợ Markdown đơn giản: **đậm**, *nghiêng*, - danh sách, - [ ] việc con, [liên kết](https://…)', control: textarea('description', t.description, 'maxlength="5000" rows="3" placeholder="Ghi chú, liên kết, các bước…"') })}
      <div class="form-row">
        ${field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(TASK_STATUS).map(([v, s]) => ({ value: v, label: s.label })), t.status) })}
        ${field({ label: 'Độ ưu tiên', name: 'priority', control: select('priority', Object.entries(TASK_PRIORITY).map(([v, l]) => ({ value: v, label: l })), t.priority) })}
      </div>
      <div class="form-row">
        ${field({ label: 'Danh mục', name: 'category_id', control: select('category_id', categoryOptions('task', { all: '— Chưa phân loại —' }), t.category_id) })}
        ${field({ label: 'Hạn chót', name: 'due_date', optional: true, control: input('due_date', t.due_date, 'type="date"') })}
      </div>
      <div class="form-row">
        ${field({ label: 'Ước tính (phút)', name: 'estimated_minutes', optional: true, control: input('estimated_minutes', est, 'type="number" min="0" max="100000" step="5" inputmode="numeric" placeholder="vd: 30"') })}
        ${field({ label: 'Lặp lại', name: 'recurrence', optional: true, control: select('recurrence', [{ value: '', label: 'Không lặp' }, ...Object.entries(RECURRENCE_LABELS).map(([v, l]) => ({ value: v, label: l }))], t.recurrence || '') })}
      </div>
      <div class="tk-presets" role="group" aria-label="Ước tính nhanh">
        ${ESTIMATE_PRESETS.map((m) => html`<button type="button" class="tk-preset" data-est="${m}">${fmtMinutes(m)}</button>`)}
        ${isEdit ? html`<span class="tk-presets__actual">${icon('clock')} Thực tế: ${fmtMinutes(t.actual_minutes || 0)}</span>` : ''}
      </div>
      ${field({ label: 'Thẻ', name: 'tags', optional: true, control: tagInput('tags', t.tags || []) })}
    </div>`;

  const footExtra = isEdit ? html`<button type="button" class="btn btn--danger-ghost btn--sm" data-del>${icon('trash')} Xóa</button>` : '';

  const m = openModal({
    eyebrow: isEdit ? 'Chỉnh sửa công việc' : 'Công việc mới',
    title: isEdit ? t.title : 'Thêm công việc',
    body,
    submitLabel: isEdit ? 'Lưu thay đổi' : 'Tạo công việc',
    footExtra,
    validate(v) {
      const e = {};
      if (!v.title) e.title = 'Hãy nhập tiêu đề.';
      else if (v.title.length > 200) e.title = 'Tối đa 200 ký tự.';
      if (v.estimated_minutes !== '') {
        const n = Number(v.estimated_minutes);
        if (!Number.isInteger(n) || n < 0) e.estimated_minutes = 'Nhập số phút nguyên ≥ 0.';
        else if (n > 100000) e.estimated_minutes = 'Tối đa 100.000 phút.';
      }
      if (v.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(v.due_date)) e.due_date = 'Ngày không hợp lệ.';
      if ((v.description || '').length > 5000) e.description = 'Tối đa 5.000 ký tự.';
      return e;
    },
    async onSubmit(v) {
      const payload = toPayload(v, task);
      const saved = isEdit ? await updateTask(task.id, payload) : await createTask(payload);
      toast(isEdit ? 'Đã lưu công việc.' : 'Đã tạo công việc.');
      onSaved?.(saved);
    },
  });
  bindTagInput(m.body);

  m.body.querySelectorAll('[data-est]').forEach((b) => b.addEventListener('click', () => {
    const inp = m.body.querySelector('[name="estimated_minutes"]');
    inp.value = b.dataset.est;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }));

  m.el.querySelector('[data-del]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Xóa công việc này?',
      message: `“${task.title}” sẽ bị xóa vĩnh viễn. Các phiên tính giờ vẫn được giữ lại nhưng không còn gắn với công việc.`,
    });
    if (!ok) return;
    try {
      await deleteTask(task.id);
      m.close();
      toast('Đã xóa công việc.');
      onDeleted?.(task.id);
    } catch (err) {
      toast.error(err);
    }
  });
  return m;
}
