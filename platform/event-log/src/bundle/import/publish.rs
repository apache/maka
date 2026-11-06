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

use super::ImportReceipt;
use crate::{
    StoreError,
    bundle::{
        format::{Blob, Record},
        stage,
    },
};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn all(
    destination: &Connection,
    staged: &Connection,
    relocated: &Connection,
    receipt: &ImportReceipt,
    binding_digest: &str,
    configurations: &BTreeMap<String, Value>,
    positions: &crate::bundle::relocation::Positions,
) -> Result<(), StoreError> {
    destination.execute(
        "INSERT INTO session_bundle_imports VALUES(?,?,?)",
        rusqlite::params![
            &receipt.bundle_digest,
            binding_digest,
            serde_json::to_string(receipt)?
        ],
    )?;
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = staged.prepare_cached(
            "SELECT number,record_json FROM frames WHERE kind='session' AND number>? ORDER BY number LIMIT 1",
        )?.query_row(rusqlite::params![after], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
        let Some((number, json)) = row else { break };
        let Record::Session {
            id,
            parent,
            created_at,
            updated_at,
            archived,
            ..
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        crate::sessions::insert(
            destination,
            &id,
            &receipt.bundle_digest,
            &serde_json::to_string(&configurations[&id])?,
            created_at,
        )?;
        destination.execute(
            "UPDATE session_control SET updated_at=?,archived=? WHERE id=?",
            rusqlite::params![updated_at as i64, archived, &id],
        )?;
        destination.execute(
            "INSERT INTO session_bundle_members VALUES(?,?,?)",
            rusqlite::params![id, &receipt.bundle_digest, parent],
        )?;
        after = number;
    }
    // Message openings freeze their inherited lineage at insertion. Install
    // the already-validated copy topology first, while leaving roots unpinned
    // until all source events have reached the destination.
    source_copies(destination, relocated)?;
    events(destination, relocated, &receipt.bundle_digest)?;
    copies(destination, relocated, &receipt.bundle_digest)?;
    // All copied bases are installed before pinning: bundle Session IDs do not
    // encode ancestry order.
    for session in &receipt.session_ids {
        destination.query_row("SELECT context_source_pin_copy(?)", [session], |_| Ok(()))?;
    }
    materials(destination, staged, positions)?;

    crate::bundle::accounting::validate(staged, destination)
}

fn source_copies(destination: &Connection, relocated: &Connection) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let rows: Vec<(String, String, i64)> = {
            let mut statement = relocated.prepare_cached(
            "SELECT owner,source,through_sequence FROM context_source_copies WHERE owner>? ORDER BY owner LIMIT 128")?;

            statement
                .query_map(rusqlite::params![&after], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        }?;
        if rows.is_empty() {
            break;
        }
        for (owner, source, through) in rows {
            destination.execute(
                "INSERT INTO context_source_copies(owner,source,through_sequence) VALUES(?,?,?)",
                rusqlite::params![&owner, source, through],
            )?;
            after = owner;
        }
    }
    Ok(())
}

fn events(
    destination: &Connection,
    relocated: &Connection,
    digest: &str,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let mut statement = relocated.prepare_cached(&format!(
            "SELECT e.sequence,e.event_header,{columns} FROM runtime_events e {joins} WHERE e.sequence>? ORDER BY e.sequence LIMIT 1",
            columns=crate::canonical::COLUMNS, joins=crate::canonical::JOINS,
        ))?;
        let mut rows = statement.query([after])?;
        let Some(row) = rows.next()? else {
            break;
        };
        let sequence: i64 = row.get(0)?;
        let json = crate::canonical::json(row)?.into_owned();
        let event: RuntimeEvent = serde_json::from_str(&json)?;
        destination.execute(
            "INSERT INTO imported_invocations VALUES(?,?) ON CONFLICT DO NOTHING",
            rusqlite::params![&event.invocation.invocation_id, digest],
        )?;
        crate::append::ingress::insert(
            destination,
            &event,
            json,
            crate::append::ingress::Position::Imported(Some(sequence as u64)),
        )?;
        crate::message_sources::insert(destination, &event)?;
        crate::root_store::usage_meter::append(destination, &event)?;
        if matches!(
            event.fact,
            Fact::MessageImported { .. }
                | Fact::InvocationOpened { .. }
                | Fact::MessageSteered { .. }
                | Fact::ModelCompleted { .. }
                | Fact::ModelInterrupted { .. }
                | Fact::InvocationEnded { .. }
        ) {
            crate::sessions::project_execution(destination, sequence as u64)?;
        }
        after = sequence;
    }
    Ok(())
}

