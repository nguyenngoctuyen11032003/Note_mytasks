// Sign in · Sign up · Forgot password · Reset password (after recovery link)
import { html, raw, mount, formData, setBusy, showErrors } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { field, input } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { navigate, href } from '../core/router.js';
import { signIn, signUp, requestPasswordReset, updatePassword } from '../services/auth.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const COPY = {
  login: {
    eyebrow: 'Đăng nhập',
    title: 'Chào mừng <em>trở lại</em>.',
    lede: 'Mở lại sổ tay của bạn — công việc, thời gian, mục tiêu và chi tiêu ở cùng một chỗ.',
  },
  signup: {
    eyebrow: 'Tạo tài khoản',
    title: 'Bắt đầu một <em>cuốn sổ mới</em>.',
    lede: 'Mỗi tài khoản là một không gian riêng. Dữ liệu của bạn được bảo vệ theo từng dòng ở cơ sở dữ liệu.',
  },
  'forgot-password': {
    eyebrow: 'Khôi phục',
    title: 'Quên <em>mật khẩu</em>?',
    lede: 'Nhập email đã đăng ký. Chúng tôi sẽ gửi một liên kết để bạn đặt mật khẩu mới.',
  },
  reset: {
    eyebrow: 'Đặt lại mật khẩu',
    title: 'Chọn <em>mật khẩu mới</em>.',
    lede: 'Mật khẩu cần tối thiểu 8 ký tự. Sau khi lưu, bạn sẽ được đưa vào sổ tay.',
  },
};

export default function renderAuth(app, { kind, query }) {
  const c = COPY[kind] || COPY.login;
  mount(app, html`
    <div class="auth">
      <section class="auth__plate" aria-hidden="true">
        <div class="auth__drawing">${drawing()}</div>
        <a class="brand" href="#/login" tabindex="-1">
          <span class="brand__mark">N</span>
          <span><span class="brand__name">Note<em>_</em>mytasks</span><span class="brand__sub">Sổ tay cá nhân · MMXXVI</span></span>
        </a>
        <div class="auth__quote">
          <p>Một ngày được <em>sắp đặt</em> như một bản vẽ — từng nét, có chủ đích.</p>
          <span>Công việc · Thời gian · KPI · Chi tiêu</span>
        </div>
        <div class="auth__legend"><span>Tờ 01 / 01</span><span>Tỉ lệ 1 : 1</span><span>Bản vẽ — Kế hoạch</span></div>
      </section>
      <section class="auth__side">
        <div class="auth__card">
          <span class="eyebrow" style="color:var(--accent)">${c.eyebrow}</span>
          <h1>${raw(c.title)}</h1>
          <p class="auth__lede">${c.lede}</p>
          <div data-notice></div>
          ${formFor(kind, query)}
          ${footFor(kind)}
        </div>
      </section>
    </div>`);

  const form = app.querySelector('form');
  const btn = form.querySelector('[type=submit]');
  const notice = app.querySelector('[data-notice]');

  app.querySelectorAll('[data-reveal]').forEach((b) =>
    b.addEventListener('click', () => {
      const inp = b.parentElement.querySelector('input');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = String(icon(show ? 'eyeOff' : 'eye'));
      b.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    }),
  );

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
      showNotice(notice, 'danger', err.message);
    } finally {
      setBusy(btn, false);
    }
  });

  form.querySelector('input:not([type=hidden])')?.focus();
}

