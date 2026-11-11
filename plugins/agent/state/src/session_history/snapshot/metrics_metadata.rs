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
    accounting::{ModelEvidence, Outcome},
    model::ModelUsage,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::session_history) enum ModelMetadata {
    Prepared {
        accounting: ModelEvidence,
        provenance: ContentRef,
    },
    Admitted {
        at: UnixMillis,
    },
    FirstToken {
        at: UnixMillis,
    },
    Closed {
        outcome: Outcome,
        at: UnixMillis,
        usage: ModelUsage,
    },
}

pub(in crate::session_history) fn require_ready(
    c: &Connection,
    snapshot: &Snapshot,
) -> Result<(), StoreError> {
    navigation::require_ready(c, snapshot).map(|_| ())
}

pub(super) fn original<T: serde::de::DeserializeOwned>(
    c: &Connection,
    snapshot: SnapshotId,
    run: RunId,
    reference: &ContentRef,
) -> Result<T, StoreError> {
    let id = read::pinned_registered(c, snapshot, reference, Some(run))?;
    super::super::sql::decode_original(c, id, reference)
}

pub(super) fn verify_original(
    c: &Connection,
    snapshot: SnapshotId,
    run: RunId,
    reference: &ContentRef,
) -> Result<(), StoreError> {
    let id = read::pinned_registered(c, snapshot, reference, Some(run))?;
    super::super::sql::read_blob(c, id, reference, |blob| {
        std::io::copy(blob, &mut std::io::sink())?;
        Ok(())
    })
}

pub(super) enum IndexPhase {
    Inventory,
    Complete,
}

pub(super) fn classify(
    c: &Connection,
    snapshot: SnapshotId,
    entry: &Entry,
    phase: IndexPhase,
) -> Result<(Option<String>, Option<ModelMetadata>), StoreError> {
    let Entry::Fact {
        run,
        id,
        revision,
        step,
        attempt,
        body,
        ..
    } = entry
    else {
        return Ok((None, None));
    };
    let record: RecordedFact = original(c, snapshot, *run, body)?;
    if record.schema_version != SCHEMA_VERSION
        || record.id != *id
        || record.run != *run
        || record.revision != *revision
    {
        return Err(invalid(
            "snapshot metrics fact differs from its original identity/schema",
        ));
    }
    if matches!(phase, IndexPhase::Complete)
        && matches!(
            &record.fact,
            Fact::ModelPrivatePartialCaptured { .. } | Fact::ModelSourceFailureCaptured { .. }
        )
    {
        super::model_evidence::validate(c, snapshot, entry, &record)?;
    }
    let metadata = match &record.fact {
        // The immutable inventory writes Facts before Payload pins. Only its
        // completed producer may open the request referenced by StepPrepared.
        Fact::StepPrepared { .. } if matches!(phase, IndexPhase::Inventory) => None,
        Fact::StepPrepared {
            step: actual,
            request,
            ..
        } => {
            if *step != Some(*actual) {
                return Err(invalid("snapshot metrics original Step differs"));
            }
            let request: RequestSpec = original(c, snapshot, *run, request)?;
            if request.schema_version != SCHEMA_VERSION || request.step != *actual {
                return Err(invalid(
                    "snapshot metrics original request schema/Step differs",
                ));
            }
            request.accounting.validate().map_err(invalid)?;
            Some(ModelMetadata::Prepared {
                accounting: request.accounting,
                provenance: request.provenance,
            })
        }
        Fact::ModelAttemptAdmitted {
            attempt: actual, ..
        } => {
            if *attempt != Some(*actual) {
                return Err(invalid(
                    "snapshot metrics original admitted attempt differs",
                ));
            }
            Some(ModelMetadata::Admitted { at: record.at })
        }
        Fact::ModelFirstTokenObserved { attempt: actual } => {
            if *attempt != Some(*actual) {
                return Err(invalid("snapshot metrics first token attempt differs"));
            }
            Some(ModelMetadata::FirstToken { at: record.at })
        }
        Fact::ModelClosed {
            attempt: actual,
            outcome,
            usage,
            ..
        } => {
            if *attempt != Some(*actual) {
                return Err(invalid("snapshot metrics original closed attempt differs"));
            }
            Some(ModelMetadata::Closed {
                outcome: *outcome,
                at: record.at,
                usage: usage.clone(),
            })
        }
        _ => None,
    };
    // The typed original above already validated this wire variant. Retain its
    // stored tag without serializing large model parts or private protocol data.
    let kind: String = c.query_row("SELECT json_extract(CAST(payload AS TEXT),'$.fact.kind') FROM contents WHERE content_sha256=? AND length(payload)=?", params![body.digest, bind_u64(body.bytes)?], |row| row.get(0))?;
    Ok((Some(kind), metadata))
}

