import { html, mount, on, raw, formData, setBusy, showErrors } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, swatchPicker } from '../components/ui.js';
import { openModal, field, input, select, confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { applyTheme } from '../components/theme.js';
import { reloadCategories } from '../components/context.js';
import * as store from '../core/store.js';
import { updateProfile } from '../services/profile.js';
import { createCategory, updateCategory, deleteCategory } from '../services/categories.js';
import { verifyPassword, updatePassword, signOut } from '../services/auth.js';
import { clearActivity } from '../services/activity.js';
import { configureDates, getTimezone } from '../utils/date.js';
import { configureFormat } from '../utils/format.js';
import { initials, day } from '../utils/format.js';

const CURRENCIES = [
  ['VND', 'VND — Việt Nam đồng'], ['USD', 'USD — Đô la Mỹ'], ['EUR', 'EUR — Euro'], ['JPY', 'JPY — Yên Nhật'],
  ['KRW', 'KRW — Won Hàn Quốc'], ['SGD', 'SGD — Đô la Singapore'], ['THB', 'THB — Baht Thái'], ['AUD', 'AUD — Đô la Úc'],
];
const TIMEZONES = ['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];
const WEEKDAYS = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

export default async function settingsPage(root) {
  const disposers = [];
  let catKind = 'task';

  function render() {
    const s = store.get();
    const p = s.profile || {};
    const tz = p.timezone || getTimezone();
    const tzList = TIMEZONES.includes(tz) ? TIMEZONES : [tz, ...TIMEZONES];
    mount(root, html`
      ${pageHead({ num: '09', kicker: 'Cài đặt', title: 'Sắp đặt <em>góc làm việc</em>', lede: 'Hồ sơ, đơn vị hiển thị, danh mục và bảo mật tài khoản.' })}
      <div class="settings">
        <nav class="settings__nav" aria-label="Mục cài đặt">
          <a href="#s-profile" data-jump="s-profile">${icon('user')} Hồ sơ</a>
          <a href="#s-prefs" data-jump="s-prefs">${icon('settings')} Tùy chọn</a>
          <a href="#s-cats" data-jump="s-cats">${icon('tag')} Danh mục</a>
          <a href="#s-security" data-jump="s-security">${icon('lock')} Bảo mật</a>
          <a href="#s-data" data-jump="s-data">${icon('folder')} Dữ liệu</a>
        </nav>
        <div class="settings__body">

          <section class="sheet settings__sect" id="s-profile">
            <header class="settings__head"><span class="sheet__num">S.1</span><div><h2>Hồ sơ</h2><p class="muted">Tên hiển thị dùng trong lời chào và trên thanh điều hướng.</p></div></header>
            <form class="form settings__form" data-form="profile" novalidate>
              <div class="row" style="gap:var(--s-5)">
                <span class="avatar avatar--lg">${initials(store.displayName())}</span>
                <div class="grow stack-sm">
                  ${field({ label: 'Tên hiển thị', name: 'display_name', control: input('display_name', p.display_name, 'maxlength="80" autocomplete="name"') })}
                  <span class="field__hint">Email: <strong>${s.user?.email}</strong> · Tham gia ${p.created_at ? day(p.created_at.slice(0, 10), 'medium') : ''}</span>
                </div>
              </div>
              <div class="settings__actions"><button class="btn btn--primary" type="submit">Lưu hồ sơ</button></div>
            </form>
          </section>

          <section class="sheet settings__sect" id="s-prefs">
            <header class="settings__head"><span class="sheet__num">S.2</span><div><h2>Tùy chọn hiển thị</h2><p class="muted">Ảnh hưởng đến cách ngày, tiền tệ và tuần được tính trên mọi trang.</p></div></header>
            <form class="form settings__form" data-form="prefs" novalidate>
              <div class="form-row">
                ${field({ label: 'Tiền tệ', name: 'currency', control: select('currency', CURRENCIES.map(([v, l]) => ({ value: v, label: l })), p.currency || 'VND') })}
                ${field({ label: 'Múi giờ', name: 'timezone', hint: 'Dùng để xác định “hôm nay” và gom dữ liệu theo ngày.', control: select('timezone', tzList.map((z) => ({ value: z, label: z.replace('_', ' ') })), tz) })}
              </div>
              <div class="form-row">
                ${field({ label: 'Tuần bắt đầu từ', name: 'week_starts_on', control: select('week_starts_on', WEEKDAYS.map((w, i) => ({ value: i, label: w })), p.week_starts_on ?? 1) })}
                <div class="field">
                  <span class="field__label">Giao diện</span>
                  <div class="segmented" role="radiogroup" aria-label="Giao diện">
                    ${[['light', 'Sáng', 'sun'], ['dark', 'Tối', 'moon'], ['system', 'Hệ thống', 'monitor']].map(([v, l, ic]) => html`<label><input type="radio" name="theme" value="${v}" ${(p.theme || 'system') === v ? raw('checked') : ''} /><span>${icon(ic)} ${l}</span></label>`)}
                  </div>
                </div>
              </div>
              <div class="settings__actions"><button class="btn btn--primary" type="submit">Lưu tùy chọn</button></div>
            </form>
          </section>

          <section class="sheet settings__sect" id="s-cats">
            <header class="settings__head"><span class="sheet__num">S.3</span><div><h2>Danh mục</h2><p class="muted">Màu sắc giúp nhận diện nhanh trên lịch, biểu đồ và danh sách. Xóa danh mục không xóa dữ liệu — các mục liên quan trở thành “chưa phân loại”.</p></div></header>
            <div class="settings__form">
              <div class="row between" style="margin-bottom:var(--s-4);flex-wrap:wrap;gap:var(--s-3)">
                <div class="segmented" role="group">
                  <button type="button" data-kind="task" aria-pressed="${catKind === 'task'}">${icon('tasks')} Công việc</button>
                  <button type="button" data-kind="expense" aria-pressed="${catKind === 'expense'}">${icon('wallet')} Chi tiêu</button>
                </div>
                <button class="btn btn--sm" data-act="new-cat">${icon('plus')} Thêm danh mục</button>
              </div>
              <ul class="list cat-list" data-cats></ul>
            </div>
          </section>

          <section class="sheet settings__sect" id="s-security">
            <header class="settings__head"><span class="sheet__num">S.4</span><div><h2>Bảo mật</h2><p class="muted">Đổi mật khẩu đăng nhập. Bạn cần nhập mật khẩu hiện tại để xác nhận.</p></div></header>
            <form class="form settings__form" data-form="password" novalidate>
              <input type="email" name="username" value="${s.user?.email || ''}" autocomplete="username" hidden />
              ${field({ label: 'Mật khẩu hiện tại', name: 'current', control: input('current', '', 'type="password" autocomplete="current-password"') })}
              <div class="form-row">
                ${field({ label: 'Mật khẩu mới', name: 'password', hint: 'Tối thiểu 8 ký tự.', control: input('password', '', 'type="password" autocomplete="new-password"') })}
                ${field({ label: 'Nhập lại mật khẩu mới', name: 'confirm', control: input('confirm', '', 'type="password" autocomplete="new-password"') })}
              </div>
              <div class="settings__actions"><button class="btn btn--primary" type="submit">Đổi mật khẩu</button></div>
            </form>
          </section>

          <section class="sheet settings__sect" id="s-data">
            <header class="settings__head"><span class="sheet__num">S.5</span><div><h2>Dữ liệu & phiên</h2><p class="muted">Dữ liệu của bạn được bảo vệ bằng Row Level Security — chỉ tài khoản này đọc được.</p></div></header>
            <div class="settings__form">
              <ul class="list settings__rows">
                <li><div class="grow"><strong>Xuất dữ liệu (CSV)</strong><p class="muted">Tải công việc, thời gian, chi tiêu, mua sắm và KPI — nên làm định kỳ để sao lưu.</p></div><a class="btn btn--sm" href="#/reports">${icon('download')} Mở báo cáo</a></li>
                <li><div class="grow"><strong>Xóa nhật ký hoạt động</strong><p class="muted">Chỉ xóa dòng “Hoạt động gần đây”; dữ liệu gốc giữ nguyên.</p></div><button class="btn btn--sm btn--danger-ghost" data-act="clear-activity">${icon('trash')} Xóa nhật ký</button></li>
                <li><div class="grow"><strong>Đăng xuất</strong><p class="muted">Kết thúc phiên trên trình duyệt này.</p></div><button class="btn btn--sm" data-act="signout">${icon('logout')} Đăng xuất</button></li>
              </ul>
            </div>
          </section>
        </div>
      </div>`);
    renderCats();
  }

  function renderCats() {
    const list = store.categoriesOf(catKind);
    const box = root.querySelector('[data-cats]');
    if (!box) return;
    mount(box, list.length
      ? html`${list.map((c) => html`
          <li class="cat-item" data-id="${c.id}">
            <span class="cat-item__swatch" style="background:${c.color || 'var(--ink-4)'}"></span>
            <span class="grow"><strong>${c.name}</strong>${c.is_default ? html` <span class="badge badge--plain badge--outline">Mặc định</span>` : ''}</span>
            <button class="icon-btn icon-btn--sm" data-act="edit-cat" aria-label="Sửa ${c.name}">${icon('edit')}</button>
            <button class="icon-btn icon-btn--sm" data-act="del-cat" aria-label="Xóa ${c.name}">${icon('trash')}</button>
          </li>`)}`
      : html`<li class="muted" style="padding:var(--s-4) 0">Chưa có danh mục nào.</li>`);
  }

  function openCatForm(c = null) {
    openModal({
      eyebrow: c ? 'Sửa danh mục' : `Danh mục ${catKind === 'task' ? 'công việc' : 'chi tiêu'} mới`,
      title: c ? c.name : 'Thêm danh mục',
      size: 'narrow',
      body: html`<div class="form">
        ${field({ label: 'Tên', name: 'name', control: input('name', c?.name, 'maxlength="50" required') })}
        <div class="field"><span class="field__label">Màu</span>${swatchPicker('color', c?.color)}</div>
      </div>`,
      submitLabel: c ? 'Lưu' : 'Thêm',
      validate: (v) => {
        if (!v.name) return { name: 'Hãy nhập tên.' };
        const dup = store.categoriesOf(catKind).some((x) => x.id !== c?.id && x.name.toLowerCase() === v.name.toLowerCase());
        return dup ? { name: 'Đã có danh mục cùng tên.' } : {};
      },
      async onSubmit(v) {
        if (c) await updateCategory(c.id, { name: v.name, color: v.color });
        else await createCategory({ kind: catKind, name: v.name, color: v.color, sort_order: (store.categoriesOf(catKind).length + 1) * 10 });
        await reloadCategories();
        renderCats();
        toast(c ? 'Đã lưu danh mục.' : 'Đã thêm danh mục.');
      },
    });
  }

  async function submitForm(form, kind) {
    const btn = form.querySelector('[type=submit]');
    const v = formData(form);
    const uid = store.get().user.id;
    if (kind === 'profile') {
      if (v.display_name.length > 80) return showErrors(form, { display_name: 'Tối đa 80 ký tự.' });
      setBusy(btn, true);
      try {
        const profile = await updateProfile({ display_name: v.display_name || null });
        store.set({ profile });
        toast('Đã lưu hồ sơ.');
        render();
      } catch (err) { toast.error(err); } finally { setBusy(btn, false); }
    }
    if (kind === 'prefs') {
      setBusy(btn, true);
      try {
        const profile = await updateProfile({ currency: v.currency, timezone: v.timezone, week_starts_on: Number(v.week_starts_on), theme: v.theme });
        store.set({ profile });
        configureDates({ timezone: profile.timezone, weekStartsOn: profile.week_starts_on });
        configureFormat({ currency: profile.currency });
        toast('Đã lưu tùy chọn.');
        applyTheme(profile.theme, { persist: true }); // re-renders the page
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
    void uid;
  }

  disposers.push(on(root, 'submit', 'form[data-form]', (e, form) => { e.preventDefault(); submitForm(form, form.dataset.form); }));
  disposers.push(on(root, 'click', '[data-jump]', (e, el) => {
    e.preventDefault(); // keep the hash router intact
    document.getElementById(el.dataset.jump)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  disposers.push(on(root, 'click', '[data-kind]', (e, el) => {
    catKind = el.dataset.kind;
    root.querySelectorAll('[data-kind]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === catKind)));
    renderCats();
  }));
  disposers.push(on(root, 'click', '[data-act]', async (e, el) => {
    const a = el.dataset.act;
    const c = store.categoryById(el.closest('[data-id]')?.dataset.id);
    if (a === 'new-cat') openCatForm();
    if (a === 'edit-cat' && c) openCatForm(c);
    if (a === 'del-cat' && c) {
      const ok = await confirmDialog({
        title: `Xóa danh mục “${c.name}”?`,
        message: c.kind === 'expense'
          ? 'Các khoản chi và món mua sắm thuộc danh mục này sẽ thành “chưa phân loại”. Ngân sách riêng của danh mục sẽ bị xóa.'
          : 'Các công việc thuộc danh mục này sẽ thành “chưa phân loại”.',
      });
      if (!ok) return;
      try {
        const res = await deleteCategory(c.id);
        await reloadCategories();
        renderCats();
        toast(res?.warning || 'Đã xóa danh mục.');
      } catch (err) { toast.error(err); }
    }
    if (a === 'clear-activity') {
      if (!(await confirmDialog({ title: 'Xóa nhật ký hoạt động?', message: 'Toàn bộ dòng “Hoạt động gần đây” sẽ bị xóa. Không thể hoàn tác.' }))) return;
      try { await clearActivity(); toast('Đã xóa nhật ký hoạt động.'); } catch (err) { toast.error(err); }
    }
    if (a === 'signout') {
      try { await signOut(); } catch (err) { toast.error(err); }
      store.clearUserState();
      location.hash = '#/login';
    }
  }));

  render();
  return () => disposers.forEach((d) => d());
}
