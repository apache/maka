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

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use maka_event_log::EventLog;
use maka_js_runtime::{CellLimits, CodeExecutor};
use maka_runtime::event::{
    CommitError, CommitFuture, EventSink, EventWrite, Fact, Invocation, InvocationInput, LogScope,
    RuntimeEvent,
};
use maka_runtime::model::{ModelFinishReason, ModelPart, ModelStep, ModelToolCall};
use maka_runtime::tool_call::ToolOrigin;
use maka_runtime::tools::{ToolError, ToolExecutor, ToolFuture};
use maka_tools::{
    RunTools, ToolCatalog, ToolDefinition, ToolHandler, ToolMode, ToolNesting, ToolRegistration,
    ToolSemantics,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const PARENT: &str = "step:parent";

#[derive(Clone, Copy)]
enum Boundary {
    ChildDispatch,
    ChildSettlement,
    Notification,
}

struct FaultSink {
    log: Arc<EventLog>,
    boundary: Boundary,
    attempts: Mutex<Vec<RuntimeEvent>>,
    faults: AtomicUsize,
}

impl EventSink for FaultSink {
    fn commit(self: Arc<Self>, write: EventWrite) -> CommitFuture {
        Box::pin(async move {
            let event = write.event();
            self.attempts.lock().unwrap().push(event.clone());
            let fail = match (&self.boundary, &event.fact) {
                (Boundary::Notification, Fact::ToolNotified { .. }) => true,
                (Boundary::ChildDispatch, Fact::ToolDispatched { call, .. }) => {
                    matches!(call.origin, ToolOrigin::CodeMode { .. })
                }
                (Boundary::ChildSettlement, Fact::ToolSettled { operation_id, .. }) => {
                    operation_id != PARENT
                }
                _ => false,
            };
            if fail {
                self.faults.fetch_add(1, Ordering::SeqCst);
                return Err(match self.boundary {
                    Boundary::ChildDispatch => CommitError::Rejected("injected child T1".into()),
                    Boundary::ChildSettlement => {
                        CommitError::OutcomeUnknown("injected child T2".into())
                    }
                    Boundary::Notification => {
                        CommitError::OutcomeUnknown("injected notification commit".into())
                    }
                });
            }
            self.log.clone().commit(write).await
        })
    }
}

struct Effect {
    calls: Arc<AtomicUsize>,
    log: Arc<EventLog>,
}

impl ToolExecutor for Effect {
    fn names(&self) -> Vec<String> {
        vec!["effect".into()]
    }

    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let log = self.log.clone();
        let calls = self.calls.clone();
        Box::pin(async move {
            // The real effect is admitted only after its own durable T1.
            let prefix = log.prefix(32, 64 * 1024).await.unwrap();
            assert!(matches!(prefix.events.last().unwrap().event.fact,
            Fact::ToolDispatched { ref call, .. }
            if matches!(call.origin, ToolOrigin::CodeMode { .. })));
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(input)
        })
    }
}

fn catalog(log: Arc<EventLog>, calls: Arc<AtomicUsize>) -> ToolCatalog {
    ToolCatalog::new([ToolRegistration {
        definition: ToolDefinition {
            freeform: None,
            output_schema: None,
            provider: None,
            name: "effect".into(),
            description: "count one effect".into(),
            input_schema: json!({"type":"object"}),
        },
        handler: ToolHandler::Immediate(Arc::new(Effect { calls, log })),
        nesting: ToolNesting::Nestable,
        semantics: ToolSemantics::Parallel,
    }])
    .unwrap()
}

