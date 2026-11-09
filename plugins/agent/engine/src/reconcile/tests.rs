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
    accounting::Outcome,
    cells::CellEvent,
    execution::{CollaborationMode, ModelBinding},
    language::Language,
    model::{ModelPart, ModelToolCall, ModelUsage},
};
use maka_agent_state::ContentBlob;
use maka_plugin_core::{
    composition::InstanceId,
    contract::Transport,
    deployment::DeploymentRef,
    operation::{
        OperationCleanup, OperationReply, RecoveryContract, RecoveryProtocol, RecoveryRef,
    },
};
use maka_sandbox::{
    Approval, Permissions, Sandbox,
    workspace::{BindingStamp, PermissionBasis},
};
use serde_json::json;
use uuid::Uuid;

const NOW: UnixMillis = UnixMillis(1_000);

fn content(value: &str) -> ContentRef {
    ContentBlob::json(&value).unwrap().reference().clone()
}

fn apply(view: &mut RunView, fact: Fact) {
    view.apply(&RecordedFact {
        schema_version: SCHEMA_VERSION,
        id: FactId::new(),
        run: view.run,
        revision: view.revision + 1,
        at: NOW,
        fact,
    })
    .unwrap();
}

fn admitted() -> RunView {
    let reference = content("pure policy fixture");
    let mut view = RunView::admitted(
        RunId::new(),
        RunSpec {
            schema_version: SCHEMA_VERSION,
            session_id: "session".into(),
            owner: RunOwner {
                deployment: Uuid::new_v4(),
                namespace: InstanceId(vec![Uuid::new_v4()]),
            },
            turn_id: "turn".into(),
            origin: RunOrigin::Local,
            trigger: Trigger::Message {
                message_id: "message".into(),
            },
            workspace: "/fixture".into(),
            permission_basis: PermissionBasis {
                boundary_revision: 0,
                binding: BindingStamp {
                    id: Uuid::new_v4(),
                    permission_epoch: 0,
                },
            },
            permission_ceiling: Permissions {
                sandbox: Sandbox::Disabled,
                approval: Approval::Never,
            },
            backend: BackendSpec::Model {
                binding: ModelBinding {
                    connection_id: "fixture".into(),
                    connection_slug: "fixture".into(),
                    model: "fixture".into(),
                },
                descriptor: reference.clone(),
            },
            collaboration: CollaborationMode::Agent,
            language: Language::En,
            tool_discovery: false,
            allowed_tools: None,
            mcp_revision: None,
            compaction_prompt: None,
            system_prompt: reference.clone(),
            tool_selection: reference.clone(),
            input: reference,
            budget: Budget {
                tokens: None,
                retries: 1,
                deadline: None,
            },
            budget_basis: None,
        },
    )
    .unwrap();
    apply(
        &mut view,
        Fact::RunAdmitted {
            spec: content("run spec"),
        },
    );
    view
}

fn start(view: &mut RunView) -> (StepId, ModelAttemptId) {
    let step = StepId::new();
    let attempt = ModelAttemptId::new();
    apply(
        view,
        Fact::StepPrepared {
            step,
            request: content("prepared request"),
            adjudications: vec![],
        },
    );
    apply(view, Fact::ModelAttemptPrepared { attempt, step });
    apply(
        view,
        Fact::ModelAttemptAdmitted {
            attempt,
            upstream: json!({"response": "original"}),
        },
    );
    (step, attempt)
}

fn tool(view: &mut RunView, call: &str) -> ToolKey {
    let attempt = view.current_attempt.unwrap();
    let index = view.attempts[&attempt].observed;
    let key = ToolKey {
        attempt,
        call: call.into(),
    };
    apply(
        view,
        Fact::ModelObserved {
            attempt,
            index,
            part: ModelPart::ToolCall {
                call: ModelToolCall {
                    id: call.into(),
                    name: "fixture_tool".into(),
                    input: json!({}).into(),
                    provider_options: None,
                    provider_executed: false,
                },
            },
            continuation: None,
        },
    );
    key
}

fn admit_tool(view: &mut RunView, key: &ToolKey) {
    apply(
        view,
        Fact::ToolDecided {
            tool: key.clone(),
            decision: ToolDecision::Approved {
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                input: content("tool input"),
                resources: vec![],
                approval: None,
                display: Default::default(),
            },
        },
    );
    apply(view, Fact::ToolAdmitted { tool: key.clone() });
}

