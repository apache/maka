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
use maka_agent_facts::interaction::ClosureReason;
use maka_agent_facts::interaction::GrantCapability;
use maka_agent_facts::interaction::GrantScope;
use maka_agent_facts::interaction::GrantTarget;
use maka_agent_facts::interaction::InteractionOutcome;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;
use maka_event_log::EventLog;

fn request(id: &str) -> InteractionRecord {
    InteractionRecord {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        request_id: id.into(),
        created_at: 10,
        request: InteractionRequest::ClientCapability {
            tool_use_id: "tool-use".into(),
            basis: None,
            target: GrantTarget {
                provider_id: "provider".into(),
                contract_id: "contract".into(),
                server_id: "desktop_browser".into(),
                tool_name: "browser_navigate".into(),
                capability: GrantCapability::Browser,
                scope: GrantScope::BrowserOrigin {
                    origin: "https://example.com".into(),
                },
            },
        },
        outcome: None,
    }
}
fn target(record: &InteractionRecord) -> &GrantTarget {
    let InteractionRequest::ClientCapability { target, .. } = &record.request else {
        panic!("expected capability request")
    };
    target
}
#[tokio::test]
async fn run_closure_guards_every_terminal_and_restart_closes_even_sealed_runs() {
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("runtime.sqlite"))
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationOpened {
                    configuration: None,
                    input: maka_agent_facts::input::InvocationInput::Code {
                        source: "test".into(),
                    },
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    for variant in 0..4 {
        let mut candidate = request(&format!("request_{variant}"));
        match variant {
            1 => candidate.session_id = "other_session".into(),
            2 => candidate.turn_id = "other_turn".into(),
            3 => candidate.run_id = "other_run".into(),
            _ => {}
        }
        log.establish_interaction(&candidate).await.unwrap();
    }
    for outcome in [
        InvocationOutcome::Completed,
        InvocationOutcome::Cancelled {
            source: "test".into(),
        },
        InvocationOutcome::Failed {
            model_failure: None,
            class: "test".into(),
            message: None,
        },
    ] {
        assert!(
            log.append(
                &EventWrite::plain(
                    (RuntimeEvent::new(invocation.clone(), Fact::InvocationEnded { outcome }))
                        .clone()
                )
                .unwrap()
            )
            .await
            .is_err()
        );
    }
    let mut wake = log.subscribe_commits();
    assert_eq!(
        log.close_run_interactions(&invocation, ClosureReason::TurnTerminal, 50)
            .await
            .unwrap(),
        1
    );
    wake.changed().await.unwrap();
    assert_eq!(*wake.borrow_and_update(), 1);
    assert_eq!(
        log.close_run_interactions(&invocation, ClosureReason::HostRestarted, 60)
            .await
            .unwrap(),
        0
    );
    assert!(!wake.has_changed().unwrap());
    assert_eq!(
        log.interaction("request_0").await.unwrap().unwrap().outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::TurnTerminal,
            committed_at: 50
        })
    );
    for variant in 1..4 {
        assert!(
            log.interaction(&format!("request_{variant}"))
                .await
                .unwrap()
                .unwrap()
                .outcome
                .is_none()
        );
    }
    log.append(
        &EventWrite::plain(
            (RuntimeEvent::new(
                invocation.clone(),
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
            ))
            .clone(),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    // Canonical requests remain independent of execution admission: startup must
    // close a legacy pending request even when its execution Run is sealed.
    log.establish_interaction(&request("legacy")).await.unwrap();
    // Exercise multiple bounded ID pages, beyond the Session projection limit.
    for index in 0..130 {
        log.establish_interaction(&request(&format!("bulk_{index:03}")))
            .await
            .unwrap();
    }
    let before = log.prefix(10, 65536).await.unwrap().high_water;
    assert_eq!(log.close_abandoned_interactions(70).await.unwrap(), 134);
    assert_eq!(log.close_abandoned_interactions(80).await.unwrap(), 0);
    assert_eq!(
        log.interaction("legacy").await.unwrap().unwrap().outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::HostRestarted,
            committed_at: 70
        })
    );
    assert_eq!(
        log.interaction("request_0").await.unwrap().unwrap().outcome,
        Some(InteractionOutcome::Closure {
            reason: ClosureReason::TurnTerminal,
            committed_at: 50
        })
    );
    assert_eq!(log.prefix(10, 65536).await.unwrap().high_water, before);
    assert!(
        log.client_capability_grant("session", target(&request("legacy")))
            .await
            .unwrap()
            .is_none()
    );
    let mut invalid = invocation;
    invalid.turn_id.clear();
    assert!(
        log.close_run_interactions(&invalid, ClosureReason::TurnTerminal, 90)
            .await
            .is_err()
    );
    assert!(log.close_abandoned_interactions(u64::MAX).await.is_err());
    log.close().await.unwrap();
}

#[tokio::test]
async fn native_publication_checks_current_run_without_pending_quota() {
    use maka_agent_facts::event::Fact;
    use maka_agent_facts::event::Invocation;
    use maka_agent_facts::event::InvocationOutcome;
    use maka_agent_facts::event::RuntimeEvent;
    let temp = tempfile::tempdir().unwrap();
    let log = EventLog::open(&temp.path().join("native.sqlite"))
        .await
        .unwrap();
    log.create_session("session", "create", &serde_json::json!({}), 1)
        .await
        .unwrap();
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    assert!(
        log.establish_run_interaction(&invocation, &request("absent"))
            .await
            .is_err()
    );
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Code {
                    source: "test".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    for changed in [
        Invocation {
            invocation_id: "foreign".into(),
            ..invocation.clone()
        },
        Invocation {
            session_id: "foreign".into(),
            ..invocation.clone()
        },
        Invocation {
            turn_id: "foreign".into(),
            ..invocation.clone()
        },
        Invocation {
            run_id: "foreign".into(),
            ..invocation.clone()
        },
    ] {
        assert!(
            log.establish_run_interaction(&changed, &request("foreign"))
                .await
                .is_err()
        );
    }
    for index in 0..15 {
        log.establish_run_interaction(&invocation, &request(&format!("native_{index}")))
            .await
            .unwrap();
    }
    let last = request("last");
    let overflow = request("overflow");
    let (a, b) = tokio::join!(
        log.establish_run_interaction(&invocation, &last),
        log.establish_run_interaction(&invocation, &overflow),
    );
    assert!(a.unwrap().matches);
    assert!(b.unwrap().matches);
    assert_eq!(log.pending_interactions("session").await.unwrap().len(), 17);
    let accepted = &last;
    assert!(
        log.establish_run_interaction(&invocation, accepted)
            .await
            .unwrap()
            .matches
    );
    log.close_run_interactions(&invocation, ClosureReason::TurnTerminal, 30)
        .await
        .unwrap();
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(
        log.establish_run_interaction(&invocation, &request("late"))
            .await
            .is_err()
    );
    assert!(log.interaction("late").await.unwrap().is_none());
    assert!(
        log.establish_run_interaction(&invocation, accepted)
            .await
            .unwrap()
            .matches,
        "an exact retry reads its original fact after closure"
    );
    log.close().await.unwrap();
}
