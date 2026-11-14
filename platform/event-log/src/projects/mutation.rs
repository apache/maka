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
use crate::writeback::{Notification, Prepared, Statement};
use uuid::Uuid;

enum RegistrationGuard {
    Unconditional,
    Observed(Option<ProjectRecord>),
    Available,
    ObservedAvailable(Option<ProjectRecord>),
}

impl EventLog {
    pub(crate) async fn project_by_identity(
        &self,
        identity: &str,
    ) -> Result<Option<ProjectRecord>> {
        validate_text(identity)?;
        let identity = identity.to_owned();
        self.connection
            .read(move |connection| {
                let snapshot = connection.unchecked_transaction()?;
                let id: Option<String> = snapshot
                    .query_row(
                        "SELECT id FROM projects WHERE identity=?",
                        params![identity],
                        |row| row.get(0),
                    )
                    .optional()?;
                let record = match id {
                    Some(id) => read(&snapshot, &id)?,
                    None => None,
                };
                snapshot.commit()?;
                Ok(record)
            })
            .await
    }

    pub async fn register_project(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
    ) -> Result<ProjectRecord> {
        self.register_project_guarded(registration, prefer, now, RegistrationGuard::Unconditional)
            .await
    }
    pub async fn register_project_if(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        expected: Option<ProjectRecord>,
    ) -> Result<ProjectRecord> {
        self.register_project_guarded(
            registration,
            prefer,
            now,
            RegistrationGuard::Observed(expected),
        )
        .await
    }
    pub async fn register_available_project(
        &self,
        registration: ProjectRegistration,
        now: u64,
    ) -> Result<ProjectRecord> {
        self.register_project_guarded(registration, true, now, RegistrationGuard::Available)
            .await
    }
    async fn register_project_guarded(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        guard: RegistrationGuard,
    ) -> Result<ProjectRecord> {
        self.connection
            .write(
                WriteRegistration::new(registration, prefer, now, guard, Uuid::new_v4())?,
                self.commits.notice(),
            )
            .await?
            .map_err(StoreError::Project)
    }
    pub(crate) fn prepare_project_registration(
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        expected: Option<ProjectRecord>,
        new_id: Uuid,
    ) -> Result<
        impl Statement<
            Value = std::result::Result<ProjectRecord, ProjectError>,
            Output = std::result::Result<ProjectRecord, ProjectError>,
        >,
    > {
        WriteRegistration::new(
            registration,
            prefer,
            now,
            RegistrationGuard::Observed(expected),
            new_id,
        )
    }
    pub(crate) fn prepare_available_project_registration(
        registration: ProjectRegistration,
        now: u64,
        expected: Option<ProjectRecord>,
        new_id: Uuid,
    ) -> Result<
        impl Statement<
            Value = std::result::Result<ProjectRecord, ProjectError>,
            Output = std::result::Result<ProjectRecord, ProjectError>,
        >,
    > {
        WriteRegistration::new(
            registration,
            true,
            now,
            RegistrationGuard::ObservedAvailable(expected),
            new_id,
        )
    }
    pub async fn mutate_project(
        &self,
        id: &str,
        mutation: ProjectMutation,
        now: u64,
    ) -> Result<ProjectRecord> {
        self.mutate_project_guarded(id, mutation, now, None).await
    }
    pub async fn mutate_project_if(
        &self,
        expected: ProjectRecord,
        mutation: ProjectMutation,
        now: u64,
    ) -> Result<ProjectRecord> {
        self.mutate_project_guarded(&expected.id.clone(), mutation, now, Some(expected))
            .await
    }
    async fn mutate_project_guarded(
        &self,
        id: &str,
        mutation: ProjectMutation,
        now: u64,
        expected: Option<ProjectRecord>,
    ) -> Result<ProjectRecord> {
        self.connection
            .write(
                WriteMutation::new(id, mutation, now, expected)?,
                self.commits.notice(),
            )
            .await?
            .map_err(StoreError::Project)
    }
    pub(crate) fn prepare_project_mutation(
        expected: ProjectRecord,
        mutation: ProjectMutation,
        now: u64,
    ) -> Result<
        impl Statement<
            Value = std::result::Result<ProjectRecord, ProjectError>,
            Output = std::result::Result<ProjectRecord, ProjectError>,
        >,
    > {
        WriteMutation::new(&expected.id.clone(), mutation, now, Some(expected))
    }
    pub(crate) fn prepare_project_selection(
        id: Uuid,
        identity: String,
        path: String,
        now: u64,
    ) -> Result<impl Statement<Value = std::result::Result<ProjectRecord, ProjectError>>> {
        Ok(WriteSelection {
            id,
            identity,
            path,
            now: timestamp(now)?,
        })
    }
    pub async fn touch_project(&self, id: &str, path: &str, now: u64) -> Result<ProjectRecord> {
        validate_id(id)?;
        validate_text(path)?;
        let now = timestamp(now)?;
        let (id, path) = (id.to_owned(), path.to_owned());
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let record = read(&tx, &id)?.ok_or(ProjectError::NotFound)?;
                touch(&tx, &record.id, &path, now)?;
                let record = read(&tx, &record.id)?.ok_or(ProjectError::NotFound)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(record)
            })
            .await
    }
}

