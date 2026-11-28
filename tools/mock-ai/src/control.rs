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

use crate::plan::Usage;
use crate::routing::{ResponseId, SessionId};
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
    /// Max stored Responses objects per owner retained for `GET/DELETE /v1/responses/{id}`.
    #[serde(default = "default_stored_responses_cap")]
    pub stored_responses_capacity: usize,
    /// Max serialized JSON byte budget for stored Responses objects per owner.
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
    pub fn find_model(&self, id: &str) -> Option<Value> {
        self.models
            .iter()
            .find(|model| model.id == id)
            .map(ModelEntry::to_wire_json)
    }

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

pub fn render_count_tokens(input_tokens: u64) -> Value {
    json!({ "input_tokens": input_tokens })
}

pub fn render_responses_compact(
    id: &str,
    created_at: u64,
    item_id: &str,
    encrypted_content: &str,
    mut retained_user_items: Vec<Value>,
    usage: &Usage,
) -> Value {
    let reasoning = usage.reasoning_tokens.unwrap_or(0);
    let output_tokens = usage.output_tokens.max(reasoning);
    retained_user_items.push(json!({
        "type": "compaction", "id": item_id, "encrypted_content": encrypted_content,
    }));
    json!({
        "id": id,
        "object": "response.compaction",
        "created_at": created_at,
        "output": retained_user_items,
        "usage": {
            "input_tokens": usage.input_tokens,
            "input_tokens_details": {
                "cached_tokens": usage.cache_read_tokens.unwrap_or(0),
                "cache_write_tokens": usage.cache_creation_tokens.unwrap_or(0),
            },
            "output_tokens": output_tokens,
            "output_tokens_details": { "reasoning_tokens": reasoning },
            "total_tokens": usage.input_tokens.saturating_add(output_tokens),
        },
    })
}

/// Completed Responses bodies, with a count and byte budget per owner.
pub struct StoredResponses {
    capacity: usize,
    max_bytes: usize,
    inner: Mutex<StoredResponsesInner>,
}

#[derive(Default)]
struct StoredResponsesInner {
    legacy: ResponseBucket,
    by_owner: HashMap<SessionId, ResponseBucket>,
}

#[derive(Default)]
struct ResponseBucket {
    order: VecDeque<String>,
    map: HashMap<String, Arc<StoredEntry>>,
    total_bytes: usize,
}

struct StoredEntry {
    response: Arc<Value>,
    byte_len: usize,
}

#[derive(Default)]
struct JsonByteCount(usize);

impl std::io::Write for JsonByteCount {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl ResponseBucket {
    fn insert(
        &mut self,
        id: String,
        entry: Arc<StoredEntry>,
        capacity: usize,
        max_bytes: usize,
        retired: &mut Vec<Arc<StoredEntry>>,
    ) {
        retired.extend(self.delete(&id));
        while self.order.len() >= capacity
            || (max_bytes > 0 && self.total_bytes > max_bytes - entry.byte_len)
        {
            let evicted = self
                .order
                .pop_front()
                .expect("full response bucket has a head");
            let removed = self
                .map
                .remove(&evicted)
                .expect("queue entry has a response");
            self.total_bytes -= removed.byte_len;
            retired.push(removed);
        }
        self.total_bytes += entry.byte_len;
        self.order.push_back(id.clone());
        self.map.insert(id, entry);
    }

    fn get(&self, id: &str) -> Option<Arc<StoredEntry>> {
        self.map.get(id).cloned()
    }

