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
use crate::sessions::PluginSession;
use crate::writeback::{Notification, Prepared, Statement};
use rusqlite::OptionalExtension;
use serde::Deserialize;

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
            creator: maka_plugin_core::storage::Namespace::new(self.package, scope)
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
    /// Prepare metadata and a native domain statement for the original Host
    /// completion transaction. A domain rejection must be an execute error, not
    /// a successful statement whose opaque value happens to contain an error.
    /// The guarded record describes that transaction's choice; it is not yet a
    /// published Session or a durable receipt.
    pub async fn prepare_plugin_session<T, S>(
        &self,
        claim: &PluginSession,
        configuration: &T,
        now: u64,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRecord<T>, DataChange), StoreError>
    where
        T: Serialize + DeserializeOwned + Send + 'static,
        S: Statement,
    {
        if !self.data_writer()?.same_root(writer) {
            return Err(invalid("foreign Root data writer"));
        }
        validate_origin(claim)?;
        crate::sessions::validate_time(now)?;
        let configuration = serde_json::to_value(configuration)?;
        creation::validate_configuration(&configuration)?;
        self.require_creation_dependencies(None, Some(claim))
            .await?;
        let command = Creation::Plugin {
            origin: claim.into(),
            configuration: configuration.clone(),
            created_at: now,
        };
        let creation = self
            .gates
            .write([gates::Key::Creation(claim.session_id.clone())])
            .await?;
        let (sessions, bindings) = command.pin_inputs(&claim.session_id)?;
        let log = Arc::new(
            pin_sessions(self.log.clone(), &self.gates, &sessions, &bindings)
                .await?
                .scoped(Arc::new(creation)),
        );
        let requested = claim.clone();
        let (expected, command) = log
            .connection
            .read(move |db| {
                require_plugin_dependencies(db, &requested)?;
                let command = creation::WriteReservation::existing(
                    db,
                    &requested.session_id,
                    &requested.fingerprint,
                    &command,
                )?
                .map_or(command, |reserved| reserved.command);
                let Creation::Plugin {
                    configuration,
                    created_at,
                    ..
                } = &command
                else {
                    unreachable!("plugin creation")
                };
                let expected = requested.prepare_record(db, configuration, *created_at)?;
                Ok((expected, command))
            })
            .await?;
        let configuration: T = serde_json::from_value(expected.configuration.clone())?;
        let record = expected.clone().map_configuration(|_| configuration);
        // Reservation is deliberately deferred as well: an interrupted prepare
        // must not leave a metadata-only command for startup recovery to publish.
        let change = writer.prepare(PluginCreation {
            command,
            expected,
            statement,
            custody: log,
        });
        Ok((record, change))
    }

    /// Workspace candidates remain unpublished until the same statement installs
    /// the original plugin Session and its domain facts. Metadata is read in SQL.
    pub async fn prepare_plugin_session_with_workspace<S, W>(
        &self,
        claim: &PluginSession,
        configuration: &serde_json::Value,
        now: u64,
        writer: &DataWriter,
        workspace: W,
        statement: S,
    ) -> Result<
        impl Statement<Value = (SessionRecord, S::Value), Output = (SessionRecord, S::Output)>
        + use<S, W>,
        StoreError,
    >
    where
        S: Statement,
        W: Statement<
                Value = maka_sandbox::workspace::BindingRef,
                Output = maka_sandbox::workspace::BindingRef,
            >,
    {
        self.require_open()?;
        self.validate_data_writer(writer)?;
        validate_origin(claim)?;
        crate::sessions::validate_time(now)?;
        creation::validate_configuration(configuration)?;
        self.require_creation_dependencies(None, Some(claim))
            .await?;
        let command = Creation::Plugin {
            origin: claim.into(),
            configuration: configuration.clone(),
            created_at: now,
        };
        let creation = self
            .gates
            .write([gates::Key::Creation(claim.session_id.clone())])
            .await?;
        let (sessions, bindings) = command.pin_inputs(&claim.session_id)?;
        // An uninstalled candidate is data, not an existing binding resource.
        let bindings = self
            .log
            .connection
            .read(move |connection| {
                let mut existing = Vec::new();
                for binding in bindings {
                    if crate::workspace_bindings::read::<serde_json::Value>(connection, binding.id)?
                        .is_some()
                    {
                        existing.push(binding);
                    }
                }
                Ok(existing)
            })
            .await?;
        let custody = Arc::new(
            pin_sessions(self.log.clone(), &self.gates, &sessions, &bindings)
                .await?
                .scoped(Arc::new(creation)),
        );
        Ok(WorkspacePluginCreation {
            command,
            workspace,
            statement,
            custody,
        })
    }

    pub(super) async fn require_published_session(&self, id: &str) -> Result<(), StoreError> {
        self.session(id).await.map(|_| ())
    }

    async fn require_creation_dependencies(
        &self,
        source: Option<&str>,
        origin: Option<&PluginSession>,
    ) -> Result<(), StoreError> {
        let authority = origin.and_then(|origin| origin.authority_session_id.as_deref());
        let scope = origin.and_then(|origin| match origin.creator.scope() {
            maka_plugin_core::scope::Scope::Session(id) => Some(id.as_str()),
            _ => None,
        });
        for dependency in [source, authority, scope].into_iter().flatten() {
            self.require_published_session(dependency).await?;
        }
        Ok(())
    }

    pub(super) async fn execute_creation(
        &self,
        id: &str,
        fingerprint: &str,
        command: Creation,
        members: Vec<String>,
    ) -> Result<(), StoreError> {
        self.require_open()?;
        if fingerprint.is_empty() {
            return Err(invalid("invalid session fingerprint"));
        }
        for member in &members {
            crate::sessions::validate_id(member)?;
        }
        let creation = self
            .gates
            .write([super::gates::Key::Creation(id.to_owned())])
            .await?;
        let (sessions, bindings) = command.pin_inputs(id)?;
        let log = super::pin_sessions(self.log.clone(), &self.gates, &sessions, &bindings)
            .await?
            .scoped(Arc::new(creation));
        let reserved = log
            .connection
            .write(
                creation::WriteReservation {
                    id: id.to_owned(),
                    fingerprint: fingerprint.to_owned(),
                    command,
                    members,
                },
                self.log.commits.notice(),
            )
            .await?;
        self.finish_pinned_creation(id, fingerprint, reserved.command, &log)
            .await?;
        Ok(())
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
        self.require_creation_dependencies(None, Some(claim))
            .await?;
        let command = Creation::Plugin {
            origin: claim.into(),
            configuration,
            created_at: now,
        };
        self.execute_creation(
            &claim.session_id,
            &claim.fingerprint,
            command,
            vec![claim.session_id.clone()],
        )
        .await?;
        self.handle(claim.session_id.clone())
            .get()
            .await?
            .ok_or(StoreError::SessionNotFound)
    }
}

