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

use crate::support::{
    canonical::{self, NoEffects, OriginalReceipts, admitted_model, append, finished_model},
    native::NativeFixture,
};
use maka_agent_engine::{DriverExit, Engine};
use maka_agent_facts::{
    durable::*,
    model::{ModelPart, ModelToolCall},
    tool_call::ToolRejection,
};
use maka_agent_state::{Admission, Change, ContentBlob};
use maka_event_log::{
    applications::operations::{Dispatch, OperationRequest},
    root::ROOT_DATABASE,
};
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt},
};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const NOW: UnixMillis = UnixMillis(1_000);

fn contract() -> Contract {
    Contract {
        name: "startup.effects".into(),
        version: 1,
        transport: Transport::Local,
        interface: Interface::Service {
            methods: BTreeMap::from([(
                "read".into(),
                Method {
                    mode: MethodMode::Mutation,
                    input: json!({}).into(),
                    output: json!({}).into(),
                    progress: None,
                    resources: BTreeMap::new(),
                },
            )]),
        },
    }
}

// A real original-Root provider ingress, as in State's composition tests. The
// claim is live Root authority; no RecoveryRef or RunSpec grants dispatch.
async fn provider(
    fixture: &NativeFixture,
    outcome: OperationOutcome,
    attempts: &AtomicUsize,
) -> (OperationRequest, OperationReply) {
    let request = OperationRequest {
        source: fixture.app.source().unwrap().clone(),
        namespace: InstanceId(vec![Uuid::from_u128(3)]),
        consumer: InstanceId(vec![Uuid::from_u128(2)]),
        export: "effects".into(),
        method: "read".into(),
        contract: contract(),
        operation: Uuid::new_v4(),
        input: json!({"path": "effect.txt"}),
        capture: None,
        origin: json!({"kind": "startup_boundary_fixture"}),
    };
    let operation = fixture
        .root
        .operation(&request.reference().unwrap())
        .unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request.clone()).await.unwrap() else {
        panic!("an original provider ingress must receive one live claim");
    };
    operation.start_operation(&claim).unwrap();
    attempts.fetch_add(1, Ordering::SeqCst);
    operation
        .record_operation_outcome(&claim, outcome)
        .await
        .unwrap();
    let observed = operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    let reply = OperationReply {
        reference: observed.reference,
        receipt: Receipt::Recorded {
            outcome: observed.outcome,
            cleanup: observed.cleanup,
        },
    };
    (request, reply)
}

async fn call(
    fixture: &NativeFixture,
    link: AgentStepLink,
    reply: Option<&OperationReply>,
) -> ToolKey {
    let tool = ToolKey {
        attempt: link.attempt,
        call: format!("call:{}", link.attempt),
    };
    let input = ContentBlob::json(&json!({"path": "effect.txt"})).unwrap();
    let mut changes = vec![Change::new(
        Fact::ModelObserved {
            attempt: link.attempt,
            index: 0,
            continuation: None,
            part: ModelPart::ToolCall {
                call: ModelToolCall {
                    id: tool.call.clone(),
                    name: "Read".into(),
                    input: json!({"path": "effect.txt"}).into(),
                    provider_options: None,
                    provider_executed: false,
                },
            },
        },
        NOW,
    )];
    if let Some(reply) = reply {
        changes.extend([
            Change::new(
                Fact::ToolDecided {
                    tool: tool.clone(),
                    decision: ToolDecision::Approved {
                        semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                        input: input.reference().clone(),
                        resources: vec![],
                        approval: None,
                        display: Default::default(),
                    },
                },
                NOW,
            ),
            Change::new(Fact::ToolAdmitted { tool: tool.clone() }, NOW),
            Change::new(
                Fact::ToolOriginalBound {
                    tool: tool.clone(),
                    reference: reply.reference.clone(),
                },
                NOW,
            ),
            Change::new(
                Fact::OperationObserved {
                    tool: tool.clone(),
                    reply: reply.clone(),
                },
                NOW,
            ),
        ]);
    }
    append(&fixture.state, link.run, changes, vec![input])
        .await
        .unwrap();
    tool
}

