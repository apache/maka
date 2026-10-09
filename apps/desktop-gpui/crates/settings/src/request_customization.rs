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

//! A connection's advanced request settings, as the form and the detail
//! edit them: the custom request headers (their values are secrets the Host
//! keeps; a saved header shows its name and keeps its value unless a new
//! one is typed) and the extra request body, a JSON object checked here
//! before anything is sent.
//!
//! The checks are the Host's (`normalizeRequestHeaderUpdates` and
//! `normalizeRequestBodyOverlay` in packages/core/src/request-customization.ts),
//! so a refusal is said at once, in words; the editor is Desktop's
//! (`RequestHeadersEditor` in
//! apps/desktop/src/renderer/settings/request-customization-editor.tsx).

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, SharedString, Styled as _, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _,
};
use host_protocol::RequestHeaderUpdate;
use serde_json::{Map, Value};
use shared::copy::models as copy;
use shared::domain_element_id;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, quiet_button};

/// `REQUEST_HEADERS_MAX_COUNT`.
pub(crate) const MAX_HEADERS: usize = 32;
const HEADER_NAME_MAX_LENGTH: usize = 128;
const HEADER_VALUE_MAX_LENGTH: usize = 8_192;
/// `REQUEST_BODY_OVERLAY_MAX_BYTES` and `_MAX_DEPTH`.
const BODY_MAX_BYTES: usize = 32 * 1_024;
const BODY_MAX_DEPTH: usize = 16;
/// The headers Maka sends itself.
const PROTECTED_HEADERS: [&str; 8] = [
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "host",
    "proxy-authorization",
    "transfer-encoding",
    "x-api-key",
];
/// Keys a body may not hold at any depth.
const UNSAFE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// A header name the Host takes: a token of at most 128 characters that
/// Maka does not send itself.
fn header_name_valid(name: &str) -> bool {
    let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c);
    !name.is_empty()
        && name.len() <= HEADER_NAME_MAX_LENGTH
        && name.chars().all(token)
        && !PROTECTED_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// A header value the Host takes: 1 to 8192 characters, tabs, printable
/// ASCII, or Latin-1.
fn header_value_valid(value: &str) -> bool {
    let count = value.chars().count();
    (1..=HEADER_VALUE_MAX_LENGTH).contains(&count)
        && value
            .chars()
            .all(|c| c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c))
}

/// The extra request body `text` holds: `None` when it is blank or `{}`,
/// the object otherwise, or `Err` when the Host would refuse it (not a
/// JSON object, nested deeper than 16 levels, over 32 KiB, or with a key
/// such as `__proto__`).
pub(crate) fn parse_body_overlay(text: &str) -> Result<Option<Map<String, Value>>, ()> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(text) else {
        return Err(());
    };
    if !object_valid(&object, 1) {
        return Err(());
    }
    let bytes = serde_json::to_vec(&object).map_err(|_| ())?.len();
    if bytes > BODY_MAX_BYTES {
        return Err(());
    }
    Ok((!object.is_empty()).then_some(object))
}

fn object_valid(object: &Map<String, Value>, depth: usize) -> bool {
    depth <= BODY_MAX_DEPTH
        && object.iter().all(|(key, value)| {
            !UNSAFE_KEYS.contains(&key.as_str()) && value_valid(value, depth + 1)
        })
}

fn value_valid(value: &Value, depth: usize) -> bool {
    match value {
        Value::Array(items) => {
            depth <= BODY_MAX_DEPTH && items.iter().all(|item| value_valid(item, depth + 1))
        }
        Value::Object(object) => object_valid(object, depth),
        _ => true,
    }
}

/// The body as the editor shows it: pretty-printed, or empty.
pub(crate) fn format_body_overlay(overlay: Option<&Map<String, Value>>) -> String {
    overlay.and_then(|overlay| serde_json::to_string_pretty(overlay).ok()).unwrap_or_default()
}

/// One header being edited: its name and value fields, and the name it
/// was saved under, which keeps its value while the name stays and no new
/// value is typed.
struct HeaderRow {
    id: u64,
    name: Entity<InputState>,
    value: Entity<InputState>,
    saved: Option<SharedString>,
}

