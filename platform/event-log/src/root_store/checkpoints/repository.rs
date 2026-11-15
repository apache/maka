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
use crate::checkpoints::repository::{
    Binding, Commit, CommitReceipt, SessionIdentity, SessionRepository, Source, Storage,
    VerifiedCheckpoint, sql,
};
use crate::connection::BoxFuture;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Configuration {
    Local {
        agent: Uuid,
    },
    Shared {
        repository: String,
        objects: String,
        agent: Uuid,
    },
}
impl Configuration {
    fn agent(&self) -> Uuid {
        match self {
            Self::Local { agent } | Self::Shared { agent, .. } => *agent,
        }
    }
}
pub(in crate::root_store) async fn configure(
    log: &EventLog,
    storage: Option<&Storage>,
) -> Result<Uuid, StoreError> {
    let expected = storage.map(|s| Configuration::Shared {
        repository: s.sessions.identity().into(),
        objects: s.objects.identity().into(),
        agent: s.agent,
    });
    log.connection.run(move |db| {
        let tx = db.unchecked_transaction()?;
        let current: Option<String> = tx.query_row("SELECT configuration_json FROM checkpoint_repository_settings WHERE singleton=1", [], |r|r.get(0)).optional()?;
        let configuration = match current {
            Some(json) => {
                let current: Configuration = serde_json::from_str(&json)?;
                let same = match &expected {
                    Some(expected) => *expected == current,
                    None => matches!(current, Configuration::Local { .. }),
                };
                if !same { return Err(invalid("Root requires its original checkpoint repository; explicit migration required")); }
                current
            }
            None => {
                if expected.is_some() {
                    let local: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM history_checkpoint_publications) OR EXISTS(SELECT 1 FROM history_checkpoint_heads)", [], |r|r.get(0))?;
                    if local { return Err(invalid("existing local checkpoints require explicit repository migration")); }
                }
                let configuration = expected.unwrap_or_else(|| Configuration::Local { agent: Uuid::new_v4() });
                tx.execute("INSERT INTO checkpoint_repository_settings VALUES(1,?)", [serde_json::to_string(&configuration)?])?;
                configuration
            }
        };
        tx.commit().map_err(StoreError::CommitUnknown)?;
        Ok(configuration.agent())
    }).await
}