async fn stop(fixture: &NativeFixture, run: RunId) -> Change {
    let change = Change::new(
        Fact::StopRequested {
            diagnostic: "explicit recovery drain".into(),
        },
        NOW,
    );
    let view = fixture.state.frontier(run).await.unwrap();
    fixture
        .state
        .control(run, (&view).into(), vec![change.clone()], vec![])
        .await
        .unwrap();
    change
}

async fn drive(fixture: &NativeFixture, run: RunId) -> DriverExit {
    Engine::new(fixture.state.clone())
        .drive(
            fixture.state.claim(run).await.unwrap(),
            Arc::new(OriginalReceipts {
                clock: NoEffects(NOW),
                root: fixture.root.clone(),
            }),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

#[derive(Debug, PartialEq)]
struct Database {
    application: i64,
    migrations: Vec<(i64, Vec<u8>)>,
    payload: Option<Vec<u8>>,
    runs: i64,
    obsolete_transcripts: i64,
    foreign_keys: i64,
}

async fn database(path: PathBuf, digest: Option<String>) -> Database {
    tokio::task::spawn_blocking(move || {
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        Database {
            application: connection.query_row("PRAGMA application_id", [], |row| row.get(0)).unwrap(),
            migrations: connection.prepare("SELECT version,checksum FROM _sqlx_migrations WHERE success=1 ORDER BY version")
                .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
                .collect::<Result<_, _>>().unwrap(),
            payload: digest.map(|digest| connection.query_row("SELECT payload FROM contents WHERE content_sha256=?", [digest], |row| row.get(0)).unwrap()),
            runs: connection.query_row("SELECT count(*) FROM agent_run_specs", [], |row| row.get(0)).unwrap(),
            obsolete_transcripts: connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('transcript_rows','transcript_text')", [], |row| row.get(0)).unwrap(),
            foreign_keys: connection.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| row.get(0)).unwrap(),
        }
    }).await.unwrap()
}

fn path(directory: &Path) -> PathBuf {
    directory.join("root").join(ROOT_DATABASE)
}

#[tokio::test]
async fn initialization_and_reopen_preserve_facts_payloads_and_schema_identity() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = NativeFixture::open(directory.path(), canonical::configuration())
        .await
        .unwrap();
    fixture
        .root
        .create_session("session", "request", &json!({"name": "kept"}), 10)
        .await
        .unwrap();
    let (spec, contents) = canonical::spec(&fixture, directory.path(), "session", "turn", "kept");
    let owner = spec.owner.clone();
    let admission = Admission::new(spec, NOW, contents);
    let run = admission.run();
    fixture.state.admit(admission.clone()).await.unwrap();
    let model = admitted_model(&fixture.state, run, NOW).await;
    let effects = AtomicUsize::new(0);
    let (request, reply) = provider(
        &fixture,
        OperationOutcome::Returned {
            result: OperationResult::Success {
                value: json!({"text": "persistent output"}),
            },
        },
        &effects,
    )
    .await;
    let tool = call(&fixture, model, Some(&reply)).await;
    append(&fixture.state, run, finished_model(model, NOW), vec![])
        .await
        .unwrap();
    stop(&fixture, run).await;
    assert!(matches!(
        drive(&fixture, run).await,
        DriverExit::Terminal {
            terminal: Terminal::Cancelled,
            ..
        }
    ));
    let facts = fixture.state.history(run, 0, 128).await.unwrap();
    let result = facts
        .iter()
        .find_map(|fact| match &fact.fact {
            Fact::ToolResultAccepted {
                tool: accepted,
                result,
                ..
            } if *accepted == tool => Some(result.clone()),
            _ => None,
        })
        .unwrap();
    let payload = fixture.state.content(run, result.clone()).await.unwrap();
    assert!(
        std::str::from_utf8(&payload)
            .unwrap()
            .contains("persistent output")
    );
    let view = fixture.state.frontier(run).await.unwrap();
    let source = fixture.app.source().unwrap().clone();
    fixture.shutdown().await.unwrap();
    let before = database(path(directory.path()), Some(result.digest.clone())).await;
    assert!(!before.migrations.is_empty());
    assert_eq!(before.payload.as_deref(), Some(payload.as_slice()));
    assert_eq!(before.obsolete_transcripts, 0);

    let fixture = NativeFixture::open(directory.path(), canonical::configuration())
        .await
        .unwrap();
    assert_eq!(fixture.app.source(), Some(&source));
    assert_eq!(fixture.state.history(run, 0, 128).await.unwrap(), facts);
    assert_eq!(fixture.state.frontier(run).await.unwrap().spec, view.spec);
    assert_eq!(
        fixture.state.content(run, result.clone()).await.unwrap(),
        payload
    );
    assert!(fixture.state.admission_recorded(&admission).await.unwrap());
    let history = fixture.state.session_history(owner, "session".into());
    let cut = history.capture().await.unwrap();
    assert!(
        !history.page(&cut, 0, 256).await.unwrap().items.is_empty(),
        "public history is reconstructed from canonical Agent facts"
    );
    let session = fixture
        .root
        .session("session")
        .await
        .unwrap()
        .get::<Value>()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.configuration, json!({"name": "kept"}));
    let operation = fixture.root.operation(&reply.reference).unwrap();
    assert!(
        !matches!(
            operation.dispatch_operation(request).await.unwrap(),
            Dispatch::New(_)
        ),
        "exact provider identity is never dispatched again after reopen"
    );
    assert_eq!(effects.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.state.admit(admission).await.unwrap().facts[0],
        facts[0]
    );
    drop((history, operation));
    fixture.shutdown().await.unwrap();
    let after = database(path(directory.path()), Some(result.digest)).await;
    assert_eq!(after, before);
    assert_eq!(after.foreign_keys, 0);
}

