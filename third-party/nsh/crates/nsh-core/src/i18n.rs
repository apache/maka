//! Translations: the app's text in each of its languages, as
//! [rust-i18n](https://github.com/longbridge/rust-i18n) has it. The app's
//! `locales/` files (rust-i18n's formats) are read when it is built and come
//! with it ([`Translations::from_json`]); [`t!`](crate::t) looks a key up in
//! the language the app shows ([`crate::element::locale`]), which
//! [`set_locale`] changes. Each surface has its own: the language of one
//! never changes another's.
//!
//! A key missing in a language is looked up as rust-i18n does: in the
//! language without its last subtag (`zh-Hant-TW`, then `zh-Hant`, then
//! `zh`), then in English; where no language has it, the text is
//! `<locale>.<key>`. `%{name}` in a text is the argument `name`.

use std::{borrow::Cow, collections::HashMap, fmt::Display, sync::Arc};

use rust_i18n::{Backend, SimpleBackend};

/// The app's translations: its text by language and key (TS: what
/// `nsh/i18n`'s `t` reads). Cheap to clone.
#[derive(Clone, Default)]
pub struct Translations(Arc<Inner>);

#[derive(Default)]
struct Inner {
    backend: SimpleBackend,
    /// The languages, sorted.
    locales: Vec<String>,
}

impl std::fmt::Debug for Translations {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("Translations")
            .field(&self.0.locales)
            .finish()
    }
}

impl PartialEq for Translations {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Translations {
    /// The translations of `json`: an object of languages, each an object of
    /// keys and their text (`{"en": {"hello": "Hello"}}`), as the build
    /// writes them from the app's `locales/` files.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let map: HashMap<String, HashMap<String, String>> =
            serde_json::from_str(json).map_err(|e| format!("translations: {e}"))?;
        Ok(Self::from_map(map))
    }

    /// The translations of `map`: keys and their text by language.
    pub fn from_map(map: HashMap<String, HashMap<String, String>>) -> Self {
        let mut locales: Vec<String> = map.keys().cloned().collect();
        locales.sort();
        let backend = map
            .into_iter()
            .map(|(locale, texts)| {
                let texts = texts
                    .into_iter()
                    .map(|(k, v)| (Cow::Owned(k), Cow::Owned(v)))
                    .collect();
                (Cow::Owned(locale), texts)
            })
            .collect();
        Translations(Arc::new(Inner { backend, locales }))
    }

    /// These translations with `map` merged in: keys of an existing language
    /// overwrite those keys and leave the rest; new languages are added.
    pub fn extend(&self, map: HashMap<String, HashMap<String, String>>) -> Self {
        if map.is_empty() {
            return self.clone();
        }
        let mut merged: HashMap<String, HashMap<String, String>> = self
            .0
            .locales
            .iter()
            .map(|locale| {
                let texts = self
                    .0
                    .backend
                    .messages_for_locale(locale)
                    .into_iter()
                    .flatten()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                (locale.clone(), texts)
            })
            .collect();
        for (locale, texts) in map {
            merged.entry(locale).or_default().extend(texts);
        }
        Self::from_map(merged)
    }

    /// The languages it has, sorted (rust-i18n's `available_locales!`).
    pub fn locales(&self) -> &[String] {
        &self.0.locales
    }

    /// The first of `languages` (the user's, most preferred first) the
    /// translations have, itself or a shorter tag of it (`de-CH` where they
    /// have `de`): the language the app's text shows in. `None` where they
    /// have none of them.
    pub fn pick(
        &self,
        languages: impl IntoIterator<Item = crate::platform::Locale>,
    ) -> Option<crate::platform::Locale> {
        let has = |tag: &str| self.0.locales.iter().any(|l| l == tag);
        languages.into_iter().find(|language| {
            let mut tag = Some(language.as_str());
            while let Some(t) = tag {
                if has(t) {
                    return true;
                }
                tag = t.rfind('-').map(|i| &t[..i]);
            }
            false
        })
    }

