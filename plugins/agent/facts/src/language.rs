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

//! Supported languages for Maka-owned copy and the user's open BCP 47 preference.

pub use maka_i18n::{BuiltinLocale, LocaleTag};
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{borrow::Cow, fmt};

/// A resolved built-in locale backed by `locales.manifest.json`.
///
/// Wire and persisted representations are canonical BCP 47 tags (for example
/// `"en"`, `"zh-CN"`, `"zh-TW"`, `"zh-HK"`, `"ja"`, `"ko"`, `"es"`, `"fr"`, `"de"`,
/// `"pt-BR"`, `"ru"`, `"it"`). Unknown valid BCP 47 tags negotiate cleanly to the
/// closest built-in locale.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Language(BuiltinLocale);

impl Language {
    pub const EN: Self = Self(BuiltinLocale::En);
    pub const ZH_CN: Self = Self(BuiltinLocale::ZhCn);
    pub const ZH_TW: Self = Self(BuiltinLocale::ZhTw);
    pub const ZH_HK: Self = Self(BuiltinLocale::ZhHk);
    pub const JA: Self = Self(BuiltinLocale::Ja);
    pub const KO: Self = Self(BuiltinLocale::Ko);
    pub const ES: Self = Self(BuiltinLocale::Es);
    pub const FR: Self = Self(BuiltinLocale::Fr);
    pub const DE: Self = Self(BuiltinLocale::De);
    pub const PT_BR: Self = Self(BuiltinLocale::PtBr);
    pub const RU: Self = Self(BuiltinLocale::Ru);
    pub const IT: Self = Self(BuiltinLocale::It);

    pub const fn all() -> [Self; BuiltinLocale::COUNT] {
        let mut out = [Self::EN; BuiltinLocale::COUNT];
        let mut i = 0;
        while i < BuiltinLocale::COUNT {
            out[i] = Self(BuiltinLocale::ALL[i]);
            i += 1;
        }
        out
    }

    pub const fn tag(self) -> &'static str {
        self.0.tag()
    }

    pub const fn is_english(&self) -> bool {
        matches!(self.0, BuiltinLocale::En)
    }

    /// Detect the current OS language negotiated against built-in locales.
    pub fn system() -> Self {
        Self(maka_i18n::negotiate_builtin(&maka_i18n::system_locales()))
    }
}

impl From<BuiltinLocale> for Language {
    fn from(locale: BuiltinLocale) -> Self {
        Self(locale)
    }
}

impl From<Language> for BuiltinLocale {
    fn from(language: Language) -> Self {
        language.0
    }
}

impl fmt::Display for Language {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.tag())
    }
}

impl Serialize for Language {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.tag())
    }
}

impl<'de> Deserialize<'de> for Language {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let tag = LocaleTag::parse(&raw).map_err(serde::de::Error::custom)?;
        Ok(Self(tag.to_builtin()))
    }
}

impl JsonSchema for Language {
    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("Language")
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 2,
            "maxLength": 35,
            "description": "Resolved canonical BCP 47 language tag (for example en, zh-CN, zh-TW, zh-HK, ja, ko, es, fr, de, pt-BR, ru, it)."
        })
    }
}

/// User or deployment language preference: automatic OS negotiation or an explicit BCP 47 tag.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum LanguagePreference {
    #[default]
    Auto,
    Tag(LocaleTag),
}

impl LanguagePreference {
    /// Normalize deployment/user locale input; empty or `"auto"` selects automatic detection.
    pub fn from_locale(locale: &str) -> Self {
        let trimmed = locale.trim();
        if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
            return Self::Auto;
        }
        match LocaleTag::parse(trimmed) {
            Ok(tag) => Self::Tag(tag),
            Err(_) => Self::Tag(LocaleTag::from_builtin(BuiltinLocale::En)),
        }
    }

    pub fn resolve(&self, native: Language) -> Language {
        match self {
            Self::Auto => native,
            Self::Tag(tag) => Language(tag.to_builtin()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Auto => "auto",
            Self::Tag(tag) => tag.as_str(),
        }
    }
}

impl Serialize for LanguagePreference {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for LanguagePreference {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        let trimmed = raw.trim();
        if trimmed.eq_ignore_ascii_case("auto") {
            return Ok(Self::Auto);
        }
        let tag = LocaleTag::parse(trimmed).map_err(serde::de::Error::custom)?;
        Ok(Self::Tag(tag))
    }
}

impl JsonSchema for LanguagePreference {
    fn schema_name() -> Cow<'static, str> {
        Cow::Borrowed("LanguagePreference")
    }

    fn json_schema(_gen: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "minLength": 2,
            "maxLength": 35,
            "description": "Language preference: \"auto\" or a canonical BCP 47 locale tag."
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_bcp47_preferences_preserve_tags_and_negotiate_all_twelve_locales() {
        assert_eq!(
            LanguagePreference::from_locale(""),
            LanguagePreference::Auto
        );
        assert_eq!(
            LanguagePreference::from_locale(" auto "),
            LanguagePreference::Auto
        );

        for (raw, expected) in [
            ("zh-Hans-CN", Language::ZH_CN),
            ("zh-Hans-TW", Language::ZH_CN),
            ("ZH_mo", Language::ZH_HK),
            ("zh", Language::ZH_CN),
            ("zh-Hant-HK", Language::ZH_HK),
            ("zh_TW.UTF-8", Language::ZH_TW),
            ("ja-JP", Language::JA),
            ("ko-KR", Language::KO),
            ("es-MX", Language::ES),
            ("fr-FR", Language::FR),
            ("de-DE", Language::DE),
            ("pt-BR", Language::PT_BR),
            ("ru-RU", Language::RU),
            ("it-IT", Language::IT),
            ("en-US", Language::EN),
        ] {
            assert_eq!(
                LanguagePreference::from_locale(raw).resolve(Language::EN),
                expected,
                "{raw}"
            );
        }

        // Backward compatibility with existing saved wire values.
        assert_eq!(
            serde_json::from_str::<LanguagePreference>(r#""auto""#).unwrap(),
            LanguagePreference::Auto
        );
        assert_eq!(
            serde_json::from_str::<LanguagePreference>(r#""zh-TW""#).unwrap(),
            LanguagePreference::Tag(LocaleTag::parse("zh-TW").unwrap())
        );
        assert_eq!(
            serde_json::from_str::<LanguagePreference>(r#""zh-HK""#).unwrap(),
            LanguagePreference::Tag(LocaleTag::parse("zh-HK").unwrap())
        );
        assert_eq!(
            serde_json::from_str::<LanguagePreference>(r#""zh-Hant-HK""#)
                .unwrap()
                .resolve(Language::EN),
            Language::ZH_HK
        );
        assert!(serde_json::from_str::<LanguagePreference>(r#""bad/locale""#).is_err());
        assert!(serde_json::from_str::<LanguagePreference>(r#""""#).is_err());
    }
}
