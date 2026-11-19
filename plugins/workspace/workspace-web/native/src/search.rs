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

use maka_capabilities::call;
use maka_capabilities::http;
use serde_json::Value;
use std::sync::Arc;
use url::Url;

use maka_web_api::{
    search::{Query, Results, Row},
    settings::ResultsMapping,
};

mod endpoint;
#[cfg(test)]
mod tests;
pub(crate) use endpoint::{SearchEndpoint, presets};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("WebSearch requires a nonempty query and a result limit from 1 to 20")]
    Input,
    #[error("WebSearch credentials are not configured")]
    NotConfigured,
    #[error("WebSearch credentials were rejected")]
    InvalidCredentials,
    #[error("WebSearch rate limit exceeded")]
    RateLimited,
    #[error("WebSearch request was cancelled")]
    Cancelled,
    #[error("WebSearch returned HTTP {0}")]
    Status(u16),
    #[error("WebSearch returned an invalid response")]
    Response,
    #[error("WebSearch network request failed")]
    Network,
    #[error("WebSearch network access was denied")]
    Denied,
    #[error(transparent)]
    Settlement(#[from] maka_agent_facts::tools::ToolError),
}

#[derive(Clone)]
pub(crate) struct Search {
    http: Arc<dyn http::Client>,
}
impl Search {
    pub fn new(http: Arc<dyn http::Client>) -> Self {
        Self { http }
    }

    pub async fn query(
        &self,
        parent: &call::Scope,
        endpoint: &SearchEndpoint,
        key: Option<&str>,
        input: &Query,
    ) -> Result<Results, Error> {
        if !input.is_valid() {
            return Err(Error::Input);
        }
        let owned = call::Owned::new(parent.child()?);
        let scope = owned.scope();
        let result = tokio::select! {
            biased;
            _ = scope.cancellation.cancelled() => Err(Error::Cancelled),
            result = self.request(&scope, endpoint, key, input) => result,
        };
        owned.finish().await?;
        result
    }

    async fn request(
        &self,
        scope: &call::Scope,
        endpoint: &SearchEndpoint,
        key: Option<&str>,
        input: &Query,
    ) -> Result<Results, Error> {
        let response = self
            .http
            .request(scope.clone(), endpoint.request(key, input)?)
            .await
            .map_err(network_error)?;
        let result = async {
            match response.head.status {
                200..300 => {}
                401 | 403 => return Err(Error::InvalidCredentials),
                429 => return Err(Error::RateLimited),
                status => return Err(Error::Status(status)),
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.body.next().await.map_err(network_error)? {
                bytes.extend_from_slice(&chunk);
            }
            decode(&bytes, input, &endpoint.config.results)
        }
        .await;
        // Never follow redirects with a search credential.
        response.body.close().await.map_err(network_error)?;
        result
    }
}
fn network_error(error: http::Error) -> Error {
    match error {
        http::Error::Denied => Error::Denied,
        http::Error::CleanupUnconfirmed => {
            Error::Settlement(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
                "WebSearch HTTP cleanup is unconfirmed".into(),
            ))
        }
        _ => Error::Network,
    }
}

fn decode(bytes: &[u8], input: &Query, mapping: &ResultsMapping) -> Result<Results, Error> {
    let response: Value = serde_json::from_slice(bytes).map_err(|_| Error::Response)?;
    let entries = response.pointer(&mapping.list).ok_or(Error::Response)?;
    let entries = if entries.is_null() {
        &[][..]
    } else {
        entries.as_array().ok_or(Error::Response)?.as_slice()
    };
    let rows = entries
        .iter()
        .filter_map(|entry| {
            let url = Url::parse(entry.pointer(&mapping.url)?.as_str()?).ok()?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return None;
            }
            let field = |path: &Option<String>| {
                path.as_deref()
                    .and_then(|path| entry.pointer(path))
                    .and_then(Value::as_str)
            };
            Some(Row {
                title: field(&mapping.title).unwrap_or(url.as_str()).into(),
                snippet: field(&mapping.snippet).unwrap_or_default().into(),
                url: url.into(),
            })
        })
        .take(input.limit)
        .collect::<Vec<_>>();
    let total = entries.len();
    let omitted_results = total - rows.len();
    Ok(Results {
        query: input.query.clone(),
        truncated: omitted_results > 0,
        omitted_results,
        rows,
    })
}

fn native(
    model: &maka_agent_facts::tools::ModelToolContext,
) -> Option<maka_agent_facts::tools::ProviderTool> {
    use maka_agent_facts::tools::ProviderTool;
    use maka_agent_facts::tools::ProviderToolProtocol;
    let protocol = model.provider_tools?;
    if model.capabilities.web_search != Some(true) {
        return None;
    }
    Some(match protocol {
        ProviderToolProtocol::OpenaiResponses => ProviderTool {
            id: "openai.web_search".into(),
            args: serde_json::json!({"searchContextSize":"medium"}),
        },
        ProviderToolProtocol::DeepseekResponses => ProviderTool {
            id: match model.model.as_str() {
                "deepseek-v4-pro" => "deepseek.web_search",
                "deepseek-flash" | "deepseek-v4-flash" => "deepseek.deepseek_web_search",
                _ => return None,
            }
            .into(),
            args: serde_json::json!({}),
        },
        ProviderToolProtocol::AnthropicMessages => ProviderTool {
            id: "anthropic.web_search_20250305".into(),
            args: serde_json::json!({"maxUses":8}),
        },
    })
}

pub enum Selection {
    Provider(maka_agent_facts::tools::ProviderTool),
    Custom,
}

pub fn select(
    capture: &maka_web_api::contract::Capture,
    model: Option<&maka_agent_facts::tools::ModelToolContext>,
) -> Option<Selection> {
    if !capture.available {
        return None;
    }
    if capture.source == maka_web_api::settings::Source::Custom && capture.custom_available {
        return Some(Selection::Custom);
    }
    model
        .and_then(native)
        .map(Selection::Provider)
        .or_else(|| capture.custom_available.then_some(Selection::Custom))
}
