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

//! Native startup locale shared by prompts and the workbench.
/// Normalized native startup language, shared by the bootstrap prompt and UI value.
pub fn system() -> String {
    resolve(|key| std::env::var(key).ok(), sys_locale::get_locale)
}

fn resolve(
    env: impl Fn(&str) -> Option<String>,
    platform: impl FnOnce() -> Option<String>,
) -> String {
    let value = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(env)
        .find(|s| !s.trim().is_empty())
        .or_else(platform);
    value
        .as_deref()
        .and_then(normalize)
        .unwrap_or_else(|| "en".into())
}

fn normalize(value: &str) -> Option<String> {
    let tag = value.trim().split(['.', '@']).next()?.replace('_', "-");
    if tag.eq_ignore_ascii_case("c") || tag.eq_ignore_ascii_case("posix") {
        return Some("en".into());
    }
    if tag.is_empty()
        || tag
            .split('-')
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric()))
    {
        return None;
    }
    Some(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_priority_preserves_language_script_and_region() {
        assert_eq!(
            resolve(
                |key| match key {
                    "LC_ALL" => Some("zh_Hant_HK.UTF-8".into()),
                    "LC_MESSAGES" => Some("zh_CN".into()),
                    _ => Some("en_US".into()),
                },
                || panic!("environment takes precedence")
            ),
            "zh-Hant-HK"
        );
        assert_eq!(
            resolve(
                |key| match key {
                    "LC_ALL" => Some("  ".into()),
                    "LC_MESSAGES" => Some("zh_CN.UTF-8".into()),
                    _ => Some("en_US".into()),
                },
                || None
            ),
            "zh-CN"
        );
        assert_eq!(
            resolve(|key| (key == "LANG").then(|| "de_DE.UTF-8".into()), || None),
            "de-DE"
        );
        assert_eq!(
            resolve(|_| None, || Some("zh-Hant-TW".into())),
            "zh-Hant-TW"
        );
        assert_eq!(resolve(|_| None, || None), "en");
    }

    #[test]
    fn posix_and_malformed_locales_fall_back_while_complete_valid_tags_survive() {
        for value in ["C", "C.UTF-8", "POSIX", "", "zh--TW", "bad/locale", "\n"] {
            assert_eq!(resolve(|_| Some(value.into()), || None), "en");
        }
        let complete = "a".repeat(129);
        assert_eq!(resolve(|_| Some(complete.clone()), || None), complete);
        assert_eq!(
            normalize("en_US.UTF-8@calendar=gregorian").as_deref(),
            Some("en-US")
        );
    }
}
