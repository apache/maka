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

//! Canonical execution scope and journal behavior, not SDK producer capability authenticity.
mod support;

use maka_agent_facts::{
    accounting::Outcome,
    artifact::ToolReturn,
    cells::{CellEvent, CellId, CellOwner, CellVmBinding},
    durable::*,
    interaction::{
        ComputerAppActivity, ComputerAppDisplay, ComputerAppPlatform, GrantCapability, GrantScope,
        GrantTarget,
    },
    model::{ModelPart, ModelToolCall, ToolInput},
    tool_output::{DurableToolProjection, ReturnedToolResult, ToolOutput},
};
use maka_agent_state::{
    Admission, Change, ContentBlob, DriverClaim, Store,
    computer::{self, ComputerStore, NativeSource, Subject},
};
use maka_event_log::{
    StoreError,
    applications::operations::{Dispatch, OperationRequest},
    root_store::RootStore,
};
use maka_plugin_core::{
    composition::{Input, InstanceId},
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt},
};
use maka_sandbox::workspace::PermissionBasis;
use serde_json::json;
use std::collections::BTreeMap;
use uuid::Uuid;

async fn session(root: &RootStore, id: &str) -> PermissionBasis {
    let binding = root
        .attach_workspace("native-source-test", &json!({"path":"/fixture"}))
        .await
        .unwrap();
    root.create_session(
        id,
        id,
        &json!({
            "workspace":binding,"boundary_revision":0,
            "permissions":{"access":"danger_full_access"},
        }),
        1,
    )
    .await
    .unwrap();
    PermissionBasis {
        boundary_revision: 0,
        binding: maka_sandbox::workspace::BindingStamp {
            id: binding.id,
            permission_epoch: 0,
        },
    }
}

async fn host_operation(root: &RootStore) -> OperationReply {
    let request = OperationRequest {
        source: root
            .commit_application(
                Uuid::new_v4(),
                0,
                Input {
                    base: None,
                    ui: None,
                    instances: BTreeMap::new(),
                },
                vec![],
                vec![],
            )
            .await
            .unwrap(),
        namespace: InstanceId(vec![Uuid::new_v4()]),
        consumer: InstanceId(vec![Uuid::new_v4()]),
        export: "service".into(),
        method: "native".into(),
        contract: Contract {
            name: "native-source-test".into(),
            version: 1,
            transport: Transport::Local,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "native".into(),
                    Method {
                        progress: None,
                        mode: MethodMode::Mutation,
                        input: json!({}).into(),
                        output: json!({}).into(),
                        resources: BTreeMap::new(),
                    },
                )]),
            },
        },
        operation: Uuid::new_v4(),
        input: json!({"native":true}),
        capture: None,
        origin: json!({"kind":"native_source_test"}),
    };
    let operation = root.operation(&request.reference().unwrap()).unwrap();
    let Dispatch::New(claim) = operation.dispatch_operation(request).await.unwrap() else {
        panic!("one actual original Host operation must be admitted");
    };
    operation.start_operation(&claim).unwrap();
    let returned = OperationOutcome::Returned {
        result: OperationResult::Success {
            value: json!({"native":true}),
        },
    };
    operation
        .record_operation_outcome(&claim, returned.clone())
        .await
        .unwrap();
    operation
        .record_operation_cleanup(&claim, OperationCleanup::Confirmed)
        .await
        .unwrap();
    let observed = operation.operation_observation().await.unwrap().unwrap();
    assert_eq!(observed.reference, *claim.reference());
    assert_eq!(observed.outcome, returned);
    assert_eq!(observed.cleanup, OperationCleanup::Confirmed);
    OperationReply {
        reference: observed.reference,
        receipt: Receipt::Recorded {
            outcome: observed.outcome,
            cleanup: observed.cleanup,
        },
    }
}

