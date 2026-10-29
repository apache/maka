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

//! Actual SQLite admission/continuation keepers. The native producer is tested
//! at its own bound worker boundary; these tests do not simulate a physical key.
use maka_agent_facts::{
    continuation::{REPLAY_VERSION, ReplayEvidence, SessionBase},
    event::{
        CommitError, CommitFuture, EventSink, EventWrite, Fact, Invocation, InvocationOutcome,
        RuntimeEvent, ToolOutcome,
    },
    handoff::{CompactionBudget, HandoffExecution, HandoffIntent, HandoffPause, HandoffTools},
    input::InvocationInput,
    interaction::{
        Decision, GrantCapability, GrantScope, GrantTarget, InteractionOutcome, InteractionRecord,
        InteractionRequest,
    },
    tool_call::{HostSdkParent, ToolCallIdentity, ToolOrigin},
    tool_output::ToolOutput,
    tools::{PreparedEffect, ToolError, ToolJournal},
    workspace::{BindingStamp, PermissionBasis},
};
use maka_event_log::{
    EventLog, StoreError,
    native_computer::{InterruptionCommit, NativeInterruption},
};
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

use crate::continuation::fixtures::*;

fn target() -> GrantTarget {
    GrantTarget {
        provider_id: "maka_workspace_computer".into(),
        contract_id: "maka_workspace_computer_v1".into(),
        server_id: "maka_workspace_computer".into(),
        tool_name: "cua_repl".into(),
        capability: GrantCapability::ComputerUse,
        scope: GrantScope::Capability {},
    }
}
async fn session(log: &EventLog, id: &str) -> PermissionBasis {
    let binding = log
        .attach_workspace(id, &json!({"path":"/workspace"}))
        .await
        .unwrap();
    log.create_session(
        id,
        id,
        &json!({"workspace":binding,"boundary_revision":0}),
        1,
    )
    .await
    .unwrap();
    PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: binding.id,
            permission_epoch: binding.permission_epoch_at_attach,
        },
    }
}
fn open(session: &str, turn: &str) -> RuntimeEvent {
    let mut event = opening(turn, None);
    event.invocation.session_id = session.into();
    event
}
async fn grant(log: &EventLog, invocation: &Invocation, basis: PermissionBasis, id: &str) {
    log.establish_run_interaction(
        invocation,
        &InteractionRecord {
            session_id: invocation.session_id.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: id.into(),
            created_at: 2,
            outcome: None,
            request: InteractionRequest::ClientCapability {
                tool_use_id: format!("tool-{id}"),
                target: target(),
                basis: Some(basis),
            },
        },
    )
    .await
    .unwrap();
    log.commit_interaction_outcome(
        id,
        InteractionOutcome::ClientCapabilityDecision {
            decision: Decision::Allow,
            committed_at: 3,
        },
    )
    .await
    .unwrap();
}
fn dispatch(invocation: &Invocation, id: &str, parent: Option<(&str, &str)>) -> EventWrite {
    EventWrite::plain(RuntimeEvent::new(
        invocation.clone(),
        Fact::ToolDispatched {
            presentation: None,
            title: None,
            operation_id: id.into(),
            name: "cua_operation".into(),
            input: json!({}),
            call: ToolCallIdentity {
                tool_call_id: format!("call-{id}"),
                origin: parent.map_or(ToolOrigin::Standalone, |(op, epoch)| ToolOrigin::HostSdk {
                    package_id: "maka_workspace_computer".into(),
                    entry_id: "maka_workspace_computer".into(),
                    activation: "host".into(),
                    parent: Some(HostSdkParent::EvaluationObserver {
                        operation_id: op.into(),
                        epoch: epoch.into(),
                    }),
                }),
            },
        },
    ))
    .unwrap()
}
async fn cell(log: &EventLog, invocation: &Invocation, id: &str) {
    log.append(&dispatch(invocation, id, None)).await.unwrap();
}
async fn settle(log: &EventLog, invocation: &Invocation, id: &str) {
    log.append(
        &EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ToolSettled {
                operation_id: id.into(),
                outcome: ToolOutcome::Failed {
                    message: "fixture known terminal native/tool result".into(),
                },
            },
        ))
        .unwrap(),
    )
    .await
    .unwrap();
}
fn observed(invocation: &Invocation, operation: &str, epoch: &str) -> NativeInterruption {
    NativeInterruption {
        opening: invocation.clone(),
        operation_id: operation.into(),
        native_epoch: epoch.into(),
        native_generation: "actual-fixture-native-generation".into(),
    }
}
async fn no_new_t1(log: &EventLog, invocation: &Invocation, operation: &str) {
    let prefix = log.prefix(100, 1024 * 1024).await.unwrap();
    assert_eq!(prefix.events.iter().filter(|row|row.event.invocation==*invocation
        && matches!(&row.event.fact,Fact::ToolDispatched{operation_id,..} if operation_id==operation)).count(),0,
        "native refusal must precede actual durable T1");
}
fn interrupted(error: CommitError) {
    assert!(matches!(error, CommitError::NativeTurnInterrupted));
}

