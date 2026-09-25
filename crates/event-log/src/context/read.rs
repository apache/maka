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

use super::selection::Selection;
use super::{
    ContextBaseline, ModelContextSource, boundary, evidence, invalid, latest_main, proof, safety,
    validate,
};
use crate::{EventLog, StoreError};
use maka_runtime::{
    context::CheckpointMode,
    event::{Fact, RuntimeEvent, StoredEvent},
};
use sqlx::{Connection, SqliteConnection};

impl EventLog {
    /// Check an explicit user's fresh message against all prior facts. The
    /// returned bit only marks whether a sealed unknown dispatch is present.
    pub async fn check_manual_message_history(&self, session: &str) -> Result<bool, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let pending =
                        safety::require_manual_message_safe(&mut tx, &session, None).await?;
                    tx.commit().await?;
                    Ok(pending)
                })
            })
            .await
    }

    pub async fn read_model_context(
        &self,
        session: &str,
        current: Option<&str>,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        self.context_source(session, current, max_events, max_bytes, None, false)
            .await
    }

    pub async fn read_manual_message_context(
        &self,
        session: &str,
        current: &str,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        self.context_source(session, Some(current), max_events, max_bytes, None, true)
            .await
    }

    pub async fn prepare_context_compaction(
        &self,
        session: &str,
        current: Option<&str>,
        max_events: usize,
        max_bytes: usize,
        mode: &CheckpointMode,
    ) -> Result<ModelContextSource, StoreError> {
        self.context_source(
            session,
            current,
            max_events,
            max_bytes,
            Some(mode.clone()),
            false,
        )
        .await
    }

    async fn context_source(
        &self,
        session: &str,
        current: Option<&str>,
        max_events: usize,
        max_bytes: usize,
        mode: Option<CheckpointMode>,
        manual_message: bool,
    ) -> Result<ModelContextSource, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let (session, current) = (session.to_owned(), current.map(str::to_owned));
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let opening =
                        safety::current_opening(&mut tx, &session, current.as_deref()).await?;
                    if manual_message {
                        let Some((_, event)) = &opening else {
                            return Err(invalid("manual message has no active opening"));
                        };
                        if !matches!(
                            &event.fact,
                            Fact::InvocationOpened {
                                input: maka_runtime::input::InvocationInput::Message { .. },
                                ..
                            }
                        ) {
                            return Err(invalid(
                                "manual message context requires a message opening",
                            ));
                        }
                        safety::require_manual_message_safe(&mut tx, &session, current.as_deref())
                            .await?;
                    } else {
                        safety::require_safe(&mut tx, &session, current.as_deref()).await?;
                    }
                    let selection = match &opening {
                        Some((_, event)) => Selection::for_opening(&mut tx, event).await?,
                        None => Selection::session(&session),
                    };
                    let high_water = if let Some(mode) = &mode {
                        if let Some((_, event)) = &opening {
                            boundary::admit_summary(
                                &mut tx,
                                &event.invocation.invocation_id,
                                None,
                                i64::MAX as u64,
                            )
                            .await?;
                            safety::settled_boundary(
                                &mut tx,
                                &event.invocation.invocation_id,
                                i64::MAX as u64,
                            )
                            .await?;
                        }
                        boundary::source_fence(
                            &mut tx,
                            &selection,
                            opening.as_ref(),
                            mode,
                            i64::MAX as u64,
                        )
                        .await?
                    } else {
                        selection.high_water(&mut tx, i64::MAX as u64).await?
                    };
                    let before = i64::MAX as u64;
                    let latest_main =
                        latest_main::read_selected(&mut tx, &selection, high_water).await?;
                    let source = materialize_selected(
                        &mut tx,
                        &selection,
                        high_water,
                        before,
                        max_events,
                        max_bytes,
                        latest_main,
                    )
                    .await?;
                    tx.commit().await?;
                    Ok(source)
                })
            })
            .await
    }
}

/// Use the same effective-tail/anchor accounting as the successor's first read.
pub(crate) async fn check_handoff_capacity(
    connection: &mut SqliteConnection,
    opening: &maka_runtime::event::RuntimeEvent,
    max_events: usize,
    max_bytes: usize,
) -> Result<(), StoreError> {
    let selection = Selection::for_opening(connection, opening).await?;
    let high = selection.high_water(connection, i64::MAX as u64).await?;
    materialize_selected(
        connection,
        &selection,
        high,
        i64::MAX as u64,
        max_events,
        max_bytes,
        super::LatestMainContext::TraceUnavailable,
    )
    .await?;
    Ok(())
}