fn interrupt(view: &mut RunView, attempt: ModelAttemptId) {
    apply(
        view,
        Fact::ModelInterrupted {
            attempt,
            diagnostic: "original transport disconnected".into(),
        },
    );
}

fn original_reference() -> RecoveryRef {
    RecoveryRef {
        source: DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::new_v4(),
            revision: 1,
        },
        namespace: InstanceId(vec![Uuid::new_v4()]),
        export: "effects".into(),
        method: "mutate".into(),
        operation: Uuid::new_v4(),
        fingerprint: format!("sha256-{}", "b".repeat(64)),
        contract: RecoveryContract {
            name: "fixture.effects".into(),
            version: 1,
            transport: Transport::Local,
            digest: format!("sha256-{}", "c".repeat(64)),
        },
        recovery: RecoveryProtocol::JournalV1,
    }
}

#[test]
fn stopped_original_sources_are_observed_before_interruption_or_generic_blocking() {
    let mut model = admitted();
    let (_, attempt) = start(&mut model);
    let descriptor = content("original model observation descriptor");
    apply(
        &mut model,
        Fact::AttemptRecoveryRecorded {
            attempt,
            recovery: AttemptRecovery::ObserveOriginal {
                descriptor: descriptor.clone(),
            },
        },
    );
    apply(
        &mut model,
        Fact::StopRequested {
            diagnostic: "user stop".into(),
        },
    );
    let mut live = Live::default();
    assert!(
        matches!(next(&model, &live, NOW, None), Action::ObserveModel(id, source)
        if id == attempt && source == descriptor)
    );
    live.models_observed.insert(attempt);
    apply(
        &mut model,
        Fact::Blocked {
            blocker: BlockerId::new(),
            reason: BlockerKind::CurrentAuthorityUnavailable {
                stage: AuthorityStage::BackendScope,
                diagnostic: "original observation unavailable".into(),
            },
        },
    );
    assert!(matches!(next(&model, &live, NOW, None), Action::Idle));

    let mut spec = admitted().spec;
    spec.backend = BackendSpec::Executor {
        selection: maka_agent_facts::executor::Selection {
            executor: "fixture".into(),
            settings: maka_agent_facts::executor::Settings {
                model: None,
                thinking_level: None,
                runtime: None,
            },
        },
        descriptor: content("original executor"),
    };
    let mut external = RunView::admitted(RunId::new(), spec).unwrap();
    apply(
        &mut external,
        Fact::RunAdmitted {
            spec: content("executor RunSpec"),
        },
    );
    let task = ExternalTaskId::new();
    let descriptor = content("original task observation descriptor");
    apply(
        &mut external,
        Fact::ExternalTaskPrepared {
            task,
            descriptor: descriptor.clone(),
        },
    );
    apply(&mut external, Fact::ExternalTaskAdmitted { task });
    apply(
        &mut external,
        Fact::StopRequested {
            diagnostic: "user stop".into(),
        },
    );
    assert!(matches!(
        next(&external, &Live::default(), NOW, None),
        Action::Idle
    ));
    apply(
        &mut external,
        Fact::ExternalTaskBound {
            task,
            descriptor: descriptor.clone(),
        },
    );
    assert!(
        matches!(next(&external, &Live::default(), NOW, None), Action::ObserveExternal(id, source)
        if id == task && source == descriptor)
    );
}