struct NativeJournal {
    log: Arc<EventLog>,
    basis: PermissionBasis,
}
impl EventSink for NativeJournal {
    fn commit(self: Arc<Self>, event: EventWrite) -> CommitFuture {
        self.commit_with_prefix(&[], event)
    }

    fn commit_with_prefix(
        self: Arc<Self>,
        prefix: &[EventWrite],
        event: EventWrite,
    ) -> CommitFuture {
        let mut events = prefix.to_vec();
        events.push(event);
        Box::pin(async move {
            let (event, prefix) = events.split_last().expect("last event is present");
            if matches!(event.event().fact, Fact::ToolDispatched { .. }) {
                self.log
                    .append_native_computer_dispatch(prefix, event, &[target()], &self.basis)
                    .await
            } else {
                self.log
                    .append_batch(&events)
                    .await
                    .map(|sequences| *sequences.last().expect("last event has a sequence"))
            }
        })
    }
}

#[tokio::test]
async fn completed_source_idle_escape_survives_legal_b_then_a_new_vm_but_keeps_browser_and_fresh_turn()
 {
    let directory = tempfile::tempdir().unwrap();
    let log = Arc::new(
        EventLog::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap(),
    );
    let basis_a = session(&log, "session-a").await;
    let basis_b = session(&log, "session-b").await;
    let a = open("session-a", "turn-a");
    append(&log, &a).await;
    grant(&log, &a.invocation, basis_a, "grant-a").await;
    cell(&log, &a.invocation, "cell-a1").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(&a.invocation, "native-a1", Some(("cell-a1", "epoch-a1"))),
        &[target()],
        &basis_a,
    )
    .await
    .unwrap();
    settle(&log, &a.invocation, "native-a1").await;
    settle(&log, &a.invocation, "cell-a1").await;
    let b = open("session-b", "turn-b");
    append(&log, &b).await;
    grant(&log, &b.invocation, basis_b, "grant-b").await;
    cell(&log, &b.invocation, "cell-b").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(&b.invocation, "native-b", Some(("cell-b", "epoch-b"))),
        &[target()],
        &basis_b,
    )
    .await
    .unwrap();
    settle(&log, &b.invocation, "native-b").await;
    // The source call is already settled and a different session owns the real
    // native route. Its valid late event still belongs to A's logical Turn.
    let first = log
        .record_native_turn_interruption(observed(&a.invocation, "native-a1", "epoch-a1"))
        .await
        .unwrap();
    assert!(matches!(first, InterruptionCommit::Recorded { .. }));
    assert_eq!(
        log.record_native_turn_interruption(observed(&a.invocation, "native-a1", "epoch-a1"))
            .await
            .unwrap(),
        first
    );
    cell(&log, &a.invocation, "cell-a2").await;
    let attempted = Arc::new(AtomicUsize::new(0));
    let effect_attempted = attempted.clone();
    let Fact::ToolDispatched {
        call, name, input, ..
    } = dispatch(&a.invocation, "native-a2", Some(("cell-a2", "epoch-a2")))
        .event()
        .fact
        .clone()
    else {
        unreachable!()
    };
    let refusal = ToolJournal::new(
        Arc::new(NativeJournal {
            log: log.clone(),
            basis: basis_a,
        }),
        a.invocation.clone(),
    )
    .invoke_prepared_output(
        "native-a2".into(),
        call,
        name,
        input,
        None,
        CancellationToken::new(),
        PreparedEffect::new(move |_| {
            Box::pin(async move {
                effect_attempted.fetch_add(1, Ordering::SeqCst);
                Ok(ToolOutput::Json(json!({"shouldNotRun":true})).into())
            })
        }),
    )
    .await;
    assert!(
        matches!(refusal,Err(ToolError::Failed(reason)) if reason=="native Computer Use is stopped for this logical Turn"),
        "native stop is known before effect, not a Persistence error that retires the Computer service"
    );
    assert_eq!(
        attempted.load(Ordering::SeqCst),
        0,
        "original prepared native effect never ran"
    );
    no_new_t1(&log, &a.invocation, "native-a2").await;
    // Browser remains a real admitted operation under the unchanged CU grant.
    log.append_capability_dispatch(
        &[],
        &dispatch(&a.invocation, "browser-a", Some(("cell-a2", "epoch-a2"))),
        &[target()],
        &basis_a,
    )
    .await
    .unwrap();
    settle(&log, &a.invocation, "browser-a").await;
    settle(&log, &a.invocation, "cell-a2").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(&b.invocation, "native-b2", Some(("cell-b", "epoch-b"))),
        &[target()],
        &basis_b,
    )
    .await
    .unwrap();
    settle(&log, &b.invocation, "native-b2").await;
    settle(&log, &b.invocation, "cell-b").await;
    close(&log, &a).await;
    let fresh = open("session-a", "turn-fresh");
    append(&log, &fresh).await;
    cell(&log, &fresh.invocation, "cell-fresh").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(
            &fresh.invocation,
            "native-fresh",
            Some(("cell-fresh", "epoch-fresh")),
        ),
        &[target()],
        &basis_a,
    )
    .await
    .unwrap();
    settle(&log, &fresh.invocation, "native-fresh").await;
    settle(&log, &fresh.invocation, "cell-fresh").await;
    Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
}

