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

//! Supported languages for Maka-owned copy and the user's saved selection.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum Language {
    #[default]
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
}

impl Language {
    pub fn is_english(&self) -> bool {
        *self == Self::En
    }

    /// Normalize native POSIX/BCP 47 locales to supported copy, falling back to English.
    pub fn from_locale(locale: &str) -> Self {
        let locale = locale.trim().split(['.', '@']).next().unwrap_or("");
        let normalized = locale.replace('_', "-").to_ascii_lowercase();
        let mut parts = normalized.split('-');
        if parts.next() != Some("zh") {
            return Self::En;
        }
        let parts: Vec<_> = parts.collect();
        if parts.contains(&"hant") {
            Self::ZhTw
        } else if parts.contains(&"hans") {
            Self::ZhCn
        } else if parts.iter().any(|part| matches!(*part, "tw" | "hk" | "mo")) {
            Self::ZhTw
        } else {
            Self::ZhCn
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum LanguagePreference {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "en")]
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
}

impl LanguagePreference {
    /// Normalize deployment locale input; saved preferences retain strict wire tags.
    pub fn from_locale(locale: &str) -> Self {
        let locale = locale.trim();
        if locale.is_empty() || locale.eq_ignore_ascii_case("auto") {
            return Self::Auto;
        }
        match Language::from_locale(locale) {
            Language::En => Self::En,
            Language::ZhCn => Self::ZhCn,
            Language::ZhTw => Self::ZhTw,
        }
    }

    pub fn resolve(self, native: Language) -> Language {
        match self {
            Self::Auto => native,
            Self::En => Language::En,
            Self::ZhCn => Language::ZhCn,
            Self::ZhTw => Language::ZhTw,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deployment_locale_aliases_normalize_without_widening_saved_preferences() {
        for (locale, expected) in [
            ("", LanguagePreference::Auto),
            (" auto ", LanguagePreference::Auto),
            ("zh-Hans-CN", LanguagePreference::ZhCn),
            ("zh-Hans-TW", LanguagePreference::ZhCn),
            ("ZH_mo", LanguagePreference::ZhTw),
            ("zh", LanguagePreference::ZhCn),
            ("zh-Hant-HK", LanguagePreference::ZhTw),
            ("zh_TW.UTF-8", LanguagePreference::ZhTw),
            ("en-US", LanguagePreference::En),
            ("fr-FR", LanguagePreference::En),
        ] {
            assert_eq!(
                LanguagePreference::from_locale(locale),
                expected,
                "{locale}"
            );
        }
        assert_eq!(Language::from_locale(""), Language::En);
        assert!(serde_json::from_str::<LanguagePreference>(r#""zh-Hant-HK""#).is_err());
        assert_eq!(
            serde_json::from_str::<LanguagePreference>(r#""zh-TW""#).unwrap(),
            LanguagePreference::ZhTw
        );
    }
}
