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
use maka_agent_facts::{
    cells::{CellEvent, CellView},
    execution::ModelBinding,
    model::{ModelToolCall, ToolInput},
};
use maka_agent_state::{ContentBlob, fold::Tool};
use maka_plugin_core::composition::InstanceId;
use maka_sandbox::workspace::{BindingStamp, PermissionBasis};
use uuid::Uuid;

pub(crate) fn policy_view(tokens: Option<u64>) -> RunView {
    let source = ContentBlob::new(Vec::new()).reference().clone();
    RunView::admitted(
        RunId::new(),
        RunSpec {
            schema_version: SCHEMA_VERSION,
            session_id: "cell-policy".into(),
            owner: RunOwner {
                deployment: Uuid::new_v4(),
                namespace: InstanceId(vec![Uuid::new_v4()]),
            },
            turn_id: "cell-policy-turn".into(),
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
            backend: BackendSpec::Model {
                binding: ModelBinding {
                    connection_id: "policy".into(),
                    connection_slug: "policy".into(),
                    model: "policy".into(),
                },
                descriptor: source.clone(),
            },
            collaboration: Default::default(),
            language: Default::default(),
            tool_discovery: false,
            allowed_tools: None,
            mcp_revision: None,
            compaction_prompt: None,
            system_prompt: source.clone(),
            tool_selection: source.clone(),
            input: source.clone(),
            budget: Budget {
                tokens,
                retries: 0,
                deadline: None,
            },
            budget_basis: None,
        },
    )
    .unwrap()
}

#[test]
fn pending_cell_observation_precedes_new_tool_policy_without_freezing_live_cells() {
    // Policy data only: no request loading, Root custody, or VM lifetime is established here.
    let mut view = policy_view(None);
    let source = view.spec.input.clone();
    let link = AgentStepLink {
        run: view.run,
        step: StepId::new(),
        attempt: ModelAttemptId::new(),
    };
    view.current_step = Some(link.step);
    view.current_attempt = Some(link.attempt);
    let candidate = ToolKey {
        attempt: link.attempt,
        call: "candidate".into(),
    };
    view.tools.insert(
        maka_agent_state::fold::tool_key(&candidate),
        Tool {
            key: candidate.clone(),
            call: ModelToolCall {
                id: candidate.call.clone(),
                name: "candidate".into(),
                input: ToolInput::Json(serde_json::Value::Null),
                provider_options: None,
                provider_executed: false,
            },
            decision: None,
            approval_refusal: None,
            original: None,
            receipt: None,
            provider_result: None,
            local_returned: None,
            host_returned: None,
            prohibited_before_host: None,
            admitted: false,
            accepted: None,
        },
    );
    let cell = CellId::for_agent(link, "original-exec");
    view.cells.insert(
        cell,
        CellView::started(&CellEvent::Started {
            cell,
            owner: CellOwner::Agent {
                link,
                call: "original-exec".into(),
            },
            source,
        })
        .unwrap(),
    );
    let mut live = Live::default();
    assert!(
        matches!(next(&view, &live, UnixMillis(1), None, false), Action::ObserveCell(id) if id == cell)
    );

    live.cells_observed.insert(cell);
    live.work.insert(WorkKey::Cell(cell));
    assert!(matches!(
        next(&view, &live, UnixMillis(1), None, false),
        Action::Idle
    ));

    // Model a completed Live observation, not a canonical Interrupted/Gone transition.
    live.work.remove(&WorkKey::Cell(cell));
    assert!(
        matches!(next(&view, &live, UnixMillis(1), None, false), Action::Decide(key) if key == candidate)
    );
}

pub(crate) fn apply_policy_fact(view: &mut RunView, fact: Fact) {
    let recorded = RecordedFact {
        schema_version: SCHEMA_VERSION,
        id: FactId::new(),
        run: view.run,
        revision: view.revision + 1,
        at: UnixMillis(1),
        fact,
    };
    view.apply(&recorded).unwrap();
}

