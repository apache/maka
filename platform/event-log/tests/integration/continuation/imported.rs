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
use maka_agent_facts::input::DeliveredMessage;
use maka_agent_facts::message::MessageDisposition;
use maka_agent_facts::message::Placement;
use maka_agent_facts::message::RootSourceMessage;
use maka_event_log::StoreError;
use maka_event_log::{
    message_admissions::PendingMessageAdmission,
    message_interrupts::{InterruptCommand, InterruptReceipt},
};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

#[tokio::test]
async fn foreign_openings_and_pauses_remain_evidence_without_local_recovery_or_reservations() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("history.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for session in ["session", "proof-only", "local-session"] {
        log.create_session(session, session, &serde_json::json!({}), 1)
            .await
            .unwrap();
    }
    let paused = opening("paused", None);
    append(&log, &paused).await;
    let context = log
        .context_before_run(&paused.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    let pause = maka_agent_facts::handoff::HandoffPause {
        intent: maka_agent_facts::handoff::HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "host".into(),
            root_run_id: paused.invocation.run_id.clone(),
            successor_run_id: "successor".into(),
            successor_invocation_id: "successor-invocation".into(),
            claim_id: "successor-claim".into(),
        },
        execution: super::handoff::execution(),
    };
    append(
        &log,
        &RuntimeEvent::new(
            paused.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        ),
    )
    .await;
    let inherited = claim(&log, &pause.intent.claim_id, &paused, base).await;
    let Fact::InvocationOpened { configuration, .. } = &paused.fact else {
        unreachable!()
    };
    let successor = EventWrite::plain(RuntimeEvent::new(
        pause.intent.successor(&paused.invocation),
        Fact::InvocationOpened {
            configuration: configuration.clone(),
            input: InvocationInput::Handoff {
                claim: Box::new(inherited),
                pause: Box::new(pause.clone()),
            },
        },
    ))
    .unwrap();
    let mut proof = opening("proof", None);
    proof.invocation.session_id = "proof-only".into();
    append(&log, &proof).await;
    let mut local = opening("local", None);
    local.invocation.session_id = "local-session".into();
    append(&log, &local).await;
    let before = log.prefix(100, 65536).await.unwrap();
    assert_eq!(log.pending_handoffs(0).await.unwrap().len(), 1);
    assert_eq!(
        log.unfinished_invocations(0, 10)
            .await
            .unwrap()
            .invocations
            .len(),
        2
    );
    log.close().await.unwrap();

    // Seed the importer's durable origin boundary, not a fake terminal or a queue.
    // Reopen through normal startup to exercise real recovery discovery.
    let mut db = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    for invocation in [&paused.invocation, &proof.invocation] {
        sqlx::query("INSERT INTO imported_invocations VALUES (?, ?)")
            .bind(&invocation.invocation_id)
            .bind(digest('a'))
            .execute(&mut db)
            .await
            .unwrap();
    }
    db.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.prefix(100, 65536).await.unwrap().digest, before.digest);
    assert_eq!(
        log.unfinished_invocations(0, 10).await.unwrap().invocations,
        [local.invocation.clone()]
    );
    assert!(log.pending_handoffs(0).await.unwrap().is_empty());
    assert!(!log.has_pending_handoff("session").await.unwrap());
    for invocation in [&paused.invocation, &proof.invocation] {
        assert!(matches!(
            log.invocation_recovery(invocation).await,
            Err(StoreError::ImportedInvocation)
        ));
    }
    assert!(matches!(
        log.cancel_handoff(&paused.invocation).await,
        Err(StoreError::ImportedInvocation)
    ));
    assert!(matches!(
        log.check_handoff(&proof.invocation, &pause).await,
        Err(StoreError::ImportedInvocation)
    ));
    assert!(
        log.append(&EventWrite::plain(proof.clone()).unwrap())
            .await
            .is_err(),
        "even exact replay cannot adopt a foreign invocation"
    );
    let terminal = EventWrite::plain(RuntimeEvent::new(
        proof.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    ))
    .unwrap();
    assert!(log.append(&terminal).await.is_err());
    assert!(
        log.append(&successor).await.is_err(),
        "foreign pause cannot admit its reserved successor"
    );
    log.invocation_recovery(&local.invocation).await.unwrap();
    close(&log, &local).await;
    let mut fresh = opening("fresh", None);
    fresh.invocation.session_id = "proof-only".into();
    let message = RootSourceMessage {
        unprepared_content: "fresh".into(),
        message: DeliveredMessage {
            origin: None,
            message_id: "new-message".into(),
            content: "fresh".into(),
            submitted_content_digest: maka_agent_facts::input::MessageInput::from("fresh")
                .content_digest()
                .unwrap(),
        },
        submitted_placement: Placement::NextTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let admission = PendingMessageAdmission {
        execution: maka_event_log::message_admissions::PendingExecution {
            owner: "maka-runtime-host".into(),
            basis: serde_json::Value::Null,
        },
        invocation: fresh.invocation.clone(),
        steering_invocation: None,
        source: message.clone(),
        required_tools: Default::default(),
        admitted_at: 2,
    };
    for disposition in [MessageDisposition::Steering, MessageDisposition::Followup] {
        let mut foreign = admission.clone();
        foreign.invocation = proof.invocation.clone();
        foreign.source.disposition = disposition;
        assert!(matches!(
            log.admit_message(foreign).await,
            Err(StoreError::ImportedInvocation)
        ));
    }
    log.admit_message(admission).await.unwrap();
    let queue = log.message_queue("proof-only").await.unwrap();
    let interrupt = InterruptCommand {
        host_epoch: "current-host".into(),
        session_id: "proof-only".into(),
        interrupt_id: "old-interrupt".into(),
        turn_id: proof.invocation.turn_id.clone(),
        run_id: proof.invocation.run_id.clone(),
    };
    assert_eq!(
        log.interrupt_message_queue(&interrupt, queue.revision, Some(&proof.invocation))
            .await
            .unwrap(),
        InterruptReceipt::Conflict
    );
    assert_eq!(log.message_queue("proof-only").await.unwrap(), queue);
    let Fact::InvocationOpened {
        input: InvocationInput::Message {
            source_messages, ..
        },
        ..
    } = &mut fresh.fact
    else {
        unreachable!()
    };
    source_messages.push(message);
    append(&log, &fresh).await;
    close(&log, &fresh).await;
    assert!(log.pending_messages("proof-only").await.unwrap().is_empty());
    // Foreign handoff does not block a user-authorized fresh Run in that Session.
    let after_pause = opening("after-pause", None);
    append(&log, &after_pause).await;
    close(&log, &after_pause).await;
    assert!(
        log.unfinished_invocations(0, 10)
            .await
            .unwrap()
            .invocations
            .is_empty()
    );
    log.close().await.unwrap();
}
