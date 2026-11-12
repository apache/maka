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
use serde::{Deserialize, de::DeserializeOwned};
use url::Url;

#[derive(Clone, Copy)]
pub(super) enum Source {
    DeepSeek,
    Moonshot(&'static str),
    StepFun(&'static str),
    Zhipu(&'static str),
    OpenRouter,
    ModelScope,
    AiHubMix,
}

pub(super) fn source(id: &str) -> Option<Source> {
    Some(match id {
        "deepseek" => Source::DeepSeek,
        "moonshot" => Source::Moonshot("CNY"),
        "moonshot-global" => Source::Moonshot("USD"),
        "stepfun" | "stepfun-step-plan" => Source::StepFun("CNY"),
        "stepfun-ai" | "stepfun-ai-step-plan" => Source::StepFun("USD"),
        "zai" => Source::Zhipu("USD"),
        "zhipu" => Source::Zhipu("CNY"),
        "openrouter" => Source::OpenRouter,
        "modelscope" => Source::ModelScope,
        "aihubmix" => Source::AiHubMix,
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
        let entry = match self {
            Self::DeepSeek => {
                let response: DeepSeek = get(context, base, "/user/balance", key).await?;
                return deepseek(response);
            }
            Self::Moonshot(unit) => {
                let response: Moonshot = get(context, base, "/v1/users/me/balance", key).await?;
                if response.code != 0 {
                    return Err(invalid());
                }
                balance(
                    response
                        .data
                        .ok_or_else(invalid)?
                        .available_balance
                        .value()?,
                    unit,
                )
            }
            Self::StepFun(unit) => {
                let response: StepFun = get(context, base, "/v1/accounts", key).await?;
                balance(response.balance.value()?, unit)
            }
            Self::Zhipu(unit) => {
                if base.path().starts_with("/api/coding/") {
                    return Err(Error::Unavailable);
                }
                let response: Zhipu = get(
                    context,
                    base,
                    "/api/biz/account/query-customer-account-report",
                    key,
                )
                .await?;
                if (1000..=1005).contains(&response.code) {
                    return Err(Error::AuthenticationRequired);
                }
                if response.code != 200 {
                    return Err(invalid());
                }
                let data = response.data.ok_or_else(invalid)?;
                balance(data.available_balance.value()?, unit)
            }
            Self::OpenRouter => {
                let response: Envelope<OpenRouterKey> =
                    get(context, base, "/api/v1/key", key).await?;
                if response.data.is_management_key {
                    let account: Envelope<OpenRouterCredits> =
                        get(context, base, "/api/v1/credits", key).await?;
                    balance(
                        account.data.total_credits.value()? - account.data.total_usage.value()?,
                        "USD",
                    )
                } else {
                    openrouter_key(response.data)?
                }
            }
            Self::ModelScope => {
                let response: ModelScope = get_json(
                    context,
                    "https://modelscope.cn/openapi/v1/magicubes/balance".into(),
                    bearer(key),
                )
                .await?;
                if !response.success {
                    return Err(invalid());
                }
                balance(
                    response
                        .data
                        .ok_or_else(invalid)?
                        .available_balance
                        .value()?,
                    "魔粒",
                )
            }
            Self::AiHubMix => {
                let response: AiHubMix =
                    get(context, base, "/dashboard/billing/remain", key).await?;
                let remaining = response.total_usage.value()?;
                if remaining == -1.0 {
                    UsageLimit::Unlimited {
                        label: Some("API key spending limit".into()),
                    }
                } else {
                    UsageLimit::Balance {
                        label: Some("API key balance".into()),
                        amount: remaining,
                        unit: Some("USD".into()),
                    }
                }
            }
        };
        Ok(vec![entry])
    }
}

async fn get<T: DeserializeOwned>(
    context: &Context,
    base: &Url,
    path: &str,
    key: &str,
) -> Result<T, Error> {
    let url = base.join(path).map_err(|_| Error::InvalidEndpoint)?;
    get_json(context, url.into(), bearer(key)).await
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Amount {
    // Not `f64`; see `plans::Number`.
    Number(serde_json::Number),
    Decimal(String),
}

impl Amount {
    fn value(self) -> Result<f64, Error> {
        let value = match self {
            Self::Number(value) => value.as_f64().ok_or_else(invalid)?,
            Self::Decimal(value) => value.parse().map_err(|_| invalid())?,
        };
        value.is_finite().then_some(value).ok_or_else(invalid)
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: T,
}

#[derive(Deserialize)]
struct DeepSeek {
    balance_infos: Vec<DeepSeekBalance>,
}

#[derive(Deserialize)]
struct DeepSeekBalance {
    currency: Currency,
    total_balance: Amount,
}

#[derive(Deserialize)]
#[serde(rename_all = "UPPERCASE")]
enum Currency {
    Cny,
    Usd,
}

fn deepseek(response: DeepSeek) -> Result<Vec<UsageLimit>, Error> {
    response
        .balance_infos
        .into_iter()
        .map(|entry| {
            let unit = match entry.currency {
                Currency::Cny => "CNY",
                Currency::Usd => "USD",
            };
            Ok(balance(entry.total_balance.value()?, unit))
        })
        .collect()
}

#[derive(Deserialize)]
struct AvailableBalance {
    available_balance: Amount,
}

#[derive(Deserialize)]
struct Moonshot {
    code: u32,
    data: Option<AvailableBalance>,
}

#[derive(Deserialize)]
struct ModelScope {
    success: bool,
    data: Option<AvailableBalance>,
}

#[derive(Deserialize)]
struct StepFun {
    balance: Amount,
}

#[derive(Deserialize)]
struct Zhipu {
    code: u32,
    data: Option<ZhipuBalance>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZhipuBalance {
    available_balance: Amount,
}

#[derive(Deserialize)]
struct OpenRouterKey {
    #[serde(default)]
    is_management_key: bool,
    limit: KeyLimit,
    limit_remaining: Option<Amount>,
    limit_reset: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum KeyLimit {
    Limited(Amount),
    Unlimited(()),
}

#[derive(Deserialize)]
struct OpenRouterCredits {
    total_credits: Amount,
    total_usage: Amount,
}

fn openrouter_key(key: OpenRouterKey) -> Result<UsageLimit, Error> {
    let label = Some("API key spending limit".into());
    let KeyLimit::Limited(limit) = key.limit else {
        return Ok(UsageLimit::Unlimited { label });
    };
    let limit = limit.value()?;
    let remaining = key.limit_remaining.ok_or_else(invalid)?.value()?;
    if limit < 0.0 {
        return Err(invalid());
    }
    if limit == 0.0 {
        return Ok(UsageLimit::Balance {
            label,
            amount: remaining,
            unit: Some("USD".into()),
        });
    }
    let used = (limit - remaining).max(0.0);
    let period = match key.limit_reset.as_deref() {
        Some("daily") => Some(UsagePeriod::Duration { seconds: 86_400 }),
        Some("weekly") => Some(UsagePeriod::Duration { seconds: 604_800 }),
        Some("monthly") => Some(UsagePeriod::Monthly),
        _ => None,
    };
    Ok(UsageLimit::Window {
        label,
        period,
        resets_at: None,
        used_percent: used / limit * 100.0,
        quantity: Some(UsageQuantity {
            used,
            limit,
            unit: Some("USD".into()),
        }),
    })
}

#[derive(Deserialize)]
struct AiHubMix {
    // This endpoint calls the remaining budget total_usage.
    total_usage: Amount,
}

fn balance(amount: f64, unit: &str) -> UsageLimit {
    UsageLimit::Balance {
        label: None,
        amount,
        unit: Some(unit.into()),
    }
}

fn invalid() -> Error {
    Error::Invalid("invalid provider balance response".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_limits_accept_decimals() {
        let read = |text| match serde_json::from_str::<KeyLimit>(text).unwrap() {
            KeyLimit::Limited(amount) => Some(amount.value().unwrap()),
            KeyLimit::Unlimited(()) => None,
        };
        assert_eq!(read("12.5"), Some(12.5));
        assert_eq!(read(r#""3.25""#), Some(3.25));
        assert_eq!(read("null"), None);
    }
}
