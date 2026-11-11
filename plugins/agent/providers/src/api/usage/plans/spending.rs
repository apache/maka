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

use super::{FIVE_HOURS, Number, Time, WEEK, bearer, duration, get_json, quantity, share};
use maka_agent_ports::provider::{Context, Error, UsageLimit, UsagePeriod, UsageQuantity};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Ollama {
    included: Option<OllamaIncluded>,
    purchased: Option<OllamaPurchased>,
}

#[derive(Deserialize)]
struct OllamaIncluded {
    balance_usd: Option<Number>,
    allowance_usd: Option<Number>,
    period: Option<OllamaPeriod>,
    session: Option<OllamaWindow>,
    weekly: Option<OllamaWindow>,
}

#[derive(Deserialize)]
struct OllamaPurchased {
    balance_usd: Option<Number>,
}

#[derive(Deserialize)]
struct OllamaPeriod {
    from: Option<String>,
    until: Option<String>,
}

#[derive(Deserialize)]
struct OllamaWindow {
    remaining_percent: Number,
    resets_at: Option<Time>,
}

impl OllamaWindow {
    fn usage(self, label: Option<String>, period: Option<UsagePeriod>) -> Option<UsageLimit> {
        let remaining = self.remaining_percent.value()?;
        Some(UsageLimit::Window {
            label,
            period,
            resets_at: self.resets_at.and_then(Time::seconds),
            used_percent: (100.0 - remaining).max(0.0),
            quantity: None,
        })
    }
}