async fn record(store: &Store, claim: &DriverClaim, facts: Vec<Fact>, contents: Vec<ContentBlob>) {
    let view = store.frontier(claim.run()).await.unwrap();
    store
        .append(
            claim,
            (&view).into(),
            facts
                .into_iter()
                .map(|fact| Change::new(fact, UnixMillis(2)))
                .collect(),
            contents,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn external_host_admission_requires_current_task_protocol_and_original_source() {
    use maka_agent_facts::{
        executor::{Binding, NATIVE_TASK_PROTOCOL, Selection, Settings, TaskDescriptor},
        external_effects::{ExternalEffectDescriptor, ExternalEffectEvent, ExternalEffectKey},
        tool_call::ToolOrigin,
        tools::ToolDefinition,
    };

    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let basis = session(&root, "external-source").await;
    let store = support::state(&root);
    let source = Binding {
        executor_id: "fixture".to_owned().try_into().unwrap(),
        package_id: "native-source-test".into(),
        entry_id: "external".into(),
        activation: Uuid::new_v4().to_string(),
    };
    let definition = ToolDefinition {
        provider: None,
        name: "native".into(),
        description: "Canonical external Host call".into(),
        input_schema: json!({"type":"object"}),
        freeform: None,
        output_schema: None,
    };
    let catalog = ContentBlob::json(&vec![definition.clone()]).unwrap();
    let catalog_digest = catalog.reference().digest.clone();
    let mut previous_run = None;
    for boundary in ["protocol", "executor", "bound_activation", "current"] {
        let (mut spec, mut contents) =
            support::spec("external-source", boundary, "external Host call");
        spec.permission_basis = basis.clone();
        let accepted = ContentBlob::json(&source).unwrap();
        spec.backend = BackendSpec::Executor {
            selection: Selection {
                executor: "fixture".into(),
                settings: Settings::default(),
            },
            descriptor: accepted.reference().clone(),
        };
        contents.push(accepted);
        let admission = Admission::new(spec, UnixMillis(1), contents);
        let run = admission.run();
        store.admit(admission).await.unwrap();
        let claim = store.claim(run).await.unwrap();
        let task = ExternalTaskId::new();
        let execution = ExecutionIdentity {
            session_id: "external-source".into(),
            turn_id: boundary.into(),
            run_id: run,
        };
        // Native owns its payload codec; this case exercises the shared envelope boundary.
        let mut original = TaskDescriptor {
            protocol: NATIVE_TASK_PROTOCOL.into(),
            source: source.clone(),
            payload: json!({"request":{"execution":execution,"taskId":task},"recovery":null}),
        };
        let mut bound = original.clone();
        bound.payload["recovery"] = json!({"originalTask":task});
        let expected = match boundary {
            "protocol" => {
                original.protocol = "unaccepted-task-protocol".into();
                bound.protocol = original.protocol.clone();
                Some("external task descriptor differs from the accepted executor protocol")
            }
            "executor" => {
                original.source.executor_id = "other".to_owned().try_into().unwrap();
                bound.source = original.source.clone();
                Some("external task descriptor differs from the accepted executor protocol")
            }
            "bound_activation" => {
                bound.source.activation = Uuid::new_v4().to_string();
                Some("external task binding changed its original accepted source")
            }
            "current" => None,
            _ => unreachable!(),
        };
        let original_blob = ContentBlob::json(&original).unwrap();
        let bound_blob = ContentBlob::json(&bound).unwrap();
        record(
            &store,
            &claim,
            vec![
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: original_blob.reference().clone(),
                },
                Fact::ExternalTaskAdmitted { task },
                Fact::ExternalTaskBound {
                    task,
                    descriptor: bound_blob.reference().clone(),
                },
            ],
            vec![original_blob.clone(), bound_blob.clone()],
        )
        .await;
        let key = ExternalEffectKey {
            task,
            operation: Uuid::new_v4(),
        };
        let descriptor = ExternalEffectDescriptor {
            schema_version: SCHEMA_VERSION,
            protocol: "maka.external-host-effect".into(),
            execution,
            key,
            origin: ToolOrigin::External {
                task,
                operation: key.operation,
                package_id: source.package_id.clone(),
                entry_id: source.entry_id.clone(),
                activation: source.activation.clone(),
            },
            operation_id: format!("external:{}:{}", task, key.operation),
            name: definition.name.clone(),
            input: json!({"native":true}),
            definition: definition.clone(),
            catalog_digest: catalog_digest.clone(),
            resources: vec![],
        };
        let candidates = if let Some(expected) = expected {
            vec![(descriptor, Some(expected))]
        } else {
            let mut wrong_task = descriptor.clone();
            wrong_task.key.task = ExternalTaskId::new();
            let ToolOrigin::External { task, .. } = &mut wrong_task.origin else {
                unreachable!()
            };
            *task = wrong_task.key.task;
            wrong_task.operation_id = format!("external:{}:{}", wrong_task.key.task, key.operation);
            let mut foreign_run = descriptor.clone();
            foreign_run.execution.run_id = previous_run.expect("another actual canonical Run");
            vec![
                (
                    wrong_task,
                    Some("external Host effect belongs to no original admitted task"),
                ),
                (
                    foreign_run,
                    Some("external Host descriptor differs from the original call identity"),
                ),
                (descriptor, None),
            ]
        };
        for (descriptor, expected) in candidates {
            let key = descriptor.key;
            let blob = ContentBlob::json(&descriptor).unwrap();
            let prepared = Change::new(
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Prepared {
                        key,
                        descriptor: blob.reference().clone(),
                    },
                },
                UnixMillis(3),
            );
            let admitted = Change::new(
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Admitted {
                        key,
                        approval: None,
                    },
                },
                UnixMillis(3),
            );
            let prepared_id = prepared.id;
            let admitted_id = admitted.id;
            let before = store.frontier(run).await.unwrap();
            let result = store
                .append(
                    &claim,
                    (&before).into(),
                    vec![prepared, admitted],
                    vec![blob.clone()],
                )
                .await;
            let after = store.frontier(run).await.unwrap();
            if let Some(expected) = expected {
                assert!(
                    matches!(&result, Err(StoreError::InvalidTransition(reason)) if reason == expected),
                    "{boundary}: expected={expected}, result={result:?}"
                );
                assert_eq!(after.revision, before.revision);
                assert_eq!(after.control_version, before.control_version);
                assert_eq!(after.external, before.external);
                assert!(store.external_effect(run, key).await.unwrap().is_none());
                assert!(store.fact(run, prepared_id).await.unwrap().is_none());
                assert!(store.fact(run, admitted_id).await.unwrap().is_none());
            } else {
                let commit = result.unwrap();
                assert_eq!(after.revision, commit.head.revision);
                assert!(store.fact(run, prepared_id).await.unwrap().is_some());
                assert!(store.fact(run, admitted_id).await.unwrap().is_some());
                let effect = store.external_effect(run, key).await.unwrap().unwrap();
                assert!(effect.admitted);
                assert_eq!(effect.descriptor, *blob.reference());
                assert_eq!(
                    store.external_effect_descriptor(run, key).await.unwrap(),
                    descriptor
                );
                assert_eq!(
                    store.content(run, blob.reference().clone()).await.unwrap(),
                    serde_json::to_vec(&descriptor).unwrap()
                );
            }
            let parent = after.external.as_ref().unwrap();
            assert_eq!(parent.descriptor, *original_blob.reference());
            assert_eq!(parent.binding.as_ref(), Some(bound_blob.reference()));
            assert_eq!(
                store
                    .content(run, original_blob.reference().clone())
                    .await
                    .unwrap(),
                serde_json::to_vec(&original).unwrap()
            );
            assert_eq!(
                store
                    .content(run, bound_blob.reference().clone())
                    .await
                    .unwrap(),
                serde_json::to_vec(&bound).unwrap()
            );
        }
        previous_run = Some(run);
    }
    root.close().await.unwrap();
}

