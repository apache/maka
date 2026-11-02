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

use crate::{
    Epoch, Error, OperatorId, WorkId,
    control::{Control, Intent, Wake},
    projection::{Execution, Record},
    schedule::{HistoricalInput, Schedule, Target, Update, WorkStatus},
    store::Store,
};
use futures_util::future::BoxFuture;
use maka_agent_facts::language::Language;
use maka_agent_ports::execution::ChildSession;
use maka_agent_ports::execution::Commands;
use maka_agent_ports::execution::Progress;
use maka_agent_ports::execution::Submit;
use maka_capabilities::authorization::CommandError;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

/// Resolve an approved target through Host capabilities. Implementations must
/// reuse the same child for the same graph/operator and never widen permissions.
pub trait Operators: Send + Sync {
    fn active(&self) -> BoxFuture<'_, Result<bool, Error>>;
    fn provision(
        &self,
        epoch: &Epoch,
        operator: &OperatorId,
        target: &Target,
    ) -> BoxFuture<'_, Result<ChildSession, Error>>;
}

pub struct Coordinator {
    store: Arc<dyn Store>,
    commands: Arc<dyn Commands>,
    operators: Arc<dyn Operators>,
    pub schedule: Schedule,
    pub control: Control,
    pub executions: BTreeMap<WorkId, Execution>,
    pub failures: BTreeMap<WorkId, String>,
    pub waiting: BTreeMap<WorkId, Vec<String>>,
    intents: BTreeMap<WorkId, Intent>,
    inspected: BTreeSet<WorkId>,
    delivered_signal: Option<String>,
}
impl Coordinator {
    pub(crate) fn changes(&self) -> Result<tokio::sync::watch::Receiver<u64>, Error> {
        Ok(self.commands.changes()?)
    }

    pub(crate) fn catching_up(&self) -> bool {
        self.executions.values().any(|execution| {
            execution.after < execution.observation.through_sequence
                || (matches!(execution.observation.progress, Progress::Ended { .. })
                    && matches!(
                        execution.workspace_result,
                        crate::projection::WorkspaceResult::Pending
                    ))
        })
    }

    pub(crate) async fn decide(&mut self, update: Update, now: u64) -> Result<u64, Error> {
        self.refresh_schedule().await?;
        if let Some(finish) = &update.finish {
            for id in &finish.result_ids {
                if self.read_record(id).await?.is_none() {
                    return Err(Error::NotFound(id.clone()));
                }
            }
        }
        let committed = self
            .store
            .commit_update(update, self.schedule.revision, now)
            .await?;
        self.refresh_schedule().await?;
        Ok(committed.revision)
    }
    pub fn new(
        epoch: Epoch,
        store: Arc<dyn Store>,
        commands: Arc<dyn Commands>,
        operators: Arc<dyn Operators>,
    ) -> Result<Self, Error> {
        let schedule = Schedule::new(epoch.clone())?;
        Ok(Self {
            store,
            commands,
            operators,
            schedule,
            control: Control {
                epoch,
                selected: true,
                schedule_revision: 0,
                stop_requested: false,
                stop_target: None,
                finished: false,
            },
            executions: BTreeMap::new(),
            failures: BTreeMap::new(),
            waiting: BTreeMap::new(),
            intents: BTreeMap::new(),
            inspected: BTreeSet::new(),
            delivered_signal: None,
        })
    }

    /// Reconcile accepted outcomes before attempting any new admissions. A caller
    /// owns this future through its Fiber; accepted Host work owns itself.
    pub async fn reconcile(&mut self, language: Language) -> Result<(), Error> {
        if !self.operators.active().await? {
            return Err(Error::Closed);
        }
        self.refresh_schedule().await?;
        if let Some(target) = &self.control.stop_target {
            self.commands.stop(target.clone()).await?;
        }
        let work = self.schedule.work.keys().cloned().collect::<Vec<_>>();
        self.failures.clear();
        self.waiting.clear();
        for id in &work {
            if let Err(error) = self.observe(id).await {
                self.failures.insert(id.clone(), error.to_string());
            }
        }
        for id in &work {
            if self.failures.contains_key(id) {
                continue;
            }
            if let Err(error) = self.advance(id, language).await {
                self.failures.insert(id.clone(), error.to_string());
            }
        }
        Ok(())
    }

