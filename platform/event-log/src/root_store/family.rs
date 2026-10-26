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

//! Durable creation commands and immutable family placement.
use super::routes::Creation;
use super::*;
use crate::sessions::{PluginSession, SessionCopy, SessionCopyResult};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Origin {
    session_id: String,
    package: String,
    scope: String,
    fingerprint: String,
    managed: bool,
    authority_session_id: Option<String>,
}
impl From<&PluginSession> for Origin {
    fn from(value: &PluginSession) -> Self {
        Self {
            session_id: value.session_id.clone(),
            package: value.creator.package().into(),
            scope: String::from(value.creator.scope().clone()),
            fingerprint: value.fingerprint.clone(),
            managed: value.managed,
            authority_session_id: value.authority_session_id.clone(),
        }
    }
}
impl Origin {
    pub(super) fn dependencies(&self) -> Result<Vec<String>, StoreError> {
        let mut ids = vec![self.session_id.clone()];
        ids.extend(self.authority_session_id.iter().cloned());
        if let maka_plugin_core::scope::Scope::Session(id) =
            maka_plugin_core::scope::Scope::try_from(self.scope.clone()).map_err(invalid)?
        {
            ids.push(id);
        }
        Ok(ids)
    }

    fn claim(self) -> Result<PluginSession, StoreError> {
        let scope = maka_plugin_core::scope::Scope::try_from(self.scope).map_err(invalid)?;
        Ok(PluginSession {
            session_id: self.session_id,
            creator: maka_capabilities::storage::Namespace::new(self.package, scope)
                .map_err(invalid)?,
            fingerprint: self.fingerprint,
            managed: self.managed,
            authority_session_id: self.authority_session_id,
        })
    }
}
fn invalid(message: impl std::fmt::Display) -> StoreError {
    StoreError::InvalidTransition(message.to_string())
}

