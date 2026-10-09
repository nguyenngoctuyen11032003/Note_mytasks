// § 04 Thời gian — focus timer (stopwatch + Pomodoro), focus mode, manual
// entries, week timeline and time analytics. All timer state transitions go
// through components/timer.js so the topbar chip and other pages stay in sync.
import { html, mount, on, raw, fragment } from '../utils/dom.js';
import { icon } from '../components/icons.js';
import { pageHead, sheetHead, popMenu, prio, PRIORITY_RANK } from '../components/ui.js';
import { emptyState, errorState, loadingRows, loadingBlock, statTileSkeleton } from '../components/states.js';
import { openModal, field, input, select, confirmDialog } from '../components/modal.js';
import { makeChart, palette } from '../components/chart.js';
import { toast } from '../components/toast.js';
import * as timer from '../components/timer.js';
import * as store from '../core/store.js';
import { categoryById } from '../core/store.js';
import { setQuery } from '../core/router.js';
import { onDataChanged } from '../core/events.js';
import { listTasks } from '../services/tasks.js';
import { listEntries, entrySeconds, logTime, updateEntry, deleteEntry } from '../services/timer.js';
import {
  today, addDays, addMonths, startOfWeek, startOfMonth, endOfMonth, daysBetween, dayOf, dayStartInstant,
  toLocalInput, fromLocalInput, weekdayLabels,
} from '../utils/date.js';
import { clock, minutes, hours, day, time, relDay, dec, monthLabel, num } from '../utils/format.js';

const OPEN = ['todo', 'in_progress'];
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
const fc = timer.formatCountdown;