function formFor(kind, query) {
  const pw = (name, label, auto, hint) =>
    field({
      label,
      name,
      hint,
      control: html`<div class="input-group">${icon('lock')}<input id="__ID__" class="input has-suffix" type="password" name="${name}" autocomplete="${auto}" required minlength="${kind === 'login' ? 1 : 8}" /><button type="button" class="icon-btn icon-btn--sm" data-reveal aria-label="Hiện mật khẩu" style="position:absolute;right:6px">${icon('eye')}</button></div>`,
    });
  const email = field({
    label: 'Email',
    name: 'email',
    control: html`<div class="input-group">${icon('mail')}<input id="__ID__" class="input" type="email" name="email" value="${query?.email || ''}" autocomplete="email" inputmode="email" required placeholder="ban@vidu.com" /></div>`,
  });

  if (kind === 'signup')
    return html`<form class="form" novalidate>
      ${field({ label: 'Tên hiển thị', name: 'display_name', control: html`<div class="input-group">${icon('user')}${input('display_name', '', 'autocomplete="name" maxlength="80" placeholder="Nguyễn Văn A"')}</div>` })}
      ${email}
      ${pw('password', 'Mật khẩu', 'new-password', 'Tối thiểu 8 ký tự, nên có cả chữ và số.')}
      ${pw('confirm', 'Nhập lại mật khẩu', 'new-password')}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Tạo tài khoản ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'forgot-password')
    return html`<form class="form" novalidate>
      ${email}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Gửi liên kết đặt lại ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'reset')
    return html`<form class="form" novalidate>
      ${pw('password', 'Mật khẩu mới', 'new-password', 'Tối thiểu 8 ký tự.')}
      ${pw('confirm', 'Nhập lại mật khẩu mới', 'new-password')}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Lưu mật khẩu mới ${icon('check')}</button>
    </form>`;

  return html`<form class="form" novalidate>
    ${email}
    ${pw('password', 'Mật khẩu', 'current-password')}
    <div class="row between" style="margin-top:-4px">
      <span></span>
      <a href="#/forgot-password" style="font-size:var(--fs-sm)">Quên mật khẩu?</a>
    </div>
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
    if (!v.password || v.password.length < 8) e.password = 'Mật khẩu cần tối thiểu 8 ký tự.';
    if (v.confirm !== v.password) e.confirm = 'Hai mật khẩu chưa khớp.';
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

function showNotice(el, type, msg) {
  el.innerHTML = String(html`<div class="notice notice--${type}" role="${type === 'danger' ? 'alert' : 'status'}" style="margin-bottom:var(--s-5)">${icon(type === 'danger' ? 'alert' : 'checkCircle')}<div>${msg}</div></div>`);
}

/** Architectural elevation drawing — arches, columns, dimension lines. */
function drawing() {
  return raw(`
  <svg viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.32">
    <defs>
      <pattern id="g" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" stroke-width="0.35" opacity="0.5"/></pattern>
    </defs>
    <rect width="600" height="800" fill="url(#g)" stroke="none"/>
    <g transform="translate(110 250)">
      <path d="M0 400V120h380v280"/>
      <path d="M-20 120h420M-20 108h420v12M-28 96h436v12"/>
      <path d="M190 30 -30 96M190 30l220 66"/>
      <circle cx="190" cy="70" r="16"/><circle cx="190" cy="70" r="9"/>
      ${[0, 1, 2].map((i) => {
        const x = 30 + i * 115;
        return `<path d="M${x} 400V230a45 45 0 0 1 90 0v170"/><path d="M${x + 8} 400V232a37 37 0 0 1 74 0v168" opacity=".6"/><path d="M${x + 45} 185v-10"/>`;
      }).join('')}
      ${[0, 1, 2, 3].map((i) => `<rect x="${10 + i * 115}" y="130" width="20" height="270"/><path d="M${6 + i * 115} 130h28M${6 + i * 115} 400h28"/>`).join('')}
      <path d="M-40 400h460M-40 412h460" />
      <path d="M-60 440h500" stroke-dasharray="3 5"/>
      <path d="M0 470v-14M380 470v-14M0 463h380" />
      <path d="M0 463l8-3M0 463l8 3M380 463l-8-3M380 463l-8 3"/>
      <text x="190" y="480" fill="currentColor" stroke="none" font-size="10" text-anchor="middle" font-family="monospace" letter-spacing="2">12 000</text>
      <path d="M420 400V30M412 400h16M412 30h16" />
      <text x="436" y="220" fill="currentColor" stroke="none" font-size="10" font-family="monospace" letter-spacing="2" transform="rotate(90 436 220)">9 600</text>
    </g>
    <g stroke="#e58a5e" opacity="0.9" stroke-width="1">
      <circle cx="490" cy="150" r="46"/><path d="M490 90v120M430 150h120"/>
      <path d="M490 150l30-30"/>
    </g>
  </svg>`);
}
