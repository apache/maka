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

//! Accounting spans the fixed data journals. Each fence component is captured
//! in its journal's read transaction; this is a vector snapshot, not a global
//! transaction. Physical admissions occur in exactly one source journal.
use super::*;
use maka_agent_facts::accounting::{
    Activity, Group, ModelTotals, Selection, Summary, Tokens, ToolTotals,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageFence {
    pub state_domain: String,
    pub partitions: [u64; PARTITION_COUNT],
}
#[derive(Clone, Debug)]
pub struct UsageQuery {
    pub from: f64,
    pub to: f64,
    pub session_id: Option<String>,
    pub through: Option<UsageFence>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageActivityCursor {
    pub completed_at: f64,
    pub partition: usize,
    pub request_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageGroupCursor {
    pub group: Group,
    /// None is the unknown-provider group, not the beginning of pagination.
    pub key: Option<String>,
}
pub struct UsageActivityPage {
    pub through: UsageFence,
    pub attempts: Vec<Activity>,
    pub total: u64,
    pub next_cursor: Option<UsageActivityCursor>,
}
pub struct UsageReport {
    pub through: UsageFence,
    pub summary: Summary,
    pub next_cursor: Option<UsageGroupCursor>,
}
impl UsageQuery {
    fn local(&self, index: usize) -> crate::usage::Query {
        crate::usage::Query {
            from: self.from,
            to: self.to,
            session_id: self.session_id.clone(),
            through: self.through.as_ref().map(|fence| fence.partitions[index]),
        }
    }
    fn validate(&self, domain: &str) -> Result<(), StoreError> {
        self.local(0).validate()?;
        if self.through.as_ref().is_some_and(|fence| {
            fence.state_domain != domain || fence.partitions.iter().any(|value| *value > MAX_NUMBER)
        }) {
            return Err(invalid("foreign or invalid Usage fence"));
        }
        Ok(())
    }
}
impl RootStore {
    pub async fn usage_totals(&self, query: UsageQuery) -> Result<UsageReport, StoreError> {
        self.require_open()?;
        totals(
            self.partitions.clone(),
            self.control.owned_root()?.root_id().to_owned(),
            query,
        )
        .await
    }
    pub async fn usage_summary_page(
        &self,
        query: UsageQuery,
        group: Group,
        after: Option<UsageGroupCursor>,
    ) -> Result<UsageReport, StoreError> {
        self.require_open()?;
        summary_page(
            self.partitions.clone(),
            self.control.owned_root()?.root_id().to_owned(),
            query,
            group,
            after,
        )
        .await
    }
    pub async fn usage_activity(
        &self,
        query: UsageQuery,
        selection: Selection,
        after: Option<UsageActivityCursor>,
    ) -> Result<UsageActivityPage, StoreError> {
        self.require_open()?;
        activity_page(
            self.partitions.clone(),
            self.control.owned_root()?.root_id().to_owned(),
            query,
            selection,
            after,
        )
        .await
    }
}
impl SessionStore {
    pub async fn usage_totals(&self, mut query: UsageQuery) -> Result<UsageReport, StoreError> {
        let owner = self.owner()?;
        if let Some(session) = &query.session_id {
            self.check_session(session)?;
        }
        query.session_id = Some(self.id().to_owned());
        let journals = self
            .journals
            .iter()
            .map(|journal| journal.upgrade().ok_or(StoreError::ConnectionClosed))
            .collect::<Result<Vec<_>, _>>()?;
        totals(journals, owner.owned_root()?.root_id().to_owned(), query).await
    }
}
async fn totals(
    journals: Vec<Arc<EventLog>>,
    domain: String,
    query: UsageQuery,
) -> Result<UsageReport, StoreError> {
    query.validate(&domain)?;
    let reports =
        futures_util::future::join_all(journals.into_iter().enumerate().map(|(index, owner)| {
            let query = query.local(index);
            async move { owner.scoped(owner.clone()).usage_totals(query).await }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    combine_reports(domain, reports)
}
fn combine_reports(
    domain: String,
    reports: Vec<crate::usage::Report>,
) -> Result<UsageReport, StoreError> {
    let positions: [u64; PARTITION_COUNT] = reports
        .iter()
        .map(|report| report.through)
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| invalid("invalid Usage partition count"))?;
    let mut reports = reports.into_iter();
    let mut summary = reports
        .next()
        .ok_or_else(|| invalid("missing Usage partitions"))?
        .summary;
    summary.by_model.clear();
    summary.by_provider.clear();
    summary.by_tool.clear();
    for report in reports {
        merge_totals(&mut summary, &report.summary)?;
    }
    Ok(UsageReport {
        through: UsageFence {
            state_domain: domain,
            partitions: positions,
        },
        summary,
        next_cursor: None,
    })
}
async fn summary_page(
    journals: Vec<Arc<EventLog>>,
    domain: String,
    query: UsageQuery,
    group: Group,
    after: Option<UsageGroupCursor>,
) -> Result<UsageReport, StoreError> {
    query.validate(&domain)?;
    if let Some(cursor) = &after
        && (query.through.is_none()
            || cursor.group != group
            || (cursor.key.is_none() && group != Group::ByProvider)
            || cursor.key.as_ref().is_some_and(|key| key.len() > 48 * 1024))
    {
        return Err(invalid("invalid Usage group cursor"));
    }
    let after = after.map(|cursor| cursor.key);
    let reports =
        futures_util::future::join_all(journals.into_iter().enumerate().map(|(index, owner)| {
            let query = query.local(index);
            let after = after.clone();
            async move {
                owner
                    .scoped(owner.clone())
                    .usage_summary_after(query, group, after)
                    .await
            }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    // At most 8 * 33 keys. Any key among the first 32 global keys must occur
    // within every partition's first 33, so all its contributions are present.
    let mut models = BTreeMap::<Option<String>, ModelTotals>::new();
    let mut tools = BTreeMap::<String, ToolTotals>::new();
    for report in &reports {
        match group {
            Group::ByProvider => {
                for entry in &report.summary.by_provider {
                    insert_model(&mut models, entry.provider_id.clone(), &entry.totals)?;
                }
            }
            Group::ByModel => {
                for entry in &report.summary.by_model {
                    insert_model(&mut models, Some(entry.model_id.clone()), &entry.totals)?;
                }
            }
            Group::ByTool => {
                for entry in &report.summary.by_tool {
                    if entry.name.len() > 48 * 1024 {
                        return Err(invalid("one Usage group exceeds page capacity"));
                    }
                    if let Some(old) = tools.get_mut(&entry.name) {
                        merge_tools(old, &entry.totals)?;
                    } else {
                        tools.insert(entry.name.clone(), entry.totals.clone());
                    }
                }
            }
        }
    }
    let available = models.len() + tools.len();
    let mut result = combine_reports(domain, reports)?;
    let mut last = None;
    for (key, value) in models.into_iter().take(32) {
        match group {
            Group::ByProvider => {
                result
                    .summary
                    .by_provider
                    .push(maka_agent_facts::accounting::ProviderSummary {
                        provider_id: key.clone(),
                        totals: value,
                    })
            }
            Group::ByModel => {
                result
                    .summary
                    .by_model
                    .push(maka_agent_facts::accounting::ModelSummary {
                        model_id: key
                            .clone()
                            .ok_or_else(|| invalid("model group has no identity"))?,
                        totals: value,
                    })
            }
            _ => unreachable!(),
        }
        if serde_json::to_vec(&result.summary)?.len() > 48 * 1024 {
            match group {
                Group::ByProvider => {
                    result.summary.by_provider.pop();
                }
                _ => {
                    result.summary.by_model.pop();
                }
            }
            break;
        }
        last = Some(key);
    }
    for (key, value) in tools.into_iter().take(32) {
        result
            .summary
            .by_tool
            .push(maka_agent_facts::accounting::ToolSummary {
                name: key.clone(),
                totals: value,
            });
        if serde_json::to_vec(&result.summary)?.len() > 48 * 1024 {
            result.summary.by_tool.pop();
            break;
        }
        last = Some(Some(key));
    }
    let emitted = result.summary.by_provider.len()
        + result.summary.by_model.len()
        + result.summary.by_tool.len();
    if available != 0 && emitted == 0 {
        return Err(invalid("one Usage group exceeds page capacity"));
    }
    if emitted < available {
        result.next_cursor = Some(UsageGroupCursor {
            group,
            key: last.expect("emitted group"),
        });
    }
    Ok(result)
}
fn insert_model(
    map: &mut BTreeMap<Option<String>, ModelTotals>,
    key: Option<String>,
    value: &ModelTotals,
) -> Result<(), StoreError> {
    if key.as_ref().is_some_and(|key| key.len() > 48 * 1024) {
        return Err(invalid("one Usage group exceeds page capacity"));
    }
    if let Some(old) = map.get_mut(&key) {
        merge_models(old, value)?;
    } else {
        map.insert(key, value.clone());
    }
    Ok(())
}
async fn activity_page(
    journals: Vec<Arc<EventLog>>,
    domain: String,
    query: UsageQuery,
    selection: Selection,
    after: Option<UsageActivityCursor>,
) -> Result<UsageActivityPage, StoreError> {
    query.validate(&domain)?;
    selection
        .validate()
        .map_err(|_| invalid("invalid Usage selection"))?;
    if let Some(cursor) = &after
        && (query.through.is_none()
            || !cursor.completed_at.is_finite()
            || cursor.completed_at < 0.0
            || cursor.partition >= PARTITION_COUNT
            || cursor.request_id.is_empty()
            || cursor.request_id.len() > 128)
    {
        return Err(invalid("invalid Usage activity cursor"));
    }
    let pages =
        futures_util::future::join_all(journals.into_iter().enumerate().map(|(index, owner)| {
            let query = query.local(index);
            let selection = selection.clone();
            let after = after.clone();
            async move {
                crate::usage::reads::activity_after(
                    &owner.scoped(owner.clone()),
                    query,
                    selection,
                    index,
                    after,
                )
                .await
            }
        }))
        .await
        .into_iter()
        .collect::<Result<Vec<_>, _>>()?;
    let positions: [u64; PARTITION_COUNT] = pages
        .iter()
        .map(|page| page.through)
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| invalid("invalid Usage partition count"))?;
    let mut total = 0;
    let mut candidates = Vec::new();
    for (partition, page) in pages.into_iter().enumerate() {
        total = add(total, page.total)?;
        for attempt in page.attempts {
            candidates.push((cursor(&attempt, partition), attempt));
        }
    }
    candidates.sort_by(|(left, _), (right, _)| {
        right
            .completed_at
            .total_cmp(&left.completed_at)
            .then(left.partition.cmp(&right.partition))
            .then(left.request_id.cmp(&right.request_id))
    });
    let available = candidates.len();
    let mut attempts = Vec::new();
    let mut bytes = 0;
    let mut last = None;
    for (cursor, attempt) in candidates.into_iter().take(32) {
        let size = serde_json::to_vec(&attempt)?.len() + 1;
        if bytes + size > 32 * 1024 {
            break;
        }
        bytes += size;
        attempts.push(attempt);
        last = Some(cursor);
    }
    if available != 0 && attempts.is_empty() {
        return Err(invalid("one Usage record exceeds page capacity"));
    }
    let next_cursor = (attempts.len() < available).then_some(last).flatten();
    Ok(UsageActivityPage {
        through: UsageFence {
            state_domain: domain,
            partitions: positions,
        },
        attempts,
        total,
        next_cursor,
    })
}
fn cursor(attempt: &Activity, partition: usize) -> UsageActivityCursor {
    let (completed_at, request_id) = match attempt {
        Activity::Model(attempt) => (attempt.completed_at, attempt.request_id.clone()),
        Activity::Tool(attempt) => (attempt.completed_at, attempt.request_id.clone()),
    };
    UsageActivityCursor {
        completed_at,
        partition,
        request_id,
    }
}
const MAX_NUMBER: u64 = (1 << 53) - 1;
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn add(left: u64, right: u64) -> Result<u64, StoreError> {
    left.checked_add(right)
        .filter(|value| *value <= MAX_NUMBER)
        .ok_or_else(|| invalid("Usage aggregate exceeds exact integer capacity"))
}
fn sum(left: f64, right: f64) -> Result<f64, StoreError> {
    let value = left + right;
    if value.is_finite() && value >= 0.0 {
        Ok(value)
    } else {
        Err(invalid("Usage aggregate exceeds finite numeric capacity"))
    }
}
fn merge_tokens(left: &mut Tokens, right: &Tokens) -> Result<(), StoreError> {
    left.known = add(left.known, right.known)?;
    left.missing = add(left.missing, right.missing)?;
    Ok(())
}
fn merge_models(left: &mut ModelTotals, right: &ModelTotals) -> Result<(), StoreError> {
    left.calls = add(left.calls, right.calls)?;
    left.success = add(left.success, right.success)?;
    left.error = add(left.error, right.error)?;
    left.aborted = add(left.aborted, right.aborted)?;
    left.unknown = add(left.unknown, right.unknown)?;
    left.duration_ms = sum(left.duration_ms, right.duration_ms)?;
    merge_tokens(&mut left.input, &right.input)?;
    merge_tokens(&mut left.output, &right.output)?;
    merge_tokens(&mut left.cache_read, &right.cache_read)?;
    merge_tokens(&mut left.cache_write, &right.cache_write)?;
    merge_tokens(&mut left.reasoning, &right.reasoning)?;
    left.cost.known_usd = sum(left.cost.known_usd, right.cost.known_usd)?;
    left.cost.unvalued = add(left.cost.unvalued, right.cost.unvalued)?;
    left.cost.unpriced = add(left.cost.unpriced, right.cost.unpriced)?;
    Ok(())
}
fn merge_tools(left: &mut ToolTotals, right: &ToolTotals) -> Result<(), StoreError> {
    left.calls = add(left.calls, right.calls)?;
    left.success = add(left.success, right.success)?;
    left.error = add(left.error, right.error)?;
    left.unknown = add(left.unknown, right.unknown)?;
    left.rejected = add(left.rejected, right.rejected)?;
    left.duration_ms = sum(left.duration_ms, right.duration_ms)?;
    let observed = add(left.success, left.error)?;
    left.mean_latency_ms = if observed == 0 {
        None
    } else {
        Some(left.duration_ms / observed as f64)
    };
    Ok(())
}
fn merge_totals(left: &mut Summary, right: &Summary) -> Result<(), StoreError> {
    merge_models(&mut left.models, &right.models)?;
    merge_tools(&mut left.tools, &right.tools)?;
    left.pending.models = add(left.pending.models, right.pending.models)?;
    left.pending.tools = add(left.pending.tools, right.pending.tools)?;
    Ok(())
}

#[cfg(test)]
mod tests;
