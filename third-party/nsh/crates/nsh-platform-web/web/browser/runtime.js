import { createWebPage } from "./page.js";

// A module given as source text, as a blob URL; its source map inline, so
// DevTools maps it.
function moduleURL(code, name, sourceMap) {
  let source = String(code);
  if (name) source += `\n//# sourceURL=${name}`;
  if (sourceMap) {
    const bytes = new TextEncoder().encode(sourceMap);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    source += `\n//# sourceMappingURL=data:application/json;base64,${btoa(binary)}`;
  }
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

// The module that stands for a native one: `names` are its exports, read
// from the realm's namespace when the module runs; those in `late` are
// live bindings, set again when a later gate registers them.
function facadeURL(specifier, names, late) {
  const key = JSON.stringify(specifier);
  const updates = [];
  const declarations = names.map((name, index) => {
    const value = `host.get(${key})[${JSON.stringify(name)}]`;
    if (!late.includes(name)) {
      if (name === "default") return `export default ${value};`;
      return `const e${index}=${value};export{e${index} as ${JSON.stringify(name)}};`;
    }
    updates.push(`e${index}=${value};`);
    return `let e${index}=${value};export{e${index} as ${JSON.stringify(name)}};`;
  });
  if (updates.length) declarations.push(`globalThis.__nsh_browser_realm.watch(()=>{${updates.join("")}});`);
  const source = `const host=globalThis.__nsh_browser_realm.modules;\n${declarations.join("\n")}`;
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

function addImportMap(doc, imports) {
  const importMap = doc.createElement("script");
  importMap.type = "importmap";
  importMap.textContent = JSON.stringify({ imports });
  doc.head.append(importMap);
}

export function createBrowserHost(player) {
  let current, pageRealmUsed = false;
  return {
    bind(wasm) {
      return Object.fromEntries(Object.entries(wasm).map(([name, value]) => [name,
        typeof value === "function" && name !== "nsh_browser_trace"
          ? (...args) => {
            const app = current;
            return app?.values ? app.values.boundary(() => value(...args), () => wasm.nsh_browser_trace()) : value(...args);
          } : value,
      ]));
    },
    imports: { value: (...args) => {
      if (!current) throw new Error("the browser host was not initialized");
      return current.imports.value(...args);
    } },
    // `owned`: blob URLs that go with the app. `nativeExports`
    // (`{ specifier: [name] }`): what the app imports by name from native
    // modules (a published app's, `web::native_exports`). Their modules
    // are made before the realm loads any module; their bindings are live,
    // so what a gate called after the start registers (a side module
    // loaded before the chunk) is filled then.
    async run(entry, { appId = "", capabilities = "", imports: moduleMap = {}, chunks = {}, nativeExports = {}, params } = {}, owned = []) {
      if (current?.stopping) throw new Error("cannot start an app during disposal");
      const [width, height] = player.reset();
      let values;
      let running = true, modules, components, animation, lists, host, frame, rejectLoad;
      // The facades' updates of their late bindings (`nativeExports`).
      const watchers = [];
      const urls = [...owned];
      const active = () => running;
      const call = (op, args) => {
        if (!active()) throw new Error("the app was disposed");
        return values.boundary(() => values.with([args], ([id]) => values.result(player.wasm.nsh_browser_call(op, id))), values.trace);
      };
      const requestPump = () => { if (active()) player.requestPump(); };
      const report = error => { try { player.showError(error?.stack ?? String(error)); } catch { console.error(error); } };
      const stopped = [];
      const app = current = {
        values: null,
        imports: null,
        hot: null,
        // The realm's `import()` (the realm compiles no code otherwise).
        importModule: null,
        stopping: false,
        stop() {
          if (!running || app.stopping) return;
          app.stopping = true;
          rejectLoad?.(new Error("the app was disposed")); rejectLoad = null;
          // Cleanup is app code: a failure must not strand promises or
          // prevent the engine and the realm from being released.
          const failures = [];
          for (const stage of stopped) { try { stage(); } catch (error) { failures.push(error); } }
          running = false;
          values?.dispose();
          frame?.remove();
          for (const url of urls) URL.revokeObjectURL(url);
          for (const error of failures) report(error);
        },
      };
      try {
        frame = document.createElement("iframe");
        frame.hidden = true;
        frame.setAttribute("aria-hidden", "true");
        player.container.append(frame);
        let realm = frame.contentWindow, doc;
        try { doc = realm.document; } catch {
          // A page with an opaque origin (a `sandbox` without
          // `allow-same-origin`) cannot reach its own frames, so the app
          // runs in the page's realm. A document keeps the modules and the
          // import map it loaded, so that realm runs one app.
          if (pageRealmUsed) throw new Error("this page has an opaque origin and runs one app; reload it to run another");
          pageRealmUsed = true;
          frame.remove();
          frame = null;
          realm = window;
          doc = document;
        }
        if (frame) {
          const baseElement = doc.createElement("base");
          // The page's URL as the player started (`player.baseURL`).
          baseElement.href = player.baseURL;
          doc.head.append(baseElement);
        }
        // Firefox and older WebKit ignore import maps after the first module
        // script. Bootstrap runs as a classic script in this realm; its
        // factories let us build the complete map before loading any module.
        const map = { ...moduleMap };
        const entryURL = new URL(entry, player.baseURL);
        // Chunks are named relative to the entry; one given as source (a
        // blob) has them relative to the page.
        const chunkBase = entryURL.protocol === "blob:" ? new URL(player.baseURL) : entryURL;
        if (chunkBase === entryURL) map[new URL("bundle.js", entryURL).href] = entryURL.href;
        for (const [id, url] of Object.entries(chunks)) map[new URL(id, chunkBase).href] = new URL(url, player.baseURL).href;
        for (const [specifier, names] of Object.entries(nativeExports)) {
          const url = facadeURL(specifier, names, names);
          urls.push(url);
          map[specifier] = url;
        }
        // Construct the facade in the app realm, so Error, Promise, Buffer,
        // typed arrays and class identities use the same intrinsics as its code.
        const scope = await new Promise((resolve, reject) => {
          let settled = false;
          const bootstrap = doc.createElement("script");
          const finish = (ok, value) => {
            if (settled) return;
            settled = true;
            realm.removeEventListener("error", failed);
            bootstrap.onload = bootstrap.onerror = null;
            if (ok) resolve(value); else reject(value);
          };
          // Classic script execution errors reach the Window, not the script's
          // error handler. Observe only this bootstrap, not unrelated page code.
          const failed = event => {
            if (event.filename !== bootstrap.src) return;
            event.preventDefault();
            finish(false, event.error ?? new Error(event.message));
          };
          rejectLoad = error => finish(false, error);
          Object.defineProperty(realm, "__nsh_browser_bootstrap", { value: scope => finish(true, scope), configurable: true });
          // Match module scripts' CORS loading so a CDN bootstrap's execution
          // errors retain their filename and original rejection value.
          bootstrap.crossOrigin = "anonymous";
          bootstrap.src = new URL("./bootstrap.js", import.meta.url).href;
          bootstrap.onerror = async () => {
            let detail = bootstrap.src;
            // A stalled probe must not hide the load failure. Stop it early.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            try {
              const response = await fetch(bootstrap.src, { cache: "no-store", signal: controller.signal });
              const type = response.headers.get("content-type") ?? "no content-type";
              detail += ` (status ${response.status}, ${type})`;
              response.body?.cancel();
            } catch (error) {
              detail += ` (fetch failed: ${error})`;
            } finally {
              clearTimeout(timer);
            }
            finish(false, new Error(`could not load the browser facade: ${detail}`));
          };
          bootstrap.onload = () => finish(false, new Error("the browser facade did not initialize"));
          realm.addEventListener("error", failed);
          try { doc.head.append(bootstrap); } catch (error) { finish(false, error); }
        });
        if (!active()) throw new Error("the app was disposed");
        rejectLoad = null;
        delete realm.__nsh_browser_bootstrap;
        const { Values, createReactive, createModules, createDom, createComponents, createGestures,
          createCanvas, createAnimation, createNavigation, createKeymap, createEnvironment, createI18n,
          createHost, createStandard, createResource, createLists, configureAPIs, createHot } = scope;
        values = new Values();
        values.trace = () => player.wasm.nsh_browser_trace();
        values.report = report;
        current.values = values;
        current.imports = values.imports(() => player.wasm.memory);
        player.wasm.nsh_browser_initialize();
        const reactive = createReactive(call, active, values);
        const dom = createDom(call, values, reactive, active, requestPump);
        const hot = app.hot = createHot(reactive, report);
        dom.setHot(hot);
        const env = createEnvironment(reactive, call, dom);
        dom.setPlatform(env.api.platform);
        const gestures = createGestures(call, values, reactive, dom, active, requestPump);
        dom.setTouches(gestures);
        dom.rt.setup = env.setup;
        const i18n = createI18n(reactive, call, env);
        dom.rt.i18n = i18n.setup;
        dom.rt.font = (uri, family) => call(404, [uri, family]);
        stopped.push(() => dom.dispose(), () => modules?.dispose(), () => host?.dispose(), () => animation?.dispose(), () => player.wasm.nsh_stop(), () => player.wasm.nsh_browser_dispose());
        const event = (name, args) => {
          if (!active()) return;
          switch (name) {
            case "hostEvent": host?.event(...args); break;
            case "hostReply": host?.reply(...args); break;
            case "bindList": lists?.bind(...args); break;
            case "event": dom.event(...args); break;
            case "reply": modules?.reply(...args); break;
            case "component": components.component(...args); break;
            case "children": components.children(...args); break;
            case "render": components.render(...args); break;
            case "unrender": components.unrender(...args); break;
            case "environment": env.update(args[0]); break;
            case "tokens": env.changedTokens(); break;
            case "animationsFinished": animation?.finished(args[0]); break;
            // A gate ran after the start (`nsh_after_gate`).
            case "registry": modules?.refresh(); for (const watcher of watchers) watcher(); break;
            default: throw new Error(`browser host event is not implemented: ${name}`);
          }
        };
        call(400, [event]);
        call(401, [appId, capabilities]);
        player.begin(width, settings => {
          player.withStrings([settings], (p, l) => player.wasm.nsh_environment(p, l));
          // `host.params`: what the page gives the app to start with.
          if (params != null) player.withStrings([JSON.stringify(params)], (p, l) => player.wasm.nsh_set_host_params?.(p, l));
          const delay = player.wasm.nsh_browser_start(width, height, player.dark ? 1 : 0, devicePixelRatio || 1);
          if (delay === -2) throw new Error("browser engine startup failed");
          return delay;
        }, true);
        // The engine's clock and a test session's sockets (`testing.js`),
        // and `fetch` through the engine's network for the app's files and
        // a test session's HTTP (`fetch.js`), in the realm's place before
        // any of the app's code runs.
        const network = !!player.testing;
        scope.installTesting(realm, call, { active, wake: requestPump, network });
        scope.installFetch(realm, call, { active, wake: requestPump, network });
        lists = createLists(call, values, reactive, dom, active, requestPump);
        dom.rt.list = lists.render;
        components = createComponents(call, values, reactive, dom);
        modules = createModules(call, values, active, requestPump, components.make);
        // A UI set a later gate registers fills this namespace in place.
        for (const specifier of Object.keys(nativeExports)) if (!modules.exports.has(specifier)) modules.exports.set(specifier, Object.create(null));
        dom.setMeasure((node, what) => modules.measure(node, what));
        animation = createAnimation(call, active, requestPump, env);
        const nsh = modules.exports.get("nsh") ?? {};
        const canvas = createCanvas(call, reactive, dom, active, requestPump);
        Object.assign(nsh, animation.api, canvas, { PanResponder: gestures.PanResponder });
        Object.assign(nsh, reactive, env.api, { List: lists.render, mount: dom.mount, resource: createResource(call, reactive, active, requestPump), keymap: createKeymap(call, reactive, dom, env.api.platform, requestPump, hot) });
        host = createHost(call, reactive, dom, env, active, nsh.host);
        nsh.host = host.host;
        configureAPIs(nsh, modules, dom, active, env);
        const page = createWebPage(reactive, player);
        // Where the app is the page, `setUrl` takes a URL of the page's
        // origin, resolved once as `history.replaceState` resolves it
        // (against the page's `<base href>`).
        if (nsh.UrlScheme && player.history) {
          scope.configureAddress(nsh.UrlScheme, {
            base: () => document.baseURI,
            origin: location.origin,
          });
        }
        const base = modules.exports.get("nsh/base");
        if (base) Object.assign(base, createNavigation(reactive, dom, env, animation.api));

        const namespaces = new Map([...modules.exports, ...createStandard(call, active)]);
        const mobile = namespaces.get("nsh/mobile") ?? {};
        mobile.isAvailable = false;
        namespaces.set("nsh/mobile", mobile);
        namespaces.set("nsh/android", { ...mobile, isAvailable: false });
        namespaces.set("nsh/ios", { ...mobile, isAvailable: false });
        namespaces.set("nsh", nsh);
        namespaces.set("nsh/web", page.exports);
        namespaces.set("nsh:rt", dom.rt);
        // Development bundles import it for `__nsh_hot`, the global their
        // modules and update scripts call.
        namespaces.set("nsh:hot", { get hot() {
          if (!Object.hasOwn(realm, "__nsh_hot")) Object.defineProperty(realm, "__nsh_hot", { value: hot.hot, configurable: true });
          return hot.hot;
        } });
        for (const [specifier, namespace] of Object.entries(env.modules)) namespaces.set(specifier, namespace);
        namespaces.set("nsh/i18n", i18n.api);
        namespaces.set("nsh/host", { host: nsh.host });
        namespaces.set("nsh/native", { nativeComponent: nsh.nativeComponent, nativeModule: nsh.nativeModule });
        namespaces.set("nsh/keymap", { keymap: nsh.keymap });
        namespaces.set("nsh/animated", animation.api);
        namespaces.set("nsh/gesture", { PanResponder: gestures.PanResponder });
        // Namespace imports and development bundles need the full module
        // catalog too. One map covers these and the late-bound exports of
        // published chunks, including browsers that accept only one map.
        for (const [specifier, namespace] of namespaces) {
          if (Object.hasOwn(nativeExports, specifier)) continue;
          const url = facadeURL(specifier, Object.keys(namespace), []);
          urls.push(url);
          map[specifier] = url;
        }
        addImportMap(doc, map);
        const finished = new Promise((resolve, reject) => {
          rejectLoad = reject;
          Object.defineProperty(realm, "__nsh_browser_realm", { value: Object.freeze({
            entry: entryURL.href, base: chunkBase.href, modules: namespaces, watch: watcher => { watchers.push(watcher); },
            setImporter: load => { app.importModule = load; },
            live: active, prepareChunk: id => player.options.prepareChunk?.(id), ready: resolve, failed: reject,
          }) });
        });
        const script = doc.createElement("script");
        script.type = "module";
        script.src = new URL("./realm.js", import.meta.url).href;
        script.onerror = () => rejectLoad?.(new Error("could not load the app realm"));
        doc.head.append(script);
        await finished;
        if (!active()) throw new Error("the app was disposed");
        rejectLoad = null;
        player.startedApp();
        requestPump();
      } catch (error) {
        if (active()) { report(error); player.hostEvents = null; }
        // A rejected startup owns only its run; a newer run may already
        // have replaced it while the old module's import was pending.
        app.stop();
        if (current === app) current = null;
        throw error;
      }
    },
    /** Runs an ES module given as source text (`run`'s options, `name` and `sourceMap`). */
    runSource(code, { name = "", sourceMap = "", ...options } = {}) {
      const url = moduleURL(code, name, sourceMap);
      return this.run(url, options, [url]);
    },
    /**
     * Applies a hot update script to the running development bundle;
     * whether it was applied in place (false: run the new bundle).
     */
    async hotUpdate(code, name, sourceMap) {
      const app = current;
      if (!app?.hot?.started || !app.importModule || app.stopping) return false;
      const url = moduleURL(code, name, sourceMap);
      try {
        const applied = await app.hot.apply(() => app.importModule(url));
        return applied && current === app && !app.stopping;
      } finally {
        URL.revokeObjectURL(url);
        if (current === app && !app.stopping) player.requestPump();
      }
    },
    stop() {
      const app = current;
      app?.stop();
      if (current === app) current = null;
    },
  };
}
