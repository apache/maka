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

//! Explicit selected-workspace file service. JSON paths never grant directory access.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use maka_agent_api::contract::{Workspace, WorkspaceAccess};
use maka_agent_api::session::ResolvedConfiguration;
use maka_agent_authority::computer::{NativeCallAccess, NativeCallContext};
use maka_agent_facts::{
    model::prompt_source::source::{self as pull, ChargedBuffer, SourceBudget, TextSource},
    tools::{ToolError, ToolExecutor},
};
use maka_event_log::RootStore;
use maka_fs_tools::{
    MutationExecutor, ReadExecutor, ReadOutput, ReadScope, WriteCoordinator, WriteScope,
};
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeActivation, NativeOwner,
    NativeRegistry,
};
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Rule},
    grant::Permissions,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

mod archive;
pub mod attachments;
mod permissions;
mod publication;

use maka_workspace_api::files::*;
pub fn provide(registry: &mut NativeRegistry) -> Result<(), String> {
    // One coordinator for every activation of this compiled provider. It owns
    // no work; accepted request Scopes retain the actual joined executors.
    let writes = Arc::new(WriteCoordinator::default());
    registry.insert(
        maka_workspace_api::files::IMPLEMENTATION.into(),
        Arc::new(move |context, _| {
            let writes = writes.clone();
            Box::pin(async move {
                let opened = (|| {
                    let persistence = context
                        .persistence()
                        .ok_or("workspace_files_require_persistence")?;
                    let root = persistence
                        .store()
                        .owned_root()
                        .map_err(|_| "workspace_files_root_unavailable")?;
                    let state_root =
                        maka_fs_tools::workspace::project::host_path(root.canonical_path())
                            .map_err(|_| "workspace_files_root_unavailable")?
                            .into();
                    Ok::<_, String>(Arc::new(Files {
                        store: persistence.store().clone(),
                        writes,
                        state_root,
                    }))
                })();
                match opened {
                    Ok(owner) => NativeActivation {
                        exports: Ok(BTreeMap::from([(
                            EXPORT.into(),
                            maka_plugin_core::runtime::Published {
                                contract: contract(),
                                value: owner.clone() as Arc<dyn Handler>,
                            },
                        )])),
                        owner,
                    },
                    Err(error) => NativeActivation {
                        exports: Err(error),
                        owner: Arc::new(()),
                    },
                }
            })
        }),
    )
}
struct Files {
    store: Arc<RootStore>,
    writes: Arc<WriteCoordinator>,
    state_root: PathBuf,
}
impl Handler for Files {
    fn call(
        &self,
        name: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        let store = self.store.clone();
        let writes = self.writes.clone();
        let state_root = self.state_root.clone();
        let result = async move {
            if name == "publishChange" {
                return publication::call(&store, writes, state_root, input, &context).await;
            }
            let (_, mutation) = method(&name).ok_or("workspace_file_method_unavailable")?;
            let native = context
                .native_context::<NativeCallContext>()
                .ok_or("workspace_files_require_native_call")?;
            if mutation && context.operation().is_none() {
                return Err("workspace_file_mutation_required".into());
            }
            let mut ticket = context
                .scope()
                .resources
                .reserve()
                .map_err(|e| e.to_string())?;
            ticket.start();
            let result = execute(
                &store,
                writes,
                state_root,
                &name,
                input,
                native.access(),
                &context,
            )
            .await;
            let cleanup = match &result {
                Err(ToolError::CleanupUnconfirmed(message)) => Err(message.clone()),
                _ => Ok(()),
            };
            ticket.complete(cleanup);
            let result = match result {
                Ok(Output::Image { bytes, mime_type }) => {
                    for (index, chunk) in
                        bytes.chunks(maka_agent_api::IMAGE_CHUNK_BYTES).enumerate()
                    {
                        let frame = maka_agent_api::contract::ImageFrame::Chunk {
                            mime_type: mime_type.clone(),
                            total_bytes: bytes.len(),
                            offset: index * maka_agent_api::IMAGE_CHUNK_BYTES,
                            data: STANDARD.encode(chunk),
                        };
                        context
                            .emit(serde_json::to_value(frame).map_err(|e| e.to_string())?)
                            .await?;
                    }
                    return serde_json::to_value(maka_agent_api::contract::ImageFrame::Complete {
                        detail: None,
                    })
                    .map_err(|e| HandlerError::from(e.to_string()));
                }
                Ok(Output::Json(value)) => FileResult::Completed { value },
                Err(
                    error @ (ToolError::OutcomeUnknown(_)
                    | ToolError::CleanupUnconfirmed(_)
                    | ToolError::Persistence(_)),
                ) => {
                    return Err(HandlerError::Unknown {
                        diagnostic: error.to_string(),
                    });
                }
                Err(error) if name == "readImage" => {
                    return Err(HandlerError::from(error.to_string()));
                }
                Err(ToolError::Failed(message) | ToolError::Io { message, .. }) => {
                    FileResult::Failed { message }
                }
                Err(error) => return Err(HandlerError::from(error.to_string())),
            };
            serde_json::to_value(result)
                .map_err(|_| HandlerError::from("workspace_file_result_unavailable"))
        };
        Box::pin(async move {
            let result: std::result::Result<Value, HandlerError> = result.await;
            result.map(HandlerValue::Json)
        })
    }
}
impl NativeOwner for Files {
    fn execution_basis(&self) -> Option<Value> {
        // Package/configuration identify the implementation; these are its
        // captured targets. Comparison never restores a handle or grants access.
        // Calls still read the live Session boundary from this exact Root.
        let root = self.store.owned_root().ok()?;
        Some(serde_json::json!({
            "root": root.root_id(),
            "privateRoot": self.state_root,
        }))
    }
    fn prepare_retirement(
        &self,
    ) -> Option<Box<dyn maka_host_runtime::application::NativeRetirement>> {
        Some(Box::new(()))
    }
    fn close(&self) -> BoxFuture<'static, Result<(), String>> {
        // No detached workers. Provider retirement waits for admitted call Scopes.
        Box::pin(async { Ok(()) })
    }
}
struct Captured {
    path: PathBuf,
    directory: cap_std::fs::Dir,
    sandbox: Sandbox,
    ceiling: Sandbox,
}
fn capture(
    workspace: &Workspace,
    access: WorkspaceAccess,
    state_root: &Path,
    floor: &Sandbox,
) -> Result<Captured, ToolError> {
    let path = PathBuf::from(&workspace.path);
    let directory =
        maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
    if maka_fs_tools::workspace::read_directory_identity(
        path.clone(),
        directory.try_clone().map_err(failed)?,
    )
    .map_err(failed)?
        != workspace.identity
    {
        return Err(failed("Workspace marker identity changed"));
    }
    let (sandbox, ceiling) =
        maka_workspace_support::sandbox(workspace, access, state_root).map_err(failed)?;
    let sandbox = sandbox.intersect(floor).map_err(failed)?;
    let ceiling = ceiling.intersect(floor).map_err(failed)?;
    // Policy resolution may inspect workspace metadata; never accept replacement
    // of the original directory during those reads.
    maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
    Ok(Captured {
        path,
        directory,
        sandbox,
        ceiling,
    })
}
pub enum Output {
    Json(Value),
    Image { bytes: Vec<u8>, mime_type: String },
}
async fn execute(
    root: &RootStore,
    writes: Arc<WriteCoordinator>,
    state_root: PathBuf,
    name: &str,
    input: Value,
    access: &dyn NativeCallAccess,
    context: &Context,
) -> Result<Output, ToolError> {
    let tool_context = access.call();
    if context.scope().identity.agent() != Some(&tool_context.execution)
        || context.scope().identity.operation_id() != Some(tool_context.operation_id.as_str())
    {
        return Err(failed("Workspace file call differs from its native source"));
    }
    let custody = context
        .work_custody()
        .ok_or_else(|| failed("Workspace file call lacks work custody"))?;
    if tool_context
        .custody
        .as_ref()
        .is_none_or(|original| !Arc::ptr_eq(original, custody))
    {
        return Err(failed(
            "Workspace file call changed its original work custody",
        ));
    }
    root.session_for_work(custody.as_ref(), &tool_context.execution.session_id)
        .map_err(failed)?;
    if context.operation().is_some() {
        access.bind_original(context).await?;
    }
    let (tool, _) = method(name).ok_or_else(|| failed("Workspace file method unavailable"))?;
    let image = name == "readImage";
    let cancellation = &context.scope().cancellation;
    cancelled(cancellation)?;
    let configuration = access.current().await?;
    if tool == maka_fs_tools::READ_NAME {
        let read: maka_agent_facts::read::ReadInput =
            serde_json::from_value(input.clone()).map_err(failed)?;
        let mut request = read.resolve().map_err(failed)?;
        if let Some(address) =
            maka_agent_facts::read::parse_imported_tool_result_path(request.path())
                .map_err(failed)?
        {
            if image {
                return Err(failed("Use readText for archived tool results"));
            }
            let result = async {
                let history = maka_agent_state::session_history::SessionHistory::new(
                    root.data_writer_for_work(custody.as_ref(), &tool_context.execution.session_id)
                        .map_err(failed)?,
                    access.run_owner().clone(),
                    tool_context.execution.session_id.clone(),
                );
                let cut = history.capture().await.map_err(failed)?;
                let tree =
                    maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
                        .await
                        .map_err(failed)?;
                let budget: Arc<dyn SourceBudget> = Arc::new(archive::Budget(Arc::new(
                    tokio::sync::Semaphore::new(2 * 1024 * 1024),
                )));
                let selected = tree
                    .imported_tool_result(&address, budget.clone(), cancellation)
                    .await
                    .map_err(failed)?;
                let maka_agent_state::session_history::tool_result_source::ToolResultSource::Returned(returned) =
                    selected.result else {
                    return Err(failed("Imported part lacks its original ToolReturn"));
                };
                let projection = returned.fields(budget.clone()).await.map_err(failed)?
                    .projection(budget.clone()).await.map_err(failed)?
                    .ok_or_else(|| failed("Original archived tool projection is missing"))?
                    .into_json(budget.clone()).await.map_err(failed)?;
                let (name, length) =
                    imported_tool_name(selected.name, budget.clone(), cancellation).await?;
                let name = std::str::from_utf8(&name.as_ref()[..length]).map_err(failed)?;
                if !request.is_continuation() {
                    request
                        .bind_imported_tool_result(&address)
                        .map_err(failed)?;
                }
                let page = maka_agent_facts::read::projection_page(
                    projection,
                    name,
                    &request,
                    read_page_budget(),
                    budget,
                    cancellation,
                )
                .await
                .map_err(failed)?;
                serde_json::to_value(page).map(Output::Json).map_err(failed)
            }
            .await;
            cancelled(cancellation)?;
            return result;
        }
        if let Some(address) =
            maka_agent_facts::read::ResourceAddress::parse(request.path()).map_err(failed)?
        {
            use maka_agent_facts::read::ResourceAddress;
            match &address {
                ResourceAddress::Task(_) => {
                    return Err(failed("This Files service does not support task resources"));
                }
                ResourceAddress::ToolResult(_) if image => {
                    return Err(failed("Use readText for archived tool results"));
                }
                _ => {}
            }
            cancelled(cancellation)?;
            match address {
                ResourceAddress::Attachment(mut id) => {
                    let scope = maka_agent_state::artifacts::SessionScope {
                        owner: access.run_owner().clone(),
                        session: tool_context.execution.session_id.clone(),
                    };
                    let artifacts = maka_agent_state::artifacts::ArtifactStore::new(
                        root.data_writer_for_work(custody.as_ref(), &scope.session)
                            .map_err(failed)?,
                    );
                    if !request.is_continuation() {
                        let record = artifacts
                            .resolve(scope.clone(), id)
                            .await
                            .map_err(failed)?
                            .ok_or_else(|| failed("Attachment was not found in this Session"))?;
                        if record.source != maka_agent_facts::artifact::ArtifactSource::UserUpload {
                            return Err(failed("Attachment was not found in this Session"));
                        }
                        id = record.id;
                        request
                            .bind_resource(&ResourceAddress::Attachment(id.clone()))
                            .map_err(failed)?;
                    }
                    return attachments::read(&artifacts, scope, id, request, image, cancellation)
                        .await;
                }
                ResourceAddress::ToolResult(id) => {
                    let history = maka_agent_state::session_history::SessionHistory::new(
                        root.data_writer_for_work(
                            custody.as_ref(),
                            &tool_context.execution.session_id,
                        )
                        .map_err(failed)?,
                        access.run_owner().clone(),
                        tool_context.execution.session_id.clone(),
                    );
                    let cut = history.capture().await.map_err(failed)?;
                    let source = history
                        .resolve_tool_result(&cut, &id)
                        .await
                        .map_err(failed)?
                        .ok_or_else(|| failed("Tool result was not found in this Session"))?;
                    if !request.is_continuation() {
                        request
                            .bind_resource(&ResourceAddress::ToolResult(
                                source.item.recorded.id.to_string(),
                            ))
                            .map_err(failed)?;
                    }
                    let page = archive::read(
                        &history,
                        &cut,
                        &source.item,
                        &source.tool_name,
                        &request,
                        cancellation,
                    )
                    .await?;
                    cancelled(cancellation)?;
                    return serde_json::to_value(page).map(Output::Json).map_err(failed);
                }
                ResourceAddress::Task(_) => unreachable!("task resource rejected above"),
            }
        }
    }

    let workspace = configuration.workspace.clone();
    let workspace_access = configuration.permissions.access;
    let floor = context.scope().sandbox_floor().clone();
    let mut captured = tokio::task::spawn_blocking(move || {
        capture(&workspace, workspace_access, &state_root, &floor)
    })
    .await
    .map_err(failed)??;
    if matches!(
        tool,
        maka_fs_tools::WRITE_NAME | maka_fs_tools::EDIT_NAME | maka_fs_tools::PATCH_NAME
    ) {
        captured = permissions::authorize(
            access,
            captured,
            &configuration,
            tool,
            &input,
            context.scope().sandbox_floor(),
            cancellation,
        )
        .await?;
    }
    let policy = match &captured.sandbox {
        Sandbox::Managed { filesystem, .. } => {
            Some(Arc::new(filesystem.compile().map_err(failed)?))
        }
        Sandbox::Disabled => None,
        _ => return Err(failed("Workspace filesystem policy unavailable")),
    };
    let current = access.current().await?;
    if current.permission_basis() != configuration.permission_basis()
        || current.workspace != configuration.workspace
    {
        return Err(failed(
            "Workspace permissions changed before file admission",
        ));
    }
    cancelled(cancellation)?;
    if matches!(
        tool,
        maka_fs_tools::WRITE_NAME | maka_fs_tools::EDIT_NAME | maka_fs_tools::PATCH_NAME
    ) {
        let executor = if let Some(policy) = policy {
            MutationExecutor::from_directory(
                captured.path,
                captured.directory,
                writes,
                Some(policy),
            )?
        } else {
            MutationExecutor::new(captured.path, WriteScope::Unrestricted, writes)?
        };
        executor
            .invoke(tool.into(), input, cancellation.clone())
            .await
            .map(Output::Json)
    } else {
        let executor = if let Some(policy) = policy {
            ReadExecutor::from_directory(captured.path, captured.directory, Some(policy))?
        } else {
            ReadExecutor::new(captured.path, ReadScope::Unrestricted)?
        };
        let input: maka_agent_facts::read::ReadInput =
            serde_json::from_value(input).map_err(failed)?;
        match executor
            .read(
                input.resolve().map_err(failed)?,
                read_page_budget(),
                cancellation.clone(),
            )
            .await?
        {
            ReadOutput::Text(_) if image => {
                Err(failed("Workspace readImage requires image content"))
            }
            ReadOutput::Text(page) => serde_json::to_value(page).map(Output::Json).map_err(failed),
            ReadOutput::Image { bytes, mime_type } if image => {
                Ok(Output::Image { bytes, mime_type })
            }
            ReadOutput::Image { .. } => {
                Err(failed("Workspace readText accepts UTF-8 text, not images"))
            }
        }
    }
}
fn cancelled(cancellation: &CancellationToken) -> Result<(), ToolError> {
    if cancellation.is_cancelled() {
        Err(failed("Workspace file operation cancelled"))
    } else {
        Ok(())
    }
}
async fn imported_tool_name(
    source: TextSource,
    budget: Arc<dyn SourceBudget>,
    stop: &CancellationToken,
) -> Result<(ChargedBuffer, usize), ToolError> {
    let capacity = usize::try_from(
        source
            .bytes()
            .len()
            .ok_or_else(|| failed("Imported tool name lacks its original bounded span"))?,
    )
    .map_err(failed)?;
    let mut name = budget.allocate(capacity).await.map_err(failed)?;
    let mut buffer = budget.allocate(32 * 1024).await.map_err(failed)?;
    let mut cursor = pull::text::cursor(source, budget);
    let mut length = 0usize;
    loop {
        cancelled(stop)?;
        let read = cursor.read_chunk(buffer).await.map_err(failed)?;
        let end = length
            .checked_add(read.bytes_read)
            .ok_or_else(|| failed("Imported tool name length overflow"))?;
        name.as_mut()
            .get_mut(length..end)
            .ok_or_else(|| failed("Imported tool name exceeds its original bounded span"))?
            .copy_from_slice(&read.buffer.as_ref()[..read.bytes_read]);
        length = end;
        buffer = read.buffer;
        if read.eof {
            break;
        }
    }
    if length == 0 {
        return Err(failed("Imported tool name is empty"));
    }
    Ok((name, length))
}

fn failed(message: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(message.to_string())
}

// Reserve the public service envelope so model pruning preserves the file continuation.
fn read_page_budget() -> usize {
    let envelope = serde_json::to_string(&FileResult::Completed { value: Value::Null })
        .expect("file result envelope")
        .len()
        - "null".len();
    maka_agent_facts::read::MAX_PAGE_CHARS - envelope
}
