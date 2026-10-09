import { html, fragment, raw, setBusy, showErrors, formData } from '../utils/dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';

/**
 * Open a native <dialog>. Focus trap, Esc and backdrop close come from the
 * platform. Returns { el, close, body }.
 *
 * opts.onSubmit(values, ctx) → may return { errors } to show field errors,
 * or throw to show a toast; resolves → dialog closes.
 */
export function openModal({ eyebrow, title, body, submitLabel = 'Lưu', cancelLabel = 'Hủy', size = '', danger = false, footExtra = '', onSubmit, onOpen, onClose, validate }) {
  const el = fragment(html`
    <dialog class="dialog ${size ? 'dialog--' + size : ''}" aria-labelledby="dlg-title">
      <form method="dialog" class="dialog__form" novalidate style="display:contents">
        <header class="dialog__head">
          <div>
            ${eyebrow ? html`<span class="eyebrow">${eyebrow}</span>` : ''}
            <h2 id="dlg-title">${title}</h2>
          </div>
          <button type="button" class="icon-btn" data-close aria-label="Đóng">${icon('x')}</button>
        </header>
        <div class="dialog__body">${body}</div>
        ${onSubmit !== null
          ? html`<footer class="dialog__foot">
              ${footExtra ? html`<div class="grow">${footExtra}</div>` : ''}
              <button type="button" class="btn btn--ghost" data-close>${cancelLabel}</button>
              <button type="submit" class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-submit>${submitLabel}</button>
            </footer>`
          : ''}
      </form>
    </dialog>`);

  const form = el.querySelector('form');
  const submitBtn = el.querySelector('[data-submit]');
  let closed = false;

  const close = (result) => {
    if (closed) return;
    closed = true;
    el.close();
    el.remove();
    onClose?.(result);
  };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    else if (e.target === el) close(); // backdrop
  });
  el.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!submitBtn?.disabled) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const values = formData(form);
    const errs = validate?.(values, form) || {};
    if (!showErrors(form, errs)) return;
    setBusy(submitBtn, true);
    try {
      const res = await onSubmit(values, { form, el });
      if (res && res.errors) {
        showErrors(form, res.errors);
        return;
      }
      if (res !== false) close(res);
    } catch (err) {
      toast.error(err);
    } finally {
      if (!closed) setBusy(submitBtn, false);
    }
  });

  document.body.append(el);
  el.showModal();
  const first = el.querySelector('.dialog__body [autofocus], .dialog__body input:not([type=hidden]):not([type=checkbox]):not([type=radio]), .dialog__body textarea, .dialog__body select');
  first?.focus();
  onOpen?.(el);
  return { el, form, close, body: el.querySelector('.dialog__body') };
}

/** Promise-based confirm. Resolves true/false. */
export function confirmDialog({ title = 'Bạn chắc chứ?', message = '', confirmLabel = 'Xóa', cancelLabel = 'Hủy', danger = true, eyebrow = 'Xác nhận' } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openModal({
      eyebrow,
      title,
      size: 'narrow',
      body: html`<p class="muted">${message}</p>`,
      submitLabel: confirmLabel,
      cancelLabel,
      danger,
      onSubmit: () => {
        ok = true;
      },
      onClose: () => resolve(ok),
    });
  });
}

/* ---------- Field builders ---------- */

export function field({ label, name, hint, optional, control, id }) {
  const fid = id || `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  return html`
    <div class="field">
      <label class="field__label" for="${fid}">${label}${optional ? html`<span class="opt">không bắt buộc</span>` : ''}</label>
      ${raw(String(control).replace('id="__ID__"', `id="${fid}"`))}
      ${hint ? html`<span class="field__hint">${hint}</span>` : ''}
      <span class="field__error" role="alert"></span>
    </div>`;
}

export const input = (name, value = '', attrs = '') =>
  html`<input id="__ID__" class="input" name="${name}" value="${value ?? ''}" ${raw(attrs)} />`;

export const textarea = (name, value = '', attrs = '') =>
  html`<textarea id="__ID__" class="textarea" name="${name}" ${raw(attrs)}>${value ?? ''}</textarea>`;

export function select(name, options, selected, attrs = '') {
  return html`<select id="__ID__" class="select" name="${name}" ${raw(attrs)}>
    ${options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(selected ?? '') ? raw('selected') : ''}>${o.label}</option>`)}
  </select>`;
}
