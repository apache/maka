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

//! Native fallback selection. Call once at activation; persisted preference remains authoritative.
use maka_agent_facts::language::Language;

pub fn native_language() -> Language {
    language_from_sources(|name| std::env::var(name).ok(), sys_locale::get_locale)
}

fn language_from_sources(
    environment: impl Fn(&str) -> Option<String>,
    system: impl FnOnce() -> Option<String>,
) -> Language {
    for name in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Some(locale) = environment(name).filter(|locale| !locale.trim().is_empty()) {
            return Language::from_locale(&locale);
        }
    }
    system()
        .as_deref()
        .map(Language::from_locale)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_precedence_and_system_fallback() {
        let resolve = |all: &str, messages: &str, lang: &str, system: &str| {
            language_from_sources(
                |name| {
                    Some(
                        match name {
                            "LC_ALL" => all,
                            "LC_MESSAGES" => messages,
                            "LANG" => lang,
                            _ => unreachable!(),
                        }
                        .into(),
                    )
                },
                || Some(system.into()),
            )
        };
        assert_eq!(resolve("en_US", "zh_TW", "zh_CN", "zh_TW"), Language::En);
        assert_eq!(resolve("", "zh_TW", "zh_CN", "en_US"), Language::ZhTw);
        assert_eq!(resolve(" ", "", "zh_CN.UTF-8", "en_US"), Language::ZhCn);
        assert_eq!(resolve("", "", "", "zh-Hant"), Language::ZhTw);
        assert_eq!(resolve("fr_FR", "zh_TW", "zh_CN", "zh_TW"), Language::En);
        assert_eq!(language_from_sources(|_| None, || None), Language::En);
    }
}
