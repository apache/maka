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
use maka_agent_facts::accounting::ToolUsageResult;
use maka_agent_facts::{
    accounting::{ActivityKind, ActivityStatus, ModelAttempt},
    model::ModelUsage,
};
use rusqlite::params_from_iter;

pub(super) struct Read {
    pub query: UsageQuery,
    pub selection: Selection,
    pub after: Option<UsageActivityCursor>,
    pub domain: String,
}
impl Query for Read {
    type Output = UsageActivityPage;
    fn execute(self, db: &Connection) -> Result<Self::Output, StoreError> {
        let through = fence(db, &self.query, &self.domain)?;
        let (mut predicate, mut values) = scope(&self.query, &through)?;
        if let Some(kind) = self.selection.kind {
            values.push(Value::Text(
                match kind {
                    ActivityKind::Model => "model",
                    ActivityKind::Tool => "tool",
                }
                .into(),
            ));
            predicate.push_str(&format!(" AND c.kind=?{}", values.len()));
        }
        if let Some(status) = self.selection.status {
            values.push(Value::Text(
                match status {
                    ActivityStatus::Success => "success",
                    ActivityStatus::Error => "error",
                    ActivityStatus::Aborted => "aborted",
                    ActivityStatus::Unknown => "unknown",
                    ActivityStatus::Rejected => "rejected",
                }
                .into(),
            ));
            predicate.push_str(&format!(" AND r.outcome=?{}", values.len()));
        }
        if !self.selection.search.is_empty() {
            values.push(Value::Text(self.selection.search));
            predicate.push_str(&format!(" AND instr(lower(
                c.session||' '||COALESCE(c.model_id,'')||' '||COALESCE(c.name,'')||' '||
                COALESCE(c.provider_id,'')||' '||COALESCE(json_extract(c.binding_json,'$.connection_slug'),'')||' '||
                COALESCE(json_extract(c.binding_json,'$.model'),'')),lower(?{}))>0", values.len()));
        }
        let base = settled(&predicate);
        let total: i64 = db.query_row(
            &format!("SELECT COUNT(*) {base}"),
            params_from_iter(&values),
            |r| r.get(0),
        )?;
        let select = format!("SELECT r.request AS request,c.kind,c.session,c.model_id,c.name,c.started_at,
            c.binding_json,c.quote_json,c.origin_json,r.completed_at AS completed_at,r.outcome,r.rejection,r.cleanup_json,
            r.input,r.output,r.cache_read,r.cache_write,r.reasoning,r.cost_usd
            FROM agent_usage_results r INDEXED BY agent_usage_result_time
            CROSS JOIN agent_usage_calls c ON c.request=r.request {}", settled_where(&predicate));
        let sql = if let Some(after) = self.after {
            values.push(Value::Real(after.completed_at));
            let at = values.len();
            values.push(Value::Text(after.request_id));
            // Disjoint index ranges seek within timestamp ties as well as across time.
            format!(
                "{select} AND r.completed_at=?{at} AND r.request>?{}
                UNION ALL {select} AND r.completed_at<?{at}
                ORDER BY completed_at DESC,request ASC LIMIT 33",
                values.len()
            )
        } else {
            format!("{select} ORDER BY r.completed_at DESC,r.request ASC LIMIT 33")
        };
        let mut statement = db.prepare_cached(&sql)?;
        let mut rows = statement.query(params_from_iter(&values))?;
        let mut attempts = Vec::new();
        while let Some(row) = rows.next()? {
            attempts.push(decode(row)?);
        }
        let more = attempts.len() > 32;
        attempts.truncate(32);
        let next_cursor = if more {
            attempts.last().map(|attempt| {
                let (completed_at, request_id) = match attempt {
                    Activity::Model(value) => (value.completed_at, value.request_id.clone()),
                    Activity::Tool(value) => (value.completed_at, value.request_id.clone()),
                };
                UsageActivityCursor {
                    completed_at,
                    request_id,
                }
            })
        } else {
            None
        };
        Ok(UsageActivityPage {
            through,
            attempts,
            total: count(total)?,
            next_cursor,
        })
    }
}

fn optional_json<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    name: &str,
) -> Result<Option<T>, StoreError> {
    row.get::<_, Option<String>>(name)?
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(Into::into)
}
fn optional_counter(row: &rusqlite::Row<'_>, name: &str) -> Result<Option<u64>, StoreError> {
    row.get::<_, Option<i64>>(name)?.map(count).transpose()
}
fn decode(row: &rusqlite::Row<'_>) -> Result<Activity, StoreError> {
    match row.get::<_, String>("kind")?.as_str() {
        "model" => Ok(Activity::Model(ModelAttempt {
            request_id: row.get("request")?,
            origin: serde_json::from_str(&row.get::<_, String>("origin_json")?)?,
            session_id: row.get("session")?,
            binding: optional_json(row, "binding_json")?,
            model_id: row.get("model_id")?,
            started_at: timestamp(row, "started_at")?,
            completed_at: timestamp(row, "completed_at")?,
            outcome: serde_json::from_value(serde_json::Value::String(row.get("outcome")?))?,
            usage: ModelUsage {
                input_tokens: optional_counter(row, "input")?,
                output_tokens: optional_counter(row, "output")?,
                cache_read_tokens: optional_counter(row, "cache_read")?,
                cache_write_tokens: optional_counter(row, "cache_write")?,
                reasoning_tokens: optional_counter(row, "reasoning")?,
            },
            quote: optional_json(row, "quote_json")?,
            cost_usd: row
                .get::<_, Option<f64>>("cost_usd")?
                .map(finite)
                .transpose()?,
        })),
        "tool" => tool(row).map(Activity::Tool),
        _ => Err(invalid("unsupported usage activity kind")),
    }
}

fn tool(row: &rusqlite::Row<'_>) -> Result<ToolUsage, StoreError> {
    let outcome: String = row.get("outcome")?;
    let result = if outcome == "rejected" {
        ToolUsageResult::Rejected {
            reason: optional_json(row, "rejection")?,
        }
    } else {
        ToolUsageResult::Settled {
            started_at: timestamp(row, "started_at")?,
            outcome: serde_json::from_value(serde_json::Value::String(outcome))?,
        }
    };
    Ok(ToolUsage {
        request_id: row.get("request")?,
        source: serde_json::from_str(&row.get::<_, String>("origin_json")?)?,
        name: row.get("name")?,
        binding: optional_json(row, "binding_json")?,
        completed_at: timestamp(row, "completed_at")?,
        result,
        cleanup: optional_json(row, "cleanup_json")?,
    })
}
