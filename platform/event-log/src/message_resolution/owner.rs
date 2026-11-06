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

use crate::{EventLog, StoreError, turns::TurnBoundary};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

/// Current work reached from one immutable Message identity, not Session activity.
pub enum MessageExecution {
    Pending,
    Cancelled,
    Owned(Box<TurnBoundary>),
    Shared(Box<TurnBoundary>),
    Missing,
}

impl EventLog {
    pub async fn message_execution(
        &self,
        session: &str,
        message: &str,
    ) -> Result<MessageExecution, StoreError> {
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(message)?;
        let (session, message) = (session.to_owned(), message.to_owned());
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                execution(&tx, &session, &message)
            })
            .await
    }
}

pub(crate) fn execution(
    tx: &Connection,
    session: &str,
    message: &str,
) -> Result<MessageExecution, StoreError> {
    if let Some(owner) = read(tx, session, message)? {
        return match owner {
            DeliveryOwner::Exclusive(invocation) => {
                lineage(tx, &invocation).map(|boundary| MessageExecution::Owned(Box::new(boundary)))
            }
            DeliveryOwner::Shared(invocation) => lineage(tx, &invocation)
                .map(|boundary| MessageExecution::Shared(Box::new(boundary))),
        };
    }
    if crate::message_queue::cancelled(tx, session, message)? {
        return Ok(MessageExecution::Cancelled);
    }
    let pending: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id = ? AND message_id = ?)",
        rusqlite::params![session, message],
        |row| row.get(0),
    )?;
    Ok(if pending {
        MessageExecution::Pending
    } else {
        MessageExecution::Missing
    })
}

/// Delivery to a shared Run is evidence of receipt, not authority to stop it.
enum DeliveryOwner {
    Exclusive(Invocation),
    Shared(Invocation),
}

fn read(
    tx: &Connection,
    session: &str,
    message: &str,
) -> Result<Option<DeliveryOwner>, StoreError> {
    let json: Option<String> = tx
        .query_row(
            "SELECT e.event_header
         FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
         WHERE s.session_id = ? AND s.message_id = ?",
            rusqlite::params![session, message],
            |row| row.get(0),
        )
        .optional()?;
    let Some(json) = json else {
        return Ok(None);
    };
    let event: RuntimeEvent = serde_json::from_str(&json)?;
    if event.invocation.session_id != session {
        return Err(invalid("Message owner belongs to another Session"));
    }
    let exclusive = match &event.fact {
        Fact::InvocationOpened {
            input:
                InvocationInput::Message {
                    content,
                    source_messages,
                    ..
                },
            ..
        } => {
            maka_agent_facts::message::validate_sources(content, source_messages)
                .map_err(invalid)?;
            if !source_messages
                .iter()
                .any(|source| source.message.message_id == message)
            {
                return Err(invalid("Message source index disagrees with its opening"));
            }
            source_messages.len() == 1
        }
        Fact::MessageSteered {
            message: delivered, ..
        } if delivered.message_id == message => false,
        _ => return Err(invalid("Message source has no delivery proof")),
    };
    Ok(Some(if exclusive {
        DeliveryOwner::Exclusive(event.invocation)
    } else {
        DeliveryOwner::Shared(event.invocation)
    }))
}

/// Follow explicit continuation edges, never the Session's latest Run. Caller
/// keeps one SQL snapshot through owner selection and any control admission.
pub(crate) fn lineage(tx: &Connection, owner: &Invocation) -> Result<TurnBoundary, StoreError> {
    let mut current = owner.clone();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.run_id.clone()) {
            return Err(invalid("Message owner continuation cycle"));
        }
        let opening: Option<String> = tx
            .query_row(
                "SELECT event_header
             FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'",
                rusqlite::params![&current.invocation_id],
                |row| row.get(0),
            )
            .optional()?;
        let opening: RuntimeEvent =
            serde_json::from_str(&opening.ok_or_else(|| invalid("Message owner has no opening"))?)?;
        if opening.invocation != current {
            return Err(invalid("Message owner identity changed"));
        }
        let successors: Vec<String> = tx
            .prepare_cached(
                "SELECT event_header
             FROM event_log INDEXED BY continuation_source_boundary
             WHERE invocation_id IS NOT NULL AND event_header IS NOT NULL
             AND kind = 'invocation_opened'
             AND json_extract(event_header, '$.fact.input.kind') IN ('continuation', 'handoff')
             AND json_extract(event_header, '$.invocation.session_id') = ?
             AND json_extract(event_header, '$.fact.input.claim.source.invocation.run_id') = ?
             LIMIT 2",
            )?
            .query_map(
                rusqlite::params![&current.session_id, &current.run_id],
                |row| row.get(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        if successors.len() > 1 {
            return Err(invalid("Message owner has ambiguous continuations"));
        }
        let Some(successor) = successors.into_iter().next() else {
            return crate::turns::project(tx, opening);
        };
        let successor: RuntimeEvent = serde_json::from_str(&successor)?;
        let Fact::InvocationOpened { input, .. } = &successor.fact else {
            return Err(invalid("Message owner continuation index changed"));
        };
        input
            .validate_inheritance(&successor.invocation)
            .map_err(invalid)?;
        let claim = input
            .inherited_claim()
            .ok_or_else(|| invalid("Message successor has no inherited boundary"))?;
        if claim.source.invocation != current {
            return Err(invalid(
                "Message owner continuation belongs to another source",
            ));
        }
        // Append already authenticated the immutable raw prefix. Verify this
        // edge still names the sealed owner's complete Run-local boundary.
        let (count, sealed): (i64, bool) = tx.query_row(
            "SELECT COUNT(*), COALESCE(MAX(kind = 'invocation_ended'), 0)
             FROM runtime_events WHERE invocation_id = ?",
            rusqlite::params![&current.invocation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if !sealed || u64::try_from(count).ok() != Some(claim.source.high_water) {
            return Err(invalid(
                "Message owner continuation has an invalid sealed boundary",
            ));
        }
        current = successor.invocation;
    }
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}
