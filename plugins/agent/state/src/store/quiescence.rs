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

//! Read-only retirement preconditions over the existing transactional indexes.
use super::*;
use rusqlite::params;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionObligation {
    QueuedInput,
    LocalRun,
    Interaction,
    Model,
    Tool,
    Wait,
    ExternalTask,
    ExternalEffect,
    ExternalPublication,
    ExternalSteering,
    Cell,
    CellNotification,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionQuiescence {
    Quiescent,
    Busy(SessionObligation),
}
impl SessionQuiescence {
    pub fn is_quiescent(self) -> bool {
        matches!(self, Self::Quiescent)
    }
}

/// An original-Root read capability, not an idle certificate. Retirement must
/// recheck it on the committing Connection and separately drain physical work.
#[derive(Clone)]
pub struct SessionQuiescenceGuard {
    data: DataWriter,
    owner: RunOwner,
    session: String,
}
impl Store {
    pub fn quiescence_guard(
        &self,
        owner: RunOwner,
        session: String,
    ) -> Result<SessionQuiescenceGuard, StoreError> {
        if owner.deployment.is_nil() || session.is_empty() {
            return Err(invalid("missing session quiescence namespace"));
        }
        owner
            .namespace
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        Ok(SessionQuiescenceGuard {
            data: self.data.clone(),
            owner,
            session,
        })
    }

    pub async fn session_quiescence(
        &self,
        owner: RunOwner,
        session: String,
    ) -> Result<SessionQuiescence, StoreError> {
        self.quiescence_guard(owner, session)?.observe().await
    }
}
impl SessionQuiescenceGuard {
    /// The Root composition checks actual owner affinity against this writer;
    /// a serialized Root id or a Connection pointer is not that check.
    pub fn data_writer(&self) -> &DataWriter {
        &self.data
    }
    pub fn owner(&self) -> &RunOwner {
        &self.owner
    }
    pub fn session(&self) -> &str {
        &self.session
    }

    pub async fn observe(&self) -> Result<SessionQuiescence, StoreError> {
        self.data
            .query(ReadQuiescence(self.owner.clone(), self.session.clone()))
            .await
    }

    pub fn validate(&self, c: &Connection) -> Result<(), StoreError> {
        if observe(c, &self.owner, &self.session)?.is_quiescent() {
            Ok(())
        } else {
            Err(StoreError::SessionBusy)
        }
    }
}
struct ReadQuiescence(RunOwner, String);
impl Query for ReadQuiescence {
    type Output = SessionQuiescence;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        observe(c, &self.0, &self.1)
    }
}

fn observe(
    c: &Connection,
    owner: &RunOwner,
    session: &str,
) -> Result<SessionQuiescence, StoreError> {
    let owner = serde_json::to_string(owner)?;
    // Each check uses the existing session/run/pending indexes. Imported and
    // forked records are evidence, never local runtime obligations.
    let checks = [
        (
            SessionObligation::QueuedInput,
            "SELECT EXISTS(SELECT 1 FROM agent_queue_items WHERE owner=?1 AND session=?2 AND state='pending')",
        ),
        (
            SessionObligation::LocalRun,
            "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE owner=?1 AND session=?2 AND local=1 AND terminal IS NULL)",
        ),
        (
            SessionObligation::Interaction,
            "SELECT EXISTS(SELECT 1 FROM agent_interaction_pending p JOIN agent_interaction_requests i ON i.request=p.request JOIN agent_runs r ON r.run=i.run WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND r.stopped=0 AND r.terminal IS NULL)",
        ),
        (
            SessionObligation::Model,
            "SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND EXISTS(SELECT 1 FROM agent_attempts a WHERE a.run=r.run AND a.pending=1))",
        ),
        (
            SessionObligation::Tool,
            "SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND EXISTS(SELECT 1 FROM agent_tools t WHERE t.run=r.run AND t.pending=1))",
        ),
        (
            SessionObligation::Wait,
            "SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND json_extract(r.terminal,'$') IS NOT 'cancelled' AND EXISTS(SELECT 1 FROM agent_waits w WHERE w.run=r.run AND w.pending=1))",
        ),
        (
            SessionObligation::ExternalTask,
            "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE owner=?1 AND session=?2 AND local=1 AND json_extract(external,'$.admitted')=1 AND ((json_extract(external,'$.closed') IS NULL AND json_extract(terminal,'$') IS NOT 'cancelled') OR json_extract(external,'$.cleanup.kind') IS NOT 'confirmed'))",
        ),
        (
            SessionObligation::ExternalEffect,
            "SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND EXISTS(SELECT 1 FROM agent_external_effects e WHERE e.run=r.run AND e.pending=1))",
        ),
        (
            SessionObligation::ExternalSteering,
            "SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.owner=?1 AND r.session=?2 AND r.local=1 AND EXISTS(SELECT 1 FROM agent_external_steering s WHERE s.run=r.run AND s.admitted_fact IS NULL))",
        ),
        (
            SessionObligation::CellNotification,
            "SELECT EXISTS(SELECT 1 FROM agent_cell_notifications n LEFT JOIN agent_runs r ON r.run=n.run WHERE n.session=?2 AND n.consumed_step IS NULL AND (n.run IS NULL OR (r.owner=?1 AND r.local=1 AND r.terminal IS NULL)))",
        ),
    ];
    for (obligation, sql) in checks {
        let busy: bool = c
            .prepare_cached(sql)?
            .query_row(params![owner, session], |r| r.get(0))?;
        if busy {
            return Ok(SessionQuiescence::Busy(obligation));
        }
    }
    let mut publications=c.prepare_cached("SELECT r.run FROM agent_runs r JOIN agent_external_publications p ON p.run=r.run WHERE r.owner=?1 AND r.session=?2 AND r.local=1")?;
    let mut publication_rows = publications.query(params![owner, session])?;
    while let Some(row) = publication_rows.next()? {
        let run: RunId = serde_json::from_value(serde_json::Value::String(row.get(0)?))?;
        let view = crate::sql::load(c, run, &[], false)?;
        if !crate::external_publication::quiescent(&view) {
            return Ok(SessionQuiescence::Busy(
                SessionObligation::ExternalPublication,
            ));
        }
    }
    let mut cells=c.prepare_cached("SELECT c.body,r.terminal FROM agent_cells c LEFT JOIN agent_runs r ON r.run=c.run WHERE c.session=?2 AND c.pending=1 AND (c.run IS NULL OR (r.owner=?1 AND r.local=1))")?;
    let mut rows = cells.query(params![owner, session])?;
    while let Some(row) = rows.next()? {
        let cell: maka_agent_facts::cells::CellView =
            serde_json::from_str(&row.get::<_, String>(0)?)?;
        let terminal: Option<Terminal> = row
            .get::<_, Option<String>>(1)?
            .map(|body| serde_json::from_str(&body))
            .transpose()?;
        if cell.blocks_session_retirement(terminal.as_ref()) {
            return Ok(SessionQuiescence::Busy(SessionObligation::Cell));
        }
    }
    Ok(SessionQuiescence::Quiescent)
}
