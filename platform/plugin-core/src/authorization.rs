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

//! Frozen Host permission constraints, never a bearer capability.
use serde::{Deserialize, Serialize};

/// Frozen observation, not a capability. Only a Host-issued Scope can use it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Boundary {
    Profile,
    Directory {
        path: String,
        identity: maka_sandbox::workspace::DirectoryIdentity,
    },
    Session {
        boundary: SessionBoundary,
        workspace_identity: maka_sandbox::workspace::WorkspaceIdentity,
    },
    Workspace {
        workspace: maka_sandbox::workspace::WorkspaceProjection,
        workspace_identity: maka_sandbox::workspace::WorkspaceIdentity,
        origin: maka_sandbox::workspace::WorkspaceOrigin,
        sandbox_mode: maka_sandbox::Mode,
    },
}
/// Persisted constraints, not a bearer capability. Only an explicit Host grant
/// binds them to a live plugin instance; current boundaries are still checked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionBoundary {
    pub workspace_origin: maka_sandbox::workspace::WorkspaceOrigin,
    pub session_id: String,
    pub boundary_revision: u64,
    pub sandbox_mode: maka_sandbox::Mode,
    pub approval_policy: maka_sandbox::Approval,
    pub cwd: String,
}
impl SessionBoundary {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.session_id.is_empty()
            || self
                .session_id
                .chars()
                .any(|character| character.is_control() || character.is_whitespace())
        {
            return Err("invalid Session execution identity");
        }
        if self.boundary_revision >= (1 << 53) || self.cwd.is_empty() || self.cwd.contains('\0') {
            return Err("invalid Session execution boundary");
        }
        Ok(())
    }
}
