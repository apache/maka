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

use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
use maka_agent_facts::message::{MessageDisposition, Placement};
use maka_agent_ports::execution::{Enqueue, Submit};
use maka_capabilities::storage::Namespace;
use maka_event_log::{EventLog, StoreError, message_admissions::PendingMessageAdmission};
use maka_plugin_core::scope::Scope;
use serde_json::json;

async fn open_session(log: &EventLog, session: &str) -> Invocation {
    log.create_session(session, &format!("create-{session}"), &json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: session.into(),
        turn_id: format!("turn-{session}"),
        run_id: format!("run-{session}"),
        invocation_id: format!("invocation-{session}"),
    };
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "opening".into(),
                    request_fingerprint: None,
                    source_messages: vec![],
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    invocation
}

fn message_pending(request: &Enqueue) -> PendingMessageAdmission {
    let mut pending = super::pending(&Submit {
        session_id: request.invocation.session_id.clone(),
        operation_id: request.operation_id.clone(),
        content: request.content.clone(),
        orchestration_mode: None,
    });
    pending.invocation = request.invocation.clone();
    pending.source.message.message_id = request.message_id.clone();
    pending.source.submitted_placement = request.placement;
    pending.source.disposition = match request.placement {
        Placement::CurrentTurn => MessageDisposition::Steering,
        Placement::NextTurn => MessageDisposition::Followup,
    };
    pending
}

#[tokio::test]
async fn message_receipts_are_atomic_session_scoped_and_survive_retraction() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("messages.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let namespace = Namespace::new("producer", Scope::Profile).unwrap();
    let first = Enqueue {
        operation_id: "same-operation".into(),
        message_id: "same-message".into(),
        invocation: open_session(&log, "first").await,
        content: "first followup".into(),
        placement: Placement::NextTurn,
    };
    let second = Enqueue {
        invocation: open_session(&log, "second").await,
        content: "second followup".into(),
        ..first.clone()
    };
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TRIGGER reject_message_receipt BEFORE INSERT ON plugin_message_receipts BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;").unwrap();
    assert!(
        log.admit_plugin_message(&namespace, first.clone(), message_pending(&first))
            .await
            .is_err()
    );
    assert!(log.pending_messages("first").await.unwrap().is_empty());
    assert!(
        log.plugin_message_receipt(&namespace, &first.operation())
            .await
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER reject_message_receipt")
        .unwrap();
    drop(db);
    let (one, two) = tokio::join!(
        log.admit_plugin_message(&namespace, first.clone(), message_pending(&first)),
        log.admit_plugin_message(&namespace, second.clone(), message_pending(&second)),
    );
    let one = one.unwrap();
    let two = two.unwrap();
    assert_ne!(one.invocation, two.invocation);
    for (request, expected) in [(&first, &one), (&second, &two)] {
        assert_eq!(
            log.admit_plugin_message(&namespace, request.clone(), message_pending(request))
                .await
                .unwrap(),
            *expected
        );
        let mut conflict = request.clone();
        conflict.content = "changed payload".into();
        assert!(matches!(
            log.admit_plugin_message(&namespace, conflict.clone(), message_pending(&conflict))
                .await,
            Err(StoreError::EventConflict)
        ));
        assert!(
            log.plugin_execution_receipt(&namespace, &request.operation())
                .await
                .unwrap()
                .is_none()
        );
    }
    log.retract_plugin_message(&one).await.unwrap();
    assert!(log.pending_messages("first").await.unwrap().is_empty());
    assert_eq!(log.pending_messages("second").await.unwrap().len(), 1);
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    for (request, expected) in [(&first, &one), (&second, &two)] {
        assert_eq!(
            log.plugin_message_receipt(&namespace, &request.operation())
                .await
                .unwrap()
                .as_ref(),
            Some(expected)
        );
        assert_eq!(
            log.admit_plugin_message(&namespace, request.clone(), message_pending(request))
                .await
                .unwrap(),
            *expected
        );
    }
    assert!(
        log.pending_messages("first").await.unwrap().is_empty(),
        "retry cannot readmit a retracted message"
    );
    assert_eq!(log.pending_messages("second").await.unwrap().len(), 1);
    log.close().await.unwrap();
}
