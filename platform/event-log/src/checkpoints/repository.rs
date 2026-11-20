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

//! Checkpoint authority independent of worker Roots. Implementations are trusted
//! assembly capabilities, not grants to execute a Session.
use super::{Head, Manifest, ObjectRef, Revision, Scope, invalid, valid_digest};
use crate::{StoreError, connection::BoxFuture};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, sync::Arc};
use uuid::Uuid;
pub mod files;
pub(crate) mod sql;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionIdentity {
    pub session: Uuid,
    pub agent: Uuid,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub root_id: String,
    pub scope: Scope,
    pub session: String,
}
impl Source {
    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        crate::sessions::validate_id(&self.session)?;
        self.scope
            .namespace
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        if !valid_digest(&self.root_id)
            || !valid_digest(&self.scope.state_domain)
            || self.scope.deployment.is_nil()
        {
            return Err(invalid("invalid checkpoint source"));
        }
        Ok(())
    }
    pub(crate) fn key(&self) -> Result<String, StoreError> {
        self.validate()?;
        Ok(super::digest(&serde_json::to_vec(self)?))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub identity: SessionIdentity,
    pub source: Source,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Commit {
    pub binding: Binding,
    pub operation: Uuid,
    pub fingerprint: String,
    pub expected_revision: Option<Revision>,
    pub manifest: ObjectRef,
}
impl Commit {
    pub(crate) fn key(&self) -> Result<String, StoreError> {
        self.binding.source.validate()?;
        if self.binding.identity.session.is_nil()
            || self.binding.identity.agent.is_nil()
            || self.operation.is_nil()
            || !valid_digest(&self.fingerprint)
            || !valid_digest(&self.manifest.digest)
            || self.manifest.bytes == 0
            || self.expected_revision.is_some_and(|r| r.0.is_nil())
        {
            return Err(invalid("invalid repository commit"));
        }
        Ok(super::digest(&serde_json::to_vec(&(
            &self.binding.source,
            self.operation,
        ))?))
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CommitReceipt {
    Published { head: Head },
    Conflict { actual: Option<Revision> },
}

/// Blocking streaming I/O, called only on a physical worker. A successful put
/// owns durable independent bytes; read returns verified, rewound material.
/// Implementations must retain published objects (no concurrent GC in this contract).
pub trait ImmutableObjectStore: Send + Sync {
    fn identity(&self) -> &str;
    /// Physical storage, when local, must not be recursively captured as Workspace.
    fn local_directory(&self) -> Option<&std::path::Path> {
        None
    }
    fn put(&self, source: &mut dyn Read) -> Result<ObjectRef, StoreError>;
    fn read(&self, object: &ObjectRef) -> Result<File, StoreError>;
}

/// Constructed by full dependency verification, never by deserializing a caller flag.
pub struct VerifiedCheckpoint {
    object_store: String,
    reference: ObjectRef,
    manifest: Manifest,
}
impl VerifiedCheckpoint {
    pub fn verify(
        objects: &dyn ImmutableObjectStore,
        reference: ObjectRef,
    ) -> Result<Self, StoreError> {
        Self::read_verified(objects, reference).map(|(verified, _)| verified)
    }
    fn read_verified(
        objects: &dyn ImmutableObjectStore,
        reference: ObjectRef,
    ) -> Result<(Self, File), StoreError> {
        let manifest: Manifest = serde_json::from_reader(objects.read(&reference)?)?;
        Source {
            root_id: manifest.root_id.clone(),
            scope: manifest.scope.clone(),
            session: manifest.session_id.clone(),
        }
        .validate()?;
        if manifest.history.object.bytes == 0 {
            return Err(invalid("checkpoint history is empty"));
        }
        let snapshot = objects.read(&manifest.history.object)?;
        if let Some(workspace) = &manifest.workspace {
            for entry in super::workspace::read_inventory(objects.read(&workspace.inventory)?)? {
                if let super::WorkspaceEntry::File { object, .. } = entry {
                    objects.read(&object)?;
                }
            }
        }
        Ok((
            Self::captured(objects.identity(), reference, manifest),
            snapshot,
        ))
    }
    // Only the Root capture pipeline can attest newly written, durable local material.
    // Recovery and external reads must go through full verification instead.
    pub(crate) fn captured(object_store: &str, reference: ObjectRef, manifest: Manifest) -> Self {
        Self {
            object_store: object_store.into(),
            reference,
            manifest,
        }
    }
    fn validate_source(&self, source: &Source) -> Result<(), StoreError> {
        if self.manifest.root_id != source.root_id
            || self.manifest.scope != source.scope
            || self.manifest.session_id != source.session
        {
            return Err(invalid("checkpoint belongs to another source"));
        }
        Ok(())
    }
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    pub fn validate(&self, object_store: &str, request: &Commit) -> Result<(), StoreError> {
        request.key()?;
        self.validate_source(&request.binding.source)?;
        if self.object_store != object_store || self.reference != request.manifest {
            return Err(invalid(
                "checkpoint belongs to another source or object store",
            ));
        }
        Ok(())
    }
}

/// A Head and its immutable provenance, read together from the same authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundHead {
    pub binding: Binding,
    pub head: Head,
}

/// Head and its original commit receipt are one atomic authority. A conflict is
/// terminal for that operation. No lease/Activation policy lives in this port.
pub trait SessionRepository: Send + Sync {
    fn identity(&self) -> &str;
    fn object_store_identity(&self) -> &str;
    fn lookup(
        &self,
        source: Source,
        agent: Uuid,
    ) -> BoxFuture<'_, Result<Option<Binding>, StoreError>>;
    fn bind(&self, source: Source, agent: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>>;
    fn read_head(
        &self,
        identity: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<BoundHead>, StoreError>>;
    fn receipt(&self, request: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>>;
    fn commit(
        &self,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>>;
}

/// Trusted assembly chooses one pair before Root recovery/admission starts.
#[derive(Clone)]
pub struct Storage {
    pub(crate) objects: Arc<dyn ImmutableObjectStore>,
    pub(crate) sessions: Arc<dyn SessionRepository>,
    pub(crate) agent: Uuid,
    pub(crate) execution: Option<super::execution::Execution>,
}
impl Storage {
    pub fn new(
        objects: Arc<dyn ImmutableObjectStore>,
        sessions: Arc<dyn SessionRepository>,
        agent: Uuid,
    ) -> Result<Self, StoreError> {
        if agent.is_nil()
            || objects.identity().is_empty()
            || sessions.identity().is_empty()
            || objects.identity() != sessions.object_store_identity()
        {
            return Err(invalid(
                "checkpoint repository/object-store binding differs",
            ));
        }
        Ok(Self {
            objects,
            sessions,
            agent,
            execution: None,
        })
    }

    /// Read the retained logical Session without opening its source Root. The
    /// repository capability must already be authorized by trusted assembly.
    pub async fn checkout_exact(
        &self,
        identity: SessionIdentity,
        revision: Revision,
    ) -> Result<super::Checkout, StoreError> {
        if identity.agent != self.agent {
            return Err(invalid("checkpoint agent binding differs"));
        }
        let head = self
            .sessions
            .read_head(identity.clone())
            .await?
            .filter(|h| h.head.revision == revision)
            .ok_or_else(|| invalid("checkpoint revision unavailable"))?;
        if head.binding.identity != identity {
            return Err(invalid("checkpoint logical Session binding differs"));
        }
        let source = head.binding.source.clone();
        let objects = self.objects.clone();
        let reference = head.head.manifest.clone();
        let (manifest, snapshot) = tokio::task::spawn_blocking(move || {
            let (verified, snapshot) =
                VerifiedCheckpoint::read_verified(objects.as_ref(), reference)?;
            verified.validate_source(&source)?;
            Ok::<_, StoreError>((verified.manifest, snapshot))
        })
        .await
        .map_err(|_| StoreError::OperationUnknown)??;
        if self.sessions.read_head(identity).await?.as_ref() != Some(&head) {
            return Err(invalid("checkpoint revision unavailable"));
        }
        Ok(super::Checkout {
            head: head.head,
            manifest,
            snapshot,
        })
    }
}
