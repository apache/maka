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

use maka_capabilities::filesystem::ReadRoot;
use maka_session_import::catalog::{self, Format, Query};
use serde_json::json;
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

fn write(root: &Path, path: &str, bytes: &[u8], mtime: u64) {
    let path = root.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    std::fs::File::open(path)
        .unwrap()
        .set_times(
            std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(mtime)),
        )
        .unwrap();
}
fn rollout(id: &str, cwd: Option<&str>, title: &str) -> Vec<u8> {
    format!(
        "{}\n{}\n",
        json!({"type":"session_meta","payload":{"id":id,"cwd":cwd,"source":"cli"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":title}})
    )
    .into_bytes()
}
fn query() -> Query {
    Query {
        cwd: None,
        text: String::new(),
        include_archived: false,
        limit: 20,
        cursor: None,
    }
}
fn owner() -> maka_capabilities::call::Scope {
    maka_capabilities::call::Issuer::default()
        .issue(
            maka_capabilities::call::Identity::Remote {
                request_id: uuid::Uuid::new_v4(),
            },
            CancellationToken::new(),
        )
        .unwrap()
}

#[tokio::test]
async fn catalog_paging_preserves_scope_archive_and_exact_wire_continuation() {
    let directory = tempfile::tempdir().unwrap();
    write(
        directory.path(),
        "sessions/2026/09/rollout-a.jsonl",
        &rollout("a", Some("/"), "Alpha"),
        10_000,
    );
    write(
        directory.path(),
        "sessions/2026/09/rollout-b.jsonl",
        &rollout("b", Some("C:\\Cafe\u{301}\\Repo\\"), "Beta"),
        20_000,
    );
    write(
        directory.path(),
        "archived_sessions/rollout-c.jsonl",
        &rollout("c", None, "Archived"),
        30_000,
    );
    let owner = owner();
    let root = ReadRoot::open(directory.path()).await.unwrap();
    let view = root.bind_scope(&owner);
    let first = catalog::list(
        &view,
        Format::Codex,
        Query {
            limit: 1,
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(first.entries[0].id, "b");
    let cursor = first.next.unwrap();
    assert!(
        catalog::list(
            &view,
            Format::Codex,
            Query {
                cursor: Some(cursor.clone()),
                text: "another query".into(),
                ..query()
            }
        )
        .await
        .is_err()
    );
    let second = catalog::list(
        &view,
        Format::Codex,
        Query {
            cursor: Some(cursor),
            limit: 1,
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(second.entries[0].id, "a");
    assert!(second.next.is_none());
    let archived = catalog::list(
        &view,
        Format::Codex,
        Query {
            include_archived: true,
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        archived
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["c", "b", "a"]
    );
    assert!(archived.entries[0].archived);
    let scoped = catalog::list(
        &view,
        Format::Codex,
        Query {
            cwd: Some("c:/CAFÉ/repo".into()),
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(scoped.entries.len(), 1);
    assert_eq!(scoped.entries[0].id, "b");
    let root_scope = catalog::list(
        &view,
        Format::Codex,
        Query {
            cwd: Some("/".into()),
            include_archived: true,
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        root_scope
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["a"]
    );

    for (id, cwd) in [("d", "C:\\"), ("e", "C:")] {
        write(
            directory.path(),
            &format!("sessions/rollout-{id}.jsonl"),
            &rollout(id, Some(cwd), "Drive"),
            40_000,
        );
    }
    let drive_root = catalog::list(
        &view,
        Format::Codex,
        Query {
            cwd: Some("c:/".into()),
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        drive_root
            .entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        ["d"]
    );

    // A wire page may stop before its item limit. Its next key must refer to the
    // last delivered row, not the last scanned or the first undelivered row.
    let cwd = format!("/{}", "w".repeat(54_000));
    for index in 0..20 {
        let id = if index == 0 {
            format!("large-0-{}", "x".repeat(129))
        } else {
            format!("large-{index}")
        };
        write(
            directory.path(),
            &format!("sessions/rollout-{id}.jsonl"),
            &rollout(&id, Some(&cwd), "Large"),
            40_000 + index,
        );
    }
    let mut seen = BTreeSet::new();
    let mut cursor = None;
    loop {
        let page = catalog::list(
            &view,
            Format::Codex,
            Query {
                cursor,
                text: "Large".into(),
                limit: 100,
                ..query()
            },
        )
        .await
        .unwrap();
        assert!(serde_json::to_vec(&page).unwrap().len() <= 48 * 1024 || page.entries.len() == 1);
        assert!(!page.entries.is_empty());
        for entry in page.entries {
            assert_eq!(entry.cwd.as_deref(), Some(cwd.as_str()));
            assert!(seen.insert(entry.id));
        }
        cursor = page.next;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 20);
    assert!(seen.contains(&format!("large-0-{}", "x".repeat(129))));
    owner.finish().await.unwrap();
}

#[tokio::test]
async fn claude_catalog_uses_bounded_real_cwd_even_when_the_first_record_is_partial() {
    let directory = tempfile::tempdir().unwrap();
    let row = format!(
        "{{\"type\":\"user\",\"sessionId\":\"aa-bb\",\"cwd\":\"/workspace/my-project\",\"message\":{{\"content\":\"{}\"}}}}\n",
        "x".repeat(600_000)
    );
    write(
        directory.path(),
        "projects/-workspace-my-project/aa-bb.jsonl",
        row.as_bytes(),
        10_000,
    );
    let nested = format!(
        "{{\"type\":\"user\",\"sessionId\":\"cc-dd\",\"nested\":{{\"cwd\":\"/workspace/my-project\"}},\"message\":{{\"content\":\"{}\"}}}}\n",
        "x".repeat(600_000)
    );
    write(
        directory.path(),
        "projects/-workspace-my-project/cc-dd.jsonl",
        nested.as_bytes(),
        20_000,
    );
    let owner = owner();
    let root = ReadRoot::open(directory.path()).await.unwrap();
    let view = root.bind_scope(&owner);
    let all = catalog::list(&view, Format::ClaudeCode, query())
        .await
        .unwrap();
    assert_eq!(all.entries.len(), 2);
    let scoped = catalog::list(
        &view,
        Format::ClaudeCode,
        Query {
            cwd: Some("/workspace/my-project".into()),
            ..query()
        },
    )
    .await
    .unwrap();
    assert_eq!(scoped.entries.len(), 1);
    assert_eq!(scoped.entries[0].id, "aa-bb");
    assert_eq!(scoped.entries[0].title, "aa-bb");
    let ambiguous = catalog::list(
        &view,
        Format::ClaudeCode,
        Query {
            cwd: Some("/workspace/my/project".into()),
            ..query()
        },
    )
    .await
    .unwrap();
    assert!(ambiguous.entries.is_empty());
    owner.finish().await.unwrap();
}
