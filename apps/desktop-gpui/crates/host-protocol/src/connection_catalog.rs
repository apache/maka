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

//! `connection.catalog.query`: the LLM connections and the models each one
//! offers, which is what a model picker lists; and the catalog commands the
//! connection settings use, `connection.catalog.create`,
//! `connection.catalog.set-default-target`, `connection.catalog.update`,
//! and `connection.catalog.remove`.
//!
//! Source: `packages/runtime-host/src/protocol/runtime-policy.ts`
//! (`RUNTIME_POLICY_OPERATION_SPECS['connection.catalog.query']`,
//! `decodeCatalogQueryInput`, `decodeCatalogQueryResult`, `catalogCursor`,
//! `catalogPageItem`); a catalog entry is `decodeModelCatalogEntry` in
//! `packages/core/src/runtime-policy/model-catalog-entry-codec.ts`.
//!
//! A page is a flat list of items addressed by `connectionIndex`: a
//! `connection` header, then its `enabled_model_id`, `model`, and
//! `catalog_entry` items. The Host owns model facts; a client renders the
//! `catalog_entry` items rather than deriving model metadata itself. The
//! catalog changes are announced by `connection.catalog.changed` and
//! `configuration.changed` ([`crate::ChangeNotice`]).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    ConnectionEffectFailureClass, ModelApiProtocol, ModelOverride, ModelOverrides, Nullable,
    Operation, ThinkingLevel,
};

/// `ConnectionCatalogQueryInput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionCatalogQueryInput {
    Start,
    /// The page after `cursor` of the catalog at `revision`.
    Continue {
        revision: u64,
        cursor: ConnectionCatalogCursor,
    },
}

wire_enum! {
    /// `ConnectionCatalogCursor.part`.
    pub enum ConnectionCatalogPart {
        Connection = "connection",
        EnabledModelId = "enabled_model_id",
        Model = "model",
        CatalogEntry = "catalog_entry",
    }
}

/// `ConnectionCatalogCursor`: `itemIndex` is present for every part except
/// `connection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogCursor {
    pub connection_index: u64,
    pub part: ConnectionCatalogPart,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_index: Option<u64>,
}

/// `ConnectionCatalogQueryResult`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum ConnectionCatalogQueryResult {
    /// At most 128 items and 48 KiB.
    #[serde(rename_all = "camelCase")]
    Page {
        revision: u64,
        /// The catalog default (`SessionModelTarget::Default` resolves to it).
        default_target: Option<ConnectionTarget>,
        connection_count: u64,
        items: Vec<ConnectionCatalogItem>,
        next_cursor: Option<ConnectionCatalogCursor>,
    },
    /// The catalog changed between pages; restart with `start`.
    #[serde(rename_all = "camelCase")]
    RevisionChanged { expected_revision: u64, actual_revision: u64 },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ConnectionTarget` (`packages/core/src/runtime-policy.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionTarget {
    pub connection_id: String,
    pub model_id: String,
}

impl ConnectionTarget {
    pub fn new(connection_id: impl Into<String>, model_id: impl Into<String>) -> Self {
        Self { connection_id: connection_id.into(), model_id: model_id.into() }
    }
}

wire_union! {
    /// `ConnectionCatalogPageItem`.
    pub enum ConnectionCatalogItem in "kind" {
        Connection(ConnectionHeader) = "connection",
        /// A model the user enabled for pickers on this connection.
        EnabledModelId(EnabledModelIdItem) = "enabled_model_id",
        /// A stored model row (`ConnectionModel`), kept as JSON.
        Model(ConnectionModelItem) = "model",
        /// A model as the Host resolved it: what a picker shows.
        CatalogEntry(CatalogEntryItem) = "catalog_entry",
    }
}

impl ConnectionCatalogItem {
    /// The connection the item belongs to.
    pub fn connection_index(&self) -> Option<u64> {
        match self {
            Self::Connection(item) => Some(item.connection_index),
            Self::EnabledModelId(item) => Some(item.connection_index),
            Self::Model(item) => Some(item.connection_index),
            Self::CatalogEntry(item) => Some(item.connection_index),
            Self::Unknown(value) => value.get("connectionIndex").and_then(Value::as_u64),
        }
    }
}

/// `ConnectionCatalogHeaderItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionHeader {
    pub connection_index: u64,
    pub connection_id: String,
    pub revision: u64,
    /// For example `env-deepseek`; the session projection names it
    /// `llmConnectionSlug`.
    pub slug: String,
    pub name: String,
    /// `ProviderType`, for example `deepseek`, `anthropic`, `openai`, or
    /// `custom` for a connection to an endpoint the registry does not know.
    pub provider_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Present exactly on a `custom` connection (`decodeDefaultApiProtocol`):
    /// the wire its models use unless one declares its own. Fixed at creation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_api_protocol: Option<ModelApiProtocol>,
    pub enabled: bool,
    /// Where the stored model list came from; absent when `modelCount` is 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_source: Option<ModelSource>,
    /// The outcome of the last connection test.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_test: Option<ConnectionTestSummary>,
    /// Extra top-level fields every request body carries
    /// (`normalizeOptionalRequestBodyOverlay`: never an empty object).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body_overlay: Option<Map<String, Value>>,
    pub enabled_model_id_count: u64,
    pub model_count: u64,
    pub catalog_entry_count: u64,
}

/// An `enabled_model_id` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct EnabledModelIdItem {
    pub connection_index: u64,
    pub item_index: u64,
    pub model_id: String,
}

/// A `model` item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionModelItem {
    pub connection_index: u64,
    pub item_index: u64,
    /// `ConnectionModel` (`ModelInfo`) with the user's overrides merged.
    pub model: Value,
}

/// A `catalog_entry` item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct CatalogEntryItem {
    pub connection_index: u64,
    pub item_index: u64,
    pub entry: ModelCatalogEntry,
    /// The parameters declared for this model on this connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_override: Option<ModelOverride>,
}

wire_enum! {
    /// `ModelDiscoverySource`: whether the stored models were listed by the
    /// provider or are the registry's fallback list.
    pub enum ModelSource {
        Fetched = "fetched",
        Fallback = "fallback",
    }
}

wire_enum! {
    /// `ConnectionTestSummary.status`.
    pub enum ConnectionTestStatus {
        Verified = "verified",
        /// An account's sign-in lapsed.
        NeedsReauth = "needs_reauth",
        Error = "error",
    }
}

/// `ConnectionTestSummary` (`decodeConnectionTestSummary` in
/// packages/core/src/runtime-policy/connection-catalog-codec.ts): the last
/// test's outcome, when it ran, and why it failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionTestSummary {
    pub status: ConnectionTestStatus,
    /// An ISO 8601 time.
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_class: Option<ConnectionEffectFailureClass>,
}

impl ConnectionTestSummary {
    pub fn new(status: ConnectionTestStatus, checked_at: impl Into<String>) -> Self {
        Self { status, checked_at: checked_at.into(), error_class: None }
    }
}

/// `ModelCatalogEntry` (`packages/core/src/model-catalog.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ModelCatalogEntry {
    /// The model id to put in `SessionModelTarget::Explicit::model`.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// False when this connection cannot hold a chat on this model.
    pub can_use_as_chat_default: bool,
    pub is_default: bool,
    pub supports_vision: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_supports_vision: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_threshold: Option<u64>,
    /// Reasoning levels offered, in display order; empty for a
    /// non-reasoning model.
    pub thinking_levels: Vec<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_thinking_level: Option<ThinkingLevel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_input_limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_cutoff: Option<String>,
}

impl ModelCatalogEntry {
    /// The name to show: `displayName`, else the id.
    pub fn label(&self) -> &str {
        self.display_name.as_deref().unwrap_or(&self.id)
    }
}

/// `connection.catalog.query` (mode `query`).
#[derive(Debug)]
pub enum ConnectionCatalogQuery {}