impl RootStore {
    pub(super) async fn route_partition(&self, id: &str) -> Result<usize, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        self.control.connection.read(move |db| Box::pin(async move {
            let partition: Option<i64> = sqlx::query_scalar("SELECT partition FROM session_routes WHERE session_id=? AND ready=1 AND visible=1").bind(id).fetch_optional(db).await?;
            Ok(partition.ok_or(StoreError::SessionNotFound)? as usize)
        })).await
    }

    async fn family_partition(
        &self,
        target: &str,
        source: Option<&str>,
        origin: Option<&PluginSession>,
    ) -> Result<usize, StoreError> {
        let mut partition = None;
        let authority = origin.and_then(|origin| origin.authority_session_id.as_deref());
        let scope = origin.and_then(|origin| match origin.creator.scope() {
            maka_plugin_core::scope::Scope::Session(id) => Some(id.as_str()),
            _ => None,
        });
        for dependency in [source, authority, scope].into_iter().flatten() {
            let inherited = self.route_partition(dependency).await?;
            if partition.is_some_and(|current| current != inherited) {
                return Err(invalid(
                    "Session creation dependencies belong to different partitions",
                ));
            }
            partition = Some(inherited);
        }
        Ok(partition.unwrap_or_else(|| partition_for(b"session", target)))
    }

    pub(super) async fn execute_creation(
        &self,
        id: &str,
        fingerprint: &str,
        command: Creation,
        partition: usize,
        members: Vec<String>,
    ) -> Result<usize, StoreError> {
        self.require_open()?;
        if fingerprint.is_empty() {
            return Err(invalid("invalid session fingerprint"));
        }
        for member in &members {
            crate::sessions::validate_id(member)?;
        }
        let _gate = self.creation_gates[partition].lock().await;
        self.require_open()?;
        let (partition, command) = self
            .reserve_family(id, fingerprint, command, partition, members)
            .await?;
        self.finish_creation(id, fingerprint, partition, command)
            .await?;
        Ok(partition)
    }

    pub async fn create_plugin_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        claim: &PluginSession,
        configuration: &T,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        validate_origin(claim)?;
        crate::sessions::validate_time(now)?;
        let configuration = serde_json::to_value(configuration)?;
        creation::validate_configuration(&configuration)?;
        let partition = self
            .family_partition(&claim.session_id, None, Some(claim))
            .await?;
        let command = Creation::Plugin {
            origin: claim.into(),
            configuration,
            created_at: now,
        };
        let partition = self
            .execute_creation(
                &claim.session_id,
                &claim.fingerprint,
                command,
                partition,
                vec![claim.session_id.clone()],
            )
            .await?;
        self.handle(claim.session_id.clone(), partition)
            .get()
            .await?
            .ok_or(StoreError::SessionNotFound)
    }

    pub async fn copy_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        self.copy_owned(request, configuration, now, None).await
    }
    pub async fn copy_plugin_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
        origin: PluginSession,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        validate_origin(&origin)?;
        if origin.session_id != request.target_session_id {
            return Err(invalid("copy target differs from its creation owner"));
        }
        self.copy_owned(request, configuration, now, Some(origin))
            .await
    }
    async fn copy_owned<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        request: SessionCopy,
        configuration: &T,
        now: u64,
        origin: Option<PluginSession>,
    ) -> Result<SessionCopyResult<T>, StoreError> {
        crate::sessions::validate_id(&request.target_session_id)?;
        crate::sessions::validate_id(&request.source_session_id)?;
        crate::sessions::validate_time(now)?;
        if request.source_session_id == request.target_session_id
            || request.expected_source_revision == 0
            || request.expected_source_revision > 9_007_199_254_740_991
        {
            return Err(invalid("invalid Session copy identity or revision"));
        }
        use maka_agent_facts::session::CopyPurpose;
        if let CopyPurpose::Revision { turn_id }
        | CopyPurpose::Branch {
            turn_id: Some(turn_id),
            ..
        } = &request.purpose
        {
            crate::sessions::validate_id(turn_id)?;
        }
        let configuration = serde_json::to_value(configuration)?;
        creation::validate_configuration(&configuration)?;
        let target = request.target_session_id.clone();
        let partition = self
            .family_partition(&target, Some(&request.source_session_id), origin.as_ref())
            .await?;
        let fingerprint = origin.as_ref().map(|o| o.fingerprint.clone()).unwrap_or(
            maka_agent_facts::artifact::content_digest(serde_json::to_string(&request)?.as_bytes()),
        );
        let command = Creation::Copy {
            request,
            origin: origin.as_ref().map(Into::into),
            configuration,
            created_at: now,
        };
        match self
            .execute_creation(
                &target,
                &fingerprint,
                command,
                partition,
                vec![target.clone()],
            )
            .await
        {
            Err(StoreError::SessionCreationRejected(
                CreationRejection::SourceRevisionConflict { expected, actual },
            )) => Ok(SessionCopyResult::SourceRevisionConflict { expected, actual }),
            Err(error) => Err(error),
            Ok(partition) => Ok(SessionCopyResult::Committed(Box::new(
                self.handle(target, partition)
                    .get()
                    .await?
                    .ok_or(StoreError::SessionNotFound)?,
            ))),
        }
    }

    pub async fn import_session<T: Serialize + DeserializeOwned + Send + 'static>(
        &self,
        owner: &PluginSession,
        source: &maka_agent_facts::import::Source,
        configuration: &T,
        records: Vec<maka_agent_facts::import::Record>,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        validate_origin(owner)?;
        source.validate().map_err(invalid)?;
        crate::sessions::validate_time(now)?;
        if records.is_empty()
            || !records
                .iter()
                .any(maka_agent_facts::import::Record::is_conversation)
        {
            return Err(invalid("invalid complete import"));
        }
        let mut calls = std::collections::HashSet::new();
        for record in &records {
            record.validate().map_err(invalid)?;
            if let maka_agent_facts::import::Content::ToolCall { call_id, .. } = &record.content
                && !calls.insert(call_id)
            {
                return Err(invalid("duplicate imported tool call identity"));
            }
        }
        let configuration = serde_json::to_value(configuration)?;
        creation::validate_configuration(&configuration)?;
        let partition = self
            .family_partition(&owner.session_id, None, Some(owner))
            .await?;
        let command = Creation::Import {
            origin: owner.into(),
            source: source.clone(),
            records,
            configuration,
            created_at: now,
        };
        let partition = self
            .execute_creation(
                &owner.session_id,
                &owner.fingerprint,
                command,
                partition,
                vec![owner.session_id.clone()],
            )
            .await?;
        self.handle(owner.session_id.clone(), partition)
            .get()
            .await?
            .ok_or(StoreError::SessionNotFound)
    }
}

