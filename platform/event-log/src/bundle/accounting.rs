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

use super::format::Record;
use crate::StoreError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::model::ModelUsage;
use maka_agent_facts::model::recorded::ModelObservation;
use rusqlite::{Connection, OptionalExtension, params};

/// The first provider usage fact fixes a request's valuation, if it was quoted.
pub(super) fn witness(db: &Connection, request: &str) -> Result<Option<u64>, StoreError> {
    let row: Option<i64> = db.prepare_cached("SELECT MIN(e.sequence) FROM runtime_events r JOIN runtime_events e ON e.invocation_id=r.invocation_id
         AND json_extract(e.event_header,'$.fact.step_id')=json_extract(r.event_header,'$.fact.step_id')
         WHERE r.event_id=? AND (e.kind='model_completed' OR
          (e.kind='model_observed' AND json_extract(e.event_header,'$.fact.event.kind')='finished'))")?.query_row(params![request], |row| row.get(0))?;
    row.map(crate::sequence_number).transpose()
}

pub(super) fn validate(staged: &Connection, original: &Connection) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = staged.prepare_cached("SELECT number,record_json FROM frames WHERE kind='accounting' AND number>? ORDER BY number LIMIT 1")?.query_row(params![after], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let Some((number, json)) = row else { break };
        let Record::Accounting {
            event_id,
            quote,
            valuation,
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        let request: Option<String> = original.prepare_cached("SELECT event_header FROM runtime_events WHERE event_id=? AND kind='model_requested'")?.query_row(params![&event_id], |row| row.get(0)).optional()?;
        let event: RuntimeEvent =
            serde_json::from_str(&request.ok_or_else(|| invalid("unbound bundle model quote"))?)?;
        let Fact::ModelRequested {
            model_id, step_id, ..
        } = &event.fact
        else {
            unreachable!()
        };
        quote.validate(model_id).map_err(invalid)?;
        crate::usage::valuation::capture(original, &event_id, &quote)?;
        let mut observed: Option<ModelUsage> = None;
        let mut sequence = 0i64;
        loop {
            let row: Option<(i64, String)> = original.prepare_cached("SELECT sequence,event_header FROM runtime_events WHERE invocation_id=?1 AND sequence>?2
                 AND json_extract(event_header,'$.fact.step_id')=?3 AND (kind='model_completed' OR
                  (kind='model_observed' AND json_extract(event_header,'$.fact.event.kind')='finished'))
                 ORDER BY sequence LIMIT 1")?.query_row(params![&event.invocation.invocation_id, sequence, step_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let Some((next, json)) = row else { break };
            let usage_event: RuntimeEvent = serde_json::from_str(&json)?;
            let usage = match usage_event.fact {
                Fact::ModelCompleted { output, .. } => output.usage,
                Fact::ModelObserved {
                    event: ModelObservation::Finished { usage, .. },
                    ..
                } => usage,
                _ => unreachable!(),
            };
            if observed.as_ref().is_some_and(|prior| prior != &usage) {
                return Err(invalid("bundle request has contradictory usage evidence"));
            }
            observed = Some(usage);
            sequence = next;
        }
        match (observed, valuation) {
            (None, None) => {}
            (Some(usage), Some(valuation))
                if usage == valuation.usage
                    && quote.estimate(&usage).map_err(invalid)? == valuation.usd =>
            {
                crate::usage::valuation::value(original, &event_id, &usage)?;
            }
            _ => {
                return Err(invalid(
                    "bundle valuation differs from its selected usage evidence",
                ));
            }
        }
        after = number;
    }
    Ok(())
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
