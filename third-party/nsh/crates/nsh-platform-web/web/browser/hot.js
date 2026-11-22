// Hot module replacement on the browser host (development bundles only):
// the module system and component registry behind `__nsh_hot`, as nsh-js
// `hot.rs` is for QuickJS, with the same semantics.
//
// A development bundle (`nsh-bundler` `HotBundle`) defines every module as
// a factory (rolldown CommonJS output, one chunk per module) and starts the
// entry with the namespaces of the native modules it imports. An update
// script redefines the modules that changed; `update` runs them again,
// together with the importers that cannot take the change on their own, in
// place: the realm, the native views and every other module keep their
// state.
//
// Components (top-level functions returning JSX, wrapped by the bundler)
// are registered by module and name and rendered through a stable proxy.
// Running a module again swaps the implementation behind its proxies; the
// mounted instances whose code changed render again. Contexts keep their
// identity across updates, and so do the top-level signals and navigators
// the bundler marks (`keep`) while their initializer's code is the same. A
// `mount` call made again with the same component keeps what it mounted;
// other `mount` calls of a module that runs again are undone, from the
// first one that differs, and made anew.
import { adoptContextDefault } from "./reactive.js";

export function createHot(reactive, report) {
  // Module id -> factory(module, exports, require).
  const factories = new Map();
  // Modules that never run again (rolldown's runtime).
  const fixed = new Set();
  // Module id -> { exports, components, accepts }; `exports` is the first
  // exports object, which importers keep and later runs forward to theirs.
  const modules = new Map();
  // Module id -> the ids of the modules that required it.
  const importers = new Map();
  // "module:name" -> { fn, sig, version, proxy }.
  const components = new Map();
  const proxies = new WeakSet();
  // "module:name" -> context.
  const contexts = new Map();
  // "module:name" -> { sig, value }.
  const kept = new Map();
  // Module id -> functions undoing what its top-level code did, called
  // before it runs again.
  const undo = new Map();
  // Module id -> what its `mount` calls mounted: { app, dispose }.
  const renders = new Map();
  // Module id -> the renders of its previous run, while it runs again.
  const pending = new Map();
  let natives = {}, entry = null, current = null;
  // Running an update: components whose code did not change still render
  // again (their module ran because a dependency changed).
  let forced = false;
  let stale = [];
  // What the last update script's `update` call returned (a script that
  // makes none, the dev server's "nothing changed", applied).
  let applied = true;

  const keyOf = (module, name) => `${module}:${name}`;
  const sorted = values => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const undoRenders = list => {
    for (const render of list) {
      try { render.dispose(); } catch (error) { report(error); }
    }
  };

  // `spec` relative to module `from` (`a/b.js` + `../c.js` -> `c.js`).
  const resolve = (from, spec) => {
    const parts = from.split("/");
    parts.pop();
    for (const part of spec.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    return parts.join("/");
  };

  // A factory's `require(spec)`: a native module's namespace, or the
  // exports of the app's module `spec` names (relative to `from`).
  const require = (from, spec) => {
    spec = String(spec);
    if (!spec.startsWith(".")) {
      const namespace = natives?.[spec];
      if (namespace === undefined) throw new TypeError(`nsh hot: no module ${spec}`);
      return namespace;
    }
    const id = resolve(from, spec);
    let set = importers.get(id);
    if (!set) importers.set(id, set = new Set());
    set.add(from);
    return load(id);
  };

  // The exports of module `id`, running it the first time.
  const load = id => {
    const known = modules.get(id);
    if (known) return known.exports;
    const exports = {};
    modules.set(id, { exports, components: 0, accepts: false });
    run(id);
    return exports;
  };

  // Makes `kept` (what importers hold) forward to `exports` (the run's):
  // its keys follow, read through getters.
  const forward = (keptExports, exports) => {
    const keys = Object.getOwnPropertyNames(exports);
    for (const key of Object.getOwnPropertyNames(keptExports)) {
      if (!keys.includes(key)) delete keptExports[key];
    }
    for (const key of keys) {
      const { enumerable } = Object.getOwnPropertyDescriptor(exports, key);
      Object.defineProperty(keptExports, key, { configurable: true, enumerable, get: () => exports[key] });
    }
  };

  // Whether module `id` takes its own updates: it made components and
  // everything it exports (enumerably) is one of their proxies.
  const accepts = (module, exports) => {
    if (!module.components) return false;
    return Object.keys(exports).every(key => proxies.has(exports[key]));
  };

  // Runs module `id` (again).
  const run = id => {
    const factory = factories.get(id), module = modules.get(id);
    if (!factory || !module) throw new TypeError(`nsh hot: no module ${id}`);
    module.components = 0;
    // Renders made by an earlier run are kept or replaced by this run's
    // `mount` calls (`reuse`).
    pending.set(id, renders.get(id) ?? []);
    renders.delete(id);
    const undone = undo.get(id) ?? [];
    undo.delete(id);
    for (const f of undone) {
      try { f(); } catch (error) { report(error); }
    }
    const exports = fixed.has(id) ? module.exports : {};
    const record = { exports };
    const previous = current;
    current = id;
    let failure = null;
    try {
      factory(record, exports, spec => require(id, spec));
    } catch (error) {
      failure = { error };
    } finally {
      current = previous;
    }
    // What this run did not mount again.
    const left = pending.get(id) ?? [];
    pending.delete(id);
    undoRenders(left);
    if (failure) throw failure.error;
    if (record.exports !== module.exports) forward(module.exports, record.exports);
    module.accepts = accepts(module, module.exports);
  };

  // The modules to run again for `changed`, dependencies before their
  // importers; null when a change reaches a module nothing imports.
  const affected = changed => {
    const rerun = new Set(), queue = [...changed];
    while (queue.length) {
      const id = queue.pop();
      if (rerun.has(id)) continue;
      rerun.add(id);
      if (modules.get(id)?.accepts || id === entry) continue;
      const from = importers.get(id);
      if (!from?.size) return null;
      queue.push(...sorted(from));
    }
    const seen = new Set(), order = [];
    const visit = id => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const dep of sorted(importers.keys())) {
        if (rerun.has(dep) && importers.get(dep).has(id)) visit(dep);
      }
      order.push(id);
    };
    for (const id of sorted(rerun)) visit(id);
    return order;
  };

  // A proxy's render: a memo of the component's implementation now, run
  // again when its version changes.
  const render = (key, version, props) => reactive.computed(() => {
    version();
    const fn = components.get(key)?.fn;
    if (!fn) return undefined;
    try {
      return reactive.untracked(() => fn(props));
    } catch (error) {
      // A component that throws reports the error and renders nothing,
      // ready for the fix.
      report(error);
      return undefined;
    }
  });

  const hot = {
    // `define(id, factory, fixed)`: registers a module factory; fixed
    // modules never run again.
    define(id, factory, isFixed) {
      id = String(id);
      factories.set(id, factory);
      if (isFixed) fixed.add(id);
    },
    // `start(entry, natives)`: runs the entry; `natives` maps the native
    // modules' specifiers to their namespaces.
    start(id, namespaces) {
      entry = String(id);
      natives = namespaces ?? {};
      load(entry);
    },
    // `update(defs)`: replaces the factories of `defs` (id -> factory) and
    // runs the modules affected; false when the update cannot be applied
    // in place (the host runs the new bundle).
    update(defs) {
      applied = false;
      const changed = [], defined = new Set();
      for (const [id, factory] of Object.entries(defs ?? {})) {
        if (modules.has(id)) changed.push(id);
        factories.set(id, factory);
        defined.add(id);
      }
      const order = affected(changed);
      if (!order) return false;
      // Applied from here on: a module that throws is reported, and the
      // next update can fix it.
      applied = true;
      let failure = null;
      for (const id of order) {
        forced = !defined.has(id);
        try { run(id); } catch (error) { failure = { error }; break; }
      }
      forced = false;
      const versions = stale.map(key => components.get(key)?.version).filter(Boolean);
      stale = [];
      if (failure) throw failure.error;
      reactive.batch(() => { for (const version of versions) version.update(n => n + 1); });
      return true;
    },
    // `component(module, name, fn, signature)`: the stable proxy of a
    // component; a new signature renders its instances again.
    component(module, name, fn, sig) {
      const key = keyOf(module, name);
      sig = String(sig);
      const owner = current && modules.get(current);
      if (owner) owner.components++;
      const existing = components.get(key);
      if (existing) {
        if (existing.sig !== sig || forced) stale.push(key);
        existing.fn = fn;
        existing.sig = sig;
        return existing.proxy;
      }
      const version = reactive.signal(0);
      const proxy = props => render(key, version, props);
      Object.defineProperty(proxy, "name", { value: String(name), configurable: true });
      proxies.add(proxy);
      components.set(key, { fn, sig, version, proxy });
      return proxy;
    },
    // `context(module, name, context)`: the first context made under that
    // name keeps its identity (taking the new default).
    context(module, name, made) {
      const key = keyOf(module, name);
      const existing = contexts.get(key);
      if (existing) {
        adoptContextDefault(existing, made);
        return existing;
      }
      contexts.set(key, made);
      return made;
    },
    // `keep(module, name, signature, value)`: the value first made under
    // that name while its initializer's signature stays the same (a signal
    // keeps its value, a navigator its routes); otherwise `value`.
    keep(module, name, sig, value) {
      const key = keyOf(module, name);
      sig = String(sig);
      const existing = kept.get(key);
      if (existing && existing.sig === sig) return existing.value;
      kept.set(key, { sig, value });
      return value;
    },
  };

  return {
    hot,
    // Whether a development bundle started.
    get started() { return entry !== null; },
    // Runs an update script with `load` (which evaluates it); whether it
    // was applied in place. A script that throws is reported: the app
    // keeps the modules that ran.
    async apply(load) {
      applied = true;
      try { await load(); } catch (error) { report(error); }
      return applied;
    },
    // `mount(app)` ran: what it returned is undone when the module running
    // now runs again (unless that run mounts `app` again: `reuse`).
    rendered(app, dispose) {
      if (current === null) return;
      let list = renders.get(current);
      if (!list) renders.set(current, list = []);
      list.push({ app, dispose });
    },
    // `mount(app, props)` while a module runs again: when its previous
    // run's next render mounted the same `app` without props, that render
    // stays and its disposer is returned. Otherwise the previous run's
    // remaining renders are undone, so this one mounts after what stays.
    reuse(app, props) {
      if (current === null) return null;
      const list = pending.get(current);
      if (!list) return null;
      const hasProps = props !== null && (typeof props === "object" || typeof props === "function");
      if (!hasProps && list.length && list[0].app === app) {
        const render = list.shift();
        let done = renders.get(current);
        if (!done) renders.set(current, done = []);
        done.push(render);
        return render.dispose;
      }
      undoRenders(list.splice(0));
      return null;
    },
    // `f` undoes what the module running now did at its top level (a
    // keyboard shortcut it bound): it runs before the module runs again.
    // False outside a development bundle's module.
    undoOnRerun(f) {
      if (current === null) return false;
      let list = undo.get(current);
      if (!list) undo.set(current, list = []);
      list.push(f);
      return true;
    },
    // Takes `f` back from what undoes a module's run: what it undoes ended
    // by itself.
    forgetUndo(f) {
      for (const list of undo.values()) {
        const at = list.indexOf(f);
        if (at >= 0) { list.splice(at, 1); return; }
      }
    },
  };
}
