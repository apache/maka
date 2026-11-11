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

use super::{FIVE_HOURS, Number, Time, WEEK, duration, invalid, share};
use maka_agent_ports::provider::{Error, UsageLimit, UsagePeriod, UsageQuantity};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Reply {
    usage: Option<Count>,
    #[serde(default)]
    limits: Vec<TimedCount>,
    usages: Option<Shares>,
    #[serde(alias = "boosterWallet")]
    booster_wallet: Option<Wallet>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimedCount {
    window: Span,
    detail: Count,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Span {
    duration: u32,
    time_unit: String,
}

impl Span {
    fn period(self) -> Option<UsagePeriod> {
        let unit = self.time_unit.trim_start_matches("TIME_UNIT_");
        let scale = match unit {
            "MINUTE" => 60,
            "HOUR" => 3600,
            "DAY" => 86400,
            "WEEK" => WEEK,
            "MONTH" if self.duration == 1 => return Some(UsagePeriod::Monthly),
            _ => return None,
        };
        self.duration
            .checked_mul(scale)
            .filter(|n| *n > 0)
            .map(duration)
    }
}

#[derive(Deserialize)]
struct Count {
    limit: Number,
    used: Option<Number>,
    remaining: Option<Number>,
    #[serde(alias = "resetTime", alias = "resetAt", alias = "reset_at")]
    reset_time: Option<Time>,
}

impl Count {
    fn reading(self, period: Option<UsagePeriod>) -> Option<UsageLimit> {
        let limit = self.limit.value()?;
        if limit == 0.0 {
            return None;
        }
        let used = self
            .used
            .and_then(Number::value)
            .or_else(|| Some((limit - self.remaining?.value()?).max(0.0)))?;
        let quantity = UsageQuantity {
            used,
            limit,
            unit: None,
        };
        Some(UsageLimit::Window {
            label: None,
            period,
            resets_at: self.reset_time.and_then(Time::seconds),
            used_percent: share(&quantity)?,
            quantity: Some(quantity),
        })
    }
}

#[derive(Deserialize, Default)]
struct Shares {
    #[serde(alias = "limit5h")]
    limit_5h: Option<Ratio>,
    #[serde(alias = "limit7d")]
    limit_7d: Option<Ratio>,
    #[serde(alias = "limitMonthTotal")]
    limit_month_total: Option<Ratio>,
    #[serde(alias = "limitMonthCode")]
    limit_month_code: Option<Ratio>,
}

#[derive(Deserialize)]
struct Ratio {
    #[serde(alias = "usedRatio")]
    used_ratio: Number,
    #[serde(alias = "resetTime", alias = "resetAt", alias = "reset_at")]
    reset_time: Option<Time>,
}

impl Ratio {
    fn reading(self, period: UsagePeriod) -> Option<UsageLimit> {
        Some(UsageLimit::Window {
            label: None,
            period: Some(period),
            resets_at: self.reset_time.and_then(Time::seconds),
            used_percent: self.used_ratio.value()? * 100.0,
            quantity: None,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wallet {
    balance: Option<Booster>,
    monthly_charge_limit: Option<Currency>,
    monthly_used: Option<Currency>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Booster {
    #[serde(rename = "type")]
    kind: String,
    amount: Number,
    amount_left: Option<Number>,
}

#[derive(Deserialize)]
struct Currency {
    currency: Option<String>,
}

fn window_order(limit: &UsageLimit) -> u32 {
    match limit {
        UsageLimit::Window {
            period: Some(UsagePeriod::Duration { seconds }),
            ..
        } => *seconds,
        UsageLimit::Window {
            period: Some(UsagePeriod::Monthly),
            ..
        } => u32::MAX - 1,
        _ => u32::MAX,
    }
}

pub(super) fn limits(reply: Reply) -> Result<Vec<UsageLimit>, Error> {
    let mut windows: Vec<_> = reply
        .limits
        .into_iter()
        .filter_map(|entry| entry.detail.reading(entry.window.period()))
        .collect();
    if let Some(weekly) = reply
        .usage
        .and_then(|usage| usage.reading(Some(duration(WEEK))))
    {
        windows.push(weekly);
    }
    let shares = reply.usages.unwrap_or_default();
    // Concrete 5h and 7d counters can be authoritative even when the summary ratios are zero.
    // See MoonshotAI/kimi-code#3951.
    for (reading, period) in [
        (shares.limit_5h, duration(FIVE_HOURS)),
        (shares.limit_7d, duration(WEEK)),
        (
            shares.limit_month_total.or(shares.limit_month_code),
            UsagePeriod::Monthly,
        ),
    ] {
        if let Some(reading) = reading.and_then(|reading| reading.reading(period))
            && !windows
                .iter()
                .any(|existing| window_order(existing) == window_order(&reading))
        {
            windows.push(reading);
        }
    }
    windows.sort_by_key(window_order);
    if let Some(wallet) = reply.booster_wallet
        && let Some(balance) = wallet.balance.filter(|balance| balance.kind == "BOOSTER")
        && balance.amount.value().is_some_and(|amount| amount > 0.0)
    {
        let unit = wallet
            .monthly_charge_limit
            .and_then(|limit| limit.currency)
            .filter(|unit| !unit.trim().is_empty())
            .or_else(|| wallet.monthly_used.and_then(|used| used.currency))
            .filter(|unit| !unit.trim().is_empty())
            .unwrap_or_else(|| "USD".into());
        windows.push(UsageLimit::Balance {
            label: Some("Booster".into()),
            amount: balance.amount_left.and_then(Number::value).unwrap_or(0.0) / 100_000_000.0,
            unit: Some(unit),
        });
    }
    if windows.is_empty() {
        return Err(invalid("Kimi usage"));
    }
    Ok(windows)
}
