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

//! Original workspace-publication evidence. Source and manifests contain no grants.
use crate::durable::{ContentRef, ExecutionIdentity, ExternalPublicationId, ExternalTaskId};
use maka_plugin_core::operation::{OperationCleanup, OperationReply, RecoveryRef};
use maka_sandbox::workspace::PermissionBasis;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalPublicationSource<T> {
    pub schema_version: u32,
    pub execution: ExecutionIdentity,
    pub task: ExternalTaskId,
    pub payload: T,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationManifest<Root, Change> {
    pub schema_version: u32,
    pub publication: ExternalPublicationId,
    pub task: ExternalTaskId,
    pub source: ContentRef,
    pub basis: PermissionBasis,
    pub root: Root,
    pub changes: Vec<Change>,
    pub contents: Vec<ContentRef>,
}
impl<Root, Change> PublicationManifest<Root, Change> {
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        let mut refs = vec![&self.source];
        refs.extend(&self.contents);
        refs
    }
}

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalPublicationKey {
    pub publication: ExternalPublicationId,
    pub index: u64,
}

/// Native maps the actual FS result exhaustively; State never guesses from FS JSON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalPublicationOutcome {
    Applied,
    Conflict,
    Unsupported,
    NotAttempted,
    Failed,
    Unknown,
    NotExecuted,
    Prevented,
}
impl ExternalPublicationOutcome {
    pub fn known(self) -> bool {
        self != Self::Unknown
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ExternalPublicationEvent {
    Pending {
        id: ExternalPublicationId,
        task: ExternalTaskId,
        source: ContentRef,
    },
    Prepared {
        id: ExternalPublicationId,
        manifest: ContentRef,
        item_count: u64,
    },
    Admitted {
        key: ExternalPublicationKey,
        basis: PermissionBasis,
    },
    PreventedBeforeHostAdmission {
        key: ExternalPublicationKey,
        diagnostic: String,
    },
    Bound {
        key: ExternalPublicationKey,
        original: RecoveryRef,
    },
    Observed {
        key: ExternalPublicationKey,
        observation: OperationReply,
        outcome: ExternalPublicationOutcome,
    },
    CleanupObserved {
        key: ExternalPublicationKey,
        cleanup: OperationCleanup,
    },
    Abandoned {
        id: ExternalPublicationId,
    },
}
impl ExternalPublicationEvent {
    pub fn id(&self) -> ExternalPublicationId {
        match self {
            Self::Pending { id, .. } | Self::Prepared { id, .. } | Self::Abandoned { id } => *id,
            Self::Admitted { key, .. }
            | Self::PreventedBeforeHostAdmission { key, .. }
            | Self::Bound { key, .. }
            | Self::Observed { key, .. }
            | Self::CleanupObserved { key, .. } => key.publication,
        }
    }
    pub fn key(&self) -> Option<ExternalPublicationKey> {
        match self {
            Self::Admitted { key, .. }
            | Self::PreventedBeforeHostAdmission { key, .. }
            | Self::Bound { key, .. }
            | Self::Observed { key, .. }
            | Self::CleanupObserved { key, .. } => Some(*key),
            _ => None,
        }
    }
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        match self {
            Self::Pending { source, .. } => vec![source],
            Self::Prepared { manifest, .. } => vec![manifest],
            _ => vec![],
        }
    }
    pub fn is_admission(&self) -> bool {
        matches!(self, Self::Admitted { .. })
    }
    pub fn is_late(&self) -> bool {
        matches!(
            self,
            Self::Pending { .. }
                | Self::PreventedBeforeHostAdmission { .. }
                | Self::Bound { .. }
                | Self::Observed { .. }
                | Self::CleanupObserved { .. }
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExternalPublicationBlocker {
    Unknown,
    Conflict,
    Unsupported,
    Failed,
    NotAttempted,
    CleanupUnconfirmed,
}
