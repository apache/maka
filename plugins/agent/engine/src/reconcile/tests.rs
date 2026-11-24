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
            network_approval_ceiling: None,
            filesystem_approval_ceiling: None,
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

#[test]
fn completed_cell_waits_for_live_tool_return_before_recovering() {
    use maka_agent_facts::{
        accounting::Outcome,
        cells::{CellVmBinding, SessionPublication},
        context::ModelPurpose,
        model::ModelFinishReason,
    };

    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, request, attempt) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::ToolCalls,
        Outcome::Success,
        true,
    );
    let key = ToolKey {
        attempt,
        call: "continuation".into(),
    };
    view.tools
        .get_mut(&maka_agent_state::fold::tool_key(&key))
        .unwrap()
        .admitted = true;
    let link = AgentStepLink {
        run: view.run,
        step: request.step,
        attempt,
    };
    let cell = CellId::for_agent(link, &key.call);
    let source = view.spec.input.clone();
    for event in [
        CellEvent::Started {
            cell,
            owner: CellOwner::Agent {
                link,
                call: key.call.clone(),
            },
            source: source.clone(),
        },
        CellEvent::VmBound {
            cell,
            binding: CellVmBinding {
                runtime: "fixture".into(),
                version: 1,
                descriptor: source.clone(),
            },
        },
        CellEvent::Completed {
            cell,
            result: source,
            publication: SessionPublication {
                values: Default::default(),
                loaded_tools: None,
            },
        },
    ] {
        apply_policy_fact(&mut view, Fact::Cell { event });
    }

    let mut live = Live::default();
    live.work.insert(WorkKey::Tool(key.clone()));
    assert!(matches!(
        next(&view, &live, UnixMillis(1), None, false),
        Action::Idle
    ));

    live.work.clear();
    assert!(matches!(next(&view, &live, UnixMillis(1), None, false),
        Action::Accept(tool, AcceptedResult::CellRecovered { cell: recovered })
            if tool == key && recovered == cell
    ));
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
            surface: source.clone(),
            dynamic_context: Vec::new(),
            tool_catalog_digest: source.digest.clone(),
            provider_options: None,
            max_output_tokens: None,
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
        model_time_ms: None,
        finish_reason,
        provider_options: None,
        cache_read_reported: None,
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
fn closed_attempt_waits_for_its_in_flight_recovery_assessment() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};

    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (view, _, attempt) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Aborted,
        false,
    );
    let now = UnixMillis(1);
    let mut live = Live::default();
    // The closed stream may still be settling independently of its assessment.
    live.work.insert(WorkKey::Model(attempt));
    assert!(matches!(next(&view, &live, now, None, false), Action::Assess(id) if id == attempt));

    live.work.insert(WorkKey::Assess(attempt));
    assert!(matches!(next(&view, &live, now, None, false), Action::Idle));
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
fn provider_search_and_final_answer_complete_in_one_request() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    use maka_plugin_core::operation::OperationCleanup;

    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, _, attempt) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        true,
    );
    let key = ToolKey {
        attempt,
        call: "continuation".into(),
    };
    let tool = view
        .tools
        .get_mut(&maka_agent_state::fold::tool_key(&key))
        .unwrap();
    tool.call.provider_executed = true;
    tool.accepted = Some(maka_agent_state::fold::ToolAcceptance {
        result: view.spec.input.clone(),
        outcome: AcceptedResult::Succeeded,
    });
    apply_policy_fact(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    assert!(matches!(
        next(&view, &Live::default(), UnixMillis(1), None, false),
        Action::Terminate(Terminal::Completed)
    ));
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
fn spent_budget_waits_for_closed_proactive_summary_cleanup_before_completing() {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    use maka_plugin_core::operation::OperationCleanup;

    let mut view = policy_view(Some(110));
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, request, main) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        false,
    );
    let summary_step = StepId::new();
    let summary = ModelAttemptId::new();
    for fact in [
        Fact::ProactiveSummaryPrepared {
            step: summary_step,
            request: view.spec.input.clone(),
            attempt: summary,
        },
        Fact::ModelAttemptAdmitted {
            attempt: summary,
            upstream: serde_json::json!({}),
        },
        Fact::ModelClosed {
            attempt: summary,
            outcome: Outcome::Success,
            diagnostic: None,
            usage: Default::default(),
            protocol: serde_json::json!({}),
        },
        Fact::ModelCleanupObserved {
            attempt: main,
            cleanup: OperationCleanup::Confirmed,
        },
        Fact::BudgetCharged { tokens: 110 },
    ] {
        apply_policy_fact(&mut view, fact);
    }

    let now = UnixMillis(1);
    let mut live = Live::default();
    live.work.insert(WorkKey::Model(summary));
    assert!(complete_at_budget(&view, &request, now));
    assert!(matches!(
        next(&view, &live, now, None, true),
        Action::Wait(WaitReason::Model { attempt }, None) if attempt == summary
    ));
    let wait = WaitId::new();
    apply_policy_fact(
        &mut view,
        Fact::WaitRegistered {
            wait,
            reason: WaitReason::Model { attempt: summary },
            due_at: None,
        },
    );
    assert!(matches!(next(&view, &live, now, None, true), Action::Idle));
    apply_policy_fact(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt: summary,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    assert!(matches!(
        next(&view, &live, now, None, true),
        Action::Satisfy(id) if id == wait
    ));
    let evidence = view.spec.input.clone();
    apply_policy_fact(&mut view, Fact::WaitSatisfied { wait, evidence });
    assert!(matches!(
        next(&view, &live, now, None, true),
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
                    requester: StopRequester::Internal,
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

#[test]
fn known_publication_failure_only_fences_followup_until_original_cleanup() {
    use maka_agent_state::{
        external_publication::{ExternalPublication, PublicationItem},
        fold::{Blocker, ExternalClosure, ExternalTask},
    };
    use maka_plugin_core::operation::OperationCleanup;

    let mut view = policy_view(None);
    let task = ExternalTaskId::new();
    let id = ExternalPublicationId::new();
    let key = ExternalPublicationKey {
        publication: id,
        index: 0,
    };
    let item = PublicationItem {
        key,
        basis: view.spec.permission_basis,
        prevention: None,
        original: None,
        observation: None,
        outcome: Some(ExternalPublicationOutcome::Conflict),
        cleanup: OperationCleanup::Unconfirmed,
    };
    view.external = Some(ExternalTask {
        task,
        descriptor: view.spec.input.clone(),
        live_workspace: false,
        admitted: true,
        binding: None,
        observed: 0,
        active_tools: Default::default(),
        context_usage: None,
        model_time_ms: None,
        turn_usage: None,
        closed: Some(ExternalClosure {
            outcome: Terminal::Completed,
            diagnostic: None,
            final_message: None,
        }),
        cleanup: OperationCleanup::Confirmed,
        cleanup_not_before: None,
        steering: None,
        effects: Default::default(),
        publication: Some(ExternalPublication {
            id,
            task,
            source: view.spec.input.clone(),
            manifest: Some(view.spec.input.clone()),
            item_count: Some(2),
            admitted: 1,
            settled: 0,
            abandoned: false,
            items: [(0, item)].into(),
        }),
    });
    let reason = BlockerKind::ExternalPublicationItem {
        key,
        reason: ExternalPublicationBlocker::Conflict,
    };
    view.blockers.insert(
        BlockerId::new(),
        Blocker {
            reason: reason.clone(),
            decision: None,
            resolved_by: None,
        },
    );
    view.terminal = Some(Terminal::Failed);
    assert!(view.blocks_followup());

    view.external
        .as_mut()
        .unwrap()
        .publication
        .as_mut()
        .unwrap()
        .items
        .get_mut(&0)
        .unwrap()
        .cleanup = OperationCleanup::Confirmed;
    assert!(!view.blocks_followup());
    assert_eq!(view.recovery_failure(), Some(&reason));
}

#[test]
fn a_finished_turn_fails_the_run_when_its_external_task_closed_as_failed() {
    use maka_agent_facts::external_effects::{ExternalEffectEvent, ExternalEffectKey};
    use maka_agent_state::fold::{ExternalClosure, ExternalTask};
    use maka_plugin_core::operation::OperationCleanup;

    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let task = ExternalTaskId::new();
    view.external = Some(ExternalTask {
        task,
        descriptor: view.spec.input.clone(),
        live_workspace: true,
        admitted: true,
        binding: None,
        observed: 0,
        active_tools: Default::default(),
        context_usage: None,
        model_time_ms: None,
        turn_usage: None,
        closed: None,
        cleanup: OperationCleanup::Confirmed,
        cleanup_not_before: None,
        steering: None,
        effects: Default::default(),
        publication: None,
    });
    let key = ExternalEffectKey {
        task,
        operation: Uuid::new_v4(),
    };
    for event in [
        ExternalEffectEvent::Prepared {
            key,
            descriptor: view.spec.input.clone(),
        },
        ExternalEffectEvent::Admitted {
            key,
            approval: None,
        },
        ExternalEffectEvent::CleanupObserved {
            key,
            cleanup: OperationCleanup::Confirmed,
        },
        ExternalEffectEvent::Returned {
            key,
            output: view.spec.input.clone(),
            finish_turn: true,
        },
    ] {
        apply_policy_fact(&mut view, Fact::ExternalEffect { event });
    }
    assert!(view.finish_requested());
    view.external.as_mut().unwrap().closed = Some(ExternalClosure {
        outcome: Terminal::Failed,
        diagnostic: Some("the executor closed its task as failed".into()),
        final_message: None,
    });

    assert!(matches!(
        next(&view, &Live::default(), UnixMillis(1), None, false),
        Action::Terminate(Terminal::Failed)
    ));
}

#[test]
fn an_approval_no_one_answered_in_time_counts_as_denied() {
    use maka_agent_facts::{
        accounting::Outcome,
        context::ModelPurpose,
        interaction::{ClosureReason, InteractionOutcome},
        model::ModelFinishReason,
    };
    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, _, attempt) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        true,
    );
    let tool = ToolKey {
        attempt,
        call: "continuation".into(),
    };
    apply_policy_fact(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        },
    );
    apply_policy_fact(
        &mut view,
        Fact::ApprovalRefused {
            approval: ApprovalId::new(),
            tool: tool.clone(),
            outcome: InteractionOutcome::Closure {
                reason: ClosureReason::TimedOut,
                committed_at: 1,
            },
        },
    );
    let Action::Reject(key, rejection) = next(&view, &Live::default(), UnixMillis(1), None, false)
    else {
        panic!("an unanswered approval must reject the call");
    };
    assert_eq!(key, tool);
    assert_eq!(
        rejection,
        ToolRejection::PolicyDenied {
            message: "No one approved this request in time".into()
        }
    );
}

