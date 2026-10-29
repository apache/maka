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

use maka_agent_facts::continuation::ContinuationClaim;
use maka_agent_facts::continuation::REPLAY_VERSION;
use maka_agent_facts::continuation::ReplayEvidence;
use maka_agent_facts::continuation::SessionBase;
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use maka_agent_facts::execution::BehaviorId;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::ToolMode;
use maka_agent_facts::execution::WorkspaceIdentity;
use maka_agent_facts::input::InvocationInput;
use maka_event_log::EventLog;
use maka_presentation::{Content, InvocationView, TurnState};

mod bundle;
pub(crate) mod fixtures;
mod handoff;
mod handoff_budget;
mod handoff_cancel;
mod handoff_claim;
mod handoff_consumers;
mod imported;
use fixtures::*;

#[tokio::test]
async fn canonical_claim_is_atomic_unique_and_preserves_the_entire_lineage_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("continuation.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "history-source", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let prior = opening("prior", None);
    append(&log, &prior).await;
    close(&log, &prior).await;
    let mut source = opening("source", None);
    if let Fact::InvocationOpened {
        input:
            InvocationInput::Message {
                content,
                source_messages,
                ..
            },
        ..
    } = &mut source.fact
    {
        source_messages.push(maka_agent_facts::message::RootSourceMessage {
            unprepared_content: content.clone(),
            message: maka_agent_facts::input::DeliveredMessage {
                origin: None,
                message_id: "origin-message".into(),
                submitted_content_digest: content.content_digest().unwrap(),
                content: content.clone(),
            },
            submitted_placement: maka_agent_facts::message::Placement::NextTurn,
            disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
            submitted_intent: None,
        });
    }
    append(&log, &source).await;
    close(&log, &source).await;
    let context = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    assert_eq!(base.high_water, 2);
    let original = claim(&log, "claim-first", &source, base.clone()).await;
    let before = log.prefix(100, 65536).await.unwrap();
    assert!(
        log.continuation_for_source(&original.source)
            .await
            .unwrap()
            .is_none()
    );

    // Invalid raw evidence and workspace observations must not acquire the boundary.
    for mutation in 0..5 {
        let mut changed = original.clone();
        match mutation {
            0 => changed.source.digest = digest('c'),
            1 => changed.base.digest = digest('c'),
            2 => changed.source.invocation.turn_id = "wrong-source-turn".into(),
            _ => {}
        }
        let mut target = opening("first", Some(changed));
        if let Fact::InvocationOpened {
            configuration: Some(configuration),
            ..
        } = &mut target.fact
        {
            match mutation {
                3 => configuration.workspace_identity = None,
                4 => {
                    configuration.workspace_identity = Some(
                        WorkspaceIdentity::from_marker_id("bedbc850-d324-435a-9374-a02ae5037244")
                            .unwrap(),
                    )
                }
                _ => {}
            }
        }
        assert!(
            log.append(&EventWrite::plain(target).unwrap())
                .await
                .is_err()
        );
    }
    for mutation in 0..3 {
        let mut target = opening("first", Some(original.clone()));
        match mutation {
            0 => target.invocation.turn_id = source.invocation.turn_id.clone(),
            1 => target.invocation.session_id = "other-session".into(),
            _ => {
                if let Fact::InvocationOpened {
                    input: InvocationInput::Continuation { claim, .. },
                    ..
                } = &mut target.fact
                {
                    claim.replay.version += 1;
                }
            }
        }
        assert!(EventWrite::plain(target).is_err());
    }

    let first = opening("first", Some(original.clone()));
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TRIGGER reject_continuation BEFORE INSERT ON event_log
        WHEN json_extract(NEW.event_json,'$.fact.input.kind')='continuation'
        BEGIN SELECT RAISE(ABORT,'injected opening failure'); END;",
    )
    .unwrap();
    assert!(
        log.append(&EventWrite::plain(first.clone()).unwrap())
            .await
            .is_err()
    );
    assert!(
        log.continuation_for_source(&original.source)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        serde_json::to_value(&before).unwrap()
    );
    db.execute_batch("DROP TRIGGER reject_continuation")
        .unwrap();

    let sequence = append(&log, &first).await;
    let committed = log
        .continuation_for_source(&original.source)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(committed.event, first);
    assert_eq!(committed.sequence, sequence);
    let mut view = InvocationView::new();
    assert!(
        view.push(&committed).unwrap().iter().all(|row| matches!(
            row.message.content,
            maka_presentation::Content::TurnState {
                state: maka_presentation::TurnState::Running
            }
        )),
        "continuation must not fabricate a user message"
    );
    let terminal = RuntimeEvent::new(
        first.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    let terminal_sequence = append(&log, &terminal).await;
    let revision = log
        .get_session::<serde_json::Value>("session")
        .await
        .unwrap()
        .unwrap()
        .revision;
    use maka_event_log::context::{ContextEvent, HistoryCapture, HistoryCut};
    for (cut, expected) in [
        (
            HistoryCut::BeforeTurn(first.invocation.turn_id.clone()),
            sequence - 1,
        ),
        (
            HistoryCut::ThroughTurn(first.invocation.turn_id.clone()),
            terminal_sequence,
        ),
    ] {
        let HistoryCapture::Captured(history) = log
            .capture_session_history("session", revision, cut, 100, 65536)
            .await
            .unwrap()
        else {
            panic!("unchanged source");
        };
        assert_eq!(history.context.source_evidence.high_water, expected);
        assert_eq!(
            history.context.tail.iter().any(|entry| matches!(entry,
                ContextEvent::Canonical(entry) if entry.event == first
            )),
            expected == terminal_sequence
        );
    }
    let rows = view
        .push(&StoredEvent {
            sequence: terminal_sequence,
            event: terminal,
        })
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert!(matches!(
        rows[0].message.content,
        Content::TurnState {
            state: TurnState::Completed
        }
    ));

    let mut duplicate = original.clone();
    duplicate.id = "different-claim".into();
    assert!(
        log.append(&EventWrite::plain(opening("duplicate", Some(duplicate))).unwrap())
            .await
            .is_err()
    );
    assert_eq!(
        append(&log, &first).await,
        sequence,
        "exact retry remains legal after sealing"
    );
    let mut wrong_lookup = original.source.clone();
    wrong_lookup.digest = digest('e');
    assert!(log.continuation_for_source(&wrong_lookup).await.is_err());

    let second_claim = claim(&log, "claim-second", &first, base.clone()).await;
    let reused_turn = opening("prior", Some(second_claim.clone()));
    assert!(
        log.append(&EventWrite::plain(reused_turn).unwrap())
            .await
            .is_err()
    );
    let second = opening("second", Some(second_claim.clone()));
    append(&log, &second).await;
    close(&log, &second).await;
    let third_claim = claim(&log, "claim-third", &second, base).await;
    let unrelated = opening("unrelated", None);
    append(&log, &unrelated).await;
    close(&log, &unrelated).await;
    log.close().await.unwrap();

    let log = EventLog::open(&path).await.unwrap();
    assert!(
        matches!(
            log.message_execution("session", "origin-message").await.unwrap(),
            maka_event_log::message_resolution::MessageExecution::Owned(owner) if owner.invocation == second.invocation
        ),
        "Message ownership follows continuation claims, never the latest Session root"
    );
    assert_eq!(
        log.continuation_for_source(&original.source)
            .await
            .unwrap()
            .unwrap()
            .event,
        first
    );
    assert_eq!(
        log.continuation_for_source(&second_claim.source)
            .await
            .unwrap()
            .unwrap()
            .event,
        second
    );
    assert_eq!(append(&log, &first).await, sequence);
    // A previously admitted ancestry remains usable after reopen. Fresh claims
    // above still validate their source identity and cannot reuse an owned edge.
    let third = opening("third", Some(third_claim.clone()));
    append(&log, &third).await;
    assert_eq!(
        log.continuation_for_source(&third_claim.source)
            .await
            .unwrap()
            .unwrap()
            .event,
        third
    );
    assert!(matches!(
        log.message_execution("session", "origin-message").await.unwrap(),
        maka_event_log::message_resolution::MessageExecution::Owned(owner)
            if owner.invocation == third.invocation
    ));
    log.close().await.unwrap();
}