struct Local {
    log: EventLog,
    identity: String,
}
impl SessionRepository for Local {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn object_store_identity(&self) -> &str {
        &self.identity
    }
    fn lookup(
        &self,
        source: Source,
        agent: Uuid,
    ) -> BoxFuture<'_, Result<Option<Binding>, StoreError>> {
        Box::pin(
            self.log
                .connection
                .read(move |db| sql::lookup(db, &source, agent)),
        )
    }
    fn bind(&self, source: Source, agent: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>> {
        Box::pin(
            self.log
                .connection
                .run(move |db| sql::bind(db, &source, agent, sql::Layout::Local)),
        )
    }
    fn read_head(
        &self,
        identity: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<Head>, StoreError>> {
        Box::pin(
            self.log
                .connection
                .read(move |db| sql::head(db, &identity, sql::Layout::Local)),
        )
    }
    fn receipt(&self, request: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        Box::pin(
            self.log
                .connection
                .read(move |db| sql::receipt(db, &request)),
        )
    }
    fn commit(
        &self,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        let identity = self.identity.clone();
        Box::pin(self.log.connection.run(move |db| {
            verified.validate(&identity, &request)?;
            sql::commit(db, &request, sql::Layout::Local)
        }))
    }
}
fn backend(log: &EventLog) -> Result<Arc<dyn SessionRepository>, StoreError> {
    if let Some(storage) = &log.checkpoint_storage {
        return Ok(storage.sessions.clone());
    }
    let root = log.owned_root()?;
    Ok(Arc::new(Local {
        log: log.scoped(root.clone()),
        identity: root.root_id().into(),
    }))
}
fn source(log: &EventLog, scope: Scope, session: String) -> Result<Source, StoreError> {
    let source = Source {
        root_id: log.owned_root()?.root_id().into(),
        scope,
        session,
    };
    source.validate()?;
    Ok(source)
}
fn validate_scope(db: &Connection, scope: &Scope, session: &str) -> Result<(), StoreError> {
    let bound: Option<String> = db
        .query_row(
            "SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(bound) = bound
        && serde_json::from_str::<Scope>(&bound)? != *scope
    {
        return Err(invalid("checkpoint local scope differs"));
    }
    Ok(())
}
pub(super) async fn binding(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Binding, StoreError> {
    let source = source(log, scope.clone(), session.clone())?;
    if log.checkpoint_storage.is_some() {
        // Reserve the same local provenance as publication before registering it remotely.
        log.connection.run(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            validate_scope(&tx, &scope, &session)?;
            tx.execute(
                "INSERT INTO history_checkpoint_bindings VALUES(?,?) ON CONFLICT(session_id) DO NOTHING",
                params![session, serde_json::to_string(&scope)?],
            )?;
            tx.commit().map_err(StoreError::CommitUnknown)
        }).await?;
    }
    backend(log)?.bind(source, log.checkpoint_agent).await
}
pub(super) async fn head(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Option<Head>, StoreError> {
    let source = source(log, scope.clone(), session.clone())?;
    let local = log.checkpoint_storage.is_none();
    let legacy = log
        .connection
        .read(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
            validate_scope(&tx, &scope, &session)?;
            let head: Option<String> = if local {
                tx.query_row(
                    "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
                    [session],
                    |r| r.get(0),
                )
                .optional()?
            } else {
                None
            };
            head.map(|json| serde_json::from_str(&json).map_err(StoreError::from))
                .transpose()
        })
        .await?;
    let repository = backend(log)?;
    match repository.lookup(source, log.checkpoint_agent).await? {
        Some(binding) => repository.read_head(binding.identity).await,
        // Existing local Heads predate logical bindings. Reading them must not claim a scope.
        None => Ok(legacy),
    }
}
fn commit_request(
    binding: Binding,
    request: &Request,
    manifest: ObjectRef,
) -> Result<Commit, StoreError> {
    Ok(Commit {
        binding,
        operation: request.publication.operation,
        fingerprint: crate::checkpoints::digest(&serde_json::to_vec(request)?),
        expected_revision: request.publication.expected_revision,
        manifest,
    })
}
pub(super) async fn receipt(
    log: &EventLog,
    request: &Request,
    manifest: ObjectRef,
) -> Result<Option<CommitReceipt>, StoreError> {
    let repository = backend(log)?;
    let source = source(log, request.scope.clone(), request.session_id.clone())?;
    let Some(binding) = repository.lookup(source, log.checkpoint_agent).await? else {
        return Ok(None);
    };
    repository
        .receipt(commit_request(binding, request, manifest)?)
        .await
}

pub(super) async fn commit(
    log: &EventLog,
    objects: &Objects,
    request: &Request,
    manifest: ObjectRef,
) -> Result<Publication, StoreError> {
    let binding = binding(log, request.scope.clone(), request.session_id.clone()).await?;
    let request_commit = commit_request(binding, request, manifest.clone())?;
    let repository = backend(log)?;
    let receipt = match repository.receipt(request_commit.clone()).await? {
        Some(receipt) => receipt,
        None => {
            let verified =
                match VerifiedCheckpoint::verify(objects.storage.as_ref(), manifest.clone()) {
                    Ok(verified) => verified,
                    Err(error) if unavailable(&error) => {
                        return journal::unavailable(
                            log,
                            request.clone(),
                            manifest,
                            error.to_string(),
                        )
                        .await;
                    }
                    Err(error) => return Err(error),
                };
            if verified.manifest().history != request.publication.history {
                return journal::unavailable(
                    log,
                    request.clone(),
                    manifest,
                    "checkpoint history differs from its original request".into(),
                )
                .await;
            }
            repository.commit(request_commit, verified).await?
        }
    };
    journal::record_commit(log, request.clone(), manifest, receipt).await
}

// An outage is not evidence that immutable material is invalid: retain Prepared for retry.
fn unavailable(error: &StoreError) -> bool {
    match error {
        StoreError::InvalidTransition(_) => true,
        StoreError::Json(error) => !error.is_io(),
        StoreError::Io(error) => error.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

impl HistoryCheckpoints {
    /// Stable logical identity, distinct from the source Root/native Session.
    pub async fn binding(&self) -> Result<Binding, StoreError> {
        binding(
            &self.session.scoped().await?,
            self.scope.clone(),
            self.session.id().into(),
        )
        .await
    }
    pub(super) fn require_local_restore(&self) -> Result<(), StoreError> {
        if self.session.owner()?.checkpoint_storage.is_some() {
            return Err(invalid(
                "shared checkpoint loading/activation requires an explicit cross-Root authority handoff",
            ));
        }
        Ok(())
    }
}
