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
use std::{path::Path, time::Duration};
use tokio::sync::oneshot;

fn owner(path: &Path) -> Arc<root::RootOwner> {
    Arc::new(root::RootOwner::create(&path.join("root"), &namespaces(path)).unwrap())
}
fn namespaces(path: &Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}

#[tokio::test]
async fn reservations_recover_before_becoming_visible_and_never_move() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    let (partition, _) = store
        .reserve_creation(
            "pending",
            "fingerprint",
            routes::Creation::Session {
                configuration: serde_json::json!({"value":1}),
                created_at: 1,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        store.session("pending").await,
        Err(StoreError::SessionNotFound)
    ));
    store.close().await.unwrap();
    let store = RootStore::open(owner.clone()).await.unwrap();
    let session = store.session("pending").await.unwrap();
    assert!(Arc::ptr_eq(
        &session.owner().unwrap(),
        &store.partitions[partition]
    ));
    assert_eq!(
        session
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .configuration,
        serde_json::json!({"value":1})
    );
    store
        .create_session(
            "pending",
            "fingerprint",
            &serde_json::json!({"value":1}),
            99,
        )
        .await
        .unwrap();
    assert!(matches!(
        store
            .create_session(
                "pending",
                "fingerprint",
                &serde_json::json!({"value":2}),
                99
            )
            .await,
        Err(StoreError::SessionConflict)
    ));
    let rows: i64 = store
        .control
        .connection
        .read(|connection| {
            Box::pin(async move {
                Ok(sqlx::query_scalar("SELECT count(*) FROM session_control")
                    .fetch_one(connection)
                    .await?)
            })
        })
        .await
        .unwrap();
    assert_eq!(rows, 0);
    store.close().await.unwrap();
    assert!(matches!(
        session.get::<serde_json::Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
}

#[tokio::test]
async fn blocked_partition_does_not_block_other_writers_or_shutdown_signals() {
    let directory = tempfile::tempdir().unwrap();
    let store = RootStore::open(owner(directory.path())).await.unwrap();
    let session = store
        .create_session("one", "one", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let first = partition_for(b"session", "one");
    let other_id = (0..100)
        .map(|n| format!("other-{n}"))
        .find(|id| partition_for(b"session", id) != first)
        .unwrap();
    let other = partition_for(b"session", &other_id);
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let partition = store.partitions[first].clone();
    let writer = tokio::spawn(async move {
        partition
            .connection
            .run(move |connection| {
                Box::pin(async move {
                    let _ = entered.send(());
                    released.await.unwrap();
                    sqlx::query("UPDATE session_control SET updated_at=42 WHERE id='one'")
                        .execute(connection)
                        .await?;
                    Ok(())
                })
            })
            .await
    });
    started.await.unwrap();
    let independent = tokio::time::timeout(
        Duration::from_secs(10),
        store.create_session(&other_id, "other", &serde_json::json!({}), 2),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        independent
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .is_some()
    );
    let blocked_receipt = store.partitions[first].connection.close_receipt();
    let other_receipt = store.partitions[other].connection.close_receipt();
    // Drop must notify every owner without waiting for the blocked writer.
    let root_receipt = store.lifecycle.as_ref().unwrap().receipt();
    drop(store);
    assert!(matches!(
        session.get::<serde_json::Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    tokio::time::timeout(Duration::from_secs(10), other_receipt)
        .await
        .unwrap()
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), blocked_receipt.clone())
            .await
            .is_err()
    );
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path())
        )
        .is_err()
    );
    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), blocked_receipt)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), root_receipt)
        .await
        .unwrap()
        .unwrap();
    let reopened = Arc::new(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .unwrap(),
    );
    let store = RootStore::open(reopened).await.unwrap();
    assert_eq!(
        store
            .session("one")
            .await
            .unwrap()
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .updated_at,
        42
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn rejects_legacy_data_without_migrating_or_hiding_it() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let old = EventLog::for_root(owner.clone()).await.unwrap();
    old.create_session("old", "old", &serde_json::json!({}), 1)
        .await
        .unwrap();
    old.close().await.unwrap();
    assert!(matches!(
        RootStore::open(owner.clone()).await,
        Err(StoreError::UnsupportedDatabase)
    ));
    let old = EventLog::for_root(owner).await.unwrap();
    assert!(
        old.get_session::<serde_json::Value>("old")
            .await
            .unwrap()
            .is_some()
    );
    old.close().await.unwrap();
}