fn admitted_side_effecting_call() -> (RunView, ToolKey) {
    use maka_agent_facts::{accounting::Outcome, context::ModelPurpose, model::ModelFinishReason};
    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let (mut view, _, attempt) = model_closure(
        view,
        ModelPurpose::Main,
        ModelFinishReason::Stop,
        Outcome::Success,
        true,
    );
    let tool = ToolKey {
        attempt,
        call: "continuation".into(),
    };
    let input = view.spec.input.clone();
    apply_policy_fact(
        &mut view,
        Fact::ToolDecided {
            tool: tool.clone(),
            decision: ToolDecision::Approved {
                input,
                resources: Vec::new(),
                approval: None,
                display: Default::default(),
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
            },
        },
    );
    apply_policy_fact(&mut view, Fact::ToolAdmitted { tool: tool.clone() });
    apply_policy_fact(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: maka_plugin_core::operation::OperationCleanup::Confirmed,
        },
    );
    (view, tool)
}

fn bind_host_operation(view: &mut RunView, tool: &ToolKey, cleanup: OperationCleanupState) {
    use maka_plugin_core::operation::{
        OperationOutcome, OperationReply, Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef,
    };
    let digest = format!(
        "sha256-{}",
        view.spec.input.digest.strip_prefix("sha256:").unwrap()
    );
    let reference = RecoveryRef {
        source: maka_plugin_core::deployment::DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: view.spec.owner.deployment,
            revision: 1,
        },
        namespace: view.spec.owner.namespace.clone(),
        export: "history".into(),
        method: "write".into(),
        operation: Uuid::new_v4(),
        fingerprint: digest.clone(),
        contract: RecoveryContract {
            name: "history".into(),
            version: 1,
            transport: maka_plugin_core::contract::Transport::Local,
            digest,
        },
        recovery: RecoveryProtocol::JournalV1,
    };
    apply_policy_fact(
        view,
        Fact::ToolOriginalBound {
            tool: tool.clone(),
            reference: reference.clone(),
        },
    );
    apply_policy_fact(
        view,
        Fact::OperationObserved {
            tool: tool.clone(),
            reply: OperationReply {
                reference,
                receipt: Receipt::Recorded {
                    outcome: OperationOutcome::Unknown {
                        diagnostic: "the provider closed the connection".into(),
                    },
                    cleanup,
                },
            },
        },
    );
}

