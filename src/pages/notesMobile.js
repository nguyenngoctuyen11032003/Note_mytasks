// Ghi chú — phone helpers: swipe / long-press on list rows and a format bar
// that rides above the on-screen keyboard. Pure DOM, no page state: the page
// passes callbacks and gets back a dispose function.

const SWIPE_START = 12;    // px of horizontal travel before a swipe takes over
const SWIPE_COMMIT = 0.32; // share of the row width that commits the action
const LONG_PRESS = 480;    // ms
const MOVE_SLOP = 8;       // px a press may wander before it stops being a long-press

/**
 * Swipe a list row right / left to run an action, long-press for a menu.
 *   bindRowGestures(box, {
 *     enabled: () => bool,                      // e.g. phone + list layout
 *     actions: (id) => ({ right, left }),       // { label, icon (SafeHTML), tone, run } | null
 *     onMenu: (id, rowEl) => void,              // long-press / context menu
 *   }) → dispose
 */
export function bindRowGestures(box, { enabled, actions, onMenu }) {
  let g = null;           // current gesture
  let swallowClick = false;

  const rowOf = (t) => t.closest?.('.nb-item[data-id]');

  function reset(animate = true) {
    if (!g) return;
    const { row, under } = g;
    clearTimeout(g.timer);
    if (g.swiping) {
      row.style.transition = animate ? 'transform var(--t-med) var(--ease)' : '';
      row.style.transform = '';
      const done = () => { row.classList.remove('is-swiping'); row.style.transition = ''; under?.remove(); };
      if (animate) setTimeout(done, 220); else done();
    }
    g = null;
  }

  function underlay(row, acts) {
    const el = document.createElement('div');
    el.className = 'nb-swipe';
    el.setAttribute('aria-hidden', 'true');
    el.style.top = row.offsetTop + 'px';
    el.style.height = row.offsetHeight + 'px';
    const side = (a, dir) => (a ? `<span class="nb-swipe__act nb-swipe__act--${dir}" data-tone="${a.tone || ''}">${a.icon || ''}<b>${a.label}</b></span>` : '');
    el.innerHTML = side(acts.right, 'right') + side(acts.left, 'left');
    row.parentElement.insertBefore(el, row);
    return el;
  }

  const onDown = (e) => {
    if (e.pointerType === 'mouse' || e.button !== 0 || !enabled()) return;
    const row = rowOf(e.target);
    if (!row) return;
    reset(false);
    g = { row, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, swiping: false, pid: e.pointerId, under: null, acts: null };
    g.timer = setTimeout(() => {
      if (!g || g.swiping) return;
      const { id, row: r } = g;
      g = null;
      swallowClick = true;
      navigator.vibrate?.(8);
      onMenu(id, r);
    }, LONG_PRESS);
  };

  const onMove = (e) => {
    if (!g || e.pointerId !== g.pid) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.swiping) {
      if (Math.abs(dx) > MOVE_SLOP || Math.abs(dy) > MOVE_SLOP) clearTimeout(g.timer);
      if (Math.abs(dy) > MOVE_SLOP && Math.abs(dy) >= Math.abs(dx)) { g = null; return; } // vertical scroll
      if (Math.abs(dx) < SWIPE_START || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      g.acts = actions(g.id) || {};
      if (!g.acts.right && !g.acts.left) { g = null; return; }
      g.swiping = true;
      g.row.classList.add('is-swiping');
      g.under = underlay(g.row, g.acts);
      try { g.row.setPointerCapture(e.pointerId); } catch { /* row re-rendered */ }
    }
    // No action on a side → resist instead of sliding freely.
    const allowed = dx > 0 ? g.acts.right : g.acts.left;
    const w = g.row.offsetWidth || 1;
    g.dx = allowed ? Math.max(-w, Math.min(w, dx)) : dx / 6;
    g.row.style.transform = `translateX(${g.dx}px)`;
    const armed = allowed && Math.abs(g.dx) >= w * SWIPE_COMMIT;
    if (armed !== g.armed) {
      g.armed = armed;
      if (armed) navigator.vibrate?.(6);
    }
    g.under.dataset.dir = g.dx > 0 ? 'right' : 'left';
    g.under.dataset.tone = allowed?.tone || '';
    g.under.classList.toggle('is-armed', Boolean(armed));
  };

  const onUp = (e) => {
    if (!g || e.pointerId !== g.pid) return;
    clearTimeout(g.timer);
    if (!g.swiping) { g = null; return; }
    swallowClick = true;
    const act = g.armed ? (g.dx > 0 ? g.acts.right : g.acts.left) : null;
    if (!act) { reset(); return; }
    const { row, under, dx } = g;
    g = null;
    row.style.transition = 'transform var(--t-med) var(--ease)';
    if (act.leaves) {
      // The row is going away (trash, archive…): fly out, then let the list re-render.
      row.style.transform = `translateX(${dx > 0 ? '' : '-'}110%)`;
      setTimeout(() => {
        under.remove();
        // Still here afterwards (failed, or the view keeps it) → slide back in.
        Promise.resolve().then(act.run).catch(() => {}).finally(() => {
          if (!row.isConnected) return;
          row.style.transform = '';
          setTimeout(() => { row.classList.remove('is-swiping'); row.style.transition = ''; }, 220);
        });
      }, 200);
    } else {
      row.style.transform = '';
      setTimeout(() => { row.classList.remove('is-swiping'); row.style.transition = ''; under.remove(); act.run(); }, 200);
    }
  };

  const onCancel = (e) => { if (g && e.pointerId === g.pid) reset(); };

  // Android fires contextmenu on long-press too; desktop right-click gets the same menu.
  const onContext = (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    e.preventDefault();
    if (swallowClick) return; // our own long-press already opened it
    reset(false);
    onMenu(row.dataset.id, row);
  };

  const onClick = (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    if (rowOf(e.target)) { e.preventDefault(); e.stopPropagation(); }
  };
  // A press that ended without a click (scroll, menu…) must not eat the next tap.
  const onDownReset = () => { if (!g) swallowClick = false; };

  box.addEventListener('pointerdown', onDownReset, true);
  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', onUp);
  box.addEventListener('pointercancel', onCancel);
  box.addEventListener('contextmenu', onContext);
  box.addEventListener('click', onClick, true);
  return () => {
    reset(false);
    box.removeEventListener('pointerdown', onDownReset, true);
    box.removeEventListener('pointerdown', onDown);
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', onUp);
    box.removeEventListener('pointercancel', onCancel);
    box.removeEventListener('contextmenu', onContext);
    box.removeEventListener('click', onClick, true);
  };
}

/**
 * Track the on-screen keyboard through visualViewport: sets `--nb-kb` (its
 * height in px) on `el` and toggles `data-kb` so CSS can lift the format bar
 * above it and hide chrome that only steals space while typing.
 */
export function trackKeyboard(el) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  let raf = 0;
  const update = () => {
    raf = 0;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const open = kb > 80; // smaller gaps are browser chrome, not a keyboard
    el.style.setProperty('--nb-kb', (open ? kb : 0) + 'px');
    if (open) el.dataset.kb = ''; else delete el.dataset.kb;
    document.documentElement.classList.toggle('nb-kb-open', open);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  update();
  return () => {
    cancelAnimationFrame(raf);
    vv.removeEventListener('resize', schedule);
    vv.removeEventListener('scroll', schedule);
    document.documentElement.classList.remove('nb-kb-open');
  };
}
