// Task detail drawer — a side panel on desktop, a bottom sheet on phones.
// Every field saves inline (optimistic, rolled back on error).
//
//   const d = openTaskDrawer({ task, onSaved(task), onDeleted(task), onClose() })
//   d.update(task)  — push a newer copy (e.g. toggled from the list)
//   d.close()
import { html, raw, esc } from '../utils/dom.js';
import { icon } from './icons.js';
import { TASK_STATUS, TASK_PRIORITY, categoryOptions, tagInput, bindTagInput, popMenu, closeMenu } from './ui.js';
import { RECURRENCE_LABELS, ESTIMATE_PRESETS, openTaskForm } from './taskForm.js';
import { toast } from './toast.js';
import * as timer from './timer.js';
import * as store from '../core/store.js';
import { updateTask, setTaskStatus, getTask } from '../services/tasks.js';
import { listEntriesForTask } from '../services/timeEntries.js';
import { today, addDays, dayOf, startOfWeek } from '../utils/date.js';
import { minutes, relDay, time as fmtTime, dateTime, ago, clock } from '../utils/format.js';

let current = null;

export function isDrawerOpen() {
  return Boolean(current);
}
export function currentDrawerTaskId() {
  return current?.taskId() || null;
}

/* ------------------------------------------------------------------ */
/* Tiny, safe markdown (escape first, then a small set of constructs)  */
/* ------------------------------------------------------------------ */

