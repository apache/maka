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

//! Graph decisions share WorkHub's original task dispatch and native owner.
mod notifications;
mod tools;
use super::*;
use maka_agent_facts::language::Language;
use maka_graph::{GraphId, WorkId, repository::Repository};
pub(super) use tools::registrations;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskSource {
    pub(super) graph_id: GraphId,
    pub(super) work_id: WorkId,
    authority: crate::contract::ScheduledTarget,
    route: Value,
}

pub(crate) struct Graphs {
    link: Link,
    installed: bool,
    storage: OnceLock<Arc<maka_host_runtime::storage::Storage>>,
    repository: OnceLock<Repository>,
    pub(crate) gate: tokio::sync::Mutex<()>,
    awake: std::sync::atomic::AtomicU64,
}
impl Graphs {
    pub(super) fn new(link: Link, installed: bool) -> Self {
        Self {
            link,
            installed,
            storage: OnceLock::new(),
            repository: OnceLock::new(),
            gate: tokio::sync::Mutex::new(()),
            awake: std::sync::atomic::AtomicU64::new(u64::from(installed)),
        }
    }
    pub(in crate::workhub) fn bind(&self, owner: &Arc<Owner>) {
        // Same namespace and exact original task keys permit one graph/task CAS.
        // Repository's entry hash isolates this Agent's graph decisions.
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            owner.store.clone(),
            String::new(),
            namespace(),
        ));
        let repository =
            Repository::new(storage.clone(), &owner.prefix).expect("native graph entry");
        assert!(
            self.storage.set(storage).is_ok(),
            "graph storage bound once"
        );
        assert!(
            self.repository.set(repository).is_ok(),
            "graph repository bound once"
        );
    }
}

use maka_agent_api::workhub::graph as api;
use maka_capabilities::storage::Store as _;
use maka_graph::{
    Epoch,
    control::Control,
    schedule::{Schedule, WorkStatus},
    store::Store as _,
    view::{Status, WorkState},
};

pub(crate) const NAMES: &[&str] = &[
    "agent_list",
    "view_agent_graph",
    "update_agent_graph",
    "yield_agent_graph",
    "agent_swarm_status",
];