#[test]
fn stop_waits_for_live_cell_then_blocks_its_unresolved_original_child() {
    let mut view = admitted();
    let (step, attempt) = start(&mut view);
    let code = tool(&mut view, "running-code");
    admit_tool(&mut view, &code);
    let link = AgentStepLink {
        run: view.run,
        step,
        attempt,
    };
    let cell = CellId::for_agent(link, &code.call);
    let operation = Uuid::new_v4();
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::Started {
                cell,
                owner: CellOwner::Agent {
                    link,
                    call: code.call.clone(),
                },
                source: content("code"),
            },
        },
    );
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::ChildPrepared {
                cell,
                operation,
                name: "counter".into(),
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                input: content("original child input"),
                resources: vec![],
            },
        },
    );
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::ChildAdmitted { cell, operation },
        },
    );
    apply(
        &mut view,
        Fact::LocalToolReturned {
            tool: code.clone(),
            result: content("exec returned Running"),
            is_error: false,
            settlement: maka_agent_facts::tool_call::ToolSettlement::Returned,
        },
    );
    apply(
        &mut view,
        Fact::ToolResultAccepted {
            tool: code,
            result: content("accepted Running"),
            outcome: AcceptedResult::Succeeded,
        },
    );
    apply(
        &mut view,
        Fact::ModelClosed {
            attempt,
            outcome: Outcome::Success,
            diagnostic: None,
            usage: ModelUsage::default(),
            protocol: json!({}),
        },
    );
    apply(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    apply(
        &mut view,
        Fact::StopRequested {
            diagnostic: "user stop".into(),
        },
    );
    let mut live = Live::default();
    assert!(matches!(next(&view, &live, NOW, None), Action::ObserveCell(id) if id == cell));
    live.cells_observed.insert(cell);
    assert!(matches!(next(&view, &live, NOW, None), Action::Idle));
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::Interrupted {
                cell,
                report: content("original VM closure with unresolved counter"),
            },
        },
    );
    assert!(
        matches!(next(&view, &live, NOW, None), Action::Block(BlockerKind::CodeCellRecoveryUnavailable { cell: id }) if id == cell.to_string())
    );
    let child = &view.cells[&cell].children[&operation];
    assert!(child.admitted && !child.known() && child.reference.is_none() && child.reply.is_none());
}

#[test]
fn stop_drains_canonical_obligations_before_existing_cell_uncertainty() {
    let mut view = admitted();
    let (step, attempt) = start(&mut view);
    let code = tool(&mut view, "code");
    admit_tool(&mut view, &code);
    let pending = tool(&mut view, "pending");
    let link = AgentStepLink {
        run: view.run,
        step,
        attempt,
    };
    let cell = CellId::for_agent(link, &code.call);
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::Started {
                cell,
                owner: CellOwner::Agent {
                    link,
                    call: code.call.clone(),
                },
                source: content("code"),
            },
        },
    );
    apply(
        &mut view,
        Fact::Cell {
            event: CellEvent::VmCleanupUnconfirmed {
                cell,
                binding: None,
                diagnostic: "VM ownership is unresolved".into(),
            },
        },
    );
    let blocker = BlockerId::new();
    apply(
        &mut view,
        Fact::Blocked {
            blocker,
            reason: BlockerKind::CodeCellRecoveryUnavailable {
                cell: cell.to_string(),
            },
        },
    );
    let wait = WaitId::new();
    apply(
        &mut view,
        Fact::WaitRegistered {
            wait,
            reason: WaitReason::Blocker { blocker },
            due_at: None,
        },
    );
    apply(
        &mut view,
        Fact::StopRequested {
            diagnostic: "user stop".into(),
        },
    );
    let live = Live::default();

    assert!(matches!(next(&view, &live, NOW, None), Action::CancelWait(id) if id == wait));
    apply(
        &mut view,
        Fact::WaitCancelled {
            wait,
            diagnostic: "Run admission fence closed".into(),
        },
    );
    let Action::Reject(key, rejection) = next(&view, &live, NOW, None) else {
        panic!("an unadmitted tool must be rejected before observing the unknown Cell");
    };
    assert_eq!(key, pending);
    assert!(matches!(rejection, ToolRejection::Cancelled));
    apply(
        &mut view,
        Fact::ToolDecided {
            tool: key,
            decision: ToolDecision::Rejected {
                rejection,
                display: Default::default(),
            },
        },
    );
    assert!(
        matches!(next(&view, &live, NOW, None), Action::Accept(key, AcceptedResult::Rejected) if key == pending)
    );
    apply(
        &mut view,
        Fact::ToolResultAccepted {
            tool: pending,
            result: content("cancelled tool result"),
            outcome: AcceptedResult::Rejected,
        },
    );
    assert!(matches!(next(&view, &live, NOW, None), Action::Interrupt(id, _) if id == attempt));
}

