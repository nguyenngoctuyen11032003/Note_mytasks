// Stratos auth sphere: a Fibonacci sphere of "field-note" tiles floating in
// the sky, with a serif headline pinned at the sphere's 0×0 origin.
//
// Everything lives inside the host element (never the window): radius and
// perspective come from the host box, the loop pauses while the host is off
// screen or the tab is hidden. Per frame JS writes only the world transform,
// the counter-rotated headline transform and each card's depth (--d/opacity),
// and only when a value actually changed.
import '../../css/pages/auth-sphere.css';

const GA = Math.PI * (3 - Math.sqrt(5)); // golden angle
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const SENS = 0.13;        // deg per dragged px
const FRICTION = 0.94;
const SNAP = 0.002;
const PITCH_MAX = 32;
const TILT = -4;
const DRIFT = 0.03;       // idle yaw, deg per 60fps frame
const IDLE_MS = 4000;
const PARALLAX = 3;       // max deg, fine pointers only

/** Perspective (px) for a host width. */
function perspectiveFor(w) {
  if (w < 480) return 620;
  if (w < 800) return 760;
  if (w < 1200) return 920;
  return 1150;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, p = 1000) => Math.round(v * p) / p;

/**
 * Mount the sphere inside `el`.
 * @param {HTMLElement} el
 * @param {{ headline?: string, tiles?: Array<{icon:string,label:string,value:string,note:string,tone:number}>, onPick?: (i:number)=>void }} opts
 * @returns {{ destroy: () => void, relayout: () => void }}
 */
