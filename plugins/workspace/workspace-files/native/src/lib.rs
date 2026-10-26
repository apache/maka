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
use maka_agent_facts::tools::ToolCallContext;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_event_log::RootStore;
use maka_fs_tools::{
    MutationExecutor, ReadExecutor, ReadOutput, ReadScope, WriteCoordinator, WriteScope,
};
use maka_host_runtime::application::{
    Context, Handler, NativeActivation, NativeOwner, NativeRegistry,
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

pub mod attachments;
mod permissions;

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
    ) -> BoxFuture<'static, Result<Value, String>> {
        let store = self.store.clone();
        let writes = self.writes.clone();
        let state_root = self.state_root.clone();
        Box::pin(async move {
            let (_, mutation) = method(&name).ok_or("workspace_file_method_unavailable")?;
            let invocation = context
                .scope()
                .identity
                .agent()
                .ok_or("workspace_files_require_agent")?
                .clone();
            let operation_id = context
                .scope()
                .identity
                .operation_id()
                .ok_or("workspace_files_require_tool")?
                .into();
            if mutation && context.operation().is_none() {
                return Err("workspace_file_mutation_required".into());
            }
            let tool_context = ToolCallContext {
                invocation,
                operation_id,
                execution: context.scope().execution().cloned(),
            };
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
                tool_context,
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
                    return serde_json::to_value(maka_agent_api::contract::ImageFrame::Complete)
                        .map_err(|e| e.to_string());
                }
                Ok(Output::Json(value)) => FileResult::Completed { value },
                Err(error) if name == "readImage" => return Err(error.to_string()),
                Err(ToolError::Failed(message) | ToolError::Io { message, .. }) => {
                    FileResult::Failed { message }
                }
                Err(error) => return Err(error.to_string()),
            };
            serde_json::to_value(result).map_err(|_| "workspace_file_result_unavailable".into())
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
    if access == WorkspaceAccess::DangerFullAccess {
        return Ok(Captured {
            path,
            directory,
            sandbox: Sandbox::Disabled,
            ceiling: Sandbox::Disabled,
        });
    }
    let (sandbox, ceiling) =
        maka_workspace_support::sandbox(workspace, access, state_root).map_err(failed)?;
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
    tool_context: ToolCallContext,
    context: &Context,
) -> Result<Output, ToolError> {
    let store = maka_agent_authority::permissions::execution(
        root,
        &tool_context.invocation,
        tool_context.execution.as_deref(),
    )?;
    let (tool, _) = method(name).ok_or_else(|| failed("Workspace file method unavailable"))?;
    let image = name == "readImage";
    let cancellation = &context.scope().cancellation;
    cancelled(cancellation)?;
    let configuration =
        maka_agent_authority::permissions::live(&store, &tool_context.invocation).await?;
    if tool == maka_fs_tools::READ_NAME {
        let read: maka_agent_facts::read::ReadInput =
            serde_json::from_value(input.clone()).map_err(failed)?;
        let mut request = read.resolve().map_err(failed)?;
        if let Some(mut address) =
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
            let missing = match &address {
                ResourceAddress::Attachment(_) => "Attachment was not found in this Session",
                _ => "Tool result was not found in this Session",
            };
            cancelled(cancellation)?;
            if !request.is_continuation() {
                address = store
                    .resolve_read_resource(&tool_context.invocation.session_id, address)
                    .await
                    .map_err(failed)?
                    .ok_or_else(|| failed(missing))?;
                cancelled(cancellation)?;
                request.bind_resource(&address).map_err(failed)?;
            }
            match address {
                ResourceAddress::Attachment(id) => {
                    return attachments::read(
                        &store,
                        &tool_context.invocation.session_id,
                        &id,
                        &request,
                        image,
                        cancellation,
                    )
                    .await;
                }
                ResourceAddress::ToolResult(id) => {
                    cancelled(cancellation)?;
                    // Await the original store job: dropping its reply cannot
                    // cancel the physical read or settle this call's ticket.
                    let result = store
                        .read_tool_result(&tool_context.invocation.session_id, &id)
                        .await
                        .map_err(failed)?;
                    cancelled(cancellation)?;
                    let result = result
                        .ok_or_else(|| failed("Tool result was not found in this Session"))?;
                    let page = request
                        .tool_result_page(
                            &result.tool_name,
                            &result.serialized_result,
                            read_page_budget(),
                        )
                        .map_err(failed)?;
                    cancelled(cancellation)?;
                    return serde_json::to_value(page).map(Output::Json).map_err(failed);
                }
                ResourceAddress::Task(_) => unreachable!("task resource rejected above"),
            }
        }
    }

    let workspace = configuration.workspace.clone();
    let access = configuration.permissions.access;
    let mut captured =
        tokio::task::spawn_blocking(move || capture(&workspace, access, &state_root))
            .await
            .map_err(failed)??;
    if matches!(
        tool,
        maka_fs_tools::WRITE_NAME | maka_fs_tools::EDIT_NAME | maka_fs_tools::PATCH_NAME
    ) {
        captured = permissions::authorize(
            &store,
            captured,
            &configuration,
            tool,
            &input,
            &tool_context,
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
    // This original SQL snapshot is the filesystem admission point, ordered
    // against permission CAS and invocation closure in the same Root worker.
    let current = maka_agent_authority::permissions::live(&store, &tool_context.invocation).await?;
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
        if tool == maka_fs_tools::READ_NAME {
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
                ReadOutput::Text(page) => {
                    serde_json::to_value(page).map(Output::Json).map_err(failed)
                }
                ReadOutput::Image { bytes, mime_type } if image => {
                    Ok(Output::Image { bytes, mime_type })
                }
                ReadOutput::Image { .. } => {
                    Err(failed("Workspace readText accepts UTF-8 text, not images"))
                }
            }
        } else {
            executor
                .invoke(tool.into(), input, cancellation.clone())
                .await
                .map(Output::Json)
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
