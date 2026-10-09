import { html, fragment } from '../utils/dom.js';
import { icon } from './icons.js';

const ICONS = { success: 'checkCircle', error: 'alert', info: 'info' };

/**
 * toast('Đã lưu') · toast.error(err) · toast('…', { action: { label, onClick } })
 */
export function toast(message, { type = 'success', duration = 3600, action } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = fragment(html`
    <div class="toast toast--${type}" role="${type === 'error' ? 'alert' : 'status'}">
      ${icon(ICONS[type])}
      <div>
        <div>${message}</div>
        ${action ? html`<button type="button" class="toast__action" style="margin-top:4px;text-decoration:underline;opacity:.9">${action.label}</button>` : ''}
      </div>
      <button type="button" aria-label="Đóng thông báo">${icon('x')}</button>
    </div>`);
  const close = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  };
  el.querySelector('[aria-label="Đóng thông báo"]').onclick = close;
  if (action) {
    el.querySelector('.toast__action').onclick = () => {
      action.onClick();
      close();
    };
  }
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  if (duration) setTimeout(close, duration);
}

toast.error = (err, opts) => toast(typeof err === 'string' ? err : err?.message || 'Đã có lỗi xảy ra.', { type: 'error', duration: 6000, ...opts });
toast.info = (msg, opts) => toast(msg, { type: 'info', ...opts });