async fn seed(log: &EventLog, invocation: &Invocation, call: &ModelToolCall) {
    let append = async |fact| {
        log.append(&EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)).unwrap())
            .await
            .unwrap()
    };
    append(Fact::InvocationOpened {
        configuration: None,
        input: InvocationInput::Message {
            source_messages: Vec::new(),
            content: "execute the fixture".into(),
            request_fingerprint: None,
        },
    })
    .await;
    let prefix = log
        .scoped_prefix(
            LogScope::Session {
                id: invocation.session_id.clone(),
            },
            32,
            64 * 1024,
        )
        .await
        .unwrap();
    append(Fact::ModelRequested {
        effective_source_digest: None,
        step_id: "step".into(),
        model_id: "fixture".into(),
        source_scope: prefix.scope,
        source_high_water: prefix.high_water,
        source_digest: prefix.digest,
        input_digest: "fixture".into(),
        route_identity: "fixture".into(),
        checkpoint_event_id: None,
        purpose: maka_runtime::context::ModelPurpose::Main,
        context: None,
    })
    .await;
    append(Fact::ModelCompleted {
        step_id: "step".into(),
        output: ModelStep {
            parts: vec![ModelPart::ToolCall { call: call.clone() }],
            finish_reason: ModelFinishReason::ToolCalls,
            usage: Default::default(),
            provider_options: None,
            response_id: None,
            model: None,
            timestamp: None,
        },
    })
    .await;
}

