// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
let plugin,
  context,
  locale = 'zh-CN',
  changed = false,
  ids = [],
  active;
const cancelled = new Set();
class Signal {
  aborted = false;
  reason;
  listeners = new Set();
  throwIfAborted() {
    if (this.aborted) throw this.reason;
  }
  addEventListener(name, callback) {
    if (name === 'abort') this.listeners.add(callback);
  }
  removeEventListener(name, callback) {
    if (name === 'abort') this.listeners.delete(callback);
  }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = Error('Cancelled');
    this.reason.name = 'AbortError';
    for (const callback of this.listeners) callback({ type: 'abort', target: this });
    this.listeners.clear();
  }
}
export function cancel(id) {
  if (active?.id === id) active.signal.abort();
  else {
    if (cancelled.size >= 256) cancelled.delete(cancelled.values().next().value);
    cancelled.add(id);
  }
  return null;
}
const call = (name, input) => {
  if (!context) throw Error('Plugin service calls require an active invocation');
  active?.signal.throwIfAborted();
  return context.invoke({ name, input: input ?? null }).then((value) => {
    active?.signal.throwIfAborted();
    return value;
  });
};
const api = {
  get locale() {
    return locale;
  },
  storage: {
    read: (fallback) => call('storage.read', fallback),
    write: (value) => call('storage.write', value),
  },
  call,
  changed: () => {
    changed = true;
  },
};
const uuid = () => {
  if (!ids.length) throw Error('UUID batch exhausted');
  return ids.pop();
};
const require = (name) => {
  if (name === 'crypto' || name === 'node:crypto') return { randomUUID: uuid };
  throw Error(
    `Native plugins cannot import ${name}; bundle dependencies and use ctx.call for host services`,
  );
};
export function validate(code) {
  new Function('exports', 'require', 'module', code);
  return true;
}
export async function invoke(request, native) {
  context = native;
  changed = false;
  locale = request.locale;
  ids = request.uuids;
  const key = Symbol.for('maka.quick-tools.locale.v1');
  const state = (globalThis[key] ??= { locale, listeners: new Set() });
  if (state) {
    state.locale = locale;
    for (const listener of state.listeners) listener();
  }
  const signal = new Signal();
  active = { id: request.id, signal };
  if (cancelled.delete(request.id)) signal.abort();
  try {
    signal.throwIfAborted();
    let value;
    const args = request.args ?? [];
    switch (request.method) {
      case 'start': {
        const module = { exports: {} };
        new Function('exports', 'require', 'module', request.code)(module.exports, require, module);
        plugin = await module.exports.default(api);
        break;
      }
      case 'search':
        value = (await plugin.search?.(args[0], signal)) ?? [];
        break;
      case 'view':
        if (!plugin.view) throw Error('Plugin has no view');
        value = await plugin.view(args[0], args[1], signal);
        break;
      case 'resolve':
        value = plugin.resolve
          ? await plugin.resolve(args[0])
          : (await plugin.search?.('', signal))?.find((row) => row.id === args[0]);
        break;
      case 'run':
        value = await plugin.run(args[0], args[1], args[2], signal);
        break;
      case 'event':
        value = await plugin.event?.(args[0], args[1]);
        break;
      case 'suggest':
        value = (await plugin.suggest?.(args[0], signal)) ?? { source: 'local', ids: [] };
        break;
      case 'dispose':
        value = await plugin.dispose?.();
        break;
      default:
        throw Error('Unknown plugin operation');
    }
    return { value: value ?? null, changed };
  } finally {
    context = undefined;
    ids = [];
    active = undefined;
  }
}