pub(crate) fn budget_closure(
    purpose: maka_agent_facts::context::ModelPurpose,
    finish_reason: maka_agent_facts::model::ModelFinishReason,
    outcome: maka_agent_facts::accounting::Outcome,
    with_tool: bool,
) -> (RunView, RequestSpec, ModelAttemptId) {
    // Policy/fold evidence only, not actual source custody or physical cleanup.
    let mut view = policy_view(Some(110));
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, request, attempt) =
        model_closure(view, purpose, finish_reason, outcome, with_tool);
    apply_policy_fact(&mut view, Fact::BudgetCharged { tokens: 110 });
    (view, request, attempt)
}

pub(crate) fn model_closure(
    mut view: RunView,
    purpose: maka_agent_facts::context::ModelPurpose,
    finish_reason: maka_agent_facts::model::ModelFinishReason,
    outcome: maka_agent_facts::accounting::Outcome,
    with_tool: bool,
) -> (RunView, RequestSpec, ModelAttemptId) {
    let source = view.spec.input.clone();
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let binding = match &view.spec.backend {
        BackendSpec::Model { binding, .. } => binding.clone(),
        _ => unreachable!(),
    };
    let request = RequestSpec {
        schema_version: SCHEMA_VERSION,
        step,
        composition: maka_agent_facts::composition::RequestComposition {
            system_prompt: None,
            dynamic_context: Vec::new(),
            tool_catalog_digest: source.digest.clone(),
            tools: Vec::new(),
            provider_options: None,
            max_output_tokens: None,
            sources: Vec::new(),
        },
        summary_repair_of: None,
        compaction_recovery: None,
        source_capture: source.clone(),
        source_digest: source.digest.clone(),
        effective_source_digest: source.digest.clone(),
        provenance: source.clone(),
        projection: None,
        adjudications: Vec::new(),
        steering: Vec::new(),
        request: source.clone(),
        protocol: "policy".into(),
        protocol_version: 1,
        recovery_contract: source.clone(),
        request_contents: Vec::new(),
        accounting: maka_agent_facts::accounting::ModelEvidence {
            model_id: binding.model.clone(),
            binding,
            purpose,
            quote: None,
        },
    };
    let encoded = ContentBlob::json(&request).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::StepPrepared {
            step,
            request: encoded.reference().clone(),
            adjudications: Vec::new(),
        },
    );
    apply_policy_fact(&mut view, Fact::ModelAttemptPrepared { attempt, step });
    apply_policy_fact(
        &mut view,
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::Value::Null,
        },
    );
    if with_tool {
        apply_policy_fact(
            &mut view,
            Fact::ModelObserved {
                attempt,
                index: 0,
                continuation: None,
                part: maka_agent_facts::model::ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: "continuation".into(),
                        name: "candidate".into(),
                        input: ToolInput::Json(serde_json::Value::Null),
                        provider_options: None,
                        provider_executed: false,
                    },
                },
            },
        );
    }
    let protocol = serde_json::to_value(ModelClosureProtocol {
        finish_reason,
        provider_options: None,
        response_id: None,
        model: None,
        timestamp: None,
        compaction: None,
        summary: None,
    })
    .unwrap();
    apply_policy_fact(
        &mut view,
        Fact::ModelClosed {
            attempt,
            outcome,
            diagnostic: None,
            usage: maka_agent_facts::model::ModelUsage {
                input_tokens: Some(100),
                output_tokens: Some(10),
                ..Default::default()
            },
            protocol,
        },
    );
    (view, request, attempt)
}