async fn model_tool(
    store: &Store,
    session: &str,
    turn: &str,
    basis: PermissionBasis,
) -> (DriverClaim, ToolKey, AgentStepLink) {
    let (mut spec, contents) = support::spec(session, turn, "native source question");
    spec.permission_basis = basis;
    spec.trigger = Trigger::Message {
        message_id: format!("native-message-{}", Uuid::new_v4()),
    };
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    store.admit(admission).await.unwrap();
    let claim = store.claim(run).await.unwrap();
    let (step, request, mut contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    let tool = ToolKey {
        attempt,
        call: "native-call".into(),
    };
    let input = ContentBlob::json(&json!({"native":true})).unwrap();
    contents.push(input.clone());
    record(
        store,
        &claim,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"admitted":true}),
            },
            Fact::ModelObserved {
                attempt,
                index: 0,
                part: ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: tool.call.clone(),
                        name: "native".into(),
                        input: ToolInput::Json(json!({"native":true})),
                        provider_executed: false,
                        provider_options: None,
                    },
                },
                continuation: None,
            },
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: Default::default(),
                protocol: json!({}),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
            Fact::ToolDecided {
                tool: tool.clone(),
                decision: ToolDecision::Approved {
                    semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                    display: ToolDisplay::default(),
                    input: input.reference().clone(),
                    resources: vec![],
                    approval: None,
                },
            },
            Fact::ToolAdmitted { tool: tool.clone() },
        ],
        contents,
    )
    .await;
    (claim, tool, AgentStepLink { run, step, attempt })
}

