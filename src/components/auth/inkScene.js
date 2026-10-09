// Ink-wash landscape for the auth stage: misty ridges, a still lake with a
// rippled reflection, pine outcrops on both edges and two gliding cranes.
//
// Everything is procedural inline SVG drawn in `currentColor` (the CSS sets
// `color: var(--lux-wash)`), so the page background shows through and the
// same markup works on dark espresso and cream paper. Shapes come from a
// seeded RNG, so a given seed renders the same scene every time.

import '../../css/pages/auth-ink.css';

const W = 1600;
const H = 900;
const LAKE = 772;        // shoreline (y)
const X0 = -40;          // ridges overshoot the viewBox a little
const X1 = W + 40;
const SEGS = 128;        // ridge resolution (power of two)

let uid = 0;

// mulberry32 — tiny, fast, good enough for scenery.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n) => String(Math.round(n * 10) / 10);
const between = (r, a, b) => a + r() * (b - a);

// 1-D midpoint displacement → values roughly in [-1, 1].
function midpoint(r, n, rough = 0.55) {
  const out = new Array(n + 1).fill(0);
  out[0] = r() * 2 - 1;
  out[n] = r() * 2 - 1;
  let scale = 1;
  for (let step = n; step > 1; step /= 2) {
    const h = step / 2;
    for (let i = h; i < n; i += step) {
      out[i] = (out[i - h] + out[i + h]) / 2 + (r() * 2 - 1) * scale;
    }
    scale *= rough;
  }
  return out;
}

// One ridge: crest polyline points + a lookup for y at any x.
function ridge(r, { crest, amp, peaks, valley }) {
  const noise = midpoint(r, SEGS, 0.58);
  const bumps = Array.from({ length: peaks }, () => ({
    x: between(r, X0, X1),
    h: between(r, 0.6, 1.4) * amp * 1.3,
    w: between(r, 90, 260),
  }));
  const pts = [];
  for (let i = 0; i <= SEGS; i++) {
    const x = X0 + ((X1 - X0) * i) / SEGS;
    let y = crest + noise[i] * amp * 0.55;
    for (const b of bumps) y -= b.h * Math.exp(-(((x - b.x) / b.w) ** 2));
    // Open the middle a little so the lake reads as a valley.
    y += valley * Math.exp(-(((x - 800) / 520) ** 2));
    pts.push([x, Math.min(y, LAKE - 6)]);
  }
  const at = (x) => {
    const t = ((x - X0) / (X1 - X0)) * SEGS;
    const i = Math.max(0, Math.min(SEGS - 1, Math.floor(t)));
    const k = t - i;
    return pts[i][1] * (1 - k) + pts[i + 1][1] * k;
  };
  return { pts, at };
}

const line = (pts) => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join('L');

// A pine: trunk + stacked, slightly lopsided tiers.
function pine(r, x, y, h) {
  const tiers = 3 + Math.floor(r() * 3);
  const step = (h * 0.82) / tiers;
  let d = `M${f(x - 0.7)} ${f(y)}h1.4v${f(-h * 0.26)}h-1.4Z`;
  for (let k = 0; k < tiers; k++) {
    const yb = y - h * 0.14 - k * step;
    const w = h * 0.3 * (1 - (k / tiers) * 0.72) * between(r, 0.85, 1.15);
    const rise = step * 1.9;
    const lean = between(r, -1, 1) * w * 0.08;
    // Left foot → tip → right foot → notch, relative to keep markup small.
    d += `M${f(x - w)} ${f(yb)}l${f(w + lean)} ${f(-rise)}l${f(w - lean)} ${f(rise + between(r, -1, 1))}l${f(-w * 0.68)} -1.5Z`;
  }
  return d;
}

