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

//! Accepted graph epochs use the existing Agent admission and cleanup gates.
use super::*;
use crate::workhub::tasks::graph::{Graphs, receipt_mutation};
use maka_agent_api::workhub::graph as api;
use maka_agent_facts::language::Language;
use maka_graph::{Epoch, Mode};
use maka_plugin_core::operation::RecoveryRef;

pub(super) fn behavior(epoch: &Epoch) -> BehaviorId {
    format!(
        "maka.{}.{}",
        match epoch.mode {
            Mode::Graph => "graph",
            Mode::Swarm => "swarm",
        },
        epoch.graph_id
    )
    .try_into()
    .expect("native graph behavior")
}
impl Owner {
    pub(crate) async fn graph_privacy(&self) -> Result<(), String> {
        if self
            .configuration
            .runtime_policy()
            .await
            .map_err(|_| "graph_policy_unavailable")?
            .policy
            .privacy
            .incognito_active
        {
            return Err("graph_incognito".into());
        }
        Ok(())
    }
    pub(super) async fn graph_selected(&self, session: &str) -> Result<bool, String> {
        match &self.graphs {
            Some(graphs) => Ok(graphs
                .current(session)
                .await?
                .is_some_and(|control| control.selected)),
            None => Ok(false),
        }
    }
    pub(crate) async fn graph_invocation(&self, invocation: &Invocation) -> Result<Epoch, String> {
        self.graph_privacy().await?;
        let runs = self.runs.lock().await;
        let control = runs
            .controls
            .get(&invocation.session_id)
            .filter(|control| control.invocation == *invocation && control.failure.is_none())
            .ok_or("graph_source_inactive")?;
        let epoch = control.basis.graph.clone().ok_or("graph_source_invalid")?;
        let current = self
            .graphs
            .as_ref()
            .ok_or("graph_unavailable")?
            .current(&invocation.session_id)
            .await?
            .ok_or("graph_closed")?
            .epoch;
        if epoch != current {
            return Err("graph_epoch_changed".into());
        }
        Ok(epoch)
    }
    /// Publish only a versioned public choice for the supervisor's model.
    /// New worker admissions validate it; existing assignments keep their inputs.
    pub(crate) async fn graph_model_choice(
        &self,
        invocation: &Invocation,
    ) -> Result<Value, String> {
        let configuration = self
            .store
            .session(&invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_configuration(invocation)
            .await
            .map_err(|_| "graph_source_unavailable")?
            .ok_or("graph_source_missing")?;
        let Some(model) = configuration.model else {
            return Ok(Value::Null);
        };
        let catalog = self
            .configuration
            .catalog()
            .await
            .map_err(|_| "graph_models_unavailable")?;
        let Some(connection) = catalog.connections.into_iter().find(|row| {
            row.connection_id == model.connection_id
                && row.slug == model.connection_slug
                && row.enabled
                && row.enabled_model_ids.contains(&model.model)
        }) else {
            return Ok(Value::Null);
        };
        Ok(serde_json::json!({
            "model": crate::ModelSelection { connection_id: connection.connection_id, revision: connection.revision, model_id: model.model },
            "thinkingLevel": configuration.thinking_level,
        }))
    }
    pub(crate) async fn graph_target(
        &self,
        invocation: &Invocation,
    ) -> Result<ScheduledTarget, String> {
        let session = self.session(&invocation.session_id).await?;
        let configuration = self
            .store
            .session(&invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_configuration(invocation)
            .await
            .map_err(|_| "graph_source_unavailable")?
            .ok_or("graph_source_unavailable")?;
        if session.archived
            || session.configuration.boundary_revision != configuration.boundary_revision
            || Some(session.configuration.binding) != configuration.workspace_binding
            || session.configuration.workspace.identity
                != configuration
                    .workspace_identity
                    .ok_or("graph_workspace_unavailable")?
        {
            return Err("graph_authorization_changed".into());
        }
        Ok(ScheduledTarget {
            session_id: invocation.session_id.clone(),
            workspace: session.configuration.workspace,
            permissions: session.configuration.permissions,
            boundary_revision: session.configuration.boundary_revision,
            binding: session.configuration.binding,
        })
    }
    pub(crate) async fn graph_target_valid(
        &self,
        target: &ScheduledTarget,
    ) -> Result<bool, String> {
        if self.graph_privacy().await.is_err() {
            return Ok(false);
        }
        let session = self.session(&target.session_id).await?;
        Ok(!session.archived
            && session.configuration.workspace == target.workspace
            && session.configuration.permissions == target.permissions
            && session.configuration.boundary_revision == target.boundary_revision
            && session.configuration.binding == target.binding)
    }
    pub(super) async fn prepare_graph_behavior(
        &self,
        session: &str,
        basis: &mut MessageBasis,
        user_message: bool,
    ) -> Result<(), String> {
        let Some(graphs) = &self.graphs else {
            return Ok(());
        };
        let Some(control) = graphs
            .current(session)
            .await?
            .filter(|control| control.selected)
        else {
            return Ok(());
        };
        self.graph_privacy().await?;
        if basis.collaboration_mode != CollaborationMode::Agent
            || basis.executor.is_some()
            || basis.background.is_some()
        {
            return Err("graph_execution_conflict".into());
        }
        let epoch = if control.closed() {
            if !user_message {
                return Err("graph_epoch_closed".into());
            }
            if !graphs.quiescent(session, &control).await? {
                return Err("graph_previous_epoch_settling".into());
            }
            if !self
                .store
                .session(session)
                .await
                .map_err(|error| error.to_string())?
                .message_queue(session)
                .await
                .map_err(|_| "agent_queue_unavailable")?
                .entries
                .is_empty()
            {
                return Err("graph_pending_messages".into());
            }
            graphs.written();
            graphs
                .repository()?
                .open(
                    session,
                    control.epoch.mode,
                    Some(&control.epoch.graph_id),
                    now(),
                )
                .await
                .map_err(|e| e.to_string())?
        } else {
            control.epoch
        };
        let instructions = match epoch.mode {
            Mode::Graph => match basis.language {
                Language::En => {
                    "You are the Agent Graph supervisor. Coordinate bounded work through the graph; handle small requests directly."
                }
                Language::ZhCn => {
                    "你是 Agent Graph 主管，通过图协调边界明确的工作，小请求直接处理。"
                }
                Language::ZhTw => {
                    "你是 Agent Graph 主管，透過圖協調邊界明確的工作，小請求直接處理。"
                }
            },
            Mode::Swarm => match basis.language {
                Language::En => {
                    "You are the Agent Swarm supervisor. Prefer parallel delegation for independent work with non-overlapping writes; handle small or indivisible requests directly."
                }
                Language::ZhCn => {
                    "你是 Agent Swarm 主管，对独立且写入不重叠的工作优先并行委派；小请求或不可分任务直接处理。"
                }
                Language::ZhTw => {
                    "你是 Agent Swarm 主管，對獨立且寫入不重疊的工作優先平行委派；小請求或不可分任務直接處理。"
                }
            },
        };
        let prompt = basis.behavior.get_or_insert_with(|| {
            let mut source = self.revision.clone();
            source.kind = SourceKind::PromptSection;
            SystemPrompt {
                text: String::new(),
                policy_revision: 0,
                sources: vec![source],
            }
        });
        prompt.text.push_str("\n\n");
        prompt.text.push_str(instructions);
        prompt.text.push_str(&match basis.language {
            Language::En => format!(
                "\nCurrent graph: {}; epoch: {}.",
                epoch.graph_id, epoch.epoch
            ),
            Language::ZhCn => format!("\n当前图：{}；epoch：{}。", epoch.graph_id, epoch.epoch),
            Language::ZhTw => format!("\n目前圖：{}；epoch：{}。", epoch.graph_id, epoch.epoch),
        });
        basis.graph = Some(epoch);
        Ok(())
    }
    pub(super) async fn validate_graph_basis(
        &self,
        session: &str,
        basis: &MessageBasis,
    ) -> Result<(), String> {
        match (&self.graphs, &basis.graph) {
            (Some(graphs), Some(epoch)) => {
                self.graph_privacy().await?;
                if graphs.active(session).await?.as_ref() != Some(epoch) {
                    return Err("graph_epoch_changed".into());
                }
            }
            (None, Some(_)) => return Err("graph_unavailable".into()),
            (_, None) if self.graph_selected(session).await? => {
                return Err("graph_behavior_changed".into());
            }
            _ => {}
        }
        Ok(())
    }
    pub(super) async fn resume_graph(
        &self,
        session: &str,
        source: &BehaviorId,
    ) -> Result<Option<Epoch>, String> {
        let graph_behavior = source.as_str().starts_with("maka.graph.")
            || source.as_str().starts_with("maka.swarm.");
        let current = match &self.graphs {
            Some(graphs) => graphs.active(session).await?,
            None => None,
        };
        match current {
            Some(epoch) if graph_behavior && behavior(&epoch) == *source => {
                self.graph_privacy().await?;
                Ok(Some(epoch))
            }
            None if !graph_behavior && !self.graph_selected(session).await? => Ok(None),
            _ => Err("graph_resume_epoch_changed".into()),
        }
    }
    pub(crate) async fn graph_change(
        self: &Arc<Self>,
        input: api::Change,
        operation: RecoveryRef,
        scope: &maka_capabilities::call::Scope,
    ) -> Result<api::Changed, String> {
        if scope.identity.agent().is_some() {
            return Err("graph_user_control_required".into());
        }
        let graphs = self.graphs.clone().ok_or("graph_unavailable")?;
        let owner = self.clone();
        let cancellation = scope.cancellation.clone();
        self.workers
            .spawn(async move {
                let _gate = graphs.gate.lock().await;
                if let Some(result) = graphs.receipt(&operation).await? {
                    return Ok(result);
                }
                if cancellation.is_cancelled() {
                    return Err("graph_control_cancelled".into());
                }
                let runs = owner.runs.lock().await;
                if runs.closing || owner.stop.is_cancelled() {
                    return Err("agent_closed".into());
                }
                let session = owner.session(&input.session_id).await?;
                let current = graphs.current(&input.session_id).await?;
                if current.as_ref().map(|c| &c.epoch.graph_id) != input.expected_graph_id.as_ref() {
                    return graphs
                        .record_control(
                            &operation,
                            api::Changed::Conflict {
                                current: current.map(|c| c.epoch),
                            },
                        )
                        .await;
                }
                match input.action {
                    api::Action::Start { mode } => {
                        if let Err(reason) = owner
                            .graph_start_allowed(&graphs, &session, &runs, current.as_ref())
                            .await
                        {
                            return graphs
                                .record_control(&operation, api::Changed::Rejected { reason })
                                .await;
                        }
                        graphs.written();
                        let epoch = graphs
                            .repository()?
                            .open_with(
                                &input.session_id,
                                mode,
                                current.as_ref().map(|c| &c.epoch.graph_id),
                                now(),
                                |epoch| {
                                    receipt_mutation(
                                        &operation,
                                        &api::Changed::Committed {
                                            epoch: epoch.clone(),
                                        },
                                    )
                                    .map(|mutation| vec![mutation])
                                    .map_err(maka_graph::Error::Persistence)
                                },
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(api::Changed::Committed { epoch })
                    }
                    api::Action::Stop | api::Action::Leave => {
                        let Some(current) = current else {
                            return graphs
                                .record_control(
                                    &operation,
                                    api::Changed::Rejected {
                                        reason: "graph_missing".into(),
                                    },
                                )
                                .await;
                        };
                        let source = runs
                            .controls
                            .get(&input.session_id)
                            .filter(|control| control.basis.graph.as_ref() == Some(&current.epoch));
                        let target = source.map(|control| control.invocation.clone());
                        let result = api::Changed::Committed {
                            epoch: current.epoch.clone(),
                        };
                        graphs.written();
                        graphs
                            .repository()?
                            .stop_with(
                                &input.session_id,
                                &current.epoch.graph_id,
                                target,
                                matches!(input.action, api::Action::Leave),
                                vec![receipt_mutation(&operation, &result)?],
                            )
                            .await
                            .map_err(|e| e.to_string())?;
                        if let Some(source) = source {
                            source.cancellation.cancel();
                        }
                        Ok(result)
                    }
                }
            })
            .await
            .map_err(|_| "graph_control_unknown".to_string())?
    }
    async fn graph_start_allowed(
        &self,
        graphs: &Graphs,
        session: &SessionRecord<ResolvedConfiguration>,
        runs: &Runs,
        current: Option<&maka_graph::control::Control>,
    ) -> Result<(), String> {
        self.graph_privacy().await?;
        if !graphs.enabled() {
            return Err("graph_workers_unavailable".into());
        }
        if session.archived || session.configuration.collaboration_mode != CollaborationMode::Agent
        {
            return Err("graph_session_unavailable".into());
        }
        if runs.busy(&session.id)
            || self.has_parked_invocation(&session.id).await?
            || !self
                .store
                .session(&session.id)
                .await
                .map_err(|error| error.to_string())?
                .message_queue(&session.id)
                .await
                .map_err(|_| "agent_queue_unavailable")?
                .entries
                .is_empty()
        {
            return Err("graph_session_busy".into());
        }
        if let Some(current) = current {
            if !current.closed() {
                return Err("graph_epoch_active".into());
            }
            if !graphs.quiescent(&session.id, current).await? {
                return Err("graph_previous_epoch_settling".into());
            }
        }
        if self
            .goal(GoalRead {
                session_id: session.id.clone(),
            })
            .await?
            .current
            .is_some_and(|goal| {
                goal.pending || matches!(goal.status, GoalStatus::Armed | GoalStatus::Active)
            })
        {
            return Err("graph_goal_conflict".into());
        }
        if self
            .plan(PlanRead {
                session_id: session.id.clone(),
            })
            .await?
            .current
            .execution
            .is_some_and(|execution| {
                matches!(
                    execution.phase,
                    PlanPhase::AwaitingAdmission | PlanPhase::Active
                )
            })
        {
            return Err("graph_plan_conflict".into());
        }
        Ok(())
    }
}
