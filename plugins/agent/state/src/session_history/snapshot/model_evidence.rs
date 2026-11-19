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
use maka_agent_facts::{
    context::ModelPurpose,
    model::{assembly::AttemptBinding, recorded::PrivateModelPartial},
};

pub(super) fn validate(
    c: &Connection,
    snapshot: SnapshotId,
    entry: &Entry,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    if matches!(&record.fact, Fact::ModelSourceFailureCaptured { .. }) {
        return source_failure(c, snapshot, entry, record);
    }
    let Fact::ModelPrivatePartialCaptured { attempt, partial } = &record.fact else {
        return Ok(());
    };
    let Entry::Fact {
        run,
        sequence,
        step,
        ..
    } = entry
    else {
        return Err(invalid(
            "private partial snapshot entry is not its original fact",
        ));
    };
    let step = step.ok_or_else(|| invalid("private partial snapshot lost its original Step"))?;
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND run=?",params![snapshot.to_string(),run.to_string()],|r|r.get(0))?;
    let Entry::Run {
        run: original,
        spec,
        ..
    } = serde_json::from_str(&raw)?
    else {
        return Err(invalid(
            "private partial snapshot Run source has another entry kind",
        ));
    };
    if original != *run {
        return Err(invalid("private partial snapshot Run membership differs"));
    }
    let spec: RunSpec = metrics_metadata::original(c, snapshot, *run, &spec)?;
    if spec.schema_version != SCHEMA_VERSION {
        return Err(invalid("private partial snapshot Run schema differs"));
    }
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind='model_attempt_prepared' AND sequence<? ORDER BY sequence LIMIT 1",params![snapshot.to_string(),run.to_string(),attempt.to_string(),bind_u64(*sequence)?],|r|r.get(0))?;
    let (_, prepared) = original_fact(c, snapshot, *run, &raw)?;
    if !matches!(prepared.fact,Fact::ModelAttemptPrepared{attempt:actual,step:actual_step} if actual==*attempt && actual_step==step)
    {
        return Err(invalid(
            "private partial snapshot lost its original prepared attempt/Step",
        ));
    }
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=? AND fact_kind='step_prepared' AND sequence<? ORDER BY sequence LIMIT 1",params![snapshot.to_string(),run.to_string(),step.to_string(),bind_u64(*sequence)?],|r|r.get(0))?;
    let (_, prepared) = original_fact(c, snapshot, *run, &raw)?;
    let Fact::StepPrepared {
        step: actual,
        request,
        ..
    } = prepared.fact
    else {
        return Err(invalid(
            "private partial snapshot lacks its original request preparation",
        ));
    };
    if actual != step {
        return Err(invalid(
            "private partial snapshot request belongs to another Step",
        ));
    }
    let request: RequestSpec = metrics_metadata::original(c, snapshot, *run, &request)?;
    if request.schema_version != SCHEMA_VERSION
        || request.step != step
        || request.accounting.purpose != ModelPurpose::Main
    {
        return Err(invalid(
            "private partial snapshot source is not its original Main request",
        ));
    }
    request.accounting.validate().map_err(invalid)?;
    let value: PrivateModelPartial = metrics_metadata::original(c, snapshot, *run, partial)?;
    if value.depends_on > 0 {
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_fact WHERE snapshot=? AND kind='fact' AND sequence=?",params![snapshot.to_string(),bind_u64(value.depends_on)?],|r|r.get(0))?;
        let Entry::Fact {
            run: watermark_run, ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid(
                "private partial snapshot watermark is not canonical",
            ));
        };
        original_fact(c, snapshot, watermark_run, &raw)?;
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND run=?",params![snapshot.to_string(),watermark_run.to_string()],|r|r.get(0))?;
        let Entry::Run {
            spec: watermark_spec,
            ..
        } = serde_json::from_str(&raw)?
        else {
            return Err(invalid(
                "private partial snapshot watermark lost its original Run namespace",
            ));
        };
        let watermark_spec: RunSpec =
            metrics_metadata::original(c, snapshot, watermark_run, &watermark_spec)?;
        if watermark_spec.schema_version != SCHEMA_VERSION
            || watermark_spec.owner != spec.owner
            || watermark_spec.session_id != spec.session_id
        {
            return Err(invalid(
                "private partial snapshot watermark belongs to another original namespace/schema",
            ));
        }
    }
    let expected = AttemptBinding {
        execution: ExecutionIdentity {
            session_id: spec.session_id,
            turn_id: spec.turn_id,
            run_id: *run,
        },
        step_id: step,
        attempt_id: *attempt,
        purpose: ModelPurpose::Main,
    };
    crate::sql::validate_private_partial_envelope(&value, &expected, *sequence, |reference| {
        let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_fact_identity WHERE snapshot=? AND kind='fact' AND json_extract(entry_json,'$.id')=?",params![snapshot.to_string(),reference.event_id],|r|r.get(0))?;
        original_fact(c, snapshot, *run, &raw)
    })?;
    let mut statement=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind='model_private_partial_captured' AND sequence<? ORDER BY sequence")?;
    let mut rows = statement.query(params![
        snapshot.to_string(),
        run.to_string(),
        attempt.to_string(),
        bind_u64(*sequence)?
    ])?;
    while let Some(row) = rows.next()? {
        let (_, other) = original_fact(c, snapshot, *run, &row.get::<_, String>(0)?)?;
        if !matches!(other.fact,Fact::ModelPrivatePartialCaptured{attempt:other,partial:ref prior} if other==*attempt && prior==partial)
        {
            return Err(StoreError::EventConflict);
        }
    }
    Ok(())
}
fn original_fact(
    c: &Connection,
    snapshot: SnapshotId,
    run: RunId,
    raw: &str,
) -> Result<(u64, RecordedFact), StoreError> {
    let Entry::Fact {
        run: actual,
        sequence,
        id,
        revision,
        body,
        ..
    } = serde_json::from_str(raw)?
    else {
        return Err(invalid(
            "private partial snapshot receipt is not an original fact entry",
        ));
    };
    if actual != run {
        return Err(invalid(
            "private partial snapshot receipt belongs to another original Run",
        ));
    }
    let record: RecordedFact = metrics_metadata::original(c, snapshot, run, &body)?;
    if record.schema_version != SCHEMA_VERSION
        || record.run != run
        || record.id != id
        || record.revision != revision
    {
        return Err(invalid(
            "private partial snapshot receipt differs from its original schema/PK",
        ));
    }
    Ok((sequence, record))
}

