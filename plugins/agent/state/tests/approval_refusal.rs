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

mod support;

use maka_agent_facts::{
    accounting::Outcome,
    durable::*,
    interaction::{
        ClosureReason, InteractionOutcome, InteractionRecord, InteractionRequest,
        PermissionDecision, PermissionRequest, PermissionScope,
    },
    model::{ModelPart, ModelToolCall, ModelUsage},
    tool_call::ToolRejection,
    tool_output::AcceptedToolResult,
};
use maka_agent_state::{
    Admission, Change, ContentBlob, Store, fold, interactions::ApprovalBinding,
};
use maka_event_log::root_store::RootStore;
use maka_plugin_core::operation::OperationCleanup;
use maka_sandbox::{
    Network,
    grant::Permissions,
    workspace::{BindingStamp, PermissionBasis},
};
use serde_json::json;

struct Approval {
    run: RunId,
    tool: ToolKey,
    binding: ApprovalBinding,
    record: InteractionRecord,
    wait: WaitId,
}

async fn establish(root: &RootStore, state: &Store, session: &str) -> Approval {
    let workspace = root
        .attach_workspace("fixture", &json!({"path":"/fixture"}))
        .await
        .unwrap();
    root.create_session(
        session,
        &format!("create:{session}"),
        &json!({"workspace":workspace,"boundary_revision":0}),
        1,
    )
    .await
    .unwrap();
    let stamp = BindingStamp {
        id: workspace.id,
        permission_epoch: workspace.permission_epoch_at_attach,
    };
    let basis = PermissionBasis {
        binding: stamp,
        boundary_revision: workspace.boundary_revision(0, stamp).unwrap(),
    };
    let (mut spec, contents) = support::spec(session, "turn", "question");
    spec.permission_basis = basis;
    let admission = Admission::new(spec, UnixMillis(1), contents);
    let run = admission.run();
    state.admit(admission).await.unwrap();
    let (step, request, contents) = support::request(vec![]);
    let attempt = ModelAttemptId::new();
    let tool = ToolKey {
        attempt,
        call: "original-call".into(),
    };
    support::append(
        state,
        run,
        vec![
            Fact::StepPrepared {
                step,
                request: request.reference().clone(),
                adjudications: vec![],
            },
            Fact::ModelAttemptPrepared { attempt, step },
            Fact::ModelAttemptAdmitted {
                attempt,
                upstream: json!({"original":true}),
            },
            Fact::ModelObserved {
                attempt,
                index: 0,
                part: ModelPart::ToolCall {
                    call: ModelToolCall {
                        id: tool.call.clone(),
                        name: "fixture_tool".into(),
                        input: json!({"value":1}).into(),
                        provider_options: None,
                        provider_executed: false,
                    },
                },
                continuation: None,
            },
            Fact::ModelClosed {
                attempt,
                outcome: Outcome::Success,
                diagnostic: None,
                usage: ModelUsage::default(),
                protocol: json!({}),
            },
            Fact::ModelCleanupObserved {
                attempt,
                cleanup: OperationCleanup::Confirmed,
            },
        ],
        contents,
    )
    .await;
    let input = ContentBlob::json(&json!({"value":1})).unwrap();
    let binding = ApprovalBinding {
        approval: ApprovalId::new(),
        phase: maka_agent_state::interactions::ApprovalPhase::Preparation,
        target: AuthorizationObligation::Tool { tool: tool.clone() },
        input: input.reference().clone(),
        resources: vec![],
    };
    let record = InteractionRecord {
        execution: ExecutionIdentity {
            session_id: session.into(),
            turn_id: "turn".into(),
            run_id: run,
        },
        request_id: format!("approval-{run}"),
        created_at: 10,
        request: InteractionRequest::Permissions {
            target: binding.target.clone(),
            tool_use_id: Some(maka_agent_facts::tool_call::tool_use_id(
                run,
                &fold::tool_key(&tool),
            )),
            basis,
            request: PermissionRequest {
                reason: "one original tool call needs network".into(),
                command: None,
                permissions: Permissions {
                    filesystem: vec![],
                    network: Network::Allowed,
                },
            },
        },
        outcome: None,
    };
    let claim = state.claim(run).await.unwrap();
    let view = state.frontier(run).await.unwrap();
    state
        .interactions()
        .establish(
            &claim,
            (&view).into(),
            record.clone(),
            Some(binding.clone()),
            vec![input],
        )
        .await
        .unwrap();
    Approval {
        run,
        tool,
        binding,
        record,
        wait: WaitId::new(),
    }
}

