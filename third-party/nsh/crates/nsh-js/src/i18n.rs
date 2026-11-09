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
    let locales = i18n(cx).translations.borrow().locales().to_vec();
    let mut items: Vec<JsValue> = locales.iter().map(|l| string(cx, l)).collect();
    // SAFETY: the array takes the strings.
    unsafe { qjs::JS_NewArrayFrom(cx, items.len() as c_int, items.as_mut_ptr()) }
}

/// The exports of `nsh/i18n`.
pub(crate) const EXPORTS: &[Item] = &[
    (
        "t",
        Export::Function(t, 2),
        Ts::function(
            "The text of `key` in the language the app shows: the first of the user's\npreferred languages (`localeSettings().languages`) the app has\ntranslations in, else `locale()`'s. From the app's `locales/` files (rust-i18n's formats): `t(\"hello\")`,\n`t(\"messages.hello\", { name: \"Jason\" })` fills `%{name}`, and\n`{ locale: \"zh-CN\" }` asks for another language. A key a language lacks\ncomes from the language without its last subtag (`zh-Hant`, then `zh`),\nthen from English; where none has it, the text is `<locale>.<key>`.\nReading it follows the language, so a view that shows it changes with\n`setLocale`.",
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
            "The languages the app has translations in, sorted.",
            &["(): string[]"],
        ),
    ),
];
