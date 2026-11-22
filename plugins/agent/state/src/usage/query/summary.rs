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
use maka_agent_facts::accounting::*;
use rusqlite::params_from_iter;

pub(super) struct Read {
    pub query: UsageQuery,
    pub group: Option<Group>,
    pub after: Option<UsageGroupCursor>,
    pub domain: String,
}
impl Query for Read {
    type Output = UsageReport;
    fn execute(self, db: &Connection) -> Result<Self::Output, StoreError> {
        let through = fence(db, &self.query, &self.domain)?;
        let (predicate, values) = scope(&self.query, &through)?;
        let base = settled(&predicate);
        let models = model_totals(db, &format!("{base} AND c.kind='model'"), &values)?;
        let tools = tool_totals(db, &format!("{base} AND c.kind='tool'"), &values)?;
        let mut summary = Summary {
            models,
            tools,
            pending: pending(db, &predicate, &values)?,
            by_provider: vec![],
            by_model: vec![],
            by_tool: vec![],
        };
        let mut next_cursor = None;
        if let Some(group) = self.group {
            let (key, kind, columns) = match group {
                Group::ByProvider => ("c.provider_id", "model", MODELS),
                Group::ByModel => ("c.model_id", "model", MODELS),
                Group::ByTool => ("c.name", "tool", TOOLS),
            };
            let mut sql = format!("SELECT {key} AS group_key,{columns} {base} AND c.kind='{kind}'");
            let mut values = values;
            if let Some(after) = self.after {
                if let Some(key_value) = after.key {
                    values.push(Value::Text(key_value));
                    sql.push_str(&format!(" AND {key}>?{}", values.len()));
                } else {
                    sql.push_str(&format!(" AND {key} IS NOT NULL"));
                }
            }
            sql.push_str(&format!(" GROUP BY {key} ORDER BY {key} ASC LIMIT 33"));
            let mut statement = db.prepare_cached(&sql)?;
            let mut rows = statement.query(params_from_iter(&values))?;
            let mut length = 0usize;
            let mut last_key = None;
            while let Some(row) = rows.next()? {
                length += 1;
                if length > 32 {
                    next_cursor = Some(UsageGroupCursor {
                        group,
                        key: last_key,
                    });
                    break;
                }
                match group {
                    Group::ByProvider => {
                        let provider_id: Option<String> = row.get("group_key")?;
                        last_key = provider_id.clone();
                        summary.by_provider.push(ProviderSummary {
                            provider_id,
                            totals: read_models(row)?,
                        });
                    }
                    Group::ByModel => {
                        let model_id: String = row.get("group_key")?;
                        last_key = Some(model_id.clone());
                        summary.by_model.push(ModelSummary {
                            model_id,
                            totals: read_models(row)?,
                        });
                    }
                    Group::ByTool => {
                        let name: String = row.get("group_key")?;
                        last_key = Some(name.clone());
                        summary.by_tool.push(ToolSummary {
                            name,
                            totals: read_tools(row)?,
                        });
                    }
                }
            }
        }
        Ok(UsageReport {
            through,
            summary,
            next_cursor,
        })
    }
}

pub(super) struct SessionTotals {
    pub query: UsageQuery,
    pub domain: String,
}
impl Query for SessionTotals {
    type Output = SessionUsageTotals;
    fn execute(self, db: &Connection) -> Result<Self::Output, StoreError> {
        let through = fence(db, &self.query, &self.domain)?;
        let (predicate, values) = scope(&self.query, &through)?;
        let mut statement = db.prepare_cached(&format!(
            "SELECT COALESCE(SUM(r.input),0) AS input,COUNT(*)-COUNT(r.input) AS input_missing,
            COALESCE(SUM(r.output),0) AS output,COUNT(*)-COUNT(r.output) AS output_missing,
            COALESCE(SUM(r.cache_read),0) AS cache_read,COUNT(*)-COUNT(r.cache_read) AS cache_read_missing,
            COALESCE(SUM(r.cache_write),0) AS cache_write,COUNT(*)-COUNT(r.cache_write) AS cache_write_missing,
            COALESCE(SUM(r.reasoning),0) AS reasoning,COUNT(*)-COUNT(r.reasoning) AS reasoning_missing
            FROM agent_usage_calls c LEFT JOIN agent_usage_results r ON r.request=c.request
              AND r.sequence=(SELECT v.sequence FROM agent_usage_results v WHERE v.request=c.request
                AND v.sequence<={CUT} ORDER BY v.sequence DESC LIMIT 1)
            WHERE c.admission_sequence<={CUT} AND c.started_at>=?1 AND c.started_at<=?2
              {predicate} AND c.kind='model'"
        ))?;
        let mut rows = statement.query(params_from_iter(&values))?;
        let row = rows.next()?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        Ok(SessionUsageTotals {
            input: tokens(row, "input")?,
            output: tokens(row, "output")?,
            cache_read: tokens(row, "cache_read")?,
            cache_write: tokens(row, "cache_write")?,
            reasoning: tokens(row, "reasoning")?,
        })
    }
}