impl Operation for ConnectionCatalogQuery {
    const NAME: &'static str = "connection.catalog.query";
    type Input = ConnectionCatalogQueryInput;
    type Output = ConnectionCatalogQueryResult;
}

/// `SetDefaultConnectionTargetInput` (`normalizeSetDefaultConnectionTargetInput`
/// in packages/core/src/runtime-policy/connection-catalog-codec.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogSetDefaultTargetInput {
    /// The catalog `revision` the change was made against.
    pub expected_catalog_revision: u64,
    /// Always on the wire; `null` clears the default.
    pub target: Option<ConnectionTarget>,
}

impl ConnectionCatalogSetDefaultTargetInput {
    pub fn new(expected_catalog_revision: u64, target: Option<ConnectionTarget>) -> Self {
        Self { expected_catalog_revision, target }
    }
}

/// `SetDefaultConnectionTargetResult` (`decodeSetDefaultTargetResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum SetDefaultConnectionTargetResult {
    #[serde(rename_all = "camelCase")]
    Committed { catalog_revision: u64 },
    /// The catalog moved on; read it again and retry.
    #[serde(rename_all = "camelCase")]
    RevisionConflict { expected_revision: u64, actual_revision: u64 },
    /// The target names no enabled model of an enabled connection.
    InvalidDefaultTarget { target: ConnectionTarget },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.catalog.set-default-target` (mode `command`).
#[derive(Debug)]
pub enum ConnectionCatalogSetDefaultTarget {}

impl Operation for ConnectionCatalogSetDefaultTarget {
    const NAME: &'static str = "connection.catalog.set-default-target";
    type Input = ConnectionCatalogSetDefaultTargetInput;
    type Output = SetDefaultConnectionTargetResult;
}

/// `ConnectionVersionBasis` (`decodeConnectionVersionBasis`): a connection
/// at the revision the caller read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionVersionBasis {
    pub connection_id: String,
    pub revision: u64,
}

impl ConnectionVersionBasis {
    pub fn new(connection_id: impl Into<String>, revision: u64) -> Self {
        Self { connection_id: connection_id.into(), revision }
    }
}

/// `ConnectionCatalogEntryUpdate` (`normalizeConnectionCatalogEntryUpdate`
/// in packages/core/src/runtime-policy/connection-catalog-codec.ts).
/// `baseUrl` must be sent back as read; an absent key clears it. The model
/// parameters (`modelOverrides`) and the request body overlay are
/// tri-state: absent leaves them as stored (what a change to anything else
/// sends, so it cannot clobber them), `null` clears them, a value replaces
/// them whole.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogEntryUpdate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    pub enabled: bool,
    /// In the user's order; the first is the connection's default model.
    pub enabled_model_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub model_overrides: Nullable<ModelOverrides>,
    #[serde(default, skip_serializing_if = "Nullable::is_absent")]
    pub request_body_overlay: Nullable<Map<String, Value>>,
}

impl ConnectionCatalogEntryUpdate {
    pub fn new(
        name: impl Into<String>,
        base_url: Option<String>,
        enabled: bool,
        enabled_model_ids: Vec<String>,
    ) -> Self {
        Self {
            name: name.into(),
            base_url,
            enabled,
            enabled_model_ids,
            model_overrides: Nullable::Absent,
            request_body_overlay: Nullable::Absent,
        }
    }

    /// Replaces the model parameters with `table` (an empty one clears
    /// them, as the Host reads it).
    pub fn with_model_overrides(mut self, table: ModelOverrides) -> Self {
        self.model_overrides =
            if table.is_empty() { Nullable::Null } else { Nullable::Value(table) };
        self
    }

    /// Replaces the request body overlay with `overlay` (`None` or an empty
    /// object clears it).
    pub fn with_request_body_overlay(mut self, overlay: Option<Map<String, Value>>) -> Self {
        self.request_body_overlay = match overlay {
            Some(overlay) if !overlay.is_empty() => Nullable::Value(overlay),
            _ => Nullable::Null,
        };
        self
    }
}

/// `UpdateCatalogConnectionInput` (`normalizeUpdateCatalogConnectionInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogUpdateInput {
    pub expected: ConnectionVersionBasis,
    pub changes: ConnectionCatalogEntryUpdate,
}

