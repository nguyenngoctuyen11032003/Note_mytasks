// Sign in · Sign up · Forgot password · Reset password (after recovery link)
// plus the "page not found" view for unknown routes (renderNotFound).
import { html, mount, formData, setBusy, showErrors } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { field, input } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { navigate, href } from '../core/router.js';
import { signIn, signUp, requestPasswordReset, updatePassword, resendConfirmation } from '../services/auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PW = 8;

const COPY = {
  login: {
    title: 'Chào mừng trở lại',
    lede: 'Đăng nhập để mở công việc, thời gian, mục tiêu và chi tiêu của bạn.',
  },
  signup: {
    title: 'Tạo tài khoản',
    lede: 'Miễn phí và riêng tư — mỗi tài khoản là một không gian dữ liệu tách biệt.',
  },
  'forgot-password': {
    title: 'Quên mật khẩu?',
    lede: 'Nhập email đã đăng ký, chúng tôi sẽ gửi liên kết để bạn đặt mật khẩu mới.',
  },
  reset: {
    title: 'Đặt mật khẩu mới',
    lede: `Mật khẩu cần tối thiểu ${MIN_PW} ký tự. Sau khi lưu, bạn sẽ vào thẳng ứng dụng.`,
  },
};

const FEATURES = [
  ['tasks', 'Công việc', 'Ưu tiên, hạn chót, nhãn, bộ lọc và tìm kiếm.'],
  ['clock', 'Thời gian', 'Bấm giờ theo từng việc, tổng hôm nay, tuần, tháng.'],
  ['target', 'Mục tiêu KPI', 'Chỉ tiêu, tiến độ và lịch sử cập nhật.'],
  ['wallet', 'Chi tiêu & ngân sách', 'Ngân sách theo tháng, cảnh báo khi vượt mức.'],
];

const brand = (cls = '') => html`
  <a class="brand ${cls}" href="#/login" aria-label="Note_mytasks">
    <span class="brand__mark" aria-hidden="true">N</span>
    <span class="brand__text"><span class="brand__name">Note_mytasks</span><span class="brand__sub">Sổ tay cá nhân</span></span>
  </a>`;

export default function renderAuth(app, { kind, query }) {
  const c = COPY[kind] || COPY.login;
  mount(app, html`
    <div class="auth">
      <section class="auth__plate auth-panel" aria-label="Giới thiệu Note_mytasks">
        ${brand()}
        <div class="auth-panel__body">
          <h2 class="auth-panel__title">Mọi việc của một ngày, gọn trong một chỗ.</h2>
          <p class="auth-panel__lede">Ghi chú, công việc, thời gian, mục tiêu và chi tiêu — đồng bộ trên mọi thiết bị của bạn.</p>
          <ul class="auth-panel__list">
            ${FEATURES.map(([ic, t, d]) => html`<li><span class="auth-panel__icon" aria-hidden="true">${icon(ic)}</span><span><strong>${t}</strong><span>${d}</span></span></li>`)}
          </ul>
        </div>
        <p class="auth-panel__foot">${icon('shield')}<span>Dữ liệu của bạn được bảo vệ theo từng tài khoản — không ai khác xem được.</span></p>
      </section>
      <main class="auth__side" id="auth-main">
        <div class="auth__card">
          ${brand('auth__mbrand')}
          <h1>${c.title}</h1>
          <p class="auth__lede">${c.lede}</p>
          <div data-notice aria-live="polite"></div>
          ${formFor(kind, query)}
          ${footFor(kind)}
        </div>
      </main>
    </div>`);
  document.title = `${c.title} · Note_mytasks`;

  const form = app.querySelector('form');
  const btn = form.querySelector('[type=submit]');
  const notice = app.querySelector('[data-notice]');
  const caps = form.querySelector('[data-caps]');

  app.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => {
      const inp = b.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = String(icon(show ? 'eyeOff' : 'eye'));
      b.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      b.setAttribute('aria-pressed', String(show));
      inp.focus();
    }),
  );

  // Caps Lock warning while typing a password.
  const onCaps = (e) => {
    if (!caps || typeof e.getModifierState !== 'function') return;
    caps.hidden = !e.getModifierState('CapsLock');
  };
  form.querySelectorAll('input[name=password], input[name=confirm]').forEach((inp) => {
    inp.addEventListener('keydown', onCaps);
    inp.addEventListener('keyup', onCaps);
    inp.addEventListener('blur', () => { if (caps) caps.hidden = true; });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    const v = formData(form);
    if (!showErrors(form, validate(kind, v))) return;
    notice.innerHTML = '';
    setBusy(btn, true);
    try {
      await submit(kind, v, notice, form);
    } catch (err) {
      if (err.code === 'email_not_confirmed') showResend(notice, v.email);
      else if (err.code === 'user_already_exists') showNotice(notice, 'danger', html`Email <strong>${v.email}</strong> đã được đăng ký. <a href="${href('/login', { email: v.email })}">Đăng nhập</a> hoặc <a href="${href('/forgot-password', { email: v.email })}">đặt lại mật khẩu</a>.`);
      else showNotice(notice, 'danger', err.message || 'Đã có lỗi xảy ra. Vui lòng thử lại.');
      if (kind === 'login' && err.code !== 'email_not_confirmed') {
        const pw = form.querySelector('input[name=password]');
        pw?.select();
        pw?.focus();
      }
    } finally {
      setBusy(btn, false);
    }
  });

  // Prefilled e-mail (link from a notice) → start in the password box.
  const first = query?.email ? form.querySelector('input[name=password]') : null;
  (first || form.querySelector('input:not([type=hidden])'))?.focus();
}

