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

//! The converters need only explicitly authorized source reads. They do not
//! receive execution, persistence, or authorization capabilities.
use crate::Error;
use futures_util::future::BoxFuture;
use maka_agent_facts::execution::CollaborationMode;
use maka_agent_ports::remote::Views;
use maka_agent_ports::remote::WorkspaceViewInput;
use maka_capabilities::filesystem::ReadDirectory;
use maka_capabilities::filesystem::database;
use maka_sandbox::Mode as SandboxMode;
use maka_sandbox::workspace::WorkspaceTarget;

pub trait ReadSource: Send + Sync {
    fn open_file(
        &self,
        path: String,
    ) -> BoxFuture<'_, Result<maka_capabilities::filesystem::PinnedFile, Error>> {
        Box::pin(async move {
            let path = std::path::Path::new(&path);
            let parent = path
                .parent()
                .and_then(|value| value.to_str())
                .ok_or(Error::Invalid("source media has no directory"))?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or(Error::Invalid("source media filename is invalid"))?;
            let directory = self.directory(parent.into()).await?;
            Ok(directory
                .open_file(maka_capabilities::filesystem::OpenFile {
                    path: name.into(),
                    symlinks: maka_capabilities::filesystem::Symlinks::Reject,
                })
                .await?)
        })
    }
    fn directory(&self, path: String) -> BoxFuture<'_, Result<ReadDirectory, Error>>;
    fn query_database(
        &self,
        input: database::Read,
    ) -> BoxFuture<'_, Result<Vec<database::Table>, database::Error>>;
}

impl<T: Views + ?Sized> ReadSource for T {
    fn directory(&self, path: String) -> BoxFuture<'_, Result<ReadDirectory, Error>> {
        Box::pin(async move {
            Ok(self
                .workspace(WorkspaceViewInput {
                    workspace: WorkspaceTarget::HostPath { path },
                    sandbox_mode: SandboxMode::ReadOnly,
                    collaboration_mode: CollaborationMode::Agent,
                })
                .await?
                .files)
        })
    }
    fn query_database(
        &self,
        input: database::Read,
    ) -> BoxFuture<'_, Result<Vec<database::Table>, database::Error>> {
        Views::query_database(self, input)
    }
}
