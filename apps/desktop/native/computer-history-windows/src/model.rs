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

use crate::control::{Result, is_link, validate_home};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::Path,
};
use url::{Host, Url};
use uuid::Uuid;

const MAX_CONFIG_BYTES: u64 = 256 * 1024;
const MAX_RULES: usize = 512;
const MAX_DOMAINS: usize = 64;
const MAX_TEXT_BYTES: usize = 28 * 1024;
pub const MAX_SELECTION_BYTES: usize = 8 * 1024;
const MAX_URL_BYTES: usize = 8192;
const MAX_EVENT_ID: u64 = (1_u64 << 53) - 1;

/// Worker transport only. Never persist this object without Policy::project.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub app_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_user_model_id: Option<String>,
    pub app_name: String,
    pub pid: u32,
    pub window_id: u64,
    pub title: String,
    pub url: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub text_truncated: bool,
    #[serde(default)]
    pub selection: Option<Selection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_selection: Option<ItemSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_target: Option<InputTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<Action>,
    pub source_id: String,
    pub domains: Vec<String>,
    pub secure: bool,
    pub private: bool,
    pub source_known: bool,
}

impl Snapshot {
    /// Retain source admission facts without carrying an older body observation.
    pub fn without_content(&self) -> Self {
        Self {
            text: None,
            selection: None,
            item_selection: None,
            action: None,
            text_truncated: false,
            app_id: self.app_id.clone(),
            application_user_model_id: self.application_user_model_id.clone(),
            app_name: self.app_name.clone(),
            pid: self.pid,
            window_id: self.window_id,
            title: self.title.clone(),
            url: self.url.clone(),
            input_target: self.input_target.clone(),
            source_id: self.source_id.clone(),
            domains: self.domains.clone(),
            secure: self.secure,
            private: self.private,
            source_known: self.source_known,
        }
    }
}

/// Worker-only identity. UIA targets use their real native focus host, which
/// can equal the top-level window; admission additionally requires a live lease.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputTarget {
    pub hwnd: u64,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uia: Option<UiaTarget>,
}

/// Opaque comparison-only identities, never persisted or interpreted as text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiaTarget {
    #[serde(deserialize_with = "runtime_id")]
    pub runtime_id: Vec<i32>,
    /// Empty only when the admitted native tree has no owning web Document.
    #[serde(deserialize_with = "runtime_id")]
    pub document_runtime_id: Vec<i32>,
}

impl UiaTarget {
    pub fn is_valid(&self) -> bool {
        !self.runtime_id.is_empty()
            && self.runtime_id.len() <= 32
            && self.document_runtime_id.len() <= 32
    }
}

fn runtime_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<i32>, D::Error> {
    struct RuntimeId;
    impl<'de> serde::de::Visitor<'de> for RuntimeId {
        type Value = Vec<i32>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("at most 32 opaque runtime ID integers")
        }

        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut sequence: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut values = Vec::new();
            while let Some(value) = sequence.next_element::<i32>()? {
                if values.len() == 32 {
                    return Err(serde::de::Error::custom(
                        "UIA runtime ID exceeds 32 integers",
                    ));
                }
                values.push(value);
            }
            Ok(values)
        }
    }
    deserializer.deserialize_seq(RuntimeId)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Keyboard {
        key: String,
        modifiers: Vec<String>,
    },
    Mouse {
        button: String,
        modifiers: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_text: Option<String>,
    #[serde(default)]
    pub truncated: bool,
    /// Offset and optional original length in UTF-16 units, independent of text clipping.
    pub start: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u32>,
}

