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

//! Accounting uses one canonical settlement watermark.
use super::*;
use maka_agent_facts::accounting::{Activity, Group, Selection, Summary};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageFence {
    pub state_domain: String,
    pub sequence: u64,
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
    pub request_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageGroupCursor {
    pub group: Group,
    /// None identifies the unknown-provider group, not the start of pagination.
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
    fn local(&self, domain: &str) -> Result<crate::usage::Query, StoreError> {
        if self
            .through
            .as_ref()
            .is_some_and(|fence| fence.state_domain != domain)
        {
            return Err(invalid("foreign Usage fence"));
        }
        let query = crate::usage::Query {
            from: self.from,
            to: self.to,
            session_id: self.session_id.clone(),
            through: self.through.as_ref().map(|fence| fence.sequence),
        };
        query.validate()?;
        Ok(query)
    }
}
impl RootStore {
    pub async fn usage_totals(&self, query: UsageQuery) -> Result<UsageReport, StoreError> {
        self.require_open()?;
        totals(self.log.clone(), query).await
    }
    pub async fn usage_summary_page(
        &self,
        query: UsageQuery,
        group: Group,
        after: Option<UsageGroupCursor>,
    ) -> Result<UsageReport, StoreError> {
        self.require_open()?;
        let domain = self.log.owned_root()?.root_id().to_owned();
        let local = query.local(&domain)?;
        if after.as_ref().is_some_and(|cursor| {
            query.through.is_none()
                || cursor.group != group
                || (cursor.key.is_none() && group != Group::ByProvider)
        }) {
            return Err(invalid("invalid Usage group cursor"));
        }
        let report = self
            .log
            .usage_summary_after(local, group, after.map(|cursor| cursor.key))
            .await?;
        let mut summary = report.summary;
        let (more, key) = match group {
            Group::ByProvider => {
                let more = summary.by_provider.len() > 32;
                summary.by_provider.truncate(32);
                (
                    more,
                    summary
                        .by_provider
                        .last()
                        .map(|row| row.provider_id.clone()),
                )
            }
            Group::ByModel => {
                let more = summary.by_model.len() > 32;
                summary.by_model.truncate(32);
                (
                    more,
                    summary
                        .by_model
                        .last()
                        .map(|row| Some(row.model_id.clone())),
                )
            }
            Group::ByTool => {
                let more = summary.by_tool.len() > 32;
                summary.by_tool.truncate(32);
                (
                    more,
                    summary.by_tool.last().map(|row| Some(row.name.clone())),
                )
            }
        };
        Ok(UsageReport {
            through: UsageFence {
                state_domain: domain,
                sequence: report.through,
            },
            summary,
            next_cursor: if more {
                key.map(|key| UsageGroupCursor { group, key })
            } else {
                None
            },
        })
    }
    pub async fn usage_activity(
        &self,
        query: UsageQuery,
        selection: Selection,
        after: Option<UsageActivityCursor>,
    ) -> Result<UsageActivityPage, StoreError> {
        self.require_open()?;
        let domain = self.log.owned_root()?.root_id().to_owned();
        let local = query.local(&domain)?;
        if after.as_ref().is_some_and(|cursor| {
            query.through.is_none()
                || !cursor.completed_at.is_finite()
                || cursor.completed_at < 0.0
                || cursor.request_id.is_empty()
        }) {
            return Err(invalid("invalid Usage activity cursor"));
        }
        let page = crate::usage::reads::activity_after(&self.log, local, selection, after).await?;
        let mut attempts = page.attempts;
        let more = attempts.len() > 32;
        attempts.truncate(32);
        let next_cursor = if more {
            attempts.last().map(|attempt| {
                let (completed_at, request_id) = match attempt {
                    Activity::Model(row) => (row.completed_at, row.request_id.clone()),
                    Activity::Tool(row) => (row.completed_at, row.request_id.clone()),
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
            through: UsageFence {
                state_domain: domain,
                sequence: page.through,
            },
            attempts,
            total: page.total,
            next_cursor,
        })
    }
}
impl SessionStore {
    pub async fn usage_totals(&self, mut query: UsageQuery) -> Result<UsageReport, StoreError> {
        if let Some(id) = &query.session_id {
            self.check_session(id)?;
        }
        query.session_id = Some(self.id().to_owned());
        totals(self.owner()?, query).await
    }
}
async fn totals(log: Arc<EventLog>, query: UsageQuery) -> Result<UsageReport, StoreError> {
    let domain = log.owned_root()?.root_id().to_owned();
    let report = log
        .scoped(log.clone())
        .usage_totals(query.local(&domain)?)
        .await?;
    Ok(UsageReport {
        through: UsageFence {
            state_domain: domain,
            sequence: report.through,
        },
        summary: report.summary,
        next_cursor: None,
    })
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

#[cfg(test)]
mod tests;
