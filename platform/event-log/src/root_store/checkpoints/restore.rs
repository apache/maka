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

//! Physical workspace recovery and atomic metadata rebinding, not history admission.
use super::*;
use crate::checkpoints::{PreparedRestore, RestoreOperation, RestoredSession};
use crate::writeback::{Notification, Prepared, Statement};
use maka_sandbox::workspace::DirectoryIdentity;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestIdentity {
    scope: Scope,
    session: String,
    operation: RestoreOperation,
}
impl RequestIdentity {
    fn key(&self) -> Result<String, StoreError> {
        if !crate::checkpoints::valid_digest(&self.operation.fingerprint)
            || !self.operation.parent.is_absolute()
        {
            return Err(invalid("invalid checkpoint restore request"));
        }
        crate::checkpoints::load_key(&self.scope, &self.session, self.operation.operation)
    }
}
struct Preparation {
    prepared: PreparedRestore,
    directory_identity: Option<DirectoryIdentity>,
    result: Option<RestoredSession>,
}
impl Preparation {
    fn directory_identity(&self) -> Result<&DirectoryIdentity, StoreError> {
        self.directory_identity
            .as_ref()
            .ok_or_else(|| invalid("checkpoint restore directory preparation incomplete"))
    }
}
async fn prior(
    log: &EventLog,
    request: &RequestIdentity,
) -> Result<Option<Preparation>, StoreError> {
    let key = request.key()?;
    let expected = serde_json::to_string(request)?;
    log.connection.read(move |db| {
        let row: Option<(String, String, Option<String>, Option<String>)> = db.query_row("SELECT request_json,prepared_json,directory_identity_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?", rusqlite::params![key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,))).optional()?;
        row.map(|(original, prepared, directory_identity, result)| {
            if original != expected { return Err(invalid("checkpoint restore identity conflict")); }
            Ok(Preparation {
                prepared: serde_json::from_str(&prepared)?,
                directory_identity: directory_identity.map(|v|serde_json::from_str(&v)).transpose()?,
                result: result.map(|r|serde_json::from_str(&r)).transpose()?,
            })
        }).transpose()
    }).await
}

