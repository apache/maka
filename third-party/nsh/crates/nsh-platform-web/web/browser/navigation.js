// Route state is held by the shared Rust reactive graph. Stack transitions,
// layout, back handling and modal surfaces remain in the Rust core/platform.
export function createNavigation(reactive, dom, environment, animation) {
  const { signal, computed, untracked, split, batch } = reactive;
  const rt = dom.rt, pages = new WeakSet(), popped = new WeakMap();
  const except = (props, keys) => split(props, keys)[1];
  function createNavStack(routes) {
    if (!Array.isArray(routes)) throw new TypeError("createNavStack: an array of routes");
    const entries = signal(routes.map(route => ({ route })));
    const edit = fn => { const next = untracked(entries).slice(); fn(next); entries.set(next); };
    const state = {
      routes: computed(() => entries().map(entry => entry.route)),
      push(route) { edit(next => next.push({ route })); },
      pop(count = 1) { edit(next => next.splice(Math.max(1, next.length - Math.trunc(Math.max(0, Number(count)) || 0)))); },
      popToRoot() { edit(next => next.splice(1)); },
      replace(route) { edit(next => { next.pop(); next.push({ route }); }); },
      setRoutes(routes) {
        const old = untracked(entries).slice();
        entries.set((Array.isArray(routes) ? routes : []).map(route => {
          const index = old.findIndex(entry => entry && entry.route === route);
          if (index < 0) return { route };
          const entry = old[index]; old[index] = null; return entry;
        }));
      },
      remove(route) { edit(next => { const index = next.findLastIndex(entry => entry.route === route); if (index >= 0) next.splice(index, 1); }); },
    };
    Object.defineProperty(state, "__nshEntries", { value: entries });
    return state;
  }
  function nativeInsets(topZero) {
    const reported = signal(null);
    return [computed(() => reported() ?? (topZero ? { ...environment.api.safeArea(), top: 0 } : environment.api.safeArea())),
      ({ top, right, bottom, left }) => reported.set({ top, right, bottom, left })];
  }
  const withInsets = (insets, children) => environment.insets.Provider({ value: insets, get children() { return children(); } });
  function NavPage(props) {
    const node = rt.element("screen"); pages.add(node);
    rt.spread(node, except(props, ["children", "header", "headerLeft", "headerRight", "headerTitle", "onDismiss", "onBackPress", "onInsets"]));
    const [insets, onInsets] = nativeInsets(true);
    rt.prop(node, "onInsets", onInsets);
    dom.listen(node, "onDismiss", () => { popped.get(node)?.(); props.onDismiss?.(); });
    if (props.onBackPress != null) rt.prop(node, "onBackPress", () => props.onBackPress?.());
    const parts = [["left", "headerLeft"], ["right", "headerRight"], ["title", "headerTitle"], ["header", "header"]].map(([slot, key]) => computed(() => {
      const content = props[key];
      if (content == null || content === false) return null;
      return untracked(() => { const item = rt.element("headeritem"); rt.prop(item, "headerSlot", slot); rt.insert(item, content); return item; });
    }));
    parts.push(withInsets(insets, () => props.children));
    rt.insert(node, parts);
    return node;
  }
  function NavStack(props) {
    const node = rt.element("stack");
    rt.spread(node, except(props, ["state", "children"]));
    const entries = props.state.__nshEntries;
    const rows = rt.each(entries, (read, index) => {
      const entry = untracked(read);
      const rendered = untracked(() => props.children(entry.route, index));
      const screenFor = rendered => {
        const page = pages.has(rendered) ? rendered : NavPage({ children: rendered });
        popped.set(page, () => entries.set(untracked(entries).filter(value => value !== entry)));
        return page;
      };
      return typeof rendered === "function" ? computed(() => { const value = rendered(); return untracked(() => screenFor(value)); }) : screenFor(rendered);
    });
    rt.insert(node, rows);
    return node;
  }
  function Dialog(props) {
    let closedByUser = false;
    const tick = signal(0);
    const close = reason => {
      props.onCancel?.();
      const flag = { backdropPress: "closeOnBackdropPress", swipe: "closeOnSwipe", cancel: "closeOnEscape" }[reason];
      if (props[flag] === false || closedByUser) return;
      batch(() => { props.onOpenChange?.(false, reason); closedByUser = true; tick.update(n => n + 1); });
    };
    return computed(() => {
      tick();
      if (props.open === false) { closedByUser = false; return null; }
      if (closedByUser) return null;
      return untracked(() => {
        const node = rt.element("modal");
        rt.spread(node, except(props, ["children", "style", "class", "backdropStyle", "backdropClass", "backdropTestID", "open", "animation", "onOpen", "onClose", "onCancel", "onOpenChange"]));
        const hasBackdrop = () => props.backdropClass != null || props.backdropStyle != null;
        const slide = hasBackdrop() && (props.animation == null || props.animation === "slide") && props.style?.translate == null && !environment.api.reduceMotion();
        if (slide) rt.prop(node, "animation", "fade"); else rt.bindProp(node, "animation", () => props.animation);
        const [insets, onInsets] = nativeInsets(false);
        rt.prop(node, "onInsets", onInsets);
        dom.listen(node, "onShow", () => props.onOpen?.());
        dom.listen(node, "onDismiss", () => props.onClose?.());
        dom.listen(node, "onRequestClose", e => close(e.reason === "backdropPress" || e.reason === "swipe" ? e.reason : "cancel"));
        const backdrop = rt.cond(hasBackdrop, () => {
          const view = rt.element("view");
          rt.bindProp(view, "class", () => `absolute inset-0 ${typeof props.backdropClass === "string" ? props.backdropClass : ""}`);
          rt.bindProp(view, "style", () => props.backdropStyle);
          rt.bindProp(view, "testID", () => props.backdropTestID);
          rt.prop(view, "onPress", () => close("backdropPress"));
          return view;
        });
        const popup = rt.element("view");
        rt.bindProp(popup, "class", () => props.class);
        if (slide) {
          const offset = animation.createAnimatedValue(Math.max(1, environment.api.windowSize().height));
          rt.bindProp(popup, "style", () => [props.style, { translate: [0, offset] }]);
          animation.Animated.timing(offset, { toValue: 0, duration: 320, easing: [0.2, 0.8, 0.2, 1] }).start();
        } else rt.bindProp(popup, "style", () => props.style);
        rt.insert(popup, withInsets(insets, () => props.children));
        rt.insert(node, [backdrop, popup]);
        return node;
      });
    });
  }
  return { createNavStack, NavStack, NavPage, Dialog };
}