#[tokio::test]
async fn message_owner_rejects_new_competing_claim_and_preserves_owner_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("ambiguous-successors.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.create_session("session", "history-source", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let mut source = opening("source", None);
    let Fact::InvocationOpened {
        input:
            InvocationInput::Message {
                content,
                source_messages,
                ..
            },
        ..
    } = &mut source.fact
    else {
        unreachable!()
    };
    source_messages.push(maka_agent_facts::message::RootSourceMessage {
        unprepared_content: content.clone(),
        message: maka_agent_facts::input::DeliveredMessage {
            origin: None,
            message_id: "origin-message".into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
        },
        submitted_placement: maka_agent_facts::message::Placement::NextTurn,
        disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
        submitted_intent: None,
    });
    append(&log, &source).await;
    close(&log, &source).await;
    let context = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap();
    let original = claim(
        &log,
        "valid-claim",
        &source,
        SessionBase {
            high_water: context.source_evidence.high_water,
            digest: context.source_evidence.digest,
        },
    )
    .await;
    let successor = opening("successor", Some(original.clone()));
    append(&log, &successor).await;
    assert!(matches!(
        log.message_execution("session", "origin-message")
            .await
            .unwrap(),
        maka_event_log::message_resolution::MessageExecution::Owned(owner)
            if owner.invocation == successor.invocation
    ));

    // A new competing source cut is checked at admission and cannot replace the
    // existing message owner. No out-of-band private-ledger rewrite is involved.
    let mut competing = original;
    competing.id = "competing-claim".into();
    competing.source.high_water += 1;
    let competing = opening("competing-successor", Some(competing));
    let canonical_before = serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap();
    assert!(
        log.append(&EventWrite::plain(competing).unwrap())
            .await
            .is_err()
    );
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        canonical_before
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert!(matches!(
        log.message_execution("session", "origin-message").await.unwrap(),
        maka_event_log::message_resolution::MessageExecution::Owned(owner)
            if owner.invocation == successor.invocation
    ));
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        canonical_before
    );
    log.close().await.unwrap();
}
