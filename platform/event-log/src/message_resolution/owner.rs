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
use sqlx::{Connection, SqliteConnection};
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
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        crate::sessions::validate_id(message)?;
        let (session, message) = (session.to_owned(), message.to_owned());
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    execution(&mut tx, &session, &message).await
                })
            })
            .await
    }
}

pub(crate) async fn execution(
    tx: &mut SqliteConnection,
    session: &str,
    message: &str,
) -> Result<MessageExecution, StoreError> {
    if let Some(owner) = read(tx, session, message).await? {
        return match owner {
            DeliveryOwner::Exclusive(invocation) => lineage(tx, &invocation)
                .await
                .map(|boundary| MessageExecution::Owned(Box::new(boundary))),
            DeliveryOwner::Shared(invocation) => lineage(tx, &invocation)
                .await
                .map(|boundary| MessageExecution::Shared(Box::new(boundary))),
        };
    }
    if crate::message_queue::cancelled(tx, session, message).await? {
        return Ok(MessageExecution::Cancelled);
    }
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id = ? AND message_id = ?)",
    )
    .bind(session)
    .bind(message)
    .fetch_one(tx)
    .await?;
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

async fn read(
    tx: &mut SqliteConnection,
    session: &str,
    message: &str,
) -> Result<Option<DeliveryOwner>, StoreError> {
    let json: Option<String> = sqlx::query_scalar(
        "SELECT e.event_json
         FROM message_sources s JOIN runtime_events e ON e.event_id = s.event_id
         WHERE s.session_id = ? AND s.message_id = ?",
    )
    .bind(session)
    .bind(message)
    .fetch_optional(&mut *tx)
    .await?;
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
pub(crate) async fn lineage(
    tx: &mut SqliteConnection,
    owner: &Invocation,
) -> Result<TurnBoundary, StoreError> {
    let mut current = owner.clone();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.run_id.clone()) {
            return Err(invalid("Message owner continuation cycle"));
        }
        let opening: Option<String> = sqlx::query_scalar(
            "SELECT event_json
             FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'",
        )
        .bind(&current.invocation_id)
        .fetch_optional(&mut *tx)
        .await?;
        let opening: RuntimeEvent =
            serde_json::from_str(&opening.ok_or_else(|| invalid("Message owner has no opening"))?)?;
        if opening.invocation != current {
            return Err(invalid("Message owner identity changed"));
        }
        let successors: Vec<String> = sqlx::query_scalar(
            "SELECT event_json
             FROM event_log INDEXED BY continuation_source_boundary
             WHERE invocation_id IS NOT NULL AND event_json IS NOT NULL
             AND kind = 'invocation_opened'
             AND json_extract(event_json, '$.fact.input.kind') IN ('continuation', 'handoff')
             AND json_extract(event_json, '$.invocation.session_id') = ?
             AND json_extract(event_json, '$.fact.input.claim.source.invocation.run_id') = ?
             LIMIT 2",
        )
        .bind(&current.session_id)
        .bind(&current.run_id)
        .fetch_all(&mut *tx)
        .await?;
        if successors.len() > 1 {
            return Err(invalid("Message owner has ambiguous continuations"));
        }
        let Some(successor) = successors.into_iter().next() else {
            return crate::turns::project(tx, opening).await;
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
        let (count, sealed): (i64, bool) = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(MAX(kind = 'invocation_ended'), 0)
             FROM runtime_events WHERE invocation_id = ?",
        )
        .bind(&current.invocation_id)
        .fetch_one(&mut *tx)
        .await?;
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
