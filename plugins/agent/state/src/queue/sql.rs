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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_after_interrupt: Option<RunId>,
        edit: QueueEdit,
    },
    CallerStopped {
        caller: RunId,
    },
    /// A user Stop keeps what others queued until the Session's next Run.
    Held {
        requests: Vec<RequestId>,
    },
    /// That Run takes `steering` as its steering; the rest become follow-ups.
    HeldReleased {
        run: RunId,
        expected_head: Head,
        steering: Vec<RequestId>,
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
pub(super) fn from_sql_integer(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("queue SQL integer is negative"))
}
pub(super) fn revision(c: &Connection, session: &str) -> Result<u64, StoreError> {
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
            request.spec.budget_basis.is_some()
        }
        Trigger::Continuation { .. }
        | Trigger::ContextCompact
        | Trigger::CheckpointHandoff { .. }
        | Trigger::HistorySource => false,
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
/// A Stop takes back what the stopping party queued. A message from anyone
/// else is sent once: its sender has already settled it, so retracting it
/// would leave this Session never told.
fn sent_by(requester: &StopRequester, source: &RootSourceMessage) -> bool {
    use maka_agent_facts::{message::MessageOrigin, room::RoomAuthor};
    match (requester, &source.message.origin) {
        (
            StopRequester::User,
            None
            | Some(MessageOrigin::Room {
                author: RoomAuthor::Human,
                ..
            }),
        ) => true,
        (
            StopRequester::Session { session_id },
            Some(
                MessageOrigin::Session { execution }
                | MessageOrigin::Room {
                    author: RoomAuthor::Session { execution },
                    ..
                },
            ),
        ) => &execution.session_id == session_id,
        _ => false,
    }
}
/// What waits after a user Stop: messages others sent that a Stop would
/// otherwise have taken back.
fn held(request: &PreparedRequest, source: &RootSourceMessage) -> bool {
    is_interactive(request, source) && !sent_by(&StopRequester::User, source)
}
fn derived_id(tag: &[u8], parts: &[&[u8]]) -> FactId {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(tag);
    for part in parts {
        hash.update(part);
    }
    let bytes = hash.finalize()[..16].try_into().expect("SHA256 prefix");
    FactId::try_from(uuid::Uuid::from_bytes(bytes)).expect("non-nil control identity")
}
pub(crate) fn stopped_by_user(c: &Connection, run: RunId) -> Result<bool, StoreError> {
    Ok(c.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM agent_runs r
         JOIN agent_facts f ON f.id=r.stop_request AND f.run=r.run
         JOIN contents b ON b.id=f.body_content_id
         WHERE r.run=?1 AND json_extract(b.payload,'$.fact.requester.kind')='user')",
    )?
    .query_row([run.to_string()], |row| row.get(0))?)
}
fn has_held(c: &Connection, session: &str) -> Result<bool, StoreError> {
    Ok(c.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM agent_queue_items WHERE session=? AND state='pending' AND lane='held')",
    )?
    .query_row([session], |row| row.get(0))?)
}
/// From a user Stop until the Session's next Run, what others send waits.
fn holding(c: &Connection, session: &str) -> Result<bool, StoreError> {
    Ok(has_held(c, session)?
        || match crate::sql::latest(c, session.to_owned())? {
            Some(run) => stopped_by_user(c, run)?,
            None => false,
        })
}
/// Called inside the admission of a Run that starts new work, once the Run's
/// row exists. What waited after a user Stop becomes this Run's steering, so
/// the model reads it with the message that started the Run. A message this
/// Run may not carry becomes a follow-up and runs after it.
pub(crate) fn deliver_held(
    c: &Connection,
    run: &crate::fold::RunView,
    admission: FactId,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let session = &run.spec.session_id;
    if !has_held(c, session)? {
        return Ok(());
    }
    let mut steering = Vec::new();
    if matches!(run.spec.backend, BackendSpec::Model { .. }) {
        for entry in read(c, session, None)?.entries {
            if matches!(entry.placement, Placement::Held)
                && entry.request.spec.owner == run.spec.owner
                && run
                    .spec
                    .accepts_steering_from(&entry.request.spec)
                    .map_err(|error| invalid(error.to_string()))?
            {
                steering.push(entry.request.id);
            }
        }
    }
    let event = Event::HeldReleased {
        run: run.run,
        expected_head: Head::from(run),
        steering,
    };
    let next = cas(c, session, revision(c, session)?)?;
    project(c, session, next, &event, at, true)?;
    record(
        c,
        session,
        next,
        derived_id(b"held-release", &[admission.as_uuid().as_bytes()]),
        at,
        &event,
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
    run: RunId,
    expected_head: Option<Head>,
) -> Result<(), StoreError> {
    let (spec, actual, stopped, terminal) = run_head(c, run)?;
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
    if let Some(expected) = expected_head
        && actual != expected
    {
        return Err(StoreError::RevisionConflict {
            expected: serde_json::to_string(&expected)?,
            actual: serde_json::to_string(&actual)?,
        });
    }
    Ok(())
}
pub(super) fn interrupt_handoff(
    c: &Connection,
    session: &str,
    frontier: RunId,
    message: Option<&str>,
) -> Result<Option<InterruptHandoff>, StoreError> {
    // The stored run is the original interrupted Run, not the current frontier.
    // A delivered message associates its successor through accepted_run.
    // Negative ranks let the pending lookup seek past ordinary followups.
    let origin: Option<String> = match message {
        None => c.query_row(
            "SELECT interrupted_run FROM agent_queue_items
             WHERE session=? AND state='pending' AND lane='followup' AND position<0 AND interrupted_run IS NOT NULL
             ORDER BY position DESC, request DESC LIMIT 1",
            [session], |r| r.get(0),
        ).optional()?,
        Some(message) => c.query_row(
            "SELECT interrupted_run FROM agent_queue_items
             WHERE session=? AND message=? AND state='delivered' AND accepted_run=? AND interrupted_run IS NOT NULL",
            params![session, message, frontier.to_string()], |r| r.get(0),
        ).optional()?,
    };
    let Some(origin) = origin else {
        return Ok(None);
    };
    let interrupted = RunId::try_from(
        uuid::Uuid::parse_str(&origin).map_err(|_| invalid("invalid interrupted Run"))?,
    )
    .map_err(invalid)?;
    Ok(
        (message.is_some() || interrupted == frontier).then_some(InterruptHandoff {
            interrupted,
            frontier,
        }),
    )
}
fn followup(
    c: &Connection,
    session: &str,
    event: &Event,
    fence: &Followup,
) -> Result<(), StoreError> {
    let original = fence.original();
    fn rejected(reason: &str) -> StoreError {
        StoreError::StatementRejected {
            diagnostic: "agent_admission_failed".into(),
            cause: Arc::new(invalid(reason)),
        }
    }
    let promoted;
    let request_spec = match event {
        Event::Command {
            edit:
                QueueEdit::Enqueue {
                    request,
                    placement: Placement::Followup,
                },
            ..
        } => &request.spec,
        Event::Command {
            edit:
                QueueEdit::Promote {
                    request,
                    target: steering,
                },
            ..
        } => {
            promoted = pending(c, session, request)?;
            match fence {
                Followup::Interrupt { run, .. } if *run == steering.run => {
                    return target(c, session, &promoted.request.spec.owner, *run, None);
                }
                Followup::Resume(handoff) if handoff.frontier == steering.run => {
                    &promoted.request.spec
                }
                _ => return Err(rejected("promotion does not target the observed Run")),
            }
        }
        _ => {
            return Err(rejected(
                "original Run fence requires a follow-up enqueue or promotion",
            ));
        }
    };
    if request_spec.session_id != session {
        return Err(rejected("follow-up request belongs to another session"));
    }
    let owner = serde_json::to_string(&request_spec.owner)?;
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
    if spec.owner != request_spec.owner
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
    if let Followup::Resume(handoff) = fence {
        let current = c.query_row(
            "SELECT run=?2 AND (run=?3 OR (NOT stopped AND terminal IS NULL))
             FROM agent_runs WHERE session=?1 ORDER BY admission_sequence DESC LIMIT 1",
            params![session, handoff.frontier.to_string(), original.to_string()],
            |r| r.get::<_, bool>(0),
        )?;
        if stopped != 1 || !current {
            return Err(rejected("steering handoff no longer current"));
        }
    } else if stopped != 0 {
        return Err(rejected("original follow-up Run has been stopped"));
    }
    Ok(())
}

pub(super) fn refresh_room_enqueue(
    c: &Connection,
    session: &str,
    command: &mut QueueCommand,
) -> Result<(), StoreError> {
    let already_recorded: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_queue_events WHERE session=? AND id=?)",
        params![session, command.id.to_string()],
        |r| r.get(0),
    )?;
    if already_recorded {
        return Ok(());
    }
    command.expected_revision = revision(c, session)?;
    if let QueueEdit::Enqueue {
        placement: placement @ Placement::Steering { .. },
        ..
    } = &mut command.edit
        && let Placement::Steering { run, .. } = *placement
    {
        let (_, actual_head, stopped, terminal) = run_head(c, run)?;
        if !stopped && !terminal {
            *placement = Placement::Steering {
                run,
                expected_head: actual_head,
            };
        } else if terminal {
            // The target Run completed during the preparation window; deliver as a fresh turn.
            *placement = Placement::Followup;
        }
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
    followup_fence: Option<&Followup>,
) -> Result<(QueueCommit, bool), StoreError> {
    id(session)?;
    let mut event = Event::Command {
        expected_revision: command.expected_revision,
        resume_after_interrupt: match followup_fence {
            Some(fence @ (Followup::Interrupt { .. } | Followup::Resume(_))) => {
                Some(fence.original())
            }
            _ => None,
        },
        edit: command.edit,
    };
    // A follow-up from someone else that arrives while the Session is holding
    // is recorded as held.
    fn hold(event: &mut Event) -> Option<&PreparedRequest> {
        match event {
            Event::Command {
                edit:
                    QueueEdit::Enqueue {
                        request,
                        placement: placement @ Placement::Followup,
                    },
                resume_after_interrupt: None,
                ..
            } => {
                *placement = Placement::Held;
                Some(request)
            }
            _ => None,
        }
    }
    let replayed = match previous(c, session, command.id, &event) {
        Err(StoreError::EventConflict) if followup_fence.is_none() => {
            hold(&mut event).ok_or(StoreError::EventConflict)?;
            previous(c, session, command.id, &event)?
        }
        result => result?,
    };
    if let Some(revision) = replayed {
        return Ok((QueueCommit { revision }, false));
    }
    // The hold decision reads the message's source, which may arrive with
    // this command.
    for blob in &contents {
        put(c, blob)?;
    }
    if followup_fence.is_none()
        && matches!(
            &event,
            Event::Command {
                edit: QueueEdit::Enqueue {
                    placement: Placement::Followup,
                    ..
                },
                ..
            }
        )
        && holding(c, session)?
    {
        let mut waiting = event.clone();
        if let Some(request) = hold(&mut waiting)
            && held(request, &source(c, request)?)
        {
            event = waiting;
        }
    }
    if let Some(fence) = followup_fence {
        followup(c, session, &event, fence)?;
    }
    let next = cas(c, session, command.expected_revision)?;
    project(c, session, next, &event, command.at, true)?;
    record(c, session, next, command.id, command.at, &event)?;
    Ok((QueueCommit { revision: next }, true))
}
/// The first Stop of a Session's latest Run takes back what the requester
/// queued. After a user Stop, what others queued waits for the next Run,
/// including results other Sessions reported back to the stopped Run.
pub(crate) fn stop_queue(
    c: &Connection,
    session: &str,
    run: RunId,
    stop: &Change,
    requester: &StopRequester,
) -> Result<(), StoreError> {
    use maka_agent_facts::message::MessageOrigin;

    let queue = read(c, session, None)?;
    let mut expected_revision = queue.revision;
    let mut hold = Vec::new();
    for entry in queue.entries {
        let source = source(c, &entry.request)?;
        if !is_interactive(&entry.request, &source) {
            continue;
        }
        if sent_by(requester, &source) {
            let command = QueueCommand {
                id: derived_id(
                    b"stop-retract",
                    &[stop.id.as_uuid().as_bytes(), entry.request.id.0.as_bytes()],
                ),
                at: stop.at,
                expected_revision,
                edit: QueueEdit::Retract {
                    request: entry.request.id,
                },
            };
            let (commit, _) = write(c, session, command, Vec::new(), None)?;
            expected_revision = commit.revision;
            continue;
        }
        // The stopped turn's own continuation is taken back with the Stop.
        let keep = match entry.placement {
            Placement::Completion { caller } => {
                caller == run
                    && matches!(
                        source.message.origin,
                        Some(MessageOrigin::SessionCompletion { .. })
                    )
            }
            Placement::Held => false,
            Placement::Followup | Placement::Steering { .. } => true,
        };
        if matches!(requester, StopRequester::User) && keep {
            hold.push(entry.request.id);
        }
    }
    if hold.is_empty() {
        return Ok(());
    }
    let event = Event::Held { requests: hold };
    let next = cas(c, session, expected_revision)?;
    project(c, session, next, &event, stop.at, true)?;
    record(
        c,
        session,
        next,
        derived_id(b"stop-hold", &[stop.id.as_uuid().as_bytes()]),
        stop.at,
        &event,
    )
}

