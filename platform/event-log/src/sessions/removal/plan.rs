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

use super::{EventLog, MAX_SAFE_INTEGER, StoreError, invalid, validate_id};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// A frozen lifecycle plan; only Host-owned authority dependencies
/// participate. Plugin business identifiers and display labels are irrelevant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemovalPlan {
    pub remove: Vec<String>,
    pub archive: Vec<String>,
    pub archived_subtask_count: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RemoveFamilyResult {
    Accepted(RemovalPlan),
    RevisionConflict { expected: u64, actual: u64 },
}

pub(super) enum Action {
    Remove,
    Archive,
}

impl EventLog {
    /// Read an accepted removal without requiring the removed catalog record.
    pub async fn session_removal_receipt(
        &self,
        session: &str,
    ) -> Result<Option<RemovalPlan>, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                receipt(&tx, &session)
            })
            .await
    }

    /// Preview is advisory; commit recomputes this plan inside its CAS transaction.
    pub async fn preview_session_removal(&self, session: &str) -> Result<RemovalPlan, StoreError> {
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                read(&tx, &session)
            })
            .await
    }

    /// Retire a Session and archive its authority-dependent descendants atomically.
    /// A retry reads the accepted plan before checking any current metadata.
    pub async fn remove_session_family(
        &self,
        session: &str,
        expected: u64,
    ) -> Result<RemoveFamilyResult, StoreError> {
        self.remove_session_family_guarded(session, expected, None)
            .await?
            .ok_or_else(|| invalid("unguarded removal changed plan"))
    }

    pub(crate) async fn remove_session_family_guarded(
        &self,
        session: &str,
        expected: u64,
        locked_plan: Option<RemovalPlan>,
    ) -> Result<Option<RemoveFamilyResult>, StoreError> {
        validate_id(session)?;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return Err(invalid("invalid expected Session revision"));
        }
        let session = session.to_owned();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                if let Some(plan) = receipt(&tx, &session)? {
                    return Ok(Some(RemoveFamilyResult::Accepted(plan)));
                }
                super::require_mutable(&tx, &session)?;
                let actual = crate::workspace_bindings::current_session_revision(&tx, &session)?
                    .ok_or(StoreError::SessionNotFound)?;
                if actual != expected {
                    return Ok(Some(RemoveFamilyResult::RevisionConflict {
                        expected,
                        actual,
                    }));
                }
                let plan = read(&tx, &session)?;
                if locked_plan.as_ref().is_some_and(|locked| locked != &plan) {
                    tx.rollback()?;
                    return Ok(None);
                }
                for target in &plan.remove {
                    fence(&tx, target, Action::Remove)?;
                }
                for target in &plan.archive {
                    fence(&tx, target, Action::Archive)?;
                }
                tx.execute(
                    "INSERT INTO session_removal_receipts VALUES (?,?)",
                    params![&session, serde_json::to_string(&plan)?],
                )?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                commits
                    .for_sessions(plan.remove.iter().chain(&plan.archive).map(String::as_str))
                    .metadata();
                Ok(Some(RemoveFamilyResult::Accepted(plan)))
            })
            .await
    }
}

fn receipt(
    connection: &rusqlite::Connection,
    session: &str,
) -> Result<Option<RemovalPlan>, StoreError> {
    let receipt: Option<String> = connection
        .query_row(
            "SELECT plan_json FROM session_removal_receipts WHERE session_id=?",
            params![session],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(receipt) = receipt {
        return Ok(Some(serde_json::from_str(&receipt)?));
    }
    // Another member's removal may already have retired this identity.
    Ok(super::read(connection, session)?
        .filter(|state| state.removes())
        .map(|_| RemovalPlan {
            remove: vec![session.to_owned()],
            archive: Vec::new(),
            archived_subtask_count: 0,
        }))
}

fn read(connection: &rusqlite::Connection, session: &str) -> Result<RemovalPlan, StoreError> {
    let rows = connection
        .prepare_cached(
            "WITH RECURSIVE dependents(id) AS (
                SELECT id FROM session_control WHERE id=?1
                  AND NOT EXISTS(SELECT 1 FROM session_retirements r
                    WHERE r.session_id=id AND r.remove_session=1)
                UNION
                SELECT child.id FROM dependents d
                  JOIN plugin_sessions p ON p.authority_session_id=d.id
                  JOIN session_control child ON child.id=p.session_id
                  WHERE NOT EXISTS(SELECT 1 FROM session_retirements r
                    WHERE r.session_id=child.id AND r.remove_session=1)
            ) SELECT s.id, s.archived, s.id=?1 AS removes
              FROM dependents d JOIN session_control s ON s.id=d.id
              ORDER BY removes DESC, s.id",
        )?
        .query_map(params![session], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        return Err(StoreError::SessionNotFound);
    }
    let mut plan = RemovalPlan {
        remove: Vec::new(),
        archive: Vec::new(),
        archived_subtask_count: 0,
    };
    for row in rows {
        let id: String = row.0;
        if row.2 {
            plan.remove.push(id);
        } else {
            plan.archive.push(id);
            if !row.1 {
                plan.archived_subtask_count += 1;
            }
        }
    }
    Ok(plan)
}

pub(super) fn fence(
    connection: &rusqlite::Connection,
    session: &str,
    action: Action,
) -> Result<(), StoreError> {
    if let Some(previous) = super::read(connection, session)? {
        match action {
            Action::Archive => return Ok(()),
            Action::Remove if previous.removes() => return Ok(()),
            Action::Remove => {}
        }
    }
    let remove = matches!(action, Action::Remove);
    connection.execute(
        "INSERT INTO session_retirements(session_id,remove_session) VALUES (?,?)
        ON CONFLICT(session_id) DO UPDATE SET remove_session=excluded.remove_session, completed=0",
        params![session, remove],
    )?;
    if !remove {
        connection.execute(
            "UPDATE session_control SET archived=1 WHERE id=?",
            params![session],
        )?;
    }
    super::super::advance_revision(connection, session)
}