struct Source {
    claim: DriverClaim,
    native: NativeSource,
    reply: OperationReply,
    tool: ToolKey,
    basis: PermissionBasis,
}

async fn tool_source(
    root: &RootStore,
    store: &Store,
    session: &str,
    turn: &str,
    basis: PermissionBasis,
) -> Source {
    let (claim, tool, _) = model_tool(store, session, turn, basis).await;
    let reply = host_operation(root).await;
    record(
        store,
        &claim,
        vec![Fact::ToolOriginalBound {
            tool: tool.clone(),
            reference: reply.reference.clone(),
        }],
        vec![],
    )
    .await;
    let view = store.frontier(claim.run()).await.unwrap();
    let native = NativeSource {
        execution: ExecutionIdentity {
            session_id: view.spec.session_id,
            turn_id: view.spec.turn_id,
            run_id: view.run,
        },
        target: AuthorizationObligation::Tool { tool: tool.clone() },
        original: reply.reference.clone(),
        native_epoch: "native-epoch".into(),
        generation: "generation".into(),
        operation: reply.reference.operation.to_string(),
    };
    Source {
        claim,
        native,
        reply,
        tool,
        basis,
    }
}

async fn cell_source(
    root: &RootStore,
    store: &Store,
    session: &str,
    turn: &str,
    basis: PermissionBasis,
) -> Source {
    let (claim, tool, link) = model_tool(store, session, turn, basis).await;
    let reply = host_operation(root).await;
    let cell = CellId::for_agent(link, &tool.call);
    let code = ContentBlob::json(&"native child source").unwrap();
    let vm = ContentBlob::json(&json!({"runtime":"native-test","generation":1})).unwrap();
    let input = ContentBlob::json(&json!({"native":true})).unwrap();
    let operation = reply.reference.operation;
    let view = store.frontier(claim.run()).await.unwrap();
    store
        .append(
            &claim,
            (&view).into(),
            vec![
                Change {
                    id: cell.started_fact_id(),
                    at: UnixMillis(2),
                    fact: Fact::Cell {
                        event: CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent {
                                link,
                                call: tool.call.clone(),
                            },
                            source: code.reference().clone(),
                        },
                    },
                },
                Change::new(
                    Fact::Cell {
                        event: CellEvent::VmBound {
                            cell,
                            binding: CellVmBinding {
                                runtime: "native-test".into(),
                                version: 1,
                                descriptor: vm.reference().clone(),
                            },
                        },
                    },
                    UnixMillis(2),
                ),
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildPrepared {
                            semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                            cell,
                            operation,
                            name: "native".into(),
                            input: input.reference().clone(),
                            resources: vec![],
                        },
                    },
                    UnixMillis(2),
                ),
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildAdmitted { cell, operation },
                    },
                    UnixMillis(2),
                ),
                Change::new(
                    Fact::Cell {
                        event: CellEvent::ChildBound {
                            cell,
                            operation,
                            reference: reply.reference.clone(),
                        },
                    },
                    UnixMillis(2),
                ),
            ],
            vec![code, vm, input],
        )
        .await
        .unwrap();
    let view = store.frontier(claim.run()).await.unwrap();
    let native = NativeSource {
        execution: ExecutionIdentity {
            session_id: view.spec.session_id,
            turn_id: view.spec.turn_id,
            run_id: view.run,
        },
        target: AuthorizationObligation::Cell { cell, operation },
        original: reply.reference.clone(),
        native_epoch: "native-epoch".into(),
        generation: "generation".into(),
        operation: operation.to_string(),
    };
    Source {
        claim,
        native,
        reply,
        tool,
        basis,
    }
}

