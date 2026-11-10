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

use super::{Store, invalid};
use crate::{
    external_effects::ExternalEffect,
    external_publication,
    fold::{self, Attempt, ExternalTask, Tool},
};
use maka_agent_facts::operation::RecordedReceipt as Receipt;
use maka_agent_facts::{cells::CellView, durable::*, external_publication::ExternalPublicationKey};
use maka_event_log::{StoreError, connection::Query, root_store::DataWriter};
use maka_plugin_core::operation::OperationCleanup;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, de::DeserializeOwned};
use std::collections::BTreeSet;

impl Store {
    /// Counts admitted operations, not the queue messages aggregated into each operation.
    pub async fn external_steering_admitted_batches(
        &self,
        execution: ExecutionIdentity,
        task: ExternalTaskId,
    ) -> Result<u64, StoreError> {
        self.data
            .query_barrier(ExternalSteeringAdmittedBatches { execution, task })
            .await
    }

    pub async fn latest_message_backend(
        &self,
        owner: RunOwner,
        session: String,
    ) -> Result<Option<(RunId, BackendSpec)>, StoreError> {
        validate_owner(&owner)?;
        if session.is_empty() {
            return Err(invalid("missing message backend session"));
        }
        self.data
            .query_barrier(LatestMessageBackend(owner, session))
            .await
    }

    /// Frozen durable references only. The Native catalog owner must separately
    /// protect snapshots acquired in memory across this read and its final GC.
    pub async fn referenced_mcp_revisions(
        &self,
        owner: RunOwner,
    ) -> Result<BTreeSet<String>, StoreError> {
        validate_owner(&owner)?;
        self.data.query_barrier(ReferencedMcpRevisions(owner)).await
    }
}

fn validate_owner(owner: &RunOwner) -> Result<(), StoreError> {
    if owner.deployment.is_nil() {
        return Err(invalid("missing metadata owner"));
    }
    owner
        .namespace
        .validate()
        .map_err(|e| invalid(e.to_string()))
}

// A read projection of small canonical fields, never a second executable RunSpec.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Metadata {
    schema_version: u32,
    owner: RunOwner,
    session_id: String,
    origin: RunOrigin,
    trigger: Trigger,
    mcp_revision: Option<String>,
}
fn metadata(body: &str, owner: &RunOwner, session: &str) -> Result<Metadata, StoreError> {
    let value: Metadata = serde_json::from_str(body)?;
    if value.schema_version != SCHEMA_VERSION
        || &value.owner != owner
        || value.session_id != session
    {
        return Err(invalid(
            "canonical metadata differs from its owner/session/schema",
        ));
    }
    Ok(value)
}
fn run_metadata(row: &Row<'_>, owner: &RunOwner) -> Result<Metadata, StoreError> {
    if row.get::<_, u32>(1)? != SCHEMA_VERSION
        || serde_json::from_str::<RunOwner>(&row.get::<_, String>(2)?)? != *owner
    {
        return Err(invalid("RunSpec index differs from its owner/schema"));
    }
    metadata(&row.get::<_, String>(4)?, owner, &row.get::<_, String>(3)?)
}
fn run_id(value: String) -> Result<RunId, StoreError> {
    Ok(serde_json::from_value(serde_json::Value::String(value))?)
}

