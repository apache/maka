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

use crate::{EventLog, StoreError};
use maka_agent_facts::interaction::{GrantCapability, GrantScope, GrantTarget};
use maka_agent_facts::message::MessageDisposition;
use std::{sync::Arc, time::Duration};
use tokio::{sync::oneshot, task::JoinHandle};

#[path = "../../tests/support/message_queue.rs"]
mod queue;

async fn hold_writer(
    log: &Arc<EventLog>,
) -> (oneshot::Sender<()>, JoinHandle<Result<(), StoreError>>) {
    let (entered, ready) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let log = log.clone();
    let writer = tokio::spawn(async move {
        log.connection
            .run(move |_| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    let _ = released.await;
                    Ok(())
                })
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .expect("writer must accept the held job")
        .unwrap();
    (release, writer)
}

#[tokio::test]
async fn cold_empty_boundary_reads_progress_while_the_original_writer_is_held() {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let (release, writer) = hold_writer(&log).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        assert!(
            log.pending_interactions("session")
                .await
                .unwrap()
                .is_empty()
        );
        assert!(log.interaction("absent").await.unwrap().is_none());
        let target = GrantTarget {
            provider_id: "provider".into(),
            contract_id: "contract".into(),
            server_id: "server".into(),
            tool_name: "tool".into(),
            capability: GrantCapability::ComputerUse,
            scope: GrantScope::Capability {},
        };
        assert!(
            log.client_capability_grant("session", &target)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            log.commit_pending_steering(&queue::invocation("turn"))
                .await
                .unwrap(),
            0
        );
    })
    .await
    .expect("empty observations must not queue behind an unrelated accepted writer job");
    release.send(()).unwrap();
    writer.await.unwrap().unwrap();
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}

#[tokio::test]
async fn real_steering_still_commits_once_through_the_original_writer_and_reopens() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let invocation = queue::invocation("turn");
    queue::append(&log, &invocation, queue::opening()).await;
    assert_eq!(log.commit_pending_steering(&invocation).await.unwrap(), 0);
    let pending = queue::admission(&invocation, "steering", MessageDisposition::Steering);
    log.admit_message(pending.clone()).await.unwrap();
    let (release, writer) = hold_writer(&log).await;
    let mut delivery = Box::pin(log.commit_pending_steering(&invocation));
    assert!(futures_util::poll!(delivery.as_mut()).is_pending());
    assert!(
        tokio::time::timeout(Duration::from_secs(10), log.pending_interactions("session"))
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    assert!(futures_util::poll!(delivery.as_mut()).is_pending());
    release.send(()).unwrap();
    assert_eq!(delivery.await.unwrap(), 1);
    writer.await.unwrap().unwrap();
    let proof = log
        .steering_message("session", "steering")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.event.invocation, invocation);
    let maka_agent_facts::event::Fact::MessageSteered { message, source } = &proof.event.fact
    else {
        panic!("delivery must retain its canonical source");
    };
    assert_eq!(message.as_ref(), &pending.source.message);
    assert_eq!(source.as_ref(), &pending.source);
    assert!(log.pending_messages("session").await.unwrap().is_empty());
    assert_eq!(log.commit_pending_steering(&invocation).await.unwrap(), 0);
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let persisted = reopened
        .steering_message("session", "steering")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.sequence, proof.sequence);
    assert_eq!(persisted.event, proof.event);
    assert!(
        reopened
            .pending_messages("session")
            .await
            .unwrap()
            .is_empty()
    );
    reopened.close().await.unwrap();
}
