// Hand-written chainable fake of the supabase-js v2 client.
//
//   const fake = createFakeSupabase();
//   fake.respond('tasks', { data: [...], error: null });   // next from('tasks') awaited
//   fake.respond('rpc:focus_tasks', { data: [...] });
//   fake.respond('auth:signInWithPassword', { data: {...}, error: null });
//   fake.respond('tasks', { throws: new TypeError('Failed to fetch') });
//   fake.respond('tasks', (call) => ({ data: ... }));     // computed from the call
//
// Every query is recorded in fake.calls as
//   { kind: 'from'|'rpc'|'auth', name, args, chain: [{ method, args }] }
// Unprogrammed queries resolve to { data: null, error: null }.

export function createFakeSupabase() {
  const calls = [];
  const queues = new Map();

  function respond(key, ...responses) {
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(...responses);
    return fake;
  }

  function resolve(key, call) {
    const q = queues.get(key);
    let r = q && q.length ? q.shift() : { data: null, error: null };
    if (typeof r === 'function') r = r(call);
    if (r && r.throws) return Promise.reject(r.throws);
    return Promise.resolve({ data: null, error: null, ...r });
  }

  function builder(call, key) {
    const target = {};
    const proxy = new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then') {
          return (onOk, onErr) => resolve(key, call).then(onOk, onErr);
        }
        if (prop === 'catch' || prop === 'finally') {
          return (...a) => resolve(key, call)[prop](...a);
        }
        if (typeof prop === 'symbol') return undefined;
        return (...args) => {
          call.chain.push({ method: prop, args });
          return proxy;
        };
      },
    });
    return proxy;
  }

  const auth = new Proxy(
    {},
    {
      get(_t, method) {
        if (typeof method === 'symbol') return undefined;
        if (method === 'onAuthStateChange') {
          return (cb) => {
            const unsubscribe = () => { fake.unsubscribed = true; };
            calls.push({ kind: 'auth', name: method, args: [cb], chain: [] });
            fake.authCallback = cb;
            return { data: { subscription: { unsubscribe } } };
          };
        }
        return (...args) => {
          const call = { kind: 'auth', name: method, args, chain: [] };
          calls.push(call);
          return resolve(`auth:${method}`, call);
        };
      },
    },
  );

  const fake = {
    calls,
    respond,
    auth,
    unsubscribed: false,
    authCallback: null,
    from(table) {
      const call = { kind: 'from', name: table, args: [table], chain: [] };
      calls.push(call);
      return builder(call, table);
    },
    rpc(name, args) {
      const call = { kind: 'rpc', name, args: args === undefined ? [] : [args], chain: [] };
      calls.push(call);
      return builder(call, `rpc:${name}`);
    },
    reset() {
      calls.length = 0;
      queues.clear();
      fake.unsubscribed = false;
      fake.authCallback = null;
    },
    // --- inspection helpers ---
    last(kind, name) {
      for (let i = calls.length - 1; i >= 0; i--) {
        const c = calls[i];
        if ((!kind || c.kind === kind) && (!name || c.name === name)) return c;
      }
      return undefined;
    },
    methods(call) {
      return call.chain.map((c) => c.method);
    },
    argsOf(call, method) {
      return call.chain.filter((c) => c.method === method).map((c) => c.args);
    },
  };
  return fake;
}
