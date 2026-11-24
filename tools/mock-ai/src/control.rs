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

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};

/// Model descriptor returned by `GET /v1/models` (and compatible discovery endpoints).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default = "default_owner")]
    pub owned_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_completion_tokens: Option<u64>,
    /// Arbitrary extra fields merged into the model JSON object (e.g. `reasoning`, `service_tiers`, `capabilities`).
    #[serde(default)]
    pub extra: BTreeMap<String, Value>,
}

fn default_owner() -> String {
    "maka-mock-ai".into()
}

impl ModelEntry {
    pub fn simple(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: None,
            owned_by: default_owner(),
            context_length: None,
            max_completion_tokens: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn with_context(mut self, context_length: u64, max_completion_tokens: u64) -> Self {
        self.context_length = Some(context_length);
        self.max_completion_tokens = Some(max_completion_tokens);
        self
    }

    pub fn with_extra(mut self, key: impl Into<String>, value: Value) -> Self {
        self.extra.insert(key.into(), value);
        self
    }

    pub fn to_wire_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("id".into(), json!(self.id));
        obj.insert("object".into(), json!("model"));
        obj.insert("owned_by".into(), json!(self.owned_by));
        if let Some(name) = &self.name {
            obj.insert("name".into(), json!(name));
        }
        if let Some(ctx) = self.context_length {
            obj.insert("context_length".into(), json!(ctx));
        }
        if let Some(max_out) = self.max_completion_tokens {
            obj.insert(
                "top_provider".into(),
                json!({ "max_completion_tokens": max_out }),
            );
        }
        for (k, v) in &self.extra {
            obj.insert(k.clone(), v.clone());
        }
        Value::Object(obj)
    }
}

/// Configuration for control-plane endpoints served alongside generation routes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneConfig {
    /// Models returned by `GET /v1/models` and `GET /models`.
    #[serde(default = "default_models")]
    pub models: Vec<ModelEntry>,
    /// Optional default page size for `/v1/models` cursor pagination (0 = return all).
    #[serde(default)]
    pub models_page_size: usize,
    /// Optional JSON payload for `GET /api/usage/token/` (relay usage quota endpoint).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_token_usage: Option<Value>,
    /// Optional JSON payload for `GET /v1/usage`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v1_usage: Option<Value>,
    /// Static extra JSON routes keyed by exact path (e.g. `"/v1/users/me/balance"`).
    #[serde(default)]
    pub extra_get_routes: BTreeMap<String, Value>,
    /// Max stored Responses objects retained for `GET/DELETE /v1/responses/{id}`.
    #[serde(default = "default_stored_responses_cap")]
    pub stored_responses_capacity: usize,
    /// Max approximate byte budget for stored Responses objects.
    #[serde(default = "default_stored_responses_bytes")]
    pub stored_responses_max_bytes: usize,
    /// Enable `/admin/*` control endpoints (`/admin/metrics`, `/admin/requests`, `/admin/reset`, `/admin/rules`).
    #[serde(default)]
    pub enable_admin_api: bool,
}

fn default_models() -> Vec<ModelEntry> {
    vec![
        ModelEntry::simple("mock-model").with_context(200_000, 16_384),
        ModelEntry::simple("gpt-4.1").with_context(1_047_576, 32_768),
        ModelEntry::simple("claude-sonnet-4-5").with_context(200_000, 16_384),
    ]
}

fn default_stored_responses_cap() -> usize {
    1024
}

fn default_stored_responses_bytes() -> usize {
    64 * 1024 * 1024
}

impl Default for ControlPlaneConfig {
    fn default() -> Self {
        Self {
            models: default_models(),
            models_page_size: 0,
            relay_token_usage: None,
            v1_usage: None,
            extra_get_routes: BTreeMap::new(),
            stored_responses_capacity: default_stored_responses_cap(),
            stored_responses_max_bytes: default_stored_responses_bytes(),
            enable_admin_api: false,
        }
    }
}

