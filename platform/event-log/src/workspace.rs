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

use crate::{EventLog, StoreError};
use sqlx::{Connection, Row};

/// Execution evidence for Sessions sharing an exact canonical working directory.
/// Membership follows the current shared binding, not historical inline paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceFence(pub Vec<WorkspaceSession>);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceSession {
    pub session_id: String,
    pub revision: i64,
    pub event_sequence: i64,
    pub orphaned_shells: bool,
}

impl EventLog {
    /// Ownership, not quiescence: another retained Session keeps a managed
    /// checkout alive regardless of how many past users shared that directory.
    pub async fn workspace_has_other_session(
        &self,
        cwd: &str,
        session: &str,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let (cwd, session) = (cwd.to_owned(), session.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM workspace_bindings binding
                         JOIN session_control session INDEXED BY session_workspace_binding
                         ON json_extract(session.configuration,'$.workspace.id')=binding.id
                         WHERE json_extract(binding.workspace_json,'$.path')=? AND session.id<>?)",
                    )
                    .bind(cwd)
                    .bind(session)
                    .fetch_one(connection)
                    .await?)
                })
            })
            .await
    }

    pub async fn workspace_fence(&self, cwd: &str) -> Result<WorkspaceFence, StoreError> {
        self.validate_root()?;
        let cwd = cwd.to_owned();
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let rows = sqlx::query(
                "SELECT s.id, s.revision,
                 b.metadata_epoch,json_extract(s.configuration,'$.workspace.metadataEpochAtAttach') AS attached_epoch,
                 COALESCE((SELECT MAX(e.sequence) FROM runtime_events e WHERE
                    (e.event_json IS NOT NULL AND e.event_session=s.id)), 0) AS sequence,
                 EXISTS(SELECT 1 FROM shell_runs r WHERE r.session_id = s.id AND
                    json_extract(r.record_json, '$.state.outcome.kind') = 'orphaned') AS orphaned
                 FROM workspace_bindings b
                 JOIN session_control s INDEXED BY session_workspace_binding
                 ON json_extract(s.configuration,'$.workspace.id')=b.id
                 WHERE json_extract(b.workspace_json,'$.path') = ?
                 ORDER BY s.id"
            ).bind(cwd).fetch_all(&mut *tx).await?;
            let mut result = Vec::with_capacity(rows.len());
            for row in rows {
                let local: i64 = row.try_get("revision")?;
                let current: i64 = row.try_get("metadata_epoch")?;
                let attached: i64 = row.try_get("attached_epoch")?;
                let revision = current.checked_sub(attached).filter(|delta| *delta >= 0)
                    .and_then(|delta| local.checked_add(delta))
                    .filter(|revision| (0..=maka_agent_facts::interaction::MAX_SAFE_INTEGER as i64).contains(revision))
                    .ok_or_else(|| StoreError::InvalidTransition("invalid effective workspace Session revision".into()))?;
                result.push(WorkspaceSession {
                    session_id: row.try_get("id")?, revision,
                    event_sequence: row.try_get("sequence")?, orphaned_shells: row.try_get("orphaned")?,
                });
            }
            tx.commit().await?;
            Ok(WorkspaceFence(result))
        })).await
    }
}