fn pause(source: &Invocation) -> HandoffPause {
    HandoffPause {
        intent: HandoffIntent {
            handoff_id: "handoff".into(),
            host_epoch: "old-host".into(),
            root_run_id: source.run_id.clone(),
            successor_run_id: "run-successor".into(),
            successor_invocation_id: "invocation-successor".into(),
            claim_id: "claim-successor".into(),
        },
        execution: Box::new(HandoffExecution {
            replay: ReplayEvidence {
                version: REPLAY_VERSION,
                digest: digest('a'),
                route_identity: digest('b'),
            },
            context: None,
            provider_options: json!({}),
            main_output_limit: None,
            supports_vision: false,
            tools: HandoffTools {
                catalog_digest: digest('c'),
                loaded: Default::default(),
            },
            compaction: CompactionBudget::Available,
            replay_base: None,
        }),
    }
}
#[tokio::test]
async fn late_source_event_after_real_handoff_pause_reopen_fences_its_same_turn_successor() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let basis = session(&log, "session").await;
    let source = opening("root", None);
    append(&log, &source).await;
    grant(&log, &source.invocation, basis, "grant").await;
    let context = log
        .context_before_run(&source.invocation, 100, 65536)
        .await
        .unwrap();
    let base = SessionBase {
        high_water: context.source_evidence.high_water,
        digest: context.source_evidence.digest,
    };
    cell(&log, &source.invocation, "cell").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(
            &source.invocation,
            "native",
            Some(("cell", "retired-epoch")),
        ),
        &[target()],
        &basis,
    )
    .await
    .unwrap();
    let native_unknown = RuntimeEvent::new(
        source.invocation.clone(),
        Fact::ToolSettled {
            operation_id: "native".into(),
            outcome: ToolOutcome::Unknown {
                message: "accepted native action was interrupted; its effect remains unknown"
                    .into(),
                operation: None,
            },
        },
    );
    append(&log, &native_unknown).await;
    settle(&log, &source.invocation, "cell").await;
    let pause = pause(&source.invocation);
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
    assert!(
        matches!(
            log.record_native_turn_interruption(observed(
                &source.invocation,
                "native",
                "retired-epoch"
            ))
            .await
            .unwrap(),
            InterruptionCommit::Recorded { .. }
        ),
        "an already sent native event is not discarded because its physical Run sealed"
    );
    log.close().await.unwrap();
    let log = EventLog::open(&path).await.unwrap();
    assert_eq!(
        maka_event_log::recovery::recover_invocations(&log)
            .await
            .unwrap(),
        0
    );
    let after_reopen = log.prefix(100, 1024 * 1024).await.unwrap();
    let retained = after_reopen
        .events
        .iter()
        .find(|row| row.event.id == native_unknown.id)
        .unwrap();
    assert_eq!(
        retained.event, native_unknown,
        "interruption/cleanup facts never rewrite the admitted action's original Unknown T2"
    );
    let inherited = claim(&log, &pause.intent.claim_id, &source, base).await;
    let Fact::InvocationOpened { configuration, .. } = &source.fact else {
        unreachable!()
    };
    let successor = RuntimeEvent::new(
        pause.intent.successor(&source.invocation),
        Fact::InvocationOpened {
            configuration: configuration.clone(),
            input: InvocationInput::Handoff {
                claim: Box::new(inherited),
                pause: Box::new(pause),
            },
        },
    );
    append(&log, &successor).await;
    assert_eq!(successor.invocation.turn_id, source.invocation.turn_id);
    cell(&log, &successor.invocation, "successor-cell").await;
    interrupted(
        log.append_native_computer_dispatch(
            &[],
            &dispatch(
                &successor.invocation,
                "successor-native",
                Some(("successor-cell", "fresh-host-epoch")),
            ),
            &[target()],
            &basis,
        )
        .await
        .unwrap_err(),
    );
    no_new_t1(&log, &successor.invocation, "successor-native").await;
    log.append_capability_dispatch(
        &[],
        &dispatch(
            &successor.invocation,
            "successor-browser",
            Some(("successor-cell", "fresh-host-epoch")),
        ),
        &[target()],
        &basis,
    )
    .await
    .unwrap();
    settle(&log, &successor.invocation, "successor-browser").await;
    settle(&log, &successor.invocation, "successor-cell").await;
    log.close().await.unwrap();
}