impl ConnectionCatalogUpdateInput {
    pub fn new(expected: ConnectionVersionBasis, changes: ConnectionCatalogEntryUpdate) -> Self {
        Self { expected, changes }
    }
}

/// `UpdateCatalogConnectionResult` (`decodeUpdateConnectionResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum UpdateCatalogConnectionResult {
    /// `CatalogConnectionCommitted` (`catalogConnectionCommitted`): the
    /// catalog revision and the connection at its new revision.
    #[serde(rename_all = "camelCase")]
    Committed { catalog_revision: u64, connection: ConnectionVersionBasis },
    /// The connection changed since it was read, or is gone (`actual` null).
    ConnectionStale { expected: ConnectionVersionBasis, actual: Option<ConnectionVersionBasis> },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.catalog.update` (mode `command`).
#[derive(Debug)]
pub enum ConnectionCatalogUpdate {}

impl Operation for ConnectionCatalogUpdate {
    const NAME: &'static str = "connection.catalog.update";
    type Input = ConnectionCatalogUpdateInput;
    type Output = UpdateCatalogConnectionResult;
}

/// `ConnectionCatalogEntryDraft` (`normalizeConnectionCatalogEntryDraft`):
/// a new connection. `defaultApiProtocol` is required for `custom` and
/// refused for every other provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogEntryDraft {
    /// `validateSlug`: lowercase letters, digits, and inner hyphens.
    pub slug: String,
    pub name: String,
    pub provider_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_api_protocol: Option<ModelApiProtocol>,
    pub enabled: bool,
    pub enabled_model_ids: Vec<String>,
    /// The model parameters it starts with (`nonEmptyRelayProfiles`: an
    /// empty table is none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_overrides: Option<ModelOverrides>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_body_overlay: Option<Map<String, Value>>,
}

impl ConnectionCatalogEntryDraft {
    /// An enabled connection with `enabled_model_ids` (the first is its
    /// default model).
    pub fn new(
        slug: impl Into<String>,
        name: impl Into<String>,
        provider_type: impl Into<String>,
        enabled_model_ids: Vec<String>,
    ) -> Self {
        Self {
            slug: slug.into(),
            name: name.into(),
            provider_type: provider_type.into(),
            base_url: None,
            default_api_protocol: None,
            enabled: true,
            enabled_model_ids,
            model_overrides: None,
            request_body_overlay: None,
        }
    }

    /// Starts it with the model parameters `table`, unless it is empty.
    pub fn with_model_overrides(mut self, table: Option<ModelOverrides>) -> Self {
        self.model_overrides = table.filter(|table| !table.is_empty());
        self
    }

    pub fn with_base_url(mut self, base_url: Option<String>) -> Self {
        self.base_url = base_url;
        self
    }

    pub fn with_default_api_protocol(mut self, protocol: Option<ModelApiProtocol>) -> Self {
        self.default_api_protocol = protocol;
        self
    }

    /// The overlay, unless it is empty (the Host stores none then).
    pub fn with_request_body_overlay(mut self, overlay: Option<Map<String, Value>>) -> Self {
        self.request_body_overlay = overlay.filter(|overlay| !overlay.is_empty());
        self
    }
}

/// `CreateCatalogConnectionInput` (`normalizeCreateCatalogConnectionInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogCreateInput {
    /// The catalog `revision` the connection was added against.
    pub expected_catalog_revision: u64,
    pub connection: ConnectionCatalogEntryDraft,
}

impl ConnectionCatalogCreateInput {
    pub fn new(expected_catalog_revision: u64, connection: ConnectionCatalogEntryDraft) -> Self {
        Self { expected_catalog_revision, connection }
    }
}

