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

//! Plan decisions stay in the existing repository; the Agent owns all execution.
mod dispatch;
mod tools;
use super::*;
use maka_agent_facts::language::Language;
use maka_assistant::plan::{Command, Error, Phase, Request, Snapshot, repository::Repository};
use maka_capabilities::storage::{Data, Mutation, Namespace, Store};
use maka_plugin_core::operation::RecoveryRef;
use std::sync::{
    OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

pub(super) const EXECUTION: &str = "maka.plan.execute";
const ENTRY: &str = "maka.plan";
pub(super) struct Plans {
    storage: Arc<maka_host_runtime::storage::Storage>,
    gate: Mutex<()>,
    wake: Notify,
    changed: tokio::sync::watch::Sender<()>,
    owner: OnceLock<Weak<Owner>>,
    // Retirement hint only; published from canonical decisions under the gate.
    awake: AtomicBool,
}
impl Plans {
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        Self {
            storage: Arc::new(maka_host_runtime::storage::Storage::new(
                store,
                prefix,
                Namespace::new("maka.agent.plan", maka_plugin_core::scope::Scope::Profile)
                    .expect("plan namespace"),
            )),
            gate: Mutex::new(()),
            wake: Notify::new(),
            changed: tokio::sync::watch::channel(()).0,
            owner: OnceLock::new(),
            awake: AtomicBool::new(true),
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.owner
            .set(Arc::downgrade(owner))
            .expect("plan bound once");
    }
    pub fn keeps_host_awake(&self) -> bool {
        self.awake.load(Ordering::Acquire)
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
    pub fn execution_changed(&self) {
        self.wake.notify_one();
    }
    fn written(&self) {
        self.awake.store(true, Ordering::Release);
        self.changed.send_modify(|_| {});
        self.wake.notify_one();
    }
    fn repository(&self, session: &str) -> Result<Repository<MessageBasis>, String> {
        Repository::new(self.storage.clone(), ENTRY, session).map_err(reason)
    }
    async fn advance(
        &self,
        session: &str,
        snapshot: &Snapshot<MessageBasis>,
        command: Command<MessageBasis>,
    ) -> Result<Snapshot<MessageBasis>, String> {
        let request = Request {
            operation_id: identity(&(snapshot.revision, &command))?,
            expected_revision: snapshot.revision,
            command,
        };
        let next = self
            .repository(session)?
            .apply(&request, now())
            .await
            .map_err(reason)?;
        self.written();
        Ok(next)
    }
    async fn receipt(&self, reference: &RecoveryRef) -> Result<Option<PlanResult>, String> {
        self.storage
            .read(receipt_key(reference))
            .await
            .map_err(reason)?
            .map(|record| {
                let receipt: Receipt = serde_json::from_value(
                    record.data.value().cloned().ok_or("plan_receipt_invalid")?,
                )
                .map_err(reason)?;
                if receipt.reference != *reference {
                    return Err("plan_receipt_conflict".into());
                }
                Ok(receipt.result)
            })
            .transpose()
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    reference: RecoveryRef,
    result: PlanResult,
}
fn identity(value: &impl Serialize) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(value).map_err(reason)?,
    )))
}
fn receipt_key(reference: &RecoveryRef) -> String {
    format!(
        "receipt/{}",
        identity(reference).expect("operation reference")
    )
}
fn receipt_mutation(reference: &RecoveryRef, result: &PlanResult) -> Result<Mutation, String> {
    Ok(Mutation {
        key: receipt_key(reference),
        expected_revision: None,
        data: Data::Present(
            serde_json::to_value(Receipt {
                reference: reference.clone(),
                result: result.clone(),
            })
            .map_err(reason)?,
        ),
    })
}
fn detail(snapshot: Snapshot<MessageBasis>) -> PlanSnapshot {
    PlanSnapshot {
        revision: snapshot.revision,
        proposal: snapshot.proposal,
        execution: snapshot.execution.map(|execution| {
            let (phase, receipt, reason) = match execution.phase {
                Phase::AwaitingAdmission => (PlanPhase::AwaitingAdmission, None, None),
                Phase::Active { receipt } => (PlanPhase::Active, Some(receipt), None),
                Phase::Completed { receipt } => (PlanPhase::Completed, Some(receipt), None),
                Phase::Interrupted { receipt, reason } => {
                    (PlanPhase::Interrupted, receipt, Some(reason))
                }
                Phase::Cancelled { receipt, reason } => {
                    (PlanPhase::Cancelled, receipt, Some(reason))
                }
            };
            PlanExecution {
                id: execution.id,
                proposal_id: execution.proposal_id,
                artifact: execution.artifact,
                steps: execution.steps,
                phase,
                invocation: receipt.map(|receipt| receipt.invocation),
                reason,
                cancellation: execution.cancellation,
                updated_at: execution.updated_at,
            }
        }),
    }
}
impl Owner {
    pub fn plan_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.plans.changed.subscribe()
    }
    pub async fn plan(&self, input: PlanRead) -> Result<PlanView, String> {
        self.session(&input.session_id).await?;
        Ok(PlanView {
            enabled: self.settings.plans,
            current: detail(
                self.plans
                    .repository(&input.session_id)?
                    .current()
                    .await
                    .map_err(reason)?,
            ),
        })
    }
    pub async fn plan_history(&self, input: PlanHistoryRead) -> Result<PlanHistory, String> {
        self.session(&input.session_id).await?;
        let page = self
            .plans
            .repository(&input.session_id)?
            .history(input.through_revision, input.after)
            .await
            .map_err(reason)?;
        Ok(PlanHistory {
            through_revision: page.through_revision,
            snapshots: page.snapshots.into_iter().map(detail).collect(),
            next_after: page.next_after,
        })
    }
    pub async fn plan_receipt(&self, input: PlanReceiptRead) -> Result<Option<PlanResult>, String> {
        let reference = input.reference;
        if reference.source.state_domain != self.data_source.state_domain
            || reference.source.deployment != self.data_source.deployment
            || reference.namespace != self.data_source.namespace
            || reference.export != crate::EXPORT
            || reference.method != "changePlan"
        {
            return Err("plan_receipt_owner_invalid".into());
        }
        self.plans.receipt(&reference).await
    }
    pub async fn plan_change(
        self: &Arc<Self>,
        input: PlanChange,
        operation: RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<PlanResult, String> {
        if scope.identity.agent().is_some() {
            return Err("plan_user_approval_required".into());
        }
        self.session(&input.session_id).await?;
        let runs = self.runs.lock().await;
        if runs.closing || self.stop.is_cancelled() {
            return Err("agent_closed".into());
        }
        let owner = self.clone();
        let job = self.workers.spawn(async move {
            let _gate = owner.plans.gate.lock().await;
            if let Some(result) = owner.plans.receipt(&operation).await? {
                return Ok(result);
            }
            owner.change_plan(input, &operation).await
        });
        drop(runs);
        job.await
            .map_err(|_| "plan_operation_unknown".to_string())?
    }
    async fn plan_result(
        &self,
        operation: &RecoveryRef,
        result: PlanResult,
    ) -> Result<PlanResult, String> {
        self.plans
            .storage
            .batch(vec![receipt_mutation(operation, &result)?])
            .await
            .map_err(reason)?;
        Ok(result)
    }
    async fn plan_privacy(&self) -> Result<(), String> {
        if self
            .configuration
            .runtime_policy()
            .await
            .map_err(reason)?
            .policy
            .privacy
            .incognito_active
        {
            return Err("plan_incognito".into());
        }
        Ok(())
    }
    async fn plan_approval(
        &self,
        session: &str,
        proposal: &str,
        approval: PlanApproval,
    ) -> Result<MessageBasis, String> {
        self.plan_privacy().await?;
        if approval.target.session_id != session {
            return Err("plan_approval_session_changed".into());
        }
        let basis = self
            .approve_background(
                &approval.target,
                approval.model,
                approval.thinking_level,
                BackgroundKind::Plan(proposal.into()),
            )
            .await?;
        if basis
            .allowed_tools
            .as_ref()
            .is_some_and(|names| !names.iter().any(|name| name == "update_plan"))
        {
            return Err("plan_progress_tool_unavailable".into());
        }
        Ok(basis)
    }
    async fn change_plan(
        self: &Arc<Self>,
        input: PlanChange,
        operation: &RecoveryRef,
    ) -> Result<PlanResult, String> {
        if !self.settings.plans {
            return self
                .plan_result(
                    operation,
                    PlanResult::Rejected {
                        reason: "plan_disabled".into(),
                    },
                )
                .await;
        }
        let repo = self.plans.repository(&input.session_id)?;
        let snapshot = repo.current().await.map_err(reason)?;
        if snapshot.revision != input.revision {
            return self
                .plan_result(
                    operation,
                    PlanResult::Conflict {
                        actual: snapshot.revision,
                    },
                )
                .await;
        }
        let command: Result<_, String> = async { Ok(match input.action {
            PlanAction::Approve { proposal_id, proposal_revision, approval } => {
                let grant = self.plan_approval(&input.session_id, &proposal_id, approval).await?;
                Command::Approve { language: grant.language, grant, proposal_id, proposal_revision,
                    behavior: EXECUTION.to_owned().try_into().expect("Plan behavior") }
            },
            PlanAction::Resume { execution_id, approval } => {
                if self.store.session(&input.session_id).await.map_err(|error| error.to_string())?.latest_turn_boundary(&input.session_id).await.map_err(reason)?.is_some_and(|boundary|
                    matches!(boundary.state, maka_event_log::turns::InvocationState::Ended { outcome: maka_agent_facts::event::InvocationOutcome::HandoffPaused { .. }, .. })) {
                    return Err("plan_resume_session_first".into());
                }
                let execution = snapshot.execution.as_ref().filter(|execution| execution.id == execution_id).ok_or("plan_execution_changed")?;
                let grant = self.plan_approval(&input.session_id, &execution.proposal_id, approval).await?;
                Command::Resume { language: grant.language, grant, execution_id }
            },
            PlanAction::Revise { proposal_id } => Command::Revise { proposal_id },
            PlanAction::Abandon { proposal_id } => Command::Abandon { proposal_id },
            PlanAction::Cancel { execution_id, reason } => Command::Cancel { execution_id, reason, grant: None },
        }) }.await;
        let command = match command {
            Ok(command) => command,
            Err(reason) => {
                return self
                    .plan_result(operation, PlanResult::Rejected { reason })
                    .await;
            }
        };
        let request = Request {
            operation_id: identity(operation)?,
            expected_revision: input.revision,
            command,
        };
        let result = PlanResult::Committed {
            revision: input.revision + 1,
        };
        match repo
            .apply_with(&request, now(), vec![receipt_mutation(operation, &result)?])
            .await
        {
            Ok(_) => {
                self.plans.written();
                Ok(result)
            }
            Err(Error::Conflict) => {
                self.plan_result(
                    operation,
                    PlanResult::Conflict {
                        actual: repo.current().await.map_err(reason)?.revision,
                    },
                )
                .await
            }
            Err(Error::Invalid(reason)) => {
                self.plan_result(operation, PlanResult::Rejected { reason })
                    .await
            }
            Err(error) => Err(reason(error)),
        }
    }
    pub(in crate::owner) async fn check_plan_background(
        &self,
        session: &str,
        proposal: &str,
        basis: &MessageBasis,
    ) -> Result<(), String> {
        self.plan_privacy().await?;
        let snapshot = self
            .plans
            .repository(session)?
            .current()
            .await
            .map_err(reason)?;
        let execution = snapshot.execution.ok_or("plan_execution_missing")?;
        if execution.proposal_id != proposal
            || execution.cancellation.is_some()
            || !matches!(
                execution.phase,
                Phase::AwaitingAdmission | Phase::Active { .. }
            )
            || (!basis.fingerprint.is_empty() && basis.fingerprint != identity(&execution.request)?)
        {
            return Err("plan_execution_stopped".into());
        }
        Ok(())
    }
    pub(in crate::owner) async fn prepare_plan_behavior(
        &self,
        session: &str,
        basis: &mut MessageBasis,
    ) -> Result<(), String> {
        let planning = basis.collaboration_mode == CollaborationMode::Plan;
        let executing = matches!(basis.background_kind, BackgroundKind::Plan(_));
        if !planning && !executing {
            return Ok(());
        }
        if !self.settings.plans {
            return Err("plan_disabled".into());
        }
        let instructions = if planning {
            match basis.language {
                Language::En => {
                    "You are planning a change for user approval. Inspect and discuss only. Workspace mutation, Shell, subagents and autonomous workflows are unavailable. SubmitPlan proposes concrete ordered steps and material risks for approval; submission ends this planning Turn without starting implementation."
                }
                Language::ZhCn => {
                    "你正在规划变更，供用户批准。仅检查和讨论；不能修改工作区、使用 Shell、Subagent 或自主工作流。通过 SubmitPlan 提交具体有序步骤及重大风险，供用户批准；提交会结束此规划轮次，不会开始实现。"
                }
                Language::ZhTw => {
                    "你正在規劃變更，供使用者批准。僅檢查和討論；不能修改工作區、使用 Shell、Subagent 或自主工作流程。透過 SubmitPlan 提交具體有序步驟及重大風險，供使用者批准；提交會結束此規劃回合，不會開始實作。"
                }
            }
        } else {
            match basis.language {
                Language::En => {
                    "Execute the frozen user-approved Plan in the opening message. Record step status through update_plan; completion requires evidence and takes effect only after execution succeeds. cancel_plan is for user-requested abandonment."
                }
                Language::ZhCn => {
                    "执行开头消息中已冻结且经用户批准的计划。通过 update_plan 记录步骤状态；完成需要证据，且仅在执行成功结束后生效。cancel_plan 用于用户要求放弃执行时。"
                }
                Language::ZhTw => {
                    "執行開頭訊息中已凍結且經使用者批准的計劃。透過 update_plan 記錄步驟狀態；完成需要證據，且僅在執行成功結束後生效。cancel_plan 用於使用者要求放棄執行時。"
                }
            }
        };
        let prompt = basis.behavior.get_or_insert_with(|| SystemPrompt {
            text: String::new(),
            policy_revision: 0,
            sources: vec![self.revision.clone()],
        });
        prompt.text.push_str("\n\n");
        prompt.text.push_str(instructions);
        if planning {
            let snapshot = self
                .plans
                .repository(session)?
                .current()
                .await
                .map_err(reason)?;
            if let Some(proposal) = snapshot.proposal {
                prompt.text.push_str(match basis.language {
                    Language::En => "\nCurrent Plan proposal for review and revision:\n",
                    Language::ZhCn => "\n当前待审阅和修订的计划提案：\n",
                    Language::ZhTw => "\n目前待審閱和修訂的計劃提案：\n",
                });
                prompt
                    .text
                    .push_str(&serde_json::to_string(&proposal).map_err(reason)?);
            }
        }
        prompt.validate().map_err(str::to_owned)
    }
}
pub(super) fn select(
    catalog: &maka_tools::ToolCatalog,
    basis: &MessageBasis,
    planning: &[String],
) -> maka_tools::ToolCatalog {
    let names = catalog.names();
    let excluded: Vec<_> = names
        .iter()
        .filter(|name| {
            if basis.collaboration_mode == CollaborationMode::Plan {
                !planning.contains(name)
            } else if matches!(basis.background_kind, BackgroundKind::Plan(_)) {
                name.as_str() == "SubmitPlan"
            } else {
                matches!(name.as_str(), "SubmitPlan" | "update_plan" | "cancel_plan")
            }
        })
        .map(String::as_str)
        .collect();
    catalog.excluding(&excluded)
}
fn reason(error: impl std::fmt::Display) -> String {
    error.to_string()
}