#[tokio::test]
async fn forged_binding_and_terminal_old_turn_cannot_poison_another_live_turn() {
    let directory = tempfile::tempdir().unwrap();
    let log = EventLog::open(&directory.path().join("events.sqlite"))
        .await
        .unwrap();
    let basis = session(&log, "session").await;
    let a = opening("a", None);
    append(&log, &a).await;
    grant(&log, &a.invocation, basis, "grant").await;
    cell(&log, &a.invocation, "cell-a").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(&a.invocation, "native-a", Some(("cell-a", "epoch-a"))),
        &[target()],
        &basis,
    )
    .await
    .unwrap();
    settle(&log, &a.invocation, "native-a").await;
    settle(&log, &a.invocation, "cell-a").await;
    for mutation in 0..4 {
        let mut forged = observed(&a.invocation, "native-a", "epoch-a");
        match mutation {
            0 => forged.native_epoch = "wrong-epoch".into(),
            1 => forged.opening.turn_id = "b".into(),
            2 => forged.opening.session_id = "other".into(),
            _ => forged.operation_id = "unissued-operation".into(),
        }
        assert!(matches!(
            log.record_native_turn_interruption(forged).await,
            Err(StoreError::InvalidTransition(_))
        ));
    }
    close(&log, &a).await;
    let b = opening("b", None);
    append(&log, &b).await;
    assert_eq!(
        log.record_native_turn_interruption(observed(&a.invocation, "native-a", "epoch-a"))
            .await
            .unwrap(),
        InterruptionCommit::Superseded
    );
    cell(&log, &b.invocation, "cell-b").await;
    log.append_native_computer_dispatch(
        &[],
        &dispatch(&b.invocation, "native-b", Some(("cell-b", "epoch-b"))),
        &[target()],
        &basis,
    )
    .await
    .unwrap();
    settle(&log, &b.invocation, "native-b").await;
    settle(&log, &b.invocation, "cell-b").await;
    log.close().await.unwrap();
}