#[tokio::test]
async fn invalid_and_rejected_creations_cannot_poison_restart() {
    let directory = tempfile::tempdir().unwrap();
    let owner = owner(directory.path());
    let store = RootStore::open(owner.clone()).await.unwrap();
    assert!(matches!(
        store
            .create_session("invalid", "", &serde_json::json!({}), 1)
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let missing = maka_agent_facts::workspace::BindingRef {
        id: uuid::Uuid::new_v4(),
        permission_epoch_at_attach: 0,
        metadata_epoch_at_attach: 0,
    };
    let configuration = serde_json::json!({"workspace":missing,"boundary_revision":0});
    assert!(matches!(
        store
            .create_session("rejected", "rejected", &configuration, 1)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    // Simulate loss of the control completion after the partition has committed.
    let (partition, _) = store
        .reserve_creation(
            "committed",
            "committed",
            routes::Creation::Session {
                configuration: serde_json::json!({}),
                created_at: 2,
            },
        )
        .await
        .unwrap();
    store.partitions[partition]
        .create_session("committed", "committed", &serde_json::json!({}), 2)
        .await
        .unwrap();
    store.close().await.unwrap();
    let store = RootStore::open(owner).await.unwrap();
    assert!(store.session("committed").await.is_ok());
    assert!(matches!(
        store.session("rejected").await,
        Err(StoreError::SessionNotFound)
    ));
    assert!(matches!(
        store
            .create_session("rejected", "rejected", &configuration, 9)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::MissingWorkspaceBinding
        ))
    ));
    // Pure validation did not reserve the invalid identity.
    store
        .create_session("invalid", "valid", &serde_json::json!({}), 3)
        .await
        .unwrap();
    store.close().await.unwrap();
}

#[tokio::test]
async fn every_partition_reads_control_bindings_without_copying_them() {
    let directory = tempfile::tempdir().unwrap();
    let root = owner(directory.path());
    let store = RootStore::open(root.clone()).await.unwrap();
    store.control.connection.run(|connection| Box::pin(async move {
        sqlx::query("INSERT INTO workspace_bindings(id,owner_scope,selection_digest,workspace_json,permission_epoch,metadata_epoch) VALUES('control-only','owner','selection','{}',4,5)")
            .execute(connection).await?;
        Ok(())
    })).await.unwrap();
    for partition in &store.partitions {
        partition
            .connection
            .run(|connection| {
                Box::pin(async move {
                    let id: String = sqlx::query_scalar("SELECT id FROM workspace_bindings")
                        .fetch_one(&mut *connection)
                        .await?;
                    assert_eq!(id, "control-only");
                    let count: i64 =
                        sqlx::query_scalar("SELECT COUNT(*) FROM main.workspace_bindings")
                            .fetch_one(&mut *connection)
                            .await?;
                    assert_eq!(count, 0);
                    assert!(
                        sqlx::query(
                            "UPDATE root_control.workspace_bindings SET permission_epoch=99"
                        )
                        .execute(connection)
                        .await
                        .is_err()
                    );
                    Ok(())
                })
            })
            .await
            .unwrap();
        partition
            .connection
            .read(|connection| {
                Box::pin(async move {
                    let epoch: i64 =
                        sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings")
                            .fetch_one(connection)
                            .await?;
                    assert_eq!(epoch, 4);
                    Ok(())
                })
            })
            .await
            .unwrap();
    }
    store.close().await.unwrap();
    // Reopening migrates/initializes main first and reinstalls every TEMP view.
    let store = RootStore::open(root).await.unwrap();
    for partition in &store.partitions {
        partition
            .connection
            .run(|connection| {
                Box::pin(async move {
                    let epoch: i64 =
                        sqlx::query_scalar("SELECT permission_epoch FROM workspace_bindings")
                            .fetch_one(connection)
                            .await?;
                    assert_eq!(epoch, 4);
                    Ok(())
                })
            })
            .await
            .unwrap();
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn rejects_legacy_non_session_journals_without_orphaning_rows() {
    for (table, statement) in [
        (
            "plugin_data",
            "INSERT INTO plugin_data VALUES ('plugin','profile','key',1,'{}')",
        ),
        (
            "application_intents",
            "INSERT INTO application_intents (deployment,consumer,operation,source_revision,reference_json) VALUES ('deployment','[]','operation',1,'{}')",
        ),
        (
            "application_ui_checkpoints",
            "INSERT INTO application_ui_checkpoints VALUES ('deployment','[]','key',1,'v1','{}','{}',x'010203')",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let owner = owner(directory.path());
        let old = EventLog::for_root(owner.clone()).await.unwrap();
        old.connection
            .run(move |connection| {
                Box::pin(async move {
                    sqlx::raw_sql(statement).execute(connection).await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        old.close().await.unwrap();
        assert!(
            matches!(
                RootStore::open(owner.clone()).await,
                Err(StoreError::UnsupportedDatabase)
            ),
            "{table}"
        );
        let old = EventLog::for_root(owner).await.unwrap();
        old.connection.read(move |connection| Box::pin(async move {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            assert_eq!(sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql.as_str())).fetch_one(&mut *connection).await?, 1);
            assert!(!sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='root_store_layout')").fetch_one(connection).await?);
            Ok(())
        })).await.unwrap();
        old.close().await.unwrap();
    }
}

mod prepared_cache;
