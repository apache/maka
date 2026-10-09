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

//! The Host's model connections and the models each one offers pickers.
//!
//! [`ConnectionCatalog`] reads `connection.catalog.query` page by page the
//! way `readRuntimeHostConnectionCatalog`
//! (`packages/runtime-host/src/client/catalog-reader.ts`) does, and folds the
//! flat page items into one [`ConnectionEntry`] per connection, enabled or
//! not, with its enabled models in the user's order and every model it has
//! stored. Pickers list the enabled connections only
//! ([`ConnectionList::enabled`]); the connection settings list them all. The
//! Host owns model facts; a model's label comes from its `catalog_entry` or
//! stored `model` item, never from a registry bundled here.

use std::collections::BTreeMap;

use gpui_kit::{Context, Entity, SharedString, Subscription, Task};
use host_protocol::{
    ChangeNotice, ConnectionCatalogItem, ConnectionCatalogQuery, ConnectionCatalogQueryInput,
    ConnectionCatalogQueryResult, ConnectionTarget, ConnectionTestSummary, ModelApiProtocol,
    ModelCatalogEntry, ModelOverrides, ModelSource, PushFrame, ThinkingLevel,
};
use serde_json::{Map, Value};

use crate::{HostRequestError, HostRequester, HostSession, HostSessionEvent};

/// Restarts allowed when the catalog changes between pages
/// (`MAX_STABLE_READ_ATTEMPTS` in `packages/runtime-host/src/client/catalog-reader.ts`).
const MAX_STABLE_READ_ATTEMPTS: usize = 8;

/// A model a connection offers to pickers.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConnectionModel {
    /// The id a session's explicit `modelTarget` names.
    pub id: SharedString,
    /// The catalog entry's display name, else the id.
    pub label: SharedString,
    /// A stored model's own request wire, when discovery found one.
    pub api_protocol: Option<ModelApiProtocol>,
}

impl ConnectionModel {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self { id: id.into(), label: label.into(), api_protocol: None }
    }

    /// The model with the request wire discovery found for it.
    pub fn with_api_protocol(mut self, protocol: Option<ModelApiProtocol>) -> Self {
        self.api_protocol = protocol;
        self
    }
}

/// One connection from the catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConnectionEntry {
    pub id: SharedString,
    /// For example `ollama-local`; a session's explicit target names it too.
    pub slug: SharedString,
    pub name: SharedString,
    /// The connection's revision, which `connection.catalog.update` and
    /// `connection.catalog.remove` expect.
    pub revision: u64,
    /// The models the user enabled for pickers, in their order.
    pub models: Vec<ConnectionModel>,
    /// `ProviderType`, for example `deepseek` or `custom`.
    pub provider_type: SharedString,
    /// The service URL, when the connection sets one.
    pub base_url: Option<SharedString>,
    /// A `custom` connection's `defaultApiProtocol`, for example
    /// `openai-chat`; `None` for every other provider.
    pub default_api_protocol: Option<SharedString>,
    /// Whether pickers offer the connection at all.
    pub enabled: bool,
    /// Every model the connection has stored (discovered or declared), in
    /// the stored order, whether enabled or not.
    pub stored_models: Vec<ConnectionModel>,
    /// Every model as the Host resolved it for this connection, in the
    /// catalog's order: what a settings page lists and describes.
    pub catalog_entries: Vec<ModelCatalogEntry>,
    /// The parameters declared per model.
    pub model_overrides: ModelOverrides,
    /// The extra fields every request body carries.
    pub request_body_overlay: Option<Map<String, Value>>,
    /// The outcome of the last connection test.
    pub last_test: Option<ConnectionTestSummary>,
    /// Where the stored models came from.
    pub model_source: Option<ModelSource>,
}

