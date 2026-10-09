// Hash router (#/path?query). GitHub Pages has no SPA rewrites, so history
// routing would 404 on refresh. Only location.hash is read or written here.

const listeners = new Set();

export function parseHash(hash = window.location.hash) {
  const h = hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  return { path: path.startsWith('/') ? path : '/' + path, query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function current() {
  return parseHash();
}

export function href(path, query) {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  return `#${path}${qs ? '?' + qs : ''}`;
}

export function navigate(path, query, { replace = false } = {}) {
  const target = href(path, query);
  if (replace) {
    const url = new URL(window.location.href);
    url.hash = target;
    window.history.replaceState(null, '', url);
    emit();
  } else if (window.location.hash === target) {
    emit();
  } else {
    window.location.hash = target;
  }
}

/** Update query params of the current route without re-rendering the page. */
export function setQuery(patch) {
  const { path, query } = current();
  const next = { ...query, ...patch };
  const url = new URL(window.location.href);
  url.hash = href(path, next);
  window.history.replaceState(null, '', url);
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  const r = current();
  listeners.forEach((fn) => fn(r));
}

window.addEventListener('hashchange', emit);