#[tokio::test]
async fn startup_recovers_model_and_call_cuts_across_multiple_pages_in_opening_order() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = NativeFixture::open(directory.path(), canonical::configuration())
        .await
        .unwrap();
    let effects = AtomicUsize::new(0);
    let mut admissions = vec![];
    let mut tools = vec![];
    let mut replies = vec![];
    let mut owner = None;
    for n in 0..257 {
        let session = format!("s-{n}");
        fixture
            .root
            .create_session(&session, &session, &json!({"index": n}), 1)
            .await
            .unwrap();
        let (spec, contents) = canonical::spec(
            &fixture,
            directory.path(),
            &session,
            &format!("t-{n}"),
            "recover",
        );
        owner = Some(spec.owner.clone());
        let admission = Admission::new(spec, NOW, contents);
        let run = admission.run();
        fixture.state.admit(admission.clone()).await.unwrap();
        if n < 4 {
            let link = admitted_model(&fixture.state, run, NOW).await;
            if n > 0 {
                let reply = if n > 1 {
                    let outcome = if n == 2 {
                        OperationOutcome::Unknown {
                            diagnostic: "original provider outcome remains unknown".into(),
                        }
                    } else {
                        OperationOutcome::Returned {
                            result: OperationResult::Failure {
                                diagnostic: "known failure".into(),
                            },
                        }
                    };
                    Some(provider(&fixture, outcome, &effects).await.1)
                } else {
                    None
                };
                tools.push((n, call(&fixture, link, reply.as_ref()).await));
                if let Some(reply) = reply {
                    replies.push((n, reply));
                }
            }
            append(
                &fixture.state,
                run,
                vec![Change::new(
                    Fact::ModelCleanupObserved {
                        attempt: link.attempt,
                        cleanup: OperationCleanup::Confirmed,
                    },
                    NOW,
                )],
                vec![],
            )
            .await
            .unwrap();
        }
        admissions.push(admission);
    }
    let unknown_run = admissions[2].run();
    let unknown_facts = fixture.state.history(unknown_run, 0, 128).await.unwrap();
    let original_unknown = unknown_facts
        .iter()
        .find(|record| {
            matches!(
                &record.fact,
                Fact::OperationObserved {
                    reply: OperationReply {
                        receipt: Receipt::Recorded {
                            outcome: OperationOutcome::Unknown { .. },
                            ..
                        },
                        ..
                    },
                    ..
                }
            )
        })
        .unwrap()
        .clone();
    let unknown_bytes = serde_json::to_vec(&original_unknown).unwrap();
    let Fact::OperationObserved {
        tool: unknown_tool, ..
    } = &original_unknown.fact
    else {
        unreachable!()
    };
    let original_input = unknown_facts
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ToolDecided {
                tool,
                decision: ToolDecision::Approved { input, .. },
            } if tool == unknown_tool => Some(input.clone()),
            _ => None,
        })
        .unwrap();
    let input_bytes = fixture
        .state
        .content(unknown_run, original_input.clone())
        .await
        .unwrap();
    let owner = owner.unwrap();
    fixture.shutdown().await.unwrap();

    let fixture = NativeFixture::open(directory.path(), canonical::configuration())
        .await
        .unwrap();
    let retained_unknown = fixture
        .state
        .fact_barrier(unknown_run, original_unknown.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retained_unknown, original_unknown);
    assert_eq!(
        serde_json::to_vec(&retained_unknown).unwrap(),
        unknown_bytes
    );
    assert_eq!(
        fixture
            .state
            .content(unknown_run, original_input.clone())
            .await
            .unwrap(),
        input_bytes
    );
    let first = fixture
        .state
        .ready_runs(owner.clone(), NOW, None, 256)
        .await
        .unwrap();
    assert_eq!(first.len(), 256);
    let second = fixture
        .state
        .ready_runs(
            owner.clone(),
            NOW,
            Some(first.last().unwrap().admission_sequence),
            256,
        )
        .await
        .unwrap();
    assert_eq!(second.len(), 1);
    assert!(
        fixture
            .state
            .ready_runs(owner.clone(), NOW, Some(second[0].admission_sequence), 256)
            .await
            .unwrap()
            .is_empty()
    );
    let ordered: Vec<_> = first.iter().chain(&second).map(|ready| ready.run).collect();
    assert_eq!(
        ordered,
        admissions.iter().map(Admission::run).collect::<Vec<_>>(),
        "recovery discovery uses original opening order across every page"
    );
    assert_eq!(effects.load(Ordering::SeqCst), 2);

    // Startup no longer fails logical Runs just because physical ownership
    // changed. Retiring a physical activation preserves its exact admission.
    for run in ordered.iter().skip(4) {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(Engine::new(fixture.state.clone()).drive(
            fixture.state.claim(*run).await.unwrap(), Arc::new(NoEffects(NOW)), cancellation,
        ).await.unwrap(), DriverExit::Retired { run: actual } if actual == *run));
        assert_eq!(fixture.state.history(*run, 0, 8).await.unwrap().len(), 1);
    }
    let mut settled = vec![];
    for (n, admission) in admissions.iter().enumerate() {
        let run = admission.run();
        let control = stop(&fixture, run).await;
        let exit = drive(&fixture, run).await;
        if n == 2 {
            let DriverExit::Blocked { blockers, .. } = exit else {
                panic!("original Unknown T2 must remain an explicit obligation")
            };
            let blocker = blockers
                .iter()
                .find_map(|(id, reason)| {
                    matches!(reason, BlockerKind::OperationUnknown { .. }).then_some(*id)
                })
                .unwrap();
            let view = fixture.state.frontier(run).await.unwrap();
            let decision = RiskDecision::CancelBlockedRun {
                diagnostic: "explicit user accepts unknown effect while cancelling".into(),
            };
            let scope = maka_agent_engine::risk_action_scope(&view, blocker, &decision).unwrap();
            fixture
                .state
                .control(
                    run,
                    (&view).into(),
                    vec![Change::new(
                        Fact::RiskAdjudicated {
                            blocker,
                            decision,
                            scope,
                        },
                        NOW,
                    )],
                    vec![],
                )
                .await
                .unwrap();
            assert!(matches!(
                drive(&fixture, run).await,
                DriverExit::Terminal {
                    terminal: Terminal::Cancelled,
                    ..
                }
            ));
        } else {
            assert!(matches!(
                exit,
                DriverExit::Terminal {
                    terminal: Terminal::Cancelled,
                    ..
                }
            ));
        }
        let view = fixture.state.frontier(run).await.unwrap();
        let before = view.revision;
        fixture
            .state
            .control(run, (&view).into(), vec![control], vec![])
            .await
            .unwrap();
        assert_eq!(
            fixture.state.frontier(run).await.unwrap().revision,
            before,
            "re-observation never re-runs startup recovery"
        );
        assert!(fixture.state.admission_recorded(admission).await.unwrap());
        settled.push(run);
    }
    assert_eq!(settled, ordered);
    for n in 0..4 {
        let run = admissions[n].run();
        let facts = fixture.state.history(run, 0, 128).await.unwrap();
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(f.fact, Fact::ModelInterrupted { .. }))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(
                    &f.fact,
                    Fact::ToolDecided {
                        decision: ToolDecision::Rejected {
                            rejection: ToolRejection::Cancelled,
                            ..
                        },
                        ..
                    }
                ))
                .count(),
            usize::from(n == 1)
        );
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(f.fact, Fact::ToolAdmitted { .. }))
                .count(),
            usize::from(n > 1)
        );
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(
                    &f.fact,
                    Fact::OperationObserved {
                        reply: OperationReply {
                            receipt: Receipt::Recorded {
                                outcome: OperationOutcome::Returned { .. },
                                ..
                            },
                            ..
                        },
                        ..
                    }
                ))
                .count(),
            usize::from(n == 3)
        );
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(f.fact, Fact::RunAdmitted { .. }))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|f| matches!(f.fact, Fact::RunTerminated { .. }))
                .count(),
            1
        );
        if let Some((_, reply)) = replies.iter().find(|(index, _)| *index == n) {
            let observation = fixture
                .root
                .operation(&reply.reference)
                .unwrap()
                .operation_observation()
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                observation.outcome,
                match &reply.receipt {
                    Receipt::Recorded { outcome, .. } => outcome.clone(),
                    _ => unreachable!(),
                }
            );
            if n == 2 {
                assert!(
                    matches!(observation.outcome, OperationOutcome::Unknown { .. }),
                    "cleanup and explicit risk cancellation never rewrite original Unknown T2"
                );
                let retained_unknown = fixture
                    .state
                    .fact_barrier(run, original_unknown.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(retained_unknown, original_unknown);
                assert_eq!(
                    serde_json::to_vec(&retained_unknown).unwrap(),
                    unknown_bytes
                );
                assert_eq!(
                    fixture
                        .state
                        .content(run, original_input.clone())
                        .await
                        .unwrap(),
                    input_bytes
                );
            }
        }
    }
    assert_eq!(
        effects.load(Ordering::SeqCst),
        2,
        "startup observes originals; it never dispatches either Host effect again"
    );
    assert!(
        fixture
            .state
            .ready_runs(owner, NOW, None, 256)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(tools.len(), 3);
    fixture.shutdown().await.unwrap();
    assert_eq!(database(path(directory.path()), None).await.runs, 257);
}