impl ConnectionEntry {
    pub fn new(
        id: impl Into<SharedString>,
        slug: impl Into<SharedString>,
        name: impl Into<SharedString>,
        revision: u64,
        models: Vec<ConnectionModel>,
    ) -> Self {
        Self {
            id: id.into(),
            slug: slug.into(),
            name: name.into(),
            revision,
            models,
            provider_type: SharedString::default(),
            base_url: None,
            default_api_protocol: None,
            enabled: true,
            stored_models: Vec::new(),
            catalog_entries: Vec::new(),
            model_overrides: ModelOverrides::new(),
            request_body_overlay: None,
            last_test: None,
            model_source: None,
        }
    }

    /// The connection with its provider type and service URL.
    pub fn with_provider(
        mut self,
        provider_type: impl Into<SharedString>,
        base_url: Option<SharedString>,
    ) -> Self {
        self.provider_type = provider_type.into();
        self.base_url = base_url;
        self
    }

    /// The connection with the default API protocol it was created with.
    pub fn with_default_api_protocol(mut self, protocol: Option<SharedString>) -> Self {
        self.default_api_protocol = protocol;
        self
    }

    /// The connection, enabled or not.
    pub fn with_enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    /// The connection with the models it has stored.
    pub fn with_stored_models(mut self, stored_models: Vec<ConnectionModel>) -> Self {
        self.stored_models = stored_models;
        self
    }

    /// The connection with its resolved models and their parameters.
    pub fn with_catalog_entries(
        mut self,
        catalog_entries: Vec<ModelCatalogEntry>,
        model_overrides: ModelOverrides,
    ) -> Self {
        self.catalog_entries = catalog_entries;
        self.model_overrides = model_overrides;
        self
    }

    /// The connection with its request body overlay, last test, and model
    /// source.
    pub fn with_state(
        mut self,
        request_body_overlay: Option<Map<String, Value>>,
        last_test: Option<ConnectionTestSummary>,
        model_source: Option<ModelSource>,
    ) -> Self {
        self.request_body_overlay = request_body_overlay;
        self.last_test = last_test;
        self.model_source = model_source;
        self
    }

    /// The model `model` as the Host resolved it for this connection.
    pub fn catalog_entry(&self, model: &str) -> Option<&ModelCatalogEntry> {
        self.catalog_entries.iter().find(|entry| entry.id == model)
    }

    /// The thinking levels `model` offers on this connection, in the order
    /// a picker lists them; empty for a model without levels, or one the
    /// catalog does not describe.
    pub fn thinking_levels(&self, model: &str) -> &[ThinkingLevel] {
        self.catalog_entry(model).map_or(&[], |entry| entry.thinking_levels.as_slice())
    }

    /// The thinking level `model` uses on this connection when a task asks
    /// for none, when it declares one.
    pub fn default_thinking_level(&self, model: &str) -> Option<&ThinkingLevel> {
        self.catalog_entry(model)?.default_thinking_level.as_ref()
    }

    /// The ids of the enabled models, in the user's order.
    pub fn enabled_model_ids(&self) -> Vec<String> {
        self.models.iter().map(|model| model.id.to_string()).collect()
    }

    /// The models a person can enable, each with whether it is: the stored
    /// models in their order, then enabled ids no stored model describes.
    pub fn model_choices(&self) -> Vec<(ConnectionModel, bool)> {
        let enabled = |id: &SharedString| self.models.iter().any(|model| &model.id == id);
        let mut choices: Vec<(ConnectionModel, bool)> = self
            .stored_models
            .iter()
            .map(|model| {
                // The enabled entry carries the catalog's label.
                let label = self
                    .models
                    .iter()
                    .find(|enabled| enabled.id == model.id)
                    .map_or(model.label.clone(), |enabled| enabled.label.clone());
                (ConnectionModel::new(model.id.clone(), label), enabled(&model.id))
            })
            .collect();
        for model in &self.models {
            if !self.stored_models.iter().any(|stored| stored.id == model.id) {
                choices.push((model.clone(), true));
            }
        }
        choices
    }
}

