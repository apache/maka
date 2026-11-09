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

use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{
        CellEvent, CellId, CellObservation, CellOwner, CellReturnedResult, CellStatus, CellView,
        SessionPublication,
    },
    durable::{ContentRef, ExecutionIdentity, FactId, RunId, SCHEMA_VERSION, UnixMillis},
    tool_call::{ToolCallIdentity, ToolSettlement},
    tool_output::{ToolOutput, ToolSuccess},
    tools::{ToolError, ToolSemantics},
};
use maka_agent_state::{
    ContentBlob,
    cells::{CellsStore, StandaloneBatch, StandaloneEvent},
};
use maka_code_runtime::{CellContext, CellStore, PreparedCell};
use maka_event_log::{
    StoreError,
    connection::Query,
    root::{ROOT_MARKER, RootNamespaces, RootOwner},
    root_store::{DataWriter, RootStore, SessionWorkLease, WorkEffects},
};
use maka_plugin_core::work::WorkCustody;
use maka_tools::{
    CellChange, CellContent, CellFuture, CellPersistence, CodeCells, CodeExecutor, ToolCallContext,
    ToolCatalog,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}

pub struct Fixture {
    pub root: Arc<RootStore>,
    pub store: CellsStore,
    pub data: DataWriter,
    pub session: String,
    pub custody: Arc<dyn WorkCustody>,
    pub execution: ExecutionIdentity,
    lease: SessionWorkLease,
    effects: WorkEffects,
}
impl Fixture {
    pub async fn open(base: &Path, session: &str) -> Self {
        let namespaces = RootNamespaces {
            ownership: base.join("owners"),
            control: base.join("control"),
        };
        let path = base.join("root");
        let existing = path.join(ROOT_MARKER).exists();
        let owner = Arc::new(
            if existing {
                RootOwner::open(&path, &namespaces)
            } else {
                RootOwner::create(&path, &namespaces)
            }
            .unwrap(),
        );
        let migrations = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(maka_agent_state::MIGRATIONS)
            .copied()
            .collect::<Vec<_>>();
        let root = Arc::new(RootStore::open(owner, &migrations).await.unwrap());
        let selected = if existing {
            root.session(session).await.unwrap()
        } else {
            root.create_session(session, "standalone-tools-test", &json!({}), 1)
                .await
                .unwrap()
        };
        let (lease, effects) = selected
            .work_scope(None)
            .await
            .unwrap()
            .accept(CancellationToken::new());
        let custody = lease.store().work_custody().unwrap();
        let data = root
            .data_writer_for_work(custody.as_ref(), session)
            .unwrap();
        let store = CellsStore::new(data.clone());
        // A standalone delivery label, never a RunSpec, Agent grant or backend.
        let execution = ExecutionIdentity {
            session_id: session.into(),
            turn_id: "standalone".into(),
            run_id: RunId::new(),
        };
        Self {
            root,
            store,
            data,
            session: session.into(),
            custody,
            execution,
            lease,
            effects,
        }
    }
    pub fn port(&self) -> Arc<Standalone> {
        Arc::new(Standalone {
            root: self.root.clone(),
            cells: self.store.clone(),
            session: self.session.clone(),
            custody: self.custody.clone(),
            execution: self.execution.clone(),
            data: self.data.clone(),
        })
    }
    pub fn cell_store(&self) -> CellStore {
        CellStore::new(
            self.store
                .reader(self.session.clone(), tokio::runtime::Handle::current()),
        )
    }
    pub fn cells(&self, executor: CodeExecutor) -> CodeCells {
        CodeCells::new(executor, self.cell_store())
    }
    pub fn context(&self, operation: Uuid) -> ToolCallContext {
        self.port().context(operation)
    }
    pub async fn events(&self) -> Vec<SourceEvent> {
        self.data
            .query(ReadEvents(self.session.clone()))
            .await
            .unwrap()
    }
    pub async fn settle(&self) {
        self.effects.settle().await.unwrap();
    }
    pub async fn close(self) {
        let Self {
            root,
            store,
            data,
            custody,
            lease,
            effects,
            ..
        } = self;
        effects.settle().await.unwrap();
        lease.finish();
        drop(custody);
        drop(store);
        drop(data);
        root.shutdown().await.unwrap();
    }
}

