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

//! Immutable history-only checkpoints. These are not workspace snapshots or
//! execution grants, and their revisions are independent of live Session revisions.
use crate::{StoreError, bundle::Inventory};
use maka_plugin_core::composition::InstanceId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub state_domain: String,
    pub deployment: Uuid,
    pub namespace: InstanceId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Revision(pub Uuid);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicationRequest {
    pub operation: Uuid,
    /// Fingerprint of the original admitted operation, not a new retry identity.
    pub fingerprint: String,
    pub expected_revision: Option<Revision>,
    /// Confirmation of catalog membership, not a live revision precondition.
    pub confirmed_subtree_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectRef {
    /// SHA-256 over every byte, including the native transfer's final frame.
    pub digest: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum Manifest {
    #[serde(rename = "native_history_v1")]
    NativeHistory {
        root_id: String,
        scope: Scope,
        inventory: Inventory,
        /// MAKA-SESSION version 2; no TS tar.zst compatibility is implied.
        bundle: ObjectRef,
        /// The native format's own framed-stream checksum.
        transfer_digest: String,
    },
}
impl Manifest {
    pub fn bundle(&self) -> &ObjectRef {
        match self {
            Self::NativeHistory { bundle, .. } => bundle,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Head {
    pub revision: Revision,
    pub manifest: ObjectRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PublicationState {
    Capturing,
    Prepared {
        manifest: ObjectRef,
    },
    Published {
        head: Head,
    },
    Conflict {
        actual: Option<Revision>,
    },
    Interrupted,
    /// Prepared bytes could not be verified. Keep their identity for diagnosis;
    /// never repair an original request by capturing newer live history.
    Unavailable {
        manifest: ObjectRef,
        cause: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    pub state: PublicationState,
    /// Business completion survives a failure to remove owned temporary files.
    pub cleanup_pending: bool,
    pub cleanup_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub scope: Scope,
    pub session_id: String,
    pub publication: PublicationRequest,
}

pub(crate) fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

pub(crate) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
impl Request {
    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        crate::sessions::validate_id(&self.session_id)?;
        self.scope
            .namespace
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        if !valid_digest(&self.scope.state_domain)
            || self.scope.deployment.is_nil()
            || self.publication.operation.is_nil()
            || !valid_digest(&self.publication.fingerprint)
            || !valid_digest(&self.publication.confirmed_subtree_digest)
            || self
                .publication
                .expected_revision
                .is_some_and(|v| v.0.is_nil())
        {
            return Err(invalid("invalid history checkpoint request"));
        }
        Ok(())
    }
    pub(crate) fn key(&self) -> Result<String, StoreError> {
        Ok(digest(&serde_json::to_vec(&(
            &self.scope,
            &self.session_id,
            self.publication.operation,
        ))?))
    }
}