function inline(s) {
  let out = esc(s);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  out = out
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#\/)[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" ${u.startsWith('#') ? '' : 'target="_blank" rel="noopener noreferrer"'}>${t}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u.replace(/^https?:\/\//, '').slice(0, 48)}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

export function renderMarkdown(src = '') {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];
  let fence = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  lines.forEach((line, i) => {
    if (fence) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
      return;
    }
    if (/^```/.test(line)) { flushPara(); closeList(); fence = []; return; }
    let m;
    if ((m = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul class="md-check">'); list = 'ul'; }
      const done = m[1].toLowerCase() === 'x';
      out.push(`<li class="${done ? 'is-done' : ''}"><button type="button" class="md-box" data-md-line="${i}" role="checkbox" aria-checked="${done}" aria-label="Đánh dấu việc con">${done ? '✓' : ''}</button><span>${inline(m[2])}</span></li>`);
      return;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      return;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      return;
    }
    closeList();
    if (!line.trim()) { flushPara(); return; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); return; }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); return; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); out.push('<hr>'); return; }
    para.push(line);
  });
  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  flushPara();
  closeList();
  return out.join('');
}

/** Sub-task progress from "- [ ]" / "- [x]" lines. */
export function checklistStats(src = '') {
  const all = String(src).match(/^\s*[-*+]\s+\[( |x|X)\]/gm) || [];
  const done = all.filter((s) => /\[(x|X)\]/.test(s)).length;
  return { total: all.length, done };
}

/* ------------------------------------------------------------------ */

const PRIO_ORDER = ['low', 'medium', 'high', 'urgent'];

export function openTaskDrawer({ task, onSaved, onDeleted, onClose, focus } = {}) {
  current?.close({ silent: true });

  let t = { ...task };
  let entries = null; // null = loading
  let entriesErr = null;
  let editingDesc = false;
  let closed = false;
  const lastFocus = document.activeElement;
  const unsubs = [];

  const root = document.createElement('div');
  root.className = 'tk-drawer';
  root.innerHTML = String(html`
    <div class="tk-drawer__scrim" data-close></div>
    <aside class="tk-drawer__panel" role="dialog" aria-modal="true" aria-labelledby="tkd-title" tabindex="-1">
      <div class="tk-drawer__grab" data-grab aria-hidden="true"><span></span></div>
      <header class="tk-drawer__head" data-grab>
        <div class="tk-drawer__crumb"><span class="eyebrow tk-drawer__num">§ 03</span><span class="eyebrow">Chi tiết công việc</span><span class="tk-drawer__saved" data-saved aria-live="polite"></span></div>
        <div class="tk-drawer__tools">
          <button type="button" class="icon-btn" data-act="more" aria-label="Thêm thao tác" aria-haspopup="menu">${icon('more')}</button>
          <button type="button" class="icon-btn" data-close aria-label="Đóng (Esc)">${icon('x')}</button>
        </div>
      </header>
      <div class="tk-drawer__body">
        <div data-sec="title"></div>
        <dl class="tk-props" data-sec="props"></dl>
        <section class="tk-dsec" data-sec="desc"></section>
        <section class="tk-dsec" data-sec="time"></section>
        <section class="tk-dsec" data-sec="links"></section>
        <footer class="tk-dmeta" data-sec="meta"></footer>
      </div>
    </aside>`);
  document.body.append(root);
  document.documentElement.classList.add('tk-drawer-lock');
  const panel = root.querySelector('.tk-drawer__panel');
  const $ = (s) => root.querySelector(s);
  requestAnimationFrame(() => root.classList.add('is-open'));

  /* ---------- sections ---------- */

  const isDone = () => t.status === 'completed';
  const running = () => store.get().runningEntry?.task_id === t.id;

  function paintTitle() {
    const sec = $('[data-sec="title"]');
    const ta = sec.querySelector('textarea');
    if (ta && document.activeElement === ta) {
      sec.querySelector('.tick')?.setAttribute('aria-checked', String(isDone()));
      return;
    }
    sec.innerHTML = String(html`
      <div class="tk-dtitle ${isDone() ? 'is-done' : ''}">
        <button type="button" class="tick tk-dtitle__tick" role="checkbox" aria-checked="${isDone()}" data-act="toggle" data-p="${t.priority}" aria-label="${isDone() ? 'Mở lại' : 'Đánh dấu hoàn thành'}">${icon('check')}</button>
        <textarea id="tkd-title" class="tk-dtitle__input" rows="1" maxlength="200" aria-label="Tiêu đề công việc" spellcheck="false">${t.title}</textarea>
      </div>`);
    autosize(sec.querySelector('textarea'));
  }

  function paintProps() {
    const prioBtns = PRIO_ORDER.map((p) => html`<button type="button" class="tk-prio-opt" data-prio="${p}" aria-pressed="${t.priority === p}" title="${TASK_PRIORITY[p]}"><span class="prio" data-p="${p}"><span class="prio__bars"><i></i><i></i><i></i></span></span><span>${TASK_PRIORITY[p]}</span></button>`);
    const t0 = today();
    const quickDue = [
      { v: t0, l: 'Hôm nay' },
      { v: addDays(t0, 1), l: 'Mai' },
      { v: addDays(startOfWeek(t0), 7), l: 'Tuần sau' },
    ];
    $('[data-sec="props"]').innerHTML = String(html`
      <div class="tk-prop">
        <dt>${icon('activity')}<span>Trạng thái</span></dt>
        <dd><div class="tk-status" role="radiogroup" aria-label="Trạng thái">
          ${Object.entries(TASK_STATUS).map(([v, s]) => html`<button type="button" role="radio" aria-checked="${t.status === v}" data-status="${v}" class="tk-status__opt tk-status__opt--${v}">${s.label}</button>`)}
        </div></dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('flag')}<span>Ưu tiên</span></dt>
        <dd><div class="tk-prio-pick" role="group" aria-label="Độ ưu tiên">${prioBtns}</div></dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('folder')}<span>Danh mục</span></dt>
        <dd><select class="select select--sm tk-inline" data-field="category_id" aria-label="Danh mục">
          ${categoryOptions('task', { all: '— Chưa phân loại —' }).map((o) => html`<option value="${o.value}" ${o.value === (t.category_id || '') ? raw('selected') : ''}>${o.label}</option>`)}
        </select></dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('calendar')}<span>Hạn chót</span></dt>
        <dd class="tk-prop__stack">
          <div class="row-wrap">
            <input class="input input--sm tk-inline tk-date" type="date" data-field="due_date" value="${t.due_date || ''}" aria-label="Hạn chót" />
            ${t.due_date ? html`<span class="tk-rel ${!isDone() && t.due_date < t0 ? 'is-overdue' : ''}">${relDay(t.due_date)}</span>` : ''}
          </div>
          <div class="tk-chips">
            ${quickDue.map((q) => html`<button type="button" class="tk-chip ${t.due_date === q.v ? 'is-on' : ''}" data-due="${q.v}">${q.l}</button>`)}
            ${t.due_date ? html`<button type="button" class="tk-chip tk-chip--ghost" data-due="">${icon('x')} Bỏ hạn</button>` : ''}
          </div>
        </dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('hourglass')}<span>Ước tính</span></dt>
        <dd class="tk-prop__stack">
          <div class="input-group tk-est"><input class="input input--sm tk-inline has-suffix" type="number" min="0" step="5" inputmode="numeric" data-field="estimated_minutes" value="${t.estimated_minutes ?? ''}" placeholder="—" aria-label="Ước tính (phút)" /><span class="input-group__suffix">phút</span></div>
          <div class="tk-chips">${ESTIMATE_PRESETS.map((m) => html`<button type="button" class="tk-chip ${t.estimated_minutes === m ? 'is-on' : ''}" data-est="${m}">${minutes(m)}</button>`)}</div>
        </dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('repeat')}<span>Lặp lại</span></dt>
        <dd><select class="select select--sm tk-inline" data-field="recurrence" aria-label="Lặp lại">
          <option value="">Không lặp</option>
          ${Object.entries(RECURRENCE_LABELS).map(([v, l]) => html`<option value="${v}" ${t.recurrence === v ? raw('selected') : ''}>${l}</option>`)}
        </select>
        ${t.recurrence ? html`<span class="tk-hint">Hoàn thành sẽ tự tạo lần kế tiếp.</span>` : ''}</dd>
      </div>
      <div class="tk-prop">
        <dt>${icon('tag')}<span>Thẻ</span></dt>
        <dd>${raw(String(tagInput('tags', t.tags || [])).replace('__ID__', 'tkd-tags'))}</dd>
      </div>`);
    bindTagInput($('[data-sec="props"]'));
  }

  function paintDesc() {
    const sec = $('[data-sec="desc"]');
    const stats = checklistStats(t.description || '');
    const head = html`<div class="tk-dsec__head"><h3><span class="tk-dsec__num">A</span> Mô tả</h3>
      ${stats.total ? html`<span class="tk-check-sum mono">${stats.done}/${stats.total} việc con</span>` : ''}
      ${!editingDesc ? html`<button type="button" class="btn btn--ghost btn--sm" data-act="edit-desc">${icon('edit')} ${t.description ? 'Sửa' : 'Thêm'}</button>` : ''}</div>`;
    if (editingDesc) {
      sec.innerHTML = String(html`${head}
        <textarea class="textarea tk-desc-input" maxlength="5000" rows="6" placeholder="Ghi chú, các bước, liên kết…&#10;- [ ] Việc con&#10;**đậm**, *nghiêng*, [liên kết](https://…)" aria-label="Mô tả">${t.description || ''}</textarea>
        <div class="tk-desc-foot"><span class="tk-hint">Markdown đơn giản · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> để lưu · <kbd>Esc</kbd> hủy</span>
          <div class="row"><button type="button" class="btn btn--ghost btn--sm" data-act="desc-cancel">Hủy</button><button type="button" class="btn btn--primary btn--sm" data-act="desc-save">Lưu</button></div></div>`);
      const ta = sec.querySelector('textarea');
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    sec.innerHTML = String(html`${head}
      ${t.description
        ? html`${stats.total ? html`<div class="tk-check-bar" aria-hidden="true"><span style="width:${(stats.done / stats.total) * 100}%"></span></div>` : ''}<div class="md">${raw(renderMarkdown(t.description))}</div>`
        : html`<button type="button" class="tk-desc-empty" data-act="edit-desc">Chưa có mô tả. Nhấn để thêm ghi chú, các bước hay liên kết…</button>`}`);
  }

  function paintTime() {
    const sec = $('[data-sec="time"]');
    const est = Number(t.estimated_minutes) || 0;
    const live = running() ? Math.floor(timer.sessionSeconds() / 60) : 0;
    const actual = (Number(t.actual_minutes) || 0) + (running() ? Math.max(0, live - runningCarried()) : 0);
    const pct = est ? Math.round((actual / est) * 100) : 0;
    const over = est && actual > est;
    const other = store.get().runningEntry && !running();
    const done = isDone() || t.status === 'cancelled';
    sec.innerHTML = String(html`
      <div class="tk-dsec__head"><h3><span class="tk-dsec__num">B</span> Thời gian</h3><a class="btn btn--ghost btn--sm" href="#/time">Nhật ký ${icon('arrowRight')}</a></div>
      <div class="tk-time">
        <div class="tk-time__fig"><span class="eyebrow">Thực tế</span><strong class="mono" data-actual>${minutes(actual)}</strong></div>
        <div class="tk-time__fig"><span class="eyebrow">Ước tính</span><strong class="mono">${est ? minutes(est) : '—'}</strong></div>
        <div class="tk-time__fig"><span class="eyebrow">Tiến độ</span><strong class="mono ${over ? 'danger-text' : ''}">${est ? `${pct}%` : '—'}</strong></div>
        <div class="tk-time__bar ${over ? 'is-over' : ''}" role="progressbar" aria-label="Thực tế so với ước tính" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, pct)}">
          <span style="width:${est ? Math.min(100, pct) : 0}%"></span>${over ? html`<i style="left:${(est / actual) * 100}%"></i>` : ''}
        </div>
        ${over ? html`<p class="tk-hint danger-text">Vượt ước tính ${minutes(actual - est)}.</p>` : ''}
      </div>
      ${!done ? html`<div class="tk-timer">
        ${running()
          ? html`<button type="button" class="btn btn--accent tk-timer__btn" data-act="pause">${icon('pause')} Tạm dừng <span class="mono" data-clock>${clock(timer.sessionSeconds())}</span></button>
                 <button type="button" class="btn btn--ghost" data-act="stop">${icon('stop')} Dừng</button>`
          : html`<button type="button" class="btn btn--primary tk-timer__btn" data-act="start">${icon('play')} ${other ? 'Chuyển bấm giờ sang việc này' : 'Bắt đầu bấm giờ'}</button>`}
      </div>` : ''}
      <div class="tk-entries">
        ${entries == null && !entriesErr ? html`<div class="skeleton sk-line" style="width:70%"></div><div class="skeleton sk-line" style="width:50%"></div>` : ''}
        ${entriesErr ? html`<p class="tk-hint danger-text">Không tải được các phiên bấm giờ.</p>` : ''}
        ${entries && !entries.length ? html`<p class="tk-hint">Chưa có phiên bấm giờ nào cho việc này.</p>` : ''}
        ${entries && entries.length ? html`<ol class="tk-entry-list">
          ${entries.slice(0, 8).map((e) => html`<li>
            <span class="tk-entry__day">${relDay(dayOf(e.started_at))}</span>
            <span class="mono tk-entry__range">${fmtTime(e.started_at)}–${e.ended_at ? fmtTime(e.ended_at) : html`<em class="tk-live">đang chạy</em>`}</span>
            ${e.source === 'manual' ? html`<span class="badge badge--plain badge--muted">thủ công</span>` : html`<span></span>`}
            <span class="mono tk-entry__dur">${e.ended_at ? minutes(Math.round((e.duration_seconds || 0) / 60)) : '…'}</span>
          </li>`)}
          ${entries.length > 8 ? html`<li class="tk-entry-more">+ ${entries.length - 8} phiên khác</li>` : ''}
        </ol>` : ''}
      </div>`);
  }

  // seconds carried from paused segments are already in actual_minutes
  function runningCarried() {
    const p = timer.pausedSession();
    return p && p.task_id === t.id ? Math.floor((p.seconds || 0) / 60) : 0;
  }

  function paintLinks() {
    $('[data-sec="links"]').innerHTML = String(html`
      <div class="tk-dsec__head"><h3><span class="tk-dsec__num">C</span> Liên quan</h3></div>
      <a class="tk-linkcard" href="#/notes?new=1">
        <span class="tk-linkcard__icon">${icon('note')}</span>
        <span><strong>Ghi chú liên quan</strong><small>Mở một ghi chú mới để ghi lại ý tưởng, biên bản cho việc này.</small></span>
        ${icon('arrowRight')}
      </a>
      <button type="button" class="tk-linkcard" data-act="copy-link">
        <span class="tk-linkcard__icon">${icon('link')}</span>
        <span><strong>Sao chép liên kết</strong><small>Liên kết trực tiếp tới công việc này.</small></span>
        ${icon('copy')}
      </button>`);
  }

  function paintMeta() {
    $('[data-sec="meta"]').innerHTML = String(html`
      <div><span class="eyebrow">Tạo lúc</span><span class="mono">${t.created_at ? dateTime(t.created_at) : '—'}</span></div>
      <div><span class="eyebrow">Cập nhật</span><span class="mono">${t.updated_at ? ago(t.updated_at) : '—'}</span></div>
      <div><span class="eyebrow">Hoàn thành</span><span class="mono">${t.completed_at ? dateTime(t.completed_at) : '—'}</span></div>`);
  }

  function paint(...secs) {
    const all = !secs.length;
    if (all || secs.includes('title')) paintTitle();
    if (all || secs.includes('props')) paintProps();
    if (all || secs.includes('desc')) paintDesc();
    if (all || secs.includes('time')) paintTime();
    if (all) paintLinks();
    if (all || secs.includes('meta')) paintMeta();
  }

  /* ---------- saving ---------- */

  let savedTimer = 0;
  function flash(text, cls = '') {
    const el = $('[data-saved]');
    if (!el) return;
    el.className = `tk-drawer__saved is-visible ${cls}`;
    el.textContent = text;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove('is-visible'), 1600);
  }

  async function patch(p, { sections = ['props', 'time', 'meta'] } = {}) {
    if (t.id.startsWith('tmp-')) return;
    const prev = t;
    t = { ...t, ...p };
    if (p.category_id !== undefined) t.category = null;
    onSaved?.(t);
    paint(...sections);
    flash('Đang lưu…');
    try {
      const saved = 'status' in p && Object.keys(p).length === 1 ? await setTaskStatus(t.id, p.status) : await updateTask(t.id, p);
      if (closed) { onSaved?.(saved, { prev, serverConfirmed: true }); return; }
      t = saved;
      onSaved?.(t, { prev, serverConfirmed: true });
      paint(...sections);
      flash('Đã lưu');
    } catch (err) {
      t = prev;
      onSaved?.(t);
      if (!closed) { paint(...sections); flash('Chưa lưu', 'is-error'); }
      toast.error(err);
    }
  }

  async function loadEntries() {
    try {
      entries = await listEntriesForTask(t.id);
      entriesErr = null;
    } catch (err) {
      entriesErr = err;
    }
    if (!closed) paintTime();
  }

  async function refreshTask() {
    try {
      const fresh = await getTask(t.id);
      if (fresh && !closed) { t = fresh; onSaved?.(t, { serverConfirmed: true }); paint('time', 'meta'); }
    } catch { /* ignore */ }
  }

  /* ---------- events ---------- */

  function onClick(e) {
    const el = e.target.closest('[data-close], [data-act], [data-status], [data-prio], [data-due], [data-est], [data-md-line]');
    if (!el || !root.contains(el)) return;
    if (el.hasAttribute('data-close')) return close();
    if (el.dataset.status) { if (el.dataset.status !== t.status) patch({ status: el.dataset.status }, { sections: ['title', 'props', 'time', 'meta'] }); return; }
    if (el.dataset.prio) { if (el.dataset.prio !== t.priority) patch({ priority: el.dataset.prio }, { sections: ['title', 'props'] }); return; }
    if (el.dataset.due !== undefined && el.hasAttribute('data-due')) { const v = el.dataset.due || null; if (v !== t.due_date) patch({ due_date: v }); return; }
    if (el.dataset.est) { const v = Number(el.dataset.est); patch({ estimated_minutes: t.estimated_minutes === v ? null : v }); return; }
    if (el.dataset.mdLine != null) return toggleChecklist(Number(el.dataset.mdLine));
    const act = el.dataset.act;
    if (act === 'toggle') {
      const next = isDone() ? 'todo' : 'completed';
      el.setAttribute('aria-checked', String(next === 'completed'));
      patch({ status: next }, { sections: ['title', 'props', 'time', 'meta'] });
    }
    if (act === 'edit-desc') { editingDesc = true; paintDesc(); }
    if (act === 'desc-cancel') { editingDesc = false; paintDesc(); }
    if (act === 'desc-save') saveDesc();
    if (act === 'start') startTimer();
    if (act === 'pause') timerAction(() => timer.pause());
    if (act === 'stop') timerAction(() => timer.stop());
    if (act === 'copy-link') copyLink();
    if (act === 'more') moreMenu(el);
  }

  function saveDesc() {
    const ta = $('.tk-desc-input');
    if (!ta) return;
    const v = ta.value.trim();
    editingDesc = false;
    if ((v || null) !== (t.description || null)) patch({ description: v || null }, { sections: ['desc', 'meta'] });
    else paintDesc();
  }

  function toggleChecklist(lineNo) {
    const lines = String(t.description || '').replace(/\r\n?/g, '\n').split('\n');
    const line = lines[lineNo];
    if (line == null) return;
    lines[lineNo] = line.replace(/\[( |x|X)\]/, (m, c) => (c === ' ' ? '[x]' : '[ ]'));
    patch({ description: lines.join('\n') }, { sections: ['desc', 'meta'] });
  }

  async function startTimer() {
    await timerAction(() => timer.start({ taskId: t.id }));
    if (t.status === 'todo') patch({ status: 'in_progress' }, { sections: ['title', 'props', 'time', 'meta'] });
  }

  async function timerAction(fn) {
    try {
      await fn();
      paintTime();
      loadEntries();
      refreshTask();
    } catch (err) {
      toast.error(err);
    }
  }

  async function copyLink() {
    const url = `${location.origin}${location.pathname}#/tasks?id=${t.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Đã sao chép liên kết.');
    } catch {
      toast.info(url, { duration: 8000 });
    }
  }

  function moreMenu(anchor) {
    popMenu(anchor, [
      { label: 'Mở biểu mẫu đầy đủ', icon: 'edit', onClick: () => openTaskForm({ task: t, onSaved: (s) => { t = s; onSaved?.(s, { serverConfirmed: true }); if (!closed) paint(); }, onDeleted: () => { onDeleted?.(t, { alreadyDeleted: true }); close(); } }) },
      { label: 'Sao chép liên kết', icon: 'link', onClick: copyLink },
      'sep',
      { label: 'Xóa công việc', icon: 'trash', danger: true, onClick: () => { const victim = t; close(); onDeleted?.(victim); } },
    ]);
  }

  function onChange(e) {
    const f = e.target.dataset.field;
    if (f) {
      let v = e.target.value;
      if (f === 'estimated_minutes') {
        if (v === '') v = null;
        else { v = Math.round(Number(v)); if (!Number.isFinite(v) || v < 0) { toast.error('Nhập số phút ≥ 0.'); paintProps(); return; } }
      } else v = v || null;
      if (v !== (t[f] ?? null)) patch({ [f]: v });
      return;
    }
    if (e.target.name === 'tags') return;
  }

  // tag-input writes a hidden field without events → observe it
  const tagObserver = new MutationObserver(() => {
    const hidden = root.querySelector('input[type=hidden][name="tags"]');
    if (!hidden) return;
    let tags;
    try { tags = JSON.parse(hidden.value || '[]'); } catch { return; }
    if (JSON.stringify(tags) !== JSON.stringify(t.tags || [])) patchTagsSoon(tags);
  });
  tagObserver.observe($('[data-sec="props"]'), { subtree: true, childList: true });
  let tagTimer = 0;
  function patchTagsSoon(tags) {
    clearTimeout(tagTimer);
    tagTimer = setTimeout(() => {
      // keep the input focused: only refresh meta, the tag input is already up to date
      if (JSON.stringify(tags) !== JSON.stringify(t.tags || [])) patch({ tags }, { sections: ['meta'] });
    }, 350);
  }

  function onTitleKey(e) {
    if (e.target.id !== 'tkd-title') return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.stopPropagation(); e.target.value = t.title; e.target.blur(); }
  }
  function onFocusOut(e) {
    if (e.target.id === 'tkd-title') {
      const v = e.target.value.replace(/\s+/g, ' ').trim();
      if (!v) { e.target.value = t.title; toast.error('Tiêu đề không được để trống.'); return; }
      if (v !== t.title) patch({ title: v }, { sections: ['meta'] });
    }
  }
  function onInput(e) {
    if (e.target.tagName === 'TEXTAREA') autosize(e.target);
  }
  function onDescKey(e) {
    if (!e.target.classList.contains('tk-desc-input')) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDesc(); }
    if (e.key === 'Escape') { e.stopPropagation(); editingDesc = false; paintDesc(); }
  }

  function onDocKey(e) {
    if (e.key === 'Escape') {
      if (document.querySelector('.menu') || document.querySelector('dialog[open]')) return;
      if (e.target.closest?.('.tk-desc-input, #tkd-title')) return;
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab' && !document.querySelector('dialog[open]')) {
      const f = [...panel.querySelectorAll('button:not([disabled]), [href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', onTitleKey);
  root.addEventListener('keydown', onDescKey);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('input', onInput);
  document.addEventListener('keydown', onDocKey);
  unsubs.push(() => document.removeEventListener('keydown', onDocKey));
  unsubs.push(store.subscribe((_, p) => {
    if ('runningEntry' in p && !closed) { paintTime(); if (!store.get().runningEntry) { loadEntries(); refreshTask(); } }
  }));
  unsubs.push(timer.onTick(() => {
    if (!running() || closed) return;
    const c = root.querySelector('[data-clock]');
    if (c) c.textContent = clock(timer.sessionSeconds());
  }));

  /* ---------- swipe down to close (bottom sheet) ---------- */
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('[data-grab]') || e.target.closest('button') || window.innerWidth > 640) return;
    drag = { y: e.clientY, dy: 0, id: e.pointerId };
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('is-dragging');
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.y);
    panel.style.transform = `translateY(${drag.dy}px)`;
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    panel.classList.remove('is-dragging');
    const far = drag.dy > Math.min(160, panel.offsetHeight * 0.25);
    panel.style.transform = '';
    drag = null;
    if (far) close();
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);

  /* ---------- lifecycle ---------- */

  function close({ silent = false } = {}) {
    if (closed) return;
    closed = true;
    closeMenu();
    // flush a pending title edit
    const ta = root.querySelector('#tkd-title');
    if (ta && document.activeElement === ta) ta.blur();
    const desc = root.querySelector('.tk-desc-input');
    if (desc && desc.value.trim() !== (t.description || '')) {
      const v = desc.value.trim() || null;
      updateTask(t.id, { description: v }).then((s) => onSaved?.(s, { serverConfirmed: true })).catch((err) => toast.error(err));
    }
    clearTimeout(tagTimer);
    tagObserver.disconnect();
    unsubs.forEach((u) => u());
    document.documentElement.classList.remove('tk-drawer-lock');
    root.classList.remove('is-open');
    root.classList.add('is-closing');
    const remove = () => root.remove();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) remove(); else setTimeout(remove, 260);
    if (current === api) current = null;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus?.({ preventScroll: true });
    if (!silent) onClose?.();
    else onClose?.({ replaced: true });
  }

  const api = {
    el: root,
    close,
    taskId: () => t.id,
    update(next) {
      if (closed || !next || next.id !== t.id) return;
      t = { ...next };
      paint('title', 'props', 'time', 'meta');
      if (!editingDesc) paintDesc();
    },
  };
  current = api;

  paint();
  loadEntries();
  setTimeout(() => {
    if (focus === 'title') { const ta = root.querySelector('#tkd-title'); ta?.focus(); ta?.select(); }
    else panel.focus({ preventScroll: true });
  }, 30);
  return api;
}

function autosize(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

