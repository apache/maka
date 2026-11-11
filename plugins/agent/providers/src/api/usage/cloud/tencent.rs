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

use super::{AccessKey, Number, VendorError, hmac, sha256, timestamp};
use crate::usage::request_json;
use jiff::Timestamp;
use maka_agent_ports::provider::{Context, Error, UsageLimit, UsagePeriod, UsageQuantity};
use maka_capabilities::http;
use maka_plugin_core::http::Method;
use serde::Deserialize;
use serde_json::json;

const SERVICE: &str = "tokenhub";
const VERSION: &str = "2026-03-22";

#[derive(Clone, Copy)]
pub(super) enum Region {
    Guangzhou,
    Singapore,
}

impl Region {
    fn endpoint(self) -> (&'static str, &'static str) {
        match self {
            Self::Guangzhou => ("tokenhub.tencentcloudapi.com", "ap-guangzhou"),
            Self::Singapore => ("tokenhub.intl.tencentcloudapi.com", "ap-singapore"),
        }
    }
}

pub(super) async fn read(
    key: &AccessKey,
    context: &Context,
    region: Region,
) -> Result<Vec<UsageLimit>, Error> {
    let team_id = key
        .team_id
        .as_deref()
        .ok_or(Error::AuthenticationRequired)?;
    let body = serde_json::to_vec(&json!({"TeamId": team_id}))
        .map_err(|_| Error::Invalid("invalid TokenHub usage request".into()))?;
    let envelope: Envelope =
        request_json(context, request(key, region, body, Timestamp::now())).await?;
    match envelope.response {
        Response::Failed { error } => Err(error.failure()),
        Response::Data(plan) if plan.team_id == team_id => Ok(plan.limit().into_iter().collect()),
        Response::Data(_) => Err(Error::Invalid("TokenHub returned a different plan".into())),
    }
}

fn request(key: &AccessKey, region: Region, body: Vec<u8>, now: Timestamp) -> http::Request {
    const CONTENT_TYPE: &str = "application/json; charset=utf-8";
    const SIGNED_HEADERS: &str = "content-type;host;x-tc-action";
    const ALGORITHM: &str = "TC3-HMAC-SHA256";

    const ACTION: &str = "DescribeTokenPlan";
    let (host, region) = region.endpoint();
    let date = now.strftime("%Y-%m-%d").to_string();
    let time = now.as_second();
    let payload_hash = sha256(&body);
    let lower_action = ACTION.to_ascii_lowercase();
    let canonical = format!(
        "POST\n/\n\ncontent-type:{CONTENT_TYPE}\nhost:{host}\nx-tc-action:{lower_action}\n\n{SIGNED_HEADERS}\n{payload_hash}"
    );
    let scope = format!("{date}/{SERVICE}/tc3_request");
    let canonical_hash = sha256(canonical.as_bytes());
    let message = format!("{ALGORITHM}\n{time}\n{scope}\n{canonical_hash}");
    let initial_key = format!("TC3{}", key.secret_access_key);
    let date_key = hmac(initial_key.as_bytes(), &date);
    let service_key = hmac(&date_key, SERVICE);
    let signing_key = hmac(&service_key, "tc3_request");
    let signature = hex::encode(hmac(&signing_key, &message));
    let authorization = format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}",
        key.access_key_id
    );
    http::Request {
        url: format!("https://{host}/"),
        method: Method::Post,
        headers: vec![
            ("authorization".into(), authorization),
            ("content-type".into(), CONTENT_TYPE.into()),
            ("x-tc-action".into(), ACTION.into()),
            ("x-tc-region".into(), region.into()),
            ("x-tc-timestamp".into(), time.to_string()),
            ("x-tc-version".into(), VERSION.into()),
        ],
        body: body.into(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Envelope {
    response: Response,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Response {
    Failed {
        #[serde(rename = "Error")]
        error: VendorError,
    },
    Data(Plan),
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Plan {
    team_id: String,
    name: Option<String>,
    package_info: Option<Package>,
    token_summary: Option<Cycle>,
    product_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Package {
    total_used: Number,
    total_quota: Option<Number>,
    total_cycles: Option<u32>,
    cycle_unit: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Cycle {
    cycle_end_time: String,
}

impl Plan {
    fn limit(self) -> Option<UsageLimit> {
        let package = self.package_info?;
        let used = package.total_used.nonnegative()?;
        let limit = package
            .total_quota?
            .nonnegative()
            .filter(|&limit| limit > 0.0)?;
        // TokenHub reports cumulative TotalUsed. Pair it with TotalQuota, and
        // attach a monthly reset only when the entire package is one cycle.
        let monthly =
            package.total_cycles == Some(1) && package.cycle_unit.as_deref() == Some("month");
        let name = self
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty() && !name.chars().any(char::is_control))
            .unwrap_or(&self.team_id);
        let label = if monthly {
            name.to_owned()
        } else {
            format!("{name} · Plan total")
        };
        let unit = match self.product_type.as_deref() {
            Some("enterprise") => Some("credits".into()),
            Some("enterprise-auto") => Some("tokens".into()),
            _ => None,
        };
        Some(UsageLimit::Window {
            label: Some(label),
            period: monthly.then_some(UsagePeriod::Monthly),
            resets_at: self
                .token_summary
                .filter(|_| monthly)
                .and_then(|summary| timestamp(&summary.cycle_end_time)),
            used_percent: 100.0 * used / limit,
            quantity: Some(UsageQuantity { used, limit, unit }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;

    #[tokio::test]
    async fn singapore_usage_signs_the_selected_plan_and_preserves_package_totals() {
        let key = AccessKey {
            access_key_id: "fixture-ak".into(),
            secret_access_key: "fixture-secret".into(),
            team_id: Some("tp-ent-selected".into()),
        };
        let body = br#"{"TeamId":"tp-ent-selected"}"#;
        let outgoing = request(
            &key,
            Region::Singapore,
            body.to_vec(),
            "2026-11-11T00:00:00Z".parse().unwrap(),
        );
        assert_eq!(outgoing.url, "https://tokenhub.intl.tencentcloudapi.com/");
        let headers: std::collections::BTreeMap<_, _> = outgoing.headers.into_iter().collect();
        assert_eq!(headers["x-tc-region"], "ap-singapore");
        assert_eq!(headers["x-tc-action"], "DescribeTokenPlan");
        assert_eq!(
            headers["authorization"],
            "TC3-HMAC-SHA256 Credential=fixture-ak/2026-11-11/tokenhub/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=4a61a41207b998d9d21abf28f6b06994b7d2863f6de1b3fcb97551001a3f4a89"
        );
        let chunks: Vec<_> = outgoing.body.into_stream().try_collect().await.unwrap();
        assert_eq!(chunks.concat(), body);

        // Parse text, as the HTTP reader does: decimals take a different path than in a Value.
        let plan: Plan = serde_json::from_str(
            &json!({
                "TeamId": "tp-ent-selected",
                "Name": "Development",
                "ProductType": "enterprise",
                "PackageInfo": {
                    "TotalUsed": "150", "TotalQuota": 600.0, "CycleQuota": "100",
                    "TotalCycles": 6, "CycleUnit": "month"
                },
                "TokenSummary": {"CycleEndTime": "2026-12-01T00:00:00+08:00"}
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(plan.limit().unwrap()).unwrap(),
            json!({
                "kind": "window",
                "label": "Development · Plan total",
                "usedPercent": 25.0,
                "quantity": {"used":150.0, "limit":600.0, "unit":"credits"}
            })
        );
    }
}
