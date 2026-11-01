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

//! Claims are canonical continuation openings, not a second admission ledger.

use crate::{EventLog, StoreError, sequence_number};
use maka_agent_facts::continuation::RunBoundary;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::StoredEvent;
use sqlx::{Connection, SqliteConnection};
use std::collections::HashSet;

impl EventLog {
    /// Latest failed/cancelled inline Run, not simply the latest Session Turn.
    pub async fn latest_continuation_candidate(
        &self,
        session: &str,
    ) -> Result<Option<String>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection.run(move |connection| Box::pin(async move {
            Ok(sqlx::query_scalar(
                "SELECT json_extract(opening.event_header, '$.invocation.run_id')
                 FROM runtime_events opening JOIN runtime_events terminal
                   ON terminal.invocation_id = opening.invocation_id AND terminal.kind = 'invocation_ended'
                 WHERE opening.kind = 'invocation_opened'
                   AND json_extract(opening.event_header, '$.invocation.session_id') = ?
                   AND json_extract(opening.event_header, '$.fact.input.kind') IN ('message', 'continuation', 'handoff')
                   AND json_extract(terminal.event_header, '$.fact.outcome.kind') IN ('failed', 'cancelled')
                 ORDER BY opening.sequence DESC LIMIT 1"
            ).bind(session).fetch_optional(connection).await?)
        })).await
    }

    /// The exact committed target for a source boundary, if one acquired it.
    /// A read never reserves the source or creates execution authority.
    pub async fn continuation_for_source(
        &self,
        source: &RunBoundary,
    ) -> Result<Option<StoredEvent>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(&source.invocation.session_id)?;
        crate::sessions::validate_id(&source.invocation.run_id)?;
        if source.high_water == 0 || source.high_water > 9_007_199_254_740_991 {
            return Err(invalid("invalid source Run high-water"));
        }
        let source = source.clone();
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            let rows: Vec<(i64, Option<String>)> = sqlx::query_as(
                "SELECT sequence, CASE WHEN length(CAST(event_header AS BLOB)) <= 1048576 THEN event_header END
                 FROM runtime_events WHERE kind='invocation_opened'
                 AND json_extract(event_header,'$.fact.input.kind') IN ('continuation','handoff')
                 AND json_extract(event_header,'$.invocation.session_id')=?
                 AND json_extract(event_header,'$.fact.input.claim.source.invocation.run_id')=?
                 AND json_extract(event_header,'$.fact.input.claim.source.high_water')=? LIMIT 2"
            ).bind(&source.invocation.session_id).bind(&source.invocation.run_id)
                .bind(source.high_water as i64).fetch_all(&mut *tx).await?;
            if rows.len() > 1 { return Err(invalid("ambiguous continuation claim")); }
            let result = rows.into_iter().next().map(|(sequence, json)| {
                let event: RuntimeEvent = serde_json::from_str(&json.ok_or_else(|| invalid("claim opening exceeds capacity"))?)?;
                let Fact::InvocationOpened { input, .. } = &event.fact else {
                    return Err(invalid("claim index has invalid opening"));
                };
                let claim = input.inherited_claim().ok_or_else(|| invalid("claim index has no claim"))?;
                input.validate_inheritance(&event.invocation).map_err(invalid)?;
                if claim.source != source { return Err(invalid("claimed source evidence changed")); }
                Ok(StoredEvent { sequence: sequence_number(sequence)?, event })
            }).transpose()?;
            tx.commit().await?;
            Ok(result)
        })).await
    }
}

pub(crate) async fn validate(
    connection: &mut SqliteConnection,
    event: &RuntimeEvent,
) -> Result<(), StoreError> {
    let Fact::InvocationOpened {
        input,
        configuration,
    } = &event.fact
    else {
        return Ok(());
    };
    let Some(claim) = input.inherited_claim() else {
        return Ok(());
    };
    input
        .validate_inheritance(&event.invocation)
        .map_err(invalid)?;
    let workspace = configuration
        .as_ref()
        .and_then(|c| c.workspace_identity.as_ref())
        .ok_or_else(|| invalid("continuation has no observed workspace identity"))?;
    let reused: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE kind='invocation_opened'
         AND json_extract(event_header,'$.invocation.session_id')=?1
         AND ((?4 AND json_extract(event_header,'$.invocation.turn_id')=?2) OR json_extract(event_header,'$.invocation.run_id')=?3))"
    ).bind(&event.invocation.session_id).bind(&event.invocation.turn_id).bind(&event.invocation.run_id)
        .bind(matches!(input, InvocationInput::Continuation { .. })).fetch_one(&mut *connection).await?;
    if reused {
        return Err(invalid(
            "continuation reused a reserved Turn or physical Run",
        ));
    }
    crate::context::safety::require_safe(connection, &event.invocation.session_id, None).await?;
    ancestors(connection, &claim.source, &claim.base, workspace).await?;
    Ok(())
}

/// Validate every inherited edge against canonical bytes, returning physical Run identities.
pub(crate) async fn ancestors(
    connection: &mut SqliteConnection,
    boundary: &RunBoundary,
    base: &maka_agent_facts::continuation::SessionBase,
    workspace: &maka_agent_facts::execution::WorkspaceIdentity,
) -> Result<Vec<maka_agent_facts::event::Invocation>, StoreError> {
    let mut source = boundary.clone();
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    loop {
        if !seen.insert(source.invocation.run_id.clone()) {
            return Err(invalid("continuation lineage cycle"));
        }
        let id = crate::turns::run_invocation(
            connection,
            &source.invocation.session_id,
            &source.invocation.run_id,
        )
        .await?
        .ok_or_else(|| invalid("continuation source Run is missing"))?;
        if id != source.invocation.invocation_id {
            return Err(invalid("continuation source identity changed"));
        }
        let through: i64 =
            sqlx::query_scalar("SELECT MAX(sequence) FROM runtime_events WHERE invocation_id=?")
                .bind(&id)
                .fetch_one(&mut *connection)
                .await?;
        let evidence = crate::run_source::read(
            connection,
            &source.invocation.session_id,
            &source.invocation.run_id,
            &id,
            through,
        )
        .await?;
        if evidence.boundary != source
            || !matches!(evidence.last.event.fact, Fact::InvocationEnded { .. })
        {
            return Err(invalid(
                "continuation source is not its exact sealed boundary",
            ));
        }
        result.push(evidence.boundary.invocation.clone());
        let opening = &evidence.opening;
        let Fact::InvocationOpened {
            input,
            configuration,
        } = &opening.event.fact
        else {
            unreachable!()
        };
        if configuration
            .as_ref()
            .and_then(|c| c.workspace_identity.as_ref())
            != Some(workspace)
        {
            return Err(invalid(
                "continuation workspace identity differs from its source",
            ));
        }
        match input {
            InvocationInput::Message { .. } => {
                crate::context::frozen::verify_base(
                    connection,
                    &evidence.boundary.invocation,
                    opening.sequence,
                    base,
                )
                .await?;
                return Ok(result);
            }
            InvocationInput::Continuation { claim: parent, .. }
            | InvocationInput::Handoff { claim: parent, .. } => {
                input
                    .validate_inheritance(&evidence.boundary.invocation)
                    .map_err(invalid)?;
                if &parent.base != base {
                    return Err(invalid("continuation changed its inherited Session base"));
                }
                source = parent.source.clone();
            }
            _ => return Err(invalid("source has no resumable model opening")),
        }
    }
}

fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}
