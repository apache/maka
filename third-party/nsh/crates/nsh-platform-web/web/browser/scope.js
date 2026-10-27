export { createHost } from "./host.js";
export { createStandard } from "./standard.js";
export { createResource } from "./resource.js";
export { createLists } from "./list.js";
export { Values } from "./values.js";
export { createReactive } from "./reactive.js";
export { createModules } from "./modules.js";
export { createDom } from "./dom.js";
export { createComponents } from "./components.js";
export { createGestures } from "./gesture.js";
export { createCanvas } from "./canvas.js";
export { createAnimation } from "./animation.js";
export { createNavigation } from "./navigation.js";
export { createKeymap } from "./keymap.js";
export { createEnvironment } from "./environment.js";


// Public wrappers must share the app's Function/Error/Promise intrinsics.
export function configureAPIs(nsh, modules, dom, active, env) {
  nsh.nextTick = (callback, ...args) => {
    if (typeof callback !== "function") throw new TypeError("nextTick: callback must be a function");
    queueMicrotask(() => { if (active()) callback(...args); });
  };
  const process = modules.exports.get("process");
  if (process) { process.nextTick = nsh.nextTick; if (process.default) process.default.nextTick = nsh.nextTick; }
  const desktop = modules.exports.get("nsh/desktop");
  if (desktop) Object.assign(desktop, { isAvailable: false, titleBar: env.titleBar, Menu: { setApplicationMenu() {}, popup: () => Promise.resolve() } });
  for (const [name, tag] of Object.entries({View:"view",Text:"text",Scroll:"scroll",Overlay:"overlay",Image:"image",WebView:"webview",Video:"video",Shader:"shader"})) {
    const Component = props => {const node = dom.rt.element(tag);dom.rt.spread(node,props);if ("children" in props) dom.rt.insert(node,()=>props.children);return node;};
    nsh[name] = Object.assign(Component, nsh[name]);
  }
  nsh.nativeComponent = (name, spec = {}) => (props = {}) => {
    const node = dom.rt.element("native");
    dom.rt.prop(node, "component", name);
    const own = new Set(spec.props ?? []), eventNames = new Set((spec.events ?? []).map(name => "on" + name[0].toUpperCase() + name.slice(1)));
    const forwarded = new Proxy(props, { ownKeys: target => Reflect.ownKeys(target).filter(key => key !== "children" && !own.has(key) && !eventNames.has(key)), getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
    dom.rt.spread(node, forwarded);
    for (const key of own) dom.rt.bindProp(node, "$" + key, () => props[key]);
    if (eventNames.size) dom.rt.prop(node, "onNativeEvent", event => {
      const handler = props["on" + event.name[0].toUpperCase() + event.name.slice(1)];
      if (typeof handler === "function") handler(event.data);
    });
    return node;
  };
  nsh.nativeModule = specifier => { const namespace = modules.exports.get(specifier); if (!namespace) throw new Error(`unknown native module ${specifier}`); return namespace; };

  const mobile = modules.exports.get("nsh/mobile") ?? {};
  mobile.InputAccessoryView = () => null; // Off-iOS behavior, in the app realm.
  modules.exports.set("nsh/mobile", mobile);
  const base = modules.exports.get("nsh/base");
  if (base) base.Input = props => { const node = dom.rt.element("input"); dom.rt.spread(node, props); return node; };
}