export default async function timePage(root, { query }) {
  let period = query.period === 'month' ? 'month' : 'week';
  let offset = Math.min(0, Math.trunc(Number(query.offset) || 0));
  let tasks = [];
  let entries = [];      // selected period
  let weekEntries = [];  // this week (stats)
  let charts = [];
  let pickTaskId = query.task || '';
  let pickDesc = '';
  let lastKey = '';
  let focusEl = null;
  let focusOff = [];
  let wakeLock = null;
  let reloadTimer = null;
  const disposers = [];

  mount(root, html`
    ${pageHead({
      num: '04',
      kicker: 'Thời gian',
      title: 'Đo đếm từng <em>khoảnh khắc</em>',
      lede: 'Bấm giờ hoặc làm theo nhịp Pomodoro. Mỗi phiên được cộng dồn vào công việc — dữ liệu thật để lập kế hoạch sát hơn.',
      actions: html`
        <button class="btn" data-act="focus">${icon('expand')} Chế độ tập trung</button>
        <button class="btn" data-act="manual">${icon('edit')} Ghi giờ thủ công</button>`,
    })}
    <section class="sheet sheet--ticked tm-hero" data-hero>${loadingBlock(320)}</section>
    <section class="tm-stats" data-stats>${statTileSkeleton(4)}</section>

    <div class="tm-period">
      <h2 class="section-title tm-period__title"><span class="eyebrow">§ 04.2</span>Nhật ký <em>thời gian</em></h2>
      <div class="tm-period__ctrl">
        <div class="segmented" role="group" aria-label="Kỳ xem">
          <button type="button" data-period="week" aria-pressed="${period === 'week'}">Tuần</button>
          <button type="button" data-period="month" aria-pressed="${period === 'month'}">Tháng</button>
        </div>
        <div class="tm-period__nav">
          <button class="icon-btn" data-shift="-1" aria-label="Kỳ trước">${icon('chevronLeft')}</button>
          <span class="tm-period__label num" data-plabel></span>
          <button class="icon-btn" data-shift="1" aria-label="Kỳ sau">${icon('chevronRight')}</button>
        </div>
        <button class="btn btn--sm btn--ghost" data-act="now" hidden>Về hiện tại</button>
      </div>
    </div>

    <section class="grid grid-12 tm-grid">
      <article class="sheet span-12 tm-tl-card" data-tl>${sheetHead('T.2', 'Dòng thời gian tuần')}<div class="sheet__body">${loadingBlock(200)}</div></article>
      <article class="sheet span-8" data-daily>${sheetHead('T.3', 'Giờ theo ngày')}<div class="sheet__body">${loadingBlock(220)}</div></article>
      <article class="sheet span-4" data-cats>${sheetHead('T.4', 'Theo danh mục')}<div class="sheet__body">${loadingBlock(220)}</div></article>
      <article class="sheet span-7" data-log>${sheetHead('T.5', 'Các phiên')}${loadingRows(6)}</article>
      <article class="sheet span-5" data-est>${sheetHead('T.6', 'Ước tính & thực tế')}<div class="sheet__body">${loadingBlock(220)}</div></article>
    </section>`);

  const $ = (s) => root.querySelector(s);
  const taskById = (id) => tasks.find((t) => t.id === id) || null;
  const openTasks = () => tasks
    .filter((t) => OPEN.includes(t.status))
    .sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1)
      || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      || String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')));

  /* ================================================================ */
  /* View model                                                        */
  /* ================================================================ */
  function view() {
    const run = store.get().runningEntry;
    const paused = run ? null : timer.pausedSession();
    const pm = timer.pomodoro();
    let state = run ? 'running' : paused ? 'paused' : 'idle';
    if (pm.enabled && pm.phase === 'break') state = 'break';
    else if (pm.enabled && pm.phase === 'ready' && !run) state = 'ready';
    const secs = timer.sessionSeconds();
    let digits, arc, phase, sub, tone, handSecs = secs;
    if (state === 'break') {
      digits = fc(pm.remaining);
      arc = pm.total ? pm.remaining / pm.total : 0;
      phase = pm.breakKind === 'long' ? 'Nghỉ dài' : 'Nghỉ ngắn';
      tone = 'break';
      handSecs = pm.elapsed;
      sub = `Xong phiên ${pm.cycle} · đứng dậy, uống nước`;
    } else if (pm.enabled) {
      const focusing = state === 'running' || state === 'paused';
      digits = fc(focusing ? pm.remaining : pm.cfg.focus * 60);
      arc = focusing && pm.total ? pm.elapsed / pm.total : 0;
      phase = { running: 'Tập trung', paused: 'Tạm dừng', ready: 'Sẵn sàng phiên mới', idle: 'Pomodoro' }[state];
      tone = 'focus';
      sub = focusing || state === 'ready' ? `Tổng phiên ${clock(secs)}` : `${pm.cfg.focus} phút tập trung · ${pm.cfg.short} phút nghỉ`;
    } else {
      digits = clock(secs);
      arc = (secs % 3600) / 3600;
      phase = { running: 'Đang chạy', paused: 'Tạm dừng', idle: 'Sẵn sàng' }[state];
      tone = 'watch';
      sub = run ? `Bắt đầu lúc ${time(run.started_at)}` : state === 'paused' ? 'Phiên đang tạm dừng' : 'Mỗi vòng cung = 1 giờ';
    }
    return { state, mode: pm.enabled ? 'pomodoro' : 'stopwatch', digits, arc, phase, sub, tone, hand: (handSecs % 60) * 6, pm, run, paused };
  }

  /* ================================================================ */
  /* Dial                                                              */
  /* ================================================================ */
  function dial() {
    let ticks = '', nums = '';
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2, major = i % 5 === 0;
      const r1 = major ? 133 : 141, r2 = 150;
      const sx = (r) => (160 + Math.sin(a) * r).toFixed(2), sy = (r) => (160 - Math.cos(a) * r).toFixed(2);
      ticks += `<line class="${major ? 'is-major' : ''}" x1="${sx(r1)}" y1="${sy(r1)}" x2="${sx(r2)}" y2="${sy(r2)}"/>`;
      if (major) nums += `<text x="${sx(122)}" y="${sy(122)}">${String(i).padStart(2, '0')}</text>`;
    }
    return html`
      <div class="tm-dial" data-dial data-tone="watch">
        <svg viewBox="0 0 320 320" aria-hidden="true" focusable="false">
          <circle class="tm-dial__rim" cx="160" cy="160" r="157"/>
          <circle class="tm-dial__rim tm-dial__rim--in" cx="160" cy="160" r="98"/>
          <path class="tm-dial__cross" d="M160 0v14M160 306v14M0 160h14M306 160h14"/>
          <g class="tm-dial__ticks">${raw(ticks)}</g>
          <g class="tm-dial__nums">${raw(nums)}</g>
          <circle class="tm-dial__track" cx="160" cy="160" r="108"/>
          <circle class="tm-dial__arc" data-arc cx="160" cy="160" r="108" pathLength="1000" stroke-dasharray="0 1000" transform="rotate(-90 160 160)"/>
          <g data-hand transform="rotate(0 160 160)"><line class="tm-dial__hand" x1="160" y1="8" x2="160" y2="34"/><circle class="tm-dial__bead" cx="160" cy="21" r="3"/></g>
        </svg>
        <div class="tm-dial__face">
          <span class="tm-dial__phase" data-phase></span>
          <span class="tm-dial__digits" data-digits role="timer" aria-live="off"></span>
          <span class="tm-dial__sub" data-sub></span>
        </div>
      </div>`;
  }

  function paint(v) {
    const scopes = [root, focusEl].filter(Boolean);
    for (const s of scopes) {
      s.querySelectorAll('[data-dial]').forEach((d) => {
        d.dataset.tone = v.tone;
        d.dataset.state = v.state;
        d.querySelector('[data-arc]').setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, v.arc)) * 1000} 1000`);
        d.querySelector('[data-hand]').setAttribute('transform', `rotate(${v.hand} 160 160)`);
        d.querySelector('[data-digits]').textContent = v.digits;
        d.querySelector('[data-phase]').textContent = v.phase;
        d.querySelector('[data-sub]').textContent = v.sub;
      });
    }
  }

  /* ================================================================ */
  /* Hero                                                              */
  /* ================================================================ */
  function stateBadge(v) {
    const map = {
      running: ['accent', v.mode === 'pomodoro' ? 'Đang tập trung' : 'Đang chạy'],
      paused: ['warning', 'Tạm dừng'],
      break: ['success', 'Giờ nghỉ'],
      ready: ['info', 'Chờ phiên mới'],
      idle: ['muted', 'Sẵn sàng'],
    };
    const [b, l] = map[v.state];
    return html`<span class="badge badge--${b}">${l}</span>`;
  }

  function currentLabel(v) {
    const id = v.run ? v.run.task_id : v.paused?.task_id;
    const t = id ? taskById(id) : null;
    const title = (v.run ? v.run.task?.title : null) || t?.title || v.paused?.title || '';
    const desc = v.run ? v.run.description : v.paused?.description;
    return { title: title || desc || 'Phiên không gắn công việc', desc: title && desc ? desc : '', task: t || v.run?.task || null };
  }

  function controls(v, { big = false } = {}) {
    const lg = big ? 'btn--lg tm-btn-xl' : 'btn--lg';
    const pomo = v.mode === 'pomodoro';
    if (v.state === 'idle') {
      return html`<button class="btn ${lg} btn--primary tm-start" data-act="start">${icon('play')} ${pomo ? `Bắt đầu tập trung · ${v.pm.cfg.focus} phút` : 'Bắt đầu'}</button>`;
    }
    if (v.state === 'running') {
      return html`
        <button class="btn ${lg}" data-act="pause">${icon('pause')} Tạm dừng</button>
        <button class="btn ${lg} btn--accent" data-act="stop">${icon('stop')} Dừng & lưu</button>
        ${pomo ? html`<button class="btn ${lg} btn--ghost" data-act="skip" title="Kết thúc phiên tập trung này và chuyển sang nghỉ">${icon('skip')} Nghỉ ngay</button>` : ''}`;
    }
    if (v.state === 'paused') {
      return html`
        <button class="btn ${lg} btn--primary" data-act="resume">${icon('play')} Tiếp tục</button>
        <button class="btn ${lg}" data-act="stop">${icon('stop')} Kết thúc phiên</button>`;
    }
    if (v.state === 'break') {
      return html`
        <button class="btn ${lg} btn--primary" data-act="next-focus">${icon('skip')} Bỏ qua giờ nghỉ</button>
        <button class="btn ${lg}" data-act="stop">${icon('stop')} Kết thúc phiên</button>`;
    }
    return html`
      <button class="btn ${lg} btn--primary" data-act="next-focus">${icon('play')} Tập trung tiếp · ${v.pm.cfg.focus} phút</button>
      <button class="btn ${lg}" data-act="stop">${icon('stop')} Kết thúc phiên</button>`;
  }

  function cycleRow(v) {
    if (v.mode !== 'pomodoro') return '';
    const every = v.pm.every;
    let filled = v.pm.cycle % every;
    if (v.pm.cycle && filled === 0 && (v.state === 'break' || v.state === 'ready')) filled = every;
    return html`
      <div class="tm-cycle" aria-label="Chu kỳ Pomodoro: ${filled}/${every}">
        <span class="tm-cycle__dots">${Array.from({ length: every }, (_, i) => html`<i class="${i < filled ? 'is-on' : ''}"></i>`)}</span>
        <span class="tm-cycle__txt"><strong class="num">${filled}/${every}</strong> trước nghỉ dài · hôm nay <strong class="num">${v.pm.todayCount}</strong> pomodoro</span>
      </div>`;
  }

  function renderHero(v) {
    const el = $('[data-hero]');
    el.dataset.state = v.state;
    el.dataset.mode = v.mode;
    const cur = currentLabel(v);
    const picked = taskById(pickTaskId);
    mount(el, html`
      <div class="tm-hero__dial">${dial()}</div>
      <div class="tm-hero__panel">
        <div class="tm-hero__top">
          <span class="sheet__num">T.1</span>
          <div class="segmented" role="group" aria-label="Chế độ đồng hồ">
            <button type="button" data-mode="stopwatch" aria-pressed="${v.mode === 'stopwatch'}">${icon('timer')} Bấm giờ</button>
            <button type="button" data-mode="pomodoro" aria-pressed="${v.mode === 'pomodoro'}">${icon('hourglass')} Pomodoro</button>
          </div>
          <span class="grow"></span>
          ${v.mode === 'pomodoro' ? html`<button class="icon-btn tm-touch" data-act="pomo-settings" aria-label="Cài đặt Pomodoro" title="Cài đặt Pomodoro">${icon('settings')}</button>` : ''}
          <button class="icon-btn tm-touch" data-act="focus" aria-label="Chế độ tập trung" title="Chế độ tập trung">${icon('expand')}</button>
        </div>

        <div class="tm-hero__state">${stateBadge(v)}${v.run ? html`<span class="faint num">từ ${time(v.run.started_at)}</span>` : ''}</div>

        ${v.state === 'idle'
          ? html`
            <div class="tm-hero__form">
              <label class="field__label" for="tm-pick-input">Công việc</label>
              ${picker(picked)}
              <label class="field__label" for="tm-desc">Ghi chú phiên <span class="opt">không bắt buộc</span></label>
              <input id="tm-desc" class="input" data-desc maxlength="500" value="${pickDesc}" placeholder="Bạn sẽ làm gì trong phiên này?" autocomplete="off" />
            </div>`
          : html`
            <div class="tm-hero__task">
              <span class="eyebrow">${v.state === 'break' ? 'Vừa tập trung cho' : 'Đang tính cho'}</span>
              <strong>${cur.title}</strong>
              ${cur.desc ? html`<span class="muted">${cur.desc}</span>` : ''}
              ${cur.task ? html`<span class="tm-hero__taskmeta">${cur.task.priority ? prio(cur.task.priority) : ''}${taskTotals(cur.task)}</span>` : ''}
            </div>`}

        <div class="tm-hero__ctrl">${controls(v)}</div>
        ${cycleRow(v)}
        <p class="tm-hero__kbd faint">Phím tắt: <kbd>Space</kbd> bắt đầu / tạm dừng · <kbd>F</kbd> tập trung</p>
      </div>`);
    bindPicker(el);
  }

  function taskTotals(t) {
    const full = taskById(t.id) || t;
    if (full.actual_minutes == null && !full.estimated_minutes) return '';
    return html`<span class="num faint">${minutes(full.actual_minutes || 0)}${full.estimated_minutes ? ` / ${minutes(full.estimated_minutes)} ước tính` : ''}</span>`;
  }

  function refresh() {
    const v = view();
    const key = `${v.state}|${v.mode}|${v.pm.cycle}|${v.pm.todayCount}|${v.run?.id || ''}`;
    if (key !== lastKey) {
      lastKey = key;
      renderHero(v);
      renderFocus(v);
    }
    paint(v);
  }

  /* ================================================================ */
  /* Searchable task picker (combobox)                                 */
  /* ================================================================ */
  function picker(picked) {
    return html`
      <div class="tm-pick" data-pick>
        <div class="input-group">
          ${icon('search')}
          <input id="tm-pick-input" class="input" data-pick-input role="combobox" aria-expanded="false" aria-controls="tm-pick-list" aria-autocomplete="list"
            autocomplete="off" placeholder="Tìm công việc đang mở…" value="${picked?.title || ''}" />
          <button type="button" class="tm-pick__clear" data-pick-clear aria-label="Bỏ chọn công việc" ${picked ? '' : raw('hidden')}>${icon('x')}</button>
        </div>
        <ul class="tm-pick__list" id="tm-pick-list" role="listbox" hidden></ul>
      </div>`;
  }

  function bindPicker(scope) {
    const box = scope.querySelector('[data-pick]');
    if (!box) return;
    const inp = box.querySelector('[data-pick-input]');
    const list = box.querySelector('.tm-pick__list');
    const clear = box.querySelector('[data-pick-clear]');
    let items = [];
    let active = -1;

    const options = (q) => {
      const f = fold(q.trim());
      const all = openTasks();
      const matched = f ? all.filter((t) => fold(t.title).includes(f) || (t.tags || []).some((g) => fold(g).includes(f))) : all;
      return [{ id: '', title: 'Không gắn công việc' }, ...matched.slice(0, 40)];
    };
    const draw = () => {
      const pickedTitle = taskById(pickTaskId)?.title || '';
      items = options(inp.value === pickedTitle ? '' : inp.value);
      list.innerHTML = String(html`${items.length === 1 && inp.value.trim()
        ? html`<li class="tm-pick__empty">Không có công việc mở nào khớp “${inp.value.trim()}”.</li>`
        : ''}${items.map((t, i) => html`
          <li role="option" id="tm-opt-${i}" data-i="${i}" aria-selected="${i === active}" class="${t.id === pickTaskId ? 'is-picked' : ''}">
            ${t.id
              ? html`<span class="tm-pick__title truncate">${t.title}</span>
                     <span class="tm-pick__meta">${t.status === 'in_progress' ? html`<span class="badge badge--info">Đang làm</span>` : ''}${prio(t.priority)}${t.due_date ? html`<span class="num faint">${relDay(t.due_date)}</span>` : ''}</span>`
              : html`<span class="tm-pick__title muted">— ${t.title} —</span>`}
          </li>`)}`);
      list.hidden = false;
      inp.setAttribute('aria-expanded', 'true');
      if (active >= 0) {
        inp.setAttribute('aria-activedescendant', `tm-opt-${active}`);
        list.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
      } else inp.removeAttribute('aria-activedescendant');
    };
    const close = () => {
      list.hidden = true;
      inp.setAttribute('aria-expanded', 'false');
      active = -1;
      inp.value = taskById(pickTaskId)?.title || '';
      clear.hidden = !pickTaskId;
    };
    const choose = (i) => {
      const t = items[i];
      if (!t) return;
      pickTaskId = t.id;
      setQuery({ task: t.id || null });
      close();
    };
    inp.addEventListener('focus', () => { active = -1; draw(); inp.select(); });
    inp.addEventListener('input', () => { active = -1; draw(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (list.hidden) draw(); active = Math.min(items.length - 1, active + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
      else if (e.key === 'Enter') { if (!list.hidden && active >= 0) { e.preventDefault(); choose(active); } else if (!list.hidden && items.length === 2 && inp.value.trim()) { e.preventDefault(); choose(1); } }
      else if (e.key === 'Escape') { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
    });
    inp.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) close(); }, 120));
    list.addEventListener('mousedown', (e) => e.preventDefault());
    list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) choose(Number(li.dataset.i)); });
    clear.addEventListener('click', () => { pickTaskId = ''; setQuery({ task: null }); close(); inp.focus(); });
  }

  /* ================================================================ */
  /* Focus mode (fullscreen, distraction-free)                         */
  /* ================================================================ */
  function openFocus() {
    if (focusEl) return;
    timer.unlockAudio();
    focusEl = fragment(html`
      <div class="tm-focus" role="dialog" aria-modal="true" aria-label="Chế độ tập trung" tabindex="-1">
        <header class="tm-focus__top">
          <span class="eyebrow">§ Chế độ tập trung</span>
          <span data-focus-badge></span>
          <span class="grow"></span>
          <span class="tm-focus__hint">Esc để thoát · Space tạm dừng</span>
          <button class="icon-btn tm-touch" data-act="focus-exit" aria-label="Thoát chế độ tập trung">${icon('x')}</button>
        </header>
        <div class="tm-focus__stage">
          ${dial()}
          <div class="tm-focus__task" data-focus-task></div>
          <div class="tm-focus__ctrl" data-focus-ctrl></div>
          <div data-focus-cycle></div>
        </div>
      </div>`);
    document.body.append(focusEl);
    document.documentElement.classList.add('tm-noscroll');
    focusOff = [
      on(focusEl, 'click', '[data-act]', (e, el) => handleAct(el)),
    ];
    const onFs = () => { if (!document.fullscreenElement && focusEl?.dataset.fs === '1') closeFocus(); };
    document.addEventListener('fullscreenchange', onFs);
    focusOff.push(() => document.removeEventListener('fullscreenchange', onFs));
    const onVis = () => { if (document.visibilityState === 'visible' && focusEl) acquireWake(); };
    document.addEventListener('visibilitychange', onVis);
    focusOff.push(() => document.removeEventListener('visibilitychange', onVis));
    try {
      // Fullscreen the whole document (not the overlay) so toasts stay visible.
      const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      p?.then(() => { if (focusEl) focusEl.dataset.fs = '1'; }).catch(() => {});
    } catch {}
    acquireWake();
    lastKey = '';
    refresh();
    focusEl.focus();
  }

  function acquireWake() {
    try {
      navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
    } catch {}
  }

  function closeFocus() {
    if (!focusEl) return;
    const el = focusEl;
    focusEl = null;
    focusOff.splice(0).forEach((d) => d());
    try { if (document.fullscreenElement) document.exitFullscreen?.(); } catch {}
    try { wakeLock?.release(); } catch {}
    wakeLock = null;
    el.remove();
    document.documentElement.classList.remove('tm-noscroll');
    root.querySelector('[data-act="focus"]')?.focus();
  }

  function renderFocus(v) {
    if (!focusEl) return;
    const cur = currentLabel(v);
    const picked = taskById(pickTaskId);
    mount(focusEl.querySelector('[data-focus-badge]'), stateBadge(v));
    mount(focusEl.querySelector('[data-focus-task]'), v.state === 'idle'
      ? html`<span class="eyebrow">Sắp làm</span><strong>${picked?.title || pickDesc || 'Phiên không gắn công việc'}</strong>`
      : html`<span class="eyebrow">${v.state === 'break' ? 'Thư giãn một chút' : 'Đang tập trung vào'}</span><strong>${cur.title}</strong>${cur.desc ? html`<span class="muted">${cur.desc}</span>` : ''}`);
    mount(focusEl.querySelector('[data-focus-ctrl]'), controls(v, { big: true }));
    mount(focusEl.querySelector('[data-focus-cycle]'), cycleRow(v));
  }

  /* ================================================================ */
  /* Pomodoro settings                                                  */
  /* ================================================================ */
  function openPomoSettings() {
    const c = timer.pomodoroConfig();
    const perm = timer.notifyPermission();
    openModal({
      eyebrow: 'Pomodoro',
      title: 'Nhịp làm việc của bạn',
      size: 'narrow',
      body: html`<div class="form">
        <div class="form-row">
          ${field({ label: 'Tập trung (phút)', name: 'focus', control: input('focus', c.focus, 'type="number" min="1" max="180" inputmode="numeric" required') })}
          ${field({ label: 'Nghỉ ngắn (phút)', name: 'short', control: input('short', c.short, 'type="number" min="1" max="60" inputmode="numeric" required') })}
        </div>
        <div class="form-row">
          ${field({ label: 'Nghỉ dài (phút)', name: 'long', control: input('long', c.long, 'type="number" min="1" max="90" inputmode="numeric" required') })}
          ${field({ label: 'Nghỉ dài sau mỗi', name: 'every', hint: 'phiên tập trung', control: input('every', c.every, 'type="number" min="2" max="12" inputmode="numeric" required') })}
        </div>
        <div class="tm-presets">
          <span class="eyebrow">Mẫu nhanh</span>
          <button type="button" class="btn btn--sm" data-preset="25,5,15,4">25 / 5</button>
          <button type="button" class="btn btn--sm" data-preset="50,10,20,3">50 / 10</button>
          <button type="button" class="btn btn--sm" data-preset="90,15,30,2">90 / 15</button>
        </div>
        <label class="check"><input type="checkbox" name="autoFocus" ${c.autoFocus ? raw('checked') : ''} /> Tự bắt đầu phiên tập trung khi hết giờ nghỉ</label>
        <div class="row between" style="flex-wrap:wrap">
          <label class="check"><input type="checkbox" name="sound" ${c.sound ? raw('checked') : ''} /> Chuông báo nhẹ</label>
          <button type="button" class="btn btn--sm btn--ghost" data-chime>${icon('bell')} Nghe thử</button>
        </div>
        <div class="row between" style="flex-wrap:wrap">
          <label class="check"><input type="checkbox" name="notify" ${c.notify ? raw('checked') : ''} /> Thông báo của trình duyệt</label>
          ${perm === 'granted'
            ? html`<span class="badge badge--success">Đã cho phép</span>`
            : perm === 'denied'
              ? html`<span class="badge badge--muted" title="Mở cài đặt trang web của trình duyệt để bật lại">Đã bị chặn</span>`
              : perm === 'unsupported'
                ? html`<span class="badge badge--muted">Không hỗ trợ</span>`
                : html`<button type="button" class="btn btn--sm" data-perm>Cho phép thông báo</button>`}
        </div>
      </div>`,
      submitLabel: 'Lưu nhịp',
      onOpen(el) {
        el.addEventListener('click', async (e) => {
          const pre = e.target.closest('[data-preset]');
          if (pre) {
            const [f, s, l, n] = pre.dataset.preset.split(',');
            Object.entries({ focus: f, short: s, long: l, every: n }).forEach(([k, val]) => { el.querySelector(`[name=${k}]`).value = val; });
          }
          if (e.target.closest('[data-chime]')) timer.chime('focus', { force: true });
          const pb = e.target.closest('[data-perm]');
          if (pb) {
            const r = await timer.requestNotifyPermission();
            pb.replaceWith(fragment(r === 'granted' ? html`<span class="badge badge--success">Đã cho phép</span>` : html`<span class="badge badge--muted">Chưa cho phép</span>`));
          }
        });
      },
      validate(v) {
        const e = {};
        if (!(Number(v.focus) >= 1 && Number(v.focus) <= 180)) e.focus = '1–180 phút.';
        if (!(Number(v.short) >= 1 && Number(v.short) <= 60)) e.short = '1–60 phút.';
        if (!(Number(v.long) >= 1 && Number(v.long) <= 90)) e.long = '1–90 phút.';
        if (!(Number(v.every) >= 2 && Number(v.every) <= 12)) e.every = '2–12 phiên.';
        return e;
      },
      onSubmit(v) {
        timer.setPomodoroConfig({ focus: v.focus, short: v.short, long: v.long, every: v.every, autoFocus: v.autoFocus, sound: v.sound, notify: v.notify });
        lastKey = '';
        refresh();
        toast('Đã lưu nhịp Pomodoro.');
      },
    });
  }

  /* ================================================================ */
  /* Stats                                                              */
  /* ================================================================ */
  function renderStats() {
    const t0 = today(), ws = startOfWeek(t0);
    const sumDay = (list, pred) => list.reduce((s, e) => s + pieces(e).filter((p) => pred(p.day)).reduce((a, p) => a + (p.e - p.s) / 1000, 0), 0);
    const todaySecs = sumDay(weekEntries, (d) => d === t0);
    const weekSecs = sumDay(weekEntries, (d) => d >= ws && d <= t0);
    const elapsedDays = daysBetween(ws, t0).length;
    const pm = timer.pomodoro();
    const est = tasks.filter((t) => t.status === 'completed' && t.estimated_minutes > 0 && t.actual_minutes > 0);
    const acc = est.length ? est.reduce((s, t) => s + t.actual_minutes, 0) / est.reduce((s, t) => s + t.estimated_minutes, 0) : null;
    mount($('[data-stats]'), html`
      <div class="stat stat--accent">
        <div class="stat__label"><span class="eyebrow">Hôm nay</span><span class="stat__icon">${icon('clock')}</span></div>
        <div class="stat__value">${hoursMins(todaySecs)}</div>
        <div class="stat__meta">${num(weekEntries.filter((e) => dayOf(e.started_at) === t0).length)} phiên</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Tuần này</span><span class="stat__icon">${icon('calendar')}</span></div>
        <div class="stat__value">${hoursMins(weekSecs)}</div>
        <div class="stat__meta">TB ${minutes(weekSecs / 60 / Math.max(1, elapsedDays))} / ngày</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Pomodoro hôm nay</span><span class="stat__icon">${icon('hourglass')}</span></div>
        <div class="stat__value">${num(pm.todayCount)}<small>phiên</small></div>
        <div class="stat__meta">≈ ${minutes(pm.todayCount * pm.cfg.focus)} tập trung sâu</div>
      </div>
      <div class="stat">
        <div class="stat__label"><span class="eyebrow">Độ sát ước tính</span><span class="stat__icon">${icon('target')}</span></div>
        ${acc == null
          ? html`<div class="stat__value">—</div><div class="stat__meta">Cần việc đã xong có ước tính</div>`
          : html`<div class="stat__value">${dec(Math.round(acc * 100) / 100)}<small>×</small></div>
                 <div class="stat__meta">${acc > 1.15 ? 'Thường lâu hơn dự kiến' : acc < 0.85 ? 'Thường xong sớm' : 'Ước tính khá sát'} · ${est.length} việc</div>`}
      </div>`);
  }

  const hoursMins = (secs) => {
    const m = Math.round(secs / 60);
    if (m < 60) return html`${m}<small>phút</small>`;
    return html`${Math.floor(m / 60)}<small>g</small>${String(m % 60).padStart(2, '0')}<small>p</small>`;
  };

  /* ================================================================ */
  /* Period data helpers                                                */
  /* ================================================================ */
  const startCache = new Map();
  const dayStartMs = (d) => {
    if (!startCache.has(d)) startCache.set(d, dayStartInstant(d).getTime());
    return startCache.get(d);
  };

  /** Split an entry at local midnights → [{day, s, e}] (ms). Running entries end now. */
  function pieces(e) {
    const s = Date.parse(e.started_at);
    const end = e.ended_at ? Date.parse(e.ended_at) : Date.now();
    const out = [];
    let cur = s;
    while (cur < end && out.length < 4) {
      const d = dayOf(new Date(cur));
      const stop = Math.min(end, dayStartMs(addDays(d, 1)));
      out.push({ day: d, s: cur, e: stop });
      cur = stop;
    }
    return out;
  }

  function bounds() {
    const t0 = today();
    if (period === 'month') {
      const m = addMonths(startOfMonth(t0), offset);
      return [m, endOfMonth(m)];
    }
    const s = addDays(startOfWeek(t0), offset * 7);
    return [s, addDays(s, 6)];
  }

  const catOf = (e) => {
    const t = e.task || taskById(e.task_id);
    const cid = t?.category_id || taskById(e.task_id)?.category_id;
    return cid ? categoryById(cid) : null;
  };
  const colorOf = (e) => catOf(e)?.color || 'var(--ink-3)';
  const titleOf = (e) => e.task?.title || taskById(e.task_id)?.title || e.description || 'Không gắn công việc';

  /* ================================================================ */
  /* Timeline (week, desktop)                                           */
  /* ================================================================ */
  function renderTimeline() {
    const card = $('[data-tl]');
    card.hidden = period !== 'week';
    if (period !== 'week') return;
    const [from, to] = bounds();
    const days = daysBetween(from, to);
    const byDay = new Map(days.map((d) => [d, []]));
    entries.forEach((e) => pieces(e).forEach((p) => byDay.get(p.day)?.push({ ...p, entry: e })));
    let h0 = 7, h1 = 22;
    byDay.forEach((list, d) => list.forEach((p) => {
      const a = (p.s - dayStartMs(d)) / 3600000, b = (p.e - dayStartMs(d)) / 3600000;
      h0 = Math.min(h0, Math.floor(a));
      h1 = Math.max(h1, Math.ceil(b));
    }));
    h0 = Math.max(0, h0);
    h1 = Math.min(24, h1);
    const span = h1 - h0;
    const step = span > 12 ? 2 : 1;
    const labels = [];
    for (let h = h0; h <= h1; h += step) labels.push(h);
    const t0 = today();
    const wl = weekdayLabels('short');
    const nowPct = ((Date.now() - dayStartMs(t0)) / 3600000 - h0) / span * 100;
    const total = [...byDay.values()].flat().reduce((s, p) => s + (p.e - p.s), 0) / 1000;

    mount(card, html`
      ${sheetHead('T.2', 'Dòng thời gian tuần', html`<span class="num muted tm-head-sum">${minutes(total / 60)}</span>`)}
      <div class="tm-tl" style="--n:${span / step}">
        <div class="tm-tl__axis" aria-hidden="true">
          <span></span>
          <div class="tm-tl__hours">${labels.map((h) => html`<span style="left:${((h - h0) / span) * 100}%">${String(h).padStart(2, '0')}</span>`)}</div>
        </div>
        ${days.map((d, i) => {
          const list = byDay.get(d);
          const secs = list.reduce((s, p) => s + (p.e - p.s), 0) / 1000;
          return html`
            <div class="tm-tl__row ${d === t0 ? 'is-today' : ''} ${d > t0 ? 'is-future' : ''}">
              <div class="tm-tl__day"><strong>${wl[i]}</strong><small class="num">${d.slice(8)}/${d.slice(5, 7)}</small><span class="num">${secs ? minutes(secs / 60) : '—'}</span></div>
              <div class="tm-tl__track">
                ${list.map((p) => {
                  const left = (((p.s - dayStartMs(d)) / 3600000 - h0) / span) * 100;
                  const width = Math.max(0.35, ((p.e - p.s) / 3600000 / span) * 100);
                  const e = p.entry;
                  const label = `${time(p.s)}–${e.ended_at || p.e < Date.now() - 60000 ? time(p.e) : 'nay'} · ${titleOf(e)} · ${minutes((p.e - p.s) / 60000)}`;
                  return html`<button type="button" class="tm-tl__bar ${e.ended_at ? '' : 'is-running'}" style="left:${left}%;width:${width}%;--c:${colorOf(e)}" data-entry="${e.id}" data-act="${e.ended_at ? 'edit-entry' : ''}" title="${label}" aria-label="${label}"><span>${titleOf(e)}</span></button>`;
                })}
                ${d === t0 && nowPct >= 0 && nowPct <= 100 ? html`<i class="tm-tl__now" style="left:${nowPct}%" aria-hidden="true"></i>` : ''}
              </div>
            </div>`;
        })}
      </div>`);
  }

  /* ================================================================ */
  /* Charts                                                             */
  /* ================================================================ */
  function renderCharts() {
    charts.forEach((d) => d());
    charts = [];
    const p = palette();
    const [from, to] = bounds();
    const days = daysBetween(from, to);
    const per = Object.fromEntries(days.map((d) => [d, 0]));
    const perCat = new Map();
    entries.forEach((e) => {
      const c = catOf(e);
      const key = c ? c.id : e.task_id ? '__nocat' : '__none';
      pieces(e).forEach((pc) => {
        if (!(pc.day in per)) return;
        const s = (pc.e - pc.s) / 1000;
        per[pc.day] += s;
        perCat.set(key, (perCat.get(key) || 0) + s);
      });
    });
    const t0 = today();
    const total = Object.values(per).reduce((a, b) => a + b, 0);
    const activeDays = days.filter((d) => per[d] > 0).length;
    const avgH = activeDays ? total / 3600 / activeDays : 0;
    const best = days.reduce((b, d) => (per[d] > (per[b] || 0) ? d : b), days[0]);

    /* -- hours per day -- */
    mount($('[data-daily]'), html`
      ${sheetHead('T.3', 'Giờ theo ngày', html`<span class="chart-key"><span><i style="background:var(--ink)"></i>Giờ</span><span><i style="background:var(--accent)"></i>Hôm nay</span><span><i class="tm-key-dash"></i>TB ngày có làm</span></span>`)}
      <div class="sheet__body">
        ${total
          ? html`<div class="chart-box" data-c></div>
                 <dl class="tm-facts">
                   <div><dt>Tổng</dt><dd class="num">${minutes(total / 60)}</dd></div>
                   <div><dt>Ngày có làm</dt><dd class="num">${activeDays}/${days.filter((d) => d <= t0).length || days.length}</dd></div>
                   <div><dt>TB / ngày có làm</dt><dd class="num">${minutes(avgH * 60)}</dd></div>
                   <div><dt>Năng suất nhất</dt><dd class="num">${per[best] ? `${relDay(best)} · ${minutes(per[best] / 60)}` : '—'}</dd></div>
                 </dl>`
          : emptyState({ art: 'chart', small: true, title: 'Chưa có giờ nào trong kỳ', text: 'Bấm giờ hoặc ghi giờ thủ công để thấy nhịp làm việc của bạn.' })}
      </div>`);
    if (total) {
      const wl = weekdayLabels('narrow');
      const labels = days.map((d, i) => (period === 'week' ? [wl[i], d.slice(8)] : String(Number(d.slice(8)))));
      charts.push(makeChart($('[data-daily] [data-c]'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              type: 'bar', label: 'Giờ', order: 2,
              data: days.map((d) => Math.round((per[d] / 3600) * 100) / 100),
              backgroundColor: days.map((d) => (d === t0 ? p.accent : d > t0 ? p.rule : p.ink)),
              borderRadius: 3, maxBarThickness: period === 'week' ? 36 : 14,
            },
            { type: 'line', label: 'TB', order: 1, data: days.map(() => Math.round(avgH * 100) / 100), borderColor: p.ink3, borderDash: [4, 4], borderWidth: 1, pointRadius: 0, pointHoverRadius: 0 },
          ],
        },
        options: {
          scales: { y: { ticks: { callback: (v) => `${v}g` } } },
          plugins: {
            tooltip: {
              filter: (c) => c.datasetIndex === 0,
              callbacks: { title: (c) => day(days[c[0].dataIndex], 'weekday'), label: (c) => ` ${minutes(per[days[c.dataIndex]] / 60)}` },
            },
          },
        },
      }));
    }

    /* -- by category -- */
    const cats = [...perCat.entries()].sort((a, b) => b[1] - a[1]).map(([k, s]) => {
      if (k === '__none') return { name: 'Không gắn công việc', color: p.ink4, s };
      if (k === '__nocat') return { name: 'Chưa phân loại', color: p.ink3, s };
      const c = categoryById(k);
      return { name: c?.name || 'Danh mục đã xóa', color: c?.color || p.ink3, s };
    });
    mount($('[data-cats]'), html`
      ${sheetHead('T.4', 'Theo danh mục')}
      <div class="sheet__body">
        ${cats.length
          ? html`
            <div class="donut tm-donut"><div class="chart-box chart-box--sm" data-c></div>
              <div class="donut__center"><span class="eyebrow">Tổng</span><strong class="num">${hours(total / 60)}</strong></div></div>
            <div class="legend tm-legend">${cats.map((c) => html`
              <div class="legend__row"><span class="legend__dot" style="--c:${c.color}"></span><span class="truncate">${c.name}</span><span class="legend__val">${minutes(c.s / 60)}</span><span class="legend__pct">${Math.round((c.s / total) * 100)}%</span></div>`)}</div>`
          : emptyState({ art: 'clock', small: true, title: 'Chưa có dữ liệu' })}
      </div>`);
    if (cats.length) {
      charts.push(makeChart($('[data-cats] [data-c]'), {
        type: 'doughnut',
        data: { labels: cats.map((c) => c.name), datasets: [{ data: cats.map((c) => Math.round(c.s / 60)), backgroundColor: cats.map((c) => c.color), borderColor: p.surface, borderWidth: 2, hoverOffset: 4 }] },
        options: { plugins: { tooltip: { callbacks: { label: (c) => ` ${minutes(c.raw)} · ${Math.round((c.raw * 60 / total) * 100)}%` } } } },
      }));
    }

    renderEstimate();
  }

  function renderEstimate() {
    const p = palette();
    const list = tasks
      .filter((t) => t.estimated_minutes > 0 && t.actual_minutes > 0 && t.status !== 'cancelled')
      .sort((a, b) => String(b.completed_at || b.updated_at).localeCompare(String(a.completed_at || a.updated_at)))
      .slice(0, 8);
    const card = $('[data-est]');
    if (!list.length) {
      mount(card, html`${sheetHead('T.6', 'Ước tính & thực tế')}<div class="sheet__body">${emptyState({ art: 'target', small: true, title: 'Chưa đủ dữ liệu', text: 'Đặt “thời gian ước tính” cho công việc rồi bấm giờ khi làm — bạn sẽ biết mình ước lượng sát đến đâu.' })}</div>`);
      return;
    }
    const ratios = list.map((t) => t.actual_minutes / t.estimated_minutes).sort((a, b) => a - b);
    const median = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
    const over = list.filter((t) => t.actual_minutes > t.estimated_minutes * 1.1).length;
    const advice = median > 1.15
      ? `Thực tế thường gấp ${dec(Math.round(median * 100) / 100)}× ước tính — hãy cộng thêm khoảng ${Math.round((median - 1) * 100)}% khi lập kế hoạch.`
      : median < 0.85 ? `Bạn thường xong sớm (≈ ${dec(Math.round(median * 100) / 100)}× ước tính) — có thể nhận thêm việc.`
        : 'Ước tính của bạn khá sát thực tế. Giữ nhịp này!';
    mount(card, html`
      ${sheetHead('T.6', 'Ước tính & thực tế', html`<span class="chart-key"><span><i style="background:var(--rule-strong)"></i>Ước tính</span><span><i style="background:var(--moss)"></i>Thực tế</span><span><i style="background:var(--clay)"></i>Vượt</span></span>`)}
      <div class="sheet__body">
        <div class="chart-box" style="height:${list.length * 38 + 30}px" data-c></div>
        <p class="tm-advice">${icon('sparkle')}<span>${advice} <span class="faint">(${over}/${list.length} việc vượt ước tính)</span></span></p>
      </div>`);
    const short = (s) => (s.length > 24 ? s.slice(0, 23) + '…' : s);
    charts.push(makeChart(card.querySelector('[data-c]'), {
      type: 'bar',
      data: {
        labels: list.map((t) => short(t.title)),
        datasets: [
          { label: 'Ước tính', data: list.map((t) => t.estimated_minutes), backgroundColor: p.rule, borderRadius: 2, barPercentage: 0.9, categoryPercentage: 0.7 },
          { label: 'Thực tế', data: list.map((t) => t.actual_minutes), backgroundColor: list.map((t) => (t.actual_minutes > t.estimated_minutes * 1.1 ? p.clay : p.moss)), borderRadius: 2, barPercentage: 0.9, categoryPercentage: 0.7 },
        ],
      },
      options: {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { display: true, color: p.rule }, ticks: { callback: (v) => minutes(v), maxTicksLimit: 5 } },
          y: { grid: { display: false }, ticks: { color: p.ink2 } },
        },
        plugins: { tooltip: { callbacks: { title: (c) => list[c[0].dataIndex].title, label: (c) => ` ${c.dataset.label}: ${minutes(c.raw)}` } } },
      },
    }));
  }

  /* ================================================================ */
  /* Entry list                                                         */
  /* ================================================================ */
  function renderLog() {
    const [from, to] = bounds();
    const rows = entries.filter((e) => { const d = dayOf(e.started_at); return d >= from && d <= to; });
    const total = rows.reduce((s, e) => s + entrySeconds(e), 0);
    const head = sheetHead('T.5', 'Các phiên', html`<span class="num muted tm-head-sum">${rows.length} phiên · ${minutes(total / 60)}</span>`);
    if (!rows.length) {
      mount($('[data-log]'), html`${head}${emptyState({ art: 'clock', small: true, title: 'Chưa có phiên nào trong kỳ', text: 'Bấm “Bắt đầu” ở trên hoặc ghi lại khoảng thời gian bạn đã làm.', action: html`<button class="btn btn--sm" data-act="manual">${icon('plus')} Ghi giờ thủ công</button>` })}`);
      return;
    }
    const groups = new Map();
    rows.forEach((e) => { const d = dayOf(e.started_at); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(e); });
    mount($('[data-log]'), html`${head}
      <div class="tm-log">
      ${[...groups.entries()].map(([d, list]) => html`
        <div class="group-head"><span class="group-head__day">${relDay(d)}<small>${day(d, 'numeric')}</small></span><span class="group-head__sum">${minutes(list.reduce((s, e) => s + entrySeconds(e), 0) / 60)}</span></div>
        <ul class="list">
          ${list.map((e) => {
            const running = !e.ended_at;
            const c = catOf(e);
            const t = e.task || taskById(e.task_id);
            return html`<li class="tm-entry ${running ? 'is-running' : ''}" data-entry="${e.id}" style="--c:${colorOf(e)}">
              <span class="tm-entry__time num">${time(e.started_at)}<span class="faint">–</span>${running ? html`<span class="success-text">nay</span>` : time(e.ended_at)}</span>
              <button type="button" class="tm-entry__main" data-act="${running ? '' : 'edit-entry'}" ${running ? raw('disabled') : ''} aria-label="${running ? 'Phiên đang chạy' : `Sửa phiên ${titleOf(e)}`}">
                <span class="tm-entry__title truncate">${t?.title || e.description || html`<span class="muted">Không gắn công việc</span>`}</span>
                <span class="tm-entry__meta">
                  ${c ? html`<span class="cat" style="--c:${c.color}"><span class="cat__dot"></span>${c.name}</span>` : ''}
                  ${t && e.description ? html`<span class="truncate">${e.description}</span>` : ''}
                  ${e.source === 'manual' ? html`<span class="badge badge--plain badge--outline">Thủ công</span>` : ''}
                  ${running ? html`<span class="badge badge--accent">Đang chạy</span>` : ''}
                </span>
              </button>
              <span class="tm-entry__dur num">${minutes(entrySeconds(e) / 60)}</span>
              ${running ? html`<span></span>` : html`<button class="icon-btn tm-touch" data-act="entry-menu" aria-label="Thao tác với phiên">${icon('more')}</button>`}
            </li>`;
          })}
        </ul>`)}
      </div>`);
  }

  /* ================================================================ */
  /* Manual / edit entry                                                */
  /* ================================================================ */
  function openEntryForm(entry = null) {
    const now = new Date();
    const round5 = (d) => new Date(Math.floor(d.getTime() / 300000) * 300000);
    const s = entry ? new Date(entry.started_at) : round5(new Date(now.getTime() - 60 * 60000));
    const e = entry ? new Date(entry.ended_at) : round5(now);
    const [sd, st] = toLocalInput(s).split('T');
    const [, et] = toLocalInput(e).split('T');
    const choices = tasks.filter((t) => OPEN.includes(t.status) || t.id === entry?.task_id || t.status === 'completed');
    const opts = [{ value: '', label: '— Không gắn công việc —' }, ...choices
      .sort((a, b) => (OPEN.includes(a.status) ? 0 : 1) - (OPEN.includes(b.status) ? 0 : 1))
      .map((t) => ({ value: t.id, label: t.status === 'completed' ? `✓ ${t.title}` : t.title }))];
    const compute = (v) => {
      if (!v.day || !v.from || !v.to) return null;
      const a = fromLocalInput(`${v.day}T${v.from}`);
      let b = fromLocalInput(`${v.day}T${v.to}`);
      let overnight = false;
      if (b <= a) { b = new Date(b.getTime() + 86400000); overnight = true; }
      return { a, b, overnight, mins: (b - a) / 60000 };
    };
    openModal({
      eyebrow: entry ? 'Sửa phiên' : 'Ghi giờ thủ công',
      title: entry ? 'Chỉnh sửa phiên làm việc' : 'Thêm khoảng thời gian đã làm',
      body: html`<div class="form">
        ${field({ label: 'Công việc', name: 'task_id', control: select('task_id', opts, entry ? entry.task_id || '' : pickTaskId || '') })}
        <div class="form-row form-row--3">
          ${field({ label: 'Ngày', name: 'day', control: input('day', sd, `type="date" required max="${today()}"`) })}
          ${field({ label: 'Từ', name: 'from', control: input('from', st, 'type="time" required step="60"') })}
          ${field({ label: 'Đến', name: 'to', control: input('to', et, 'type="time" required step="60"') })}
        </div>
        <div class="tm-durs" role="group" aria-label="Thời lượng nhanh">
          <span class="eyebrow">Thời lượng</span>
          ${[15, 30, 45, 60, 90, 120].map((m) => html`<button type="button" class="btn btn--sm" data-dur="${m}">${minutes(m)}</button>`)}
        </div>
        ${field({ label: 'Ghi chú', name: 'description', optional: true, control: input('description', entry?.description || '', 'maxlength="500" placeholder="Ví dụ: Họp với khách hàng"') })}
        <p class="tm-durline" data-durline></p>
      </div>`,
      submitLabel: entry ? 'Lưu thay đổi' : 'Thêm phiên',
      onOpen(el) {
        const val = (n) => el.querySelector(`[name=${n}]`).value;
        const upd = () => {
          const r = compute({ day: val('day'), from: val('from'), to: val('to') });
          el.querySelector('[data-durline]').textContent = r ? `Thời lượng: ${minutes(r.mins)}${r.overnight ? ' · kết thúc vào ngày hôm sau' : ''}` : '';
        };
        el.addEventListener('input', upd);
        el.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-dur]');
          if (!b) return;
          const a = fromLocalInput(`${val('day')}T${val('from')}`);
          const end = new Date(a.getTime() + Number(b.dataset.dur) * 60000);
          el.querySelector('[name=to]').value = toLocalInput(end).split('T')[1];
          upd();
        });
        upd();
      },
      validate(v) {
        const er = {};
        if (!v.day) er.day = 'Chọn ngày.';
        if (!v.from) er.from = 'Chọn giờ bắt đầu.';
        if (!v.to) er.to = 'Chọn giờ kết thúc.';
        const r = compute(v);
        if (r && r.b > new Date(Date.now() + 60000)) er.to = 'Không thể ghi giờ trong tương lai.';
        return er;
      },
      async onSubmit(v) {
        const r = compute(v);
        const payload = { task_id: v.task_id || null, description: v.description || null, started_at: r.a.toISOString(), ended_at: r.b.toISOString() };
        if (entry) await updateEntry(entry.id, payload);
        else await logTime({ taskId: payload.task_id, startedAt: payload.started_at, endedAt: payload.ended_at, description: payload.description });
        toast(entry ? 'Đã lưu phiên.' : `Đã thêm ${minutes(r.mins)} vào nhật ký.`);
        await loadData();
      },
    });
  }

  async function removeEntry(entry) {
    if (!(await confirmDialog({ title: 'Xóa phiên này?', message: `Phiên ${minutes(entrySeconds(entry) / 60)} (${titleOf(entry)}) sẽ bị xóa và thời gian thực tế của công việc được tính lại.` }))) return;
    try {
      await deleteEntry(entry.id);
      toast('Đã xóa phiên.');
      await loadData();
    } catch (err) { toast.error(err); }
  }

  /* ================================================================ */
  /* Data                                                               */
  /* ================================================================ */
  function renderPeriodHead() {
    const [from, to] = bounds();
    $('[data-plabel]').textContent = period === 'month' ? monthLabel(from) : `${day(from)} – ${day(to)}`;
    root.querySelector('[data-shift="1"]').disabled = offset >= 0;
    root.querySelector('[data-act="now"]').hidden = offset === 0;
    root.querySelectorAll('[data-period]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === period)));
  }

  function renderPeriod() {
    renderPeriodHead();
    renderTimeline();
    renderCharts();
    renderLog();
  }

  let loadSeq = 0;
  async function loadData() {
    const seq = ++loadSeq;
    const t0 = today();
    const [from, to] = bounds();
    const ws = startOfWeek(t0);
    const coversWeek = from <= ws && to >= t0;
    try {
      const [tk, en, we] = await Promise.all([
        listTasks({ limit: 1000 }),
        listEntries({ from, to: to > t0 ? t0 : to }),
        coversWeek ? null : listEntries({ from: ws, to: t0 }),
      ]);
      if (seq !== loadSeq) return;
      tasks = tk;
      entries = en;
      weekEntries = we || en.filter((e) => dayOf(e.started_at) >= ws);
      lastKey = '';
      refresh();
      renderStats();
      renderPeriod();
    } catch (err) {
      if (seq !== loadSeq) return;
      lastKey = '';
      refresh();
      mount($('[data-log]'), html`${sheetHead('T.5', 'Các phiên')}<div class="sheet__body">${errorState(err)}</div>`);
    }
  }

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadData, 500);
  }

  /* ================================================================ */
  /* Actions                                                            */
  /* ================================================================ */
  let acting = false;
  async function act(fn, msg) {
    if (acting) return;
    acting = true;
    try { await fn(); if (msg) toast(msg); } catch (err) { toast.error(err); } finally { acting = false; }
  }

  async function handleAct(el) {
    const a = el.dataset.act;
    if (!a) return;
    if (a === 'start') {
      const desc = root.querySelector('[data-desc]')?.value.trim() || pickDesc || null;
      pickDesc = '';
      return act(() => timer.start({ taskId: pickTaskId || null, description: desc }));
    }
    if (a === 'pause') return act(timer.pause);
    if (a === 'resume') return act(timer.resume);
    if (a === 'stop') return act(timer.stop, 'Đã lưu phiên làm việc.');
    if (a === 'skip') return act(timer.skipFocus);
    if (a === 'next-focus') return act(timer.startNextFocus);
    if (a === 'focus') return openFocus();
    if (a === 'focus-exit') return closeFocus();
    if (a === 'pomo-settings') return openPomoSettings();
    if (a === 'manual') return openEntryForm();
    if (a === 'retry') return loadData();
    if (a === 'now') { offset = 0; setQuery({ offset: null }); renderPeriodHead(); return loadData(); }
    const id = el.closest('[data-entry]')?.dataset.entry;
    const entry = id && entries.find((x) => x.id === id);
    if (!entry) return;
    if (a === 'edit-entry') return openEntryForm(entry);
    if (a === 'entry-menu') {
      popMenu(el, [
        { label: 'Sửa phiên', icon: 'edit', onClick: () => openEntryForm(entry) },
        { label: 'Bấm giờ tiếp việc này', icon: 'play', onClick: () => {
          const t = taskById(entry.task_id);
          if (t && !OPEN.includes(t.status)) return toast.error('Công việc đã hoàn thành hoặc đã hủy.');
          act(() => timer.start({ taskId: entry.task_id || null, description: entry.description || null }), 'Đã bắt đầu bấm giờ.');
        } },
        'sep',
        { label: 'Xóa phiên', icon: 'trash', danger: true, onClick: () => removeEntry(entry) },
      ]);
    }
  }

  disposers.push(on(root, 'click', '[data-act]', (e, el) => handleAct(el)));
  disposers.push(on(root, 'input', '[data-desc]', (e, el) => { pickDesc = el.value; }));
  disposers.push(on(root, 'click', '[data-mode]', (e, el) => {
    timer.setTimerMode(el.dataset.mode);
    lastKey = '';
    refresh();
  }));
  disposers.push(on(root, 'click', '[data-period]', (e, el) => {
    if (el.dataset.period === period) return;
    period = el.dataset.period;
    offset = 0;
    setQuery({ period: period === 'week' ? null : period, offset: null });
    renderPeriodHead();
    loadData();
  }));
  disposers.push(on(root, 'click', '[data-shift]', (e, el) => {
    offset = Math.min(0, offset + Number(el.dataset.shift));
    setQuery({ offset: offset || null });
    renderPeriodHead();
    loadData();
  }));

  // Keyboard: Space = start/pause/resume, F = focus mode, Esc = leave focus mode.
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && focusEl) { e.preventDefault(); closeFocus(); return; }
    const tag = e.target.tagName;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(tag) || e.target.isContentEditable) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === ' ') {
      const v = view();
      const map = { idle: 'start', running: 'pause', paused: 'resume', ready: 'next-focus', break: 'next-focus' };
      e.preventDefault();
      handleAct({ dataset: { act: map[v.state] }, closest: () => null });
    } else if ((e.key === 'f' || e.key === 'F') && !focusEl) {
      e.preventDefault();
      openFocus();
    }
  };
  document.addEventListener('keydown', onKey);
  disposers.push(() => document.removeEventListener('keydown', onKey));

  disposers.push(timer.onPomodoro(refresh));
  disposers.push(store.subscribe((_, patch) => {
    if (!('runningEntry' in patch)) return;
    refresh();
    scheduleReload();
  }));
  disposers.push(onDataChanged(scheduleReload));

  renderPeriodHead();
  refresh();
  await loadData();
  if (query.new) { setQuery({ new: null }); openEntryForm(); }
  if (query.focus) { setQuery({ focus: null }); openFocus(); }

  return () => {
    clearTimeout(reloadTimer);
    closeFocus();
    disposers.forEach((d) => d());
    charts.forEach((d) => d());
  };
}
