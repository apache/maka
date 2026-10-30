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
use serde::{Deserialize, Serialize};
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::BTreeSet;

/// A frozen lifecycle plan; only Host-owned lineage and authority dependencies
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

/// Host-issued authority, checked against every directly removed family member
/// in the commit transaction. Dependency archival is a consequence of retirement.
pub enum RemovalAuthority {
    Unmanaged,
    Granted {
        namespace: maka_capabilities::storage::Namespace,
        sessions: BTreeSet<String>,
    },
}

impl RemovalAuthority {
    async fn check(
        &self,
        connection: &mut SqliteConnection,
        plan: &RemovalPlan,
    ) -> Result<(), StoreError> {
        for session in &plan.remove {
            let manager: Option<(String, String)> = sqlx::query_as(
                "SELECT package_id,scope_id FROM plugin_sessions WHERE session_id=? AND managed=1",
            )
            .bind(session)
            .fetch_optional(&mut *connection)
            .await?;
            let allowed = match self {
                Self::Unmanaged => manager.is_none(),
                Self::Granted {
                    namespace,
                    sessions,
                } => {
                    sessions.contains(session)
                        && manager.is_none_or(|(package, scope)| {
                            package == namespace.package()
                                && scope == String::from(namespace.scope().clone())
                        })
                }
            };
            if !allowed {
                return Err(StoreError::SessionConflict);
            }
        }
        Ok(())
    }
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
        self.validate_root()?;
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    receipt(&mut tx, &session).await
                })
            })
            .await
    }

    /// Preview is advisory; commit recomputes this plan inside its CAS transaction.
    pub async fn preview_session_removal(&self, session: &str) -> Result<RemovalPlan, StoreError> {
        self.validate_root()?;
        validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    read(&mut tx, &session).await
                })
            })
            .await
    }

    /// Remove the revision family and archive its dependent families atomically.
    /// A retry reads the accepted plan before checking any current metadata.
    pub async fn remove_session_family(
        &self,
        session: &str,
        expected: u64,
        authority: RemovalAuthority,
    ) -> Result<RemoveFamilyResult, StoreError> {
        self.remove_session_family_guarded(session, expected, std::sync::Arc::new(authority), None)
            .await?
            .ok_or_else(|| invalid("unguarded removal changed plan"))
    }

    pub(crate) async fn remove_session_family_guarded(
        &self,
        session: &str,
        expected: u64,
        authority: std::sync::Arc<RemovalAuthority>,
        locked_plan: Option<RemovalPlan>,
    ) -> Result<Option<RemoveFamilyResult>, StoreError> {
        self.validate_root()?;
        validate_id(session)?;
        if expected == 0 || expected > MAX_SAFE_INTEGER {
            return Err(invalid("invalid expected Session revision"));
        }
        let session = session.to_owned();
        let commits = self.commits.notice();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
                    if let Some(plan) = receipt(&mut tx, &session).await? {
                        return Ok(Some(RemoveFamilyResult::Accepted(plan)));
                    }
                    super::require_mutable(&mut tx, &session).await?;
                    let actual =
                        crate::workspace_bindings::current_session_revision(&mut tx, &session)
                            .await?
                            .ok_or(StoreError::SessionNotFound)?;
                    if actual != expected {
                        return Ok(Some(RemoveFamilyResult::RevisionConflict {
                            expected,
                            actual,
                        }));
                    }
                    let plan = read(&mut tx, &session).await?;
                    if locked_plan.as_ref().is_some_and(|locked| locked != &plan) {
                        tx.rollback().await?;
                        return Ok(None);
                    }
                    authority.check(&mut tx, &plan).await?;
                    let mut approval_revoked = false;
                    for target in &plan.remove {
                        approval_revoked |= fence(&mut tx, target, Action::Remove).await?;
                    }
                    for target in &plan.archive {
                        approval_revoked |= fence(&mut tx, target, Action::Archive).await?;
                    }
                    sqlx::query("INSERT INTO session_removal_receipts VALUES (?,?)")
                        .bind(&session)
                        .bind(serde_json::to_string(&plan)?)
                        .execute(&mut *tx)
                        .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)?;
                    if approval_revoked {
                        commits.activations();
                    }
                    commits
                        .for_sessions(plan.remove.iter().chain(&plan.archive).map(String::as_str))
                        .metadata();
                    Ok(Some(RemoveFamilyResult::Accepted(plan)))
                })
            })
            .await
    }
}