fn validate_origin(origin: &PluginSession) -> Result<(), StoreError> {
    crate::sessions::validate_id(&origin.session_id)?;
    if origin.fingerprint.is_empty() {
        return Err(invalid("invalid session fingerprint"));
    }
    if let Some(authority) = &origin.authority_session_id {
        crate::sessions::validate_id(authority)?;
        if authority == &origin.session_id {
            return Err(invalid("Session cannot authorize its own creation"));
        }
    }
    Ok(())
}

pub(super) async fn commit(
    root: &RootStore,
    store: &EventLog,
    command: Creation,
) -> Result<Option<CreationRejection>, StoreError> {
    if committed_receipt(store, &command).await? {
        return Ok(None);
    }
    let result = match command {
        Creation::Plugin {
            origin,
            configuration,
            created_at,
        } => store
            .create_plugin_session(&origin.claim()?, &configuration, created_at)
            .await
            .map(|_| None),
        Creation::Copy {
            request,
            origin,
            configuration,
            created_at,
        } => {
            let result = match origin {
                Some(origin) => {
                    store
                        .copy_plugin_session(request, &configuration, created_at, origin.claim()?)
                        .await
                }
                None => {
                    store
                        .copy_session(request, &configuration, created_at)
                        .await
                }
            };
            result.map(|result| match result {
                SessionCopyResult::Committed(_) => None,
                SessionCopyResult::SourceRevisionConflict { expected, actual } => {
                    Some(CreationRejection::SourceRevisionConflict { expected, actual })
                }
            })
        }
        Creation::Import {
            origin,
            source,
            records,
            configuration,
            created_at,
        } => store
            .import_session(
                &origin.claim()?,
                &source,
                &configuration,
                records,
                created_at,
            )
            .await
            .map(|_| None),
        Creation::Bundle {
            stage,
            digest,
            binding,
            configurations,
            ..
        } => {
            // A committed receipt survives deletion of the stage or changed bindings.
            if store
                .bundle_import_receipt(&digest, &binding)
                .await?
                .is_some()
            {
                return Ok(None);
            }
            let directory = store
                .root_owner
                .as_ref()
                .ok_or_else(|| invalid("bundle requires Root owner"))?
                .canonical_path()
                .join("runtime-stages");
            let path = stage_path(&directory, &stage)?;
            let staged = crate::bundle::StagedBundle::reopen(&path, root.stage_owner()?).await?;
            store
                .import_bundle(staged, &binding, configurations)
                .await
                .map(|_| None)
                .map_err(|error| match error {
                    crate::bundle::BundleError::Store(error) => error,
                    crate::bundle::BundleError::CandidateSetStale => {
                        invalid("unexpected bundle inventory change")
                    }
                })
        }
        Creation::Session { .. } => unreachable!("ordinary creation has its own receipt"),
    };
    let rejection = match result {
        Ok(None) => return Ok(None),
        Ok(rejection) => rejection,
        Err(error) => Some(match error {
            StoreError::SessionConflict => CreationRejection::IdentityConflict,
            StoreError::SessionRetired => CreationRejection::Retired,
            StoreError::SessionNotFound => CreationRejection::MissingDependency,
            StoreError::ManagedSession => CreationRejection::ManagedSource,
            StoreError::HistoryTurnMissing => CreationRejection::HistoryTurnMissing,
            StoreError::HistoryTurnSplit => CreationRejection::HistoryTurnSplit,
            StoreError::HistoryUnsettled => CreationRejection::HistoryUnsettled,
            StoreError::HistoryProviderEffectUnresolved => {
                CreationRejection::HistoryProviderEffectUnresolved
            }
            StoreError::SessionCreationRejected(rejection) => rejection,
            StoreError::InvalidTransition(ref message)
                if message == "revision Turn has no editable input" =>
            {
                CreationRejection::RevisionInputMissing
            }
            StoreError::InvalidTransition(ref message)
                if message == "revision family exhausted" =>
            {
                CreationRejection::RevisionFamilyExhausted
            }
            // Unknown InvalidTransition/storage errors retain their recovery obligation.
            error => return Err(error),
        }),
    };
    // Domain methods drop their SQL transaction on rejection. A subsequent BEGIN
    // on this same writer can only succeed once SQLite has acknowledged rollback.
    // Never terminalize a reservation if that acknowledgement fails.
    store
        .connection
        .run(|db| {
            Box::pin(async move {
                let tx = db.begin_with("BEGIN IMMEDIATE").await?;
                tx.rollback().await?;
                Ok(())
            })
        })
        .await?;
    Ok(rejection)
}

