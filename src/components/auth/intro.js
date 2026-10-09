// Auth intro: a one-per-session cinematic splash (wordmark + real progress bar,
// veil wipe reveal) and a soft blend-difference cursor dot for fine pointers.
import '../../css/pages/auth-intro.css';

const SEEN_KEY = 'nm.authIntro';
const MIN_MS = 1100;
const MAX_MS = 3200;
const LEAVE_MS = 1000;
const LOGO = './icons/logo-mark.png?v=stratos2';

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function seen() {
  try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
function markSeen() {
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* storage blocked */ }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function playIntro(root, { word = 'Stratos', tag = 'Hệ sinh thái cá nhân' } = {}) {
  if (!root) return Promise.resolve();
  if (seen() || reducedMotion()) {
    return new Promise((resolve) => requestAnimationFrame(() => {
      root.classList.add('is-revealed');
      resolve();
    }));
  }
  markSeen();

  const w = String(word);
  const head = w.length > 2 ? w.slice(0, -2) : '';
  const tail = w.length > 2 ? w.slice(-2) : w;

  const el = document.createElement('div');
  el.id = 'lux-splash';
  el.className = 'lxi-splash';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', `Đang mở ${w}`);
  el.innerHTML = `
    <img class="lxi-splash__logo" src="${LOGO}" alt="" width="56" height="56" aria-hidden="true" decoding="async">
    <p class="lxi-splash__word" aria-hidden="true">${esc(head)}<em>${esc(tail)}</em></p>
    <div class="lxi-splash__bar" aria-hidden="true"><s></s></div>
    <p class="lxi-splash__tag" aria-hidden="true">${esc(tag)}</p>`;
  document.body.appendChild(el);

  const bar = el.querySelector('.lxi-splash__bar s');
  const logo = el.querySelector('img');
  const start = performance.now();

  return new Promise((resolve) => {
    let done = false;          // fully finished (resolved)
    let leaving = false;       // reveal sequence started
    let fast = false;          // user asked to skip
    let raf = 0;
    let shown = 0;             // displayed progress 0..1
    let leaveTimer = 0;
    let mo = null;
    // Root may be attached right after this call; only "gone" once it was in.
    let wasIn = root.isConnected;
    const gone = () => {
      if (root.isConnected) { wasIn = true; return false; }
      return wasIn;
    };
    const ready = { fonts: false, img: false, frames: false };

    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      clearTimeout(leaveTimer);
      if (mo) mo.disconnect();
      off();
      el.remove();
      resolve();
    };

    const leave = () => {
      if (leaving) return;
      leaving = true;
      bar.style.transform = 'scaleX(1)';
      el.classList.add('is-leaving');
      // Page entrance plays underneath the wipe.
      root.classList.add('is-revealed');
      leaveTimer = setTimeout(finish, LEAVE_MS);
    };

    const skip = () => { fast = true; };
    const EVENTS = ['click', 'pointerdown', 'keydown', 'touchstart'];
    const opts = { capture: true, passive: true };
    EVENTS.forEach((t) => window.addEventListener(t, skip, opts));
    function off() { EVENTS.forEach((t) => window.removeEventListener(t, skip, opts)); }

    // Real readiness signals.
    const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fontsReady.catch(() => {}).then(() => { ready.fonts = true; });
    const imgReady = logo.decode ? logo.decode() : Promise.resolve();
    imgReady.catch(() => {}).then(() => { ready.img = true; });
    frame().then(frame).then(() => { ready.frames = true; });

    const tick = (now) => {
      if (done) return;
      // Root gone (user navigated away): clean up quietly.
      if (gone()) { finish(); return; }
      if (leaving) return;

      const elapsed = now - start;
      const time = Math.min(1, elapsed / MIN_MS);
      const signals = (ready.fonts ? 1 : 0) + (ready.img ? 1 : 0) + (ready.frames ? 1 : 0);
      let target = (signals + time) / 4;
      if (elapsed >= MAX_MS || fast) target = 1;

      shown += (target - shown) * (fast ? 0.35 : 0.12);
      if (target - shown < 0.004) shown = target;
      bar.style.transform = `scaleX(${shown.toFixed(4)})`;

      if (shown >= 1) { leave(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // Root detached during the wipe (no tick running then): clean up too.
    mo = new MutationObserver(() => { if (gone()) finish(); });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

const WIDE = '.lxs__card, a, button, .lxs';
const HIDE = 'input, textarea, select, .lux__card';

// `_root` kept for API symmetry; the dot tracks the whole viewport.
export function mountCursor(_root) {
  const noop = () => {};
  if (typeof matchMedia !== 'function') return noop;
  if (!matchMedia('(hover:hover) and (pointer:fine)').matches || reducedMotion()) return noop;

  const dot = document.createElement('div');
  dot.className = 'lxc';
  dot.setAttribute('aria-hidden', 'true');
  document.body.appendChild(dot);

  let x = -100, y = -100, tx = -100, ty = -100;
  let raf = 0;
  let seenMove = false;

  const step = () => {
    raf = 0;
    x += (tx - x) * 0.2;
    y += (ty - y) * 0.2;
    if (Math.abs(tx - x) < 0.1 && Math.abs(ty - y) < 0.1) { x = tx; y = ty; }
    dot.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    // Idle: stop the loop until the pointer moves again.
    if ((x !== tx || y !== ty) && !document.hidden) raf = requestAnimationFrame(step);
  };
  const kick = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(step); };

  const onMove = (e) => {
    tx = e.clientX; ty = e.clientY;
    if (!seenMove) { seenMove = true; x = tx; y = ty; dot.classList.add('is-on'); }
    kick();
  };
  const onOver = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const hide = !!(t && t.closest(HIDE));
    dot.classList.toggle('is-hidden', hide);
    dot.classList.toggle('is-wide', !hide && !!(t && t.closest(WIDE)));
  };
  const onOut = (e) => {
    // Pointer left the window: fade out, snap back on re-entry.
    if (!e.relatedTarget) { dot.classList.remove('is-on'); seenMove = false; }
  };
  const onVis = () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else kick();
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerover', onOver, { passive: true });
  document.addEventListener('pointerout', onOut, { passive: true });
  document.addEventListener('visibilitychange', onVis);

  return function destroy() {
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerover', onOver);
    document.removeEventListener('pointerout', onOut);
    document.removeEventListener('visibilitychange', onVis);
    dot.remove();
  };
}
