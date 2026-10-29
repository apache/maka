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

use maka_agent_facts::message::MessageDisposition;
use maka_event_log::{
    EventLog, StoreError,
    message_queue::{QueueCommandKind as Kind, QueueEdit},
};
use serde_json::json;

use crate::support::message_queue as support;
use support::{admission, append, command, invocation, opening};

#[tokio::test]
async fn receipts_commit_with_effects_replay_without_repeating_and_release_old_epochs() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("receipts.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let owner = invocation("turn");
    append(&log, &owner, opening()).await;
    log.admit_message(admission(&owner, "one", MessageDisposition::Followup))
        .await
        .unwrap();
    let queue = log.message_queue("session").await.unwrap();
    let prefix = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    let retract = command("retract", Kind::RetractAll);
    let edit = QueueEdit::RetractAll {
        cancellation_id: "retract".into(),
    };
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_receipt BEFORE INSERT ON queue_command_receipts
         BEGIN SELECT RAISE(ABORT, 'receipt fault'); END;",
    )
    .unwrap();
    assert!(
        log.edit_message_queue("session", queue.revision, edit.clone(), retract.clone())
            .await
            .is_err()
    );
    assert_eq!(log.message_queue("session").await.unwrap(), queue);
    assert!(!log.message_cancelled("session", "one").await.unwrap());
    assert!(
        log.queue_command_receipt("session", &retract)
            .await
            .unwrap()
            .is_none()
    );
    db.execute_batch("DROP TRIGGER reject_receipt").unwrap();

    let receipt = log
        .edit_message_queue("session", queue.revision, edit.clone(), retract.clone())
        .await
        .unwrap();
    assert_eq!(receipt.retracted.len(), 1);
    assert_eq!(receipt.retracted[0].source.message.message_id, "one");
    assert_eq!(receipt.revision, queue.revision + 1);
    log.admit_message(admission(&owner, "two", MessageDisposition::Followup))
        .await
        .unwrap();
    let later = log.message_queue("session").await.unwrap();
    // Replay precedes stale-revision/entry checks and cannot retract later admissions.
    assert_eq!(
        log.edit_message_queue("session", queue.revision, edit.clone(), retract.clone())
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(log.message_queue("session").await.unwrap(), later);
    let mut conflict = retract.clone();
    conflict.fingerprint = format!("sha256:{}", "b".repeat(64));
    assert!(matches!(
        log.queue_command_receipt("session", &conflict).await,
        Err(StoreError::InvalidTransition(_))
    ));

    let mut notices = log.subscribe_commits();
    notices.borrow_and_update();
    // Exceed the removed Host lifetime limit. No-op receipts do not wake projections
    // or advance their revision, and lookup still finds the oldest exact result.
    for index in 0..1030 {
        let receipt = log
            .edit_message_queue(
                "session",
                later.revision,
                QueueEdit::Reorder {
                    message_ids: vec!["two".into()],
                },
                command(&format!("noop-{index}"), Kind::Reorder),
            )
            .await
            .unwrap();
        assert_eq!(receipt.revision, later.revision);
        assert!(receipt.retracted.is_empty());
    }
    assert!(!notices.has_changed().unwrap());
    assert_eq!(
        log.queue_command_receipt("session", &retract)
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    assert!(
        log.queue_command_receipt("another-session", &retract)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        prefix
    );
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.queue_command_receipt("session", &retract)
            .await
            .unwrap(),
        Some(receipt)
    );
    log.begin_message_epoch("next-epoch").await.unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM queue_command_receipts", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(log.message_queue("session").await.unwrap(), later);
    assert!(log.message_cancelled("session", "one").await.unwrap());
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        prefix
    );
    log.close().await.unwrap();
}
