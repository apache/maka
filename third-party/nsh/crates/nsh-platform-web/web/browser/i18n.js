/** `nsh/i18n` in the browser, as nsh-js's (`src/i18n.rs`): the bundle's
 * translations (`nsh:rt`'s `i18n`, run before the app's modules), `t`
 * looking a key up as rust-i18n does in the first of the user's languages
 * the app has, `setLocale`, and `addTranslations`. The engine gets
 * them too (ops 407, 408 and 409), for the core's components and the language
 * it reports. The browser's own `Intl` formats every language, so the
 * bundle's language data stays unused here. */
export function createI18n(reactive, invoke, env) {
  let translations = Object.create(null);
  const version = reactive.signal(0);
  /** `key`'s text in `locale`, each shorter tag, then English. */
  const lookup = (locale, key) => {
    for (let tag = locale; tag; tag = tag.includes("-") ? tag.slice(0, tag.lastIndexOf("-")) : "") {
      const table = Object.hasOwn(translations, tag) ? translations[tag] : undefined;
      const text = table && Object.hasOwn(table, key) ? table[key] : undefined;
      if (typeof text === "string") return text;
    }
    const en = Object.hasOwn(translations, "en") ? translations.en : undefined;
    return locale === "en" ? undefined : (en && Object.hasOwn(en, key) ? en[key] : undefined);
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
    addTranslations(map) {
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        throw new TypeError("addTranslations: expected an object of { [locale]: { [key]: string } }");
      }
      const entries = [];
      for (const [locale, table] of Object.entries(map)) {
        if (!table || typeof table !== "object" || Array.isArray(table)) {
          throw new TypeError("addTranslations: expected an object of translations for each locale");
        }
        const texts = Object.create(null);
        for (const [key, value] of Object.entries(table)) {
          if (typeof value !== "string") {
            throw new TypeError("addTranslations: expected string translation values");
          }
          texts[key] = value;
        }
        entries.push([locale, texts]);
      }
      if (!entries.length) return;
      const next = Object.create(null);
      for (const [locale, table] of Object.entries(translations)) next[locale] = table;
      const added = Object.create(null);
      for (const [locale, texts] of entries) {
        const merged = Object.create(null);
        if (Object.hasOwn(next, locale)) Object.assign(merged, next[locale]);
        Object.assign(merged, texts);
        next[locale] = merged;
        added[locale] = texts;
      }
      translations = next;
      version.update(value => value + 1);
      invoke(409, [JSON.stringify(added)]);
    },
  };
  return {
    api,
    setup(json) {
      let parsed;
      try { parsed = JSON.parse(json).translations ?? {}; } catch { return; }
      const next = Object.create(null);
      for (const [locale, table] of Object.entries(parsed)) {
        if (!table || typeof table !== "object") continue;
        const texts = Object.create(null);
        for (const [key, value] of Object.entries(table)) {
          if (typeof value === "string") texts[key] = value;
        }
        next[locale] = texts;
      }
      translations = next;
      version.update(value => value + 1);
      invoke(407, [json]);
    },
  };
}
