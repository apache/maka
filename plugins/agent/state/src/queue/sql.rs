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
use crate::{Change, store::invalid};
use maka_agent_facts::{artifact::content_digest, message::RootSourceMessage};
use maka_event_log::content;
use rusqlite::{OptionalExtension, params};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum DeliveryTarget {
    Run,
    Step {
        step: StepId,
    },
    External {
        task: ExternalTaskId,
        steering: uuid::Uuid,
        descriptor: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Event {
    Command {
        expected_revision: u64,
        edit: QueueEdit,
    },
    CallerStopped {
        caller: RunId,
    },
    SteeringReleased {
        run: RunId,
    },
    Consumed {
        cut: Consume,
        run: RunId,
        target: DeliveryTarget,
    },
}
fn id(value: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 1024 || value.contains('\0') {
        return Err(invalid("invalid queue identity"));
    }
    Ok(())
}
fn to_sql_integer(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("queue integer exceeds SQLite range"))
}
fn from_sql_integer(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("queue SQL integer is negative"))
}
fn revision(c: &Connection, session: &str) -> Result<u64, StoreError> {
    from_sql_integer(
        c.query_row(
            "SELECT revision FROM agent_queue_heads WHERE session=?",
            [session],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0),
    )
}
fn cas(c: &Connection, session: &str, expected: u64) -> Result<u64, StoreError> {
    let actual = revision(c, session)?;
    if actual != expected {
        return Err(StoreError::RevisionConflict {
            expected: expected.to_string(),
            actual: actual.to_string(),
        });
    }
    expected
        .checked_add(1)
        .filter(|v| *v <= maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("queue revision exhausted"))
}
fn head(c: &Connection, session: &str, revision: u64) -> Result<(), StoreError> {
    c.execute("INSERT INTO agent_queue_heads(session,revision) VALUES(?,?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision", params![session,to_sql_integer(revision)?])?;
    Ok(())
}
fn exact_content(c: &Connection, reference: &ContentRef) -> Result<Vec<u8>, StoreError> {
    reference.validate().map_err(invalid)?;
    let bytes = content::read(c, &reference.digest)?
        .ok_or_else(|| invalid("missing pinned queue content"))?;
    if bytes.len() as u64 != reference.bytes || content_digest(&bytes) != reference.digest {
        return Err(invalid("corrupt queue content"));
    }
    Ok(bytes)
}
fn put(c: &Connection, blob: &ContentBlob) -> Result<i64, StoreError> {
    blob.store(c)
}
fn pin(
    c: &Connection,
    session: &str,
    request: &RequestId,
    reference: &ContentRef,
) -> Result<(), StoreError> {
    reference.validate().map_err(invalid)?;
    let content_id: i64 = c
        .query_row(
            "SELECT id FROM contents WHERE content_sha256=? AND length(payload)=?",
            params![reference.digest, to_sql_integer(reference.bytes)?],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| invalid("missing queue evidence content"))?;
    c.execute(
        "INSERT OR IGNORE INTO agent_queue_content_pins(session,request,content_id) VALUES(?,?,?)",
        params![session, request.0, content_id],
    )?;
    Ok(())
}
fn references(request: &PreparedRequest) -> Vec<&ContentRef> {
    let mut refs = vec![&request.source, &request.resources];
    refs.extend(request.spec.content_refs());
    refs
}
fn source(c: &Connection, request: &PreparedRequest) -> Result<RootSourceMessage, StoreError> {
    let source: RootSourceMessage = serde_json::from_slice(&exact_content(c, &request.source)?)?;
    source.validate().map_err(invalid)?;
    if source.message.message_id != request.message_id {
        return Err(invalid("queue message/source identity differs"));
    }
    Ok(source)
}
fn validate_request(
    c: &Connection,
    session: &str,
    request: &PreparedRequest,
) -> Result<RootSourceMessage, StoreError> {
    id(session)?;
    id(&request.id.0)?;
    id(&request.message_id)?;
    id(&request.spec.turn_id)?;
    if request.spec.session_id != session
        || request.spec.schema_version != SCHEMA_VERSION
        || !matches!(request.spec.origin, RunOrigin::Local)
    {
        return Err(invalid(
            "queue request is not a local request for this session/schema",
        ));
    }
    let source = source(c, request)?;
    let matches_source = match &request.spec.trigger {
        Trigger::Message { .. } => is_interactive(request, &source),
        Trigger::Goal { goal_id } => {
            request.spec.budget_basis.is_some()
                && matches!(&source.message.origin,
                    Some(maka_agent_facts::message::MessageOrigin::Goal { goal_id: original, .. })
                        if original.parse::<uuid::Uuid>().ok().as_ref() == Some(goal_id))
        }
        Trigger::Schedule { schedule_id } => {
            id(schedule_id)?;
            source.message.origin.is_none() && request.spec.budget_basis.is_some()
        }
        Trigger::Continuation { .. } | Trigger::ContextCompact | Trigger::HistorySource => false,
    };
    if !matches_source {
        return Err(invalid(
            "queue RunSpec trigger differs from original message",
        ));
    }
    for reference in references(request) {
        reference.validate().map_err(invalid)?;
    }
    Ok(source)
}
fn is_interactive(request: &PreparedRequest, source: &RootSourceMessage) -> bool {
    matches!(&request.spec.trigger, Trigger::Message { message_id } if message_id == &request.message_id)
        && request.spec.budget_basis.is_none()
        && !matches!(
            &source.message.origin,
            Some(maka_agent_facts::message::MessageOrigin::Goal { .. })
        )
}
fn run_head(c: &Connection, run: RunId) -> Result<(RunSpec, Head, bool, bool), StoreError> {
    let row: Option<(Vec<u8>,u32,i64,i64,bool,bool)> = c.query_row(
        "SELECT c.payload,r.schema_version,r.revision,r.control_version,r.stopped,r.terminal IS NOT NULL FROM agent_run_specs s JOIN contents c ON c.id=s.spec_content_id JOIN agent_runs r ON r.run=s.run WHERE s.run=?",
        [run.to_string()], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (body, version, revision, control_version, stopped, terminal) =
        row.ok_or_else(|| invalid("steering Run not found"))?;
    let spec: RunSpec = serde_json::from_slice(&body)?;
    if version != crate::sql::HEADER_SCHEMA_VERSION || spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("unsupported steering Run schema"));
    }
    Ok((
        spec,
        Head {
            revision: from_sql_integer(revision)?,
            control_version: from_sql_integer(control_version)?,
        },
        stopped,
        terminal,
    ))
}
fn target(
    c: &Connection,
    session: &str,
    owner: &RunOwner,
    target: &SteeringTarget,
) -> Result<(), StoreError> {
    let (spec, actual, stopped, terminal) = run_head(c, target.run)?;
    if spec.session_id != session
        || &spec.owner != owner
        || !matches!(spec.origin, RunOrigin::Local)
        || stopped
        || terminal
    {
        return Err(invalid(
            "steering target is not a live local Run owned by this session",
        ));
    }
    if actual != target.expected_head {
        return Err(StoreError::RevisionConflict {
            expected: serde_json::to_string(&target.expected_head)?,
            actual: serde_json::to_string(&actual)?,
        });
    }
    Ok(())
}
fn followup(
    c: &Connection,
    session: &str,
    event: &Event,
    original: RunId,
) -> Result<(), StoreError> {
    fn rejected(reason: &str) -> StoreError {
        StoreError::StatementRejected {
            diagnostic: "agent_admission_failed".into(),
            cause: Arc::new(invalid(reason)),
        }
    }
    let Event::Command {
        edit:
            QueueEdit::Enqueue {
                request,
                placement: Placement::Followup,
            },
        ..
    } = event
    else {
        return Err(rejected("original Run fence requires a follow-up Enqueue"));
    };
    if request.spec.session_id != session {
        return Err(rejected("follow-up request belongs to another session"));
    }
    let owner = serde_json::to_string(&request.spec.owner)?;
    type OriginalRunRow = (u32, Vec<u8>, u32, String, String, i64, i64);
    let row: Option<OriginalRunRow> = c
        .query_row(
            "SELECT s.schema_version,b.payload,r.schema_version,r.owner,r.session,r.local,r.stopped
         FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id
         JOIN agent_runs r ON r.run=s.run
         WHERE s.run=?1 AND s.owner=?2 AND s.session=?3",
            params![original.to_string(), owner, session],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()?;
    let (spec_schema, body, run_schema, run_owner, run_session, local, stopped) = row
        .ok_or_else(|| rejected("original follow-up Run is missing or belongs to another scope"))?;
    let spec: RunSpec = serde_json::from_slice(&body)?;
    if spec_schema != SCHEMA_VERSION
        || run_schema != crate::sql::HEADER_SCHEMA_VERSION
        || spec.schema_version != SCHEMA_VERSION
    {
        return Err(rejected("unsupported original follow-up Run schema"));
    }
    if spec.owner != request.spec.owner
        || spec.session_id != session
        || !matches!(spec.origin, RunOrigin::Local)
        || run_owner != owner
        || run_session != session
        || local != 1
        || !matches!(stopped, 0 | 1)
    {
        return Err(rejected(
            "original follow-up Run scope or canonical Local metadata differs",
        ));
    }
    if stopped != 0 {
        return Err(rejected("original follow-up Run has been stopped"));
    }
    Ok(())
}

fn previous(
    c: &Connection,
    session: &str,
    command: FactId,
    event: &Event,
) -> Result<Option<u64>, StoreError> {
    let row: Option<(i64,Vec<u8>)> = c.query_row("SELECT e.revision,c.payload FROM agent_queue_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=? AND e.id=?", params![session,command.to_string()], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(revision, body)| {
        if serde_json::from_slice::<Event>(&body)? != *event {
            return Err(StoreError::EventConflict);
        }
        from_sql_integer(revision)
    })
    .transpose()
}
fn record(
    c: &Connection,
    session: &str,
    revision: u64,
    command: FactId,
    at: UnixMillis,
    event: &Event,
) -> Result<(), StoreError> {
    let blob = ContentBlob::json(event)?;
    let content_id = put(c, &blob)?;
    c.execute(
        "INSERT INTO agent_queue_events(session,revision,id,at,body_content_id) VALUES(?,?,?,?,?)",
        params![
            session,
            to_sql_integer(revision)?,
            command.to_string(),
            at.0,
            content_id
        ],
    )?;
    crate::session_history::index_queue(c, session, revision)?;
    head(c, session, revision)
}
pub(super) fn write(
    c: &Connection,
    session: &str,
    command: QueueCommand,
    contents: Vec<ContentBlob>,
    admission_fence: Option<RunId>,
) -> Result<(QueueCommit, bool), StoreError> {
    id(session)?;
    let event = Event::Command {
        expected_revision: command.expected_revision,
        edit: command.edit,
    };
    if let Some(revision) = previous(c, session, command.id, &event)? {
        return Ok((QueueCommit { revision }, false));
    }
    if let Some(original) = admission_fence {
        followup(c, session, &event, original)?;
    }
    let next = cas(c, session, command.expected_revision)?;
    for blob in &contents {
        put(c, blob)?;
    }
    project(c, session, next, &event, true)?;
    record(c, session, next, command.id, command.at, &event)?;
    Ok((QueueCommit { revision: next }, true))
}
pub(crate) fn retract_interactive(
    c: &Connection,
    session: &str,
    stop: &Change,
) -> Result<(), StoreError> {
    use sha2::{Digest, Sha256};

    let queue = read(c, session, None)?;
    let mut expected_revision = queue.revision;
    for entry in queue.entries {
        let source = source(c, &entry.request)?;
        if !is_interactive(&entry.request, &source)
            || matches!(
                source.message.origin,
                Some(maka_agent_facts::message::MessageOrigin::BotWorker { .. })
            )
        {
            continue;
        }
        let mut hash = Sha256::new();
        hash.update(b"stop-retract");
        hash.update(stop.id.as_uuid().as_bytes());
        hash.update(entry.request.id.0.as_bytes());
        let bytes = hash.finalize()[..16].try_into().expect("SHA256 prefix");
        let command = QueueCommand {
            id: FactId::try_from(uuid::Uuid::from_bytes(bytes)).expect("non-nil control identity"),
            at: stop.at,
            expected_revision,
            edit: QueueEdit::Retract {
                request: entry.request.id,
            },
        };
        let (commit, _) = write(c, session, command, Vec::new(), None)?;
        expected_revision = commit.revision;
    }
    Ok(())
}

fn row_entry(
    c: &Connection,
    session: &str,
    request: &RequestId,
) -> Result<Option<(QueueEntry, String, u64)>, StoreError> {
    let row: Option<(String, String, i64)> = c
        .query_row(
            "SELECT entry_json,state,position FROM agent_queue_items WHERE session=? AND request=?",
            params![session, request.0],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    row.map(|(body, state, position)| {
        Ok((
            serde_json::from_str(&body)?,
            state,
            from_sql_integer(position)?,
        ))
    })
    .transpose()
}
fn pending(
    c: &Connection,
    session: &str,
    request: &RequestId,
) -> Result<(QueueEntry, u64), StoreError> {
    let (entry, state, position) =
        row_entry(c, session, request)?.ok_or_else(|| invalid("queue request not found"))?;
    if state != "pending" {
        return Err(invalid("queue request is no longer pending"));
    }
    Ok((entry, position))
}
fn placement_columns(placement: &Placement) -> (&'static str, Option<String>) {
    match placement {
        Placement::Followup | Placement::Completion { .. } => ("followup", None),
        Placement::Steering { run, .. } => ("steering", Some(run.to_string())),
    }
}
fn update_entry(c: &Connection, session: &str, entry: &QueueEntry) -> Result<(), StoreError> {
    let (lane, target) = placement_columns(&entry.placement);
    c.execute("UPDATE agent_queue_items SET entry_json=?,lane=?,target_run=? WHERE session=? AND request=?",params![serde_json::to_string(entry)?,lane,target,session,entry.request.id.0])?;
    Ok(())
}
fn project(
    c: &Connection,
    session: &str,
    next: u64,
    event: &Event,
    check: bool,
) -> Result<(), StoreError> {
    match event {
        Event::Command { edit, .. } => {
            match edit {
                QueueEdit::Enqueue { request, placement } => {
                    let source = validate_request(c, session, request)?;
                    if matches!(placement, Placement::Steering { .. })
                        && !is_interactive(request, &source)
                    {
                        return Err(invalid(
                            "only interactive queue messages can be steered or edited",
                        ));
                    }
                    crate::artifacts::pin_request(c, request, &source)?;
                    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_queue_items WHERE session=? AND (request=? OR message=?))",params![session,request.id.0,request.message_id],|r|r.get(0))?;
                    if exists {
                        return Err(StoreError::EventConflict);
                    }
                    if check && let Placement::Steering { run, expected_head } = placement {
                        target(
                            c,
                            session,
                            &request.spec.owner,
                            &SteeringTarget {
                                run: *run,
                                expected_head: *expected_head,
                            },
                        )?;
                    }
                    for reference in references(request) {
                        pin(c, session, &request.id, reference)?;
                    }
                    let entry = QueueEntry {
                        request: *request.clone(),
                        placement: placement.clone(),
                    };
                    let (lane, mut target) = placement_columns(placement);
                    if let Placement::Completion { caller } = placement {
                        let (original, _, stopped, _) = run_head(c, *caller)?;
                        if !matches!(
                            &source.message.origin,
                            Some(
                                maka_agent_facts::message::MessageOrigin::SessionCompletion { .. }
                            )
                        ) || original.session_id != session
                            || original.owner != request.spec.owner
                            || !matches!(original.origin, RunOrigin::Local)
                            || !matches!(original.backend, BackendSpec::Model { .. })
                            || (check && stopped)
                        {
                            return Err(invalid("completion does not match its original caller"));
                        }
                        if original.workspace == request.spec.workspace
                            && original.permission_basis == request.spec.permission_basis
                        {
                            target = Some(caller.to_string());
                        }
                    }
                    c.execute("INSERT INTO agent_queue_items(session,request,message,owner,position,lane,target_run,state,entry_json) VALUES(?,?,?,?,?,?,?,'pending',?)",params![session,request.id.0,request.message_id,serde_json::to_string(&request.spec.owner)?,to_sql_integer(next)?,lane,target,serde_json::to_string(&entry)?])?;
                }
                QueueEdit::Update { request } => {
                    let (mut old, _) = pending(c, session, &request.id)?;
                    let before = source(c, &old.request)?;
                    if !is_interactive(&old.request, &before) {
                        return Err(invalid(
                            "only interactive queue messages can be steered or edited",
                        ));
                    }
                    let after = validate_request(c, session, request)?;
                    if !is_interactive(request, &after) {
                        return Err(invalid(
                            "only interactive queue messages can be steered or edited",
                        ));
                    }
                    crate::artifacts::pin_request(c, request, &after)?;
                    if old.request.message_id != request.message_id
                        || old.request.spec.owner != request.spec.owner
                        || old.request.spec.turn_id != request.spec.turn_id
                        || before.message.origin != after.message.origin
                        || before.message.submitted_content_digest
                            != after.message.submitted_content_digest
                        || before.submitted_placement != after.submitted_placement
                        || before.submitted_intent != after.submitted_intent
                    {
                        return Err(invalid("queue edit changed immutable request provenance"));
                    }
                    if matches!(old.placement, Placement::Completion { .. })
                        && (old.request.spec.workspace != request.spec.workspace
                            || old.request.spec.permission_basis != request.spec.permission_basis)
                    {
                        return Err(invalid("queue edit changed the completion workspace basis"));
                    }
                    for reference in references(request) {
                        pin(c, session, &request.id, reference)?;
                    }
                    old.request = *request.clone();
                    c.execute(
                        "UPDATE agent_queue_items SET entry_json=? WHERE session=? AND request=?",
                        params![serde_json::to_string(&old)?, session, request.id.0],
                    )?;
                }
                QueueEdit::Retract { request } => {
                    pending(c, session, request)?;
                    c.execute("UPDATE agent_queue_items SET state='cancelled' WHERE session=? AND request=?",params![session,request.0])?;
                }
                QueueEdit::RetractAll => {
                    c.execute("UPDATE agent_queue_items SET state='cancelled' WHERE session=? AND state='pending'",[session])?;
                }
                QueueEdit::Promote {
                    request,
                    target: steering,
                } => {
                    let (mut entry, _) = pending(c, session, request)?;
                    let source = source(c, &entry.request)?;
                    if !is_interactive(&entry.request, &source) {
                        return Err(invalid(
                            "only interactive queue messages can be steered or edited",
                        ));
                    }
                    if !matches!(entry.placement, Placement::Followup) {
                        return Err(invalid("request is already steering"));
                    }
                    if check {
                        target(c, session, &entry.request.spec.owner, steering)?;
                    }
                    entry.placement = Placement::Steering {
                        run: steering.run,
                        expected_head: steering.expected_head,
                    };
                    update_entry(c, session, &entry)?;
                    c.execute(
                        "UPDATE agent_queue_items SET position=? WHERE session=? AND request=?",
                        params![to_sql_integer(next)?, session, request.0],
                    )?;
                }
                QueueEdit::Reorder { requests } => {
                    if requests.is_empty() {
                        return Err(invalid("empty queue reorder"));
                    }
                    let first = pending(c, session, &requests[0])?.0;
                    let (lane, _) = placement_columns(&first.placement);
                    let count: i64 = c.query_row("SELECT count(*) FROM agent_queue_items WHERE session=? AND state='pending' AND lane=?",params![session,lane],|r|r.get(0))?;
                    let unique: BTreeSet<_> = requests.iter().collect();
                    if count
                        != i64::try_from(requests.len())
                            .map_err(|_| invalid("queue length exceeds SQLite range"))?
                        || unique.len() != requests.len()
                    {
                        return Err(invalid("reorder must name exactly the pending lane"));
                    }
                    for (position, request) in requests.iter().enumerate() {
                        let item = pending(c, session, request)?.0;
                        if placement_columns(&item.placement).0 != lane {
                            return Err(invalid("reorder crosses queue lanes"));
                        }
                        c.execute(
                            "UPDATE agent_queue_items SET position=? WHERE session=? AND request=?",
                            params![
                                i64::try_from(position)
                                    .map_err(|_| invalid("queue position exceeds SQLite range"))?,
                                session,
                                request.0
                            ],
                        )?;
                    }
                }
            };
        }
        Event::CallerStopped { caller } => {
            retract_completions(c, session, *caller)?;
        }
        Event::SteeringReleased { run } => {
            move_steering_to_followup(c, session, *run)?;
        }
        Event::Consumed { cut, run, target } => {
            for request in &cut.requests {
                pending(c, session, request)?;
                c.execute("UPDATE agent_queue_items SET state='delivered',accepted_run=?,shared=? WHERE session=? AND request=?",params![run.to_string(),!matches!(target,DeliveryTarget::Run),session,request.0])?;
            }
        }
    }
    Ok(())
}
fn move_steering_to_followup(
    c: &Connection,
    session: &str,
    run: RunId,
) -> Result<usize, StoreError> {
    Ok(c.execute(
        "UPDATE agent_queue_items
         SET lane='followup', target_run=NULL, entry_json=json_set(entry_json,'$.placement',json(?3))
         WHERE session=?1 AND target_run=?2 AND state='pending' AND lane='steering'",
        params![session, run.to_string(), serde_json::to_string(&Placement::Followup)?],
    )?)
}

pub(crate) fn release_steering(
    c: &Connection,
    session: &str,
    run: RunId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    if move_steering_to_followup(c, session, run)? == 0 {
        return Ok(());
    }
    let next = cas(c, session, revision(c, session)?)?;
    record(
        c,
        session,
        next,
        FactId::new(),
        at,
        &Event::SteeringReleased { run },
    )
}

pub(super) fn recover_stopped_goal_steering(
    c: &Connection,
    owner: &RunOwner,
    at: UnixMillis,
) -> Result<BTreeSet<String>, StoreError> {
    let rows = c
        .prepare_cached(
            "SELECT DISTINCT q.session,q.target_run
         FROM agent_queue_items q
         JOIN agent_runs r ON r.run=q.target_run AND r.session=q.session AND r.owner=q.owner
         JOIN agent_facts f ON f.run=r.run AND f.id=r.stop_request
         JOIN contents b ON b.id=f.body_content_id
         WHERE q.owner=?1 AND q.state='pending' AND q.lane='steering'
           AND json_extract(b.payload,'$.fact.diagnostic')=?2",
        )?
        .query_map(
            params![serde_json::to_string(owner)?, GOAL_CONTROL_STOP],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sessions = BTreeSet::new();
    for (session, run) in rows {
        let run = RunId::try_from(
            uuid::Uuid::parse_str(&run).map_err(|_| invalid("invalid stopped steering Run"))?,
        )
        .map_err(invalid)?;
        release_steering(c, &session, run, at)?;
        sessions.insert(session);
    }
    Ok(sessions)
}
fn retract_completions(c: &Connection, session: &str, caller: RunId) -> Result<usize, StoreError> {
    Ok(c.execute(
        "UPDATE agent_queue_items SET state='cancelled'
         WHERE session=?1 AND state='pending' AND lane='followup'
           AND json_extract(entry_json,'$.placement.kind')='completion'
           AND json_extract(entry_json,'$.placement.caller')=?2",
        params![session, caller.to_string()],
    )?)
}

pub(crate) fn stop_completions(
    c: &Connection,
    session: &str,
    caller: RunId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    if retract_completions(c, session, caller)? == 0 {
        return Ok(());
    }
    let current = revision(c, session)?;
    let next = cas(c, session, current)?;
    record(
        c,
        session,
        next,
        FactId::new(),
        at,
        &Event::CallerStopped { caller },
    )
}

fn steering_entries(
    c: &Connection,
    session: &str,
    run: RunId,
    limit: i64,
) -> Result<Vec<QueueEntry>, StoreError> {
    c.prepare_cached(
        "SELECT entry_json FROM agent_queue_items
         WHERE session=? AND target_run=? AND state='pending'
         ORDER BY position,request LIMIT ?",
    )?
    .query_map(params![session, run.to_string(), limit], |row| {
        row.get::<_, String>(0)
    })?
    .map(|row| Ok(serde_json::from_str(&row?)?))
    .collect()
}

pub(super) fn read(c: &Connection, session: &str, run: Option<RunId>) -> Result<Queue, StoreError> {
    id(session)?;
    let entries = if let Some(run) = run {
        steering_entries(c, session, run, -1)?
    } else {
        c.prepare_cached("SELECT entry_json FROM agent_queue_items WHERE session=? AND state='pending' ORDER BY CASE lane WHEN 'steering' THEN 0 ELSE 1 END,position,request")?
            .query_map([session], |row| row.get::<_, String>(0))?
            .map(|row| Ok(serde_json::from_str(&row?)?))
            .collect::<Result<_, StoreError>>()?
    };
    Ok(Queue {
        revision: revision(c, session)?,
        entries,
    })
}
pub(super) fn entry(
    c: &Connection,
    session: &str,
    request: &RequestId,
) -> Result<Option<QueueEntry>, StoreError> {
    id(session)?;
    id(&request.0)?;
    Ok(row_entry(c, session, request)?.map(|row| row.0))
}
pub(super) fn resolve(
    c: &Connection,
    session: &str,
    message: &str,
) -> Result<MessageResolution, StoreError> {
    id(session)?;
    id(message)?;
    let row: Option<(String, Option<String>, bool)> = c
        .query_row(
            "SELECT state,accepted_run,shared FROM agent_queue_items WHERE session=? AND message=?",
            params![session, message],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        None => Ok(MessageResolution::Missing),
        Some((state, run, shared)) => match state.as_str() {
            "pending" => Ok(MessageResolution::Pending),
            "cancelled" => Ok(MessageResolution::Cancelled),
            "delivered" => Ok(MessageResolution::Delivered {
                run: RunId::try_from(
                    uuid::Uuid::parse_str(&run.ok_or_else(|| invalid("missing delivered Run"))?)
                        .map_err(|_| invalid("invalid delivered Run"))?,
                )
                .map_err(invalid)?,
                shared,
            }),
            _ => Err(invalid("invalid queue delivery state")),
        },
    }
}
pub(super) fn owned_content(
    c: &Connection,
    session: &str,
    request: &RequestId,
    reference: &ContentRef,
) -> Result<Vec<u8>, StoreError> {
    id(session)?;
    id(&request.0)?;
    let owns: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_queue_content_pins p JOIN contents c ON c.id=p.content_id WHERE p.session=? AND p.request=? AND c.content_sha256=?)",params![session,request.0,reference.digest],|r|r.get(0))?;
    if !owns {
        return Err(invalid("content is not pinned by this queue request"));
    }
    exact_content(c, reference)
}
pub(super) fn ready(
    c: &Connection,
    owner: &RunOwner,
    after: Option<&ReadyCursor>,
    limit: u32,
) -> Result<Vec<ReadyEntry>, StoreError> {
    if !(1..=256).contains(&limit) {
        return Err(invalid("queue page limit must be 1..=256"));
    }
    let (session, position, request) = match after {
        Some(cursor) => (
            cursor.session.as_str(),
            cursor.position,
            cursor.request.0.as_str(),
        ),
        None => ("", 0, ""),
    };
    let rows = c.prepare_cached("SELECT session,position,request,entry_json FROM agent_queue_items WHERE owner=?1 AND state='pending' AND (session,position,request)>(?2,?3,?4) ORDER BY session,position,request LIMIT ?5")?.query_map(params![serde_json::to_string(owner)?,session,to_sql_integer(position)?,request,limit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
    rows.into_iter()
        .map(|(session, position, request, body)| {
            Ok(ReadyEntry {
                cursor: ReadyCursor {
                    session,
                    position: from_sql_integer(position)?,
                    request: RequestId(request),
                },
                entry: serde_json::from_str(&body)?,
            })
        })
        .collect()
}
pub(super) fn rebuild(c: &Connection, session: &str) -> Result<QueueCommit, StoreError> {
    id(session)?;
    c.execute("DELETE FROM agent_queue_items WHERE session=?", [session])?;
    c.execute("DELETE FROM agent_queue_heads WHERE session=?", [session])?;
    let mut after = 0;
    loop {
        let rows = c.prepare_cached("SELECT e.revision,c.payload FROM agent_queue_events e JOIN contents c ON c.id=e.body_content_id WHERE e.session=? AND e.revision>? ORDER BY e.revision LIMIT 128")?.query_map(params![session,to_sql_integer(after)?],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,Vec<u8>>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
        if rows.is_empty() {
            break;
        }
        for (revision, body) in rows {
            let revision = from_sql_integer(revision)?;
            if after.checked_add(1) != Some(revision) {
                return Err(invalid("noncontiguous queue canonical stream"));
            }
            let event: Event = serde_json::from_slice(&body)?;
            project(c, session, revision, &event, false)?;
            head(c, session, revision)?;
            after = revision;
        }
    }
    Ok(QueueCommit { revision: after })
}

/// Called only inside the statement which writes RunAdmitted. There is no
/// standalone mark-delivered API: the request and Run share one durable commit.
pub(crate) fn consume(
    c: &Connection,
    cut: &Consume,
    spec: &RunSpec,
    run: RunId,
    command: FactId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let event = Event::Consumed {
        cut: cut.clone(),
        run,
        target: DeliveryTarget::Run,
    };
    if previous(c, &cut.session, command, &event)?.is_some() {
        return Ok(());
    }
    id(&cut.session)?;
    if cut.requests.len() != 1 {
        return Err(invalid("one Run admission consumes exactly one request"));
    }
    let next = cas(c, &cut.session, cut.expected_revision)?;
    let (entry, _) = pending(c, &cut.session, &cut.requests[0])?;
    if !entry.placement.is_followup() || entry.request.spec != *spec {
        return Err(invalid(
            "Run admission does not match frozen followup request",
        ));
    }
    if let Placement::Completion { caller } = entry.placement {
        let (_, _, stopped, terminal) = run_head(c, caller)?;
        if stopped || !terminal {
            return Err(invalid(
                "completion followup requires a finished, unstopped caller",
            ));
        }
    }
    project(c, &cut.session, next, &event, true)?;
    record(c, &cut.session, next, command, at, &event)
}

/// Called with the exact immutable RequestSpec of the StepPrepared in this
/// statement, before its derived step row exists. Captured source order and
/// queue consumption are inseparable, including when the commit ack is lost.
pub(crate) fn consume_steering(
    c: &Connection,
    cut: &Consume,
    run: RunId,
    step: StepId,
    request: &ContentRef,
    command: FactId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let event = Event::Consumed {
        cut: cut.clone(),
        run,
        target: DeliveryTarget::Step { step },
    };
    if previous(c, &cut.session, command, &event)?.is_some() {
        return Ok(());
    }
    id(&cut.session)?;
    if cut.requests.is_empty() {
        return Err(invalid("empty steering consumption"));
    }
    let next = cas(c, &cut.session, cut.expected_revision)?;
    let spec: RequestSpec = serde_json::from_slice(&exact_content(c, request)?)?;
    if spec.step != step || spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("steering request Step/schema mismatch"));
    }
    let (run_spec, entries) = steering_requests(c, cut, run)?;
    if !matches!(run_spec.backend, BackendSpec::Model { .. }) {
        return Err(invalid("model steering requires the original model Run"));
    }
    let captured: Vec<_> = entries.into_iter().map(|request| request.source).collect();
    if spec.steering != captured {
        return Err(invalid(
            "RequestSpec did not capture the exact steering source prefix",
        ));
    }
    project(c, &cut.session, next, &event, true)?;
    record(c, &cut.session, next, command, at, &event)
}

fn steering_requests(
    c: &Connection,
    cut: &Consume,
    run: RunId,
) -> Result<(RunSpec, Vec<PreparedRequest>), StoreError> {
    id(&cut.session)?;
    if cut.requests.is_empty() {
        return Err(invalid("empty steering consumption"));
    }
    let (run_spec, _, stopped, terminal) = run_head(c, run)?;
    if run_spec.session_id != cut.session
        || !matches!(run_spec.origin, RunOrigin::Local)
        || stopped
        || terminal
    {
        return Err(invalid(
            "stopped, terminal or historical Run cannot consume steering",
        ));
    }
    // The enclosing Append already checks the live claim and exact Run head.
    let limit = i64::try_from(cut.requests.len())
        .map_err(|_| invalid("steering prefix exceeds SQLite range"))?;
    let prefix = steering_entries(c, &cut.session, run, limit)?;
    if prefix.len() != cut.requests.len()
        || prefix
            .iter()
            .zip(&cut.requests)
            .any(|(entry, id)| &entry.request.id != id)
    {
        return Err(invalid(
            "steering consume does not name the exact ordered pending prefix",
        ));
    }
    let mut entries = Vec::with_capacity(cut.requests.len());
    for entry in prefix {
        if entry.request.spec.owner != run_spec.owner
            || !matches!(entry.placement,
                Placement::Steering { run: target, .. } | Placement::Completion { caller: target }
                if target == run)
        {
            return Err(invalid("steering request belongs to another Run or owner"));
        }
        entries.push(entry.request);
    }
    Ok((run_spec, entries))
}
/// Local executor input admission, not a provider acknowledgement. The caller
/// holds the original append claim/head and records the matching Admitted fact.
pub(crate) fn consume_external_steering(
    c: &Connection,
    cut: &Consume,
    run: RunId,
    key: &maka_agent_facts::external_steering::ExternalSteeringKey,
    descriptor: &ContentRef,
    command: FactId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let event = Event::Consumed {
        cut: cut.clone(),
        run,
        target: DeliveryTarget::External {
            task: key.task,
            steering: key.steering,
            descriptor: descriptor.clone(),
        },
    };
    if previous(c, &cut.session, command, &event)?.is_some() {
        return Ok(());
    }
    let next = cas(c, &cut.session, cut.expected_revision)?;
    let frozen = crate::external_steering::read_spec(c, run, key, descriptor)?;
    if frozen.consume != *cut {
        return Err(invalid(
            "external steering descriptor differs from original queue cut",
        ));
    }
    let (run_spec, entries) = steering_requests(c, cut, run)?;
    if !matches!(run_spec.backend, BackendSpec::Executor { .. }) {
        return Err(invalid(
            "external steering requires the original executor Run",
        ));
    }
    if frozen.sources.len() != entries.len()
        || frozen
            .sources
            .iter()
            .zip(&entries)
            .any(|(source, request)| {
                source.request != request.id
                    || source.source != request.source
                    || source.resources != request.resources
            })
    {
        return Err(invalid(
            "external steering descriptor did not freeze the exact ordered request/source/resources prefix",
        ));
    }
    project(c, &cut.session, next, &event, true)?;
    record(c, &cut.session, next, command, at, &event)
}