pub(crate) struct Commit {
    key: String,
    request: RequestIdentity,
    prepared: PreparedRestore,
    directory_identity: DirectoryIdentity,
}
impl Commit {
    pub(crate) fn validate(&self, db: &Connection) -> Result<(), StoreError> {
        let current: Option<String> = db
            .query_row(
                "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
                rusqlite::params![&self.request.session],
                |row| row.get(0),
            )
            .optional()?;
        if current
            .as_deref()
            .map(serde_json::from_str::<Head>)
            .transpose()?
            .as_ref()
            != Some(&self.prepared.head)
        {
            return Err(invalid("checkpoint restore head moved"));
        }
        let archived: bool = db
            .query_row(
                "SELECT archived FROM session_control WHERE id=?",
                rusqlite::params![&self.request.session],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::SessionNotFound)?;
        if archived {
            return Err(invalid("archived Session cannot be restored"));
        }
        let row: Option<(String, String, Option<String>, Option<String>)> = db.query_row("SELECT request_json,prepared_json,directory_identity_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?", rusqlite::params![&self.key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,))).optional()?;
        if row
            != Some((
                serde_json::to_string(&self.request)?,
                serde_json::to_string(&self.prepared)?,
                Some(serde_json::to_string(&self.directory_identity)?),
                None,
            ))
        {
            return Err(invalid("checkpoint restore claim changed"));
        }
        Ok(())
    }
    pub(crate) fn record(self, db: &Connection, revision: u64) -> Result<(), StoreError> {
        let result = RestoredSession {
            operation: self.request.operation.operation,
            session_id: self.request.session,
            session_revision: revision,
            prepared: self.prepared,
        };
        db.execute("UPDATE checkpoint_workspace_restores SET result_json=? WHERE restore_key=? AND result_json IS NULL", rusqlite::params![serde_json::to_string(&result)?, self.key])?;
        Ok(())
    }
}
impl HistoryCheckpoints {
    /// Verify physical preparation under its original custody, then retain the
    /// metadata/binding guards until the Host's shared completion has settled.
    pub async fn prepare_workspace_restore_change<T, F, S>(
        &self,
        operation: RestoreOperation,
        fence: &WorkspaceFence,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(RestoredSession, DataChange), StoreError>
    where
        T: Serialize + serde::de::DeserializeOwned + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        let owner = self.session.owner()?;
        if !writer.matches_owner(&owner.owned_root()?) {
            return Err(invalid("foreign Root data writer"));
        }
        fence.validate_owner(&owner.owned_root()?)?;
        let request = self.restore_identity(operation);
        request.key()?;
        let log = self
            .session
            .exclusive_metadata(true)
            .await?
            .scoped(Arc::new(fence.clone()));
        let fence = fence.clone();
        let writer = writer.clone();
        let gates = self.session.gates.clone();
        worker(log, gates.clone(), move |log, objects| async move {
            let preparation = prior(&log, &request)
                .await?
                .ok_or_else(|| invalid("checkpoint restore not prepared"))?;
            if let Some(result) = preparation.result {
                let metadata = RestoreMetadata::Committed {
                    key: request.key()?,
                    request: serde_json::to_string(&request)?,
                    result: serde_json::to_string(&result)?,
                };
                let change = writer.prepare(WorkspaceRestore {
                    metadata,
                    statement,
                    custody: Arc::new(log),
                });
                return Ok((result, change));
            }
            let directory_identity = preparation.directory_identity()?.clone();
            let prepared = preparation.prepared;
            verify_destination(
                &objects,
                &prepared,
                &request.operation,
                &directory_identity,
                &fence,
            )?;
            let record = log
                .get_session::<T>(&request.session)
                .await?
                .ok_or(StoreError::SessionNotFound)?;
            let mut normalized = serde_json::to_value(&record.configuration)?;
            crate::workspace_bindings::normalize(
                &mut normalized,
                record.workspace_binding.as_ref(),
            )?;
            let mut candidate: T = serde_json::from_value(normalized)?;
            update(&mut candidate)?;
            let configuration = serde_json::to_value(candidate)?;
            let reference = crate::workspace_bindings::attached(&configuration)?
                .ok_or_else(|| invalid("restore workspace binding missing"))?;
            let pin = gates.read([gates::Key::Binding(reference.id)]).await?;
            let binding = owner
                .workspace_binding::<Value>(reference.id)
                .await?
                .ok_or_else(|| invalid("restore binding missing"))?;
            if binding.workspace.get("path").and_then(Value::as_str) != prepared.path.to_str() {
                return Err(invalid("restore binding differs from prepared workspace"));
            }
            let revision = next_revision(record.revision)?;
            let result = RestoredSession {
                operation: request.operation.operation,
                session_id: request.session.clone(),
                session_revision: revision,
                prepared: prepared.clone(),
            };
            let metadata = RestoreMetadata::Prepared {
                commit: Commit {
                    key: request.key()?,
                    request,
                    prepared,
                    directory_identity,
                },
                expected: record.revision,
                configuration,
            };
            let change = writer.prepare(WorkspaceRestore {
                metadata,
                statement,
                custody: Arc::new(log.scoped(Arc::new(pin))),
            });
            Ok((result, change))
        })
        .await
    }

