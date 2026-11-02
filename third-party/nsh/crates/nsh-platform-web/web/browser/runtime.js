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
    // `owned`: blob URLs that go with the app.
    async run(entry, { appId = "", capabilities = "", imports: moduleMap = {}, chunks = {} } = {}, owned = []) {
      if (current?.stopping) throw new Error("cannot start an app during disposal");
      const [width, height] = player.reset();
      let values;
      let running = true, modules, components, animation, lists, host, frame, rejectLoad;
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
          baseElement.href = document.baseURI;
          doc.head.append(baseElement);
        }
        // Construct the facade in the app realm, so Error, Promise, Buffer,
        // typed arrays and class identities use the same intrinsics as its code.
        const scope = await new Promise((resolve, reject) => {
          rejectLoad = reject;
          Object.defineProperty(realm, "__nsh_browser_bootstrap", { value: resolve, configurable: true });
          const bootstrap = doc.createElement("script");
          bootstrap.type = "module";
          bootstrap.src = new URL("./bootstrap.js", import.meta.url).href;
          bootstrap.onerror = () => reject(new Error("could not load the browser facade"));
          doc.head.append(bootstrap);
        });
        if (!active()) throw new Error("the app was disposed");
        rejectLoad = null;
        delete realm.__nsh_browser_bootstrap;
        const { Values, createReactive, createModules, createDom, createComponents, createGestures,
          createCanvas, createAnimation, createNavigation, createKeymap, createEnvironment,
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
        const gestures = createGestures(call, values, reactive, dom, active, requestPump);
        dom.setTouches(gestures);
        dom.rt.setup = env.setup;
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
            default: throw new Error(`browser host event is not implemented: ${name}`);
          }
        };
        call(400, [event]);
        call(401, [appId, capabilities]);
        player.begin(width, settings => {
          player.withStrings([settings], (p, l) => player.wasm.nsh_environment(p, l));
          const delay = player.wasm.nsh_browser_start(width, height, player.dark ? 1 : 0, devicePixelRatio || 1);
          if (delay === -2) throw new Error("browser engine startup failed");
          return delay;
        }, true);
        // The engine's clock and a test session's network, in the realm's
        // place before any of the app's code runs (`testing.js`).
        scope.installTesting(realm, call, { active, wake: requestPump, network: !!player.testing });
        lists = createLists(call, values, reactive, dom, active, requestPump);
        dom.rt.list = lists.render;
        components = createComponents(call, values, reactive, dom);
        modules = createModules(call, values, active, requestPump, components.make);
        dom.setMeasure(node => modules.measure(node));
        animation = createAnimation(call, active, requestPump, env);
        const nsh = modules.exports.get("nsh") ?? {};
        const canvas = createCanvas(call, reactive, dom, active, requestPump);
        Object.assign(nsh, animation.api, canvas, { PanResponder: gestures.PanResponder });
        Object.assign(nsh, reactive, env.api, { List: lists.render, mount: dom.mount, resource: createResource(call, reactive, active, requestPump), keymap: createKeymap(call, reactive, dom, env.api.platform, requestPump, hot) });
        host = createHost(call, reactive, dom, env, active, nsh.host);
        nsh.host = host.host;
        configureAPIs(nsh, modules, dom, active, env);
        const base = modules.exports.get("nsh/base");
        if (base) Object.assign(base, createNavigation(reactive, dom, env, animation.api));

        const namespaces = new Map([...modules.exports, ...createStandard(call, active)]);
        const mobile = namespaces.get("nsh/mobile") ?? {};
        mobile.isAvailable = false;
        namespaces.set("nsh/mobile", mobile);
        namespaces.set("nsh/android", { ...mobile, isAvailable: false });
        namespaces.set("nsh/ios", { ...mobile, isAvailable: false });
        namespaces.set("nsh", nsh);
        namespaces.set("nsh:rt", dom.rt);
        // Development bundles import it for `__nsh_hot`, the global their
        // modules and update scripts call.
        namespaces.set("nsh:hot", { get hot() {
          if (!Object.hasOwn(realm, "__nsh_hot")) Object.defineProperty(realm, "__nsh_hot", { value: hot.hot, configurable: true });
          return hot.hot;
        } });
        namespaces.set("nsh/device", Object.fromEntries(["windowSize", "colorScheme", "setColorScheme", "fontScale", "pixelRatio", "locale", "platform"].map(name => [name, nsh[name]])));
        namespaces.set("nsh/accessibility", { reduceMotion: nsh.reduceMotion, screenReaderEnabled: nsh.screenReaderEnabled });
        namespaces.set("nsh/host", { host: nsh.host });
        namespaces.set("nsh/native", { nativeComponent: nsh.nativeComponent, nativeModule: nsh.nativeModule });
        namespaces.set("nsh/keymap", { keymap: nsh.keymap });
        namespaces.set("nsh/animated", animation.api);
        namespaces.set("nsh/gesture", { PanResponder: gestures.PanResponder });
        const map = { ...moduleMap };
        const entryURL = new URL(entry, document.baseURI);
        // Chunks are named relative to the entry; one given as source (a
        // blob) has them relative to the page.
        const chunkBase = entryURL.protocol === "blob:" ? new URL(document.baseURI) : entryURL;
        if (chunkBase === entryURL) map[new URL("bundle.js", entryURL).href] = entryURL.href;
        for (const [id, url] of Object.entries(chunks)) map[new URL(id, chunkBase).href] = new URL(url, document.baseURI).href;
        for (const [specifier, namespace] of namespaces) {
          const declarations = Object.keys(namespace).map((name, index) => {
            if (name === "default") return `export default host.get(${JSON.stringify(specifier)})["default"];`;
            return `const e${index}=host.get(${JSON.stringify(specifier)})[${JSON.stringify(name)}];export{e${index} as ${JSON.stringify(name)}};`;
          }).join("\n");
          const source = `const host=globalThis.__nsh_browser_realm.modules;\n${declarations}`;
          const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          urls.push(url);
          map[specifier] = url;
        }
        const importMap = doc.createElement("script");
        importMap.type = "importmap";
        importMap.textContent = JSON.stringify({ imports: map });
        doc.head.append(importMap);
        const finished = new Promise((resolve, reject) => {
          rejectLoad = reject;
          Object.defineProperty(realm, "__nsh_browser_realm", { value: Object.freeze({
            entry: entryURL.href, base: chunkBase.href, modules: namespaces,
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
