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
    pub fn localized(en: &str, zh_cn: &str, zh_tw: &str) -> Self {
        Self {
            fallback: en.into(),
            translations: BTreeMap::from([
                ("zh-CN".into(), zh_cn.into()),
                ("zh-TW".into(), zh_tw.into()),
            ]),
        }
    }
    pub fn resolve(&self, locale: &str) -> &str {
        self.translations
            .get(locale)
            .or_else(|| {
                locale
                    .split_once('-')
                    .and_then(|(language, _)| self.translations.get(language))
            })
            .map_or(&self.fallback, String::as_str)
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