    fn restore_identity(&self, operation: RestoreOperation) -> RequestIdentity {
        RequestIdentity {
            scope: self.scope.clone(),
            session: self.session.id().into(),
            operation,
        }
    }
    pub async fn workspace_restore_receipt(
        &self,
        operation: uuid::Uuid,
        fingerprint: String,
        revision: Revision,
    ) -> Result<Option<RestoredSession>, StoreError> {
        let key = crate::checkpoints::load_key(&self.scope, self.session.id(), operation)?;
        let scope = self.scope.clone();
        let session = self.session.id().to_owned();
        self.session.scoped().await?.connection.read(move |db|{
            let row: Option<(String,Option<String>)> = db.query_row("SELECT request_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?", rusqlite::params![key], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
            row.map(|(request,result)| {
                let request: RequestIdentity = serde_json::from_str(&request)?;
                if request.scope != scope || request.session != session || request.operation.operation != operation || request.operation.fingerprint != fingerprint || request.operation.revision != revision { return Err(invalid("checkpoint restore identity conflict")); }
                result.map(|r|serde_json::from_str(&r).map_err(StoreError::from)).transpose()
            }).transpose().map(Option::flatten)
        }).await
    }
    /// The parent was selected by the trusted Host. Always creates a new child,
    /// never overwrites an existing project. Partial destinations fail closed.
    pub async fn prepare_workspace_restore(
        &self,
        operation: RestoreOperation,
        parent: &RootWorkspace,
    ) -> Result<(PreparedRestore, WorkspaceFence), StoreError> {
        let owner = self.session.owner()?.owned_root()?;
        parent.validate(&owner)?;
        let parent = parent.clone();
        let request = self.restore_identity(operation);
        request.key()?;
        let physical_fence = Arc::new(std::sync::OnceLock::<WorkspaceFence>::new());
        let log = self
            .session
            .exclusive_metadata(true)
            .await?
            .scoped(physical_fence.clone());
        let gates = self.session.gates.clone();
        worker(log, gates.clone(), move |log, objects| async move {
            let directory = parent.directory();
            if directory_identity(directory)? != request.operation.parent_identity {
                return Err(invalid("restore parent directory changed"));
            }
            workspace::validate_alias(directory, &request.operation.parent)?;
            let parent_path = request.operation.parent.canonicalize()?;
            workspace::validate_alias(directory, &parent_path)?;
            if parent_path.starts_with(objects.owner.canonical_path()) {
                return Err(invalid("restore destination overlaps private Root"));
            }
            let prior = prior(&log, &request).await?;
            let name = match &prior {
                Some(prior) => prior.prepared.path.file_name().ok_or_else(||invalid("restore destination missing"))?.to_owned(),
                None => std::ffi::OsString::from(format!("maka-restored-{}",request.key()?)),
            };
            let slot = super::super::workspace_fence::ChildSlot::reserve(
                &gates, &objects.owner, directory.try_clone()?, name.clone()
            )?;
            physical_fence.set(slot.fence()).map_err(|_| invalid("physical workspace fence already captured"))?;
            if let Some(prior) = prior {
                use cap_fs_ext::DirExt;
                slot.bind_existing(&gates, directory.open_dir_nofollow(&name)?)?;
                let fence = slot.fence();
                if prior.result.is_none() {
                    verify_destination(&objects, &prior.prepared, &request.operation, prior.directory_identity()?, &fence)?;
                }
                return Ok((prior.prepared, fence));
            }
            let (head, manifest) = selected_checkpoint(&log, &objects, &request.scope, &request.session, request.operation.revision).await?;
            let Manifest { workspace, history, .. } = manifest;
            let workspace = workspace.ok_or_else(|| invalid("checkpoint has no workspace"))?;
            let current = log.get_session::<Value>(&request.session).await?.ok_or(StoreError::SessionNotFound)?;
            if current.archived { return Err(invalid("archived Session cannot be restored")); }
            let prepared = PreparedRestore { head, history, workspace, path: parent_path.join(&name) };
            let key = request.key()?;
            let encoded = serde_json::to_string(&request)?;
            let data = serde_json::to_string(&prepared)?;
            let fence = slot.fence();
            let log = log.scoped(Arc::new(fence.clone()));
            log.connection.run(move |db| {
                db.execute("INSERT INTO checkpoint_workspace_restores(restore_key,request_json,prepared_json) VALUES(?,?,?)",rusqlite::params![key,encoded,data])?;
                Ok(())
            }).await?;
            // The slot remains reserved while the actual created directory is bound.
            // New Root admissions inspect both its parent/name and its bound inode.
            slot.create(&gates)?;
            let destination = fence.directory()?;
            let identity = directory_identity(destination)?;
            workspace::materialize_in(&objects, &prepared.workspace, destination)?;
            directory.open(".")?.sync_all()?;
            let key = request.key()?;
            let identity = serde_json::to_string(&identity)?;
            log.connection.run(move |db| {
                let changed = db.execute("UPDATE checkpoint_workspace_restores SET directory_identity_json=? WHERE restore_key=? AND directory_identity_json IS NULL AND result_json IS NULL",rusqlite::params![identity,key])?;
                if changed != 1 { return Err(invalid("checkpoint restore claim changed")); }
                Ok(())
            }).await?;
            Ok((prepared, fence))
        }).await
    }
    /// Configuration and the original restore receipt commit atomically. This
    /// rebinding never rewinds history or starts an invocation.
    pub async fn commit_workspace_restore<T, F>(
        &self,
        operation: RestoreOperation,
        fence: &WorkspaceFence,
        mut update: F,
    ) -> Result<RestoredSession, StoreError>
    where
        T: Serialize + serde::de::DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnMut(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        fence.validate_owner(&self.session.owner()?.owned_root()?)?;
        let request = self.restore_identity(operation);
        let log = self
            .session
            .exclusive_metadata(true)
            .await?
            .scoped(Arc::new(fence.clone()));
        let fence = fence.clone();
        let gates = self.session.gates.clone();
        let control = self
            .session
            .log
            .upgrade()
            .ok_or(StoreError::ConnectionClosed)?;
        worker(log, gates.clone(), move |log, objects| async move {
            let preparation = prior(&log, &request)
                .await?
                .ok_or_else(|| invalid("checkpoint restore not prepared"))?;
            if let Some(result) = preparation.result {
                return Ok(result);
            }
            let directory_identity = preparation.directory_identity()?.clone();
            let prepared = preparation.prepared;
            verify_destination(
                &objects,
                &prepared,
                &request.operation,
                &directory_identity,
                &fence,
            )?;
            loop {
                let record = log
                    .get_session::<T>(&request.session)
                    .await?
                    .ok_or(StoreError::SessionNotFound)?;
                let mut normalized = serde_json::to_value(&record.configuration)?;
                crate::workspace_bindings::normalize(
                    &mut normalized,
                    record.workspace_binding.as_ref(),
                )?;
                let mut candidate: T = serde_json::from_value(normalized)?;
                update(&mut candidate)?;
                let encoded = serde_json::to_value(&candidate)?;
                let reference = crate::workspace_bindings::attached(&encoded)?
                    .ok_or_else(|| invalid("restore workspace binding missing"))?;
                let pin = gates.read([gates::Key::Binding(reference.id)]).await?;
                let binding = control
                    .workspace_binding::<Value>(reference.id)
                    .await?
                    .ok_or_else(|| invalid("restore binding missing"))?;
                if binding.workspace.get("path").and_then(Value::as_str) != prepared.path.to_str() {
                    return Err(invalid("restore binding differs from prepared workspace"));
                }
                let key = request.key()?;
                let result = log
                    .scoped(Arc::new(pin))
                    .mutate_session_metadata::<T, _>(
                        &request.session,
                        record.revision,
                        true,
                        Some(Commit {
                            key,
                            request: request.clone(),
                            prepared: prepared.clone(),
                            directory_identity: directory_identity.clone(),
                        }),
                        move |value| {
                            *value = candidate;
                            Ok(())
                        },
                    )
                    .await?;
                match result {
                    crate::sessions::SessionMutation::Committed(_) => break,
                    crate::sessions::SessionMutation::RevisionConflict { .. } => continue,
                }
            }
            prior(&log, &request)
                .await?
                .and_then(|v| v.result)
                .ok_or_else(|| invalid("checkpoint restore receipt missing"))
        })
        .await
    }
}

fn next_revision(expected: u64) -> Result<u64, StoreError> {
    expected
        .checked_add(1)
        .filter(|revision| *revision <= 9_007_199_254_740_991)
        .ok_or_else(|| invalid("session metadata revision exhausted"))
}

enum RestoreMetadata {
    Prepared {
        commit: Commit,
        expected: u64,
        configuration: Value,
    },
    Committed {
        key: String,
        request: String,
        result: String,
    },
}
impl RestoreMetadata {
    fn execute(self, db: &Connection) -> Result<(String, bool), StoreError> {
        match self {
            Self::Committed {
                key,
                request,
                result,
            } => {
                let current: Option<(String, Option<String>)> = db.query_row(
                    "SELECT request_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?",
                    rusqlite::params![key], |row| Ok((row.get(0)?, row.get(1)?)),
                ).optional()?;
                if current != Some((request.clone(), Some(result))) {
                    return Err(invalid("checkpoint restore receipt changed"));
                }
                Ok((
                    serde_json::from_str::<RequestIdentity>(&request)?.session,
                    false,
                ))
            }
            Self::Prepared {
                commit,
                expected,
                configuration,
            } => {
                let session = commit.request.session.clone();
                crate::sessions::removal::require_mutable(db, &session)?;
                commit.validate(db)?;
                if crate::workspace_bindings::current_session_revision(db, &session)?
                    != Some(expected)
                {
                    return Err(invalid("prepared Session metadata changed"));
                }
                crate::workspace_bindings::require_current_reference(db, &configuration)?;
                let revision = next_revision(expected)?;
                if db.execute(
                    "UPDATE session_control SET configuration=?,revision=? WHERE id=?",
                    rusqlite::params![
                        serde_json::to_string(&configuration)?,
                        revision as i64,
                        &session
                    ],
                )? != 1
                {
                    return Err(StoreError::SessionNotFound);
                }
                crate::sessions::advance_catalog(db)?;
                commit.record(db, revision)?;
                Ok((session, true))
            }
        }
    }
}

struct WorkspaceRestore<S> {
    metadata: RestoreMetadata,
    statement: S,
    custody: Arc<EventLog>,
}
impl<S: Statement> Statement for WorkspaceRestore<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut inputs = self.statement.retain();
        inputs.push(self.custody.clone());
        inputs
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, db: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let (session, changed) = self.metadata.execute(db)?;
        let domain = self.statement.execute(db)?;
        Ok(Prepared {
            value: domain.value,
            changed: changed || domain.changed,
            notification: domain
                .notification
                .combine(Notification::METADATA.with_sessions([session])),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::InvalidTransition(_)
            )
    }
}

