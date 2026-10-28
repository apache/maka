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

use crate::contract::{Workspace, WorkspacePermissions};
use maka_agent_facts::workspace::{BindingRef, BindingStamp};
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredSessionConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<crate::contract::BackendPreference>,
    #[serde(default)]
    pub collaboration_mode: maka_agent_facts::execution::CollaborationMode,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_prompt: Option<String>,
    pub title: String,
    pub title_is_manual: bool,
    pub labels: Vec<String>,
    pub workspace: BindingRef,
    pub permissions: WorkspacePermissions,
    /// Local permission base. Resolve with the binding epoch before checking authority.
    #[serde(rename = "boundary_revision")]
    pub boundary_revision: u64,
}

/// Current workspace and permission authority resolved in the Session read's
/// database snapshot. Historical captured configurations must never be upgraded.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedConfiguration {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<crate::contract::BackendPreference>,
    #[serde(default)]
    pub collaboration_mode: maka_agent_facts::execution::CollaborationMode,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_prompt: Option<String>,
    pub title: String,
    pub title_is_manual: bool,
    pub labels: Vec<String>,
    pub workspace: Workspace,
    pub binding: BindingStamp,
    pub permissions: WorkspacePermissions,
    #[serde(rename = "boundary_revision")]
    pub boundary_revision: u64,
}

impl StoredSessionConfiguration {
    pub fn resolve(
        self,
        workspace: Workspace,
        stamp: BindingStamp,
    ) -> Result<ResolvedConfiguration, &'static str> {
        let boundary_revision = self
            .workspace
            .boundary_revision(self.boundary_revision, stamp)?;
        Ok(ResolvedConfiguration {
            backend: self.backend,
            collaboration_mode: self.collaboration_mode,
            tools: self.tools,
            compaction_prompt: self.compaction_prompt,
            title: self.title,
            title_is_manual: self.title_is_manual,
            labels: self.labels,
            workspace,
            binding: stamp,
            permissions: self.permissions,
            boundary_revision,
        })
    }
}

impl ResolvedConfiguration {
    pub fn permission_basis(&self) -> maka_agent_facts::workspace::PermissionBasis {
        maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: self.boundary_revision,
            binding: self.binding,
        }
    }

    /// Attach to a new binding after the old effective boundary was resolved.
    /// The Session metadata transaction validates the reference's current epochs.
    pub fn into_stored(self, workspace: BindingRef) -> StoredSessionConfiguration {
        StoredSessionConfiguration {
            backend: self.backend,
            collaboration_mode: self.collaboration_mode,
            tools: self.tools,
            compaction_prompt: self.compaction_prompt,
            title: self.title,
            title_is_manual: self.title_is_manual,
            labels: self.labels,
            workspace,
            permissions: self.permissions,
            boundary_revision: self.boundary_revision,
        }
    }
}