/// Worker-only selection membership. Acquisition must admit the complete
/// selected subtrees and revalidate their source before supplying sampled values.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemSelection {
    #[serde(deserialize_with = "runtime_id")]
    pub owner_runtime_id: Vec<i32>,
    /// Empty only for a native tree without an owning remote document.
    #[serde(deserialize_with = "runtime_id")]
    pub document_runtime_id: Vec<i32>,
    pub items: Vec<SelectedItem>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedItem {
    #[serde(deserialize_with = "runtime_id")]
    pub runtime_id: Vec<i32>,
    pub role: String,
    /// Bounded sampled content from admitted leaves, never a container aggregate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl ItemSelection {
    fn project(&self, capture_text: bool, remote: bool) -> Option<(Value, usize)> {
        if self.owner_runtime_id.is_empty()
            || self.owner_runtime_id.len() > 32
            || self.document_runtime_id.len() > 32
            || (remote && self.document_runtime_id.is_empty())
            || self.items.len() > 32
        {
            return None;
        }
        let mut items = Vec::with_capacity(self.items.len());
        for (index, item) in self.items.iter().enumerate() {
            if item.runtime_id.is_empty()
                || item.runtime_id.len() > 32
                || item.runtime_id == self.owner_runtime_id
                || item.runtime_id == self.document_runtime_id
                || self.items[..index]
                    .iter()
                    .any(|previous| previous.runtime_id == item.runtime_id)
                || !matches!(
                    item.role.as_str(),
                    "AXRow"
                        | "AXCell"
                        | "AXGroup"
                        | "AXStaticText"
                        | "AXTextField"
                        | "AXTextArea"
                        | "AXButton"
                        | "AXCheckBox"
                        | "AXRadioButton"
                        | "AXMenuItem"
                        | "AXImage"
                        | "AXLink"
                        | "AXList"
                        | "AXOutline"
                        | "AXTable"
                        | "AXScrollArea"
                        | "AXTabGroup"
                        | "AXComboBox"
                )
            {
                return None;
            }
            let mut projected = json!({ "role": item.role });
            if capture_text && let Some(value) = &item.value {
                if value.len() > MAX_SELECTION_BYTES {
                    return None;
                }
                projected["value"] = json!(bounded(value, MAX_SELECTION_BYTES, true).0);
            }
            items.push(projected);
        }
        // Reject overflow instead of silently dropping later selection members.
        let items = Value::Array(items);
        let bytes = serde_json::to_vec(&items).ok()?.len();
        (bytes <= MAX_SELECTION_BYTES).then_some((items, bytes))
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Behavior {
    Observe,
    DoNotObserve,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "scope", rename_all = "lowercase", deny_unknown_fields)]
enum Rule {
    Application {
        #[serde(rename = "bundleID")]
        app_id: String,
    },
    Url {
        #[serde(rename = "urlDomain")]
        domain: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    default_application_behavior: Behavior,
    #[serde(rename = "defaultURLBehavior")]
    default_url_behavior: Behavior,
    allowlist: Vec<Rule>,
    blocklist: Vec<Rule>,
}

/// A successfully loaded policy is required for every persistence operation.
/// There is deliberately no permissive Default implementation.
#[derive(Debug)]
pub struct Policy {
    observation: Observation,
    pub capture_text: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    observation: Observation,
    capture_text: bool,
    #[serde(default, rename = "showMenuBarIcon")]
    _show_menu_bar_icon: bool,
}

impl Policy {
    /// Reads main's config.json. Missing, oversized, linked or malformed files
    /// are errors; callers must stop admission instead of retaining an old policy.
    pub fn load(home: &Path) -> Result<Self> {
        validate_home(home)?;
        let path = home.join("config.json");
        let bytes = read_regular(&path, MAX_CONFIG_BYTES)?;
        let config: Config =
            serde_json::from_slice(&bytes).map_err(|_| "invalid_history_config")?;
        let mut policy = Self {
            observation: config.observation,
            capture_text: config.capture_text,
        };
        if policy.observation.allowlist.len() > MAX_RULES
            || policy.observation.blocklist.len() > MAX_RULES
        {
            return Err("invalid_history_config".into());
        }
        for rule in policy
            .observation
            .allowlist
            .iter_mut()
            .chain(policy.observation.blocklist.iter_mut())
        {
            match rule {
                Rule::Application { app_id } => {
                    // Main can retain exclusions for other operating systems.
                    let normalized = application_id(app_id).ok_or("invalid_history_config")?;
                    if normalized.starts_with("win32.")
                        && windows_application_id(&normalized).is_none()
                    {
                        return Err("invalid_history_config".into());
                    }
                    *app_id = normalized;
                }
                Rule::Url { domain } => {
                    *domain = domain_name(domain).ok_or("invalid_history_config")?;
                }
            }
        }
        Ok(policy)
    }

    #[cfg(test)]
    pub fn permits_app(&self, app_id: &str) -> bool {
        self.permits_application(app_id, None)
    }

    /// Either identity can exclude a process; an allow rule cannot override a block.
    pub fn permits_application(&self, app_id: &str, aumid: Option<&str>) -> bool {
        let Some(app_id) = windows_application_id(app_id) else {
            return false;
        };
        let packaged = match aumid {
            Some(value) => match packaged_application_id(value) {
                Some(value) => Some(format!("winapp.{value}")),
                None => return false,
            },
            None => None,
        };
        let matches = |rules: &[Rule]| {
            rules.iter().any(|rule| {
                if let Rule::Application { app_id: candidate } = rule {
                    candidate.eq_ignore_ascii_case(&app_id)
                        || packaged
                            .as_ref()
                            .is_some_and(|id| candidate.eq_ignore_ascii_case(id))
                } else {
                    false
                }
            })
        };
        !matches(&self.observation.blocklist)
            && (matches(&self.observation.allowlist)
                || matches!(
                    self.observation.default_application_behavior,
                    Behavior::Observe
                ))
    }

    /// Domain rules cover the exact host and its subdomains; a block always wins.
    /// This takes a hostname, not a URL, path, wildcard or credential authority.
    pub fn permits_domain(&self, domain: &str) -> bool {
        let Some(domain) = domain_name(domain) else {
            return false;
        };
        let domain = domain.strip_prefix("www.").unwrap_or(&domain);
        let matches = |rules: &[Rule]| {
            rules.iter().any(|rule| {
                let Rule::Url { domain: candidate } = rule else {
                    return false;
                };
                let candidate = candidate.strip_prefix("www.").unwrap_or(candidate);
                domain == candidate || domain.ends_with(&format!(".{candidate}"))
            })
        };
        !matches(&self.observation.blocklist)
            && (matches(&self.observation.allowlist)
                || matches!(self.observation.default_url_behavior, Behavior::Observe))
    }

    /// The sole conversion from worker data to the existing HistoryCore schema.
    /// Unknown sources suppress even boundaries. Known session boundaries carry
    /// identity only, including when their attached context would be denied.
    pub fn project(
        &self,
        snapshot: &Snapshot,
        kind: &str,
        id: u64,
        timestamp: DateTime<Utc>,
    ) -> Option<Value> {
        if !snapshot.source_known
            || id > MAX_EVENT_ID
            || !matches!(
                kind,
                "session.started"
                    | "session.ended"
                    | "window.changed"
                    | "ui.changed"
                    | "selection.changed"
                    | "terminal.value_changed"
                    | "keyboard.submit"
                    | "keyboard.shortcut"
                    | "mouse.click"
                    | "mouse.contextMenu"
                    | "mouse.drag"
            )
        {
            return None;
        }
        let mut event = json!({
            "id": id,
            "timestamp": timestamp.to_rfc3339_opts(SecondsFormat::Millis, true),
            "kind": kind,
        });
        if matches!(kind, "session.started" | "session.ended") {
            return Some(event);
        }
        let app_id = windows_application_id(&snapshot.app_id)?;
        if snapshot.secure
            || snapshot.private
            || !self.permits_application(&app_id, snapshot.application_user_model_id.as_deref())
            || private_title(&snapshot.title)
            || snapshot.domains.len() > MAX_DOMAINS
            || snapshot.source_id.len() != 36
        {
            return None;
        }
        let source_id = Uuid::parse_str(&snapshot.source_id).ok()?;
        if source_id.is_nil()
            || source_id.hyphenated().to_string() != snapshot.source_id.to_ascii_lowercase()
        {
            return None;
        }
        let mut domains = Vec::with_capacity(snapshot.domains.len());
        for domain in &snapshot.domains {
            let domain = domain_name(domain)?;
            if !self.permits_domain(&domain) {
                return None;
            }
            if !domains.contains(&domain) {
                domains.push(domain);
            }
        }
        let url = match snapshot.url.as_deref() {
            Some(value) => {
                let (url, domain) = domain_url(value)?;
                if !self.permits_domain(&domain) {
                    return None;
                }
                if !domains.contains(&domain) {
                    domains.push(domain);
                }
                Some(url)
            }
            None => None,
        };
        if domains.len() > MAX_DOMAINS {
            return None;
        }
        domains.sort_unstable();
        event["app"] = json!({
            "name": bounded(&snapshot.app_name, 256, false).0,
            "bundleIdentifier": app_id,
            "processIdentifier": snapshot.pid,
        });
        if let Some(identity) = &snapshot.application_user_model_id {
            event["app"]["applicationUserModelId"] = json!(identity);
        }
        event["window"] = json!({
            "title": bounded(&snapshot.title, 1024, false).0,
            "windowID": snapshot.window_id,
        });
        if let Some(url) = url {
            event["window"]["url"] = json!(url);
        }
        event["sourceId"] = json!(source_id.hyphenated().to_string());
        event["contentState"] = json!(if self.capture_text {
            "unavailable"
        } else {
            "metadataOnly"
        });
        let is_input = kind.starts_with("keyboard.") || kind.starts_with("mouse.");
        let (selected_items, item_bytes) =
            if !is_input && let Some(selection) = &snapshot.item_selection {
                let (items, bytes) = selection.project(self.capture_text, !domains.is_empty())?;
                (Some(items), bytes)
            } else {
                (None, 0)
            };
        if !is_input
            && self.capture_text
            && let Some(text) = snapshot.text.as_deref()
        {
            let selection_bytes = snapshot
                .selection
                .as_ref()
                .and_then(|selection| selection.selected_text.as_deref())
                .map_or(0, |text| bounded(text, MAX_SELECTION_BYTES, true).0.len());
            let (text, truncated) = bounded(
                text,
                MAX_TEXT_BYTES.saturating_sub(selection_bytes + item_bytes),
                true,
            );
            if !text.trim().is_empty() {
                event["ax"] = json!({ "mode": "fullTree", "text": text,
                    "truncated": truncated || snapshot.text_truncated });
                event["contentState"] = json!("available");
                event["contentDomains"] = json!(domains);
            }
        }
        if !is_input && let Some(selection) = &snapshot.selection {
            event["selection"] = if let Some(length) = selection.length {
                selection.start.checked_add(length)?;
                json!({ "selectedRange": { "location": selection.start, "length": length } })
            } else {
                json!({ "start": selection.start })
            };
            if self.capture_text
                && let Some(text) = selection.selected_text.as_deref()
                && !text.is_empty()
            {
                let (text, truncated) = bounded(text, MAX_SELECTION_BYTES, true);
                event["selection"]["selectedText"] = json!(text);
                event["selection"]["truncated"] = json!(truncated || selection.truncated);
                event["contentState"] = json!("available");
                event["contentDomains"] = json!(domains);
            }
        }
        if let Some(items) = selected_items {
            if event.get("selection").is_none() {
                event["selection"] = json!({});
            }
            if items.as_array()?.iter().any(|item| {
                item.get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            }) {
                event["contentState"] = json!("available");
                event["contentDomains"] = json!(domains);
            }
            event["selection"]["selectedItems"] = items;
        }
        if is_input {
            let input_target = snapshot.input_target.as_ref()?;
            if input_target.hwnd == 0
                || (input_target.uia.is_none() && input_target.hwnd == snapshot.window_id)
                || !matches!(
                    input_target.role.as_str(),
                    "AXTextField" | "AXGroup" | "AXDocument"
                )
                || input_target.uia.as_ref().is_some_and(|uia| {
                    !uia.is_valid()
                        || ((snapshot.url.is_some() || !snapshot.domains.is_empty())
                            && uia.document_runtime_id.is_empty())
                })
            {
                return None;
            }
            let mut target = json!({ "role": input_target.role });
            if self.capture_text && input_target.uia.is_none() {
                target["identifier"] = json!(format!("hwnd:{}", input_target.hwnd));
            }
            let (modifiers, payload) = match snapshot.action.as_ref()? {
                Action::Keyboard { key, modifiers } => {
                    if !matches!(kind, "keyboard.submit" | "keyboard.shortcut")
                        || (kind == "keyboard.submit" && key != "return")
                        || key.is_empty()
                        || key.len() > 32
                        || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                        || (kind == "keyboard.shortcut"
                            && !modifiers
                                .iter()
                                .any(|m| matches!(m.as_str(), "control" | "alt" | "meta")))
                    {
                        return None;
                    }
                    let mut keyboard = json!({ "modifiers": modifiers, "target": target });
                    if self.capture_text {
                        keyboard["keyEquivalent"] = json!(key);
                    }
                    (modifiers, keyboard)
                }
                Action::Mouse { button, modifiers } => {
                    if input_target.uia.is_some()
                        || !matches!(button.as_str(), "left" | "right" | "middle" | "other")
                        || (kind != "mouse.drag"
                            && kind
                                != if button == "right" {
                                    "mouse.contextMenu"
                                } else {
                                    "mouse.click"
                                })
                    {
                        return None;
                    }
                    let mut mouse =
                        json!({ "button": button, "modifiers": modifiers, "target": target });
                    if kind == "mouse.drag" {
                        // Both endpoints belong to the same observed native
                        // control. This records movement, not an operation result.
                        let endpoint = json!({ "app": event["app"], "window": event["window"], "element": target });
                        mouse["origin"] = endpoint.clone();
                        mouse["destination"] = endpoint;
                    } else {
                        mouse["clickCount"] = json!(1);
                    }
                    (modifiers, mouse)
                }
            };
            if modifiers.len() > 4
                || modifiers
                    .iter()
                    .any(|m| !matches!(m.as_str(), "control" | "shift" | "alt" | "meta"))
            {
                return None;
            }
            event[if kind.starts_with("keyboard.") {
                "keyboard"
            } else {
                "mouse"
            }] = payload;
            if self.capture_text {
                event["contentState"] = json!("available");
                event["contentDomains"] = json!(domains);
            }
        }
        Some(event)
    }
}

fn application_id(value: &str) -> Option<String> {
    if let Some(aumid) = value.strip_prefix("winapp.") {
        return packaged_application_id(aumid).map(|id| format!("winapp.{id}"));
    }
    if value.is_empty()
        || value.len() > 256
        || value.starts_with('.')
        || value.ends_with('.')
        || value.contains("..")
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return None;
    }
    Some(value.to_ascii_lowercase())
}

pub(crate) fn windows_application_id(value: &str) -> Option<String> {
    let value = application_id(value)?;
    let executable = value.strip_prefix("win32.")?;
    if executable.is_empty() || executable.starts_with('.') || executable.ends_with(".exe") {
        return None;
    }
    Some(value)
}

/// Packaged identity envelope, preserved exactly. The native process/metadata reader
/// also asks Windows to verify the identity before using it as an OS lookup key.
pub(crate) fn packaged_application_id(value: &str) -> Option<&str> {
    let (family, relative) = value.split_once('!')?;
    let (name, publisher) = family.split_once('_')?;
    let package_character = |c: u8| c.is_ascii_alphanumeric() || b".-".contains(&c);
    if value.len() > 129
        || !(3..=50).contains(&name.len())
        || !name.bytes().all(package_character)
        || publisher.len() != 13
        || !publisher
            .bytes()
            .all(|c| b"0123456789abcdefghjkmnpqrstvwxyz".contains(&c.to_ascii_lowercase()))
        || relative.is_empty()
        || relative.len() > 64
        || !relative
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.')
    {
        return None;
    }
    Some(value)
}

fn domain_name(value: &str) -> Option<String> {
    if value.is_empty()
        || value.len() > 253
        || value.chars().any(|character| {
            character.is_whitespace() || character.is_control() || "/@?#:\\%".contains(character)
        })
    {
        return None;
    }
    let host = Host::parse(value).ok()?.to_string();
    let host = host.strip_suffix('.').unwrap_or(&host);
    if host.is_empty()
        || host.len() > 253
        || !host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.as_bytes()[0].is_ascii_alphanumeric()
                && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn domain_url(value: &str) -> Option<(String, String)> {
    if value.len() > MAX_URL_BYTES
        || value.contains('\\')
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let authority = value.split_once("://")?.1;
    if !matches!(url.scheme(), "http" | "https")
        || authority.is_empty()
        || authority.starts_with(['/', '?', '#'])
        || !value
            .to_ascii_lowercase()
            .starts_with(&format!("{}://", url.scheme()))
    {
        return None;
    }
    let host = domain_name(url.host_str()?)?;
    // Rebuild even with text consent: URL credentials are never history content.
    Some((format!("{}://{host}", url.scheme()), host))
}

pub(crate) fn private_title(title: &str) -> bool {
    let title = title.to_lowercase();
    [
        "incognito",
        "inprivate",
        "private",
        "in private",
        "in-private",
        "privat",
        "privad",
        "priv\u{e9}",
        "priv\u{e1}",
        "an\u{f4}nim",
        "an\u{f3}nim",
        "\u{65e0}\u{75d5}",
        "\u{7121}\u{75d5}",
        "\u{9690}\u{8eab}",
        "\u{96b1}\u{8eab}",
        "\u{9690}\u{79c1}",
        "\u{96b1}\u{79c1}",
        "\u{79c1}\u{5bc6}",
        "\u{30b7}\u{30fc}\u{30af}\u{30ec}\u{30c3}\u{30c8}",
        "\u{30d7}\u{30e9}\u{30a4}\u{30d9}\u{30fc}\u{30c8}",
        "\u{c2dc}\u{d06c}\u{b9bf}",
        "\u{d504}\u{b77c}\u{c774}\u{be57}",
        "inkognito",
        "navigation priv\u{e9}e",
        "navegaci\u{f3}n privada",
        "inc\u{f3}gnito",
        "navega\u{e7}\u{e3}o privada",
        "\u{43f}\u{440}\u{438}\u{432}\u{430}\u{442}",
        "\u{438}\u{43d}\u{43a}\u{43e}\u{433}\u{43d}\u{438}\u{442}\u{43e}",
    ]
    .iter()
    .any(|marker| title.contains(marker))
}

fn bounded(value: &str, limit: usize, multiline: bool) -> (String, bool) {
    let mut output = String::with_capacity(value.len().min(limit));
    for character in value.chars() {
        let character = if character.is_control() {
            if multiline {
                if !matches!(character, '\n' | '\r' | '\t') {
                    continue;
                }
                character
            } else {
                ' '
            }
        } else {
            character
        };
        if output.len() + character.len_utf8() > limit {
            return (output, true);
        }
        output.push(character);
    }
    (output, false)
}

/// Reads one bounded regular file object without blocking atomic replacement.
/// Never follows a final linked entry, including a Windows reparse point.
pub(crate) fn read_regular(path: &Path, max_bytes: u64) -> Result<Vec<u8>> {
    let file = open_read(path)?;
    if file.metadata()?.len() > max_bytes {
        return Err("history_file_too_large".into());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err("history_file_too_large".into());
    }
    Ok(bytes)
}

fn open_read(path: &Path) -> Result<File> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("history_file_must_be_regular".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // READ | WRITE | DELETE: readers retain the opened object across replacement.
        options.share_mode(0x0000_0007);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("history_file_must_be_regular".into());
    }
    Ok(file)
}

/// Opens a regular file for store writes without following a final linked entry.
/// Windows writers deny replacement while the handle is open.
pub(crate) fn open_regular(path: &Path, options: &mut OpenOptions) -> Result<File> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link(&metadata) || !metadata.is_file() => {
            return Err("history_file_must_be_regular".into());
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => {}
    }
    no_follow(options);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("history_file_must_be_regular".into());
    }
    Ok(file)
}

