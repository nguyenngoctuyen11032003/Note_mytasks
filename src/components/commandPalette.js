// Command palette (Ctrl/⌘+K): navigation, actions and live search over
// tasks, notes and expenses. Native <dialog> gives the focus trap + Esc;
// the input is an ARIA combobox driving a listbox via aria-activedescendant.
//
// Matching is diacritic-insensitive ("ghi chu" finds "Ghi chú"): server
// search (ILIKE, accent-sensitive) is merged with a small recent corpus
// fetched once per opening and matched locally.
import { html, fragment, raw, esc } from '../utils/dom.js';
import { icon } from './icons.js';
import { NAV, setThemePref } from './shell.js';
import { navigate, current } from '../core/router.js';
import * as store from '../core/store.js';
import { notifyDataChanged } from '../core/events.js';
import { money, day } from '../utils/format.js';
import { toast } from './toast.js';
import { TASK_STATUS, isTouchOnly } from './ui.js';
import { openTaskForm } from './taskForm.js';
import * as timer from './timer.js';
import { listTasks } from '../services/tasks.js';
import { listExpenses } from '../services/expenses.js';

// notes.js may land after this file; glob keeps the build green either way.
const NOTES = import.meta.glob('../services/notes.js');
async function notesApi() {
  const load = NOTES['../services/notes.js'];
  return load ? load() : null;
}

const RECENT_KEY = 'nm.cmdk.recent';
const RECENT_MAX = 6;
const PER_GROUP = 6;

export const GO_KEYS = { d: '/dashboard', n: '/notes', t: '/tasks', c: '/calendar', h: '/time', k: '/kpi', e: '/expenses', s: '/shopping', r: '/reports' };
const GO_BY_PATH = Object.fromEntries(Object.entries(GO_KEYS).map(([k, p]) => [p, k.toUpperCase()]));
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

let ctx = { onSignOut: null, onHelp: null };
/** main.js wires the callbacks that live outside this module. */
export function configurePalette(c) {
  ctx = { ...ctx, ...c };
}

/* ------------------------------------------------------------------ */
/* Text matching                                                       */