    fn delete(&mut self, id: &str) -> Option<Arc<StoredEntry>> {
        let entry = self.map.remove(id)?;
        self.total_bytes -= entry.byte_len;
        self.order.retain(|key| key != id);
        Some(entry)
    }
}

impl StoredResponses {
    pub fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            inner: Mutex::new(StoredResponsesInner::default()),
        }
    }

    pub fn insert_owned(
        &self,
        owner: &SessionId,
        id: ResponseId,
        response: Value,
        store: bool,
    ) -> bool {
        if !store {
            return false;
        }
        let Some(bytes) = self.admitted_size(&response) else {
            return false;
        };
        self.insert_sized(Some(owner), id.0, response, bytes);
        true
    }

    pub(crate) fn insert_sized(
        &self,
        owner: Option<&SessionId>,
        id: String,
        response: Value,
        bytes: usize,
    ) {
        let entry = Arc::new(StoredEntry {
            response: Arc::new(response),
            byte_len: bytes,
        });
        let mut retired = Vec::new();
        {
            let mut guard = self.inner.lock().unwrap();
            let bucket = match owner {
                Some(owner) => guard.by_owner.entry(owner.clone()).or_default(),
                None => &mut guard.legacy,
            };
            bucket.insert(id, entry, self.capacity, self.max_bytes, &mut retired);
        }
        drop(retired);
    }

    pub fn get_owned(&self, owner: &SessionId, id: &ResponseId) -> Option<Value> {
        let entry = self.inner.lock().unwrap().by_owner.get(owner)?.get(&id.0)?;
        Some(entry.response.as_ref().clone())
    }

    pub fn delete_owned(&self, owner: &SessionId, id: &ResponseId) -> bool {
        let retired = {
            let mut guard = self.inner.lock().unwrap();
            let Some(bucket) = guard.by_owner.get_mut(owner) else {
                return false;
            };
            let retired = bucket.delete(&id.0);
            if bucket.map.is_empty() {
                guard.by_owner.remove(owner);
            }
            retired
        };
        retired.is_some()
    }

    pub fn finalize_owner(&self, owner: &SessionId) {
        let retired = self.inner.lock().unwrap().by_owner.remove(owner);
        drop(retired);
    }

    pub fn put(&self, id: String, response: Value) {
        let Some(bytes) = self.admitted_size(&response) else {
            return;
        };
        self.insert_sized(None, id, response, bytes);
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        let entry = self.inner.lock().unwrap().legacy.get(id)?;
        Some(entry.response.as_ref().clone())
    }

    pub fn contains(&self, id: &str) -> bool {
        self.inner.lock().unwrap().legacy.map.contains_key(id)
    }

    pub fn delete(&self, id: &str) -> bool {
        let retired = self.inner.lock().unwrap().legacy.delete(id);
        retired.is_some()
    }

    pub fn clear(&self) {
        let retired = std::mem::take(&mut *self.inner.lock().unwrap());
        drop(retired);
    }

    pub(crate) fn admitted_size(&self, response: &Value) -> Option<usize> {
        if self.capacity == 0 {
            return None;
        }
        let mut count = JsonByteCount::default();
        serde_json::to_writer(&mut count, response).expect("JSON value serializes to byte counter");
        (self.max_bytes == 0 || count.0 <= self.max_bytes).then_some(count.0)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_bodies_are_isolated_by_owner_and_store_flag() {
        let responses = StoredResponses::new(1, 64);
        let a = SessionId("a".into());
        let b = SessionId("b".into());
        let first = ResponseId("first".into());
        let second = ResponseId("second".into());
        let ephemeral = ResponseId("ephemeral".into());

        assert!(responses.insert_owned(&a, first.clone(), json!({"owner": "a"}), true));
        assert!(!responses.delete_owned(&b, &first));
        assert_eq!(responses.get_owned(&b, &first), None);
        assert_eq!(responses.get("first"), None);
        assert!(responses.insert_owned(&b, first.clone(), json!({"owner": "b"}), true));
        assert!(responses.insert_owned(&b, second.clone(), json!({"owner": "b"}), true));
        assert!(!responses.insert_owned(&b, ephemeral.clone(), json!({"store": false}), false));

        assert_eq!(responses.get_owned(&a, &first), Some(json!({"owner": "a"})));
        assert_eq!(responses.get_owned(&b, &first), None);
        assert_eq!(responses.get_owned(&b, &ephemeral), None);
        assert_eq!(
            responses.get_owned(&b, &second),
            Some(json!({"owner": "b"}))
        );
        responses.finalize_owner(&a);
        assert_eq!(responses.get_owned(&a, &first), None);
        assert!(responses.delete_owned(&b, &second));
    }

    #[test]
    fn stored_bodies_evict_using_serialized_json_size() {
        let responses = StoredResponses::new(4, 17);
        responses.put("escaped".into(), json!("你\n\""));
        assert_eq!(responses.get("escaped"), Some(json!("你\n\"")));
        responses.put("next".into(), json!("1234567"));
        assert_eq!(responses.get("escaped"), None);
        assert_eq!(responses.get("next"), Some(json!("1234567")));

        responses.put("next".into(), json!("123456789012345"));
        responses.put("oversized".into(), json!("1234567890123456"));
        assert_eq!(responses.get("next"), Some(json!("123456789012345")));
        assert_eq!(responses.get("oversized"), None);
    }

    #[test]
    fn stored_bodies_support_concurrent_owner_reads_and_writes() {
        let responses = StoredResponses::new(1, 8192);
        let start = std::sync::Barrier::new(8);
        let id = ResponseId("shared-id".into());
        let payload = "x".repeat(4096);

        std::thread::scope(|threads| {
            for index in 0..8 {
                let (responses, start, id, payload) = (&responses, &start, &id, &payload);
                threads.spawn(move || {
                    let owner = SessionId(index.to_string());
                    start.wait();
                    for revision in 0..64 {
                        let value = json!({"owner": index, "revision": revision, "text": payload});
                        assert!(responses.insert_owned(&owner, id.clone(), value.clone(), true));
                        assert_eq!(responses.get_owned(&owner, id), Some(value));
                    }
                    assert!(responses.delete_owned(&owner, id));
                    assert_eq!(responses.get_owned(&owner, id), None);
                });
            }
        });
    }

    #[test]
    fn control_plane_payloads_match_wire_shapes() {
        let cfg = ControlPlaneConfig::default();
        assert_eq!(cfg.find_model("missing"), None);
        assert_eq!(
            cfg.find_model("mock-model"),
            Some(json!({
                "id": "mock-model", "object": "model", "owned_by": "maka-mock-ai",
                "context_length": 200000, "top_provider": { "max_completion_tokens": 16384 },
            }))
        );
        assert_eq!(render_count_tokens(73), json!({"input_tokens": 73}));
        let retained = json!({
            "type": "message", "id": "msg_1", "role": "user", "status": "completed",
            "content": [{"type": "input_text", "text": "Keep this instruction"}],
        });
        assert_eq!(
            render_responses_compact(
                "resp_1",
                123,
                "cmp_1",
                "opaque",
                vec![retained.clone()],
                &Usage::new(73, 9)
            ),
            json!({
                "id": "resp_1", "object": "response.compaction", "created_at": 123,
                "output": [retained, {"id": "cmp_1", "type": "compaction", "encrypted_content": "opaque"}],
                "usage": {
                    "input_tokens": 73,
                    "input_tokens_details": {"cached_tokens": 0, "cache_write_tokens": 0},
                    "output_tokens": 9, "output_tokens_details": {"reasoning_tokens": 0},
                    "total_tokens": 82,
                },
            })
        );
    }
}
