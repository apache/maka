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
use rusqlite::{OptionalExtension, params};

use crate::sessions::advance_catalog;
use crate::writeback::{Notification, Prepared, Statement};
use serde_json::Value;

#[derive(Debug)]
pub struct ProjectRelink {
    pub project: ProjectRecord,
    pub updated_bindings: usize,
}

/// Exact source and destination observations plus the only Session namespace
/// whose shared workspace selections this owner may relocate.
#[derive(Clone, Debug)]
pub struct ProjectRelinkGuard {
    pub source: ProjectRecord,
    pub destination: Option<ProjectRecord>,
    pub owner_scope: String,
}

impl EventLog {
    pub async fn relink_project(
        &self,
        id: &str,
        owner_scope: &str,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<ProjectRelink> {
        self.relink_project_guarded(id, owner_scope, registration, now, selected_workspace, None)
            .await
    }
    pub async fn relink_project_if(
        &self,
        guard: ProjectRelinkGuard,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<ProjectRelink> {
        self.relink_project_guarded(
            &guard.source.id.clone(),
            &guard.owner_scope.clone(),
            registration,
            now,
            selected_workspace,
            Some(guard),
        )
        .await
    }
    async fn relink_project_guarded(
        &self,
        id: &str,
        owner_scope: &str,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
        guard: Option<ProjectRelinkGuard>,
    ) -> Result<ProjectRelink> {
        self.connection
            .write(
                WriteRelink::new(
                    id,
                    owner_scope,
                    registration,
                    now,
                    selected_workspace,
                    guard,
                )?,
                self.commits.notice(),
            )
            .await?
            .map_err(StoreError::Project)
    }
    pub(crate) fn prepare_project_relink(
        guard: ProjectRelinkGuard,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
    ) -> Result<
        impl Statement<
            Value = std::result::Result<ProjectRelink, ProjectError>,
            Output = std::result::Result<ProjectRelink, ProjectError>,
        >,
    > {
        WriteRelink::new(
            &guard.source.id.clone(),
            &guard.owner_scope.clone(),
            registration,
            now,
            selected_workspace,
            Some(guard),
        )
    }
}

struct WriteRelink {
    id: String,
    owner_scope: String,
    registration: ProjectRegistration,
    now: i64,
    selected_workspace: Value,
    guard: Option<ProjectRelinkGuard>,
}
impl WriteRelink {
    fn new(
        id: &str,
        owner_scope: &str,
        registration: ProjectRegistration,
        now: u64,
        selected_workspace: Value,
        guard: Option<ProjectRelinkGuard>,
    ) -> Result<Self> {
        if owner_scope.is_empty() {
            return Err(invalid("invalid project owner scope"));
        }
        validate_id(id)?;
        validate_registration(&registration)?;
        if !selected_workspace.is_object() {
            return Err(invalid("invalid relocated workspace"));
        }
        Ok(Self {
            id: id.into(),
            owner_scope: owner_scope.into(),
            registration,
            now: timestamp(now)?,
            selected_workspace,
            guard,
        })
    }
}
impl Statement for WriteRelink {
    type Value = std::result::Result<ProjectRelink, ProjectError>;
    type Output = Self::Value;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<Self::Value>> {
        let Self {
            id,
            owner_scope,
            registration,
            now,
            selected_workspace,
            guard,
        } = self;
        let Some(project) = read(connection, &id)? else {
            return Ok(Prepared {
                value: Err(ProjectError::NotFound),
                changed: false,
                notification: Notification::NONE,
            });
        };
        let conflict_id: Option<String> = connection
            .query_row(
                "SELECT id FROM projects WHERE identity = ? AND id != ?",
                params![&registration.identity, &project.id],
                |row| row.get(0),
            )
            .optional()?;
        let conflict = match conflict_id {
            Some(id) => Some(read(connection, &id)?.ok_or(ProjectError::NotFound)?),
            None => None,
        };
        if let Some(guard) = &guard {
            let destination = if project.identity == registration.identity {
                Some(&project)
            } else {
                conflict.as_ref()
            };
            if guard.source != project || guard.destination.as_ref() != destination {
                return Ok(Prepared {
                    value: Err(ProjectError::Changed),
                    changed: false,
                    notification: Notification::NONE,
                });
            }
        }
        let (updated_bindings, permission_changed) = reassign_bindings(
            connection,
            &project,
            conflict.as_ref(),
            &owner_scope,
            selected_workspace,
            now as u64,
        )?;
        connection.execute(
            "DELETE FROM project_locations WHERE project_id = ?",
            params![&project.id],
        )?;
        if let Some(conflict) = &conflict {
            // Move identities before deleting their former owner; the unique
            // namespace prevents alias collisions throughout the transaction.
            connection.execute(
                "UPDATE project_identities SET project_id = ? WHERE project_id = ?",
                params![&project.id, &conflict.id],
            )?;
            connection.execute(
                "INSERT INTO project_locations
                    SELECT ?, path, is_worktree, last_used_at FROM project_locations
                    WHERE project_id = ? AND path != ?",
                params![&project.id, &conflict.id, &registration.path],
            )?;
            connection.execute("DELETE FROM projects WHERE id = ?", params![&conflict.id])?;
        }
        connection.execute(
            "INSERT INTO project_locations VALUES (?, ?, ?, ?)",
            params![
                &project.id,
                &registration.path,
                registration.is_worktree,
                now
            ],
        )?;
        let last_used = now.max(project.last_used_at as i64).max(
            conflict
                .as_ref()
                .map_or(0, |record| record.last_used_at as i64),
        );
        connection.execute(
            "UPDATE projects SET identity = ?, last_used_at = ? WHERE id = ?",
            params![&registration.identity, last_used, &project.id],
        )?;
        let project = read(connection, &project.id)?.ok_or(ProjectError::NotFound)?;

        let notification = if updated_bindings == 0 {
            Notification::NONE
        } else {
            Notification::metadata_scope(owner_scope).with_activation(permission_changed)
        };
        Ok(Prepared {
            value: Ok(ProjectRelink {
                project,
                updated_bindings,
            }),
            changed: true,
            notification,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

fn reassign_bindings(
    connection: &rusqlite::Connection,
    source: &ProjectRecord,
    absorbed: Option<&ProjectRecord>,
    owner_scope: &str,
    mut selected_workspace: Value,
    now: u64,
) -> Result<(usize, bool)> {
    if !selected_workspace.is_object() {
        return Err(invalid("invalid relocated workspace"));
    }
    selected_workspace["projectId"] = Value::String(source.id.clone());
    let mut updated = 0usize;
    let mut permission_changed = false;
    for (project, relocation) in
        std::iter::once((source, true)).chain(absorbed.map(|project| (project, false)))
    {
        for project_id in std::iter::once(&project.id).chain(&project.aliases) {
            let mut cursor = String::new();
            loop {
                let rows: Vec<(String, String)> = connection
                    .prepare_cached(
                        "SELECT id,workspace_json FROM workspace_bindings
                     WHERE owner_scope=? AND json_extract(workspace_json,'$.projectId')=? AND id>?
                     ORDER BY id LIMIT 32",
                    )?
                    .query_map(params![owner_scope, project_id, &cursor], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                if rows.is_empty() {
                    break;
                }
                for (id, encoded) in rows {
                    cursor.clone_from(&id);
                    let workspace = if relocation {
                        selected_workspace.clone()
                    } else {
                        let mut workspace: Value = serde_json::from_str(&encoded)?;
                        workspace["projectId"] = Value::String(source.id.clone());
                        workspace
                    };
                    let binding_id = uuid::Uuid::parse_str(&id)
                        .map_err(|_| invalid("invalid workspace binding ID"))?;
                    crate::workspace_bindings::replace(
                        connection, binding_id, workspace, relocation,
                    )?;
                    if relocation {
                        permission_changed = true;
                    }
                    updated = updated
                        .checked_add(1)
                        .ok_or_else(|| invalid("workspace binding count exhausted"))?;
                }
            }
        }
    }
    if updated != 0 {
        advance_catalog(connection)?;
    }
    Ok((updated, permission_changed))
}