fn verify_destination(
    objects: &Objects,
    prepared: &PreparedRestore,
    operation: &RestoreOperation,
    identity: &DirectoryIdentity,
    fence: &WorkspaceFence,
) -> Result<(), StoreError> {
    use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::fs::{Dir, OpenOptions};
    use sha2::{Digest, Sha256};
    use std::io::Read;
    fence.validate_owner(&objects.owner)?;
    let (parent, name) = fence.child_parent()?;
    if directory_identity(parent)? != operation.parent_identity {
        return Err(invalid("restore parent directory changed"));
    }
    workspace::validate_alias(parent, &operation.parent)?;
    if prepared.path.file_name() != Some(name.as_os_str()) {
        return Err(invalid("restore destination differs from its child slot"));
    }
    let named = parent.open_dir_nofollow(name)?;
    let root = fence.directory()?;
    if directory_identity(&named)? != directory_identity(root)? {
        return Err(invalid(
            "restore destination no longer names its original directory",
        ));
    }
    if &directory_identity(root)? != identity {
        return Err(invalid("restore destination directory changed"));
    }
    let entries = workspace::inventory(objects, &prepared.workspace)?;
    let expected: std::collections::BTreeSet<_> = entries
        .iter()
        .map(|entry| match entry {
            crate::checkpoints::WorkspaceEntry::Directory { path }
            | crate::checkpoints::WorkspaceEntry::File { path, .. } => path.clone(),
        })
        .collect();
    fn paths(
        dir: &Dir,
        prefix: &str,
        expected: &std::collections::BTreeSet<String>,
        result: &mut std::collections::BTreeSet<String>,
    ) -> Result<(), StoreError> {
        for entry in dir.entries()? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("restored path invalid"))?;
            if prefix.is_empty() && name == ".maka-workspace.json" {
                continue;
            }
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if !expected.contains(&path) {
                return Err(invalid("restored workspace inventory changed"));
            }
            result.insert(path.clone());
            if entry.file_type()?.is_dir() {
                paths(&dir.open_dir_nofollow(&name)?, &path, expected, result)?;
            }
        }
        Ok(())
    }
    let mut actual = std::collections::BTreeSet::new();
    paths(root, "", &expected, &mut actual)?;
    if actual != expected {
        return Err(invalid("restored workspace inventory changed"));
    }
    for entry in entries {
        let path = match &entry {
            crate::checkpoints::WorkspaceEntry::Directory { path }
            | crate::checkpoints::WorkspaceEntry::File { path, .. } => path,
        };
        let mut parts = path.split('/').collect::<Vec<_>>();
        let name = parts.pop().unwrap();
        let mut parent = root.try_clone()?;
        for part in parts {
            parent = parent.open_dir_nofollow(part)?;
        }
        match &entry {
            crate::checkpoints::WorkspaceEntry::Directory { .. } => {
                parent.open_dir_nofollow(name)?;
            }
            crate::checkpoints::WorkspaceEntry::File {
                object, executable, ..
            } => {
                let mut options = OpenOptions::new();
                options.read(true).follow(FollowSymlinks::No);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NONBLOCK);
                }
                let mut file = parent.open_with(name, &options)?;
                if !file.metadata()?.is_file() {
                    return Err(invalid("restored workspace entry changed"));
                }
                #[cfg(unix)]
                {
                    use cap_std::fs::MetadataExt;
                    if (file.metadata()?.mode() & 0o111 != 0) != *executable {
                        return Err(invalid("restored executable bit changed"));
                    }
                }
                #[cfg(not(unix))]
                let _ = executable;
                let mut hash = Sha256::new();
                let mut bytes = 0u64;
                let mut buffer = [0u8; 65536];
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    bytes += count as u64;
                    if bytes > object.bytes {
                        return Err(invalid("restored workspace changed"));
                    }
                    hash.update(&buffer[..count]);
                }
                if bytes != object.bytes || hex::encode(hash.finalize()) != object.digest {
                    return Err(invalid("restored workspace changed"));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn directory_identity(
    directory: &cap_std::fs::Dir,
) -> Result<maka_sandbox::workspace::DirectoryIdentity, StoreError> {
    use cap_fs_ext::MetadataExt;
    let metadata = directory.dir_metadata()?;
    let birth = metadata
        .created()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs(), d.subsec_nanos()));
    maka_sandbox::workspace::DirectoryIdentity::try_from(format!(
        "sha256:{}",
        crate::checkpoints::digest(&serde_json::to_vec(&(
            metadata.dev(),
            metadata.ino(),
            birth,
        ))?)
    ))
    .map_err(invalid)
}
