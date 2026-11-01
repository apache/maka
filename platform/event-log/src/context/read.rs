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
    ContextBaseline, ContextView, ModelContextSource, boundary, invalid, latest_main, safety,
};
use crate::{EventLog, StoreError};
use maka_agent_facts::context::CheckpointMode;
use maka_agent_facts::event::{Fact, RuntimeEvent, StoredEvent};
use sqlx::{Connection, SqliteConnection};

impl EventLog {
    pub async fn check_history(&self, session: &str) -> Result<bool, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let pending = safety::require_safe(&mut tx, &session, None).await?;
                    tx.commit().await?;
                    Ok(pending)
                })
            })
            .await
    }

    pub async fn read_model_view(
        &self,
        session: &str,
        current: Option<&str>,
    ) -> Result<ContextView, StoreError> {
        self.context_view(session, current, None).await
    }
    pub async fn prepare_compaction_view(
        &self,
        session: &str,
        current: Option<&str>,
        mode: &CheckpointMode,
    ) -> Result<ContextView, StoreError> {
        self.context_view(session, current, Some(mode.clone()))
            .await
    }
    async fn context_view(
        &self,
        session: &str,
        current: Option<&str>,
        mode: Option<CheckpointMode>,
    ) -> Result<ContextView, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        let (session, current) = (session.to_owned(), current.map(str::to_owned));
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let opening =
                        safety::current_opening(&mut tx, &session, current.as_deref()).await?;
                    let prior_unknown =
                        safety::require_safe(&mut tx, &session, current.as_deref()).await?;
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
                    let view = selected_view(
                        &mut tx,
                        &selection,
                        high_water,
                        i64::MAX as u64,
                        prior_unknown,
                    )
                    .await?;
                    tx.commit().await?;
                    Ok(view)
                })
            })
            .await
    }

    /// Explicit bounded export of model history. Ordinary model requests use
    /// the fixed semantic view and never enter this materialization path.
    pub async fn capture_model_context(
        &self,
        session: &str,
        current: Option<&str>,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        let view = self.read_model_view(session, current).await?;
        self.materialize_view(view, max_events, max_bytes).await
    }
    pub async fn capture_compaction_context(
        &self,
        session: &str,
        current: Option<&str>,
        mode: &CheckpointMode,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        let view = self.prepare_compaction_view(session, current, mode).await?;
        self.materialize_view(view, max_events, max_bytes).await
    }
    pub(super) async fn materialize_view(
        &self,
        view: ContextView,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<ModelContextSource, StoreError> {
        self.validate_root()?;
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    let selection = Selection {
                        scope: view.source_evidence.scope,
                        session: Some(view.selection.session),
                        lineage: view.selection.lineage,
                    };
                    let source = materialize_selected(
                        &mut tx,
                        &selection,
                        view.source_evidence.high_water,
                        view.selection.before,
                        max_events,
                        max_bytes,
                        view.latest_main,
                    )
                    .await?;
                    tx.commit().await?;
                    Ok(source)
                })
            })
            .await
    }
}

/// Handoff admission checks current obligations and committed source identity;
/// it does not read every old model payload to establish private-byte trust.
pub(crate) async fn validate_handoff_context(
    connection: &mut SqliteConnection,
    opening: &RuntimeEvent,
) -> Result<(), StoreError> {
    let selection = Selection::for_opening(connection, opening).await?;
    let high = selection.high_water(connection, i64::MAX as u64).await?;
    latest_with_evidence(connection, &selection, high).await?;
    super::semantic::available(connection, &opening.invocation.session_id).await?;
    Ok(())
}

pub(super) async fn selected_view(
    connection: &mut SqliteConnection,
    selection: &Selection,
    high_water: u64,
    before: u64,
    prior_unknown: bool,
) -> Result<ContextView, StoreError> {
    let captured: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
        .fetch_one(&mut *connection)
        .await?;
    let captured = crate::sequence_number(captured)?;
    selected_view_at(
        connection,
        selection,
        high_water,
        before,
        prior_unknown,
        captured,
    )
    .await
}