async fn park(state: &Store, approval: &Approval) {
    support::append(
        state,
        approval.run,
        vec![
            Fact::ToolDecided {
                tool: approval.tool.clone(),
                decision: ToolDecision::Approved {
                    semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                    input: approval.binding.input.clone(),
                    resources: vec![],
                    approval: Some(approval.binding.approval),
                    display: ToolDisplay::default(),
                },
            },
            Fact::WaitRegistered {
                wait: approval.wait,
                reason: WaitReason::Approval {
                    approval: approval.binding.approval,
                },
                due_at: None,
            },
        ],
        vec![],
    )
    .await;
}
async fn ready(state: &Store, run: RunId) -> bool {
    state
        .ready_runs(support::owner(), UnixMillis(100), None, 128)
        .await
        .unwrap()
        .iter()
        .any(|entry| entry.run == run)
}
fn denial() -> InteractionOutcome {
    InteractionOutcome::PermissionsDecision {
        decision: PermissionDecision::Deny,
        committed_at: 50,
    }
}

#[tokio::test]
async fn denied_approval_park_wakes_cold_owner_without_grant_or_implicit_wait_ack() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    let approval = establish(&root, &state, "session").await;
    park(&state, &approval).await;
    assert!(!ready(&state, approval.run).await);
    let before = state.frontier(approval.run).await.unwrap();
    let forged = Change::new(
        Fact::ApprovalRefused {
            approval: approval.binding.approval,
            tool: approval.tool.clone(),
            outcome: denial(),
        },
        UnixMillis(50),
    );
    assert!(
        state
            .control(approval.run, (&before).into(), vec![forged], vec![])
            .await
            .is_err()
    );
    let answer = state
        .interactions()
        .commit_outcome("session", &approval.record.request_id, denial())
        .await
        .unwrap();
    assert_eq!(answer.outcome, Some(denial()));
    assert!(ready(&state, approval.run).await);
    let view = state.frontier(approval.run).await.unwrap();
    let tool = view.tools.get(&fold::tool_key(&approval.tool)).unwrap();
    assert_eq!(tool.approval_refusal.as_ref().unwrap().outcome, denial());
    assert!(!tool.admitted);
    assert!(!view.approvals.contains_key(&approval.binding.approval));
    assert!(view.waits.get(&approval.wait).unwrap().satisfied.is_none());
    assert!(view.waits.get(&approval.wait).unwrap().cancelled.is_none());
    assert!(
        state
            .interactions()
            .permission_grants(
                &approval.record.execution,
                Some(&approval.binding.target),
                &view.spec.permission_basis
            )
            .await
            .unwrap()
            .is_empty()
    );
    let claimed = state.claim(approval.run).await.unwrap();
    assert!(
        state
            .append(
                &claimed,
                (&view).into(),
                vec![
                    Change::new(
                        Fact::ApprovalConsumed {
                            approval: approval.binding.approval,
                            tool: approval.tool.clone()
                        },
                        UnixMillis(51)
                    ),
                    Change::new(
                        Fact::ToolAdmitted {
                            tool: approval.tool.clone()
                        },
                        UnixMillis(51)
                    )
                ],
                vec![]
            )
            .await
            .is_err()
    );
    let before = state.frontier(approval.run).await.unwrap();
    assert!(
        state
            .control(
                approval.run,
                (&before).into(),
                vec![Change::new(
                    Fact::ApprovalRecorded {
                        approval: approval.binding.approval,
                        tool: approval.tool.clone(),
                        input_digest: approval.binding.input.digest.clone(),
                        expires_at: None
                    },
                    UnixMillis(51)
                )],
                vec![]
            )
            .await
            .is_err()
    );
    let history = state.history(approval.run, 0, 128).await.unwrap();
    let refusal=history.iter().find(|record|matches!(&record.fact,Fact::ApprovalRefused{approval:original,..} if *original==approval.binding.approval)).unwrap().clone();
    root.close().await.unwrap();
    let root = support::open(directory.path(), true).await;
    let state = support::state(&root);
    assert!(ready(&state, approval.run).await);
    assert_eq!(
        state.fact(approval.run, refusal.id).await.unwrap(),
        Some(refusal)
    );
    assert_eq!(
        state
            .interactions()
            .read("session", &approval.record.request_id)
            .await
            .unwrap(),
        Some(answer.clone())
    );
    assert!(
        state
            .interactions()
            .pending("session")
            .await
            .unwrap()
            .records
            .is_empty()
    );
    let retry = state
        .interactions()
        .commit_outcome(
            "session",
            &approval.record.request_id,
            InteractionOutcome::PermissionsDecision {
                decision: PermissionDecision::Allow {
                    permissions: Permissions {
                        filesystem: vec![],
                        network: Network::Allowed,
                    },
                    scope: PermissionScope::Once,
                },
                committed_at: 99,
            },
        )
        .await
        .unwrap();
    assert_eq!(retry, answer);
    state.rebuild(approval.run).await.unwrap();
    assert_eq!(state.history(approval.run, 0, 128).await.unwrap(), history);
    assert!(ready(&state, approval.run).await);
    assert!(
        state
            .frontier(approval.run)
            .await
            .unwrap()
            .approvals
            .is_empty()
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn refusal_before_tool_decision_preserves_the_original_callback_id_and_still_cannot_dispatch()
{
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    let approval = establish(&root, &state, "session").await;
    state
        .interactions()
        .commit_outcome("session", &approval.record.request_id, denial())
        .await
        .unwrap();
    support::append(
        &state,
        approval.run,
        vec![Fact::ToolDecided {
            tool: approval.tool.clone(),
            decision: ToolDecision::Approved {
                semantics: maka_agent_facts::tools::ToolSemantics::Parallel,
                input: approval.binding.input.clone(),
                resources: vec![],
                approval: Some(approval.binding.approval),
                display: ToolDisplay::default(),
            },
        }],
        vec![],
    )
    .await;
    let view = state.frontier(approval.run).await.unwrap();
    let tool = view.tools.get(&fold::tool_key(&approval.tool)).unwrap();
    assert_eq!(
        tool.approval_refusal.as_ref().unwrap().approval,
        approval.binding.approval
    );
    assert_eq!(tool.approval_refusal.as_ref().unwrap().outcome, denial());
    assert!(!tool.admitted);
    let claim = state.claim(approval.run).await.unwrap();
    assert!(
        state
            .append(
                &claim,
                (&view).into(),
                vec![Change::new(
                    Fact::ToolAdmitted {
                        tool: approval.tool.clone()
                    },
                    UnixMillis(51)
                )],
                vec![]
            )
            .await
            .is_err()
    );
    assert_eq!(
        state
            .interactions()
            .read("session", &approval.record.request_id)
            .await
            .unwrap()
            .unwrap()
            .outcome,
        Some(denial())
    );
    root.close().await.unwrap();
}

#[tokio::test]
async fn closure_and_positive_answer_both_release_only_the_original_approval_wait_level() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    for (session, outcome, positive) in [
        (
            "closure",
            InteractionOutcome::Closure {
                reason: ClosureReason::ProducerCancelled,
                committed_at: 50,
            },
            false,
        ),
        (
            "allowed",
            InteractionOutcome::PermissionsDecision {
                decision: PermissionDecision::Allow {
                    permissions: Permissions {
                        filesystem: vec![],
                        network: Network::Allowed,
                    },
                    scope: PermissionScope::Once,
                },
                committed_at: 50,
            },
            true,
        ),
    ] {
        let approval = establish(&root, &state, session).await;
        park(&state, &approval).await;
        assert!(!ready(&state, approval.run).await);
        state
            .interactions()
            .commit_outcome(session, &approval.record.request_id, outcome.clone())
            .await
            .unwrap();
        assert!(ready(&state, approval.run).await);
        let view = state.frontier(approval.run).await.unwrap();
        assert_eq!(
            view.approvals.contains_key(&approval.binding.approval),
            positive
        );
        assert_eq!(
            view.tools
                .get(&fold::tool_key(&approval.tool))
                .unwrap()
                .approval_refusal
                .is_none(),
            positive
        );
        assert!(view.waits.get(&approval.wait).unwrap().satisfied.is_none());
        let grants = state
            .interactions()
            .permission_grants(
                &approval.record.execution,
                Some(&approval.binding.target),
                &view.spec.permission_basis,
            )
            .await
            .unwrap();
        assert_eq!(grants.len(), usize::from(positive));
        if !positive {
            support::create(&root, "timer-child").await;
            let child = support::admit(&state, "timer-child", "child-turn", "child").await;
            support::append(
                &state,
                approval.run,
                vec![Fact::WaitRegistered {
                    wait: WaitId::new(),
                    reason: WaitReason::Child { run: child },
                    due_at: Some(UnixMillis(1000)),
                }],
                vec![],
            )
            .await;
            assert!(!ready(&state, approval.run).await);
            assert_eq!(
                state.next_due_wait(support::owner()).await.unwrap(),
                Some(UnixMillis(1000))
            );
        }
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn terminal_late_denial_remains_original_history_without_new_run_fact_or_ready_state() {
    let directory = tempfile::tempdir().unwrap();
    let root = support::open(directory.path(), false).await;
    let state = support::state(&root);
    let approval = establish(&root, &state, "session").await;
    park(&state, &approval).await;
    let result = ContentBlob::json(&AcceptedToolResult::Rejected {
        diagnostic: "cancelled before dispatch".into(),
    })
    .unwrap();
    support::append(
        &state,
        approval.run,
        vec![
            Fact::WaitCancelled {
                wait: approval.wait,
                diagnostic: "run cancelled".into(),
            },
            Fact::ToolDecided {
                tool: approval.tool.clone(),
                decision: ToolDecision::Rejected {
                    rejection: ToolRejection::Cancelled,
                    display: ToolDisplay::default(),
                },
            },
            Fact::ToolResultAccepted {
                tool: approval.tool.clone(),
                result: result.reference().clone(),
                outcome: AcceptedResult::Rejected,
            },
            Fact::RunTerminated {
                terminal: Terminal::Cancelled,
                diagnostic: None,
            },
        ],
        vec![result],
    )
    .await;
    let original = state.history(approval.run, 0, 128).await.unwrap();
    let answer = state
        .interactions()
        .commit_outcome("session", &approval.record.request_id, denial())
        .await
        .unwrap();
    assert_eq!(answer.outcome, Some(denial()));
    assert_eq!(state.history(approval.run, 0, 128).await.unwrap(), original);
    assert!(!ready(&state, approval.run).await);
    let history = state.session_history(support::owner(), "session".into());
    let cut = history.capture().await.unwrap();
    let view = history.view_at(&cut, approval.run).await.unwrap();
    assert_eq!(view.terminal, Some(Terminal::Cancelled));
    assert_eq!(
        view.tools[&fold::tool_key(&approval.tool)]
            .accepted
            .as_ref()
            .unwrap()
            .outcome,
        AcceptedResult::Rejected
    );
    assert!(
        view.tools
            .get(&fold::tool_key(&approval.tool))
            .unwrap()
            .approval_refusal
            .is_none()
    );
    assert!(view.approvals.is_empty());
    root.close().await.unwrap();
}
