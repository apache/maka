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
use crate::StoreError;
use maka_agent_facts::configuration::validation::MAX_SAFE_INTEGER;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use sqlx::SqliteConnection;

/// Only canonical predecessors: no local reservation, current permission or interaction state.
pub(crate) async fn validate(
    tx: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    if let Fact::InvocationOpened {
        input,
        configuration,
    } = &event.fact
    {
        if let InvocationInput::Handoff { claim, pause } = input {
            let source = &claim.source.invocation;
            let (opening, terminal): (String, String) = sqlx::query_as(
                "SELECT o.event_header, t.event_header FROM runtime_events o JOIN runtime_events t
                 ON t.invocation_id=o.invocation_id AND t.kind='invocation_ended'
                 WHERE o.invocation_id=? AND o.kind='invocation_opened'",
            )
            .bind(&source.invocation_id)
            .fetch_one(&mut *tx)
            .await?;
            let opening: RuntimeEvent = serde_json::from_str(&opening)?;
            let terminal: RuntimeEvent = serde_json::from_str(&terminal)?;
            if !matches!(terminal.fact, Fact::InvocationEnded { outcome: InvocationOutcome::HandoffPaused { pause: sealed } } if sealed == **pause)
                || !matches!(opening.fact, Fact::InvocationOpened { configuration: Some(ref frozen), .. } if Some(frozen) == configuration.as_ref())
            {
                return Err(invalid(
                    "handoff changes its sealed intent, budget or admitted configuration",
                ));
            }
        }
        return Ok(());
    }
    let Fact::InvocationEnded {
        outcome: InvocationOutcome::HandoffPaused { pause },
    } = &event.fact
    else {
        return Ok(());
    };
    pause.validate(&event.invocation).map_err(invalid)?;
    let ended: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id=? AND kind='invocation_ended')",
    ).bind(&event.invocation.invocation_id).fetch_one(&mut *tx).await?;
    if ended {
        return Err(invalid("handoff source is already sealed"));
    }
    let opening: String = sqlx::query_scalar(
        "SELECT event_header FROM runtime_events WHERE invocation_id=? AND kind='invocation_opened'",
    )
    .bind(&event.invocation.invocation_id)
    .fetch_one(&mut *tx)
    .await?;
    let opening: RuntimeEvent = serde_json::from_str(&opening)?;
    if opening.invocation != event.invocation {
        return Err(invalid("handoff source invocation changed"));
    }
    let Fact::InvocationOpened {
        input,
        configuration: Some(configuration),
    } = &opening.fact
    else {
        return Err(invalid("handoff has no admitted configuration"));
    };
    let workspace = configuration
        .workspace_identity
        .as_ref()
        .ok_or_else(|| invalid("handoff requires an observed workspace identity"))?;
    crate::context::safety::require_safe(
        tx,
        &event.invocation.session_id,
        Some(&event.invocation.invocation_id),
    )
    .await?;
    if let Some(claim) = input.inherited_claim() {
        crate::continuation::ancestors(tx, &claim.source, &claim.base, workspace).await?;
    }
    let root = match &opening.fact {
        Fact::InvocationOpened {
            input: InvocationInput::Message { .. } | InvocationInput::Continuation { .. },
            configuration: Some(_),
        } => &event.invocation.run_id,
        Fact::InvocationOpened {
            input: InvocationInput::Handoff {
                pause: previous, ..
            },
            configuration: Some(_),
        } => &previous.intent.root_run_id,
        _ => {
            return Err(invalid("handoff requires an admitted model Run"));
        }
    };
    let replay_base = match input {
        InvocationInput::Continuation { claim, .. } => Some(claim.base.high_water),
        InvocationInput::Handoff { pause, .. } => pause.execution.replay_base,
        _ => None,
    };
    if pause.execution.replay_base != replay_base {
        return Err(invalid("handoff changes its admitted history projection"));
    }
    if &pause.intent.root_run_id != root {
        return Err(invalid(
            "handoff must preserve its admitted logical model Run",
        ));
    }
    // As with pruning before the next step, a failed, effect-free summary is
    // harmless; an interrupted request never proves a provider effect settled.
    crate::context::safety::settled_boundary(tx, &event.invocation.invocation_id, i64::MAX as u64)
        .await?;
    let source = crate::run_source::read(
        tx,
        &event.invocation.session_id,
        &event.invocation.run_id,
        &event.invocation.invocation_id,
        i64::MAX,
    )
    .await?;
    if source.boundary.invocation != event.invocation {
        return Err(invalid("handoff source invocation changed"));
    }
    source
        .boundary
        .high_water
        .checked_add(1)
        .filter(|count| *count <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("handoff source high-water exceeds the safe integer range"))?;
    crate::context::read::validate_handoff_context(tx, &opening).await?;
    let occupied: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE kind='invocation_opened'
         AND (invocation_id=?1 OR json_extract(event_header,'$.invocation.run_id')=?2
           OR json_extract(event_header,'$.fact.input.claim.id')=?3))",
    )
    .bind(&pause.intent.successor_invocation_id)
    .bind(&pause.intent.successor_run_id)
    .bind(&pause.intent.claim_id)
    .fetch_one(&mut *tx)
    .await?;
    if occupied {
        return Err(invalid("handoff successor identity already exists"));
    }

    Ok(())
}
