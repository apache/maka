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
use rusqlite::OptionalExtension;

impl EventLog {
    pub async fn check_history(&self, session: &str) -> Result<bool, StoreError> {
        crate::sessions::validate_id(session)?;
        let session = session.to_owned();
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let pending = safety::require_safe(&tx, &session, None)?;
                tx.commit()?;
                Ok(pending)
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
    pub async fn active_checkpoint_coverage(
        &self,
        session: &str,
        current: Option<&str>,
    ) -> Result<u64, StoreError> {
        crate::sessions::validate_id(session)?;
        let (session, current) = (session.to_owned(), current.map(str::to_owned));
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let opening = safety::current_opening(&tx, &session, current.as_deref())?;
                let selection = match &opening {
                    Some((_, event)) => Selection::for_opening(&tx, event)?,
                    None => Selection::session(&session),
                };
                let high_water = selection.high_water(&tx, i64::MAX as u64)?;
                let coverage = latest_selected(&tx, &selection, high_water)?
                    .map_or(0, |baseline| baseline.checkpoint.covered_through);
                tx.commit()?;
                Ok(coverage)
            })
            .await
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
        crate::sessions::validate_id(session)?;
        let (session, current) = (session.to_owned(), current.map(str::to_owned));
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let opening = safety::current_opening(&tx, &session, current.as_deref())?;
                let prior_unknown = safety::require_safe(&tx, &session, current.as_deref())?;
                let selection = match &opening {
                    Some((_, event)) => Selection::for_opening(&tx, event)?,
                    None => Selection::session(&session),
                };
                let high_water = if let Some(mode) = &mode {
                    if let Some((_, event)) = &opening {
                        boundary::admit_summary(
                            &tx,
                            &event.invocation.invocation_id,
                            None,
                            i64::MAX as u64,
                        )?;
                        safety::settled_boundary(
                            &tx,
                            &event.invocation.invocation_id,
                            i64::MAX as u64,
                        )?;
                    }
                    boundary::source_fence(
                        &tx,
                        &selection,
                        opening.as_ref(),
                        mode,
                        i64::MAX as u64,
                    )?
                } else {
                    selection.high_water(&tx, i64::MAX as u64)?
                };
                let view =
                    selected_view(&tx, &selection, high_water, i64::MAX as u64, prior_unknown)?;
                tx.commit()?;
                Ok(view)
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
        self.connection
            .read_interruptible(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let selection = Selection {
                    scope: view.source_evidence.scope,
                    session: Some(view.selection.session),
                    lineage: view.selection.lineage,
                };
                let source = materialize_selected(
                    &tx,
                    &selection,
                    view.source_evidence.high_water,
                    view.selection.before,
                    max_events,
                    max_bytes,
                    view.latest_main,
                )?;
                tx.commit()?;
                Ok(source)
            })
            .await
    }
}

/// Handoff admission checks current obligations and committed source identity;
/// it does not read every old model payload to establish private-byte trust.
pub(crate) fn validate_handoff_context(
    connection: &rusqlite::Connection,
    opening: &RuntimeEvent,
) -> Result<(), StoreError> {
    let selection = Selection::for_opening(connection, opening)?;
    let high = selection.high_water(connection, i64::MAX as u64)?;
    latest_with_evidence(connection, &selection, high)?;
    super::semantic::available(connection, &opening.invocation.session_id)?;
    Ok(())
}

pub(super) fn selected_view(
    connection: &rusqlite::Connection,
    selection: &Selection,
    high_water: u64,
    before: u64,
    prior_unknown: bool,
) -> Result<ContextView, StoreError> {
    let captured: i64 = connection
        .prepare_cached("SELECT COALESCE(MAX(sequence),0) FROM event_log")?
        .query_row(rusqlite::params![], |row| row.get(0))?;
    let captured = crate::sequence_number(captured)?;
    selected_view_at(
        connection,
        selection,
        high_water,
        before,
        prior_unknown,
        captured,
    )
}

