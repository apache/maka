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

//! Same-Root workspace recovery; the live history must still equal the captured cut.
use super::*;
use crate::checkpoints::{PreparedRestore, RestoreOperation, RestoredSession};
use maka_agent_facts::execution::DirectoryIdentity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqliteConnection;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    log.connection.read(move |db| Box::pin(async move {
        let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as("SELECT request_json,prepared_json,directory_identity_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?").bind(key).fetch_optional(db).await?;
        row.map(|(original, prepared, directory_identity, result)| {
            if original != expected { return Err(invalid("checkpoint restore identity conflict")); }
            Ok(Preparation {
                prepared: serde_json::from_str(&prepared)?,
                directory_identity: directory_identity.map(|v|serde_json::from_str(&v)).transpose()?,
                result: result.map(|r|serde_json::from_str(&r)).transpose()?,
            })
        }).transpose()
    })).await
}

pub(crate) struct Commit {
    key: String,
    request: RequestIdentity,
    prepared: PreparedRestore,
    directory_identity: DirectoryIdentity,
}
impl Commit {
    pub(crate) async fn validate(&self, db: &mut SqliteConnection) -> Result<(), StoreError> {
        let current: Option<String> =
            sqlx::query_scalar("SELECT head_json FROM history_checkpoint_heads WHERE session_id=?")
                .bind(&self.request.session)
                .fetch_optional(&mut *db)
                .await?;
        if current
            .as_deref()
            .map(serde_json::from_str::<Head>)
            .transpose()?
            .as_ref()
            != Some(&self.prepared.head)
        {
            return Err(invalid("checkpoint restore head moved"));
        }
        let inventory = crate::bundle::Inventory {
            root_session_id: self.request.session.clone(),
            subtree_digest: String::new(),
            sessions: vec![crate::bundle::Session {
                id: self.request.session.clone(),
                revision: self.prepared.source_revision,
            }],
        };
        crate::bundle::require_idle(db, &inventory).await?;
        if crate::bundle::history_cut(db, &self.request.session).await? != self.prepared.history_cut
        {
            return Err(invalid("live Session history advanced beyond checkpoint"));
        }
        let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as("SELECT request_json,prepared_json,directory_identity_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?").bind(&self.key).fetch_optional(db).await?;
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
    pub(crate) async fn record(
        self,
        db: &mut SqliteConnection,
        revision: u64,
    ) -> Result<(), StoreError> {
        let result = RestoredSession {
            operation: self.request.operation.operation,
            session_id: self.request.session,
            session_revision: revision,
            prepared: self.prepared,
        };
        sqlx::query("UPDATE checkpoint_workspace_restores SET result_json=? WHERE restore_key=? AND result_json IS NULL").bind(serde_json::to_string(&result)?).bind(self.key).execute(db).await?;
        Ok(())
    }
}
impl HistoryCheckpoints {
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
        self.session.scoped().await?.connection.read(move |db|Box::pin(async move {
            let row: Option<(String,Option<String>)> = sqlx::query_as("SELECT request_json,result_json FROM checkpoint_workspace_restores WHERE restore_key=?").bind(key).fetch_optional(db).await?;
            row.map(|(request,result)| {
                let request: RequestIdentity = serde_json::from_str(&request)?;
                if request.scope != scope || request.session != session || request.operation.operation != operation || request.operation.fingerprint != fingerprint || request.operation.revision != revision { return Err(invalid("checkpoint restore identity conflict")); }
                result.map(|r|serde_json::from_str(&r).map_err(StoreError::from)).transpose()
            }).transpose().map(Option::flatten)
        })).await
    }
    /// The parent was selected by the trusted Host. Always creates a new child,
    /// never overwrites an existing project. Partial destinations fail closed.
    pub async fn prepare_workspace_restore(
        &self,
        operation: RestoreOperation,
    ) -> Result<PreparedRestore, StoreError> {
        let request = self.restore_identity(operation);
        request.key()?;
        let log = self.session.exclusive_metadata(true).await?;
        worker(log, self.session.gates.clone(), move |log, objects| async move {
            if let Some(prior) = prior(&log, &request).await? {
                if prior.result.is_none() { verify_destination(&objects, &prior.prepared, &request.operation, prior.directory_identity()?)?; }
                return Ok(prior.prepared);
            }
            let checkout = checkout(&log, &objects, request.scope.clone(), request.session.clone(), request.operation.revision).await?;
            let Manifest { inventory, workspace, history_cut, .. } = checkout.manifest;
            let workspace = workspace.ok_or_else(|| invalid("checkpoint has no workspace"))?;
            if inventory.sessions.len() != 1 || inventory.sessions[0].id != request.session { return Err(invalid("checkpoint restore requires one ordinary Session")); }
            let current = log.get_session::<Value>(&request.session).await?.ok_or(StoreError::SessionNotFound)?;
            if current.archived { return Err(invalid("archived Session cannot be restored")); }
            let expected = history_cut.clone();
            log.connection.read(move |db| Box::pin(async move {
                crate::bundle::require_idle(db, &inventory).await?;
                if crate::bundle::history_cut(db, &inventory.root_session_id).await? != expected {
                    return Err(invalid("live Session history advanced beyond checkpoint"));
                }
                Ok(())
            })).await?;
            let parent = request.operation.parent.canonicalize()?;
            let directory = cap_std::fs::Dir::open_ambient_dir(&parent, cap_std::ambient_authority())?;
            if directory_identity(&directory)? != request.operation.parent_identity { return Err(invalid("restore parent directory changed")); }
            if parent.starts_with(objects.owner.canonical_path()) { return Err(invalid("restore destination overlaps private Root")); }
            let prepared = PreparedRestore { head: checkout.head, source_revision: current.revision, history_cut, workspace, path: parent.join(format!("maka-restored-{}", request.key()?)) };
            let key = request.key()?;
            let encoded = serde_json::to_string(&request)?;
            let data = serde_json::to_string(&prepared)?;
            // The durable claim precedes writes, and commit rechecks both Head and live revision.
            log.connection.run(move |db|Box::pin(async move {
                sqlx::query("INSERT INTO checkpoint_workspace_restores(restore_key,request_json,prepared_json) VALUES(?,?,?)").bind(key).bind(encoded).bind(data).execute(db).await?; Ok(())
            })).await?;
            let name = prepared.path.file_name().ok_or_else(||invalid("restore destination missing"))?;
            directory.create_dir(name)?;
            use cap_fs_ext::DirExt;
            let destination = directory.open_dir_nofollow(name)?;
            let identity = directory_identity(&destination)?;
            workspace::materialize_in(&objects, &prepared.workspace, &destination)?;
            directory.open(".")?.sync_all()?;
            verify_destination(&objects, &prepared, &request.operation, &identity)?;
            let key = request.key()?;
            let identity = serde_json::to_string(&identity)?;
            // A claim alone never proves we created the directory. Publish its
            // physical identity only after the complete copy and directory sync.
            log.connection.run(move |db|Box::pin(async move {
                let changed = sqlx::query("UPDATE checkpoint_workspace_restores SET directory_identity_json=? WHERE restore_key=? AND directory_identity_json IS NULL AND result_json IS NULL").bind(identity).bind(key).execute(db).await?;
                if changed.rows_affected() != 1 { return Err(invalid("checkpoint restore claim changed")); }
                Ok(())
            })).await?;
            Ok(prepared)
        }).await
    }
    /// Configuration and the original restore receipt commit atomically. This
    /// rebinding never rewinds history or starts an invocation.
    pub async fn commit_workspace_restore(
        &self,
        operation: RestoreOperation,
        configuration: Value,
        now: u64,
    ) -> Result<RestoredSession, StoreError> {
        crate::sessions::validate_time(now)?;
        let request = self.restore_identity(operation);
        let log = self.session.exclusive_metadata(true).await?;
        let gates = self.session.gates.clone();
        let control = self
            .session
            .control
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
            let reference = crate::workspace_bindings::attached(&configuration)?
                .ok_or_else(|| invalid("restore workspace binding missing"))?;
            let pin = gates.read([gates::Key::Binding(reference.id)]).await?;
            verify_destination(&objects, &prepared, &request.operation, &directory_identity)?;
            let binding = control
                .workspace_binding::<Value>(reference.id)
                .await?
                .ok_or_else(|| invalid("restore binding missing"))?;
            if binding.workspace.get("path").and_then(Value::as_str) != prepared.path.to_str() {
                return Err(invalid("restore binding differs from prepared workspace"));
            }
            let key = request.key()?;
            let result = log
                .mutate_session_metadata::<Value, _>(
                    &request.session,
                    prepared.source_revision,
                    true,
                    Some(now),
                    Some(control),
                    Some(Commit {
                        key,
                        request: request.clone(),
                        prepared: prepared.clone(),
                        directory_identity,
                    }),
                    move |value| {
                        *value = configuration;
                        Ok(())
                    },
                )
                .await?;
            drop(pin);
            if !matches!(result, crate::sessions::SessionMutation::Committed(_)) {
                return Err(invalid("live Session advanced beyond checkpoint"));
            }
            prior(&log, &request)
                .await?
                .and_then(|v| v.result)
                .ok_or_else(|| invalid("checkpoint restore receipt missing"))
        })
        .await
    }
}
fn verify_destination(
    objects: &Objects,
    prepared: &PreparedRestore,
    operation: &RestoreOperation,
    identity: &DirectoryIdentity,
) -> Result<(), StoreError> {
    use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
    use cap_std::fs::{Dir, OpenOptions};
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let parent = Dir::open_ambient_dir(&operation.parent, cap_std::ambient_authority())?;
    if directory_identity(&parent)? != operation.parent_identity {
        return Err(invalid("restore parent directory changed"));
    }
    let root = parent.open_dir_nofollow(
        prepared
            .path
            .file_name()
            .ok_or_else(|| invalid("restore destination missing"))?,
    )?;
    if &directory_identity(&root)? != identity {
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
            if result.len() >= 20_000 || path.split('/').count() > 65 {
                return Err(invalid("restored workspace bounds exceeded"));
            }
            result.insert(path.clone());
            if entry.file_type()?.is_dir() {
                paths(&dir.open_dir_nofollow(&name)?, &path, result)?;
            }
        }
        Ok(())
    }
    let mut actual = std::collections::BTreeSet::new();
    paths(&root, "", &mut actual)?;
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
) -> Result<maka_agent_facts::execution::DirectoryIdentity, StoreError> {
    use cap_fs_ext::MetadataExt;
    let metadata = directory.dir_metadata()?;
    let birth = metadata
        .created()
        .ok()
        .and_then(|time| time.into_std().duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs(), d.subsec_nanos()));
    maka_agent_facts::execution::DirectoryIdentity::try_from(
        maka_agent_facts::artifact::content_digest(&serde_json::to_vec(&(
            metadata.dev(),
            metadata.ino(),
            birth,
        ))?),
    )
    .map_err(invalid)
}
