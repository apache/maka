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

//! Links clicked in rendered text (a reply, a file in the Files face, the
//! daily review): which ones open. gpui-kit's text view hands any address
//! to the platform by default, so a `javascript:` or `file:` link the agent
//! wrote would reach Launch Services as it is, and a `file:` link can start
//! an application. Every rendered text takes [`follow_link`] instead.

use gpui_kit::{App, ClickEvent, MouseButton, SharedString};

/// Where a clicked link opens, when it may: Desktop's `isExternalUrl`
/// (`apps/desktop/src/main/external-link-guard.ts`), which hands `http:`,
/// `https:` and `mailto:` addresses to the system and refuses every other
/// scheme (`javascript:`, `file:`) and anything that does not parse as an
/// absolute URL: a relative path or a `#fragment` resolves against nothing
/// here, as rendered text has no base.
pub fn external_link(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    matches!(url.scheme(), "http" | "https" | "mailto").then(|| url.into())
}

/// Opens a link clicked in rendered text when it is a web or mail address
/// ([`external_link`]); any other link does nothing. Which clicks follow a
/// link is the kit's own rule, which a handler replaces: the primary or
/// middle button, a key, a tap.
pub fn follow_link(href: &SharedString, event: &ClickEvent, cx: &mut App) {
    let follows = match event {
        ClickEvent::Mouse(click) => {
            matches!(click.up.button, MouseButton::Left | MouseButton::Middle)
        }
        ClickEvent::Keyboard(_) => true,
        ClickEvent::Touch(tap) => !tap.long_press,
    };
    if follows && let Some(url) = external_link(href) {
        cx.open_url(&url);
    }
}

#[cfg(test)]
mod tests {
    use super::external_link;

    #[test]
    fn only_web_and_mail_links_open() {
        assert_eq!(
            external_link("https://example.com/a b").as_deref(),
            Some("https://example.com/a%20b")
        );
        assert_eq!(external_link("HTTP://Example.com").as_deref(), Some("http://example.com/"));
        assert_eq!(
            external_link("mailto:team@example.com").as_deref(),
            Some("mailto:team@example.com")
        );
        for refused in [
            "javascript:alert(1)",
            " JavaScript:alert(1)",
            "java\nscript:alert(1)",
            "file:///etc/hosts",
            "file:///System/Applications/Calculator.app",
            "data:text/html,<script>alert(1)</script>",
            "vbscript:msgbox",
            "x-apple-systempreferences:com.apple.preference.security",
            "report.html",
            "../notes/plan.md",
            "/etc/hosts",
            "//example.com/x",
            "#section",
            "",
            "https://",
        ] {
            assert_eq!(external_link(refused), None, "{refused:?}");
        }
    }
}
