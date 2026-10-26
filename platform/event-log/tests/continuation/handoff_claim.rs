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
use maka_agent_facts::handoff::HandoffIntent;
use maka_agent_facts::handoff::HandoffPause;

#[tokio::test]
async fn handoff_claim_preserves_turn_and_frozen_ancestry_without_releasing_reserved_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("handoff.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let root = opening("root", None);
    append(&log, &root).await;
    let context = log
        .context_before_run(&root.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    let mut source = root.clone();
    for round in 0..2 {
        let pause = HandoffPause {
            intent: HandoffIntent {
                handoff_id: format!("handoff-{round}"),
                host_epoch: format!("host-{round}"),
                root_run_id: root.invocation.run_id.clone(),
                successor_run_id: format!("run-{round}"),
                successor_invocation_id: format!("invocation-{round}"),
                claim_id: format!("claim-{round}"),
            },
            execution: super::handoff::execution(),
        };
        append(
            &log,
            &RuntimeEvent::new(
                source.invocation.clone(),
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::HandoffPaused {
                        pause: pause.clone(),
                    },
                },
            ),
        )
        .await;
        let before = log.prefix(100, 65536).await.unwrap();
        let inherited = claim(&log, &pause.intent.claim_id, &source, base.clone()).await;
        let Fact::InvocationOpened { configuration, .. } = &source.fact else {
            unreachable!()
        };
        let target = RuntimeEvent::new(
            pause.intent.successor(&source.invocation),
            Fact::InvocationOpened {
                configuration: configuration.clone(),
                input: InvocationInput::Handoff {
                    claim: Box::new(inherited.clone()),
                    pause: Box::new(pause.clone()),
                },
            },
        );
        for mutation in 0..5 {
            let mut changed = target.clone();
            let Fact::InvocationOpened {
                input: InvocationInput::Handoff { claim, pause },
                configuration,
            } = &mut changed.fact
            else {
                unreachable!()
            };
            match mutation {
                0 => pause.execution.main_output_limit = Some(20),
                1 => configuration.as_mut().unwrap().sandbox_mode = SandboxMode::DangerFullAccess,
                2 => claim.source.digest = digest('d'),
                3 => claim.id = "not-reserved".into(),
                _ => changed.invocation.turn_id = "new-turn".into(),
            }
            match EventWrite::plain(changed) {
                Ok(write) => assert!(log.append(&write).await.is_err()),
                Err(maka_agent_facts::event::CommitError::Rejected(_)) => {}
                Err(error) => panic!("unexpected failure: {error}"),
            }
        }
        for steal_invocation in [false, true] {
            let mut other = opening("unrelated", None);
            other.invocation.session_id = "other-session".into();
            if steal_invocation {
                other.invocation.invocation_id = pause.intent.successor_invocation_id.clone();
            } else {
                other.invocation.run_id = pause.intent.successor_run_id.clone();
            }
            assert!(
                log.append(&EventWrite::plain(other).unwrap())
                    .await
                    .is_err()
            );
        }
        assert_eq!(log.prefix(100, 65536).await.unwrap().digest, before.digest);
        if round == 0 {
            let mut competitor = opening("competitor", None);
            competitor.invocation.session_id = "other-session".into();
            append(&log, &competitor).await;
            for field in 0..3 {
                let mut conflicting = pause.clone();
                conflicting.intent.root_run_id = competitor.invocation.run_id.clone();
                if field != 0 {
                    conflicting.intent.successor_run_id = "other-run".into();
                }
                if field != 1 {
                    conflicting.intent.successor_invocation_id = "other-invocation".into();
                }
                if field != 2 {
                    conflicting.intent.claim_id = "other-claim".into();
                }
                assert!(
                    log.check_handoff(&competitor.invocation, &conflicting)
                        .await
                        .is_err(),
                    "known reservations must be rejected before an irreversible decision"
                );
            }
            close(&log, &competitor).await;
        }
        assert!(
            log.continuation_for_source(&inherited.source)
                .await
                .unwrap()
                .is_none()
        );
        let sequence = append(&log, &target).await;
        assert_eq!(
            append(&log, &target).await,
            sequence,
            "canonical replay does not acquire twice"
        );
        assert_eq!(
            log.continuation_for_source(&inherited.source)
                .await
                .unwrap()
                .unwrap()
                .event
                .id,
            target.id
        );
        assert_eq!(target.invocation.turn_id, root.invocation.turn_id);
        let logical = log
            .turn_boundary("session", &root.invocation.turn_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            logical.invocation, target.invocation,
            "control owns the physical tip"
        );
        assert_eq!(
            logical.root_invocation(),
            &root.invocation,
            "client identity is stable across handoffs"
        );
        assert_eq!(logical.root_opening_event_id(), root.id);
        assert!(matches!(
            logical.root_input(),
            InvocationInput::Message { .. }
        ));
        let physical = log
            .run_boundary("session", &source.invocation.run_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            physical.invocation, source.invocation,
            "exact Run reads never jump to a successor"
        );
        let mut view = InvocationView::new();
        assert!(
            view.push(&StoredEvent {
                sequence,
                event: target.clone()
            })
            .unwrap()
            .iter()
            .all(|row| !matches!(row.message.content, maka_presentation::Content::User { .. })),
            "a successor does not invent another user message"
        );
        source = target;
    }
    close(&log, &source).await;
    let last = claim(&log, "manual", &source, base).await;
    let manual = opening("manual-turn", Some(last));
    append(&log, &manual).await;
    let fresh = log
        .turn_boundary("session", &manual.invocation.turn_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        fresh.root_invocation(),
        &manual.invocation,
        "manual resume starts a fresh logical Turn"
    );
    let Fact::InvocationOpened {
        input: InvocationInput::Continuation { claim, .. },
        ..
    } = &manual.fact
    else {
        unreachable!()
    };
    let mut pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "manual-handoff".into(),
            host_epoch: "host".into(),
            root_run_id: manual.invocation.run_id.clone(),
            successor_run_id: "manual-successor-run".into(),
            successor_invocation_id: "manual-successor-invocation".into(),
            claim_id: "manual-successor-claim".into(),
        },
        execution: super::handoff::execution(),
    };
    assert!(
        log.check_handoff(&manual.invocation, &pause).await.is_err(),
        "a physical handoff cannot discard manual resume's stable-cut policy"
    );
    pause.execution.replay_base = Some(claim.base.high_water);
    log.check_handoff(&manual.invocation, &pause).await.unwrap();
    close(&log, &manual).await;
    let prefix = log
        .run_source("session", &manual.invocation.run_id, None)
        .await
        .unwrap()
        .unwrap();
    let boundary = prefix.boundary;
    let before = log
        .capture_lineage_context(&boundary, 100, 65536)
        .await
        .unwrap();
    assert_eq!(
        before
            .tail
            .iter()
            .filter(|event| matches!(event,
        maka_event_log::context::ContextEvent::Canonical(event) if matches!(event.event.fact,
            Fact::InvocationOpened { input: InvocationInput::Message { .. }, .. })))
            .count(),
        1
    );
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    let after = reopened
        .capture_lineage_context(&boundary, 100, 65536)
        .await
        .unwrap();
    assert_eq!(before.source_evidence.scope, after.source_evidence.scope);
    assert_eq!(
        before.source_evidence.high_water,
        after.source_evidence.high_water
    );
    assert_eq!(before.source_evidence.digest, after.source_evidence.digest);
    assert_eq!(
        before.effective_source_digest,
        after.effective_source_digest
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn workspace_refusal_and_deep_handoff_control_preserve_canonical_ownership() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("eligibility.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let mut missing = opening("missing", None);
    if let Fact::InvocationOpened {
        configuration: Some(configuration),
        ..
    } = &mut missing.fact
    {
        configuration.workspace_identity = None;
    }
    append(&log, &missing).await;
    let mut pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "host".into(),
            root_run_id: "missing".into(),
            successor_run_id: "successor".into(),
            successor_invocation_id: "successor-invocation".into(),
            claim_id: "claim".into(),
        },
        execution: super::handoff::execution(),
    };
    assert!(
        log.check_handoff(&missing.invocation, &pause)
            .await
            .is_err()
    );
    assert!(
        log.append(
            &EventWrite::plain(RuntimeEvent::new(
                missing.invocation.clone(),
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::HandoffPaused {
                        pause: pause.clone()
                    },
                }
            ))
            .unwrap()
        )
        .await
        .is_err()
    );
    close(&log, &missing).await;

    let mut root = opening("root", None);
    let Fact::InvocationOpened {
        input:
            InvocationInput::Message {
                content,
                source_messages,
                ..
            },
        ..
    } = &mut root.fact
    else {
        unreachable!()
    };
    source_messages.push(maka_agent_facts::message::RootSourceMessage {
        unprepared_content: content.clone(),
        message: maka_agent_facts::input::DeliveredMessage {
            origin: None,
            message_id: "deep-origin-message".into(),
            submitted_content_digest: content.content_digest().unwrap(),
            content: content.clone(),
        },
        submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
        disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
        submitted_intent: None,
    });
    append(&log, &root).await;
    let context = log
        .context_before_run(&root.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    pause.intent.root_run_id = root.invocation.run_id.clone();
    let mut source = root.clone();
    for round in 0..66 {
        pause.intent.handoff_id = format!("handoff-{round}");
        pause.intent.successor_run_id = format!("run-{round}");
        pause.intent.successor_invocation_id = format!("invocation-{round}");
        pause.intent.claim_id = format!("claim-{round}");
        let seal = EventWrite::plain(RuntimeEvent::new(
            source.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        ))
        .unwrap();
        log.check_handoff(&source.invocation, &pause).await.unwrap();
        log.append(&seal).await.unwrap();
        let inherited = claim(&log, &pause.intent.claim_id, &source, base.clone()).await;
        let Fact::InvocationOpened { configuration, .. } = &source.fact else {
            unreachable!()
        };
        source = RuntimeEvent::new(
            pause.intent.successor(&source.invocation),
            Fact::InvocationOpened {
                configuration: configuration.clone(),
                input: InvocationInput::Handoff {
                    claim: Box::new(inherited),
                    pause: Box::new(pause.clone()),
                },
            },
        );
        append(&log, &source).await;
    }
    assert_eq!(source.invocation.run_id, "run-65");
    let before = serde_json::to_value(log.prefix(1000, 1024 * 1024).await.unwrap()).unwrap();
    let owner = log.cancel_handoff(&root.invocation).await.unwrap();
    assert_eq!(owner.invocation, source.invocation);
    assert_eq!(owner.root_invocation(), &root.invocation);
    assert!(matches!(
        log.message_execution("session", "deep-origin-message").await.unwrap(),
        maka_event_log::message_resolution::MessageExecution::Owned(owner)
            if owner.invocation == source.invocation
    ));
    assert_eq!(
        serde_json::to_value(log.prefix(1000, 1024 * 1024).await.unwrap()).unwrap(),
        before
    );

    pause.intent.handoff_id = "deep-final-handoff".into();
    pause.intent.successor_run_id = "deep-cancelled-run".into();
    pause.intent.successor_invocation_id = "deep-cancelled-invocation".into();
    pause.intent.claim_id = "deep-cancelled-claim".into();
    log.check_handoff(&source.invocation, &pause).await.unwrap();
    append(
        &log,
        &RuntimeEvent::new(
            source.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        ),
    )
    .await;
    let sealed = log
        .run_source("session", "run-65", None)
        .await
        .unwrap()
        .unwrap();
    let sealed_prefix = log.prefix(1000, 1024 * 1024).await.unwrap();
    let cancelled = log.cancel_handoff(&source.invocation).await.unwrap();
    let after_cancel = log.prefix(1000, 1024 * 1024).await.unwrap();
    assert_eq!(after_cancel.events.len(), sealed_prefix.events.len() + 2);
    assert_eq!(
        serde_json::to_value(&after_cancel.events[..sealed_prefix.events.len()]).unwrap(),
        serde_json::to_value(&sealed_prefix.events).unwrap()
    );
    assert_eq!(
        cancelled.invocation,
        pause.intent.successor(&source.invocation)
    );
    assert!(matches!(
        &cancelled.state,
        maka_event_log::turns::InvocationState::Ended {
            outcome: InvocationOutcome::Cancelled { source },
            ..
        } if source == "runtime_cancellation"
    ));
    let cancelled_source = log
        .run_source("session", "deep-cancelled-run", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cancelled_source.boundary.high_water, 2);
    let Fact::InvocationOpened {
        input: InvocationInput::Handoff { claim, .. },
        ..
    } = &cancelled_source.opening.event.fact
    else {
        unreachable!()
    };
    assert_eq!(claim.source, sealed.boundary);
    append(&log, &opening("next-turn", None)).await;
    let raw_proof = serde_json::to_value(log.prefix(1000, 1024 * 1024).await.unwrap()).unwrap();
    let mut first_log = Some(log);
    for _ in 0..2 {
        let log = match first_log.take() {
            Some(log) => log,
            None => EventLog::open(&path).await.unwrap(),
        };
        let owner = log.cancel_handoff(&root.invocation).await.unwrap();
        assert_eq!(owner.invocation, cancelled.invocation);
        assert_eq!(owner.root_invocation(), &root.invocation);
        assert!(
            matches!(log.message_execution("session", "deep-origin-message").await.unwrap(),
            maka_event_log::message_resolution::MessageExecution::Owned(owner)
                if owner.invocation == cancelled.invocation)
        );
        assert_eq!(
            log.run_source("session", "run-65", None)
                .await
                .unwrap()
                .unwrap()
                .boundary,
            sealed.boundary
        );
        assert_eq!(
            serde_json::to_value(log.prefix(1000, 1024 * 1024).await.unwrap()).unwrap(),
            raw_proof
        );
        log.close().await.unwrap();
    }
}

