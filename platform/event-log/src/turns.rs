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

use crate::{EventLog, StoreError, sessions};
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::Invocation;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::input::InvocationInput;
use sqlx::Connection;

mod root;

/// A bounded projection of canonical boundaries, never a model-history prefix.
pub struct TurnBoundary {
    pub opening_event_id: String,
    pub invocation: Invocation,
    pub input: InvocationInput,
    pub state: InvocationState,
    root: Option<root::Origin>,
}

impl TurnBoundary {
    /// Stable client identity. Execution and cleanup still use `invocation`.
    pub fn root_invocation(&self) -> &Invocation {
        self.root
            .as_ref()
            .map_or(&self.invocation, |root| &root.invocation)
    }

    pub fn root_input(&self) -> &InvocationInput {
        self.root.as_ref().map_or(&self.input, |root| &root.input)
    }

    pub fn root_opening_event_id(&self) -> &str {
        self.root
            .as_ref()
            .map_or(&self.opening_event_id, |root| &root.event_id)
    }
}
pub enum InvocationState {
    Admitted,
    Running,
    WaitingForUser,
    Ended {
        event_id: String,
        outcome: InvocationOutcome,
    },
}

impl InvocationState {
    /// A sealed physical Run still owns unfinished logical work.
    pub fn terminal_outcome(&self) -> Option<&InvocationOutcome> {
        match self {
            Self::Ended {
                outcome: InvocationOutcome::HandoffPaused { .. },
                ..
            }
            | Self::Admitted
            | Self::Running
            | Self::WaitingForUser => None,
            Self::Ended { outcome, .. } => Some(outcome),
        }
    }
}

impl EventLog {
    /// Compact canonical receipt keyed by the globally unique opening identity.
    /// No plugin ledger or current Session tip is used to reconstruct acceptance.
    pub async fn continuation_receipt(
        &self,
        invocation_id: &str,
    ) -> Result<
        Option<(
            Invocation,
            maka_agent_facts::continuation::RunBoundary,
            String,
        )>,
        StoreError,
    > {
        self.validate_root()?;
        sessions::validate_id(invocation_id)?;
        let invocation_id = invocation_id.to_owned();
        let expected_session = self.expected_session.clone();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
                        "SELECT json_extract(event_json, '$.invocation'),
                    json_extract(event_json, '$.fact.input.claim.source'),
                    json_extract(event_json, '$.fact.input.request_fingerprint')
                 FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'
                   AND (? IS NULL OR event_session = ?)",
                    )
                    .bind(invocation_id)
                    .bind(expected_session.as_deref())
                    .bind(expected_session.as_deref())
                    .fetch_optional(connection)
                    .await?;
                    row.map(|(invocation, source, fingerprint)| {
                        Ok((
                            serde_json::from_str(&invocation)?,
                            serde_json::from_str(&source.ok_or(StoreError::EventConflict)?)?,
                            fingerprint.ok_or(StoreError::EventConflict)?,
                        ))
                    })
                    .transpose()
                })
            })
            .await
    }
    /// Exact physical invocation and Run-local event count in one snapshot.
    /// Never substitutes the Session tip or a root-global stream position.
    pub async fn invocation_boundary(
        &self,
        session_id: &str,
        invocation_id: &str,
    ) -> Result<Option<(TurnBoundary, u64)>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        sessions::validate_id(invocation_id)?;
        let session = session_id.to_owned();
        let invocation = invocation_id.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let opening: Option<String> = sqlx::query_scalar(
                        "SELECT event_json FROM runtime_events WHERE invocation_id = ?1
                 AND kind = 'invocation_opened'
                 AND json_extract(event_json, '$.invocation.session_id') = ?2",
                    )
                    .bind(invocation)
                    .bind(session)
                    .fetch_optional(&mut *tx)
                    .await?;
                    let result = match opening {
                        Some(opening) => {
                            let boundary =
                                project(&mut tx, serde_json::from_str(&opening)?).await?;
                            let high_water: i64 = sqlx::query_scalar(
                                "SELECT COUNT(*) FROM runtime_events WHERE invocation_id = ?",
                            )
                            .bind(&boundary.invocation.invocation_id)
                            .fetch_one(&mut *tx)
                            .await?;
                            Some((boundary, high_water as u64))
                        }
                        None => None,
                    };
                    tx.commit().await?;
                    Ok(result)
                })
            })
            .await
    }
    pub async fn latest_turn_boundary(
        &self,
        session_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        let session = session_id.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    read(&mut tx, &session, None).await
                })
            })
            .await
    }

    /// Read the frozen execution boundary without loading message or model bodies.
    pub async fn invocation_configuration(
        &self,
        invocation: &Invocation,
    ) -> Result<Option<maka_agent_facts::execution::InvocationConfiguration>, StoreError> {
        self.validate_root()?;
        let invocation = invocation.clone();
        self.connection.run(move |connection| Box::pin(async move {
            let configuration: Option<String> = sqlx::query_scalar(
                "SELECT json_extract(event_json, '$.fact.configuration') FROM runtime_events
                 WHERE invocation_id = ?1 AND kind = 'invocation_opened'
                 AND json_extract(event_json, '$.invocation.session_id') = ?2
                 AND json_extract(event_json, '$.invocation.run_id') = ?3
                 AND json_extract(event_json, '$.invocation.turn_id') = ?4"
            ).bind(&invocation.invocation_id).bind(&invocation.session_id).bind(&invocation.run_id).bind(&invocation.turn_id)
                .fetch_optional(connection).await?.flatten();
            configuration.map(|value| serde_json::from_str(&value).map_err(StoreError::from)).transpose()
        })).await
    }

    /// Exact physical Run, including an earlier Run of the same logical Turn.
    pub async fn run_boundary(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        sessions::validate_id(run_id)?;
        let (session_id, run_id) = (session_id.to_owned(), run_id.to_owned());
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let Some(invocation) = run_invocation(&mut tx, &session_id, &run_id).await? else {
                        return Ok(None);
                    };
                    let opening: String = sqlx::query_scalar(
                        "SELECT event_json FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'",
                    ).bind(invocation).fetch_one(&mut *tx).await?;
                    let result = project(&mut tx, serde_json::from_str(&opening)?).await?;
                    tx.commit().await?;
                    Ok(Some(result))
                })
            })
            .await
    }

    /// Only opening, logical root and terminal bodies are decoded, irrespective of streamed history.
    /// Reading control/status must remain possible after context budgets fill.
    pub async fn turn_boundary(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session_id)?;
        sessions::validate_id(turn_id)?;
        let session_id = session_id.to_owned();
        let turn_id = turn_id.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    let result = read(&mut transaction, &session_id, Some(&turn_id)).await?;
                    transaction.commit().await?;
                    Ok(result)
                })
            })
            .await
    }
}

