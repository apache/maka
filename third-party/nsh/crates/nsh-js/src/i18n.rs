//! `nsh/i18n`: the app's translations (rust-i18n's files, read when the app
//! is built: [`nsh_core::i18n`]) and the language it shows. The entry hands
//! the bundle's translations and language data over first (`nsh:rt`'s
//! `i18n`, run before any other module); `t` looks a key up in the first of
//! the user's preferred languages the app has translations in (else in
//! `locale()`'s), reading them so that what shows a text follows
//! `setLocale`.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::c_int,
    ptr,
};

use nsh_core::i18n::Translations;
use rquickjs::qjs;

use crate::{
    modules::{Export, Item, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The translations part of a context's state.
#[derive(Default)]
pub(crate) struct I18n {
    translations: RefCell<Translations>,
    /// A signal of their version (owned, made on first use): `t` reads it,
    /// so a text follows new translations (a hot update).
    version: Cell<Option<JsValue>>,
    versions: Cell<u32>,
}

impl I18n {
    /// Frees the values it holds (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        if let Some(signal) = self.version.take() {
            // SAFETY: the signal it owns; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, signal) };
        }
    }
}

fn i18n<'a>(cx: *mut JsContext) -> &'a I18n {
    // SAFETY: a projection of the state's field, reached by shared
    // reference only.
    unsafe { &(*crate::state::state(cx)).i18n }
}

fn version(cx: *mut JsContext) -> JsValue {
    let state = i18n(cx);
    match state.version.get() {
        Some(signal) => signal,
        None => {
            let signal = reactive::new_signal(cx, qjs::JS_NewFloat64(0.0));
            state.version.set(Some(signal));
            signal
        }
    }
}

/// `nsh:rt`'s `i18n(json)`: the bundle's translations and language data
/// (`{"translations": {...}, "languages": {...}}`), before anything else
/// runs. The core gets the translations too (its components' `t!`).
pub(crate) unsafe extern "C" fn setup(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(json) = crate::dom::string_arg(cx, arg(argc, argv, 0)) else {
        return UNDEFINED;
    };
    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct Bundle {
        translations: HashMap<String, HashMap<String, String>>,
        languages: serde_json::Map<String, serde_json::Value>,
    }
    let bundle: Bundle = match serde_json::from_str(&json) {
        Ok(bundle) => bundle,
        Err(e) => {
            log::warn!("locales: {e}");
            return UNDEFINED;
        }
    };
    crate::web::add_languages(cx, bundle.languages);
    let translations = Translations::from_map(bundle.translations);
    set_translations(cx, translations)
}

/// Takes in `translations`: what read a text runs again, and the core has
/// them when this turn's ops reach it.
fn set_translations(cx: *mut JsContext, translations: Translations) -> JsValue {
    let state = i18n(cx);
    state.translations.replace(translations.clone());
    let op = nsh_core::Op::Rust(nsh_core::element::RustOp {
        call: 0,
        run: nsh_core::element::RustCall::Op(Box::new(move |module| {
            module.set_translations(translations);
            Ok(Box::new(()))
        })),
    });
    if let Err(e) = crate::dom::push_op(cx, op) {
        return e;
    }
    let next = state.versions.get().wrapping_add(1);
    state.versions.set(next);
    reactive::set_signal(cx, version(cx), qjs::JS_NewFloat64(next.into()));
    UNDEFINED
}

/// The own string properties of `options` but `locale`, as `t`'s
/// arguments, and its `locale`.
fn options(cx: *mut JsContext, options: JsValue) -> (Vec<(String, String)>, Option<String>) {
    let mut args = Vec::new();
    let mut locale = None;
    // SAFETY: an inline tag check.
    if !unsafe { qjs::JS_IsObject(options) } {
        return (args, locale);
    }
    let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: an enumeration of a live object, freed below; each value
    // read is freed after its string is taken.
    unsafe {
        let flags = (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_ENUM_ONLY) as c_int;
        if qjs::JS_GetOwnPropertyNames(cx, &mut tab, &mut len, options, flags) != 0 {
            qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
            return (args, locale);
        }
        for i in 0..len as usize {
            let atom = (*tab.add(i)).atom;
            let name = qjs::JS_AtomToCStringLen(cx, ptr::null_mut(), atom);
            if name.is_null() {
                continue;
            }
            let key = std::ffi::CStr::from_ptr(name)
                .to_string_lossy()
                .into_owned();
            qjs::JS_FreeCString(cx, name);
            let value = qjs::JS_GetProperty(cx, options, atom);
            let text = crate::dom::string_arg(cx, value);
            qjs::JS_FreeValue(cx, value);
            let Some(text) = text else {
                qjs::JS_FreeValue(cx, qjs::JS_GetException(cx));
                continue;
            };
            if key == "locale" {
                locale = Some(text);
            } else {
                args.push((key, text));
            }
        }
        qjs::JS_FreePropertyEnum(cx, tab, len);
    }
    (args, locale)
}

