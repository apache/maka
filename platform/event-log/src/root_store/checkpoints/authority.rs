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

use super::local::Local;
use super::*;
use crate::checkpoints::repository::{
    Binding, Commit, CommitReceipt, SessionRepository, Source, Storage, VerifiedCheckpoint,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) enum Authority {
    Local { agent: Uuid },
    Shared(Storage),
}
impl Authority {
    fn agent(&self) -> Uuid {
        match self {
            Self::Local { agent } => *agent,
            Self::Shared(storage) => storage.agent,
        }
    }
    pub(crate) fn storage(&self) -> Option<&Storage> {
        match self {
            Self::Local { .. } => None,
            Self::Shared(storage) => Some(storage),
        }
    }
}
fn authority(log: &EventLog) -> Result<&Authority, StoreError> {
    log.checkpoint
        .as_ref()
        .ok_or_else(|| invalid("checkpoint authority is not configured"))
}

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
    Executing {
        repository: String,
        objects: String,
        grant: Box<crate::checkpoints::execution::Grant>,
    },
}
impl Configuration {
    fn agent(&self) -> Uuid {
        match self {
            Self::Local { agent } | Self::Shared { agent, .. } => *agent,
            Self::Executing { grant, .. } => grant.binding.identity.agent,
        }
    }
}
pub(in crate::root_store) async fn configure(
    log: &EventLog,
    storage: Option<Storage>,
) -> Result<Authority, StoreError> {
    if let Some(execution) = storage.as_ref().and_then(|s| s.execution.as_ref()) {
        if execution.grant().binding.source.root_id != log.owned_root()?.root_id() {
            return Err(invalid("execution grant belongs to another Root"));
        }
        execution.check().await?;
    }
    let expected = storage.as_ref().map(|s| match &s.execution {
        Some(execution) => Configuration::Executing {
            repository: s.sessions.identity().into(),
            objects: s.objects.identity().into(),
            grant: Box::new(execution.grant().clone()),
        },
        None => Configuration::Shared {
            repository: s.sessions.identity().into(),
            objects: s.objects.identity().into(),
            agent: s.agent,
        },
    });
    let agent = log.connection.run(move |db| {
        let tx = db.unchecked_transaction()?;
        let current: Option<String> = tx.query_row("SELECT configuration_json FROM checkpoint_repository_settings WHERE singleton=1", [], |r|r.get(0)).optional()?;
        let configuration = match current {
            Some(json) => {
                let current: Configuration = serde_json::from_str(&json)?;
                let replacement = match (&current, expected) {
                    (Configuration::Local { .. }, None) => None,
                    (_, Some(expected)) if expected == current => None,
                    (Configuration::Local { .. }, Some(next @ Configuration::Executing { .. })) => {
                        let occupied: bool = tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM checkpoint_repository_sessions) OR EXISTS(SELECT 1 FROM history_checkpoint_publications) OR EXISTS(SELECT 1 FROM history_checkpoint_heads)",
                            [], |r| r.get(0),
                        )?;
                        if occupied {
                            return Err(invalid("existing local checkpoints require explicit repository migration"));
                        }
                        Some(next)
                    }
                    (Configuration::Shared { repository, objects, agent },
                        Some(Configuration::Executing { repository: next_repository, objects: next_objects, grant }))
                        if *repository == next_repository && *objects == next_objects && *agent == grant.binding.identity.agent => {
                            Some(Configuration::Executing { repository: next_repository, objects: next_objects, grant })
                        }
                    _ => return Err(invalid("Root requires its original checkpoint repository/execution; explicit migration required")),
                };
                match replacement {
                    Some(next) => {
                        let pending: bool = tx.query_row(
                            "SELECT EXISTS(SELECT 1 FROM history_checkpoint_publications WHERE json_extract(publication_json,'$.state.kind') IN ('capturing','prepared'))",
                            [], |r| r.get(0),
                        )?;
                        if pending { return Err(invalid("pending checkpoint requires its original authority")); }
                        tx.execute("UPDATE checkpoint_repository_settings SET configuration_json=? WHERE singleton=1", [serde_json::to_string(&next)?])?;
                        next
                    }
                    None => current,
                }
            }
            None => {
                if expected.is_some() {
                    let local: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM history_checkpoint_publications) OR EXISTS(SELECT 1 FROM history_checkpoint_heads)", [], |r|r.get(0))?;
                    if local { return Err(invalid("existing local checkpoints require explicit repository migration")); }
                }
                let configuration = expected.unwrap_or_else(|| Configuration::Local { agent: Uuid::new_v4() });
                tx.execute("INSERT INTO checkpoint_repository_settings (singleton,configuration_json) VALUES(1,?)", [serde_json::to_string(&configuration)?])?;
                configuration
            }
        };
        tx.commit().map_err(StoreError::CommitUnknown)?;
        Ok(configuration.agent())
    }).await?;
    Ok(match storage {
        Some(storage) => Authority::Shared(storage),
        None => Authority::Local { agent },
    })
}

fn backend(log: &EventLog) -> Result<Arc<dyn SessionRepository>, StoreError> {
    if let Some(storage) = authority(log)?.storage() {
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
pub(super) async fn binding(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Binding, StoreError> {
    let source = source(log, scope.clone(), session.clone())?;
    if authority(log)?.storage().is_some() {
        // Reserve the same local provenance as publication before registering it remotely.
        log.connection
            .run(move |db| super::local::reserve_source(db, &scope, &session))
            .await?;
    }
    backend(log)?.bind(source, authority(log)?.agent()).await
}
pub(super) async fn head(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Option<Head>, StoreError> {
    let source = source(log, scope.clone(), session.clone())?;
    let local = authority(log)?.storage().is_none();
    let legacy = log
        .connection
        .read(move |db| super::local::legacy_head(db, &scope, &session, local))
        .await?;
    let repository = backend(log)?;
    match repository.lookup(source, authority(log)?.agent()).await? {
        Some(binding) => {
            let bound = repository.read_head(binding.identity.clone()).await?;
            if bound.as_ref().is_some_and(|bound| bound.binding != binding) {
                return Err(invalid("checkpoint logical Session binding differs"));
            }
            Ok(bound.map(|bound| bound.head))
        }
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
    let Some(binding) = repository.lookup(source, authority(log)?.agent()).await? else {
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
    captured: Option<VerifiedCheckpoint>,
) -> Result<Publication, StoreError> {
    let binding = binding(log, request.scope.clone(), request.session_id.clone()).await?;
    let request_commit = commit_request(binding, request, manifest.clone())?;
    let repository = backend(log)?;
    let receipt = match repository.receipt(request_commit.clone()).await? {
        Some(receipt) => receipt,
        None => {
            let verified = match captured {
                Some(verified) => verified,
                None => match VerifiedCheckpoint::verify(objects.storage(), manifest.clone()) {
                    Ok(verified) => verified,
                    Err(error) if is_permanent_material_error(&error) => {
                        return journal::unavailable(
                            log,
                            request.clone(),
                            manifest,
                            error.to_string(),
                        )
                        .await;
                    }
                    Err(error) => return Err(error),
                },
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
fn is_permanent_material_error(error: &StoreError) -> bool {
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
        if authority(self.session.owner()?.as_ref())?
            .storage()
            .is_some()
        {
            return Err(invalid(
                "shared checkpoint loading/activation requires an explicit cross-Root authority handoff",
            ));
        }
        Ok(())
    }
}