fn row_entry(
    c: &Connection,
    session: &str,
    request: &RequestId,
) -> Result<Option<(QueueEntry, String)>, StoreError> {
    let row: Option<(String, String)> = c
        .query_row(
            "SELECT entry_json,state FROM agent_queue_items WHERE session=? AND request=?",
            params![session, request.0],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(body, state)| Ok((serde_json::from_str(&body)?, state)))
        .transpose()
}
fn pending(c: &Connection, session: &str, request: &RequestId) -> Result<QueueEntry, StoreError> {
    let (entry, state) =
        row_entry(c, session, request)?.ok_or_else(|| invalid("queue request not found"))?;
    if state != "pending" {
        return Err(invalid("queue request is no longer pending"));
    }
    Ok(entry)
}
fn placement_columns(placement: &Placement) -> (&'static str, Option<String>) {
    match placement {
        Placement::Followup | Placement::Completion { .. } => ("followup", None),
        Placement::Steering { run, .. } => ("steering", Some(run.to_string())),
        Placement::Held => ("held", None),
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
    at: UnixMillis,
    check: bool,
) -> Result<(), StoreError> {
    match event {
        Event::Command {
            edit,
            resume_after_interrupt,
            ..
        } => {
            // Reserve negative ranks for handoffs, ordered by insertion. The
            // queue revision is bounded by MAX_SAFE_INTEGER in cas().
            let revision = to_sql_integer(next)?;
            let position = if resume_after_interrupt.is_some() {
                revision
                    - (maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER as i64)
                    - 1
            } else {
                revision
            };
            match edit {
                QueueEdit::Enqueue { request, placement } => {
                    let source = validate_request(c, session, request)?;
                    if matches!(placement, Placement::Steering { .. })
                        && !is_interactive(request, &source)
                        && !matches!(&request.spec.trigger, Trigger::Schedule { .. })
                    {
                        return Err(invalid("message cannot be delivered as steering"));
                    }
                    if matches!(placement, Placement::Held) && !held(request, &source) {
                        return Err(invalid("only messages others sent can wait after a Stop"));
                    }
                    crate::artifacts::pin_request(c, request, &source)?;
                    let exists: bool = c.query_row("SELECT EXISTS(SELECT 1 FROM agent_queue_items WHERE session=? AND (request=? OR message=?))",params![session,request.id.0,request.message_id],|r|r.get(0))?;
                    if exists {
                        return Err(StoreError::EventConflict);
                    }
                    if check && let Placement::Steering { run, expected_head } = placement {
                        target(c, session, &request.spec.owner, *run, Some(*expected_head))?;
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
                        use maka_agent_facts::message::MessageOrigin;
                        let valid_source = match &source.message.origin {
                            Some(MessageOrigin::SessionCompletion { .. }) => true,
                            Some(MessageOrigin::Session { execution }) => {
                                execution.run_id == *caller
                                    && execution.session_id == original.session_id
                                    && execution.turn_id == original.turn_id
                            }
                            _ => false,
                        };
                        if !valid_source
                            || original.session_id != session
                            || original.owner != request.spec.owner
                            || !matches!(original.origin, RunOrigin::Local)
                            || !matches!(
                                (&original.backend, &request.spec.backend),
                                (BackendSpec::Model { .. }, BackendSpec::Model { .. })
                                    | (BackendSpec::Executor { .. }, BackendSpec::Executor { .. })
                            )
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
                    c.execute("INSERT INTO agent_queue_items(session,request,message,owner,position,lane,target_run,state,entry_json,enqueued_at,interrupted_run) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)",params![session,request.id.0,request.message_id,serde_json::to_string(&request.spec.owner)?,position,lane,target,serde_json::to_string(&entry)?,at.0,resume_after_interrupt.map(|run| run.to_string())])?;
                }
                QueueEdit::Update { request } => {
                    let mut old = pending(c, session, &request.id)?;
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
                    let mut entry = pending(c, session, request)?;
                    let source = source(c, &entry.request)?;
                    if !is_interactive(&entry.request, &source) {
                        return Err(invalid(
                            "only interactive queue messages can be steered or edited",
                        ));
                    }
                    if !matches!(entry.placement, Placement::Followup) {
                        return Err(invalid("request is already steering"));
                    }
                    if resume_after_interrupt.is_none() {
                        if check {
                            target(
                                c,
                                session,
                                &entry.request.spec.owner,
                                steering.run,
                                Some(steering.expected_head),
                            )?;
                        }
                        entry.placement = Placement::Steering {
                            run: steering.run,
                            expected_head: steering.expected_head,
                        };
                        update_entry(c, session, &entry)?;
                    }
                    c.execute(
                        "UPDATE agent_queue_items SET position=?, interrupted_run=? WHERE session=? AND request=?",
                        params![position, resume_after_interrupt.map(|run| run.to_string()), session, request.0],
                    )?;
                }
                QueueEdit::Reorder { requests } => {
                    if requests.is_empty() {
                        return Err(invalid("empty queue reorder"));
                    }
                    let lane: String = c.query_row(
                        "SELECT lane FROM agent_queue_items WHERE session=? AND request=? AND state='pending'",
                        params![session, requests[0].0], |r| r.get(0),
                    ).optional()?.ok_or_else(|| invalid("queue request is no longer pending"))?;
                    let rows: Vec<(String, bool)> = c.prepare_cached(
                        "SELECT request, interrupted_run IS NOT NULL FROM agent_queue_items WHERE session=? AND state='pending' AND lane=? ORDER BY position, request",
                    )?.query_map(params![session, lane], |r| Ok((r.get(0)?, r.get(1)?)))?
                        .collect::<Result<_, _>>()?;
                    let requested: BTreeSet<_> = requests.iter().map(|r| r.0.as_str()).collect();
                    if requested.len() != requests.len()
                        || rows.len() != requests.len()
                        || rows.iter().any(|(id, _)| !requested.contains(id.as_str()))
                    {
                        return Err(invalid("reorder must name exactly the pending lane"));
                    }
                    let priority: Vec<_> = rows
                        .iter()
                        .filter(|(_, interrupted)| *interrupted)
                        .map(|(id, _)| id.as_str())
                        .collect();
                    if check
                        && requests
                            .iter()
                            .take(priority.len())
                            .map(|r| r.0.as_str())
                            .ne(priority.iter().copied())
                    {
                        return Err(invalid("reorder cannot move interrupt handoffs"));
                    }
                    let priority_set: BTreeSet<_> = priority.iter().copied().collect();
                    let ordinary = requests
                        .iter()
                        .filter(|request| !priority_set.contains(request.0.as_str()));
                    for (position, request) in ordinary.enumerate() {
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
        Event::Held { requests } => {
            for request in requests {
                let mut entry = pending(c, session, request)?;
                entry.placement = Placement::Held;
                update_entry(c, session, &entry)?;
            }
        }
        Event::HeldReleased {
            run,
            expected_head,
            steering,
        } => {
            let held: Vec<QueueEntry> = c
                .prepare_cached(
                    "SELECT entry_json FROM agent_queue_items
                     WHERE session=? AND state='pending' AND lane='held'",
                )?
                .query_map([session], |row| row.get::<_, String>(0))?
                .map(|row| Ok(serde_json::from_str(&row?)?))
                .collect::<Result<_, StoreError>>()?;
            if steering
                .iter()
                .any(|request| !held.iter().any(|entry| &entry.request.id == request))
            {
                return Err(invalid("released steering was not held"));
            }
            for mut entry in held {
                entry.placement = if steering.contains(&entry.request.id) {
                    Placement::Steering {
                        run: *run,
                        expected_head: *expected_head,
                    }
                } else {
                    Placement::Followup
                };
                update_entry(c, session, &entry)?;
            }
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

pub(super) fn recover_undelivered_steering(
    c: &Connection,
    owner: &RunOwner,
    session: Option<&str>,
    at: UnixMillis,
) -> Result<BTreeSet<String>, StoreError> {
    let rows = c
        .prepare_cached(
            "SELECT DISTINCT q.session,q.target_run
         FROM agent_queue_items q
         JOIN agent_runs r ON r.run=q.target_run AND r.session=q.session AND r.owner=q.owner
         WHERE q.owner=?1 AND q.state='pending' AND q.lane='steering' AND r.local=1
           AND (?3 IS NULL OR q.session=?3)
           AND (r.terminal IS NOT NULL OR EXISTS (
               SELECT 1 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id
               WHERE f.id=r.stop_request AND f.run=r.run
                 AND json_extract(b.payload,'$.fact.diagnostic')=?2
           ))",
        )?
        .query_map(
            params![serde_json::to_string(owner)?, GOAL_CONTROL_STOP, session],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut sessions = BTreeSet::new();
    for (session, run) in rows {
        let run = RunId::try_from(
            uuid::Uuid::parse_str(&run).map_err(|_| invalid("invalid steering Run"))?,
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
pub(super) fn entry_enqueued_at(
    c: &Connection,
    session: &str,
    request: &RequestId,
) -> Result<Option<UnixMillis>, StoreError> {
    id(session)?;
    id(&request.0)?;
    Ok(c.query_row(
        "SELECT enqueued_at FROM agent_queue_items WHERE session=? AND request=?",
        params![session, request.0],
        |r| r.get::<_, i64>(0),
    )
    .optional()?
    .map(UnixMillis))
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
            "SELECT state, (
                WITH RECURSIVE handoff(run, depth) AS (
                    SELECT q.accepted_run, 0
                    UNION ALL
                    SELECT x.run, h.depth + 1 FROM handoff h
                    JOIN agent_continuation_successors x ON x.source_run = h.run
                    JOIN agent_run_specs s ON s.run = x.run
                    JOIN contents b ON b.id = s.spec_content_id
                    WHERE json_extract(b.payload, '$.trigger.kind') = 'checkpoint_handoff'
                )
                SELECT run FROM handoff ORDER BY depth DESC LIMIT 1
            ), shared FROM agent_queue_items q WHERE session=? AND message=?",
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
    let rows = c.prepare_cached("SELECT session,position,request,entry_json FROM agent_queue_items WHERE owner=?1 AND state='pending' AND lane<>'held' AND (session,position,request)>(?2,?3,?4) ORDER BY session,position,request LIMIT ?5")?.query_map(params![serde_json::to_string(owner)?,session,position,request,limit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))?.collect::<Result<Vec<_>,_>>()?;
    rows.into_iter()
        .map(|(session, position, request, body)| {
            Ok(ReadyEntry {
                cursor: ReadyCursor {
                    session,
                    position,
                    request: RequestId(request),
                },
                entry: serde_json::from_str(&body)?,
            })
        })
        .collect()
}
pub(crate) fn rebuild_queue_projections(c: &Connection) -> Result<(), StoreError> {
    let mut after = String::new();
    loop {
        let sessions: Vec<String> = c.prepare_cached(
            "SELECT DISTINCT session FROM agent_queue_events WHERE session>? ORDER BY session LIMIT 128",
        )?.query_map([&after], |row| row.get(0))?.collect::<Result<_, _>>()?;
        if sessions.is_empty() {
            break;
        }
        for session in sessions {
            replay_queue_events(c, &session, "b.payload")?;
            after = session;
        }
    }
    Ok(())
}

pub(super) fn rebuild(c: &Connection, session: &str) -> Result<QueueCommit, StoreError> {
    replay_queue_events(
        c,
        session,
        "CASE WHEN e.memory_admission IS NULL THEN b.payload
         ELSE CAST(json_set(b.payload, '$.edit.request.spec.memoryAdmission', e.memory_admission) AS BLOB) END",
    )
}

/// Keep the original command body intact for idempotency and the queue revision intact for CAS.
/// Only the last enqueue or update supplied the request that was pending at upgrade.
pub(crate) fn migrate_memory_admissions(c: &Connection) -> Result<(), StoreError> {
    let expected: i64 = c.query_row("SELECT count(*) FROM pinned_queue_admissions", [], |r| {
        r.get(0)
    })?;
    let recorded = c.execute(
        "WITH last_edit(session,revision,admission) AS MATERIALIZED (
           SELECT e.session,max(e.revision),p.admission
           FROM (SELECT DISTINCT session FROM pinned_queue_admissions) affected
           CROSS JOIN agent_queue_events e ON e.session=affected.session
           CROSS JOIN contents b ON b.id=e.body_content_id
           CROSS JOIN pinned_queue_admissions p ON p.session=e.session
             AND p.request=b.payload->>'$.edit.request.id'
           WHERE b.payload->>'$.kind'='command' AND b.payload->>'$.edit.kind' IN ('enqueue','update')
           GROUP BY p.session,p.request
         )
         UPDATE agent_queue_events AS e SET memory_admission=l.admission
         FROM last_edit l WHERE e.session=l.session AND e.revision=l.revision",
        [],
    )?;
    if i64::try_from(recorded).ok() != Some(expected) {
        return Err(invalid(
            "pending request is missing its canonical queue event",
        ));
    }
    c.execute_batch(
        "UPDATE agent_queue_items AS q
         SET entry_json=json_set(q.entry_json,'$.request.spec.memoryAdmission',p.admission)
         FROM pinned_queue_admissions p WHERE q.session=p.session AND q.request=p.request;",
    )?;
    Ok(())
}

fn replay_queue_events(
    c: &Connection,
    session: &str,
    body: &str,
) -> Result<QueueCommit, StoreError> {
    id(session)?;
    c.execute("DELETE FROM agent_queue_items WHERE session=?", [session])?;
    c.execute("DELETE FROM agent_queue_heads WHERE session=?", [session])?;
    let mut page = c.prepare(&format!(
        "SELECT e.revision,{body},e.at FROM agent_queue_events e
        JOIN contents b ON b.id=e.body_content_id WHERE e.session=? AND e.revision>?
        ORDER BY e.revision LIMIT 128"
    ))?;
    let mut after = 0;
    loop {
        let rows = page
            .query_map(params![session, to_sql_integer(after)?], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Vec<u8>>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if rows.is_empty() {
            break;
        }
        for (revision, body, at) in rows {
            let revision = from_sql_integer(revision)?;
            if after.checked_add(1) != Some(revision) {
                return Err(invalid("noncontiguous queue canonical stream"));
            }
            let event: Event = serde_json::from_slice(&body)?;
            project(c, session, revision, &event, UnixMillis(at), false)?;
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
    let entry = pending(c, &cut.session, &cut.requests[0])?;
    use maka_agent_facts::memory::MemoryAdmission;
    let original = &entry.request.spec;
    let same_memory = original.memory_admission == spec.memory_admission
        && original.memory_projection == spec.memory_projection;
    let fresh_memory = matches!(
        original.memory_admission,
        MemoryAdmission::Enabled | MemoryAdmission::Disabled
    ) && (spec.memory_admission == MemoryAdmission::Enabled
        || (matches!(
            spec.memory_admission,
            MemoryAdmission::Disabled | MemoryAdmission::Excluded
        ) && spec.memory_projection.is_none()));
    if !entry.placement.is_followup()
        || !(same_memory || fresh_memory)
        || !entry.request.matches_run_input(spec.clone())
    {
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
    project(c, &cut.session, next, &event, at, true)?;
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
    project(c, &cut.session, next, &event, at, true)?;
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
    project(c, &cut.session, next, &event, at, true)?;
    record(c, &cut.session, next, command, at, &event)
}

pub(super) fn message_entry(
    c: &Connection,
    session: &str,
    message: &str,
) -> Result<Option<QueueEntry>, StoreError> {
    id(session)?;
    id(message)?;
    let json: Option<String> = c
        .query_row(
            "SELECT entry_json FROM agent_queue_items WHERE session=? AND message=?",
            params![session, message],
            |r| r.get(0),
        )
        .optional()?;
    json.map(|v| serde_json::from_str(&v).map_err(StoreError::from))
        .transpose()
}
