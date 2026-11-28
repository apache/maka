/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
//! Single source of truth for Maka locale identity, BCP 47 negotiation,
//! OS locale detection, and CLDR plural rules.

mod detect;
mod plural;

pub use detect::{system_locale, system_locales};
pub use plural::{PluralCategory, plural_category};

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{borrow::Cow, collections::BTreeMap, fmt, str::FromStr};

include!(concat!(env!("OUT_DIR"), "/manifest.rs"));

/// Maximum accepted length of a canonical BCP 47 tag.
const MAX_TAG_LEN: usize = 35;

/// A validated, canonically cased BCP 47 locale tag (e.g. en, zh-CN, zh-Hant-HK, pt-BR).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LocaleTag(String);

impl LocaleTag {
    pub fn parse(raw: &str) -> Result<Self, &'static str> {
        normalize_bcp47(raw)
            .map(Self)
            .ok_or("invalid BCP 47 locale tag")
    }

    pub fn from_builtin(locale: BuiltinLocale) -> Self {
        Self(locale.tag().to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Negotiate this open BCP 47 tag to the closest built-in locale.
    pub fn to_builtin(&self) -> BuiltinLocale {
        resolve_builtin_tag(&self.0)
    }
}

impl Default for LocaleTag {
    fn default() -> Self {
        Self::from_builtin(BuiltinLocale::default())
    }
}

impl AsRef<str> for LocaleTag {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for LocaleTag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for LocaleTag {
    type Err = &'static str;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

impl From<BuiltinLocale> for LocaleTag {
    fn from(locale: BuiltinLocale) -> Self {
        Self::from_builtin(locale)
    }
}

impl Serialize for LocaleTag {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for LocaleTag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(&raw).map_err(serde::de::Error::custom)
    }
}

impl JsonSchema for LocaleTag {
    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("LocaleTag")
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 2,
            "maxLength": 35,
            "description": "Canonical BCP 47 locale tag (for example en, zh-CN, zh-HK, ja, pt-BR)."
        })
    }
}

/// Normalize POSIX or BCP 47 locale input (stripping .charset and @modifier,
/// converting _ to -, canonicalizing subtag casing). Returns None if malformed.
pub fn normalize_bcp47(raw: &str) -> Option<String> {
    let head = raw.trim().split(['.', '@']).next()?.trim();
    if head.is_empty() || head.len() > MAX_TAG_LEN {
        return None;
    }
    let normalized = head.replace('_', "-");
    let parts: Vec<&str> = normalized.split('-').collect();
    let first = *parts.first()?;
    if !(2..=3).contains(&first.len()) || !first.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    let mut out = Vec::with_capacity(parts.len());
    out.push(first.to_ascii_lowercase());
    let mut in_extension = false;
    for (idx, part) in parts.iter().enumerate().skip(1) {
        if part.is_empty() || part.len() > 8 || !part.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        if part.len() == 1 {
            in_extension = true;
            out.push(part.to_ascii_lowercase());
        } else if in_extension {
            out.push(part.to_ascii_lowercase());
        } else if idx == 1 && part.len() == 4 && part.bytes().all(|b| b.is_ascii_alphabetic()) {
            let mut script = String::with_capacity(4);
            let mut chars = part.chars();
            if let Some(c) = chars.next() {
                script.push(c.to_ascii_uppercase());
                for rest in chars {
                    script.push(rest.to_ascii_lowercase());
                }
            }
            out.push(script);
        } else if (part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()))
            || (part.len() == 3 && part.bytes().all(|b| b.is_ascii_digit()))
        {
            out.push(part.to_ascii_uppercase());
        } else {
            out.push(part.to_ascii_lowercase());
        }
    }
    Some(out.join("-"))
}