async fn bind(
    computer: &ComputerStore,
    store: &Store,
    source: &Source,
    native: NativeSource,
) -> Result<FactId, StoreError> {
    let id = FactId::new();
    let view = store.frontier(source.claim.run()).await?;
    let inserted = computer
        .append(
            &source.claim,
            (&view).into(),
            computer::Change {
                id,
                at: UnixMillis(3),
                fact: computer::Fact::NativeSourceBound { source: native },
            },
            vec![],
        )
        .await?;
    assert!(inserted);
    Ok(id)
}

#[tokio::test]
async fn native_source_requires_exact_execution_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let basis = session(&root, "session").await;
    let other_basis = session(&root, "other-session").await;
    let store = support::state(&root);
    let computer = ComputerStore::new(root.data_writer().unwrap());
    let original = cell_source(&root, &store, "session", "original-turn", basis).await;
    let other = tool_source(&root, &store, "other-session", "other-turn", other_basis).await;
    let binding = bind(&computer, &store, &original, original.native.clone())
        .await
        .unwrap();
    let mut wrong_turn = original.native.clone();
    wrong_turn.execution.turn_id = other.native.execution.turn_id.clone();
    let mut wrong_run = original.native.clone();
    wrong_run.execution.run_id = other.native.execution.run_id;
    let mut wrong_session = original.native.clone();
    wrong_session.execution.session_id = other.native.execution.session_id.clone();
    for wrong in [wrong_turn, wrong_run, wrong_session] {
        assert!(matches!(
            bind(&computer, &store, &original, wrong).await,
            Err(StoreError::InvalidTransition(_))
        ));
    }
    let mut wrong_original = original.native.clone();
    wrong_original.original = other.reply.reference.clone();
    assert!(
        matches!(bind(&computer, &store, &original, wrong_original).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "Cell source does not match original admitted operation")
    );
    assert!(
        !computer
            .native_turn_interrupted(&original.native.execution)
            .await
            .unwrap()
    );
    computer.rebuild().await.unwrap();
    assert!(
        !computer
            .native_turn_interrupted(&original.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&other.native.execution)
            .await
            .unwrap()
    );
    let replacement = store.claim(original.native.execution.run_id).await.unwrap();
    assert!(matches!(store.driver_frontier(&original.claim).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "superseded driver claim"));
    let current = store.driver_frontier(&replacement).await.unwrap();
    assert_eq!(replacement.run(), original.native.execution.run_id);
    assert_eq!(
        ExecutionIdentity {
            session_id: current.spec.session_id,
            turn_id: current.spec.turn_id,
            run_id: current.run,
        },
        original.native.execution
    );
    assert!(
        computer
            .native_interrupted(
                &original.native.execution,
                binding,
                FactId::new(),
                UnixMillis(4)
            )
            .await
            .unwrap()
    );
    computer.rebuild().await.unwrap();
    assert!(
        computer
            .native_turn_interrupted(&original.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&other.native.execution)
            .await
            .unwrap()
    );
    assert!(matches!(store.driver_frontier(&original.claim).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "superseded driver claim"));
    let current = store.driver_frontier(&replacement).await.unwrap();
    assert_eq!(
        ExecutionIdentity {
            session_id: current.spec.session_id,
            turn_id: current.spec.turn_id,
            run_id: current.run,
        },
        original.native.execution
    );
    record(
        &store,
        &replacement,
        vec![Fact::StopRequested {
            diagnostic: "user stop".into(),
        }],
        vec![],
    )
    .await;
    assert!(matches!(store.driver_frontier(&replacement).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "Run is no longer executable"));
    let stopped = store.original_driver_frontier(&replacement).await.unwrap();
    assert!(stopped.stopped && stopped.terminal.is_none());
    assert_eq!(stopped.run, original.native.execution.run_id);
    assert!(
        matches!(store.original_driver_frontier(&original.claim).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "superseded driver claim")
    );
    let foreign_directory = tempfile::tempdir().unwrap();
    let foreign_root = support::open(foreign_directory.path(), false).await;
    let foreign_store = support::state(&foreign_root);
    assert!(
        matches!(foreign_store.original_driver_frontier(&replacement).await,
        Err(StoreError::InvalidTransition(reason)) if reason == "foreign driver claim")
    );
    foreign_root.close().await.unwrap();
    root.close().await.unwrap();
}

