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
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::LogScope;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::{
    ModelPart, TextKind,
    recorded::{ModelObservation, ModelPartRecord},
};
use maka_event_log::{EventLog, StoreError, turns::InvocationState};

#[tokio::test]
async fn turn_control_reads_survive_history_budget_exhaustion_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("runtime.sqlite");
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let event = |fact| RuntimeEvent::new(invocation.clone(), fact);
    let terminal = event(Fact::InvocationEnded {
        outcome: InvocationOutcome::Cancelled {
            source: "runtime_cancellation".into(),
        },
    });
    {
        let log = EventLog::open(&path).await.unwrap();
        log.append(
            &EventWrite::plain(
                (event(Fact::InvocationOpened {
                    configuration: None,
                    input: maka_agent_facts::input::InvocationInput::Message {
                        source_messages: Vec::new(),
                        content: "question".into(),
                        request_fingerprint: Some("sha256:fixture".into()),
                    },
                }))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        let prefix = log
            .scoped_prefix(
                LogScope::Session {
                    id: "session".into(),
                },
                10,
                1024,
            )
            .await
            .unwrap();
        log.append(
            &EventWrite::plain(
                (event(Fact::ModelRequested {
                    context_breakdown: None,
                    item_acceptance: true,
                    purpose: maka_agent_facts::context::ModelPurpose::Main,
                    context: None,
                    checkpoint_event_id: None,
                    step_id: "step".into(),
                    model_id: "test".into(),
                    source_scope: prefix.scope,
                    source_high_water: prefix.high_water,
                    source_digest: prefix.digest,
                    effective_source_digest: None,
                    input_digest: "input".into(),
                    route_identity: "route".into(),
                }))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        log.append(
            &EventWrite::plain(
                (event(Fact::ModelObserved {
                    step_id: "step".into(),
                    event: ModelObservation::Part(ModelPartRecord {
                        ordinal: 0,
                        message_id: "large-text".into(),
                        started_at: std::time::UNIX_EPOCH,
                        provider_part_id: Some("text".into()),
                        part: std::sync::Arc::new(ModelPart::Text {
                            text_kind: TextKind::Text,
                            text: "x".repeat(8 * 1024 * 1024).into(),
                            provider_options: None,
                        }),
                    }),
                }))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        assert!(matches!(
            log.scoped_prefix(
                LogScope::Session {
                    id: "session".into()
                },
                10_000,
                8 * 1024 * 1024
            )
            .await,
            Err(StoreError::PrefixTooLarge)
        ));
        let boundary = log.turn_boundary("session", "turn").await.unwrap().unwrap();
        assert!(matches!(boundary.state, InvocationState::Running));
        assert!(matches!(
            log.run_boundary("session", "run")
                .await
                .unwrap()
                .unwrap()
                .state,
            InvocationState::Running
        ));
        assert!(
            matches!(boundary.input, maka_agent_facts::input::InvocationInput::Message {
            request_fingerprint: Some(ref fingerprint), ..
        } if fingerprint == "sha256:fixture")
        );
        assert!(
            log.turn_boundary("another-session", "turn")
                .await
                .unwrap()
                .is_none()
        );
        log.append(
            &EventWrite::plain(
                (event(Fact::ModelInterrupted {
                    partial: None,
                    model_failure: None,
                    diagnostic: None,
                    step_id: "step".into(),
                    status: ModelInterruption::Cancelled,
                }))
                .clone(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        log.append(&EventWrite::plain((terminal).clone()).unwrap())
            .await
            .unwrap();
        log.close().await.unwrap();
    }
    let log = EventLog::open(&path).await.unwrap();
    // A physical successor has the same logical Turn, not the same Run/Invocation.
    let successor = Invocation {
        run_id: "successor-run".into(),
        invocation_id: "successor-invocation".into(),
        ..invocation.clone()
    };
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            successor.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: Vec::new(),
                    content: "successor fixture".into(),
                    request_fingerprint: None,
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        log.turn_boundary("session", "turn")
            .await
            .unwrap()
            .unwrap()
            .invocation,
        successor
    );
    assert!(
        log.run_boundary("another-session", "run")
            .await
            .unwrap()
            .is_none()
    );
    let boundary = log.run_boundary("session", "run").await.unwrap().unwrap();
    assert_eq!(boundary.invocation, invocation);
    let InvocationState::Ended { event_id, outcome } = boundary.state else {
        panic!("missing terminal");
    };
    assert_eq!(event_id, terminal.id);
    assert_eq!(
        outcome,
        InvocationOutcome::Cancelled {
            source: "runtime_cancellation".into()
        }
    );
}
