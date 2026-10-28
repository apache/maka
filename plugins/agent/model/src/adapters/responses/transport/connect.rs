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

use super::{Result, error};
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::sync::Arc;
use std::{collections::BTreeMap, time::Duration};

/// None permits HTTP fallback: no model request has been dispatched yet.
pub(super) async fn open(
    network: &dyn Transport,
    url: &str,
    headers: &BTreeMap<String, String>,
) -> Result<Option<Arc<dyn Socket>>> {
    let mut request_headers = HeaderMap::new();
    for (name, value) in headers {
        if matches!(
            name.as_str(),
            "host" | "connection" | "upgrade" | "content-length"
        ) {
            continue;
        }
        let name: HeaderName = name
            .parse()
            .map_err(|_| error("invalid Responses WebSocket header"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| error("invalid Responses WebSocket header"))?;
        request_headers
            .try_insert(name, value)
            .map_err(|_| error("Responses WebSocket headers cannot be represented"))?;
    }
    if !request_headers.contains_key("openai-beta") {
        request_headers
            .try_insert(
                "openai-beta",
                HeaderValue::from_static("responses_websockets=2026-02-06"),
            )
            .map_err(|_| error("Responses WebSocket headers cannot be represented"))?;
    }
    // One initial attempt, then five exponential retries. The caller's select
    // owns cancellation and the model idle budget, including these sleeps. No
    // response.create has been sent yet, so reconnecting cannot replay it.
    for attempt in 0..=5 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(100 << (attempt - 1))).await;
        }
        if let Ok(Ok(socket)) = tokio::time::timeout(
            Duration::from_secs(15),
            network.connect(Connect {
                url: url.into(),
                headers: request_headers
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.to_string(),
                            value
                                .as_bytes()
                                .iter()
                                .map(|byte| char::from(*byte))
                                .collect(),
                        )
                    })
                    .collect(),
            }),
        )
        .await
        {
            return Ok(Some(socket));
        }
    }
    Ok(None)
}
