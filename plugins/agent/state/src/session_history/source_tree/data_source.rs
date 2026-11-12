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
use super::*;
impl HistoryDataSource {
    pub async fn run_source(&self, run: RunId) -> Result<RunSource, StoreError> {
        match self {
            Self::Live { history, cut } => {
                history
                    .data
                    .query(queries::RunAt(history.namespace.clone(), cut.clone(), run))
                    .await
            }
            Self::Snapshot(source) => source.run_source(run).await,
        }
    }
    pub async fn view_at(&self, run: RunId) -> Result<crate::fold::RunView, StoreError> {
        match self {
            Self::Live { history, cut } => history.view_at(cut, run).await,
            Self::Snapshot(source) => source.view_at(run).await,
        }
    }
    pub async fn executor_view(
        &self,
        run: RunId,
    ) -> Result<(crate::fold::RunView, ExecutorTranscript), StoreError> {
        match self {
            Self::Live { history, cut } => {
                history
                    .data
                    .query(ExecutorViewAt(history.clone(), cut.clone(), run))
                    .await
            }
            Self::Snapshot(snapshot) => snapshot.executor_view(run).await,
        }
    }
    pub async fn terminated(
        &self,
        run: RunId,
    ) -> Result<Option<(UnixMillis, Terminal)>, StoreError> {
        match self {
            Self::Live { history, cut } => {
                history
                    .data
                    .query(queries::TerminatedAt(
                        history.namespace.clone(),
                        cut.clone(),
                        run,
                    ))
                    .await
            }
            Self::Snapshot(source) => source.terminated(run).await,
        }
    }
    pub async fn request(&self, run: RunId, step: StepId) -> Result<RequestSpec, StoreError> {
        match self {
            Self::Live { history, cut } => {
                history
                    .data
                    .query(RequestAt(history.namespace.clone(), cut.clone(), run, step))
                    .await
            }
            Self::Snapshot(source) => source.request(run, step).await,
        }
    }
    pub async fn with_content<T: Send + 'static>(
        &self,
        run: RunId,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        match self {
            Self::Live { history, cut } => history.with_content(cut, run, reference, consume).await,
            Self::Snapshot(source) => source.with_content(run, reference, consume).await,
        }
    }
    pub async fn sources(
        &self,
        sequence: u64,
        after: Option<u64>,
        limit: u32,
    ) -> Result<SnapshotSources, StoreError> {
        match self {
            Self::Snapshot(source) => source.sources(sequence, after, limit).await,
            Self::Live { history, cut } => {
                let page = history.sources(cut, sequence, after, limit).await?;
                Ok(SnapshotSources {
                    sources: page
                        .sources
                        .into_iter()
                        .map(|source| Source {
                            position: source.position,
                            source: source.request.source,
                            resources: source.request.resources,
                        })
                        .collect(),
                    next: page.next,
                })
            }
        }
    }
    pub async fn with_source<T: Send + 'static>(
        &self,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        match self {
            Self::Snapshot(source) => {
                source
                    .with_source(sequence, position, reference, consume)
                    .await
            }
            Self::Live { history, cut } => {
                history
                    .with_source(cut, sequence, position, reference, consume)
                    .await
            }
        }
    }
    pub(super) async fn tool_positions(
        &self,
        id: &str,
        after: Option<(u64, u64)>,
        min_admission: u64,
        limit: u32,
    ) -> Result<Vec<SnapshotPosition>, StoreError> {
        match self {
            Self::Snapshot(source) => source.tool_positions(id, after, min_admission, limit).await,
            Self::Live { history, cut } => {
                history
                    .data
                    .query(LiveToolPositions(
                        history.namespace.clone(),
                        cut.clone(),
                        id.to_owned(),
                        after,
                        min_admission,
                        limit,
                    ))
                    .await
            }
        }
    }
    pub(in crate::session_history) fn latest_source_in_snapshot(
        &self,
        c: &Connection,
    ) -> Result<Option<RunSource>, StoreError> {
        match self {
            Self::Snapshot(source) => source.latest_source_in_snapshot(c),
            Self::Live { history, cut } => {
                Latest(history.namespace.clone(), cut.clone()).execute(c)
            }
        }
    }
    pub(super) fn snapshot_id(&self) -> Option<SnapshotId> {
        match self {
            Self::Live { .. } => None,
            Self::Snapshot(source) => Some(source.id()),
        }
    }
    pub(in crate::session_history) fn nested_in_snapshot(
        &self,
        c: &Connection,
        marker: &RunSource,
    ) -> Result<Self, StoreError> {
        Ok(Self::Snapshot(match self {
            Self::Live { history, cut } => history.snapshot_in_snapshot(c, cut, marker.run)?,
            Self::Snapshot(source) => source.nested_in_snapshot(c, marker.run)?,
        }))
    }
    pub(super) async fn positions(
        &self,
        anchor: Option<(u64, u64)>,
        reverse: bool,
        include_internal: bool,
        min_admission: u64,
        limit: u32,
    ) -> Result<Vec<SnapshotPosition>, StoreError> {
        match self {
            Self::Snapshot(source) => {
                source
                    .positions(anchor, reverse, include_internal, min_admission, limit)
                    .await
            }
            Self::Live { history, cut } => {
                history
                    .data
                    .query(LivePositions(
                        history.namespace.clone(),
                        cut.clone(),
                        anchor,
                        reverse,
                        include_internal,
                        min_admission,
                        limit,
                    ))
                    .await
            }
        }
    }
}