struct ExternalSteeringAdmittedBatches {
    execution: ExecutionIdentity,
    task: ExternalTaskId,
}
impl Query for ExternalSteeringAdmittedBatches {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        let mut statement = c.prepare_cached(
            "SELECT s.run,s.schema_version,s.owner,s.session,
             json_object('schemaVersion',json_extract(b.payload,'$.schemaVersion'),
                         'owner',json_extract(b.payload,'$.owner'),
                         'sessionId',json_extract(b.payload,'$.sessionId'),
                         'origin',json_extract(b.payload,'$.origin'),
                         'trigger',json_extract(b.payload,'$.trigger'),
                         'mcpRevision',json_extract(b.payload,'$.mcpRevision')),
             json_extract(b.payload,'$.turnId'),r.schema_version,r.owner,r.session,r.local,
             json_extract(r.external,'$.task'),json_extract(r.external,'$.admitted'),
             (SELECT COUNT(*) FROM agent_external_steering e
              WHERE e.run=s.run AND e.task=?2 AND e.admitted_fact IS NOT NULL),
             json_extract(b.payload,'$.backend.kind')
             FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id
             JOIN agent_runs r ON r.run=s.run WHERE s.run=?1",
        )?;
        let mut rows = statement.query(params![
            self.execution.run_id.to_string(),
            self.task.to_string()
        ])?;
        let row = rows
            .next()?
            .ok_or_else(|| invalid("original external steering Run is absent"))?;
        let owner: RunOwner = serde_json::from_str(&row.get::<_, String>(2)?)?;
        validate_owner(&owner)?;
        let spec = run_metadata(row, &owner)?;
        if spec.session_id != self.execution.session_id
            || row.get::<_, String>(5)? != self.execution.turn_id
            || !matches!(spec.origin, RunOrigin::Local)
            || row.get::<_, u32>(6)? != crate::sql::HEADER_SCHEMA_VERSION
            || serde_json::from_str::<RunOwner>(&row.get::<_, String>(7)?)? != owner
            || row.get::<_, String>(8)? != self.execution.session_id
            || !row.get::<_, bool>(9)?
            || row.get::<_, Option<String>>(10)?.as_deref() != Some(self.task.to_string().as_str())
            || row.get::<_, Option<bool>>(11)? != Some(true)
            || row.get::<_, String>(13)? != "executor"
        {
            return Err(invalid(
                "external steering proof differs from its original admitted Run/Task",
            ));
        }
        u64::try_from(row.get::<_, i64>(12)?)
            .map_err(|_| invalid("negative admitted external steering batch count"))
    }
}

struct LatestMessageBackend(RunOwner, String);
impl Query for LatestMessageBackend {
    type Output = Option<(RunId, BackendSpec)>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut statement=c.prepare_cached("SELECT k.run,s.schema_version,s.owner,s.session,json_object('schemaVersion',json_extract(b.payload,'$.schemaVersion'),'owner',json_extract(b.payload,'$.owner'),'sessionId',json_extract(b.payload,'$.sessionId'),'origin',json_extract(b.payload,'$.origin'),'trigger',json_extract(b.payload,'$.trigger'),'mcpRevision',json_extract(b.payload,'$.mcpRevision')),json_extract(b.payload,'$.backend') FROM agent_catalog_runs k INDEXED BY agent_catalog_latest_run LEFT JOIN agent_run_specs s ON s.run=k.run LEFT JOIN contents b ON b.id=s.spec_content_id WHERE k.owner=?1 AND k.session=?2 ORDER BY k.admission_sequence DESC")?;
        let mut rows = statement.query(params![serde_json::to_string(&self.0)?, self.1])?;
        while let Some(row) = rows.next()? {
            let spec = run_metadata(row, &self.0)?;
            if spec.session_id != self.1 {
                return Err(invalid("catalog Run belongs to another session"));
            }
            if matches!(spec.origin, RunOrigin::Local)
                && matches!(spec.trigger, Trigger::Message { .. })
            {
                let backend = serde_json::from_str(&row.get::<_, String>(5)?)?;
                return Ok(Some((run_id(row.get(0)?)?, backend)));
            }
        }
        Ok(None)
    }
}