#[test]
fn stopped_cold_lookup_does_not_consume_original_receipt_observation() {
    let mut view = admitted();
    let (_, attempt) = start(&mut view);
    let key = tool(&mut view, "effect");
    admit_tool(&mut view, &key);
    interrupt(&mut view, attempt);
    apply(
        &mut view,
        Fact::StopRequested {
            diagnostic: "user stop".into(),
        },
    );
    let mut live = Live::default();
    assert!(matches!(next(&view, &live, NOW, None), Action::Lookup(found) if found == key));
    live.looked_up.insert(key.clone());
    assert!(
        matches!(next(&view, &live, NOW, None), Action::Block(BlockerKind::OriginalAdmissionUnknown { tool }) if tool == key)
    );

    let reference = original_reference();
    apply(
        &mut view,
        Fact::ToolOriginalBound {
            tool: key.clone(),
            reference: reference.clone(),
        },
    );
    assert!(matches!(next(&view, &live, NOW, None), Action::Observe(found) if found == key));
    live.observed.insert(key.clone());
    apply(
        &mut view,
        Fact::OperationObserved {
            tool: key.clone(),
            reply: OperationReply {
                reference: reference.clone(),
                receipt: Receipt::NotRecorded,
            },
        },
    );
    let Action::Block(reason @ BlockerKind::OperationUnknown { .. }) =
        next(&view, &live, NOW, None)
    else {
        panic!("NotRecorded is not a non-execution proof or an accepted tool result");
    };
    apply(
        &mut view,
        Fact::Blocked {
            blocker: BlockerId::new(),
            reason,
        },
    );
    apply(
        &mut view,
        Fact::OperationObserved {
            tool: key.clone(),
            reply: OperationReply {
                reference,
                receipt: Receipt::Recorded {
                    outcome: OperationOutcome::Unknown {
                        diagnostic: "original outcome unavailable".into(),
                    },
                    cleanup: OperationCleanup::Unconfirmed,
                },
            },
        },
    );
    assert!(matches!(next(&view, &live, NOW, None), Action::Idle));
}

