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

mod edit_index;
mod edit_match;
pub use edit_match::EditMatchStrategy;
pub mod directory;
pub mod files;
pub mod git;
pub mod image;
pub mod path;
mod search;
pub mod workspace;
pub mod worktree;
pub use search::{GLOB_DESCRIPTION, GLOB_NAME, glob_schema};
mod grep;
pub use grep::{GREP_DESCRIPTION, GREP_NAME, grep_schema};
mod mutation;
mod patch;
pub mod publication;
mod scoped;
mod write;
mod write_target;

pub use mutation::{
    EDIT_DESCRIPTION, EDIT_NAME, WRITE_DESCRIPTION, WRITE_NAME, edit_schema, write_schema,
};
pub use patch::{PATCH_DESCRIPTION, PATCH_NAME, patch_schema};
pub use write::{MutationExecutor, WriteCoordinator, WriteScope, mutation_paths};

use maka_agent_facts::read::ReadInput;
use maka_agent_facts::read::ReadPage;
use maka_agent_facts::read::ReadRequest;
use maka_agent_facts::tools::ToolError;
use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub const READ_NAME: &str = "Read";
pub const READ_DESCRIPTION: &str = "Read a bounded page of UTF-8 text or a PNG/JPEG/GIF/WebP image within the Session's allowed filesystem roots. Offset is zero-based lines; limit is a positive line count. Pass a non-null next object to Read to continue; a changed source invalidates the continuation. Images ignore offset/limit and return the original encoded bytes.";

pub fn read_schema() -> Value {
    schemars::schema_for!(ReadInput).into()
}

/// Trusted Host authority, never deserialized from tool arguments.
/// Directory capabilities enforce reads; this is not an OS process sandbox.
pub enum ReadScope {
    Restricted { roots: Vec<PathBuf> },
    Policy(Arc<maka_sandbox::filesystem::Compiled>),
    Unrestricted,
}

/// Bytes remain internal until the Host commits the image snapshot and result.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadOutput {
    Text(ReadPage),
    Image { bytes: Vec<u8>, mime_type: String },
}

/// Metadata observed from the authorized regular file before creating a sink.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BinaryFileMetadata {
    pub name: String,
    pub bytes: u64,
    /// Last modification time observed from this opened file, when available.
    pub modified: Option<std::time::SystemTime>,
}

#[derive(Clone)]
pub struct ReadExecutor {
    authority: Arc<scoped::Authority>,
}

impl ReadExecutor {
    /// Retain the selected directory. With a policy, external paths are governed
    /// by that policy; without one, access stays confined to this directory.
    pub fn from_directory(
        path: PathBuf,
        directory: cap_std::fs::Dir,
        policy: Option<Arc<maka_sandbox::filesystem::Compiled>>,
    ) -> Result<Self, ToolError> {
        Ok(Self {
            authority: Arc::new(scoped::Authority::from_directory(path, directory, policy)?),
        })
    }
    pub fn new(cwd: impl AsRef<Path>, scope: ReadScope) -> Result<Self, ToolError> {
        Ok(Self {
            authority: Arc::new(scoped::Authority::new(cwd.as_ref(), scope)?),
        })
    }

    pub async fn read(
        &self,
        input: ReadRequest,
        page_budget: usize,
        cancellation: CancellationToken,
    ) -> Result<ReadOutput, ToolError> {
        let authority = self.authority.clone();
        if input.path().contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        // Always join blocking I/O: cancellation must not detach unsettled work.
        tokio::task::spawn_blocking(move || authority.read(input, page_budget, cancellation))
            .await
            .map_err(|e| failed(format!("Read worker failed: {e}")))?
    }

    /// Observe an authorized regular file's name and length for budget sizing.
    /// This does not freeze content or authorize a later open; copying must
    /// open through the same authority again and check its current metadata.
    ///
    /// # Errors
    /// Returns file, policy, cancellation or worker errors.
    pub async fn binary_metadata(
        &self,
        path: String,
        cancellation: CancellationToken,
    ) -> Result<BinaryFileMetadata, ToolError> {
        if path.contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        let authority = self.authority.clone();
        tokio::task::spawn_blocking(move || authority.binary_metadata(path, cancellation))
            .await
            .map_err(|error| failed(format!("Binary metadata worker failed: {error}")))?
    }

    /// Copy an authorized regular file into a caller-owned binary sink.
    /// The factory runs only after opening through this executor's directory
    /// authority. The source descriptor stays in the joined worker; the caller
    /// finalizes the returned sink within its original resource custody.
    ///
    /// # Errors
    /// Returns policy, file, sink, cancellation or observable source-change
    /// errors. Blocking work is joined before returning, including cancellation.
    pub async fn copy_binary<W, F>(
        &self,
        path: String,
        create: F,
        cancellation: CancellationToken,
    ) -> Result<W, ToolError>
    where
        W: std::io::Write + Send + 'static,
        F: FnOnce(BinaryFileMetadata) -> Result<W, ToolError> + Send + 'static,
    {
        if path.contains("://") {
            return Err(failed("Filesystem Read requires a file path"));
        }
        let authority = self.authority.clone();
        tokio::task::spawn_blocking(move || authority.copy_binary(path, create, cancellation))
            .await
            .map_err(|error| failed(format!("Binary Read worker failed: {error}")))?
    }
}

impl ToolExecutor for ReadExecutor {
    fn names(&self) -> Vec<String> {
        vec![READ_NAME.into(), GLOB_NAME.into(), GREP_NAME.into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let executor = self.clone();
        Box::pin(async move {
            if name == GLOB_NAME {
                return executor.glob(input, cancellation).await;
            }
            if name == GREP_NAME {
                return executor.grep(input, cancellation).await;
            }
            if name != READ_NAME {
                return Err(failed("unsupported tool"));
            }
            let input: ReadInput =
                serde_json::from_value(input).map_err(|e| failed(e.to_string()))?;
            let request = input.resolve().map_err(|e| failed(e.to_string()))?;
            match executor
                .read(
                    request,
                    maka_agent_facts::read::MAX_PAGE_CHARS,
                    cancellation,
                )
                .await?
            {
                ReadOutput::Text(page) => Ok(serde_json::to_value(page).expect("ReadPage is JSON")),
                ReadOutput::Image { .. } => Err(failed(
                    "Read image requires a durable journal snapshot; use the Host typed Read path",
                )),
            }
        })
    }
}

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}