#[derive(Clone)]
pub struct Standalone {
    pub root: Arc<RootStore>,
    pub cells: CellsStore,
    pub session: String,
    pub custody: Arc<dyn WorkCustody>,
    pub execution: ExecutionIdentity,
    pub data: DataWriter,
}
impl Standalone {
    pub fn context(&self, operation: Uuid) -> ToolCallContext {
        ToolCallContext {
            execution: self.execution.clone(),
            operation_id: operation.to_string(),
            call: ToolCallIdentity::standalone(operation.to_string()),
            custody: Some(self.custody.clone()),
        }
    }
    pub async fn events(&self) -> Vec<SourceEvent> {
        self.data
            .query(ReadEvents(self.session.clone()))
            .await
            .unwrap()
    }
    pub async fn raw<T: DeserializeOwned>(&self, cell: CellId, reference: ContentRef) -> T {
        serde_json::from_slice(&self.content(cell, reference).await.unwrap()).unwrap()
    }
    pub async fn admit(
        &self,
        cell: CellId,
        operation: Uuid,
        name: &str,
        semantics: ToolSemantics,
        input: &Value,
    ) -> Result<u64, ToolError> {
        let frozen = CellContent::json(input)?;
        self.append(
            vec![CellChange::new(
                CellEvent::ChildPrepared {
                    cell,
                    operation,
                    name: name.into(),
                    semantics,
                    input: frozen.reference.clone(),
                    resources: vec![],
                },
                self.now(),
            )],
            vec![frozen],
        )
        .await?;
        let admitted = CellChange::new(CellEvent::ChildAdmitted { cell, operation }, self.now());
        let fact = admitted.id;
        self.append(vec![admitted], vec![]).await?;
        self.data
            .query(ReadSequence(self.session.clone(), fact))
            .await
            .map_err(persistence)
    }
    pub async fn returned(
        &self,
        cell: CellId,
        operation: Uuid,
        success: ToolSuccess,
        settlement: ToolSettlement,
    ) -> Result<ToolOutput, ToolError> {
        let execution = self.execution.clone();
        let (body, content) = tokio::task::spawn_blocking(move || {
            let normalized = success
                .into_durable(
                    &format!("{cell}:{operation}"),
                    SystemTime::now(),
                    &execution,
                )
                .map_err(persistence)?;
            if !normalized.artifacts.is_empty() {
                return Err(persistence(
                    "standalone plain-output fixture does not register media artifacts",
                ));
            }
            let manifest = ToolReturn {
                schema_version: SCHEMA_VERSION,
                artifacts: Vec::new(),
                body: CellReturnedResult {
                    output: normalized.output,
                    projection: Some(normalized.projection),
                    is_error: normalized.is_error,
                },
            };
            let content = CellContent::json(&manifest)?;
            Ok::<_, ToolError>((manifest.body, content))
        })
        .await
        .map_err(persistence)??;
        self.append(
            vec![CellChange::new(
                CellEvent::LocalChildReturned {
                    cell,
                    operation,
                    result: content.reference.clone(),
                    is_error: body.is_error,
                    settlement,
                },
                self.now(),
            )],
            vec![content],
        )
        .await?;
        Ok(body.output)
    }
    pub async fn finish_prepared(
        &self,
        cell: CellId,
        prepared: PreparedCell,
        context: CellContext,
        executor: &CodeExecutor,
    ) {
        let binding = prepared.binding().clone();
        let result = prepared.execute_bound().await.unwrap();
        let observation = CellObservation::Completed {
            cell_id: cell,
            content: context.take_output(),
            result: serde_json::to_value(result).unwrap(),
        };
        let result = CellContent::json(&observation).unwrap();
        let draft = context.take_draft().unwrap();
        let mut contents = vec![result.clone()];
        let values = draft
            .values
            .into_iter()
            .map(|(key, bytes)| {
                let content = CellContent::new(bytes);
                let reference = content.reference.clone();
                contents.push(content);
                (key, reference)
            })
            .collect();
        let event = CellEvent::Completed {
            cell,
            result: result.reference,
            publication: SessionPublication {
                values,
                loaded_tools: draft.loaded_tools,
            },
        };
        self.append(vec![CellChange::new(event, self.now())], contents)
            .await
            .unwrap();
        executor.release_binding(&binding);
    }
}
impl CellPersistence for Standalone {
    fn owner(&self) -> CellOwner {
        CellOwner::Standalone {
            session: self.session.clone(),
        }
    }
    fn now(&self) -> UnixMillis {
        UnixMillis(1)
    }
    fn append(&self, changes: Vec<CellChange>, contents: Vec<CellContent>) -> CellFuture<'_, ()> {
        Box::pin(async move {
            let events = changes
                .into_iter()
                .map(|change| StandaloneEvent {
                    id: change.id,
                    at: change.at,
                    event: change.event,
                })
                .collect();
            let contents = tokio::task::spawn_blocking(move || {
                contents
                    .into_iter()
                    .map(|content| {
                        let blob = ContentBlob::new(content.bytes);
                        if blob.reference() != &content.reference {
                            return Err(persistence("Cell content digest mismatch"));
                        }
                        Ok(blob)
                    })
                    .collect::<Result<Vec<_>, ToolError>>()
            })
            .await
            .map_err(persistence)??;
            let batch = StandaloneBatch::with_publications(self.session.clone(), events, contents)
                .map_err(persistence)?;
            self.cells
                .append_standalone(&self.root, self.custody.clone(), batch)
                .await
                .map_err(persistence)
        })
    }
    fn read(&self, cell: CellId) -> CellFuture<'_, Option<CellView>> {
        Box::pin(async move {
            self.cells
                .read(&self.session, cell)
                .await
                .map_err(persistence)
        })
    }
    fn content(&self, cell: CellId, reference: ContentRef) -> CellFuture<'_, Vec<u8>> {
        Box::pin(async move {
            self.cells
                .content(&self.session, cell, reference)
                .await
                .map_err(persistence)
        })
    }
    fn invoke(
        &self,
        cell: CellId,
        operation: Uuid,
        name: String,
        input: Value,
        catalog: ToolCatalog,
        cancellation: CancellationToken,
    ) -> maka_agent_facts::tools::ToolFuture<ToolOutput> {
        let port = self.clone();
        Box::pin(async move {
            let work = port
                .root
                .fork_effect(port.custody.as_ref(), &port.session)
                .map_err(persistence)?;
            let (reply, result) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let outcome = async {
                    let view = port
                        .read(cell)
                        .await?
                        .ok_or_else(|| persistence("Cell missing before child admission"))?;
                    if !matches!(view.status, CellStatus::Running) || view.blocks_effect_admission()
                    {
                        return Err(ToolError::OutcomeUnknown(
                            "Cell no longer admits effects".into(),
                        ));
                    }
                    catalog
                        .validate(&name, &input)
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let effect = catalog
                        .prepare(
                            name.clone(),
                            input.clone(),
                            port.context(operation),
                            cancellation.clone(),
                        )
                        .await
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let semantics = catalog
                        .semantics(&name)
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let sequence = port
                        .admit(cell, operation, &name, semantics, &input)
                        .await?;
                    let (custody, execute) = effect.begin(sequence, cancellation)?.execute();
                    let result = execute.await;
                    let outcome = match result {
                        Ok(success) => {
                            port.returned(cell, operation, success, ToolSettlement::Returned)
                                .await
                        }
                        Err(
                            error @ (ToolError::Persistence(_)
                            | ToolError::OutcomeUnknown(_)
                            | ToolError::CleanupUnconfirmed(_)
                            | ToolError::OperationUnknown { .. }
                            | ToolError::OperationCleanupUnconfirmed { .. }),
                        ) => Err(error),
                        Err(error) => {
                            port.returned(
                                cell,
                                operation,
                                ToolSuccess::from(ToolOutput::Text(error.to_string()))
                                    .reporting_error(true),
                                ToolSettlement::Failed,
                            )
                            .await?;
                            Err(error)
                        }
                    };
                    drop(custody);
                    outcome
                }
                .await;
                let cleanup = match &outcome {
                    Err(ToolError::CleanupUnconfirmed(reason)) => Err(reason.clone()),
                    Err(ToolError::OperationCleanupUnconfirmed { message, .. }) => {
                        Err(message.clone())
                    }
                    _ => Ok(()),
                };
                work.finish(cleanup);
                let _ = reply.send(outcome);
            });
            result.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!("local child owner disappeared: {error}"))
            })?
        })
    }
}