function formFor(kind, query) {
  const pw = (name, label, auto, hint) =>
    field({
      label,
      name,
      hint,
      control: html`<div class="input-group">${icon('lock')}<input id="__ID__" class="input has-suffix" type="password" name="${name}" autocomplete="${auto}" required minlength="${kind === 'login' ? 1 : MIN_PW}" /><button type="button" class="icon-btn icon-btn--sm auth__reveal" data-reveal aria-label="Hiện mật khẩu" aria-pressed="false">${icon('eye')}</button></div>`,
    });
  const email = field({
    label: 'Email',
    name: 'email',
    control: html`<div class="input-group">${icon('mail')}<input id="__ID__" class="input" type="email" name="email" value="${query?.email || ''}" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" required placeholder="ban@vidu.com" /></div>`,
  });
  const capsNote = html`<p class="auth__caps" data-caps hidden role="status">${icon('alert')} Caps Lock đang bật.</p>`;

  if (kind === 'signup')
    return html`<form class="form" novalidate>
      ${field({ label: 'Tên hiển thị', name: 'display_name', optional: true, control: html`<div class="input-group">${icon('user')}${input('display_name', '', 'autocomplete="name" maxlength="80" placeholder="Nguyễn Văn A"')}</div>` })}
      ${email}
      ${pw('password', 'Mật khẩu', 'new-password', `Tối thiểu ${MIN_PW} ký tự, nên có cả chữ và số.`)}
      ${pw('confirm', 'Nhập lại mật khẩu', 'new-password')}
      ${capsNote}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Tạo tài khoản ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'forgot-password')
    return html`<form class="form" novalidate>
      ${email}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Gửi liên kết đặt lại ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'reset')
    return html`<form class="form" novalidate>
      ${pw('password', 'Mật khẩu mới', 'new-password', `Tối thiểu ${MIN_PW} ký tự.`)}
      ${pw('confirm', 'Nhập lại mật khẩu mới', 'new-password')}
      ${capsNote}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Lưu mật khẩu mới ${icon('check')}</button>
    </form>`;

  return html`<form class="form" novalidate>
    ${email}
    ${pw('password', 'Mật khẩu', 'current-password')}
    ${capsNote}
    <div class="auth__forgot"><a href="#/forgot-password">Quên mật khẩu?</a></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">Đăng nhập ${icon('arrowRight')}</button>
  </form>`;
}

function footFor(kind) {
  if (kind === 'signup') return html`<div class="auth__foot"><span>Đã có tài khoản?</span><a href="#/login">Đăng nhập</a></div>`;
  if (kind === 'forgot-password') return html`<div class="auth__foot"><span>Nhớ ra rồi?</span><a href="#/login">Quay lại đăng nhập</a></div>`;
  if (kind === 'reset') return html`<div class="auth__foot"><span>Liên kết chỉ dùng được một lần.</span><a href="#/forgot-password">Gửi lại liên kết</a></div>`;
  return html`<div class="auth__foot"><span>Chưa có tài khoản?</span><a href="#/signup">Tạo tài khoản mới</a></div>`;
}

