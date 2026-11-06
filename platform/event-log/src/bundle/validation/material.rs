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

use super::invalid;
use crate::{
    StoreError,
    bundle::{
        format::{Blob, Record},
        stage::payload,
    },
};
use maka_agent_facts::composition::RequestComposition;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::tool_output::decode_raw_tool_result;
use rusqlite::{Connection, OptionalExtension, params};

pub(super) fn tool(
    staged: &Connection,
    event: &RuntimeEvent,
) -> Result<Option<Vec<u8>>, StoreError> {
    let Some((number, descriptor)) = descriptor(staged, &event.id, "tool_result")? else {
        return Ok(None);
    };
    let Fact::ToolSettled {
        outcome: ToolOutcome::Succeeded { raw, .. },
        ..
    } = &event.fact
    else {
        return Err(invalid("tool blob belongs to a non-success event"));
    };
    if raw.bytes != descriptor.bytes() || raw.digest != descriptor.digest() {
        return Err(invalid("tool blob differs from its original event"));
    }
    let payload = payload(staged, number, &descriptor)?;
    let output = decode_raw_tool_result(&payload, raw).map_err(invalid)?;
    if serde_json::to_vec(&output)? != payload {
        return Err(invalid(
            "tool blob is not the canonical raw result encoding",
        ));
    }
    Ok(Some(payload))
}

pub(super) fn composition(
    staged: &Connection,
    db: &Connection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let material = descriptor(staged, &event.id, "composition")?;
    crate::composition::validate_retry(
        db,
        event,
        material.as_ref().map(|(_, descriptor)| descriptor.digest()),
    )?;
    let Some((number, descriptor)) = material else {
        return Ok(());
    };
    if !matches!(event.fact, Fact::ModelRequested { .. }) {
        return Err(invalid("composition belongs to a non-request event"));
    }
    let bytes = payload(staged, number, &descriptor)?;
    let surface: RequestComposition = serde_json::from_slice(&bytes)?;
    if surface.clone().freeze().map_err(invalid)?.digest() != descriptor.digest() {
        return Err(invalid("composition is not the frozen request surface"));
    }
    crate::composition::store(db, descriptor.digest(), &surface, bytes.len())?;
    db.execute(
        "INSERT INTO model_request_compositions(event_id,digest) VALUES(?,?)",
        params![&event.id, descriptor.digest()],
    )?;
    Ok(())
}

fn descriptor(
    staged: &Connection,
    event: &str,
    resource: &str,
) -> Result<Option<(i64, Blob)>, StoreError> {
    let row: Option<(i64,String)> = staged.prepare_cached("SELECT number,record_json FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource')=?
         AND json_extract(record_json,'$.event_id')=?")?.query_row(params![resource, event], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
    row.map(|(number, json)| {
        let Record::Blob(blob) = serde_json::from_str(&json)? else {
            unreachable!()
        };
        Ok((number, blob))
    })
    .transpose()
}

pub(super) fn check_bindings(staged: &Connection, db: &Connection) -> Result<(), StoreError> {
    let expected: i64 = staged.prepare_cached("SELECT COUNT(*) FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource') IN ('tool_result','composition')")?.query_row(params![], |row| row.get(0))?;
    let installed: i64 = db.prepare_cached("SELECT (SELECT COUNT(*) FROM tool_result_payloads)+(SELECT COUNT(*) FROM model_request_compositions)")?.query_row(params![], |row| row.get(0))?;
    if expected != installed {
        return Err(invalid("bundle contains unbound event payloads"));
    }
    let expected: i64 = staged
        .prepare_cached("SELECT COUNT(*) FROM frames WHERE kind IN ('member','revision_source')")?
        .query_row(params![], |row| row.get(0))?;
    let installed: i64 = db.prepare_cached("SELECT (SELECT COUNT(*) FROM session_history_members)+(SELECT COUNT(*) FROM session_revision_sources)")?.query_row(params![], |row| row.get(0))?;
    if expected != installed {
        return Err(invalid("bundle contains history without its copy"));
    }
    let invalid_pin: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_history_members h JOIN runtime_events t ON t.sequence=h.sequence
         LEFT JOIN runtime_events a ON a.sequence=h.archive_sequence
         WHERE t.event_session=h.session_id OR (h.archive_sequence IS NOT NULL AND
           (a.kind IS NOT 'tool_result_archived' OR a.sequence<=t.sequence OR
            json_extract(a.event_header,'$.fact.placeholder.identity.runtime_event_id') IS NOT t.event_id)))")?.query_row(params![], |row| row.get(0))?;
    if invalid_pin {
        return Err(invalid("copy has a self member or mismatched archive pin"));
    }
    let changed_projection: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_history_members h
         JOIN session_history_copies c ON c.session_id=h.session_id
         JOIN runtime_events target ON target.sequence=h.sequence
         LEFT JOIN session_history_members parent ON parent.session_id=c.source_session_id AND parent.sequence=h.sequence
         WHERE h.archive_sequence IS NOT COALESCE(
            (SELECT a.sequence FROM runtime_events a WHERE a.kind='tool_result_archived'
             AND a.event_session=c.source_session_id AND a.sequence<=c.observed_through
             AND json_extract(a.event_header,'$.fact.placeholder.identity.runtime_event_id')=target.event_id),
            parent.archive_sequence))")?.query_row(params![], |row| row.get(0))?;
    if changed_projection {
        return Err(invalid(
            "copy archive pin differs from its source projection",
        ));
    }
    let premature: bool = db.prepare_cached("SELECT EXISTS(SELECT 1 FROM session_history_copies c JOIN runtime_events e ON e.event_session=c.session_id
         WHERE e.sequence<=c.observed_through OR c.state!='committed')")?.query_row(params![], |row| row.get(0))?;
    if premature {
        return Err(invalid("copy has work before its creation or retention"));
    }
    Ok(())
}