fn require_plugin_dependencies(
    db: &SqliteConnection,
    origin: &PluginSession,
) -> Result<(), StoreError> {
    for id in Origin::from(origin).dependencies()? {
        if id != origin.session_id && !super::catalog::session_visible(db, &id)? {
            return Err(StoreError::SessionCreationRejected(
                CreationRejection::MissingDependency,
            ));
        }
    }
    Ok(())
}

struct PluginCreation<S> {
    command: Creation,
    expected: SessionRecord,
    statement: S,
    custody: Arc<EventLog>,
}

impl<S: Statement> Statement for PluginCreation<S> {
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
    fn execute(self, db: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        let id = self.expected.id.clone();
        let Creation::Plugin { origin, .. } = &self.command else {
            unreachable!("plugin creation")
        };
        let claim = origin.clone().claim()?;
        require_plugin_dependencies(db, &claim)?;
        let reserved = creation::WriteReservation {
            id: id.clone(),
            fingerprint: claim.fingerprint.clone(),
            command: self.command,
            members: vec![id.clone()],
        }
        .execute(db)?;
        let Creation::Plugin {
            configuration,
            created_at,
            ..
        } = reserved.value.command
        else {
            unreachable!("plugin creation")
        };
        let inserted = claim.insert_metadata(db, &configuration, created_at)?;
        if crate::sessions::read::<serde_json::Value>(db, &id)?.as_ref() != Some(&self.expected) {
            return Err(invalid("prepared Session metadata changed"));
        }
        let publication = creation::WritePublication {
            id: id.clone(),
            rejection: None,
        }
        .execute(db)?;
        let domain = self.statement.execute(db)?;
        Ok(Prepared {
            value: domain.value,
            changed: reserved.changed || inserted || domain.changed || publication.changed,
            notification: domain
                .notification
                .combine(Notification::METADATA.with_sessions([id])),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionConflict
                    | StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionCreationRejected(_)
                    | StoreError::InvalidTransition(_)
            )
    }
}

struct WorkspacePluginCreation<S, W> {
    command: Creation,
    workspace: W,
    statement: S,
    custody: Arc<EventLog>,
}
impl<S, W> Statement for WorkspacePluginCreation<S, W>
where
    S: Statement,
    W: Statement<
            Value = maka_sandbox::workspace::BindingRef,
            Output = maka_sandbox::workspace::BindingRef,
        >,
{
    type Value = (SessionRecord, S::Value);
    type Output = (SessionRecord, S::Output);
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD || W::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.workspace.retain();
        retained.extend(self.statement.retain());
        retained.push(self.custody.clone());
        retained
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            workspace: self.workspace.prepare()?,
            statement: self.statement.prepare()?,
            ..self
        })
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.custody.connection.require_same_writer(connection)?;
        let workspace = self.workspace.execute(connection)?;
        let Creation::Plugin {
            origin,
            configuration,
            ..
        } = &self.command
        else {
            unreachable!("plugin creation")
        };
        if crate::workspace_bindings::attached(configuration)?.as_ref() != Some(&workspace.value) {
            return Err(invalid(
                "plugin creation workspace differs from the original candidate",
            ));
        }
        let claim = origin.clone().claim()?;
        require_plugin_dependencies(connection, &claim)?;
        let command = creation::WriteReservation::existing(
            connection,
            &claim.session_id,
            &claim.fingerprint,
            &self.command,
        )?
        .map_or(self.command, |reserved| reserved.command);
        let Creation::Plugin {
            configuration,
            created_at,
            ..
        } = &command
        else {
            unreachable!("plugin creation")
        };
        let expected = claim.prepare_record(connection, configuration, *created_at)?;
        let creation = PluginCreation {
            command,
            expected,
            statement: RecordAfter {
                session: claim.session_id,
                statement: self.statement,
            },
            custody: self.custody,
        }
        .execute(connection)?;
        Ok(Prepared {
            value: creation.value,
            changed: workspace.changed || creation.changed,
            notification: workspace.notification.combine(creation.notification),
        })
    }
    fn committed((record, value): Self::Value) -> Self::Output {
        (record, S::committed(value))
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        W::isolated_rejection(error) || PluginCreation::<RecordAfter<S>>::isolated_rejection(error)
    }
}

