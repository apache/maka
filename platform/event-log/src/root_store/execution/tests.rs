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
use futures_util::poll;
use serde_json::{Value, json};
use std::time::Duration;

async fn open(path: &std::path::Path) -> RootStore {
    let owner = root::RootOwner::create(&path.join("root"), &namespaces(path)).unwrap();
    RootStore::open(Arc::new(owner)).await.unwrap()
}
fn namespaces(path: &std::path::Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}

#[tokio::test]
async fn prepared_scope_can_cancel_and_shutdown_drains_accepted_work_before_sql() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let prepared = session.execution_scope(None).await.unwrap();
    let stale = prepared.store();
    drop(prepared);
    assert!(matches!(
        stale.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let scope = session.execution_scope(None).await.unwrap();
    let running = scope.store();
    let lease = scope.accept();
    let mut closing = Box::pin(root.shutdown());
    assert!(poll!(&mut closing).is_pending());
    assert!(matches!(
        session.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    let admitted = running.scoped().await.unwrap();
    admitted
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET updated_at=42 WHERE id='session'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(
        running.get::<Value>().await.unwrap().unwrap().updated_at,
        42
    );
    lease.finish();
    tokio::time::timeout(Duration::from_secs(10), closing)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        running.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    drop(root);
    let owner = root::RootOwner::open(
        &directory.path().join("root"),
        &namespaces(directory.path()),
    )
    .unwrap();
    RootStore::open(Arc::new(owner))
        .await
        .unwrap()
        .close()
        .await
        .unwrap();
}

#[tokio::test]
async fn execution_reuses_binding_pin_behind_queued_writer_and_cannot_rebind() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let reference = root
        .attach_workspace("owner", &json!({"path":"/tmp/original"}))
        .await
        .unwrap();
    let session = root
        .create_session(
            "session",
            "session",
            &json!({"workspace":reference,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let basis = PermissionBasis {
        boundary_revision: 0,
        binding: maka_agent_facts::workspace::BindingStamp {
            id: reference.id,
            permission_epoch: 0,
        },
    };
    assert!(matches!(
        session.execution_scope(None).await,
        Err(StoreError::PermissionRevoked)
    ));
    let scope = session.execution_scope(Some(basis)).await.unwrap();
    let running = scope.store();
    let lease = scope.accept();
    let mut writer = Box::pin(root.gates.write([gates::Key::Binding(reference.id)]));
    assert!(poll!(&mut writer).is_pending());
    let record = tokio::time::timeout(Duration::from_secs(2), running.get::<Value>())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let rejected = tokio::time::timeout(
        Duration::from_secs(2),
        running.update_session_metadata::<Value, _>("session", record.revision, |value| {
            value["title"] = json!("changed");
            Ok(())
        }),
    )
    .await
    .unwrap();
    assert!(matches!(rejected, Err(StoreError::InvalidTransition(_))));
    // A plain control handle also cannot switch the attachment underneath
    // this run's immutable binding lease.
    let other = root
        .attach_workspace("owner", &json!({"path":"/tmp/other"}))
        .await
        .unwrap();
    let rebind = session
        .update_session_metadata::<Value, _>("session", record.revision, move |value| {
            value["workspace"] = serde_json::to_value(other)?;
            Ok(())
        })
        .await;
    assert!(matches!(rebind, Err(StoreError::SessionBusy)));
    lease.finish();
    drop(
        tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(
        session
            .get::<Value>()
            .await
            .unwrap()
            .unwrap()
            .configuration
            .get("title")
            .is_none()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn retirement_waits_for_physical_scope_and_blocks_fresh_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let scope = session.execution_scope(None).await.unwrap();
    let lease = scope.accept();
    let revision = session.get::<Value>().await.unwrap().unwrap().revision;
    root.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert!(!root.session_retirement_ready("session").await.unwrap());
    assert!(matches!(
        session.execution_scope(None).await,
        Err(StoreError::SessionRetired)
    ));
    lease.finish();
    assert!(root.session_retirement_ready("session").await.unwrap());
    root.close().await.unwrap();
}

#[tokio::test]
async fn quarantined_child_keeps_sql_for_accepted_parent_without_reopening_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let parent = session.execution_scope(None).await.unwrap().accept();
    let running = parent.store();
    let child = running.fork_execution().unwrap();
    let abandoned = child.store();
    child.retain_unconfirmed();

    // Quarantine itself fences prebound ordinary handles, before shutdown sets
    // the Root's explicit closed flag. Only the original accepted pins remain.
    assert!(matches!(
        root.session("session").await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        session.subscribe_commits(),
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        session.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(matches!(
        abandoned.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    assert!(
        tokio::time::timeout(Duration::from_secs(10), root.shutdown())
            .await
            .unwrap()
            .is_err()
    );

    let admitted = running.scoped().await.unwrap();
    admitted
        .connection
        .run(|connection| {
            Box::pin(async move {
                sqlx::query("UPDATE session_control SET updated_at=42 WHERE id='session'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(
        running.get::<Value>().await.unwrap().unwrap().updated_at,
        42
    );
    parent.finish();
    assert!(matches!(
        running.get::<Value>().await,
        Err(StoreError::ConnectionClosed)
    ));
    drop(root);
    assert!(
        root::RootOwner::open(
            &directory.path().join("root"),
            &namespaces(directory.path()),
        )
        .is_err()
    );
    // The original uncertain owner still owns live SQL and its filesystem.
    let _ = directory.keep();
}