/** Lower-case, strip Vietnamese diacritics (NFD), đ → d. */
export function fold(s = '') {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

/** Folded string plus a map from folded index → original index (for highlights). */
function foldMap(s) {
  let out = '';
  const map = [];
  [...String(s)].forEach((ch, i) => {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
  });
  return { out, map, chars: [...String(s)] };
}

/** Score one token against folded text. 0 = no match. */
function tokenScore(tok, text, subseq = true) {
  if (!tok) return 1;
  const i = text.indexOf(tok);
  if (i === 0) return 100;
  if (i > 0) return /[\s\-_/·.,(]/.test(text[i - 1]) ? 80 : 60 - Math.min(i, 30) * 0.5;
  // Subsequence ("cvc" → "công việc") — weak signal, titles only.
  if (!subseq || text.length > 120) return 0;
  let j = 0, gaps = 0, last = -1;
  for (let k = 0; k < text.length && j < tok.length; k++) {
    if (text[k] === tok[j]) { if (last >= 0) gaps += k - last - 1; last = k; j++; }
  }
  return j === tok.length && tok.length >= 2 ? Math.max(5, 30 - gaps) : 0;
}

export function score(query, ...fields) {
  const toks = fold(query).trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return 1;
  const hay = fields.filter(Boolean).map(fold);
  let total = 0;
  for (const t of toks) {
    let best = 0;
    hay.forEach((h, idx) => { best = Math.max(best, tokenScore(t, h, idx === 0) * (idx === 0 ? 1 : 0.6)); });
    if (!best) return 0;
    total += best;
  }
  return total / toks.length;
}

/** Highlight contiguous token matches in the original (accented) text. */
function highlight(text, query) {
  const toks = fold(query).trim().split(/\s+/).filter((t) => t.length > 0);
  if (!toks.length || !text) return esc(text || '');
  const { out, map, chars } = foldMap(text);
  const mark = new Array(chars.length).fill(false);
  for (const t of toks) {
    let from = 0, i;
    while ((i = out.indexOf(t, from)) !== -1) {
      for (let k = i; k < i + t.length; k++) mark[map[k]] = true;
      from = i + t.length;
    }
  }
  let res = '', open = false;
  chars.forEach((c, i) => {
    if (mark[i] && !open) { res += '<mark>'; open = true; }
    if (!mark[i] && open) { res += '</mark>'; open = false; }
    res += esc(c);
  });
  return open ? res + '</mark>' : res;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */

/** The espresso (dark) palette is the default; only data-theme=light is latte. */
function effectiveTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function staticCommands() {
  const navs = NAV.filter((n) => n.path).map((n) => ({
    id: `nav:${n.path}`,
    group: 'Đi tới',
    icon: n.icon,
    label: n.label,
    sub: null,
    keywords: `${n.path.slice(1)} trang`,
    kbd: GO_BY_PATH[n.path] ? ['G', GO_BY_PATH[n.path]] : null,
    run: () => navigate(n.path),
  }));
  const dark = effectiveTheme() === 'dark';
  const path = current().path;
  const actions = [
    { id: 'act:new-task', icon: 'tasks', label: 'Tạo công việc', keywords: 'them task moi viec', run: () => openTaskForm({ onSaved: () => notifyDataChanged('tasks') }) },
    { id: 'act:new-note', icon: 'note', label: 'Tạo ghi chú', keywords: 'them note moi viet', run: () => navigate('/notes', { new: '1' }) },
    { id: 'act:new-expense', icon: 'wallet', label: 'Thêm khoản chi', keywords: 'chi tieu tien expense', run: () => navigate('/expenses', { new: '1' }) },
    { id: 'act:new-shopping', icon: 'cart', label: 'Thêm món cần mua', keywords: 'mua sam shopping', run: () => navigate('/shopping', { new: '1' }) },
    { id: 'act:timer', icon: 'timer', label: 'Bắt đầu tính giờ', keywords: 'timer bam gio hen gio dong ho start', run: startTimer },
    { id: 'act:log-time', icon: 'clock', label: 'Ghi giờ thủ công', keywords: 'time entry', run: () => navigate('/time', { new: '1' }) },
    { id: 'act:theme', icon: dark ? 'sun' : 'moon', label: dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối', keywords: 'doi giao dien theme dark light sang toi', run: () => setThemePref(dark ? 'light' : 'dark') },
    { id: 'act:home', icon: 'pin', label: 'Đặt trang này làm trang chủ', sub: NAV.find((n) => n.path === path)?.label, keywords: 'home mac dinh landing', run: () => setHome(path) },
    { id: 'act:help', icon: 'info', label: 'Xem phím tắt', keywords: 'keyboard shortcuts phim tat tro giup', kbd: ['?'], run: () => ctx.onHelp?.() },
    { id: 'act:signout', icon: 'logout', label: 'Đăng xuất', keywords: 'sign out logout thoat', run: () => ctx.onSignOut?.() },
  ].filter((a) => a.id !== 'act:help' || !isTouchOnly()) // no keyboard → no shortcut sheet
    .map((a) => ({ ...a, group: 'Hành động' }));
  return [...actions, ...navs];
}

async function startTimer() {
  if (store.get().runningEntry) {
    toast.info('Đồng hồ đang chạy — mở trang Thời gian.');
    navigate('/time');
    return;
  }
  try {
    await timer.start({});
    toast('Đã bắt đầu tính giờ.', { action: { label: 'Mở', onClick: () => navigate('/time') } });
  } catch (err) {
    toast.error(err);
  }
}

function setHome(path) {
  if (!NAV.some((n) => n.path === path)) return;
  try { localStorage.setItem('nm.home', path); } catch {}
  toast(`Trang chủ: ${NAV.find((n) => n.path === path).label}`);
}

/* ---------- Live data → items ---------- */

const excerpt = (s, n = 72) => {
  const t = String(s || '').replace(/[#>*_`~\-[\]()!]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

const taskItem = (t) => ({
  id: `task:${t.id}`, group: 'Công việc', icon: t.status === 'completed' ? 'checkCircle' : 'tasks',
  label: t.title, sub: [TASK_STATUS[t.status]?.label, t.due_date ? day(t.due_date) : ''].filter(Boolean).join(' · '),
  search: t.description || '', href: `#/tasks?id=${encodeURIComponent(t.id)}`,
});
const noteItem = (n) => ({
  id: `note:${n.id}`, group: 'Ghi chú', icon: 'note',
  label: n.title || 'Ghi chú không tên', sub: excerpt(n.content), search: String(n.content || '').slice(0, 4000),
  href: `#/notes?id=${encodeURIComponent(n.id)}`,
});
const expenseItem = (e) => ({
  id: `exp:${e.id}`, group: 'Chi tiêu', icon: 'wallet',
  label: e.description || store.categoryById(e.category_id)?.name || 'Khoản chi',
  sub: `${money(e.amount)} · ${day(e.spent_on)}`, search: `${e.note || ''} ${store.categoryById(e.category_id)?.name || ''}`,
  href: `#/expenses?period=day&date=${encodeURIComponent(e.spent_on || '')}&focus=${encodeURIComponent(e.id)}`,
});

/* ------------------------------------------------------------------ */
/* Recent                                                               */

function readRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((r) => r && r.id); } catch { return []; }
}
function pushRecent(item) {
  const entry = { id: item.id, icon: item.icon, label: item.label, sub: item.sub || '', href: item.href || null };
  const list = [entry, ...readRecent().filter((r) => r.id !== item.id)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

/* ------------------------------------------------------------------ */
/* Dialog                                                               */

let dlg = null;

export const isPaletteOpen = () => Boolean(dlg);

export function closePalette() {
  dlg?.close();
}

export function togglePalette() {
  if (dlg) closePalette();
  else openPalette();
}

export function openPalette(initial = '') {
  if (dlg) { dlg.querySelector('input').focus(); return; }

  const commands = staticCommands();
  const el = fragment(html`
    <dialog class="cmdk" aria-label="Bảng lệnh">
      <div class="cmdk__head">
        ${icon('search')}
        <input class="cmdk__input" type="text" role="combobox" aria-expanded="true" aria-controls="cmdk-list"
          aria-autocomplete="list" aria-label="Tìm trang, lệnh, công việc, ghi chú, khoản chi"
          placeholder="Tìm trang, lệnh, công việc, ghi chú…" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" />
        <span class="cmdk__spin" aria-hidden="true"></span>
        <button type="button" class="cmdk__esc" data-close aria-label="Đóng"><kbd>Esc</kbd><span>Đóng</span></button>
      </div>
      <div class="cmdk__list" id="cmdk-list" role="listbox" aria-label="Kết quả"></div>
      <footer class="cmdk__foot" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> chọn</span>
        <span><kbd>↵</kbd> mở</span>
        <span><kbd>Esc</kbd> đóng</span>
        <span class="cmdk__brand">Note_mytasks</span>
      </footer>
      <div class="sr-only" role="status" aria-live="polite" data-count></div>
    </dialog>`);

  const input = el.querySelector('input');
  const list = el.querySelector('.cmdk__list');
  const status = el.querySelector('[data-count]');
  let flat = [];
  let active = 0;
  let live = { tasks: [], notes: [], expenses: [] };
  let corpus = null;      // recent rows matched locally (accent-insensitive)
  let failed = false;     // data search unavailable (all sources errored)
  let token = 0;
  let timerId = null;

  const loadCorpus = () => {
    if (corpus) return corpus;
    corpus = Promise.allSettled([
      listTasks({ limit: 300 }),
      notesApi().then((m) => (m?.listNotes ? m.listNotes({ limit: 150 }) : [])),
      listExpenses({ limit: 150 }),
    ]).then(([t, n, e]) => {
      // Every source failed (offline, expired session…): say so instead of
      // pretending nothing matched. Pages and commands still work.
      failed = [t, n, e].every((r) => r.status === 'rejected');
      return {
        tasks: t.status === 'fulfilled' ? t.value || [] : [],
        notes: n.status === 'fulfilled' ? n.value || [] : [],
        expenses: e.status === 'fulfilled' ? e.value || [] : [],
      };
    });
    return corpus;
  };

  function groupsFor(q) {
    const groups = [];
    if (!q.trim()) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const recent = readRecent().map((r) => byId.get(r.id) || { ...r, group: 'Gần đây', run: () => { if (r.href) window.location.hash = r.href.slice(1); } })
        .map((r) => ({ ...r, group: 'Gần đây', sub: r.sub }));
      if (recent.length) groups.push(['Gần đây', recent]);
      groups.push(['Hành động', commands.filter((c) => c.group === 'Hành động').slice(0, 6)]);
      groups.push(['Đi tới', commands.filter((c) => c.group === 'Đi tới')]);
      return groups;
    }
    const rank = (items, fields) => items
      .map((it) => ({ it, s: score(q, ...fields(it)) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const cmds = rank(commands, (c) => [c.label, c.keywords, c.sub]);
    const data = [
      ['Công việc', rank(live.tasks.map(taskItem), (i) => [i.label, i.search])],
      ['Ghi chú', rank(live.notes.map(noteItem), (i) => [i.label, i.search])],
      ['Chi tiêu', rank(live.expenses.map(expenseItem), (i) => [i.label, i.search, i.sub])],
    ];
    const cmdGroups = ['Hành động', 'Đi tới'].map((g) => [g, cmds.filter((x) => x.it.group === g)]);
    // Order groups by their best hit; ties keep the declared order.
    return [...cmdGroups, ...data]
      .filter(([, xs]) => xs.length)
      .map(([g, xs], i) => ({ g, xs, best: xs[0].s, i }))
      .sort((a, b) => b.best - a.best || a.i - b.i)
      .map(({ g, xs }) => [g, xs.slice(0, PER_GROUP).map((x) => x.it)]);
  }

  function draw() {
    const q = input.value;
    const groups = groupsFor(q);
    flat = groups.flatMap(([, xs]) => xs);
    active = Math.min(active, Math.max(flat.length - 1, 0));
    let n = 0;
    list.innerHTML = String(html`${groups.map(([g, xs], gi) => html`
      <div class="cmdk__group" role="group" aria-labelledby="cmdk-g${gi}">
        <div class="cmdk__gtitle" id="cmdk-g${gi}">${g}</div>
        ${xs.map((it) => {
          const i = n++;
          return html`<div class="cmdk__item" role="option" id="cmdk-o${i}" data-i="${i}" aria-selected="${i === active}">
            <span class="cmdk__icon">${icon(it.icon || 'arrowRight')}</span>
            <span class="cmdk__text">
              <span class="cmdk__label truncate">${raw(highlight(it.label, q))}</span>
              ${it.sub ? html`<span class="cmdk__sub truncate">${it.sub}</span>` : ''}
            </span>
            ${it.kbd ? html`<span class="cmdk__kbd">${it.kbd.map((k) => html`<kbd>${k}</kbd>`)}</span>` : html`<span class="cmdk__go">${icon('arrowRight')}</span>`}
          </div>`;
        })}
      </div>`)}`);
    if (!flat.length) {
      list.innerHTML = String(html`<div class="cmdk__empty">
        <span class="cmdk__empty-icon" aria-hidden="true">${icon(failed ? 'alert' : 'search')}</span>
        <strong>${failed ? 'Chưa tìm được trong dữ liệu' : 'Không có kết quả'}</strong>
        <p>${failed
          ? 'Không tải được công việc, ghi chú và khoản chi — kiểm tra kết nối rồi mở lại bảng lệnh.'
          : html`Không tìm thấy “${q.trim()}”. Thử từ khóa ngắn hơn — dấu tiếng Việt không bắt buộc.`}</p>
      </div>`);
    } else if (failed && q.trim()) {
      list.insertAdjacentHTML('beforeend', String(html`<p class="cmdk__note" role="note">${icon('alert')} Không tải được dữ liệu — chỉ hiện trang và lệnh.</p>`));
    }
    status.textContent = q.trim() ? `${flat.length} kết quả` : '';
    setActive(active, false);
  }

  function setActive(i, scroll = true) {
    if (!flat.length) { input.removeAttribute('aria-activedescendant'); return; }
    active = (i + flat.length) % flat.length;
    list.querySelectorAll('[aria-selected="true"]').forEach((o) => o.setAttribute('aria-selected', 'false'));
    const opt = list.querySelector(`#cmdk-o${active}`);
    opt?.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', `cmdk-o${active}`);
    if (scroll) opt?.scrollIntoView({ block: 'nearest' });
  }

  function run(i) {
    const it = flat[i];
    if (!it) return;
    pushRecent(it);
    el.close();
    // After the dialog is gone so modals opened by the command get focus.
    setTimeout(() => {
      if (it.run) it.run();
      else if (it.href) window.location.hash = it.href.slice(1);
    }, 0);
  }

  async function search() {
    const q = input.value.trim();
    const my = ++token;
    if (!q) { live = { tasks: [], notes: [], expenses: [] }; el.classList.remove('is-loading'); draw(); return; }
    el.classList.add('is-loading');
    const local = await loadCorpus();
    if (my !== token) return;
    live = local;
    draw();
    if (q.length < 2) { el.classList.remove('is-loading'); return; }
    // Server search reaches older rows outside the local corpus.
    const [t, n, e] = await Promise.allSettled([
      listTasks({ search: q, limit: 8 }),
      notesApi().then((m) => (m?.listNotes ? m.listNotes({ search: q, limit: 8 }) : [])),
      listExpenses({ search: q, limit: 8 }),
    ]);
    if (my !== token) return;
    const merge = (a, b) => { const seen = new Set(a.map((x) => x.id)); return [...a, ...(b || []).filter((x) => !seen.has(x.id))]; };
    live = {
      tasks: merge(local.tasks, t.status === 'fulfilled' ? t.value : []),
      notes: merge(local.notes, n.status === 'fulfilled' ? n.value : []),
      expenses: merge(local.expenses, e.status === 'fulfilled' ? e.value : []),
    };
    el.classList.remove('is-loading');
    draw();
  }

  input.addEventListener('input', () => {
    active = 0;
    draw();
    clearTimeout(timerId);
    timerId = setTimeout(search, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setActive(flat.length - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive(Math.min(active + 5, flat.length - 1)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive(Math.max(active - 5, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  });
  list.addEventListener('pointermove', (e) => {
    const o = e.target.closest('[data-i]');
    if (o && Number(o.dataset.i) !== active) setActive(Number(o.dataset.i), false);
  });
  list.addEventListener('click', (e) => {
    const o = e.target.closest('[data-i]');
    if (o) run(Number(o.dataset.i));
  });
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close]')) el.close();
  });
  el.addEventListener('close', () => {
    clearTimeout(timerId);
    token++;
    el.remove();
    if (dlg === el) dlg = null;
  });

  document.body.append(el);
  dlg = el;
  el.showModal();
  input.value = initial;
  draw();
  input.focus();
  if (initial) search();
  // Warm the local corpus in the background so the first keystroke is instant.
  setTimeout(() => { if (dlg === el) loadCorpus(); }, 120);
}
