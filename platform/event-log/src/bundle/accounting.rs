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
use sqlx::SqliteConnection;

/// The first provider usage fact fixes a request's valuation, if it was quoted.
pub(super) async fn witness(
    db: &mut SqliteConnection,
    request: &str,
) -> Result<Option<u64>, StoreError> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(e.sequence) FROM runtime_events r JOIN runtime_events e ON e.invocation_id=r.invocation_id
         AND json_extract(e.event_json,'$.fact.step_id')=json_extract(r.event_json,'$.fact.step_id')
         WHERE r.event_id=? AND (e.kind='model_completed' OR
          (e.kind='model_observed' AND json_extract(e.event_json,'$.fact.event.kind')='finished'))"
    ).bind(request).fetch_one(db).await?;
    row.map(crate::sequence_number).transpose()
}

pub(super) async fn validate(
    staged: &mut SqliteConnection,
    original: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE kind='accounting' AND number>? ORDER BY number LIMIT 1"
        ).bind(after).fetch_optional(&mut *staged).await?;
        let Some((number, json)) = row else { break };
        let Record::Accounting {
            event_id,
            quote,
            valuation,
        } = serde_json::from_str(&json)?
        else {
            unreachable!()
        };
        let request: Option<String> = sqlx::query_scalar(
            "SELECT event_json FROM runtime_events WHERE event_id=? AND kind='model_requested'",
        )
        .bind(&event_id)
        .fetch_optional(&mut *original)
        .await?;
        let event: RuntimeEvent =
            serde_json::from_str(&request.ok_or_else(|| invalid("unbound bundle model quote"))?)?;
        let Fact::ModelRequested {
            model_id, step_id, ..
        } = &event.fact
        else {
            unreachable!()
        };
        quote.validate(model_id).map_err(invalid)?;
        crate::usage::valuation::capture(original, &event_id, &quote).await?;
        let mut observed: Option<ModelUsage> = None;
        let mut sequence = 0i64;
        loop {
            let row: Option<(i64, String)> = sqlx::query_as(
                "SELECT sequence,event_json FROM runtime_events WHERE invocation_id=?1 AND sequence>?2
                 AND json_extract(event_json,'$.fact.step_id')=?3 AND (kind='model_completed' OR
                  (kind='model_observed' AND json_extract(event_json,'$.fact.event.kind')='finished'))
                 ORDER BY sequence LIMIT 1"
            ).bind(&event.invocation.invocation_id).bind(sequence).bind(step_id).fetch_optional(&mut *original).await?;
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
                crate::usage::valuation::value(original, &event_id, &usage).await?;
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