async fn check_boundary(boundary: Boundary) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("events.sqlite");
    let invocation = Invocation {
        session_id: "session".into(),
        turn_id: "turn".into(),
        run_id: "run".into(),
        invocation_id: "invocation".into(),
    };
    let call = ModelToolCall {
        id: "parent".into(),
        name: "exec".into(),
        input: json!({"code": "try { await tools.effect({}); } catch (_) {} text('caught');"}),
        provider_options: None,
        provider_executed: false,
    };
    let effects = Arc::new(AtomicUsize::new(0));
    let expected_effects = usize::from(matches!(boundary, Boundary::ChildSettlement));
    let (digest, high_water, mut uncertain) = {
        let log = Arc::new(EventLog::open(&path).await.unwrap());
        seed(&log, &invocation, &call).await;
        let sink = Arc::new(FaultSink {
            log: log.clone(),
            boundary,
            attempts: Mutex::new(Vec::new()),
            faults: AtomicUsize::new(0),
        });
        let run = RunTools::new(
            sink.clone(),
            invocation.clone(),
            catalog(log.clone(), effects.clone()),
            ToolMode::CodeMode,
            CodeExecutor::new(1, CellLimits::default()).unwrap(),
        );
        let result = run
            .capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step("step")
            .invoke(&call, CancellationToken::new())
            .await;
        assert!(matches!(
            run.shutdown().await,
            Err(ToolError::Persistence(_))
        ));
        match boundary {
            Boundary::Notification => unreachable!("separate notification case"),
            Boundary::ChildDispatch => assert!(matches!(result, Err(ToolError::Persistence(_)))),
            Boundary::ChildSettlement => {
                assert!(matches!(result, Err(ToolError::Persistence(_))))
            }
        }
        assert_eq!(sink.faults.load(Ordering::SeqCst), 1);
        assert_eq!(effects.load(Ordering::SeqCst), expected_effects);
        let child = {
            let attempts = sink.attempts.lock().unwrap();
            assert!(
                !attempts.iter().any(|event| matches!(&event.fact,
            Fact::ToolSettled { operation_id, .. } if operation_id == PARENT)),
                "JS catch must not even attempt parent T2 after a fatal child commit error"
            );
            attempts
                .iter()
                .find_map(|event| match &event.fact {
                    Fact::ToolDispatched {
                        operation_id, call, ..
                    } if matches!(call.origin, ToolOrigin::CodeMode { .. }) => {
                        let ToolOrigin::CodeMode { parent_operation_id, .. } = &call.origin else { unreachable!() };
                        assert!(attempts.iter().any(|event| matches!(&event.fact,
                            Fact::ToolDispatched {operation_id,call,..} if operation_id==parent_operation_id
                                && matches!(&call.origin,ToolOrigin::CodeCell {parent_operation_id,..} if parent_operation_id==PARENT))));
                        Some(operation_id.clone())
                    }
                    _ => None,
                })
                .expect("real JS invoked the child")
        };
        let prefix = log.prefix(32, 64 * 1024).await.unwrap();
        assert_eq!(prefix.events.len(), 5 + expected_effects);
        assert!(
            !prefix
                .events
                .iter()
                .any(|stored| matches!(stored.event.fact, Fact::ToolSettled { .. }))
        );
        let mut uncertain = vec![PARENT.to_string()];
        uncertain.extend(
            prefix
                .events
                .iter()
                .filter_map(|event| match &event.event.fact {
                    Fact::ToolDispatched {
                        operation_id, call, ..
                    } if matches!(call.origin, ToolOrigin::CodeCell { .. }) => {
                        Some(operation_id.clone())
                    }
                    _ => None,
                }),
        );
        if expected_effects == 1 {
            uncertain.push(child);
        }
        drop(run);
        drop(sink);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        (prefix.digest, prefix.high_water, uncertain)
    };
    uncertain.sort();
    // Reopen the actual database with no fault injector. Recovery evidence must
    // retain every unresolved dispatch, including the parent when child T1 failed.
    let log = Arc::new(EventLog::open(&path).await.unwrap());
    let recovery = log
        .invocation_recovery(&invocation, 32, 64 * 1024)
        .await
        .unwrap();
    let mut pending = recovery.uncertain_operations;
    pending.sort();
    assert_eq!(pending, uncertain);
    assert!(recovery.undispatched_calls.is_empty());
    assert_eq!(
        log.unfinished_invocations(32).await.unwrap(),
        std::slice::from_ref(&invocation)
    );
    let prefix = log.prefix(32, 64 * 1024).await.unwrap();
    assert_eq!(prefix.digest, digest);
    assert_eq!(prefix.high_water, high_water);
    assert_eq!(prefix.project_invocation("invocation").terminal, None);

    // Even explicitly retrying the same accepted provider call cannot replay
    // the cell or its effect: storage refuses a second parent dispatch first.
    let run = RunTools::new(
        log.clone(),
        invocation,
        catalog(log.clone(), effects.clone()),
        ToolMode::CodeMode,
        CodeExecutor::new(1, CellLimits::default()).unwrap(),
    );
    assert!(matches!(
        run.capture(".", tokio_util::sync::CancellationToken::new())
            .await
            .unwrap()
            .into_step("step")
            .invoke(&call, CancellationToken::new())
            .await,
        Err(ToolError::Persistence(_))
    ));
    assert_eq!(effects.load(Ordering::SeqCst), expected_effects);
    assert_eq!(log.prefix(32, 64 * 1024).await.unwrap().digest, digest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn notification_commit_failure_cancels_the_cell_without_fabricating_success() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let directory = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::open(&directory.path().join("events.sqlite")).await.unwrap());
        let invocation = Invocation { session_id:"session".into(), turn_id:"turn".into(), run_id:"run".into(), invocation_id:"invocation".into() };
        let call = ModelToolCall { id:"parent".into(), name:"exec".into(), input:json!({"code":"notify('progress'); await new Promise(resolve => setTimeout(resolve, 60000));"}), provider_options:None, provider_executed:false };
        seed(&log, &invocation, &call).await;
        let sink = Arc::new(FaultSink { log:log.clone(), boundary:Boundary::Notification, attempts:Mutex::new(Vec::new()), faults:AtomicUsize::new(0) });
        let run = RunTools::new(sink.clone(), invocation, ToolCatalog::default(), ToolMode::CodeMode, CodeExecutor::new(1, CellLimits::default()).unwrap());
        let result = run.capture(".", CancellationToken::new()).await.unwrap().into_step("step").invoke(&call, CancellationToken::new()).await;
        assert!(matches!(result, Err(ToolError::Persistence(_))));
        assert!(matches!(run.shutdown().await, Err(ToolError::Persistence(_))));
        assert_eq!(sink.faults.load(Ordering::SeqCst), 1);
        assert!(!log.prefix(32, 64*1024).await.unwrap().events.iter().any(|event| matches!(event.event.fact, Fact::ToolSettled { .. } | Fact::ToolNotified { .. })));
        drop(run); drop(sink); Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
    }).await.expect("notification persistence failure must drain");
}

#[tokio::test]
async fn rejected_child_t1_runs_no_effect_and_js_catch_cannot_settle_parent() {
    check_boundary(Boundary::ChildDispatch).await;
}

#[tokio::test]
async fn uncertain_child_t2_preserves_effect_and_js_catch_cannot_settle_parent() {
    check_boundary(Boundary::ChildSettlement).await;
}
