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

use super::{CodeInput, WaitInput};
use crate::availability::Availability;
use crate::{CodeExecutor, PreparedEffect, ToolCatalog, ToolDefinition};
use futures_util::FutureExt;
use maka_agent_facts::{
    cells::*,
    durable::{ContentRef, FactId, UnixMillis},
    tool_call::ToolRejection,
    tool_output::{ToolContent, ToolOutput, ToolSuccess},
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_code_runtime::{CellContext, CellOutput, CellResult, CellStore, ToolMetadata};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use uuid::Uuid;

#[cfg(test)]
mod tests;

pub type CellFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, ToolError>> + Send + 'a>>;
#[derive(Clone, Debug)]
pub struct CellChange {
    pub id: FactId,
    pub at: UnixMillis,
    pub event: CellEvent,
}
impl CellChange {
    pub fn new(event: CellEvent, at: UnixMillis) -> Self {
        Self {
            id: FactId::new(),
            at,
            event,
        }
    }
}
#[derive(Clone)]
pub struct CellContent {
    pub reference: ContentRef,
    pub bytes: Vec<u8>,
}
impl CellContent {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            reference: ContentRef {
                digest: maka_agent_facts::artifact::content_digest(&bytes),
                bytes: bytes.len() as u64,
            },
            bytes,
        }
    }
    pub fn json(value: &impl Serialize) -> Result<Self, ToolError> {
        serde_json::to_vec(value)
            .map(Self::new)
            .map_err(persistence)
    }
}
/// An actual Native owner supplies this port and retains its original work custody.
/// It validates canonical CellStarted/ChildPrepared before invoking the Host.
/// The Host journals its original CallerIntent before final admission; Cell binding
/// and receipt observations may arrive later, including after observer loss.
/// A persisted CellOwner or this trait's Rust implementation is not itself a Host grant.
pub trait CellPersistence: Send + Sync {
    fn owner(&self) -> CellOwner;
    fn now(&self) -> UnixMillis;
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()>;
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>>;
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>>;
    /// Execute one new child under this Cell's original real capability. The
    /// adapter owns canonical ChildPrepared/Bound/Observed and original resources.
    fn invoke(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> ToolFuture<ToolOutput>;
}
#[derive(Clone)]
pub struct CodeCells(Arc<State>);
struct State {
    executor: CodeExecutor,
    store: CellStore,
    live: Mutex<BTreeMap<CellId, Arc<Live>>>,
    displayed: Mutex<BTreeMap<CellId, usize>>,
    starting: Mutex<BTreeSet<CellId>>,
    tasks: TaskTracker,
    physical_changes: watch::Sender<()>,
    cancellation: CancellationToken,
    execution: Arc<tokio::sync::RwLock<()>>,
    admission: tokio::sync::Mutex<()>,
}
struct StartingCell {
    state: Arc<State>,
    cell: CellId,
}
impl Drop for StartingCell {
    fn drop(&mut self) {
        self.state.starting.lock().unwrap().remove(&self.cell);
        self.state.physical_changes.send_replace(());
    }
}
struct Live {
    context: CellContext,
    cancel: CancellationToken,
    observer: tokio::sync::Mutex<()>,
    done: watch::Receiver<Option<Result<(), ToolError>>>,
    output: Mutex<Vec<CellOutput>>,
}
pub use maka_agent_facts::cells::CellObservation;

#[derive(Clone)]
pub struct CellAdmission {
    id: CellId,
    started: CellChange,
    source: CellContent,
}
impl CellAdmission {
    pub fn new(source: String, owner: CellOwner, at: UnixMillis) -> Self {
        let id = match &owner {
            CellOwner::Agent { link, call } => CellId::for_agent(*link, call),
            CellOwner::Standalone { .. } => CellId::new(),
        };
        let source = CellContent::new(source.into_bytes());
        let started = CellChange {
            id: id.started_fact_id(),
            at,
            event: CellEvent::Started {
                cell: id,
                owner,
                source: source.reference.clone(),
            },
        };
        Self {
            id,
            started,
            source,
        }
    }
    pub fn id(&self) -> CellId {
        self.id
    }
}
#[derive(Clone)]
pub struct ObservedCell {
    pub state: CellReplyState,
    pub observation: CellObservation,
    display_from: usize,
}
impl ObservedCell {
    pub fn display(&self) -> &[CellOutput] {
        match &self.observation {
            CellObservation::Running { content, .. }
            | CellObservation::Completed { content, .. } => &content[self.display_from..],
            CellObservation::Interrupted { .. } => &[],
        }
    }
}

impl CodeCells {
    pub fn new(executor: CodeExecutor, store: CellStore) -> Self {
        Self(Arc::new(State {
            executor,
            store,
            live: Mutex::default(),
            displayed: Mutex::default(),
            starting: Mutex::default(),
            tasks: TaskTracker::new(),
            physical_changes: watch::channel(()).0,
            cancellation: CancellationToken::new(),
            execution: Arc::default(),
            admission: tokio::sync::Mutex::new(()),
        }))
    }
    pub fn definitions(&self, availability: &Availability) -> Vec<ToolDefinition> {
        Self::definitions_for(availability, self.0.executor.language())
    }
    pub fn definitions_for(
        availability: &Availability,
        language: maka_agent_facts::execution::CodeLanguage,
    ) -> Vec<ToolDefinition> {
        // Code Mode discovers deferred tools through ALL_TOOLS. Promoting
        // them into exec's description after a call invalidates the prefix.
        let visible = availability.select(&BTreeSet::new());
        let mut exec = super::definition(language);
        exec.description.push_str(&super::declarations(
            visible.nested().definitions(),
            language,
        ));
        let mut definitions = vec![exec, super::wait_definition()];
        definitions.extend(availability.direct_only().definitions().cloned());
        definitions
    }
    pub fn prepare(
        &self,
        name: &str,
        input: &Value,
        catalog: ToolCatalog,
        port: Arc<dyn CellPersistence>,
        cancellation: CancellationToken,
        steering: CancellationToken,
    ) -> Result<PreparedEffect, ToolRejection> {
        let cells = self.clone();
        match name {
            "exec" => {
                let input = super::source(input, self.0.executor.language())?;
                Ok(PreparedEffect::new(move |effect_cancel| {
                    Box::pin(async move {
                        if cancellation.is_cancelled() {
                            return Err(ToolError::Failed(
                                "Cell call cancelled before start".into(),
                            ));
                        }
                        cells
                            .start(input, catalog, port, effect_cancel, steering)
                            .await
                    })
                })
                .titled(maka_agent_facts::display::Text::localized(
                    "Run script",
                    "运行脚本",
                    "執行腳本",
                ))
                .presented("maka.agent.Builtin@1/exec".into()))
            }
            "wait" => {
                let input = super::wait_input(input)?;
                let title = if input.terminate {
                    maka_agent_facts::display::Text::localized(
                        "Stop script",
                        "停止脚本",
                        "停止腳本",
                    )
                } else {
                    maka_agent_facts::display::Text::localized(
                        "Wait for script",
                        "等待脚本",
                        "等待腳本",
                    )
                };
                Ok(PreparedEffect::new(move |effect_cancel| {
                    Box::pin(
                        async move { cells.observe(input, port, effect_cancel, steering).await },
                    )
                })
                .titled(title)
                .presented("maka.agent.Builtin@1/wait".into()))
            }
            _ => Err(ToolRejection::Unavailable),
        }
    }
    pub fn cancel(&self) {
        self.0.cancellation.cancel();
        for cell in self.0.live.lock().unwrap().values() {
            cell.cancel.cancel();
        }
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancellation.is_cancelled()
    }
    /// Physical interpreter liveness only; canonical existence always comes from the port.
    pub fn physical_changes(&self) -> watch::Receiver<()> {
        self.0.physical_changes.subscribe()
    }
    pub fn has_live(&self, cell: CellId) -> bool {
        self.0.starting.lock().unwrap().contains(&cell)
            || self
                .0
                .live
                .lock()
                .unwrap()
                .get(&cell)
                .is_some_and(|live| live.done.borrow().is_none())
    }
    pub fn is_idle(&self) -> bool {
        self.0.starting.lock().unwrap().is_empty()
            && self
                .0
                .live
                .lock()
                .unwrap()
                .values()
                .all(|c| c.done.borrow().is_some())
    }
    pub async fn shutdown(&self) -> Result<(), ToolError> {
        self.cancel();
        let _admission = self.0.admission.lock().await;
        self.0.tasks.close();
        self.0.tasks.wait().await;
        let cells = std::mem::take(&mut *self.0.live.lock().unwrap());
        let failure = cells
            .values()
            .find_map(|cell| match &*cell.done.borrow() {
                Some(Err(
                    error @ (ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                )) => Some(error.clone()),
                _ => None,
            })
            .or_else(|| {
                cells.values().find_map(|cell| match &*cell.done.borrow() {
                    Some(Err(error)) => Some(error.clone()),
                    _ => None,
                })
            });
        drop(cells);
        self.0.displayed.lock().unwrap().clear();
        match failure {
            Some(error) => Err(cell_failure(error)),
            None => Ok(()),
        }
    }
    async fn start(
        &self,
        input: CodeInput,
        catalog: ToolCatalog,
        port: Arc<dyn CellPersistence>,
        cancellation: CancellationToken,
        steering: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        let admission = CellAdmission::new(input.code, port.owner(), port.now());
        let id = self
            .start_cell(&admission, catalog, port.clone(), cancellation.clone())
            .await?;
        let observed = self
            .observe_cell(
                id,
                Duration::from_millis(input.yield_time_ms),
                false,
                port,
                cancellation,
                steering,
            )
            .await?;
        tokio::task::spawn_blocking(move || {
            Self::project_observation(id, observed, input.max_output_tokens)
        })
        .await
        .map_err(persistence)
    }
    /// Retain this admission on uncertain acknowledgement. An existing canonical
    /// identity is observed, never permission to start its script a second time.
    pub async fn start_cell(
        &self,
        admission: &CellAdmission,
        catalog: ToolCatalog,
        port: Arc<dyn CellPersistence>,
        cancellation: CancellationToken,
    ) -> Result<CellId, ToolError> {
        let _admission = self.0.admission.lock().await;
        if self.0.cancellation.is_cancelled() || cancellation.is_cancelled() {
            return Err(ToolError::Failed("code owner is closed".into()));
        }
        let id = admission.id;
        self.0.starting.lock().unwrap().insert(id);
        let _starting = StartingCell {
            state: self.0.clone(),
            cell: id,
        };
        if port.owner()
            != match &admission.started.event {
                CellEvent::Started { owner, .. } => owner.clone(),
                _ => unreachable!(),
            }
        {
            return Err(ToolError::Failed(
                "Cell admission belongs to another owner".into(),
            ));
        }
        if let Some(original) = port.read(id).await? {
            if original.owner != port.owner() || original.source != admission.source.reference {
                return Err(ToolError::Persistence(
                    "Cell admission identity conflict".into(),
                ));
            }
            return Ok(id);
        }
        // Durable admission precedes every script instruction and child effect.
        port.append(
            vec![admission.started.clone()],
            vec![admission.source.clone()],
        )
        .await?;
        let source = String::from_utf8(admission.source.bytes.clone()).map_err(persistence)?;
        let nested_catalog = catalog.nested();
        let direct = super::DirectAliases::new(
            &self.0.executor,
            &nested_catalog,
            &catalog.direct_only().names(),
        );
        let catalog = nested_catalog;
        let metadata = catalog
            .definitions()
            .map(|d| ToolMetadata {
                name: self.0.executor.tool_identifier(&d.name),
                description: super::declarations(std::iter::once(d), self.0.executor.language()),
            })
            .collect();
        let context = CellContext::new(self.0.store.clone(), metadata)
            .map_err(|e| ToolError::Persistence(e.message))?;
        let (done, receiver) = watch::channel(None);
        let live = Arc::new(Live {
            context: context.clone(),
            cancel: cancellation.child_token(),
            observer: tokio::sync::Mutex::new(()),
            done: receiver,
            output: Mutex::default(),
        });
        self.0.live.lock().unwrap().insert(id, live.clone());
        if self.0.cancellation.is_cancelled() {
            live.cancel.cancel();
        }
        let state = self.0.clone();
        let worker_port = port.clone();
        let worker_live = live.clone();
        self.0.tasks.spawn(async move {
            let work = std::panic::AssertUnwindSafe(run_cell(
                state.clone(),
                worker_live.clone(),
                id,
                source,
                catalog,
                direct,
                worker_port.clone(),
            ))
            .catch_unwind()
            .await;
            let result = match work {
                Ok(result) => result,
                Err(_) => Err(record_vm_uncertainty(
                    &worker_port,
                    id,
                    &worker_live,
                    "Cell worker panicked; VM cleanup requires original closure evidence".into(),
                )
                .await),
            };
            let complete = result.is_ok();
            done.send_replace(Some(result));
            if complete {
                state.live.lock().unwrap().remove(&id);
            }
            state.physical_changes.send_replace(());
        });
        Ok(id)
    }
    async fn observe(
        &self,
        input: WaitInput,
        port: Arc<dyn CellPersistence>,
        cancellation: CancellationToken,
        steering: CancellationToken,
    ) -> Result<ToolSuccess, ToolError> {
        let uuid = Uuid::parse_str(&input.cell_id)
            .map_err(|_| ToolError::Failed("invalid Cell identity".into()))?;
        let id = CellId::try_from(uuid).map_err(|e| ToolError::Failed(e.into()))?;
        let observed = self
            .observe_cell(
                id,
                Duration::from_millis(input.yield_time_ms),
                input.terminate,
                port,
                cancellation,
                steering,
            )
            .await?;
        tokio::task::spawn_blocking(move || {
            Self::project_observation(id, observed, input.max_tokens)
        })
        .await
        .map_err(persistence)
    }
    pub async fn observe_cell(
        &self,
        id: CellId,
        yield_time: Duration,
        terminate: bool,
        port: Arc<dyn CellPersistence>,
        cancellation: CancellationToken,
        steering: CancellationToken,
    ) -> Result<ObservedCell, ToolError> {
        // Absence in the live map has no historical meaning, including after restart.
        let mut canonical = port
            .read(id)
            .await
            .map_err(cell_failure)?
            .ok_or_else(|| ToolError::Failed("Cell was not recorded in this session".into()))?;
        let live = self.0.live.lock().unwrap().get(&id).cloned();
        let _observer = live
            .as_ref()
            .map(|live| {
                live.observer
                    .try_lock()
                    .map_err(|_| ToolError::Failed("Cell already has an observer".into()))
            })
            .transpose()?;
        let mut new_output = Vec::new();
        if let Some(live) = &live {
            if terminate {
                live.cancel.cancel();
            }
            let mut done = live.done.clone();
            if done.borrow().is_none() {
                tokio::select! {
                    _=cancellation.cancelled()=>return Err(ToolError::Failed("Cell observation cancelled".into())),
                    _=steering.cancelled(),if !terminate=>{},
                    _=done.changed()=>{},
                    _=live.context.yielded(),if !terminate=>{},
                    _=tokio::time::sleep(yield_time)=>{},
                }
            }
            // Worker failures fence Cell execution, not this control call's Host
            // operation. The Cell owner retains child and VM cleanup obligations.
            {
                let mut output = live.output.lock().unwrap();
                new_output = live.context.take_output();
                output.extend(new_output.iter().cloned());
            }
            canonical = port
                .read(id)
                .await
                .map_err(cell_failure)?
                .ok_or_else(|| ToolError::Persistence("admitted Cell disappeared".into()))?;
            if matches!(canonical.status, CellStatus::Running) {
                let finished = done.borrow().clone();
                match finished {
                    Some(Err(error)) => return Err(cell_failure(error)),
                    Some(Ok(())) => {
                        canonical = port
                            .read(id)
                            .await
                            .map_err(cell_failure)?
                            .ok_or_else(|| persistence("admitted Cell disappeared"))?;
                        if matches!(canonical.status, CellStatus::Running) {
                            return Err(persistence(
                                "Cell worker completed without a canonical terminal observation",
                            ));
                        }
                    }
                    None => {
                        if !live.cancel.is_cancelled()
                            && let Some(error) = live.context.failure()
                        {
                            return Err(cell_failure(error));
                        }
                    }
                }
            }
        }
        let evidence = match &canonical.status {
            CellStatus::Running => CellReplyState::Running,
            CellStatus::Completed { result, .. } => CellReplyState::Completed {
                result: result.clone(),
            },
            CellStatus::Interrupted { report } => CellReplyState::Interrupted {
                report: report.clone(),
            },
        };
        let observation = match canonical.status {
            CellStatus::Running => CellObservation::Running {
                cell_id: id,
                content: new_output,
            },
            CellStatus::Completed { result, .. } => {
                let bytes = port.content(id, result).await.map_err(cell_failure)?;
                let completion = tokio::task::spawn_blocking(move || {
                    serde_json::from_slice::<CellObservation>(&bytes).map_err(persistence)
                })
                .await
                .map_err(persistence)??;
                self.0.live.lock().unwrap().remove(&id);
                completion
            }
            CellStatus::Interrupted { report } => {
                use maka_agent_facts::operation::{restore_result, result_reference};
                let bytes = port.content(id, report).await.map_err(cell_failure)?;
                self.0.live.lock().unwrap().remove(&id);
                let mut report: CellInterruption = tokio::task::spawn_blocking(move || {
                    serde_json::from_slice(&bytes).map_err(persistence)
                })
                .await
                .map_err(persistence)??;
                for reply in report
                    .children
                    .values_mut()
                    .filter_map(|child| child.reply.as_mut())
                {
                    if let Some(reference) = result_reference(reply).cloned() {
                        let bytes = port.content(id, reference).await.map_err(cell_failure)?;
                        let stored =
                            tokio::task::spawn_blocking(move || serde_json::from_slice(&bytes))
                                .await
                                .map_err(persistence)?
                                .map_err(persistence)?;
                        restore_result(reply, stored).map_err(persistence)?;
                    }
                }
                let report = tokio::task::spawn_blocking(move || serde_json::to_value(report))
                    .await
                    .map_err(persistence)?
                    .map_err(persistence)?;
                CellObservation::Interrupted {
                    cell_id: id,
                    report,
                }
            }
        };
        let display_from = match &observation {
            CellObservation::Running { content, .. } => {
                *self.0.displayed.lock().unwrap().entry(id).or_default() += content.len();
                0
            }
            CellObservation::Completed { .. } => {
                self.0.displayed.lock().unwrap().remove(&id).unwrap_or(0)
            }
            CellObservation::Interrupted { .. } => {
                self.0.displayed.lock().unwrap().remove(&id);
                0
            }
        };
        Ok(ObservedCell {
            state: evidence,
            observation,
            display_from,
        })
    }
}
async fn run_cell(
    state: Arc<State>,
    live: Arc<Live>,
    id: CellId,
    source: String,
    catalog: ToolCatalog,
    direct: super::DirectAliases,
    port: Arc<dyn CellPersistence>,
) -> Result<(), ToolError> {
    let nested = Arc::new(Nested {
        port: port.clone(),
        cell: id,
        catalog,
        execution: state.execution.clone(),
        context: live.context.clone(),
        cell_cancel: live.cancel.clone(),
    });
    let prepared = match state
        .executor
        .prepare_module(source, nested, live.cancel.clone(), live.context.clone())
        .await
    {
        Ok(prepared) => prepared,
        Err(maka_code_runtime::CellAbort::VmCleanupUnconfirmed(message)) => {
            return Err(record_vm_uncertainty(&port, id, &live, message).await);
        }
        Err(error) => return record_closed_interruption(&port, id, error.to_string(), None).await,
    };
    let binding = prepared.binding().clone();
    let descriptor = match CellContent::json(&binding.descriptor) {
        Ok(descriptor) => descriptor,
        Err(error) => {
            if let Err(cleanup) = prepared.abort().await {
                return Err(record_vm_uncertainty(
                    &port,
                    id,
                    &live,
                    format!("{error}; prepared VM cleanup: {cleanup}"),
                )
                .await);
            }
            record_closed_interruption(&port, id, error.to_string(), None).await?;
            state.executor.release_binding(&binding);
            return Err(error);
        }
    };
    let change = CellChange::new(
        CellEvent::VmBound {
            cell: id,
            binding: CellVmBinding {
                runtime: binding.runtime.clone(),
                version: binding.version,
                descriptor: descriptor.reference.clone(),
            },
        },
        port.now(),
    );
    if let Err(error) = port.append(vec![change], vec![descriptor]).await {
        live.context.fail(error.clone());
        if let Err(cleanup) = prepared.abort().await {
            return Err(record_vm_uncertainty(
                &port,
                id,
                &live,
                format!("{error}; prepared VM cleanup: {cleanup}"),
            )
            .await);
        }
        record_closed_interruption(&port, id, error.to_string(), None).await?;
        state.executor.release_binding(&binding);
        return Err(error);
    }
    let run = prepared.execute_bound();
    tokio::pin!(run);
    let result = loop {
        tokio::select! {
            biased;
            _=live.context.notified()=>{
                if let Err(error)=publish_notifications(&live.context,id,&port).await {
                    live.context.fail(error.clone());
                    live.cancel.cancel();
                    if let Err(maka_code_runtime::CellAbort::VmCleanupUnconfirmed(message))=run.await {return Err(record_vm_uncertainty(&port,id,&live,format!("{error}; VM cleanup: {message}")).await);}
                    return Err(record_notification_failure(&state,&live,id,&port,&binding,error).await);
                }
            },
            result=&mut run=>break result,
        }
    };
    if let Err(maka_code_runtime::CellAbort::VmCleanupUnconfirmed(message)) = result {
        return Err(record_vm_uncertainty(&port, id, &live, message).await);
    }
    if let Err(error) = publish_notifications(&live.context, id, &port).await {
        return Err(record_notification_failure(&state, &live, id, &port, &binding, error).await);
    }
    let canonical = port
        .read(id)
        .await?
        .ok_or_else(|| ToolError::Persistence("Cell admission lost".into()))?;
    let result = if canonical.children.values().any(|child| !child.known())
        || canonical.blocks_effect_admission()
    {
        Err(maka_code_runtime::CellAbort::Tool(ToolError::OutcomeUnknown("Cell has unresolved original child effects; write tools are blocked until original receipt reconciliation".into())))
    } else {
        result
    };
    let output = {
        let mut pending = live.output.lock().unwrap();
        let mut output = std::mem::take(&mut *pending);
        output.extend(live.context.take_output());
        output
    };
    let result = result.map(|mut result| {
        direct.explain(&mut result);
        result
    });
    let published = match result {
        Ok(result @ CellResult::Success { .. }) => {
            let context = live.context.clone();
            let (event, contents) = tokio::task::spawn_blocking(move || -> Result<_, ToolError> {
                let observation = CellObservation::Completed {
                    cell_id: id,
                    content: output,
                    result: serde_json::to_value(result).map_err(persistence)?,
                };
                let final_result = CellContent::json(&observation)?;
                let draft = context
                    .take_draft()
                    .map_err(|e| ToolError::Persistence(e.message))?;
                let mut values = BTreeMap::new();
                let mut contents = vec![final_result.clone()];
                for (key, bytes) in draft.values {
                    let blob = CellContent::new(bytes);
                    values.insert(key, blob.reference.clone());
                    contents.push(blob);
                }
                Ok((
                    CellEvent::Completed {
                        cell: id,
                        result: final_result.reference,
                        publication: SessionPublication {
                            values,
                            loaded_tools: draft.loaded_tools,
                        },
                    },
                    contents,
                ))
            })
            .await
            .map_err(persistence)??;
            let change = CellChange::new(event, port.now());
            // No publication here. Engine accepts this final result and its exact
            // draft in one Root transaction, including background completions.
            port.append(vec![change], contents).await
        }
        failed => {
            let content = tokio::task::spawn_blocking(move || -> Result<CellContent, ToolError> {
                let diagnostic = match failed {
                    Ok(result) => serde_json::to_value(result)
                        .map_err(persistence)?
                        .to_string(),
                    Err(error) => error.to_string(),
                };
                CellContent::json(&CellInterruption {
                    cell: id,
                    diagnostic,
                    children: canonical.children,
                    prior_output: Some(CellPriorOutput { content: output }),
                })
            })
            .await
            .map_err(persistence)??;
            port.append(
                vec![CellChange::new(
                    CellEvent::Interrupted {
                        cell: id,
                        report: content.reference.clone(),
                    },
                    port.now(),
                )],
                vec![content],
            )
            .await
        }
    };
    if published.is_ok() {
        state.executor.release_binding(&binding);
    }
    published
}
async fn record_vm_uncertainty(
    port: &Arc<dyn CellPersistence>,
    cell: CellId,
    live: &Live,
    message: String,
) -> ToolError {
    live.context
        .fail(ToolError::CleanupUnconfirmed(message.clone()));
    live.cancel.cancel();
    let observation = async {
        let original = port
            .read(cell)
            .await?
            .ok_or_else(|| persistence("Cell admission lost during VM cleanup observation"))?;
        let event = CellEvent::VmCleanupUnconfirmed {
            cell,
            binding: original.vm,
            diagnostic: message.clone(),
        };
        port.append(vec![CellChange::new(event, port.now())], vec![])
            .await
    }
    .await;
    ToolError::CleanupUnconfirmed(match observation {
        Ok(()) => message,
        Err(error) => format!("{message}; VM uncertainty persistence: {error}"),
    })
}
// The original VM result has already confirmed teardown, independently of this metadata failure.
async fn record_notification_failure(
    state: &State,
    live: &Live,
    cell: CellId,
    port: &Arc<dyn CellPersistence>,
    binding: &maka_code_runtime::VmBinding,
    error: ToolError,
) -> ToolError {
    live.context.fail(error.clone());
    let content = {
        let mut pending = live.output.lock().unwrap();
        let mut output = std::mem::take(&mut *pending);
        output.extend(live.context.take_output());
        output
    };
    match record_closed_interruption(
        port,
        cell,
        error.to_string(),
        Some(CellPriorOutput { content }),
    )
    .await
    {
        Ok(()) => {
            state.executor.release_binding(binding);
            error
        }
        Err(report) => ToolError::Persistence(format!(
            "{error}; recording closed VM interruption: {report}"
        )),
    }
}
async fn record_closed_interruption(
    port: &Arc<dyn CellPersistence>,
    cell: CellId,
    diagnostic: String,
    prior_output: Option<CellPriorOutput>,
) -> Result<(), ToolError> {
    let original = port
        .read(cell)
        .await?
        .ok_or_else(|| persistence("Cell admission lost before VM start"))?;
    if !matches!(original.status, CellStatus::Running) {
        return Ok(());
    }
    let content = tokio::task::spawn_blocking(move || {
        CellContent::json(&CellInterruption {
            cell,
            diagnostic,
            children: original.children,
            prior_output,
        })
    })
    .await
    .map_err(persistence)??;
    port.append(
        vec![CellChange::new(
            CellEvent::Interrupted {
                cell,
                report: content.reference.clone(),
            },
            port.now(),
        )],
        vec![content],
    )
    .await
}
async fn publish_notifications(
    context: &CellContext,
    cell: CellId,
    port: &Arc<dyn CellPersistence>,
) -> Result<(), ToolError> {
    for text in context.take_notifications() {
        let content = tokio::task::spawn_blocking(move || {
            CellContent::json(&CellNotification {
                schema_version: CELL_NOTIFICATION_SCHEMA_VERSION,
                body: CellNotificationBody::Text { text },
            })
        })
        .await
        .map_err(persistence)??;
        let id = FactId::new();
        let change = CellChange::new(
            CellEvent::NotificationQueued {
                cell,
                notification: id,
                content: content.reference.clone(),
            },
            port.now(),
        );
        port.append(vec![change], vec![content]).await?;
    }
    Ok(())
}
struct Nested {
    port: Arc<dyn CellPersistence>,
    cell: CellId,
    catalog: ToolCatalog,
    execution: Arc<tokio::sync::RwLock<()>>,
    context: CellContext,
    cell_cancel: CancellationToken,
}
impl ToolExecutor for Nested {
    fn names(&self) -> Vec<String> {
        self.catalog.names()
    }
    fn invoke(&self, name: String, input: Value, cancel: CancellationToken) -> ToolFuture {
        let port = self.port.clone();
        let cell = self.cell;
        let catalog = self.catalog.clone();
        let gate = self.execution.clone();
        let context = self.context.clone();
        let cell_cancel = self.cell_cancel.clone();
        let parallel = catalog.semantics(&name) == Ok(crate::ToolSemantics::Parallel);
        Box::pin(async move {
            let _gate = if parallel {
                futures_util::future::Either::Left(gate.read_owned().await)
            } else {
                futures_util::future::Either::Right(gate.write_owned().await)
            };
            if let Some(error) = context.failure() {
                cell_cancel.cancel();
                return Err(error);
            }
            let result = port
                .invoke(cell, Uuid::new_v4(), name.clone(), input, catalog, cancel)
                .await;
            if let Err(
                error @ (ToolError::Persistence(_)
                | ToolError::CleanupUnconfirmed(_)
                | ToolError::OutcomeUnknown(_)
                | ToolError::OperationUnknown { .. }
                | ToolError::OperationCleanupUnconfirmed { .. }),
            ) = &result
            {
                context.fail(error.clone());
                cell_cancel.cancel();
            }
            let value = result?.into_code_value().map_err(ToolError::Failed)?;
            context
                .stage_loaded(std::collections::BTreeSet::from([name]))
                .map_err(|_| {
                    cell_cancel.cancel();
                    context
                        .failure()
                        .expect("loaded draft failure remains fatal")
                })?;
            Ok(value)
        })
    }
}
fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}
fn cell_failure(error: ToolError) -> ToolError {
    match error {
        ToolError::OperationUnknown { message, .. } => ToolError::OutcomeUnknown(message),
        ToolError::OperationCleanupUnconfirmed { message, .. } => {
            ToolError::CleanupUnconfirmed(message)
        }
        error @ (ToolError::Persistence(_)
        | ToolError::OutcomeUnknown(_)
        | ToolError::CleanupUnconfirmed(_)) => error,
        error => ToolError::OutcomeUnknown(error.to_string()),
    }
}
impl CodeCells {
    pub fn project_observation(
        cell: CellId,
        observed: ObservedCell,
        max_tokens: usize,
    ) -> ToolSuccess {
        let ObservedCell {
            state,
            observation,
            display_from,
        } = observed;
        let is_error = matches!(state, CellReplyState::Interrupted { .. });
        let raw = serde_json::to_value(&observation).expect("typed Cell observation");
        let (content, summary) = match observation {
            CellObservation::Running { cell_id, content } => {
                (content, json!({"state":"running","cell_id":cell_id}))
            }
            CellObservation::Completed {
                cell_id,
                content,
                result,
            } => (
                content,
                json!({"state":"completed","cell_id":cell_id,"result":result}),
            ),
            CellObservation::Interrupted { cell_id, report } => (
                Vec::new(),
                json!({
                    "state":"interrupted","cell_id":cell_id,"diagnostic":report["diagnostic"],
                    "heap":"expired","bindings":"invalid"
                }),
            ),
        };
        let mut remaining = max_tokens.saturating_mul(4);
        let mut parts = vec![ToolContent::Text(clip(
            &summary.to_string(),
            &mut remaining,
        ))];
        for output in content.into_iter().skip(display_from) {
            parts.push(match output {
                CellOutput::Text { text } => ToolContent::Text(clip(&text, &mut remaining)),
                CellOutput::Image { image } => ToolContent::Image(image),
                CellOutput::Media { content, detail } => ToolContent::Media { content, detail },
            });
        }
        ToolSuccess::content(
            ToolOutput::Cell(Box::new(CellReply {
                cell,
                state,
                observation: raw,
            })),
            parts,
        )
        .reporting_error(is_error)
    }
}
fn clip(text: &str, remaining: &mut usize) -> String {
    if *remaining == 0 {
        return String::new();
    }
    let bytes = serde_json::to_string(text).unwrap().len();
    if bytes <= *remaining {
        *remaining -= bytes;
        return text.into();
    }
    const MARKER: &str = "\n[output truncated; full observation is archived]";
    let available = remaining.saturating_sub(MARKER.len() + 3);
    let mut used = 0;
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        let bytes = match ch {
            '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
            '\u{0}'..='\u{1f}' => 6,
            _ => ch.len_utf8(),
        };
        if bytes > available.saturating_sub(used) {
            break;
        }
        used += bytes;
        end = index + ch.len_utf8();
    }
    *remaining = 0;
    format!("{}{MARKER}", &text[..end])
}
