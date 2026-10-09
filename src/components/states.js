import { html } from '../utils/dom.js';
import { icon, art } from './icons.js';

export function emptyState({ art: a = 'tasks', title, text = '', action = '', small = false }) {
  return html`
    <div class="empty ${small ? 'empty--sm' : ''}">
      ${art(a)}
      <div class="empty__title">${title}</div>
      ${text ? html`<p class="empty__text">${text}</p>` : ''}
      ${action}
    </div>`;
}

export function errorState(err, { retry = true } = {}) {
  return html`
    <div class="error-box" role="alert">
      ${icon('alert')}
      <p>${err?.message || 'Không tải được dữ liệu.'}</p>
      ${retry ? html`<button type="button" class="btn btn--sm" data-act="retry">${icon('refresh')} Thử lại</button>` : ''}
    </div>`;
}

export function loadingRows(n = 5) {
  return html`
    <div class="loading-rows" aria-busy="true" aria-label="Đang tải">
      ${Array.from({ length: n }, (_, i) => html`
        <div class="sk-row">
          <div class="skeleton" style="width:22px;height:22px;border-radius:50%"></div>
          <div><div class="skeleton sk-line" style="width:${55 + ((i * 17) % 35)}%"></div><div class="skeleton sk-line" style="width:${20 + ((i * 11) % 20)}%;height:8px"></div></div>
          <div class="skeleton sk-line"></div>
        </div>`)}
    </div>`;
}

export function loadingBlock(h = 220) {
  return html`<div class="skeleton" style="height:${h}px" aria-busy="true" aria-label="Đang tải"></div>`;
}

export function statTileSkeleton(n = 4) {
  return Array.from({ length: n }, () => html`
    <div class="stat"><div class="skeleton sk-line" style="width:40%"></div><div class="skeleton" style="height:38px;width:60%"></div><div class="skeleton sk-line" style="width:70%"></div></div>`);
}