type OperationCleanupState = maka_plugin_core::operation::OperationCleanup;

fn returned_unknown(view: &mut RunView, tool: &ToolKey) {
    let result = view.spec.input.clone();
    apply_policy_fact(
        view,
        Fact::LocalToolReturned {
            tool: tool.clone(),
            result,
            is_error: true,
            settlement: maka_agent_facts::tool_call::ToolSettlement::Unknown,
            cell_observation: None,
        },
    );
}

fn hand_back(view: &mut RunView, live: &Live, tool: &ToolKey) {
    let action = next(view, live, UnixMillis(1), None, false);
    assert!(
        matches!(&action, Action::Accept(key, AcceptedResult::OutcomeUnknown) if key == tool),
        "an ended call with an unknown result must go back to the model"
    );
    let result = ContentBlob::json(
        &maka_agent_facts::tool_output::AcceptedToolResult::OutcomeUnknown {
            diagnostic: "the server stopped answering".into(),
        },
    )
    .unwrap();
    apply_policy_fact(
        view,
        Fact::ToolResultAccepted {
            tool: tool.clone(),
            result: result.reference().clone(),
            outcome: AcceptedResult::OutcomeUnknown,
        },
    );
    assert!(view.recovery_failure().is_none());
    assert!(!view.has_unsettled_recovery());
}

