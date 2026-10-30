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

use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::message::MessageDisposition as Disposition;
use maka_agent_facts::message::Placement;
use maka_event_log::{
    EventLog, StoreError,
    message_queue::{QueueCommandKind as Kind, QueueEdit},
    message_resolution::MessageResolution,
};
use serde_json::json;

use crate::support::message_queue::{admission, append, command, invocation, opening};

#[tokio::test]
async fn removal_atomically_cancels_pending_work_and_keeps_accepted_settlement_across_restart() {
    use maka_event_log::sessions::{SessionRemovalResult as Result, SessionRetirement as State};
    for active in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("removal.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("session", "create", &json!({}), 1)
            .await
            .unwrap();
        let process = uuid::Uuid::new_v4();
        log.admit_session_process("session", process).await.unwrap();
        let owner = invocation("first");
        if active {
            append(&log, &owner, opening()).await;
        }
        let pending = admission(
            &owner,
            "pending",
            if active {
                Disposition::Followup
            } else {
                Disposition::TurnStarted
            },
        );
        log.admit_message(pending.clone()).await.unwrap();
        let revision = log
            .get_session::<serde_json::Value>("session")
            .await
            .unwrap()
            .unwrap()
            .revision;
        assert!(matches!(
            log.begin_session_removal("session", revision + 1)
                .await
                .unwrap(),
            Result::RevisionConflict { .. }
        ));
        let inspect = rusqlite::Connection::open(&path).unwrap();
        inspect
            .execute_batch(
                "CREATE TRIGGER reject_retirement BEFORE INSERT ON message_cancellations
            BEGIN SELECT RAISE(ABORT, 'cancellation failure'); END;",
            )
            .unwrap();
        assert!(
            log.begin_session_removal("session", revision)
                .await
                .is_err()
        );
        assert_eq!(log.session_retirement("session").await.unwrap(), None);
        assert_eq!(
            log.pending_messages("session").await.unwrap(),
            vec![pending.clone()]
        );
        inspect
            .execute_batch("DROP TRIGGER reject_retirement")
            .unwrap();
        drop(inspect);
        assert_eq!(
            log.begin_session_removal("session", revision)
                .await
                .unwrap(),
            Result::Accepted(State::Removing)
        );
        assert!(!log.session_retirement_ready("session").await.unwrap());
        assert!(
            log.admit_session_process("session", uuid::Uuid::new_v4())
                .await
                .is_err()
        );
        assert!(log.message_cancelled("session", "pending").await.unwrap());
        assert!(
            log.get_session::<serde_json::Value>("session")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            log.list_sessions::<serde_json::Value>(None, None, 32)
                .await
                .unwrap()
                .sessions
                .is_empty()
        );
        assert!(
            log.retiring_session::<serde_json::Value>("session")
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            log.pending_message_sessions("maka-runtime-host", None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(log.admit_message(pending).await.is_err());
        assert!(matches!(
            log.retain_session("session").await,
            Err(StoreError::SessionRetired)
        ));
        assert!(
            log.update_session_metadata(
                "session",
                revision + 1,
                |_: &mut serde_json::Value| Ok(())
            )
            .await
            .is_err()
        );
        if active {
            assert_eq!(
                log.finish_session_retirement("session").await.unwrap(),
                State::Removing
            );
            append(
                &log,
                &owner,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Cancelled {
                        source: "session_removal".into(),
                    },
                },
            )
            .await;
        }
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert!(
            !log.session_retirement_ready("session").await.unwrap(),
            "losing the native process handle does not prove cleanup"
        );
        assert_eq!(
            log.finish_session_retirement("session").await.unwrap(),
            State::Removing
        );
        log.clean_session_process(process).await.unwrap();
        assert!(log.session_retirement_ready("session").await.unwrap());
        assert_eq!(
            log.pending_session_retirements(None).await.unwrap(),
            ["session"]
        );
        assert_eq!(
            log.begin_session_removal("session", revision)
                .await
                .unwrap(),
            Result::Accepted(State::Removing)
        );
        assert_eq!(
            log.finish_session_retirement("session").await.unwrap(),
            State::Removed
        );
        assert_eq!(
            log.finish_session_retirement("session").await.unwrap(),
            State::Removed
        );
        assert_eq!(
            log.begin_session_removal("session", revision)
                .await
                .unwrap(),
            Result::Accepted(State::Removed)
        );
        assert!(
            log.get_session::<serde_json::Value>("session")
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            log.create_session("session", "create", &json!({}), 2)
                .await
                .is_err()
        );
        assert!(
            log.append(
                &EventWrite::plain(RuntimeEvent::new(invocation("late"), opening())).unwrap()
            )
            .await
            .is_err()
        );
        assert!(
            log.pending_session_retirements(None)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(log.message_cancelled("session", "pending").await.unwrap());
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn queue_edits_cancel_or_deliver_once_with_atomic_revision_and_original_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("queue.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "create", &json!({}), 1)
        .await
        .unwrap();
    let first = invocation("first");
    append(&log, &first, opening()).await;
    let mut notices = log.subscribe_commits();
    let before = *notices.borrow_and_update();
    let targets = ["session".into()];
    let version = log.observation_versions(&targets).await.unwrap()["session"];
    for id in ["one", "two", "three"] {
        let mut pending = admission(&first, id, Disposition::Followup);
        if id == "two" {
            pending.source.message.origin =
                Some(maka_agent_facts::message::MessageOrigin::WorkhubGraph {
                    graph_id: "graph-original".into(),
                });
        }
        log.admit_message(pending).await.unwrap();
    }
    notices.changed().await.unwrap();
    assert_eq!(
        *notices.borrow_and_update(),
        before,
        "queue wakeup does not invent a log event"
    );
    let queue = log.message_queue("session").await.unwrap();
    assert_eq!(queue.revision, 3);
    let queued_version = log.observation_versions(&targets).await.unwrap()["session"];
    assert_eq!(queued_version.event, version.event);
    assert_eq!(
        queued_version.queue, queue.revision,
        "queue-only commits must invalidate observation"
    );
    let reordered = log
        .edit_message_queue(
            "session",
            3,
            QueueEdit::Reorder {
                message_ids: vec!["three".into(), "one".into(), "two".into()],
            },
            command("reorder", Kind::Reorder),
        )
        .await
        .unwrap();
    assert_eq!(reordered.revision, 4);
    let reordered = log.message_queue("session").await.unwrap();
    assert_eq!(
        reordered
            .entries
            .iter()
            .map(|e| e.source.message.message_id.as_str())
            .collect::<Vec<_>>(),
        ["three", "one", "two"]
    );
    assert!(matches!(
        log.edit_message_queue(
            "session",
            3,
            QueueEdit::RetractAll {
                cancellation_id: "stale".into()
            },
            command("stale", Kind::RetractAll),
        )
        .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    assert_eq!(log.message_queue("session").await.unwrap(), reordered);
    let same = log
        .edit_message_queue(
            "session",
            4,
            QueueEdit::Reorder {
                message_ids: vec!["three".into(), "one".into(), "two".into()],
            },
            command("same", Kind::Reorder),
        )
        .await
        .unwrap();
    assert_eq!(same.revision, reordered.revision);
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_cancel BEFORE INSERT ON message_cancellations
        WHEN NEW.message_id = 'one' BEGIN SELECT RAISE(ABORT, 'cancel fault'); END;",
    )
    .unwrap();
    assert!(
        log.edit_message_queue(
            "session",
            4,
            QueueEdit::RetractAll {
                cancellation_id: "fault".into()
            },
            command("fault", Kind::RetractAll),
        )
        .await
        .is_err()
    );
    assert_eq!(log.message_queue("session").await.unwrap(), reordered);
    for id in ["one", "two", "three"] {
        assert!(!log.message_cancelled("session", id).await.unwrap());
    }
    db.execute_batch("DROP TRIGGER reject_cancel").unwrap();
    let receipt: maka_agent_facts::input::InputReceipt = serde_json::from_value(json!({
        "source":{"kind":"input","name":"review","packageId":"reviewer","entryId":"entry","activation":"1","revision":"1"},
        "receipt":{"document":"report.md"}
    })).unwrap();
    let mut content: maka_agent_facts::input::MessageInput = "edited 😀".into();
    content.preparation.push(receipt.clone());
    let updated = log
        .edit_message_queue(
            "session",
            4,
            QueueEdit::Update {
                message_id: "two".into(),
                unprepared_content: Box::new("edited 😀".into()),
                content: Box::new(content),
                required_tools: ["Read".into()].into(),
            },
            command("update", Kind::Update),
        )
        .await
        .unwrap();
    assert_eq!(updated.revision, 5);
    let unchanged = log.message_queue("session").await.unwrap();
    let entry = unchanged
        .entries
        .iter()
        .find(|entry| entry.source.message.message_id == "two")
        .unwrap();
    let same = log
        .edit_message_queue(
            "session",
            5,
            QueueEdit::Update {
                message_id: "two".into(),
                content: Box::new(entry.source.message.content.clone()),
                unprepared_content: Box::new(entry.source.unprepared_content.clone()),
                required_tools: entry.required_tools.clone(),
            },
            command("same-update", Kind::Update),
        )
        .await
        .unwrap();
    assert_eq!(same.revision, 5);
    assert_eq!(log.message_queue("session").await.unwrap(), unchanged);
    append(
        &log,
        &first,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    )
    .await;
    let second = invocation("second");
    append(&log, &second, opening()).await;
    let promoted = log
        .edit_message_queue(
            "session",
            5,
            QueueEdit::Promote {
                message_id: "two".into(),
                invocation: second.clone(),
            },
            command("promote", Kind::Promote),
        )
        .await
        .unwrap();
    assert_eq!(promoted.revision, 6);
    let promoted = log.message_queue("session").await.unwrap();
    let entry = promoted
        .entries
        .iter()
        .find(|e| e.source.message.message_id == "two")
        .unwrap();
    assert_eq!(
        entry.invocation, first,
        "promotion does not rewrite original admission ownership"
    );
    let origin = Some(maka_agent_facts::message::MessageOrigin::WorkhubGraph {
        graph_id: "graph-original".into(),
    });
    assert_eq!(entry.source.message.origin, origin);
    assert_eq!(entry.steering_target(), &second);
    assert_eq!(entry.required_tools, ["Read".into()].into());
    assert_eq!(entry.source.submitted_placement, Placement::NextTurn);
    let mut omitted = entry.source.message.clone();
    omitted.content.preparation.clear();
    let omitted_receipt = EventWrite::plain(RuntimeEvent::new(
        second.clone(),
        Fact::MessageSteered {
            source: Box::new({
                let mut source = entry.source.clone();
                source.message = omitted.clone();
                source
            }),
            message: Box::new(omitted),
        },
    ))
    .unwrap();
    assert!(log.append(&omitted_receipt).await.is_err());
    assert_eq!(log.message_queue("session").await.unwrap(), promoted);
    assert_eq!(log.commit_pending_steering(&second).await.unwrap(), 1);
    assert!(matches!(
        log.edit_message_queue(
            "session",
            6,
            QueueEdit::Retract {
                message_id: "two".into(),
                cancellation_id: "late".into()
            },
            command("late", Kind::Retract),
        )
        .await,
        Err(StoreError::RevisionConflict { .. })
    ));
    let proof = log
        .steering_message("session", "two")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proof.event.invocation, second);
    assert!(
        matches!(&proof.event.fact, Fact::MessageSteered { message, .. } if message.content.preparation == [receipt] && message.origin == origin)
    );
    let before_retraction = log.message_queue("session").await.unwrap();
    let cancelled = log
        .edit_message_queue(
            "session",
            before_retraction.revision,
            QueueEdit::RetractAll {
                cancellation_id: "cancel-rest".into(),
            },
            command("cancel-rest", Kind::RetractAll),
        )
        .await
        .unwrap();
    assert_eq!(cancelled.retracted.len(), 2);
    assert_eq!(cancelled.retracted, before_retraction.entries);
    let queue = log.message_queue("session").await.unwrap();
    assert!(queue.entries.is_empty());
    for id in ["one", "three"] {
        assert!(log.message_cancelled("session", id).await.unwrap());
        assert!(
            log.admit_message(admission(&second, id, Disposition::Steering))
                .await
                .is_err()
        );
        assert!(
            log.append(
                &EventWrite::plain(RuntimeEvent::new(second.clone(), {
                    let message = admission(&second, id, Disposition::Steering).source.message;
                    let mut unprepared_content = message.content.clone();
                    unprepared_content.preparation.clear();
                    Fact::MessageSteered {
                        source: Box::new(maka_agent_facts::message::RootSourceMessage {
                            message: message.clone(),
                            unprepared_content,
                            submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
                            disposition: maka_agent_facts::message::MessageDisposition::Steering,
                            submitted_intent: None,
                        }),
                        message: Box::new(message),
                    }
                }))
                .unwrap()
            )
            .await
            .is_err(),
            "cancelled identity cannot bypass the pending path"
        );
    }
    let ids: Vec<_> = ["one", "two", "three", "absent"].map(String::from).into();
    let resolutions = log.message_resolutions("session", &ids).await.unwrap();
    assert_eq!(
        resolutions,
        vec![
            MessageResolution::Cancelled {
                message_id: "one".into()
            },
            MessageResolution::Owned {
                message_id: "two".into(),
                invocation: second
            },
            MessageResolution::Cancelled {
                message_id: "three".into()
            },
            MessageResolution::Absent {
                message_id: "absent".into()
            },
        ]
    );
    assert!(
        log.message_resolutions("foreign", &ids)
            .await
            .unwrap()
            .is_empty()
    );
    let prefix = serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap();
    log.close().await.unwrap();
    drop(db);
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(log.message_queue("session").await.unwrap(), queue);
    assert_eq!(
        log.queue_command_receipt("session", &command("cancel-rest", Kind::RetractAll))
            .await
            .unwrap(),
        Some(cancelled)
    );
    assert_eq!(
        log.message_resolutions("session", &ids).await.unwrap(),
        resolutions
    );
    assert_eq!(
        serde_json::to_vec(&log.prefix(100, 1024 * 1024).await.unwrap()).unwrap(),
        prefix
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn pending_dispatchers_remain_disjoint_across_reopen_and_receipts_bind_execution() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("dispatch.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    for (session, dispatcher) in [
        ("a", "native-a"),
        ("b", "host"),
        ("c", "native-a"),
        ("d", "native-b"),
    ] {
        log.create_session(session, "create", &json!({}), 1)
            .await
            .unwrap();
        let mut owner = invocation(session);
        owner.session_id = session.into();
        append(&log, &owner, opening()).await;
        let mut pending = admission(&owner, "message", Disposition::Followup);
        pending.execution.owner = dispatcher.into();
        // Accepted execution may exceed the receipt's 64KiB budget. Only its
        // digest belongs in the receipt, while the original basis stays pending.
        pending.execution.basis = json!({"model":"accepted","parameters":"x".repeat(70 * 1024)});
        let receipt = log
            .admit_queued_message("epoch", 0, pending.clone())
            .await
            .unwrap();
        assert_eq!(
            log.admit_queued_message("epoch", 0, pending.clone())
                .await
                .unwrap(),
            receipt
        );
        let mut reordered = pending.clone();
        reordered.execution.basis = json!({"parameters":"x".repeat(70 * 1024),"model":"accepted"});
        assert_eq!(
            log.admit_queued_message("epoch", 0, reordered)
                .await
                .unwrap(),
            receipt
        );
        let mut changed = pending.clone();
        changed.execution.basis = json!({"model":"replacement"});
        assert!(log.admit_queued_message("epoch", 0, changed).await.is_err());
        let mut changed = pending.clone();
        changed.execution.owner = "another-owner".into();
        assert!(
            log.admit_queued_message("epoch", 0, changed.clone())
                .await
                .is_err()
        );
        changed.source.message.message_id = "another-message".into();
        assert!(
            log.admit_queued_message("epoch", receipt.queue_revision, changed)
                .await
                .is_err()
        );
        assert_eq!(log.pending_messages(session).await.unwrap(), vec![pending]);
    }
    log.shutdown().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        log.pending_message_sessions("native-a", None)
            .await
            .unwrap(),
        ["a", "c"]
    );
    assert_eq!(
        log.pending_message_sessions("native-a", Some("a"))
            .await
            .unwrap(),
        ["c"]
    );
    assert_eq!(
        log.pending_message_sessions("host", None).await.unwrap(),
        ["b"]
    );
    assert_eq!(
        log.pending_message_sessions("native-b", None)
            .await
            .unwrap(),
        ["d"]
    );
    assert!(
        log.pending_message_sessions("absent", None)
            .await
            .unwrap()
            .is_empty()
    );
    // A receipt remains original evidence even after the pending row is gone.
    let entry = log.pending_messages("a").await.unwrap().remove(0);
    let revision = log.message_queue("a").await.unwrap().revision;
    log.edit_message_queue(
        "a",
        revision,
        QueueEdit::Retract {
            message_id: "message".into(),
            cancellation_id: "cancel".into(),
        },
        command("cancel", Kind::Retract),
    )
    .await
    .unwrap();
    let mut changed = entry.clone();
    changed.execution.basis = json!({"model":"replacement"});
    assert!(log.admit_queued_message("epoch", 0, changed).await.is_err());
    assert!(log.admit_queued_message("epoch", 0, entry).await.is_ok());
    log.shutdown().await.unwrap();
}