/// Script-aware BCP 47 negotiation of a single tag to a built-in locale.
/// Returns None when the tag's language family is not among built-in locales.
pub fn negotiate_builtin_tag(locale: &str) -> Option<BuiltinLocale> {
    let normalized = normalize_bcp47(locale)?;
    if let Some(exact) = BuiltinLocale::from_exact_tag(&normalized) {
        return Some(exact);
    }
    let lower = normalized.to_ascii_lowercase();
    let mut parts = lower.split('-');
    let lang = parts.next()?;
    // Stop before BCP 47 extension / private-use singletons (u, t, x, ...).
    let rest: Vec<&str> = parts.take_while(|p| p.len() > 1).collect();

    match lang {
        "zh" => {
            if rest.contains(&"hans") {
                Some(BuiltinLocale::ZhCn)
            } else if rest.contains(&"hant") {
                if rest.iter().any(|p| matches!(*p, "hk" | "mo")) {
                    Some(BuiltinLocale::ZhHk)
                } else {
                    Some(BuiltinLocale::ZhTw)
                }
            } else if rest.iter().any(|p| matches!(*p, "hk" | "mo")) {
                Some(BuiltinLocale::ZhHk)
            } else if rest.contains(&"tw") {
                Some(BuiltinLocale::ZhTw)
            } else {
                Some(BuiltinLocale::ZhCn)
            }
        }
        "yue" => {
            if rest.contains(&"hans") {
                Some(BuiltinLocale::ZhCn)
            } else {
                Some(BuiltinLocale::ZhHk)
            }
        }
        "ja" => Some(BuiltinLocale::Ja),
        "ko" => Some(BuiltinLocale::Ko),
        "es" => Some(BuiltinLocale::Es),
        "fr" => Some(BuiltinLocale::Fr),
        "de" => Some(BuiltinLocale::De),
        "pt" => Some(BuiltinLocale::PtBr),
        "ru" => Some(BuiltinLocale::Ru),
        "it" => Some(BuiltinLocale::It),
        "en" => Some(BuiltinLocale::En),
        _ => None,
    }
}

/// Resolve a single tag to a built-in locale, falling back to BuiltinLocale::En.
pub fn resolve_builtin_tag(locale: &str) -> BuiltinLocale {
    negotiate_builtin_tag(locale).unwrap_or(BuiltinLocale::En)
}

/// Negotiate an ordered list of preferred locale tags against built-in locales.
pub fn negotiate_builtin<S: AsRef<str>>(preferred: &[S]) -> BuiltinLocale {
    preferred
        .iter()
        .find_map(|tag| negotiate_builtin_tag(tag.as_ref()))
        .unwrap_or(BuiltinLocale::En)
}

/// Resolve an open translation map (such as DisplayText or plugin localizations)
/// using script-aware BCP 47 fallback without crossing zh-Hant into zh-Hans.
fn lookup_ci<'a>(translations: &'a BTreeMap<String, String>, tag: &str) -> Option<&'a str> {
    translations.get(tag).map(String::as_str).or_else(|| {
        translations
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(tag))
            .map(|(_, v)| v.as_str())
    })
}

