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
const MAX_URL_BYTES: usize = 8192;
const MAX_EVENT_ID: u64 = (1_u64 << 53) - 1;

/// Worker transport only. Never persist this object without Policy::project.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub app_id: String,
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
    pub source_id: String,
    pub domains: Vec<String>,
    pub secure: bool,
    pub private: bool,
    pub source_known: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub selected_text: String,
    pub truncated: bool,
    pub start: u32,
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

    pub fn permits_app(&self, app_id: &str) -> bool {
        let Some(app_id) = windows_application_id(app_id) else {
            return false;
        };
        let matches = |rules: &[Rule]| {
            rules.iter().any(|rule| {
                if let Rule::Application { app_id: candidate } = rule {
                    *candidate == app_id
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
            || !self.permits_app(&app_id)
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
        if self.capture_text
            && let Some(text) = snapshot.text.as_deref()
        {
            let (text, truncated) = bounded(text, MAX_TEXT_BYTES, true);
            if !text.trim().is_empty() {
                event["ax"] = json!({ "mode": "fullTree", "text": text,
                    "truncated": truncated || snapshot.text_truncated });
                event["contentState"] = json!("available");
                event["contentDomains"] = json!(domains);
            }
        }
        if self.capture_text
            && let Some(selection) = &snapshot.selection
            && !selection.selected_text.is_empty()
        {
            let (text, truncated) = bounded(&selection.selected_text, 4096, true);
            event["selection"] = json!({
                "selectedText": text, "start": selection.start,
                "truncated": truncated || selection.truncated,
            });
            event["contentState"] = json!("available");
            event["contentDomains"] = json!(domains);
        }
        Some(event)
    }
}

fn application_id(value: &str) -> Option<String> {
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
            app_id: "win32.chrome".into(),
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
            selected_text: "  selected\ttext\r\n".into(),
            truncated: true,
            start: 7,
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
        assert!(metadata.get("selection").is_none());
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
        original.selection.as_mut().unwrap().selected_text = "\u{4e2d}".repeat(4096);
        let event = policy
            .project(&original, "selection.changed", 1, now())
            .unwrap();
        assert_eq!(
            event["selection"]["selectedText"].as_str().unwrap().len(),
            4095
        );
        assert_eq!(event["selection"]["truncated"], true);
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
}