#[test]
fn real_closed_outcome_completes_without_waiting_for_model_observer_eof() {
    let mut view = admitted();
    let (_, earlier) = start(&mut view);
    let key = tool(&mut view, "rejected");
    apply(
        &mut view,
        Fact::ToolDecided {
            tool: key.clone(),
            decision: ToolDecision::Rejected {
                display: Default::default(),
                rejection: ToolRejection::PolicyDenied {
                    message: "not allowed".into(),
                },
            },
        },
    );
    apply(
        &mut view,
        Fact::ToolResultAccepted {
            tool: key,
            result: content("rejected result"),
            outcome: AcceptedResult::Rejected,
        },
    );
    interrupt(&mut view, earlier);
    apply(
        &mut view,
        Fact::AttemptRecoveryRecorded {
            attempt: earlier,
            recovery: AttemptRecovery::ProjectPrefixSafe {
                prefix: content("captured prefix proof"),
                not_before: None,
            },
        },
    );
    apply(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt: earlier,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    let (_, current) = start(&mut view);
    interrupt(&mut view, current);
    apply(
        &mut view,
        Fact::ModelClosed {
            attempt: current,
            outcome: Outcome::Success,
            diagnostic: None,
            usage: ModelUsage {
                input_tokens: Some(5),
                output_tokens: Some(3),
                cache_read_tokens: None,
                cache_write_tokens: None,
                reasoning_tokens: None,
            },
            protocol: json!({"finishReason":"stop","providerOptions":null,"responseId":null,"model":null,"timestamp":null,"compaction":null}),
        },
    );
    let mut live = Live::default();
    live.work.insert(WorkKey::Model(current));
    assert!(matches!(
        next(&view, &live, NOW, None),
        Action::Wait(WaitReason::Model { .. }, None)
    ));
    apply(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt: current,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    assert!(matches!(
        next(&view, &live, NOW, None),
        Action::Terminate(Terminal::Completed)
    ));
    live.work.insert(WorkKey::CancelModel(current));
    assert!(!live.only_cleanup(&view));
    assert!(matches!(next(&view, &live, NOW, None), Action::Idle));
    live.work.remove(&WorkKey::CancelModel(current));
    assert!(matches!(
        next(&view, &live, NOW, None),
        Action::Terminate(Terminal::Completed)
    ));
}

#[test]
fn same_base_replans_prepare_one_step_consuming_both_adjudications() {
    let mut view = admitted();
    let (base_step, attempt) = start(&mut view);
    interrupt(&mut view, attempt);
    let mut expected = BTreeSet::new();
    for label in ["protocol-one", "protocol-two"] {
        let blocker = BlockerId::new();
        let evidence = content(label);
        apply(
            &mut view,
            Fact::Blocked {
                blocker,
                reason: BlockerKind::UnsupportedProtocol {
                    protocol: label.into(),
                    version: 1,
                },
            },
        );
        apply(
            &mut view,
            Fact::RiskAdjudicated {
                blocker,
                decision: RiskDecision::AuthorizeReplan {
                    evidence: evidence.clone(),
                },
                scope: RiskActionScope::ModelReplan { attempt, base_step },
            },
        );
        expected.insert(blocker);
    }
    let live = Live::default();
    let Action::Prepare(Preparation::Replan {
        attempt: selected,
        adjudications,
    }) = next(&view, &live, NOW, None)
    else {
        panic!("same-base human decisions must prepare one combined replan");
    };
    assert_eq!(selected, Some(attempt));
    assert_eq!(adjudications.len(), 2);
    let selected: BTreeSet<_> = adjudications
        .iter()
        .map(|input| input.basis.blocker)
        .collect();
    assert_eq!(selected, expected);
    for input in &adjudications {
        assert_eq!(input.decision, view.replans[&input.basis.blocker].decision);
        assert!(
            matches!(&input.decision, RiskDecision::AuthorizeReplan { evidence } if evidence == &input.basis.evidence)
        );
    }
    let step = StepId::new();
    apply(
        &mut view,
        Fact::StepPrepared {
            step,
            request: content("combined replan request"),
            adjudications: selected.into_iter().collect(),
        },
    );
    assert!(
        matches!(next(&view, &live, NOW, None), Action::Wait(WaitReason::Model { attempt: waiting }, None) if waiting == attempt)
    );
    apply(
        &mut view,
        Fact::ModelCleanupObserved {
            attempt,
            cleanup: OperationCleanup::Confirmed,
        },
    );
    assert!(matches!(next(&view, &live, NOW, None), Action::Attempt(id) if id == step));
}

#[test]
fn accepted_unknown_risk_waits_for_original_cleanup_without_becoming_known() {
    let mut view = admitted();
    start(&mut view);
    let key = tool(&mut view, "unknown-effect");
    admit_tool(&mut view, &key);
    let reference = original_reference();
    apply(
        &mut view,
        Fact::ToolOriginalBound {
            tool: key.clone(),
            reference: reference.clone(),
        },
    );
    let unknown = OperationOutcome::Unknown {
        diagnostic: "original effect remains unknown".into(),
    };
    apply(
        &mut view,
        Fact::OperationObserved {
            tool: key.clone(),
            reply: OperationReply {
                reference: reference.clone(),
                receipt: Receipt::Recorded {
                    outcome: unknown.clone(),
                    cleanup: OperationCleanup::Unconfirmed,
                },
            },
        },
    );
    let blocker = BlockerId::new();
    apply(
        &mut view,
        Fact::Blocked {
            blocker,
            reason: BlockerKind::OperationUnknown {
                tool: key.clone(),
                reference: reference.clone(),
            },
        },
    );
    let wait = WaitId::new();
    apply(
        &mut view,
        Fact::WaitRegistered {
            wait,
            reason: WaitReason::Operation { tool: key.clone() },
            due_at: None,
        },
    );
    apply(
        &mut view,
        Fact::RiskAdjudicated {
            blocker,
            decision: RiskDecision::AuthorizeReplan {
                evidence: content("explicit risk acceptance"),
            },
            scope: RiskActionScope::Tool { tool: key.clone() },
        },
    );
    let live = Live::default();
    let acknowledged = OperationReply {
        reference,
        receipt: Receipt::Recorded {
            outcome: unknown,
            cleanup: OperationCleanup::Confirmed,
        },
    };
    let mut not_accepted = view.clone();
    apply(
        &mut not_accepted,
        Fact::OperationObserved {
            tool: key.clone(),
            reply: acknowledged.clone(),
        },
    );
    assert!(!matches!(next(&not_accepted, &live, NOW, None), Action::Satisfy(id) if id == wait));
    apply(
        &mut view,
        Fact::ToolResultAccepted {
            tool: key.clone(),
            result: content("accepted risk context"),
            outcome: AcceptedResult::RiskAdjudicated { blocker },
        },
    );
    assert!(!matches!(next(&view, &live, NOW, None), Action::Satisfy(id) if id == wait));
    apply(
        &mut view,
        Fact::OperationObserved {
            tool: key.clone(),
            reply: acknowledged.clone(),
        },
    );
    assert!(matches!(next(&view, &live, NOW, None), Action::Satisfy(id) if id == wait));
    let receipt = &view.tools[&maka_agent_state::fold::tool_key(&key)].receipt;
    assert!(!known(receipt));
    assert_eq!(receipt.as_ref(), Some(&acknowledged.receipt));
}