    /// The text of `key` in `locale`, or in the first language it falls
    /// back to that has it (the module doc); `None` where none has it.
    pub fn lookup(&self, locale: &str, key: &str) -> Option<Cow<'_, str>> {
        fallbacks(locale).find_map(|l| self.0.backend.translate(l, key))
    }

    /// The text of `key` in `locale` with `args` in its `%{name}`s, or
    /// `<locale>.<key>` where no language has it.
    pub fn translate(&self, locale: &str, key: &str, args: &[(&str, String)]) -> String {
        let Some(text) = self.lookup(locale, key) else {
            // The `<locale>.<key>` that shows is a translation that does
            // not exist yet. In a development build, where the app is
            // being written, say so — once per key, since a text is read
            // again with every render.
            #[cfg(debug_assertions)]
            missing(locale, key);
            return format!("{locale}.{key}");
        };
        if args.is_empty() {
            return text.into_owned();
        }
        let (names, values): (Vec<&str>, Vec<String>) = args.iter().cloned().unzip();
        rust_i18n::replace_patterns(&text, &names, &values)
    }
}

/// Warns of a translation that no language of the fallback has, once for
/// the key and locale: a development build's only, since the app is being
/// written and `<locale>.<key>` is what shows (a development build reads
/// a text again with every render, and once is a line, not a stream).
#[cfg(debug_assertions)]
fn missing(locale: &str, key: &str) {
    thread_local! {
        static SAID: std::cell::RefCell<std::collections::HashSet<(Box<str>, Box<str>)>> =
            Default::default();
    }
    SAID.with(|said| {
        if said
            .borrow_mut()
            .insert((locale.into(), key.into()))
        {
            log::warn!("i18n: no translation for {key:?} in {locale} (or its fallbacks); the text shows as `{locale}.{key}`");
        }
    });
}

/// `locale`, then each shorter tag (`zh-Hant-TW`, `zh-Hant`, `zh`), then
/// `en`.
fn fallbacks(locale: &str) -> impl Iterator<Item = &str> {
    let mut next = Some(locale);
    let tags = std::iter::from_fn(move || {
        let tag = next?;
        next = tag.rfind('-').map(|i| &tag[..i]);
        Some(tag)
    });
    tags.chain((locale != "en").then_some("en"))
}

/// The text of `key` in the language the app shows (or `locale`), with
/// `args` in its `%{name}`s: what [`t!`](crate::t) calls. Reading it
/// subscribes to the language and the translations, so what shows it
/// follows [`set_locale`].
#[doc(hidden)]
pub fn translate(key: &str, locale: Option<&str>, args: &[(&str, &dyn Display)]) -> String {
    let translations = crate::element::global::<Translations>().get();
    let args: Vec<(&str, String)> = args.iter().map(|(n, v)| (*n, v.to_string())).collect();
    match locale {
        Some(locale) => translations.translate(locale, key, &args),
        None => {
            let shown = shown(
                &translations,
                crate::element::locale(),
                crate::element::locale_settings().languages,
            );
            translations.translate(shown.as_str(), key, &args)
        }
    }
}

/// The language the app's text shows in: the first of the user's preferred
/// languages it has translations for, else the locale.
fn shown(
    translations: &Translations,
    locale: crate::platform::Locale,
    languages: crate::platform::Languages,
) -> crate::platform::Locale {
    translations.pick(languages.iter()).unwrap_or(locale)
}

/// The language of framework-owned text: the app's selected language, or
/// its English translation fallback. Without an app dictionary, use the
/// requested locale so a host or a hard-coded app can still select it.
pub(crate) fn text_locale(
    translations: &Translations,
    locale: crate::platform::Locale,
    languages: crate::platform::Languages,
) -> crate::platform::Locale {
    let locale = shown(translations, locale, languages);
    if translations.locales().is_empty() {
        locale
    } else {
        translations.pick([locale]).unwrap_or_default()
    }
}