#[tokio::test]
async fn handoff_preserves_distinct_physical_and_logical_roots_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("ambiguous-handoff-root.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let root = opening("root", None);
    append(&log, &root).await;
    let context = log
        .context_before_run(&root.invocation, 100, 65536)
        .await
        .unwrap();
    let pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "host".into(),
            root_run_id: root.invocation.run_id.clone(),
            successor_run_id: "successor-run".into(),
            successor_invocation_id: "successor-invocation".into(),
            claim_id: "successor-claim".into(),
        },
        execution: super::handoff::execution(),
    };
    append(
        &log,
        &RuntimeEvent::new(
            root.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        ),
    )
    .await;
    let inherited = claim(
        &log,
        &pause.intent.claim_id,
        &root,
        SessionBase {
            high_water: context.source_evidence.high_water,
            digest: context.source_evidence.digest,
        },
    )
    .await;
    let Fact::InvocationOpened { configuration, .. } = &root.fact else {
        unreachable!()
    };
    let successor = RuntimeEvent::new(
        pause.intent.successor(&root.invocation),
        Fact::InvocationOpened {
            configuration: configuration.clone(),
            input: InvocationInput::Handoff {
                claim: Box::new(inherited),
                pause: Box::new(pause),
            },
        },
    );
    append(&log, &successor).await;
    let physical = log
        .run_boundary("session", &successor.invocation.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(physical.invocation, successor.invocation);
    assert_eq!(physical.opening_event_id, successor.id);
    assert_eq!(physical.root_invocation(), &root.invocation);
    assert_eq!(physical.root_opening_event_id(), root.id);
    assert!(matches!(
        physical.root_input(),
        InvocationInput::Message { .. }
    ));

    let canonical_before = serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log
        .run_boundary("session", &successor.invocation.run_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reopened.invocation, physical.invocation);
    assert_eq!(reopened.opening_event_id, physical.opening_event_id);
    assert_eq!(reopened.root_invocation(), &root.invocation);
    assert_eq!(reopened.root_opening_event_id(), root.id);
    assert!(matches!(
        reopened.root_input(),
        InvocationInput::Message { .. }
    ));
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        canonical_before
    );
    log.close().await.unwrap();
}