// Rocky outcrop on one edge. `side` = 1 for left, -1 for right (mirrored).
function outcrop(r, side) {
  const base = [[-30, 330], [40, 352], [110, 398], [170, 458], [228, 540], [282, 636], [328, 722], [380, 776]];
  const last = base.length - 1;
  const ctrl = base.map(([x, y], i) => [x, y + (i === last ? 0 : i ? between(r, -18, 18) : between(r, -40, 10))]);
  const n = 64;
  const noise = midpoint(r, n, 0.6);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (ctrl.length - 1);
    const j = Math.min(ctrl.length - 2, Math.floor(t));
    const k = t - j;
    const x = ctrl[j][0] * (1 - k) + ctrl[j + 1][0] * k;
    const y = ctrl[j][1] * (1 - k) + ctrl[j + 1][1] * k + (i < n ? noise[i] * 9 : 0);
    pts.push([x, y]);
  }
  const mx = (x) => (side > 0 ? x : W - x);
  const at = (x) => {
    for (let i = 0; i < n; i++) {
      if (x >= pts[i][0] && x <= pts[i + 1][0]) {
        const k = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0] || 1);
        return pts[i][1] * (1 - k) + pts[i + 1][1] * k;
      }
    }
    return H;
  };
  const edge = pts.map(([x, y]) => [mx(x), y]);
  const rock = line(edge) + `L${f(mx(-30))} ${LAKE + 3}Z`;

  // Cracks / strata strokes on the rock face.
  let cracks = '';
  for (let i = 0; i < 16; i++) {
    const x = between(r, 0, 330);
    let y = at(x) + between(r, 14, 120);
    if (y > LAKE - 12) continue;
    let px = x;
    cracks += `M${f(mx(px))} ${f(y)}`;
    for (let s = 0; s < 3; s++) {
      px += between(r, 4, 14);
      y += between(r, 6, 16);
      cracks += `L${f(mx(px))} ${f(y)}`;
    }
  }

  // Back row: smaller and paler, along the crest.
  let back = '';
  for (let i = 0; i < 26; i++) {
    const x = between(r, -10, 350);
    back += pine(r, mx(x), at(x) + between(r, 4, 22), between(r, 12, 26));
  }
  // Front row: denser near the top of the outcrop, a few tall framing pines.
  let front = '';
  for (let i = 0; i < 30; i++) {
    const x = between(r, -10, 300) * Math.sqrt(r());
    const y = at(x) + between(r, 16, 90);
    if (y < LAKE - 4) front += pine(r, mx(x), y, between(r, 22, 50));
  }
  for (let i = 0; i < 4; i++) {
    const x = between(r, 0, 120);
    front += pine(r, mx(x), at(x) + between(r, 10, 30), between(r, 84, 132));
  }
  return { rock, cracks, back, front };
}

// Crane silhouette, flying right; shoulder at (0,0) so wings pivot there.
const CRANE = `<g class="lxi__bob">`
  + `<g class="lxi__wing lxi__wing--far"><path d="M-2 -1C-6 -12-16-24-30-31C-24-21-18-11-11 1Z" fill-opacity=".45"/></g>`
  + `<path d="M-30 3C-18-2-3-3 8-1C3 3-14 6-30 3Z"/>`
  + `<path d="M6-1C18-4 29-6 40-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`
  + `<circle cx="41.5" cy="-6.2" r="2.4"/><path d="M43-7L53-5.2L43-5.2Z"/>`
  + `<path d="M-28 3L-50 6M-28 4L-49 9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>`
  + `<g class="lxi__wing"><path d="M-4-1C-10-16-24-30-42-37L-38-33L-44-33L-36-28L-41-27C-31-18-22-9-14 2Z"/></g>`
  + `</g>`;