fn copies(
    destination: &Connection,
    relocated: &Connection,
    digest: &str,
) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let row: Option<CopyRow> = relocated.prepare_cached(
            "SELECT session_id,source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,state
             FROM session_history_copies WHERE session_id>? ORDER BY session_id LIMIT 1",
        )?.query_row(rusqlite::params![&after], |row| Ok(CopyRow {
                session_id: row.get(0)?, source_session_id: row.get(1)?, source_revision: row.get(2)?,
                through_sequence: row.get(3)?, observed_through: row.get(4)?, request_json: row.get(5)?,
                lineage_json: row.get(6)?, state: row.get(7)?,
            })).optional()?;
        let Some(CopyRow {
            session_id: session,
            source_session_id: source,
            source_revision: revision,
            through_sequence: through,
            observed_through: observed,
            request_json: request,
            lineage_json: lineage,
            state,
        }) = row
        else {
            break;
        };
        destination.execute(
            "INSERT INTO session_history_copies VALUES(?,?,?,?,?,?,?,?,?)",
            rusqlite::params![
                &session, source, revision, through, observed, request, lineage, state, digest
            ],
        )?;
        let mut member = 0i64;
        loop {
            let rows: Vec<(i64, Option<i64>)> = {
                let mut statement = relocated.prepare_cached(
                "SELECT sequence,archive_sequence FROM session_history_members WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128",
            )?;

                statement
                    .query_map(rusqlite::params![&session, member], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
            }?;
            if rows.is_empty() {
                break;
            }
            for (sequence, archive) in rows {
                destination.execute(
                    "INSERT INTO session_history_members VALUES(?,?,?)",
                    rusqlite::params![&session, sequence, archive],
                )?;
                crate::context::semantic::copy_member(destination, &session, sequence, archive)?;
                member = sequence;
            }
        }
        let mut member = 0i64;
        loop {
            let rows: Vec<i64> = {
                let mut statement = relocated.prepare_cached(
                "SELECT sequence FROM session_revision_sources WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 128",
            )?;

                statement
                    .query_map(rusqlite::params![&session, member], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            }?;
            if rows.is_empty() {
                break;
            }
            for sequence in rows {
                destination.execute(
                    "INSERT INTO session_revision_sources VALUES(?,?)",
                    rusqlite::params![&session, sequence],
                )?;
                member = sequence;
            }
        }
        after = session;
    }
    Ok(())
}

fn materials(
    destination: &Connection,
    staged: &Connection,
    positions: &crate::bundle::relocation::Positions,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = staged.prepare_cached(
            "SELECT number,record_json FROM frames WHERE kind='blob' AND number>? ORDER BY number LIMIT 1",
        )?.query_row(rusqlite::params![after], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
        let Some((number, json)) = row else { break };
        let Record::Blob(blob) = serde_json::from_str(&json)? else {
            unreachable!()
        };
        let payload = stage::payload(staged, number, &blob)?;
        match blob {
            Blob::ToolResult { event_id, .. } => {
                crate::tool_payloads::store_raw(destination, &event_id, &payload)?;
            }
            Blob::Composition {
                event_id, digest, ..
            } => {
                let value = serde_json::from_slice(&payload)?;
                crate::composition::store(destination, &digest, &value, payload.len())?;
                destination.execute(
                    "INSERT INTO model_request_compositions VALUES(?,?)",
                    rusqlite::params![event_id, digest],
                )?;
            }
            Blob::Artifact {
                metadata,
                frozen_at,
                ..
            } => {
                let stamp = frozen_at
                    .map(|source| positions.event(source))
                    .transpose()?;
                let (session, id) = (metadata.session_id.clone(), metadata.id.clone());
                crate::artifacts::commit_in_transaction(destination, metadata, &payload)?;
                if let Some(stamp) = stamp {
                    destination.execute(
                        "UPDATE artifacts SET canonical_at=? WHERE session_id=? AND id=?",
                        rusqlite::params![stamp as i64, session, id],
                    )?;
                }
            }
        }
        after = number;
    }
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = staged.prepare_cached(
            "SELECT number,record_json FROM frames WHERE kind='history_artifact' AND number>? ORDER BY number LIMIT 1",
        )?.query_row(rusqlite::params![after], |row| Ok((row.get(0)?,row.get(1)?,))).optional()?;
        let Some((number, json)) = row else { break };
        let Record::HistoryArtifact {
            session,
            source_session,
            source_artifact,
            artifact,
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        destination.execute("INSERT INTO session_history_artifacts (session_id,source_session_id,source_artifact_id,artifact_id,lookup_digest,target_digest) VALUES(?,?,?,?,?,?)", rusqlite::params![&session, &source_session, &source_artifact, &artifact, crate::artifacts::identity::history_lookup_digest(&session, &source_session, &source_artifact).as_slice(), crate::artifacts::identity::artifact_lookup_digest(&session, &artifact).as_slice()])?;
        after = number;
    }
    Ok(())
}

struct CopyRow {
    session_id: String,
    source_session_id: String,
    source_revision: i64,
    through_sequence: i64,
    observed_through: i64,
    request_json: String,
    lineage_json: String,
    state: String,
}
