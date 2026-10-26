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
use maka_agent_facts::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::*,
};
use maka_assistant::todo::{Document, Item, Repository, Status};
use maka_capabilities::storage::{Namespace, StoreError};
use std::sync::{OnceLock, Weak};

pub(super) struct Todo {
    storage: Arc<maka_host_runtime::storage::Storage>,
    repository: Repository,
    owner: OnceLock<Weak<Owner>>,
}
impl Todo {
    pub fn new(store: Arc<RootStore>, prefix: String) -> Self {
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            store,
            prefix,
            Namespace::new(
                maka_assistant::todo::ID,
                maka_plugin_core::scope::Scope::Profile,
            )
            .expect("todo namespace"),
        ));
        Self {
            repository: Repository {
                store: storage.clone(),
                changed: tokio::sync::watch::channel(()).0,
            },
            storage,
            owner: OnceLock::new(),
        }
    }
    pub fn bind(&self, owner: &Arc<Owner>) {
        self.owner
            .set(Arc::downgrade(owner))
            .expect("todo bound once");
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.storage.finish().await
    }
    pub fn tools(self: &Arc<Self>) -> Vec<ToolRegistration> {
        [
            ("todo_read", "Read this session's checklist. Completed means model-reported progress, not verified execution.", serde_json::to_value(schemars::schema_for!(Read)).expect("todo schema")),
            ("todo_write", "Atomically replace this session's checklist; include every item to keep. Completed means model-reported progress, not verified execution.", serde_json::to_value(schemars::schema_for!(Write)).expect("todo schema")),
        ].into_iter().map(|(name, description, input_schema)| ToolRegistration {
            definition: ToolDefinition { provider: None, name: name.into(), description: description.into(), input_schema, output_schema: None, freeform: None },
            nesting: ToolNesting::Nestable, semantics: ToolSemantics::Parallel, handler: ToolHandler::Prepared(self.clone()),
        }).collect()
    }
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Read {}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct Write {
    todos: Vec<Item>,
}
impl ToolPreparer for Todo {
    fn names(&self) -> Vec<String> {
        vec!["todo_read".into(), "todo_write".into()]
    }
    fn prepare(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
    ) -> PreparationFuture {
        let owner = self.owner.get().and_then(Weak::upgrade);
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolRejection::Cancelled);
            }
            let owner = owner.ok_or(ToolRejection::Unavailable)?;
            let replacement = match name.as_str() {
                "todo_read" => {
                    serde_json::from_value::<Read>(input).map_err(invalid)?;
                    None
                }
                "todo_write" => Some(
                    Document::normalize(
                        serde_json::from_value::<Write>(input)
                            .map_err(invalid)?
                            .todos,
                    )
                    .map_err(invalid)?,
                ),
                _ => return Err(ToolRejection::Unavailable),
            };
            owner
                .check_todo_invocation(&context)
                .await
                .map_err(|message| ToolRejection::PreparationFailed { message })?;
            // Freeze the observed revision before T1; two concurrent replacements cannot silently overwrite each other.
            let expected = owner
                .todo
                .repository
                .read(&context.invocation.session_id)
                .await
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?
                .revision;
            Ok(PreparedEffect::new(move |cancellation| {
                Box::pin(async move {
                    if cancellation.is_cancelled() {
                        return Err(failed("Checklist call cancelled"));
                    }
                    let runs = owner.runs.lock().await;
                    if runs.closing {
                        return Err(failed("Checklist unavailable"));
                    }
                    let captured = owner.clone();
                    let job = owner.workers.spawn(async move {
                        captured
                            .check_todo_invocation(&context)
                            .await
                            .map_err(failed)?;
                        let session = &context.invocation.session_id;
                        let document = match replacement {
                            Some(document) => {
                                captured
                                    .todo
                                    .repository
                                    .replace(session, expected, &document)
                                    .await
                                    .map_err(storage_error)?;
                                document
                            }
                            None => {
                                captured
                                    .todo
                                    .repository
                                    .read(session)
                                    .await
                                    .map_err(storage_error)?
                                    .document
                            }
                        };
                        let text = document.render();
                        Ok(ToolSuccess::projected(
                            ToolOutput::Json(serde_json::to_value(document).map_err(failed)?),
                            DurableToolProjection::Text { text },
                        ))
                    });
                    drop(runs);
                    job.await
                        .map_err(|error| ToolError::OutcomeUnknown(error.to_string()))?
                })
            }))
        })
    }
}
impl Owner {
    async fn check_todo_invocation(&self, context: &ToolCallContext) -> Result<(), String> {
        if !self.settings.todo || self.session(&context.invocation.session_id).await?.archived {
            return Err("checklist_unavailable".into());
        }
        let boundary = self
            .store
            .session(&context.invocation.session_id)
            .await
            .map_err(|error| error.to_string())?
            .invocation_boundary(
                &context.invocation.session_id,
                &context.invocation.invocation_id,
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("checklist_invocation_unavailable")?
            .0;
        if boundary.invocation != context.invocation
            || matches!(
                boundary.state,
                maka_event_log::turns::InvocationState::Ended { .. }
            )
        {
            return Err("checklist_invocation_closed".into());
        }
        Ok(())
    }
    pub fn checklist_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.todo.repository.changed.subscribe()
    }
    pub async fn checklist(&self, input: &ChecklistRead) -> Result<Checklist, String> {
        self.session(&input.session_id).await?;
        let snapshot = self
            .todo
            .repository
            .read(&input.session_id)
            .await
            .map_err(|e| e.to_string())?;
        let items = if self.settings.todo {
            snapshot.document.items
        } else {
            vec![]
        };
        let total = items.len();
        let offset = input.offset.min(total.saturating_sub(1) / 20 * 20);
        Ok(Checklist {
            enabled: self.settings.todo,
            revision: snapshot.revision,
            total,
            completed: items
                .iter()
                .filter(|item| item.status == Status::Completed)
                .count(),
            current: items
                .iter()
                .find(|item| item.status == Status::InProgress)
                .cloned(),
            offset,
            items: items.into_iter().skip(offset).take(20).collect(),
            next_offset: (offset + 20 < total).then_some(offset + 20),
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> ToolRejection {
    ToolRejection::InvalidInput {
        message: error.to_string(),
    }
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
fn storage_error(error: StoreError) -> ToolError {
    match error {
        StoreError::OutcomeUnknown(message) => ToolError::OutcomeUnknown(message),
        other => failed(other),
    }
}