/// Behavior and presentation owner of a custom request header list being
/// edited: a row per header (its name, its value masked, Remove) and "Add
/// header", at most 32. A saved header's value field is empty and says
/// "Keep saved value"; typing one replaces it. The owner reads what to send
/// with [`Self::updates`] (a change to a saved list) or
/// [`Self::new_headers`] (a new connection, where every header needs its
/// value).
pub(crate) struct HeadersEditor {
    key: &'static str,
    rows: Vec<HeaderRow>,
    saved: Vec<SharedString>,
    next_id: u64,
    disabled: bool,
}

impl std::fmt::Debug for HeadersEditor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeadersEditor").field("saved", &self.saved).finish_non_exhaustive()
    }
}

impl HeadersEditor {
    /// An editor identified by `key` (its element ids), with no headers.
    pub(crate) fn new(key: &'static str) -> Self {
        Self { key, rows: Vec::new(), saved: Vec::new(), next_id: 1, disabled: false }
    }

    /// Shows the saved headers `names`, each keeping its value.
    pub(crate) fn reset(
        &mut self,
        names: &[SharedString],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.rows.clear();
        self.saved = names.to_vec();
        for name in names {
            self.push_row(Some(name.clone()), window, cx);
        }
        cx.notify();
    }

    fn push_row(
        &mut self,
        saved: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let id = self.next_id;
        self.next_id += 1;
        let placeholder = if saved.is_some() {
            copy::RETAINED_HEADER_VALUE.get(cx)
        } else {
            copy::HEADER_VALUE.get(cx)
        };
        let name = cx.new(|cx| {
            let input = InputState::new(window, cx).placeholder("HTTP-Referer");
            match &saved {
                Some(saved) => input.default_value(saved.clone()),
                None => input,
            }
        });
        let value = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder(placeholder));
        self.rows.push(HeaderRow { id, name, value, saved });
    }

    /// Adds an empty row, focused, unless there are 32.
    pub(crate) fn add(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.rows.len() >= MAX_HEADERS || self.disabled {
            return;
        }
        self.push_row(None, window, cx);
        if let Some(row) = self.rows.last() {
            row.name.update(cx, |input, cx| input.focus(window, cx));
        }
        cx.notify();
    }

    /// Removes the row `id`.
    pub(crate) fn remove(&mut self, id: u64, cx: &mut Context<Self>) {
        if !self.disabled {
            self.rows.retain(|row| row.id != id);
            cx.notify();
        }
    }

    pub(crate) fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if self.disabled != disabled {
            self.disabled = disabled;
            cx.notify();
        }
    }

    /// Fills the row at `index` (a new row when it is past the end), as
    /// typing does.
    pub(crate) fn fill(
        &mut self,
        index: usize,
        name: &str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        while self.rows.len() <= index {
            self.push_row(None, window, cx);
        }
        let row = &self.rows[index];
        row.name.update(cx, |input, cx| input.set_value(name.to_owned(), window, cx));
        row.value.update(cx, |input, cx| input.set_value(value.to_owned(), window, cx));
        cx.notify();
    }

    /// Whether a row is shown at all.
    pub(crate) fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Whether the rows differ from the saved headers.
    pub(crate) fn has_changes(&self, cx: &gpui_kit::App) -> bool {
        self.rows.len() != self.saved.len()
            || self.rows.iter().zip(&self.saved).any(|(row, saved)| {
                let name = row.name.read(cx).value();
                row.saved.as_ref() != Some(saved)
                    || !row.value.read(cx).value().is_empty()
                    || !name.trim().eq_ignore_ascii_case(saved)
            })
    }

    /// The headers to send for a saved list: a row that kept its saved name
    /// and has no new value keeps the saved one. `Err` when a name or value
    /// would be refused, or two names match.
    pub(crate) fn updates(&self, cx: &gpui_kit::App) -> Result<Vec<RequestHeaderUpdate>, ()> {
        let mut updates = Vec::with_capacity(self.rows.len());
        for row in &self.rows {
            let name = row.name.read(cx).value().trim().to_owned();
            let value = row.value.read(cx).value();
            let kept = row.saved.as_deref() == Some(name.as_str()) && value.is_empty();
            if !header_name_valid(&name) {
                return Err(());
            }
            updates.push(if kept {
                RequestHeaderUpdate::keep(name)
            } else if header_value_valid(&value) {
                RequestHeaderUpdate::set(name, value.to_string())
            } else {
                return Err(());
            });
        }
        let mut names: Vec<String> =
            updates.iter().map(|update| update.name.to_ascii_lowercase()).collect();
        names.sort_unstable();
        names.dedup();
        if names.len() != updates.len() || updates.len() > MAX_HEADERS {
            return Err(());
        }
        Ok(updates)
    }

    /// The headers of a new connection, each with its value.
    pub(crate) fn new_headers(&self, cx: &gpui_kit::App) -> Result<Vec<RequestHeaderUpdate>, ()> {
        let updates = self.updates(cx)?;
        if updates.iter().any(|update| update.value.is_none()) {
            return Err(());
        }
        Ok(updates)
    }
}