/// A consistent read of the whole catalog.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ConnectionList {
    /// The catalog revision every page was read at; the
    /// `expectedCatalogRevision` of `connection.catalog.set-default-target`.
    pub revision: u64,
    /// The catalog default a session's `default` target resolves to.
    pub default_target: Option<ConnectionTarget>,
    pub connections: Vec<ConnectionEntry>,
}

impl ConnectionList {
    pub fn new(
        revision: u64,
        default_target: Option<ConnectionTarget>,
        connections: Vec<ConnectionEntry>,
    ) -> Self {
        Self { revision, default_target, connections }
    }

    /// The connection with `id`.
    pub fn connection(&self, id: &str) -> Option<&ConnectionEntry> {
        self.connections.iter().find(|connection| connection.id == id)
    }

    /// The connections pickers offer, in catalog order.
    pub fn enabled(&self) -> impl Iterator<Item = &ConnectionEntry> {
        self.connections.iter().filter(|connection| connection.enabled)
    }

    /// The model a new task runs on unless it asks for another: the
    /// catalog default while a picker offers it, else the first model a
    /// picker offers. `None` while no enabled connection has a model.
    pub fn default_model(&self) -> Option<(&ConnectionEntry, &ConnectionModel)> {
        let offered = |connection_id: &str, model_id: &str| {
            let connection = self.enabled().find(|connection| connection.id == connection_id)?;
            let model = connection.models.iter().find(|model| model.id == model_id)?;
            Some((connection, model))
        };
        self.default_target
            .as_ref()
            .and_then(|target| offered(&target.connection_id, &target.model_id))
            .or_else(|| {
                self.enabled().find_map(|connection| {
                    connection.models.first().map(|model| (connection, model))
                })
            })
    }

    /// Whether the catalog default names the connection `id`.
    pub fn is_default(&self, id: &str) -> bool {
        self.default_target.as_ref().is_some_and(|target| target.connection_id == id)
    }
}

/// Where reading the catalog stands. The last list stays readable while a
/// reload runs or after one fails.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConnectionCatalogStatus {
    /// Nothing read yet, or waiting for a connection to read on.
    Idle,
    Loading,
    Loaded,
    Failed(SharedString),
}

/// The Host's model connections, kept current.
///
/// Reads the catalog when a connection becomes ready, on
/// `connection.catalog.changed` and `configuration.changed` (the two notices
/// that announce catalog changes), and when [`Self::reload`] is called, for
/// example right after a connection was added. A newer read supersedes an
/// older one. Observe it for changes.
pub struct ConnectionCatalog {
    host: Entity<HostSession>,
    list: Option<ConnectionList>,
    status: ConnectionCatalogStatus,
    generation: u64,
    _subscription: Subscription,
    _load: Option<Task<()>>,
}

impl std::fmt::Debug for ConnectionCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionCatalog")
            .field("status", &self.status)
            .field("list", &self.list)
            .finish_non_exhaustive()
    }
}

impl ConnectionCatalog {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscription =
            cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| match event {
                HostSessionEvent::Connected { .. } => this.reload(cx),
                HostSessionEvent::Push(frame)
                    if matches!(
                        frame.as_ref(),
                        PushFrame::Change(
                            ChangeNotice::ConnectionCatalogChanged { .. }
                                | ChangeNotice::ConfigurationChanged { .. }
                        )
                    ) =>
                {
                    this.reload(cx)
                }
                _ => {}
            });
        let mut this = Self {
            host,
            list: None,
            status: ConnectionCatalogStatus::Idle,
            generation: 0,
            _subscription: subscription,
            _load: None,
        };
        this.reload(cx);
        this
    }

    /// Reads the catalog again, unless there is no connection to read on
    /// (the next one reads it).
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        let requester = self.host.read(cx).requester();
        self.status = ConnectionCatalogStatus::Loading;
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = read_connections(&requester).await;
            this.update(cx, |this, cx| this.finish_reload(generation, result, cx)).ok();
        }));
        cx.notify();
    }

    fn finish_reload(
        &mut self,
        generation: u64,
        result: Result<ConnectionList, HostRequestError>,
        cx: &mut Context<Self>,
    ) {
        if generation != self.generation {
            return;
        }
        self._load = None;
        match result {
            Ok(list) => {
                log::info!(
                    "connection catalog at revision {}: {} connections",
                    list.revision,
                    list.connections.len()
                );
                self.list = Some(list);
                self.status = ConnectionCatalogStatus::Loaded;
            }
            Err(error) => {
                log::warn!("connection.catalog.query failed: {error}");
                self.status = ConnectionCatalogStatus::Failed(error.to_string().into());
            }
        }
        cx.notify();
    }

    /// The last catalog read, if any.
    pub fn list(&self) -> Option<&ConnectionList> {
        self.list.as_ref()
    }

    pub fn status(&self) -> &ConnectionCatalogStatus {
        &self.status
    }
}