function validate(kind, v) {
  const e = {};
  if ('email' in v) {
    if (!v.email) e.email = 'Hãy nhập email.';
    else if (!EMAIL_RE.test(v.email)) e.email = 'Email không đúng định dạng.';
  }
  if (kind === 'login' && !v.password) e.password = 'Hãy nhập mật khẩu.';
  if (kind === 'signup' || kind === 'reset') {
    if (!v.password || v.password.length < MIN_PW) e.password = `Mật khẩu cần tối thiểu ${MIN_PW} ký tự.`;
    if (!v.confirm) e.confirm = 'Hãy nhập lại mật khẩu.';
    else if (v.confirm !== v.password) e.confirm = 'Hai mật khẩu chưa khớp.';
  }
  if (kind === 'signup' && v.display_name && v.display_name.length > 80) e.display_name = 'Tối đa 80 ký tự.';
  return e;
}

async function submit(kind, v, notice, form) {
  if (kind === 'login') {
    await signIn(v.email, v.password);
    // main.js handles SIGNED_IN → loads context and routes to ?next or dashboard.
    return;
  }
  if (kind === 'signup') {
    const data = await signUp(v.email, v.password, v.display_name || v.email.split('@')[0]);
    if (!data.session) {
      form.reset();
      showNotice(notice, 'success', html`Đã tạo tài khoản. Hãy mở email <strong>${v.email}</strong> và bấm vào liên kết xác nhận, sau đó <a href="${href('/login', { email: v.email })}">đăng nhập</a>.`);
    }
    return;
  }
  if (kind === 'forgot-password') {
    await requestPasswordReset(v.email);
    showNotice(notice, 'success', html`Nếu <strong>${v.email}</strong> đã được đăng ký, liên kết đặt lại mật khẩu sẽ đến trong vài phút. Hãy kiểm tra cả thư mục Spam.`);
    return;
  }
  if (kind === 'reset') {
    await updatePassword(v.password);
    window.dispatchEvent(new Event('nm:recovery-done'));
    toast('Đã đổi mật khẩu.');
    navigate('/dashboard', null, { replace: true });
  }
}

// Login blocked by an unconfirmed e-mail: offer to send the link again.
function showResend(notice, email) {
  showNotice(notice, 'danger', html`Email chưa được xác nhận. Hãy kiểm tra hộp thư (cả Spam / Quảng cáo) của <strong>${email}</strong>.
    <div class="auth__resend"><button type="button" class="btn btn--sm" data-resend>${icon('mail')} Gửi lại email xác nhận</button></div>`);
  const btn = notice.querySelector('[data-resend]');
  btn.addEventListener('click', async () => {
    setBusy(btn, true);
    try {
      await resendConfirmation(email);
      showNotice(notice, 'success', html`Đã gửi lại liên kết xác nhận tới <strong>${email}</strong>. Thư có thể mất vài phút — nhớ xem cả thư mục Spam.`);
    } catch (err) {
      showNotice(notice, 'danger', err.message);
      setBusy(btn, false);
    }
  });
}

function showNotice(el, type, msg) {
  el.innerHTML = String(html`<div class="notice notice--${type} auth__notice" role="${type === 'danger' ? 'alert' : 'status'}">${icon(type === 'danger' ? 'alert' : 'checkCircle')}<div>${msg}</div></div>`);
}

/**
 * Unknown route. Rendered inside the app shell when signed in (pass the
 * shell's #content element) so the navigation stays around it.
 * @param {HTMLElement} el
 * @param {{ path?: string, home?: string }} [o]
 */
export function renderNotFound(el, { path = '', home = '/dashboard' } = {}) {
  document.title = 'Không tìm thấy trang · Note_mytasks';
  mount(el, html`
    <section class="notfound" aria-labelledby="nf-title">
      <span class="notfound__code" aria-hidden="true">404</span>
      <h1 id="nf-title">Không tìm thấy trang</h1>
      <p class="notfound__text">Đường dẫn <code>${path || '/'}</code> không tồn tại hoặc đã được đổi. Kiểm tra lại địa chỉ, hoặc quay về trang chính.</p>
      <div class="notfound__actions">
        <a class="btn btn--primary" href="#${home}">${icon('dashboard')} Về trang chính</a>
        <button type="button" class="btn" data-nf-search>${icon('search')} Tìm trang</button>
        <button type="button" class="btn btn--ghost" data-nf-back>${icon('chevronLeft')} Quay lại</button>
      </div>
    </section>`);
  const back = el.querySelector('[data-nf-back]');
  if (window.history.length <= 1) back.hidden = true;
  back.addEventListener('click', () => window.history.back());
  el.querySelector('[data-nf-search]').addEventListener('click', () => {
    import('../components/commandPalette.js').then((m) => m.openPalette());
  });
}
