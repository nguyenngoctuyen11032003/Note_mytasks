// Create / edit task dialog — shared by Tasks, Dashboard and Calendar.
import { html } from '../utils/dom.js';
import { openModal, field, input, textarea, select, confirmDialog } from './modal.js';
import { TASK_STATUS, TASK_PRIORITY, categoryOptions, tagInput, bindTagInput } from './ui.js';
import { createTask, updateTask, deleteTask } from '../services/tasks.js';
import { toast } from './toast.js';
import { minutes as fmtMinutes } from '../utils/format.js';
import { icon } from './icons.js';

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
      ${field({ label: 'Mô tả', name: 'description', optional: true, control: textarea('description', t.description, 'maxlength="5000" rows="3" placeholder="Ghi chú, liên kết, các bước…"') })}
      <div class="form-row">
        ${field({ label: 'Trạng thái', name: 'status', control: select('status', Object.entries(TASK_STATUS).map(([v, s]) => ({ value: v, label: s.label })), t.status) })}
        ${field({ label: 'Độ ưu tiên', name: 'priority', control: select('priority', Object.entries(TASK_PRIORITY).map(([v, l]) => ({ value: v, label: l })), t.priority) })}
      </div>
      <div class="form-row">
        ${field({ label: 'Danh mục', name: 'category_id', control: select('category_id', categoryOptions('task', { all: '— Chưa phân loại —' }), t.category_id) })}
        ${field({ label: 'Hạn chót', name: 'due_date', optional: true, control: input('due_date', t.due_date, 'type="date"') })}
      </div>
      <div class="form-row">
        ${field({ label: 'Ước tính (phút)', name: 'estimated_minutes', optional: true, hint: 'Ví dụ 90 = 1g 30p', control: input('estimated_minutes', est, 'type="number" min="0" step="5" inputmode="numeric"') })}
        ${field({ label: 'Thời gian thực tế', name: '_actual', hint: 'Tự cộng từ các phiên tính giờ', control: input('_actual', fmtMinutes(t.actual_minutes || 0), 'disabled') })}
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
      if (v.estimated_minutes !== '' && (!Number.isInteger(Number(v.estimated_minutes)) || Number(v.estimated_minutes) < 0)) e.estimated_minutes = 'Nhập số phút ≥ 0.';
      return e;
    },
    async onSubmit(v) {
      const payload = {
        title: v.title,
        description: v.description || null,
        status: v.status,
        priority: v.priority,
        category_id: v.category_id || null,
        due_date: v.due_date || null,
        estimated_minutes: v.estimated_minutes === '' ? null : Number(v.estimated_minutes),
        tags: JSON.parse(v.tags || '[]'),
      };
      const saved = isEdit ? await updateTask(task.id, payload) : await createTask(payload);
      toast(isEdit ? 'Đã lưu công việc.' : 'Đã tạo công việc.');
      onSaved?.(saved);
    },
  });
  bindTagInput(m.body);

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
