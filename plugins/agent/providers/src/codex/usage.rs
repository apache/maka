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

use maka_agent_ports::provider::{
    Context, Error, UsageCredential, UsageLimit, UsageLimitsRequest, UsagePeriod,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct AccountUsage {
    rate_limit: Option<Windows>,
    additional_rate_limits: Option<Vec<AdditionalLimit>>,
    credits: Option<Credits>,
}

#[derive(Deserialize)]
struct Credits {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
}

#[derive(Deserialize)]
struct AdditionalLimit {
    limit_name: String,
    rate_limit: Option<Windows>,
}

#[derive(Deserialize)]
struct Windows {
    primary_window: Option<Window>,
    secondary_window: Option<Window>,
}

#[derive(Deserialize)]
struct Window {
    used_percent: u32,
    limit_window_seconds: u32,
    reset_at: u32,
}

pub(super) async fn read(
    request: UsageLimitsRequest,
    context: Context,
) -> Result<Vec<UsageLimit>, Error> {
    super::configuration(&request.connection.configuration)?;
    let UsageCredential::Provider {
        credential,
        request_headers,
    } = request.credential
    else {
        return Err(Error::AuthenticationRequired);
    };
    let headers = super::provider::inspection_headers(
        &request.connection,
        Some(credential),
        request_headers,
    )?;
    let usage: AccountUsage = crate::usage::get_json(
        &context,
        "https://chatgpt.com/backend-api/wham/usage".into(),
        headers,
    )
    .await?;
    let mut limits = Vec::new();
    append(&mut limits, None, usage.rate_limit);
    for additional in usage.additional_rate_limits.into_iter().flatten() {
        let label = additional.limit_name.trim();
        append(&mut limits, Some(label), additional.rate_limit);
    }
    if let Some(credits) = usage.credits {
        if credits.unlimited {
            limits.push(UsageLimit::Unlimited {
                label: Some("Credits".into()),
            });
        } else if credits.has_credits
            && let Some(balance) = credits.balance
        {
            let amount = balance
                .parse()
                .map_err(|_| Error::Invalid("invalid subscription credit balance".into()))?;
            limits.push(UsageLimit::Balance {
                label: None,
                amount,
                unit: Some("credits".into()),
            });
        }
    }
    Ok(limits)
}

fn append(limits: &mut Vec<UsageLimit>, label: Option<&str>, windows: Option<Windows>) {
    if let Some(windows) = windows {
        limits.extend(
            [windows.primary_window, windows.secondary_window]
                .into_iter()
                .flatten()
                .map(|window| UsageLimit::Window {
                    label: label.map(str::to_owned),
                    used_percent: f64::from(window.used_percent),
                    period: (window.limit_window_seconds > 0).then_some(UsagePeriod::Duration {
                        seconds: window.limit_window_seconds,
                    }),
                    resets_at: Some(u64::from(window.reset_at)),
                    quantity: None,
                }),
        );
    }
}
