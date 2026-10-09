// App-wide data-change events, e.g. a task created from the topbar quick-add
// should refresh whichever page is open.
export function notifyDataChanged(kind) {
  window.dispatchEvent(new CustomEvent('nm:data', { detail: { kind } }));
}

export function onDataChanged(fn) {
  const h = (e) => fn(e.detail.kind);
  window.addEventListener('nm:data', h);
  return () => window.removeEventListener('nm:data', h);
}