/// The text of a key in the language the app shows, as rust-i18n's `t!`:
/// `t!("hello")`, `t!("messages.hello", name = "Jason")` (`%{name}` in the
/// text), `t!("hello", locale = "zh-CN")`. It returns a `String`; reading
/// it subscribes, so a view that shows it follows
/// [`set_locale`](crate::i18n::set_locale).
#[macro_export]
macro_rules! t {
    ($key:expr $(,)?) => {
        $crate::i18n::translate($key, None, &[])
    };
    ($key:expr, locale = $locale:expr $(, $name:ident = $value:expr)* $(,)?) => {
        $crate::i18n::translate(
            $key,
            Some(::core::convert::AsRef::<str>::as_ref(&$locale)),
            &[$((stringify!($name), &$value as &dyn ::core::fmt::Display)),*],
        )
    };
    ($key:expr $(, $name:ident = $value:expr)+ $(,)?) => {
        $crate::i18n::translate(
            $key,
            None,
            &[$((stringify!($name), &$value as &dyn ::core::fmt::Display)),*],
        )
    };
}

/// Shows the app in `locale` whatever the user's language (TS:
/// `setLocale`); `None` follows the user's again. [`t!`](crate::t), `Intl`
/// and [`crate::element::locale`] follow it.
pub fn set_locale(locale: Option<crate::platform::Locale>) {
    crate::element::act_locale(locale);
}

/// The languages the app has translations in, sorted (TS:
/// `availableLocales()`).
pub fn available_locales() -> Vec<String> {
    crate::element::global::<Translations>()
        .get()
        .locales()
        .to_vec()
}

