/** `nsh/i18n` in the browser, as nsh-js's (`src/i18n.rs`): the bundle's
 * translations (`nsh:rt`'s `i18n`, run before the app's modules), `t`
 * looking a key up as rust-i18n does in the first of the user's languages
 * the app has, and `setLocale`. The engine gets
 * both too (ops 407 and 408), for the core's components and the language
 * it reports. The browser's own `Intl` formats every language, so the
 * bundle's language data stays unused here. */
export function createI18n(reactive, invoke, env) {
  let translations = {};
  const version = reactive.signal(0);
  /** `key`'s text in `locale`, each shorter tag, then English. */
  const lookup = (locale, key) => {
    for (let tag = locale; tag; tag = tag.includes("-") ? tag.slice(0, tag.lastIndexOf("-")) : "") {
      const text = translations[tag]?.[key];
      if (typeof text === "string") return text;
    }
    return locale === "en" ? undefined : translations.en?.[key];
  };
  /** Whether the translations have `tag` or a shorter tag of it. */
  const has = tag => {
    for (; tag; tag = tag.includes("-") ? tag.slice(0, tag.lastIndexOf("-")) : "") if (Object.hasOwn(translations, tag)) return true;
    return false;
  };
  /** The first of the user's preferred languages the app has, else the locale. */
  const shown = () => env.api.localeSettings().languages.find(has) ?? env.api.locale();
  const api = {
    t(key, options) {
      key = String(key);
      version();
      const { locale = shown(), ...args } = options && typeof options === "object" ? options : {};
      const text = lookup(String(locale), key);
      if (text === undefined) return `${locale}.${key}`;
      return text.replace(/%\{(\w+)\}/g, (pattern, name) => Object.hasOwn(args, name) ? String(args[name]) : pattern);
    },
    setLocale(locale) {
      if (locale == null) { invoke(408, [null]); return; }
      let tag;
      try { [tag] = Intl.getCanonicalLocales(locale); } catch { tag = undefined; }
      if (typeof locale !== "string" || !tag) throw new RangeError('setLocale: expected a BCP 47 language tag ("zh-CN") or null');
      env.showLocale(tag);
      invoke(408, [tag]);
    },
    availableLocales: () => { version(); return Object.keys(translations).sort(); },
  };
  return {
    api,
    setup(json) {
      try { translations = JSON.parse(json).translations ?? {}; } catch { return; }
      version.update(value => value + 1);
      invoke(407, [json]);
    },
  };
}
