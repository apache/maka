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
use rusqlite::OptionalExtension;

mod root;

/// A bounded projection of canonical boundaries, never a model-history prefix.
pub struct TurnBoundary {
    pub opening_event_id: String,
    pub invocation: Invocation,
    pub input: InvocationInput,
    pub configuration: Option<Box<maka_agent_facts::execution::InvocationConfiguration>>,
    pub state: InvocationState,
    root: Option<root::Origin>,
}

impl TurnBoundary {
    #[cfg(test)]
    pub(crate) fn for_test(invocation: Invocation) -> Self {
        Self {
            opening_event_id: "opened".into(),
            invocation,
            input: InvocationInput::Message {
                content: "hi".into(),
                source_messages: vec![],
                request_fingerprint: None,
            },
            configuration: None,
            state: InvocationState::Running,
            root: None,
        }
    }
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
        sessions::validate_id(invocation_id)?;
        let invocation_id = invocation_id.to_owned();
        let expected_session = self.expected_session.clone();
        self.connection
            .read(move |connection| {
                let row: Option<(String, Option<String>, Option<String>)> = connection
                    .query_row(
                        "SELECT json_extract(event_header, '$.invocation'),
                    json_extract(event_header, '$.fact.input.claim.source'),
                    json_extract(event_header, '$.fact.input.request_fingerprint')
                 FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'
                   AND (? IS NULL OR event_session = ?)",
                        rusqlite::params![
                            invocation_id,
                            expected_session.as_deref(),
                            expected_session.as_deref()
                        ],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .optional()?;
                row.map(|(invocation, source, fingerprint)| {
                    Ok((
                        serde_json::from_str(&invocation)?,
                        serde_json::from_str(&source.ok_or(StoreError::EventConflict)?)?,
                        fingerprint.ok_or(StoreError::EventConflict)?,
                    ))
                })
                .transpose()
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
        sessions::validate_id(session_id)?;
        sessions::validate_id(invocation_id)?;
        let session = session_id.to_owned();
        let invocation = invocation_id.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let opening: Option<String> = tx
                    .query_row(
                        "SELECT event_header FROM runtime_events WHERE invocation_id = ?1
                 AND kind = 'invocation_opened'
                 AND json_extract(event_header, '$.invocation.session_id') = ?2",
                        rusqlite::params![invocation, session],
                        |row| row.get(0),
                    )
                    .optional()?;
                let result = match opening {
                    Some(opening) => {
                        let boundary = project(&tx, serde_json::from_str(&opening)?)?;
                        let high_water: i64 = tx.query_row(
                            "SELECT COUNT(*) FROM runtime_events WHERE invocation_id = ?",
                            rusqlite::params![&boundary.invocation.invocation_id],
                            |row| row.get(0),
                        )?;
                        Some((boundary, high_water as u64))
                    }
                    None => None,
                };
                tx.commit()?;
                Ok(result)
            })
            .await
    }
    pub async fn latest_turn_boundary(
        &self,
        session_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        sessions::validate_id(session_id)?;
        let session = session_id.to_owned();
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                read(&tx, &session, None)
            })
            .await
    }

    /// Read the frozen execution boundary without loading message or model bodies.
    pub async fn invocation_configuration(
        &self,
        invocation: &Invocation,
    ) -> Result<Option<maka_agent_facts::execution::InvocationConfiguration>, StoreError> {
        let invocation = invocation.clone();
        self.connection.read(move |connection| {
            let configuration: Option<String> = connection.query_row("SELECT json_extract(event_header, '$.fact.configuration') FROM runtime_events
                 WHERE invocation_id = ?1 AND kind = 'invocation_opened'
                 AND json_extract(event_header, '$.invocation.session_id') = ?2
                 AND json_extract(event_header, '$.invocation.run_id') = ?3
                 AND json_extract(event_header, '$.invocation.turn_id') = ?4", rusqlite::params![&invocation.invocation_id, &invocation.session_id, &invocation.run_id, &invocation.turn_id], |row| row.get(0)).optional()?.flatten();
            configuration.map(|value| serde_json::from_str(&value).map_err(StoreError::from)).transpose()
        }).await
    }

    /// Exact physical Run, including an earlier Run of the same logical Turn.
    pub async fn run_boundary(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Option<TurnBoundary>, StoreError> {
        sessions::validate_id(session_id)?;
        sessions::validate_id(run_id)?;
        let (session_id, run_id) = (session_id.to_owned(), run_id.to_owned());
        self.connection
            .read(move |connection| {
                {
                    let tx = rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Deferred)?;
                    let Some(invocation) = run_invocation(&tx, &session_id, &run_id)? else {
                        return Ok(None);
                    };
                    let opening: String = tx.query_row("SELECT event_header FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_opened'", rusqlite::params![invocation], |row| row.get(0))?;
                    let result = project(&tx, serde_json::from_str(&opening)?)?;
                    tx.commit()?;
                    Ok(Some(result))
                }
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
        sessions::validate_id(session_id)?;
        sessions::validate_id(turn_id)?;
        let session_id = session_id.to_owned();
        let turn_id = turn_id.to_owned();
        self.connection
            .read(move |connection| {
                let transaction = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let result = read(&transaction, &session_id, Some(&turn_id))?;
                transaction.commit()?;
                Ok(result)
            })
            .await
    }
}

/// Caller holds one read transaction when combining with metadata or a cursor.
pub(crate) fn read(
    connection: &rusqlite::Connection,
    session_id: &str,
    turn_id: Option<&str>,
) -> Result<Option<TurnBoundary>, StoreError> {
    let opening: Option<String> = connection
        .query_row(
            "SELECT event_header FROM runtime_events
             WHERE kind = 'invocation_opened'
             AND json_extract(event_header, '$.invocation.session_id') = ?1
             AND (?2 IS NULL OR json_extract(event_header, '$.invocation.turn_id') = ?2)
             ORDER BY sequence DESC LIMIT 1",
            rusqlite::params![session_id, turn_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(opening) = opening else {
        return Ok(None);
    };
    Ok(Some(project(connection, serde_json::from_str(&opening)?)?))
}

/// Fail closed on ambiguous legacy/synthetic identities; never choose a newer Run.
pub(crate) fn run_invocation(
    connection: &rusqlite::Connection,
    session: &str,
    run: &str,
) -> Result<Option<String>, StoreError> {
    let ids: Vec<String> = connection
        .prepare_cached(
            "SELECT invocation_id FROM runtime_events WHERE kind = 'invocation_opened'
         AND json_extract(event_header, '$.invocation.session_id') = ?
         AND json_extract(event_header, '$.invocation.run_id') = ? LIMIT 2",
        )?
        .query_map(rusqlite::params![session, run], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > 1 {
        return Err(StoreError::InvalidTransition(
            "Run names multiple invocations".into(),
        ));
    }
    Ok(ids.into_iter().next())
}

pub(crate) fn project(
    connection: &rusqlite::Connection,
    opening: RuntimeEvent,
) -> Result<TurnBoundary, StoreError> {
    let Fact::InvocationOpened {
        input,
        configuration,
    } = opening.fact
    else {
        return Err(StoreError::InvalidTransition(
            "invalid stored invocation opening".into(),
        ));
    };
    let root = root::read(connection, &opening.invocation, &input)?;
    let terminal: Option<String> = connection.query_row("SELECT event_header FROM runtime_events WHERE invocation_id = ? AND kind = 'invocation_ended'", rusqlite::params![&opening.invocation.invocation_id], |row| row.get(0)).optional()?;
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
    } else if crate::interactions::pending(connection, &opening.invocation.session_id)?
        .iter()
        .any(|request| {
            request.run_id == opening.invocation.run_id
                && request.turn_id == opening.invocation.turn_id
        })
    {
        InvocationState::WaitingForUser
    } else {
        let requested: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM runtime_events WHERE invocation_id = ? AND kind = 'model_requested')", rusqlite::params![&opening.invocation.invocation_id], |row| row.get(0))?;
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
        configuration,
        state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::event::EventWrite;
    use std::{sync::Arc, time::Duration};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn control_reads_bypass_writer_and_preserve_committed_terminal_and_count() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(
            EventLog::open(&directory.path().join("runtime.sqlite"))
                .await
                .unwrap(),
        );
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let content: maka_agent_facts::input::MessageInput = "question".into();
        let source = maka_agent_facts::message::RootSourceMessage {
            unprepared_content: content.clone(),
            message: maka_agent_facts::input::DeliveredMessage {
                origin: None,
                message_id: "message".into(),
                submitted_content_digest: content.content_digest().unwrap(),
                content: content.clone(),
            },
            submitted_placement: maka_agent_facts::message::Placement::NextTurn,
            disposition: maka_agent_facts::message::MessageDisposition::TurnStarted,
            submitted_intent: None,
        };
        let opening = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: vec![source],
                    content,
                    request_fingerprint: None,
                },
            },
        );
        store
            .append(&EventWrite::plain(opening.clone()).unwrap())
            .await
            .unwrap();
        let terminal = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        );
        let pending_terminal = terminal.clone();
        let (entered, reached) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let writer = store.clone();
        let blocked = tokio::spawn(async move {
            writer
                .connection
                .run(move |connection| {
                    {
                        let tx = rusqlite::Transaction::new_unchecked(
                            connection,
                            rusqlite::TransactionBehavior::Deferred,
                        )?;
                        // Hold an uncommitted terminal on the actual writer while readers
                        // must still see the previously committed opening and event count.
                        crate::append::ingress::insert(
                            &tx,
                            &pending_terminal,
                            serde_json::to_string(&pending_terminal)?,
                            crate::append::ingress::Position::Admitted,
                        )?;
                        entered.send(()).unwrap();
                        gate.blocking_recv().unwrap();
                        tx.commit()?;
                        Ok(())
                    }
                })
                .await
        });
        reached.await.unwrap();
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            let (boundary, count) = store
                .invocation_boundary("session", "invocation")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(boundary.invocation, invocation);
            assert_eq!(boundary.opening_event_id, opening.id);
            assert!(matches!(boundary.state, InvocationState::Admitted));
            assert_eq!(count, 1);
            for boundary in [
                store
                    .latest_turn_boundary("session")
                    .await
                    .unwrap()
                    .unwrap(),
                store.run_boundary("session", "run").await.unwrap().unwrap(),
                store
                    .turn_boundary("session", "turn")
                    .await
                    .unwrap()
                    .unwrap(),
            ] {
                assert_eq!(boundary.invocation, invocation);
                assert!(matches!(boundary.state, InvocationState::Admitted));
            }
            assert!(
                store
                    .invocation_configuration(&invocation)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(
                store
                    .continuation_receipt("missing")
                    .await
                    .unwrap()
                    .is_none()
            );
            for origin in [
                crate::observation::WorkOrigin::Message("message".into()),
                crate::observation::WorkOrigin::Invocation("invocation".into()),
            ] {
                let observed = store
                    .work_observation("session", origin, 0, None)
                    .await
                    .unwrap();
                let crate::message_resolution::MessageExecution::Owned(boundary) =
                    observed.execution
                else {
                    panic!("committed source must resolve to its exclusive invocation");
                };
                assert_eq!(boundary.invocation, invocation);
                assert!(matches!(boundary.state, InvocationState::Admitted));
                assert_eq!(observed.high_water, 1);
                assert!(observed.answer.is_none());
            }
            let crate::message_resolution::MessageExecution::Owned(boundary) =
                store.message_execution("session", "message").await.unwrap()
            else {
                panic!("committed source must resolve while writer is blocked");
            };
            assert_eq!(boundary.invocation, invocation);
            assert!(matches!(boundary.state, InvocationState::Admitted));
        })
        .await;
        release.send(()).unwrap();
        blocked.await.unwrap().unwrap();
        observed.expect("boundary reads must complete while the writer is blocked");
        let (boundary, count) = store
            .invocation_boundary("session", "invocation")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 2);
        let InvocationState::Ended { event_id, outcome } = boundary.state else {
            panic!("committed terminal must be visible");
        };
        assert_eq!(event_id, terminal.id);
        assert_eq!(outcome, InvocationOutcome::Completed);
        for origin in [
            crate::observation::WorkOrigin::Message("message".into()),
            crate::observation::WorkOrigin::Invocation("invocation".into()),
        ] {
            let observed = store
                .work_observation("session", origin, 0, None)
                .await
                .unwrap();
            assert_eq!(observed.high_water, 2);
            let crate::message_resolution::MessageExecution::Owned(boundary) = observed.execution
            else {
                panic!("committed source must retain its exclusive invocation");
            };
            assert_eq!(boundary.invocation, invocation);
            assert!(
                matches!(boundary.state, InvocationState::Ended { ref event_id, outcome: InvocationOutcome::Completed } if event_id == &terminal.id)
            );
        }
        let crate::message_resolution::MessageExecution::Owned(boundary) =
            store.message_execution("session", "message").await.unwrap()
        else {
            panic!("message execution must retain its committed owner");
        };
        assert!(
            matches!(boundary.state, InvocationState::Ended { ref event_id, outcome: InvocationOutcome::Completed } if event_id == &terminal.id)
        );
        Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    }
}