fn stage_path(directory: &std::path::Path, stage: &str) -> Result<std::path::PathBuf, StoreError> {
    let id = uuid::Uuid::parse_str(stage).map_err(invalid)?;
    if id.to_string() != stage {
        return Err(invalid("invalid durable stage identity"));
    }
    Ok(directory.join(format!("{stage}.sqlite")))
}

impl RootStore {
    pub async fn import_bundle<T: Serialize + Send + 'static>(
        &self,
        mut staged: crate::bundle::StagedBundle,
        binding_fingerprint: &str,
        configurations: std::collections::BTreeMap<String, T>,
    ) -> Result<crate::bundle::ImportReceipt, crate::bundle::BundleError> {
        self.require_open()?;
        if !maka_agent_facts::archive::valid_projection_digest(binding_fingerprint) {
            return Err(invalid("invalid bundle binding fingerprint").into());
        }
        let configurations: std::collections::BTreeMap<String, Value> = configurations
            .into_iter()
            .map(|(id, configuration)| Ok((id, serde_json::to_value(configuration)?)))
            .collect::<Result<_, serde_json::Error>>()
            .map_err(StoreError::from)?;
        if configurations.keys().ne(staged
            .summary()
            .inventory
            .sessions
            .iter()
            .map(|session| &session.id))
        {
            return Err(invalid("bundle destination bindings differ from its inventory").into());
        }
        for configuration in configurations.values() {
            creation::validate_configuration(configuration)?;
        }
        staged.validate_history().await?;
        let members = staged.family_members().await?;
        let id = staged.summary().inventory.root_session_id.clone();
        let digest = staged.summary().digest.clone();
        let stage = uuid::Uuid::new_v4().to_string();
        let directory = self
            .control
            .root_owner
            .as_ref()
            .ok_or_else(|| invalid("bundle requires Root owner"))?
            .canonical_path()
            .join("runtime-stages");
        root::private_directory(&directory).map_err(StoreError::from)?;
        let path = stage_path(&directory, &stage)?;
        staged.persist(&path, self.stage_owner()?).await?;
        let command = Creation::Bundle {
            stage,
            digest: digest.clone(),
            binding: binding_fingerprint.into(),
            configurations,
            members: members.clone(),
        };
        let partition = self
            .execute_creation(
                &id,
                binding_fingerprint,
                command,
                partition_for(b"session", &id),
                members,
            )
            .await?;
        let receipt = self.partitions[partition]
            .bundle_import_receipt(&digest, binding_fingerprint)
            .await?
            .ok_or_else(|| invalid("committed bundle receipt is missing"))?;
        std::fs::remove_file(&path).map_err(StoreError::from)?;
        std::fs::File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(StoreError::from)?;
        Ok(receipt)
    }

    /// Startup owns every creation gate, so unreserved stages cannot race cleanup.
    pub(super) async fn cleanup_stages(&self) -> Result<(), StoreError> {
        let directory = self
            .control
            .root_owner
            .as_ref()
            .ok_or_else(|| invalid("bundle requires Root owner"))?
            .canonical_path()
            .join("runtime-stages");
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let pending: Vec<String> = self.control.connection.read(|db| Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT DISTINCT json_extract(command,'$.stage') FROM session_routes WHERE ready=0 AND json_extract(command,'$.kind')='bundle'").fetch_all(db).await?)
        })).await?;
        let pending: std::collections::HashSet<_> = pending.into_iter().collect();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "sqlite")
            {
                let Some(stage) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                stage_path(&directory, stage)?;
                if !pending.contains(stage) {
                    std::fs::remove_file(path)?;
                }
            }
        }
        std::fs::File::open(directory)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "family_tests.rs"]
mod tests;

