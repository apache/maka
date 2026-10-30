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

use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;

use maka_event_log::{
    EventLog, StoreError,
    bundle::{BundleError, StagedBundle},
};
use serde_json::{Value, json};
use sqlx::Connection;
use std::collections::BTreeMap;

pub(crate) async fn roundtrip(bytes: &[u8]) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("destination.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("destination", "destination", &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "destination".into(),
        turn_id: "destination-turn".into(),
        run_id: "destination-run".into(),
        invocation_id: "destination-invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            input: InvocationInput::Code {
                source: "local history".into(),
            },
            configuration: None,
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
    let binding = maka_agent_facts::artifact::content_digest(b"selected destination");
    let staged = StagedBundle::read(bytes).await.unwrap();
    let root = staged.summary().inventory.root_session_id.clone();
    let bindings: BTreeMap<String, Value> = staged
        .summary()
        .inventory
        .sessions
        .iter()
        .map(|s| (s.id.clone(), json!({"policy":"destination policy"})))
        .collect();

    let mut faults = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new().filename(&path),
    )
    .await
    .unwrap();
    sqlx::raw_sql(
        "CREATE TRIGGER fail_bundle AFTER INSERT ON event_log BEGIN SELECT RAISE(ABORT,'fixture publication fault'); END;",
    ).execute(&mut faults).await.unwrap();
    assert!(
        log.import_bundle(staged, &binding, bindings.clone())
            .await
            .is_err()
    );
    for query in [
        "SELECT COUNT(*) FROM session_bundle_imports",
        "SELECT COUNT(*) FROM session_bundle_members",
        "SELECT COUNT(*) FROM imported_invocations",
        "SELECT COUNT(*) FROM session_history_copies",
    ] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(query)
                .fetch_one(&mut faults)
                .await
                .unwrap(),
            0
        );
    }
    assert!(log.get_session::<Value>(&root).await.unwrap().is_none());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM event_log")
            .fetch_one(&mut faults)
            .await
            .unwrap(),
        2
    );
    sqlx::query("DROP TRIGGER fail_bundle")
        .execute(&mut faults)
        .await
        .unwrap();
    faults.close().await.unwrap();

    let receipt = log
        .import_bundle(
            StagedBundle::read(bytes).await.unwrap(),
            &binding,
            bindings.clone(),
        )
        .await
        .unwrap();
    assert_eq!(receipt.root_session_id, root);
    assert_eq!(
        log.bundle_import_receipt(&receipt.bundle_digest, &binding)
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    assert!(*log.subscribe_commits().borrow() > 2);
    assert!(
        log.session_catalog_changes(2, *log.subscribe_commits().borrow(), 128)
            .await
            .unwrap()
            .is_empty(),
        "historical import must not replay live catalog notifications"
    );
    assert!(log.session_copy_receipt(&root).await.unwrap().is_none());
    assert_eq!(
        log.get_session::<Value>(&root)
            .await
            .unwrap()
            .unwrap()
            .configuration,
        bindings[&root]
    );
    assert_eq!(
        log.import_bundle(
            StagedBundle::read(bytes).await.unwrap(),
            &binding,
            bindings.clone()
        )
        .await
        .unwrap(),
        receipt
    );
    let mut changed = bindings.clone();
    changed.insert(root.clone(), json!({"policy":"another policy"}));
    assert_eq!(
        log.import_bundle(
            StagedBundle::read(bytes).await.unwrap(),
            &binding,
            changed.clone()
        )
        .await
        .unwrap(),
        receipt,
        "an accepted binding is not re-resolved against changed defaults"
    );
    assert!(matches!(
        log.import_bundle(
            StagedBundle::read(bytes).await.unwrap(),
            &maka_agent_facts::artifact::content_digest(b"other destination"),
            changed
        )
        .await,
        Err(BundleError::Store(StoreError::SessionConflict))
    ));
    reexport(&log, &root).await;
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.import_bundle(
            StagedBundle::read(bytes).await.unwrap(),
            &binding,
            bindings.clone()
        )
        .await
        .unwrap(),
        receipt
    );
    let imported = log.prefix(1024, 8 * 1024 * 1024).await.unwrap();
    let foreign = imported
        .events
        .iter()
        .find(|stored| {
            stored.event.invocation.session_id != "destination"
                && matches!(stored.event.fact, Fact::InvocationOpened { .. })
        })
        .unwrap()
        .event
        .invocation
        .clone();
    assert!(matches!(
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                foreign,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                }
            ))
            .unwrap()
        )
        .await,
        Err(CommitError::Rejected(reason))
            if reason == "imported invocation is historical evidence, not locally accepted work"
    ));
    // A new publication cannot append imported history after a canonical local owner.
    let collision_path = dir.path().join("collision.sqlite");
    let collision = EventLog::open(&collision_path).await.unwrap();
    collision
        .create_session(&root, "local-owner", &json!({}), 1)
        .await
        .unwrap();
    collision
        .append(&local_event(
            &root,
            "collision-local",
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Code {
                    source: "existing local owner".into(),
                },
            },
        ))
        .await
        .unwrap();
    let before_collision = collision.prefix(10, 16_384).await.unwrap();
    assert!(matches!(
        collision
            .import_bundle(
                StagedBundle::read(bytes).await.unwrap(),
                &binding,
                bindings.clone()
            )
            .await,
        Err(BundleError::Store(StoreError::SessionConflict))
    ));
    assert_eq!(
        serde_json::to_vec(&collision.prefix(10, 16_384).await.unwrap()).unwrap(),
        serde_json::to_vec(&before_collision).unwrap()
    );
    collision.close().await.unwrap();
    let inspect = rusqlite::Connection::open(&collision_path).unwrap();
    inspect
        .execute_batch(
            "UPDATE event_log SET retained_json=event_json,body_digest='fixture',event_json=NULL",
        )
        .unwrap();
    let collision = EventLog::open(&collision_path).await.unwrap();
    let inventory = collision.preview_bundle(&root).await.unwrap();
    assert!(matches!(
        collision
            .export_bundle(&root, &inventory.subtree_digest, Vec::new())
            .await,
        Err(BundleError::Store(StoreError::MaterialCollected)),
    ));
    collision.close().await.unwrap();
    inspect
        .execute("DELETE FROM session_control WHERE id=?", [&root])
        .unwrap();
    let collision = EventLog::open(&collision_path).await.unwrap();
    assert!(
        collision
            .get_session::<Value>(&root)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        collision
            .import_bundle(
                StagedBundle::read(bytes).await.unwrap(),
                &binding,
                bindings.clone(),
            )
            .await,
        Err(BundleError::Store(StoreError::SessionConflict)),
    ));
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM event_log", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        inspect
            .query_row("SELECT COUNT(*) FROM session_bundle_imports", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    collision.close().await.unwrap();

    log.close().await.unwrap();
}

async fn reexport(log: &EventLog, root: &str) {
    let inventory = log.preview_bundle(root).await.unwrap();
    let (bytes, _) = log
        .export_bundle(root, &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    let mut staged = StagedBundle::read(bytes.as_slice()).await.unwrap();
    staged.validate_history().await.unwrap();
    staged.close().await.unwrap();
    log.capture_model_context(root, None, 100_000, 64 * 1024 * 1024)
        .await
        .unwrap();
}

fn local_event(session: &str, id: &str, fact: Fact) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        Invocation {
            session_id: session.into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        fact,
    ))
    .unwrap()
}
