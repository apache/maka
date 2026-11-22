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

use crate::Policy;
use maka_agent_facts::configuration::policy::NetworkProxy;
use maka_agent_facts::configuration::policy::network_test::Output;
use std::{net::IpAddr, time::Duration};
use tokio::time::{Instant, timeout_at};

/// A diagnostic proves the proxy route, even when ordinary traffic would bypass it.
/// Every response body is bounded; the same deadline covers body and country lookup.
pub async fn probe(
    settings: &NetworkProxy,
    password: Option<&str>,
    url: Option<&str>,
    timeout_ms: Option<u64>,
) -> Output {
    if !settings.enabled {
        return Output::failed("Proxy disabled");
    }
    if settings.host.trim().is_empty() || settings.port == 0 {
        return Output::failed("Proxy host/port required");
    }
    let mut forced = settings.clone();
    forced.bypass_list.clear();
    forced.auto_bypass_domains.clear();
    let policy = match Policy::from_settings(&forced, password) {
        Ok(policy) => policy,
        Err(crate::Error::MissingCredentials) => {
            return Output::failed("Proxy credential is not configured");
        }
        Err(_) => return Output::failed("Invalid proxy configuration"),
    };
    let client = match policy.client_builder().pool_max_idle_per_host(0).build() {
        Ok(client) => client,
        Err(_) => return Output::failed("Cannot initialize network client"),
    };
    let start = Instant::now();
    let deadline = start + Duration::from_millis(timeout_ms.unwrap_or(8000).clamp(1, 30_000));
    let first = async {
        let response = client
            .get(url.unwrap_or("https://icanhazip.com"))
            .send()
            .await
            .map_err(|_| "Proxy request failed")?;
        let latency_ms = millis(start);
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Ok(Output {
                status: Some(status),
                latency_ms,
                ..Output::failed(format!("HTTP {status}"))
            });
        }
        let bytes = body(response, 1024).await?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "Invalid proxy probe response")?
            .trim();
        if text.len() > 256 {
            return Err("Proxy probe response exceeds limit");
        }
        Ok(Output {
            ok: true,
            status: Some(status),
            latency_ms,
            ip: (!text.is_empty()).then(|| text.to_owned()),
            ..Output::default()
        })
    };
    let mut result = match timeout_at(deadline, first).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => {
            return Output {
                latency_ms: millis(start),
                ..Output::failed(error)
            };
        }
        Err(_) => {
            return Output {
                latency_ms: millis(start),
                ..Output::failed("Proxy test timeout")
            };
        }
    };
    // Country information is optional. Invalid text is never interpolated into a URL.
    if let Some(ip) = result.ip.as_ref().and_then(|s| s.parse::<IpAddr>().ok())
        && let Ok(Some(country)) = timeout_at(deadline, country(&client, ip)).await
    {
        result.country_flag = Some(
            country
                .bytes()
                .filter_map(|c| char::from_u32(127_397 + u32::from(c)))
                .collect(),
        );
        result.country_code = Some(country);
    }
    result
}
fn millis(start: Instant) -> u64 {
    (start.elapsed().as_millis().min(300_000)) as u64
}
async fn body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, &'static str> {
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Proxy response failed")?
    {
        if chunk.len() > limit - data.len() {
            return Err("Proxy probe response exceeds limit");
        }
        data.extend_from_slice(&chunk);
    }
    Ok(data)
}
async fn country(client: &reqwest::Client, ip: IpAddr) -> Option<String> {
    let response = client
        .get(format!("https://api.country.is/{ip}"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body(response, 4096).await.ok()?).ok()?;
    let code = value.get("country")?.as_str()?;
    (code.len() == 2 && code.bytes().all(|c| c.is_ascii_alphabetic()))
        .then(|| code.to_ascii_uppercase())
}
