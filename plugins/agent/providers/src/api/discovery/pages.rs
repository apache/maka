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

use super::{InventoryClient, append, invalid, names, normalize, rows, strip_suffix};
use futures_util::{StreamExt, TryStreamExt, stream};
use maka_agent_facts::configuration::ModelCapabilities;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_ports::provider::Error;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use url::Url;

pub(super) async fn cohere(
    client: &InventoryClient,
    mut base: Url,
) -> Result<Vec<ModelInfo>, Error> {
    strip_suffix(&mut base, "/v2");
    append(&mut base, "v1/models");
    base.query_pairs_mut()
        .extend_pairs([("endpoint", "chat"), ("page_size", "1000")]);
    let raw = fetch_pages(client, base, Pagination::CohereModels).await?;
    let mut models = Vec::new();
    for row in raw {
        let Some(name) = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        if row.get("is_deprecated").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let endpoints = match row.get("endpoints") {
            None => continue,
            Some(Value::Array(values)) => values,
            _ => return Err(invalid()),
        };
        if !endpoints.iter().any(|value| value.as_str() == Some("chat")) {
            continue;
        }
        let mut model = ModelInfo::new(name);
        model.context_window = token_limit(row.get("context_length"));
        models.push(model);
    }
    normalize(models)
}

pub(super) async fn cloudflare(
    client: &InventoryClient,
    mut base: Url,
) -> Result<Vec<ModelInfo>, Error> {
    let path = base.path().trim_end_matches('/');
    let Some(root) = path.strip_suffix("/ai/v1") else {
        return Err(Error::Invalid(
            "Cloudflare endpoint must end with /ai/v1".into(),
        ));
    };
    base.set_path(&format!("{root}/ai/models/search"));
    base.set_query(None);
    base.query_pairs_mut()
        .extend_pairs([("per_page", "50"), ("task", "Text Generation")]);
    let mut models = Vec::new();
    // Ask for an empty terminal page; a short page alone does not prove exhaustion.
    let mut page = 1u64;
    loop {
        let mut url = base.clone();
        url.query_pairs_mut().append_pair("page", &page.to_string());
        let root = client.get(url).await?;
        if root.get("success").and_then(Value::as_bool) != Some(true)
            || root.get("result").is_none()
        {
            return Err(invalid());
        }
        let items = rows(&root, "result")?;
        if items.is_empty() {
            return normalize(models);
        }
        models.extend(names(items, false));
        page = page.checked_add(1).ok_or_else(invalid)?;
    }
}

pub(super) async fn fireworks(
    client: &InventoryClient,
    mut base: Url,
    accounts_path: &str,
    public_account: &str,
    query: &BTreeMap<String, String>,
) -> Result<Vec<ModelInfo>, Error> {
    strip_suffix(&mut base, "/inference/v1");
    let mut accounts_url = base.clone();
    append(&mut accounts_url, accounts_path.trim_start_matches('/'));
    accounts_url
        .query_pairs_mut()
        .append_pair("pageSize", "200");
    let raw = fetch_pages(client, accounts_url, Pagination::FireworksAccounts).await?;
    let mut seen = HashSet::new();
    let accounts: Vec<_> = raw
        .iter()
        .filter_map(|row| row.get("name").and_then(Value::as_str))
        .chain(std::iter::once(public_account))
        .filter(|name| {
            name.strip_prefix("accounts/")
                .is_some_and(|id| !id.is_empty() && !id.contains('/') && !matches!(id, "." | ".."))
        })
        .filter(|name| seen.insert((*name).to_owned()))
        .map(str::to_owned)
        .collect();
    // Preserve account order while limiting in-flight requests and response ownership.
    let mut batches = stream::iter(accounts.into_iter().map(|account| {
        let mut url = base.clone();
        // Account names came from the provider, not from trusted URL syntax.
        {
            let id = account
                .strip_prefix("accounts/")
                .expect("validated account");
            url.path_segments_mut()
                .expect("HTTP URL")
                .pop_if_empty()
                .extend(["v1", "accounts", id, "models"]);
        }
        url.query_pairs_mut().extend_pairs(query);
        async move { fetch_pages(client, url, Pagination::FireworksModels).await }
    }))
    .buffered(4);
    let mut models = Vec::new();
    while let Some(batch) = batches.try_next().await? {
        for row in batch {
            let Some(name) = row
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            else {
                continue;
            };
            let mut model = ModelInfo::new(name);
            model.display_name = row
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_owned);
            model.context_window = token_limit(row.get("contextLength"));
            let vision = row.get("supportsImageInput").and_then(Value::as_bool);
            let function_calling = row.get("supportsTools").and_then(Value::as_bool);
            if vision.is_some() || function_calling.is_some() {
                model.capabilities = Some(ModelCapabilities {
                    vision,
                    function_calling,
                    ..Default::default()
                });
            }
            models.push(model);
        }
    }
    normalize(models)
}

#[derive(Clone, Copy)]
enum Pagination {
    CohereModels,
    FireworksAccounts,
    FireworksModels,
}

async fn fetch_pages(
    client: &InventoryClient,
    base: Url,
    pagination: Pagination,
) -> Result<Vec<Value>, Error> {
    let (field, token_field, token_parameter) = match pagination {
        Pagination::CohereModels => ("models", "next_page_token", "page_token"),
        Pagination::FireworksAccounts => ("accounts", "nextPageToken", "pageToken"),
        Pagination::FireworksModels => ("models", "nextPageToken", "pageToken"),
    };
    let mut seen = HashSet::new();
    let mut token: Option<String> = None;
    let mut items = Vec::new();
    loop {
        let mut url = base.clone();
        if let Some(token) = &token {
            url.query_pairs_mut().append_pair(token_parameter, token);
        }
        let root = client.get(url).await?;
        let page = rows(&root, field)?;
        items.extend_from_slice(page);
        let next = match root.get(token_field) {
            None | Some(Value::Null) => return Ok(items),
            Some(Value::String(value)) if value.is_empty() => return Ok(items),
            Some(Value::String(value))
                if !value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') =>
            {
                value
            }
            _ => return Err(invalid()),
        };
        if !seen.insert(next.clone()) {
            return Err(invalid());
        }
        token = Some(next.clone());
    }
}

fn token_limit(value: Option<&Value>) -> Option<u64> {
    value?
        .as_f64()
        .filter(|n| (1.0..=9_007_199_254_740_991.0).contains(n) && n.fract() == 0.0)
        .map(|n| n as u64)
}