pub(super) fn ollama(data: Ollama) -> Vec<UsageLimit> {
    let mut limits = Vec::new();
    if let Some(included) = data.included {
        limits.extend(
            included
                .session
                .and_then(|value| value.usage(Some("Session".into()), None)),
        );
        limits.extend(
            included
                .weekly
                .and_then(|value| value.usage(None, Some(duration(WEEK)))),
        );
        if let Some(limit) = included
            .allowance_usd
            .and_then(Number::value)
            .filter(|value| *value > 0.0)
            && let Some(left) = included.balance_usd.and_then(Number::value)
        {
            let (from, until) = included
                .period
                .map(|period| {
                    (
                        period
                            .from
                            .and_then(|value| value.parse::<jiff::Timestamp>().ok()),
                        period
                            .until
                            .and_then(|value| value.parse::<jiff::Timestamp>().ok()),
                    )
                })
                .unwrap_or_default();
            let period = from.zip(until).and_then(|(from, until)| {
                let next_month = from
                    .to_zoned(jiff::tz::TimeZone::UTC)
                    .checked_add(jiff::Span::new().months(1))
                    .ok()
                    .map(|boundary| boundary.timestamp());
                if next_month == Some(until) {
                    Some(UsagePeriod::Monthly)
                } else {
                    let seconds = u32::try_from(until.as_second() - from.as_second()).ok()?;
                    (seconds > 0).then(|| duration(seconds))
                }
            });
            let quantity = UsageQuantity {
                used: (limit - left).max(0.0),
                limit,
                unit: Some("USD".into()),
            };
            if let Some(used_percent) = share(&quantity) {
                limits.push(UsageLimit::Window {
                    label: None,
                    period,
                    resets_at: until.and_then(|time| u64::try_from(time.as_second()).ok()),
                    used_percent,
                    quantity: Some(quantity),
                });
            }
        }
    }
    if let Some(amount) = data
        .purchased
        .and_then(|value| value.balance_usd)
        .and_then(Number::value)
    {
        limits.push(UsageLimit::Balance {
            label: Some("Purchased credits".into()),
            amount,
            unit: Some("USD".into()),
        });
    }
    limits
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CommandCode {
    credits: Option<CommandCredits>,
    window_limits: Option<CommandWindows>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandCredits {
    plan_id: Option<String>,
    monthly_credits: Option<Number>,
    purchased_credits: Option<Number>,
    free_credits: Option<Number>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandWindows {
    five_hour: Option<CommandWindow>,
    weekly: Option<CommandWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandWindow {
    used: Option<Number>,
    cap: Option<Number>,
    reset_at: Option<Time>,
}

impl CommandWindow {
    fn usage(self, period: UsagePeriod) -> Option<UsageLimit> {
        let quantity = quantity(self.used, self.cap, None)?;
        Some(UsageLimit::Window {
            label: None,
            period: Some(period),
            resets_at: self.reset_at.and_then(Time::seconds),
            used_percent: share(&quantity)?,
            quantity: Some(quantity),
        })
    }
}

pub(super) fn command_code(data: CommandCode) -> Vec<UsageLimit> {
    let mut limits = Vec::new();
    if let Some(windows) = data.window_limits {
        limits.extend(
            windows
                .five_hour
                .and_then(|value| value.usage(duration(FIVE_HOURS))),
        );
        limits.extend(windows.weekly.and_then(|value| value.usage(duration(WEEK))));
    }
    if let Some(credits) = data.credits {
        if let Some(amount) = credits.monthly_credits.and_then(Number::value) {
            // The credits API can omit the plan ID, which is needed to determine
            // the monthly cap and whether its credits are USD or usage-value units.
            let unit = match credits.plan_id.as_deref() {
                Some(
                    "individual-go" | "individual-goat" | "individual-pro" | "individual-pro-v1",
                ) => Some("credits".into()),
                Some("individual-max" | "individual-ultra" | "teams-pro") => Some("USD".into()),
                _ => None,
            };
            limits.push(UsageLimit::Balance {
                label: Some("Monthly credits".into()),
                amount,
                unit,
            });
        }
        for (label, value) in [
            ("Purchased credits", credits.purchased_credits),
            ("Free credits", credits.free_credits),
        ] {
            if let Some(amount) = value.and_then(Number::value) {
                limits.push(UsageLimit::Balance {
                    label: Some(label.into()),
                    amount,
                    unit: Some("USD".into()),
                });
            }
        }
    }
    limits
}

#[derive(Deserialize)]
struct MistralIdentity {
    plan_type: Option<String>,
}

#[derive(Deserialize)]
struct MistralBudgets {
    vibe_budget: Option<MistralBudget>,
    api_budget: Option<MistralBudget>,
}

#[derive(Deserialize)]
struct MistralBudget {
    usage_percentage: Number,
    initial_budget: Number,
    currency: Option<String>,
    reset_at: Option<Time>,
}

pub(super) async fn mistral(key: &str, context: &Context) -> Result<Vec<UsageLimit>, Error> {
    let headers = bearer(key);
    let identity: MistralIdentity = get_json(
        context,
        "https://console.mistral.ai/api/vibe/whoami".into(),
        headers.clone(),
    )
    .await?;
    let plan = identity
        .plan_type
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    let plan = match plan.as_deref() {
        Some(plan @ ("chat" | "api")) => plan,
        _ => return Ok(Vec::new()),
    };
    let budgets: MistralBudgets = get_json(
        context,
        "https://api.mistral.ai/v1/billing/budget".into(),
        headers,
    )
    .await?;
    Ok(mistral_budget(plan, budgets).into_iter().collect())
}

fn mistral_budget(plan: &str, budgets: MistralBudgets) -> Option<UsageLimit> {
    let (label, budget) = if plan == "chat" {
        (Some("Vibe".into()), budgets.vibe_budget?)
    } else {
        (Some("API".into()), budgets.api_budget?)
    };
    let limit = budget.initial_budget.value()?;
    if limit == 0.0 {
        return None;
    }
    let used_percent = budget.usage_percentage.value()?;
    let used = limit * (used_percent / 100.0);
    Some(UsageLimit::Window {
        label,
        period: Some(UsagePeriod::Monthly),
        resets_at: budget.reset_at.and_then(Time::seconds),
        used_percent,
        quantity: Some(UsageQuantity {
            used,
            limit,
            unit: budget
                .currency
                .filter(|currency| !currency.trim().is_empty()),
        }),
    })
}