/// `CreateCatalogConnectionResult` (`decodeCreateConnectionResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum CreateCatalogConnectionResult {
    #[serde(rename_all = "camelCase")]
    Committed { catalog_revision: u64, connection: ConnectionVersionBasis },
    /// Another connection has the slug.
    ConnectionExists { slug: String },
    /// The catalog moved on; read it again and retry.
    #[serde(rename_all = "camelCase")]
    RevisionConflict { expected_revision: u64, actual_revision: u64 },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.catalog.create` (mode `command`).
#[derive(Debug)]
pub enum ConnectionCatalogCreate {}

impl Operation for ConnectionCatalogCreate {
    const NAME: &'static str = "connection.catalog.create";
    type Input = ConnectionCatalogCreateInput;
    type Output = CreateCatalogConnectionResult;
}

/// `RemoveCatalogConnectionInput` (`normalizeRemoveCatalogConnectionInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ConnectionCatalogRemoveInput {
    pub expected: ConnectionVersionBasis,
}

impl ConnectionCatalogRemoveInput {
    pub fn new(expected: ConnectionVersionBasis) -> Self {
        Self { expected }
    }
}

/// `RemoveCatalogConnectionResult` (`decodeRemoveConnectionResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RemoveCatalogConnectionResult {
    #[serde(rename_all = "camelCase")]
    Committed { catalog_revision: u64 },
    /// The connection changed since it was read, or is gone (`actual` null).
    ConnectionStale { expected: ConnectionVersionBasis, actual: Option<ConnectionVersionBasis> },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `connection.catalog.remove` (mode `command`).
#[derive(Debug)]
pub enum ConnectionCatalogRemove {}

impl Operation for ConnectionCatalogRemove {
    const NAME: &'static str = "connection.catalog.remove";
    type Input = ConnectionCatalogRemoveInput;
    type Output = RemoveCatalogConnectionResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_target_and_remove_commands_encode_and_decode() {
        let set = ConnectionCatalogSetDefaultTargetInput::new(
            6,
            Some(ConnectionTarget::new("c1", "qwen2.5:7b")),
        );
        assert_eq!(
            serde_json::to_value(set).expect("encode"),
            json!({"expectedCatalogRevision": 6,
                   "target": {"connectionId": "c1", "modelId": "qwen2.5:7b"}})
        );
        assert_eq!(
            serde_json::to_value(ConnectionCatalogSetDefaultTargetInput::new(6, None))
                .expect("encode"),
            json!({"expectedCatalogRevision": 6, "target": null})
        );
        for (value, expected) in [
            (
                json!({"kind": "committed", "catalogRevision": 7}),
                SetDefaultConnectionTargetResult::Committed { catalog_revision: 7 },
            ),
            (
                json!({"kind": "revision_conflict", "expectedRevision": 6, "actualRevision": 8}),
                SetDefaultConnectionTargetResult::RevisionConflict {
                    expected_revision: 6,
                    actual_revision: 8,
                },
            ),
            (
                json!({"kind": "invalid_default_target",
                       "target": {"connectionId": "c1", "modelId": "m"}}),
                SetDefaultConnectionTargetResult::InvalidDefaultTarget {
                    target: ConnectionTarget::new("c1", "m"),
                },
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<SetDefaultConnectionTargetResult>(value).expect("decode"),
                expected
            );
        }

        let remove = ConnectionCatalogRemoveInput::new(ConnectionVersionBasis::new("c9", 1));
        assert_eq!(
            serde_json::to_value(remove).expect("encode"),
            json!({"expected": {"connectionId": "c9", "revision": 1}})
        );
        let stale: RemoveCatalogConnectionResult = serde_json::from_value(json!({
            "kind": "connection_stale", "expected": {"connectionId": "c9", "revision": 1},
            "actual": null
        }))
        .expect("decode");
        assert!(matches!(
            stale,
            RemoveCatalogConnectionResult::ConnectionStale { actual: None, .. }
        ));
    }