fn string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string of `s`'s bytes.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

/// `t(key, options?)`.
unsafe extern "C" fn t(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let Some(key) = crate::dom::string_arg(cx, arg(argc, argv, 0)) else {
        return qjs::JS_EXCEPTION;
    };
    let (args, locale) = options(cx, arg(argc, argv, 1));
    // Read so that the text follows new translations and the language.
    // SAFETY: calling the signal reads (and tracks) it.
    unsafe {
        let v = qjs::JS_Call(cx, version(cx), UNDEFINED, 0, ptr::null_mut());
        qjs::JS_FreeValue(cx, v);
    }
    let translations = i18n(cx).translations.borrow().clone();
    let locale = locale.unwrap_or_else(|| {
        // The first of the user's languages the app has, else the locale.
        let (locale, languages) = crate::env::tracked_languages(cx);
        translations
            .pick(languages.iter())
            .unwrap_or(locale)
            .to_string()
    });
    let args: Vec<(&str, String)> = args.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    let text = translations.translate(&locale, &key, &args);
    string(cx, &text)
}

/// `setLocale(locale)`.
unsafe extern "C" fn set_locale(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let value = arg(argc, argv, 0);
    // SAFETY: inline tag checks.
    let locale = if unsafe { qjs::JS_IsNull(value) || qjs::JS_IsUndefined(value) } {
        None
    } else {
        let tag = crate::dom::string_arg(cx, value).unwrap_or_default();
        match nsh_core::platform::Locale::parse(&tag) {
            Some(locale) => Some(locale),
            // SAFETY: throws on a live context.
            None => unsafe {
                return qjs::JS_ThrowRangeError(
                    cx,
                    c"setLocale: expected a BCP 47 language tag (\"zh-CN\") or null".as_ptr(),
                );
            },
        }
    };
    if let Some(locale) = locale {
        crate::env::show_locale(cx, locale);
    }
    let op = nsh_core::Op::Rust(nsh_core::element::RustOp {
        call: 0,
        run: nsh_core::element::RustCall::Op(Box::new(move |module| {
            module.set_locale(locale);
            Ok(Box::new(()))
        })),
    });
    if let Err(e) = crate::dom::push_op(cx, op) {
        return e;
    }
    reactive::finish_value(cx, UNDEFINED)
}

/// `availableLocales()`.
unsafe extern "C" fn available_locales(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    // Read so that views listing locales update when translations change.
    // SAFETY: calling the signal reads (and tracks) it.
    unsafe {
        let v = qjs::JS_Call(cx, version(cx), UNDEFINED, 0, ptr::null_mut());
        qjs::JS_FreeValue(cx, v);
    }
    let locales = i18n(cx).translations.borrow().locales().to_vec();
    let mut items: Vec<JsValue> = locales.iter().map(|l| string(cx, l)).collect();
    // SAFETY: the array takes the strings.
    unsafe { qjs::JS_NewArrayFrom(cx, items.len() as c_int, items.as_mut_ptr()) }
}

fn atom_string(cx: *mut JsContext, atom: qjs::JSAtom) -> Option<String> {
    let mut len: qjs::size_t = 0;
    // SAFETY: converts a live atom to a UTF-8 string and frees the C buffer.
    unsafe {
        let ptr = qjs::JS_AtomToCStringLen(cx, &mut len, atom);
        if ptr.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), len as usize);
        let text = String::from_utf8_lossy(bytes).into_owned();
        qjs::JS_FreeCString(cx, ptr);
        Some(text)
    }
}

fn is_plain_object(cx: *mut JsContext, value: JsValue) -> bool {
    // SAFETY: inline tag and object-kind checks on a live context.
    unsafe { qjs::JS_IsObject(value) && !qjs::JS_IsArray(value) && !qjs::JS_IsFunction(cx, value) }
}

