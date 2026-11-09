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

//! Durable Project membership and locations. Availability is a filesystem
//! observation supplied by the Host; these records never become model history.

mod mutation;
mod relink;

use crate::{EventLog, StoreError};
pub use relink::{ProjectRelink, ProjectRelinkGuard};
use rusqlite::{OptionalExtension, params};
use std::collections::BTreeMap;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("project changed since it was observed")]
    Changed,
    #[error("project not found")]
    NotFound,
    #[error("project is archived")]
    Archived,
    #[error("project has no available registered location")]
    Unavailable,
    #[error("path does not belong to the project")]
    PathMismatch,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ProjectLocation {
    pub path: String,
    pub is_worktree: bool,
    pub last_used_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ProjectRecord {
    pub id: String,
    pub aliases: Vec<String>,
    /// Domain identity of a folder or shared Git directory, optionally scoped
    /// by its owning service. This is not the workspace UUID.
    pub identity: String,
    pub name: String,
    pub locations: Vec<ProjectLocation>,
    pub last_used_at: u64,
    pub archived_at: Option<u64>,
}

/// Filesystem resolution belongs to the Host. Persistence validates the shape
/// but does not authorize a path or claim that a directory still exists.
#[derive(Clone, Debug)]
pub struct ProjectRegistration {
    pub identity: String,
    pub name: String,
    pub path: String,
    pub is_worktree: bool,
}

#[derive(Clone, Debug)]
pub enum ProjectMutation {
    Rename(String),
    Archive,
    Restore,
}

impl EventLog {
    pub async fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        self.project_catalog(None).await
    }

    /// Select an owning service's logical identity namespace in the same SQL
    /// snapshot as its locations and aliases. The prefix is data, not a grant.
    pub async fn projects_with_identity_prefix(&self, prefix: &str) -> Result<Vec<ProjectRecord>> {
        validate_text(prefix)?;
        self.project_catalog(Some(prefix.to_owned())).await
    }

    async fn project_catalog(&self, prefix: Option<String>) -> Result<Vec<ProjectRecord>> {
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let mut projects = read_all(&tx, prefix.as_deref())?;
                projects.sort_by(|a, b| {
                    a.archived_at
                        .is_some()
                        .cmp(&b.archived_at.is_some())
                        .then_with(|| b.last_used_at.cmp(&a.last_used_at))
                        .then_with(|| a.id.cmp(&b.id))
                });
                Ok(projects)
            })
            .await
    }

    pub async fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>> {
        validate_id(id)?;
        let id = id.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                read(&tx, &id)
            })
            .await
    }
}

fn read_all(connection: &rusqlite::Connection, prefix: Option<&str>) -> Result<Vec<ProjectRecord>> {
    let rows = connection.prepare_cached("SELECT id, identity, name, last_used_at, archived_at FROM projects WHERE (?1 IS NULL OR instr(identity, ?1)=1) ORDER BY id")?.query_map(params![prefix],|row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?,row.get::<_, Option<i64>>(4)?,)))?.collect::<std::result::Result<Vec<_>, _>>()
    ?;
    let mut records = BTreeMap::new();
    for row in rows {
        let id: String = row.0;
        records.insert(
            id.clone(),
            ProjectRecord {
                id,
                identity: row.1,
                name: row.2,
                last_used_at: number(row.3)?,
                archived_at: row.4.map(number).transpose()?,
                aliases: Vec::new(),
                locations: Vec::new(),
            },
        );
    }
    for row in connection.prepare_cached("SELECT a.id, a.project_id FROM project_identities a JOIN projects p ON p.id=a.project_id WHERE a.id != a.project_id AND (?1 IS NULL OR instr(p.identity, ?1)=1) ORDER BY a.id")?.query_map(params![prefix],|row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,)))?.collect::<std::result::Result<Vec<_>, _>>()
    ?
    {
        let owner: String = row.1;
        records
            .get_mut(&owner)
            .ok_or_else(|| invalid("orphan project identity"))?
            .aliases
            .push(row.0);
    }
    for row in connection.prepare_cached("SELECT l.project_id, l.path, l.is_worktree, l.last_used_at FROM project_locations l JOIN projects p ON p.id=l.project_id WHERE (?1 IS NULL OR instr(p.identity, ?1)=1) ORDER BY l.path")?.query_map(params![prefix],|row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, bool>(2)?,row.get::<_, i64>(3)?,)))?.collect::<std::result::Result<Vec<_>, _>>()
    ?
    {
        let owner: String = row.0;
        records
            .get_mut(&owner)
            .ok_or_else(|| invalid("orphan project location"))?
            .locations
            .push(ProjectLocation {
                path: row.1,
                is_worktree: row.2,
                last_used_at: number(row.3)?,
            });
    }
    Ok(records.into_values().collect())
}

fn read(connection: &rusqlite::Connection, id: &str) -> Result<Option<ProjectRecord>> {
    let canonical: Option<String> = connection
        .query_row(
            "SELECT project_id FROM project_identities WHERE id = ?",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = canonical else {
        return Ok(None);
    };
    let row = connection.query_row(
        "SELECT identity, name, last_used_at, archived_at FROM projects WHERE id = ?",
        params![&id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        },
    )?;
    let aliases = connection
        .prepare_cached(
            "SELECT id FROM project_identities WHERE project_id = ? AND id != ? ORDER BY id",
        )?
        .query_map(params![&id, &id], |row| row.get(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let rows = connection.prepare_cached("SELECT path, is_worktree, last_used_at FROM project_locations WHERE project_id = ? ORDER BY path")?.query_map(params![&id],|row| Ok((row.get::<_, String>(0)?,row.get::<_, bool>(1)?,row.get::<_, i64>(2)?,)))?.collect::<std::result::Result<Vec<_>, _>>()?;
    let locations = rows
        .into_iter()
        .map(|row| {
            Ok(ProjectLocation {
                path: row.0,
                is_worktree: row.1,
                last_used_at: number(row.2)?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(Some(ProjectRecord {
        id,
        aliases,
        locations,
        identity: row.0,
        name: row.1,
        last_used_at: number(row.2)?,
        archived_at: row.3.map(number).transpose()?,
    }))
}

fn validate_registration(registration: &ProjectRegistration) -> Result<()> {
    validate_text(&registration.identity)?;
    validate_name(&registration.name)?;
    validate_text(&registration.path)
}

fn validate_id(id: &str) -> Result<()> {
    crate::sessions::validate_id(id).map_err(|_| invalid("invalid project ID"))
}

fn validate_name(name: &str) -> Result<()> {
    validate_text(name)?;
    if name.trim().is_empty() {
        return Err(invalid("empty project name"));
    }
    Ok(())
}

fn validate_text(text: &str) -> Result<()> {
    if text.is_empty() || text.contains('\0') {
        return Err(invalid("invalid project text"));
    }
    Ok(())
}

fn number(number: i64) -> Result<u64> {
    if !(0..=MAX_SAFE_INTEGER as i64).contains(&number) {
        return Err(invalid("project number exceeds safe integer range"));
    }
    Ok(number as u64)
}

fn timestamp(now: u64) -> Result<i64> {
    if now > MAX_SAFE_INTEGER {
        return Err(invalid("project timestamp exceeds safe integer range"));
    }
    Ok(now as i64)
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