    #[test]
    fn an_update_sends_parameters_and_the_overlay_only_when_it_changes_them() {
        let update = ConnectionCatalogEntryUpdate::new("N", None, true, vec!["m".into()]);
        assert_eq!(
            serde_json::to_value(&update).expect("encode"),
            json!({"name": "N", "enabled": true, "enabledModelIds": ["m"]}),
            "absent keys leave both as stored"
        );
        let declared = ModelOverride { context_window: Some(128_000), ..ModelOverride::default() };
        let table = ModelOverrides::from([("m".to_owned(), declared)]);
        let body: Map<String, Value> =
            serde_json::from_value(json!({"provider": {"order": ["Anthropic"]}})).expect("body");
        let update = update.with_model_overrides(table).with_request_body_overlay(Some(body));
        assert_eq!(
            serde_json::to_value(&update).expect("encode"),
            json!({"name": "N", "enabled": true, "enabledModelIds": ["m"],
                   "modelOverrides": {"m": {"contextWindow": 128000}},
                   "requestBodyOverlay": {"provider": {"order": ["Anthropic"]}}})
        );
        let cleared = ConnectionCatalogEntryUpdate::new("N", None, true, vec![])
            .with_model_overrides(ModelOverrides::new())
            .with_request_body_overlay(Some(Map::new()));
        assert_eq!(
            serde_json::to_value(&cleared).expect("encode"),
            json!({"name": "N", "enabled": true, "enabledModelIds": [],
                   "modelOverrides": null, "requestBodyOverlay": null})
        );
    }

    #[test]
    fn create_encodes_the_draft_and_decodes_every_result() {
        let draft =
            ConnectionCatalogEntryDraft::new("ollama", "Ollama", "ollama", vec!["llama3.2".into()])
                .with_base_url(Some("http://127.0.0.1:11434/v1".into()));
        assert_eq!(
            serde_json::to_value(ConnectionCatalogCreateInput::new(4, draft)).expect("encode"),
            json!({"expectedCatalogRevision": 4,
                   "connection": {"slug": "ollama", "name": "Ollama", "providerType": "ollama",
                                  "baseUrl": "http://127.0.0.1:11434/v1", "enabled": true,
                                  "enabledModelIds": ["llama3.2"]}})
        );
        let custom = ConnectionCatalogEntryDraft::new("relay", "Relay", "custom", vec![])
            .with_default_api_protocol(Some(ModelApiProtocol::AnthropicMessages))
            .with_request_body_overlay(Some(Map::new()));
        assert_eq!(
            serde_json::to_value(custom).expect("encode"),
            json!({"slug": "relay", "name": "Relay", "providerType": "custom",
                   "defaultApiProtocol": "anthropic-messages", "enabled": true,
                   "enabledModelIds": []})
        );
        // A configuration import starts a connection with its parameters.
        let declared: ModelOverrides =
            serde_json::from_value(json!({"m1": {"contextWindow": 64000}})).expect("overrides");
        let restored = ConnectionCatalogEntryDraft::new("relay", "Relay", "custom", vec![])
            .with_default_api_protocol(Some(ModelApiProtocol::OpenaiChat))
            .with_model_overrides(Some(declared));
        let wire = json!({"slug": "relay", "name": "Relay", "providerType": "custom",
                          "defaultApiProtocol": "openai-chat", "enabled": true,
                          "enabledModelIds": [],
                          "modelOverrides": {"m1": {"contextWindow": 64000}}});
        assert_eq!(serde_json::to_value(&restored).expect("encode"), wire);
        let decoded: ConnectionCatalogEntryDraft = serde_json::from_value(wire).expect("decode");
        assert_eq!(decoded, restored);
        let empty = ConnectionCatalogEntryDraft::new("relay", "Relay", "custom", vec![])
            .with_model_overrides(Some(ModelOverrides::new()));
        assert_eq!(empty.model_overrides, None, "an empty table is none");
        for (value, expected) in [
            (
                json!({"kind": "committed", "catalogRevision": 5,
                       "connection": {"connectionId": "c9", "revision": 1}}),
                CreateCatalogConnectionResult::Committed {
                    catalog_revision: 5,
                    connection: ConnectionVersionBasis::new("c9", 1),
                },
            ),
            (
                json!({"kind": "connection_exists", "slug": "ollama"}),
                CreateCatalogConnectionResult::ConnectionExists { slug: "ollama".into() },
            ),
            (
                json!({"kind": "revision_conflict", "expectedRevision": 4, "actualRevision": 6}),
                CreateCatalogConnectionResult::RevisionConflict {
                    expected_revision: 4,
                    actual_revision: 6,
                },
            ),
            (json!({"kind": "future"}), CreateCatalogConnectionResult::Unknown),
        ] {
            assert_eq!(
                serde_json::from_value::<CreateCatalogConnectionResult>(value).expect("decode"),
                expected
            );
        }
    }

