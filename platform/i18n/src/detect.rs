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
//! Single authoritative OS locale detection across macOS, Windows, and Linux/BSD.

use crate::{negotiate_builtin_tag, normalize_bcp47};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Apple,
    Windows,
    PosixUnix,
}

const fn current_platform() -> Platform {
    if cfg!(target_vendor = "apple") {
        Platform::Apple
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::PosixUnix
    }
}

/// Ordered user-preferred BCP 47 locale tags from the current OS environment.
///
/// - MAKA_LOCALE (colon/comma-separated) provides an explicit override on every platform.
/// - On macOS and Windows, OS user preferences (sys_locale::get_locales()) are authoritative;
///   POSIX shell variables (LANG, LC_*) are ignored so terminal/Git Bash settings do not
///   override the desktop system language.
/// - On Linux/BSD, POSIX variables (LANGUAGE, LC_ALL, LC_MESSAGES, LANG) take precedence
///   before falling back to sys_locale::get_locales().
pub fn system_locales() -> Vec<String> {
    resolve_locales(
        current_platform(),
        |key| std::env::var(key).ok(),
        || sys_locale::get_locales().collect(),
    )
}

/// The best single native startup locale tag for this OS environment.
pub fn system_locale() -> String {
    select_startup_locale(&system_locales())
}

fn select_startup_locale(locales: &[String]) -> String {
    if let Some(matched) = locales
        .iter()
        .find(|tag| negotiate_builtin_tag(tag).is_some())
    {
        return matched.clone();
    }
    locales.first().cloned().unwrap_or_else(|| "en".to_owned())
}

fn push_unique(out: &mut Vec<String>, raw: &str) {
    let Some(normalized) = normalize_bcp47(raw) else {
        return;
    };
    if !out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&normalized))
    {
        out.push(normalized);
    }
}

fn push_posix(out: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let head = trimmed.split(['.', '@']).next().unwrap_or("");
    if head.eq_ignore_ascii_case("c") || head.eq_ignore_ascii_case("posix") {
        return;
    }
    push_unique(out, trimmed);
}

fn resolve_locales(
    platform: Platform,
    env: impl Fn(&str) -> Option<String>,
    os_locales: impl FnOnce() -> Vec<String>,
) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(override_val) = env("MAKA_LOCALE").filter(|s| !s.trim().is_empty()) {
        let first = override_val
            .split([':', ','])
            .map(str::trim)
            .find(|part| !part.is_empty());
        if !first.is_some_and(|part| part.eq_ignore_ascii_case("auto")) {
            for part in override_val.split([':', ',']) {
                push_posix(&mut out, part);
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    match platform {
        Platform::Apple | Platform::Windows => {
            for raw in os_locales() {
                push_posix(&mut out, &raw);
            }
        }
        Platform::PosixUnix => {
            if let Some(list) = env("LANGUAGE").filter(|s| !s.trim().is_empty()) {
                for part in list.split(':') {
                    push_posix(&mut out, part);
                }
            }
            for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
                if let Some(val) = env(key) {
                    push_posix(&mut out, &val);
                }
            }
            for raw in os_locales() {
                push_posix(&mut out, &raw);
            }
        }
    }

    if out.is_empty() {
        out.push("en".to_owned());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_and_windows_ignore_lang_and_honor_os_preferred_list() {
        let env = |key: &str| match key {
            "LANG" => Some("en_US.UTF-8".into()),
            "LC_ALL" => Some("en_US.UTF-8".into()),
            _ => None,
        };
        for platform in [Platform::Apple, Platform::Windows] {
            let locales =
                resolve_locales(platform, env, || vec!["zh-Hans-CN".into(), "en-US".into()]);
            assert_eq!(locales, vec!["zh-Hans-CN", "en-US"]);
            assert_eq!(select_startup_locale(&locales), "zh-Hans-CN");
        }
    }

    #[test]
    fn maka_locale_override_wins_on_every_platform() {
        let env = |key: &str| match key {
            "MAKA_LOCALE" => Some("zh_HK:ja_JP".into()),
            "LANG" => Some("en_US.UTF-8".into()),
            _ => None,
        };
        for platform in [Platform::Apple, Platform::Windows, Platform::PosixUnix] {
            let locales = resolve_locales(platform, env, || vec!["en-US".into()]);
            assert_eq!(locales, vec!["zh-HK", "ja-JP"]);
        }
    }

    #[test]
    fn linux_respects_posix_env_and_skips_c_posix() {
        let locales = resolve_locales(
            Platform::PosixUnix,
            |key| match key {
                "LANGUAGE" => Some("zh_Hant_HK:zh_TW:en".into()),
                "LC_ALL" => Some("C.UTF-8".into()),
                "LANG" => Some("en_US.UTF-8".into()),
                _ => None,
            },
            || vec!["de-DE".into()],
        );
        assert_eq!(locales, vec!["zh-Hant-HK", "zh-TW", "en", "en-US", "de-DE"]);
        assert_eq!(select_startup_locale(&locales), "zh-Hant-HK");
    }

    #[test]
    fn unsupported_primary_locale_falls_through_to_first_supported_preference() {
        let locales = resolve_locales(
            Platform::Apple,
            |_| None,
            || vec!["ar-SA".into(), "ja-JP".into(), "en-US".into()],
        );
        assert_eq!(locales, vec!["ar-SA", "ja-JP", "en-US"]);
        assert_eq!(select_startup_locale(&locales), "ja-JP");
    }

    #[test]
    fn maka_locale_auto_delegates_to_os_detection() {
        for raw in ["auto", "AUTO", "auto,ja"] {
            let env = |key: &str| (key == "MAKA_LOCALE").then(|| raw.into());
            let locales = resolve_locales(Platform::Apple, env, || vec!["zh-Hant-HK".into()]);
            assert_eq!(locales, vec!["zh-Hant-HK"], "{raw}");
        }
    }

    #[test]
    fn empty_or_malformed_falls_back_to_en() {
        let locales = resolve_locales(
            Platform::PosixUnix,
            |key| (key == "LANG").then(|| "POSIX".into()),
            || vec!["bad/locale".into(), "zh--TW".into()],
        );
        assert_eq!(locales, vec!["en"]);
    }
}
