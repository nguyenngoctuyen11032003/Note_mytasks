// "/" command menu for the rich Notes editor (stream A3).
//
//   SLASH_ITEMS                       → [{ id, label, hint, icon, keys }]
//   filterSlashItems(query, items?)   → matching items, best first (diacritic-insensitive)
//   createSlashMenu({ onPick, items?, doc? }) → {
//     el, id, open(rect), close(), isOpen(), filter(query) → count, move(delta),
//     pick(), count(), active() → item|null, activeId() → string, destroy()
//   }
//
// The menu is a listbox popup positioned at the caret (position: fixed). The editor keeps
// focus while it is open: it routes ArrowUp/Down/Enter/Tab/Escape here and points
// aria-activedescendant at activeId(). Mouse picks use mousedown + preventDefault so the
// caret never leaves the editor. Visual styling lives in rich.css (A7); a zero-specificity
// fallback (:where) is injected once so the menu is usable before that CSS lands.

export const SLASH_ITEMS = [
  { id: 'h1', label: 'Tiêu đề 1', hint: 'Tiêu đề lớn', icon: 'H1', keys: 'h1 heading tieu de lon #' },
  { id: 'h2', label: 'Tiêu đề 2', hint: 'Tiêu đề vừa', icon: 'H2', keys: 'h2 heading tieu de vua ##' },
  { id: 'h3', label: 'Tiêu đề 3', hint: 'Tiêu đề nhỏ', icon: 'H3', keys: 'h3 heading tieu de nho ###' },
  { id: 'ul', label: 'Danh sách', hint: 'Danh sách gạch đầu dòng', icon: '•', keys: 'bullet list ul gach dau dong -' },
  { id: 'ol', label: 'Danh sách số', hint: 'Danh sách đánh số', icon: '1.', keys: 'numbered ordered list ol so thu tu' },
  { id: 'task', label: 'Việc cần làm', hint: 'Danh sách có ô đánh dấu', icon: '☐', keys: 'todo task checklist checkbox viec can lam' },
  { id: 'quote', label: 'Trích dẫn', hint: 'Khối trích dẫn', icon: '❝', keys: 'quote blockquote trich dan >' },
  { id: 'code', label: 'Mã', hint: 'Khối mã nguồn', icon: '</>', keys: 'code block ma nguon lap trinh ```' },
  { id: 'table', label: 'Bảng', hint: 'Bảng 3 × 3', icon: '▦', keys: 'table bang' },
  { id: 'hr', label: 'Đường kẻ', hint: 'Đường phân cách', icon: '―', keys: 'divider hr line duong ke phan cach ---' },
  { id: 'image', label: 'Ảnh', hint: 'Chèn ảnh từ máy', icon: '🖼', keys: 'image picture photo anh hinh' },
  { id: 'record', label: 'Ghi âm', hint: 'Ghi âm cuộc họp', icon: '🎙', keys: 'record audio voice mic ghi am cuoc hop' },
];

