//! The language data: what a language (and its region) formats numbers
//! and dates with (the symbols, grouping and patterns CLDR gives them, as
//! browsers format), not CLDR itself: one JSON file per language in
//! `nsh-i18n`'s `data/`. English is built in (`nsh_i18n::ENGLISH`); the
//! others are the ones the app ships (nsh.json `locales`), which
//! [`Languages::add`] registers per VM. A language without data resolves
//! to the next requested one, then the device's, then `en-US`.
//!
//! A file holds a language's `numbers` and `dates`, every field present,
//! and `regions`: by region (`"CH"`; `""` for a tag without one) the fields
//! of `numbers` and `dates` that differ there, each replacing the
//! language's.

use std::{collections::HashMap, rc::Rc, sync::OnceLock};

use serde::Deserialize;
use serde_json::Value;

/// What a language (and its region) formats numbers with.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Numbers {
    pub(crate) decimal: String,
    pub(crate) group: String,
    /// Integer digits needed before the first separator is written, less
    /// three: 1 (`1,234`) or 2 (Spanish `1234`, `12.345`).
    pub(crate) min_grouping: u8,
    /// Groups of two after the first three (`12,34,567`, India).
    pub(crate) indian: bool,
    pub(crate) minus: String,
    /// After the number (`12%`, `12 %`).
    pub(crate) percent: String,
    /// The currency before the number (`$1.00`) or after (`1,00 €`).
    pub(crate) currency_before: bool,
    /// Between the currency and the number.
    pub(crate) currency_space: String,
    /// Compact notation: the power of ten of each unit and its suffix.
    pub(crate) compact_short: Vec<(u8, String)>,
    /// `compactDisplay: "long"` (the short ones where there are none).
    pub(crate) compact_long: Vec<(u8, String)>,
}

/// What a language formats dates and times with.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Dates {
    pub(crate) hour12: bool,
    /// 24-hour times pad the hour (`09:05`).
    pub(crate) pad_hour24: bool,
    pub(crate) am: String,
    pub(crate) pm: String,
    /// The day period before the time (`오후 3:04`).
    pub(crate) period_first: bool,
    /// Between the time and the day period after it.
    pub(crate) period_space: String,
    /// After an hour formatted alone in 24-hour time (`15 Uhr`, `15時`).
    pub(crate) hour_suffix: String,
    /// A numeric date: the fields in order and what follows each.
    pub(crate) numeric: Vec<(Field, String)>,
    /// `dateStyle: "short"` writes a two-digit year.
    #[serde(rename = "shortYear2digit")]
    pub(crate) short_year_2digit: bool,
    /// A date with a month name; `None`: written numerically.
    pub(crate) text: Option<Vec<(Field, String)>>,
    /// With `month: "long"`, where it differs (Spanish `16 de octubre de`).
    pub(crate) text_long: Option<Vec<(Field, String)>>,
    /// The weekday's place: before the date (and what follows it) or after.
    pub(crate) weekday_first: bool,
    pub(crate) weekday_sep: String,
    /// Between the date and the time.
    pub(crate) date_time_sep: String,
    /// `None`: English's ([`english_names`]).
    pub(crate) names: Option<Names>,
    /// Chinese, Japanese and Korean: months are numbers with a unit.
    pub(crate) cjk: bool,
}

/// A field of a date pattern.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Field {
    Year,
    Month,
    Day,
}

/// Month and weekday names (weekdays from Sunday).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Names {
    pub(crate) months: [String; 12],
    pub(crate) months_short: [String; 12],
    pub(crate) weekdays: [String; 7],
    pub(crate) weekdays_short: [String; 7],
}

/// A resolved locale: its tag and data (shared: formats keep a clone).
#[derive(Clone, Debug)]
pub(crate) struct Locale {
    /// As requested, without extensions (`de-AT`).
    pub(crate) tag: nsh_core::platform::Locale,
    pub(crate) numbers: Rc<Numbers>,
    pub(crate) dates: Rc<Dates>,
}

