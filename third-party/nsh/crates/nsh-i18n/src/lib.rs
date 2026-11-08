//! Native Shell's languages, for the toolchain: what an app's bundle carries
//! so that it shows in the languages it lists.
//!
//! - **Language data**: what `Intl` formats a language's numbers and dates
//!   with (separators, digits, compact units, date patterns, month and day
//!   names), one file per language in `data/`. The runtime has English
//!   ([`ENGLISH`]); an app ships the other languages its `nsh.json`
//!   `locales` lists, or, without that key, the languages of its
//!   translations. A new language is a new file here.
//! - **Translations** (feature `build`, the toolchain's): the app's
//!   `locales/` files in rust-i18n's formats (`_version: 1`, a file per
//!   language, or `_version: 2`, one file with every language; YAML, JSON
//!   or TOML), read with rust-i18n.
//!
//! [`bundle_json`] writes both as the JSON the runtime takes
//! (`nsh_core::i18n`, `nsh:rt`'s `i18n`).

#[cfg(feature = "build")]
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

/// The app's translations: keys and their text, by language.
#[cfg(feature = "build")]
pub type Translations = BTreeMap<String, BTreeMap<String, String>>;

/// The directory of an app's translations, beside its `nsh.json`.
pub const LOCALES_DIR: &str = "locales";

/// English's data, which the runtime has built in.
pub const ENGLISH: &str = include_str!("../data/en.json");

/// The languages with data here an app ships (English is the runtime's
/// own: [`ENGLISH`]).
pub const LANGUAGES: &[&str] = &[
    "de", "es", "fr", "hi", "id", "it", "ja", "ko", "nl", "pl", "pt", "ru", "sv", "th", "tr", "vi",
    "zh",
];

/// The data of `language` (`"de"`, a language subtag): JSON, as the
/// runtime reads it. `None` for English (built in) and languages without
/// data.
pub fn language_data(language: &str) -> Option<&'static str> {
    Some(match language {
        "de" => include_str!("../data/de.json"),
        "es" => include_str!("../data/es.json"),
        "fr" => include_str!("../data/fr.json"),
        "hi" => include_str!("../data/hi.json"),
        "id" => include_str!("../data/id.json"),
        "it" => include_str!("../data/it.json"),
        "ja" => include_str!("../data/ja.json"),
        "ko" => include_str!("../data/ko.json"),
        "nl" => include_str!("../data/nl.json"),
        "pl" => include_str!("../data/pl.json"),
        "pt" => include_str!("../data/pt.json"),
        "ru" => include_str!("../data/ru.json"),
        "sv" => include_str!("../data/sv.json"),
        "th" => include_str!("../data/th.json"),
        "tr" => include_str!("../data/tr.json"),
        "vi" => include_str!("../data/vi.json"),
        "zh" => include_str!("../data/zh.json"),
        _ => return None,
    })
}

/// The language of a locale (`zh-Hant-TW`: `zh`), lower case.
pub fn language_of(locale: &str) -> String {
    locale
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

#[cfg(feature = "build")]
/// The translation files in `app_dir`'s `locales/` (what a development
/// session watches).
pub fn locale_files(app_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect(&app_dir.join(LOCALES_DIR), &mut files);
    files.sort();
    files
}

#[cfg(feature = "build")]
fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, files);
        } else if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("yml" | "yaml" | "json" | "toml")
        ) {
            files.push(path);
        }
    }
}

#[cfg(feature = "build")]
/// The translations in `app_dir`'s `locales/`, read as rust-i18n reads
/// them; empty without the directory.
pub fn read_translations(app_dir: &Path) -> Result<Translations, String> {
    let dir = app_dir.join(LOCALES_DIR);
    if !dir.is_dir() {
        return Ok(Translations::new());
    }
    let dir = dir.to_string_lossy();
    rust_i18n_support::try_load_locales(&dir, |_| false, true)
        .map_err(|e| format!("{LOCALES_DIR}/: {e}"))
}

#[cfg(feature = "build")]
/// The JSON of the translations alone (a Rust app's root:
/// `Root::translations_json`).
pub fn translations_json(translations: &Translations) -> String {
    serde_json::to_string(translations).unwrap_or_default()
}

#[cfg(feature = "build")]
/// What the bundle hands the runtime (`nsh:rt`'s `i18n`):
/// `{"translations": {...}, "languages": {...}}`, the data of the languages
/// `locales` lists (`nsh.json`), or, where it is `None`, of the
/// translations' languages. `None` when there is neither. A language
/// without data is reported to `warn` and formats as English.
pub fn bundle_json(
    translations: &Translations,
    locales: Option<&[String]>,
    mut warn: impl FnMut(String),
) -> Option<String> {
    let wanted: Vec<String> = match locales {
        Some(locales) => locales.to_vec(),
        None => translations.keys().cloned().collect(),
    };
    let mut languages = serde_json::Map::new();
    for locale in &wanted {
        let language = language_of(locale);
        if language == "en" || languages.contains_key(&language) {
            continue;
        }
        match language_data(&language).map(serde_json::from_str::<serde_json::Value>) {
            Some(Ok(data)) => {
                languages.insert(language, data);
            }
            Some(Err(e)) => warn(format!("language data of `{language}`: {e}")),
            None if locales.is_some() => warn(format!(
                "locales: Native Shell has no language data for `{locale}`; numbers and dates format in English"
            )),
            None => {}
        }
    }
    if translations.is_empty() && languages.is_empty() {
        return None;
    }
    let bundle = serde_json::json!({
        "translations": translations,
        "languages": languages,
    });
    Some(bundle.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_data_that_parses() {
        for language in LANGUAGES {
            let data = language_data(language).expect(language);
            let value: serde_json::Value = serde_json::from_str(data).expect(language);
            assert!(value.get("numbers").is_some(), "{language}");
            assert!(value.get("dates").is_some(), "{language}");
        }
        assert!(language_data("en").is_none());
        let english: serde_json::Value = serde_json::from_str(ENGLISH).unwrap();
        assert!(english.get("numbers").is_some() && english.get("dates").is_some());
    }

    #[cfg(feature = "build")]
    #[test]
    fn the_bundle_carries_the_listed_languages() {
        let mut translations = Translations::new();
        translations.insert(
            "zh-CN".into(),
            BTreeMap::from([("hello".into(), "你好".into())]),
        );
        let mut warnings = Vec::new();
        let json = bundle_json(&translations, None, |w| warnings.push(w)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["languages"]["zh"].is_object());
        assert_eq!(value["translations"]["zh-CN"]["hello"], "你好");
        let listed = ["de-CH".to_owned(), "en-GB".to_owned(), "xx".to_owned()];
        let json = bundle_json(&Translations::new(), Some(&listed), |w| warnings.push(w)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let languages = value["languages"].as_object().unwrap();
        assert_eq!(languages.keys().collect::<Vec<_>>(), ["de"]);
        assert_eq!(warnings.len(), 1);
        assert!(bundle_json(&Translations::new(), None, |_| {}).is_none());
    }

    #[cfg(feature = "build")]
    #[test]
    fn translations_are_read_as_rust_i18n_reads_them() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/app");
        let translations = read_translations(&dir).unwrap();
        assert_eq!(translations["en"]["hello"], "Hello");
        assert_eq!(translations["zh-CN"]["messages.hello"], "你好，%{name}");
        assert_eq!(locale_files(&dir).len(), 2);
    }
}