    async fn refresh_schedule(&mut self) -> Result<(), Error> {
        let epoch = self.schedule.epoch.clone();
        let control = self
            .store
            .control(&epoch.root_session_id, &epoch.graph_id)
            .await?;
        while self.schedule.revision < control.schedule_revision {
            let page = self
                .store
                .updates(
                    &epoch.graph_id,
                    self.schedule.revision,
                    control.schedule_revision,
                )
                .await?;
            if page.is_empty() {
                return Err(Error::Persistence("schedule prefix is incomplete".into()));
            }
            for update in &page {
                self.schedule.apply(update)?;
            }
        }
        self.control = control;
        Ok(())
    }

    async fn observe(&mut self, work: &WorkId) -> Result<(), Error> {
        if !self.inspected.contains(work) {
            if let Some(intent) = self
                .store
                .intent(&self.schedule.epoch.graph_id, work)
                .await?
            {
                // Creation replay restores this activation's bounded child grant.
                self.provision(work).await?;
                self.intents.insert(work.clone(), intent);
            }
            self.inspected.insert(work.clone());
        }
        let Some(intent) = self.intents.get(work) else {
            return Ok(());
        };
        let observation = match self.commands.query(intent.request.operation()).await {
            Ok(observation) => observation,
            Err(CommandError::NotFound) => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let execution = self.executions.entry(work.clone()).or_insert_with(|| {
            Execution::new(
                work.clone(),
                intent.operator_id.clone(),
                observation.clone(),
            )
        });
        if observation.receipt != execution.observation.receipt
            || observation.through_sequence < execution.after
        {
            return Err(Error::Persistence(
                "accepted execution changed identity or regressed".into(),
            ));
        }
        execution.observation = observation;
        let through = execution.observation.through_sequence;
        // Bounded work per pass keeps a large old log from starving fresh control.
        for _ in 0..8 {
            if execution.after == through {
                break;
            }
            let page = self
                .commands
                .events(intent.request.operation(), execution.after, through)
                .await?;
            execution
                .apply_page(page, self.commands.as_ref(), &intent.request.operation())
                .await?;
        }
        if matches!(execution.observation.progress, Progress::Ended { .. })
            && execution.after == through
            && matches!(
                execution.workspace_result,
                crate::projection::WorkspaceResult::Pending
            )
        {
            match self
                .commands
                .workspace_patch(intent.request.operation())
                .await
            {
                Ok(patch) => {
                    execution.workspace_result = crate::projection::WorkspaceResult::Ready(patch)
                }
                Err(CommandError::Busy) => {} // Native cleanup still owns the workspace.
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn provision(&self, work: &WorkId) -> Result<(OperatorId, ChildSession), Error> {
        let item = &self.schedule.work[work];
        let (operator, target) = match &item.work.target {
            Target::Operator { operator_id } => {
                let origin = self
                    .schedule
                    .work
                    .values()
                    .find(|candidate| {
                        !matches!(candidate.work.target, Target::Operator { .. })
                            && operator_id_for(&self.schedule.epoch, &candidate.work.work_id)
                                == *operator_id
                    })
                    .ok_or_else(|| Error::NotFound(operator_id.to_string()))?;
                (operator_id.clone(), &origin.work.target)
            }
            target => (operator_id_for(&self.schedule.epoch, work), target),
        };
        let child = self
            .operators
            .provision(&self.schedule.epoch, &operator, target)
            .await?;
        Ok((operator, child))
    }

    async fn advance(&mut self, work: &WorkId, language: Language) -> Result<(), Error> {
        let item = &self.schedule.work[work];
        let operator = match &item.work.target {
            Target::Operator { operator_id } => operator_id.clone(),
            _ => operator_id_for(&self.schedule.epoch, work),
        };
        let cancelled = self.control.closed()
            || item.status != WorkStatus::Requested
            || self.schedule.stopped.contains_key(operator.as_str())
            || self.executions.get(work).is_some_and(|execution| {
                self.schedule
                    .stopped
                    .contains_key(&execution.observation.receipt.invocation.invocation_id)
                    || self
                        .schedule
                        .stopped
                        .contains_key(&execution.observation.receipt.invocation.run_id)
            });
        if cancelled {
            if let Some(execution) = self.executions.get(work)
                && !matches!(execution.observation.progress, Progress::Ended { .. })
            {
                let intent = &self.intents[work];
                self.commands.cancel(intent.request.operation()).await?;
            }
            return Ok(());
        }
        if self.executions.contains_key(work) {
            return Ok(());
        }
        if self
            .executions
            .values()
            .any(|other| other.operator_id == operator && !other.settled())
        {
            self.waiting
                .insert(work.clone(), vec![format!("operator:{operator}")]);
            return Ok(());
        }
        let request = if let Some(intent) = self.intents.get(work) {
            intent.request.clone()
        } else {
            let mut missing = Vec::new();
            let mut input = String::new();
            for id in &item.work.input_ids {
                if let Some(record) = self.read_record(id).await? {
                    render(&mut input, &record, language)?;
                } else {
                    missing.push(id.clone());
                }
            }
            // Historical results are explicitly selected and resolved by a
            // completed earlier epoch, never by a same-named current record.
            for selection in &item.work.selected_result_inputs {
                render(
                    &mut input,
                    &self.historical_record(selection).await?,
                    language,
                )?;
            }
            if !missing.is_empty() {
                self.waiting.insert(work.clone(), missing);
                return Ok(());
            }
            input.push_str(match language {
                Language::En => "\nTask:\n",
                Language::ZhCn => "\n任务：\n",
                Language::ZhTw => "\n任務：\n",
            });
            input.push_str(&item.work.instruction);
            let (operator_id, child) = self.provision(work).await?;
            let request = Submit {
                orchestration_mode: None,
                operation_id: format!("graph:{}:{work}", self.schedule.epoch.graph_id),
                session_id: child.session_id,
                content: input.into(),
            };
            let intent = self
                .store
                .commit_intent(Intent {
                    graph_id: self.schedule.epoch.graph_id.clone(),
                    work_id: work.clone(),
                    operator_id,
                    request,
                    schedule_revision: self.schedule.revision,
                })
                .await?;
            let request = intent.request.clone();
            self.intents.insert(work.clone(), intent);
            request
        };
        match self.commands.submit(request).await {
            Ok(_) => self.observe(work).await,
            Err(CommandError::Busy) => {
                self.waiting
                    .insert(work.clone(), vec![format!("operator:{operator}")]);
                Ok(())
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn record(&self, id: &str) -> Option<&Record> {
        self.executions.values().find_map(|execution| {
            execution
                .terminal
                .as_ref()
                .filter(|record| record.record_id == id)
                .or_else(|| {
                    execution
                        .recent
                        .iter()
                        .find(|record| record.record_id == id)
                })
        })
    }

    pub async fn read_record(&self, id: &str) -> Result<Option<Record>, Error> {
        if let Some(record) = self
            .record(id)
            .filter(|record| !record.truncated || record.terminal)
        {
            return Ok(Some(record.clone()));
        }
        // Older activity need not remain in memory. The exact lookup is fenced
        // and authorized by its accepted execution, not a global event-ID lookup.
        for (work, execution) in &self.executions {
            let intent = &self.intents[work];
            if let Some(event) = self
                .commands
                .event(
                    intent.request.operation(),
                    id.into(),
                    execution.observation.through_sequence,
                )
                .await?
            {
                let mut projection = Execution::new(
                    work.clone(),
                    execution.operator_id.clone(),
                    execution.observation.clone(),
                );
                return projection
                    .observe(event, self.commands.as_ref(), &intent.request.operation())
                    .await;
            }
        }
        Ok(None)
    }

    async fn historical_record(&self, selection: &HistoricalInput) -> Result<Record, Error> {
        let control = self
            .store
            .control(
                &self.schedule.epoch.root_session_id,
                &selection.source_graph_id,
            )
            .await?;
        if !control.finished || control.epoch.epoch >= self.schedule.epoch.epoch {
            return Err(Error::Invalid(
                "historical input must belong to a completed earlier epoch".into(),
            ));
        }
        let mut previous = Self::new(
            control.epoch,
            self.store.clone(),
            self.commands.clone(),
            self.operators.clone(),
        )?;
        previous.refresh_schedule().await?;
        if !previous
            .schedule
            .finish
            .as_ref()
            .is_some_and(|(finish, _, _)| finish.result_ids.contains(&selection.result_id))
        {
            return Err(Error::Invalid(
                "historical result was not selected by its epoch's finish decision".into(),
            ));
        }
        for work in previous.schedule.work.keys().cloned().collect::<Vec<_>>() {
            loop {
                previous.observe(&work).await?;
                let Some(execution) = previous.executions.get(&work) else {
                    break;
                };
                if execution.after == execution.observation.through_sequence {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
        previous
            .read_record(&selection.result_id)
            .await?
            .ok_or_else(|| Error::NotFound(selection.result_id.clone()))
    }

    pub fn quiescent(&self) -> bool {
        self.executions.values().all(Execution::settled) && self.failures.is_empty()
    }

    pub(crate) fn has_background_work(&self) -> bool {
        !self.quiescent()
            || self.catching_up()
            || (!self.control.closed()
                && self
                    .signal_key()
                    .is_some_and(|signal| self.delivered_signal.as_ref() != Some(&signal)))
    }

    pub async fn wake_supervisor(&mut self, language: Language) -> Result<(), Error> {
        if self.control.closed() {
            return Ok(());
        }
        let Some(signal) = self.signal_key() else {
            return Ok(());
        };
        if self.delivered_signal.as_ref() == Some(&signal) {
            return Ok(());
        }
        let content = if let Some(swarm) = self.swarm_snapshot() {
            let body = serde_json::to_string(&swarm.page(None))
                .map_err(|error| Error::Invalid(error.to_string()))?;
            match language {
                Language::En => format!(
                    "Agent Swarm checkpoint. Current status: agent_swarm_status; original results: view_agent_graph.\n{body}"
                ),
                Language::ZhCn => format!(
                    "Agent Swarm 检查点。当前状态：agent_swarm_status；原始结果：view_agent_graph。\n{body}"
                ),
                Language::ZhTw => format!(
                    "Agent Swarm 檢查點。目前狀態：agent_swarm_status；原始結果：view_agent_graph。\n{body}"
                ),
            }
        } else {
            let body = serde_json::to_string(&self.snapshot())
                .map_err(|error| Error::Invalid(error.to_string()))?;
            match language {
                Language::En => format!(
                    "Agent Graph has new durable outcomes. Original results: view_agent_graph.\n{body}"
                ),
                Language::ZhCn => {
                    format!("Agent Graph 有新的持久结果。原始结果：view_agent_graph。\n{body}")
                }
                Language::ZhTw => {
                    format!("Agent Graph 有新的持久結果。原始結果：view_agent_graph。\n{body}")
                }
            }
        };
        let wake = self
            .store
            .commit_wake(Wake {
                graph_id: self.schedule.epoch.graph_id.clone(),
                snapshot_key: signal.clone(),
                request: Submit {
                    orchestration_mode: Some(match self.schedule.epoch.mode {
                        crate::Mode::Graph => {
                            maka_agent_facts::execution::BehaviorId::try_from("graph".to_owned())
                                .unwrap()
                        }
                        crate::Mode::Swarm => {
                            maka_agent_facts::execution::BehaviorId::try_from("swarm".to_owned())
                                .unwrap()
                        }
                    }),
                    operation_id: format!("graph-wake:{}", signal.strip_prefix("sha256:").unwrap()),
                    session_id: self.schedule.epoch.root_session_id.clone(),
                    content: content.into(),
                },
            })
            .await?;
        match self.commands.submit(wake.request).await {
            Ok(_) => {
                self.delivered_signal = Some(signal);
                Ok(())
            }
            Err(CommandError::Busy) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

pub fn operator_id_for(epoch: &Epoch, work: &WorkId) -> OperatorId {
    let identity = serde_json::to_vec(&(&epoch.graph_id, work)).expect("typed identity serializes");
    format!("graph_operator_{}", hex::encode(Sha256::digest(identity)))
        .try_into()
        .expect("generated identity")
}

fn render(text: &mut String, record: &Record, language: Language) -> Result<(), Error> {
    text.push_str(&match language {
        Language::En => format!(
            "\nWorker result {} (work {}):\n",
            record.record_id, record.work_id
        ),
        Language::ZhCn => format!(
            "\n工作 Agent 结果 {}（工作 {}）：\n",
            record.record_id, record.work_id
        ),
        Language::ZhTw => format!(
            "\n工作 Agent 結果 {}（工作 {}）：\n",
            record.record_id, record.work_id
        ),
    });
    text.push_str(&record.text);
    if record.truncated {
        text.push_str(match language {
            Language::En => {
                "\n[Output preview truncated; inspect the source execution for full content.]"
            }
            Language::ZhCn => "\n[输出预览已截断；检查源执行以获取完整内容。]",
            Language::ZhTw => "\n[輸出預覽已截斷；檢查來源執行以取得完整內容。]",
        });
    }
    Ok(())
}