pub async fn observe(
    cells: &CodeCells,
    cell: CellId,
    terminate: bool,
    port: Arc<dyn CellPersistence>,
) -> maka_tools::ObservedCell {
    cells
        .observe_cell(
            cell,
            Duration::from_secs(10),
            terminate,
            port,
            CancellationToken::new(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
}

pub struct SourceEvent {
    pub sequence: u64,
    pub event: StandaloneEvent,
}
struct ReadEvents(String);
impl Query for ReadEvents {
    type Output = Vec<SourceEvent>;
    fn execute(self, c: &rusqlite::Connection) -> Result<Self::Output, StoreError> {
        let mut statement = c.prepare("SELECT e.sequence,c.payload FROM agent_standalone_cell_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=? ORDER BY e.sequence")?;
        let rows = statement
            .query_map([self.0], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(sequence, bytes)| {
                Ok(SourceEvent {
                    sequence: u64::try_from(sequence)
                        .map_err(|error| StoreError::InvalidTransition(error.to_string()))?,
                    event: serde_json::from_slice(&bytes)?,
                })
            })
            .collect()
    }
}
struct ReadSequence(String, FactId);
impl Query for ReadSequence {
    type Output = u64;
    fn execute(self, c: &rusqlite::Connection) -> Result<u64, StoreError> {
        let sequence: i64 = c.query_row(
            "SELECT sequence FROM agent_standalone_cell_events WHERE session=? AND id=?",
            rusqlite::params![self.0, self.1.to_string()],
            |row| row.get(0),
        )?;
        u64::try_from(sequence).map_err(|error| StoreError::InvalidTransition(error.to_string()))
    }
}