pub(crate) struct WriteRegistration {
    registration: ProjectRegistration,
    prefer: bool,
    now: i64,
    guard: RegistrationGuard,
    new_id: Uuid,
}
impl WriteRegistration {
    fn new(
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
        guard: RegistrationGuard,
        new_id: Uuid,
    ) -> Result<Self> {
        validate_registration(&registration)?;
        Ok(Self {
            registration,
            prefer,
            now: timestamp(now)?,
            guard,
            new_id,
        })
    }
}
impl Statement for WriteRegistration {
    type Value = std::result::Result<ProjectRecord, ProjectError>;
    type Output = Self::Value;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<Self::Value>> {
        let Self {
            registration,
            prefer,
            now,
            guard,
            new_id,
        } = self;
        let existing: Option<String> = connection
            .query_row(
                "SELECT id FROM projects WHERE identity = ?",
                params![&registration.identity],
                |row| row.get(0),
            )
            .optional()?;
        let actual = if matches!(
            &guard,
            RegistrationGuard::Observed(_) | RegistrationGuard::ObservedAvailable(_)
        ) {
            match &existing {
                Some(id) => Some(read(connection, id)?.ok_or(ProjectError::NotFound)?),
                None => None,
            }
        } else {
            None
        };
        match guard {
            RegistrationGuard::Observed(expected) => {
                if actual != expected {
                    return rejected(ProjectError::Changed);
                }
            }
            RegistrationGuard::ObservedAvailable(expected) => {
                if actual != expected {
                    return rejected(ProjectError::Changed);
                }
                if actual
                    .as_ref()
                    .is_some_and(|record| record.archived_at.is_some())
                {
                    return rejected(ProjectError::Archived);
                }
            }
            RegistrationGuard::Available => {
                if let Some(id) = &existing {
                    let archived: Option<i64> = connection.query_row(
                        "SELECT archived_at FROM projects WHERE id=?",
                        params![id],
                        |row| row.get(0),
                    )?;
                    if archived.is_some() {
                        return rejected(ProjectError::Archived);
                    }
                }
            }
            RegistrationGuard::Unconditional => {}
        }
        let id = if let Some(id) = existing {
            connection.execute(
                "UPDATE projects SET last_used_at = MAX(last_used_at, ?) WHERE id = ?",
                params![now, &id],
            )?;
            id
        } else {
            let id = new_id.to_string();
            connection.execute(
                "INSERT INTO projects VALUES (?, ?, ?, ?, NULL)",
                params![&id, &registration.identity, registration.name.trim(), now],
            )?;
            connection.execute(
                "INSERT INTO project_identities VALUES (?, ?)",
                params![&id, &id],
            )?;
            id
        };
        let has_location: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_locations WHERE project_id = ?)",
            params![&id],
            |row| row.get(0),
        )?;
        let used_at = if prefer || !has_location { now } else { 0 };
        connection.execute(
            "INSERT INTO project_locations VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, path) DO UPDATE SET is_worktree = excluded.is_worktree,
            last_used_at = MAX(project_locations.last_used_at, excluded.last_used_at)",
            params![&id, &registration.path, registration.is_worktree, used_at],
        )?;
        let record = read(connection, &id)?.ok_or(ProjectError::NotFound)?;
        Ok(Prepared {
            value: Ok(record),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

struct WriteMutation {
    id: String,
    mutation: ProjectMutation,
    now: i64,
    expected: Option<ProjectRecord>,
}
impl WriteMutation {
    fn new(
        id: &str,
        mutation: ProjectMutation,
        now: u64,
        expected: Option<ProjectRecord>,
    ) -> Result<Self> {
        validate_id(id)?;
        if let ProjectMutation::Rename(name) = &mutation {
            validate_name(name)?;
        }
        Ok(Self {
            id: id.into(),
            mutation,
            now: timestamp(now)?,
            expected,
        })
    }
}
impl Statement for WriteMutation {
    type Value = std::result::Result<ProjectRecord, ProjectError>;
    type Output = Self::Value;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<Self::Value>> {
        let Some(record) = read(connection, &self.id)? else {
            return rejected(ProjectError::NotFound);
        };
        if self
            .expected
            .as_ref()
            .is_some_and(|expected| expected != &record)
        {
            return rejected(ProjectError::Changed);
        }
        match self.mutation {
            ProjectMutation::Rename(name) => {
                connection.execute(
                    "UPDATE projects SET name = ? WHERE id = ?",
                    params![name.trim(), &record.id],
                )?;
            }
            ProjectMutation::Archive => {
                connection.execute(
                    "UPDATE projects SET archived_at = ? WHERE id = ?",
                    params![self.now, &record.id],
                )?;
            }
            ProjectMutation::Restore => {
                connection.execute(
                    "UPDATE projects SET archived_at = NULL WHERE id = ?",
                    params![&record.id],
                )?;
            }
        }
        let record = read(connection, &record.id)?.ok_or(ProjectError::NotFound)?;
        Ok(Prepared {
            value: Ok(record),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

struct WriteSelection {
    id: Uuid,
    identity: String,
    path: String,
    now: i64,
}
impl Statement for WriteSelection {
    type Value = std::result::Result<ProjectRecord, ProjectError>;
    type Output = Self::Value;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<Self::Value>> {
        let id = self.id.to_string();
        let Some(record) = read(connection, &id)? else {
            return rejected(ProjectError::NotFound);
        };
        if record.id != id || record.identity != self.identity {
            return rejected(ProjectError::Changed);
        }
        if record.archived_at.is_some() {
            return rejected(ProjectError::Archived);
        }
        if !record
            .locations
            .iter()
            .any(|location| location.path == self.path)
        {
            return rejected(ProjectError::Unavailable);
        }
        touch(connection, &record.id, &self.path, self.now)?;
        let record = read(connection, &record.id)?.ok_or(ProjectError::NotFound)?;
        Ok(Prepared {
            value: Ok(record),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

fn rejected<T>(error: ProjectError) -> Result<Prepared<std::result::Result<T, ProjectError>>> {
    Ok(Prepared {
        value: Err(error),
        changed: false,
        notification: Notification::NONE,
    })
}

fn touch(connection: &rusqlite::Connection, id: &str, path: &str, now: i64) -> Result<()> {
    if connection.execute(
        "UPDATE project_locations SET last_used_at = MAX(last_used_at, ?)
        WHERE project_id = ? AND path = ?",
        params![now, id, path],
    )? != 1
    {
        return Err(ProjectError::PathMismatch.into());
    }
    connection.execute(
        "UPDATE projects SET last_used_at = MAX(last_used_at, ?) WHERE id = ?",
        params![now, id],
    )?;
    Ok(())
}