async fn receipt(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<RemovalPlan>, StoreError> {
    let receipt: Option<String> =
        sqlx::query_scalar("SELECT plan_json FROM session_removal_receipts WHERE session_id=?")
            .bind(session)
            .fetch_optional(&mut *connection)
            .await?;
    if let Some(receipt) = receipt {
        return Ok(Some(serde_json::from_str(&receipt)?));
    }
    // Another member's removal may already have retired this identity.
    Ok(super::read(connection, session)
        .await?
        .filter(|state| state.removes())
        .map(|_| RemovalPlan {
            remove: vec![session.to_owned()],
            archive: Vec::new(),
            archived_subtask_count: 0,
        }))
}

async fn read(connection: &mut SqliteConnection, session: &str) -> Result<RemovalPlan, StoreError> {
    let rows = sqlx::query(
        "WITH RECURSIVE families AS (
            SELECT s.id, s.archived, COALESCE(c.state,'committed') AS copy_state,
                CASE WHEN json_extract(c.lineage_json,'$.kind')='revision'
                     THEN json_extract(c.lineage_json,'$.root_session_id') ELSE s.id END AS family,
                p.authority_session_id AS parent
            FROM session_control s
            LEFT JOIN session_history_copies c ON c.session_id=s.id
            LEFT JOIN plugin_sessions p ON p.session_id=s.id
            WHERE NOT EXISTS(SELECT 1 FROM session_retirements r
                WHERE r.session_id=s.id AND r.remove_session=1)
        ), root AS (SELECT family FROM families WHERE id=?1), dependents(id) AS (
            SELECT id FROM families WHERE family=(SELECT family FROM root)
            UNION SELECT child.id FROM families child JOIN dependents d
                ON child.parent=d.id OR child.family=d.id
        ) SELECT f.id, f.family, f.archived, f.family=(SELECT family FROM root) AS removes
          FROM families f JOIN dependents d ON f.id=d.id
          WHERE f.copy_state<>'preparing' OR f.id=?1
          ORDER BY removes DESC, f.id",
    )
    .bind(session)
    .fetch_all(connection)
    .await?;
    if rows.is_empty() {
        return Err(StoreError::SessionNotFound);
    }
    let mut plan = RemovalPlan {
        remove: Vec::new(),
        archive: Vec::new(),
        archived_subtask_count: 0,
    };
    let mut archived_families = BTreeSet::new();
    for row in rows {
        let id: String = row.try_get("id")?;
        if row.try_get::<bool, _>("removes")? {
            plan.remove.push(id);
        } else {
            plan.archive.push(id);
            if !row.try_get::<bool, _>("archived")? {
                archived_families.insert(row.try_get::<String, _>("family")?);
            }
        }
    }
    plan.archived_subtask_count = archived_families.len() as u64;
    Ok(plan)
}

pub(super) async fn fence(
    connection: &mut SqliteConnection,
    session: &str,
    action: Action,
) -> Result<bool, StoreError> {
    if let Some(previous) = super::read(connection, session).await? {
        match action {
            Action::Archive => return Ok(false),
            Action::Remove if previous.removes() => return Ok(false),
            Action::Remove => {}
        }
    }
    let remove = matches!(action, Action::Remove);
    sqlx::query(
        "INSERT INTO session_retirements(session_id,remove_session) VALUES (?,?)
        ON CONFLICT(session_id) DO UPDATE SET remove_session=excluded.remove_session, completed=0",
    )
    .bind(session)
    .bind(remove)
    .execute(&mut *connection)
    .await?;
    if !remove {
        sqlx::query("UPDATE session_control SET archived=1 WHERE id=?")
            .bind(session)
            .execute(&mut *connection)
            .await?;
    }
    let approval_revoked = crate::native_approvals::revoke_for_session(
        connection,
        session,
        crate::native_approvals::now_millis()?,
    )
    .await?;
    // Accepted queue identities and payload deletion share the lifecycle commit.
    sqlx::query(
        "INSERT INTO message_cancellations(session_id,message_id,cancellation_id)
        SELECT session_id,message_id,?1 FROM message_admissions WHERE session_id=?1",
    )
    .bind(session)
    .execute(&mut *connection)
    .await?;
    let cancelled = sqlx::query("DELETE FROM message_admissions WHERE session_id=?")
        .bind(session)
        .execute(&mut *connection)
        .await?
        .rows_affected();
    if cancelled > 0 {
        crate::message_queue::bump(connection, session).await?;
    }
    super::super::advance_revision(connection, session).await?;
    Ok(approval_revoked)
}