#[test]
fn an_ended_call_with_an_unknown_result_goes_back_to_the_model() {
    // A Host operation whose cleanup is confirmed has ended.
    let (mut host, tool) = admitted_side_effecting_call();
    bind_host_operation(&mut host, &tool, OperationCleanupState::Confirmed);
    hand_back(&mut host, &Live::default(), &tool);
    assert!(view_continues(&host, &Live::default()));

    // A local call is known to have ended only from this activation's dispatch.
    let (mut local, tool) = admitted_side_effecting_call();
    returned_unknown(&mut local, &tool);
    let mut live = Live::default();
    live.ended_unknown.insert(tool.clone());
    hand_back(&mut local, &live, &tool);
    assert!(view_continues(&local, &live));

    // A Stop does not leave the ended call unsettled.
    let (mut stopped, tool) = admitted_side_effecting_call();
    returned_unknown(&mut stopped, &tool);
    apply_policy_fact(
        &mut stopped,
        Fact::StopRequested {
            diagnostic: "stopped by user".into(),
            requester: StopRequester::User,
        },
    );
    let mut live = Live::default();
    live.ended_unknown.insert(tool.clone());
    hand_back(&mut stopped, &live, &tool);
}

fn view_continues(view: &RunView, live: &Live) -> bool {
    matches!(
        next(view, live, UnixMillis(1), None, false),
        Action::Prepare(Preparation::ToolContinuation { .. })
    )
}

#[test]
fn a_call_that_may_still_be_running_keeps_its_recovery() {
    // The Host operation's cleanup is unconfirmed.
    let (mut host, tool) = admitted_side_effecting_call();
    bind_host_operation(&mut host, &tool, OperationCleanupState::Unconfirmed);
    assert!(!matches!(
        next(&host, &Live::default(), UnixMillis(1), None, false),
        Action::Accept(..)
    ));
    // An unknown local return without this activation's dispatch: a failed Cell
    // wait records one too, and so does a call recorded before a restart.
    let (mut local, tool) = admitted_side_effecting_call();
    returned_unknown(&mut local, &tool);
    assert!(!matches!(
        next(&local, &Live::default(), UnixMillis(1), None, false),
        Action::Accept(..)
    ));
}

#[test]
fn a_tool_call_from_an_overflowed_attempt_is_rejected_without_execution() {
    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let request = ContentBlob::json(&serde_json::json!({})).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::StepPrepared {
            step,
            request: request.reference().clone(),
            adjudications: vec![],
        },
    );
    apply_policy_fact(&mut view, Fact::ModelAttemptPrepared { attempt, step });
    apply_policy_fact(
        &mut view,
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::json!({}),
        },
    );
    let call_id = "call-before-overflow".to_owned();
    apply_policy_fact(
        &mut view,
        Fact::ModelObserved {
            attempt,
            index: 0,
            part: maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: call_id.clone(),
                    name: "Write".into(),
                    input: maka_agent_facts::model::ToolInput::Json(serde_json::json!({})),
                    provider_options: None,
                    provider_executed: false,
                },
            },
            continuation: None,
        },
    );
    apply_policy_fact(
        &mut view,
        Fact::ModelInterrupted {
            attempt,
            diagnostic: "context_length_exceeded".into(),
        },
    );
    // Before recovery is assessed, reconcile must assess instead of approving/executing the tool.
    assert!(matches!(
        next(&view, &Live::default(), UnixMillis(1), None, false),
        Action::Assess(id) if id == attempt
    ));
    apply_policy_fact(
        &mut view,
        Fact::AttemptRecoveryRecorded {
            attempt,
            recovery: AttemptRecovery::ContextOverflow {
                observed_output: true,
            },
        },
    );
    // After ContextOverflow recovery is recorded, the unadmitted tool call is rejected rather than executed.
    let key = ToolKey {
        attempt,
        call: call_id,
    };
    assert!(matches!(
        next(&view, &Live::default(), UnixMillis(1), None, false),
        Action::Reject(rejected, ToolRejection::PreparationFailed { .. }) if rejected == key
    ));
}

fn admitted_retry_view(retries: u32) -> (RunView, ContentRef) {
    let mut view = policy_view(None);
    view.spec.budget.retries = retries;
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let request = ContentBlob::json(&serde_json::json!({})).unwrap();
    (view, request.reference().clone())
}

fn fail_attempt(
    view: &mut RunView,
    step: StepId,
    request: &ContentRef,
    prepare_step: bool,
    recovery: AttemptRecovery,
) -> ModelAttemptId {
    use maka_plugin_core::operation::OperationCleanup;

    let attempt = ModelAttemptId::new();
    if prepare_step {
        apply_policy_fact(
            view,
            Fact::StepPrepared {
                step,
                request: request.clone(),
                adjudications: vec![],
            },
        );
    }
    for fact in [
        Fact::ModelAttemptPrepared { attempt, step },
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::Value::Null,
        },
        Fact::ModelInterrupted {
            attempt,
            diagnostic: "provider failed (TimedOut): stream interrupted".into(),
        },
        Fact::AttemptRecoveryRecorded { attempt, recovery },
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    ] {
        apply_policy_fact(view, fact);
    }
    attempt
}

fn closure_protocol(
    finish_reason: maka_agent_facts::model::ModelFinishReason,
) -> serde_json::Value {
    serde_json::to_value(ModelClosureProtocol {
        model_time_ms: None,
        finish_reason,
        provider_options: None,
        cache_read_reported: None,
        response_id: None,
        model: None,
        timestamp: None,
        compaction: None,
        summary: None,
    })
    .unwrap()
}

