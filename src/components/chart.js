// Chart.js wrapper that reads colours from the CSS design tokens so charts
// match the theme (light/dark) without per-chart configuration.
//
// Chart.js (~200 kB) is imported dynamically so a chart page's own code runs
// (and its data fetches start) without waiting for the library to download
// and parse. The warm-up call at the bottom of this module starts the fetch
// immediately, in parallel with the page's Supabase queries, so the first
// chart still draws as soon as its data arrives.
let ChartCtor = null; // the registered Chart constructor once the library is in
let libPromise = null;

function loadChart() {
  libPromise ||= import('chart.js').then((m) => {
    m.Chart.register(
      m.BarController, m.BarElement, m.LineController, m.LineElement, m.PointElement,
      m.DoughnutController, m.ArcElement, m.CategoryScale, m.LinearScale, m.Tooltip, m.Filler, m.Legend,
    );
    ChartCtor = m.Chart;
    return m.Chart;
  });
  // A failed fetch (flaky network) resets the memo so the next chart retries.
  libPromise.catch(() => { libPromise = null; });
  return libPromise;
}

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

// getComputedStyle returns a live declaration: one object serves every lookup
// and still reflects theme / skin changes.
let rootStyle = null;
export function token(name) {
  rootStyle ||= getComputedStyle(document.documentElement);
  return rootStyle.getPropertyValue(name).trim();
}

export function palette() {
  return {
    ink: token('--ink'), ink2: token('--ink-2'), ink3: token('--ink-3'), ink4: token('--ink-4'),
    rule: token('--rule'), surface: token('--surface'), paper2: token('--paper-2'),
    accent: token('--accent'), accentSoft: token('--accent-soft'),
    moss: token('--moss'), ochre: token('--ochre'), indigo: token('--indigo'), clay: token('--clay'), plum: token('--plum'),
  };
}

/** Fixed categorical order used when an entity has no colour of its own. */
export function series() {
  const p = palette();
  return [p.accent, p.indigo, p.moss, p.ochre, p.plum, p.clay, p.ink3];
}

function baseOptions(kind, Chart) {
  const p = palette();
  Chart.defaults.font.family = token('--font-sans') || 'system-ui';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = p.ink3;
  const tooltip = {
    backgroundColor: p.ink, titleColor: p.surface, bodyColor: p.surface,
    padding: 10, cornerRadius: 6, displayColors: true, boxPadding: 4,
    titleFont: { weight: '600' }, bodyFont: { family: token('--font-mono') },
  };
  if (kind === 'doughnut') {
    return { responsive: true, maintainAspectRatio: false, cutout: '72%', plugins: { legend: { display: false }, tooltip }, borderColor: p.surface };
  }
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip },
    scales: {
      x: { grid: { display: false }, border: { color: p.rule }, ticks: { color: p.ink3, maxRotation: 0, autoSkipPadding: 10 } },
      y: { beginAtZero: true, grid: { color: p.rule, drawTicks: false }, border: { display: false, dash: [3, 3] }, ticks: { color: p.ink3, padding: 8, maxTicksLimit: 5 } },
    },
  };
}

function merge(a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  }
  return out;
}

/** Create a chart inside `container` (a .chart-box). Returns destroy(). */
/**
 * Category colours come from the DB (any hue the user picked). On the warm
 * theme, cold/vivid hues clash, so slice colours are toned: saturation is
 * capped and the hue is nudged toward the caramel family. Chart-only — the
 * stored colour is untouched.
 */
function tone(c) {
  const m = typeof c === 'string' && /^#([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return c;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  // pull hue 30% toward 28° (caramel), cap saturation, keep lightness mid
  const dh = ((28 - h + 540) % 360) - 180;
  const H = (h + dh * 0.3 + 360) % 360, S = Math.min(s, 0.5) * 100, L = Math.min(Math.max(l, 0.42), 0.66) * 100;
  return `hsl(${H.toFixed(0)} ${S.toFixed(0)}% ${L.toFixed(0)}%)`;
}

export function makeChart(container, { type, data, options }) {
  if (type === 'doughnut' || type === 'pie') {
    data = { ...data, datasets: data.datasets.map((d) => ({ ...d, backgroundColor: Array.isArray(d.backgroundColor) ? d.backgroundColor.map(tone) : tone(d.backgroundColor) })) };
  }
  // Animate only as part of the page entrance (main.js → .is-entering). A chart
  // drawn later — data refresh, filter change, replacing one on screen — just
  // shows the new numbers instead of replaying a grow-from-zero.
  const redraw = Boolean(container.querySelector('canvas')) || !container.closest('.is-entering');
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  container.append(canvas);
  let chart = null;
  let destroyed = false;
  const draw = (Chart) => {
    if (destroyed || !canvas.isConnected) return;
    const opts = merge(baseOptions(type, Chart), options);
    // Printing: draw the final frame immediately so the print snapshot is never mid-animation.
    if (document.documentElement.dataset.print || redraw || REDUCED.matches) opts.animation = false;
    // Chart.js defaults to 1s: long enough to read as lag on every page open.
    else if (opts.animation !== false) opts.animation = { duration: 450, ...(opts.animation || {}) };
    chart = new Chart(canvas, { type, data, options: opts });
  };
  // Library already in: draw synchronously, exactly as before the lazy import
  // (redraws on data refresh / theme flips never wait a microtask).
  if (ChartCtor) draw(ChartCtor);
  else loadChart().then(draw).catch((err) => console.error(err));
  return () => { destroyed = true; chart?.destroy(); chart = null; };
}

// Warm-up: start downloading Chart.js the moment a chart page's chunk loads
// (also covers main.js's idle route prefetch), without blocking that chunk.
loadChart().catch(() => {});