impl HistoryDataSource {
    pub async fn compaction_duration_ms(
        &self,
        run: RunId,
        summary_run: RunId,
        summary_step: StepId,
        adopted_sequence: u64,
    ) -> Result<u64, StoreError> {
        let query = CompactionDuration(
            self.clone(),
            run,
            summary_run,
            summary_step,
            adopted_sequence,
        );
        match self {
            Self::Live { history, .. } => history.data.query(query).await,
            Self::Snapshot(snapshot) => {
                snapshot
                    .compaction_duration_ms(run, summary_run, summary_step, adopted_sequence)
                    .await
            }
        }
    }
}

pub(in crate::session_history) struct CompactionDuration(
    pub HistoryDataSource,
    pub RunId,
    pub RunId,
    pub StepId,
    pub u64,
);
impl CompactionDuration {
    fn request(&self, c: &Connection, step: StepId) -> Result<RequestSpec, StoreError> {
        match &self.0 {
            HistoryDataSource::Live { history, cut } => {
                RequestAt(history.namespace.clone(), cut.clone(), self.2, step).execute(c)
            }
            HistoryDataSource::Snapshot(snapshot) => {
                let prepared = self.record(c, self.2, "step_prepared", Some(step), None, None)?;
                let (Fact::StepPrepared {
                    step: original,
                    request,
                    ..
                }
                | Fact::ProactiveSummaryPrepared {
                    step: original,
                    request,
                    ..
                }) = prepared.recorded.fact
                else {
                    return Err(invalid(
                        "compaction timing request is not its original StepPrepared",
                    ));
                };
                if original != step {
                    return Err(invalid("compaction timing original request step differs"));
                }
                let request: RequestSpec = snapshot.metadata_in_snapshot(c, self.2, &request)?;
                if request.schema_version != SCHEMA_VERSION || request.step != step {
                    return Err(invalid(
                        "compaction timing original request identity/schema differs",
                    ));
                }
                Ok(request)
            }
        }
    }
    fn record(
        &self,
        c: &Connection,
        target_run: RunId,
        kind: &str,
        step: Option<StepId>,
        attempt: Option<ModelAttemptId>,
        sequence: Option<u64>,
    ) -> Result<HistoryItem, StoreError> {
        let (live_key, snapshot_key, key) = if let Some(sequence) = sequence {
            (
                "sequence",
                "sequence",
                rusqlite::types::Value::Integer(sql::bind_u64(sequence)?),
            )
        } else if let Some(step) = step {
            (
                "step",
                "json_extract(entry_json,'$.step')",
                rusqlite::types::Value::Text(step.to_string()),
            )
        } else if let Some(attempt) = attempt {
            (
                "attempt",
                "json_extract(entry_json,'$.attempt')",
                rusqlite::types::Value::Text(attempt.to_string()),
            )
        } else {
            return Err(invalid(
                "compaction timing requires an original exact identity",
            ));
        };
        match &self.0 {
            HistoryDataSource::Live { history, cut } => {
                sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
                let attempt_step = if live_key == "attempt" {
                    " AND step=(SELECT step FROM agent_attempt_ids WHERE run=?3 AND attempt=?6)"
                } else {
                    ""
                };
                let found: Option<u64> = c.query_row(&format!("SELECT sequence FROM agent_session_history WHERE owner=?1 AND session=?2 AND run=?3 AND (kind=?4 OR (?4='step_prepared' AND kind='proactive_summary_prepared')) AND sequence<=?5 AND {live_key}=?6{attempt_step} ORDER BY sequence LIMIT 1"), params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,target_run.to_string(),kind,sql::bind_u64(cut.through_sequence)?,key],|row|sql::read_u64(row,0)).optional()?;
                let found = found.ok_or_else(|| {
                    invalid("compaction timing original fact is missing from this fixed source cut")
                })?;
                sql::item(c, &history.namespace, cut, found)?
                    .ok_or_else(|| invalid("compaction timing original fact is absent"))
            }
            HistoryDataSource::Snapshot(snapshot) => {
                let manifest = snapshot.manifest_in_snapshot(c)?;
                let maka_agent_facts::history_snapshot::Origin::Canonical { cut } = manifest.origin
                else {
                    return Err(invalid(
                        "imported message source has no canonical compaction timing",
                    ));
                };
                let raw: Option<String> = c.query_row(&format!("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='fact' AND run=?2 AND sequence<=?3 AND (fact_kind=?4 OR (?4='step_prepared' AND fact_kind='proactive_summary_prepared')) AND {snapshot_key}=?5 ORDER BY sequence LIMIT 1"),params![snapshot.id().to_string(),target_run.to_string(),sql::bind_u64(cut.through_sequence)?,kind,key],|row|row.get(0)).optional()?;
                let raw = raw.ok_or_else(|| {
                    invalid("compaction timing snapshot index requires its original cold metadata")
                })?;
                let maka_agent_facts::history_snapshot::Entry::Fact {
                    run,
                    sequence,
                    admission_sequence,
                    step,
                    attempt,
                    id,
                    revision,
                    body,
                    ..
                } = serde_json::from_str(&raw)?
                else {
                    return Err(invalid("compaction timing snapshot has another entry kind"));
                };
                let recorded: RecordedFact = snapshot.metadata_in_snapshot(c, run, &body)?;
                if run != target_run
                    || recorded.run != run
                    || recorded.id != id
                    || recorded.revision != revision
                    || recorded.schema_version != SCHEMA_VERSION
                {
                    return Err(invalid(
                        "compaction timing snapshot original fact identity/schema differs",
                    ));
                }
                Ok(HistoryItem {
                    sequence,
                    admission_sequence,
                    scope: HistoryScope { step, attempt },
                    recorded,
                })
            }
        }
    }
}
impl Query for CompactionDuration {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        use maka_agent_facts::context::ModelPurpose;
        let source = match &self.0 {
            HistoryDataSource::Live { history, cut } => {
                queries::RunAt(history.namespace.clone(), cut.clone(), self.1).execute(c)?
            }
            HistoryDataSource::Snapshot(snapshot) => snapshot.run_in_snapshot(c, self.1)?,
        };
        let adopted = self.record(c, self.1, "context_compacted", None, None, Some(self.4))?;
        if !matches!(&adopted.recorded.fact, Fact::ContextCompacted { .. }) {
            return Err(invalid(
                "compaction timing endpoint is not an actual adoption",
            ));
        }
        if matches!(source.spec.trigger, Trigger::ContextCompact) {
            return duration(source.admission.at, adopted.recorded.at);
        }
        let selected = self.request(c, self.3)?;
        if selected.accounting.purpose != ModelPurpose::Summary {
            return Err(invalid("compaction timing request is not a Summary"));
        }
        let selected_prepared =
            self.record(c, self.2, "step_prepared", Some(self.3), None, None)?;
        if let Fact::ProactiveSummaryPrepared { attempt, .. } = selected_prepared.recorded.fact {
            let closed = self.record(c, self.2, "model_closed", None, Some(attempt), None)?;
            if !matches!(closed.recorded.fact, Fact::ModelClosed { attempt: id, outcome: maka_agent_facts::accounting::Outcome::Success, .. } if id == attempt)
                || selected_prepared.sequence >= closed.sequence
                || closed.sequence >= adopted.sequence
            {
                return Err(invalid(
                    "compaction timing has no original successful background closure",
                ));
            }
            return duration(selected_prepared.recorded.at, closed.recorded.at);
        }
        let first_step = if let Some(original) = selected.summary_repair_of {
            let recorded = self.record(
                c,
                self.2,
                "model_attempt_prepared",
                None,
                Some(original),
                None,
            )?;
            match recorded.recorded.fact {
                Fact::ModelAttemptPrepared { step, attempt, .. }
                    if attempt == original && recorded.sequence < selected_prepared.sequence =>
                {
                    step
                }
                _ => {
                    return Err(invalid(
                        "compaction repair timing does not name its actual prior attempt",
                    ));
                }
            }
        } else {
            self.3
        };
        let first = self.request(c, first_step)?;
        if first.accounting.purpose != ModelPurpose::Summary
            || first.summary_repair_of.is_some()
            || first.source_capture != selected.source_capture
            || first.source_digest != selected.source_digest
            || first.effective_source_digest != selected.effective_source_digest
        {
            return Err(invalid(
                "compaction timing repair changed its original frozen source",
            ));
        }
        let prepared = self.record(c, self.2, "step_prepared", Some(first_step), None, None)?;
        if !matches!(prepared.recorded.fact,Fact::StepPrepared {step,..} if step==first_step)
            || prepared.sequence > selected_prepared.sequence
            || selected_prepared.sequence >= adopted.sequence
        {
            return Err(invalid(
                "compaction timing Summary does not precede its actual adoption",
            ));
        }
        let crossed: bool=match &self.0 {
            HistoryDataSource::Live {history,..} => c.query_row("SELECT EXISTS(SELECT 1 FROM agent_session_history WHERE owner=? AND session=? AND run=? AND kind='context_compacted' AND sequence>? AND sequence<?)",params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,self.1.to_string(),sql::bind_u64(prepared.sequence)?,sql::bind_u64(adopted.sequence)?],|row|row.get(0))?,
            HistoryDataSource::Snapshot(snapshot) => c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries WHERE snapshot=? AND run=? AND kind='fact' AND fact_kind='context_compacted' AND sequence>? AND sequence<?)",params![snapshot.id().to_string(),self.1.to_string(),sql::bind_u64(prepared.sequence)?,sql::bind_u64(adopted.sequence)?],|row|row.get(0))?,
        };
        if crossed {
            return Err(invalid(
                "compaction timing crossed another adopted checkpoint",
            ));
        }
        // ModelRequested was committed before dispatch; repairs retain that original preparation span.
        duration(prepared.recorded.at, adopted.recorded.at)
    }
}

fn duration(start: UnixMillis, end: UnixMillis) -> Result<u64, StoreError> {
    end.0
        .checked_sub(start.0)
        .and_then(|elapsed| u64::try_from(elapsed).ok())
        .ok_or_else(|| invalid("invalid compaction duration"))
}
