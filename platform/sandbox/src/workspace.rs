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

//! Durable workspace references and immutable permission evidence. Concrete
//! Workspace selections belong to the native API, not this dependency layer.
mod directory;
#[cfg(target_os = "macos")]
pub use directory::volume_uuid;

use serde::{Deserialize, Serialize};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingRef {
    pub id: uuid::Uuid,
    pub permission_epoch_at_attach: u64,
    pub metadata_epoch_at_attach: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindingStamp {
    pub id: uuid::Uuid,
    pub permission_epoch: u64,
}

/// Captured authority, never silently upgraded by resolving a current binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionBasis {
    pub boundary_revision: u64,
    pub binding: BindingStamp,
}

impl BindingRef {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil()
            || self.permission_epoch_at_attach > MAX_SAFE_INTEGER
            || self.metadata_epoch_at_attach > MAX_SAFE_INTEGER
        {
            return Err("invalid workspace binding reference");
        }
        Ok(())
    }

    pub fn boundary_revision(&self, local: u64, stamp: BindingStamp) -> Result<u64, &'static str> {
        self.validate()?;
        stamp.validate()?;
        if self.id != stamp.id {
            return Err("workspace binding identity changed");
        }
        effective_revision(
            local,
            stamp.permission_epoch,
            self.permission_epoch_at_attach,
        )
    }

    pub fn session_revision(&self, local: u64, metadata_epoch: u64) -> Result<u64, &'static str> {
        self.validate()?;
        effective_revision(local, metadata_epoch, self.metadata_epoch_at_attach)
    }
}

impl BindingStamp {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_nil() || self.permission_epoch > MAX_SAFE_INTEGER {
            return Err("invalid workspace binding stamp");
        }
        Ok(())
    }
}

impl PermissionBasis {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.binding.validate()?;
        if self.boundary_revision > MAX_SAFE_INTEGER {
            return Err("invalid workspace permission boundary");
        }
        Ok(())
    }
}

fn effective_revision(local: u64, current: u64, attached: u64) -> Result<u64, &'static str> {
    if current > MAX_SAFE_INTEGER {
        return Err("workspace epoch exhausted");
    }
    current
        .checked_sub(attached)
        .and_then(|delta| local.checked_add(delta))
        .filter(|revision| *revision <= MAX_SAFE_INTEGER)
        .ok_or("workspace revision is invalid or exhausted")
}

/// Intrinsic workspace identity is distinct from its current filesystem location.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct WorkspaceIdentity(String);

/// Filesystem-object observation for directory consent, not an execution workspace marker.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct DirectoryIdentity(String);

impl TryFrom<String> for DirectoryIdentity {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.strip_prefix("sha256:").is_none_or(|hex| {
            hex.len() != 64
                || !hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        }) {
            return Err("invalid directory identity");
        }
        Ok(Self(value))
    }
}
impl From<DirectoryIdentity> for String {
    fn from(identity: DirectoryIdentity) -> Self {
        identity.0
    }
}

impl WorkspaceIdentity {
    pub fn from_marker_id(id: &str) -> Result<Self, &'static str> {
        let uuid = uuid::Uuid::parse_str(id).map_err(|_| "invalid workspace UUID")?;
        if id.len() != 36
            || !uuid.hyphenated().to_string().eq_ignore_ascii_case(id)
            || !(1..=8).contains(&uuid.get_version_num())
            || uuid.get_variant() != uuid::Variant::RFC4122
        {
            return Err("invalid workspace UUID");
        }
        // Preserve an existing marker's exact spelling, including uppercase UUIDs.
        Ok(Self(format!("workspace:v1:{id}")))
    }

    pub fn marker_id(&self) -> &str {
        &self.0["workspace:v1:".len()..]
    }
}

impl TryFrom<String> for WorkspaceIdentity {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_marker_id(
            value
                .strip_prefix("workspace:v1:")
                .ok_or("invalid workspace identity")?,
        )
    }
}

impl From<WorkspaceIdentity> for String {
    fn from(identity: WorkspaceIdentity) -> Self {
        identity.0
    }
}

/// User-selected workspace locator, before Host path resolution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceTarget {
    Project { project_id: String },
    HostPath { path: String },
}

/// Host-resolved location; a locator alone never authorizes filesystem access.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceProjection {
    pub target: WorkspaceTarget,
    pub host_cwd: String,
}

/// Host-issued provenance recorded with execution authority, never inferred from
/// the display projection's path or supplied by a workspace locator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceOrigin {
    Selected,
    Allocated,
}