/// Reads every page of one catalog revision, starting over when the
/// catalog changes between pages.
pub async fn read_connections(
    requester: &HostRequester,
) -> Result<ConnectionList, HostRequestError> {
    let mut attempts = 0;
    let mut items = Vec::new();
    let mut first: Option<(u64, Option<ConnectionTarget>)> = None;
    let mut input = ConnectionCatalogQueryInput::Start;
    loop {
        match requester.request::<ConnectionCatalogQuery>(&input).await? {
            ConnectionCatalogQueryResult::Page {
                revision,
                default_target,
                items: page,
                next_cursor,
                ..
            } => {
                let (first_revision, _) = first.get_or_insert((revision, default_target));
                if *first_revision != revision {
                    return Err(HostRequestError::Transport(
                        "connection.catalog.query pages disagree on the revision".into(),
                    ));
                }
                items.extend(page);
                match next_cursor {
                    Some(cursor) => {
                        input = ConnectionCatalogQueryInput::Continue { revision, cursor }
                    }
                    None => {
                        let (revision, default_target) = first.unwrap_or((revision, None));
                        return Ok(ConnectionList {
                            revision,
                            default_target,
                            connections: connections_from_items(items),
                        });
                    }
                }
            }
            ConnectionCatalogQueryResult::RevisionChanged { .. } => {
                attempts += 1;
                if attempts >= MAX_STABLE_READ_ATTEMPTS {
                    return Err(HostRequestError::Transport(
                        "the connection catalog kept changing while it was read".into(),
                    ));
                }
                items.clear();
                first = None;
                input = ConnectionCatalogQueryInput::Start;
            }
            _ => {
                return Err(HostRequestError::Transport(
                    "connection.catalog.query answered with an unexpected result".into(),
                ));
            }
        }
    }
}