fn parse_locale_table(
    cx: *mut JsContext,
    table: JsValue,
    flags: c_int,
) -> Result<HashMap<String, String>, JsValue> {
    if !is_plain_object(cx, table) {
        // SAFETY: throws on a live context.
        return Err(unsafe {
            qjs::JS_ThrowTypeError(
                cx,
                c"addTranslations: expected an object of translations for each locale".as_ptr(),
            )
        });
    }
    let mut tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: own-property enumeration on a live object; every value and
    // the property table are freed before returning.
    unsafe {
        if qjs::JS_GetOwnPropertyNames(cx, &mut tab, &mut len, table, flags) != 0 {
            return Err(qjs::JS_EXCEPTION);
        }
        let mut texts = HashMap::with_capacity(len as usize);
        let mut error = None;
        for i in 0..len as usize {
            let atom = (*tab.add(i)).atom;
            let Some(key) = atom_string(cx, atom) else {
                error = Some(qjs::JS_EXCEPTION);
                break;
            };
            let val = qjs::JS_GetProperty(cx, table, atom);
            if qjs::JS_IsException(val) {
                error = Some(qjs::JS_EXCEPTION);
                break;
            }
            if !qjs::JS_IsString(val) {
                qjs::JS_FreeValue(cx, val);
                error = Some(qjs::JS_ThrowTypeError(
                    cx,
                    c"addTranslations: expected string translation values".as_ptr(),
                ));
                break;
            }
            let text = crate::dom::string_arg(cx, val);
            qjs::JS_FreeValue(cx, val);
            match text {
                Some(text) => {
                    texts.insert(key, text);
                }
                None => {
                    error = Some(qjs::JS_EXCEPTION);
                    break;
                }
            }
        }
        qjs::JS_FreePropertyEnum(cx, tab, len);
        match error {
            Some(e) => Err(e),
            None => Ok(texts),
        }
    }
}

