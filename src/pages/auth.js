// Sign in · Sign up · Forgot password · Reset password (after recovery link)
// plus the "page not found" view for unknown routes (renderNotFound).
import { html, mount, formData, setBusy, showErrors } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { field, input } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { navigate, href } from '../core/router.js';
import { signIn, signUp, requestPasswordReset, updatePassword, resendConfirmation } from '../services/auth.js';
import { mountSphere } from '../components/auth/sphere.js';
import { mountInk } from '../components/auth/inkScene.js';
import { playIntro, mountCursor } from '../components/auth/intro.js';
import '../css/pages/auth.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PW = 8;
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&display=swap';
const TAG = 'Hệ sinh thái cá nhân · 2026';

// `head` = the title split into [plain part, italic accent]; `title` stays plain for document.title.
const COPY = {
  login: {
    eyebrow: 'Đăng nhập',
    title: 'Chào mừng trở lại',
    head: ['Chào mừng ', 'trở lại'],
    lede: 'Đăng nhập để mở công việc, thời gian, mục tiêu và chi tiêu của bạn.',
  },
  signup: {
    eyebrow: 'Tài khoản mới',
    title: 'Tạo tài khoản',
    head: ['Tạo ', 'tài khoản'],
    lede: 'Miễn phí và riêng tư — mỗi tài khoản là một không gian dữ liệu tách biệt.',
  },
  'forgot-password': {
    eyebrow: 'Khôi phục',
    title: 'Quên mật khẩu?',
    head: ['Quên ', 'mật khẩu?'],
    lede: 'Nhập email đã đăng ký, chúng tôi sẽ gửi liên kết để bạn đặt mật khẩu mới.',
  },
  reset: {
    eyebrow: 'Bảo mật',
    title: 'Đặt mật khẩu mới',
    head: ['Đặt mật khẩu ', 'mới'],
    lede: `Mật khẩu cần tối thiểu ${MIN_PW} ký tự. Sau khi lưu, bạn sẽ vào thẳng ứng dụng.`,
  },
};

const HEADLINE = 'Mọi việc của một ngày, gọn trong một chỗ.';

// Sphere cards: [icon, label, value, note]; tone cycles 0..4.
const TILES = [
  ['tasks', 'Công việc', '12/14', 'Ưu tiên, hạn chót, nhãn, bộ lọc và tìm kiếm.'],
  ['note', 'Ghi chú', '248', 'Ghi chú nhanh, ghim, lưu trữ và tìm lại tức thì.'],
  ['clock', 'Thời gian', '06:42', 'Bấm giờ theo từng việc, tổng hôm nay, tuần, tháng.'],
  ['target', 'Mục tiêu KPI', '87%', 'Chỉ tiêu, tiến độ và lịch sử cập nhật.'],
  ['wallet', 'Chi tiêu', '−1,2tr', 'Ghi khoản chi theo danh mục, biết ngay tiền đi đâu.'],
  ['piggy', 'Ngân sách', '64%', 'Ngân sách theo tháng, cảnh báo khi vượt mức.'],
  ['calendar', 'Lịch', '09:30', 'Hạn chót và sự kiện theo ngày, tuần, tháng.'],
  ['cart', 'Mua sắm', '7 món', 'Danh sách mua sắm, đánh dấu đã mua chỉ một chạm.'],
  ['chart', 'Báo cáo', 'Tuần 41', 'Tổng hợp công việc, thời gian và chi tiêu theo kỳ.'],
  ['repeat', 'Thói quen', '21 ngày', 'Việc lặp lại hằng ngày, hằng tuần — không bỏ sót.'],
  ['timer', 'Tập trung', '25′', 'Phiên tập trung ngắn, tự cộng vào thời gian của việc.'],
  ['dashboard', 'Tổng quan', 'Hôm nay', 'Một màn hình cho mọi việc cần làm trong ngày.'],
  ['pin', 'Đã ghim', '5', 'Ghim ghi chú và việc quan trọng lên đầu.'],
  ['trend', 'Xu hướng', '+18%', 'So sánh tiến độ và chi tiêu giữa các tháng.'],
  ['flag', 'Ưu tiên', 'Cao', 'Đánh dấu mức ưu tiên để biết việc nào làm trước.'],
  ['tag', 'Nhãn', '16', 'Gắn nhãn để lọc công việc và ghi chú theo chủ đề.'],
  ['bell', 'Nhắc việc', '3', 'Nhắc trước hạn chót để không lỡ việc nào.'],
  ['history', 'Lịch sử', '30 ngày', 'Xem lại mọi lần cập nhật tiến độ và khoản chi.'],
  ['board', 'Bảng việc', '4 cột', 'Kéo thả công việc giữa các trạng thái.'],
  ['shield', 'Riêng tư', 'Của riêng bạn', 'Dữ liệu được bảo vệ theo từng tài khoản.'],
  ['database', 'Đồng bộ', 'Mọi thiết bị', 'Ghi chú, công việc, thời gian và chi tiêu đồng bộ khắp nơi.'],
].map(([ic, label, value, note], i) => ({ icon: String(icon(ic)), label, value, note, tone: i % 5 }));

