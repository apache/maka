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

//! Deferred routes reuse the original assignment and dispatch receipts. Edges
//! only name already committed tasks, so admission order makes cycles impossible.
use super::*;
use crate::contract::{ExecutionState, Work};
use maka_agent_facts::language::Language;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Capture {
    Ready { message: String },
    Cancelled,
    Rejected { reason: String },
}
impl Hub {
    fn dependency_key(&self, id: &str) -> Result<String, String> {
        self.task_key(id)?;
        Ok(format!("{}dependency-inputs/{id}", self.agent.0.prefix))
    }
    async fn dependency_capture(&self, id: &str) -> Result<Option<Capture>, String> {
        let record = self
            .agent
            .0
            .store
            .plugin_data(&namespace(), &self.dependency_key(id)?)
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        match record.map(|r| r.data) {
            None => Ok(None),
            Some(Data::Present(value)) => serde_json::from_value(value)
                .map(Some)
                .map_err(|_| "workhub_dependency_capture_invalid".into()),
            Some(Data::Deleted) => Err("workhub_dependency_capture_removed".into()),
        }
    }
    async fn capture_dependencies(&self, id: &str, capture: Capture) -> Result<Capture, String> {
        match self
            .agent
            .0
            .store
            .plugin_data_batch(
                &namespace(),
                vec![Mutation {
                    key: self.dependency_key(id)?,
                    expected_revision: None,
                    data: Data::Present(
                        serde_json::to_value(&capture).map_err(|_| "workhub_encoding_failed")?,
                    ),
                }],
            )
            .await
        {
            Ok(_) => Ok(capture),
            Err(maka_event_log::StoreError::RevisionConflict { .. }) => self
                .dependency_capture(id)
                .await?
                .ok_or("workhub_dependency_capture_missing".into()),
            Err(_) => Err("workhub_dependency_capture_unknown".into()),
        }
    }
    pub(super) async fn validate_dependencies(&self, ids: &[String]) -> Result<(), String> {
        if ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len() {
            return Err("workhub_dependencies_invalid".into());
        }
        for id in ids {
            // No unresolved references or future aliases: the entire graph has
            // this same construction rule and requires no mutable graph ledger.
            self.assignment(id).await?;
        }
        Ok(())
    }
    pub(super) async fn cancel_pending(
        &self,
        id: &str,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let assignment = self.assignment(id).await?;
        if assignment.dependencies.is_empty() && assignment.graph.is_none() {
            return Ok(serde_json::json!({"kind":"not_deferred"}));
        }
        if cancellation.is_cancelled() {
            return Err("workhub_cancelled".into());
        }
        // Exactly one decision wins: cancelled, or immutable ready input. A
        // ready result is never described as a confirmed stop of worker execution.
        let capture = self.capture_dependencies(id, Capture::Cancelled).await?;
        Ok(serde_json::json!({"kind":match capture {
            Capture::Cancelled => "cancelled",
            Capture::Ready { .. } | Capture::Rejected { .. } => "already_resolved",
        }}))
    }
    pub(super) async fn dependency_input(
        &self,
        id: &str,
        assignment: &Assignment,
        advance: bool,
        execution: Option<Arc<dyn maka_agent_facts::tools::ExecutionCustody>>,
        cancellation: CancellationToken,
    ) -> Result<Result<Option<String>, TaskStatus>, String> {
        if assignment.dependencies.is_empty() && assignment.graph.is_none() {
            return Ok(Ok(None));
        }
        let captured = self.dependency_capture(id).await?;
        let captured = if let Some(capture) = captured {
            capture
        } else {
            if !advance {
                return Ok(Err(TaskStatus::Blocked {
                    dependencies: assignment.dependencies.clone(),
                }));
            }
            if assignment.graph.is_some() {
                let capture = match self
                    .graph_input(assignment, execution.as_deref(), cancellation.clone())
                    .await?
                {
                    Ok(message) => Capture::Ready { message },
                    Err(TaskStatus::Rejected { reason }) => Capture::Rejected { reason },
                    Err(status) => return Ok(Err(status)),
                };
                return Ok(match self.capture_dependencies(id, capture).await? {
                    Capture::Ready { message } => Ok(Some(message)),
                    Capture::Cancelled => Err(TaskStatus::Cancelled),
                    Capture::Rejected { reason } => Err(TaskStatus::Rejected { reason }),
                });
            }
            let language = self
                .source_language(&assignment.source, execution.as_deref())
                .await?;
            let mut message = assignment.input["message"]
                .as_str()
                .ok_or("workhub_input_invalid")?
                .to_owned();
            message.push_str(match language {
                Language::En => "\n\nCompleted dependency results:\n",
                Language::ZhCn => "\n\n已完成的依赖结果：\n",
                Language::ZhTw => "\n\n已完成的相依結果：\n",
            });
            let mut rejection = None;
            for dependency in &assignment.dependencies {
                let mut cursor = None;
                let mut identity = None;
                loop {
                    if cancellation.is_cancelled() {
                        return Err("workhub_cancelled".into());
                    }
                    // A read never recursively advances another dependency.
                    let value = Box::pin(self.task_with_execution(
                        dependency,
                        false,
                        cursor.clone(),
                        execution.clone(),
                        cancellation.clone(),
                    ))
                    .await?;
                    let task: Task =
                        serde_json::from_value(value).map_err(|_| "workhub_task_invalid")?;
                    let progress = match task.status {
                        TaskStatus::Started { progress, .. }
                        | TaskStatus::Queued { progress, .. } => progress,
                        TaskStatus::Cancelled | TaskStatus::Rejected { .. } => {
                            rejection = Some(format!("dependency_unsuccessful:{dependency}"));
                            break;
                        }
                        _ => {
                            return Ok(Err(TaskStatus::Blocked {
                                dependencies: assignment.dependencies.clone(),
                            }));
                        }
                    };
                    let Some(Work::Delivered {
                        shared,
                        execution,
                        answer,
                        ..
                    }) = progress
                    else {
                        if matches!(progress, Some(Work::Cancelled)) {
                            rejection = Some(format!("dependency_cancelled:{dependency}"));
                            break;
                        }
                        return Ok(Err(TaskStatus::Blocked {
                            dependencies: assignment.dependencies.clone(),
                        }));
                    };
                    match execution.state {
                        ExecutionState::Completed => {}
                        ExecutionState::Failed | ExecutionState::Cancelled => {
                            rejection = Some(format!("dependency_unsuccessful:{dependency}"));
                            break;
                        }
                        _ => {
                            return Ok(Err(TaskStatus::Blocked {
                                dependencies: assignment.dependencies.clone(),
                            }));
                        }
                    }
                    if shared {
                        rejection = Some(format!("dependency_shared_result:{dependency}"));
                        break;
                    }
                    let basis = (
                        execution.session_id,
                        execution.invocation_id,
                        execution.high_water,
                    );
                    if identity.as_ref().is_some_and(|previous| previous != &basis) {
                        return Err("workhub_dependency_result_changed".into());
                    }
                    if identity.is_none() {
                        message.push_str(&match language {
                            Language::En => format!(
                                "\nTask {dependency}, invocation {}, through {}:\n",
                                basis.1, basis.2
                            ),
                            Language::ZhCn => format!(
                                "\n任务 {dependency}，invocation {}，截至 {}：\n",
                                basis.1, basis.2
                            ),
                            Language::ZhTw => format!(
                                "\n任務 {dependency}，invocation {}，截至 {}：\n",
                                basis.1, basis.2
                            ),
                        });
                    }
                    identity = Some(basis.clone());
                    let next = if let Some(answer) = answer {
                        let offset = cursor
                            .as_ref()
                            .map_or(0, |c: &crate::contract::AnswerCursor| c.offset);
                        if answer.next.as_ref().is_some_and(|next| {
                            next.invocation_id != basis.1
                                || answer.text.is_empty()
                                || next.offset != offset + answer.text.len() as u64
                        }) {
                            return Err("workhub_dependency_page_invalid".into());
                        }
                        message.push_str(&answer.text);
                        answer.next
                    } else {
                        None
                    };
                    if next.is_none() {
                        break;
                    }
                    cursor = next;
                }
                if rejection.is_some() {
                    break;
                }
            }
            if cancellation.is_cancelled() {
                return Err("workhub_cancelled".into());
            }
            let capture = match rejection {
                Some(reason) => Capture::Rejected { reason },
                None => Capture::Ready { message },
            };
            self.capture_dependencies(id, capture).await?
        };
        Ok(match captured {
            Capture::Ready { message } => Ok(Some(message)),
            Capture::Cancelled => Err(TaskStatus::Cancelled),
            Capture::Rejected { reason } => Err(TaskStatus::Rejected { reason }),
        })
    }
}
