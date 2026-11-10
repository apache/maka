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
use maka_agent_facts::cells::{CellEvent, CellOwner};
fn key(cell: maka_agent_facts::cells::CellId, operation: Uuid) -> String {
    format!("cell:{cell}:{operation}")
}
fn call(
    c: &Connection,
    source: &str,
    owner: Option<&RunOwner>,
    session: &str,
    run: Option<RunId>,
    sequence: u64,
    at: UnixMillis,
    cell: maka_agent_facts::cells::CellId,
    operation: Uuid,
) -> Result<String, StoreError> {
    let path = format!("$.children.\"{operation}\".name");
    let (body,name):(String,String)=c.query_row("SELECT json_extract(body,'$.owner'),json_extract(body,?) FROM agent_cells WHERE cell=? AND session=?",params![path,cell.to_string(),session],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let cell_owner: CellOwner = serde_json::from_str(&body)?;
    let binding = match &cell_owner {
        CellOwner::Agent { link, .. } => Some(evidence(c, link.run, link.attempt)?.1.binding),
        CellOwner::Standalone { .. } => None,
    };
    let id = key(cell, operation);
    insert_tool(
        c,
        &id,
        source,
        owner,
        session,
        run,
        sequence,
        at,
        &name,
        binding.as_ref(),
        &ToolUsageSource::Cell {
            cell,
            owner: cell_owner,
            operation,
        },
    )?;
    Ok(id)
}
pub(crate) fn index_cell(
    c: &Connection,
    source: &str,
    owner: Option<&RunOwner>,
    session: &str,
    run: Option<RunId>,
    sequence: u64,
    at: UnixMillis,
    event: &CellEvent,
) -> Result<(), StoreError> {
    match event {
        CellEvent::ChildAdmitted { cell, operation } => {
            call(
                c, source, owner, session, run, sequence, at, *cell, *operation,
            )?;
        }
        CellEvent::ChildRejected {
            cell,
            operation,
            reason,
            ..
        } => {
            let id = call(
                c, source, owner, session, run, sequence, at, *cell, *operation,
            )?;
            settle(
                c,
                &id,
                sequence,
                at,
                ToolSettlement::Rejected,
                true,
                Some(*reason),
            )?;
        }
        CellEvent::LocalChildReturned {
            cell,
            operation,
            settlement,
            is_error,
            ..
        } => settle(
            c,
            &key(*cell, *operation),
            sequence,
            at,
            *settlement,
            *is_error,
            None,
        )?,
        CellEvent::ChildResultRecorded {
            cell,
            operation,
            is_error,
            ..
        } => host_returned(c, &key(*cell, *operation), sequence, at, *is_error)?,
        CellEvent::ChildObserved {
            cell,
            operation,
            reply,
        } => observe_receipt(c, &key(*cell, *operation), sequence, at, reply)?,
        _ => {}
    }
    Ok(())
}