// Display serif, loaded once on first auth render (subset includes Vietnamese).
function ensureFonts() {
  if (document.getElementById('lux-fonts')) return;
  const link = document.createElement('link');
  link.id = 'lux-fonts';
  link.rel = 'stylesheet';
  link.href = FONT_HREF;
  document.head.appendChild(link);
}

export default function renderAuth(app, { kind, query }) {
  const c = COPY[kind] || COPY.login;
  ensureFonts();
  mount(app, html`
    <div class="lux" data-kind="${COPY[kind] ? kind : 'login'}">
      <div class="lux__stage" aria-hidden="true">
        <div class="lux__ink" data-lux-ink></div>
        <div class="lux__sphere" data-lux-sphere></div>
        <div class="lux__vig"></div>
      </div>
      <header class="lux__top">
        <a class="lux__brand" href="#/login" aria-label="Stratos"><img src="./icons/logo-mark.png?v=stratos2" alt="" width="228" height="256" decoding="async" /><span class="lux__word">Strat<em>os</em></span></a>
        <span class="lux__tag">${TAG}</span>
      </header>
      <p class="lux__cue"><s></s><span>Kéo để xoay</span></p>
      <main class="lux__panel" id="auth-main">
        <div class="lux__card">
          <p class="lux__eyebrow">${c.eyebrow}</p>
          <h1 class="lux__title">${c.head[0]}<em>${c.head[1]}</em></h1>
          <p class="lux__lede">${c.lede}</p>
          <div data-notice aria-live="polite"></div>
          ${formFor(kind, query)}
          ${footFor(kind)}
        </div>
      </main>
      <footer class="lux__foot"><span>Dữ liệu riêng theo từng tài khoản</span><span>Stratos · Field Notes 2026</span></footer>
    </div>`);
  document.title = `${c.title} · Stratos`;
  const root = app.querySelector('.lux');

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

  // Visuals — each mount is isolated so a failing effect never blocks sign-in.
  const safe = (fn) => {
    try { return fn(); } catch (e) { console.error(e); return null; }
  };
  document.body.classList.add('lux-on');
  let ink = safe(() => mountInk(root.querySelector('[data-lux-ink]'), {}));
  let sphere = safe(() => mountSphere(root.querySelector('[data-lux-sphere]'), { headline: HEADLINE, tiles: TILES }));
  let cursor = safe(() => mountCursor(root));
  safe(() => Promise.resolve(playIntro(root, { word: 'Stratos', tag: TAG })).catch((e) => console.error(e)));

  // main.js calls this on navigation (also before re-rendering another auth kind).
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    safe(() => sphere?.destroy());
    safe(() => ink?.destroy());
    safe(() => (typeof cursor === 'function' ? cursor() : cursor?.destroy?.()));
    sphere = ink = cursor = null;
    document.body.classList.remove('lux-on');
    document.getElementById('lux-splash')?.remove();
  };
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
    return html`<form class="form lux__form" novalidate>
      ${field({ label: 'Tên hiển thị', name: 'display_name', optional: true, control: html`<div class="input-group">${icon('user')}${input('display_name', '', 'autocomplete="name" maxlength="80" placeholder="Nguyễn Văn A"')}</div>` })}
      ${email}
      ${pw('password', 'Mật khẩu', 'new-password', `Tối thiểu ${MIN_PW} ký tự, nên có cả chữ và số.`)}
      ${pw('confirm', 'Nhập lại mật khẩu', 'new-password')}
      ${capsNote}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Tạo tài khoản ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'forgot-password')
    return html`<form class="form lux__form" novalidate>
      ${email}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Gửi liên kết đặt lại ${icon('arrowRight')}</button>
    </form>`;

  if (kind === 'reset')
    return html`<form class="form lux__form" novalidate>
      ${pw('password', 'Mật khẩu mới', 'new-password', `Tối thiểu ${MIN_PW} ký tự.`)}
      ${pw('confirm', 'Nhập lại mật khẩu mới', 'new-password')}
      ${capsNote}
      <button class="btn btn--primary btn--lg btn--block" type="submit">Lưu mật khẩu mới ${icon('check')}</button>
    </form>`;

  return html`<form class="form lux__form" novalidate>
    ${email}
    ${pw('password', 'Mật khẩu', 'current-password')}
    ${capsNote}
    <div class="auth__forgot"><a href="#/forgot-password">Quên mật khẩu?</a></div>
    <button class="btn btn--primary btn--lg btn--block" type="submit">Đăng nhập ${icon('arrowRight')}</button>
  </form>`;
}

function footFor(kind) {
  if (kind === 'signup') return html`<div class="lux__switch"><span>Đã có tài khoản?</span><a href="#/login">Đăng nhập</a></div>`;
  if (kind === 'forgot-password') return html`<div class="lux__switch"><span>Nhớ ra rồi?</span><a href="#/login">Quay lại đăng nhập</a></div>`;
  if (kind === 'reset') return html`<div class="lux__switch"><span>Liên kết chỉ dùng được một lần.</span><a href="#/forgot-password">Gửi lại liên kết</a></div>`;
  return html`<div class="lux__switch"><span>Chưa có tài khoản?</span><a href="#/signup">Tạo tài khoản mới</a></div>`;
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
  document.title = 'Không tìm thấy trang · Stratos';
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
