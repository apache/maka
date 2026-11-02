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

use super::super::*;
use crate::sessions::{AbandonRevision, SessionCopy, SessionCopyResult, SessionRetirement};
use futures_util::FutureExt;
use maka_agent_facts::event::{
    EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent,
};
use maka_agent_facts::session::{CopyPurpose, ForkPosition};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

fn owner(path: &Path) -> Arc<root::RootOwner> {
    Arc::new(
        root::RootOwner::create(
            &path.join("root"),
            &root::RootNamespaces {
                ownership: path.join("ownership"),
                control: path.join("control"),
            },
        )
        .unwrap(),
    )
}

async fn block_update(
    log: &EventLog,
    table: &'static str,
) -> (
    tokio::sync::oneshot::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut entered = Some(entered);
                db.lock_handle().await?.set_update_hook(move |update| {
                    if update.table == table
                        && let Some(entered) = entered.take()
                    {
                        let _ = entered.send(());
                        let _ = released.recv();
                    }
                });
                Ok(())
            })
        })
        .await
        .unwrap();
    (reached, release)
}

async fn turns(session: &SessionStore) {
    // More than one collection batch, with enough material to free whole pages.
    for index in 0..6 {
        let content: maka_agent_facts::input::MessageInput = "private input".repeat(4096).into();
        let source = maka_agent_facts::message::RootSourceMessage {
            message: maka_agent_facts::input::DeliveredMessage {
                origin: None,
                message_id: format!("message-{index}"),
                submitted_content_digest: content.content_digest().unwrap(),
                content: content.clone(),
            },
            unprepared_content: content.clone(),
            submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
            disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        let invocation = Invocation {
            session_id: session.id.to_string(),
            turn_id: format!("turn-{index}"),
            run_id: format!("run-{index}"),
            invocation_id: format!("{}-invocation-{index}", session.id),
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
            session
                .append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
                .await
                .unwrap();
        }
    }
}

async fn copy(root: &RootStore, target: &str, purpose: CopyPurpose) -> SessionStore {
    let source = root.session("source").await.unwrap();
    assert!(matches!(
        root.copy_session(
            SessionCopy {
                source_session_id: "source".into(),
                target_session_id: target.into(),
                expected_source_revision: source.get::<Value>().await.unwrap().unwrap().revision,
                purpose,
            },
            &json!({}),
            2,
        )
        .await
        .unwrap(),
        SessionCopyResult::Committed(_)
    ));
    root.session(target).await.unwrap()
}

async fn retire(root: &RootStore, session: &str) {
    let revision = root
        .session(session)
        .await
        .unwrap()
        .get::<Value>()
        .await
        .unwrap()
        .unwrap()
        .revision;
    root.begin_session_removal(session, revision).await.unwrap();
    assert_eq!(
        root.finish_session_retirement(session).await.unwrap(),
        SessionRetirement::Removed
    );
}

async fn material_state(log: &EventLog) -> (i64, i64, i64) {
    log.connection
        .read(|db| {
            Box::pin(async move {
                let bodies = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM event_log WHERE event_header IS NOT NULL",
                )
                .fetch_one(&mut *db)
                .await?;
                let free = sqlx::query_scalar("PRAGMA freelist_count")
                    .fetch_one(&mut *db)
                    .await?;
                let pages = sqlx::query_scalar("PRAGMA page_count")
                    .fetch_one(db)
                    .await?;
                Ok((bodies, free, pages))
            })
        })
        .await
        .unwrap()
}

async fn reclaimed(log: &EventLog) -> i64 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let (bodies, free, pages) = material_state(log).await;
            if bodies == 0 && free == 0 {
                return pages;
            }
            // Vacuum changes page allocation without changing total_changes(),
            // so commit hints alone cannot acknowledge physical reclamation.
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Root must automatically collect retired bodies and return free pages")
}