pub(super) async fn selected_view_at(
    connection: &mut SqliteConnection,
    selection: &Selection,
    high_water: u64,
    before: u64,
    prior_unknown: bool,
    captured: u64,
) -> Result<ContextView, StoreError> {
    let session = selection
        .session
        .as_deref()
        .ok_or_else(|| invalid("context requires a Session"))?;
    super::semantic::available_at(connection, session, captured).await?;
    let before = before.min(captured.saturating_add(1));
    let (baseline, source_evidence) =
        latest_with_evidence(connection, selection, high_water).await?;
    let semantic = super::semantic::SemanticSelection {
        session: session.to_owned(),
        lineage: selection.lineage.clone(),
        after: baseline
            .as_ref()
            .map_or(0, |baseline| baseline.checkpoint.covered_through),
        through: high_water,
        before,
        captured_through: captured,
        replay: None,
        prior_unknown,
    };
    let has_new_history = super::semantic::meaningful_history(connection, &semantic).await?;
    let latest_main = latest_main::read_selected(connection, selection, high_water).await?;
    let effective_source_digest =
        crate::archive::digest_selected(connection, selection, &source_evidence, before).await?;
    Ok(ContextView {
        source_evidence,
        effective_source_digest,
        baseline,
        latest_main,
        selection: semantic,
        has_new_history,
        prior_unknown,
    })
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
    let (baseline, source_evidence) =
        latest_with_evidence(connection, selection, high_water).await?;
    let after = baseline
        .as_ref()
        .map_or(0, |baseline| baseline.checkpoint.covered_through);
    let tail = super::tail::read(
        connection, selection, after, high_water, before, max_events, max_bytes,
    )
    .await?;
    let effective_source_digest =
        crate::archive::digest_selected(connection, selection, &source_evidence, before).await?;
    Ok(ModelContextSource {
        source_evidence,
        effective_source_digest,
        baseline,
        tail,
        latest_main,
    })
}

pub(crate) async fn latest_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<Option<ContextBaseline>, StoreError> {
    let Some(StoredEvent { event, .. }) = latest_record(connection, selection, through).await?
    else {
        return Ok(None);
    };
    let Fact::ContextCheckpointRecorded { checkpoint } = &event.fact else {
        return Err(invalid("checkpoint kind mismatch"));
    };
    // This also rejects an unsealed checkpoint observed by a later fact in the
    // same uncommitted append batch. Committed standalone checkpoints have it.
    if matches!(checkpoint.mode, CheckpointMode::Standalone) {
        super::validate::require_terminal(connection, &event).await?;
    }
    Ok(Some(ContextBaseline {
        event_id: event.id,
        checkpoint: checkpoint.clone(),
    }))
}

pub(super) async fn latest_with_evidence(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<(Option<ContextBaseline>, super::SourceEvidence), StoreError> {
    let baseline = latest_selected(connection, selection, through).await?;
    let evidence = super::evidence::selected(connection, selection, through).await?;
    Ok((baseline, evidence))
}

/// Select without traversing predecessors, so chain validation stays iterative.
pub(crate) async fn latest_record(
    connection: &mut SqliteConnection,
    selection: &Selection,
    through: u64,
) -> Result<Option<StoredEvent>, StoreError> {
    let filter = Selection::predicate("c", "?3");
    let contains = Selection::lineage_contains("c.invocation_id", "?3");
    let eligible = format!(
        "c.kind='context_checkpoint_recorded' AND c.sequence <= ?1 AND {filter}
         AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=c.invocation_id
           AND r.kind='model_requested' AND r.operation_id=json_extract(c.event_header,'$.fact.checkpoint.summary_step_id')
           AND json_extract(r.event_header,'$.fact.source_scope.kind')='lineage'
           AND (?3 IS NULL OR NOT {contains}))"
    );
    // Limit each indexed branch before combining: a wide UNION view would sort
    // every old body even when the newest native checkpoint is already known.
    let row: Option<(i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT * FROM (
           SELECT c.sequence,c.event_header FROM runtime_events c
           WHERE json_extract(c.event_header,'$.invocation.session_id')=?2 AND {eligible}
           ORDER BY c.sequence DESC LIMIT 1)
         UNION ALL SELECT * FROM (
           SELECT c.sequence,c.event_header FROM session_history_members h
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