/// English's data, built into the runtime.
fn english() -> &'static Value {
    static ENGLISH: OnceLock<Value> = OnceLock::new();
    ENGLISH.get_or_init(|| serde_json::from_str(nsh_i18n::ENGLISH).expect("English data"))
}

/// English's month and weekday names, which languages without names of
/// their own use.
pub(crate) fn english_names() -> &'static Names {
    static NAMES: OnceLock<Names> = OnceLock::new();
    NAMES.get_or_init(|| Names::deserialize(&english()["dates"]["names"]).expect("English data"))
}

/// A VM's language data: English and the languages the app registered.
#[derive(Default)]
pub(crate) struct Languages {
    /// By language (`de`), as the app's bundle carries it.
    data: HashMap<String, Value>,
    /// Resolved locales by tag: `toLocaleString` resolves on every call.
    cache: HashMap<nsh_core::platform::Locale, Locale>,
}

impl Languages {
    /// Registers `languages` (by language subtag), replacing data a
    /// language had. Data that does not read (a field missing or of the
    /// wrong type, in the language or one of its regions) is left out with
    /// a warning.
    pub(crate) fn add(&mut self, languages: serde_json::Map<String, Value>) {
        for (lang, value) in languages {
            let lang = lang.to_ascii_lowercase();
            if lang == "en" {
                continue;
            }
            let regions = value
                .get("regions")
                .and_then(Value::as_object)
                .map(|r| r.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let invalid = std::iter::once(String::new())
                .chain(regions)
                .find_map(|region| read(&value, &region).err().map(|e| (region, e)));
            match invalid {
                Some((region, e)) => {
                    let at = if region.is_empty() {
                        String::new()
                    } else {
                        format!(" (region {region})")
                    };
                    log::warn!("language data of `{lang}`{at}: {e}");
                }
                None => {
                    self.data.insert(lang, value);
                }
            }
        }
        self.cache.clear();
    }

    /// Whether `tag`'s language has data.
    pub(crate) fn supported(&self, tag: &str) -> bool {
        let lang = language(tag);
        lang == "en" || self.data.contains_key(&lang)
    }

    /// The first of `requested` with data, else `default` (the device's),
    /// else `en-US`. Tags are canonicalized (`en_us` → `en-US`) and lose
    /// their extensions.
    pub(crate) fn resolve(&mut self, requested: &[String], default: &str) -> Locale {
        let tag = requested
            .iter()
            .filter_map(|t| nsh_core::platform::Locale::parse(t))
            .find(|t| self.supported(t.as_str()))
            .or_else(|| {
                nsh_core::platform::Locale::parse(default).filter(|t| self.supported(t.as_str()))
            })
            .unwrap_or_default();
        if let Some(locale) = self.cache.get(&tag) {
            return locale.clone();
        }
        let (lang, region) = (language(tag.as_str()), region(tag.as_str()));
        let value = self.data.get(&lang).unwrap_or_else(|| english());
        // Registered data was read once when added; English is the
        // runtime's own.
        let (numbers, dates) = read(value, &region)
            .or_else(|_| read(english(), &region))
            .expect("English data");
        let locale = Locale {
            tag,
            numbers: Rc::new(numbers),
            dates: Rc::new(dates),
        };
        self.cache.insert(tag, locale.clone());
        locale
    }
}

/// `data`'s numbers and dates in `region`: the language's, with the
/// region's fields over them.
fn read(data: &Value, region: &str) -> Result<(Numbers, Dates), serde_json::Error> {
    let over = data.get("regions").and_then(|r| r.get(region));
    let merged = |key: &str| {
        let mut base = data.get(key).cloned().unwrap_or(Value::Null);
        if let (Some(base), Some(Value::Object(fields))) =
            (base.as_object_mut(), over.and_then(|o| o.get(key)))
        {
            for (field, value) in fields {
                base.insert(field.clone(), value.clone());
            }
        }
        base
    };
    let mut numbers = Numbers::deserialize(merged("numbers"))?;
    if numbers.compact_long.is_empty() {
        numbers.compact_long = numbers.compact_short.clone();
    }
    let dates = Dates::deserialize(merged("dates"))?;
    Ok((numbers, dates))
}

fn language(tag: &str) -> String {
    tag.split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// The region of `tag` (`US`), or what the language implies (`zh-Hant`:
/// `TW`).
fn region(tag: &str) -> String {
    let mut region = String::new();
    let mut script = String::new();
    for part in tag.split(['-', '_']).skip(1) {
        match part.len() {
            4 if script.is_empty() => script = part.to_ascii_lowercase(),
            2 | 3 if region.is_empty() => region = part.to_ascii_uppercase(),
            _ => {}
        }
    }
    if region.is_empty() && script == "hant" {
        region.push_str("TW");
    }
    region
}

/// Every language `nsh-i18n` has data for, registered.
#[cfg(test)]
pub(crate) fn all_languages() -> Languages {
    let mut map = serde_json::Map::new();
    for lang in nsh_i18n::LANGUAGES {
        let data = nsh_i18n::language_data(lang).expect(lang);
        map.insert((*lang).to_owned(), serde_json::from_str(data).expect(lang));
    }
    let mut languages = Languages::default();
    languages.add(map);
    languages
}

/// [`Languages::resolve`] with every language registered.
#[cfg(test)]
pub(crate) fn resolve(requested: &[String], default: &str) -> Locale {
    all_languages().resolve(requested, default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locales_resolve_to_the_first_with_data() {
        let tags = |t: &[&str]| t.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            resolve(&tags(&["xx", "de_at"]), "en-US").tag.as_str(),
            "de-AT"
        );
        assert_eq!(resolve(&tags(&[]), "ja_JP").tag.as_str(), "ja-JP");
        assert_eq!(resolve(&tags(&["xx"]), "yy").tag.as_str(), "en-US");
        assert_eq!(
            resolve(&tags(&["en-US-u-nu-latn"]), "en-US").tag.as_str(),
            "en-US"
        );
        assert!(resolve(&tags(&["zh-Hant"]), "en").dates.hour12);
    }

    #[test]
    fn every_language_reads() {
        assert_eq!(all_languages().data.len(), nsh_i18n::LANGUAGES.len());
    }

    #[test]
    fn languages_without_data_resolve_to_english() {
        let mut languages = Languages::default();
        let locale = languages.resolve(&["de-DE".to_owned()], "fr-FR");
        assert_eq!(locale.tag.as_str(), "en-US");
        assert!(!languages.supported("de"));
        assert!(languages.supported("en-GB"));
        // English needs nothing registered: American without a region,
        // British elsewhere.
        assert!(languages.resolve(&["en".to_owned()], "en").dates.hour12);
        assert!(!languages.resolve(&["en-GB".to_owned()], "en").dates.hour12);
    }

    #[test]
    fn regions_override_their_language() {
        let mut languages = all_languages();
        let de = |languages: &mut Languages, tag: &str| languages.resolve(&[tag.to_owned()], "en");
        assert_eq!(de(&mut languages, "de-CH").numbers.group, "’");
        assert_eq!(de(&mut languages, "de-DE").numbers.group, ".");
        let tw = languages.resolve(&["zh-TW".to_owned()], "en");
        assert!(tw.dates.hour12 && !tw.dates.pad_hour24);
        assert_eq!(tw.numbers.compact_short[0].1, "萬");
        // Empty long units are the short ones.
        assert_eq!(tw.numbers.compact_long[0].1, "萬");
        let cn = languages.resolve(&["zh-CN".to_owned()], "en");
        assert!(!cn.dates.hour12);
        assert_eq!(cn.dates.names.as_ref().unwrap().weekdays_short[0], "周日");
    }

    #[test]
    fn data_that_does_not_read_is_left_out() {
        let mut languages = Languages::default();
        let mut map = serde_json::Map::new();
        map.insert(
            "xx".into(),
            serde_json::json!({ "numbers": {}, "dates": {} }),
        );
        languages.add(map);
        assert!(!languages.supported("xx"));
    }
}
