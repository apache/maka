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
use maka_agent_authority::publication::{PublicationAccess, PublicationCallContext};
use maka_capabilities::call::{ReadResource, ResourceEncoding};
use maka_fs_tools::publication::{
    PublicationContent, PublicationEntry, PublicationResult, PublishChange,
};
use std::io::{self, Read, Seek, SeekFrom};

pub(super) async fn call(
    root: &RootStore,
    writes: Arc<WriteCoordinator>,
    state_root: PathBuf,
    input: Value,
    context: &Context,
) -> Result<Value, HandlerError> {
    let native = context
        .native_context::<PublicationCallContext>()
        .ok_or("workspace_publication_requires_native_role")?;
    let access = native.0.as_ref();
    if context.operation().is_none() {
        return Err("workspace_publication_requires_mutation".into());
    }
    let custody = context
        .work_custody()
        .ok_or("workspace_publication_requires_work_custody")?;
    root.session_for_work(custody.as_ref(), &access.execution().session_id)
        .map_err(|error| HandlerError::from(error.to_string()))?;
    let input: PublishChange =
        serde_json::from_value(input).map_err(|error| HandlerError::from(error.to_string()))?;
    if input.publication != access.publication() || input.index != access.index() {
        return Err("workspace_publication_selector_changed".into());
    }
    let mut ticket = context
        .scope()
        .resources
        .reserve()
        .map_err(|error| HandlerError::from(error.to_string()))?;
    ticket.start();
    let result = execute(access, writes, state_root, context).await;
    let cleanup = match &result {
        Err(ToolError::CleanupUnconfirmed(message)) => Err(message.clone()),
        _ => Ok(()),
    };
    ticket.complete(cleanup);
    let result = result.map_err(|error| match error {
        ToolError::OutcomeUnknown(_)
        | ToolError::CleanupUnconfirmed(_)
        | ToolError::Persistence(_) => HandlerError::Unknown {
            diagnostic: error.to_string(),
        },
        _ => HandlerError::from(error.to_string()),
    })?;
    serde_json::to_value(result).map_err(|error| HandlerError::Unknown {
        diagnostic: error.to_string(),
    })
}

async fn execute(
    access: &dyn PublicationAccess,
    writes: Arc<WriteCoordinator>,
    state_root: PathBuf,
    context: &Context,
) -> Result<PublicationResult, ToolError> {
    let stop = &context.scope().cancellation;
    cancelled(stop)?;
    let configuration = access.validate(context).await?;
    if &configuration.permission_basis() != access.permission_basis() {
        return Err(failed("Workspace publication permission basis changed"));
    }
    if configuration.permissions.access == WorkspaceAccess::ReadOnly {
        return Err(failed("Workspace publication requires write access"));
    }
    let content: Option<Box<dyn PublicationContent>> = match (
        &access.change().candidate,
        context.attachments().get("content"),
    ) {
        (PublicationEntry::File { .. }, Some(resource)) => {
            if resource.resource_type() != maka_plugin_core::contract::binary_resource_type()
                || resource.encoding() != ResourceEncoding::Bytes
            {
                return Err(failed(
                    "Publication content must be an immutable binary resource",
                ));
            }
            Some(Box::new(Content {
                bytes: resource.bytes() as u64,
                resource: resource.clone(),
                position: 0,
            }))
        }
        (PublicationEntry::File { .. }, None) => {
            return Err(failed("Publication write requires content"));
        }
        (_, Some(_)) => return Err(failed("Only publication writes accept content")),
        (_, None) => None,
    };
    let workspace = configuration.workspace.clone();
    let workspace_access = configuration.permissions.access;
    let floor = context.scope().sandbox_floor().clone();
    let (captured, policy) = tokio::task::spawn_blocking(move || {
        let captured = capture(&workspace, workspace_access, &state_root, &floor)?;
        let policy = match &captured.sandbox {
            Sandbox::Managed { filesystem, .. } => {
                Some(Arc::new(filesystem.compile().map_err(failed)?))
            }
            Sandbox::Disabled => None,
            _ => {
                return Err(failed(
                    "Workspace publication filesystem policy unavailable",
                ));
            }
        };
        Ok::<_, ToolError>((captured, policy))
    })
    .await
    .map_err(failed)??;
    let current = access.validate(context).await?;
    if current.workspace != configuration.workspace
        || current.permission_basis() != configuration.permission_basis()
        || &current.permission_basis() != access.permission_basis()
    {
        return Err(failed(
            "Workspace permissions changed before publication admission",
        ));
    }
    cancelled(stop)?;
    let executor =
        MutationExecutor::from_directory(captured.path, captured.directory, writes, policy)?;
    access.bind_original(context).await?;
    cancelled(stop)?;
    executor
        .publish_change(
            access.change().clone(),
            *access.source(),
            content,
            stop.clone(),
        )
        .await
}

struct Content {
    resource: Arc<dyn ReadResource>,
    bytes: u64,
    position: u64,
}
impl Read for Content {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() || self.position >= self.bytes {
            return Ok(0);
        }
        let start = usize::try_from(self.position)
            .map_err(|_| io::Error::other("publication resource offset overflow"))?;
        let remaining = usize::try_from(self.bytes - self.position)
            .map_err(|_| io::Error::other("publication resource length overflow"))?;
        let count = buffer
            .len()
            .min(remaining)
            .min(maka_host_runtime::application::RESOURCE_CHUNK_LIMIT);
        let bytes = self
            .resource
            .read(start..start + count)
            .map_err(io::Error::other)?;
        if bytes.len() != count {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "immutable publication resource length changed",
            ));
        }
        buffer[..count].copy_from_slice(&bytes);
        self.position += count as u64;
        Ok(count)
    }
}
impl Seek for Content {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let position = match position {
            SeekFrom::Start(position) => Some(position),
            SeekFrom::End(offset) => self.bytes.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid publication resource seek",
            )
        })?;
        self.position = position;
        Ok(position)
    }
}