struct RecordAfter<S> {
    session: String,
    statement: S,
}
impl<S: Statement> Statement for RecordAfter<S> {
    type Value = (SessionRecord, S::Value);
    type Output = (SessionRecord, S::Output);
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        self.statement.retain()
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        let domain = self.statement.execute(connection)?;
        let record =
            crate::sessions::read(connection, &self.session)?.ok_or(StoreError::SessionNotFound)?;
        Ok(Prepared {
            value: (record, domain.value),
            changed: domain.changed,
            notification: domain.notification,
        })
    }
    fn committed((record, value): Self::Value) -> Self::Output {
        (record, S::committed(value))
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
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
    _root: &RootStore,
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
        Creation::Session { .. } => unreachable!("ordinary creation has its own receipt"),
    };
    let rejection = match result {
        Ok(rejection) => return Ok(rejection),
        Err(StoreError::SessionConflict) => CreationRejection::IdentityConflict,
        Err(StoreError::SessionRetired) => CreationRejection::Retired,
        Err(StoreError::SessionNotFound) => CreationRejection::MissingDependency,
        Err(StoreError::SessionCreationRejected(rejection)) => rejection,
        Err(error) => return Err(error),
    };
    store
        .connection
        .run(|db| {
            let tx =
                rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
            tx.rollback()?;
            Ok(())
        })
        .await?;
    Ok(Some(rejection))
}

impl RootStore {
    async fn recover_target(&self, id: &str) -> Result<bool, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        let row: Option<(String, String, String, Option<String>)> = self.log.connection.read(move |db| {
            Ok(db.query_row("SELECT r.creation_id,c.fingerprint,c.command,r.failure FROM session_creations r JOIN session_creations c ON c.session_id=r.creation_id WHERE r.session_id=? AND r.visible=1", rusqlite::params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).optional()?)
        }).await?;
        let Some((id, fingerprint, command, failure)) = row else {
            return Ok(false);
        };
        if let Some(failure) = failure {
            return Err(StoreError::SessionCreationRejected(serde_json::from_str(
                &failure,
            )?));
        }
        self.finish_creation(&id, &fingerprint, serde_json::from_str(&command)?)
            .await?;
        Ok(true)
    }

    pub async fn probe_session_create<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        fingerprint: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        match self.recover_target(id).await? {
            true => self.log.probe_session_create(id, fingerprint).await,
            false => Ok(None),
        }
    }
}

// Receipt tables outlive mutable Session metadata and retirement. Recover before
// checking current source revisions, bindings, or whether the target is readable.
async fn committed_receipt(store: &EventLog, command: &Creation) -> Result<bool, StoreError> {
    let Creation::Plugin { origin, .. } = command else {
        return Ok(false);
    };
    let origin = origin.clone();
    store.connection.read(move |db| {
        let stored: Option<(String,String,String,bool,Option<String>)> = db.query_row(
            "SELECT package_id,scope_id,fingerprint,managed,authority_session_id FROM plugin_sessions WHERE session_id=?",
            rusqlite::params![&origin.session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).optional()?;
        Ok(stored.is_some_and(|(package,scope,fingerprint,managed,authority)| {
            package == origin.package && scope == origin.scope && fingerprint == origin.fingerprint
                && managed == origin.managed && authority == origin.authority_session_id
        }))
    }).await
}
