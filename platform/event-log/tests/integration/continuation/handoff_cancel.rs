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
use maka_event_log::turns::InvocationState;

#[tokio::test]
async fn paused_cancellation_claim_is_atomic_idempotent_and_never_cancels_an_existing_owner() {
    for already_claimed in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
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
        *content = "x".repeat(600 * 1024).into();
        source_messages.push(maka_agent_facts::message::RootSourceMessage {
            unprepared_content: content.clone(),
            message: maka_agent_facts::input::DeliveredMessage {
                origin: None,
                message_id: "large-original-message".into(),
                submitted_content_digest: content.content_digest().unwrap(),
                content: content.clone(),
            },
            submitted_placement: maka_agent_facts::message::Placement::CurrentTurn,
            disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
            submitted_intent: None,
        });
        let opening_bytes = serde_json::to_vec(&source).unwrap().len();
        assert!(opening_bytes > 1024 * 1024 && opening_bytes < 8 * 1024 * 1024);
        append(&log, &source).await;
        let before = log
            .context_before_run(&source.invocation, 100, 8 * 1024 * 1024)
            .await
            .unwrap();
        let pause = HandoffPause {
            intent: HandoffIntent {
                handoff_id: "handoff".into(),
                host_epoch: "host".into(),
                root_run_id: source.invocation.run_id.clone(),
                successor_run_id: "next-run".into(),
                successor_invocation_id: "next-invocation".into(),
                claim_id: "claim".into(),
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
        let pending = log.pending_handoffs(0).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].invocation, source.invocation);
        assert_eq!(pending[0].host_epoch, pause.intent.host_epoch);
        assert!(
            log.pending_handoffs(pending[0].sequence)
                .await
                .unwrap()
                .is_empty()
        );
        let frozen = log
            .run_source("session", "source", None)
            .await
            .unwrap()
            .unwrap();
        if already_claimed {
            let mut target = opening("unused", None);
            target.invocation = pause.intent.successor(&source.invocation);
            let Fact::InvocationOpened { input, .. } = &mut target.fact else {
                unreachable!()
            };
            *input = InvocationInput::Handoff {
                claim: Box::new(ContinuationClaim {
                    id: "claim".into(),
                    source: frozen.boundary.clone(),
                    base: SessionBase {
                        high_water: before.source_evidence.high_water,
                        digest: before.source_evidence.digest,
                    },
                    // Same fixture projection evidence; the store authenticates raw ancestry.
                    replay: ReplayEvidence {
                        version: REPLAY_VERSION,
                        digest: digest('a'),
                        route_identity: digest('b'),
                    },
                }),
                pause: Box::new(pause.clone()),
            };
            append(&log, &target).await;
            let before = log.prefix(100, 8 * 1024 * 1024).await.unwrap();
            let result = log.cancel_handoff(&source.invocation).await.unwrap();
            assert_eq!(result.invocation, target.invocation);
            assert!(
                !matches!(result.state, InvocationState::Ended { .. }),
                "the existing worker still owns cancellation"
            );
            assert_eq!(
                log.prefix(100, 8 * 1024 * 1024).await.unwrap().digest,
                before.digest
            );
            close(&log, &target).await;
        } else {
            let database = rusqlite::Connection::open(&path).unwrap();
            database.execute_batch(
                "CREATE TRIGGER reject_cancel BEFORE INSERT ON event_log
                 WHEN NEW.kind='invocation_ended' AND json_extract(NEW.event_header,'$.fact.outcome.kind')='cancelled'
                 BEGIN SELECT RAISE(ABORT, 'cancel fault'); END;"
            ).unwrap();
            let before = log.prefix(100, 8 * 1024 * 1024).await.unwrap();
            assert!(log.cancel_handoff(&source.invocation).await.is_err());
            assert_eq!(
                log.prefix(100, 8 * 1024 * 1024).await.unwrap().digest,
                before.digest,
                "failed terminal must roll back its opening and claim"
            );
            database
                .execute_batch("DROP TRIGGER reject_cancel")
                .unwrap();
            let (first, retry) = tokio::join!(
                log.cancel_handoff(&source.invocation),
                log.cancel_handoff(&source.invocation),
            );
            let first = first.unwrap();
            let retry = retry.unwrap();
            assert_eq!(first.invocation, pause.intent.successor(&source.invocation));
            assert_eq!(first.root_invocation(), &source.invocation);
            assert_eq!(first.invocation, retry.invocation);
            let InvocationState::Ended { event_id, outcome } = first.state else {
                panic!("cancellation did not settle")
            };
            let InvocationState::Ended {
                event_id: retried_id,
                outcome: retried_outcome,
            } = retry.state
            else {
                panic!("retry lost cancellation")
            };
            assert_eq!(event_id, retried_id);
            assert_eq!(
                outcome, retried_outcome,
                "the first cancellation retains its attribution"
            );
            assert!(matches!(outcome, InvocationOutcome::Cancelled { .. }));
            let prefix = log
                .run_source("session", "next-run", None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                prefix.boundary.high_water, 2,
                "cancel requires neither model request nor tool dispatch"
            );
        }
        assert!(
            log.pending_handoffs(0).await.unwrap().is_empty(),
            "the successor opening is the only handoff claim authority"
        );
        assert_eq!(
            log.run_source("session", "source", None)
                .await
                .unwrap()
                .unwrap()
                .boundary
                .digest,
            frozen.boundary.digest
        );
        let later = opening("later-turn", None);
        append(&log, &later).await;
        close(&log, &later).await;
        let before = log.prefix(100, 8 * 1024 * 1024).await.unwrap().digest;
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        let replay = log.cancel_handoff(&source.invocation).await.unwrap();
        assert_eq!(
            replay.invocation.turn_id, source.invocation.turn_id,
            "a later Session Turn is not the claim owner"
        );
        assert_eq!(
            log.prefix(100, 8 * 1024 * 1024).await.unwrap().digest,
            before
        );
        log.close().await.unwrap();
    }
}
