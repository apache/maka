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
    RootStore::open(Arc::new(owner), crate::ROOT_MIGRATIONS)
        .await
        .unwrap()
}
fn namespaces(path: &std::path::Path) -> root::RootNamespaces {
    root::RootNamespaces {
        ownership: path.join("ownership"),
        control: path.join("control"),
    }
}

#[tokio::test]
async fn work_effect_retains_cancellation_and_settlement_after_observer_finishes() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let (parent, effects) = session.work_scope(None).await.unwrap().accept(stop.clone());
    let selected = parent.store();
    let custody = selected.work_custody().unwrap();
    let observer = selected.fork_effect().unwrap();
    let effect = root
        .fork_effect(custody.as_ref(), "session")
        .unwrap()
        .for_parent(Some(custody.as_ref()))
        .unwrap();
    let accepted = effect.cancellation();
    observer.finish(Ok(()));
    assert!(!accepted.is_cancelled());
    assert!(effect.store().get::<Value>().await.unwrap().is_some());
    let sibling = root
        .fork_effect(custody.as_ref(), "session")
        .unwrap()
        .for_parent(Some(custody.as_ref()))
        .unwrap();
    let sibling_stop = sibling.cancellation();
    accepted.cancel();
    assert!(effect.cancellation().is_cancelled());
    assert!(!sibling_stop.is_cancelled());
    assert!(!stop.is_cancelled());
    assert!(
        root.fork_effect(custody.as_ref(), "another-session")
            .is_err()
    );
    let foreign_session = root
        .create_session("foreign", "foreign", &json!({}), 1)
        .await
        .unwrap();
    let (foreign, foreign_effects) = foreign_session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let foreign_custody = foreign.store().work_custody().unwrap();
    assert!(
        selected
            .fork_effect()
            .unwrap()
            .for_parent(Some(foreign_custody.as_ref()))
            .is_err()
    );
    foreign_effects.settle().await.unwrap();
    foreign.finish();
    let mut drain = Box::pin(effects.settle());
    assert!(poll!(&mut drain).is_pending());
    assert!(root.fork_effect(custody.as_ref(), "session").is_err());
    // Resource-group sealing does not revoke original background work admission.
    let background = root.fork_work(custody.as_ref(), "session").unwrap();
    stop.cancel();
    assert!(accepted.is_cancelled());
    assert!(sibling_stop.is_cancelled());
    assert!(poll!(&mut drain).is_pending());
    effect.finish(Ok(()));
    sibling.finish(Ok(()));
    drain.await.unwrap();
    assert!(effects.is_idle());
    background.finish();
    parent.finish();
    root.close().await.unwrap();
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
        binding: maka_sandbox::workspace::BindingStamp {
            id: reference.id,
            permission_epoch: 0,
        },
    };
    assert!(matches!(
        session.work_scope(None).await,
        Err(StoreError::PermissionRevoked)
    ));
    let scope = session.work_scope(Some(basis)).await.unwrap();
    let running = scope.store();
    let (lease, effects) = scope.accept(CancellationToken::new());
    let mut writer = Box::pin(root.gates.write([gates::Key::Binding(reference.id)]));
    assert!(poll!(&mut writer).is_pending());
    let record = tokio::time::timeout(Duration::from_secs(2), running.get::<Value>())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let mut expected = record.configuration.clone();
    expected["title"] = json!("changed");
    let committed = tokio::time::timeout(
        Duration::from_secs(2),
        running.update_session_metadata::<Value, _>("session", record.revision, |value| {
            value["title"] = json!("changed");
            Ok(())
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let crate::sessions::SessionMutation::Committed(committed) = committed else {
        panic!("original accepted work must commit non-permission metadata");
    };
    assert_eq!(committed.revision, record.revision + 1);
    assert_eq!(committed.configuration, expected);
    assert_eq!(
        committed.configuration["workspace"],
        serde_json::to_value(&reference).unwrap()
    );
    assert!(poll!(&mut writer).is_pending());
    // A plain control handle also cannot switch the attachment underneath
    // this run's immutable binding lease.
    let other = root
        .attach_workspace("owner", &json!({"path":"/tmp/other"}))
        .await
        .unwrap();
    let rebind = session
        .update_session_metadata::<Value, _>("session", committed.revision, move |value| {
            value["workspace"] = serde_json::to_value(other)?;
            Ok(())
        })
        .await;
    assert!(matches!(rebind, Err(StoreError::SessionBusy)));
    effects.settle().await.unwrap();
    lease.finish();
    drop(
        tokio::time::timeout(Duration::from_secs(2), writer)
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        session.get::<Value>().await.unwrap().unwrap().configuration,
        expected
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn unconfirmed_child_keeps_other_sessions_available_and_retains_shutdown_custody() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let (parent, effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let running = parent.store();
    let child = running.fork_effect().unwrap();
    let abandoned = child.store();
    child.retain_unconfirmed((), "fixture child cleanup unconfirmed".into());

    assert!(root.session("session").await.is_ok());
    assert!(session.subscribe_commits().is_ok());
    assert!(session.get::<Value>().await.unwrap().is_some());
    let healthy = root
        .create_session("healthy", "healthy", &json!({"title":"still usable"}), 2)
        .await
        .unwrap();
    assert_eq!(
        healthy.get::<Value>().await.unwrap().unwrap().configuration["title"],
        "still usable"
    );
    let (healthy_lease, healthy_effects) = healthy
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    assert!(
        healthy_lease
            .store()
            .get::<Value>()
            .await
            .unwrap()
            .is_some()
    );
    healthy_effects.settle().await.unwrap();
    healthy_lease.finish();
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
            connection.execute(
                "UPDATE session_control SET updated_at=42 WHERE id='session'",
                rusqlite::params![],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    drop(admitted);
    assert_eq!(
        running.get::<Value>().await.unwrap().unwrap().updated_at,
        42
    );
    assert!(effects.settle().await.is_err());
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
