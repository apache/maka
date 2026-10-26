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

use super::{ApiProvider, Configuration, authentication, effects, inventory};
use crate::facts::{
    adapter::AdapterKind,
    discovery::{DiscoveryAuth, ModelDiscovery, ModelFilter, ModelProtocols, ResponseShape},
};
use effects::HeaderAuth;
use maka_agent_facts::configuration::ApiProtocol;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_ports::model::Credentials;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Discovery;
use maka_agent_ports::provider::Error;
use maka_capabilities::http;
use serde_json::Value;
use std::collections::BTreeMap;
use url::Url;

mod pages;

pub(super) async fn discover(
    provider: &ApiProvider,
    request: Discovery,
    context: Context,
) -> Result<Vec<ModelInfo>, Error> {
    let configuration = Configuration::read(&request.connection)?;
    let declaration = &provider.facts.model_discovery;
    if matches!(declaration, ModelDiscovery::Fallback { .. }) {
        return Ok(provider
            .facts
            .fallback_models
            .iter()
            .map(ModelInfo::new)
            .collect());
    }
    let anonymous = matches!(
        declaration,
        ModelDiscovery::Protocol {
            auth: Some(DiscoveryAuth::None),
            ..
        }
    );
    let credentials = if anonymous {
        Credentials::RequestHeaders(BTreeMap::new())
    } else {
        authentication::authorize(provider.facts.auth_kind, request.credential)?
    };
    let kind = if matches!(
        provider.facts.runtime_adapter.kind,
        AdapterKind::Anthropic { .. }
    ) {
        HeaderAuth::Anthropic
    } else {
        HeaderAuth::Bearer
    };
    let headers = effects::headers(kind, credentials, request.request_headers)?;
    let client = InventoryClient { context, headers };
    let base = endpoint(&configuration.base_url)?;
    match declaration {
        ModelDiscovery::Protocol {
            auth,
            path,
            query,
            response_shape,
            model_protocols,
            filter,
        } => {
            if matches!(
                auth,
                Some(
                    DiscoveryAuth::OpenaiCodex
                        | DiscoveryAuth::GithubCopilot
                        | DiscoveryAuth::OauthBearer
                )
            ) {
                return Err(Error::Unavailable);
            }
            let mut url = base;
            match &provider.facts.runtime_adapter.kind {
                AdapterKind::Google { .. } => {
                    version(&mut url, "v1beta");
                    append(&mut url, "models");
                    let mut client = client;
                    if let Some(value) = client.headers.remove("authorization") {
                        let key = value.strip_prefix("Bearer ").ok_or_else(invalid)?;
                        url.query_pairs_mut().append_pair("key", key);
                    }
                    let root = client.get(url).await?;
                    return normalize(names(rows(&root, "models")?, true));
                }
                AdapterKind::Anthropic { .. } => {
                    version(&mut url, "v1");
                    append(&mut url, "models");
                }
                AdapterKind::Openai { .. } | AdapterKind::OpenaiCompatible { .. } => {
                    if let Some(path) = path {
                        url = url.join(path).map_err(|_| invalid())?;
                        if url.origin() != endpoint(&configuration.base_url)?.origin() {
                            return Err(Error::Invalid(
                                "model inventory path changes origin".into(),
                            ));
                        }
                    } else {
                        append(&mut url, "models");
                    }
                }
                _ => return Err(Error::Unavailable),
            }
            if let Some(query) = query {
                url.query_pairs_mut().extend_pairs(query);
            }
            let root = client.get(url).await?;
            let raw =
                if matches!(response_shape, Some(ResponseShape::ArrayOrData)) && root.is_array() {
                    array(&root)?
                } else {
                    rows(&root, "data")?
                };
            let filtered = raw.iter().filter(|row| {
                !matches!(filter, Some(ModelFilter::LanguageModels))
                    || row.get("type").and_then(Value::as_str) == Some("language")
            });
            let mut models = inventory::from_rows(provider.id, filtered).map_err(|_| invalid())?;
            if matches!(filter, Some(ModelFilter::ToolCapable)) {
                models.retain(|model| {
                    model
                        .capabilities
                        .is_some_and(|c| c.function_calling == Some(true))
                });
            }
            if matches!(model_protocols, Some(ModelProtocols::Commandcode)) {
                for model in &mut models {
                    let id = model.id.to_ascii_lowercase();
                    if id
                        .strip_prefix("anthropic/")
                        .unwrap_or(&id)
                        .starts_with("claude-")
                    {
                        model.api_protocol = Some(ApiProtocol::AnthropicMessages);
                    }
                }
            }
            Ok(models)
        }
        ModelDiscovery::Ollama => {
            let mut url = base;
            strip_suffix(&mut url, "/v1");
            append(&mut url, "api/tags");
            let root = client.get(url).await?;
            normalize(names(rows(&root, "models")?, false))
        }
        ModelDiscovery::Cohere => pages::cohere(&client, base).await,
        ModelDiscovery::Cloudflare => pages::cloudflare(&client, base).await,
        ModelDiscovery::Fireworks {
            accounts_path,
            public_account,
            query,
        } => pages::fireworks(&client, base, accounts_path, public_account, query).await,
        ModelDiscovery::Fallback { .. } => unreachable!("handled before authentication"),
    }
}

struct InventoryClient {
    context: Context,
    headers: BTreeMap<String, String>,
}

impl InventoryClient {
    async fn get(&self, url: Url) -> Result<Value, Error> {
        let bytes = effects::send(
            &self.context,
            http::Request {
                url: url.into(),
                method: http::Method::Get,
                headers: self.headers.clone().into_iter().collect(),
                body: Default::default(),
            },
            effects::ResponseBody::Inventory,
        )
        .await?;
        let text = String::from_utf8_lossy(&bytes);
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| invalid())
    }
}

fn endpoint(base: &str) -> Result<Url, Error> {
    let mut url = Url::parse(base).map_err(|_| invalid())?;
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

fn append(url: &mut Url, path: &str) {
    url.set_path(&format!("{}/{}", url.path().trim_end_matches('/'), path));
}

fn strip_suffix(url: &mut Url, suffix: &str) {
    let path = url.path().trim_end_matches('/');
    let path = if path.to_ascii_lowercase().ends_with(suffix) {
        &path[..path.len() - suffix.len()]
    } else {
        path
    }
    .to_owned();
    url.set_path(&path);
}

fn version(url: &mut Url, version: &str) {
    strip_suffix(url, &format!("/{version}"));
    append(url, version);
}

fn invalid() -> Error {
    Error::Invalid("invalid model inventory".into())
}

fn array(value: &Value) -> Result<&[Value], Error> {
    let rows = value.as_array().ok_or_else(invalid)?;
    if rows.iter().any(|row| !row.is_object()) {
        return Err(invalid());
    }
    Ok(rows)
}

fn rows<'a>(root: &'a Value, key: &str) -> Result<&'a [Value], Error> {
    if !root.is_object() {
        return Err(invalid());
    }
    match root.get(key) {
        None => Ok(&[]),
        Some(value) => array(value),
    }
}

fn names(rows: &[Value], basename: bool) -> Vec<ModelInfo> {
    rows.iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?;
            Some(ModelInfo::new(if basename {
                name.rsplit('/').next()?
            } else {
                name
            }))
        })
        .collect()
}

fn normalize(models: Vec<ModelInfo>) -> Result<Vec<ModelInfo>, Error> {
    inventory::normalize(models).map_err(|_| invalid())
}
