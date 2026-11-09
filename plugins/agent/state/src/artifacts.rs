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

//! Agent-owned immutable material on the original Root. Tool metadata is
//! canonical only in ToolReturn; pre-Run uploads/copies have their own session
//! registration. None of these read scopes is an execution or permission grant.
use crate::store::invalid;
use maka_agent_facts::{
    artifact::{Artifact, PublishedArtifact},
    durable::*,
};
use maka_event_log::{
    StoreError,
    root_store::{DataChange, DataWriter},
};
use serde::{Deserialize, Serialize};
use std::{io::Read, sync::Arc};

mod cell;
mod input;
mod read;
mod session;
mod tool;
pub(crate) use input::{admit, pin_request};
pub(crate) use tool::{ArtifactBatch, append, rebuild};

pub const COPY_REJECTED: &str = "canonical_copy_rejected";

/// Trusted native readers supply the exact original producer and captured cut.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactScope {
    pub owner: RunOwner,
    pub session: String,
    pub run: RunId,
    pub through: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionScope {
    pub owner: RunOwner,
    pub session: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtifactReadScope {
    Run { scope: ArtifactScope },
    Session { scope: SessionScope },
}
impl From<ArtifactScope> for ArtifactReadScope {
    fn from(scope: ArtifactScope) -> Self {
        Self::Run { scope }
    }
}
impl From<SessionScope> for ArtifactReadScope {
    fn from(scope: SessionScope) -> Self {
        Self::Session { scope }
    }
}
impl ArtifactReadScope {
    fn session(&self) -> &str {
        match self {
            Self::Run { scope } => &scope.session,
            Self::Session { scope } => &scope.session,
        }
    }
    fn owner(&self) -> &RunOwner {
        match self {
            Self::Run { scope } => &scope.owner,
            Self::Session { scope } => &scope.owner,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ArtifactChunk {
    pub record: PublishedArtifact,
    pub total_bytes: u64,
    pub bytes: Vec<u8>,
}

/// A source proven by an authorized native read. Not serializable, not a bearer
/// permission: copying rechecks its exact original canonical registration.
#[derive(Clone)]
pub struct CopySource {
    proof: SourceProof,
    record: PublishedArtifact,
    root: DataWriter,
}
impl CopySource {
    pub fn record(&self) -> &PublishedArtifact {
        &self.record
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SourceProof {
    Session {
        scope: SessionScope,
        id: String,
        registration: ContentRef,
    },
    Run {
        scope: ArtifactScope,
        id: String,
        result: ContentRef,
    },
}

/// Retain this exact command across uncertain acknowledgements. Bytes share the
/// immutable input allocation; preparation hashes them off the async executor.
#[derive(Clone)]
pub struct Upload {
    scope: SessionScope,
    operation: String,
    logical_id: String,
    artifact: Artifact,
    bytes: Arc<Vec<u8>>,
}
impl Upload {
    pub fn new(
        scope: SessionScope,
        operation: String,
        logical_id: String,
        artifact: Artifact,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            scope,
            operation,
            logical_id,
            artifact,
            bytes: Arc::new(bytes),
        }
    }
    pub fn artifact(&self) -> &Artifact {
        &self.artifact
    }
}
/// Session-owned derived material such as an inspected workspace patch. The
/// native producer supplies its exact immutable provenance, not a live grant.
#[derive(Clone)]
pub struct SessionArtifactWrite {
    scope: SessionScope,
    operation: String,
    artifact: Artifact,
    bytes: Arc<Vec<u8>>,
    provenance: crate::ContentBlob,
}
impl SessionArtifactWrite {
    pub fn new(
        scope: SessionScope,
        operation: String,
        artifact: Artifact,
        bytes: Vec<u8>,
        provenance: crate::ContentBlob,
    ) -> Self {
        Self {
            scope,
            operation,
            artifact,
            bytes: Arc::new(bytes),
            provenance,
        }
    }
    pub fn artifact(&self) -> &Artifact {
        &self.artifact
    }
}
#[derive(Clone)]
pub struct CopyArtifact {
    source: CopySource,
    destination: SessionScope,
    operation: String,
    artifact: Artifact,
}
impl CopyArtifact {
    /// Native has authorized source reads and destination writes before preparing
    /// this command; no current workspace or latest binding is consulted here.
    pub fn new(
        source: CopySource,
        destination: SessionScope,
        operation: String,
        created_at: u64,
    ) -> Self {
        let mut artifact = source.record.artifact.clone();
        artifact.id = copy_id(&destination.session, &operation);
        artifact.session_id = destination.session.clone();
        artifact.turn_id = artifact.id.clone();
        artifact.created_at = created_at;
        Self {
            source,
            destination,
            operation,
            artifact,
        }
    }
    pub fn artifact(&self) -> &Artifact {
        &self.artifact
    }
}
pub fn copy_id(session: &str, operation: &str) -> String {
    let identity = serde_json::to_vec(&(session, operation)).expect("string identity serializes");
    format!(
        "attachment-copy-{}",
        &maka_agent_facts::artifact::content_digest(&identity)[7..39]
    )
}

#[derive(Clone)]
pub struct ArtifactStore {
    data: DataWriter,
}
impl ArtifactStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
    pub async fn get(
        &self,
        scope: impl Into<ArtifactReadScope>,
        id: String,
    ) -> Result<Option<PublishedArtifact>, StoreError> {
        self.data
            .query(read::Get {
                scope: scope.into(),
                id,
            })
            .await
    }
    /// Metadata selection only; it does not broaden a byte reader's source scope.
    pub async fn resolve(
        &self,
        scope: SessionScope,
        id_or_prefix: String,
    ) -> Result<Option<Artifact>, StoreError> {
        self.data
            .query(read::Resolve {
                scope,
                id_or_prefix,
            })
            .await
    }
    pub async fn chunk(
        &self,
        scope: impl Into<ArtifactReadScope>,
        id: String,
        offset: u64,
        limit: u32,
    ) -> Result<Option<ArtifactChunk>, StoreError> {
        self.data
            .query(read::Chunk {
                scope: scope.into(),
                id,
                offset,
                limit,
            })
            .await
    }
    /// The callback runs in the Root's existing blocking read lane and one read
    /// transaction. The SQLite BLOB is closed before this query completes.
    pub async fn with_content<T: Send + 'static>(
        &self,
        scope: impl Into<ArtifactReadScope>,
        id: String,
        read: impl FnOnce(&Artifact, &mut dyn Read) -> T + Send + 'static,
    ) -> Result<Option<T>, StoreError> {
        self.data
            .query(read::WithContent {
                scope: scope.into(),
                id,
                read,
            })
            .await
    }
    /// Reads original Produced provenance, including the frozen closure of copies,
    /// never a summary, live source session or current workspace. Uploads and
    /// copies without Produced provenance return `None`.
    /// The callback shares the Root's blocking read transaction and BLOB lifetime.
    pub async fn with_provenance<T: Send + 'static>(
        &self,
        scope: SessionScope,
        id: String,
        read: impl FnOnce(&Artifact, &mut dyn Read) -> T + Send + 'static,
    ) -> Result<Option<T>, StoreError> {
        self.data
            .query(read::WithProvenance { scope, id, read })
            .await
    }
    pub async fn copy_source(
        &self,
        scope: impl Into<ArtifactReadScope>,
        id: String,
    ) -> Result<Option<CopySource>, StoreError> {
        self.data
            .query(read::Source {
                scope: scope.into(),
                id,
                root: self.data.clone(),
            })
            .await
    }
    pub async fn upload(&self, upload: Upload) -> Result<PublishedArtifact, StoreError> {
        self.data.write(session::Write::upload(upload)).await
    }
    pub fn prepare_upload(&self, upload: Upload) -> DataChange {
        self.data.prepare(session::Write::upload(upload))
    }
    pub async fn register(
        &self,
        write: SessionArtifactWrite,
    ) -> Result<PublishedArtifact, StoreError> {
        self.data.write(session::Write::produced(write)).await
    }
    pub fn prepare_register(&self, write: SessionArtifactWrite) -> DataChange {
        self.data.prepare(session::Write::produced(write))
    }
    pub async fn copy(&self, copy: CopyArtifact) -> Result<PublishedArtifact, StoreError> {
        if !self.data.same_root(&copy.source.root) {
            return Err(invalid("artifact copy source belongs to another Root"));
        }
        self.data.write(session::Write::copy(copy)).await
    }
    pub fn prepare_copy(&self, copy: CopyArtifact) -> Result<DataChange, StoreError> {
        if !self.data.same_root(&copy.source.root) {
            return Err(invalid("artifact copy source belongs to another Root"));
        }
        Ok(self.data.prepare(session::Write::copy(copy)))
    }
    pub(crate) fn copy_statement(
        &self,
        copy: CopyArtifact,
        selected_writer: &DataWriter,
    ) -> impl maka_event_log::writeback::Statement<
        Value = PublishedArtifact,
        Output = PublishedArtifact,
    > + Clone
    + use<> {
        session::LocalCopy {
            copy,
            store: self.data.clone(),
            writer: selected_writer.clone(),
        }
    }
    pub async fn rebuild_session(&self, scope: SessionScope) -> Result<(), StoreError> {
        self.data.write(session::Rebuild(scope)).await
    }
}

fn identity(value: &str) -> Result<(), StoreError> {
    maka_agent_facts::interaction::entity_id(value).map_err(invalid)
}
fn validate_record(record: &PublishedArtifact) -> Result<(), StoreError> {
    record.artifact.validate().map_err(invalid)?;
    record.payload.validate().map_err(invalid)?;
    if record.artifact.size_bytes != record.payload.bytes {
        return Err(invalid("artifact metadata/payload length differs"));
    }
    Ok(())
}

fn to_sql_integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("artifact integer exceeds SQLite range"))
}
fn from_sql_integer(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("artifact SQL integer is negative"))
}