fn succeed_attempt(view: &mut RunView, step: StepId) -> ModelAttemptId {
    use maka_agent_facts::{accounting::Outcome, model::ModelFinishReason};
    use maka_plugin_core::operation::OperationCleanup;

    let attempt = ModelAttemptId::new();
    for fact in [
        Fact::ModelAttemptPrepared { attempt, step },
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::Value::Null,
        },
        Fact::ModelClosed {
            attempt,
            outcome: Outcome::Success,
            diagnostic: None,
            usage: Default::default(),
            protocol: closure_protocol(ModelFinishReason::Length),
        },
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    ] {
        apply_policy_fact(view, fact);
    }
    attempt
}

fn fallback_model_level(step: StepId, request: &ContentRef) -> ModelLevel {
    use maka_agent_facts::{
        accounting::ModelEvidence,
        composition::RequestComposition,
        context::{ModelFailureProtocol, ModelPurpose},
        input::RunInput,
        model::error::{ModelError, ProviderFailure, ProviderFailureReason},
    };

    ModelLevel {
        handoff: None,
        input: RunInput::HistorySource {
            source: request.clone(),
        },
        request: Some(RequestSpec {
            schema_version: SCHEMA_VERSION,
            step,
            composition: RequestComposition {
                surface: request.clone(),
                dynamic_context: vec![],
                tool_catalog_digest: request.digest.clone(),
                provider_options: None,
                max_output_tokens: None,
            },
            summary_repair_of: None,
            compaction_recovery: None,
            source_capture: request.clone(),
            source_digest: request.digest.clone(),
            effective_source_digest: request.digest.clone(),
            provenance: request.clone(),
            projection: None,
            adjudications: vec![],
            steering: vec![],
            request: request.clone(),
            protocol: "openai-responses".into(),
            protocol_version: 1,
            recovery_contract: request.clone(),
            request_contents: vec![],
            accounting: ModelEvidence {
                binding: ModelBinding {
                    connection_id: "policy".into(),
                    connection_slug: "policy".into(),
                    model: "policy".into(),
                },
                model_id: "policy".into(),
                purpose: ModelPurpose::Main,
                quote: None,
            },
        }),
        baseline: None,
        compaction: CompactionLevel::None,
        failure: Some(ModelFailureProtocol {
            failure: ModelError::Provider(ProviderFailure::new(
                ProviderFailureReason::TimedOut,
                "stream timed out",
                true,
                None,
            )),
            transport: None,
        }),
        fallback_available: true,
        codex: false,
    }
}

