import { itemsProps } from "./list.js";
// Rust component descriptors supply the public props, slots and ref API.
export function createComponents(invoke, values, reactive, dom) {
  const states = new WeakMap();
  const hostProps = ["class", "classList", "style", "activeStyle", "hoverStyle", "focusStyle", "disabledStyle", "testID", "onLayout"];
  const handler = name => "on" + name[0].toUpperCase() + name.slice(1);
  const make = (spec, call) => function (props = {}) {
    const rt = dom.rt;
    const node = rt.element("view");
    rt.prop(node, "component", spec.name);
    const owner = reactive.getOwner();
    const state = { node, props, owner, renders: new Map(), lazy: reactive.signal(false) };
    states.set(node, state);
    if (spec.events.length || spec.lazy || spec.props.some(p => p.kind === "renderer")) invoke(305, [node, "onNativeEvent", true]);
    const disposeRender = entry => { invoke(306, [node, entry.holder]); entry.dispose(); };
    reactive.cleanup(() => { for (const entries of state.renders.values()) for (const entry of entries.values()) disposeRender(entry); state.renders.clear(); });
    let anchor = null;
    for (const prop of spec.props) {
      if (prop.kind !== "slot" || !(prop.name in props)) continue;
      const holder = rt.element("view");
      rt.prop(holder, "componentSlot", prop.name);
      rt.insert(holder, () => props[prop.name]);
      rt.append(node, holder);
      anchor ??= holder;
    }
    for (const prop of spec.props.filter(prop => prop.kind === "items")) {
      const forwarded = {};
      for (const key of itemsProps) if (key in props) Object.defineProperty(forwarded, key, { enumerable: true, get: () => props[key] });
      const holder = rt.list(forwarded);
      rt.prop(holder, "componentSlot", prop.name);
      rt.append(node, holder);
      anchor ??= holder;
    }
    const previous = new Map();
    reactive.renderEffect(() => {
      let failed;
      const update = (name, set) => {
        try {
          const value = props[name];
          if (previous.get(name) === value) return;
          set(value);
          previous.set(name, value);
        } catch (error) { failed ??= error; }
      };
      for (const prop of spec.props) {
        if (prop.kind === "value" || prop.kind === "renderer") update(prop.name, value => invoke(206, [spec.id, node, prop.name, value]));
      }
      for (const name of hostProps) update(name, value => rt.prop(node, name, value));
      if (failed) throw failed;
    });
    if (typeof props.ref === "function") {
      const api = spec.methods.length ? { node } : node;
      for (const method of spec.methods) api[method.name] = (...args) => call(207, [spec.id, node, method.id], api, args, method.promise, false);
      reactive.untracked(() => props.ref(api));
    }
    if (spec.props.some(prop => prop.kind === "children") && "children" in props) {
      const children = spec.lazy ? rt.cond(state.lazy, () => props.children) : reactive.computed(() => props.children);
      rt.insert(node, children, anchor);
    }
    return node;
  };
  const state = id => { const node = values.nodes.get(id)?.deref(); return node && states.get(node); };
  return {
    make,
    component(id, name, value) {
      const current = state(id);
      if (!current) return;
      reactive.batch(() => reactive.runWithOwner(current.owner, () => reactive.untracked(() => reactive.protect(() => {
        const fn = current.props[handler(name)];
        if (typeof fn === "function") return fn(value);
      }))));
    },
    children(id, wanted) { state(id)?.lazy.set(wanted); },
    render(id, prop, key, value) {
      const current = state(id);
      if (!current) return;
      reactive.runWithOwner(current.owner, () => reactive.protect(() => {
        this.unrender(id, prop, key);
        const render = current.props[prop];
        if (typeof render !== "function") return;
        return reactive.root(dispose => {
          const holder = dom.rt.element("view");
          dom.rt.prop(holder, "componentRender", `${prop}\x1f${key}`);
          try { dom.rt.insert(holder, render(value)); dom.rt.append(current.node, holder); }
          catch (error) { dispose(); throw error; }
          let entries = current.renders.get(prop);
          if (!entries) current.renders.set(prop, entries = new Map());
          entries.set(key, { holder, dispose });
        });
      }));
    },
    unrender(id, prop, key) {
      const current = state(id), entries = current?.renders.get(prop), entry = entries?.get(key);
      if (!entry) return;
      entries.delete(key);
      invoke(306, [current.node, entry.holder]);
      entry.dispose();
    },
  };
}
