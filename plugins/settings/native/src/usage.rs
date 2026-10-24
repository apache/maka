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

//! Root-authorized accounting reads; all data comes from physical EventLog facts.
use maka_agent_facts::accounting::Activity;
use maka_agent_facts::accounting::Group;
use maka_agent_facts::accounting::ModelSummary;
use maka_agent_facts::accounting::ModelTotals;
use maka_agent_facts::accounting::Pending;
use maka_agent_facts::accounting::ProviderSummary;
use maka_agent_facts::accounting::Selection;
use maka_agent_facts::accounting::ToolSummary;
use maka_agent_facts::accounting::ToolTotals;
use maka_event_log::root_store::{RootStore, UsageActivityCursor, UsageFence, UsageGroupCursor};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsUsageRange")]
pub struct Range {
    #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
    pub from: f64,
    #[schemars(range(min = 0, max = 9_007_199_254_740_991u64))]
    pub to: f64,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<String>")]
    pub session_id: Option<String>,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<UsageFence>")]
    pub through: Option<UsageFence>,
}
impl From<Range> for maka_event_log::root_store::UsageQuery {
    fn from(value: Range) -> Self {
        Self {
            from: value.from,
            to: value.to,
            session_id: value.session_id,
            through: value.through,
        }
    }
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsUsageRead")]
pub struct Read {
    pub range: Range,
    pub selection: Selection,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<UsageActivityCursor>")]
    pub cursor: Option<UsageActivityCursor>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsUsagePage")]
pub struct Page {
    pub through: UsageFence,
    #[schemars(length(max = 32))]
    pub attempts: Vec<Activity>,
    pub total: u64,
    pub next_cursor: Option<UsageActivityCursor>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
#[schemars(rename = "SettingsUsageSummaryRead")]
pub struct SummaryRead {
    pub range: Range,
    pub group: Group,
    #[serde(deserialize_with = "Option::deserialize")]
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<UsageGroupCursor>")]
    pub cursor: Option<UsageGroupCursor>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsUsageTotals")]
pub struct Totals {
    pub models: ModelTotals,
    pub tools: ToolTotals,
    pub pending: Pending,
    #[schemars(length(max = 32))]
    pub by_provider: Vec<ProviderSummary>,
    #[schemars(length(max = 32))]
    pub by_model: Vec<ModelSummary>,
    #[schemars(length(max = 32))]
    pub by_tool: Vec<ToolSummary>,
}
#[derive(Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "SettingsUsageSummary")]
pub struct Report {
    pub through: UsageFence,
    pub summary: Totals,
    pub next_cursor: Option<UsageGroupCursor>,
}
#[derive(Serialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "SettingsPricingResult")]
pub enum PricingResult {
    Updated {
        result: maka_agent_facts::pricing::Updated,
    },
    Rejected,
}

pub(crate) async fn page(log: &RootStore, input: Value) -> Result<Value, String> {
    let input: Read = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let page = log
        .usage_activity(input.range.into(), input.selection, input.cursor)
        .await
        .map_err(|_| "settings_usage_unavailable")?;
    super::connections::encode(Page {
        through: page.through,
        attempts: page.attempts,
        total: page.total,
        next_cursor: page.next_cursor,
    })
}
pub(crate) async fn summary(log: &RootStore, input: Value) -> Result<Value, String> {
    let input: SummaryRead = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    let report = log
        .usage_summary_page(input.range.into(), input.group, input.cursor)
        .await
        .map_err(|_| "settings_usage_unavailable")?;
    let summary = report.summary;
    super::connections::encode(Report {
        through: report.through,
        next_cursor: report.next_cursor,
        summary: Totals {
            models: summary.models,
            tools: summary.tools,
            pending: summary.pending,
            by_provider: summary.by_provider,
            by_model: summary.by_model,
            by_tool: summary.by_tool,
        },
    })
}
pub(crate) async fn prices(
    store: &maka_config::ConfigurationStore,
    input: Value,
) -> Result<Value, String> {
    let input = serde_json::from_value(input).map_err(|_| "settings_input_invalid")?;
    super::connections::encode(
        store
            .query_pricing(input)
            .await
            .map_err(|_| "settings_prices_unavailable")?,
    )
}
pub(crate) async fn update_price(
    store: &maka_config::ConfigurationStore,
    input: Value,
) -> Result<Value, String> {
    let Ok(input) = serde_json::from_value(input) else {
        return super::connections::encode(PricingResult::Rejected);
    };
    let result = match store.update_pricing(input).await {
        Ok(result) => PricingResult::Updated { result },
        Err(maka_config::ConfigError::Invalid(_)) => PricingResult::Rejected,
        Err(_) => return Err("settings_effect_unknown".into()),
    };
    super::connections::encode(result)
}
