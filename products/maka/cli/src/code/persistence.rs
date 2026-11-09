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
    cells::{CellEvent, CellId, CellOwner, CellReturnedResult, CellStatus, CellView},
    durable::{ContentRef, SCHEMA_VERSION, UnixMillis},
    tool_call::ToolSettlement,
    tool_output::ToolOutput,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_agent_state::{
    ContentBlob,
    cells::{CellsStore, StandaloneBatch, StandaloneEvent},
};
use maka_event_log::root_store::RootStore;
use maka_plugin_core::work::WorkCustody;
use maka_tools::{CellChange, CellContent, CellFuture, CellPersistence, ToolCatalog};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub(super) fn now() -> UnixMillis {
    UnixMillis(jiff::Timestamp::now().as_millisecond())
}

#[derive(Clone)]
pub(super) struct Standalone {
    pub root: Arc<RootStore>,
    pub cells: CellsStore,
    pub session: String,
    pub cell: CellId,
    pub admission: Arc<tokio::sync::Mutex<Option<String>>>,
    pub custody: Arc<dyn WorkCustody>,
    pub tools: Arc<dyn ToolExecutor>,
}
fn persistence(error: impl std::fmt::Display) -> ToolError {
    ToolError::Persistence(error.to_string())
}

impl CellPersistence for Standalone {
    fn owner(&self) -> CellOwner {
        CellOwner::Standalone {
            session: self.session.clone(),
        }
    }
    fn now(&self) -> UnixMillis {
        now()
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
    ) -> ToolFuture<ToolOutput> {
        let port = self.clone();
        Box::pin(async move {
            let work = port
                .root
                .fork_effect(port.custody.as_ref(), &port.session)
                .map_err(persistence)?;
            let (send, receive) = tokio::sync::oneshot::channel();
            // The VM observer may disappear; original admitted work still settles.
            tokio::spawn(async move {
                let result = async {
                    let gate = port.admission.lock().await;
                    if let Some(diagnostic) = &*gate {
                        return Err(ToolError::OutcomeUnknown(diagnostic.clone()));
                    }
                    if cell != port.cell {
                        return Err(ToolError::Failed("foreign standalone Cell".into()));
                    }
                    let current = port
                        .read(cell)
                        .await?
                        .ok_or_else(|| persistence("Cell disappeared before child admission"))?;
                    if current.blocks_effect_admission() {
                        return Err(ToolError::OutcomeUnknown(
                            "Cell has unresolved canonical effects or VM cleanup".into(),
                        ));
                    }
                    if !matches!(current.status, CellStatus::Running) {
                        return Err(ToolError::Failed(
                            "Cell is no longer accepting children".into(),
                        ));
                    }
                    let validation = catalog.validate(&name, &input);
                    let semantics = catalog
                        .semantics(&name)
                        .map_err(|error| ToolError::Failed(error.to_string()))?;
                    let frozen_input = CellContent::json(&input)?;
                    let mut events = vec![CellChange::new(
                        CellEvent::ChildPrepared {
                            cell,
                            operation,
                            name: name.clone(),
                            semantics,
                            input: frozen_input.reference.clone(),
                            resources: Vec::new(),
                        },
                        now(),
                    )];
                    match &validation {
                        Ok(()) => events.push(CellChange::new(
                            CellEvent::ChildAdmitted { cell, operation },
                            now(),
                        )),
                        Err(error) => events.push(CellChange::new(
                            CellEvent::ChildRejected {
                                cell,
                                operation,
                                reason: error.kind(),
                                diagnostic: error.to_string(),
                            },
                            now(),
                        )),
                    }
                    port.append(events, vec![frozen_input]).await?;
                    drop(gate);
                    validation.map_err(|error| ToolError::Failed(error.to_string()))?;
                    let outcome = port.tools.invoke(name, input, cancellation).await;
                    let (output, error) = match outcome {
                        Ok(value) => (ToolOutput::Json(value), None),
                        Err(
                            error @ (ToolError::OutcomeUnknown(_)
                            | ToolError::Persistence(_)
                            | ToolError::OperationUnknown { .. }
                            | ToolError::CleanupUnconfirmed(_)
                            | ToolError::OperationCleanupUnconfirmed { .. }),
                        ) => return Err(error),
                        Err(error) => (ToolOutput::Text(error.to_string()), Some(error)),
                    };
                    let manifest = ToolReturn {
                        schema_version: SCHEMA_VERSION,
                        artifacts: Vec::new(),
                        body: CellReturnedResult {
                            output,
                            projection: None,
                            is_error: error.is_some(),
                        },
                    };
                    let (manifest, content) = tokio::task::spawn_blocking(move || {
                        CellContent::json(&manifest).map(|content| (manifest, content))
                    })
                    .await
                    .map_err(persistence)??;
                    port.append(
                        vec![CellChange::new(
                            CellEvent::LocalChildReturned {
                                cell,
                                operation,
                                result: content.reference.clone(),
                                is_error: error.is_some(),
                                settlement: if error.is_some() {
                                    ToolSettlement::Failed
                                } else {
                                    ToolSettlement::Returned
                                },
                            },
                            now(),
                        )],
                        vec![content],
                    )
                    .await?;
                    match error {
                        Some(error) => Err(error),
                        None => Ok(manifest.body.output),
                    }
                }
                .await;
                if let Err(
                    error @ (ToolError::OutcomeUnknown(_)
                    | ToolError::OperationUnknown { .. }
                    | ToolError::Persistence(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ) = &result
                {
                    let mut gate = port.admission.lock().await;
                    if gate.is_none() {
                        *gate = Some(error.to_string());
                    }
                }
                let cleanup = match &result {
                    Err(
                        ToolError::CleanupUnconfirmed(message)
                        | ToolError::OperationCleanupUnconfirmed { message, .. },
                    ) => Err(message.clone()),
                    _ => Ok(()),
                };
                work.finish(cleanup);
                let _ = send.send(result);
            });
            receive.await.map_err(|error| {
                ToolError::CleanupUnconfirmed(format!("local Cell worker disappeared: {error}"))
            })?
        })
    }
}