pub(crate) fn no_follow(options: &mut OpenOptions) {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // OPEN_REPARSE_POINT; deny replacement while the file is open.
        options.custom_flags(0x0020_0000).share_mode(0x0000_0001);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x0000_0100); // O_NOFOLLOW
        #[cfg(any(target_os = "linux", target_os = "android"))]
        options.custom_flags(0x0002_0000); // O_NOFOLLOW
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    pub(crate) struct Home(pub PathBuf);

    impl Home {
        pub(crate) fn new() -> Self {
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!("maka-history-test-{}", Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        pub(crate) fn policy(&self, capture_text: bool) -> Policy {
            self.config(config(capture_text));
            Policy::load(&self.0).unwrap()
        }

        fn config(&self, value: Value) {
            fs::write(
                self.0.join("config.json"),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-15T01:00:00Z")
            .unwrap()
            .to_utc()
    }

    fn config(capture_text: bool) -> Value {
        json!({
            "observation": {
                "defaultApplicationBehavior": "observe",
                "defaultURLBehavior": "observe",
                "allowlist": [],
                "blocklist": [],
            },
            "captureText": capture_text,
            "showMenuBarIcon": false,
        })
    }

    #[test]
    fn regular_reads_enforce_byte_limits_and_reject_non_files() {
        let home = Home::new();
        let path = home.0.join("bounded.json");
        fs::write(&path, b"1234").unwrap();
        assert_eq!(read_regular(&path, 4).unwrap(), b"1234");
        assert!(read_regular(&path, 3).is_err());
        assert!(read_regular(&path, 0).is_err());
        fs::write(&path, b"").unwrap();
        assert_eq!(read_regular(&path, 0).unwrap(), b"");
        assert!(read_regular(&home.0, 4096).is_err());
        assert!(read_regular(&home.0.join("missing"), 4096).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn regular_reads_reject_a_final_symlink() {
        let home = Home::new();
        let target = home.0.join("target.json");
        let link = home.0.join("linked.json");
        fs::write(&target, b"private").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_regular(&link, 64).is_err());
        assert_eq!(read_regular(&target, 64).unwrap(), b"private");
    }

    #[cfg(windows)]
    #[test]
    fn held_readers_allow_atomic_replacement_and_keep_the_original_object() {
        let home = Home::new();
        for name in ["runtime.json", "config.json"] {
            let path = home.0.join(name);
            let replacement = home.0.join("replacement.json");
            fs::write(&path, b"old original contents").unwrap();
            let mut reader = open_read(&path).unwrap();
            let mut prefix = [0; 4];
            reader.read_exact(&mut prefix).unwrap();
            assert_eq!(&prefix, b"old ");
            fs::write(&replacement, b"new replacement contents").unwrap();
            fs::rename(&replacement, &path).unwrap();
            assert_eq!(
                read_regular(&path, 64).unwrap(),
                b"new replacement contents"
            );
            let mut remainder = Vec::new();
            reader.read_to_end(&mut remainder).unwrap();
            assert_eq!(remainder, b"original contents");
        }
    }

    #[cfg(windows)]
    #[test]
    fn held_writers_still_deny_atomic_replacement() {
        let home = Home::new();
        let path = home.0.join("events.jsonl");
        let replacement = home.0.join("replacement.jsonl");
        fs::write(&path, b"original").unwrap();
        fs::write(&replacement, b"replacement").unwrap();
        let writer = open_regular(&path, OpenOptions::new().append(true)).unwrap();
        assert!(fs::rename(&replacement, &path).is_err());
        assert_eq!(read_regular(&path, 64).unwrap(), b"original");
        drop(writer);
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(read_regular(&path, 64).unwrap(), b"replacement");
    }

    pub(crate) fn snapshot() -> Snapshot {
        Snapshot {
            text_truncated: false,
            selection: None,
            item_selection: None,
            input_target: None,
            action: None,
            app_id: "win32.chrome".into(),
            application_user_model_id: None,
            app_name: "Chrome".into(),
            pid: 42,
            window_id: 99,
            title: "A synthetic document".into(),
            url: Some("https://user:secret@Example.com:8443/private/path?q=secret#fragment".into()),
            text: Some("Synthetic visible document content".into()),
            source_id: Uuid::new_v4().to_string(),
            domains: vec!["example.com".into(), "frame.example".into()],
            secure: false,
            private: false,
            source_known: true,
        }
    }

    #[test]
    fn worker_transport_roundtrips_camel_case_and_requires_source_authority() {
        let original = snapshot();
        let mut value = serde_json::to_value(&original).unwrap();
        assert_eq!(value["appId"], original.app_id);
        assert_eq!(value["sourceKnown"], true);
        assert_eq!(value["windowId"], 99);
        let decoded: Snapshot = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded.source_id, original.source_id);
        assert_eq!(decoded.text, original.text);
        value.as_object_mut().unwrap().remove("sourceKnown");
        assert!(serde_json::from_value::<Snapshot>(value).is_err());
    }

    #[test]
    fn packaged_identity_survives_projection_and_either_alias_denies() {
        let home = Home::new();
        let aumid = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        let mut original = snapshot();
        original.application_user_model_id = Some(aumid.into());
        let source_only = original.without_content();
        assert_eq!(
            source_only.application_user_model_id.as_deref(),
            Some(aumid)
        );
        let policy = home.policy(true);
        let event = policy.project(&original, "ui.changed", 1, now()).unwrap();
        assert_eq!(event["app"]["bundleIdentifier"], "win32.chrome");
        assert_eq!(event["app"]["applicationUserModelId"], aumid);
        for blocked in [
            "win32.chrome".into(),
            format!("winapp.{aumid}")
                .to_ascii_uppercase()
                .replacen("WINAPP.", "winapp.", 1),
        ] {
            let mut value = config(true);
            value["observation"]["blocklist"] = json!([{"scope":"application","bundleID":blocked}]);
            value["observation"]["allowlist"] = json!([
                {"scope":"application","bundleID":"win32.chrome"},
                {"scope":"application","bundleID":format!("winapp.{aumid}")},
            ]);
            home.config(value);
            assert!(
                Policy::load(&home.0)
                    .unwrap()
                    .project(&original, "ui.changed", 1, now())
                    .is_none()
            );
        }
        let policy = home.policy(true);
        for invalid in [
            "",
            "notpackaged",
            "name_publisher!App",
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App/other",
        ] {
            original.application_user_model_id = Some(invalid.into());
            assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
        }
    }

    #[test]
    fn packaged_identity_keeps_long_tail_and_rejects_non_identity_inputs() {
        let longest = format!("{}_8wekyb3d8bbwe!{}", "N".repeat(50), "A".repeat(64));
        assert_eq!(longest.len(), 129);
        assert_eq!(packaged_application_id(&longest), Some(longest.as_str()));
        assert_eq!(
            application_id(&format!("winapp.{longest}")),
            Some(format!("winapp.{longest}"))
        );
        for invalid in [
            format!("{longest}x"),
            longest.replace('!', "!!"),
            longest.replace('!', "_"),
            longest.replace("!A", "!/"),
        ] {
            assert!(packaged_application_id(&invalid).is_none());
        }
    }

    #[test]
    fn consent_controls_the_complete_persistence_projection() {
        let home = Home::new();
        let original = snapshot();
        for capture_text in [false, true] {
            let policy = home.policy(capture_text);
            let event = policy
                .project(&original, "window.changed", 7, now())
                .unwrap();
            assert_eq!(event["window"]["url"], "https://example.com");
            assert_eq!(event["window"]["title"], original.title);
            assert_eq!(event["app"]["bundleIdentifier"], "win32.chrome");
            assert_eq!(event["sourceId"], original.source_id);
            let serialized = event.to_string();
            for forbidden in ["user:secret", "/private/path", "q=secret", "fragment"] {
                assert!(!serialized.contains(forbidden));
            }
            if capture_text {
                assert_eq!(event["contentState"], "available");
                assert_eq!(
                    event["ax"],
                    json!({
                        "mode": "fullTree", "text": original.text, "truncated": false,
                    })
                );
                assert_eq!(
                    event["contentDomains"],
                    json!(["example.com", "frame.example"])
                );
            } else {
                assert_eq!(event["contentState"], "metadataOnly");
                assert!(event.get("ax").is_none());
                assert!(event.get("contentDomains").is_none());
                assert!(!serialized.contains(original.text.as_deref().unwrap()));
            }
        }
    }

    #[test]
    fn app_and_domain_exclusions_are_case_insensitive_and_block_wins() {
        let home = Home::new();
        let mut value = config(true);
        value["observation"]["defaultApplicationBehavior"] = json!("do_not_observe");
        value["observation"]["defaultURLBehavior"] = json!("do_not_observe");
        value["observation"]["allowlist"] = json!([
            {"scope": "application", "bundleID": "WIN32.CHROME"},
            {"scope": "url", "urlDomain": "Example.COM."},
        ]);
        value["observation"]["blocklist"] = json!([
            {"scope": "application", "bundleID": "WIN32.NOTEPAD"},
            {"scope": "application", "bundleID": "com.apple.keychainaccess"},
            {"scope": "url", "urlDomain": "SECRET.EXAMPLE.COM"},
        ]);
        home.config(value.clone());
        let policy = Policy::load(&home.0).unwrap();
        assert!(policy.permits_app("Win32.Chrome"));
        assert!(!policy.permits_app("win32.notepad"));
        assert!(!policy.permits_app("win32.other"));
        assert!(policy.permits_domain("www.example.com"));
        assert!(policy.permits_domain("public.example.com"));
        assert!(!policy.permits_domain("deep.SECRET.example.com."));
        assert!(!policy.permits_domain("notexample.com"));
        let mut original = snapshot();
        original.domains = vec!["public.example.com".into()];
        assert!(policy.project(&original, "ui.changed", 1, now()).is_some());
        original.domains.push("secret.example.com".into());
        assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
        value["observation"]["blocklist"]
            .as_array_mut()
            .unwrap()
            .push(json!({"scope": "application", "bundleID": "win32.chrome"}));
        home.config(value);
        assert!(!Policy::load(&home.0).unwrap().permits_app("WIN32.CHROME"));
    }

    #[test]
    fn exclusions_suppress_the_entire_event_before_metadata_or_text_persistence() {
        let home = Home::new();
        for capture_text in [false, true] {
            for rule in [
                json!({"scope": "application", "bundleID": "WIN32.CHROME"}),
                json!({"scope": "url", "urlDomain": "example.com"}),
                json!({"scope": "url", "urlDomain": "frame.example"}),
            ] {
                let mut value = config(capture_text);
                value["observation"]["blocklist"] = json!([rule]);
                home.config(value);
                let policy = Policy::load(&home.0).unwrap();
                assert!(
                    policy
                        .project(&snapshot(), "ui.changed", 1, now())
                        .is_none()
                );
            }
            let mut value = config(capture_text);
            value["observation"]["defaultURLBehavior"] = json!("do_not_observe");
            home.config(value);
            let policy = Policy::load(&home.0).unwrap();
            let mut original = snapshot();
            original.domains.clear();
            assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
            original.url = None;
            original.app_id = "win32.notepad".into();
            assert!(policy.project(&original, "ui.changed", 1, now()).is_some());
        }
    }

    #[test]
    fn missing_or_malformed_config_never_creates_a_permissive_policy() {
        let home = Home::new();
        assert!(Policy::load(&home.0).is_err());
        let mut cases = vec![json!({}), json!([]), json!(null)];
        for key in ["observation", "captureText"] {
            let mut value = config(false);
            value.as_object_mut().unwrap().remove(key);
            cases.push(value);
        }
        for key in [
            "defaultApplicationBehavior",
            "defaultURLBehavior",
            "allowlist",
            "blocklist",
        ] {
            let mut value = config(false);
            value["observation"].as_object_mut().unwrap().remove(key);
            cases.push(value);
        }
        for key in ["defaultApplicationBehavior", "defaultURLBehavior"] {
            let mut value = config(false);
            value["observation"][key] = json!("unknown");
            cases.push(value);
        }
        for key in ["allowlist", "blocklist"] {
            let mut value = config(false);
            value["observation"][key] = json!(null);
            cases.push(value);
            let mut value = config(false);
            value["observation"][key] = json!(vec![
                json!({"scope": "application", "bundleID": "win32.chrome"});
                MAX_RULES + 1
            ]);
            cases.push(value);
        }
        for (key, replacement) in [
            ("captureText", json!("true")),
            ("showMenuBarIcon", json!(null)),
            ("observation", json!({})),
            ("unexpected", json!(true)),
        ] {
            let mut value = config(false);
            value[key] = replacement;
            cases.push(value);
        }
        for rule in [
            json!({"scope": "application"}),
            json!({"scope": "url", "urlDomain": "https://example.com/path"}),
            json!({"scope": "url", "urlDomain": "user@example.com"}),
            json!({"scope": "application", "bundleID": "C:\\private\\app.exe"}),
            json!({"scope": "application", "bundleID": "win32.chrome.exe"}),
            json!({"scope": "url", "urlDomain": "example.com", "bundleID": "win32.chrome"}),
            json!({"scope": "unknown"}),
        ] {
            let mut value = config(false);
            value["observation"]["blocklist"] = json!([rule]);
            cases.push(value);
        }
        for value in cases {
            home.config(value.clone());
            assert!(Policy::load(&home.0).is_err(), "{value}");
        }
        for bytes in [
            b"{broken".to_vec(),
            vec![0xff],
            vec![b' '; MAX_CONFIG_BYTES as usize + 1],
            br#"{"captureText":false,"captureText":true,"observation":{}}"#.to_vec(),
        ] {
            fs::write(home.0.join("config.json"), bytes).unwrap();
            assert!(Policy::load(&home.0).is_err());
        }
        fs::remove_file(home.0.join("config.json")).unwrap();
        fs::create_dir(home.0.join("config.json")).unwrap();
        assert!(Policy::load(&home.0).is_err());
    }

    #[test]
    fn private_password_and_unknown_source_contexts_are_suppressed_in_both_modes() {
        let home = Home::new();
        for capture_text in [false, true] {
            let policy = home.policy(capture_text);
            for field in ["private", "secure", "source", "title"] {
                let mut original = snapshot();
                match field {
                    "private" => original.private = true,
                    "secure" => original.secure = true,
                    "source" => original.source_known = false,
                    _ => original.title = "Document - InPrivate".into(),
                }
                assert!(
                    policy.project(&original, "ui.changed", 1, now()).is_none(),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn reload_observes_revoked_text_consent_and_never_recovers_a_stale_policy() {
        let home = Home::new();
        assert!(home.policy(true).capture_text);
        home.config(config(false));
        let policy = Policy::load(&home.0).unwrap();
        assert!(!policy.capture_text);
        let event = policy.project(&snapshot(), "ui.changed", 1, now()).unwrap();
        assert!(event.get("ax").is_none());
        fs::write(home.0.join("config.json"), b"{partial").unwrap();
        assert!(Policy::load(&home.0).is_err());
        fs::remove_file(home.0.join("config.json")).unwrap();
        assert!(Policy::load(&home.0).is_err());
    }

    #[test]
    fn invalid_identity_domains_and_url_paths_fail_closed() {
        let home = Home::new();
        for capture_text in [false, true] {
            let policy = home.policy(capture_text);
            for source in [
                "",
                "../events.jsonl",
                "file:///private",
                "not-a-uuid",
                "00000000-0000-0000-0000-000000000000",
            ] {
                let mut original = snapshot();
                original.source_id = source.into();
                assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
            }
            for domain in [
                "",
                "https://example.com",
                "../private",
                "example.com/path",
                "user@example.com",
                "a..example",
                "-a.example",
                "example.com:443",
                "example.com?token",
                "example.com\\other",
                "example%2ecom",
                "example.com\n",
            ] {
                let mut original = snapshot();
                original.domains = vec![domain.into()];
                assert!(!policy.permits_domain(domain), "{domain}");
                assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
            }
            for url in [
                "file:///C:/private/file.txt",
                "C:\\private\\file.txt",
                "/private/file.txt",
                "javascript:secret",
                "https:///example.com",
                "https://example.com\\private",
                "https://",
            ] {
                let mut original = snapshot();
                original.url = Some(url.into());
                assert!(
                    policy.project(&original, "ui.changed", 1, now()).is_none(),
                    "{url}"
                );
            }
            for app in [
                "chrome.exe",
                "win32.chrome.exe",
                "win32.",
                "win32../chrome",
                "win32.C:\\private\\chrome",
                "win32.chrome\n",
                "com.google.chrome",
            ] {
                assert!(!policy.permits_app(app), "{app}");
            }
        }
    }

    #[test]
    fn domain_provenance_is_complete_bounded_and_not_silently_clipped() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        original.domains = (0..63).map(|n| format!("frame{n}.example")).collect();
        let event = policy.project(&original, "ui.changed", 1, now()).unwrap();
        assert_eq!(event["contentDomains"].as_array().unwrap().len(), 64);
        assert!(
            event["contentDomains"]
                .as_array()
                .unwrap()
                .contains(&json!("example.com"))
        );
        original.domains.push("frame63.example".into());
        assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
        original.url = None;
        assert!(policy.project(&original, "ui.changed", 1, now()).is_some());
        original.domains.push("frame64.example".into());
        assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
        original.domains = vec!["example.com".into(); 65];
        assert!(policy.project(&original, "ui.changed", 1, now()).is_none());
    }

    #[test]
    fn utf8_output_is_byte_bounded_and_missing_text_is_not_available() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        let unit = "\u{4e2d}\u{6587}\u{1f680}";
        original.text = Some(format!("{}\u{0}", unit.repeat(MAX_TEXT_BYTES)));
        original.title = unit.repeat(1024);
        original.app_name = unit.repeat(256);
        let event = policy.project(&original, "ui.changed", 1, now()).unwrap();
        let text = event["ax"]["text"].as_str().unwrap();
        assert!(text.len() <= MAX_TEXT_BYTES);
        assert!(text.len() > MAX_TEXT_BYTES - unit.len());
        assert_eq!(event["ax"]["truncated"], true);
        assert!(event["window"]["title"].as_str().unwrap().len() <= 1024);
        assert!(event["app"]["name"].as_str().unwrap().len() <= 256);
        assert!(serde_json::from_slice::<Value>(&serde_json::to_vec(&event).unwrap()).is_ok());
        for text in [None, Some("".into()), Some("\u{0} \n\t".into())] {
            original.text = text;
            let event = policy.project(&original, "ui.changed", 1, now()).unwrap();
            assert_eq!(event["contentState"], "unavailable");
            assert!(event.get("ax").is_none());
            assert!(event.get("contentDomains").is_none());
        }
    }

    #[test]
    fn upstream_clipping_survives_a_projection_that_does_not_clip_again() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        original.text = Some("retained prefix".repeat(50));
        original.text_truncated = true;
        let event = policy.project(&original, "ui.changed", 1, now()).unwrap();
        assert_eq!(event["ax"]["text"], original.text.unwrap());
        assert_eq!(event["ax"]["truncated"], true);
    }

    #[test]
    fn selection_is_bounded_and_obeys_the_same_content_admission() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        original.selection = Some(Selection {
            selected_text: Some("  selected\ttext\r\n".into()),
            truncated: true,
            start: 7,
            length: None,
        });
        let event = policy
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(
            event["selection"],
            json!({
                "selectedText": "  selected\ttext\r\n", "truncated": true, "start": 7,
            })
        );
        assert_eq!(
            event["contentDomains"],
            json!(["example.com", "frame.example"])
        );
        let metadata = home
            .policy(false)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(metadata["selection"], json!({ "start": 7 }));
        assert_eq!(metadata["contentState"], "metadataOnly");
        for flag in ["secure", "private", "sourceKnown"] {
            let mut wire = serde_json::to_value(&original).unwrap();
            wire[flag] = json!(flag != "sourceKnown");
            let denied = serde_json::from_value(wire).unwrap();
            assert!(
                policy
                    .project(&denied, "selection.changed", 1, now())
                    .is_none()
            );
        }
        original.domains = vec!["blocked.example".into()];
        let mut blocked = config(true);
        blocked["observation"]["blocklist"] =
            json!([{"scope": "url", "urlDomain": "blocked.example"}]);
        home.config(blocked);
        assert!(
            Policy::load(&home.0)
                .unwrap()
                .project(&original, "selection.changed", 1, now())
                .is_none()
        );
        original.domains = vec!["example.com".into()];
        original.selection.as_mut().unwrap().selected_text =
            Some(format!("{}VISIBLE_SELECTION_TAIL", "x".repeat(5000)));
        let event = policy
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert!(
            event["selection"]["selectedText"]
                .as_str()
                .unwrap()
                .ends_with("VISIBLE_SELECTION_TAIL")
        );
        original.selection.as_mut().unwrap().selected_text =
            Some("\u{4e2d}".repeat(MAX_SELECTION_BYTES));
        let event = policy
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(
            event["selection"]["selectedText"].as_str().unwrap().len(),
            MAX_SELECTION_BYTES - 2
        );
        assert_eq!(event["selection"]["truncated"], true);
    }

    #[test]
    fn selection_numeric_survives_absent_or_clipped_text() {
        let home = Home::new();
        let mut original = snapshot();
        original.text = None;
        for (start, length, text, clipped) in [
            (70_000, Some(4), None, false),
            (u32::MAX, Some(0), None, false),
            (0, Some(0), Some(String::new()), false),
            (4, Some(2), Some("\u{1f4bb}".into()), false),
            (7, Some(20_000), Some("s".repeat(9000)), false),
            (9, Some(20_000), Some("retained prefix".into()), true),
            (11, None, None, false),
        ] {
            original.selection = Some(
                serde_json::from_value(json!({
                    "start": start, "length": length,
                    "selectedText": text, "truncated": clipped,
                }))
                .unwrap(),
            );
            for capture_text in [true, false] {
                let event = home
                    .policy(capture_text)
                    .project(&original, "selection.changed", 1, now())
                    .unwrap();
                let selection = &event["selection"];
                if let Some(length) = length {
                    assert_eq!(
                        selection["selectedRange"],
                        json!({ "location": start, "length": length })
                    );
                    assert!(selection.get("start").is_none());
                } else {
                    assert_eq!(selection["start"], start);
                    assert!(selection.get("selectedRange").is_none());
                }
                if capture_text
                    && let Some(text) = &text
                    && !text.is_empty()
                {
                    let (expected, truncated) = bounded(text, MAX_SELECTION_BYTES, true);
                    assert_eq!(selection["selectedText"], expected);
                    assert_eq!(selection["truncated"], truncated || clipped);
                    assert_eq!(event["contentState"], "available");
                } else {
                    assert!(selection.get("selectedText").is_none());
                    assert!(selection.get("truncated").is_none());
                    assert!(event.get("contentDomains").is_none());
                    assert_eq!(
                        event["contentState"],
                        if capture_text {
                            "unavailable"
                        } else {
                            "metadataOnly"
                        }
                    );
                }
                assert!(event.get("ax").is_none());
            }
        }
        let selection: Selection =
            serde_json::from_value(json!({ "start": 17, "length": 0 })).unwrap();
        let wire = serde_json::to_value(selection).unwrap();
        assert!(wire.get("selectedText").is_none());
        assert_eq!(wire["length"], 0);
        let legacy = json!({ "start": 4, "selectedText": "old", "truncated": true });
        let selection: Selection = serde_json::from_value(legacy.clone()).unwrap();
        assert!(selection.length.is_none());
        assert_eq!(serde_json::to_value(selection).unwrap(), legacy);
    }

    #[test]
    fn selection_numeric_rejects_invalid_ranges_and_preserves_denials() {
        let home = Home::new();
        let mut original = snapshot();
        original.text = None;
        original.selection =
            Some(serde_json::from_value(json!({ "start": 7, "length": 4 })).unwrap());
        for capture_text in [true, false] {
            let policy = home.policy(capture_text);
            assert!(
                policy
                    .project(&original, "selection.changed", 1, now())
                    .is_some()
            );
            for flag in ["secure", "private", "sourceKnown"] {
                let mut wire = serde_json::to_value(&original).unwrap();
                wire[flag] = json!(flag != "sourceKnown");
                let denied = serde_json::from_value(wire).unwrap();
                assert!(
                    policy
                        .project(&denied, "selection.changed", 1, now())
                        .is_none()
                );
            }
            let mut overflow = original.clone();
            overflow.selection = Some(
                serde_json::from_value(json!({
                    "start": u32::MAX, "length": 1,
                }))
                .unwrap(),
            );
            assert!(
                policy
                    .project(&overflow, "selection.changed", 1, now())
                    .is_none()
            );
            let mut blocked = config(capture_text);
            blocked["observation"]["blocklist"] =
                json!([{"scope":"url","urlDomain":"frame.example"}]);
            home.config(blocked);
            assert!(
                Policy::load(&home.0)
                    .unwrap()
                    .project(&original, "selection.changed", 1, now())
                    .is_none()
            );
        }
        for invalid in [
            json!({ "start": -1, "length": 1 }),
            json!({ "start": 0, "length": -1 }),
            json!({ "start": 0, "length": 1.5 }),
            json!({ "start": 0, "length": u64::from(u32::MAX) + 1 }),
        ] {
            assert!(serde_json::from_value::<Selection>(invalid).is_err());
        }
    }

    #[test]
    fn boundaries_have_only_identity_and_do_not_bypass_unknown_source() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        original.secure = true;
        original.private = true;
        for kind in ["session.started", "session.ended"] {
            let event = policy.project(&original, kind, 5, now()).unwrap();
            assert_eq!(
                event,
                json!({"id":5, "kind":kind, "timestamp":"2026-09-15T01:00:00.000Z"})
            );
        }
        original.source_known = false;
        assert!(
            policy
                .project(&original, "session.started", 1, now())
                .is_none()
        );
        original.source_known = true;
        assert!(
            policy
                .project(&original, "keyboard.text_input", 1, now())
                .is_none()
        );
        assert!(
            policy
                .project(&original, "session.started", u64::MAX, now())
                .is_none()
        );
    }

    #[test]
    fn input_source_retains_admission_without_copying_observed_content() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        original.input_target = Some(InputTarget {
            hwnd: 100,
            role: "AXTextField".into(),
            uia: None,
        });
        original.text = Some("x".repeat(MAX_TEXT_BYTES));
        original.text_truncated = true;
        original.selection = Some(Selection {
            selected_text: Some("old selection".into()),
            start: 4,
            truncated: true,
            length: Some(40),
        });
        original.action = Some(Action::Keyboard {
            key: "return".into(),
            modifiers: vec![],
        });
        let source = original.without_content();
        assert!(source.text.is_none() && source.selection.is_none() && source.action.is_none());
        assert!(!source.text_truncated);
        assert!(crate::input_actions::same_input_source(&source, &original));
        let projected = policy.project(&source, "ui.changed", 1, now()).unwrap();
        assert!(projected.get("ax").is_none() && projected.get("selection").is_none());
        assert_eq!(projected["sourceId"], original.source_id);
        for denial in 0..6 {
            let mut denied = original.clone();
            match denial {
                0 => denied.secure = true,
                1 => denied.private = true,
                2 => denied.source_known = false,
                3 => denied.app_id = "invalid".into(),
                4 => denied.source_id.clear(),
                _ => denied.domains.push("invalid domain".into()),
            }
            assert!(policy.project(&denied, "ui.changed", 1, now()).is_none());
            assert!(
                policy
                    .project(&denied.without_content(), "ui.changed", 1, now())
                    .is_none()
            );
        }
    }

    #[test]
    fn input_records_project_text_and_metadata_without_observed_content() {
        let home = Home::new();
        let mut original = snapshot();
        let aumid = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        original.application_user_model_id = Some(aumid.into());
        original.input_target = Some(InputTarget {
            hwnd: 100,
            role: "AXTextField".into(),
            uia: None,
        });
        original.text = Some("body from a different observation time".into());
        original.selection = Some(Selection {
            selected_text: Some("old selected text".into()),
            start: 7,
            truncated: false,
            length: Some(17),
        });
        let modifiers = vec!["control".into(), "shift".into()];
        let cases = [
            (
                "keyboard.submit",
                Action::Keyboard {
                    key: "return".into(),
                    modifiers: vec![],
                },
            ),
            (
                "keyboard.shortcut",
                Action::Keyboard {
                    key: "a".into(),
                    modifiers: modifiers.clone(),
                },
            ),
            (
                "mouse.click",
                Action::Mouse {
                    button: "left".into(),
                    modifiers: modifiers.clone(),
                },
            ),
            (
                "mouse.contextMenu",
                Action::Mouse {
                    button: "right".into(),
                    modifiers: modifiers.clone(),
                },
            ),
            (
                "mouse.drag",
                Action::Mouse {
                    button: "other".into(),
                    modifiers,
                },
            ),
        ];
        for capture_text in [true, false] {
            let policy = home.policy(capture_text);
            for role in ["AXTextField", "AXGroup", "AXDocument"] {
                original.input_target.as_mut().unwrap().role = role.into();
                for (kind, action) in &cases {
                    original.action = Some(action.clone());
                    let event = policy
                        .project(&original, kind, 1, now())
                        .unwrap_or_else(|| {
                            panic!(
                                "admitted {kind} on {role} missing with capture_text={capture_text}"
                            )
                        });
                    assert_eq!(event["kind"], *kind);
                    assert_eq!(event["sourceId"], original.source_id);
                    assert_eq!(event["app"]["bundleIdentifier"], original.app_id);
                    assert_eq!(event["app"]["applicationUserModelId"], aumid);
                    assert_eq!(event["window"]["windowID"], original.window_id);
                    assert_eq!(event["window"]["title"], original.title);
                    assert_eq!(
                        event["contentState"],
                        if capture_text {
                            "available"
                        } else {
                            "metadataOnly"
                        }
                    );
                    if capture_text {
                        assert_eq!(
                            event["contentDomains"],
                            json!(["example.com", "frame.example"])
                        );
                    } else {
                        assert!(event.get("contentDomains").is_none());
                    }
                    for field in ["ax", "selection", "inputTarget", "action"] {
                        assert!(event.get(field).is_none(), "{field}");
                    }
                    let target = if capture_text {
                        json!({ "role": role, "identifier": "hwnd:100" })
                    } else {
                        json!({ "role": role })
                    };
                    match action {
                        Action::Keyboard { key, modifiers } => {
                            let mut expected = json!({ "modifiers": modifiers, "target": target });
                            if capture_text {
                                expected["keyEquivalent"] = json!(key);
                            }
                            assert_eq!(event["keyboard"], expected);
                            assert!(event.get("mouse").is_none());
                        }
                        Action::Mouse { button, modifiers } => {
                            let mut expected = json!({
                                "button": button, "modifiers": modifiers, "target": target,
                            });
                            if *kind == "mouse.drag" {
                                let endpoint = json!({
                                    "app": event["app"], "window": event["window"], "element": target,
                                });
                                expected["origin"] = endpoint.clone();
                                expected["destination"] = endpoint;
                            } else {
                                expected["clickCount"] = json!(1);
                            }
                            assert_eq!(event["mouse"], expected);
                            assert!(event.get("keyboard").is_none());
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn observed_uia_keyboard_uses_real_host_without_persisting_runtime_identity() {
        let home = Home::new();
        for capture_text in [false, true] {
            let policy = home.policy(capture_text);
            let mut original = snapshot();
            original.input_target = Some(InputTarget {
                hwnd: original.window_id,
                role: "AXTextField".into(),
                uia: Some(UiaTarget {
                    runtime_id: vec![42, 812, -5],
                    document_runtime_id: vec![42, 901],
                }),
            });
            original.text = Some("stale unrelated body".into());
            original.action = Some(Action::Keyboard {
                key: "return".into(),
                modifiers: vec![],
            });
            let event = policy
                .project(&original, "keyboard.submit", 1, now())
                .unwrap();
            assert_eq!(event["keyboard"]["target"], json!({"role": "AXTextField"}));
            assert_eq!(event["window"]["windowID"], original.window_id);
            assert_eq!(event["sourceId"], original.source_id);
            assert!(event.get("ax").is_none());
            assert_eq!(
                event["contentState"],
                if capture_text {
                    "available"
                } else {
                    "metadataOnly"
                }
            );
            assert_eq!(
                event["keyboard"].get("keyEquivalent"),
                capture_text.then_some(&json!("return"))
            );
            assert!(!event.to_string().contains("runtime"));
            let mut changed = original.clone();
            changed
                .input_target
                .as_mut()
                .unwrap()
                .uia
                .as_mut()
                .unwrap()
                .runtime_id[2] = -6;
            assert!(!crate::input_actions::same_input_source(
                &original, &changed
            ));
            changed = original.clone();
            changed
                .input_target
                .as_mut()
                .unwrap()
                .uia
                .as_mut()
                .unwrap()
                .document_runtime_id[1] = 902;
            assert!(!crate::input_actions::same_input_source(
                &original, &changed
            ));

            for kind in ["mouse.click", "mouse.contextMenu", "mouse.drag"] {
                original.action = Some(Action::Mouse {
                    button: if kind == "mouse.contextMenu" {
                        "right"
                    } else {
                        "left"
                    }
                    .into(),
                    modifiers: vec![],
                });
                assert!(policy.project(&original, kind, 1, now()).is_none());
            }
        }
    }

    #[test]
    fn observed_uia_identity_bounds_and_document_provenance_fail_closed() {
        let home = Home::new();
        let mut original = snapshot();
        original.input_target = Some(InputTarget {
            hwnd: original.window_id,
            role: "AXTextField".into(),
            uia: Some(UiaTarget {
                runtime_id: vec![i32::MIN, i32::MAX],
                document_runtime_id: vec![3],
            }),
        });
        original.action = Some(Action::Keyboard {
            key: "return".into(),
            modifiers: vec![],
        });
        for capture_text in [false, true] {
            let policy = home.policy(capture_text);
            assert!(
                policy
                    .project(&original, "keyboard.submit", 1, now())
                    .is_some()
            );
            for invalid in 0..9 {
                let mut denied = original.clone();
                let target = denied.input_target.as_mut().unwrap();
                let uia = target.uia.as_mut().unwrap();
                match invalid {
                    0 => uia.runtime_id.clear(),
                    1 => uia.runtime_id = vec![1; 33],
                    2 => uia.document_runtime_id = vec![1; 33],
                    3 => uia.document_runtime_id.clear(),
                    4 => target.role = "AXSecureTextField".into(),
                    5 => target.hwnd = 0,
                    6 => denied.secure = true,
                    7 => denied.private = true,
                    _ => denied.source_known = false,
                }
                assert!(
                    policy
                        .project(&denied, "keyboard.submit", 1, now())
                        .is_none(),
                    "{invalid}"
                );
            }
            let mut native = original.clone();
            native.url = None;
            native.domains.clear();
            native
                .input_target
                .as_mut()
                .unwrap()
                .uia
                .as_mut()
                .unwrap()
                .document_runtime_id
                .clear();
            assert!(
                policy
                    .project(&native, "keyboard.submit", 1, now())
                    .is_some()
            );
        }
        let legacy: InputTarget = serde_json::from_value(json!({
            "hwnd": 100, "role": "AXTextField",
        }))
        .unwrap();
        assert!(legacy.uia.is_none());
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            json!({
                "hwnd": 100, "role": "AXTextField",
            })
        );
        for (field, value) in [
            ("runtimeId", json!(vec![1; 33])),
            ("documentRuntimeId", json!(vec![1; 33])),
            ("runtimeId", json!([2_147_483_648_i64])),
            ("runtimeId", json!(["untrusted value"])),
            ("documentRuntimeId", Value::Null),
        ] {
            let mut wire = json!({"runtimeId": [1], "documentRuntimeId": [2]});
            wire[field] = value;
            assert!(
                serde_json::from_value::<UiaTarget>(wire).is_err(),
                "{field}"
            );
        }
        assert!(
            serde_json::from_value::<UiaTarget>(json!({
                "runtimeId": vec![i32::MIN; 32], "documentRuntimeId": vec![i32::MAX; 32],
            }))
            .unwrap()
            .is_valid()
        );
    }

    #[test]
    fn input_metadata_preserves_source_and_action_rejection() {
        let home = Home::new();
        let aumid = "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App";
        let mut original = snapshot();
        original.application_user_model_id = Some(aumid.into());
        original.input_target = Some(InputTarget {
            hwnd: 100,
            role: "AXTextField".into(),
            uia: None,
        });
        original.action = Some(Action::Keyboard {
            key: "return".into(),
            modifiers: vec![],
        });
        for capture_text in [true, false] {
            let policy = home.policy(capture_text);
            assert!(
                policy
                    .project(&original, "keyboard.submit", 1, now())
                    .is_some()
            );
            for (field, value) in [
                ("secure", json!(true)),
                ("private", json!(true)),
                ("sourceKnown", json!(false)),
                ("sourceId", json!("invalid")),
                ("appId", json!("invalid")),
                ("applicationUserModelId", json!("invalid")),
                ("title", json!("InPrivate")),
                ("domains", json!(["invalid domain"])),
                ("inputTarget", Value::Null),
                ("inputTarget", json!({ "hwnd": 0, "role": "AXTextField" })),
                (
                    "inputTarget",
                    json!({ "hwnd": original.window_id, "role": "AXTextField" }),
                ),
                ("inputTarget", json!({ "hwnd": 100, "role": "AXWebArea" })),
                (
                    "inputTarget",
                    json!({ "hwnd": 100, "role": "AXSecureTextField" }),
                ),
                ("action", Value::Null),
            ] {
                let mut wire = serde_json::to_value(&original).unwrap();
                wire[field] = value;
                let denied = serde_json::from_value(wire).unwrap();
                assert!(
                    policy
                        .project(&denied, "keyboard.submit", 1, now())
                        .is_none(),
                    "{field}"
                );
            }
            for (kind, action) in [
                (
                    "keyboard.submit",
                    json!({ "type": "keyboard", "key": "a", "modifiers": [] }),
                ),
                (
                    "keyboard.shortcut",
                    json!({ "type": "keyboard", "key": "a", "modifiers": [] }),
                ),
                (
                    "keyboard.shortcut",
                    json!({ "type": "keyboard", "key": "", "modifiers": ["control"] }),
                ),
                (
                    "keyboard.shortcut",
                    json!({ "type": "keyboard", "key": "secret value", "modifiers": ["control"] }),
                ),
                (
                    "keyboard.shortcut",
                    json!({ "type": "keyboard", "key": "a".repeat(33), "modifiers": ["control"] }),
                ),
                (
                    "keyboard.submit",
                    json!({ "type": "keyboard", "key": "return", "modifiers": ["unknown"] }),
                ),
                (
                    "mouse.click",
                    json!({ "type": "mouse", "button": "unknown", "modifiers": [] }),
                ),
                (
                    "mouse.click",
                    json!({ "type": "mouse", "button": "right", "modifiers": [] }),
                ),
                (
                    "mouse.contextMenu",
                    json!({ "type": "mouse", "button": "left", "modifiers": [] }),
                ),
                (
                    "mouse.drag",
                    json!({ "type": "mouse", "button": "left", "modifiers": vec!["control"; 5] }),
                ),
                (
                    "keyboard.submit",
                    json!({ "type": "mouse", "button": "left", "modifiers": [] }),
                ),
                (
                    "mouse.click",
                    json!({ "type": "keyboard", "key": "return", "modifiers": [] }),
                ),
            ] {
                let mut denied = original.clone();
                denied.action = Some(serde_json::from_value(action).unwrap());
                assert!(policy.project(&denied, kind, 1, now()).is_none(), "{kind}");
            }
            for block in [
                json!({ "scope": "application", "bundleID": original.app_id }),
                json!({ "scope": "application", "bundleID": format!("winapp.{aumid}") }),
                json!({ "scope": "url", "urlDomain": "example.com" }),
                json!({ "scope": "url", "urlDomain": "frame.example" }),
            ] {
                let mut value = config(capture_text);
                value["observation"]["blocklist"] = json!([block]);
                home.config(value);
                assert!(
                    Policy::load(&home.0)
                        .unwrap()
                        .project(&original, "keyboard.submit", 1, now())
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn selection_reserves_space_inside_the_total_event_text_budget() {
        let home = Home::new();
        let mut original = snapshot();
        original.text = Some("b".repeat(MAX_TEXT_BYTES));
        original.selection = Some(Selection {
            selected_text: Some("s".repeat(MAX_SELECTION_BYTES)),
            start: 0,
            truncated: false,
            length: Some(20_000),
        });
        let event = home
            .policy(true)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        let body = event["ax"]["text"].as_str().unwrap();
        let selection = event["selection"]["selectedText"].as_str().unwrap();
        assert_eq!(selection.len(), MAX_SELECTION_BYTES);
        assert_eq!(body.len() + selection.len(), MAX_TEXT_BYTES);
        assert_eq!(event["ax"]["truncated"], true);
        assert_eq!(event["selection"]["selectedRange"]["length"], 20_000);
        original.selection.as_mut().unwrap().selected_text = None;
        let numeric_only = home
            .policy(true)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(
            numeric_only["ax"]["text"].as_str().unwrap().len(),
            MAX_TEXT_BYTES
        );
        assert_eq!(numeric_only["ax"]["truncated"], false);
        assert_eq!(
            numeric_only["selection"],
            json!({ "selectedRange": { "location": 0, "length": 20_000 } })
        );
    }

    fn item_selection() -> ItemSelection {
        ItemSelection {
            owner_runtime_id: vec![42, 710],
            document_runtime_id: vec![42, 709],
            items: vec![SelectedItem {
                runtime_id: vec![42, 711],
                role: "AXRow".into(),
                value: Some("Sampled selected-item content:\nAXStaticText: synthetic leaf".into()),
            }],
        }
    }

    #[test]
    fn item_selection_transport_preserves_identity_but_contentless_source_drops_it() {
        let mut original = snapshot();
        let legacy = serde_json::to_value(&original).unwrap();
        assert!(legacy.get("itemSelection").is_none());
        assert!(
            serde_json::from_value::<Snapshot>(legacy)
                .unwrap()
                .item_selection
                .is_none()
        );
        original.item_selection = Some(item_selection());
        let wire = serde_json::to_value(&original).unwrap();
        assert_eq!(wire["itemSelection"]["ownerRuntimeId"], json!([42, 710]));
        let decoded: Snapshot = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(decoded.item_selection, original.item_selection);
        let mut replacement = item_selection();
        replacement.items[0].runtime_id[1] += 1;
        assert_ne!(Some(replacement), original.item_selection);
        let mut cleared = item_selection();
        cleared.items.clear();
        assert_ne!(Some(cleared), None);
        assert!(original.without_content().item_selection.is_none());
        for path in ["ownerRuntimeId", "documentRuntimeId", "runtimeId"] {
            let mut invalid = wire.clone();
            let target = if path == "runtimeId" {
                &mut invalid["itemSelection"]["items"][0]
            } else {
                &mut invalid["itemSelection"]
            };
            target[path] = json!(vec![1; 33]);
            assert!(
                serde_json::from_value::<Snapshot>(invalid).is_err(),
                "{path}"
            );
        }
        let mut unsupported = wire;
        unsupported["itemSelection"]["items"][0]["subrole"] = json!("invented");
        assert!(serde_json::from_value::<Snapshot>(unsupported).is_err());
    }

    #[test]
    fn item_selection_projects_only_roles_and_consented_samples_without_fabricated_range() {
        let home = Home::new();
        let mut original = snapshot();
        original.text = None;
        original.item_selection = Some(item_selection());
        for capture_text in [true, false] {
            let event = home
                .policy(capture_text)
                .project(&original, "selection.changed", 1, now())
                .unwrap();
            let selection = &event["selection"];
            assert!(selection.get("selectedRange").is_none() && selection.get("start").is_none());
            let item = &selection["selectedItems"][0];
            assert_eq!(item["role"], "AXRow");
            assert_eq!(
                item.as_object().unwrap().len(),
                if capture_text { 2 } else { 1 }
            );
            assert_eq!(item.get("value").is_some(), capture_text);
            if capture_text {
                assert_eq!(
                    item["value"],
                    item_selection().items[0].value.clone().unwrap()
                );
                assert_eq!(event["contentState"], "available");
                assert_eq!(
                    event["contentDomains"],
                    json!(["example.com", "frame.example"])
                );
            } else {
                assert_eq!(event["contentState"], "metadataOnly");
                assert!(event.get("contentDomains").is_none());
            }
            let encoded = serde_json::to_string(&event).unwrap();
            for private in ["runtimeId", "RuntimeId", "[42,710]", "[42,709]", "[42,711]"] {
                assert!(!encoded.contains(private), "{private}");
            }
        }
        original.item_selection.as_mut().unwrap().items.clear();
        let cleared = home
            .policy(true)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(cleared["selection"], json!({ "selectedItems": [] }));
        assert_eq!(cleared["contentState"], "unavailable");
    }

    #[test]
    fn item_selection_rejects_invalid_membership_and_roles_in_both_modes() {
        let home = Home::new();
        for case in 0..12 {
            let mut original = snapshot();
            let mut selection = item_selection();
            match case {
                0 => selection.owner_runtime_id.clear(),
                1 => selection.owner_runtime_id = vec![1; 33],
                2 => selection.document_runtime_id = vec![1; 33],
                3 => selection.document_runtime_id.clear(),
                4 => selection.items[0].runtime_id.clear(),
                5 => selection.items[0].runtime_id = vec![1; 33],
                6 => selection.items[0].runtime_id = selection.owner_runtime_id.clone(),
                7 => selection.items[0].runtime_id = selection.document_runtime_id.clone(),
                8 => selection.items.push(selection.items[0].clone()),
                9 => {
                    selection.items = (0..33)
                        .map(|id| SelectedItem {
                            runtime_id: vec![43, id],
                            ..selection.items[0].clone()
                        })
                        .collect()
                }
                10 => selection.items[0].role = "AXSecureTextField".into(),
                _ => selection.items[0].role = "AXWindow".into(),
            }
            original.item_selection = Some(selection);
            for capture_text in [true, false] {
                assert!(
                    home.policy(capture_text)
                        .project(&original, "selection.changed", 1, now())
                        .is_none(),
                    "case={case}, capture_text={capture_text}"
                );
            }
        }
        let mut native = snapshot();
        native.url = None;
        native.domains.clear();
        let mut selection = item_selection();
        selection.document_runtime_id.clear();
        native.item_selection = Some(selection);
        assert!(
            home.policy(true)
                .project(&native, "selection.changed", 1, now())
                .is_some()
        );
    }

    #[test]
    fn item_selection_obeys_source_security_and_application_domain_denials() {
        let home = Home::new();
        let mut original = snapshot();
        original.item_selection = Some(item_selection());
        for capture_text in [true, false] {
            let policy = home.policy(capture_text);
            for flag in ["secure", "private", "sourceKnown"] {
                let mut wire = serde_json::to_value(&original).unwrap();
                wire[flag] = json!(flag != "sourceKnown");
                let denied = serde_json::from_value(wire).unwrap();
                assert!(
                    policy
                        .project(&denied, "selection.changed", 1, now())
                        .is_none()
                );
            }
            for block in [
                json!({ "scope": "application", "bundleID": "win32.chrome" }),
                json!({ "scope": "url", "urlDomain": "frame.example" }),
            ] {
                let mut value = config(capture_text);
                value["observation"]["blocklist"] = json!([block]);
                home.config(value);
                assert!(
                    Policy::load(&home.0)
                        .unwrap()
                        .project(&original, "selection.changed", 1, now())
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn item_selection_encoded_budget_retains_all_members_or_rejects() {
        let home = Home::new();
        let policy = home.policy(true);
        let mut original = snapshot();
        let mut selection = item_selection();
        selection.items = (0..32)
            .map(|id| SelectedItem {
                runtime_id: vec![43, id],
                role: "AXRow".into(),
                value: Some("\u{4e2d}\"\\\n".repeat(8)),
            })
            .collect();
        original.item_selection = Some(selection);
        let event = policy
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        let items = &event["selection"]["selectedItems"];
        assert_eq!(items.as_array().unwrap().len(), 32);
        assert!(serde_json::to_vec(items).unwrap().len() <= MAX_SELECTION_BYTES);
        // Raw UTF-8 fits, but JSON escaping makes the complete membership too large.
        for item in &mut original.item_selection.as_mut().unwrap().items {
            item.value = Some("\"".repeat(128));
        }
        assert!(
            policy
                .project(&original, "selection.changed", 1, now())
                .is_none()
        );
        let metadata = home
            .policy(false)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(
            metadata["selection"]["selectedItems"]
                .as_array()
                .unwrap()
                .len(),
            32
        );
        original.item_selection = Some(item_selection());
        original.item_selection.as_mut().unwrap().items[0].value =
            Some("x".repeat(MAX_SELECTION_BYTES + 1));
        assert!(
            policy
                .project(&original, "selection.changed", 1, now())
                .is_none()
        );
    }

    #[test]
    fn item_selection_and_selected_text_share_the_total_body_allocation() {
        let home = Home::new();
        let mut original = snapshot();
        original.text = Some("b".repeat(MAX_TEXT_BYTES));
        original.selection = Some(Selection {
            selected_text: Some("s".repeat(MAX_SELECTION_BYTES + 1)),
            start: 17,
            length: Some(20_000),
            truncated: false,
        });
        original.item_selection = Some(item_selection());
        let event = home
            .policy(true)
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        let selection = &event["selection"];
        let items_bytes = serde_json::to_vec(&selection["selectedItems"])
            .unwrap()
            .len();
        assert!(items_bytes > 0);
        assert_eq!(
            event["ax"]["text"].as_str().unwrap().len()
                + selection["selectedText"].as_str().unwrap().len()
                + items_bytes,
            MAX_TEXT_BYTES,
        );
        assert_eq!(
            selection["selectedRange"],
            json!({ "location": 17, "length": 20_000 })
        );
        assert_eq!(selection["truncated"], true);
        assert_eq!(event["ax"]["truncated"], true);
    }

    #[test]
    fn item_selection_does_not_attach_old_content_to_input_or_session_events() {
        let home = Home::new();
        let mut original = snapshot();
        original.item_selection = Some(item_selection());
        original.input_target = Some(InputTarget {
            hwnd: 100,
            role: "AXTextField".into(),
            uia: None,
        });
        for capture_text in [true, false] {
            let policy = home.policy(capture_text);
            for kind in [
                "session.started",
                "session.ended",
                "keyboard.submit",
                "mouse.click",
            ] {
                original.action = Some(if kind == "mouse.click" {
                    Action::Mouse {
                        button: "left".into(),
                        modifiers: vec![],
                    }
                } else {
                    Action::Keyboard {
                        key: "return".into(),
                        modifiers: vec![],
                    }
                });
                let event = policy.project(&original, kind, 1, now()).unwrap();
                assert!(event.get("selection").is_none(), "{kind}");
                assert!(
                    !serde_json::to_string(&event)
                        .unwrap()
                        .contains("synthetic leaf")
                );
            }
        }
    }
}