pub fn resolve_translation<'a>(
    translations: &'a BTreeMap<String, String>,
    fallback: &'a str,
    locale: &str,
) -> &'a str {
    if translations.is_empty() {
        return fallback;
    }
    if let Some(exact) = translations.get(locale) {
        return exact.as_str();
    }
    if let Some(normalized) = normalize_bcp47(locale) {
        if let Some(found) = lookup_ci(translations, &normalized) {
            return found;
        }
        let builtin = negotiate_builtin_tag(&normalized);
        if let Some(b) = builtin {
            if let Some(found) = lookup_ci(translations, b.tag()) {
                return found;
            }
            for candidate in b
                .fallbacks()
                .iter()
                .copied()
                .filter(|c| *c != BuiltinLocale::En)
            {
                if let Some(found) = lookup_ci(translations, candidate.tag()) {
                    return found;
                }
            }
        }
        if let Some((lang, _)) = normalized.split_once('-')
            && !lang.eq_ignore_ascii_case("zh")
            && !lang.eq_ignore_ascii_case("yue")
            && let Some(found) = lookup_ci(translations, lang)
        {
            return found;
        }
        if let Some(b) = builtin
            && b.fallbacks().contains(&BuiltinLocale::En)
            && let Some(found) = lookup_ci(translations, BuiltinLocale::En.tag())
        {
            return found;
        }
    }
    fallback
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_bcp47_and_negotiates_cjk_and_global_locales() {
        assert_eq!(
            normalize_bcp47("zh_hant_hk.UTF-8").as_deref(),
            Some("zh-Hant-HK")
        );
        assert_eq!(
            normalize_bcp47("pt_br@currency=BRL").as_deref(),
            Some("pt-BR")
        );
        assert_eq!(normalize_bcp47("bad/locale"), None);
        assert_eq!(normalize_bcp47("zh--TW"), None);

        for (raw, expected) in [
            ("zh-CN", BuiltinLocale::ZhCn),
            ("zh-Hans-CN", BuiltinLocale::ZhCn),
            ("zh-Hans-TW", BuiltinLocale::ZhCn),
            ("zh-SG", BuiltinLocale::ZhCn),
            ("zh", BuiltinLocale::ZhCn),
            ("zh-TW", BuiltinLocale::ZhTw),
            ("zh-Hant", BuiltinLocale::ZhTw),
            ("zh-Hant-TW", BuiltinLocale::ZhTw),
            ("zh-HK", BuiltinLocale::ZhHk),
            ("zh-Hant-HK", BuiltinLocale::ZhHk),
            ("zh-MO", BuiltinLocale::ZhHk),
            ("yue-Hant-HK", BuiltinLocale::ZhHk),
            ("yue-Hans", BuiltinLocale::ZhCn),
            ("ja-JP", BuiltinLocale::Ja),
            ("ko-KR", BuiltinLocale::Ko),
            ("es-MX", BuiltinLocale::Es),
            ("fr-CA", BuiltinLocale::Fr),
            ("de-AT", BuiltinLocale::De),
            ("pt-PT", BuiltinLocale::PtBr),
            ("ru-RU", BuiltinLocale::Ru),
            ("it-CH", BuiltinLocale::It),
            ("en-GB", BuiltinLocale::En),
        ] {
            assert_eq!(resolve_builtin_tag(raw), expected, "{raw}");
        }
    }

    #[test]
    fn zh_hk_falls_back_to_zh_tw_and_never_to_zh_cn() {
        let map = BTreeMap::from([
            ("zh-CN".to_owned(), "简体".to_owned()),
            ("zh-TW".to_owned(), "繁體中文（中國台灣）".to_owned()),
        ]);
        assert_eq!(
            resolve_translation(&map, "English", "zh-HK"),
            "繁體中文（中國台灣）"
        );
        assert_eq!(
            resolve_translation(&map, "English", "zh-Hant-HK"),
            "繁體中文（中國台灣）"
        );
        assert_eq!(
            resolve_translation(&map, "English", "zh-MO"),
            "繁體中文（中國台灣）"
        );

        let simplified_only = BTreeMap::from([
            ("zh".to_owned(), "简体".to_owned()),
            ("zh-CN".to_owned(), "简体".to_owned()),
        ]);
        assert_eq!(
            resolve_translation(&simplified_only, "English", "zh-HK"),
            "English"
        );
    }

    #[test]
    fn preferred_list_skips_unsupported_and_selects_first_match() {
        assert_eq!(
            negotiate_builtin(&["ar-SA", "yue-Hant-HK", "en-US"]),
            BuiltinLocale::ZhHk
        );
        assert_eq!(
            negotiate_builtin(&["sv-SE", "fr-FR", "en-US"]),
            BuiltinLocale::Fr
        );
    }
}
