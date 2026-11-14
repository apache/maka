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
use crate::ContentBlob;
use maka_agent_facts::{execution::ModelBinding, model::ToolInput, tool_call::ToolSettlement};
use maka_plugin_core::composition::InstanceId;
use maka_sandbox::workspace::{BindingStamp, PermissionBasis};
use uuid::Uuid;

fn record(view: &RunView, fact: Fact) -> RecordedFact {
    RecordedFact {
        schema_version: SCHEMA_VERSION,
        id: FactId::new(),
        run: view.run,
        revision: view.revision + 1,
        at: UnixMillis(1),
        fact,
    }
}

fn apply(view: &mut RunView, fact: Fact) -> RecordedFact {
    let recorded = record(view, fact);
    view.apply(&recorded).unwrap();
    recorded
}

fn spec(backend: BackendSpec, reference: &ContentRef) -> RunSpec {
    RunSpec {
        schema_version: SCHEMA_VERSION,
        session_id: "run-fold".into(),
        owner: RunOwner {
            deployment: Uuid::new_v4(),
            namespace: InstanceId(vec![Uuid::new_v4()]),
        },
        turn_id: "original-turn".into(),
        origin: RunOrigin::Local,
        trigger: Trigger::Message {
            message_id: "original-message".into(),
        },
        workspace: "/".into(),
        permission_basis: PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: Uuid::new_v4(),
                permission_epoch: 0,
            },
        },
        permission_ceiling: maka_sandbox::Permissions {
            sandbox: maka_sandbox::Sandbox::Disabled,
            approval: maka_sandbox::Approval::Never,
        },
        network_approval_ceiling: None,
        backend,
        collaboration: Default::default(),
        language: Default::default(),
        tool_discovery: false,
        allowed_tools: None,
        mcp_revision: None,
        compaction_prompt: None,
        system_prompt: reference.clone(),
        tool_selection: reference.clone(),
        input: reference.clone(),
        budget: Budget {
            tokens: None,
            retries: 0,
            deadline: None,
        },
        budget_basis: None,
    }
}

#[test]
fn finish_turn_settles_after_cell_cleanup_with_an_undelivered_notification() {
    use maka_agent_facts::cells::{CellEvent, CellId, CellOwner, CellView};

    let source = ContentBlob::new(vec![]).reference().clone();
    let spec = spec(
        BackendSpec::Model {
            binding: ModelBinding {
                connection_id: "policy".into(),
                connection_slug: "policy".into(),
                model: "policy".into(),
            },
            descriptor: source.clone(),
        },
        &source,
    );
    let spec_ref = ContentBlob::json(&spec).unwrap().reference().clone();
    let mut view = RunView::admitted(RunId::new(), spec).unwrap();
    apply(&mut view, Fact::RunAdmitted { spec: spec_ref });
    let link = AgentStepLink {
        run: view.run,
        step: StepId::new(),
        attempt: ModelAttemptId::new(),
    };
    let cell = CellId::for_agent(link, "background");
    let background = CellView::started(&CellEvent::Started {
        cell,
        owner: CellOwner::Agent {
            link,
            call: "background".into(),
        },
        source: source.clone(),
    })
    .unwrap();
    view.cells.insert(cell, background);
    let complete = |view: &mut RunView| {
        let fact = record(
            view,
            Fact::RunTerminated {
                terminal: Terminal::Completed,
                diagnostic: None,
            },
        );
        view.apply(&fact)
    };
    view.finish_requested = true;
    assert!(complete(&mut view).is_err());

    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::Interrupted {
                cell,
                report: source.clone(),
            },
        },
    );
    let notification = FactId::new();
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::FinalNotificationQueued {
                cell,
                notification,
                content: source,
            },
        },
    );
    let mut continuing = view.clone();
    continuing.finish_requested = false;
    assert!(complete(&mut continuing).is_err());

    complete(&mut view).unwrap();
    assert_eq!(view.terminal, Some(Terminal::Completed));
    assert!(view.cells[&cell].notifications.contains(&notification));
    assert!(!view.cells[&cell].blocks_session_retirement(view.terminal.as_ref()));
}