impl RootStore {
    async fn recover_target(&self, id: &str) -> Result<Option<usize>, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        let row: Option<(String, String, i64, String, Option<String>)> = self.control.connection.read(move |db| Box::pin(async move {
            Ok(sqlx::query_as("SELECT r.creation_id,c.fingerprint,r.partition,c.command,r.failure FROM session_routes r JOIN session_routes c ON c.session_id=r.creation_id WHERE r.session_id=? AND r.visible=1").bind(id).fetch_optional(db).await?)
        })).await?;
        let Some((id, fingerprint, partition, command, failure)) = row else {
            return Ok(None);
        };
        if let Some(failure) = failure {
            return Err(StoreError::SessionCreationRejected(serde_json::from_str(
                &failure,
            )?));
        }
        let _gate = self.creation_gates[partition as usize].lock().await;
        self.require_open()?;
        self.finish_creation(
            &id,
            &fingerprint,
            partition as usize,
            serde_json::from_str(&command)?,
        )
        .await?;
        Ok(Some(partition as usize))
    }

    pub async fn probe_session_create<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        fingerprint: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        match self.recover_target(id).await? {
            Some(partition) => {
                self.partitions[partition]
                    .probe_session_create(id, fingerprint)
                    .await
            }
            None => Ok(None),
        }
    }

    pub async fn session_copy_receipt(
        &self,
        target: &str,
    ) -> Result<Option<maka_agent_facts::session::CopyReceipt>, StoreError> {
        match self.recover_target(target).await? {
            Some(partition) => {
                self.partitions[partition]
                    .session_copy_receipt(target)
                    .await
            }
            None => Ok(None),
        }
    }

    pub async fn bundle_import_receipt(
        &self,
        digest: &str,
        binding_fingerprint: &str,
    ) -> Result<Option<crate::bundle::ImportReceipt>, StoreError> {
        self.require_open()?;
        let query_digest = digest.to_owned();
        let id: Option<String> = self.control.connection.read(move |db| Box::pin(async move {
            Ok(sqlx::query_scalar("SELECT session_id FROM session_routes WHERE session_id=creation_id AND json_extract(command,'$.kind')='bundle' AND json_extract(command,'$.digest')=?").bind(query_digest).fetch_optional(db).await?)
        })).await?;
        let Some(id) = id else { return Ok(None) };
        match self.recover_target(&id).await? {
            Some(partition) => {
                self.partitions[partition]
                    .bundle_import_receipt(digest, binding_fingerprint)
                    .await
            }
            None => Ok(None),
        }
    }
}

// Receipt tables outlive mutable Session metadata and retirement. Recover before
// checking current source revisions, bindings, or whether the target is readable.
async fn committed_receipt(store: &EventLog, command: &Creation) -> Result<bool, StoreError> {
    let (id, expected_origin, receipt) = match command {
        Creation::Plugin { origin, .. } => (origin.session_id.clone(), Some(origin.clone()), None),
        Creation::Copy {
            request, origin, ..
        } => {
            let Some(receipt) = store
                .session_copy_receipt(&request.target_session_id)
                .await?
            else {
                return Ok(false);
            };
            if receipt.request != *request {
                return Ok(false);
            }
            (request.target_session_id.clone(), origin.clone(), None)
        }
        Creation::Import {
            origin,
            source,
            records,
            configuration,
            ..
        } => (
            origin.session_id.clone(),
            Some(origin.clone()),
            Some((
                serde_json::to_string(source)?,
                records.len() as i64,
                configuration.clone(),
            )),
        ),
        _ => return Ok(false),
    };
    store.connection.read(move |db| Box::pin(async move {
        if let Some((source, count, configuration)) = receipt {
            let imported: Option<(String, i64, String)> = sqlx::query_as("SELECT source_json,records,configuration FROM session_imports WHERE session_id=? AND state='published'")
                .bind(&id).fetch_optional(&mut *db).await?;
            let Some((stored_source, stored_count, stored_configuration)) = imported else { return Ok(false) };
            if stored_source != source || stored_count != count || serde_json::from_str::<Value>(&stored_configuration)? != configuration { return Ok(false); }
        }
        let stored: Option<(String,String,String,bool,Option<String>)> = sqlx::query_as("SELECT package_id,scope_id,fingerprint,managed,authority_session_id FROM plugin_sessions WHERE session_id=?")
            .bind(&id).fetch_optional(&mut *db).await?;
        Ok(match (stored, expected_origin) {
            (None, None) => true,
            (Some((package,scope,fingerprint,managed,authority)), Some(origin)) => package == origin.package && scope == origin.scope && fingerprint == origin.fingerprint && managed == origin.managed && authority == origin.authority_session_id,
            _ => false,
        })
    })).await
}
