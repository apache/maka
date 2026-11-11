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

use super::{AccessKey, Number, VendorError, hmac, sha256};
use crate::usage::request_json;
use jiff::Timestamp;
use maka_agent_ports::provider::{Context, Error, UsageLimit, UsagePeriod, UsageQuantity};
use maka_capabilities::http;
use maka_plugin_core::http::Method;
use serde::Deserialize;

const REGION: &str = "cn-beijing";
const SERVICE: &str = "ark";
const VERSION: &str = "2024-01-01";

pub(super) enum Plan {
    Coding,
    Agent,
}

pub(super) async fn read(
    key: &AccessKey,
    context: &Context,
    plan: Plan,
) -> Result<Vec<UsageLimit>, Error> {
    match plan {
        Plan::Coding => {
            let envelope: Envelope<CodingUsage> = request_json(
                context,
                request(
                    key,
                    "open.volcengineapi.com",
                    "GetCodingPlanUsage",
                    Timestamp::now(),
                ),
            )
            .await?;
            Ok(envelope
                .result()?
                .map(CodingUsage::limits)
                .unwrap_or_default())
        }
        Plan::Agent => {
            let envelope: Envelope<AgentUsage> = request_json(
                context,
                request(
                    key,
                    "ark.cn-beijing.volcengineapi.com",
                    "GetAFPUsage",
                    Timestamp::now(),
                ),
            )
            .await?;
            Ok(envelope
                .result()?
                .map(AgentUsage::limits)
                .unwrap_or_default())
        }
    }
}

fn request(key: &AccessKey, host: &str, action: &str, now: Timestamp) -> http::Request {
    const CONTENT_TYPE: &str = "application/json";
    const SIGNED_HEADERS: &str = "content-type;host;x-content-sha256;x-date";
    const ALGORITHM: &str = "HMAC-SHA256";
    const BODY: &[u8] = b"{}";

    let query = format!("Action={action}&Version={VERSION}");
    let date = now.strftime("%Y%m%d").to_string();
    let time = now.strftime("%Y%m%dT%H%M%SZ").to_string();
    let payload_hash = sha256(BODY);
    let canonical = format!(
        "POST\n/\n{query}\ncontent-type:{CONTENT_TYPE}\nhost:{host}\nx-content-sha256:{payload_hash}\nx-date:{time}\n\n{SIGNED_HEADERS}\n{payload_hash}"
    );
    let scope = format!("{date}/{REGION}/{SERVICE}/request");
    let canonical_hash = sha256(canonical.as_bytes());
    let message = format!("{ALGORITHM}\n{time}\n{scope}\n{canonical_hash}");
    let date_key = hmac(key.secret_access_key.as_bytes(), &date);
    let regional_key = hmac(&date_key, REGION);
    let service_key = hmac(&regional_key, SERVICE);
    let signing_key = hmac(&service_key, "request");
    let signature = hex::encode(hmac(&signing_key, &message));
    let authorization = format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}",
        key.access_key_id
    );
    http::Request {
        url: format!("https://{host}/?{query}"),
        method: Method::Post,
        headers: vec![
            ("authorization".into(), authorization),
            ("content-type".into(), CONTENT_TYPE.into()),
            ("x-content-sha256".into(), payload_hash),
            ("x-date".into(), time),
        ],
        body: BODY.to_vec().into(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Envelope<T> {
    response_metadata: Metadata,
    result: Option<T>,
}

impl<T> Envelope<T> {
    fn result(self) -> Result<Option<T>, Error> {
        if let Some(error) = self.response_metadata.error {
            return Err(error.failure());
        }
        Ok(self.result)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Metadata {
    error: Option<VendorError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CodingUsage {
    quota_usage: Vec<CodingWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CodingWindow {
    level: String,
    percent: Number,
    reset_timestamp: Option<Number>,
}

impl CodingUsage {
    fn limits(self) -> Vec<UsageLimit> {
        self.quota_usage
            .into_iter()
            .filter_map(|window| {
                let period = match window.level.as_str() {
                    "session" => FIVE_HOURS,
                    "weekly" => WEEK,
                    "monthly" => UsagePeriod::Monthly,
                    _ => return None,
                };
                Some(UsageLimit::Window {
                    label: None,
                    period: Some(period),
                    resets_at: window.reset_timestamp.and_then(|time| time.unix_seconds()),
                    used_percent: window.percent.nonnegative()?,
                    quantity: None,
                })
            })
            .collect()
    }
}

const FIVE_HOURS: UsagePeriod = UsagePeriod::Duration { seconds: 5 * 3600 };
const WEEK: UsagePeriod = UsagePeriod::Duration {
    seconds: 7 * 24 * 3600,
};

#[derive(Deserialize)]
struct AgentUsage {
    #[serde(rename = "AFPFiveHour")]
    five_hour: Option<AgentWindow>,
    #[serde(rename = "AFPDaily")]
    daily: Option<AgentWindow>,
    #[serde(rename = "AFPWeekly")]
    weekly: Option<AgentWindow>,
    #[serde(rename = "AFPMonthly")]
    monthly: Option<AgentWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AgentWindow {
    used: Number,
    quota: Number,
    reset_time: Option<u64>,
}

impl AgentUsage {
    fn limits(self) -> Vec<UsageLimit> {
        [
            (FIVE_HOURS, self.five_hour),
            (UsagePeriod::Duration { seconds: 24 * 3600 }, self.daily),
            (WEEK, self.weekly),
            (UsagePeriod::Monthly, self.monthly),
        ]
        .into_iter()
        .filter_map(|(period, value)| value?.limit(period))
        .collect()
    }
}

impl AgentWindow {
    fn limit(self, period: UsagePeriod) -> Option<UsageLimit> {
        let used = self.used.nonnegative()?;
        let limit = self.quota.nonnegative().filter(|&limit| limit > 0.0)?;
        Some(UsageLimit::Window {
            label: None,
            period: Some(period),
            resets_at: self
                .reset_time
                .filter(|time| *time > 0)
                .map(|time| time / 1000),
            used_percent: 100.0 * used / limit,
            quantity: Some(UsageQuantity {
                used,
                limit,
                unit: Some("AFP".into()),
            }),
        })
    }
}