#[tokio::test]
async fn handoff_rejects_reused_successor_and_preserves_latest_owner_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("owner-cycle.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let root = opening("root", None);
    append(&log, &root).await;
    let context = log
        .context_before_run(&root.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    let mut source = root.clone();
    let mut successors = Vec::new();
    for id in ["a", "b"] {
        let pause = HandoffPause {
            intent: HandoffIntent {
                handoff_id: format!("handoff-{id}"),
                host_epoch: "host".into(),
                root_run_id: root.invocation.run_id.clone(),
                successor_run_id: format!("run-{id}"),
                successor_invocation_id: format!("invocation-{id}"),
                claim_id: format!("claim-{id}"),
            },
            execution: super::handoff::execution(),
        };
        log.check_handoff(&source.invocation, &pause).await.unwrap();
        let seal = RuntimeEvent::new(
            source.invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::HandoffPaused {
                    pause: pause.clone(),
                },
            },
        );
        append(&log, &seal).await;
        let inherited = claim(&log, &pause.intent.claim_id, &source, base.clone()).await;
        let Fact::InvocationOpened { configuration, .. } = &source.fact else {
            unreachable!()
        };
        source = RuntimeEvent::new(
            pause.intent.successor(&source.invocation),
            Fact::InvocationOpened {
                configuration: configuration.clone(),
                input: InvocationInput::Handoff {
                    claim: Box::new(inherited),
                    pause: Box::new(pause),
                },
            },
        );
        append(&log, &source).await;
        successors.push(source.clone());
    }
    let a = &successors[0];
    let b = &successors[1];
    let pause = HandoffPause {
        intent: HandoffIntent {
            handoff_id: "last-handoff".into(),
            host_epoch: "host".into(),
            root_run_id: root.invocation.run_id.clone(),
            successor_run_id: "run-c".into(),
            successor_invocation_id: "invocation-c".into(),
            claim_id: "claim-c".into(),
        },
        execution: super::handoff::execution(),
    };
    let mut reused = pause.clone();
    reused.intent.successor_run_id = a.invocation.run_id.clone();
    reused.intent.successor_invocation_id = a.invocation.invocation_id.clone();
    let before = serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap();
    assert!(log.check_handoff(&b.invocation, &reused).await.is_err());
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        before
    );
    log.check_handoff(&b.invocation, &pause).await.unwrap();
    let last_seal = RuntimeEvent::new(
        b.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::HandoffPaused {
                pause: pause.clone(),
            },
        },
    );
    append(&log, &last_seal).await;
    let valid = log.cancel_handoff(&a.invocation).await.unwrap();
    assert_eq!(valid.invocation, b.invocation);
    assert!(matches!(
        valid.state,
        maka_event_log::turns::InvocationState::Ended {
            outcome: InvocationOutcome::HandoffPaused { .. },
            ..
        }
    ));

    let canonical_before = serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap();
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    let reopened = log.cancel_handoff(&a.invocation).await.unwrap();
    assert_eq!(reopened.invocation, b.invocation);
    assert!(matches!(
        reopened.state,
        maka_event_log::turns::InvocationState::Ended {
            outcome: InvocationOutcome::HandoffPaused { .. },
            ..
        }
    ));
    assert_eq!(
        serde_json::to_value(log.prefix(100, 65536).await.unwrap()).unwrap(),
        canonical_before
    );
    log.close().await.unwrap();
}
