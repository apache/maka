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
use maka_agent_api::executor::{IndexedOutput, TaskObservation, TaskState};
use maka_agent_facts::durable::ExternalTaskId;
use maka_plugin_core::operation::{OperationCleanup, RecoveryRef};
use maka_plugin_core::storage::{Data, Mutation, Store, StoreError};
use serde::Deserialize;
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
struct Head {
    observed: u64,
    state: TaskState,
    cleanup: OperationCleanup,
    #[serde(default)]
    process: Option<ProcessLink>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "original", rename_all = "snake_case")]
enum ProcessLink {
    Admitted(RecoveryRef),
    Started(RecoveryRef),
}
impl ProcessLink {
    fn original(&self) -> &RecoveryRef {
        match self {
            Self::Admitted(original) | Self::Started(original) => original,
        }
    }
}
pub(super) struct Original {
    pub input: maka_agent_api::executor::Execute,
    pub process: Option<RecoveryRef>,
}
pub(super) struct Journal {
    storage: Arc<storage::Storage>,
    data: maka_event_log::root_store::DataWriter,
    // Actual accepted work, not durable authority reconstructed on restart.
    retained: Mutex<BTreeMap<String, Arc<Context>>>,
}
impl Journal {
    pub fn new(
        storage: Arc<storage::Storage>,
        data: maka_event_log::root_store::DataWriter,
    ) -> Self {
        Self {
            storage,
            data,
            retained: Mutex::default(),
        }
    }
    pub fn is_idle(&self) -> bool {
        self.retained.lock().unwrap().is_empty()
    }
    pub fn key(context: &Context, task: ExternalTaskId) -> Result<String, String> {
        let execution = context
            .scope()
            .identity
            .agent()
            .ok_or("ACP requires an Agent execution")?;
        Ok(format!(
            "tasks/{}/{}",
            calls::digest(&(context.requester().instance(), &execution.session_id)),
            task
        ))
    }
    fn mutation(
        key: String,
        revision: Option<u64>,
        value: &impl Serialize,
    ) -> Result<Mutation, String> {
        Ok(Mutation {
            key,
            expected_revision: revision,
            data: Data::Present(serde_json::to_value(value).map_err(|e| e.to_string())?),
        })
    }
    async fn head(&self, key: &str) -> Result<Option<(u64, Head)>, String> {
        self.storage
            .read(format!("{key}/head"))
            .await
            .map_err(|e| e.to_string())?
            .map(|record| {
                let head = serde_json::from_value(
                    record.data.value().ok_or("ACP task head deleted")?.clone(),
                )
                .map_err(|e| e.to_string())?;
                Ok((record.revision, head))
            })
            .transpose()
    }
    pub async fn begin(
        &self,
        key: &str,
        frozen: Value,
        context: Arc<Context>,
    ) -> Result<bool, String> {
        let input_key = format!("{key}/input");
        if let Some(record) = self
            .storage
            .read(input_key.clone())
            .await
            .map_err(|e| e.to_string())?
        {
            return if record.data.value() == Some(&frozen) {
                Ok(false)
            } else {
                Err("ACP task input conflicts with its original admission".into())
            };
        }
        let head = Head {
            observed: 0,
            state: TaskState::Running,
            cleanup: OperationCleanup::Unconfirmed,
            process: None,
        };
        match self
            .storage
            .batch(vec![
                Self::mutation(input_key.clone(), None, &frozen)?,
                Self::mutation(format!("{key}/head"), None, &head)?,
            ])
            .await
        {
            Ok(_) => {
                self.retained.lock().unwrap().insert(key.into(), context);
                Ok(true)
            }
            Err(StoreError::Conflict { .. }) => {
                let original = self
                    .storage
                    .read(input_key)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("ACP task admission disappeared")?;
                if original.data.value() == Some(&frozen) {
                    Ok(false)
                } else {
                    Err("ACP task input conflicts with its original admission".into())
                }
            }
            Err(error) => Err(error.to_string()),
        }
    }
    pub async fn append(
        &self,
        key: &str,
        output: maka_agent_facts::executor::Output,
    ) -> Result<(), String> {
        self.update_head(key, |head| {
            if !matches!(head.state, TaskState::Running) {
                return Err("ACP task output after closure".into());
            }
            let indexed = IndexedOutput {
                index: head.observed,
                output: output.clone(),
            };
            head.observed = head
                .observed
                .checked_add(1)
                .filter(|count| *count <= 9_007_199_254_740_991)
                .ok_or("ACP output cursor exhausted")?;
            Ok(Some(vec![Self::mutation(
                format!("{key}/outputs/{:020}", indexed.index),
                None,
                &indexed,
            )?]))
        })
        .await
    }
    async fn update_head(
        &self,
        key: &str,
        change: impl Fn(&mut Head) -> Result<Option<Vec<Mutation>>, String>,
    ) -> Result<(), String> {
        loop {
            let (revision, mut head) = self.head(key).await?.ok_or("ACP task missing")?;
            let Some(mut mutations) = change(&mut head)? else {
                return Ok(());
            };
            mutations.push(Self::mutation(
                format!("{key}/head"),
                Some(revision),
                &head,
            )?);
            match self.storage.batch(mutations).await {
                Ok(_) => return Ok(()),
                Err(StoreError::Conflict { .. }) => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    pub async fn process(
        &self,
        key: &str,
        original: RecoveryRef,
        started: bool,
    ) -> Result<(), String> {
        self.update_head(key, |head| {
            if let Some(process) = &head.process {
                if process.original() != &original {
                    return Err("ACP original process reference changed".into());
                }
                if !started || matches!(process, ProcessLink::Started(_)) {
                    return Ok(None);
                }
            }
            head.process = Some(if started {
                ProcessLink::Started(original.clone())
            } else {
                ProcessLink::Admitted(original.clone())
            });
            Ok(Some(Vec::new()))
        })
        .await
    }
    pub async fn original(&self, key: &str) -> Result<Option<Original>, String> {
        let Some((_, head)) = self.head(key).await? else {
            return Ok(None);
        };
        let record = self
            .storage
            .read(format!("{key}/input"))
            .await
            .map_err(|e| e.to_string())?
            .ok_or("ACP original task input missing")?;
        let input = serde_json::from_value(
            record
                .data
                .value()
                .and_then(|value| value.get("input"))
                .ok_or("ACP original task input deleted")?
                .clone(),
        )
        .map_err(|e| e.to_string())?;
        Ok(Some(Original {
            input,
            process: head
                .process
                .as_ref()
                .map(|process| process.original().clone()),
        }))
    }
    pub async fn state(&self, key: &str, state: TaskState) -> Result<(), String> {
        self.update_head(key, |head| {
            if matches!(head.state, TaskState::Closed { .. }) {
                return if serde_json::to_value(&head.state).map_err(|e| e.to_string())?
                    == serde_json::to_value(&state).map_err(|e| e.to_string())?
                {
                    Ok(None)
                } else {
                    Err("ACP closed task outcome changed".into())
                };
            }
            head.state = state.clone();
            Ok(Some(Vec::new()))
        })
        .await
    }
    pub async fn cleanup(&self, key: &str, physical: OperationCleanup) -> Result<(), String> {
        self.update_head(key, |head| {
            if head.cleanup == OperationCleanup::Confirmed || head.cleanup == physical {
                return Ok(None);
            }
            head.cleanup = physical.clone();
            Ok(Some(Vec::new()))
        })
        .await
    }
    pub async fn prevented(&self, key: &str) -> Result<(), String> {
        self.update_head(key, |head| {
            if head.observed != 0
                || matches!(head.process, Some(ProcessLink::Started(_)))
                || matches!(head.state, TaskState::Closed { .. })
            {
                return Err("ACP original task creation contradicts prevention proof".into());
            }
            if head.cleanup == OperationCleanup::Confirmed {
                return Ok(None);
            }
            head.cleanup = OperationCleanup::Confirmed;
            Ok(Some(Vec::new()))
        })
        .await
    }
    pub fn root_settled(&self, key: &str) {
        self.retained.lock().unwrap().remove(key);
    }
    async fn page(
        &self,
        key: &str,
        task_id: ExternalTaskId,
        after: Option<u64>,
    ) -> Result<(TaskObservation, bool), String> {
        let Some((_, head)) = self.head(key).await? else {
            return Ok((TaskObservation::Missing, false));
        };
        if after.is_some_and(|after| after > head.observed) {
            return Err("ACP observation cursor exceeds committed output".into());
        }
        let end = after.map_or(0, |after| after.saturating_add(256).min(head.observed));
        let mut outputs = Vec::with_capacity((end - after.unwrap_or(0)) as usize);
        for index in after.unwrap_or(0)..end {
            let record = self
                .storage
                .read(format!("{key}/outputs/{index:020}"))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("ACP committed output is missing")?;
            let output: IndexedOutput =
                serde_json::from_value(record.data.value().ok_or("ACP output deleted")?.clone())
                    .map_err(|e| e.to_string())?;
            if output.index != index {
                return Err("ACP output index changed".into());
            }
            outputs.push(output);
        }
        let more = after.is_some() && end < head.observed;
        let state = match head.state {
            TaskState::Running if !self.retained.lock().unwrap().contains_key(key) => TaskState::Unknown { diagnostic: "Original ACP task has no live process witness in this activation; it will not be restarted".into() },
            state => state,
        };
        Ok((
            TaskObservation::Found {
                task_id,
                observed: end,
                has_more: more,
                outputs,
                state,
                cleanup: head.cleanup,
            },
            more,
        ))
    }
    pub async fn observe(
        self: &Arc<Self>,
        context: &Arc<Context>,
        task_id: ExternalTaskId,
        mut after: Option<u64>,
        mut completion: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
        calls: &Arc<calls::Calls>,
    ) -> HandlerResult {
        let execute = completion.is_some();
        let mut completed = None;
        let key = Self::key(context, task_id)?;
        let mut changes = self.data.subscribe_changes().map_err(|e| e.to_string())?;
        let mut previous = None;
        let mut source: Option<calls::ProcessWatch> = None;
        let result = async {
        loop {
            changes.borrow_and_update();
            let (page, more) = self.page(&key, task_id, after).await?;
            if execute {
                match page {
                    TaskObservation::Missing => {
                        return Err(HandlerError::Unknown {
                            diagnostic: "ACP task admission not observed".into(),
                        });
                    }
                    TaskObservation::Found {
                        observed,
                        has_more,
                        outputs,
                        state,
                        ..
                    } => {
                        for output in outputs {
                            context
                                .emit(serde_json::to_value(output).map_err(|e| e.to_string())?)
                                .await?;
                        }
                        after = Some(observed);
                        if has_more {
                            continue;
                        }
                        if let TaskState::Closed { outcome } = &state {
                            return Ok(HandlerValue::Json(serde_json::to_value(outcome).map_err(|e| e.to_string())?));
                        }
                        if let Some(receiver) = completion.as_mut() {
                            match receiver.try_recv() {
                                Ok(result) => {
                                    completed = Some(result);
                                    completion = None;
                                    continue;
                                }
                                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                                    completed = Some(Err("ACP task worker disappeared".into()));
                                    completion = None;
                                    continue;
                                }
                                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                            }
                        }
                        // Re-read the tail after observing original completion;
                        // its failure cannot discard already committed output.
                        if let Some(result) = completed.take() {
                            match state {
                                TaskState::Closed { outcome } => {
                                    return Ok(HandlerValue::Json(
                                        serde_json::to_value(outcome).map_err(|e| e.to_string())?,
                                    ));
                                }
                                TaskState::Unknown { diagnostic } => {
                                    result.map_err(|diagnostic| HandlerError::Unknown { diagnostic })?;
                                    return Err(HandlerError::Unknown { diagnostic });
                                }
                                TaskState::Running => {
                                    result.map_err(|diagnostic| HandlerError::Unknown { diagnostic })?;
                                    return Err(HandlerError::Unknown {
                                        diagnostic: "ACP task worker completed without a terminal observation".into(),
                                    });
                                }
                            }
                        }
                    }
                }
            } else {
                if source.is_none()
                    && matches!(&page, TaskObservation::Found { cleanup, .. } if *cleanup != OperationCleanup::Confirmed)
                    && let Some(original) = self.original(&key).await?
                    && (original.process.is_some() || !self.retained.lock().unwrap().contains_key(&key))
                {
                    if original.input.task_id != task_id {
                        return Err("ACP original task identity changed".into());
                    }
                    source = Some(calls.watch_process(self.clone(), key.clone(), context.clone(), original)?);
                }
                let value = serde_json::to_value(&page).map_err(|e| e.to_string())?;
                if previous.as_ref() != Some(&value) {
                    context.emit(value.clone()).await?;
                    previous = Some(value);
                }
                if after.is_some()
                    && let TaskObservation::Found { observed, .. } = page
                {
                    after = Some(observed);
                }
            }
            if more {
                continue;
            }
            tokio::select! {
                biased;
                () = context.scope().cancellation.cancelled() => return if execute {
                    Err(HandlerError::Unknown { diagnostic: "ACP execution observation cancelled; inspect the original task".into() })
                } else { Ok(HandlerValue::Json(Value::Null)) },
                done = async {
                    match completion.as_mut() {
                        Some(receiver) => receiver.await,
                        None => std::future::pending().await,
                    }
                } => {
                    completed = Some(done.unwrap_or_else(|_| Err("ACP task worker disappeared".into())));
                    completion = None;
                }
                changed = changes.changed() => { changed.map_err(|e| e.to_string())?; }
                done = async {
                    match source.as_mut().and_then(|source| source.finished.as_mut()) {
                        Some(finished) => finished.await,
                        None => std::future::pending().await,
                    }
                } => {
                    source.as_mut().expect("original process source").finished = None;
                    done.map_err(|_| "ACP cleanup source owner disappeared")??;
                }
            }
        }
        }.await;
        if let Some(mut source) = source {
            source.close().await;
        }
        result
    }
}
pub(super) struct Output {
    pub journal: Arc<Journal>,
    pub key: String,
    pub serial: tokio::sync::Mutex<()>,
}
impl executor::OutputSink for Output {
    fn emit(
        &self,
        output: maka_agent_facts::executor::Output,
    ) -> BoxFuture<'_, Result<(), executor::Error>> {
        Box::pin(async move {
            let _serial = self.serial.lock().await;
            self.journal
                .append(&self.key, output)
                .await
                .map_err(executor::Error::Persistence)
        })
    }
}