impl Snapshot {
    pub(super) async fn ensure_metrics_metadata(
        &self,
        stop: CancellationToken,
    ) -> Result<(), StoreError> {
        let mut after = None;
        loop {
            navigation::check(&stop)?;
            let next = self
                .data
                .write(Backfill {
                    snapshot: self.clone(),
                    after,
                    stop: stop.clone(),
                })
                .await?;
            let Some(next) = next else {
                return Ok(());
            };
            after = Some(next);
        }
    }
}
struct Backfill {
    snapshot: Snapshot,
    after: Option<u64>,
    stop: CancellationToken,
}
pub(super) fn validate_complete(c: &Connection, snapshot: SnapshotId) -> Result<(), StoreError> {
    let mut facts=c.prepare_cached("SELECT entry_json FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND fact_kind IN('step_prepared','model_private_partial_captured','model_source_failure_captured') ORDER BY ordinal")?;
    let mut rows = facts.query([snapshot.to_string()])?;
    while let Some(row) = rows.next()? {
        let entry: Entry = serde_json::from_str(&row.get::<_, String>(0)?)?;
        classify(c, snapshot, &entry, IndexPhase::Complete)?;
    }
    let mut nested=c.prepare_cached("SELECT run FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='run' AND historical=1 ORDER BY ordinal")?;
    let mut rows = nested.query([snapshot.to_string()])?;
    while let Some(row) = rows.next()? {
        let run = super::super::sql::identity(row.get(0)?)?;
        read::nested_registered(c, snapshot, snapshot, run)?;
    }
    Ok(())
}
impl Statement for Backfill {
    type Value = Option<u64>;
    type Output = Option<u64>;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        read::Header(self.snapshot.clone()).execute(c)?;
        let after = self.after.map(bind_u64).transpose()?;
        let rows: Vec<(u64, String, String, u64)> = c.prepare_cached("SELECT ordinal,entry_json,run,sequence FROM agent_history_snapshot_entries WHERE snapshot=? AND kind='fact' AND (fact_kind IS NULL OR (fact_kind='step_prepared' AND model_json IS NULL) OR fact_kind IN ('model_private_partial_captured','model_source_failure_captured')) AND (? IS NULL OR ordinal>?) ORDER BY ordinal LIMIT 128")?
            .query_map(params![self.snapshot.id.to_string(), after, after], |row| Ok((read_u64(row,0)?, row.get(1)?, row.get(2)?, read_u64(row,3)?)))?
            .collect::<Result<_,_>>()?;
        for (ordinal, raw, run, sequence) in &rows {
            navigation::check(&self.stop)?;
            let entry: Entry = serde_json::from_str(raw)?;
            if !matches!(&entry, Entry::Fact {run: actual, sequence: actual_sequence, ..} if actual.to_string()==*run && actual_sequence==sequence)
            {
                return Err(invalid(
                    "snapshot metrics inventory PK differs from its original fact",
                ));
            }
            let (kind, metadata) = classify(c, self.snapshot.id, &entry, IndexPhase::Complete)?;
            c.execute("UPDATE agent_history_snapshot_entries SET fact_kind=?,model_json=? WHERE snapshot=? AND ordinal=?", params![kind, metadata.as_ref().map(serde_json::to_string).transpose()?, self.snapshot.id.to_string(), bind_u64(*ordinal)?])?;
        }
        navigation::check(&self.stop)?;
        Ok(Prepared {
            value: if rows.len() == 128 {
                rows.last().map(|row| row.0)
            } else {
                None
            },
            changed: !rows.is_empty(),
            notification: Notification::NONE,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}
