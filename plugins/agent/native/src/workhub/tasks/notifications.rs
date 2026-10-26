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

//! Bounded observation of original tasks; only the coordinator owns follow-up admission.
use super::*;
use maka_agent_facts::language::Language;
use maka_event_log::message_admissions::PendingMessageAdmission;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Notification {
    pub(super) identity: String,
    pub(super) admission: PendingMessageAdmission,
    pub(super) accepted: bool,
}
impl Tasks {
    pub(in crate::workhub) fn start_notifications(&self, agent: &Arc<Owner>) {
        if self.workers.is_empty() {
            return;
        }
        let link = self.link.clone();
        agent.background(move |stop| async move {
            let Some(hub) = link.get().and_then(Weak::upgrade) else {
                return;
            };
            let mut commits = hub.agent.0.store.subscribe_changes();
            let mut after = None;
            let mut previous_error = None;
            let mut graph_scan = 0;
            let mut graph_pending = false;
            loop {
                if stop.is_cancelled() || hub.tasks.cleanup_failed() {
                    return;
                }
                let Some(producer) = hub.agent.0.producer().await else {
                    return;
                };
                if after.is_none() {
                    graph_scan = hub.tasks.graphs.begin_scan();
                    graph_pending = false;
                }
                let result = hub.notification_page(after.take(), stop.clone()).await;
                drop(producer);
                match result {
                    Ok((next, pending)) => {
                        after = next;
                        graph_pending |= pending;
                        if after.is_none() {
                            hub.tasks.graphs.end_scan(graph_scan, graph_pending);
                        }
                        previous_error = None;
                    }
                    Err(error) => {
                        if previous_error.as_ref() != Some(&error) && !stop.is_cancelled() {
                            eprintln!("WorkHub result notification: {error}");
                        }
                        previous_error = Some(error);
                    }
                }
                if after.is_some() {
                    tokio::select! {
                        () = stop.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
                    }
                } else {
                    // Provider changes can be external to this Root. Periodic observation
                    // and commit notifications both revisit the original immutable tasks.
                    tokio::select! {
                        () = stop.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_secs(2)) => {},
                        result = commits.changed() => if result.is_err() { return; },
                    }
                    // Coalesce streaming writes; never turn each token into a full scan.
                    tokio::select! {
                        () = stop.cancelled() => return,
                        () = tokio::time::sleep(std::time::Duration::from_millis(250)) => {},
                    }
                    commits.borrow_and_update();
                }
            }
        });
    }
}
impl Hub {
    async fn notification_page(
        &self,
        after: Option<String>,
        stop: CancellationToken,
    ) -> Result<(Option<String>, bool), String> {
        let mut graph_pending = false;
        let page = self
            .agent
            .0
            .store
            .plugin_data_scan(
                &namespace(),
                maka_capabilities::storage::Scan {
                    prefix: format!("{}tasks/", self.agent.0.prefix),
                    after,
                },
            )
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        let mut next = None;
        let more = page.entries.len() > 16 || page.next_after.is_some();
        for entry in page.entries.into_iter().take(16) {
            if stop.is_cancelled() {
                return Ok((None, true));
            }
            next = Some(entry.key.clone());
            let Data::Present(value) = entry.record.data else {
                continue;
            };
            let mut assignment: Assignment =
                serde_json::from_value(value).map_err(|_| "workhub_task_invalid")?;
            let id = entry
                .key
                .strip_prefix(&format!("{}tasks/", self.agent.0.prefix))
                .ok_or("workhub_task_invalid")?;
            if assignment.graph.is_some() {
                match self
                    .graph_notification(id, entry.record.revision, assignment, stop.clone())
                    .await
                {
                    Ok(pending) => graph_pending |= pending,
                    Err(_) if !self.tasks.cleanup_failed() && !stop.is_cancelled() => {
                        graph_pending = true
                    }
                    Err(error) => return Err(error),
                }
                continue;
            }
            // Accepted deferred routes own their dependency wait. Once ready, advance
            // only their original frozen preparation and dispatch; unknown receipts
            // retain the existing no-recapture/no-redispatch rules.
            let value = match self
                .task(id, !assignment.dependencies.is_empty(), None, stop.clone())
                .await
            {
                Ok(value) => value,
                Err(error) if !self.tasks.cleanup_failed() => {
                    // One unavailable worker must not starve other tasks on this page.
                    if stop.is_cancelled() {
                        return Ok((None, true));
                    }
                    let _ = error;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !terminal(&value) {
                continue;
            }
            let identity = format!(
                "wh_{}",
                hex::encode(Sha256::digest(
                    serde_json::to_vec(&(
                        id,
                        &value["status"]["kind"],
                        &value["status"]["progress"]["kind"],
                        &value["status"]["progress"]["execution"]["invocationId"],
                        &value["status"]["progress"]["execution"]["state"],
                    ))
                    .map_err(|_| "workhub_encoding_failed")?
                ))
            );
            if assignment
                .notification
                .as_ref()
                .is_some_and(|n| n.accepted && n.identity == identity)
            {
                continue;
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
                        continue;
                    }
                    notification.accepted = true;
                }
                None => {
                    let observation =
                        serde_json::to_string(&value).map_err(|_| "workhub_encoding_failed")?;
                    let render = |language| match language {
                        Language::En => format!(
                            "WorkHub task {id} has ended. Further answer pages: workhub_tasks inspect with this taskId.\n\nOriginal worker observation:\n{observation}"
                        ),
                        Language::ZhCn => format!(
                            "WorkHub 任务 {id} 已结束。后续答案页：使用 workhub_tasks inspect 和此 taskId。\n\n原始工作 Agent 观测：\n{observation}"
                        ),
                        Language::ZhTw => format!(
                            "WorkHub 任務 {id} 已結束。後續答案頁：使用 workhub_tasks inspect 和此 taskId。\n\n原始工作 Agent 觀測：\n{observation}"
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
                            maka_agent_facts::message::MessageOrigin::WorkhubTask {
                                task_id: id.into(),
                            },
                        )
                        .await?
                    else {
                        continue;
                    };
                    assignment.notification = Some(Notification {
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
                        key: entry.key,
                        expected_revision: Some(entry.record.revision),
                        data: Data::Present(
                            serde_json::to_value(assignment)
                                .map_err(|_| "workhub_encoding_failed")?,
                        ),
                    }],
                )
                .await
            {
                Ok(_) | Err(maka_event_log::StoreError::RevisionConflict { .. }) => {}
                Err(_) => return Err("workhub_notification_commit_unknown".into()),
            }
        }
        Ok((if more { next } else { None }, graph_pending))
    }
}
fn terminal(task: &Value) -> bool {
    let status = &task["status"];
    status["kind"] == "cancelled"
        || status["kind"] == "rejected"
        || status["progress"]["kind"] == "cancelled"
        || (status["progress"]["kind"] == "delivered"
            && matches!(
                status["progress"]["execution"]["state"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ))
}
