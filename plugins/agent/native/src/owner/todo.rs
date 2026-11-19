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

use super::driver::PreparedTool;
use super::*;
use maka_agent_facts::{
    tool_call::ToolRejection,
    tool_output::{DurableToolProjection, ToolOutput, ToolSuccess},
    tools::*,
};
use maka_agent_state::{Change, ContentBlob, Head};
use maka_assistant::todo::{Document, Item, Repository, Status};
use maka_event_log::writeback::{Prepared, Statement};
use maka_plugin_core::storage::{Data, Mutation, Namespace, StoreError};
use sha2::{Digest, Sha256};
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
        let prepared = self.prepare_native(
            name,
            input,
            context,
            cancellation,
            None,
            ToolSemantics::Parallel,
        );
        Box::pin(async move { Ok(prepared.await?.effect) })
    }
}
impl Todo {
    pub(super) fn prepare_native(
        &self,
        name: String,
        input: Value,
        context: ToolCallContext,
        cancellation: CancellationToken,
        access: Option<Arc<RunAccess>>,
        semantics: ToolSemantics,
    ) -> futures_util::future::BoxFuture<'static, Result<PreparedTool, ToolRejection>> {
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
                .read(&context.execution.session_id)
                .await
                .map_err(|error| ToolRejection::PreparationFailed {
                    message: error.to_string(),
                })?
                .revision;
            if let Some(access) = access.as_ref().filter(|_| replacement.is_some()) {
                access.check_context(&context).await.map_err(|error| {
                    ToolRejection::PreparationFailed {
                        message: error.to_string(),
                    }
                })?;
            }
            let todo = replacement
                .as_ref()
                .map(|document| -> Result<Replacement, ToolRejection> {
                    let access =
                        access
                            .as_ref()
                            .ok_or_else(|| ToolRejection::PreparationFailed {
                                message: "Checklist replacement requires Native atomic publication"
                                    .into(),
                            })?;
                    let writer = access
                        .data_writer()
                        .map_err(|message| ToolRejection::PreparationFailed { message })?;
                    let state =
                        owner
                            .durable
                            .with_data_writer(writer.clone())
                            .map_err(|error| ToolRejection::PreparationFailed {
                                message: error.to_string(),
                            })?;
                    let mutation = Mutation {
                        key: format!("session/{}", context.execution.session_id),
                        expected_revision: expected,
                        data: Data::Present(serde_json::to_value(document).map_err(|error| {
                            ToolRejection::PreparationFailed {
                                message: error.to_string(),
                            }
                        })?),
                    };
                    let business = TodoStatement {
                        inner: owner
                            .todo
                            .storage
                            .prepare_statement(vec![mutation], &writer)
                            .map_err(|error| ToolRejection::PreparationFailed {
                                message: error.to_string(),
                            })?,
                        changed: owner.todo.repository.changed.clone(),
                    };
                    Ok(Replacement::new(
                        state,
                        access.claim().clone(),
                        writer,
                        business,
                    ))
                })
                .transpose()?;
            let effect = PreparedEffect::new(move |cancellation| {
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
                        let session = &context.execution.session_id;
                        let document = match replacement {
                            Some(document) => document,
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
            })
            .presented(format!("maka.agent.Builtin@1/{name}"));
            Ok(PreparedTool {
                effect,
                local: todo.map(super::driver::LocalCompletion::Todo),
                semantics,
            })
        })
    }
}

pub(super) const REVISION_CONFLICT: &str = "checklist_revision_conflict";

type PublishLocal = dyn Fn(
        Change,
        Vec<ContentBlob>,
    ) -> futures_util::future::BoxFuture<
        'static,
        Result<maka_agent_state::Commit, maka_event_log::StoreError>,
    > + std::marker::Send
    + Sync;

pub(super) struct Replacement {
    // Captures one prepared pure CAS statement; publication never invokes the tool again.
    publish: Box<PublishLocal>,
}
impl Replacement {
    fn new<S: Statement + Clone + Sync>(
        state: maka_agent_state::Store,
        claim: maka_agent_state::DriverClaim,
        writer: maka_event_log::root_store::DataWriter,
        business: S,
    ) -> Self {
        Self {
            publish: Box::new(move |original, contents| {
                let state = state.clone();
                let claim = claim.clone();
                let writer = writer.clone();
                let business = business.clone();
                Box::pin(async move {
                    loop {
                        let view = state.frontier(claim.run()).await?;
                        match state
                            .append_local_with(
                                &claim,
                                maka_agent_state::LocalResult {
                                    head: Head::from(&view),
                                    original: original.clone(),
                                    contents: contents.clone(),
                                    normalized_artifacts: Vec::new(),
                                },
                                business.clone(),
                                &writer,
                            )
                            .await
                        {
                            Err(error)
                                if matches!(
                                    statement_cause(&error),
                                    maka_event_log::StoreError::RevisionConflict { .. }
                                ) =>
                            {
                                continue;
                            }
                            result => return result,
                        }
                    }
                })
            }),
        }
    }
    pub(super) async fn publish(
        &self,
        original: &Change,
        contents: &[ContentBlob],
    ) -> Result<maka_agent_state::Commit, maka_event_log::StoreError> {
        (self.publish)(original.clone(), contents.to_vec()).await
    }
}