struct Observed {
    work_id: WorkId,
    task_id: String,
    status: WorkState,
    result_id: Option<String>,
    failure: Option<String>,
    attention_id: Option<String>,
    execution: Option<(String, String)>,
    quiescent: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlReceipt {
    reference: RecoveryRef,
    result: api::Changed,
}
impl Graphs {
    pub(crate) fn written(&self) {
        self.awake
            .try_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
                Some(revision.wrapping_add(2) | 1)
            })
            .expect("unconditional update");
    }
    pub(crate) fn keeps_host_awake(&self) -> bool {
        self.awake.load(Ordering::Acquire) & 1 != 0
    }
    pub(super) fn begin_scan(&self) -> u64 {
        self.awake.fetch_or(1, Ordering::AcqRel) | 1
    }
    pub(super) fn end_scan(&self, revision: u64, pending: bool) {
        if !pending {
            // A graph write during a paged scan must not lose its retirement hint.
            let _ = self.awake.compare_exchange(
                revision,
                revision & !1,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }
    pub(crate) fn repository(&self) -> Result<&Repository, String> {
        self.repository
            .get()
            .ok_or("graph_owner_unavailable".into())
    }
    fn storage(&self) -> Result<&Arc<maka_host_runtime::storage::Storage>, String> {
        self.storage.get().ok_or("graph_owner_unavailable".into())
    }
    pub(crate) fn enabled(&self) -> bool {
        self.installed
    }
    fn hub(&self) -> Result<Arc<Hub>, String> {
        self.link
            .get()
            .and_then(Weak::upgrade)
            .ok_or("graph_owner_unavailable".into())
    }
    pub(crate) async fn finish(&self) -> Result<(), String> {
        match self.storage.get() {
            Some(storage) => storage.finish().await,
            None => Ok(()),
        }
    }
    pub(crate) async fn current(&self, session: &str) -> Result<Option<Control>, String> {
        self.repository()?.current(session).await.map_err(error)
    }
    pub(crate) async fn active(&self, session: &str) -> Result<Option<Epoch>, String> {
        Ok(self
            .current(session)
            .await?
            .filter(|control| !control.closed())
            .map(|control| control.epoch))
    }
    async fn schedule(&self, control: &Control) -> Result<Schedule, String> {
        let mut schedule = Schedule::new(control.epoch.clone()).map_err(error)?;
        while schedule.revision < control.schedule_revision {
            let page = self
                .repository()?
                .updates(
                    &control.epoch.graph_id,
                    schedule.revision,
                    control.schedule_revision,
                )
                .await
                .map_err(error)?;
            if page.is_empty() {
                return Err("graph_schedule_incomplete".into());
            }
            for update in page {
                schedule.apply(&update).map_err(error)?;
            }
        }
        Ok(schedule)
    }
    async fn observations(
        &self,
        hub: &Hub,
        schedule: &Schedule,
        stop: CancellationToken,
    ) -> Result<Vec<Observed>, String> {
        let mut observed = Vec::with_capacity(schedule.work.len());
        for item in schedule.work.values() {
            if stop.is_cancelled() {
                return Err("graph_observation_cancelled".into());
            }
            let id = graph_task_id(&schedule.epoch.graph_id, &item.work.work_id);
            let mut observation = match hub.task(&id, false, None, stop.clone()).await {
                Ok(value) => observe(
                    &item.work.work_id,
                    &id,
                    serde_json::from_value(value).map_err(error)?,
                ),
                Err(error) if !hub.tasks.cleanup_failed() => Observed {
                    work_id: item.work.work_id.clone(),
                    task_id: id,
                    status: WorkState::Blocked,
                    result_id: None,
                    failure: Some(error),
                    attention_id: None,
                    execution: None,
                    quiescent: false,
                },
                Err(error) => return Err(error),
            };
            match item.status {
                WorkStatus::Requested => {
                    if work_retired(schedule, &item.work.work_id, observation.execution.as_ref()) {
                        observation.status = WorkState::Stopped;
                    }
                }
                WorkStatus::Stopped => observation.status = WorkState::Stopped,
                WorkStatus::Superseded => observation.status = WorkState::Superseded,
            }
            observed.push(observation);
        }
        Ok(observed)
    }
    pub(crate) async fn quiescent(&self, session: &str, control: &Control) -> Result<bool, String> {
        if control.epoch.root_session_id != session {
            return Err("graph_session_changed".into());
        }
        let hub = self.hub()?;
        let schedule = self.schedule(control).await?;
        Ok(self
            .observations(&hub, &schedule, CancellationToken::new())
            .await?
            .iter()
            .all(|item| item.quiescent))
    }
    async fn view(
        &self,
        hub: &Hub,
        input: api::Read,
        stop: CancellationToken,
    ) -> Result<api::View, String> {
        hub.agent.0.session(&input.session_id).await?;
        let current = self.current(&input.session_id).await?;
        let selected = match &input.graph_id {
            Some(graph) => Some(
                self.repository()?
                    .control(&input.session_id, graph)
                    .await
                    .map_err(error)?,
            ),
            None => current.clone(),
        };
        let Some(control) = selected else {
            return Ok(api::View {
                enabled: !hub.tasks.workers.is_empty(),
                current_epoch: None,
                selected_mode: None,
                epoch: None,
                revision: 0,
                status: Status::Empty,
                quiescent: true,
                work: vec![],
                after: None,
                finish: None,
            });
        };
        let schedule = self.schedule(&control).await?;
        let observations = self.observations(hub, &schedule, stop).await?;
        let quiescent = observations.iter().all(|item| item.quiescent);
        let status = if control.closed() {
            if !quiescent {
                Status::Closing
            } else if control.finished {
                Status::Completed
            } else {
                Status::Stopped
            }
        } else if observations.is_empty() {
            Status::Empty
        } else if observations.iter().any(|item| {
            matches!(
                item.status,
                WorkState::Failed | WorkState::Blocked | WorkState::Cancelled
            )
        }) {
            Status::Failed
        } else if !quiescent {
            Status::Active
        } else {
            Status::Waiting
        };
        let start = input.after.as_ref().map_or(0, |id| {
            observations.partition_point(|item| &item.work_id <= id)
        });
        let end = (start + 16).min(observations.len());
        let mut work = Vec::new();
        for observation in &observations[start..end] {
            let item = &schedule.work[&observation.work_id].work;
            let end = item
                .instruction
                .floor_char_boundary(item.instruction.len().min(512));
            work.push(api::Work {
                work_id: item.work_id.clone(),
                task_id: observation.task_id.clone(),
                target: item.target.clone(),
                status: observation.status,
                instruction_excerpt: item.instruction[..end].into(),
                instruction_truncated: end < item.instruction.len(),
                result_id: observation.result_id.clone(),
                failure: observation.failure.clone(),
            });
        }
        Ok(api::View {
            enabled: !hub.tasks.workers.is_empty(),
            selected_mode: current
                .as_ref()
                .filter(|c| c.selected)
                .map(|c| c.epoch.mode),
            current_epoch: current.map(|c| c.epoch),
            epoch: Some(control.epoch),
            revision: schedule.revision,
            status,
            quiescent,
            after: (end < observations.len()).then(|| observations[end - 1].work_id.clone()),
            work,
            finish: schedule.finish.map(|(finish, _, _)| finish),
        })
    }
    async fn result(
        &self,
        hub: &Hub,
        input: api::ResultRead,
        stop: CancellationToken,
    ) -> Result<api::ResultPage, String> {
        hub.agent.0.session(&input.session_id).await?;
        self.repository()?
            .work(&input.session_id, &input.graph_id, &input.work_id)
            .await
            .map_err(error)?
            .ok_or("graph_work_missing")?;
        let id = graph_task_id(&input.graph_id, &input.work_id);
        let initial: Task = serde_json::from_value(hub.task(&id, false, None, stop.clone()).await?)
            .map_err(error)?;
        let (execution, mut answer) = terminal_result(initial).ok_or("graph_result_unavailable")?;
        if result_id(&id, &execution) != input.result_id {
            return Err("graph_result_changed".into());
        }
        if input.offset != 0 {
            let task: Task = serde_json::from_value(
                hub.task(
                    &id,
                    false,
                    Some(crate::contract::AnswerCursor {
                        invocation_id: execution.invocation_id.clone(),
                        offset: input.offset,
                    }),
                    stop,
                )
                .await?,
            )
            .map_err(error)?;
            let (next_execution, next_answer) =
                terminal_result(task).ok_or("graph_result_unavailable")?;
            if result_id(&id, &next_execution) != input.result_id {
                return Err("graph_result_changed".into());
            }
            answer = next_answer;
        }
        let (text, next_offset) = answer.map_or((String::new(), None), |page| {
            (page.text, page.next.map(|next| next.offset))
        });
        Ok(api::ResultPage {
            work_id: input.work_id,
            result_id: input.result_id,
            execution,
            text,
            next_offset,
        })
    }
    pub(crate) async fn receipt(
        &self,
        reference: &RecoveryRef,
    ) -> Result<Option<api::Changed>, String> {
        self.storage()?
            .read(receipt_key(reference)?)
            .await
            .map_err(error)?
            .map(|record| {
                let receipt: ControlReceipt = serde_json::from_value(
                    record
                        .data
                        .value()
                        .cloned()
                        .ok_or("graph_receipt_invalid")?,
                )
                .map_err(error)?;
                if receipt.reference != *reference {
                    return Err("graph_receipt_changed".into());
                }
                Ok(receipt.result)
            })
            .transpose()
    }
    pub(crate) async fn record_control(
        &self,
        reference: &RecoveryRef,
        result: api::Changed,
    ) -> Result<api::Changed, String> {
        self.storage()?
            .batch(vec![receipt_mutation(reference, &result)?])
            .await
            .map_err(error)?;
        Ok(result)
    }
}
impl Hub {
    pub(in crate::workhub) async fn graph_api(
        &self,
        method: &str,
        input: Value,
        context: &Context,
    ) -> Result<Value, String> {
        if let Some(source) = context.scope().identity.agent()
            && input["sessionId"].as_str() != Some(&source.session_id)
        {
            return Err("graph_source_invalid".into());
        }
        let graphs = &self.tasks.graphs;
        let stop = &context.scope().cancellation;
        match method {
            "graph" => serde_json::to_value(
                graphs
                    .view(
                        self,
                        serde_json::from_value(input).map_err(error)?,
                        stop.clone(),
                    )
                    .await?,
            )
            .map_err(error),
            "watchGraph" => {
                let input: api::Read = serde_json::from_value(input).map_err(error)?;
                let mut commits = self.agent.0.store.subscribe_changes();
                let mut previous = None;
                loop {
                    if stop.is_cancelled() {
                        return Err("graph_observation_cancelled".into());
                    }
                    let value =
                        serde_json::to_value(graphs.view(self, input.clone(), stop.clone()).await?)
                            .map_err(error)?;
                    if previous.as_ref() != Some(&value) {
                        context.emit(value.clone()).await?;
                        previous = Some(value);
                    }
                    tokio::select! {
                        () = stop.cancelled() => return Err("graph_observation_cancelled".into()),
                        changed = commits.changed() => changed.map_err(|_| "graph_observation_closed")?,
                        () = tokio::time::sleep(std::time::Duration::from_secs(2)) => {},
                    }
                    tokio::select! {
                        () = stop.cancelled() => return Err("graph_observation_cancelled".into()),
                        () = tokio::time::sleep(std::time::Duration::from_millis(250)) => {},
                    }
                    commits.borrow_and_update();
                }
            }
            "graphWork" => {
                let input: api::WorkRead = serde_json::from_value(input).map_err(error)?;
                self.agent.0.session(&input.session_id).await?;
                let work = graphs
                    .repository()?
                    .work(&input.session_id, &input.graph_id, &input.work_id)
                    .await
                    .map_err(error)?
                    .ok_or("graph_work_missing")?;
                serde_json::to_value(work).map_err(error)
            }
            "graphResult" => serde_json::to_value(
                graphs
                    .result(
                        self,
                        serde_json::from_value(input).map_err(error)?,
                        stop.clone(),
                    )
                    .await?,
            )
            .map_err(error),
            "graphHistory" => {
                let input: api::HistoryRead = serde_json::from_value(input).map_err(error)?;
                self.agent.0.session(&input.session_id).await?;
                let page = graphs
                    .repository()?
                    .epochs(&input.session_id, input.before)
                    .await
                    .map_err(error)?;
                serde_json::to_value(api::History {
                    epochs: page.epochs,
                    current_epoch: page.current_epoch,
                    next_before: page.next_before,
                })
                .map_err(error)
            }
            "changeGraph" => serde_json::to_value(
                self.agent
                    .0
                    .graph_change(
                        serde_json::from_value(input).map_err(error)?,
                        context
                            .operation()
                            .ok_or("graph_mutation_required")?
                            .clone(),
                        context.scope(),
                    )
                    .await?,
            )
            .map_err(error),
            "graphReceipt" => {
                let input: api::ReceiptRead = serde_json::from_value(input).map_err(error)?;
                let reference = input.reference;
                if reference.source.state_domain != self.agent.0.data_source.state_domain
                    || reference.source.deployment != self.agent.0.data_source.deployment
                    || reference.namespace != self.agent.0.data_source.namespace
                    || reference.export != EXPORT
                    || reference.method != "changeGraph"
                {
                    return Err("graph_receipt_owner_invalid".into());
                }
                serde_json::to_value(graphs.receipt(&reference).await?).map_err(error)
            }
            _ => Err("graph_method_unavailable".into()),
        }
    }
}
pub(super) fn graph_task_id(graph: &GraphId, work: &WorkId) -> String {
    format!(
        "wt_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(graph, work)).expect("graph work identity")
        ))
    )
}
fn result_id(task: &str, execution: &crate::contract::Execution) -> String {
    format!(
        "graph_result_{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&(task, execution)).expect("original execution")
        ))
    )
}
fn terminal_result(
    task: Task,
) -> Option<(
    crate::contract::Execution,
    Option<crate::contract::AnswerPage>,
)> {
    use crate::contract::{ExecutionState, Work};
    let progress = match task.status {
        TaskStatus::Started { progress, .. } | TaskStatus::Queued { progress, .. } => progress,
        _ => None,
    };
    match progress {
        Some(Work::Delivered {
            shared: false,
            execution,
            answer,
            ..
        }) if matches!(
            execution.state,
            ExecutionState::Completed | ExecutionState::Failed | ExecutionState::Cancelled
        ) =>
        {
            Some((execution, answer))
        }
        _ => None,
    }
}
fn observe(work: &WorkId, id: &str, task: Task) -> Observed {
    use crate::contract::{ExecutionState, Work};
    let mut observed = Observed {
        work_id: work.clone(),
        task_id: id.into(),
        status: WorkState::Requested,
        result_id: None,
        failure: None,
        attention_id: None,
        execution: None,
        quiescent: false,
    };
    match task.status {
        TaskStatus::Blocked { .. } => observed.status = WorkState::Waiting,
        TaskStatus::Cancelled => {
            observed.status = WorkState::Cancelled;
            observed.quiescent = true;
        }
        TaskStatus::Rejected { reason } => {
            observed.status = WorkState::Failed;
            observed.failure = Some(reason);
            observed.quiescent = true;
        }
        TaskStatus::Preparing { state, .. } => match state {
            maka_agent_api::workhub::contract::PreparationState::Pending => {}
            maka_agent_api::workhub::contract::PreparationState::Rejected { reason } => {
                // Preparation only exposes Rejected after the original receipt
                // confirms cleanup. No worker execution or result was created.
                observed.status = WorkState::Failed;
                observed.failure = Some(reason);
                observed.quiescent = true;
            }
            state => {
                observed.status = WorkState::Blocked;
                observed.failure = Some(
                    match state {
                        maka_agent_api::workhub::contract::PreparationState::OriginalCaptureRequired => {
                            "original_preparation_capture_required"
                        }
                        maka_agent_api::workhub::contract::PreparationState::Unavailable => {
                            "original_preparation_unavailable"
                        }
                        _ => "original_preparation_uncertain",
                    }
                    .into(),
                );
            }
        },
        TaskStatus::Uncertain | TaskStatus::Unavailable => {
            observed.status = WorkState::Blocked;
            observed.failure = Some("original_task_unavailable".into());
        }
        TaskStatus::Started { progress, .. } | TaskStatus::Queued { progress, .. } => {
            match progress {
                Some(Work::Cancelled) => {
                    observed.status = WorkState::Cancelled;
                    observed.quiescent = true;
                }
                Some(Work::Delivered {
                    shared,
                    execution,
                    pending_interactions,
                    ..
                }) => {
                    observed.execution =
                        Some((execution.invocation_id.clone(), execution.run_id.clone()));
                    observed.status = match execution.state {
                        ExecutionState::Completed => WorkState::Completed,
                        ExecutionState::Failed => WorkState::Failed,
                        ExecutionState::Cancelled => WorkState::Cancelled,
                        ExecutionState::Waiting | ExecutionState::Paused => WorkState::Blocked,
                        _ if pending_interactions > 0 => WorkState::Blocked,
                        _ => WorkState::Running,
                    };
                    observed.quiescent = matches!(
                        execution.state,
                        ExecutionState::Completed
                            | ExecutionState::Failed
                            | ExecutionState::Cancelled
                    );
                    if observed.quiescent && !shared {
                        observed.result_id = Some(result_id(id, &execution));
                    }
                    if shared {
                        observed.status = WorkState::Blocked;
                        observed.failure = Some("shared_task_result".into());
                    }
                    if observed.status == WorkState::Blocked {
                        observed.attention_id = Some(format!(
                            "{}:{}:{}",
                            execution.invocation_id, execution.high_water, pending_interactions
                        ));
                    }
                }
                _ => observed.status = WorkState::Running,
            }
        }
        _ => {}
    }
    observed
}
pub(crate) fn receipt_mutation(
    reference: &RecoveryRef,
    result: &api::Changed,
) -> Result<Mutation, String> {
    Ok(Mutation {
        key: receipt_key(reference)?,
        expected_revision: None,
        data: Data::Present(
            serde_json::to_value(ControlReceipt {
                reference: reference.clone(),
                result: result.clone(),
            })
            .map_err(error)?,
        ),
    })
}
fn receipt_key(reference: &RecoveryRef) -> Result<String, String> {
    Ok(format!(
        "graph-control-receipt/{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(reference).map_err(error)?
        ))
    ))
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Hub {
    /// Resolve graph result references into the existing immutable dependency capture.
    /// Ordinary WorkHub dependencies retain their successful-result-only policy.
    pub(super) async fn graph_input(
        &self,
        assignment: &Assignment,
        execution: Option<&dyn maka_agent_facts::tools::ExecutionCustody>,
        stop: CancellationToken,
    ) -> Result<Result<String, TaskStatus>, String> {
        let source = assignment.graph.as_ref().ok_or("graph_task_missing")?;
        let graphs = &self.tasks.graphs;
        let root = &assignment.source.session_id;
        let control = graphs
            .repository()?
            .control(root, &source.graph_id)
            .await
            .map_err(error)?;
        let work = graphs
            .repository()?
            .work(root, &source.graph_id, &source.work_id)
            .await
            .map_err(error)?
            .ok_or("graph_work_missing")?;
        let mut references = work
            .input_ids
            .iter()
            .map(|id| (source.graph_id.clone(), id.clone()))
            .collect::<Vec<_>>();
        for input in work.selected_result_inputs {
            let historical = graphs
                .repository()?
                .control(root, &input.source_graph_id)
                .await
                .map_err(error)?;
            let schedule = graphs.schedule(&historical).await?;
            if historical.epoch.epoch >= control.epoch.epoch
                || !historical.finished
                || !schedule
                    .finish
                    .as_ref()
                    .is_some_and(|(finish, _, _)| finish.result_ids.contains(&input.result_id))
            {
                return Ok(Err(TaskStatus::Rejected {
                    reason: "graph_historical_result_not_selected".into(),
                }));
            }
            references.push((input.source_graph_id, input.result_id));
        }
        let language = self.source_language(&assignment.source, execution).await?;
        let mut message = assignment.input["message"]
            .as_str()
            .ok_or("graph_input_invalid")?
            .to_owned();
        for (graph_id, result_id) in references {
            let control = graphs
                .repository()?
                .control(root, &graph_id)
                .await
                .map_err(error)?;
            let schedule = graphs.schedule(&control).await?;
            let observed = Box::pin(graphs.observations(self, &schedule, stop.clone())).await?;
            let Some(item) = observed
                .iter()
                .find(|item| item.result_id.as_ref() == Some(&result_id))
            else {
                return Ok(Err(TaskStatus::Blocked {
                    dependencies: vec![result_id],
                }));
            };
            message.push_str(&match language {
                Language::En => format!("\n\nGraph {graph_id}, result {result_id}:\n"),
                Language::ZhCn => format!("\n\n图 {graph_id}，结果 {result_id}：\n"),
                Language::ZhTw => format!("\n\n圖 {graph_id}，結果 {result_id}：\n"),
            });
            let mut offset = 0;
            let mut remaining = 16 * 1024;
            loop {
                if stop.is_cancelled() {
                    return Err("graph_input_cancelled".into());
                }
                let page = Box::pin(graphs.result(
                    self,
                    api::ResultRead {
                        session_id: root.clone(),
                        graph_id: graph_id.clone(),
                        work_id: item.work_id.clone(),
                        result_id: result_id.clone(),
                        offset,
                    },
                    stop.clone(),
                ))
                .await?;
                let end = page
                    .text
                    .floor_char_boundary(page.text.len().min(remaining));
                message.push_str(&page.text[..end]);
                remaining -= end;
                let truncated =
                    end < page.text.len() || (remaining == 0 && page.next_offset.is_some());
                if truncated {
                    message.push_str(match language { Language::En => "\n[Result preview truncated; the supervisor can read view_agent_graph result pages using the original graph, work and result IDs.]\n", Language::ZhCn => "\n[结果预览已截断；主管可使用原始图、工作及结果 ID，通过 view_agent_graph 读取结果页。]\n", Language::ZhTw => "\n[結果預覽已截斷；主管可使用原始圖、工作及結果 ID，透過 view_agent_graph 讀取結果頁。]\n" });
                }
                if truncated {
                    break;
                }
                match page.next_offset {
                    Some(next)
                        if !page.text.is_empty() && next == offset + page.text.len() as u64 =>
                    {
                        offset = next
                    }
                    Some(_) => return Err("graph_result_page_invalid".into()),
                    None => break,
                }
            }
        }
        Ok(Ok(message))
    }
    pub(super) async fn graph_retired(&self, assignment: &Assignment) -> Result<bool, String> {
        let Some(source) = &assignment.graph else {
            return Ok(false);
        };
        let graphs = &self.tasks.graphs;
        let control = graphs
            .repository()?
            .control(&assignment.source.session_id, &source.graph_id)
            .await
            .map_err(error)?;
        if control.closed() {
            return Ok(true);
        }
        let schedule = graphs.schedule(&control).await?;
        Ok(work_retired(&schedule, &source.work_id, None))
    }
    pub(super) async fn graph_can_advance(&self, assignment: &Assignment) -> Result<bool, String> {
        let Some(source) = &assignment.graph else {
            return Ok(true);
        };
        let graphs = &self.tasks.graphs;
        if !self.agent.0.graph_target_valid(&source.authority).await? {
            return Ok(false);
        }
        let Some(control) = graphs.current(&assignment.source.session_id).await? else {
            return Ok(false);
        };
        if control.closed() || control.epoch.graph_id != source.graph_id {
            return Ok(false);
        }
        let schedule = graphs.schedule(&control).await?;
        Ok(!work_retired(&schedule, &source.work_id, None))
    }
}

