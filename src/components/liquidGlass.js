// Liquid-glass refraction for small glass controls.
//
// For each target element we render a displacement map: the signed distance
// field (SDF) of the element's rounded rectangle gives, near the edge, a
// normal vector; pixels there are pushed inward along that normal (strongest
// at the rim, fading to zero `RIM` px inside). The map feeds an SVG
// <feDisplacementMap>, applied through `backdrop-filter: url(#…)` so the
// content BEHIND the control bends like light through a lens edge.
//
// backdrop-filter with an SVG reference only renders in Chromium; elsewhere
// (Safari/Firefox) the CSS blur from theme.css remains. Maps are cached by
// size+radius, so a page of identical buttons shares one filter.

const SELECTOR = [
  '[data-liquid]',
  '.topbar .icon-btn',
  '.topbar .btn:not(.btn--primary):not(.btn--accent)',
  '.timer-chip',
  '.segmented',
].join(',');

const RIM = 14;          // px of the edge zone that refracts
const SCALE = 18;        // feDisplacementMap scale (max shift in px)
const NS = 'http://www.w3.org/2000/svg';

const supported = typeof window !== 'undefined'
  && !!window.chrome
  && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a)')
  && !matchMedia('(prefers-reduced-transparency: reduce)').matches
  // Refraction is a desktop flourish; phones keep scrolling cheap.
  && !matchMedia('(pointer: coarse), (max-width: 960px)').matches;

let svgRoot = null;
const cache = new Map(); // key -> filter id
let seq = 0;

function host() {
  if (svgRoot) return svgRoot;
  svgRoot = document.createElementNS(NS, 'svg');
  svgRoot.setAttribute('aria-hidden', 'true');
  svgRoot.setAttribute('width', '0');
  svgRoot.setAttribute('height', '0');
  svgRoot.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  svgRoot.append(document.createElementNS(NS, 'defs'));
  document.body.append(svgRoot);
  return svgRoot;
}

/** Signed distance from p to a rounded rect centred at 0 with half-size b, radius r. */
function sdf(px, py, bx, by, r) {
  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Outward unit normal of the same rounded rect at p. */
function normal(px, py, bx, by, r) {
  const qx = Math.abs(px) - (bx - r);
  const qy = Math.abs(py) - (by - r);
  const sx = Math.sign(px) || 1, sy = Math.sign(py) || 1;
  if (qx > 0 && qy > 0) {               // corner arc
    const l = Math.hypot(qx, qy) || 1;
    return [(qx / l) * sx, (qy / l) * sy];
  }
  return qx > qy ? [sx, 0] : [0, sy];   // straight edge
}

function makeMap(w, h, r) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const bx = w / 2, by = h / 2, rr = Math.min(r, bx, by);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - bx, py = y + 0.5 - by;
      const d = sdf(px, py, bx, by, rr);         // < 0 inside
      let dx = 0, dy = 0;
      if (d < 0 && -d < RIM) {
        const t = 1 - -d / RIM;                  // 1 at the rim → 0 inside
        const s = t * t * (3 - 2 * t);           // smoothstep falloff
        const [nx, ny] = normal(px, py, bx, by, rr);
        dx = -nx * s; dy = -ny * s;              // bend inward, like a lens edge
      }
      const i = (y * w + x) * 4;
      img.data[i] = 128 + dx * 127;
      img.data[i + 1] = 128 + dy * 127;
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

function filterFor(w, h, r) {
  const key = `${w}x${h}r${r}`;
  if (cache.has(key)) return cache.get(key);
  const id = `nm-lg-${++seq}`;
  const f = document.createElementNS(NS, 'filter');
  f.setAttribute('id', id);
  f.setAttribute('x', '0'); f.setAttribute('y', '0');
  f.setAttribute('width', String(w)); f.setAttribute('height', String(h));
  f.setAttribute('filterUnits', 'userSpaceOnUse');
  f.setAttribute('primitiveUnits', 'userSpaceOnUse');
  f.setAttribute('color-interpolation-filters', 'sRGB');
  const fi = document.createElementNS(NS, 'feImage');
  fi.setAttribute('href', makeMap(w, h, r));
  fi.setAttribute('x', '0'); fi.setAttribute('y', '0');
  fi.setAttribute('width', String(w)); fi.setAttribute('height', String(h));
  fi.setAttribute('result', 'map');
  const dm = document.createElementNS(NS, 'feDisplacementMap');
  dm.setAttribute('in', 'SourceGraphic');
  dm.setAttribute('in2', 'map');
  dm.setAttribute('scale', String(SCALE));
  dm.setAttribute('xChannelSelector', 'R');
  dm.setAttribute('yChannelSelector', 'G');
  f.append(fi, dm);
  host().firstChild.append(f);
  cache.set(key, id);
  return id;
}

function apply(el) {
  const rect = el.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w < 8 || h < 8 || w > 640 || h > 240) return;
  const r = Math.round(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
  const key = `${w}x${h}r${r}`;
  if (el.dataset.lg === key) return;
  el.dataset.lg = key;
  const id = filterFor(w, h, r);
  const v = `url(#${id}) blur(2px) saturate(1.3)`;
  el.style.backdropFilter = v;
  el.style.webkitBackdropFilter = v;
}

let queued = false;
function scan() {
  queued = false;
  document.querySelectorAll(SELECTOR).forEach((el) => {
    if (!el.isConnected || el.offsetParent === null) return;
    apply(el);
    if (!el.__lgObserved) { el.__lgObserved = true; ro.observe(el); }
  });
}
function queue() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(scan);
}

const ro = supported ? new ResizeObserver((entries) => entries.forEach((e) => apply(e.target))) : null;

/**
 * Only rescan when a mutation actually brought in a glass control. Most
 * mutations are typing / list updates; a full scan there reads layout for
 * every control on every frame (forced reflow while the user types).
 */
function relevant(records) {
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(SELECTOR) || n.querySelector(SELECTOR)) return true;
    }
  }
  return false;
}

export function initLiquidGlass() {
  if (!supported) return;
  new MutationObserver((records) => { if (relevant(records)) queue(); })
    .observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', queue);
  queue();
}