struct ReferencedMcpRevisions(RunOwner);
impl Query for ReferencedMcpRevisions {
    type Output = BTreeSet<String>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let owner = serde_json::to_string(&self.0)?;
        let mut retained = BTreeSet::new();
        // Filter with the existing owner/run/pending indexes before reading any
        // frontier bodies; completed history alone is not an execution reference.
        let mut statement=c.prepare_cached("SELECT r.run,s.schema_version,s.owner,s.session,json_object('schemaVersion',json_extract(b.payload,'$.schemaVersion'),'owner',json_extract(b.payload,'$.owner'),'sessionId',json_extract(b.payload,'$.sessionId'),'origin',json_extract(b.payload,'$.origin'),'trigger',json_extract(b.payload,'$.trigger'),'mcpRevision',json_extract(b.payload,'$.mcpRevision')),r.terminal,r.external,r.schema_version,r.session FROM agent_runs r LEFT JOIN agent_run_specs s ON s.run=r.run LEFT JOIN contents b ON b.id=s.spec_content_id WHERE r.owner=?1 AND r.local=1 AND (r.terminal IS NULL OR r.external IS NOT NULL OR EXISTS(SELECT 1 FROM agent_attempts a WHERE a.run=r.run AND a.pending=1) OR EXISTS(SELECT 1 FROM agent_tools t WHERE t.run=r.run AND t.pending=1) OR EXISTS(SELECT 1 FROM agent_cells c WHERE c.run=r.run AND c.pending=1) OR EXISTS(SELECT 1 FROM agent_external_effects e WHERE e.run=r.run AND e.pending=1) OR EXISTS(SELECT 1 FROM agent_external_publications p WHERE p.run=r.run))")?;
        let mut rows = statement.query([&owner])?;
        while let Some(row) = rows.next()? {
            let spec = run_metadata(row, &self.0)?;
            if !matches!(spec.origin, RunOrigin::Local)
                || row.get::<_, u32>(7)? != crate::sql::HEADER_SCHEMA_VERSION
                || row.get::<_, String>(8)? != spec.session_id
            {
                return Err(invalid("local Run metadata differs from canonical RunSpec"));
            }
            let Some(revision) = spec.mcp_revision else {
                continue;
            };
            let terminal: Option<Terminal> = row
                .get::<_, Option<String>>(5)?
                .map(|v| serde_json::from_str(&v))
                .transpose()?;
            let needed = match terminal {
                None => true,
                Some(ref terminal) => terminal_needs_catalog(
                    c,
                    run_id(row.get(0)?)?,
                    terminal,
                    row.get::<_, Option<String>>(6)?.as_deref(),
                )?,
            };
            if needed {
                retained.insert(revision);
            }
        }
        let mut statement=c.prepare_cached("SELECT q.session,q.request,q.message,json_extract(q.entry_json,'$.request.id'),json_extract(q.entry_json,'$.request.messageId'),json_object('schemaVersion',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.schemaVersion'),'owner',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.owner'),'sessionId',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.sessionId'),'origin',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.origin'),'trigger',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.trigger'),'mcpRevision',json_extract(json_extract(q.entry_json,'$.request.spec'),'$.mcpRevision')) FROM agent_queue_items q WHERE q.owner=?1 AND q.state='pending'")?;
        let mut rows = statement.query([owner])?;
        while let Some(row) = rows.next()? {
            let spec = metadata(
                &row.get::<_, String>(5)?,
                &self.0,
                &row.get::<_, String>(0)?,
            )?;
            let message: String = row.get(2)?;
            if !matches!(spec.origin, RunOrigin::Local)
                || !matches!(&spec.trigger,Trigger::Message{message_id} if message_id==&message)
                || row.get::<_, String>(1)? != row.get::<_, String>(3)?
                || message != row.get::<_, String>(4)?
            {
                return Err(invalid(
                    "pending queue entry differs from its original local request",
                ));
            }
            if let Some(revision) = spec.mcp_revision {
                retained.insert(revision);
            }
        }
        Ok(retained)
    }
}

