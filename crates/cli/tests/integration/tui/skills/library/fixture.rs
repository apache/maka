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

use super::{Pty, Value, fs, json};
use maka_protocol::plugin::{RemoteBinding, RemoteRequest, RemoteResult};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use unicode_width::UnicodeWidthStr;

pub(super) const NAME: &str = "PTY review 中文";
pub(super) const REFERENCE: &str = "workspace:legacy:review";

pub(super) fn document(body: &str) -> String {
    format!("---\nname: {NAME}\ndescription: Review precise library changes\n---\n{body}\n")
}

/// Read-only observation through an independent real Client. All normal
/// lifecycle mutations in this fixture must come from the PTY.
pub(super) async fn read(client: &maka_client::Client, method: &str, input: Value) -> Value {
    let binding = RemoteBinding::Package {
        package_id: "maka.skills".into(),
        method: method.into(),
        session_id: Some("skill-library".into()),
    };
    let RemoteResult::Bound { target, .. } = client
        .plugin_remote(RemoteRequest::Bind {
            binding: binding.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("bound Skills")
    };
    let RemoteResult::Document { document } = client
        .plugin_remote(RemoteRequest::OpenDocument)
        .await
        .unwrap()
    else {
        panic!("Skills document")
    };
    let result = client
        .plugin_remote(RemoteRequest::Call {
            binding,
            target,
            document,
            input,
        })
        .await
        .unwrap();
    client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
        .unwrap();
    let RemoteResult::Value { value } = result else {
        panic!("Skills readback")
    };
    value
}

pub(super) async fn candidate(client: &maka_client::Client) -> Option<Value> {
    let page = read(client, "request", json!({"kind":"invocable","page":null})).await;
    page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["ref"] == REFERENCE)
        .cloned()
}

pub(super) fn installed(root: &Path) -> PathBuf {
    let directories: Vec<_> = fs::read_dir(root.join("plugin-data"))
        .unwrap()
        .map(|entry| entry.unwrap().path().join("skills/review"))
        .filter(|path| path.is_dir())
        .collect();
    assert_eq!(
        directories.len(),
        1,
        "exactly one Profile-private installation"
    );
    directories.into_iter().next().unwrap()
}

pub(super) fn verify(installed: &Path, document: &str) {
    assert_eq!(
        fs::read(installed.join("SKILL.md")).unwrap(),
        document.as_bytes()
    );
    assert_eq!(
        fs::read(installed.join(".maka/baseline/SKILL.md")).unwrap(),
        document.as_bytes()
    );
    let lock: Value =
        serde_json::from_slice(&fs::read(installed.join("skill.lock.json")).unwrap()).unwrap();
    assert_eq!(
        lock["contentSha256"],
        maka_runtime::artifact::content_digest(document.as_bytes())
    );
}

pub(super) fn files(entries: &[(&str, &[u8])]) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    entries
        .iter()
        .map(|(path, bytes)| (PathBuf::from(path), Some(bytes.to_vec())))
        .collect()
}

pub(super) fn tree(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let kind = entry.file_type().unwrap();
            assert!(
                !kind.is_symlink(),
                "fixture tree cannot escape its temporary directory"
            );
            entries.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                if kind.is_file() {
                    Some(fs::read(&path).unwrap())
                } else {
                    None
                },
            );
            if kind.is_dir() {
                visit(root, &path, entries);
            }
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

pub(super) fn selection(checkpoint: &Path, candidate: &Value) -> Value {
    let saved: Value = serde_json::from_slice(&fs::read(checkpoint).unwrap()).unwrap();
    assert_eq!(saved["ascii"], true);
    assert!(saved["unresolved"].as_array().unwrap().is_empty());
    let picked = saved["skills"]["skill-library"].as_array().unwrap();
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0]["name"], NAME);
    // Match the exact catalog candidate, not only its display name.
    assert_eq!(picked[0]["id"], candidate["id"]);
    assert_eq!(candidate["ref"], REFERENCE);
    picked[0].clone()
}

/// Public Input text editors occupy the same row, to the right of their label.
/// Clicking the label would activate the row's default submit action.
pub(super) fn enter_path(tui: &mut Pty, path: &Path) {
    let label = "Absolute file path on the Host";
    let screen = tui.screen.snapshot().unwrap().screen;
    let (row, column) = screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| {
            line.find(label)
                .map(|byte| (row, line[..byte + label.len()].width() + 2))
        })
        .unwrap_or_else(|| panic!("Missing import field: {screen}"));
    tui.click_at(row, column);
    tui.send(format!("\x1b[200~{}\x1b[201~", path.display()).as_bytes());
    tui.wait_for("review.md");
}

pub(super) fn chinese_command(tui: &mut Pty, label: &str) {
    tui.send(b"\x10");
    tui.wait_for("搜索命令…");
    tui.send(format!("\x1b[200~{label}\x1b[201~").as_bytes());
    tui.wait_until(|s| !s.contains("搜索命令…") && s.contains(label));
    // The localized query and result have identical text. Enter activates the
    // selected result; a text click would hit the query field first.
    tui.send(b"\r");
}

pub(super) fn outside(tui: &mut Pty, sheet: &str) {
    tui.send(b"\x1b[<0;1;1M\x1b[<0;1;1m");
    tui.wait_until(|s| !s.contains(sheet) && s.contains(NAME));
}

/// Short documents fit the inner code wells; scroll only the page to reach
/// the lower preview and actions on an actual terminal viewport.
pub(super) fn reveal(tui: &mut Pty, text: &str) {
    for _ in 0..12 {
        let previous = tui.screen.snapshot().unwrap().screen;
        if previous.contains(text) {
            return;
        }
        // Right-edge page scrolling avoids scrolling either embedded Code well.
        tui.send(b"\x1b[<65;119;20M");
        tui.wait_until(|screen| screen != previous || screen.contains(text));
    }
    tui.wait_for(text);
}