#[test]
fn retry_streak_persists_across_continue_from_history_and_resets_after_foreground_success() {
    use maka_agent_facts::{
        accounting::Outcome,
        model::{ModelFinishReason, retry_transport::RetryTransportPhase},
    };
    use maka_agent_state::fold::RetryStreak;
    use maka_plugin_core::operation::OperationCleanup;

    let (mut view, request) = admitted_retry_view(2);
    let now = UnixMillis(1);

    // Consecutive ContinueFromHistory failures mint a new StepId on each retry,
    // so the budget and backoff must stay bound to the streak instead of StepId.
    for expected_exponent in 0..2 {
        let failed = fail_attempt(
            &mut view,
            StepId::new(),
            &request,
            true,
            AttemptRecovery::ContinueFromHistory { not_before: None },
        );
        assert_eq!(view.retry_streak.backoff_exponent(), expected_exponent);
        assert!(matches!(
            next(&view, &Live::default(), now, None, false),
            Action::ChargeRetry(id, RetryTransportPhase::Primary) if id == failed
        ));
        apply_policy_fact(
            &mut view,
            Fact::RetryCharged {
                attempt: failed,
                phase: RetryTransportPhase::Primary,
                due_at: now,
                diagnostic: "continue from recorded history".into(),
            },
        );
    }

    // Background proactive summary success must not reset the foreground retry streak.
    let background = ModelAttemptId::new();
    for fact in [
        Fact::ProactiveSummaryPrepared {
            step: StepId::new(),
            request: request.clone(),
            attempt: background,
        },
        Fact::ModelAttemptAdmitted {
            attempt: background,
            upstream: serde_json::Value::Null,
        },
        Fact::ModelClosed {
            attempt: background,
            outcome: Outcome::Success,
            diagnostic: None,
            usage: Default::default(),
            protocol: closure_protocol(ModelFinishReason::Stop),
        },
        Fact::ModelCleanupObserved {
            attempt: background,
            cleanup: OperationCleanup::Confirmed,
        },
    ] {
        apply_policy_fact(&mut view, fact);
    }
    assert_eq!(view.retry_streak, RetryStreak::Regular { charged: 2 });

    // Third consecutive ContinueFromHistory failure on a fresh StepId exhausts the budget.
    let mut exhausted = view.clone();
    let _third = fail_attempt(
        &mut exhausted,
        StepId::new(),
        &request,
        true,
        AttemptRecovery::ContinueFromHistory { not_before: None },
    );
    assert!(matches!(
        next(&exhausted, &Live::default(), now, None, false),
        Action::Terminate(Terminal::Failed)
    ));

    // A successful foreground completion resets the streak and backoff for later Steps.
    let recovered_step = StepId::new();
    apply_policy_fact(
        &mut view,
        Fact::StepPrepared {
            step: recovered_step,
            request: request.clone(),
            adjudications: vec![],
        },
    );
    let _succeeded = succeed_attempt(&mut view, recovered_step);
    assert_eq!(view.retry_streak, RetryStreak::Regular { charged: 0 });
    assert_eq!(view.retry_streak.backoff_exponent(), 0);

    let next_failed = fail_attempt(
        &mut view,
        StepId::new(),
        &request,
        true,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    assert!(matches!(
        next(&view, &Live::default(), now, None, false),
        Action::ChargeRetry(id, RetryTransportPhase::Primary) if id == next_failed
    ));
}

#[test]
fn fallback_transition_retry_is_granted_once_even_with_zero_budget() {
    use maka_agent_facts::model::retry_transport::RetryTransportPhase;
    use maka_agent_state::fold::RetryStreak;

    let (mut view, request) = admitted_retry_view(0);
    let now = UnixMillis(1);
    let step1 = StepId::new();
    let a1 = fail_attempt(
        &mut view,
        step1,
        &request,
        true,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    let model1 = fallback_model_level(step1, &request);

    // Exhausted Primary (retries = 0) selects Fallback, then gets exactly one transition retry.
    assert!(matches!(
        next(&view, &Live::default(), now, Some(&model1), false),
        Action::SelectTransport(id, RetryTransportPhase::Fallback) if id == a1
    ));
    apply_policy_fact(
        &mut view,
        Fact::ModelTransportSelected {
            attempt: a1,
            phase: RetryTransportPhase::Fallback,
        },
    );
    assert_eq!(
        view.retry_streak,
        RetryStreak::FallbackTransitionPending { attempt: a1 }
    );
    assert_eq!(view.retry_streak.backoff_exponent(), 0);
    assert!(matches!(
        next(&view, &Live::default(), now, Some(&model1), false),
        Action::ChargeRetry(id, RetryTransportPhase::Fallback) if id == a1
    ));
    apply_policy_fact(
        &mut view,
        Fact::RetryCharged {
            attempt: a1,
            phase: RetryTransportPhase::Fallback,
            due_at: now,
            diagnostic: "fallback transition".into(),
        },
    );
    assert_eq!(
        view.retry_streak,
        RetryStreak::AfterFallbackTransition { charged: 0 }
    );
    assert_eq!(view.retry_streak.backoff_exponent(), 1);

    // If the Fallback attempt itself fails with retries = 0, no second Fallback retry is granted.
    let mut failed_fallback = view.clone();
    let _a2_fail = fail_attempt(
        &mut failed_fallback,
        step1,
        &request,
        false,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    assert!(matches!(
        next(
            &failed_fallback,
            &Live::default(),
            now,
            Some(&model1),
            false
        ),
        Action::Terminate(Terminal::Failed)
    ));

    // If Fallback succeeds, the one-time transition bonus must not recur on a later Step.
    let _a2_ok = succeed_attempt(&mut view, step1);
    assert_eq!(view.retry_streak, RetryStreak::Regular { charged: 0 });
    let step2 = StepId::new();
    let _a3 = fail_attempt(
        &mut view,
        step2,
        &request,
        true,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    let model2 = fallback_model_level(step2, &request);
    assert!(matches!(
        next(&view, &Live::default(), now, Some(&model2), false),
        Action::Terminate(Terminal::Failed)
    ));
}

#[test]
fn historical_run_wide_fallback_folds_after_earlier_step_succeeded() {
    use maka_agent_facts::model::retry_transport::RetryTransportPhase;
    use maka_agent_state::fold::RetryStreak;

    // Historical pre-streak Runs exhausted Primary budget on Step 1, succeeded,
    // and then immediately selected Fallback on Step 2's first failure.
    let (mut view, request) = admitted_retry_view(1);
    let now = UnixMillis(1);
    let step1 = StepId::new();
    let a1 = fail_attempt(
        &mut view,
        step1,
        &request,
        true,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    apply_policy_fact(
        &mut view,
        Fact::RetryCharged {
            attempt: a1,
            phase: RetryTransportPhase::Primary,
            due_at: now,
            diagnostic: "primary retry".into(),
        },
    );
    let _a2 = succeed_attempt(&mut view, step1);

    let step2 = StepId::new();
    let a3 = fail_attempt(
        &mut view,
        step2,
        &request,
        true,
        AttemptRecovery::FrozenRetrySafe { not_before: None },
    );
    apply_policy_fact(
        &mut view,
        Fact::ModelTransportSelected {
            attempt: a3,
            phase: RetryTransportPhase::Fallback,
        },
    );
    apply_policy_fact(
        &mut view,
        Fact::RetryCharged {
            attempt: a3,
            phase: RetryTransportPhase::Fallback,
            due_at: now,
            diagnostic: "fallback retry".into(),
        },
    );
    assert_eq!(
        view.retry_streak,
        RetryStreak::AfterFallbackTransition { charged: 0 }
    );
}

#[test]
fn an_overflow_whose_interruption_was_not_recorded_still_recovers() {
    let mut view = policy_view(None);
    let spec = ContentBlob::json(&view.spec).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
    );
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let request = ContentBlob::json(&serde_json::json!({})).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::StepPrepared {
            step,
            request: request.reference().clone(),
            adjudications: vec![],
        },
    );
    apply_policy_fact(&mut view, Fact::ModelAttemptPrepared { attempt, step });
    apply_policy_fact(
        &mut view,
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::json!({}),
        },
    );
    let protocol = maka_agent_facts::context::ModelFailureProtocol {
        failure: maka_model::ModelError::ContextOverflow {
            observed_output: true,
        },
        transport: None,
    };
    let failure = ContentBlob::json(&protocol).unwrap();
    apply_policy_fact(
        &mut view,
        Fact::ModelSourceFailureCaptured {
            attempt,
            failure: failure.reference().clone(),
        },
    );
    let mut model = fallback_model_level(step, request.reference());
    model.failure = Some(protocol.clone());
    // The stream's failure is recorded, but the interruption the driver published for it
    // lost a revision race, or the Host stopped before writing it.
    for _ in 0..2 {
        match next(&view, &Live::default(), UnixMillis(1), Some(&model), false) {
            Action::Interrupt(id, diagnostic) if id == attempt => apply_policy_fact(
                &mut view,
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic,
                },
            ),
            // The native adapter assesses a captured overflow as overflow recovery.
            Action::Assess(id) if id == attempt => apply_policy_fact(
                &mut view,
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::ContextOverflow {
                        observed_output: true,
                    },
                },
            ),
            _ => panic!("expected the overflowed attempt to be interrupted or assessed"),
        }
    }
    assert_eq!(
        view.attempts[&attempt].interrupted.as_deref(),
        Some(protocol.failure.to_string().as_str())
    );
    assert!(view.attempts[&attempt].compactable_overflow());
}