pub(super) async fn materialize_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    high_water: u64,
    before: u64,
    max_events: usize,
    max_bytes: usize,
    latest_main: super::LatestMainContext,
) -> Result<ModelContextSource, StoreError> {
    let baseline = latest_selected(connection, selection, high_water).await?;
    let anchor = if let Some(ContextBaseline { checkpoint, .. }) = &baseline {
        if let CheckpointMode::MidTurn { anchor_event_id } = &checkpoint.mode {
            let (sequence, event) = proof::by_id(connection, anchor_event_id).await?;
            Some(StoredEvent { sequence, event })
        } else {
            None
        }
    } else {
        None
    };
    let anchor_bytes = anchor
        .as_ref()
        .map(|a| serde_json::to_vec(&a.event).map(|b| b.len()))
        .transpose()?
        .unwrap_or(0);
    let remaining_bytes = max_bytes
        .checked_sub(anchor_bytes)
        .ok_or(StoreError::PrefixTooLarge)?;
    let remaining_events = max_events
        .checked_sub(usize::from(anchor.is_some()))
        .ok_or(StoreError::PrefixTooLarge)?;
    let after = baseline
        .as_ref()
        .map_or(0, |b| b.checkpoint.covered_through);
    let tail = super::tail::read(
        connection,
        selection,
        after,
        high_water,
        before,
        remaining_events,
        remaining_bytes,
    )
    .await?;
    let source_evidence = evidence::selected(connection, selection, high_water).await?;
    let effective_source_digest =
        crate::archive::digest_selected(connection, selection, &source_evidence, before).await?;
    Ok(ModelContextSource {
        source_evidence,
        effective_source_digest,
        baseline,
        anchor,
        tail,
        latest_main,
    })
}

pub(crate) async fn latest_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<Option<ContextBaseline>, StoreError> {
    let Some(StoredEvent { sequence, event }) =
        latest_record(connection, selection, through).await?
    else {
        return Ok(None);
    };
    validate::chain(connection, &event, sequence, true).await?;
    let Fact::ContextCheckpointRecorded { checkpoint } = event.fact else {
        return Err(invalid("checkpoint kind mismatch"));
    };
    Ok(Some(ContextBaseline {
        event_id: event.id,
        checkpoint,
    }))
}

/// Select without traversing predecessors, so chain validation stays iterative.
pub(crate) async fn latest_record(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<Option<StoredEvent>, StoreError> {
    let filter = Selection::predicate("c", "?3");
    let eligible = format!(
        "c.kind='context_checkpoint_recorded' AND c.sequence <= ?1 AND {filter}
         AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=c.invocation_id
           AND r.kind='model_requested' AND r.operation_id=json_extract(c.event_json,'$.fact.checkpoint.summary_step_id')
           AND json_extract(r.event_json,'$.fact.source_scope.kind')='lineage'
           AND (?3 IS NULL OR c.invocation_id NOT IN (SELECT value FROM json_each(?3,'$.runs'))))"
    );
    // Limit each indexed branch before combining: a wide UNION view would sort
    // every old body even when the newest native checkpoint is already known.
    let row: Option<(i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT * FROM (
           SELECT c.sequence,c.event_json FROM runtime_events c
           WHERE json_extract(c.event_json,'$.invocation.session_id')=?2 AND {eligible}
           ORDER BY c.sequence DESC LIMIT 1)
         UNION ALL SELECT * FROM (
           SELECT c.sequence,c.event_json FROM session_history_members h
           JOIN runtime_events c ON c.sequence=h.sequence
           WHERE h.session_id=?2 AND {eligible} ORDER BY h.sequence DESC LIMIT 1)
         ORDER BY sequence DESC LIMIT 1"
    )))
    .bind(through as i64)
    .bind(&selection.session)
    .bind(&selection.lineage)
    .fetch_optional(&mut *connection)
    .await?;
    let Some((sequence, json)) = row else {
        return Ok(None);
    };
    let event: RuntimeEvent = serde_json::from_str(&json)?;
    Ok(Some(StoredEvent {
        sequence: crate::sequence_number(sequence)?,
        event,
    }))
}