#[derive(Clone)]
struct TodoStatement<S> {
    inner: S,
    changed: tokio::sync::watch::Sender<()>,
}
impl<S: Statement> Statement for TodoStatement<S> {
    type Value = (S::Value, tokio::sync::watch::Sender<()>);
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.inner.retain()
    }
    fn prepare(self) -> Result<Self, maka_event_log::StoreError> {
        Ok(Self {
            inner: self.inner.prepare()?,
            changed: self.changed,
        })
    }
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<Prepared<Self::Value>, maka_event_log::StoreError> {
        let value = self
            .inner
            .execute(connection)
            .map_err(|error| match error {
                error @ maka_event_log::StoreError::RevisionConflict { .. } => {
                    maka_event_log::StoreError::StatementRejected {
                        diagnostic: REVISION_CONFLICT.into(),
                        cause: Arc::new(error),
                    }
                }
                error => error,
            })?;
        Ok(Prepared {
            value: (value.value, self.changed),
            changed: value.changed,
            notification: value.notification,
        })
    }
    fn committed((value, changed): Self::Value) -> Self::Output {
        let output = S::committed(value);
        changed.send_replace(());
        output
    }
    fn isolated_rejection(error: &maka_event_log::StoreError) -> bool {
        match error {
            maka_event_log::StoreError::StatementRejected { diagnostic, cause }
                if diagnostic == REVISION_CONFLICT =>
            {
                S::isolated_rejection(cause)
            }
            error => S::isolated_rejection(error),
        }
    }
}
pub(super) fn business_failure(error: &maka_event_log::StoreError) -> bool {
    matches!(statement_cause(error), maka_event_log::StoreError::StatementRejected { diagnostic, .. } if diagnostic == REVISION_CONFLICT)
}
fn statement_cause(error: &maka_event_log::StoreError) -> &maka_event_log::StoreError {
    match error {
        maka_event_log::StoreError::Shared(cause) => statement_cause(cause),
        error => error,
    }
}
impl Owner {
    async fn check_todo_invocation(&self, context: &ToolCallContext) -> Result<(), String> {
        if !self.settings.todo || self.session(&context.execution.session_id).await?.archived {
            return Err("checklist_unavailable".into());
        }
        self.tool_store(context)?;
        let execution = &context.execution;
        let view = self
            .durable
            .frontier(execution.run_id)
            .await
            .map_err(|error| error.to_string())?;
        if view.spec.owner != self.run_owner()
            || view.spec.session_id != execution.session_id
            || view.spec.turn_id != execution.turn_id
            || !matches!(
                view.spec.origin,
                maka_agent_facts::durable::RunOrigin::Local
            )
            || view.stopped
            || view.cancelled_by_risk
            || view.terminal.is_some()
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
        let digest = (!items.is_empty()).then(|| {
            let mut hasher = Sha256::new();
            hasher.update((total as u64).to_le_bytes());
            for item in &items {
                hasher.update((item.content.len() as u64).to_le_bytes());
                hasher.update(item.content.as_bytes());
            }
            hex::encode(hasher.finalize())
        });
        let completed = items
            .iter()
            .filter(|item| item.status == Status::Completed)
            .count();
        let active_index = items
            .iter()
            .position(|item| item.status == Status::InProgress)
            .or_else(|| {
                items
                    .iter()
                    .position(|item| item.status != Status::Completed)
            });
        let current = active_index.map(|index| items[index].clone());
        let offset = input.offset.min(total);
        let limit = input.limit.unwrap_or(20);
        let next_offset =
            (limit > 0 && offset.saturating_add(limit) < total).then_some(offset + limit);
        Ok(Checklist {
            enabled: self.settings.todo,
            revision: snapshot.revision,
            digest,
            total,
            completed,
            active_index,
            current,
            offset,
            items: items.into_iter().skip(offset).take(limit).collect(),
            next_offset,
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