#[test]
fn budget_child_wait_survives_until_the_failed_terminal_batch() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    let (mut view, request, attempt) = budget_closure(
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    let child_wait = WaitId::new();
    apply_policy_fact(
        &mut view,
        Fact::WaitRegistered {
            wait: child_wait,
            reason: WaitReason::Child { run: RunId::new() },
            due_at: None,
        },
    );
    let now = UnixMillis(1);
    let mut live = Live::default();
    assert!(!complete_at_budget(&view, &request, now));
    assert!(
        !matches!(next(&view, &live, now, None, false), Action::CancelWait(id) if id == child_wait)
    );
    // Policy/fold only: issuing cancel is not a physical cleanup ACK.
    live.models_cancelled.insert(attempt);
    assert!(matches!(
        next(&view, &live, now, None, false),
        Action::Terminate(Terminal::Failed)
    ));
    let facts = crate::driver::termination_facts(&view, Terminal::Failed, None);
    assert!(
        matches!(facts.as_slice(), [Fact::WaitCancelled { wait, .. }, Fact::RunTerminated { terminal: Terminal::Failed, .. }] if *wait == child_wait)
    );
    for fact in facts {
        apply_policy_fact(&mut view, fact);
    }
    assert_eq!(view.terminal, Some(Terminal::Failed));
}

#[test]
fn spent_budget_does_not_consume_authorized_replan_or_active_non_authority_blocker() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    let (mut view, request, attempt) = budget_closure(
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    let now = UnixMillis(1);
    let blocker = BlockerId::new();
    apply_policy_fact(
        &mut view,
        Fact::Blocked {
            blocker,
            reason: BlockerKind::UnsupportedProtocol {
                protocol: "policy uncertainty".into(),
                version: 1,
            },
        },
    );
    assert!(!complete_at_budget(&view, &request, now));
    let evidence = view.spec.input.clone();
    apply_policy_fact(
        &mut view,
        Fact::RiskAdjudicated {
            blocker,
            decision: RiskDecision::AuthorizeReplan { evidence },
            scope: RiskActionScope::ModelReplan {
                attempt,
                base_step: request.step,
            },
        },
    );
    assert!(!complete_at_budget(&view, &request, now));
    assert!(!matches!(
        next(
            &view,
            &Live::default(),
            now,
            None,
            complete_at_budget(&view, &request, now)
        ),
        Action::Terminate(Terminal::Completed)
    ));
    assert!(view.replans.contains_key(&blocker));
}