export function mountSphere(el, { headline = '', tiles = [], onPick } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  // ---- DOM ------------------------------------------------------------
  const root = document.createElement('div');
  root.className = 'lxs';
  const world = document.createElement('div');
  world.className = 'lxs__world';
  const orb = document.createElement('div');
  orb.className = 'lxs__orb';
  const head = document.createElement('h2');
  head.className = 'lxs__head';
  const inner = document.createElement('span');
  inner.className = 'lxs__inner';
  headline.split(/\s+/).filter(Boolean).forEach((word, i) => {
    if (i) inner.append(' ');
    const w = document.createElement('span');
    w.className = 'lxs__w';
    w.style.setProperty('--i', String(i));
    w.textContent = word;
    inner.append(w);
  });
  head.append(inner);
  const caption = document.createElement('p');
  caption.className = 'lxs__caption';
  caption.setAttribute('aria-live', 'polite');

  const n = tiles.length;
  const cards = tiles.map((t, i) => {
    const c = document.createElement('div');
    c.className = 'lxs__card';
    c.dataset.tone = String(clamp(Number(t.tone) || 0, 0, 4));
    c.dataset.i = String(i);
    const ic = document.createElement('span');
    ic.className = 'lxs__icon';
    ic.innerHTML = String(t.icon || ''); // trusted SVG from icon()
    const val = document.createElement('span');
    val.className = 'lxs__value';
    val.textContent = t.value || '';
    const lab = document.createElement('span');
    lab.className = 'lxs__label';
    lab.textContent = t.label || '';
    c.append(ic, val, lab);
    orb.append(c);
    return c;
  });
  world.append(orb, head);
  root.append(world, caption);
  el.replaceChildren(root);

  // Unit positions (Fibonacci lattice); scaled by R on layout.
  const pts = tiles.map((_, i) => {
    const y = n > 1 ? 1 - (i / (n - 1)) * 2 : 0;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = GA * i;
    const x = Math.cos(th) * r;
    const z = Math.sin(th) * r;
    return { x, y, z, lat: Math.asin(y) * DEG, lon: Math.atan2(x, z) * DEG };
  });
  const last = cards.map(() => ({ d: -1, o: -1 }));

  // ---- state ----------------------------------------------------------
  let R = 0;
  let camZ = 0;
  let backZ = 0; // zf below this shows the card's back (perspective-aware)
  let size = { w: 0, h: 0 };
  let rect = null;
  let yaw = 0;
  let pitch = TILT;
  let vYaw = 0;
  let vPitch = 0;
  let parX = 0, parY = 0, parTX = 0, parTY = 0;
  let lastInteract = -Infinity;
  let lastWorld = '';
  let lastHead = '';
  let raf = 0;
  let prevT = 0;
  let visible = true;
  let picked = -1;
  let drag = null; // { id, type, x0, y0, x, y, moved, active, card }

  // ---- layout ---------------------------------------------------------
  function layout(force) {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    if (!force && Math.abs(w - size.w) < 20 && Math.abs(h - size.h) < 20) return;
    size = { w, h };
    const floor = w < 640 ? 100 : 150;
    R = Math.round(Math.max(floor, Math.min(460, h * 0.42, w * 0.5)));
    camZ = -Math.round(R * 0.6);
    const cw = Math.round(Math.max(64, R * 0.42));
    const persp = perspectiveFor(w);
    backZ = R / (persp - camZ);
    root.style.setProperty('--lxs-persp', persp + 'px');
    root.style.setProperty('--lxs-w', w + 'px');
    root.style.setProperty('--cw', cw + 'px');
    cards.forEach((c, i) => {
      const p = pts[i];
      c.style.transform = `translate3d(${round(p.x * R, 10)}px, ${round(-p.y * R, 10)}px, ${round(p.z * R, 10)}px) `
        + `rotateY(${round(p.lon, 100)}deg) rotateX(${round(p.lat, 100)}deg)`;
    });
    lastWorld = lastHead = '';
    rect = el.getBoundingClientRect();
    render();
  }

  // ---- render ---------------------------------------------------------
  function render() {
    if (!R) return;
    const sx = clamp(pitch, -PITCH_MAX, PITCH_MAX) + parY;
    const sy = yaw + parX;
    const ws = `translateZ(${camZ}px) rotateY(${round(sy, 100)}deg) rotateX(${round(sx, 100)}deg)`;
    if (ws !== lastWorld) { world.style.transform = ws; lastWorld = ws; }
    const hs = `rotateX(${round(-sx, 100)}deg) rotateY(${round(-sy, 100)}deg) translateZ(${Math.round(R * 0.62)}px)`;
    if (hs !== lastHead) { head.style.transform = hs; lastHead = hs; }

    // Depth of each card in camera space: z' of Ry(sy)·Rx(sx)·p (CSS axes, y down).
    const cx = Math.cos(sx * RAD), snx = Math.sin(sx * RAD);
    const cy = Math.cos(sy * RAD), sny = Math.sin(sy * RAD);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const py = -p.y;
      const z1 = py * snx + p.z * cx;
      const zf = -p.x * sny + z1 * cy; // -1 back … 1 front
      const base = 0.14 + 0.86 * Math.pow((zf + 1) / 2, 0.85);
      const d = round(1 - base, 100);
      // Near plane: cards swinging past the headline fade out.
      const o = round(zf > 0.62 ? 1 - Math.min(1, (zf - 0.62) / 0.33) * 0.88 : 1, 100);
      const L = last[i];
      if (d !== L.d) { cards[i].style.setProperty('--d', String(d)); L.d = d; }
      if (o !== L.o) { cards[i].style.opacity = o === 1 ? '' : String(o); L.o = o; }
      // Cards face outward; from the eye point (perspective − camZ) a card shows its
      // back once p·(eye − R·p) < 0, i.e. zf < R / (persp − camZ). Hide the mirrored text.
      const back = zf < backZ;
      if (back !== L.b) { cards[i].classList.toggle('is-back', back); L.b = back; }
    }
  }

  // ---- loop -----------------------------------------------------------
  function tick(t) {
    raf = 0;
    const dt = prevT ? Math.min(3, (t - prevT) / 16.667) : 1;
    prevT = t;
    const dragging = !!(drag && drag.active);
    if (!reduce && !dragging) {
      if (Math.abs(vYaw) > SNAP || Math.abs(vPitch) > SNAP) {
        yaw += vYaw * dt;
        pitch = clamp(pitch + vPitch * dt, -PITCH_MAX, PITCH_MAX);
        const f = Math.pow(FRICTION, dt);
        vYaw *= f; vPitch *= f;
        if (Math.abs(vYaw) <= SNAP) vYaw = 0;
        if (Math.abs(vPitch) <= SNAP) vPitch = 0;
      } else if (performance.now() - lastInteract > IDLE_MS) {
        yaw += DRIFT * dt;
      }
      parX += (parTX - parX) * Math.min(1, 0.06 * dt);
      parY += (parTY - parY) * Math.min(1, 0.06 * dt);
    }
    yaw %= 360;
    render();
    // Reduced motion renders statically: frames only while dragging.
    if (!reduce || dragging) schedule();
  }

  function schedule() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    prevT = 0;
  }

  // ---- picking --------------------------------------------------------
  function pick(i) {
    if (i === picked) return;
    if (picked >= 0) cards[picked].classList.remove('is-picked');
    picked = i;
    if (i < 0) {
      root.classList.remove('has-pick');
      caption.classList.remove('is-on');
      return;
    }
    cards[i].classList.add('is-picked');
    root.classList.add('has-pick');
    const t = tiles[i];
    caption.textContent = t.note ? `${t.label} — ${t.note}` : t.label;
    caption.classList.add('is-on');
    if (typeof onPick === 'function') onPick(i);
  }

  // ---- pointer --------------------------------------------------------
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (drag) return;
    const card = e.target instanceof Element ? e.target.closest('.lxs__card') : null;
    drag = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: 0, active: false, card };
    vYaw = vPitch = 0;
    lastInteract = performance.now();
    if (e.pointerType !== 'touch') begin();
  }

  function begin() {
    drag.active = true;
    try { root.setPointerCapture(drag.id); } catch { /* pointer already gone */ }
    root.classList.add('is-dragging');
    schedule();
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const ddx = e.clientX - drag.x0;
    const ddy = e.clientY - drag.y0;
    drag.moved = Math.max(drag.moved, Math.hypot(ddx, ddy));
    if (!drag.active) {
      if (drag.moved < 10) return;
      // Mostly vertical touch: let the page scroll.
      if (Math.abs(ddy) > Math.abs(ddx) * 1.15) { drag = null; return; }
      drag.x = e.clientX; drag.y = e.clientY;
      begin();
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    yaw += dx * SENS;
    pitch = clamp(pitch - dy * SENS, -PITCH_MAX, PITCH_MAX);
    vYaw = dx * SENS;
    vPitch = -dy * SENS;
    lastInteract = performance.now();
    if (reduce) schedule();
  }

  function end(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    root.classList.remove('is-dragging');
    try { root.releasePointerCapture(d.id); } catch { /* not captured */ }
    lastInteract = performance.now();
    if (reduce) vYaw = vPitch = 0;
    if (!cancelled) {
      const slop = d.type === 'touch' || !fine ? 14 : 6;
      if (d.moved < slop) {
        vYaw = vPitch = 0;
        pick(d.card ? Number(d.card.dataset.i) : -1);
      }
    }
    schedule();
  }
  const onUp = (e) => end(e, false);
  const onCancel = (e) => end(e, true);

  function onHover(e) {
    if (e.pointerType !== 'mouse' || !rect || !rect.width) return;
    const nx = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    const ny = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
    parTX = nx * PARALLAX;
    parTY = -ny * PARALLAX;
  }
  const onLeave = () => { parTX = parTY = 0; };
  const onScroll = () => { rect = el.getBoundingClientRect(); };

  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onCancel);
  root.addEventListener('lostpointercapture', onCancel);
  const parallax = fine && !reduce;
  if (parallax) {
    window.addEventListener('pointermove', onHover, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---- observers ------------------------------------------------------
  const onVis = () => { if (document.hidden) stop(); else schedule(); };
  document.addEventListener('visibilitychange', onVis);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { layout(false); schedule(); }) : null;
  ro?.observe(el);

  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) schedule(); else stop();
    })
    : null;
  io?.observe(el);

  layout(true);
  schedule();

  return {
    relayout() { layout(true); schedule(); },
    destroy() {
      stop();
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      if (parallax) {
        window.removeEventListener('pointermove', onHover);
        document.documentElement.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('scroll', onScroll);
      }
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUp);
      root.removeEventListener('pointercancel', onCancel);
      root.removeEventListener('lostpointercapture', onCancel);
      el.replaceChildren();
    },
  };
}