/// Reads `{ [locale]: { [key]: string } }` from `value`, throwing a
/// `TypeError` for anything else.
fn parse_translations(
    cx: *mut JsContext,
    value: JsValue,
) -> Result<HashMap<String, HashMap<String, String>>, JsValue> {
    if !is_plain_object(cx, value) {
        // SAFETY: throws on a live context.
        return Err(unsafe {
            qjs::JS_ThrowTypeError(
                cx,
                c"addTranslations: expected an object of { [locale]: { [key]: string } }".as_ptr(),
            )
        });
    }
    let flags = (qjs::JS_GPN_STRING_MASK | qjs::JS_GPN_ENUM_ONLY) as c_int;
    let mut locale_tab: *mut qjs::JSPropertyEnum = ptr::null_mut();
    let mut locale_len = 0u32;
    // SAFETY: own-property enumeration on a live object; every property
    // value and the property table are freed before returning.
    unsafe {
        if qjs::JS_GetOwnPropertyNames(cx, &mut locale_tab, &mut locale_len, value, flags) != 0 {
            return Err(qjs::JS_EXCEPTION);
        }
        let mut map = HashMap::with_capacity(locale_len as usize);
        let mut error = None;
        for i in 0..locale_len as usize {
            let atom = (*locale_tab.add(i)).atom;
            let Some(locale) = atom_string(cx, atom) else {
                error = Some(qjs::JS_EXCEPTION);
                break;
            };
            let table = qjs::JS_GetProperty(cx, value, atom);
            if qjs::JS_IsException(table) {
                error = Some(qjs::JS_EXCEPTION);
                break;
            }
            let parsed = parse_locale_table(cx, table, flags);
            qjs::JS_FreeValue(cx, table);
            match parsed {
                Ok(texts) => {
                    map.insert(locale, texts);
                }
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        qjs::JS_FreePropertyEnum(cx, locale_tab, locale_len);
        match error {
            Some(e) => Err(e),
            None => Ok(map),
        }
    }
}

/// `addTranslations(translations)`.
unsafe extern "C" fn add_translations(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let map = match parse_translations(cx, arg(argc, argv, 0)) {
        Ok(map) => map,
        Err(e) => return e,
    };
    if map.is_empty() {
        return UNDEFINED;
    }
    let state = i18n(cx);
    let merged = state.translations.borrow().extend(map.clone());
    state.translations.replace(merged);
    let op = nsh_core::Op::Rust(nsh_core::element::RustOp {
        call: 0,
        run: nsh_core::element::RustCall::Op(Box::new(move |module| {
            module.add_translations(map);
            Ok(Box::new(()))
        })),
    });
    if let Err(e) = crate::dom::push_op(cx, op) {
        return e;
    }
    let next = state.versions.get().wrapping_add(1);
    state.versions.set(next);
    reactive::set_signal(cx, version(cx), qjs::JS_NewFloat64(next.into()));
    reactive::finish_value(cx, UNDEFINED)
}

/// The exports of `nsh/i18n`.
pub(crate) const EXPORTS: &[Item] = &[
    (
        "t",
        Export::Function(t, 2),
        Ts::function(
            "The text of `key` in the language the app shows: the first of the user's\npreferred languages (`localeSettings().languages`) the app has\ntranslations in, else `locale()`'s. From the app's `locales/` files (rust-i18n's formats) and any\nadded with `addTranslations`: `t(\"hello\")`,\n`t(\"messages.hello\", { name: \"Jason\" })` fills `%{name}`, and\n`{ locale: \"zh-CN\" }` asks for another language. A key a language lacks\ncomes from the language without its last subtag (`zh-Hant`, then `zh`),\nthen from English; where none has it, the text is `<locale>.<key>`.\nReading it follows the language and translations, so a view that shows\nit changes with `setLocale` and `addTranslations`.",
            &["(key: string, options?: { locale?: string; [name: string]: unknown }): string"],
        ),
    ),
    (
        "setLocale",
        Export::Function(set_locale, 1),
        Ts::function(
            "Shows the app in `locale` (a BCP 47 tag, `\"zh-CN\"`) whatever the\nuser's language: `locale()`, `t` and `Intl` follow it; `null` follows\nthe user's again.",
            &["(locale: string | null): void"],
        ),
    ),
    (
        "availableLocales",
        Export::Function(available_locales, 0),
        Ts::function(
            "The languages the app has translations in, sorted. Reading it follows\nchanges to translations (such as `addTranslations`).",
            &["(): string[]"],
        ),
    ),
    (
        "addTranslations",
        Export::Function(add_translations, 1),
        Ts::function(
            "Merges `translations` (keys and their text by language) into this\nsurface's dictionary at run time: keys of an existing language overwrite\nthose keys and leave the rest, and new languages are added. Views\nreading `t` and `availableLocales` update in place.",
            &["(translations: Record<string, Record<string, string>>): void"],
        ),
    ),
];

#[cfg(test)]
mod tests {
    use crate::Host;

    #[test]
    fn add_translations_merges_reactively_and_validates_input() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { i18n } from "nsh:rt";
            import { effect } from "nsh";
            import { addTranslations, availableLocales, t } from "nsh/i18n";

            i18n(JSON.stringify({
                translations: {
                    en: { hello: "Hello", greet: "Hello, %{name}!", keep: "Kept" },
                    zh: { hello: "你好" },
                },
                languages: {},
            }));

            const seen = [];
            effect(() => {
                seen.push([
                    t("hello"),
                    t("extra"),
                    t("hello", { locale: "fr" }),
                    availableLocales().join(","),
                ]);
            });

            // Empty object is a no-op.
            addTranslations({});
            if (seen.length !== 1) throw new Error(`expected 1 run, got ${seen.length}`);

            // Merge new locale, new key into existing locale, and overwrite existing key.
            addTranslations({
                en: { hello: "Hi", extra: "Loaded" },
                fr: { hello: "Bonjour" },
            });

            if (seen.length !== 2) throw new Error(`expected 2 runs, got ${seen.length}`);
            const [hello, extra, frHello, locales] = seen[1];
            if (hello !== "Hi") throw new Error(`hello=${hello}`);
            if (extra !== "Loaded") throw new Error(`extra=${extra}`);
            if (frHello !== "Bonjour") throw new Error(`frHello=${frHello}`);
            if (locales !== "en,fr,zh") throw new Error(`locales=${locales}`);
            if (t("keep") !== "Kept") throw new Error(`keep=${t("keep")}`);
            if (t("greet", { name: "Ada" }) !== "Hello, Ada!") throw new Error(`greet=${t("greet", { name: "Ada" })}`);
            if (t("hello", { locale: "zh" }) !== "你好") throw new Error(`zh=${t("hello", { locale: "zh" })}`);

            // Invalid arguments throw TypeError without mutating existing translations.
            for (const bad of [null, undefined, "en", 42, [], { en: null }, { en: [] }, { en: { hello: 123 } }]) {
                let threw = false;
                try {
                    addTranslations(bad);
                } catch (e) {
                    threw = e instanceof TypeError;
                }
                if (!threw) throw new Error(`expected TypeError for ${JSON.stringify(bad)}`);
            }
            if (t("hello") !== "Hi" || availableLocales().join(",") !== "en,fr,zh") {
                throw new Error("state mutated after invalid addTranslations");
            }
            "#,
        )
        .unwrap();

        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        let rust_ops = ops
            .iter()
            .filter(|op| matches!(op, nsh_core::Op::Rust(_)))
            .count();
        assert_eq!(rust_ops, 2, "expected setup + addTranslations Rust ops");
    }
}
