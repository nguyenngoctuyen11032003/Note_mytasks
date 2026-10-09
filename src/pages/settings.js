// Cài đặt — profile, preferences, categories (drag to reorder), security,
// data backup / restore / CSV, keyboard shortcuts and PWA install help.
import { html, mount, on, raw, formData, setBusy, showErrors } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, swatchPicker, SWATCHES } from '../components/ui.js';
import { openModal, field, input, select, confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { applyTheme } from '../components/theme.js';
import { reloadCategories } from '../components/context.js';
import * as store from '../core/store.js';
import { notifyDataChanged } from '../core/events.js';
import {
  updateProfile, getAvatarColor, setAvatarColor, getHomePage, setHomePage, HOME_PAGES, isValidTimezone,
} from '../services/profile.js';
import { createCategory, updateCategory, deleteCategory, reorder } from '../services/categories.js';
import { verifyPassword, updatePassword, signOut } from '../services/auth.js';
import { clearActivity } from '../services/activity.js';
import {
  BACKUP_TABLES, downloadBackup, parseBackup, importAll, downloadTableCsv, tableLabel,
} from '../services/backup.js';
import { configureDates, getTimezone } from '../utils/date.js';
import { configureFormat, initials, day, num, dateTime } from '../utils/format.js';

const CURRENCIES = [
  ['VND', 'VND — Việt Nam đồng'], ['USD', 'USD — Đô la Mỹ'], ['EUR', 'EUR — Euro'], ['JPY', 'JPY — Yên Nhật'],
  ['KRW', 'KRW — Won Hàn Quốc'], ['CNY', 'CNY — Nhân dân tệ'], ['SGD', 'SGD — Đô la Singapore'], ['THB', 'THB — Baht Thái'],
  ['AUD', 'AUD — Đô la Úc'], ['GBP', 'GBP — Bảng Anh'],
];
const COMMON_TZ = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];
const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
const THEMES = [['light', 'Sáng', 'sun'], ['dark', 'Tối', 'moon'], ['system', 'Theo hệ thống', 'monitor']];
const SECTIONS = [
  ['s-profile', 'Hồ sơ', 'user'],
  ['s-prefs', 'Tuỳ chọn', 'settings'],
  ['s-cats', 'Danh mục', 'tag'],
  ['s-security', 'Bảo mật', 'shield'],
  ['s-data', 'Dữ liệu', 'database'],
  ['s-keys', 'Phím tắt', 'keyboard'],
  ['s-install', 'Cài đặt ứng dụng', 'phone'],
];
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const SHORTCUTS = [
  { keys: [[MOD, 'K']], label: 'Mở tìm kiếm & bảng lệnh' },
  { keys: [['N']], label: 'Tạo mới (công việc, ghi chú, khoản chi…)' },
  { keys: [['G'], ['D']], label: 'Đi tới Tổng quan' },
  { keys: [['G'], ['N']], label: 'Đi tới Ghi chú' },
  { keys: [['G'], ['T']], label: 'Đi tới Công việc' },
  { keys: [['G'], ['C']], label: 'Đi tới Lịch' },
  { keys: [['G'], ['H']], label: 'Đi tới Thời gian' },
  { keys: [['G'], ['K']], label: 'Đi tới Mục tiêu KPI' },
  { keys: [['G'], ['E']], label: 'Đi tới Chi tiêu' },
  { keys: [['G'], ['S']], label: 'Đi tới Mua sắm' },
  { keys: [['G'], ['R']], label: 'Đi tới Báo cáo' },
  { keys: [['?']], label: 'Mở bảng trợ giúp phím tắt' },
  { keys: [['Esc']], label: 'Đóng hộp thoại / menu đang mở' },
];

function timezoneList(current) {
  let all = [];
  try { all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []; } catch { all = []; }
  const common = COMMON_TZ.filter((z) => z === 'UTC' || !all.length || all.includes(z));
  if (current && !common.includes(current)) common.unshift(current);
  return { common, rest: all.filter((z) => !common.includes(z)) };
}

const tzLabel = (z) => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    const off = parts.find((p) => p.type === 'timeZoneName')?.value?.replace('GMT', 'UTC') || '';
    return `${z.replace(/_/g, ' ')}${off ? ` (${off === 'UTC' ? 'UTC+0' : off})` : ''}`;
  } catch {
    return z.replace(/_/g, ' ');
  }
};