/** Lower-case, strip Vietnamese diacritics (đ → d) for matching. */
export function foldVi(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function filterSlashItems(query, items = SLASH_ITEMS) {
  const q = foldVi(query).trim();
  if (!q) return items.slice();
  const scored = [];
  items.forEach((it, i) => {
    const label = foldVi(it.label);
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (label.includes(q)) score = 2;
    else if (foldVi(it.keys).split(/\s+/).some((w) => w.startsWith(q))) score = 3;
    else if (foldVi(`${it.label} ${it.hint} ${it.keys}`).includes(q)) score = 4;
    if (score >= 0) scored.push({ it, score, i });
  });
  scored.sort((a, b) => a.score - b.score || a.i - b.i);
  return scored.map((s) => s.it);
}

let styleInjected = false;
function injectFallbackStyle(doc) {
  if (styleInjected || !doc?.head) return;
  styleInjected = true;
  const st = doc.createElement('style');
  st.setAttribute('data-rt-slash', '');
  // :where() keeps specificity at 0 so rich.css always wins.
  st.textContent = `
:where(.rt-slash){position:fixed;z-index:1000;min-width:220px;max-width:min(320px,calc(100vw - 16px));max-height:min(320px,50vh);overflow:auto;padding:4px;border-radius:10px;background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border,rgba(0,0,0,.12));box-shadow:0 8px 28px rgba(0,0,0,.18);font:inherit;font-size:14px}
:where(.rt-slash[hidden]){display:none}
:where(.rt-slash__item){display:flex;align-items:center;gap:10px;min-height:40px;padding:6px 8px;border-radius:8px;cursor:pointer;user-select:none}
:where(.rt-slash__item[aria-selected="true"]){background:var(--hover,rgba(0,0,0,.07))}
:where(.rt-slash__icon){flex:0 0 28px;height:28px;display:grid;place-items:center;border-radius:6px;border:1px solid var(--border,rgba(0,0,0,.12));font-size:12px;font-weight:600}
:where(.rt-slash__text){display:flex;flex-direction:column;min-width:0}
:where(.rt-slash__hint){font-size:12px;opacity:.65}
:where(.rt-slash__empty){padding:10px;opacity:.7}
:where(.rt.is-empty)::before{content:attr(data-placeholder);position:absolute;pointer-events:none;opacity:.5}
:where(.rt){position:relative}`;
  doc.head.appendChild(st);
}

let menuSeq = 0;

export function createSlashMenu({ onPick, items = SLASH_ITEMS, doc = document } = {}) {
  const id = `rt-slash-${++menuSeq}`;
  const el = doc.createElement('div');
  el.className = 'rt-slash';
  el.id = id;
  el.setAttribute('role', 'listbox');
  el.setAttribute('aria-label', 'Chèn khối');
  el.hidden = true;
  let list = items.slice();
  let active = 0;
  let open = false;
  let anchorRect = null;

  injectFallbackStyle(doc);

  function render() {
    el.textContent = '';
    if (!list.length) {
      const empty = doc.createElement('div');
      empty.className = 'rt-slash__empty';
      empty.textContent = 'Không có kết quả';
      el.appendChild(empty);
      return;
    }
    list.forEach((it, i) => {
      const row = doc.createElement('div');
      row.className = 'rt-slash__item';
      row.id = `${id}-${it.id}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === active));
      row.dataset.id = it.id;
      const ic = doc.createElement('span');
      ic.className = 'rt-slash__icon';
      ic.setAttribute('aria-hidden', 'true');
      ic.textContent = it.icon;
      const tx = doc.createElement('span');
      tx.className = 'rt-slash__text';
      const lb = doc.createElement('span');
      lb.className = 'rt-slash__label';
      lb.textContent = it.label;
      const hn = doc.createElement('span');
      hn.className = 'rt-slash__hint';
      hn.textContent = it.hint;
      tx.append(lb, hn);
      row.append(ic, tx);
      el.appendChild(row);
    });
  }

  function position() {
    if (!open || !anchorRect) return;
    const vw = doc.defaultView?.innerWidth || 1024;
    const vh = doc.defaultView?.innerHeight || 768;
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth || 240;
    const h = el.offsetHeight || 200;
    let left = Math.max(8, Math.min(anchorRect.left, vw - w - 8));
    let top = anchorRect.bottom + 6;
    if (top + h > vh - 8 && anchorRect.top - h - 6 > 8) top = anchorRect.top - h - 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function syncActive() {
    el.querySelectorAll('[role="option"]').forEach((row, i) => {
      row.setAttribute('aria-selected', String(i === active));
      if (i === active) row.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function onMouseDown(e) {
    e.preventDefault(); // keep focus + caret in the editor
    const row = e.target.closest?.('[role="option"]');
    if (!row) return;
    const i = list.findIndex((it) => it.id === row.dataset.id);
    if (i >= 0) {
      active = i;
      api.pick();
    }
  }
  function onMouseMove(e) {
    const row = e.target.closest?.('[role="option"]');
    if (!row) return;
    const i = list.findIndex((it) => it.id === row.dataset.id);
    if (i >= 0 && i !== active) {
      active = i;
      syncActive();
    }
  }
  el.addEventListener('mousedown', onMouseDown);
  el.addEventListener('mousemove', onMouseMove);

  const api = {
    el,
    id,
    open(rect) {
      anchorRect = rect || anchorRect || { left: 8, top: 8, bottom: 8 };
      list = items.slice();
      active = 0;
      if (!el.isConnected) doc.body.appendChild(el);
      open = true;
      el.hidden = false;
      render();
      position();
    },
    close() {
      open = false;
      el.hidden = true;
    },
    isOpen: () => open,
    filter(query) {
      list = filterSlashItems(query, items);
      active = 0;
      render();
      position();
      return list.length;
    },
    count: () => list.length,
    move(delta) {
      if (!list.length) return;
      active = (active + delta + list.length) % list.length;
      syncActive();
    },
    active: () => list[active] || null,
    activeId: () => (open && list[active] ? `${id}-${list[active].id}` : ''),
    pick() {
      const it = list[active];
      if (!it) return null;
      api.close();
      onPick?.(it);
      return it;
    },
    reposition(rect) {
      if (rect) anchorRect = rect;
      position();
    },
    destroy() {
      open = false;
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mousemove', onMouseMove);
      el.remove();
    },
  };
  return api;
}