#[test]
fn a_tool_call_on_an_uninterrupted_overflow_is_rejected_without_execution() {
    let (mut view, request) = admitted_retry_view(0);
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    let call_id = "call-before-uninterrupted-overflow".to_owned();
    let failure = ContentBlob::json(&maka_agent_facts::context::ModelFailureProtocol {
        failure: maka_model::ModelError::ContextOverflow {
            observed_output: true,
        },
        transport: None,
    })
    .unwrap();
    for fact in [
        Fact::StepPrepared {
            step,
            request,
            adjudications: vec![],
        },
        Fact::ModelAttemptPrepared { attempt, step },
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: serde_json::json!({}),
        },
        Fact::ModelObserved {
            attempt,
            index: 0,
            part: maka_agent_facts::model::ModelPart::ToolCall {
                call: maka_agent_facts::model::ModelToolCall {
                    id: call_id.clone(),
                    name: "Write".into(),
                    input: maka_agent_facts::model::ToolInput::Json(serde_json::json!({})),
                    provider_options: None,
                    provider_executed: false,
                },
            },
            continuation: None,
        },
        Fact::ModelSourceFailureCaptured {
            attempt,
            failure: failure.reference().clone(),
        },
    ] {
        apply_policy_fact(&mut view, fact);
    }

    for _ in 0..2 {
        match next(&view, &Live::default(), UnixMillis(1), None, false) {
            Action::Interrupt(id, diagnostic) if id == attempt => apply_policy_fact(
                &mut view,
                Fact::ModelInterrupted {
                    attempt,
                    diagnostic,
                },
            ),
            Action::Assess(id) if id == attempt => apply_policy_fact(
                &mut view,
                Fact::AttemptRecoveryRecorded {
                    attempt,
                    recovery: AttemptRecovery::ContextOverflow {
                        observed_output: true,
                    },
                },
            ),
            _ => panic!("expected interrupt or assess before deciding tool"),
        }
    }

    let key = ToolKey {
        attempt,
        call: call_id,
    };
    assert!(matches!(
        next(&view, &Live::default(), UnixMillis(1), None, false),
        Action::Reject(rejected, ToolRejection::PreparationFailed { .. }) if rejected == key
    ));
}

fn pending_proactive_summary_model(attempt: ModelAttemptId, adopt: bool) -> ModelLevel {
    ModelLevel {
        handoff: None,
        input: maka_agent_facts::input::RunInput::ContextCompact {
            request_fingerprint: String::new(),
        },
        request: None,
        baseline: None,
        compaction: CompactionLevel::Pending { attempt, adopt },
        failure: None,
        fallback_available: false,
        codex: false,
    }
}

