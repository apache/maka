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
use maka_agent_facts::{execution::ModelBinding, model::ModelUsage};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionModelMetrics {
    pub run: RunId,
    pub step: StepId,
    pub attempt: ModelAttemptId,
    pub model_id: String,
    pub binding: ModelBinding,
    pub requested_at: Option<UnixMillis>,
    pub finished_at: Option<UnixMillis>,
    pub usage: ModelUsage,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
    pub context_last_known: bool,
    pub provenance: ContentRef,
}

use super::{
    snapshot::{
        Snapshot,
        metrics_metadata::{self, ModelMetadata},
    },
    source_tree::{HistoryDataSource, Segment, SourceTree},
};
use crate::store::invalid;
use maka_agent_facts::{
    accounting::{ModelEvidence, Origin, Outcome},
    context::{ModelPurpose, RequestContextEvidence},
    history_snapshot::{Entry, Origin as SnapshotOrigin},
};
use rusqlite::{OptionalExtension, params};
use serde::de::DeserializeOwned;
use std::io::Read;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelCalibrationSample {
    pub binding: ModelBinding,
    pub model_id: String,
    pub input_tokens: u64,
    pub original_estimate: u64,
    pub route_identity: String,
    pub previous_checkpoint_id: Option<String>,
}

impl SessionHistory {
    pub async fn metrics(
        &self,
        cut: &HistoryCut,
    ) -> Result<Option<SessionModelMetrics>, StoreError> {
        self.data
            .query(ReadMetrics(self.clone(), cut.clone()))
            .await
    }
    pub async fn calibration_sample(
        &self,
        cut: &HistoryCut,
    ) -> Result<Option<ModelCalibrationSample>, StoreError> {
        self.data
            .query(ReadCalibration(self.clone(), cut.clone()))
            .await
    }
}