#[test]
fn unknown_local_return_keeps_risk_until_new_known_evidence_and_never_rewrites_known_result() {
    // Pure fold data: content loading, physical cleanup, and Native custody are not exercised.
    let reference = ContentBlob::new(Vec::new()).reference().clone();
    let spec = spec(
        BackendSpec::Model {
            binding: ModelBinding {
                connection_id: "policy".into(),
                connection_slug: "policy".into(),
                model: "policy".into(),
            },
            descriptor: reference.clone(),
        },
        &reference,
    );
    let spec_ref = ContentBlob::json(&spec).unwrap().reference().clone();
    let mut view = RunView::admitted(RunId::new(), spec).unwrap();
    apply(&mut view, Fact::RunAdmitted { spec: spec_ref });
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let tool = ToolKey {
        attempt,
        call: "original-call".into(),
    };
    apply(
        &mut view,
        Fact::StepPrepared {
            step,
            request: reference.clone(),
            adjudications: Vec::new(),
        },
    );
    apply(&mut view, Fact::ModelAttemptPrepared { attempt, step });
    apply(
        &mut view,
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: Value::Null,
        },
    );
    apply(
        &mut view,
        Fact::ModelObserved {
            attempt,
            index: 0,
            continuation: None,
            part: ModelPart::ToolCall {
                call: ModelToolCall {
                    id: tool.call.clone(),
                    name: "local-control".into(),
                    input: ToolInput::Json(Value::Null),
                    provider_options: None,
                    provider_executed: false,
                },
            },
        },
    );
    apply(
        &mut view,
        Fact::ToolDecided {
            tool: tool.clone(),
            decision: ToolDecision::Approved {
                input: reference,
                resources: Vec::new(),
                approval: None,
                display: ToolDisplay::default(),
                semantics: ToolSemantics::Parallel,
            },
        },
    );
    apply(&mut view, Fact::ToolAdmitted { tool: tool.clone() });
    let reason = BlockerKind::OriginalAdmissionUnknown { tool: tool.clone() };
    let before_unknown = BlockerId::new();
    apply(
        &mut view,
        Fact::Blocked {
            blocker: before_unknown,
            reason: reason.clone(),
        },
    );
    let returned = |settlement, result| Fact::LocalToolReturned {
        tool: tool.clone(),
        settlement,
        result,
        is_error: true,
        cell_observation: None,
    };
    let unknown_ref = ContentBlob::new(b"original uncertainty".to_vec())
        .reference()
        .clone();
    let unknown = apply(
        &mut view,
        returned(ToolSettlement::Unknown, unknown_ref.clone()),
    );
    assert_eq!(view.blockers[&before_unknown].resolved_by, None);
    let after_unknown = BlockerId::new();
    apply(
        &mut view,
        Fact::Blocked {
            blocker: after_unknown,
            reason,
        },
    );
    apply(&mut view, unknown.fact.clone());
    assert_eq!(view.blockers[&after_unknown].resolved_by, None);
    let different_ref = ContentBlob::new(b"different result".to_vec())
        .reference()
        .clone();
    let conflicting_unknown = record(
        &view,
        returned(ToolSettlement::Unknown, different_ref.clone()),
    );
    let unchanged = view.clone();
    assert!(matches!(
        view.apply(&conflicting_unknown),
        Err(StoreError::EventConflict)
    ));
    assert_eq!(view, unchanged);

    let known_ref = ContentBlob::new(b"actual control failure".to_vec())
        .reference()
        .clone();
    let known = apply(
        &mut view,
        returned(ToolSettlement::Failed, known_ref.clone()),
    );
    assert_ne!(known.id, unknown.id);
    for blocker in [before_unknown, after_unknown] {
        assert_eq!(view.blockers[&blocker].resolved_by, Some(known.id));
    }
    apply(&mut view, known.fact.clone());
    for fact in [
        returned(ToolSettlement::Failed, different_ref),
        returned(ToolSettlement::Returned, known_ref.clone()),
        returned(ToolSettlement::Unknown, unknown_ref.clone()),
    ] {
        let conflicting = record(&view, fact);
        let unchanged = view.clone();
        assert!(matches!(
            view.apply(&conflicting),
            Err(StoreError::EventConflict)
        ));
        assert_eq!(view, unchanged);
    }
    assert_eq!(
        view.tools[&tool_key(&tool)].local_returned,
        Some(LocalReturn {
            settlement: ToolSettlement::Failed,
            result: known_ref,
            is_error: true,
        })
    );
    assert_eq!(unknown.fact, returned(ToolSettlement::Unknown, unknown_ref));
    for blocker in [before_unknown, after_unknown] {
        assert_eq!(view.blockers[&blocker].resolved_by, Some(known.id));
    }
}

