// Stand-in for src/core/supabase.js: services call `supabase.*`, the test decides
// which real client (which signed-in user) that is.
//   vi.mock('../../src/core/supabase.js', () => import('./clientProxy.js'));
let current = null;
export function setClient(c) { current = c; }
export const supabase = new Proxy({}, {
  get(_t, prop) {
    if (!current) throw new Error('clientProxy: call setClient(client) first');
    const v = current[prop];
    return typeof v === 'function' ? v.bind(current) : v;
  },
});