    #[test]
    fn a_header_carries_its_last_test_and_overlay() {
        let item: ConnectionCatalogItem = serde_json::from_value(json!({
            "kind": "connection", "connectionIndex": 0, "connectionId": "c1", "revision": 3,
            "slug": "deepseek", "name": "DeepSeek", "providerType": "deepseek", "enabled": true,
            "modelSource": "fetched",
            "lastTest": {"status": "error", "checkedAt": "2026-09-28T10:00:00.000Z",
                         "errorClass": "auth"},
            "requestBodyOverlay": {"reasoning": {"effort": "high"}},
            "enabledModelIdCount": 1, "modelCount": 2, "catalogEntryCount": 2
        }))
        .expect("decode");
        let ConnectionCatalogItem::Connection(header) = item else { panic!("expected header") };
        let test = header.last_test.expect("last test");
        assert_eq!(test.status, ConnectionTestStatus::Error);
        assert_eq!(test.error_class, Some(ConnectionEffectFailureClass::Auth));
        assert_eq!(header.model_source, Some(ModelSource::Fetched));
        assert!(header.request_body_overlay.is_some_and(|body| body.contains_key("reasoning")));
        let entry: ConnectionCatalogItem = serde_json::from_value(json!({
            "kind": "catalog_entry", "connectionIndex": 0, "itemIndex": 1,
            "entry": {"id": "m", "canUseAsChatDefault": true, "isDefault": false,
                      "supportsVision": false, "thinkingLevels": []},
            "modelOverride": {"displayName": "Mine", "applyPatch": false}
        }))
        .expect("decode");
        let ConnectionCatalogItem::CatalogEntry(entry) = entry else { panic!("expected entry") };
        let declared = entry.model_override.expect("declared");
        assert_eq!(
            (declared.display_name.as_deref(), declared.apply_patch),
            (Some("Mine"), Some(false))
        );
    }

    #[test]
    fn inputs_encode() {
        assert_eq!(
            serde_json::to_value(ConnectionCatalogQueryInput::Start).expect("encode"),
            json!({"kind": "start"})
        );
        let next = ConnectionCatalogQueryInput::Continue {
            revision: 2,
            cursor: ConnectionCatalogCursor {
                connection_index: 0,
                part: ConnectionCatalogPart::CatalogEntry,
                item_index: Some(3),
            },
        };
        assert_eq!(
            serde_json::to_value(next).expect("encode"),
            json!({"kind": "continue", "revision": 2,
                   "cursor": {"connectionIndex": 0, "part": "catalog_entry", "itemIndex": 3}})
        );
    }

    #[test]
    fn entries_decode_with_thinking_levels() {
        let item: ConnectionCatalogItem = serde_json::from_value(json!({
            "kind": "catalog_entry", "connectionIndex": 0, "itemIndex": 0,
            "entry": {"id": "m", "canUseAsChatDefault": true, "isDefault": true,
                      "supportsVision": false, "thinkingLevels": ["low", "max"],
                      "defaultThinkingLevel": "low"}
        }))
        .expect("decode");
        let ConnectionCatalogItem::CatalogEntry(item) = item else { panic!("expected entry") };
        assert_eq!(item.entry.label(), "m");
        assert_eq!(item.entry.thinking_levels, [ThinkingLevel::Low, ThinkingLevel::Max]);
    }
}