fn work_retired(schedule: &Schedule, id: &WorkId, execution: Option<&(String, String)>) -> bool {
    let Some(item) = schedule.work.get(id) else {
        return true;
    };
    let operator = match &item.work.target {
        maka_graph::schedule::Target::Operator { operator_id } => operator_id.clone(),
        _ => maka_graph::coordinator::operator_id_for(&schedule.epoch, id),
    };
    item.status != WorkStatus::Requested
        || schedule.stopped.contains_key(operator.as_str())
        || execution.is_some_and(|(invocation, run)| {
            schedule.stopped.contains_key(invocation) || schedule.stopped.contains_key(run)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_api::workhub::contract::{PreparationStage, PreparationState};

    #[test]
    fn graph_preparation_attention_preserves_original_cleanup_uncertainty() {
        for (state, settled) in [
            (
                PreparationState::Rejected {
                    reason: "workspace_replaced".into(),
                },
                true,
            ),
            (PreparationState::Uncertain, false),
            (PreparationState::Unavailable, false),
            (PreparationState::OriginalCaptureRequired, false),
        ] {
            let work: WorkId = "graph_work_preparation".to_owned().try_into().unwrap();
            let observed = observe(
                &work,
                "original-task",
                Task {
                    dependencies: vec![],
                    task_id: "original-task".into(),
                    worker: "worker".into(),
                    title: "Original task".into(),
                    accepted_at: 1,
                    operation: Uuid::new_v4(),
                    status: TaskStatus::Preparing {
                        stage: PreparationStage::Create,
                        operation: Uuid::new_v4(),
                        session_id: None,
                        state,
                    },
                },
            );
            assert_eq!(observed.quiescent, settled);
            assert!(observed.result_id.is_none());
            assert!(observed.failure.is_some());
            let snapshot = maka_graph::swarm::Snapshot::new(
                GraphId::new(),
                vec![maka_graph::swarm::Item {
                    work_id: work,
                    status: observed.status,
                    result_record_id: observed.result_id,
                    failure: observed.failure,
                    attention_id: observed.attention_id,
                }],
                observed.quiescent,
            );
            assert_eq!(snapshot.status, maka_graph::swarm::Status::NeedsAttention);
            assert!(snapshot.signal_key().is_some());
        }
    }
}
