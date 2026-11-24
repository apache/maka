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

//! Invocation-owned copy for CUA documentation and recovery guidance.
use maka_agent_facts::language::Language;

#[allow(unused_imports)]
mod generated_catalog {
    include!(concat!(env!("OUT_DIR"), "/i18n_catalog.rs"));
}
pub use generated_catalog::i18n_catalog;
include!(concat!(env!("OUT_DIR"), "/i18n_docs.rs"));

#[cfg(feature = "native-desktop")]
pub(crate) fn documentation(language: Language) -> &'static str {
    let source = documentation_source(language);
    source
        .split_once("<!-- named-browser-documents -->")
        .map_or(source, |(text, _)| text)
}

#[cfg(feature = "native-desktop")]
fn documentation_source(language: Language) -> &'static str {
    i18n_docs::get(language)
}

/// Read an exact named document from the same localized source as the general API.
/// Name availability is not a capability grant or a claim that its feature is enabled.
#[cfg(feature = "native-desktop")]
pub(crate) fn named_documentation(language: Language, name: &str) -> Option<&'static str> {
    let source = documentation_source(language)
        .split_once("<!-- named-browser-documents -->")?
        .1;
    for block in source.split("<!-- browser-document: ").skip(1) {
        let (names, body) = block.split_once(" -->")?;
        let (body, _) = body.split_once("<!-- /browser-document -->")?;
        if names
            .split_ascii_whitespace()
            .any(|candidate| candidate == name)
        {
            return Some(body.strip_prefix('\n').unwrap_or(body));
        }
    }
    None
}

pub fn reset(language: Language) -> &'static str {
    i18n_catalog::repl::reset(language)
}

pub fn partial_observations(language: Language) -> &'static str {
    i18n_catalog::repl::partial_observations(language)
}

pub fn closed(language: Language) -> &'static str {
    i18n_catalog::repl::closed(language)
}

pub fn javascript_error(language: Language, message: &str) -> String {
    i18n_catalog::repl::javascript_error(language, message)
}

#[cfg(feature = "native-desktop")]
pub(crate) fn uncertain(language: Language) -> &'static str {
    i18n_catalog::driver::uncertain(language)
}

#[cfg(feature = "native-desktop")]
pub(crate) fn inactive(language: Language) -> &'static str {
    i18n_catalog::repl::inactive(language)
}

#[cfg(feature = "native-desktop")]
pub(crate) fn terminal(language: Language) -> &'static str {
    i18n_catalog::driver::terminal(language)
}

#[cfg(feature = "native-desktop")]
pub(crate) fn background_unavailable(language: Language) -> &'static str {
    i18n_catalog::driver::background_unavailable(language)
}

// CDP preserves the original error and uncertainty class; the accepted browser
// dispatch owns this warning for every unknown outcome.
#[cfg(feature = "native-desktop")]
pub(crate) fn browser_unknown(language: Language) -> &'static str {
    i18n_catalog::browser::unknown_outcome_suffix(language)
}

#[cfg(all(test, feature = "native-desktop"))]
mod named_documentation_tests {
    use super::*;

    #[test]
    fn named_lookup_is_exact_and_cannot_become_a_filesystem_path() {
        for language in Language::all() {
            assert!(named_documentation(language, "session-naming").is_some());
            assert!(named_documentation(language, "capabilities/browser/viewport").is_some());
            for missing in [
                "",
                " session-naming",
                "session-naming ",
                "Session-Naming",
                "../api",
                "__proto__",
            ] {
                assert!(
                    named_documentation(language, missing).is_none(),
                    "accepted {missing:?}"
                );
            }
            assert!(!documentation(language).contains("<!-- named-browser-documents -->"));
            assert!(!documentation(language).contains("<!-- browser-document: "));
        }
    }

    #[test]
    fn catalog_preserves_placeholders_apostrophes_and_zh_hk_overlay() {
        assert_eq!(
            i18n_catalog::desktop::window_header(Language::EN, r#""Notes""#, r#""Draft""#),
            r#"Window: "Draft", App: "Notes"."#
        );
        assert_eq!(
            i18n_catalog::browser::tab_header(Language::ZH_CN, "t1", "https://example.com"),
            "标签页 t1: https://example.com"
        );
        assert_eq!(
            i18n_catalog::browser::tab_header(Language::ZH_HK, "t1", "https://example.com"),
            "分頁 t1: https://example.com"
        );
        assert_eq!(
            javascript_error(Language::EN, "boom"),
            "Cua JavaScript error: boom"
        );
        assert_eq!(
            javascript_error(Language::ZH_TW, "boom"),
            "Cua JavaScript 錯誤：boom"
        );
        assert!(
            i18n_catalog::permission::unknown_risk_warning(Language::EN)
                .starts_with("This app's risk classification")
        );
    }
}
