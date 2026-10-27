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

//! Causal validation against preceding canonical facts. This does not acquire
//! execution, consume messages, inspect current grants, or update projections.

use crate::StoreError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;

/// The event must be absent; the connection must contain only its preceding
/// facts and the history memberships already established at that point.
/// Bundle staging and live append must not validate against a preloaded future.
pub(crate) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let model_failure = match &event.fact {
        Fact::ModelInterrupted { model_failure, .. }
        | Fact::InvocationEnded {
            outcome: InvocationOutcome::Failed { model_failure, .. },
        } => model_failure.as_ref(),
        _ => None,
    };
    if let Some(cause) = model_failure {
        cause
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
    }
    identity(connection, event).await?;
    crate::executor::validate(connection, event).await?;
    crate::model_items::validate(connection, event).await?;
    crate::tool_calls::validate(connection, event).await?;
    crate::continuation::validate(connection, event).await?;
    crate::handoff::validate_history(connection, event).await?;
    crate::steering::validate_append(connection, event).await?;
    crate::context::validate_append(connection, event).await?;
    crate::archive::validate_append(connection, event).await?;
    outcomes(connection, event).await
}

async fn identity(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let id = &event.invocation.invocation_id;
    if let Fact::ModelInterrupted {
        diagnostic: Some(message),
        ..
    } = &event.fact
        && (message.trim().is_empty() || message.len() > 4096)
    {
        return Err(invalid(
            "model interruption diagnostic must be nonempty and bounded",
        ));
    }
    let sealed: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended')",
    ).bind(id).fetch_one(&mut *connection).await?;
    if sealed {
        return Err(StoreError::Sealed);
    }
    let opening: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(event_json, '$.invocation') FROM runtime_events WHERE invocation_id=? AND kind='invocation_opened'",
    )
    .bind(id)
    .fetch_optional(connection)
    .await?;
    match (&event.fact, opening) {
        (Fact::InvocationOpened { .. }, None) => Ok(()),
        (Fact::InvocationOpened { .. }, Some(_)) => Err(invalid("invocation already opened")),
        (_, None) => Err(invalid("invocation not opened")),
        (_, Some(opening)) => {
            if serde_json::from_str::<maka_agent_facts::event::Invocation>(&opening)?
                != event.invocation
            {
                return Err(invalid("invocation identity changed"));
            }
            Ok(())
        }
    }
}

async fn outcomes(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let id = &event.invocation.invocation_id;
    if let Fact::ToolSettled { operation_id, .. } = &event.fact {
        let dispatched: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='tool_dispatched')",
        ).bind(id).bind(operation_id).fetch_one(&mut *connection).await?;
        if !dispatched {
            return Err(invalid("outcome without dispatch"));
        }
    }
    if let Fact::ModelCompleted { step_id, .. }
    | Fact::ModelInterrupted { step_id, .. }
    | Fact::ModelObserved { step_id, .. } = &event.fact
    {
        let requested: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind='model_requested')",
        ).bind(id).bind(step_id).fetch_one(&mut *connection).await?;
        if !requested {
            return Err(invalid("model output without request"));
        }
        let settled: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND operation_id=? AND kind IN ('model_completed','model_interrupted'))",
        ).bind(id).bind(step_id).fetch_one(&mut *connection).await?;
        if settled {
            return Err(invalid("model request already settled"));
        }
    }
    if matches!(
        event.fact,
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed
        }
    ) {
        let pending: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM runtime_events AS dispatch
             WHERE dispatch.invocation_id=? AND dispatch.kind IN ('tool_dispatched','model_requested')
             AND NOT EXISTS(SELECT 1 FROM runtime_events AS outcome
                 WHERE outcome.invocation_id=dispatch.invocation_id
                 AND outcome.operation_id=dispatch.operation_id
                 AND ((dispatch.kind='tool_dispatched' AND outcome.kind='tool_settled')
                   OR (dispatch.kind='model_requested' AND outcome.kind IN ('model_completed','model_interrupted')))))",
        ).bind(id).fetch_one(connection).await?;
        if pending {
            return Err(invalid(
                "cannot complete with an unresolved tool or model outcome",
            ));
        }
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