fn proactive_summary_base_view() -> (RunView, ModelAttemptId, ModelAttemptId) {
    let mut view = policy_view(None);
    let source = view.spec.input.clone();
    let spec = ContentBlob::json(&view.spec).unwrap();
    let step = StepId::new();
    let main = ModelAttemptId::new();
    let summary = ModelAttemptId::new();
    for fact in [
        Fact::RunAdmitted {
            spec: spec.reference().clone(),
        },
        Fact::StepPrepared {
            step,
            request: source.clone(),
            adjudications: vec![],
        },
        Fact::ModelAttemptPrepared {
            attempt: main,
            step,
        },
        Fact::ModelAttemptAdmitted {
            attempt: main,
            upstream: serde_json::json!({}),
        },
        Fact::ProactiveSummaryPrepared {
            step: StepId::new(),
            request: source,
            attempt: summary,
        },
    ] {
        apply_policy_fact(&mut view, fact);
    }
    (view, main, summary)
}

#[test]
fn proactive_summary_model_wait_waits_for_interruption_after_cleanup_confirmation() {
    use maka_plugin_core::operation::OperationCleanup;

    let (mut view, main, summary) = proactive_summary_base_view();
    let source = view.spec.input.clone();
    for fact in [
        Fact::ModelClosed {
            attempt: main,
            outcome: maka_agent_facts::accounting::Outcome::Success,
            diagnostic: None,
            usage: Default::default(),
            protocol: serde_json::json!({}),
        },
        Fact::ModelCleanupObserved {
            attempt: main,
            cleanup: OperationCleanup::Confirmed,
        },
        Fact::StepPrepared {
            step: StepId::new(),
            request: source,
            adjudications: vec![],
        },
    ] {
        apply_policy_fact(&mut view, fact);
    }

    let model = pending_proactive_summary_model(summary, true);
    let now = UnixMillis(1);
    let mut live = Live::default();

    assert!(matches!(
        next(&view, &live, now, Some(&model), false),
        Action::Idle
    ));

    apply_policy_fact(
        &mut view,
        Fact::ModelAttemptAdmitted {
            attempt: summary,
            upstream: serde_json::json!({}),
        },
    );
    live.work.insert(WorkKey::Model(summary));
    assert!(matches!(
        next(&view, &live, now, Some(&model), false),
        Action::Wait(WaitReason::Model { attempt }, None) if attempt == summary
    ));

    let wait_id = WaitId::new();
    let mut without_wait = view.clone();
    apply_policy_fact(
        &mut view,
        Fact::WaitRegistered {
            wait: wait_id,
            reason: WaitReason::Model { attempt: summary },
            due_at: None,
        },
    );

    let failure = ContentBlob::json(&serde_json::json!({"failure": "timed_out"})).unwrap();
    for fact in [
        Fact::ModelSourceFailureCaptured {
            attempt: summary,
            failure: failure.reference().clone(),
        },
        Fact::ModelCleanupObserved {
            attempt: summary,
            cleanup: OperationCleanup::Confirmed,
        },
    ] {
        apply_policy_fact(&mut view, fact.clone());
        apply_policy_fact(&mut without_wait, fact);
    }

    assert!(matches!(
        next(&view, &live, now, Some(&model), false),
        Action::Idle
    ));
    assert!(matches!(
        next(&without_wait, &live, now, Some(&model), false),
        Action::Idle
    ));

    live.work.remove(&WorkKey::Model(summary));
    apply_policy_fact(
        &mut view,
        Fact::ModelInterrupted {
            attempt: summary,
            diagnostic: "provider failed (TimedOut): model stream idle timeout exceeded".into(),
        },
    );
    assert!(matches!(
        next(&view, &live, now, Some(&model), false),
        Action::Satisfy(id) if id == wait_id
    ));
}

#[test]
fn context_overflow_does_not_register_model_wait_for_cleaned_up_open_proactive_summary() {
    use maka_plugin_core::operation::OperationCleanup;

    let (mut view, main, summary) = proactive_summary_base_view();
    for fact in [
        Fact::ModelAttemptAdmitted {
            attempt: summary,
            upstream: serde_json::json!({}),
        },
        Fact::ModelCleanupObserved {
            attempt: main,
            cleanup: OperationCleanup::Confirmed,
        },
        Fact::ModelInterrupted {
            attempt: main,
            diagnostic: "context overflow".into(),
        },
        Fact::AttemptRecoveryRecorded {
            attempt: main,
            recovery: AttemptRecovery::ContextOverflow {
                observed_output: false,
            },
        },
        Fact::ModelCleanupObserved {
            attempt: summary,
            cleanup: OperationCleanup::Confirmed,
        },
    ] {
        apply_policy_fact(&mut view, fact);
    }

    let model = pending_proactive_summary_model(summary, false);
    let mut live = Live::default();
    live.work.insert(WorkKey::Model(summary));
    assert!(matches!(
        next(&view, &live, UnixMillis(1), Some(&model), false),
        Action::Idle
    ));
}
