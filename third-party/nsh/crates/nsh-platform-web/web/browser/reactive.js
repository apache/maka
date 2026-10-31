// Browser functions and values use Rust's shared reactive graph. A facade
// belongs to one app instance; it never consults a process-global player.

// Context -> its default ({ value }): hot module replacement keeps a
// context's identity and gives it the default of the one made again.
const contextDefaults = new WeakMap();

/** Gives context `kept` the default of context `from`. */
export function adoptContextDefault(kept, from) {
  const target = contextDefaults.get(kept), source = contextDefaults.get(from);
  if (target && source && target !== source) target.value = source.value;
}

export function createReactive(invoke, live, values) {
  const call = (op, ...args) => {
    if (!live()) throw new Error("the app was disposed");
    return invoke(op, args);
  };
  const boundaryKey = {}, caught = new Map();
  let delivering = false;
  if (values) values.after = () => {
    if (delivering) return;
    delivering = true;
    try {
      while (caught.size) {
        const pending = [...caught]; caught.clear();
        for (const [boundary, error] of pending) if (untracked(boundary) === undefined) boundary.set([error]);
      }
    } finally { delivering = false; }
  };
  const protect = fn => {
    try { return fn(); }
    catch (error) {
      const boundary = call(112, boundaryKey, undefined);
      if (!boundary) throw error;
      if (!caught.has(boundary)) caught.set(boundary, error);
    }
  };
  const guarded = fn => (...args) => protect(() => fn(...args));
  const finalizers = new FinalizationRegistry(handle => {
    values?.accessors.delete(`${handle[0]}:${handle[1]}`);
    if (live()) call(114, handle);
  });
  const accessor = handle => {
    const read = () => call(101, handle);
    finalizers.register(read, handle);
    values?.accessors.set(`${handle[0]}:${handle[1]}`, new WeakRef(read));
    values?.reconcile();
    return read;
  };
  const signal = (value, options) => {
    const handle = call(100, value, options?.equals);
    const read = accessor(handle);
    values?.signals.add(read);
    // A retained setter keeps its accessor (and therefore its graph handle) alive.
    read.set = value => { void read; return call(102, handle, value); };
    read.update = update => untracked(() => read.set(update(read())));
    return read;
  };
  const computed = (fn, options) => { const read = accessor(call(103, guarded(fn), undefined, options?.equals)); values?.memos.add(read); return read; };
  const renderEffect = (fn, initial) => call(104, guarded(fn), initial, false);
  const effect = fn => call(104, guarded(() => { const dispose = fn(); if (typeof dispose === "function") cleanup(dispose); }), undefined, true);
  const cleanup = fn => {
    // Native cleanup returns its argument and simply releases it when
    // no owner exists; module-level registration is not an exception.
    if (!call(110)) return fn;
    const boundary = call(112, boundaryKey, undefined);
    call(109, () => {
      try { return fn(); }
      catch (error) { if (!boundary) throw error; if (!caught.has(boundary)) caught.set(boundary, error); }
    });
    return fn;
  };
  const batch = fn => call(107, fn);
  const untracked = fn => call(108, fn);
  const root = fn => call(105, handle => fn(() => { if (handle && live()) call(106, handle); }));
  const getOwner = () => call(110);
  const runWithOwner = (owner, fn) => call(111, owner, fn);
  const context = defaultValue => {
    const key = {}, fallback = { value: defaultValue };
    const read = () => call(112, key, fallback.value);
    contextDefaults.set(read, fallback);
    read.Provider = props => {
      const parent = getOwner();
      return root(dispose => {
        if (parent) runWithOwner(parent, () => cleanup(dispose));
        call(113, key, props.value);
        return props.children;
      });
    };
    return read;
  };
  const ErrorBoundary = props => {
    const failed = signal(undefined);
    const memoize = value => typeof value === "function" ? computed(() => memoize(value())) : Array.isArray(value) ? value.map(memoize) : value;
    return computed(() => {
      const state = failed();
      // A function is called with the error and the reset whatever it
      // declares (`(...args)` and defaults count none); an element shows.
      if (state) return untracked(() => typeof props.fallback === "function" ? props.fallback(state[0], () => failed.set(undefined)) : props.fallback);
      return computed(() => {
        call(113, boundaryKey, failed);
        return untracked(() => memoize(props.children));
      });
    });
  };
  const split = (props, ...groups) => {
    const used = new Set();
    const picks = groups.map(keys => {
      const pick = {};
      for (const key of keys) {
        used.add(key);
        Object.defineProperty(pick, key, { enumerable: true, get: () => props[key] });
      }
      return pick;
    });
    const rest = {};
    for (const key of Object.keys(props)) {
      if (!used.has(key)) Object.defineProperty(rest, key, { enumerable: true, get: () => props[key] });
    }
    return [...picks, rest];
  };
  return { signal, computed, effect, cleanup, batch, untracked, root, context, split,
    getOwner, runWithOwner, renderEffect, ErrorBoundary, protect };
}
