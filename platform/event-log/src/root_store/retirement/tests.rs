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
use crate::sessions::{SessionCopy, SessionCopyResult};
use maka_agent_facts::event::{
    EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
};
use maka_agent_facts::session::CopyPurpose;
use serde_json::{Value, json};
use std::time::Duration;

async fn open(path: &std::path::Path) -> RootStore {
    let owner = root::RootOwner::create(
        &path.join("root"),
        &root::RootNamespaces {
            ownership: path.join("ownership"),
            control: path.join("control"),
        },
    )
    .unwrap();
    RootStore::open(Arc::new(owner)).await.unwrap()
}

async fn editable_turn(log: &EventLog) {
    let content: maka_agent_facts::input::MessageInput = "editable input".into();
    let source = maka_agent_facts::message::RootSourceMessage {
        message: maka_agent_facts::input::DeliveredMessage {
            origin: None,
            message_id: "message".into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
        },
        unprepared_content: content.clone(),
        submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
        disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let invocation = Invocation {
        session_id: "parent".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    for fact in [
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                content,
                source_messages: vec![source],
                request_fingerprint: None,
            },
        },
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ] {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap();
    }
}

async fn retirement_snapshot(log: &EventLog) -> (Vec<(String, i64)>, i64, i64) {
    log.connection
        .read(|db| {
            Box::pin(async move {
                let revisions =
                    sqlx::query_as("SELECT id,revision FROM session_control ORDER BY id")
                        .fetch_all(&mut *db)
                        .await?;
                let retirements = sqlx::query_scalar("SELECT COUNT(*) FROM session_retirements")
                    .fetch_one(&mut *db)
                    .await?;
                let receipts = sqlx::query_scalar("SELECT COUNT(*) FROM session_removal_receipts")
                    .fetch_one(db)
                    .await?;
                Ok((revisions, retirements, receipts))
            })
        })
        .await
        .unwrap()
}

#[tokio::test]
async fn promoted_draft_rejects_stale_plan_and_retries_with_its_binding_pin() {
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
    editable_turn(&owner).await;
    let expected = parent.get::<Value>().await.unwrap().unwrap().revision;
    assert!(matches!(
        root.copy_session(
            SessionCopy {
                source_session_id: "parent".into(),
                target_session_id: "draft".into(),
                expected_source_revision: expected,
                purpose: CopyPurpose::Revision {
                    turn_id: "turn".into()
                },
            },
            &json!({"workspace":draft_binding,"boundary_revision":0}),
            2,
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    let plan = owner.preview_session_removal("parent").await.unwrap();
    assert_eq!(plan.remove, ["parent"]);
    let access = root
        .gates
        .write([gates::Key::Session("parent".into())])
        .await
        .unwrap();
    assert_eq!(owner.preview_session_removal("parent").await.unwrap(), plan);
    let binding = root
        .gates
        .read([gates::Key::Binding(parent_binding.id)])
        .await
        .unwrap();
    let stale = owner.scoped(Arc::new((access, binding)));

    // Accepted draft use does not acquire an ancestor's Session gate. It can
    // join the family after the second preview but before the removal SQL.
    let draft = root.session("draft").await.unwrap().scoped().await.unwrap();
    draft.retain_session("draft").await.unwrap();
    drop(draft);
    owner
        .connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();
    let expanded = owner.preview_session_removal("parent").await.unwrap();
    assert_eq!(expanded.remove, ["draft", "parent"]);
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
    owner
        .connection
        .run(|_| Box::pin(async { Ok(()) }))
        .await
        .unwrap();

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
async fn archive_and_retirement_wait_for_cross_partition_sql_after_observer_cancels() {
    let directory = tempfile::tempdir().unwrap();
    let root = open(directory.path()).await;
    let session = root
        .create_session("session", "session", &json!({}), 1)
        .await
        .unwrap();
    let lease = session.execution_scope(None).await.unwrap().accept();
    let running = lease.store();
    let original = session.owner().unwrap();
    let other = root
        .partitions
        .iter()
        .find(|log| !Arc::ptr_eq(log, &original))
        .unwrap();
    let log = other.scoped(running.execution.as_ref().unwrap().custody().unwrap());
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let caller = tokio::spawn(async move {
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    db.run_with_connection(move |_| {
                        entered.send(()).unwrap();
                        blocked.recv_timeout(Duration::from_secs(30)).unwrap();
                    })
                    .await?;
                    Ok(())
                })
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
    root.begin_session_removal("session", revision)
        .await
        .unwrap();
    assert!(!root.session_retirement_ready("session").await.unwrap());
    assert!(matches!(
        root.finish_session_retirement("session").await,
        Err(StoreError::SessionBusy)
    ));
    release.send(()).unwrap();
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
