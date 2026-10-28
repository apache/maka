export function createEnvironment(reactive, invoke, dom) {
  const initial = { window: { width: 0, height: 0 }, safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    titleBar: { height: 0, left: 0, right: 0 }, keyboard: { height: 0, duration: 0.25 },
    colorScheme: "light", fontScale: 1, pixelRatio: 1, locale: "en-US", reduceMotion: false, screenReader: false, host: false };
  const fields = Object.fromEntries(Object.entries(initial).map(([name, value]) => [name, reactive.signal(value)]));
  const tokens = reactive.signal(0);
  const insets = reactive.context(() => fields.safeArea());
  const platform = { os: "web", version: "0.0", idiom: "desktop", catalyst: false,
    select(spec) { return "web" in spec ? spec.web : this.idiom === "desktop" ? spec.desktop ?? spec.default : spec.mobile ?? spec.default; } };
  let appearance = "system", systemScheme = "light";
  const setColorScheme = scheme => {
    if (!["light", "dark", "system"].includes(scheme)) throw new TypeError('setColorScheme: expected "light", "dark" or "system"');
    appearance = scheme;
    dom.rootProp("appearance", scheme);
    fields.colorScheme.set(scheme === "system" ? systemScheme : scheme);
  };
  const api = {
    windowSize: () => fields.window(), safeArea: () => fields.safeArea(), safeAreaInsets: () => insets(),
    keyboardFrame: () => fields.keyboard(), colorScheme: () => fields.colorScheme(), setColorScheme,
    fontScale: () => fields.fontScale(), pixelRatio: () => fields.pixelRatio(), locale: () => fields.locale(),
    reduceMotion: () => fields.reduceMotion(), screenReader: () => fields.screenReader(), screenReaderEnabled: () => fields.screenReader(), platform,
    token(name) { tokens(); return invoke(402, [name, fields.colorScheme() === "dark"]); },
  };
  return {
    api, insets, host: () => fields.host(), titleBar: () => fields.titleBar(),
    update(next) {
      systemScheme = next.colorScheme;
      Object.assign(platform, { ...next.platform, version: "0.0", catalyst: false });
      reactive.batch(() => {
        for (const [name, signal] of Object.entries(fields)) {
          const value = name === "colorScheme" && appearance !== "system" ? appearance : next[name];
          const previous = reactive.untracked(signal);
          const same = previous && value && typeof value === "object"
            ? Object.keys(value).every(key => value[key] === previous[key]) : value === previous;
          if (!same) signal.set(value);
        }
      });
      dom.rootProp("layoutDirectionRtl", next.rtl);
    },
    changedTokens() { tokens.update(value => value + 1); },
    setup(tailwind, theme, scheme, statusBar) {
      if (typeof tailwind === "string") dom.rootProp("tailwindTheme", tailwind);
      if (typeof theme === "string") { dom.rootProp("uiTheme", theme); invoke(403, [theme]); tokens.update(value => value + 1); }
      if (["light", "dark", "system"].includes(scheme)) setColorScheme(scheme);
      if (typeof statusBar === "string") invoke(405, [statusBar]);
    },
  };
}
