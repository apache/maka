// The JSX facade delegates node ownership, value reconciliation, prop
// decoding and layout operations to Rust.
export function createDom(invoke, values, reactive, live, wake) {
  const handlers = new WeakMap(), owners = new WeakMap(), heldProps = new WeakMap();
  let touches, measure;
  const prototype = Object.create(null);
  for (const name of ["focus", "blur", "scrollTo", "zoomTo", "scrollToIndex", "scrollToEnd", "reload", "goBack", "goForward", "stopLoading", "injectJavaScript", "postMessage", "seek"]) {
    prototype[name] = function (argument) { const id = values.nodeIds.get(this); if (id === undefined) throw new TypeError("nsh: not a node"); return call(314, [id, name, argument]); };
  }
  prototype.setSelection = function (start, end = start) { return call(314, [values.nodeIds.get(this), "setSelection", { start: Number(start), end: Number(end) }]); };
  prototype.command = function (name, args) { return call(314, [values.nodeIds.get(this), "native", { name, args }]); };
  prototype.scrollToOffset = function (options) { return this.scrollTo({ x: options?.offset, y: options?.offset, animated: options?.animated }); };
  prototype.measure = function () { return measure(this); };
  const finalizers = new FinalizationRegistry(id => {
    if (live()) { invoke(307, [id]); values.nodes.delete(id); wake(); }
  });
  const node = (id, text = false) => {
    const existing = values.nodes.get(id)?.deref();
    if (existing) return existing;
    const value = Object.create(prototype);
    values.nodeIds.set(value, id);
    owners.set(value, reactive.getOwner());
    values.nodes.set(id, new WeakRef(value));
    if (id !== 1) finalizers.register(value, id);
    return value;
  };
  values.makeNode = node;
  const root = node(1);
  const call = (op, args) => {
    if (!live()) throw new Error("the app was disposed");
    const result = invoke(op, args);
    wake();
    return result;
  };
  const ref = (target, node, name) => {
    if (values.signals.has(target)) { target.set(node); return true; }
    if (values.memos.has(target)) throw new TypeError("a ref cannot be a memo, which is read-only");
    if (typeof target === "function") { reactive.untracked(() => target(node)); return true; }
    if (typeof name === "string") throw new TypeError(`ref={${name}}: binding cannot be assigned and is neither a signal nor a function`);
    return false;
  };
  const prop = (node, name, value) => {
    if (name === "children") return;
    if (touches?.isProp(name)) { touches.set(node,name,value); return; }
    if (name === "panActivation") touches?.gate(node,value);
    if (name === "ref") { ref(value, node); return; }
    if (/^on[A-Z]/.test(name)) {
      let events = handlers.get(node);
      if (!events) handlers.set(node, events = new Map());
      if (typeof value === "function") events.set(name, value); else events.delete(name);
      call(305, [node, name, typeof value === "function"]);
      return;
    }
    call(303, [node, name, value]);
    let held = heldProps.get(node);
    if (!held) heldProps.set(node, held = new Map());
    if (value === undefined || value === null) held.delete(name); else held.set(name, value);
  };
  const insert = (parent, value, before = null) => {
    let previous = [];
    const update = () => { previous = call(308, [parent, value, previous, before]); };
    // Rust unwraps nested functions in arrays under this tracking owner.
    reactive.renderEffect(update);
  };
  const append = (parent, child) => {
    if (values.nodeIds.has(child)) call(302, [parent, child, null]);
    else insert(parent, child);
  };
  const bindProp = (node, name, read) => reactive.renderEffect(() => prop(node, name, read()));
  const component = (Component, props) => reactive.untracked(() => Component(props));
  const cond = (when, then, otherwise) => {
    const condition = reactive.computed(() => Boolean(when()));
    return reactive.computed(() => {
      const render = condition() ? then : otherwise;
      return typeof render === "function" ? reactive.untracked(render) : undefined;
    });
  };
  const each = (source, render, key) => {
    const id = call(310, []);
    reactive.cleanup(() => call(312, [id]));
    const factory = (value, position) => {
      const item = reactive.signal(value), index = reactive.signal(position);
      return reactive.root(dispose => {
        try { return { item, index, dispose, output: render(item, index) }; }
        catch (error) { dispose(); throw error; }
      });
    };
    return reactive.computed(() => {
      const items = source();
      return reactive.untracked(() => call(311, [id, items, factory, key]));
    });
  };
  const merge = (...sources) => new Proxy(Object.create(null), {
    get(_, name) {
      for (let i = sources.length - 1; i >= 0; i--) {
        const source = typeof sources[i] === "function" ? sources[i]() : sources[i];
        if (source && name in source) return source[name];
      }
    },
    ownKeys() { return [...new Set(sources.flatMap(source => Reflect.ownKeys((typeof source === "function" ? source() : source) ?? {})))]; },
    getOwnPropertyDescriptor(_, name) { return { enumerable: true, configurable: true }; },
  });
  const spread = (node, props) => {
    let keys = [];
    reactive.renderEffect(() => {
      const next = Object.keys(props);
      for (const key of keys) if (!next.includes(key)) prop(node, key, undefined);
      for (const key of next) prop(node, key, props[key]);
      keys = next;
    });
  };
  let dispose;
  return {
    setMeasure(value) { measure = value; },
    setTouches(value) { touches = value; },
    rootProp: (name, value) => prop(root, name, value),
    listen(node, name, value) {
      let events = handlers.get(node);
      if (!events) handlers.set(node, events = new Map());
      if (typeof value === "function") events.set(name, value); else events.delete(name);
      call(309, [node, name, typeof value === "function"]);
    },
    rt: { element: tag => call(300, [tag]), text: value => call(301, [String(value)]),
      prop, bindProp, insert, append, component, cond, each, merge, spread,
      metaUrl: path => new URL(path, document.baseURI).href,
      ref,
    },
    mount(App, props = {}) {
      dispose?.();
      reactive.root(stop => { dispose = stop; insert(root, component(App, props)); });
      return () => { const stop = dispose; dispose = null; stop?.(); };
    },
    event(id, name, payload) {
      if (name === "onTouch" && touches) return touches.dispatch(payload);
      const target = values.nodes.get(id)?.deref();
      const handler = target && handlers.get(target)?.get(name);
      if (handler) reactive.batch(() => reactive.runWithOwner(owners.get(target), () => reactive.untracked(() => reactive.protect(() => handler(payload)))));
    },
    dispose() { const stop = dispose; dispose = null; stop?.(); },
  };
}