#[tokio::test]
async fn native_turn_fence_is_run_scoped() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let basis = session(&root, "session").await;
    let store = support::state(&root);
    let computer = ComputerStore::new(root.data_writer().unwrap());
    let first = tool_source(&root, &store, "session", "same-presentation-turn", basis).await;
    let second = tool_source(&root, &store, "session", "same-presentation-turn", basis).await;
    assert_ne!(
        first.native.execution.run_id,
        second.native.execution.run_id
    );
    assert_eq!(
        first.native.execution.turn_id,
        second.native.execution.turn_id
    );
    let binding = bind(&computer, &store, &first, first.native.clone())
        .await
        .unwrap();
    let capture = ContentBlob::json(&json!({"applicationId":"org.mozilla.firefox"})).unwrap();
    let browser = Subject {
        activity: ComputerAppActivity {
            execution: first.native.execution.clone(),
            operation_id: format!("browser-{}", first.reply.reference.operation),
            target: GrantTarget {
                provider_id: "native".into(),
                contract_id: "computer".into(),
                server_id: "desktop".into(),
                tool_name: "browser-app".into(),
                capability: GrantCapability::ComputerUse,
                scope: GrantScope::ComputerApp {
                    platform: ComputerAppPlatform::Macos,
                    application_id: "org.mozilla.firefox".into(),
                },
            },
            display: ComputerAppDisplay {
                name: "Firefox".into(),
                app_path: "/Applications/Firefox.app".into(),
                risk: None,
                warning: None,
            },
        },
        basis: first.basis,
        allow_always: false,
        target: first.native.target.clone(),
        operation: first.reply.reference.clone(),
        capture: capture.reference().clone(),
    };
    let view = store.frontier(first.claim.run()).await.unwrap();
    assert!(
        computer
            .append(
                &first.claim,
                (&view).into(),
                computer::Change {
                    id: FactId::new(),
                    at: UnixMillis(3),
                    fact: computer::Fact::SubjectObserved {
                        subject: browser.clone()
                    },
                },
                vec![capture]
            )
            .await
            .unwrap()
    );
    assert_eq!(
        computer
            .subject("session", &browser.activity.operation_id)
            .await
            .unwrap(),
        Some(browser.clone())
    );
    assert_eq!(
        computer
            .status("session", &browser.activity.operation_id)
            .await
            .unwrap()
            .consent,
        computer::Consent::FullAccess
    );
    assert!(
        computer
            .native_interrupted(
                &first.native.execution,
                binding,
                FactId::new(),
                UnixMillis(4)
            )
            .await
            .unwrap()
    );
    assert!(
        computer
            .native_turn_interrupted(&first.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&second.native.execution)
            .await
            .unwrap()
    );
    assert!(matches!(
        bind(&computer, &store, &first, first.native.clone()).await,
        Err(StoreError::InvalidTransition(_))
    ));
    bind(&computer, &store, &second, second.native.clone())
        .await
        .unwrap();
    let view = store.frontier(first.claim.run()).await.unwrap();
    assert!(
        computer
            .append(
                &first.claim,
                (&view).into(),
                computer::Change {
                    id: FactId::new(),
                    at: UnixMillis(5),
                    fact: computer::Fact::AppAuthorized {
                        source_operation: browser.activity.operation_id.clone(),
                        request: None,
                        basis: first.basis,
                    },
                },
                vec![]
            )
            .await
            .unwrap()
    );
    assert!(
        !computer
            .status("session", &browser.activity.operation_id)
            .await
            .unwrap()
            .stopped
    );
    computer.rebuild().await.unwrap();
    assert!(
        computer
            .native_turn_interrupted(&first.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&second.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .status("session", &browser.activity.operation_id)
            .await
            .unwrap()
            .stopped
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn late_native_interruption_keeps_original_binding_scope() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let basis = session(&root, "session").await;
    let store = support::state(&root);
    let computer = ComputerStore::new(root.data_writer().unwrap());
    let old = tool_source(&root, &store, "session", "old-turn", basis).await;
    let binding = bind(&computer, &store, &old, old.native.clone())
        .await
        .unwrap();
    let result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: ReturnedToolResult {
            output: ToolOutput::Operation(Box::new(old.reply.clone())),
            projection: DurableToolProjection::Text {
                text: "original Host operation returned".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    })
    .unwrap();
    record(
        &store,
        &old.claim,
        vec![
            Fact::OperationObserved {
                tool: old.tool.clone(),
                reply: old.reply.clone(),
            },
            Fact::ToolResultAccepted {
                tool: old.tool.clone(),
                result: result.reference().clone(),
                outcome: AcceptedResult::Succeeded,
            },
            Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            },
        ],
        vec![result],
    )
    .await;
    assert_eq!(
        store.frontier(old.claim.run()).await.unwrap().terminal,
        Some(Terminal::Completed)
    );
    let current = tool_source(&root, &store, "session", "current-turn", basis).await;
    assert!(matches!(
        computer
            .native_interrupted(
                &current.native.execution,
                binding,
                FactId::new(),
                UnixMillis(5)
            )
            .await,
        Err(StoreError::InvalidTransition(_))
    ));
    let mut wrong_old_turn = current.native.execution.clone();
    wrong_old_turn.turn_id = old.native.execution.turn_id.clone();
    assert!(matches!(
        computer.native_turn_interrupted(&wrong_old_turn).await,
        Err(StoreError::InvalidTransition(_))
    ));
    assert!(
        !computer
            .native_turn_interrupted(&current.native.execution)
            .await
            .unwrap()
    );
    let interrupted = FactId::new();
    assert!(
        computer
            .native_interrupted(&old.native.execution, binding, interrupted, UnixMillis(6))
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_interrupted(&old.native.execution, binding, interrupted, UnixMillis(6))
            .await
            .unwrap()
    );
    assert!(
        computer
            .native_turn_interrupted(&old.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&current.native.execution)
            .await
            .unwrap()
    );
    bind(&computer, &store, &current, current.native.clone())
        .await
        .unwrap();
    assert!(matches!(
        bind(&computer, &store, &old, old.native.clone()).await,
        Err(StoreError::InvalidTransition(_))
    ));
    computer.rebuild().await.unwrap();
    assert!(
        computer
            .native_turn_interrupted(&old.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&current.native.execution)
            .await
            .unwrap()
    );
    root.close().await.unwrap();
    let root = support::open(directory.path(), true).await;
    let computer = ComputerStore::new(root.data_writer().unwrap());
    assert!(
        computer
            .native_turn_interrupted(&old.native.execution)
            .await
            .unwrap()
    );
    assert!(
        !computer
            .native_turn_interrupted(&current.native.execution)
            .await
            .unwrap()
    );
    root.close().await.unwrap();
}