fn model_totals(db: &Connection, base: &str, values: &[Value]) -> Result<ModelTotals, StoreError> {
    let mut statement = db.prepare_cached(&format!("SELECT {MODELS} {base}"))?;
    let mut rows = statement.query(params_from_iter(values))?;
    read_models(rows.next()?.ok_or(rusqlite::Error::QueryReturnedNoRows)?)
}
fn tool_totals(db: &Connection, base: &str, values: &[Value]) -> Result<ToolTotals, StoreError> {
    let mut statement = db.prepare_cached(&format!("SELECT {TOOLS} {base}"))?;
    let mut rows = statement.query(params_from_iter(values))?;
    read_tools(rows.next()?.ok_or(rusqlite::Error::QueryReturnedNoRows)?)
}
fn pending(db: &Connection, scope: &str, values: &[Value]) -> Result<Pending, StoreError> {
    let (models, tools): (i64,i64) = db.query_row(&format!(
        "SELECT COALESCE(SUM(c.kind='model'),0),COALESCE(SUM(c.kind='tool'),0)
        FROM agent_usage_calls c WHERE c.started_at>=?1 AND c.started_at<=?2
        AND c.admission_sequence<={CUT} {scope}
        AND (SELECT r.completed_at FROM agent_usage_results r
            WHERE r.request=c.request AND r.sequence<={CUT} ORDER BY r.sequence DESC LIMIT 1) IS NULL"
    ), params_from_iter(values), |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(Pending {
        models: count(models)?,
        tools: count(tools)?,
    })
}

const MODELS: &str = "COUNT(*) AS calls,
    COALESCE(SUM(r.outcome='success'),0) AS success,
    COALESCE(SUM(r.outcome='error'),0) AS error,
    COALESCE(SUM(r.outcome='aborted'),0) AS aborted,
    COALESCE(SUM(r.outcome='unknown'),0) AS unknown,
    TOTAL(CASE WHEN r.outcome!='unknown' THEN MAX(r.completed_at-c.started_at,0) END) AS duration,
    COALESCE(SUM(r.input),0) AS input,COUNT(*)-COUNT(r.input) AS input_missing,
    COALESCE(SUM(r.output),0) AS output,COUNT(*)-COUNT(r.output) AS output_missing,
    COALESCE(SUM(r.cache_read),0) AS cache_read,COUNT(*)-COUNT(r.cache_read) AS cache_read_missing,
    COALESCE(SUM(r.cache_write),0) AS cache_write,COUNT(*)-COUNT(r.cache_write) AS cache_write_missing,
    COALESCE(SUM(r.reasoning),0) AS reasoning,COUNT(*)-COUNT(r.reasoning) AS reasoning_missing,
    TOTAL(r.cost_usd) AS usd,COUNT(*)-COUNT(r.cost_usd) AS unvalued,
    COUNT(*)-COUNT(json_extract(c.quote_json,'$.pricing')) AS unpriced";
const TOOLS: &str = "COUNT(*) AS calls,
    COALESCE(SUM(r.outcome='success'),0) AS success,
    COALESCE(SUM(r.outcome='error'),0) AS error,
    COALESCE(SUM(r.outcome='unknown'),0) AS unknown,
    COALESCE(SUM(r.outcome='rejected'),0) AS rejected,
    TOTAL(CASE WHEN r.outcome IN ('success','error') THEN MAX(r.completed_at-c.started_at,0) END) AS duration,
    AVG(CASE WHEN r.outcome IN ('success','error') THEN MAX(r.completed_at-c.started_at,0) END) AS latency";

fn read_models(row: &rusqlite::Row<'_>) -> Result<ModelTotals, StoreError> {
    Ok(ModelTotals {
        calls: count(row.get("calls")?)?,
        success: count(row.get("success")?)?,
        error: count(row.get("error")?)?,
        aborted: count(row.get("aborted")?)?,
        unknown: count(row.get("unknown")?)?,
        duration_ms: finite(row.get("duration")?)?,
        input: tokens(row, "input")?,
        output: tokens(row, "output")?,
        cache_read: tokens(row, "cache_read")?,
        cache_write: tokens(row, "cache_write")?,
        reasoning: tokens(row, "reasoning")?,
        cost: Cost {
            known_usd: finite(row.get("usd")?)?,
            unvalued: count(row.get("unvalued")?)?,
            unpriced: count(row.get("unpriced")?)?,
        },
    })
}
fn read_tools(row: &rusqlite::Row<'_>) -> Result<ToolTotals, StoreError> {
    Ok(ToolTotals {
        calls: count(row.get("calls")?)?,
        success: count(row.get("success")?)?,
        error: count(row.get("error")?)?,
        unknown: count(row.get("unknown")?)?,
        rejected: count(row.get("rejected")?)?,
        duration_ms: finite(row.get("duration")?)?,
        mean_latency_ms: row
            .get::<_, Option<f64>>("latency")?
            .map(finite)
            .transpose()?,
    })
}
