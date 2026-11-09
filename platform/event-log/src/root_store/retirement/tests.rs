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
use crate::sessions::PluginSession;
use maka_plugin_core::{scope::Scope, storage::Namespace};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

async fn open(path: &std::path::Path) -> RootStore {
    let owner = root::RootOwner::create(
        &path.join("root"),
        &root::RootNamespaces {
            ownership: path.join("ownership"),
            control: path.join("control"),
        },
    )
    .unwrap();
    RootStore::open(Arc::new(owner), crate::ROOT_MIGRATIONS)
        .await
        .unwrap()
}

async fn retirement_snapshot(log: &EventLog) -> (Vec<(String, i64)>, i64, i64) {
    log.connection
        .read(|db| {
            let revisions = db
                .prepare_cached("SELECT id,revision FROM session_control ORDER BY id")?
                .query_map(rusqlite::params![], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            let retirements = db.query_row(
                "SELECT COUNT(*) FROM session_retirements",
                rusqlite::params![],
                |row| row.get(0),
            )?;
            let receipts = db.query_row(
                "SELECT COUNT(*) FROM session_removal_receipts",
                rusqlite::params![],
                |row| row.get(0),
            )?;
            Ok((revisions, retirements, receipts))
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn new_authority_dependent_rejects_stale_plan_and_retries_with_its_binding_pin() {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(open(directory.path()).await);
    let parent_binding = root
        .attach_workspace("owner", &json!({"path":"/parent"}))
        .await
        .unwrap();
    let draft_binding = root
        .attach_workspace("owner", &json!({"path":"/draft"}))
        .await
        .unwrap();
    let parent = root
        .create_session(
            "parent",
            "parent",
            &json!({"workspace":parent_binding,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let owner = parent.owner().unwrap();
    let expected = parent.get::<Value>().await.unwrap().unwrap().revision;
    let plan = owner.preview_session_removal("parent").await.unwrap();
    assert_eq!(plan.remove, ["parent"]);
    assert!(plan.archive.is_empty());
    // A newly published Host authority dependency expands the advisory plan.
    // Revision/fork membership is Agent state, not a Root removal authority.
    root.create_plugin_session(
        &PluginSession {
            session_id: "draft".into(),
            creator: Namespace::new("retirement.fixture", Scope::Profile).unwrap(),
            fingerprint: "draft".into(),
            managed: false,
            authority_session_id: Some("parent".into()),
        },
        &json!({"workspace":draft_binding,"boundary_revision":0}),
        2,
    )
    .await
    .unwrap();
    let access = root
        .gates
        .write([gates::Key::Session("parent".into())])
        .await
        .unwrap();
    let binding = root
        .gates
        .read([gates::Key::Binding(parent_binding.id)])
        .await
        .unwrap();
    let stale = owner.scoped(Arc::new((access, binding)));
    let expanded = owner.preview_session_removal("parent").await.unwrap();
    assert_eq!(expanded.remove, ["parent"]);
    assert_eq!(expanded.archive, ["draft"]);
    let before = retirement_snapshot(&owner).await;
    assert_eq!((before.1, before.2), (0, 0));

    // Simulate a concurrent mutation of the newly joined member's binding.
    // The stale plan owns neither this binding nor the draft Session gate.
    let foreign_binding = root
        .gates
        .write([gates::Key::Binding(draft_binding.id)])
        .await
        .unwrap();
    let outcome = stale
        .remove_session_family_guarded(
            "parent",
            expected,
            Arc::new(RemovalAuthority::Unmanaged),
            Some(plan),
        )
        .await
        .unwrap();
    assert!(
        outcome.is_none(),
        "a changed plan must roll back before any fence"
    );
    assert_eq!(retirement_snapshot(&owner).await, before);
    drop(stale);
    owner.connection.run(|_| Ok(())).await.unwrap();

    let removing = root.clone();
    let removal = tokio::spawn(async move {
        removing
            .remove_session_family("parent", expected, RemovalAuthority::Unmanaged)
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if root
                .gates
                .try_write([gates::Key::Session("draft".into())])
                .unwrap()
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!removal.is_finished());
    assert_eq!(retirement_snapshot(&owner).await, before);
    drop(foreign_binding);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), removal)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        RemoveFamilyResult::Accepted(expanded.clone())
    );
    assert_eq!(
        root.session_removal_receipt("parent").await.unwrap(),
        Some(expanded)
    );
    assert_eq!(retirement_snapshot(&owner).await.1, 2);
    drop(owner);
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn removal_retry_keeps_a_restored_child_and_its_new_work_unchanged() {
    use crate::sessions::PluginSession;
    use maka_plugin_core::scope::Scope;
    use maka_plugin_core::storage::Namespace;

    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let parent = root
        .create_session("parent", "create", &json!({}), 1)
        .await
        .unwrap();
    let owner = parent.owner().unwrap();
    root.create_plugin_session(
        &PluginSession {
            session_id: "child".into(),
            creator: Namespace::new("example", Scope::Profile).unwrap(),
            fingerprint: "child".into(),
            managed: false,
            authority_session_id: Some("parent".into()),
        },
        &json!({}),
        2,
    )
    .await
    .unwrap();
    let expected = parent.get::<Value>().await.unwrap().unwrap().revision;
    let RemoveFamilyResult::Accepted(plan) = root
        .remove_session_family("parent", expected, RemovalAuthority::Unmanaged)
        .await
        .unwrap()
    else {
        panic!("current removal plan")
    };
    assert_eq!(plan.remove, ["parent"]);
    assert_eq!(plan.archive, ["child"]);
    assert_eq!(
        root.finish_session_retirement("parent").await.unwrap(),
        SessionRetirement::Removed
    );
    assert_eq!(
        root.finish_session_retirement("child").await.unwrap(),
        SessionRetirement::Archived
    );
    root.set_session_archived::<Value>("child", false, 3)
        .await
        .unwrap();
    let child = root.session("child").await.unwrap();
    let record = child.get::<Value>().await.unwrap().unwrap();
    child
        .update_session_metadata::<Value, _>("child", record.revision, |configuration| {
            configuration["restoredWork"] = json!("original new work 中");
            Ok(())
        })
        .await
        .unwrap();
    let (new_work, _effects) = child
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let custody = new_work.store().work_custody().unwrap();
    let before = child.get::<Value>().await.unwrap().unwrap();
    assert_eq!(
        owner
            .remove_session_family("parent", expected, RemovalAuthority::Unmanaged)
            .await
            .unwrap(),
        RemoveFamilyResult::Accepted(plan)
    );
    assert!(!child.get::<Value>().await.unwrap().unwrap().archived);
    assert_eq!(child.get::<Value>().await.unwrap(), Some(before));
    assert_eq!(
        root.session_for_work(custody.as_ref(), "child")
            .unwrap()
            .id(),
        "child"
    );
    assert!(
        root.gates
            .try_write([gates::Key::Work("child".into())])
            .unwrap()
            .is_none()
    );
    new_work.finish();
    drop(owner);
    root.close().await.unwrap();
}

#[tokio::test]
async fn archive_and_retirement_wait_for_cross_session_sql_after_observer_cancels() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let (lease, _effects) = session
        .work_scope(None)
        .await
        .unwrap()
        .accept(CancellationToken::new());
    let running = lease.store();
    let original = session.owner().unwrap();
    let other = &root.log;
    let log = other.scoped(running.work.as_ref().unwrap().custody().unwrap());
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let caller = tokio::spawn(async move {
        log.connection
            .run(move |_| {
                entered.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(30)).unwrap();

                Ok(())
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), reached)
        .await
        .unwrap()
        .unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    lease.finish();
    assert!(matches!(
        session
            .change_session_archived::<Value>("session", None, true, 2)
            .await,
        Err(StoreError::SessionBusy)
    ));
    let revision = session.get::<Value>().await.unwrap().unwrap().revision;
    let mut retirement = Box::pin(root.begin_session_removal("session", revision));
    assert!(futures_util::poll!(&mut retirement).is_pending());
    release.send(()).unwrap();
    retirement.await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if root
                .gates
                .try_write([gates::Key::Work("session".into())])
                .unwrap()
                .is_some()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(root.session_retirement_ready("session").await.unwrap());
    assert_eq!(
        root.finish_session_retirement("session").await.unwrap(),
        SessionRetirement::Removed
    );
    drop(original);
    root.close().await.unwrap();
}