fn any_pending<T: DeserializeOwned>(
    c: &Connection,
    run: RunId,
    query: &str,
    predicate: impl Fn(T) -> bool,
) -> Result<bool, StoreError> {
    let mut statement = c.prepare_cached(query)?;
    let mut rows = statement.query([run.to_string()])?;
    while let Some(row) = rows.next()? {
        if predicate(serde_json::from_str(&row.get::<_, String>(0)?)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn tool_needs_catalog(tool: Tool) -> bool {
    if tool.accepted.is_some() {
        return fold::tool_pending(&tool);
    }
    // Cancellation drops model delivery, not an original admission/effect or
    // cleanup. An unadmitted private call is not a catalog recovery obligation.
    fold::original_effect_unknown(&tool)
        || tool.original.is_some()
            && !matches!(
                &tool.receipt,
                Some(Receipt::Recorded {
                    cleanup: OperationCleanup::Confirmed,
                    ..
                })
            )
        || tool.admitted
            && tool.original.is_none()
            && tool.prohibited_before_host.is_none()
            && tool.local_returned.is_none()
}

fn terminal_needs_catalog(
    c: &Connection,
    run: RunId,
    terminal: &Terminal,
    external: Option<&str>,
) -> Result<bool, StoreError> {
    if any_pending::<Attempt>(
        c,
        run,
        "SELECT body FROM agent_attempts WHERE run=? AND pending=1",
        |attempt| attempt.admission.is_some(),
    )? || any_pending::<Tool>(
        c,
        run,
        "SELECT body FROM agent_tools WHERE run=? AND pending=1",
        tool_needs_catalog,
    )? || any_pending::<CellView>(
        c,
        run,
        "SELECT body FROM agent_cells WHERE run=? AND pending=1",
        |cell| cell.blocks_session_retirement(Some(terminal)),
    )? || any_pending::<ExternalEffect>(
        c,
        run,
        "SELECT body FROM agent_external_effects WHERE run=? AND pending=1",
        |effect| effect.admitted && effect.pending(),
    )? {
        return Ok(true);
    }
    if let Some(body) = external {
        let task: ExternalTask = serde_json::from_str(body)?;
        if task.admitted && (task.closed.is_none() || task.cleanup != OperationCleanup::Confirmed) {
            return Ok(true);
        }
    }
    let header: Option<String> = c
        .query_row(
            "SELECT body FROM agent_external_publications WHERE run=?",
            [run.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(body) = header {
        let publication: external_publication::ExternalPublication = serde_json::from_str(&body)?;
        if publication.admitted > publication.settled {
            let key = ExternalPublicationKey {
                publication: publication.id,
                index: publication.settled,
            };
            let item = external_publication::ReadItem(run, key)
                .execute(c)?
                .ok_or_else(|| invalid("missing admitted publication frontier"))?;
            // Only the one admitted frontier, never all retained denied/history items.
            return Ok(!item.settled());
        }
    }
    // No consumer remains for pure waits, notices or unadmitted private drafts.
    Ok(false)
}

pub(super) async fn finished_or_stopped(
    data: &DataWriter,
    owner: RunOwner,
    runs: Vec<RunId>,
) -> Result<BTreeSet<RunId>, StoreError> {
    validate_owner(&owner)?;
    data.query_barrier(FinishedOrStopped(owner, runs.into_iter().collect()))
        .await
}

struct FinishedOrStopped(RunOwner, BTreeSet<RunId>);
impl Query for FinishedOrStopped {
    type Output = BTreeSet<RunId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        // json_each avoids the SQLite variable limit; every join is an original
        // requested Run PK lookup in this single writer snapshot.
        let mut statement=c.prepare_cached("SELECT wanted.value,s.schema_version,s.owner,s.session,json_object('schemaVersion',json_extract(CAST(b.payload AS TEXT),'$.schemaVersion'),'owner',json_extract(CAST(b.payload AS TEXT),'$.owner'),'sessionId',json_extract(CAST(b.payload AS TEXT),'$.sessionId'),'origin',json_extract(CAST(b.payload AS TEXT),'$.origin'),'trigger',json_extract(CAST(b.payload AS TEXT),'$.trigger'),'mcpRevision',json_extract(CAST(b.payload AS TEXT),'$.mcpRevision')),r.run,r.schema_version,r.owner,r.session,r.local,r.terminal,r.stopped FROM json_each(?1) wanted LEFT JOIN agent_run_specs s ON s.run=wanted.value LEFT JOIN contents b ON b.id=s.spec_content_id LEFT JOIN agent_runs r ON r.run=wanted.value")?;
        let mut rows = statement.query([serde_json::to_string(&self.1)?])?;
        let mut finished = BTreeSet::new();
        while let Some(row) = rows.next()? {
            let original: String = row.get(0)?;
            let runtime: Option<String> = row.get(5)?;
            if row.get::<_, Option<u32>>(1)?.is_none() {
                if runtime.is_some() {
                    return Err(invalid("Run status has no original canonical RunSpec"));
                }
                continue;
            }
            let spec = run_metadata(row, &self.0)?;
            let Some(runtime) = runtime else {
                continue;
            };
            let local: bool = row.get(9)?;
            if runtime != original
                || row.get::<_, u32>(6)? != crate::sql::HEADER_SCHEMA_VERSION
                || serde_json::from_str::<RunOwner>(&row.get::<_, String>(7)?)? != self.0
                || row.get::<_, String>(8)? != spec.session_id
                || local != matches!(spec.origin, RunOrigin::Local)
            {
                return Err(invalid(
                    "Run status differs from its canonical identity/owner/session/schema/origin",
                ));
            }
            let terminal: Option<Terminal> = row
                .get::<_, Option<String>>(10)?
                .map(|body| serde_json::from_str(&body))
                .transpose()?;
            if local && (terminal.is_some() || row.get::<_, bool>(11)?) {
                finished.insert(run_id(original)?);
            }
        }
        Ok(finished)
    }
}