function build(seed) {
  const r = rng(seed);
  const id = `lxi${++uid}`;
  const layers = [
    { crest: 548, amp: 64, peaks: 4, valley: 10, op: 0.11, d: 0.12 },
    { crest: 592, amp: 56, peaks: 4, valley: 14, op: 0.15, d: 0.24 },
    { crest: 634, amp: 50, peaks: 3, valley: 18, op: 0.2, d: 0.38 },
    { crest: 672, amp: 42, peaks: 3, valley: 22, op: 0.27, d: 0.54 },
    { crest: 708, amp: 34, peaks: 3, valley: 24, op: 0.35, d: 0.74 },
    { crest: 738, amp: 26, peaks: 3, valley: 26, op: 0.46, d: 1 },
  ];
  const ridges = layers.map((l) => ridge(r, l));
  const fill = (k) => line(ridges[k].pts) + `L${X1} ${LAKE}L${X0} ${LAKE}Z`;

  let defs = `<linearGradient id="${id}-r" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity="1"/>`
    + `<stop offset=".55" stop-color="currentColor" stop-opacity=".55"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity=".08"/></linearGradient>`
    + `<linearGradient id="${id}-m" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity="0"/>`
    + `<stop offset=".5" stop-color="currentColor" stop-opacity="1"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient>`
    + `<linearGradient id="${id}-k" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="currentColor" stop-opacity=".78"/>`
    + `<stop offset="1" stop-color="currentColor" stop-opacity=".5"/></linearGradient>`
    + `<linearGradient id="${id}-w" gradientUnits="userSpaceOnUse" x1="0" y1="${LAKE}" x2="0" y2="${H}">`
    + `<stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity=".15"/></linearGradient>`
    // The one shared brush filter (mist edges only).
    + `<filter id="${id}-b" x="-5%" y="-80%" width="110%" height="260%">`
    + `<feTurbulence type="fractalNoise" baseFrequency=".011 .085" numOctaves="2" seed="${seed}" result="n"/>`
    + `<feDisplacementMap in="SourceGraphic" in2="n" scale="28" xChannelSelector="R" yChannelSelector="G"/></filter>`;

  // Ripple mask for the reflection: broken horizontal strokes.
  let strips = '';
  for (let y = LAKE + 1; y < H; y += between(r, 4.5, 8)) {
    let x = X0 + between(r, 0, 60);
    while (x < X1) {
      const w = between(r, 60, 420);
      strips += `M${f(x)} ${f(y)}h${f(w)}v${f(between(r, 2.2, 4.2))}h${f(-w)}Z`;
      x += w + between(r, 4, 40);
    }
  }
  defs += `<mask id="${id}-q" maskUnits="userSpaceOnUse" x="${X0}" y="${LAKE}" width="${X1 - X0}" height="${H - LAKE + 10}">`
    + `<path d="${strips}" fill="url(#${id}-w)"/></mask>`;

  let body = '';
  layers.forEach((l, k) => {
    const rd = ridges[k];
    let inner = `<path d="${fill(k)}" fill="url(#${id}-r)" fill-opacity="${l.op}"/>`
      + `<path d="${line(rd.pts)}" fill="none" stroke="currentColor" stroke-opacity="${f(Math.min(0.7, l.op * 1.5))}" stroke-width="${k > 3 ? 1.2 : 0.9}" stroke-linejoin="round"/>`;
    // Hatching on the nearer slopes for a drawn feel.
    if (k >= 2) {
      let hatch = '';
      for (let i = 0; i < 22; i++) {
        const x = between(r, 40, W - 40);
        const y = rd.at(x) + between(r, 5, 26);
        if (y > LAKE - 8) continue;
        hatch += `M${f(x)} ${f(y)}l${f(between(r, -7, -3))} ${f(between(r, 9, 18))}`;
      }
      inner += `<path d="${hatch}" fill="none" stroke="currentColor" stroke-opacity="${f(l.op * 0.8)}" stroke-width=".8" stroke-linecap="round"/>`;
    }
    // Mist band settling into the foot of this ridge.
    if (k >= 1 && k <= 4) {
      const my = layers[k].crest + 18 + k * 2;
      inner += `<rect class="lxi__mist" style="--lxi-d:${24 + k * 4}s" x="-120" y="${my}" width="${W + 240}" height="${44 + k * 6}" fill="url(#${id}-m)" fill-opacity="${f(0.07 + k * 0.012)}" filter="url(#${id}-b)"/>`;
    }
    if (k === 5) {
      // Tiny islet with a few pines in the lake.
      const ix = between(r, 1020, 1120);
      let isl = `M${f(ix - 52)} ${LAKE + 6}C${f(ix - 30)} ${LAKE - 8} ${f(ix + 18)} ${LAKE - 12} ${f(ix + 48)} ${LAKE + 6}Z`;
      for (let i = 0; i < 6; i++) {
        const px = ix + between(r, -34, 30);
        isl += pine(r, px, LAKE - 2 - Math.max(0, 8 - Math.abs(px - ix) / 4), between(r, 10, 24));
      }
      inner += `<path d="${isl}" fill-opacity=".52"/>`;
    }
    body += `<g class="lxi__p" data-d="${l.d}"><g class="lxi__l" style="--i:${k}">${inner}</g></g>`;
  });

  // Outcrops frame both edges and sit nearest to the viewer.
  let rocks = '';
  let mirror = '';
  [1, -1].forEach((side, i) => {
    const o = outcrop(r, side);
    const k = `${id}-o${i}`;
    rocks += `<g class="lxi__p" data-d="1"><g class="lxi__l" style="--i:7">`
      + `<path d="${o.back}" fill-opacity=".34"/>`
      + `<path id="${k}" d="${o.rock}" fill="url(#${id}-k)"/>`
      + `<path d="${o.cracks}" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width=".9" stroke-linecap="round"/>`
      + `<path id="${k}p" d="${o.front}" fill-opacity=".78"/>`
      + `</g></g>`;
    mirror += `<use href="#${k}"/><use href="#${k}p" fill-opacity=".6"/>`;
  });

  // Lake: reflection of the nearest ridge and outcrops, ripple lines and a shoreline.
  let ripples = '';
  for (let i = 0; i < 26; i++) {
    const y = between(r, LAKE + 10, H - 6);
    const x = between(r, 300, W - 300);
    ripples += `M${f(x)} ${f(y)}h${f(between(r, 16, 90))}`;
  }
  body += `<g class="lxi__p" data-d="1"><g class="lxi__l" style="--i:6">`
    + `<g mask="url(#${id}-q)" opacity=".55"><g class="lxi__shim"><g transform="matrix(1 0 0 -.82 0 ${f(LAKE * 1.82)})">`
    + `<path d="${fill(5)}" fill-opacity=".34"/><g opacity=".6">${mirror}</g>`
    + `</g></g></g>`
    + `<path d="${ripples}" fill="none" stroke="currentColor" stroke-opacity=".22" stroke-width=".9" stroke-linecap="round"/>`
    + `<path d="M${X0} ${LAKE}H${X1}" stroke="currentColor" stroke-opacity=".28" stroke-width=".8"/>`
    + `</g></g>${rocks}`;

  const cranes = `<g class="lxi__fly lxi__fly--a"><g transform="translate(0 286) scale(.95)">${CRANE}</g></g>`
    + `<g class="lxi__fly lxi__fly--b"><g transform="translate(0 322) scale(.72)" fill-opacity=".7">${CRANE}</g></g>`;

  return `<svg class="lxi__svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" fill="currentColor" focusable="false" aria-hidden="true">`
    + `<defs>${defs}</defs>${cranes}${body}</svg>`;
}