/// Caller holds one read transaction when combining with metadata or a cursor.
pub(crate) async fn read(
    connection: &mut sqlx::SqliteConnection,
    session_id: &str,
    turn_id: Option<&str>,
) -> Result<Option<TurnBoundary>, StoreError> {
    let opening: Option<String> = sqlx::query_scalar(
        "SELECT event_json FROM runtime_events
             WHERE kind = 'invocation_opened'
             AND json_extract(event_json, '$.invocation.session_id') = ?1
             AND (?2 IS NULL OR json_extract(event_json, '$.invocation.turn_id') = ?2)
             ORDER BY sequence DESC LIMIT 1",
    )
    .bind(session_id)
    .bind(turn_id)
    .fetch_optional(&mut *connection)
    .await?;
    let Some(opening) = opening else {
        return Ok(None);
    };
    Ok(Some(
        project(connection, serde_json::from_str(&opening)?).await?,
    ))
}

/// Fail closed on ambiguous legacy/synthetic identities; never choose a newer Run.
pub(crate) async fn run_invocation(
    connection: &mut sqlx::SqliteConnection,
    session: &str,
    run: &str,
) -> Result<Option<String>, StoreError> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT invocation_id FROM runtime_events WHERE kind = 'invocation_opened'
         AND json_extract(event_json, '$.invocation.session_id') = ?
         AND json_extract(event_json, '$.invocation.run_id') = ? LIMIT 2",
    )
    .bind(session)
    .bind(run)
    .fetch_all(connection)
    .await?;
    if ids.len() > 1 {
        return Err(StoreError::InvalidTransition(
            "Run names multiple invocations".into(),
        ));
    }
    Ok(ids.into_iter().next())
}

pub(crate) async fn project(
    connection: &mut sqlx::SqliteConnection,
    opening: RuntimeEvent,
) -> Result<TurnBoundary, StoreError> {
    let Fact::InvocationOpened { input, .. } = opening.fact else {
        return Err(StoreError::InvalidTransition(
            "invalid stored invocation opening".into(),
        ));
    };
    let root = root::read(connection, &opening.invocation, &input).await?;
    let terminal: Option<String> = sqlx::query_scalar(
            "SELECT event_json FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_ended'",
        ).bind(&opening.invocation.invocation_id).fetch_optional(&mut *connection).await?;
    let state = if let Some(terminal) = terminal {
        let terminal: RuntimeEvent = serde_json::from_str(&terminal)?;
        let Fact::InvocationEnded { outcome } = terminal.fact else {
            return Err(StoreError::InvalidTransition(
                "invalid stored invocation terminal".into(),
            ));
        };
        if terminal.invocation != opening.invocation {
            return Err(StoreError::InvalidTransition(
                "stored invocation identity changed".into(),
            ));
        }
        InvocationState::Ended {
            event_id: terminal.id,
            outcome,
        }
    } else if crate::interactions::pending(connection, &opening.invocation.session_id)
        .await?
        .iter()
        .any(|request| {
            request.run_id == opening.invocation.run_id
                && request.turn_id == opening.invocation.turn_id
        })
    {
        InvocationState::WaitingForUser
    } else {
        let requested: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ? AND kind = 'model_requested')",
            ).bind(&opening.invocation.invocation_id).fetch_one(&mut *connection).await?;
        if requested {
            InvocationState::Running
        } else {
            InvocationState::Admitted
        }
    };
    Ok(TurnBoundary {
        root,
        opening_event_id: opening.id,
        invocation: opening.invocation,
        input,
        state,
    })
}
