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
use jiff::Timestamp;
use maka_agent_ports::provider::{Context, Error, UsageLimit, UsagePeriod, UsageQuantity};
use serde::Deserialize;
use url::Url;

const USD: &str = "USD";
const QUOTA_UNITS: &str = "quota units";
const KEY_LIMIT: &str = "API key spending limit";
const SUBSCRIPTION_LIMIT: &str = "Subscription limit";
const DAY: u32 = 86_400;
const WEEK: u32 = 7 * DAY;

pub(super) enum Source {
    Sub2Api,
    NewApi,
}

pub(super) fn source(id: &str) -> Option<Source> {
    match id {
        "sub2api" => Some(Source::Sub2Api),
        "new-api" => Some(Source::NewApi),
        _ => None,
    }
}

impl Source {
    pub(super) async fn read(
        self,
        base: &Url,
        key: &str,
        context: &Context,
    ) -> Result<Vec<UsageLimit>, Error> {
        match self {
            Self::Sub2Api => {
                let url = usage_url(base, "/v1/usage");
                let reply: Sub2ApiUsage = get_json(context, url.into(), bearer(key)).await?;
                reply.limits()
            }
            Self::NewApi => {
                let url = usage_url(base, "/api/usage/token/");
                let reply: NewApiUsage = get_json(context, url.into(), bearer(key)).await?;
                reply.limits()
            }
        }
    }
}

fn usage_url(base: &Url, route: &str) -> Url {
    let path = base.path().trim_end_matches('/');
    let prefix = path.strip_suffix("/v1").unwrap_or(path);
    let mut url = base.clone();
    url.set_path(&format!("{prefix}{route}"));
    url
}

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
enum Sub2ApiUsage {
    QuotaLimited {
        #[serde(rename = "isValid")]
        valid: bool,
        quota: Option<Quota>,
        #[serde(default)]
        rate_limits: Vec<RateLimit>,
    },
    Unrestricted {
        balance: Option<f64>,
        subscription: Option<Subscription>,
    },
}

#[derive(Deserialize)]
struct Quota {
    limit: f64,
    used: f64,
}

#[derive(Deserialize)]
struct RateLimit {
    window: String,
    limit: f64,
    used: f64,
    reset_at: Option<String>,
}

#[derive(Deserialize)]
struct Subscription {
    daily_limit_usd: Option<f64>,
    daily_usage_usd: f64,
    weekly_limit_usd: Option<f64>,
    weekly_usage_usd: f64,
    monthly_limit_usd: Option<f64>,
    monthly_usage_usd: f64,
}

impl Sub2ApiUsage {
    fn limits(self) -> Result<Vec<UsageLimit>, Error> {
        let mut limits = Vec::new();
        match self {
            Self::QuotaLimited {
                valid,
                quota,
                rate_limits,
            } => {
                if !valid {
                    return Err(Error::AuthenticationRequired);
                }
                if let Some(quota) = quota {
                    limits.push(window(
                        Some(KEY_LIMIT),
                        None,
                        None,
                        quota.used,
                        quota.limit,
                        USD,
                    )?);
                }
                for rate in rate_limits {
                    let (label, period) = match rate.window.as_str() {
                        "5h" => (None, duration(5 * 3600)),
                        "1d" => (None, duration(DAY)),
                        "7d" => (None, duration(WEEK)),
                        name => (Some(name), None),
                    };
                    let resets_at = rate.reset_at.as_deref().map(reset_time).transpose()?;
                    limits.push(window(
                        label, period, resets_at, rate.used, rate.limit, USD,
                    )?);
                }
            }
            Self::Unrestricted {
                balance,
                subscription,
            } => {
                if let Some(subscription) = subscription {
                    for (cap, used, period) in [
                        (
                            subscription.daily_limit_usd,
                            subscription.daily_usage_usd,
                            duration(DAY),
                        ),
                        (
                            subscription.weekly_limit_usd,
                            subscription.weekly_usage_usd,
                            duration(WEEK),
                        ),
                        (
                            subscription.monthly_limit_usd,
                            subscription.monthly_usage_usd,
                            Some(UsagePeriod::Monthly),
                        ),
                    ] {
                        if let Some(cap) = cap.filter(|value| *value > 0.0) {
                            limits.push(window(None, period, None, used, cap, USD)?);
                        }
                    }
                    if limits.is_empty() {
                        limits.push(unlimited(SUBSCRIPTION_LIMIT));
                    }
                } else if let Some(balance) = balance {
                    limits.push(remaining(None, balance, USD));
                }
            }
        }
        Ok(limits)
    }
}

#[derive(Deserialize)]
struct NewApiUsage {
    code: Option<bool>,
    data: Option<TokenUsage>,
}

#[derive(Deserialize)]
struct TokenUsage {
    unlimited_quota: bool,
    total_granted: f64,
    total_used: f64,
    total_available: f64,
    user_quota: Option<UserQuota>,
}

#[derive(Deserialize)]
struct UserQuota {
    total_available: f64,
}

impl NewApiUsage {
    fn limits(self) -> Result<Vec<UsageLimit>, Error> {
        if self.code != Some(true) {
            return Err(Error::Rejected("relay usage query rejected".into()));
        }
        let data = self.data.ok_or_else(invalid)?;
        let key = if data.unlimited_quota {
            unlimited(KEY_LIMIT)
        } else if data.total_granted > 0.0 {
            window(
                Some(KEY_LIMIT),
                None,
                None,
                data.total_used,
                data.total_granted,
                QUOTA_UNITS,
            )?
        } else {
            remaining(Some("API key balance"), data.total_available, QUOTA_UNITS)
        };
        let mut limits = vec![key];
        if let Some(owner) = data.user_quota {
            limits.push(remaining(
                Some("Account balance"),
                owner.total_available,
                QUOTA_UNITS,
            ));
        }
        Ok(limits)
    }
}

fn duration(seconds: u32) -> Option<UsagePeriod> {
    Some(UsagePeriod::Duration { seconds })
}

fn reset_time(value: &str) -> Result<u64, Error> {
    let timestamp = value.parse::<Timestamp>().map_err(|_| invalid())?;
    u64::try_from(timestamp.as_second()).map_err(|_| invalid())
}

fn window(
    label: Option<&str>,
    period: Option<UsagePeriod>,
    resets_at: Option<u64>,
    used: f64,
    limit: f64,
    unit: &str,
) -> Result<UsageLimit, Error> {
    if used < 0.0 || limit <= 0.0 {
        return Err(invalid());
    }
    Ok(UsageLimit::Window {
        label: label.map(str::to_owned),
        period,
        resets_at,
        used_percent: used / limit * 100.0,
        quantity: Some(UsageQuantity {
            used,
            limit,
            unit: Some(unit.into()),
        }),
    })
}

fn remaining(label: Option<&str>, amount: f64, unit: &str) -> UsageLimit {
    UsageLimit::Balance {
        label: label.map(str::to_owned),
        amount,
        unit: Some(unit.into()),
    }
}

fn unlimited(label: &str) -> UsageLimit {
    UsageLimit::Unlimited {
        label: Some(label.into()),
    }
}

fn invalid() -> Error {
    Error::Invalid("invalid relay usage response".into())
}