impl ControlPlaneConfig {
    pub fn render_models_page(&self, query: Option<&str>) -> Value {
        let mut after: Option<String> = None;
        let mut limit: Option<usize> = None;
        let mut is_codex = false;
        if let Some(q) = query {
            for pair in q.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    match k {
                        "after" => after = Some(v.to_owned()),
                        "limit" => limit = v.parse().ok(),
                        "client_version" => is_codex = true,
                        _ => {}
                    }
                }
            }
        }

        if is_codex {
            let models: Vec<Value> = self
                .models
                .iter()
                .map(|m| {
                    let mut obj = serde_json::Map::new();
                    obj.insert("slug".into(), json!(m.id));
                    obj.insert(
                        "display_name".into(),
                        json!(m.name.as_deref().unwrap_or(&m.id)),
                    );
                    obj.insert(
                        "context_window".into(),
                        json!(m.context_length.unwrap_or(200_000)),
                    );
                    for (k, v) in &m.extra {
                        obj.insert(k.clone(), v.clone());
                    }
                    Value::Object(obj)
                })
                .collect();
            return json!({ "models": models });
        }

        let start_idx = after
            .as_deref()
            .and_then(|cursor| self.models.iter().position(|m| m.id == cursor))
            .map(|idx| idx + 1)
            .unwrap_or(0);
        let page_size = limit
            .filter(|&n| n > 0)
            .or_else(|| (self.models_page_size > 0).then_some(self.models_page_size))
            .unwrap_or(self.models.len().max(1));

        let slice = &self.models[start_idx.min(self.models.len())..];
        let take = slice.len().min(page_size);
        let has_more = start_idx + take < self.models.len();
        let page: Vec<Value> = slice[..take].iter().map(ModelEntry::to_wire_json).collect();
        let last_id = slice.get(take.saturating_sub(1)).map(|m| m.id.clone());

        json!({
            "object": "list",
            "data": page,
            "has_more": has_more,
            "last_id": last_id,
        })
    }
}

/// Bounded in-memory store for completed OpenAI Responses objects (`GET/DELETE /v1/responses/{id}`).
pub struct StoredResponses {
    capacity: usize,
    max_bytes: usize,
    inner: Mutex<StoredResponsesInner>,
}

struct StoredResponsesInner {
    order: VecDeque<String>,
    map: HashMap<String, (Value, usize)>,
    total_bytes: usize,
}

impl StoredResponses {
    pub fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            inner: Mutex::new(StoredResponsesInner {
                order: VecDeque::new(),
                map: HashMap::new(),
                total_bytes: 0,
            }),
        }
    }

    pub fn put(&self, id: String, response: Value) {
        if self.capacity == 0 {
            return;
        }
        let approx_bytes = response.to_string().len();
        if self.max_bytes > 0 && approx_bytes > self.max_bytes {
            return;
        }
        let mut guard = self.inner.lock().unwrap();
        if let Some((_, old_bytes)) = guard.map.remove(&id) {
            guard.total_bytes = guard.total_bytes.saturating_sub(old_bytes);
            guard.order.retain(|k| k != &id);
        }
        while guard.order.len() >= self.capacity
            || (self.max_bytes > 0
                && !guard.order.is_empty()
                && guard.total_bytes.saturating_add(approx_bytes) > self.max_bytes)
        {
            if let Some(evicted) = guard.order.pop_front()
                && let Some((_, b)) = guard.map.remove(&evicted)
            {
                guard.total_bytes = guard.total_bytes.saturating_sub(b);
            }
        }
        guard.total_bytes = guard.total_bytes.saturating_add(approx_bytes);
        guard.order.push_back(id.clone());
        guard.map.insert(id, (response, approx_bytes));
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.inner
            .lock()
            .unwrap()
            .map
            .get(id)
            .map(|(v, _)| v.clone())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.inner.lock().unwrap().map.contains_key(id)
    }

    pub fn delete(&self, id: &str) -> bool {
        let mut guard = self.inner.lock().unwrap();
        if let Some((_, b)) = guard.map.remove(id) {
            guard.total_bytes = guard.total_bytes.saturating_sub(b);
            guard.order.retain(|k| k != id);
            true
        } else {
            false
        }
    }

    pub fn clear(&self) {
        let mut guard = self.inner.lock().unwrap();
        guard.order.clear();
        guard.map.clear();
        guard.total_bytes = 0;
    }
}

/// HTTP response returned by a `CustomRouteFn`.
#[derive(Debug, Clone)]
pub struct CustomResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl CustomResponse {
    pub fn new(status: u16, content_type: impl Into<String>, body: impl Into<Vec<u8>>) -> Self {
        let mut headers = BTreeMap::new();
        headers.insert("content-type".into(), content_type.into());
        Self {
            status,
            headers,
            body: body.into(),
        }
    }

    pub fn text(status: u16, body: impl Into<String>) -> Self {
        Self::new(status, "text/plain", body.into().into_bytes())
    }

    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }
}

/// Optional dynamic custom HTTP handler hook evaluated before built-in control-plane
/// and generation routes.
pub type CustomRouteFn = Arc<
    dyn Fn(&str, &str, &BTreeMap<String, String>, &[u8]) -> Option<CustomResponse> + Send + Sync,
>;
