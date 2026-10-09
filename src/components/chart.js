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
export function makeChart(container, { type, data, options }) {
  container.innerHTML = '';
  const canvas = document.createElement('canvas');
  container.append(canvas);
  const chart = new Chart(canvas, { type, data, options: merge(baseOptions(type), options) });
  return () => chart.destroy();
}