export default async function settingsPage(root) {
  const disposers = [];
  let catKind = 'task';
  let observer = null;

  /* ------------------------------------------------------------------ */
  function render() {
    const s = store.get();
    const p = s.profile || {};
    const tz = p.timezone || getTimezone();
    const tzs = timezoneList(tz);
    const avatar = getAvatarColor();
    const home = getHomePage();
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

    mount(root, html`
      ${pageHead({ num: '09', kicker: 'Cài đặt', title: 'Sắp đặt <em>góc làm việc</em>', lede: 'Hồ sơ, tuỳ chọn hiển thị, danh mục, bảo mật và sao lưu dữ liệu — tất cả ở một nơi.' })}
      <div class="st">
        <nav class="st-nav" aria-label="Mục cài đặt">
          ${SECTIONS.map(([id, label, ic], i) => html`<a href="#${id}" data-jump="${id}">${icon(ic)}<span>${label}</span></a>`)}
        </nav>
        <div class="st-body">

          <section class="st-sect" id="s-profile" aria-labelledby="h-profile">
            ${head('S.1', 'h-profile', 'Hồ sơ', 'Tên hiển thị dùng trong lời chào, thanh bên và báo cáo. Màu ảnh đại diện lưu trên thiết bị này.')}
            <form class="st-form" data-form="profile" novalidate>
              <div class="st-profile">
                <span class="avatar avatar--lg st-avatar" data-avatar style="${avatar ? `--avatar-bg:${avatar};--avatar-fg:var(--accent-contrast)` : ''}">${initials(store.displayName())}</span>
                <div class="st-profile__fields">
                  ${field({ label: 'Tên hiển thị', name: 'display_name', control: input('display_name', p.display_name, 'maxlength="80" autocomplete="name" placeholder="Ví dụ: Nguyễn Minh An"') })}
                  <div class="field">
                    <span class="field__label">Màu ảnh đại diện</span>
                    <div class="swatches" role="radiogroup" aria-label="Màu ảnh đại diện">
                      <label class="swatch st-swatch--ink" title="Mặc định"><input type="radio" name="avatar_color" value="" ${!avatar ? raw('checked') : ''} aria-label="Màu mặc định" /></label>
                      ${SWATCHES.map((c) => html`<label class="swatch" style="background:${c}" title="${c}"><input type="radio" name="avatar_color" value="${c}" ${avatar && avatar.toUpperCase() === c.toUpperCase() ? raw('checked') : ''} aria-label="Màu ${c}" /></label>`)}
                    </div>
                  </div>
                  <p class="field__hint">Email: <strong>${s.user?.email || '—'}</strong>${p.created_at ? html` · Tham gia ${day(p.created_at.slice(0, 10), 'medium')}` : ''}</p>
                </div>
              </div>
              <div class="st-actions"><button class="btn btn--primary" type="submit">Lưu hồ sơ</button></div>
            </form>
          </section>

          <section class="st-sect" id="s-prefs" aria-labelledby="h-prefs">
            ${head('S.2', 'h-prefs', 'Tuỳ chọn', 'Ảnh hưởng đến cách ngày, tuần và tiền tệ được tính trên mọi trang.')}
            <div class="st-form">
              <div class="field">
                <span class="field__label">Giao diện <span class="opt">áp dụng ngay</span></span>
                <div class="segmented st-theme" role="radiogroup" aria-label="Giao diện">
                  ${THEMES.map(([v, l, ic]) => html`<label><input type="radio" name="theme" data-theme-pick value="${v}" ${(p.theme || 'system') === v ? raw('checked') : ''} /><span>${icon(ic)} ${l}</span></label>`)}
                </div>
              </div>
            </div>
            <form class="st-form st-form--rule" data-form="prefs" novalidate>
              <div class="form-row">
                <div class="field">
                  <label class="field__label" for="f-tz">Múi giờ</label>
                  <select id="f-tz" class="select" name="timezone">
                    <optgroup label="Thường dùng">${tzs.common.map((z) => html`<option value="${z}" ${z === tz ? raw('selected') : ''}>${tzLabel(z)}</option>`)}</optgroup>
                    ${tzs.rest.length ? html`<optgroup label="Tất cả múi giờ">${tzs.rest.map((z) => html`<option value="${z}">${z.replace(/_/g, ' ')}</option>`)}</optgroup>` : ''}
                  </select>
                  <span class="field__hint">Xác định “hôm nay” và cách gom dữ liệu theo ngày.</span>
                  <span class="field__error" role="alert"></span>
                </div>
                ${field({ label: 'Tuần bắt đầu từ', name: 'week_starts_on', control: select('week_starts_on', WEEKDAYS.map((w, i) => ({ value: i, label: w })), p.week_starts_on ?? 1) })}
              </div>
              <div class="form-row">
                ${field({ label: 'Tiền tệ', name: 'currency', control: select('currency', CURRENCIES.map(([v, l]) => ({ value: v, label: l })), p.currency || 'VND') })}
                ${field({ label: 'Trang mở đầu', name: 'home', hint: 'Trang hiện ra sau khi đăng nhập trên thiết bị này.', control: select('home', HOME_PAGES.map((h) => ({ value: h.path, label: h.label })), home) })}
              </div>
              <div class="st-actions"><button class="btn btn--primary" type="submit">Lưu tuỳ chọn</button></div>
            </form>
          </section>

          <section class="st-sect" id="s-cats" aria-labelledby="h-cats">
            ${head('S.3', 'h-cats', 'Danh mục', 'Kéo biểu tượng ⋮⋮ (hoặc dùng phím mũi tên) để sắp xếp. Xoá danh mục không xoá dữ liệu — các mục liên quan trở thành “chưa phân loại”.')}
            <div class="st-form">
              <div class="st-cats__bar">
                <div class="segmented" role="group" aria-label="Loại danh mục">
                  <button type="button" data-kind="task" aria-pressed="${catKind === 'task'}">${icon('tasks')} Công việc</button>
                  <button type="button" data-kind="expense" aria-pressed="${catKind === 'expense'}">${icon('wallet')} Chi tiêu</button>
                </div>
                <button type="button" class="btn btn--sm" data-act="new-cat">${icon('plus')} Thêm danh mục</button>
              </div>
              <ul class="st-cats" data-cats aria-label="Danh sách danh mục"></ul>
            </div>
          </section>

          <section class="st-sect" id="s-security" aria-labelledby="h-security">
            ${head('S.4', 'h-security', 'Bảo mật', 'Đổi mật khẩu đăng nhập. Bạn cần nhập mật khẩu hiện tại để xác nhận.')}
            <form class="st-form" data-form="password" novalidate>
              <input type="email" name="username" value="${s.user?.email || ''}" autocomplete="username" hidden />
              ${field({ label: 'Mật khẩu hiện tại', name: 'current', control: input('current', '', 'type="password" autocomplete="current-password"') })}
              <div class="form-row">
                ${field({ label: 'Mật khẩu mới', name: 'password', hint: 'Tối thiểu 8 ký tự, nên kết hợp chữ, số và ký hiệu.', control: input('password', '', 'type="password" autocomplete="new-password" minlength="8"') })}
                ${field({ label: 'Nhập lại mật khẩu mới', name: 'confirm', control: input('confirm', '', 'type="password" autocomplete="new-password"') })}
              </div>
              <div class="st-actions"><button class="btn btn--primary" type="submit">Đổi mật khẩu</button></div>
            </form>
          </section>

          <section class="st-sect" id="s-data" aria-labelledby="h-data">
            ${head('S.5', 'h-data', 'Dữ liệu', 'Dữ liệu được bảo vệ bằng Row Level Security — chỉ tài khoản này đọc và ghi được. Hãy sao lưu định kỳ.')}
            <div class="st-form">
              <div class="st-data">
                <article class="st-card">
                  <span class="st-card__icon">${icon('download')}</span>
                  <h3>Sao lưu toàn bộ</h3>
                  <p>Tải một tệp JSON chứa danh mục, công việc, thời gian, KPI, chi tiêu, ngân sách, mua sắm và ghi chú.</p>
                  <button type="button" class="btn btn--primary" data-act="backup">${icon('download')} Tải bản sao lưu</button>
                  <span class="st-card__meta" data-backup-status>Tệp: note-mytasks-backup-YYYY-MM-DD.json</span>
                </article>
                <article class="st-card">
                  <span class="st-card__icon">${icon('upload')}</span>
                  <h3>Khôi phục từ tệp</h3>
                  <p>Nhập <strong>bản sao</strong> dữ liệu từ tệp sao lưu vào tài khoản này. Dữ liệu hiện có <strong>không bị xoá hay ghi đè</strong>; bạn sẽ xem trước trước khi nhập.</p>
                  <label class="btn st-file">
                    ${icon('upload')} Chọn tệp .json
                    <input type="file" class="sr-only" accept="application/json,.json" data-import />
                  </label>
                  <span class="st-card__meta">Nhập cùng một tệp hai lần sẽ tạo dữ liệu trùng.</span>
                </article>
              </div>

              <h3 class="st-sub">Xuất CSV từng bảng</h3>
              <p class="muted st-note">Mở được bằng Excel / Google Sheets (UTF-8). Dùng để phân tích, không dùng để khôi phục.</p>
              <div class="st-csv">
                ${BACKUP_TABLES.map((t) => html`<button type="button" class="btn btn--sm" data-csv="${t.table}">${icon('download')} ${t.label}</button>`)}
              </div>

              <ul class="list st-rows">
                <li><div class="grow"><strong>Xoá nhật ký hoạt động</strong><p class="muted">Chỉ xoá dòng “Hoạt động gần đây”; dữ liệu gốc giữ nguyên.</p></div><button type="button" class="btn btn--sm btn--danger-ghost" data-act="clear-activity">${icon('trash')} Xoá nhật ký</button></li>
                <li><div class="grow"><strong>Đăng xuất</strong><p class="muted">Kết thúc phiên trên trình duyệt này.</p></div><button type="button" class="btn btn--sm" data-act="signout">${icon('logout')} Đăng xuất</button></li>
              </ul>
            </div>
          </section>

          <section class="st-sect" id="s-keys" aria-labelledby="h-keys">
            ${head('S.6', 'h-keys', 'Phím tắt', 'Làm việc nhanh hơn bằng bàn phím. Phím tắt không hoạt động khi bạn đang gõ trong ô nhập liệu.')}
            <div class="st-form">
              <dl class="st-keys">
                ${SHORTCUTS.map((sc) => html`<div class="st-keys__row"><dt>${sc.keys.map((combo, i) => html`${i ? html`<span class="st-keys__then">rồi</span>` : ''}<span class="st-keys__combo">${combo.map((k, j) => html`${j ? '+' : ''}<kbd>${k}</kbd>`)}</span>`)}</dt><dd>${sc.label}</dd></div>`)}
              </dl>
            </div>
          </section>

          <section class="st-sect" id="s-install" aria-labelledby="h-install">
            ${head('S.7', 'h-install', 'Cài đặt ứng dụng', 'Note_mytasks là ứng dụng web cài được (PWA): mở nhanh từ màn hình chính, toàn màn hình, không cần cửa hàng ứng dụng.')}
            <div class="st-form">
              ${standalone ? html`<p class="notice notice--success">${icon('checkCircle')}<span>Bạn đang dùng Note_mytasks như một ứng dụng đã cài đặt.</span></p>` : ''}
              <div class="st-install">
                <article>
                  <h3>${icon('phone')} iPhone / iPad</h3>
                  <ol>
                    <li>Mở trang bằng <strong>Safari</strong>.</li>
                    <li>Chạm nút <strong>Chia sẻ</strong> (ô vuông có mũi tên lên).</li>
                    <li>Chọn <strong>Thêm vào MH chính</strong>, rồi <strong>Thêm</strong>.</li>
                  </ol>
                </article>
                <article>
                  <h3>${icon('phone')} Android</h3>
                  <ol>
                    <li>Mở trang bằng <strong>Chrome</strong>.</li>
                    <li>Chạm menu <strong>⋮</strong> ở góc trên.</li>
                    <li>Chọn <strong>Cài đặt ứng dụng</strong> (hoặc <strong>Thêm vào màn hình chính</strong>).</li>
                  </ol>
                </article>
                <article>
                  <h3>${icon('monitor')} Máy tính</h3>
                  <ol>
                    <li>Mở bằng <strong>Chrome</strong> hoặc <strong>Edge</strong>.</li>
                    <li>Bấm biểu tượng <strong>Cài đặt</strong> ở cuối thanh địa chỉ.</li>
                    <li>Xác nhận <strong>Cài đặt</strong> — ứng dụng có cửa sổ riêng.</li>
                  </ol>
                </article>
              </div>
              <p class="muted st-note">Dữ liệu vẫn nằm trên tài khoản của bạn; gỡ ứng dụng không làm mất dữ liệu.</p>
            </div>
          </section>
        </div>
      </div>`);
    renderCats();
    watchSections();
  }

  function head(num, id, title, text) {
    return html`<header class="st-head"><div><h2 id="${id}">${title}</h2><p>${text}</p></div></header>`;
  }

  function watchSections() {
    observer?.disconnect();
    if (!('IntersectionObserver' in window)) return;
    const links = new Map([...root.querySelectorAll('[data-jump]')].map((a) => [a.dataset.jump, a]));
    observer = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!vis) return;
      links.forEach((a, id) => a.classList.toggle('is-active', id === vis.target.id));
    }, { rootMargin: '-20% 0px -65% 0px' });
    root.querySelectorAll('.st-sect').forEach((s) => observer.observe(s));
  }

  /* ---------- categories ---------- */
  function renderCats() {
    const list = store.categoriesOf(catKind);
    const box = root.querySelector('[data-cats]');
    if (!box) return;
    mount(box, list.length
      ? html`${list.map((c) => html`
          <li class="st-cat" data-id="${c.id}">
            <button type="button" class="st-cat__grip" data-grip aria-label="Sắp xếp “${c.name}” — kéo, hoặc dùng phím mũi tên lên/xuống">${icon('grip')}</button>
            <span class="st-cat__swatch" style="--c:${c.color || 'var(--ink-4)'}"></span>
            <span class="st-cat__name"><strong class="truncate">${c.name}</strong>${c.is_default ? html`<span class="badge badge--plain badge--outline">Mặc định</span>` : ''}</span>
            <button type="button" class="icon-btn" data-act="edit-cat" aria-label="Sửa ${c.name}">${icon('edit')}</button>
            <button type="button" class="icon-btn" data-act="del-cat" aria-label="Xoá ${c.name}">${icon('trash')}</button>
          </li>`)}`
      : html`<li class="st-cat st-cat--empty muted">Chưa có danh mục nào — bấm “Thêm danh mục”.</li>`);
  }

  function openCatForm(c = null) {
    openModal({
      eyebrow: c ? 'Sửa danh mục' : `Danh mục ${catKind === 'task' ? 'công việc' : 'chi tiêu'} mới`,
      title: c ? c.name : 'Thêm danh mục',
      size: 'narrow',
      body: html`<div class="form">
        ${field({ label: 'Tên', name: 'name', control: input('name', c?.name, 'maxlength="50" required autocomplete="off"') })}
        <div class="field"><span class="field__label">Màu</span>${swatchPicker('color', c?.color)}</div>
      </div>`,
      submitLabel: c ? 'Lưu' : 'Thêm',
      validate: (v) => {
        if (!v.name) return { name: 'Hãy nhập tên.' };
        const kind = c?.kind || catKind;
        const dup = store.categoriesOf(kind).some((x) => x.id !== c?.id && x.name.toLowerCase() === v.name.toLowerCase());
        return dup ? { name: 'Đã có danh mục cùng tên.' } : {};
      },
      async onSubmit(v) {
        if (c) await updateCategory(c.id, { name: v.name, color: v.color });
        else {
          const max = Math.max(0, ...store.categoriesOf(catKind).map((x) => Number(x.sort_order) || 0));
          await createCategory({ kind: catKind, name: v.name, color: v.color, sort_order: max + 10 });
        }
        await reloadCategories();
        renderCats();
        notifyDataChanged('categories');
        toast(c ? 'Đã lưu danh mục.' : 'Đã thêm danh mục.');
      },
    });
  }

  let orderTimer = null;
  async function persistOrder() {
    const ids = [...root.querySelectorAll('[data-cats] [data-id]')].map((li) => li.dataset.id);
    if (ids.length < 2) return;
    try {
      await reorder(ids);
      await reloadCategories();
      notifyDataChanged('categories');
      toast('Đã lưu thứ tự danh mục.', { duration: 2000 });
    } catch (err) {
      toast.error(err);
      renderCats();
    }
  }
  const persistSoon = () => { clearTimeout(orderTimer); orderTimer = setTimeout(persistOrder, 600); };

  // Pointer drag (mouse + touch) on the grip handle.
  let drag = null;
  disposers.push(on(root, 'pointerdown', '[data-grip]', (e, grip) => {
    if (e.button !== 0) return;
    const li = grip.closest('[data-id]');
    if (!li) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    drag = { li, moved: false };
    li.classList.add('is-dragging');
    li.parentElement.classList.add('is-sorting');
  }));
  const onMove = (e) => {
    if (!drag) return;
    const list = drag.li.parentElement;
    const others = [...list.querySelectorAll('[data-id]')].filter((x) => x !== drag.li);
    const before = others.find((it) => { const r = it.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; }) || null;
    if (before ? drag.li.nextElementSibling !== before : list.lastElementChild !== drag.li) {
      list.insertBefore(drag.li, before);
      drag.moved = true;
    }
  };
  const onUp = () => {
    if (!drag) return;
    const { li, moved } = drag;
    drag = null;
    li.classList.remove('is-dragging');
    li.parentElement?.classList.remove('is-sorting');
    if (moved) persistOrder();
  };
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  disposers.push(() => {
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
  });
  disposers.push(on(root, 'keydown', '[data-grip]', (e, grip) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const li = grip.closest('[data-id]');
    const sib = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    if (e.key === 'ArrowUp') li.parentElement.insertBefore(li, sib);
    else li.parentElement.insertBefore(sib, li);
    grip.focus();
    persistSoon();
  }));

  /* ---------- data: backup / restore ---------- */
  async function doBackup(btn) {
    const status = root.querySelector('[data-backup-status]');
    setBusy(btn, true);
    try {
      const data = await downloadBackup({ onProgress: ({ label }) => { if (status) status.textContent = `Đang đọc: ${label}…`; } });
      const total = Object.values(data.counts).reduce((s, n) => s + n, 0);
      if (status) status.textContent = `Đã tải ${num(total)} dòng lúc ${dateTime(new Date())}.`;
      toast(`Đã tạo bản sao lưu (${num(total)} dòng).`);
    } catch (err) {
      if (status) status.textContent = 'Sao lưu chưa thành công.';
      toast.error(err);
    } finally {
      setBusy(btn, false);
    }
  }

  async function previewImport(file) {
    let parsed;
    try {
      parsed = await parseBackup(file);
    } catch (err) {
      return toast.error(err);
    }
    const { backup, counts, total, exported_at: at, unknown } = parsed;
    const hasCompleted = (backup.tables.tasks || []).some((t) => t.status === 'completed');
    openModal({
      eyebrow: 'Khôi phục dữ liệu',
      title: 'Xem trước tệp sao lưu',
      size: 'wide',
      body: html`
        <div class="st-import">
          <p class="muted">${file.name}${at ? html` · tạo lúc <strong>${dateTime(at)}</strong>` : ''} · tổng <strong>${num(total)}</strong> dòng</p>
          <div class="table-wrap"><table class="table st-import__table">
            <thead><tr><th>Bảng</th><th class="r">Số dòng trong tệp</th></tr></thead>
            <tbody>${BACKUP_TABLES.map((t) => html`<tr class="${counts[t.table] ? '' : 'is-zero'}"><td>${t.label}</td><td class="r num">${num(counts[t.table])}</td></tr>`)}</tbody>
          </table></div>
          <div class="notice notice--warning st-import__warn">${icon('alert')}<div>
            <strong>Đọc kỹ trước khi nhập</strong>
            <ul>
              <li>Dữ liệu được <strong>thêm vào</strong> tài khoản hiện tại (${store.get().user?.email || ''}); không xoá hay sửa dữ liệu đang có.</li>
              <li>Danh mục trùng tên được dùng lại; ngân sách đã đặt cho cùng tháng được giữ nguyên.</li>
              <li>Nhập cùng một tệp nhiều lần sẽ tạo bản sao trùng lặp.</li>
              ${hasCompleted ? html`<li>Thời điểm hoàn thành của công việc đã xong sẽ được ghi lại theo thời điểm nhập.</li>` : ''}
              <li>Bộ đếm giờ đang chạy trong tệp (nếu có) sẽ được bỏ qua.</li>
              ${unknown.length ? html`<li>Bỏ qua bảng không hỗ trợ: ${unknown.join(', ')}.</li>` : ''}
            </ul>
          </div></div>
          <p class="st-import__progress" data-progress aria-live="polite" hidden></p>
        </div>`,
      submitLabel: `Nhập ${num(total)} dòng`,
      async onSubmit(_, { el }) {
        const prog = el.querySelector('[data-progress]');
        prog.hidden = false;
        const report = await importAll(backup, {
          onProgress: ({ label, step, total: n }) => { prog.textContent = `Đang nhập ${label}… (${step}/${n})`; },
        });
        await reloadCategories().catch(() => {});
        notifyDataChanged('all');
        showImportResult(report);
      },
    });
  }

  function showImportResult(r) {
    const ins = Object.values(r.inserted).reduce((s, n) => s + n, 0);
    const failed = Object.values(r.failed).reduce((s, n) => s + n, 0);
    openModal({
      eyebrow: 'Khôi phục dữ liệu',
      title: failed ? 'Đã nhập, có một số lỗi' : 'Nhập dữ liệu hoàn tất',
      size: 'wide',
      onSubmit: null,
      body: html`
        <p class="muted">Đã thêm <strong>${num(ins)}</strong> dòng${failed ? html`, <strong class="st-err">${num(failed)}</strong> dòng lỗi` : ''}.</p>
        <div class="table-wrap"><table class="table st-import__table">
          <thead><tr><th>Bảng</th><th class="r">Đã thêm</th><th class="r">Bỏ qua</th><th class="r">Lỗi</th></tr></thead>
          <tbody>${BACKUP_TABLES.map((t) => html`<tr><td>${tableLabel(t.table)}</td><td class="r num">${num(r.inserted[t.table] || 0)}</td><td class="r num muted">${num(r.skipped[t.table] || 0)}</td><td class="r num ${r.failed[t.table] ? 'st-err' : 'muted'}">${num(r.failed[t.table] || 0)}</td></tr>`)}</tbody>
        </table></div>
        ${r.warnings.length ? html`<ul class="st-import__list">${r.warnings.map((w) => html`<li>${icon('info')} ${w}</li>`)}</ul>` : ''}
        ${r.errors.length ? html`<ul class="st-import__list st-import__list--err">${r.errors.map((w) => html`<li>${icon('alert')} ${w}</li>`)}</ul>` : ''}`,
    });
    toast(failed ? `Đã nhập ${num(ins)} dòng, ${num(failed)} dòng lỗi.` : `Đã nhập ${num(ins)} dòng.`, { type: failed ? 'info' : 'success' });
  }

  /* ---------- forms ---------- */
  async function submitForm(form, kind) {
    const btn = form.querySelector('[type=submit]');
    const v = formData(form);
    if (kind === 'profile') {
      if ((v.display_name || '').length > 80) return showErrors(form, { display_name: 'Tối đa 80 ký tự.' });
      setBusy(btn, true);
      try {
        const profile = await updateProfile({ display_name: v.display_name || null });
        setAvatarColor(v.avatar_color || null);
        store.set({ profile });
        toast('Đã lưu hồ sơ.');
        render();
      } catch (err) { toast.error(err); } finally { setBusy(btn, false); }
    }
    if (kind === 'prefs') {
      if (!isValidTimezone(v.timezone)) return showErrors(form, { timezone: 'Múi giờ không hợp lệ.' });
      setBusy(btn, true);
      try {
        const profile = await updateProfile({ currency: v.currency, timezone: v.timezone, week_starts_on: Number(v.week_starts_on) });
        setHomePage(v.home);
        store.set({ profile });
        configureDates({ timezone: profile.timezone, weekStartsOn: profile.week_starts_on });
        configureFormat({ currency: profile.currency });
        notifyDataChanged('profile');
        toast('Đã lưu tuỳ chọn.');
      } catch (err) { toast.error(err); } finally { setBusy(btn, false); }
    }
    if (kind === 'password') {
      const e = {};
      if (!v.current) e.current = 'Nhập mật khẩu hiện tại.';
      if (!v.password || v.password.length < 8) e.password = 'Tối thiểu 8 ký tự.';
      else if (v.password === v.current) e.password = 'Mật khẩu mới phải khác mật khẩu hiện tại.';
      if (v.confirm !== v.password) e.confirm = 'Hai mật khẩu chưa khớp.';
      if (!showErrors(form, e)) return;
      setBusy(btn, true);
      try {
        try { await verifyPassword(store.get().user.email, v.current); } catch { return showErrors(form, { current: 'Mật khẩu hiện tại không đúng.' }); }
        await updatePassword(v.password);
        form.reset();
        toast('Đã đổi mật khẩu.');
      } catch (err) { toast.error(err); } finally { setBusy(btn, false); }
    }
  }

  /* ---------- events ---------- */
  disposers.push(on(root, 'submit', 'form[data-form]', (e, form) => { e.preventDefault(); submitForm(form, form.dataset.form); }));
  disposers.push(on(root, 'change', 'input[name="avatar_color"]', (e, el) => {
    const a = root.querySelector('[data-avatar]');
    if (!a) return;
    if (el.value) { a.style.setProperty('--avatar-bg', el.value); a.style.setProperty('--avatar-fg', 'var(--accent-contrast)'); }
    else { a.style.removeProperty('--avatar-bg'); a.style.removeProperty('--avatar-fg'); }
  }));
  disposers.push(on(root, 'input', 'input[name="display_name"]', (e, el) => {
    const a = root.querySelector('[data-avatar]');
    if (a) a.textContent = initials(el.value || store.displayName());
  }));
  disposers.push(on(root, 'change', '[data-theme-pick]', async (e, el) => {
    const theme = el.value;
    try {
      const profile = await updateProfile({ theme });
      store.set({ profile });
    } catch (err) {
      toast.error(err);
    }
    applyTheme(theme, { persist: true }); // the app re-renders this page
  }));
  disposers.push(on(root, 'click', '[data-jump]', (e, el) => {
    e.preventDefault(); // keep the hash router intact
    document.getElementById(el.dataset.jump)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
  disposers.push(on(root, 'click', '[data-kind]', (e, el) => {
    catKind = el.dataset.kind;
    root.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === catKind)));
    renderCats();
  }));
  disposers.push(on(root, 'change', '[data-import]', (e, el) => {
    const file = el.files?.[0];
    el.value = '';
    if (file) previewImport(file);
  }));
  disposers.push(on(root, 'click', '[data-csv]', async (e, el) => {
    setBusy(el, true);
    try {
      const n = await downloadTableCsv(el.dataset.csv);
      toast(`Đã xuất ${num(n)} dòng (${tableLabel(el.dataset.csv)}).`);
    } catch (err) {
      toast.error(el.dataset.csv === 'notes' ? 'Chưa có bảng Ghi chú trên máy chủ.' : err);
    } finally {
      setBusy(el, false);
    }
  }));
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    const c = store.categoryById(el.closest('[data-id]')?.dataset.id);
    if (a === 'new-cat') openCatForm();
    if (a === 'edit-cat' && c) openCatForm(c);
    if (a === 'del-cat' && c) {
      const ok = await confirmDialog({
        title: `Xoá danh mục “${c.name}”?`,
        message: c.kind === 'expense'
          ? 'Các khoản chi và món mua sắm thuộc danh mục này sẽ thành “chưa phân loại”. Ngân sách riêng của danh mục sẽ bị xoá.'
          : 'Các công việc thuộc danh mục này sẽ thành “chưa phân loại”.',
      });
      if (!ok) return;
      try {
        const res = await deleteCategory(c.id);
        await reloadCategories();
        renderCats();
        notifyDataChanged('categories');
        toast(res?.warning || 'Đã xoá danh mục.');
      } catch (err) { toast.error(err); }
    }
    if (a === 'backup') doBackup(el);
    if (a === 'clear-activity') {
      if (!(await confirmDialog({ title: 'Xoá nhật ký hoạt động?', message: 'Toàn bộ dòng “Hoạt động gần đây” sẽ bị xoá. Không thể hoàn tác.' }))) return;
      try { await clearActivity(); notifyDataChanged('activity'); toast('Đã xoá nhật ký hoạt động.'); } catch (err) { toast.error(err); }
    }
    if (a === 'signout') {
      try { await signOut(); } catch (err) { toast.error(err); }
      store.clearUserState();
      location.hash = '#/login';
    }
  }));

  render();
  return () => {
    if (orderTimer) { clearTimeout(orderTimer); persistOrder(); } // flush a pending keyboard reorder
    observer?.disconnect();
    disposers.forEach((d) => d());
  };
}
