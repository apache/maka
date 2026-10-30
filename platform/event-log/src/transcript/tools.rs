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

use super::evidence;
use crate::StoreError;
use maka_agent_facts::tool_call::ToolOrigin;
use maka_presentation::ProjectionError;
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use std::collections::BTreeSet;

const TOOL_KIND: &str =
    r#"SELECT operation_id, kind FROM runtime_events WHERE sequence = ? AND invocation_id = ?"#;
const TOOL_HEADER: &str = r#"SELECT sequence, json_extract(accounting_tool, '$.call.origin')
             FROM runtime_events
             WHERE invocation_id = ?1 AND operation_id = ?2 AND operation_id IS NOT NULL
               AND kind = ?3 AND sequence <= ?4 LIMIT 1"#;
const TOOL_MAIN: &str = r#"SELECT EXISTS(SELECT 1 FROM runtime_events request
             JOIN runtime_events opening ON opening.invocation_id = request.invocation_id
             AND opening.kind = 'invocation_opened'
             WHERE request.invocation_id = ?1 AND request.operation_id = ?2
             AND request.kind = 'model_requested'
             AND json_extract(opening.event_json, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
             AND json_extract(request.event_json, '$.fact.purpose') = 'main')"#;

/// Reconstruct one tool boundary, its actual dispatch ancestry and accepted
/// provider step. Exclude sibling outcomes and unrelated raw payloads.
pub(super) fn selection(
    db: &RawConnection,
    invocation: &str,
    through: i64,
) -> Result<evidence::Selection, StoreError> {
    let ancestry = ancestry(db, invocation, through)?;
    Ok(evidence::Selection::Step {
        invocation: invocation.to_owned(),
        step: ancestry.step,
        through,
        boundaries: serde_json::to_string(&ancestry.boundaries)?,
        completed: true,
    })
}

struct Ancestry {
    step: Option<String>,
    boundaries: BTreeSet<i64>,
    dispatch: i64,
}

fn ancestry(db: &RawConnection, invocation: &str, through: i64) -> Result<Ancestry, StoreError> {
    let (operation, kind): (String, String) = db
        .prepare_cached(TOOL_KIND)?
        .query_row(params![through, invocation], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
    let mut ids = BTreeSet::from([through]);
    let mut current = operation;
    let mut before = through;
    let mut rejected = kind == "tool_rejected";
    let mut dispatch = None;
    let step = loop {
        let header: Option<(i64, String)> = db
            .prepare_cached(TOOL_HEADER)?
            .query_row(
                params![
                    invocation,
                    &current,
                    if rejected {
                        "tool_rejected"
                    } else {
                        "tool_dispatched"
                    },
                    before
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((sequence, origin)) = header else {
            return Err(
                ProjectionError::Invalid("tool presentation has no dispatch provenance").into(),
            );
        };
        dispatch.get_or_insert(sequence);
        ids.insert(sequence);
        match serde_json::from_str::<ToolOrigin>(&origin)? {
            ToolOrigin::Provider { step_id } => break Some(step_id),
            ToolOrigin::Standalone | ToolOrigin::HostSdk { parent: None, .. } => break None,
            ToolOrigin::CodeMode {
                parent_operation_id,
                ..
            }
            | ToolOrigin::CodeCell {
                parent_operation_id,
                ..
            } => {
                current = parent_operation_id;
                before = sequence - 1;
                rejected = false;
            }
            ToolOrigin::HostSdk {
                parent: Some(parent),
                ..
            } => {
                current = parent.operation_id().to_owned();
                before = sequence - 1;
                rejected = false;
            }
        }
    };
    if let Some(step) = &step {
        let main: bool = db
            .prepare_cached(TOOL_MAIN)?
            .query_row(params![invocation, step], |row| row.get(0))?;
        if !main {
            return Err(ProjectionError::Invalid("tool belongs to a non-main step").into());
        }
    }
    Ok(Ancestry {
        step,
        boundaries: ids,
        dispatch: dispatch.expect("tool ancestry contains original boundary"),
    })
}

pub(super) fn project(
    db: &RawConnection,
    stored: &maka_agent_facts::event::StoredEvent,
) -> Result<Vec<maka_presentation::Row>, StoreError> {
    let ancestry = ancestry(
        db,
        &stored.event.invocation.invocation_id,
        stored.sequence as i64,
    )?;
    let dispatch = matches!(
        stored.event.fact,
        maka_agent_facts::event::Fact::ToolSettled { .. }
    )
    .then(|| evidence::fact_on_handle(db, ancestry.dispatch))
    .transpose()?;
    let resolved = if matches!(
        stored.event.fact,
        maka_agent_facts::event::Fact::ToolSettled {
            outcome: maka_agent_facts::event::ToolOutcome::Succeeded { .. },
            ..
        }
    ) {
        Some(crate::tool_payloads::resolve_in_transaction(
            db,
            &stored.event,
        )?)
    } else {
        None
    };
    Ok(maka_presentation::project_tool_boundary(
        stored,
        dispatch.as_ref().map(|event| &event.event),
        resolved.as_ref(),
    )?)
}