#[test]
fn replay_continues_after_an_external_tool_was_rejected_before_execution() {
    use maka_agent_facts::{
        executor::{Output, Selection},
        external_effects::{ExternalEffectEvent, ExternalEffectKey},
        tool_call::RejectionKind,
    };

    let descriptor = ContentBlob::new(b"original descriptor".to_vec())
        .reference()
        .clone();
    let spec = spec(
        BackendSpec::Executor {
            selection: Selection {
                executor: "external".into(),
                settings: Default::default(),
            },
            descriptor: descriptor.clone(),
        },
        &descriptor,
    );
    let spec_ref = ContentBlob::json(&spec).unwrap().reference().clone();
    let mut view = RunView::admitted(RunId::new(), spec).unwrap();
    let task = ExternalTaskId::new();
    let rejected = ExternalEffectKey {
        task,
        operation: Uuid::new_v4(),
    };
    let next = ExternalEffectKey {
        task,
        operation: Uuid::new_v4(),
    };
    let effect = |event| Fact::ExternalEffect { event };
    for fact in [
        Fact::RunAdmitted { spec: spec_ref },
        Fact::ExternalTaskPrepared {
            task,
            descriptor: descriptor.clone(),
            live_workspace: true,
        },
        Fact::ExternalTaskAdmitted { task },
        effect(ExternalEffectEvent::Prepared {
            key: rejected,
            descriptor: descriptor.clone(),
        }),
        effect(ExternalEffectEvent::Rejected {
            key: rejected,
            rejection_kind: RejectionKind::InvalidInput,
            diagnostic: "invalid tool input".into(),
        }),
    ] {
        apply(&mut view, fact);
    }
    view.check_effect_admission().unwrap();
    for fact in [
        effect(ExternalEffectEvent::Prepared {
            key: next,
            descriptor: descriptor.clone(),
        }),
        effect(ExternalEffectEvent::Admitted {
            key: next,
            approval: None,
        }),
        effect(ExternalEffectEvent::CleanupObserved {
            key: next,
            cleanup: OperationCleanup::Failed {
                diagnostic: "could not join tool worker".into(),
            },
        }),
    ] {
        apply(&mut view, fact);
    }
    assert!(matches!(
        view.check_effect_admission(),
        Err(StoreError::InvalidTransition(reason))
            if reason == "external task has unresolved original effects or cleanup"
    ));
    for fact in [
        effect(ExternalEffectEvent::Prepared {
            key: ExternalEffectKey {
                task,
                operation: Uuid::new_v4(),
            },
            descriptor,
        }),
        effect(ExternalEffectEvent::CleanupObserved {
            key: next,
            cleanup: OperationCleanup::Confirmed,
        }),
        effect(ExternalEffectEvent::Returned {
            key: next,
            output: ContentBlob::new(b"next tool result".to_vec())
                .reference()
                .clone(),
            finish_turn: false,
        }),
        Fact::ExternalTaskObserved {
            task,
            index: 0,
            output: Output::MessageEnd {
                message_id: "response".into(),
            },
        },
        Fact::ExternalTaskCleanupObserved {
            task,
            cleanup: OperationCleanup::Confirmed,
        },
        Fact::ExternalTaskClosed {
            task,
            outcome: Terminal::Cancelled,
            diagnostic: None,
            final_message: None,
        },
        Fact::RunTerminated {
            terminal: Terminal::Cancelled,
            diagnostic: None,
        },
    ] {
        apply(&mut view, fact);
    }
    assert_eq!(view.terminal, Some(Terminal::Cancelled));
}