#[derive(Clone, Copy)]
enum Selection {
    LatestSuccess,
    LatestRequest,
}
struct ReadMetrics(SessionHistory, HistoryCut);
struct ReadCalibration(SessionHistory, HistoryCut);
struct Closed {
    sequence: u64,
    at: UnixMillis,
    outcome: Outcome,
    usage: ModelUsage,
}
struct Sample {
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    prepared: u64,
    accounting: ModelEvidence,
    provenance: ContentRef,
    requested_at: Option<UnixMillis>,
    closed: Option<Closed>,
    context: Option<Provenance>,
    changed: bool,
    reset: bool,
}
struct Provenance {
    context: RequestContextEvidence,
    route_identity: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequestMetadata {
    schema_version: u32,
    step: StepId,
    accounting: ModelEvidence,
    provenance: ContentRef,
}
impl Query for ReadMetrics {
    type Output = Option<SessionModelMetrics>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Some(sample) = select(c, &self.0, &self.1, Selection::LatestSuccess)? else {
            return Ok(None);
        };
        let closed = sample
            .closed
            .ok_or_else(|| invalid("successful metrics have no original closure"))?;
        let context = sample
            .context
            .ok_or_else(|| invalid("successful metrics have no original provenance"))?;
        let context_tokens = if sample.reset {
            None
        } else {
            closed
                .usage
                .input_tokens
                .zip(closed.usage.output_tokens)
                .and_then(|(input, output)| input.checked_add(output))
        };
        Ok(Some(SessionModelMetrics {
            run: sample.run,
            step: sample.step,
            attempt: sample.attempt,
            model_id: sample.accounting.model_id,
            binding: sample.accounting.binding,
            requested_at: sample.requested_at,
            finished_at: Some(closed.at),
            usage: closed.usage,
            context_tokens,
            context_window: context
                .context
                .model_context
                .and_then(|context| context.model_context_window),
            context_last_known: sample.changed,
            provenance: sample.provenance,
        }))
    }
}
impl Query for ReadCalibration {
    type Output = Option<ModelCalibrationSample>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Some(sample) = select(c, &self.0, &self.1, Selection::LatestRequest)? else {
            return Ok(None);
        };
        let Some(closed) = sample
            .closed
            .filter(|closed| closed.outcome == Outcome::Success)
        else {
            return Ok(None);
        };
        let Some(input_tokens) = closed.usage.input_tokens.filter(|input| *input > 0) else {
            return Ok(None);
        };
        let Some(context) = sample.context else {
            return Ok(None);
        };
        let Some(route_identity) = context.route_identity else {
            return Ok(None);
        };
        Ok(Some(ModelCalibrationSample {
            binding: sample.accounting.binding,
            model_id: sample.accounting.model_id,
            input_tokens,
            original_estimate: context.context.breakdown.estimated_tokens(),
            route_identity,
            previous_checkpoint_id: context.context.previous_checkpoint_id,
        }))
    }
}
fn select(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    selection: Selection,
) -> Result<Option<Sample>, StoreError> {
    sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
    let tree = SourceTree::build_in_snapshot(
        c,
        HistoryDataSource::Live {
            history: history.clone(),
            cut: cut.clone(),
        },
    )?;
    let mut changed = false;
    let mut reset = false;
    for segment in tree.sections().iter().rev() {
        let selected = match &segment.source {
            HistoryDataSource::Live { history, cut } => {
                live(c, history, cut, segment.after_admission, selection)?
            }
            HistoryDataSource::Snapshot(snapshot) => {
                copied(c, snapshot, segment.after_admission, selection)?
            }
        };
        if let Some(mut sample) = selected {
            if sample
                .closed
                .as_ref()
                .is_some_and(|closed| closed.outcome == Outcome::Success)
            {
                let raw: serde_json::Value =
                    metadata(c, &segment.source, sample.run, &sample.provenance)?;
                if raw.get("breakdown").is_none_or(|value| value.is_null()) {
                    if matches!(selection, Selection::LatestRequest) {
                        return Ok(Some(sample));
                    }
                    return Err(invalid(
                        "metrics original request context breakdown is missing",
                    ));
                }
                let route_identity = raw
                    .get("routeIdentity")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?;
                let context: RequestContextEvidence = serde_json::from_value(raw)?;
                context.breakdown.validate().map_err(invalid)?;
                if let Some(model) = &context.model_context {
                    model.validate().map_err(invalid)?;
                }
                sample.context = Some(Provenance {
                    context,
                    route_identity,
                });
            }
            if matches!(selection, Selection::LatestSuccess) {
                let additions = changes(c, segment, Some(&sample))?;
                sample.changed = changed || additions.0;
                sample.reset = reset || additions.1;
            }
            return Ok(Some(sample));
        }
        if matches!(selection, Selection::LatestSuccess) {
            let additions = changes(c, segment, None)?;
            changed |= additions.0;
            reset |= additions.1;
        }
    }
    Ok(None)
}
fn accepted(selection: Selection, closed: &Option<Closed>) -> bool {
    matches!(selection, Selection::LatestRequest)
        || closed
            .as_ref()
            .is_some_and(|closed| closed.outcome == Outcome::Success)
}
fn live(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    floor: u64,
    selection: Selection,
) -> Result<Option<Sample>, StoreError> {
    sql::validate_cut(c, &history.namespace.owner, &history.namespace.session, cut)?;
    let owner = serde_json::to_string(&history.namespace.owner)?;
    let kind = match selection {
        Selection::LatestSuccess => "model_closed",
        Selection::LatestRequest => "model_attempt_prepared",
    };
    let mut statement = c.prepare_cached("SELECT c.admission_sequence,h.run,h.step,h.attempt,(SELECT p.fact_id FROM agent_session_history p WHERE p.owner=h.owner AND p.session=h.session AND p.sequence=c.admission_sequence AND p.run=h.run AND p.step=h.step AND p.attempt=h.attempt AND p.kind='model_attempt_prepared'),c.request,c.source,c.kind,c.owner,c.session,c.run,c.purpose,c.origin_json FROM agent_session_history h INDEXED BY agent_session_history_kind LEFT JOIN agent_usage_calls c ON c.request='model:'||h.run||':'||h.attempt WHERE h.owner=? AND h.session=? AND h.kind=? AND h.sequence<=? AND h.admission_sequence>? ORDER BY h.sequence DESC")?;
    let mut rows = statement.query(params![
        owner,
        history.namespace.session,
        kind,
        sql::bind_u64(cut.through_sequence)?,
        sql::bind_u64(floor)?
    ])?;
    while let Some(row) = rows.next()? {
        let prepared = sql::read_u64(row, 0)?;
        let run: RunId = sql::identity(row.get(1)?)?;
        let step: StepId = sql::identity(row.get(2)?)?;
        let attempt: ModelAttemptId = sql::identity(row.get(3)?)?;
        let fact: FactId = sql::identity(row.get(4)?)?;
        if row.get::<_, Option<String>>(6)?.as_deref() != Some("fact")
            || row.get::<_, Option<String>>(7)?.as_deref() != Some("model")
            || row.get::<_, Option<String>>(8)?.as_deref() != Some(owner.as_str())
            || row.get::<_, Option<String>>(9)?.as_deref()
                != Some(history.namespace.session.as_str())
            || row.get::<_, Option<String>>(10)?.as_deref() != Some(run.to_string().as_str())
        {
            return Err(invalid(
                "metrics model request has no exact original accounting source",
            ));
        }
        let origin: Origin = serde_json::from_str(&row.get::<_, String>(12)?)?;
        let Origin::Agent {
            execution,
            link,
            purpose,
        } = origin
        else {
            return Err(invalid(
                "metrics model request is not native Agent evidence",
            ));
        };
        if link != (AgentStepLink { run, step, attempt })
            || execution.run_id != run
            || execution.session_id != history.namespace.session
        {
            return Err(invalid("metrics model request identity differs"));
        }
        let indexed_purpose: ModelPurpose = serde_json::from_str(&row.get::<_, String>(11)?)?;
        if purpose != indexed_purpose {
            return Err(invalid("metrics model request purpose differs"));
        }
        if purpose != ModelPurpose::Main {
            continue;
        }
        let original = crate::sql::fact(c, run, fact)?
            .ok_or_else(|| invalid("metrics original model request disappeared"))?;
        if !matches!(original.fact,Fact::ModelAttemptPrepared{attempt:actual,step:original_step} if actual==attempt && original_step==step)
        {
            return Err(invalid(
                "metrics request index differs from its canonical fact",
            ));
        }
        let source = sql::run_source(c, &history.namespace, run)?;
        if source.execution() != execution {
            return Err(invalid("metrics original execution changed"));
        }
        let closed = live_closed(
            c,
            history,
            cut,
            run,
            step,
            attempt,
            &row.get::<_, String>(5)?,
        )?;
        if closed
            .as_ref()
            .is_some_and(|closed| closed.sequence <= prepared)
        {
            return Err(invalid("metrics closure precedes its original request"));
        }
        if !accepted(selection, &closed) {
            continue;
        }
        let step_sequence: u64 = c.query_row("SELECT sequence FROM agent_session_history INDEXED BY agent_session_history_run WHERE owner=? AND session=? AND run=? AND step=? AND kind='step_prepared' AND sequence<=? ORDER BY sequence LIMIT 1",params![owner,history.namespace.session,run.to_string(),step.to_string(),sql::bind_u64(prepared)?],|r|sql::read_u64(r,0))?;
        let item = sql::item(c, &history.namespace, cut, step_sequence)?
            .ok_or_else(|| invalid("metrics original StepPrepared is missing"))?;
        let Fact::StepPrepared {
            step: actual,
            request,
            ..
        } = item.recorded.fact
        else {
            return Err(invalid("metrics request has no canonical StepPrepared"));
        };
        if actual != step || item.recorded.run != run {
            return Err(invalid("metrics original Step belongs to another request"));
        }
        let request: RequestMetadata = metadata(
            c,
            &HistoryDataSource::Live {
                history: history.clone(),
                cut: cut.clone(),
            },
            run,
            &request,
        )?;
        if request.schema_version != SCHEMA_VERSION
            || request.step != step
            || request.accounting.purpose != ModelPurpose::Main
        {
            return Err(invalid("metrics original request schema/purpose differs"));
        }
        request.accounting.validate().map_err(invalid)?;
        let requested_at = live_time(c, history, cut, run, step, attempt)?;
        return Ok(Some(Sample {
            run,
            step,
            attempt,
            prepared: step_sequence,
            accounting: request.accounting,
            provenance: request.provenance,
            requested_at,
            closed,
            context: None,
            changed: false,
            reset: false,
        }));
    }
    Ok(None)
}
fn live_closed(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
    request: &str,
) -> Result<Option<Closed>, StoreError> {
    type ClosedModelRow = (
        u64,
        String,
        u32,
        i64,
        String,
        Option<i64>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
    );
    let row: Option<ClosedModelRow> = c.query_row("SELECT h.sequence,f.id,f.schema_version,f.at,f.run,r.completed_at,r.outcome,r.input,r.output,r.cache_read,r.cache_write,r.reasoning FROM agent_session_history h INDEXED BY agent_session_history_run LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id LEFT JOIN agent_usage_results r ON r.request=?1 AND r.sequence=h.sequence WHERE h.owner=?2 AND h.session=?3 AND h.run=?4 AND h.step=?5 AND h.kind='model_closed' AND h.attempt=?6 AND h.sequence<=?7 ORDER BY h.sequence DESC LIMIT 1",params![request,serde_json::to_string(&history.namespace.owner)?,history.namespace.session,run.to_string(),step.to_string(),attempt.to_string(),sql::bind_u64(cut.through_sequence)?],|r|Ok((sql::read_u64(r,0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?,r.get(11)?))).optional()?;
    let Some((
        sequence,
        id,
        schema,
        at,
        actual_run,
        completed,
        outcome,
        input,
        output,
        cache_read,
        cache_write,
        reasoning,
    )) = row
    else {
        return Ok(None);
    };
    let _: FactId = sql::identity(id)?;
    if schema != SCHEMA_VERSION || at < 0 || actual_run != run.to_string() || completed != Some(at)
    {
        return Err(invalid(
            "metrics closure differs from its canonical accounting source",
        ));
    }
    let outcome: Outcome = sql::identity(
        outcome.ok_or_else(|| invalid("metrics closure accounting outcome is missing"))?,
    )?;
    Ok(Some(Closed {
        sequence,
        at: UnixMillis(at),
        outcome,
        usage: ModelUsage {
            input_tokens: counter(input)?,
            output_tokens: counter(output)?,
            cache_read_tokens: counter(cache_read)?,
            cache_write_tokens: counter(cache_write)?,
            reasoning_tokens: counter(reasoning)?,
        },
    }))
}
fn live_time(
    c: &Connection,
    history: &SessionHistory,
    cut: &HistoryCut,
    run: RunId,
    step: StepId,
    attempt: ModelAttemptId,
) -> Result<Option<UnixMillis>, StoreError> {
    let row:Option<(String,u32,i64)>=c.query_row("SELECT f.id,f.schema_version,f.at FROM agent_session_history h INDEXED BY agent_session_history_run LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.id=h.fact_id AND f.run=h.run WHERE h.owner=? AND h.session=? AND h.run=? AND h.step=? AND h.kind='model_attempt_admitted' AND h.attempt=? AND h.sequence<=? ORDER BY h.sequence LIMIT 1",params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,run.to_string(),step.to_string(),attempt.to_string(),sql::bind_u64(cut.through_sequence)?],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    row.map(|(id, schema, at)| {
        let _: FactId = sql::identity(id)?;
        if schema != SCHEMA_VERSION || at < 0 {
            return Err(invalid("metrics original model admission metadata differs"));
        }
        Ok(UnixMillis(at))
    })
    .transpose()
}
fn counter(value: Option<i64>) -> Result<Option<u64>, StoreError> {
    value
        .map(|value| {
            u64::try_from(value).map_err(|_| invalid("negative original model usage counter"))
        })
        .transpose()
}
fn snapshot_bound(c: &Connection, snapshot: &Snapshot) -> Result<u64, StoreError> {
    metrics_metadata::require_ready(c, snapshot)?;
    let manifest = snapshot.manifest_in_snapshot(c)?;
    match manifest.origin { SnapshotOrigin::Canonical{cut}=>Ok(cut.through_sequence), SnapshotOrigin::Imported{..}=>c.query_row("SELECT coalesce(max(sequence),0) FROM agent_history_snapshot_entries WHERE snapshot=?",[snapshot.id().to_string()],|r|sql::read_u64(r,0)).map_err(Into::into) }
}
struct CopiedFact {
    run: RunId,
    sequence: u64,
    admission: u64,
    step: Option<StepId>,
    attempt: Option<ModelAttemptId>,
}
fn copied_fact(
    c: &Connection,
    snapshot: &Snapshot,
    raw: &str,
    bound: u64,
) -> Result<CopiedFact, StoreError> {
    let Entry::Fact {
        run,
        sequence,
        admission_sequence,
        revision,
        step,
        attempt,
        id,
        body,
        ..
    } = serde_json::from_str(raw)?
    else {
        return Err(invalid("metrics snapshot source is not an original fact"));
    };
    if sequence == 0
        || sequence > bound
        || revision == 0
        || admission_sequence == 0
        || admission_sequence > sequence
    {
        return Err(invalid(
            "metrics snapshot fact is outside its actual source cut",
        ));
    }
    let pinned:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM agent_history_snapshot_entries e JOIN agent_history_snapshot_run_refs r ON r.snapshot=e.snapshot AND r.run=e.run JOIN agent_history_snapshot_pins p ON p.snapshot=r.snapshot AND p.content_id=r.content_id JOIN contents b ON b.id=p.content_id WHERE e.snapshot=? AND e.kind='fact' AND e.run=? AND e.sequence=? AND json_extract(e.entry_json,'$.id')=? AND b.content_sha256=? AND length(b.payload)=?)",params![snapshot.id().to_string(),run.to_string(),sql::bind_u64(sequence)?,id.to_string(),body.digest,sql::bind_u64(body.bytes)?],|r|r.get(0))?;
    if !pinned {
        return Err(invalid(
            "metrics snapshot fact lost its original PK/pinned body proof",
        ));
    }
    Ok(CopiedFact {
        run,
        sequence,
        admission: admission_sequence,
        step,
        attempt,
    })
}
fn copied(
    c: &Connection,
    snapshot: &Snapshot,
    floor: u64,
    selection: Selection,
) -> Result<Option<Sample>, StoreError> {
    let bound = snapshot_bound(c, snapshot)?;
    let query = match selection {
        Selection::LatestRequest => {
            "SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_prepared WHERE snapshot=? AND kind='fact' AND fact_kind='model_attempt_prepared' AND sequence<=? AND json_extract(entry_json,'$.admission_sequence')>? ORDER BY sequence DESC"
        }
        Selection::LatestSuccess => {
            "SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_fact WHERE snapshot=? AND kind='fact' AND fact_kind='model_closed' AND sequence<=? AND json_extract(entry_json,'$.admission_sequence')>? ORDER BY sequence DESC"
        }
    };
    let mut statement = c.prepare_cached(query)?;
    let mut rows = statement.query(params![
        snapshot.id().to_string(),
        sql::bind_u64(bound)?,
        sql::bind_u64(floor)?
    ])?;
    while let Some(row) = rows.next()? {
        let observed = copied_fact(c, snapshot, &row.get::<_, String>(0)?, bound)?;
        let original = if matches!(selection, Selection::LatestSuccess) {
            let metadata: ModelMetadata = serde_json::from_str(
                &row.get::<_, Option<String>>(1)?
                    .ok_or_else(|| invalid("metrics copied closure metadata is missing"))?,
            )?;
            let ModelMetadata::Closed { outcome, at, .. } = metadata else {
                return Err(invalid("metrics copied closure metadata has another kind"));
            };
            if at.0 < 0 {
                return Err(invalid("negative original model closure time"));
            }
            if outcome != Outcome::Success {
                continue;
            }
            let raw: String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind='model_attempt_prepared' AND sequence<=? ORDER BY sequence LIMIT 1",params![snapshot.id().to_string(),observed.run.to_string(),observed.attempt.map(|id|id.to_string()),sql::bind_u64(observed.sequence)?],|r|r.get(0))?;
            let prepared = copied_fact(c, snapshot, &raw, bound)?;
            if prepared.run != observed.run
                || prepared.step != observed.step
                || prepared.attempt != observed.attempt
                || prepared.admission != observed.admission
            {
                return Err(invalid(
                    "metrics copied closure has another original request",
                ));
            }
            prepared
        } else {
            observed
        };
        let step = original
            .step
            .ok_or_else(|| invalid("metrics copied model request has no original Step"))?;
        let attempt = original
            .attempt
            .ok_or_else(|| invalid("metrics copied model request has no original attempt"))?;
        let (raw,model):(String,Option<String>)=c.query_row("SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=? AND fact_kind='step_prepared' AND sequence<=? ORDER BY sequence LIMIT 1",params![snapshot.id().to_string(),original.run.to_string(),step.to_string(),sql::bind_u64(original.sequence)?],|r|Ok((r.get(0)?,r.get(1)?)))?;
        let prepared = copied_fact(c, snapshot, &raw, bound)?;
        if prepared.run != original.run
            || prepared.step != Some(step)
            || prepared.admission != original.admission
        {
            return Err(invalid(
                "metrics copied request preparation membership differs",
            ));
        }
        let ModelMetadata::Prepared {
            accounting,
            provenance,
        } = serde_json::from_str(
            &model.ok_or_else(|| invalid("metrics copied request metadata is not complete"))?,
        )?
        else {
            return Err(invalid("metrics copied request metadata has another kind"));
        };
        accounting.validate().map_err(invalid)?;
        if accounting.purpose != ModelPurpose::Main {
            continue;
        }
        let closed = copied_closed(c, snapshot, bound, &original, "model_closed")?;
        let closed = closed
            .map(|(key, model)| match model {
                ModelMetadata::Closed { outcome, at, usage } if at.0 >= 0 => Ok(Closed {
                    sequence: key.sequence,
                    at,
                    outcome,
                    usage,
                }),
                _ => Err(invalid("metrics copied closure metadata has another kind")),
            })
            .transpose()?;
        if !accepted(selection, &closed) {
            continue;
        }
        let requested_at = copied_closed(c, snapshot, bound, &original, "model_attempt_admitted")?
            .map(|(_, model)| match model {
                ModelMetadata::Admitted { at } if at.0 >= 0 => Ok(at),
                _ => Err(invalid(
                    "metrics copied admission metadata has another kind",
                )),
            })
            .transpose()?;
        let source = snapshot.run_in_snapshot(c, original.run)?;
        if source.admission_sequence != original.admission {
            return Err(invalid(
                "metrics copied model request has another original Run",
            ));
        }
        return Ok(Some(Sample {
            run: original.run,
            step,
            attempt,
            prepared: prepared.sequence,
            accounting,
            provenance,
            requested_at,
            closed,
            context: None,
            changed: false,
            reset: false,
        }));
    }
    Ok(None)
}
fn copied_closed(
    c: &Connection,
    snapshot: &Snapshot,
    bound: u64,
    original: &CopiedFact,
    kind: &str,
) -> Result<Option<(CopiedFact, ModelMetadata)>, StoreError> {
    let row:Option<(String,Option<String>)>=c.query_row("SELECT entry_json,model_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind=? AND sequence<=? ORDER BY sequence DESC LIMIT 1",params![snapshot.id().to_string(),original.run.to_string(),original.attempt.map(|id|id.to_string()),kind,sql::bind_u64(bound)?],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    row.map(|(raw, metadata)| {
        let key = copied_fact(c, snapshot, &raw, bound)?;
        if key.run != original.run
            || key.step != original.step
            || key.attempt != original.attempt
            || key.admission != original.admission
            || key.sequence < original.sequence
        {
            return Err(invalid(
                "metrics copied model event differs from its original attempt",
            ));
        }
        Ok((
            key,
            serde_json::from_str(
                &metadata
                    .ok_or_else(|| invalid("metrics copied model event metadata is missing"))?,
            )?,
        ))
    })
    .transpose()
}
fn metadata<T: DeserializeOwned>(
    c: &Connection,
    source: &HistoryDataSource,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    match source {
        HistoryDataSource::Live { history, cut } => {
            sql::with_content(c, &history.namespace, cut, run, reference, |blob| {
                let mut bytes = Vec::new();
                blob.read_to_end(&mut bytes)?;
                if maka_agent_facts::artifact::content_digest(&bytes) != reference.digest {
                    return Err(invalid("metrics original metadata content hash differs"));
                }
                Ok(serde_json::from_slice(&bytes)?)
            })
        }
        HistoryDataSource::Snapshot(snapshot) => snapshot.metadata_in_snapshot(c, run, reference),
    }
}
fn changes(
    c: &Connection,
    segment: &Segment,
    sample: Option<&Sample>,
) -> Result<(bool, bool), StoreError> {
    let after = sample.map_or(0, |sample| sample.prepared);
    let run = sample.map(|sample| sample.run.to_string());
    let step = sample.map(|sample| sample.step.to_string());
    let attempt = sample.map(|sample| sample.attempt.to_string());
    let (changed,reset):(bool,bool)=match &segment.source {
        HistoryDataSource::Live{history,cut}=>c.query_row("SELECT coalesce(max(CASE WHEN h.kind='context_compacted' OR (h.kind='run_admitted' AND h.run IS NOT ?6) OR (h.kind='step_prepared' AND h.step IS NOT ?7) OR (h.kind IN ('model_attempt_prepared','model_attempt_admitted','model_observed') AND h.attempt IS NOT ?8) OR h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded','external_task_observed','external_effect','cell','tools_loaded') THEN 1 ELSE 0 END),0),coalesce(max(h.kind='context_compacted'),0) FROM agent_session_history h WHERE h.owner=?1 AND h.session=?2 AND h.sequence>?3 AND h.sequence<=?4 AND h.admission_sequence>?5",params![serde_json::to_string(&history.namespace.owner)?,history.namespace.session,sql::bind_u64(after)?,sql::bind_u64(cut.through_sequence)?,sql::bind_u64(segment.after_admission)?,run,step,attempt],|r|Ok((r.get(0)?,r.get(1)?)))?,
        HistoryDataSource::Snapshot(snapshot)=>{
            let bound=snapshot_bound(c,snapshot)?;
            c.query_row("SELECT coalesce(max(CASE WHEN fact_kind='context_compacted' OR (fact_kind='run_admitted' AND run IS NOT ?5) OR (fact_kind='step_prepared' AND json_extract(entry_json,'$.step') IS NOT ?6) OR (fact_kind IN ('model_attempt_prepared','model_attempt_admitted','model_observed') AND json_extract(entry_json,'$.attempt') IS NOT ?7) OR fact_kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded','external_task_observed','external_effect','cell','tools_loaded') THEN 1 ELSE 0 END),0),coalesce(max(fact_kind='context_compacted'),0) FROM agent_history_snapshot_entries WHERE snapshot=?1 AND kind='fact' AND sequence>?2 AND sequence<=?3 AND json_extract(entry_json,'$.admission_sequence')>?4",params![snapshot.id().to_string(),sql::bind_u64(after)?,sql::bind_u64(bound)?,sql::bind_u64(segment.after_admission)?,run,step,attempt],|r|Ok((r.get(0)?,r.get(1)?)))?
        }
    };
    Ok((changed, reset))
}