#[test]
fn spent_budget_does_not_complete_over_child_wait_or_context_compaction_trigger() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    let (mut view, request, _) = budget_closure(
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    apply_policy_fact(
        &mut view,
        Fact::WaitRegistered {
            wait: WaitId::new(),
            reason: WaitReason::Child { run: RunId::new() },
            due_at: None,
        },
    );
    assert!(!complete_at_budget(&view, &request, UnixMillis(1)));

    let mut context = policy_view(Some(110));
    context.spec.trigger = Trigger::ContextCompact;
    let spec = ContentBlob::json(&context.spec).unwrap();
    apply_policy_fact(
        &mut context,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut context, request, _) = model_closure(
        context,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    apply_policy_fact(&mut context, Fact::BudgetCharged { tokens: 110 });
    assert!(!complete_at_budget(&context, &request, UnixMillis(1)));
}

#[test]
fn spent_budget_preserves_final_success_and_waits_for_original_cleanup_ack() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    use maka_plugin_core::operation::OperationCleanup;
    let (mut view, request, attempt) = budget_closure(
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    let now = UnixMillis(1);
    let mut live = Live::default();
    live.work.insert(WorkKey::Model(attempt));
    assert!(complete_at_budget(&view, &request, now));
    assert!(
        matches!(next(&view, &live, now, None, complete_at_budget(&view, &request, now)),
        Action::Wait(WaitReason::Model { attempt: id }, None) if id == attempt)
    );
    live.work.remove(&WorkKey::Model(attempt));
    assert!(
        matches!(next(&view, &live, now, None, complete_at_budget(&view, &request, now)),
        Action::Wait(WaitReason::Model { attempt: id }, None) if id == attempt)
    );
    let wait = WaitId::new();
    apply_policy_fact(
        &mut view,
        Fact::WaitRegistered {
            wait,
            reason: WaitReason::Model { attempt },
            due_at: None,
        },
    );
    assert!(matches!(
        next(
            &view,
            &live,
            now,
            None,
            complete_at_budget(&view, &request, now)
        ),
        Action::Idle
    ));
    apply_policy_fact(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    assert!(
        matches!(next(&view, &live, now, None, complete_at_budget(&view, &request, now)), Action::Satisfy(id) if id == wait)
    );
    let evidence = view.spec.input.clone();
    apply_policy_fact(&mut view, Fact::WaitSatisfied { wait, evidence });
    assert!(matches!(
        next(
            &view,
            &live,
            now,
            None,
            complete_at_budget(&view, &request, now)
        ),
        Action::Terminate(Terminal::Completed)
    ));
    apply_policy_fact(
        &mut view,
        Fact::RunTerminated {
            terminal: Terminal::Completed,
            diagnostic: None,
        },
    );
    assert_eq!(view.terminal, Some(Terminal::Completed));
}

#[test]
fn spent_budget_never_dispatches_a_tool_or_prepares_its_continuation() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    let (mut view, request, attempt) = budget_closure(
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        true,
    );
    let live = Live::default();
    let now = UnixMillis(1);
    let tool = ToolKey {
        attempt,
        call: "continuation".into(),
    };
    assert!(!complete_at_budget(&view, &request, now));
    let Action::Reject(key, rejection) = next(
        &view,
        &live,
        now,
        None,
        complete_at_budget(&view, &request, now),
    ) else {
        panic!("spent budget must reject the unadmitted tool");
    };
    assert_eq!(key, tool);
    apply_policy_fact(
        &mut view,
        Fact::ToolDecided {
            tool: tool.clone(),
            decision: ToolDecision::Rejected {
                rejection,
                display: Default::default(),
            },
        },
    );
    let Action::Accept(key, outcome) = next(
        &view,
        &live,
        now,
        None,
        complete_at_budget(&view, &request, now),
    ) else {
        panic!("the original rejection must still be accepted");
    };
    assert_eq!(key, tool);
    let result = view.spec.input.clone();
    apply_policy_fact(
        &mut view,
        Fact::ToolResultAccepted {
            tool,
            result,
            outcome,
        },
    );
    assert!(!complete_at_budget(&view, &request, now));
    assert!(matches!(
        next(
            &view,
            &live,
            now,
            None,
            complete_at_budget(&view, &request, now)
        ),
        Action::Terminate(Terminal::Failed)
    ));
}

#[test]
fn spent_budget_does_not_promote_stop_unknown_failure_length_or_summary_to_success() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    for (purpose, finish, outcome, stop) in [
        (
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Success,
            true,
        ),
        (
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Unknown,
            false,
        ),
        (
            ModelPurpose::Main,
            ModelFinishReason::Stop,
            Outcome::Error,
            false,
        ),
        (
            ModelPurpose::Main,
            ModelFinishReason::Length,
            Outcome::Success,
            false,
        ),
        (
            ModelPurpose::Summary,
            ModelFinishReason::Stop,
            Outcome::Success,
            false,
        ),
    ] {
        let (mut view, request, _) = budget_closure(purpose, finish, outcome, false);
        if stop {
            apply_policy_fact(
                &mut view,
                Fact::StopRequested {
                    diagnostic: "policy stop".into(),
                },
            );
        }
        let now = UnixMillis(1);
        assert!(!complete_at_budget(&view, &request, now));
        let expected = if stop {
            Terminal::Cancelled
        } else {
            Terminal::Failed
        };
        assert!(
            matches!(next(&view, &Live::default(), now, None, complete_at_budget(&view, &request, now)),
            Action::Terminate(terminal) if terminal == expected)
        );
    }
}