pub(super) fn selected_view_at(
    connection: &rusqlite::Connection,
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
    super::semantic::available_at(connection, session, captured)?;
    let before = before.min(captured.saturating_add(1));
    let (baseline, source_evidence) = latest_with_evidence(connection, selection, high_water)?;
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
    let has_new_history = super::semantic::meaningful_history(connection, &semantic)?;
    let latest_main = latest_main::read_selected(connection, selection, high_water)?;
    let effective_source_digest =
        crate::archive::digest_selected(connection, selection, &source_evidence, before)?;
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

pub(super) fn materialize_selected(
    connection: &rusqlite::Connection,
    selection: &Selection,
    high_water: u64,
    before: u64,
    max_events: usize,
    max_bytes: usize,
    latest_main: super::LatestMainContext,
) -> Result<ModelContextSource, StoreError> {
    let (baseline, source_evidence) = latest_with_evidence(connection, selection, high_water)?;
    let after = baseline
        .as_ref()
        .map_or(0, |baseline| baseline.checkpoint.covered_through);
    let tail = super::tail::read(
        connection, selection, after, high_water, before, max_events, max_bytes,
    )?;
    let effective_source_digest =
        crate::archive::digest_selected(connection, selection, &source_evidence, before)?;
    Ok(ModelContextSource {
        source_evidence,
        effective_source_digest,
        baseline,
        tail,
        latest_main,
    })
}

pub(crate) fn latest_selected(
    connection: &rusqlite::Connection,
    selection: &Selection,
    through: u64,
) -> Result<Option<ContextBaseline>, StoreError> {
    let Some(StoredEvent { event, .. }) = latest_record(connection, selection, through)? else {
        return Ok(None);
    };
    let Fact::ContextCheckpointRecorded { checkpoint } = &event.fact else {
        return Err(invalid("checkpoint kind mismatch"));
    };
    // This also rejects an unsealed checkpoint observed by a later fact in the
    // same uncommitted append batch. Committed standalone checkpoints have it.
    if matches!(checkpoint.mode, CheckpointMode::Standalone) {
        super::validate::require_terminal(connection, &event)?;
    }
    let native =
        if let maka_agent_facts::context::CheckpointContent::CodexNative { item_digest, .. } =
            &checkpoint.summary
        {
            let (_, request) = super::proof::by_kind(
                connection,
                &event.invocation.invocation_id,
                "model_requested",
                Some(&checkpoint.summary_step_id),
            )?;
            let Fact::ModelRequested {
                context: Some(context),
                model_id,
                ..
            } = request.fact
            else {
                return Err(invalid("native checkpoint has no producing request"));
            };
            let provenance = context
                .codex
                .ok_or_else(|| invalid("native checkpoint has no producer"))?;
            let (_, completion) = super::proof::by_kind(
                connection,
                &event.invocation.invocation_id,
                "model_completed",
                Some(&checkpoint.summary_step_id),
            )?;
            let Fact::ModelCompleted { output, .. } = completion.fact else {
                return Err(invalid("native checkpoint has no completion"));
            };
            let native = output
                .compaction
                .ok_or_else(|| invalid("native checkpoint has no output"))?;
            if native.digest() != *item_digest {
                return Err(invalid("native checkpoint item digest changed"));
            }
            Some(super::NativeBaseline {
                output: native,
                provenance,
                model_id,
            })
        } else {
            None
        };
    Ok(Some(ContextBaseline {
        event_id: event.id,
        checkpoint: checkpoint.clone(),
        native,
    }))
}

pub(super) fn latest_with_evidence(
    connection: &rusqlite::Connection,
    selection: &Selection,
    through: u64,
) -> Result<(Option<ContextBaseline>, super::SourceEvidence), StoreError> {
    let baseline = latest_selected(connection, selection, through)?;
    let evidence = super::evidence::selected(connection, selection, through)?;
    Ok((baseline, evidence))
}

/// Select without traversing predecessors, so chain validation stays iterative.
pub(crate) fn latest_record(
    connection: &rusqlite::Connection,
    selection: &Selection,
    through: u64,
) -> Result<Option<StoredEvent>, StoreError> {
    let filter = Selection::predicate("c", "?3");
    let contains = Selection::lineage_contains("c.invocation_id", "?3");
    let eligible = format!(
        "c.kind='context_checkpoint_recorded' AND c.sequence <= ?1 AND {filter}
         AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=c.invocation_id
           AND r.kind='model_requested' AND r.operation_id=json_extract(c.event_header,'$.fact.checkpoint.summary_step_id')
           AND CASE WHEN json_extract(r.event_header,'$.fact.source_scope.kind')='lineage'
                    AND (?3 IS NULL OR NOT {contains})
               THEN NOT context_lineage_covers_session(?2,c.invocation_id,
                   json_extract(c.event_header,'$.fact.checkpoint.covered_through'))
               ELSE 0 END)"
    );
    // Limit each indexed branch before combining: a wide UNION view would sort
    // every old body even when the newest native checkpoint is already known.
    let row: Option<(i64, String)> = connection
        .prepare_cached(
            &(format!(
                "SELECT * FROM (
           SELECT c.sequence,c.event_header FROM runtime_events c
           WHERE json_extract(c.event_header,'$.invocation.session_id')=?2 AND {eligible}
           ORDER BY c.sequence DESC LIMIT 1)
         UNION ALL SELECT * FROM (
           SELECT c.sequence,c.event_header FROM session_history_members h
           JOIN runtime_events c ON c.sequence=h.sequence
           WHERE h.session_id=?2 AND {eligible} ORDER BY h.sequence DESC LIMIT 1)
         ORDER BY sequence DESC LIMIT 1"
            )),
        )?
        .query_row(
            rusqlite::params![through as i64, &selection.session, &selection.lineage],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((sequence, json)) = row else {
        return Ok(None);
    };
    let event: RuntimeEvent = serde_json::from_str(&json)?;
    Ok(Some(StoredEvent {
        sequence: crate::sequence_number(sequence)?,
        event,
    }))
}
