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

use std::{future::poll_fn, sync::Arc, task::Poll, time::Duration};

use maka_agent_facts::event::EventSink;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use maka_event_log::{EventLog, StoreError};

#[tokio::test]
async fn cancelled_metadata_waiter_still_notifies_and_catalog_reads_do_not_notify() {
    use maka_event_log::sessions::{CatalogFilter, CatalogScope};
    use serde_json::{Value, json};
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let mut changes = log.subscribe_catalog_changes();
    let commits = log.subscribe_commits();
    let competing = rusqlite::Connection::open(&path).unwrap();
    competing.execute_batch("BEGIN IMMEDIATE").unwrap();
    let configuration = json!({"title":"Accepted create"});
    let mut pending = Box::pin(log.create_session("accepted", "original", &configuration, 1));
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(pending);
    assert!(!changes.has_changed().unwrap());
    competing.execute_batch("ROLLBACK").unwrap();
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let page = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    assert_eq!(page.sessions[0].id, "accepted");
    assert_eq!(page.pending_session_count, 0);
    assert!(
        !commits.has_changed().unwrap(),
        "metadata is not an execution event"
    );
    for _ in 0..3 {
        assert_eq!(
            log.catalog_revision(
                CatalogScope::Profile,
                CatalogFilter {
                    archived_only: false,
                    include_archived: true,
                    pending_only: false,
                }
            )
            .await
            .unwrap(),
            page.revision
        );
        log.get_session::<Value>("accepted").await.unwrap();
    }
    assert!(
        !changes.has_changed().unwrap(),
        "catalog reads cannot wake their own subscriber"
    );
    log.set_session_archived::<Value>("accepted", true, 2)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let archived = log.list_sessions::<Value>(None, None, 32).await.unwrap();
    assert!(archived.sessions[0].archived);
    assert_ne!(archived.revision, page.revision);
    log.close().await.unwrap();
    assert!(
        changes.changed().await.is_err(),
        "notification closes with its original worker"
    );
}

#[tokio::test]
async fn dropped_commit_waiter_retains_writer_until_commit_and_publishes_only_durable_facts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let mut committed = log.subscribe_commits();
    let event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: Vec::new(),
                content: "one commit".into(),
                request_fingerprint: None,
            },
        },
    );

    // An independent connection holds SQLite's write lock. A current-thread
    // executor must still be able to cancel the waiter while COMMIT is pending.
    let competing = rusqlite::Connection::open(&path).unwrap();
    competing.execute_batch("BEGIN IMMEDIATE").unwrap();
    let mut pending = log
        .clone()
        .commit(EventWrite::plain(event.clone()).unwrap());
    poll_fn(|cx| {
        assert!(pending.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(!committed.has_changed().unwrap());
    assert_eq!(*committed.borrow(), 0);
    drop(pending);
    drop(log);
    assert!(matches!(
        EventLog::open(&path).await,
        Err(StoreError::WriterBusy)
    ));

    competing.execute_batch("ROLLBACK").unwrap();
    tokio::time::timeout(Duration::from_secs(5), committed.changed())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*committed.borrow_and_update(), 1);
    // Watch closure proves EventLog was released. The connection owner drains
    // and closes SQLx independently, retaining its lease until close completes.
    assert!(
        tokio::time::timeout(Duration::from_secs(5), committed.changed())
            .await
            .unwrap()
            .is_err()
    );
    drop(competing);
    let log = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match EventLog::open(&path).await {
                Ok(log) => break log,
                Err(StoreError::WriterBusy) => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("reopen after drained commit failed: {error}"),
            }
        }
    })
    .await
    .expect("connection owner must close and release the writer lease");
    let prefix = log.prefix(1, 16_384).await.unwrap();
    assert_eq!(prefix.events[0].event, event);
    assert_eq!(
        log.append(&EventWrite::plain((event).clone()).unwrap())
            .await
            .unwrap(),
        1
    );
    assert_eq!(log.prefix(1, 16_384).await.unwrap().digest, prefix.digest);
    log.close().await.unwrap();
}
