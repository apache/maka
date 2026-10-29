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

use crate::support::message_queue as support;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::message::MessageDisposition as Disposition;
use maka_event_log::{
    EventLog, StoreError,
    message_interrupts::{InterruptCommand, InterruptReceipt},
};
use serde_json::json;
use support::{admission, append, invocation, opening};

#[tokio::test]
async fn interrupt_fences_delivery_atomically_and_replays_the_original_queue_cut() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("interrupt.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let owner = invocation("turn");
    append(&log, &owner, opening()).await;
    log.admit_message(admission(&owner, "delivered", Disposition::Steering))
        .await
        .unwrap();
    assert_eq!(log.commit_pending_steering(&owner).await.unwrap(), 1);
    for (id, disposition) in [
        ("steer", Disposition::Steering),
        ("next", Disposition::Followup),
    ] {
        log.admit_message(admission(&owner, id, disposition))
            .await
            .unwrap();
    }
    let command = InterruptCommand {
        host_epoch: "epoch".into(),
        session_id: "session".into(),
        interrupt_id: "interrupt".into(),
        turn_id: owner.turn_id.clone(),
        run_id: owner.run_id.clone(),
    };
    let before = log.message_queue("session").await.unwrap();
    let prefix = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_interrupt BEFORE INSERT ON message_interrupt_receipts
        BEGIN SELECT RAISE(ABORT, 'interrupt fault'); END;",
    )
    .unwrap();
    assert!(
        log.interrupt_message_queue(&command, before.revision, Some(&owner))
            .await
            .is_err()
    );
    assert_eq!(log.message_queue("session").await.unwrap(), before);
    assert!(!log.message_cancelled("session", "steer").await.unwrap());
    assert!(
        log.message_interrupt_receipt(&command)
            .await
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER reject_interrupt").unwrap();

    // Canonical consumption/edit winning the SQL race makes the old cut invalid.
    log.admit_message(admission(&owner, "late", Disposition::Followup))
        .await
        .unwrap();
    assert!(matches!(
        log.interrupt_message_queue(&command, before.revision, Some(&owner))
            .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let queued = support::large_queue(&log).await;
    let receipt = log
        .interrupt_message_queue(&command, queued.revision, Some(&owner))
        .await
        .unwrap();
    let InterruptReceipt::Fenced(fence) = &receipt else {
        panic!("accepted fence");
    };
    assert_eq!(fence.revision, queued.revision + 1);
    assert_eq!(fence.retracted, queued.entries);
    assert_eq!(
        log.message_interrupt_receipt(&command).await.unwrap(),
        Some(receipt.clone())
    );
    assert_eq!(
        fence
            .retracted
            .iter()
            .map(|entry| entry.source.message.message_id.as_str())
            .collect::<Vec<_>>(),
        ["steer", "next", "late"]
    );
    assert!(
        log.message_queue("session")
            .await
            .unwrap()
            .entries
            .is_empty()
    );
    for id in ["steer", "next", "late"] {
        assert!(log.message_cancelled("session", id).await.unwrap());
    }
    assert!(!log.message_cancelled("session", "delivered").await.unwrap());
    assert!(
        log.steering_message("session", "delivered")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(log.commit_pending_steering(&owner).await.unwrap(), 0);
    assert!(matches!(
        log.admit_message(admission(&owner, "after", Disposition::Followup))
            .await,
        Err(StoreError::SessionBusy)
    ));
    assert_eq!(
        log.interrupt_message_queue(&command, 0, None)
            .await
            .unwrap(),
        receipt
    );
    let mut second = command.clone();
    second.interrupt_id = "second".into();
    assert_eq!(
        log.interrupt_message_queue(&second, 0, Some(&owner))
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        log.message_queue("session").await.unwrap().revision,
        fence.revision
    );
    let mut wrong = command.clone();
    wrong.turn_id = "different".into();
    assert!(matches!(
        log.message_interrupt_receipt(&wrong).await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        prefix
    );

    append(
        &log,
        &owner,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    let next = invocation("next-turn");
    append(&log, &next, opening()).await;
    log.admit_message(admission(&next, "new-work", Disposition::Followup))
        .await
        .unwrap();
    assert_eq!(
        log.interrupt_message_queue(&command, 0, Some(&next))
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(
        log.pending_messages("session").await.unwrap().len(),
        1,
        "old retry cannot affect new Run"
    );
    second.interrupt_id = "stale-target".into();
    assert_eq!(
        log.interrupt_message_queue(&second, 0, Some(&next))
            .await
            .unwrap(),
        InterruptReceipt::Conflict
    );
    assert_eq!(
        log.interrupt_message_queue(&second, 0, None).await.unwrap(),
        InterruptReceipt::Conflict
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.message_interrupt_receipt(&command).await.unwrap(),
        Some(receipt)
    );
    log.begin_message_epoch("new-epoch").await.unwrap();
    assert!(
        log.message_interrupt_receipt(&command)
            .await
            .unwrap()
            .is_none()
    );
    assert!(log.message_cancelled("session", "steer").await.unwrap());
    assert_eq!(log.pending_messages("session").await.unwrap().len(), 1);
    // A canonical terminal can precede release of the Host's cleanup owner.
    // That owner must still be able to fence even an empty queue exactly once.
    log.create_session("empty", "empty-create", &json!({}), 2)
        .await
        .unwrap();
    let mut empty = invocation("empty-turn");
    empty.session_id = "empty".into();
    append(&log, &empty, opening()).await;
    append(
        &log,
        &empty,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    let mut stop_empty = InterruptCommand {
        host_epoch: "new-epoch".into(),
        session_id: "empty".into(),
        interrupt_id: "empty-stop".into(),
        turn_id: empty.turn_id.clone(),
        run_id: empty.run_id.clone(),
    };
    let result = log
        .interrupt_message_queue(&stop_empty, 0, Some(&empty))
        .await
        .unwrap();
    let InterruptReceipt::Fenced(fence) = &result else {
        panic!("terminal cleanup owner lost");
    };
    assert!(fence.retracted.is_empty());
    assert_eq!(fence.revision, 1);
    stop_empty.interrupt_id = "another-empty-stop".into();
    assert_eq!(
        log.interrupt_message_queue(&stop_empty, 0, Some(&empty))
            .await
            .unwrap(),
        result
    );
    assert_eq!(log.message_queue("empty").await.unwrap().revision, 1);
    log.close().await.unwrap();
}