#[tokio::test]
async fn retirement_automatically_collects_after_the_last_archived_fork_is_removed() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turns(&source).await;
    let log = source.owner().unwrap();
    let fork = copy(
        &root,
        "fork",
        CopyPurpose::Branch {
            position: ForkPosition::End,
            side_conversation: false,
        },
    )
    .await;
    let scope = LogScope::Session { id: "fork".into() };
    let before = fork
        .scoped_prefix(scope.clone(), 100, 10_000_000)
        .await
        .unwrap();
    assert_eq!(before.events.len(), 12);
    root.set_session_archived::<Value>("fork", true, 3)
        .await
        .unwrap();
    let (_, _, pages_before) = material_state(&log).await;
    retire(&root, "source").await;
    let retained = fork.scoped_prefix(scope, 100, 10_000_000).await.unwrap();
    assert_eq!(retained.digest, before.digest);
    assert_eq!(retained.high_water, before.high_water);
    assert_eq!(retained.events.len(), 12);
    retire(&root, "fork").await;
    let pages_after = reclaimed(&log).await;
    assert!(
        pages_after < pages_before,
        "automatic vacuum must shrink the database"
    );
    let proof: (i64, i64) = log.connection.read(|db| Box::pin(async move {
        Ok(sqlx::query_as("SELECT COUNT(*), SUM(event_header IS NULL AND body_digest IS NOT NULL AND retained_json NOT LIKE '%private input%') FROM event_log")
            .fetch_one(db).await?)
    })).await.unwrap();
    assert_eq!(
        proof,
        (12, 12),
        "retain identity and proof, without full private bodies"
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn abandoning_the_last_preparing_revision_wakes_ancestor_collection() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turns(&source).await;
    let log = source.owner().unwrap();
    let draft = copy(
        &root,
        "draft",
        CopyPurpose::Revision {
            turn_id: "turn-5".into(),
        },
    )
    .await;
    retire(&root, "source").await;
    assert!(material_state(&log).await.0 > 0);
    assert!(draft.get::<Value>().await.unwrap().is_some());
    assert_eq!(
        root.abandon_revision("draft").await.unwrap(),
        AbandonRevision::Abandoned
    );
    reclaimed(&log).await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn ownership_released_during_a_pass_revisits_an_earlier_retained_source() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turns(&source).await;
    let log = source.owner().unwrap();
    let draft = copy(
        &root,
        "draft",
        CopyPurpose::Revision {
            turn_id: "turn-5".into(),
        },
    )
    .await;
    retire(&root, "source").await;
    let partition = root.route_partition("source").await.unwrap();
    let later_id = (0..)
        .map(|index| format!("z-later-{index}"))
        .find(|id| partition_for(b"session", id) == partition)
        .unwrap();
    let later = root
        .create_session(&later_id, &later_id, &json!({}), 2)
        .await
        .unwrap();
    turns(&later).await;
    // Acquire exactly the Root abandonment operation's admission/binding pins
    // before blocking SQL, so its real release job can be queued mid-pass.
    let scoped = draft.exclusive_metadata(true).await.unwrap();
    let (reached, release) = block_update(&log, "event_log").await;
    retire(&root, &later_id).await;
    tokio::time::timeout(Duration::from_secs(10), reached)
        .await
        .unwrap()
        .unwrap();
    // The pass has skipped source and is collecting the lexically later owner.
    // Queue abandonment before its next batch, without any synthetic wakeup.
    let mut abandonment = Box::pin(scoped.abandon_revision("draft"));
    assert!(futures_util::poll!(&mut abandonment).is_pending());
    release.send(()).unwrap();
    assert_eq!(abandonment.await.unwrap(), AbandonRevision::Abandoned);
    drop(scoped);
    reclaimed(&log).await;
    root.close().await.unwrap();
}

#[tokio::test]
async fn cancelled_retirement_observer_cannot_lose_the_committed_collection_wakeup() {
    let directory = tempfile::tempdir().unwrap();
    let root = Arc::new(RootStore::open(owner(directory.path())).await.unwrap());
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turns(&source).await;
    let log = source.owner().unwrap();
    let revision = source.get::<Value>().await.unwrap().unwrap().revision;
    root.begin_session_removal("source", revision)
        .await
        .unwrap();
    let (reached, release) = block_update(&log, "session_retirements").await;
    let caller = root.clone();
    let retirement = tokio::spawn(async move { caller.finish_session_retirement("source").await });
    tokio::time::timeout(Duration::from_secs(10), reached)
        .await
        .unwrap()
        .unwrap();
    retirement.abort();
    assert!(retirement.await.unwrap_err().is_cancelled());
    release.send(()).unwrap();
    reclaimed(&log).await;
    root.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_drains_the_accepted_batch_and_reopen_resumes_without_new_writes() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(owner(directory.path())).await.unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    turns(&source).await;
    let log = source.owner().unwrap();
    let partition = root.route_partition("source").await.unwrap();
    let (reached, release) = block_update(&log, "event_log").await;
    retire(&root, "source").await;
    tokio::time::timeout(Duration::from_secs(10), reached)
        .await
        .unwrap()
        .unwrap();
    let closed = root.lifecycle.as_ref().unwrap().receipt();
    let independent = root.partitions[(partition + 1) % PARTITION_COUNT].close_receipt();
    drop(log);
    drop(root);
    // Another partition closes while the accepted GC transaction is blocked.
    tokio::time::timeout(Duration::from_secs(10), independent)
        .await
        .unwrap()
        .unwrap();
    assert!(closed.clone().now_or_never().is_none());
    let namespaces = root::RootNamespaces {
        ownership: directory.path().join("ownership"),
        control: directory.path().join("control"),
    };
    assert!(root::RootOwner::open(&directory.path().join("root"), &namespaces).is_err());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), closed)
        .await
        .unwrap()
        .unwrap();
    let inspect = rusqlite::Connection::open(
        directory
            .path()
            .join(format!("root/runtime-partitions/{partition:02}.sqlite")),
    )
    .unwrap();
    let remaining: i64 = inspect
        .query_row(
            "SELECT COUNT(*) FROM event_log WHERE event_header IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        remaining > 0 && remaining < 12,
        "shutdown finishes the accepted batch but leaves work for recovery"
    );
    drop(inspect);
    let restored =
        Arc::new(root::RootOwner::open(&directory.path().join("root"), &namespaces).unwrap());
    let reopened = RootStore::open(restored).await.unwrap();
    reclaimed(&reopened.partitions[partition]).await;
    reopened.close().await.unwrap();
}