impl Render for HeadersEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let key = self.key;
        let disabled = self.disabled;
        let rows = self.rows.iter().map(|row| {
            let id = row.id;
            h_flex()
                .id(domain_element_id(key, &format!("header-{id}")))
                .test_support()
                .w_full()
                .gap_2()
                .child(
                    div().flex_1().min_w_0().child(
                        Input::new(&row.name)
                            .field_fill(cx)
                            .id(domain_element_id(key, &format!("name-{id}")))
                            .aria_label(copy::HEADER_NAME.get(cx))
                            .disabled(disabled),
                    ),
                )
                .child(
                    div().flex_1().min_w_0().child(
                        Input::new(&row.value)
                            .field_fill(cx)
                            .id(domain_element_id(key, &format!("value-{id}")))
                            .aria_label(copy::HEADER_VALUE.get(cx))
                            .mask_toggle()
                            .disabled(disabled),
                    ),
                )
                .child(
                    Button::new(domain_element_id(key, &format!("remove-{id}")))
                        .ghost()
                        .small()
                        .icon(Icon::new(gpui_kit::assets::IconName::Trash))
                        .accessibility_label(copy::REMOVE_HEADER.get(cx))
                        .tooltip(copy::REMOVE_HEADER.get(cx))
                        .disabled(disabled)
                        .on_click(cx.listener(move |this, _, _, cx| this.remove(id, cx))),
                )
        });
        v_flex()
            .id(SharedString::from(key))
            .test_support()
            .w_full()
            .gap_2()
            .when(self.rows.is_empty(), |this| {
                this.child(
                    div()
                        .text_xs()
                        .text_color(cx.maka().ink_muted)
                        .child(copy::NO_REQUEST_HEADERS.get(cx)),
                )
            })
            .children(rows)
            .child(
                h_flex().child(
                    quiet_button(Button::new(domain_element_id(key, "add")), cx)
                        .label(copy::ADD_HEADER.get(cx))
                        .disabled(disabled || self.rows.len() >= MAX_HEADERS)
                        .on_click(cx.listener(|this, _, window, cx| this.add(window, cx))),
                ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn header_names_and_values_follow_the_hosts_rules() {
        for good in ["HTTP-Referer", "X-Title", "x_trace.id", "A"] {
            assert!(header_name_valid(good), "{good}");
        }
        for bad in ["", "Authorization", "x-api-key", "Has Space", "名前", &"a".repeat(129)] {
            assert!(!header_name_valid(bad), "{bad}");
        }
        assert!(header_value_valid("Maka\tdesktop é"));
        assert!(!header_value_valid(""));
        assert!(!header_value_valid("line\nbreak"));
        assert!(!header_value_valid("中文"));
    }

    #[test]
    fn a_body_is_a_json_object_the_host_takes() {
        assert_eq!(parse_body_overlay("  "), Ok(None));
        assert_eq!(parse_body_overlay("{}"), Ok(None));
        let body = parse_body_overlay(r#"{"provider": {"order": ["Anthropic"]}}"#)
            .expect("valid")
            .expect("an object");
        assert_eq!(Value::Object(body), json!({"provider": {"order": ["Anthropic"]}}));
        for bad in ["[1]", "\"text\"", "{", "{\"__proto__\": 1}", "{\"a\": {\"prototype\": 1}}"] {
            assert_eq!(parse_body_overlay(bad), Err(()), "{bad}");
        }
        let mut deep = json!(1);
        for _ in 0..16 {
            deep = json!({"a": deep});
        }
        assert!(parse_body_overlay(&deep.to_string()).is_ok(), "16 levels");
        let deeper = json!({"a": deep});
        assert_eq!(parse_body_overlay(&deeper.to_string()), Err(()), "17 levels");
        let long = json!({"a": "x".repeat(BODY_MAX_BYTES)});
        assert_eq!(parse_body_overlay(&long.to_string()), Err(()), "over 32 KiB");
    }
}