fn source_failure(
    c: &Connection,
    snapshot: SnapshotId,
    entry: &Entry,
    record: &RecordedFact,
) -> Result<(), StoreError> {
    use maka_agent_facts::{
        composition::SourceKind, context::ModelFailureProtocol, model::error::ModelError,
    };
    let Fact::ModelSourceFailureCaptured { attempt, failure } = &record.fact else {
        return Ok(());
    };
    let Entry::Fact {
        run,
        sequence,
        step,
        ..
    } = entry
    else {
        return Err(invalid(
            "model source failure has no original snapshot fact entry",
        ));
    };
    let step = step.ok_or_else(|| invalid("model source failure snapshot lost its actual Step"))?;
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND run=?",params![snapshot.to_string(),run.to_string()],|r|r.get(0))?;
    let Entry::Run {
        run: original,
        spec,
        ..
    } = serde_json::from_str(&raw)?
    else {
        return Err(invalid(
            "source failure snapshot lost its original Run source",
        ));
    };
    if original != *run {
        return Err(invalid("source failure snapshot Run membership differs"));
    }
    let spec: RunSpec = metrics_metadata::original(c, snapshot, *run, &spec)?;
    if spec.schema_version != SCHEMA_VERSION {
        return Err(invalid(
            "source failure snapshot original Run schema differs",
        ));
    }
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind='model_attempt_admitted' AND sequence<? ORDER BY sequence LIMIT 1",params![snapshot.to_string(),run.to_string(),attempt.to_string(),bind_u64(*sequence)?],|r|r.get(0))?;
    let (_, admitted) = original_fact(c, snapshot, *run, &raw)?;
    if !matches!(admitted.fact,Fact::ModelAttemptAdmitted{attempt:actual,..} if actual==*attempt) {
        return Err(invalid(
            "source failure snapshot has no original model source admission",
        ));
    }
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind IN ('model_attempt_prepared','proactive_summary_prepared') AND sequence<? ORDER BY sequence LIMIT 1",params![snapshot.to_string(),run.to_string(),attempt.to_string(),bind_u64(*sequence)?],|r|r.get(0))?;
    let (_, prepared) = original_fact(c, snapshot, *run, &raw)?;
    if !matches!(prepared.fact,Fact::ModelAttemptPrepared{attempt:actual,step:actual_step} | Fact::ProactiveSummaryPrepared{attempt:actual,step:actual_step,..} if actual==*attempt && actual_step==step)
    {
        return Err(invalid(
            "source failure snapshot has another original prepared attempt/Step",
        ));
    }
    let raw:String=c.query_row("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_step WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.step')=? AND fact_kind IN ('step_prepared','proactive_summary_prepared') AND sequence<? ORDER BY sequence LIMIT 1",params![snapshot.to_string(),run.to_string(),step.to_string(),bind_u64(*sequence)?],|r|r.get(0))?;
    let (_, prepared) = original_fact(c, snapshot, *run, &raw)?;
    let (Fact::StepPrepared {
        step: actual,
        request,
        ..
    }
    | Fact::ProactiveSummaryPrepared {
        step: actual,
        request,
        ..
    }) = prepared.fact
    else {
        return Err(invalid("source failure snapshot lost its original request"));
    };
    if actual != step {
        return Err(invalid("source failure snapshot original Step differs"));
    }
    let request: RequestSpec = metrics_metadata::original(c, snapshot, *run, &request)?;
    if request.schema_version != SCHEMA_VERSION || request.step != step {
        return Err(invalid(
            "source failure snapshot original request schema differs",
        ));
    }
    request.accounting.validate().map_err(invalid)?;
    let value: ModelFailureProtocol = metrics_metadata::original(c, snapshot, *run, failure)?;
    if matches!(
        &value.failure,
        ModelError::Cancelled | ModelError::CleanupUnconfirmed | ModelError::LocalAuthorization(_)
    ) {
        return Err(invalid(
            "local cancellation/cleanup cannot replace actual snapshot source failure",
        ));
    }
    if let Some(transport) = &value.transport {
        if request.accounting.purpose != ModelPurpose::Main
            || transport.route_identity.is_empty()
            || transport.adapter.kind != SourceKind::ModelAdapter
            || !request
                .composition
                .sources
                .iter()
                .any(|source| source == &transport.adapter)
        {
            return Err(invalid(
                "source failure snapshot transport belongs to another original adapter/lane",
            ));
        }
        let provenance: serde_json::Value =
            metrics_metadata::original(c, snapshot, *run, &request.provenance)?;
        if provenance
            .get("routeIdentity")
            .and_then(|value| value.as_str())
            != Some(transport.route_identity.as_str())
        {
            return Err(invalid(
                "source failure snapshot transport differs from its original route",
            ));
        }
    }
    metrics_metadata::verify_original(c, snapshot, *run, &request.recovery_contract)?;
    let mut statement=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries INDEXED BY agent_history_snapshot_metrics_attempt WHERE snapshot=? AND kind='fact' AND run=? AND json_extract(entry_json,'$.attempt')=? AND fact_kind IN ('model_source_failure_captured','model_closed') ORDER BY fact_kind,sequence")?;
    let mut rows = statement.query(params![
        snapshot.to_string(),
        run.to_string(),
        attempt.to_string()
    ])?;
    while let Some(row) = rows.next()? {
        let (_, other) = original_fact(c, snapshot, *run, &row.get::<_, String>(0)?)?;
        match other.fact {
            Fact::ModelSourceFailureCaptured {
                attempt: other,
                failure: ref prior,
            } if other == *attempt && prior == failure => {}
            Fact::ModelClosed {
                attempt: other,
                outcome,
                protocol,
                ..
            } if other == *attempt => {
                if outcome == maka_agent_facts::accounting::Outcome::Error
                    || protocol
                        .get("failure")
                        .is_some_and(|value| !value.is_null())
                {
                    return Err(StoreError::EventConflict);
                }
            }
            _ => return Err(StoreError::EventConflict),
        }
    }
    Ok(())
}
