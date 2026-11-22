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
use super::*;
use crate::root::{RootNamespaces, RootOwner};
use maka_plugin_core::storage::{Data, Mutation, Namespace};
use serde_json::json;
use std::sync::Arc;

fn owner(path: &std::path::Path) -> Arc<RootOwner> {
    Arc::new(
        RootOwner::create(
            &path.join("root"),
            &RootNamespaces {
                ownership: path.join("ownership"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    )
}
fn notification() -> serde_json::Value {
    json!({"messageId": "notification", "request": "frozen"})
}
#[tokio::test]
async fn completion_records_reopen_without_schema_changes_and_keep_frozen_identity() {
    let dir = tempfile::tempdir().unwrap();
    let owner = owner(dir.path());
    let root = RootStore::open(owner.clone(), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    root.register_message_completion("host", "worker", "message", "caller", json!({"route":1}))
        .await
        .unwrap();
    let entries = root.message_completions("host", None).await.unwrap();
    let key = &entries[0].key;
    let frozen = notification();
    root.settle_message_completion("host", key, Some(frozen.clone()))
        .await
        .unwrap();
    // Retrying registration must not erase an already frozen delivery.
    root.register_message_completion("host", "worker", "message", "caller", json!({"route":1}))
        .await
        .unwrap();
    assert!(
        root.register_message_completion("host", "worker", "message", "caller", json!({"route":2}))
            .await
            .is_err()
    );
    root.close().await.unwrap();
    let root = RootStore::open(owner, crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let entries = root.message_completions("host", None).await.unwrap();
    assert_eq!(entries[0].notification, Some(frozen.clone()));
    root.settle_message_completion("host", key, Some(frozen.clone()))
        .await
        .unwrap();
    let mut changed = frozen;
    changed["request"] = json!("changed");
    assert!(
        root.settle_message_completion("host", key, Some(changed))
            .await
            .is_err()
    );
    assert!(
        root.settle_message_completion("other", key, None)
            .await
            .is_err()
    );
    root.settle_message_completion("host", key, None)
        .await
        .unwrap();
    root.log
        .connection
        .read(|db| {
            let migrations: i64 =
                db.query_row("SELECT MAX(version) FROM _sqlx_migrations", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(
                migrations,
                crate::ROOT_MIGRATIONS
                    .iter()
                    .map(|migration| migration.version)
                    .max()
                    .unwrap()
            );
            let dedicated: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='message_completions')",
                [],
                |r| r.get(0),
            )?;
            assert!(!dedicated);
            Ok(())
        })
        .await
        .unwrap();
    root.close().await.unwrap();
}
#[tokio::test]
async fn completion_scans_are_scoped_paged_and_do_not_retain_task_tombstones() {
    let dir = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(dir.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let namespace =
        Namespace::new("ordinary.plugin", maka_plugin_core::scope::Scope::Profile).unwrap();
    root.plugin_data_batch(
        &namespace,
        vec![Mutation {
            key: "existing".into(),
            expected_revision: None,
            data: Data::Present(json!(1)),
        }],
    )
    .await
    .unwrap();
    root.plugin_data_batch(
        &namespace,
        vec![Mutation {
            key: "existing".into(),
            expected_revision: Some(1),
            data: Data::Deleted,
        }],
    )
    .await
    .unwrap();
    for i in 0..70 {
        root.register_message_completion(
            "host",
            "worker",
            &format!("message-{i:03}"),
            "caller",
            json!({"route":i}),
        )
        .await
        .unwrap();
    }
    root.register_message_completion("host-other", "worker", "message", "caller", json!({}))
        .await
        .unwrap();
    assert!(
        root.has_message_completions("host", "worker", "caller")
            .await
            .unwrap()
    );
    assert!(
        !root
            .has_message_completions("host", "worker", "caller-other")
            .await
            .unwrap()
    );
    let first = root.message_completions("host", None).await.unwrap();
    assert_eq!(first.len(), 64);
    let second = root
        .message_completions("host", Some(&first.last().unwrap().key))
        .await
        .unwrap();
    assert_eq!(second.len(), 6);
    assert!(
        root.message_completions("host-other", Some(&first[0].key))
            .await
            .is_err()
    );
    for entry in first.into_iter().chain(second) {
        root.settle_message_completion("host", &entry.key, None)
            .await
            .unwrap();
    }
    assert!(
        root.message_completions("host", None)
            .await
            .unwrap()
            .is_empty()
    );
    root.log
        .connection
        .read(|db| {
            let remaining: i64 = db.query_row(
                "SELECT COUNT(*) FROM plugin_data WHERE package_id=?",
                [PACKAGE],
                |r| r.get(0),
            )?;
            assert_eq!(
                remaining, 1,
                "only the other owner's live subscription remains"
            );
            Ok(())
        })
        .await
        .unwrap();
    let ordinary = root
        .plugin_data(&namespace, "existing")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(ordinary.revision, 2);
    assert!(matches!(ordinary.data, Data::Deleted));
    root.close().await.unwrap();
}
#[tokio::test]
async fn completion_pages_bound_payload_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(dir.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    let value = json!({"route":"x".repeat(1100000)});
    for id in ["one", "two"] {
        root.register_message_completion("host", "worker", id, "caller", value.clone())
            .await
            .unwrap();
    }
    let first = root.message_completions("host", None).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        root.message_completions("host", Some(&first[0].key))
            .await
            .unwrap()
            .len(),
        1
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn completion_registration_rolls_back_with_its_admission_transaction() {
    use crate::writeback::Statement;
    let dir = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(dir.path()), crate::ROOT_MIGRATIONS)
        .await
        .unwrap();
    root.log
        .connection
        .run(|db| {
            let tx =
                rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            RegisterCompletion {
                owner: "host".into(),
                session: "worker".into(),
                message: "task".into(),
                recipient: "caller".into(),
                request: json!({"route": 1}),
            }
            .execute(&tx)?;
            tx.rollback()?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        root.message_completions("host", None)
            .await
            .unwrap()
            .is_empty()
    );
    root.close().await.unwrap();
}
