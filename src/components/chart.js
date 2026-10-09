// Chart.js wrapper that reads colours from the CSS design tokens so charts
// match the theme (light/dark) without per-chart configuration.
import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  DoughnutController, ArcElement, CategoryScale, LinearScale, Tooltip, Filler, Legend,
} from 'chart.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, DoughnutController, ArcElement, CategoryScale, LinearScale, Tooltip, Filler, Legend);

export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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

function baseOptions(kind) {
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
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  container.append(canvas);
  const opts = merge(baseOptions(type), options);
  // Printing: draw the final frame immediately so the print snapshot is never mid-animation.
  if (document.documentElement.dataset.print) opts.animation = false;
  const chart = new Chart(canvas, { type, data, options: opts });
  return () => chart.destroy();
}
