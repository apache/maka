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

//! Graph wake decisions reuse the original WorkHub notification outbox.
use super::*;
use maka_agent_facts::language::Language;
impl Hub {
    pub(in crate::workhub::tasks) async fn graph_notification(
        &self,
        id: &str,
        revision: u64,
        mut assignment: Assignment,
        stop: CancellationToken,
    ) -> Result<bool, String> {
        let source = assignment
            .graph
            .as_ref()
            .ok_or("graph_source_missing")?
            .clone();
        // Same task owner advances all accepted graph work, including work with
        // no input edges. Exact receipts still precede today's dispatch checks.
        let value = self.task(id, true, None, stop.clone()).await?;
        let task: Task = serde_json::from_value(value).map_err(error)?;
        let observed = observe(&source.work_id, id, task);
        let mut pending = !observed.quiescent;
        let graphs = &self.tasks.graphs;
        let _gate = graphs.gate.lock().await;
        let control = graphs
            .repository()?
            .control(&assignment.source.session_id, &source.graph_id)
            .await
            .map_err(error)?;
        let schedule = graphs.schedule(&control).await?;
        let retired = control.closed()
            || work_retired(&schedule, &source.work_id, observed.execution.as_ref());
        if retired {
            if !observed.quiescent {
                self.control_start(
                    id,
                    controls::Action::Stop,
                    ToolCallContext {
                        execution: None,
                        invocation: assignment.source.clone(),
                        operation_id: format!("graph-stop-{id}"),
                    },
                    stop.clone(),
                )
                .await?;
            }
            if control.closed() {
                return Ok(pending);
            }
        }
        // One deterministic original assignment owns the aggregate signal.
        // Remaining assignments continue to own their own dispatch and cleanup.
        let notification_owner = schedule
            .work
            .iter()
            .find(|(_, item)| item.status == WorkStatus::Requested)
            .or_else(|| schedule.work.iter().next())
            .map(|(id, _)| id);
        if notification_owner != Some(&source.work_id) {
            return Ok(pending);
        }
        if graphs.active(&assignment.source.session_id).await?.as_ref() != Some(&control.epoch)
            || !self.agent.0.graph_target_valid(&source.authority).await?
        {
            return Ok(pending);
        }
        let observed = graphs.observations(self, &schedule, stop).await?;
        pending = observed.iter().any(|item| !item.quiescent);
        let signal = if control.epoch.mode == maka_graph::Mode::Swarm {
            maka_graph::swarm::Snapshot::new(
                source.graph_id.clone(),
                observed
                    .iter()
                    .map(|item| maka_graph::swarm::Item {
                        work_id: item.work_id.clone(),
                        status: item.status,
                        result_record_id: item.result_id.clone(),
                        failure: item.failure.clone(),
                        attention_id: item.attention_id.clone(),
                    })
                    .collect(),
                observed.iter().all(|item| item.quiescent),
            )
            .signal_key()
        } else {
            let outcomes = observed
                .iter()
                .filter(|item| {
                    item.result_id.is_some()
                        || item.attention_id.is_some()
                        || item.failure.is_some()
                })
                .map(|item| {
                    (
                        &item.work_id,
                        item.status,
                        &item.result_id,
                        &item.failure,
                        &item.attention_id,
                    )
                })
                .collect::<Vec<_>>();
            if outcomes.is_empty() {
                None
            } else {
                Some(format!(
                    "sha256:{}",
                    hex::encode(Sha256::digest(
                        serde_json::to_vec(&outcomes).map_err(error)?
                    ))
                ))
            }
        };
        let Some(signal) = signal else {
            return Ok(pending);
        };
        let identity = format!(
            "graph_{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(&source.graph_id, signal)).map_err(error)?
            ))
        );
        if assignment
            .notification
            .as_ref()
            .is_some_and(|n| n.accepted && n.identity == identity)
        {
            return Ok(pending);
        }
        if assignment.notification.as_ref().is_some_and(|n| n.accepted) {
            assignment.notification = None;
        }
        match &mut assignment.notification {
            Some(notification) => {
                if !self
                    .agent
                    .0
                    .admit_notification(&notification.admission)
                    .await?
                {
                    return Ok(true);
                }
                notification.accepted = true;
            }
            None => {
                let render = |language| match language {
                    Language::En => format!(
                        "Graph {} has new durable worker observations; read original state and results with view_agent_graph.",
                        source.graph_id
                    ),
                    Language::ZhCn => format!(
                        "图 {} 有新的持久工作 Agent 观测；通过 view_agent_graph 读取原始状态和结果。",
                        source.graph_id
                    ),
                    Language::ZhTw => format!(
                        "圖 {} 有新的持久工作 Agent 觀測；透過 view_agent_graph 讀取原始狀態和結果。",
                        source.graph_id
                    ),
                };
                let Some(admission) = self
                    .agent
                    .0
                    .prepare_notification(
                        &assignment.source,
                        &assignment.return_route,
                        &identity,
                        render,
                        maka_agent_facts::message::MessageOrigin::WorkhubGraph {
                            graph_id: source.graph_id.to_string(),
                        },
                    )
                    .await?
                else {
                    return Ok(true);
                };
                pending = true;
                assignment.notification = Some(super::super::notifications::Notification {
                    identity,
                    admission,
                    accepted: false,
                });
            }
        }
        match self
            .agent
            .0
            .store
            .plugin_data_batch(
                &namespace(),
                vec![Mutation {
                    key: self.task_key(id)?,
                    expected_revision: Some(revision),
                    data: Data::Present(serde_json::to_value(assignment).map_err(error)?),
                }],
            )
            .await
        {
            Ok(_) | Err(maka_event_log::StoreError::RevisionConflict { .. }) => Ok(pending),
            Err(_) => Err("graph_notification_commit_unknown".into()),
        }
    }
}
