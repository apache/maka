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
use uuid::Uuid;

enum RegistrationGuard {
    Unconditional,
    Observed(Option<ProjectRecord>),
    Available,
}

impl EventLog {
    /// Register one resolved identity without rewriting unrelated catalog rows.
    /// Additional non-preferred worktrees do not displace the existing choice.
    pub async fn register_project(
        &self,
        registration: ProjectRegistration,
        prefer: bool,
        now: u64,
    ) -> Result<ProjectRecord> {
        self.register_project_guarded(registration, prefer, now, RegistrationGuard::Unconditional)
            .await
    }

    /// Compare the complete previously observed row (or absence) in the same
    /// transaction that registers this physical project identity.
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

    /// Use the current physical identity only while its logical project is available.
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
        validate_registration(&registration)?;
        let now = timestamp(now)?;
        self.connection
            .write(
                WriteRegistration {
                    registration,
                    prefer,
                    now,
                    guard,
                },
                self.commits.notice(),
            )
            .await
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
        validate_id(id)?;
        let now = timestamp(now)?;
        if let ProjectMutation::Rename(name) = &mutation {
            validate_name(name)?;
        }
        let id = id.to_owned();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let record = read(&tx, &id)?.ok_or(ProjectError::NotFound)?;
                if expected
                    .as_ref()
                    .is_some_and(|expected| expected != &record)
                {
                    return Err(ProjectError::Changed.into());
                }
                match mutation {
                    ProjectMutation::Rename(name) => {
                        tx.execute(
                            "UPDATE projects SET name = ? WHERE id = ?",
                            params![name.trim(), &record.id],
                        )?;
                    }
                    ProjectMutation::Archive => {
                        tx.execute(
                            "UPDATE projects SET archived_at = ? WHERE id = ?",
                            params![now, &record.id],
                        )?;
                    }
                    ProjectMutation::Restore => {
                        tx.execute(
                            "UPDATE projects SET archived_at = NULL WHERE id = ?",
                            params![&record.id],
                        )?;
                    }
                }
                let record = read(&tx, &record.id)?.ok_or(ProjectError::NotFound)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(record)
            })
            .await
    }

    /// The Host probes paths outside SQL and holds its membership admission gate.
    /// The transaction still rechecks both identity and location membership.
    pub async fn select_project(
        &self,
        id: &str,
        available_paths: Vec<String>,
        now: u64,
    ) -> Result<(ProjectRecord, String)> {
        self.select_project_guarded(id, available_paths, now, None)
            .await
    }

    pub async fn select_project_if(
        &self,
        expected: ProjectRecord,
        available_paths: Vec<String>,
        now: u64,
    ) -> Result<(ProjectRecord, String)> {
        let id = expected.id.clone();
        self.select_project_guarded(&id, available_paths, now, Some(expected))
            .await
    }

    async fn select_project_guarded(
        &self,
        id: &str,
        available_paths: Vec<String>,
        now: u64,
        expected: Option<ProjectRecord>,
    ) -> Result<(ProjectRecord, String)> {
        validate_id(id)?;
        let now = timestamp(now)?;
        let id = id.to_owned();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let record = read(&tx, &id)?.ok_or(ProjectError::NotFound)?;
                if expected
                    .as_ref()
                    .is_some_and(|expected| expected != &record)
                {
                    return Err(ProjectError::Changed.into());
                }
                if record.archived_at.is_some() {
                    return Err(ProjectError::Archived.into());
                }
                let location = record
                    .locations
                    .iter()
                    .filter(|location| available_paths.contains(&location.path))
                    .min_by(|a, b| {
                        b.last_used_at
                            .cmp(&a.last_used_at)
                            .then_with(|| a.path.cmp(&b.path))
                    })
                    .ok_or(ProjectError::Unavailable)?;
                let path = location.path.clone();
                touch(&tx, &record.id, &path, now)?;
                let record = read(&tx, &record.id)?.ok_or(ProjectError::NotFound)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok((record, path))
            })
            .await
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
}

impl crate::writeback::Statement for WriteRegistration {
    type Value = ProjectRecord;
    type Output = ProjectRecord;

    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> Result<crate::writeback::Prepared<ProjectRecord>> {
        {
            let Self {
                registration,
                prefer,
                now,
                guard,
            } = self;
            let existing: Option<String> = connection
                .query_row(
                    "SELECT id FROM projects WHERE identity = ?",
                    params![&registration.identity],
                    |row| row.get(0),
                )
                .optional()?;
            if let RegistrationGuard::Observed(expected) = guard {
                let actual = match &existing {
                    Some(id) => read(connection, id)?,
                    None => None,
                };
                if actual != expected {
                    return Err(ProjectError::Changed.into());
                }
            } else if matches!(guard, RegistrationGuard::Available)
                && let Some(id) = &existing
            {
                let archived: Option<i64> = connection.query_row(
                    "SELECT archived_at FROM projects WHERE id=?",
                    params![id],
                    |row| row.get(0),
                )?;
                if archived.is_some() {
                    return Err(ProjectError::Archived.into());
                }
            }
            let id = if let Some(id) = existing {
                connection.execute(
                    "UPDATE projects SET last_used_at = MAX(last_used_at, ?) WHERE id = ?",
                    params![now, &id],
                )?;
                id
            } else {
                let id = Uuid::new_v4().to_string();
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
            Ok(crate::writeback::Prepared {
                value: record,
                changed: true,
                notification: crate::writeback::Notification::NONE,
            })
        }
    }

    fn committed(value: ProjectRecord) -> ProjectRecord {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::Project(ProjectError::Changed | ProjectError::Archived)
        )
    }
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