export function mountInk(el, { seed = 7 } = {}) {
  const root = document.createElement('div');
  root.className = 'lxi';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = build(seed);
  el.appendChild(root);

  const off = [];
  let raf = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;

  // Pointer parallax: per-layer offsets, rAF-lerped, nearest moves ≤ 8px.
  if (!reduce && fine) {
    const layers = [...root.querySelectorAll('.lxi__p')].map((g) => ({ g, d: +g.dataset.d }));
    let tx = 0, ty = 0, cx = 0, cy = 0;
    let vw = innerWidth, vh = innerHeight;
    const tick = () => {
      raf = 0;
      cx += (tx - cx) * 0.06;
      cy += (ty - cy) * 0.06;
      for (const { g, d } of layers) {
        g.style.transform = `translate3d(${(cx * 8 * d).toFixed(2)}px,${(cy * 3 * d).toFixed(2)}px,0)`;
      }
      if (Math.abs(tx - cx) > 0.002 || Math.abs(ty - cy) > 0.002) kick();
    };
    const kick = () => {
      if (!raf && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const onMove = (e) => {
      tx = (e.clientX / vw - 0.5) * -2;
      ty = (e.clientY / vh - 0.5) * -2;
      kick();
    };
    const onResize = () => { vw = innerWidth; vh = innerHeight; };
    const onVis = () => {
      if (document.hidden && raf) { cancelAnimationFrame(raf); raf = 0; } else kick();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVis);
    off.push(() => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
    });
  }

  return {
    destroy() {
      off.forEach((fn) => fn());
      off.length = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.innerHTML = '';
    },
  };
}