/// Folds the flat page items (a `connection` header, then its
/// `enabled_model_id`, `model`, and `catalog_entry` items, joined by
/// `connectionIndex`) into one entry per connection, in catalog order.
fn connections_from_items(items: Vec<ConnectionCatalogItem>) -> Vec<ConnectionEntry> {
    struct Folded {
        entry: ConnectionEntry,
        model_ids: Vec<(u64, String)>,
        labels: BTreeMap<String, String>,
        stored: Vec<(u64, String, Option<String>, Option<ModelApiProtocol>)>,
        entries: Vec<(u64, ModelCatalogEntry)>,
    }
    let mut connections: BTreeMap<u64, Folded> = BTreeMap::new();
    let mut model_ids = Vec::new();
    let mut labels = Vec::new();
    let mut stored = Vec::new();
    let mut entries = Vec::new();
    for item in items {
        match item {
            ConnectionCatalogItem::Connection(header) => {
                connections.insert(
                    header.connection_index,
                    Folded {
                        entry: ConnectionEntry::new(
                            header.connection_id,
                            header.slug,
                            header.name,
                            header.revision,
                            Vec::new(),
                        )
                        .with_provider(header.provider_type, header.base_url.map(Into::into))
                        .with_default_api_protocol(
                            header
                                .default_api_protocol
                                .map(|protocol| protocol.as_str().to_owned().into()),
                        )
                        .with_enabled(header.enabled)
                        .with_state(
                            header.request_body_overlay,
                            header.last_test,
                            header.model_source,
                        ),
                        model_ids: Vec::new(),
                        labels: BTreeMap::new(),
                        stored: Vec::new(),
                        entries: Vec::new(),
                    },
                );
            }
            ConnectionCatalogItem::EnabledModelId(item) => {
                model_ids.push((item.connection_index, item.item_index, item.model_id));
            }
            ConnectionCatalogItem::CatalogEntry(item) => {
                let label = item.entry.label().to_owned();
                labels.push((item.connection_index, item.entry.id.clone(), label));
                entries.push((
                    item.connection_index,
                    item.item_index,
                    item.entry,
                    item.model_override,
                ));
            }
            ConnectionCatalogItem::Model(item) => {
                // A stored `ConnectionModel` (`ModelInfo`): its id and
                // optional display name are all a settings list needs.
                if let Some(id) = item.model.get("id").and_then(serde_json::Value::as_str) {
                    let name = item
                        .model
                        .get("displayName")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned);
                    let protocol = item
                        .model
                        .get("apiProtocol")
                        .and_then(serde_json::Value::as_str)
                        .map(ModelApiProtocol::from_wire);
                    stored.push((
                        item.connection_index,
                        item.item_index,
                        id.to_owned(),
                        name,
                        protocol,
                    ));
                }
            }
            _ => {}
        }
    }
    for (index, item_index, id, name, protocol) in stored {
        if let Some(folded) = connections.get_mut(&index) {
            folded.stored.push((item_index, id, name, protocol));
        }
    }
    for (index, item_index, entry, declared) in entries {
        if let Some(folded) = connections.get_mut(&index) {
            if let Some(declared) = declared {
                folded.entry.model_overrides.insert(entry.id.clone(), declared);
            }
            folded.entries.push((item_index, entry));
        }
    }
    for (index, item_index, model_id) in model_ids {
        if let Some(folded) = connections.get_mut(&index) {
            folded.model_ids.push((item_index, model_id));
        }
    }
    for (index, model_id, label) in labels {
        if let Some(folded) = connections.get_mut(&index) {
            folded.labels.insert(model_id, label);
        }
    }
    connections
        .into_values()
        .map(|mut folded| {
            folded.model_ids.sort_by_key(|(item_index, _)| *item_index);
            folded.stored.sort_by_key(|(item_index, _, _, _)| *item_index);
            folded.entries.sort_by_key(|(item_index, _)| *item_index);
            folded.entry.catalog_entries =
                folded.entries.into_iter().map(|(_, entry)| entry).collect();
            let labels = &folded.labels;
            folded.entry.models = folded
                .model_ids
                .into_iter()
                .map(|(_, id)| {
                    let label = labels.get(&id).cloned().unwrap_or_else(|| id.clone());
                    ConnectionModel::new(id, label)
                })
                .collect();
            folded.entry.stored_models = folded
                .stored
                .into_iter()
                .map(|(_, id, name, protocol)| {
                    let label =
                        name.or_else(|| labels.get(&id).cloned()).unwrap_or_else(|| id.clone());
                    ConnectionModel::new(id, label).with_api_protocol(protocol)
                })
                .collect();
            folded.entry
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures_lite::future::Boxed;
    use gpui_kit::{AppContext as _, TestAppContext};
    use host_client::{ConnectionEvent, HostEvent};
    use serde_json::{Value, json};

    use super::*;
    use crate::HostTransport;

    fn items(value: Value) -> Vec<ConnectionCatalogItem> {
        serde_json::from_value(value).expect("items")
    }

    fn header(index: u64, id: &str, slug: &str, name: &str, enabled: bool) -> Value {
        json!({"kind": "connection", "connectionIndex": index, "connectionId": id, "revision": 2,
               "slug": slug, "name": name, "providerType": "custom",
               "defaultApiProtocol": "openai-chat", "enabled": enabled, "enabledModelIdCount": 2, "modelCount": 0,
               "catalogEntryCount": 1})
    }

    fn enabled(index: u64, item: u64, model: &str) -> Value {
        json!({"kind": "enabled_model_id", "connectionIndex": index, "itemIndex": item,
               "modelId": model})
    }

    fn entry(index: u64, item: u64, model: &str, name: Option<&str>) -> Value {
        let mut entry = json!({"id": model, "canUseAsChatDefault": true, "isDefault": false,
                               "supportsVision": false, "thinkingLevels": []});
        if let Some(name) = name {
            entry["displayName"] = json!(name);
        }
        json!({"kind": "catalog_entry", "connectionIndex": index, "itemIndex": item,
               "entry": entry})
    }

    #[test]
    fn items_fold_into_connections_with_labelled_and_stored_models() {
        let folded = connections_from_items(items(json!([
            header(0, "c1", "ollama-local", "Ollama (local)", true),
            enabled(0, 1, "phi4:latest"),
            enabled(0, 0, "qwen2.5:7b"),
            {"kind": "model", "connectionIndex": 0, "itemIndex": 1,
             "model": {"id": "llama3", "displayName": "Llama 3"}},
            {"kind": "model", "connectionIndex": 0, "itemIndex": 0, "model": {"id": "phi4:latest"}},
            entry(0, 0, "qwen2.5:7b", Some("Qwen 2.5 7B")),
            {"kind": "catalog_entry", "connectionIndex": 0, "itemIndex": 1,
             "entry": {"id": "llama3", "canUseAsChatDefault": true, "isDefault": false,
                       "supportsVision": false, "thinkingLevels": []},
             "modelOverride": {"contextWindow": 8192}},
            header(1, "c2", "off", "Disabled", false),
            enabled(1, 0, "m"),
            {"kind": "future_item", "connectionIndex": 0}
        ])));
        let ollama = ConnectionEntry::new(
            "c1",
            "ollama-local",
            "Ollama (local)",
            2,
            vec![
                ConnectionModel::new("qwen2.5:7b", "Qwen 2.5 7B"),
                ConnectionModel::new("phi4:latest", "phi4:latest"),
            ],
        )
        .with_provider("custom", None)
        .with_default_api_protocol(Some("openai-chat".into()))
        .with_stored_models(vec![
            ConnectionModel::new("phi4:latest", "phi4:latest"),
            ConnectionModel::new("llama3", "Llama 3"),
        ])
        .with_catalog_entries(
            items(json!([
                entry(0, 0, "qwen2.5:7b", Some("Qwen 2.5 7B")),
                entry(0, 1, "llama3", None)
            ]))
            .into_iter()
            .filter_map(|item| match item {
                ConnectionCatalogItem::CatalogEntry(item) => Some(item.entry),
                _ => None,
            })
            .collect(),
            serde_json::from_value(json!({"llama3": {"contextWindow": 8192}})).expect("table"),
        );
        let disabled =
            ConnectionEntry::new("c2", "off", "Disabled", 2, vec![ConnectionModel::new("m", "m")])
                .with_provider("custom", None)
                .with_default_api_protocol(Some("openai-chat".into()))
                .with_enabled(false);
        assert_eq!(folded, [ollama.clone(), disabled]);
        // Stored models first, in their order, then enabled ids no stored
        // model describes.
        let choices: Vec<(String, bool)> = ollama
            .model_choices()
            .into_iter()
            .map(|(model, enabled)| (model.label.to_string(), enabled))
            .collect();
        let expected = [("phi4:latest", true), ("Llama 3", false), ("Qwen 2.5 7B", true)];
        let expected: Vec<(String, bool)> =
            expected.iter().map(|(label, enabled)| (label.to_string(), *enabled)).collect();
        assert_eq!(choices, expected);
    }

    /// Answers `connection.catalog.query` from a queue and records inputs.
    #[derive(Default)]
    struct Pages {
        replies: Mutex<Vec<Value>>,
        inputs: Mutex<Vec<Value>>,
    }

    impl HostTransport for Pages {
        fn request(
            &self,
            _: &'static str,
            input: Value,
            _: Duration,
        ) -> Boxed<Result<Value, HostRequestError>> {
            self.inputs.lock().expect("inputs").push(input);
            let mut replies = self.replies.lock().expect("replies");
            let reply = if replies.is_empty() {
                Err(HostRequestError::NotConnected)
            } else {
                Ok(replies.remove(0))
            };
            Box::pin(async move { reply })
        }
    }

    fn accepted() -> host_protocol::HostAccepted {
        serde_json::from_value(json!({
            "kind": "accepted", "rootId": "r", "hostEpoch": "e", "connectionId": "c",
            "selectedProtocol": 0, "compatibilityEpoch": 197, "compositionId": "maka.interactive",
            "compositionRevision": "3", "state": "ready"
        }))
        .expect("accepted")
    }

    #[gpui_kit::test]
    fn a_catalog_that_changes_between_pages_is_read_again(cx: &mut TestAppContext) {
        let cursor = json!({"connectionIndex": 1, "part": "connection"});
        let pages = Arc::new(Pages::default());
        *pages.replies.lock().expect("replies") = vec![
            json!({"kind": "page", "revision": 4, "defaultTarget": null, "connectionCount": 2,
                   "items": [header(0, "c1", "a", "A", true)], "nextCursor": cursor}),
            json!({"kind": "revision_changed", "expectedRevision": 4, "actualRevision": 5}),
            json!({"kind": "page", "revision": 5,
                   "defaultTarget": {"connectionId": "c1", "modelId": "m"},
                   "connectionCount": 2, "items": [header(0, "c1", "a", "A", true)],
                   "nextCursor": cursor}),
            json!({"kind": "page", "revision": 5,
                   "defaultTarget": {"connectionId": "c1", "modelId": "m"},
                   "connectionCount": 2,
                   "items": [header(1, "c2", "b", "B", true), enabled(1, 0, "m")],
                   "nextCursor": null}),
        ];
        let host = cx.new(|_| HostSession::with_transport(PathBuf::from("/r"), pages.clone()));
        let catalog = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        cx.run_until_parked();
        assert!(pages.inputs.lock().expect("inputs").is_empty(), "no read before a connection");

        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        cx.run_until_parked();
        assert_eq!(
            *pages.inputs.lock().expect("inputs"),
            [
                json!({"kind": "start"}),
                json!({"kind": "continue", "revision": 4, "cursor": cursor}),
                json!({"kind": "start"}),
                json!({"kind": "continue", "revision": 5, "cursor": cursor}),
            ]
        );
        catalog.read_with(cx, |catalog, _| {
            assert_eq!(catalog.status(), &ConnectionCatalogStatus::Loaded);
            let list = catalog.list().expect("list");
            assert_eq!(list.revision, 5);
            assert_eq!(
                list.default_target.as_ref().map(|target| target.model_id.as_str()),
                Some("m")
            );
            let slugs: Vec<&str> = list.connections.iter().map(|c| c.slug.as_ref()).collect();
            assert_eq!(slugs, ["a", "b"]);
        });

        // A change notice reads again; a failed read keeps the last list.
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Push(PushFrame::Change(ChangeNotice::ConnectionCatalogChanged {
                    revision: 6,
                })),
                cx,
            )
        });
        cx.run_until_parked();
        catalog.read_with(cx, |catalog, _| {
            assert!(matches!(catalog.status(), ConnectionCatalogStatus::Failed(_)));
            assert_eq!(catalog.list().map(|list| list.revision), Some(5));
        });
    }
}
