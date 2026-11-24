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

//! Localizable display text; never an execution identity.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Presentation text is distinct from the stable identity used for navigation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "DisplayText")]
pub struct Text {
    pub fallback: String,
    #[serde(default)]
    pub translations: BTreeMap<String, String>,
}
impl Text {
    /// A display line from model-authored text, never executable input.
    pub fn single_line(value: &str) -> Option<Self> {
        let mut value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        value.retain(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        });
        let title = Self::plain(value);
        title.validate().ok().map(|()| title)
    }

    pub fn plain(value: impl Into<String>) -> Self {
        Self {
            fallback: value.into(),
            translations: BTreeMap::new(),
        }
    }
    /// Populate a DisplayText for every built-in locale from a catalog function.
    pub fn for_locales(mut render: impl FnMut(maka_i18n::BuiltinLocale) -> String) -> Self {
        let fallback = render(maka_i18n::BuiltinLocale::En);
        let mut translations = BTreeMap::new();
        for locale in maka_i18n::BuiltinLocale::ALL {
            if locale != maka_i18n::BuiltinLocale::En {
                translations.insert(locale.tag().to_owned(), render(locale));
            }
        }
        Self {
            fallback,
            translations,
        }
    }
    pub fn resolve(&self, locale: &str) -> &str {
        maka_i18n::resolve_translation(&self.translations, &self.fallback, locale)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid_text = |text: &str| {
            !text.trim().is_empty()
                && !text.chars().any(|c| {
                    c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
        };
        if !valid_text(&self.fallback)
            || self.translations.iter().any(|(locale, text)| {
                locale.is_empty()
                    || locale.split('-').any(|part| {
                        part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric())
                    })
                    || !valid_text(text)
            })
        {
            return Err("Invalid display title");
        }
        Ok(())
    }
}

/// Renderer keys are opaque to the runtime and confer no resource authority.
pub fn validate_presentation(key: &str) -> Result<(), &'static str> {
    if key.is_empty()
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-:/@".contains(&c))
    {
        return Err("Invalid tool presentation key");
    }
    Ok(())
}