/// Merges `map` into this surface's translations at run time (TS:
/// `addTranslations`): keys of an existing language overwrite those keys
/// and leave the rest, and new languages are added. Views reading
/// [`t!`](crate::t) and [`available_locales`] update in place.
pub fn add_translations(map: HashMap<String, HashMap<String, String>>) {
    if map.is_empty() {
        return;
    }
    let stored = crate::element::global::<Translations>();
    let before = stored.get_untracked();
    let next = before.extend(map);
    stored.set(next);
    crate::element::act_translations_changed(before);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translations() -> Translations {
        Translations::from_json(
            r#"{
                "en": {"hello": "Hello", "greet": "Hello, %{name}!", "only.en": "English"},
                "zh": {"hello": "你好"},
                "zh-Hant": {"hello": "妳好"}
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn keys_fall_back_as_rust_i18n_does() {
        let t = translations();
        assert_eq!(t.translate("zh-Hant-TW", "hello", &[]), "妳好");
        assert_eq!(t.translate("zh-CN", "hello", &[]), "你好");
        assert_eq!(t.translate("zh-CN", "only.en", &[]), "English");
        assert_eq!(t.translate("fr", "missing", &[]), "fr.missing");
        assert_eq!(t.locales(), ["en", "zh", "zh-Hant"]);
    }

    #[test]
    fn the_first_preferred_language_with_translations_shows() {
        let t = translations();
        let tags = |tags: &[&str]| {
            tags.iter()
                .map(|t| crate::platform::Locale::parse(t).unwrap())
                .collect::<Vec<_>>()
        };
        let pick = |tags: Vec<crate::platform::Locale>| t.pick(tags).map(|l| l.to_string());
        assert_eq!(
            pick(tags(&["de-CH", "zh-Hant-TW", "en"])).as_deref(),
            Some("zh-Hant-TW")
        );
        assert_eq!(pick(tags(&["en-GB", "zh"])).as_deref(), Some("en-GB"));
        assert_eq!(pick(tags(&["fr"])), None);
    }

    #[test]
    fn arguments_fill_their_patterns() {
        let t = translations();
        assert_eq!(
            t.translate("en", "greet", &[("name", "Jason".into())]),
            "Hello, Jason!"
        );
    }

    #[test]
    fn extend_merges_locales_and_overwrites_only_given_keys() {
        let base = translations();
        assert_eq!(base.extend(HashMap::new()), base);

        let extra = HashMap::from([
            (
                "en".to_owned(),
                HashMap::from([
                    ("hello".to_owned(), "Hi".to_owned()),
                    ("bye".to_owned(), "Goodbye".to_owned()),
                ]),
            ),
            (
                "fr".to_owned(),
                HashMap::from([("hello".to_owned(), "Bonjour".to_owned())]),
            ),
        ]);
        let merged = base.extend(extra);

        // Original is unchanged.
        assert_eq!(base.translate("en", "hello", &[]), "Hello");
        assert_eq!(base.locales(), ["en", "zh", "zh-Hant"]);

        // New locale added, existing locale keys merged, untouched keys preserved.
        assert_eq!(merged.locales(), ["en", "fr", "zh", "zh-Hant"]);
        assert_eq!(merged.translate("en", "hello", &[]), "Hi");
        assert_eq!(merged.translate("en", "bye", &[]), "Goodbye");
        assert_eq!(merged.translate("en", "only.en", &[]), "English");
        assert_eq!(
            merged.translate("en", "greet", &[("name", "Ada".into())]),
            "Hello, Ada!"
        );
        assert_eq!(merged.translate("fr", "hello", &[]), "Bonjour");
        assert_eq!(merged.translate("zh", "hello", &[]), "你好");
    }

    #[test]
    fn add_translations_updates_t_and_available_locales_reactively() {
        use std::{cell::RefCell, rc::Rc};

        let rt = crate::element::Runtime::default();
        let _entered = rt.enter();
        crate::element::global::<Translations>().set(translations());

        let seen_text = Rc::new(RefCell::new(Vec::new()));
        let seen_locales = Rc::new(RefCell::new(Vec::new()));
        let text_log = seen_text.clone();
        let locales_log = seen_locales.clone();

        let _root = crate::element::create_root(move || {
            crate::element::effect(move || {
                text_log.borrow_mut().push((
                    crate::t!("hello", locale = "en"),
                    crate::t!("extra", locale = "en"),
                    crate::t!("hello", locale = "fr"),
                ));
            });
            crate::element::effect(move || {
                locales_log.borrow_mut().push(available_locales());
            });
        });

        assert_eq!(
            *seen_text.borrow(),
            vec![(
                "Hello".to_owned(),
                "en.extra".to_owned(),
                "Hello".to_owned()
            )]
        );
        assert_eq!(
            *seen_locales.borrow(),
            vec![vec!["en".to_owned(), "zh".to_owned(), "zh-Hant".to_owned()]]
        );

        // Empty map is a no-op and does not trigger reactive updates.
        add_translations(HashMap::new());
        assert_eq!(seen_text.borrow().len(), 1);
        assert_eq!(seen_locales.borrow().len(), 1);

        add_translations(HashMap::from([
            (
                "en".to_owned(),
                HashMap::from([
                    ("hello".to_owned(), "Hi".to_owned()),
                    ("extra".to_owned(), "Loaded".to_owned()),
                ]),
            ),
            (
                "fr".to_owned(),
                HashMap::from([("hello".to_owned(), "Bonjour".to_owned())]),
            ),
        ]));

        assert_eq!(
            seen_text.borrow().last().unwrap(),
            &("Hi".to_owned(), "Loaded".to_owned(), "Bonjour".to_owned())
        );
        assert_eq!(
            seen_locales.borrow().last().unwrap(),
            &vec![
                "en".to_owned(),
                "fr".to_owned(),
                "zh".to_owned(),
                "zh-Hant".to_owned()
            ]
        );
        assert_eq!(crate::t!("only.en", locale = "en"), "English");
    }
}
