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

use super::{bearer, get_json};
use maka_agent_ports::provider::{Context, Error, UsageLimit, UsagePeriod, UsageQuantity};
use serde::Deserialize;
use url::Url;

mod kimi;
mod minimax;
mod spending;
const FIVE_HOURS: u32 = 5 * 3600;
const WEEK: u32 = 7 * 86400;

#[derive(Clone, Copy)]
pub(super) enum Source {
    Zhipu,
    Kimi,
    MiniMax,
    OpenCodeGo,
    CommandCode,
    Ollama,
    Mistral,
}

pub(super) fn source(id: &str) -> Option<Source> {
    Some(match id {
        "zai-coding-plan" | "zhipu-coding-plan" => Source::Zhipu,
        "kimi-coding-plan" => Source::Kimi,
        "minimax-coding-plan" | "MiniMax" | "MiniMax-cn" => Source::MiniMax,
        "opencode-go" => Source::OpenCodeGo,
        "commandcode" => Source::CommandCode,
        "ollama-cloud" => Source::Ollama,
        "mistral" => Source::Mistral,
        _ => return None,
    })
}

impl Source {
    pub(super) async fn read(
        self,
        base: &Url,
        key: &str,
        context: &Context,
    ) -> Result<Vec<UsageLimit>, Error> {
        let at = |path| {
            base.join(path)
                .map(String::from)
                .map_err(|_| Error::InvalidEndpoint)
        };
        let headers = bearer(key);
        match self {
            Self::Zhipu => {
                let data = get_json(
                    context,
                    at("/api/monitor/usage/quota/limit")?,
                    [("authorization".into(), key.into())].into(),
                )
                .await?;
                zhipu(data)
            }
            Self::Kimi => {
                let data = get_json(context, at("/coding/v1/usages")?, headers).await?;
                kimi::limits(data)
            }
            Self::MiniMax => {
                let data = get_json(context, at("/v1/token_plan/remains")?, headers).await?;
                minimax::limits(data)
            }
            Self::OpenCodeGo => {
                let data = get_json(context, at("/zen/go/v1/usage")?, headers).await?;
                opencode_go(data)
            }
            Self::CommandCode => {
                let data = get_json(context, at("/alpha/billing/credits")?, headers).await?;
                Ok(spending::command_code(data))
            }
            Self::Ollama => {
                let data = get_json(context, at("/api/balance")?, headers).await?;
                Ok(spending::ollama(data))
            }
            Self::Mistral => spending::mistral(key, context).await,
        }
    }
}

#[derive(Deserialize)]
struct Zhipu {
    success: Option<bool>,
    data: Option<ZhipuData>,
    code: Option<u16>,
}

#[derive(Deserialize)]
struct ZhipuData {
    #[serde(default)]
    limits: Vec<ZhipuLimit>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZhipuLimit {
    #[serde(rename = "type")]
    kind: String,
    unit: u32,
    number: Option<u32>,
    percentage: Option<Number>,
    next_reset_time: Option<u64>,
    usage: Option<Number>,
    current_value: Option<Number>,
}

fn zhipu(reply: Zhipu) -> Result<Vec<UsageLimit>, Error> {
    if matches!(reply.code, Some(1000..=1005)) {
        return Err(Error::AuthenticationRequired);
    }
    let data = reply
        .data
        .filter(|_| reply.success != Some(false))
        .ok_or_else(|| invalid("Zhipu usage"))?;
    Ok(data
        .limits
        .into_iter()
        .filter_map(|entry| {
            let (label, period) = if entry.kind == "TIME_LIMIT" {
                (Some("MCP".into()), Some(UsagePeriod::Monthly))
            } else {
                let seconds = match entry.unit {
                    3 => entry
                        .number
                        .filter(|n| *n > 0)
                        .unwrap_or(5)
                        .checked_mul(3600),
                    6 => Some(WEEK),
                    _ => None,
                };
                (None, seconds.map(duration))
            };
            let unit = match entry.kind.as_str() {
                "TOKENS_LIMIT" => Some("tokens".into()),
                "CREDIT_LIMIT" => Some("credits".into()),
                "TIME_LIMIT" => Some("calls".into()),
                _ => None,
            };
            let quantity = quantity(entry.current_value, entry.usage, unit);
            let used_percent = entry
                .percentage
                .and_then(Number::value)
                .or_else(|| share(quantity.as_ref()?))?;
            Some(UsageLimit::Window {
                label,
                period,
                resets_at: entry.next_reset_time.filter(|n| *n > 0).map(|n| n / 1000),
                used_percent,
                quantity,
            })
        })
        .collect())
}

#[derive(Deserialize)]
struct OpenCodeGo {
    usage: OpenCodeWindows,
}

#[derive(Deserialize)]
struct OpenCodeWindows {
    rolling: Option<OpenCodeWindow>,
    weekly: Option<OpenCodeWindow>,
    monthly: Option<OpenCodeWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeWindow {
    percent: Option<f64>,
    resets_at: Option<String>,
}

fn opencode_go(reply: OpenCodeGo) -> Result<Vec<UsageLimit>, Error> {
    let limits: Vec<_> = [
        (reply.usage.rolling, duration(FIVE_HOURS)),
        (reply.usage.weekly, duration(WEEK)),
        (reply.usage.monthly, UsagePeriod::Monthly),
    ]
    .into_iter()
    .filter_map(|(value, period)| {
        let value = value?;
        let used_percent = value.percent?;
        Some(UsageLimit::Window {
            label: None,
            period: Some(period),
            // OpenCode reports now + window length for a window that has yet to start.
            resets_at: (used_percent > 0.0)
                .then(|| parse_time(value.resets_at.as_deref()?))
                .flatten(),
            used_percent,
            quantity: None,
        })
    })
    .collect();
    if limits.is_empty() {
        return Err(invalid("OpenCode Go usage"));
    }
    Ok(limits)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Json(f64),
    Text(String),
}

impl Number {
    fn value(self) -> Option<f64> {
        let value = match self {
            Self::Json(value) => value,
            Self::Text(value) => value.trim().parse().ok()?,
        };
        (value.is_finite() && value >= 0.0).then_some(value)
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Time {
    Epoch(u64),
    Text(String),
}

impl Time {
    fn seconds(self) -> Option<u64> {
        match self {
            Self::Epoch(value) => epoch(value),
            Self::Text(value) => parse_time(&value).or_else(|| epoch(value.parse().ok()?)),
        }
    }
}

fn parse_time(value: &str) -> Option<u64> {
    let seconds = value.parse::<jiff::Timestamp>().ok()?.as_second();
    u64::try_from(seconds).ok()
}

fn epoch(value: u64) -> Option<u64> {
    match value {
        0 => None,
        100_000_000_000.. => Some(value / 1000),
        _ => Some(value),
    }
}

fn duration(seconds: u32) -> UsagePeriod {
    UsagePeriod::Duration { seconds }
}

fn quantity(
    used: Option<Number>,
    limit: Option<Number>,
    unit: Option<String>,
) -> Option<UsageQuantity> {
    let limit = limit?.value()?;
    let used = used?.value()?;
    (limit > 0.0).then_some(UsageQuantity { used, limit, unit })
}

fn share(quantity: &UsageQuantity) -> Option<f64> {
    let percent = quantity.used / quantity.limit * 100.0;
    percent.is_finite().then_some(percent)
}

fn invalid(source: &str) -> Error {
    Error::Invalid(format!("invalid {source} response"))
}
