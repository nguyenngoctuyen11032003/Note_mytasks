// App-wide data-change events, e.g. a task created from the topbar quick-add
// should refresh whichever page is open.
export function notifyDataChanged(kind) {
  window.dispatchEvent(new CustomEvent('nm:data', { detail: { kind } }));
}

/**
 * Runs (and empties) `disposers` when `signal` aborts. main.js aborts a page's
 * signal on every navigation, so listeners a page registered before an `await`
 * are removed even if the page is interrupted or throws before it returns its
 * own cleanup. splice(0) makes a later explicit cleanup over the same array a no-op.
 */
export function disposeOnAbort(signal, disposers) {
  if (!signal) return;
  const run = () => {
    for (const d of disposers.splice(0)) {
      try { d(); } catch (e) { console.error(e); }
    }
  };
  if (signal.aborted) run();
  else signal.addEventListener('abort', run, { once: true });
}

export function onDataChanged(fn) {
  const h = (e) => fn(e.detail.kind);
  window.addEventListener('nm:data', h);
  return () => window.removeEventListener('nm:data', h);
}
