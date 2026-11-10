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
use rusqlite::{OptionalExtension, params};

pub(super) fn content_id(c: &Connection, r: &ContentRef) -> Result<i64, StoreError> {
    r.validate().map_err(invalid)?;
    c.query_row(
        "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
        params![
            r.digest,
            i64::try_from(r.bytes)
                .map_err(|_| invalid("Cell content length exceeds SQLite integer"))?
        ],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| invalid("missing Cell canonical content"))
}
pub(super) fn exists(
    c: &Connection,
    cell: CellId,
    excluding: Option<FactId>,
) -> Result<bool, StoreError> {
    Ok(c.query_row("SELECT EXISTS(SELECT 1 FROM agent_cells WHERE cell=?1 UNION ALL SELECT 1 FROM agent_facts WHERE id=?2 AND (?3 IS NULL OR id<>?3) UNION ALL SELECT 1 FROM agent_standalone_cell_events WHERE id=?2 AND (?3 IS NULL OR id<>?3))",params![cell.to_string(),cell.started_fact_id().to_string(),excluding.map(|id|id.to_string())],|r|r.get(0))?)
}
pub(super) fn read_recorded(
    c: &Connection,
    session: &str,
    cell: CellId,
) -> Result<Option<CellView>, StoreError> {
    let view = read(c, session, cell)?;
    if view.is_none() {
        let recorded:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_facts f JOIN agent_run_specs r ON r.run=f.run WHERE f.id=?1 AND r.session=?2 UNION ALL SELECT 1 FROM agent_standalone_cell_events WHERE id=?1 AND session=?2)",params![cell.started_fact_id().to_string(),session],|r|r.get(0))?;
        if recorded {
            return Err(invalid(
                "Cell projection unavailable; rebuild its original canonical source before observing or executing",
            ));
        }
    }
    Ok(view)
}
pub(super) fn read(
    c: &Connection,
    session: &str,
    cell: CellId,
) -> Result<Option<CellView>, StoreError> {
    let body: Option<String> = c
        .query_row(
            "SELECT body FROM agent_cells WHERE session=? AND cell=?",
            params![session, cell.to_string()],
            |r| r.get(0),
        )
        .optional()?;
    body.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .transpose()
}
pub(super) fn value(
    c: &Connection,
    session: &str,
    key: &str,
) -> Result<Option<Vec<u8>>, StoreError> {
    Ok(c.query_row("SELECT c.payload FROM agent_session_values v JOIN contents c ON c.id=v.value_content_id WHERE v.session=? AND v.key=?",params![session,key],|r|r.get(0)).optional()?)
}
pub(super) fn loaded(c: &Connection, session: &str) -> Result<BTreeSet<String>, StoreError> {
    let body: Option<String> = c
        .query_row(
            "SELECT body FROM agent_session_loaded_tools WHERE session=?",
            [session],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match body {
        Some(body) => serde_json::from_str(&body)?,
        None => BTreeSet::new(),
    })
}
pub(super) fn owned_content(
    c: &Connection,
    session: &str,
    cell: CellId,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    let view = read(c, session, cell)?.ok_or_else(|| invalid("Cell not found in this session"))?;
    match view.owner {
        CellOwner::Agent { link, .. } => crate::sql::owned_content(c, link.run, reference),
        CellOwner::Standalone { .. } => {
            let id = content_id(c, reference)?;
            c.query_row("SELECT c.payload FROM contents c JOIN agent_standalone_cell_pins p ON p.content_id=c.id WHERE p.cell=? AND c.id=?",params![cell.to_string(),id],|r|r.get(0)).optional()?.ok_or_else(||invalid("content not retained by this Cell"))
        }
    }
}
pub(super) fn notifications(
    c: &Connection,
    run: RunId,
    after: Option<FactId>,
    limit: u32,
) -> Result<Vec<PendingNotification>, StoreError> {
    if !(1..=1024).contains(&limit) {
        return Err(invalid("Cell page size must be 1..=1024"));
    }
    let mut q=c.prepare_cached("SELECT n.cell,n.notification,c.content_sha256,length(c.payload) FROM agent_cell_notifications n JOIN contents c ON c.id=n.content_id WHERE n.run=?1 AND n.consumed_step IS NULL AND (?2 IS NULL OR n.queued_sequence>(SELECT queued_sequence FROM agent_cell_notifications WHERE notification=?2 AND run=?1)) ORDER BY n.queued_sequence LIMIT ?3")?;
    let mut rows = q.query(params![
        run.to_string(),
        after.map(|x| x.to_string()),
        limit
    ])?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        out.push(PendingNotification {
            cell: serde_json::from_value(serde_json::Value::String(r.get(0)?))?,
            id: serde_json::from_value(serde_json::Value::String(r.get(1)?))?,
            content: ContentRef {
                digest: r.get(2)?,
                bytes: u64::try_from(r.get::<_, i64>(3)?)
                    .map_err(|_| invalid("negative Cell content length"))?,
            },
        });
    }
    Ok(out)
}
pub(crate) fn load_run(
    c: &Connection,
    run: RunId,
    targets: &[&Fact],
    all: bool,
) -> Result<BTreeMap<CellId, CellView>, StoreError> {
    let keys: Vec<_> = targets
        .iter()
        .filter_map(|f| match f {
            Fact::Cell { event } => Some(event.cell().to_string()),
            Fact::ToolResultAccepted {
                outcome: AcceptedResult::CellRecovered { cell },
                ..
            } => Some(cell.to_string()),
            _ => None,
        })
        .collect();
    let query = if all {
        "SELECT body FROM agent_cells WHERE run=?1"
    } else {
        "SELECT body FROM agent_cells WHERE run=?1 AND pending=1 UNION ALL SELECT body FROM agent_cells WHERE run=?1 AND pending=0 AND cell IN (SELECT value FROM json_each(?2)) UNION ALL SELECT v.body FROM agent_tools t JOIN agent_cells v ON v.run=t.run AND json_extract(v.body,'$.owner.link.attempt')=json_extract(t.body,'$.key.attempt') AND json_extract(v.body,'$.owner.call')=json_extract(t.body,'$.key.call') WHERE t.run=?1 AND t.pending=1 AND json_extract(t.body,'$.admitted')=1 AND v.pending=0 AND v.cell NOT IN (SELECT value FROM json_each(?2))"
    };
    let mut stmt = c.prepare_cached(query)?;
    let mut rows = if all {
        stmt.query([run.to_string()])?
    } else {
        stmt.query(params![run.to_string(), serde_json::to_string(&keys)?])?
    };
    let mut result = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let cell: CellView = serde_json::from_str(&row.get::<_, String>(0)?)?;
        result.insert(cell.id, cell);
    }
    Ok(result)
}
pub(super) fn validate_notification(
    c: &Connection,
    view: &CellView,
    event: &CellEvent,
) -> Result<(), StoreError> {
    let (content, final_notice) = match event {
        CellEvent::NotificationQueued { content, .. } => (content, false),
        CellEvent::FinalNotificationQueued { content, .. } => (content, true),
        _ => return Ok(()),
    };
    let bytes = maka_event_log::content::read(c, &content.digest)?
        .ok_or_else(|| invalid("Cell notification content missing"))?;
    let notice: CellNotification = serde_json::from_slice(&bytes)?;
    if notice.schema_version != CELL_NOTIFICATION_SCHEMA_VERSION {
        return Err(invalid("unsupported Cell notification schema"));
    }
    let valid = match notice.body {
        CellNotificationBody::Text { .. } => !final_notice,
        CellNotificationBody::Completed { result } => {
            final_notice
                && matches!(&view.status,CellStatus::Completed{result:original,..} if original==&result)
        }
        CellNotificationBody::Interrupted { report } => {
            final_notice
                && matches!(&view.status,CellStatus::Interrupted{report:original} if original==&report)
        }
    };
    if !valid {
        return Err(invalid(
            "Cell notification does not refer to its original final result",
        ));
    }
    Ok(())
}
pub(super) fn validate_batch(
    view: &CellView,
    event: &CellEvent,
    changes: &[Change],
) -> Result<(), StoreError> {
    match event {
        CellEvent::VmCleanupUnconfirmed{..}=>{
            if changes.iter().any(|change|matches!(&change.fact,Fact::Cell{event} if event.is_admission())){return Err(invalid("VM uncertainty observation cannot admit new work"));}
        },
        CellEvent::FinalNotificationQueued{cell,..}=>{
            if matches!(view.status,CellStatus::Completed{..}) && !changes.iter().any(|change|matches!(&change.fact,Fact::Cell{event:CellEvent::ResultAccepted{cell:id}} if id==cell)){return Err(invalid("background completion notification requires same-batch final acceptance"));}
        },
        CellEvent::ChildApprovalConsumed{cell,operation,..}=>{
            if !changes.iter().any(|c|matches!(&c.fact,Fact::Cell{event:CellEvent::ChildAdmitted{cell:id,operation:op}} if id==cell && op==operation)){return Err(invalid("Cell once approval consumption requires same-batch child admission"));}
        },
        CellEvent::ChildAdmitted{cell,operation}=>{
            let child=view.children.get(operation).ok_or_else(||invalid("Cell child not prepared"))?;
            for approval in child.approvals.keys() {
                if !changes.iter().any(|c|matches!(&c.fact,Fact::Cell{event:CellEvent::ChildApprovalConsumed{cell:id,operation:op,approval:a}} if id==cell && op==operation && a==approval)){return Err(invalid("Cell child admission requires same-batch consumption of every original approval"));}
            }
        },
        CellEvent::ResultAccepted{cell}=>{
            let CellStatus::Completed{publication,accepted:false,..}=&view.status else{return Err(invalid("Cell final result is not available for acceptance"));};
            let mut values=BTreeMap::new();let mut loaded=None;
            for change in changes {match &change.fact {
                Fact::Cell{event:CellEvent::SessionValuePublished{cell:id,key,value}} if id==cell=>{if values.insert(key.clone(),value.clone()).is_some(){return Err(invalid("duplicate Cell value publication"));}},
                Fact::Cell{event:CellEvent::LoadedToolsPublished{cell:id,names}} if id==cell&& loaded.replace(names.clone()).is_some()=> {return Err(invalid("duplicate Cell tools publication"));},_=>{}
            }}
            if values!=publication.values || loaded!=publication.loaded_tools{return Err(invalid("Cell acceptance must atomically publish its exact complete draft"));}
        },
        CellEvent::SessionValuePublished{cell,..}|CellEvent::LoadedToolsPublished{cell,..}=>{
            if !changes.iter().any(|change|matches!(&change.fact,Fact::Cell{event:CellEvent::ResultAccepted{cell:id}} if id==cell)){return Err(invalid("Cell publication requires same-batch final acceptance"));}
        },
        CellEvent::NotificationConsumed{step,..}
            if !changes.iter().any(|change|matches!(&change.fact,Fact::StepPrepared{step:id,..} if id==step))=> {return Err(invalid("Cell notification consumption requires exact same-batch context step"));},_=>{}
    }
    Ok(())
}
pub(super) fn project(
    c: &Connection,
    session: &str,
    run: Option<RunId>,
    id: FactId,
    event: &CellEvent,
    view: &CellView,
) -> Result<(), StoreError> {
    let original: Option<(String, Option<String>)> = c
        .query_row(
            "SELECT session,run FROM agent_cells WHERE cell=?",
            [view.id.to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if original.is_some_and(|(s, r)| s != session || r != run.map(|r| r.to_string())) {
        return Err(StoreError::EventConflict);
    }
    c.execute("INSERT INTO agent_cells(cell,session,run,pending,body) VALUES(?,?,?,?,?) ON CONFLICT(cell) DO UPDATE SET pending=excluded.pending,body=excluded.body",params![view.id.to_string(),session,run.map(|r|r.to_string()),view.pending(),serde_json::to_string(view)?])?;
    match event {
        CellEvent::ChildBound {
            cell,
            operation,
            reference,
        } => {
            let encoded = serde_json::to_string(reference)?;
            let prior:Option<String>=c.query_row("SELECT reference_json FROM agent_cell_operation_pins WHERE cell=? AND operation=?",params![cell.to_string(),operation.to_string()],|r|r.get(0)).optional()?;
            if prior.as_ref().is_some_and(|p| p != &encoded) {
                return Err(StoreError::EventConflict);
            }
            c.execute("INSERT OR IGNORE INTO agent_cell_operation_pins(cell,operation,reference_json) VALUES(?,?,?)",params![cell.to_string(),operation.to_string(),encoded])?;
        }
        CellEvent::SessionValuePublished { key, value, .. } => {
            c.execute("INSERT INTO agent_session_values(session,key,value_content_id,fact_id) VALUES(?,?,?,?) ON CONFLICT(session,key) DO UPDATE SET value_content_id=excluded.value_content_id,fact_id=excluded.fact_id",params![session,key,content_id(c,value)?,id.to_string()])?;
        }
        CellEvent::LoadedToolsPublished { names, .. } => {
            merge_loaded(c, session, id, names)?;
        }
        CellEvent::NotificationQueued {
            cell,
            notification,
            content,
        }
        | CellEvent::FinalNotificationQueued {
            cell,
            notification,
            content,
        } => {
            let table = if run.is_some() {
                "agent_facts"
            } else {
                "agent_standalone_cell_events"
            };
            let sequence: i64 = c.query_row(
                &format!("SELECT sequence FROM {table} WHERE id=?"),
                [id.to_string()],
                |r| r.get(0),
            )?;
            let inserted=c.execute("INSERT INTO agent_cell_notifications(notification,cell,session,run,content_id,queued_fact,queued_sequence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(notification) DO NOTHING",params![notification.to_string(),cell.to_string(),session,run.map(|r|r.to_string()),content_id(c,content)?,id.to_string(),sequence])?;
            if inserted != 1 {
                return Err(StoreError::EventConflict);
            }
        }
        CellEvent::NotificationConsumed {
            notification, step, ..
        } => {
            let n=c.execute("UPDATE agent_cell_notifications SET consumed_step=?,consumed_fact=? WHERE notification=? AND consumed_step IS NULL",params![step.to_string(),id.to_string(),notification.to_string()])?;
            if n != 1 {
                return Err(invalid("Cell notification already consumed or absent"));
            }
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn apply(
    c: &Connection,
    session: &str,
    recorded: &RecordedFact,
    changes: &[Change],
) -> Result<(), StoreError> {
    if matches!(&recorded.fact, Fact::ContextCompacted { .. }) {
        c.execute(
            "DELETE FROM agent_session_loaded_tools WHERE session=?",
            [session],
        )?;
        return Ok(());
    }
    let Fact::Cell { event } = &recorded.fact else {
        return Ok(());
    };
    let view = if let CellEvent::Started { owner, .. } = event {
        let CellOwner::Agent { link, call } = owner else {
            return Err(invalid("Standalone Cell cannot enter Agent facts"));
        };
        if link.run != recorded.run {
            return Err(invalid("Cell AgentStepLink belongs to another Run"));
        }
        let row_exists: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_attempt_ids WHERE attempt=? AND run=? AND step=?)",
            params![
                link.attempt.to_string(),
                link.run.to_string(),
                link.step.to_string()
            ],
            |r| r.get(0),
        )?;
        if !row_exists {
            return Err(invalid("Cell owner is not an actual admitted Agent step"));
        }
        if recorded.id != event.cell().started_fact_id() {
            return Err(StoreError::EventConflict);
        }
        let key = ToolKey {
            attempt: link.attempt,
            call: call.clone(),
        };
        let body: Option<String> = c
            .query_row(
                "SELECT body FROM agent_tools WHERE run=? AND key=?",
                params![recorded.run.to_string(), crate::fold::tool_key(&key)],
                |r| r.get(0),
            )
            .optional()?;
        let parent: crate::fold::Tool =
            serde_json::from_str(&body.ok_or_else(|| invalid("Cell parent T1 was not recorded"))?)?;
        if parent.key != key || !parent.admitted || parent.accepted.is_some() {
            return Err(invalid("Cell parent has not passed actual T1 admission"));
        }
        if exists(c, event.cell(), Some(recorded.id))? {
            return Err(StoreError::EventConflict);
        }
        CellView::started(event).map_err(transition_error)?
    } else {
        let mut view =
            read(c, session, event.cell())?.ok_or_else(|| invalid("Cell has not started"))?;
        let CellOwner::Agent { link, .. } = &view.owner else {
            return Err(invalid("Standalone Cell cannot enter Agent facts"));
        };
        if link.run != recorded.run {
            return Err(invalid("Cell belongs to another Run"));
        }
        validate_batch(&view, event, changes)?;
        validate_notification(c, &view, event)?;
        match event {
            CellEvent::Interrupted { cell, report } => {
                let bytes = maka_event_log::content::read(c, &report.digest)?
                    .ok_or_else(|| invalid("missing Cell interruption report"))?;
                let report: CellInterruption = serde_json::from_slice(&bytes)?;
                if report.cell != *cell || report.children.keys().ne(view.children.keys()) {
                    return Err(invalid(
                        "Cell interruption report must contain every original child obligation",
                    ));
                }
            }
            CellEvent::ChildResultRecorded {
                operation,
                result,
                is_error,
                ..
            } => {
                let bytes = maka_event_log::content::read(c, &result.digest)?
                    .ok_or_else(|| invalid("missing Cell Host return content"))?;
                let returned: maka_agent_facts::artifact::ToolReturn<CellReturnedResult> =
                    serde_json::from_slice(&bytes)?;
                if returned.schema_version != SCHEMA_VERSION || returned.body.is_error != *is_error
                {
                    return Err(invalid("Cell Host return schema or status mismatch"));
                }
                let child = view
                    .children
                    .get(operation)
                    .ok_or_else(|| invalid("Cell Host child not prepared"))?;
                let maka_agent_facts::tool_output::ToolOutput::Operation(reply) =
                    returned.body.output
                else {
                    return Err(invalid("Cell Host return has no original provider reply"));
                };
                let matches_original = child.reply.as_ref().is_some_and(|original| {
                    if original.reference != reply.reference {
                        return false;
                    }
                    match (&original.receipt, &reply.receipt) {
                        (
                            maka_plugin_core::operation::Receipt::Recorded {
                                outcome: known, ..
                            },
                            maka_plugin_core::operation::Receipt::Recorded {
                                outcome: returned,
                                ..
                            },
                        ) => known == returned,
                        _ => false,
                    }
                });
                if !matches_original {
                    return Err(invalid(
                        "Cell Host return differs from original provider outcome",
                    ));
                }
            }
            CellEvent::ChildApprovalRecorded {
                cell,
                operation,
                approval,
                input,
                resources,
            } => crate::interactions::validate_cell_approval(
                c,
                recorded.run,
                *cell,
                *operation,
                *approval,
                input,
                resources,
            )?,
            CellEvent::ChildApprovalConsumed {
                cell,
                operation,
                approval,
            } => {
                let child = view
                    .children
                    .get(operation)
                    .ok_or_else(|| invalid("Cell approval child not prepared"))?;
                crate::interactions::consume_cell_approval(
                    c,
                    recorded.run,
                    *cell,
                    *operation,
                    *approval,
                    &child.input,
                    &child.resources,
                )?;
            }
            _ => {}
        }
        view.apply(event).map_err(transition_error)?;
        view
    };
    // Content validation is independent from execution grants and runs inside the writer transaction.
    for reference in event.content_refs() {
        content_id(c, reference)?;
    }
    project(c, session, Some(recorded.run), recorded.id, event, &view)
}
pub(crate) fn clear_run(c: &Connection, run: RunId) -> Result<(), StoreError> {
    c.execute("DELETE FROM agent_cell_operation_pins WHERE cell IN (SELECT cell FROM agent_cells WHERE run=?)",[run.to_string()])?;
    c.execute(
        "DELETE FROM agent_cell_notifications WHERE run=?",
        [run.to_string()],
    )?;
    c.execute("DELETE FROM agent_cells WHERE run=?", [run.to_string()])?;
    Ok(())
}
pub(crate) fn replay(
    c: &Connection,
    view: &crate::fold::RunView,
    recorded: &RecordedFact,
) -> Result<(), StoreError> {
    let Fact::Cell { event } = &recorded.fact else {
        return Ok(());
    };
    if view.run != recorded.run {
        return Err(invalid("Cell replay belongs to another Run"));
    }
    let cell = view
        .cells
        .get(&event.cell())
        .ok_or_else(|| invalid("missing prefix Cell view after canonical fold"))?;
    project(
        c,
        &view.spec.session_id,
        Some(recorded.run),
        recorded.id,
        event,
        cell,
    )
}
pub(crate) fn rebuild_run(c: &Connection, run: RunId) -> Result<(), StoreError> {
    let session: String = c.query_row(
        "SELECT session FROM agent_run_specs WHERE run=?",
        [run.to_string()],
        |r| r.get(0),
    )?;
    rebuild_session(c, &session)
}
pub(super) fn rebuild_session(c: &Connection, session: &str) -> Result<(), StoreError> {
    c.execute("DELETE FROM agent_cell_operation_pins WHERE cell IN (SELECT cell FROM agent_cells WHERE session=?)",[session])?;
    c.execute(
        "DELETE FROM agent_usage_calls WHERE source='cell' AND session=?",
        [session],
    )?;
    for table in [
        "agent_cells",
        "agent_cell_notifications",
        "agent_session_values",
        "agent_session_loaded_tools",
    ] {
        c.execute(&format!("DELETE FROM {table} WHERE session=?"), [session])?;
    }
    // Standalone sources record the Agent cursor visible in their original Root
    // transaction. This merges the two canonical owners in actual commit order.
    let mut q=c.prepare_cached("SELECT source,payload FROM (
        SELECT 0 AS source,f.sequence AS position,0 AS tie,c.payload
        FROM agent_facts f JOIN agent_run_specs r ON r.run=f.run JOIN contents c ON c.id=f.body_content_id WHERE r.session=?1
        UNION ALL SELECT 1 AS source,e.agent_cursor AS position,e.sequence AS tie,c.payload
        FROM agent_standalone_cell_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=?1
    ) ORDER BY position,source,tie")?;
    let mut rows = q.query([session])?;
    while let Some(r) = rows.next()? {
        let source: u32 = r.get(0)?;
        let bytes: Vec<u8> = r.get(1)?;
        let (id, run, event) = if source == 0 {
            let fact: RecordedFact = serde_json::from_slice(&bytes)?;
            if matches!(&fact.fact, Fact::ContextCompacted { .. }) {
                let spec: Vec<u8> = c.query_row(
                    "SELECT c.payload FROM agent_run_specs r JOIN contents c ON c.id=r.spec_content_id WHERE r.run=?",
                    [fact.run.to_string()],
                    |row| row.get(0),
                )?;
                let spec: RunSpec = serde_json::from_slice(&spec)?;
                if matches!(&spec.origin, RunOrigin::Local) {
                    c.execute(
                        "DELETE FROM agent_session_loaded_tools WHERE session=?",
                        [session],
                    )?;
                }
                continue;
            }
            if let Fact::ToolsLoaded { names, .. } = &fact.fact {
                merge_loaded(c, session, fact.id, names)?;
                continue;
            }
            let Fact::Cell { event } = fact.fact else {
                continue;
            };
            (fact.id, Some(fact.run), event)
        } else {
            let event: StandaloneEvent = serde_json::from_slice(&bytes)?;
            (event.id, None, event.event)
        };
        let view = match &event {
            CellEvent::Started { .. } => CellView::started(&event).map_err(transition_error)?,
            _ => {
                let mut v = read(c, session, event.cell())?
                    .ok_or_else(|| invalid("missing Cell start during rebuild"))?;
                v.apply(&event).map_err(transition_error)?;
                v
            }
        };
        project(c, session, run, id, &event, &view)?;
    }
    drop(rows);
    drop(q);
    let mut cursor = 0i64;
    loop {
        let mut query=c.prepare_cached("SELECT e.sequence,c.payload FROM agent_standalone_cell_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=? AND e.sequence>? ORDER BY e.sequence LIMIT 128")?;
        let page = query
            .query_map(params![session, cursor], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if page.is_empty() {
            break;
        }
        for (sequence, bytes) in page {
            let event: StandaloneEvent = serde_json::from_slice(&bytes)?;
            crate::usage::index_cell(
                c,
                None,
                crate::usage::UsagePosition {
                    source: "cell",
                    session,
                    run: None,
                    sequence: u64::try_from(sequence)
                        .map_err(|_| invalid("negative standalone Cell sequence"))?,
                    at: event.at,
                },
                &event.event,
            )?;
            cursor = sequence;
        }
    }

    Ok(())
}

pub(crate) fn read_cell(c: &Connection, run: RunId, cell: CellId) -> Result<CellView, StoreError> {
    let session: String = c.query_row(
        "SELECT session FROM agent_run_specs WHERE run=?",
        [run.to_string()],
        |r| r.get(0),
    )?;
    let view =
        read(c, &session, cell)?.ok_or_else(|| invalid("Cell was not recorded in this session"))?;
    if !matches!(&view.owner,CellOwner::Agent{link,..} if link.run==run) {
        return Err(invalid("Cell belongs to another owner"));
    }
    Ok(view)
}

pub(crate) fn native_source_pending(
    c: &Connection,
    cell: CellId,
    operation: uuid::Uuid,
    execution: &ExecutionIdentity,
    reference: &maka_plugin_core::operation::RecoveryRef,
) -> Result<bool, StoreError> {
    let view = read_cell(c, execution.run_id, cell)?;
    let CellOwner::Agent { link, .. } = &view.owner else {
        return Err(invalid("Agent source cannot use a standalone Cell"));
    };
    let original: Vec<u8> = c.query_row(
        "SELECT c.payload FROM agent_run_specs r JOIN contents c ON c.id=r.spec_content_id WHERE r.run=?",
        [link.run.to_string()],
        |r| r.get(0),
    )?;
    let spec: RunSpec = serde_json::from_slice(&original)?;
    let canonical = ExecutionIdentity {
        session_id: spec.session_id,
        turn_id: spec.turn_id,
        run_id: link.run,
    };
    if execution != &canonical {
        return Err(invalid(
            "Cell source execution differs from its canonical Run",
        ));
    }
    let actual: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_attempt_ids WHERE run=? AND step=? AND attempt=?)",
        params![
            link.run.to_string(),
            link.step.to_string(),
            link.attempt.to_string()
        ],
        |r| r.get(0),
    )?;
    let child = view
        .children
        .get(&operation)
        .ok_or_else(|| invalid("Cell source child was not prepared"))?;
    if !actual || child.reference.as_ref() != Some(reference) {
        return Err(invalid(
            "Cell source does not match original admitted operation",
        ));
    }
    Ok(matches!(view.status, CellStatus::Running) && child.admitted && !child.known())
}
pub(crate) fn verify_native_source(
    c: &Connection,
    cell: CellId,
    operation: uuid::Uuid,
    execution: &ExecutionIdentity,
    reference: &maka_plugin_core::operation::RecoveryRef,
) -> Result<String, StoreError> {
    if !native_source_pending(c, cell, operation, execution, reference)? {
        return Err(invalid(
            "Cell source is no longer an active original operation",
        ));
    }
    Ok(format!("cell:{cell}:{operation}"))
}

pub(super) fn merge_loaded(
    c: &Connection,
    session: &str,
    id: FactId,
    names: &BTreeSet<String>,
) -> Result<(), StoreError> {
    let mut all = loaded(c, session)?;
    all.extend(names.iter().cloned());
    c.execute("INSERT INTO agent_session_loaded_tools(session,body,fact_id) VALUES(?,?,?) ON CONFLICT(session) DO UPDATE SET body=excluded.body,fact_id=excluded.fact_id",params![session,serde_json::to_string(&all)?,id.to_string()])?;
    Ok(())
}
