// src/core/config.js reads window.location for auth redirect URLs.
globalThis.window ??= { location: { href: 'http://localhost:5173/#/tasks', origin: 'http://localhost:5173' }, addEventListener() {} };
