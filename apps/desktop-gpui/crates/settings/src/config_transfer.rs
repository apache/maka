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

//! The configuration file Maka Desktop exports and imports (Settings →
//! Data), read and written against the Host as Desktop's main process does:
//! the bundle's shape and its parsing from `@maka/storage/config-transfer`
//! (packages/storage/src/config-transfer.ts), the export's reads from
//! `gatherRuntimeHostConfig` and the import's writes from
//! `adaptRuntimeHostConfigImport`, `applyConfigImport`, `saveConnection`
//! and `saveConnectionCredential`
//! (apps/desktop/src/main/runtime-host-config-ipc-main.ts,
//! config-transfer-service.ts), with the settings patch applied as
//! `applyHostPatchWithoutLane` applies it
//! (runtime-host-settings-ipc-main.ts).
//!
//! A file Desktop wrote imports here and a file written here imports into
//! Desktop: the categories are the same four, and each carries what
//! Desktop's does. "App settings" here are the Host's: its policy and the
//! Web Search and JEV keys' status. Desktop's own preferences in the same
//! payload (appearance, bot chat, usage filters, onboarding, projects,
//! notifications, WorkHub, keep-awake, the interface language, the pet)
//! are Desktop's windows' and are neither written nor read here.
//!
//! One difference: a backup with settings and credentials carries the
//! network proxy's password with the proxy it belongs to
//! (`credentialTarget`), as Desktop's credentials-only backup does. Desktop
//! writes it there without, and its own import then refuses the file
//! ("Proxy password import requires a target binding").
//!
//! Reads Desktop makes only to return what it wrote (the connection after
//! it is saved, the settings after the import, the policy after each
//! change) are not made, and a catalog that moved while it was read is read
//! again at once rather than after Desktop's short back-off.

use std::collections::{HashMap, HashSet};

use host_protocol::{
    ConfigurationCredentialExportInput, ConfigurationCredentialsExport, ConnectionCatalogCreate,
    ConnectionCatalogCreateInput, ConnectionCatalogEntryDraft, ConnectionCatalogEntryUpdate,
    ConnectionCatalogQuery, ConnectionCatalogQueryInput, ConnectionCatalogQueryResult,
    ConnectionCatalogRemove, ConnectionCatalogRemoveInput, ConnectionCatalogUpdate,
    ConnectionCatalogUpdateInput, ConnectionCredentialTarget, ConnectionVersionBasis,
    CreateCatalogConnectionResult, CredentialKind, CredentialLocator, CredentialMutationResult,
    CredentialStatus, CredentialVaultDelete, CredentialVaultDeleteInput, CredentialVaultQuery,
    CredentialVaultQueryInput, CredentialVaultQueryResult, CredentialVaultSet,
    CredentialVaultSetInput, MemoryDocumentName, MemoryQuery, MemoryQueryInput, MemoryQueryResult,
    ModelApiProtocol, ModelOverrides, NetworkProxyCredentialUpdate, NetworkProxyPolicy,
    NetworkProxyUpdate, NetworkProxyUpdateInput, NetworkProxyUpdateResult, Nullable, Operation,
    ProviderAuth, ProviderDefinition, RemoveCatalogConnectionResult, RuntimePolicyMutate,
    RuntimePolicyMutateInput, RuntimePolicyMutateResult, RuntimePolicyMutation, RuntimePolicyQuery,
    RuntimePolicyQueryInput, UpdateCatalogConnectionResult, canonical_url,
};
use serde_json::{Map, Value, json};
use shared::copy::Locale;
use workspace::{HostRequestError, HostRequester};

/// `CONFIG_TRANSFER_SCHEMA_VERSION`: the only file version read.
pub const SCHEMA_VERSION: u64 = 1;

/// `SENSITIVE_PLACEHOLDER`: what a saved secret reads as in settings. A
/// file carrying it for a key leaves the key as saved.
pub const SENSITIVE_PLACEHOLDER: &str = "••••••••";

/// How often a write is tried again after the Host's state moved under it
/// (`MAX_OPTIMISTIC_ATTEMPTS`), and a credential export after a connection
/// changed.
const ATTEMPTS: usize = 3;

/// How often a catalog read starts again after the catalog moved
/// (`MAX_STABLE_READ_ATTEMPTS`).
const CATALOG_READ_ATTEMPTS: usize = 8;

/// One kind of content a file carries (`ConfigCategory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ConfigCategory {
    Connections,
    Settings,
    Credentials,
    Memory,
}

impl ConfigCategory {
    /// `CONFIG_CATEGORIES`, the order a file lists them in.
    pub const ALL: [Self; 4] = [Self::Connections, Self::Settings, Self::Credentials, Self::Memory];

    pub fn wire(self) -> &'static str {
        match self {
            Self::Connections => "connections",
            Self::Settings => "settings",
            Self::Credentials => "credentials",
            Self::Memory => "memory",
        }
    }

    pub fn from_wire(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|category| category.wire() == value)
    }

    /// `SENSITIVE_CATEGORIES`: written as plain text, chosen only on purpose.
    pub fn is_sensitive(self) -> bool {
        self == Self::Credentials
    }
}

/// What an import does with a connection whose slug the Host already has
/// (`ConnectionConflictStrategy`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ConflictStrategy {
    #[default]
    Skip,
    Overwrite,
}

/// A configuration file (`ConfigBundle`): the categories it carries, in the
/// order its manifest (`includedData`) lists them, each with its payload.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigBundle {
    pub exported_at: String,
    pub app_version: String,
    entries: Vec<(ConfigCategory, Value)>,
}

impl ConfigBundle {
    /// `buildConfigBundle`: `data` in the file's order, whatever order it
    /// came in.
    pub fn build(
        app_version: impl Into<String>,
        exported_at: impl Into<String>,
        mut data: Vec<(ConfigCategory, Value)>,
    ) -> Self {
        data.sort_by_key(|(category, _)| *category);
        data.dedup_by_key(|(category, _)| *category);
        Self { exported_at: exported_at.into(), app_version: app_version.into(), entries: data }
    }

    /// `includedData`.
    pub fn included(&self) -> Vec<ConfigCategory> {
        self.entries.iter().map(|(category, _)| *category).collect()
    }

    pub fn get(&self, category: ConfigCategory) -> Option<&Value> {
        self.entries.iter().find(|(c, _)| *c == category).map(|(_, value)| value)
    }

    fn includes(&self, category: ConfigCategory) -> bool {
        self.get(category).is_some()
    }

    /// `serializeConfigBundle`: two-space JSON and a final newline.
    pub fn to_file(&self) -> String {
        let data: Map<String, Value> = self
            .entries
            .iter()
            .map(|(category, value)| (category.wire().to_owned(), value.clone()))
            .collect();
        let bundle = json!({
            "schemaVersion": SCHEMA_VERSION,
            "exportedAt": self.exported_at,
            "appVersion": self.app_version,
            "includedData": self.included().into_iter().map(ConfigCategory::wire).collect::<Vec<_>>(),
            "data": data,
        });
        let mut text = serde_json::to_string_pretty(&bundle).unwrap_or_default();
        text.push('\n');
        text
    }

    /// `parseConfigBundle`: a category counts when the manifest lists it
    /// and the file carries it; one carried but not listed (credentials a
    /// hand edit slipped in) is dropped.
    pub fn parse(raw: &str) -> Result<Self, ParseFailure> {
        let parsed: Value = serde_json::from_str(raw).map_err(|_| ParseFailure::NotJson)?;
        let Value::Object(parsed) = parsed else {
            return Err(ParseFailure::Malformed);
        };
        let Some(version) = parsed.get("schemaVersion").and_then(Value::as_f64) else {
            return Err(ParseFailure::Malformed);
        };
        if version != SCHEMA_VERSION as f64 {
            return Err(ParseFailure::UnsupportedVersion);
        }
        let Some(listed) = parsed.get("includedData").and_then(Value::as_array) else {
            return Err(ParseFailure::Malformed);
        };
        let mut included = Vec::new();
        for item in listed {
            let category =
                item.as_str().and_then(ConfigCategory::from_wire).ok_or(ParseFailure::Malformed)?;
            if !included.contains(&category) {
                included.push(category);
            }
        }
        let data = parsed.get("data").and_then(Value::as_object);
        let entries = included
            .into_iter()
            .filter_map(|category| {
                data.and_then(|data| data.get(category.wire()))
                    .map(|value| (category, value.clone()))
            })
            .collect();
        let text = |key: &str| parsed.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
        Ok(Self { exported_at: text("exportedAt"), app_version: text("appVersion"), entries })
    }
}

/// Why a file is not one this client reads (`ConfigParseFailure`); an
/// import whose settings cannot be applied as written is `Malformed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailure {
    NotJson,
    Malformed,
    UnsupportedVersion,
}

/// Why an export or an import stopped.
#[derive(Debug, Clone, PartialEq)]
pub enum TransferError {
    /// The Host refused a request or could not be reached.
    Host(HostRequestError),
    /// The file is not one this client reads.
    File(ParseFailure),
    /// What Desktop raises as an error of its own: a write the Host did not
    /// commit, a catalog that kept changing. The English sentence is for
    /// the log; the page says "Something went wrong".
    Failed(String),
    /// Memory refused the file's MEMORY.md, in the interface's language.
    Memory(String),
}

impl From<HostRequestError> for TransferError {
    fn from(error: HostRequestError) -> Self {
        Self::Host(error)
    }
}

fn failed(message: impl Into<String>) -> TransferError {
    TransferError::Failed(message.into())
}

/// What an import did (`ConfigImportResult`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportSummary {
    pub connections: Option<ConnectionCounts>,
    pub settings: bool,
    pub credentials: Option<CredentialCounts>,
    pub memory: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConnectionCounts {
    pub created: usize,
    pub overwritten: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CredentialCounts {
    pub applied: usize,
    pub skipped: usize,
}

// --- the connection catalog, as `readRuntimeHostConnectionCatalog` reads it

/// One connection of the catalog: its header as the Host sent it (less
/// the paging fields) and its parts in order.
#[derive(Debug, Clone, PartialEq)]
struct CatalogConnection {
    header: Map<String, Value>,
    enabled_model_ids: Vec<Value>,
    models: Vec<Value>,
    catalog_entries: Vec<Value>,
    model_overrides: Map<String, Value>,
}

impl CatalogConnection {
    fn text(&self, key: &str) -> Option<&str> {
        self.header.get(key).and_then(Value::as_str)
    }

    fn id(&self) -> &str {
        self.text("connectionId").unwrap_or_default()
    }

    fn slug(&self) -> &str {
        self.text("slug").unwrap_or_default()
    }

    fn provider_type(&self) -> &str {
        self.text("providerType").unwrap_or_default()
    }

    fn base_url(&self) -> Option<&str> {
        self.text("baseUrl")
    }

    fn revision(&self) -> u64 {
        self.header.get("revision").and_then(Value::as_u64).unwrap_or_default()
    }

    fn basis(&self) -> ConnectionVersionBasis {
        ConnectionVersionBasis::new(self.id(), self.revision())
    }

    /// `connectionCredentialTarget`.
    fn target(&self) -> Result<ConnectionCredentialTarget, TransferError> {
        ConnectionCredentialTarget::new(
            self.id(),
            self.revision(),
            self.slug(),
            self.provider_type(),
            self.base_url(),
        )
        .ok_or_else(|| failed("connection has an invalid effective base URL"))
    }

    /// `connectionCredentialLocator`: the connection's key or account
    /// token, `None` for a provider with no credential slot.
    fn credential_locator(&self) -> Result<Option<CredentialLocator>, TransferError> {
        let provider = ProviderDefinition::find(self.provider_type())
            .ok_or_else(|| failed(format!("unknown provider {}", self.provider_type())))?;
        let kind = match provider.auth {
            ProviderAuth::None => return Ok(None),
            ProviderAuth::OauthToken => CredentialKind::OauthToken,
            _ => CredentialKind::ApiKey,
        };
        Ok(Some(CredentialLocator::Connection { connection_id: self.id().to_owned(), kind }))
    }

    fn request_headers_locator(&self) -> CredentialLocator {
        CredentialLocator::Connection {
            connection_id: self.id().to_owned(),
            kind: CredentialKind::RequestHeaders,
        }
    }

    /// `credentialConnectionBinding`.
    fn binding(&self) -> Result<Value, TransferError> {
        let target = self.target()?;
        Ok(
            json!({"providerType": target.provider_type, "effectiveBaseUrl": target.effective_base_url}),
        )
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Catalog {
    revision: u64,
    default_target: Option<(String, String)>,
    connections: Vec<CatalogConnection>,
}

impl Catalog {
    fn by_slug(&self, slug: &str) -> Option<&CatalogConnection> {
        self.connections.iter().find(|connection| connection.slug() == slug)
    }

    /// `projectHostConnections`: each connection as a backup carries it.
    fn projected(&self) -> Value {
        Value::Array(
            self.connections
                .iter()
                .map(|connection| {
                    let header = &connection.header;
                    let default_model = match &self.default_target {
                        Some((id, model)) if id == connection.id() => model.clone(),
                        _ => String::new(),
                    };
                    let mut out = Map::new();
                    for key in ["connectionId", "slug", "name", "providerType"] {
                        out.insert(key.into(), header.get(key).cloned().unwrap_or(Value::Null));
                    }
                    for key in ["baseUrl", "defaultApiProtocol"] {
                        if let Some(value) = header.get(key) {
                            out.insert(key.into(), value.clone());
                        }
                    }
                    out.insert(
                        "enabled".into(),
                        header.get("enabled").cloned().unwrap_or(Value::Null),
                    );
                    out.insert("defaultModel".into(), default_model.into());
                    out.insert(
                        "enabledModelIds".into(),
                        connection.enabled_model_ids.clone().into(),
                    );
                    out.insert("models".into(), connection.models.clone().into());
                    out.insert("catalogEntries".into(), connection.catalog_entries.clone().into());
                    if !connection.model_overrides.is_empty() {
                        out.insert(
                            "modelOverrides".into(),
                            Value::Object(connection.model_overrides.clone()),
                        );
                    }
                    for key in ["requestBodyOverlay", "modelSource"] {
                        if let Some(value) = header.get(key) {
                            out.insert(key.into(), value.clone());
                        }
                    }
                    if let Some(test) = header.get("lastTest") {
                        out.insert(
                            "lastTestStatus".into(),
                            test.get("status").cloned().unwrap_or(Value::Null),
                        );
                        out.insert(
                            "lastTestAt".into(),
                            test.get("checkedAt").cloned().unwrap_or(Value::Null),
                        );
                        if let Some(class) = test.get("errorClass") {
                            out.insert("lastTestMessage".into(), class.clone());
                        }
                    }
                    out.insert("createdAt".into(), 0.into());
                    out.insert("updatedAt".into(), connection.revision().into());
                    Value::Object(out)
                })
                .collect(),
        )
    }
}

/// The catalog at one revision, page by page, read again from the start
/// when it moved; its parts folded as `assembleConnectionCatalog` folds
/// them, from the pages as the Host sent them.
async fn read_catalog(requester: &HostRequester) -> Result<Catalog, TransferError> {
    'attempt: for _ in 0..CATALOG_READ_ATTEMPTS {
        let mut input = ConnectionCatalogQueryInput::Start;
        let mut first: Option<(u64, Option<(String, String)>, u64)> = None;
        let mut items: Vec<Value> = Vec::new();
        let mut cursors = HashSet::new();
        loop {
            let encoded = serde_json::to_value(&input)
                .map_err(|error| failed(format!("connection.catalog.query: {error}")))?;
            let raw = requester.request_value(ConnectionCatalogQuery::NAME, encoded).await?;
            let decoded: ConnectionCatalogQueryResult = serde_json::from_value(raw.clone())
                .map_err(|error| {
                    HostRequestError::Transport(
                        format!("failed to decode the connection.catalog.query result: {error}")
                            .into(),
                    )
                })?;
            let ConnectionCatalogQueryResult::Page {
                revision,
                default_target,
                connection_count,
                next_cursor,
                ..
            } = decoded
            else {
                continue 'attempt;
            };
            match &first {
                None => {
                    let target =
                        default_target.map(|target| (target.connection_id, target.model_id));
                    first = Some((revision, target, connection_count));
                }
                Some((first_revision, ..)) if *first_revision != revision => continue 'attempt,
                Some(_) => {}
            }
            if let Some(page) = raw.get("items").and_then(Value::as_array) {
                items.extend(page.iter().cloned());
            }
            let Some(cursor) = next_cursor else { break };
            let key = serde_json::to_string(&cursor).unwrap_or_default();
            if !cursors.insert(key) {
                return Err(failed("connection catalog read failed: repeated_cursor"));
            }
            input = ConnectionCatalogQueryInput::Continue { revision, cursor };
        }
        let Some((revision, default_target, count)) = first else { continue };
        return assemble(revision, default_target, count, items);
    }
    Err(failed("Connection catalog kept changing while it was read"))
}

fn assemble(
    revision: u64,
    default_target: Option<(String, String)>,
    count: u64,
    items: Vec<Value>,
) -> Result<Catalog, TransferError> {
    let invalid = || failed("connection catalog read failed: invalid_projection");
    let index = |item: &Value, key: &str| item.get(key).and_then(Value::as_u64);
    struct Parts {
        header: Map<String, Value>,
        counts: [u64; 3],
        parts: [Vec<(u64, Value)>; 3],
        overrides: Vec<(u64, String, Value)>,
    }
    let mut folded: Vec<(u64, Parts)> = Vec::new();
    for item in &items {
        if item.get("kind").and_then(Value::as_str) != Some("connection") {
            continue;
        }
        let connection = index(item, "connectionIndex").ok_or_else(invalid)?;
        if folded.iter().any(|(at, _)| *at == connection) {
            return Err(invalid());
        }
        let mut header = item.as_object().cloned().ok_or_else(invalid)?;
        let mut counts = [0; 3];
        for (slot, key) in
            ["enabledModelIdCount", "modelCount", "catalogEntryCount"].iter().enumerate()
        {
            counts[slot] =
                header.remove(*key).and_then(|count| count.as_u64()).ok_or_else(invalid)?;
        }
        header.remove("kind");
        header.remove("connectionIndex");
        folded.push((
            connection,
            Parts { header, counts, parts: Default::default(), overrides: Vec::new() },
        ));
    }
    for item in &items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
        let slot = match kind {
            "connection" => continue,
            "enabled_model_id" => 0,
            "model" => 1,
            _ => 2,
        };
        let connection = index(item, "connectionIndex").ok_or_else(invalid)?;
        let item_index = index(item, "itemIndex").ok_or_else(invalid)?;
        let parts = &mut folded.iter_mut().find(|(at, _)| *at == connection).ok_or_else(invalid)?.1;
        if item_index >= parts.counts[slot]
            || parts.parts[slot].iter().any(|(at, _)| *at == item_index)
        {
            return Err(invalid());
        }
        let value = match slot {
            0 => item.get("modelId"),
            1 => item.get("model"),
            _ => item.get("entry"),
        }
        .cloned()
        .unwrap_or(Value::Null);
        if slot == 2
            && let Some(declared) = item.get("modelOverride")
        {
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
            parts.overrides.push((item_index, id, declared.clone()));
        }
        parts.parts[slot].push((item_index, value));
    }
    if folded.len() as u64 != count {
        return Err(invalid());
    }
    folded.sort_by_key(|(at, _)| *at);
    let mut connections = Vec::new();
    for (_, mut parts) in folded {
        for slot in 0..3 {
            if parts.parts[slot].len() as u64 != parts.counts[slot] {
                return Err(invalid());
            }
            parts.parts[slot].sort_by_key(|(at, _)| *at);
        }
        parts.overrides.sort_by_key(|(at, ..)| *at);
        let ordered = |slot: usize, parts: &mut Parts| -> Vec<Value> {
            std::mem::take(&mut parts.parts[slot]).into_iter().map(|(_, value)| value).collect()
        };
        let enabled_model_ids = ordered(0, &mut parts);
        let models = ordered(1, &mut parts);
        let catalog_entries = ordered(2, &mut parts);
        let model_overrides =
            parts.overrides.into_iter().map(|(_, id, value)| (id, value)).collect();
        connections.push(CatalogConnection {
            header: parts.header,
            enabled_model_ids,
            models,
            catalog_entries,
            model_overrides,
        });
    }
    Ok(Catalog { revision, default_target, connections })
}

// --- the policy and the vault

/// `runtime.policy.query`: the revision and the policy as the Host sent it.
async fn query_policy(
    requester: &HostRequester,
) -> Result<(u64, Map<String, Value>), TransferError> {
    let input = serde_json::to_value(RuntimePolicyQueryInput::default()).unwrap_or(json!({}));
    let raw = requester.request_value(RuntimePolicyQuery::NAME, input).await?;
    let snapshot: host_protocol::RuntimePolicySnapshot = serde_json::from_value(raw.clone())
        .map_err(|error| {
            HostRequestError::Transport(
                format!("failed to decode the runtime.policy.query result: {error}").into(),
            )
        })?;
    let policy = raw.get("policy").and_then(Value::as_object).cloned().unwrap_or_default();
    Ok((snapshot.revision, policy))
}

/// `queryCredential`: the secret's status, `None` when the Host answers
/// anything else.
async fn credential_status(
    requester: &HostRequester,
    locator: &CredentialLocator,
) -> Result<Option<CredentialStatus>, TransferError> {
    let input = CredentialVaultQueryInput::new(locator.clone());
    Ok(match requester.request::<CredentialVaultQuery>(&input).await? {
        CredentialVaultQueryResult::Status { status } => Some(status),
        _ => None,
    })
}

fn jev_locator() -> CredentialLocator {
    CredentialLocator::Jev { kind: CredentialKind::ApiKey }
}

fn tavily_locator() -> CredentialLocator {
    CredentialLocator::WebSearch { provider: "tavily".into(), kind: CredentialKind::ApiKey }
}

/// `setCredential` in the settings module: over the status just read, again
/// after the secret moved.
async fn set_credential(
    requester: &HostRequester,
    locator: &CredentialLocator,
    secret: &str,
) -> Result<(), TransferError> {
    for _ in 0..ATTEMPTS {
        let current = credential_status(requester, locator).await?;
        let basis = current.as_ref().and_then(CredentialStatus::basis);
        let input = CredentialVaultSetInput::new(locator.clone(), basis.as_ref(), secret);
        match requester.request::<CredentialVaultSet>(&input).await? {
            CredentialMutationResult::Committed { .. } => return Ok(()),
            CredentialMutationResult::CredentialStale { .. } => continue,
            _ => return Err(failed("Runtime Host rejected the credential update")),
        }
    }
    Err(failed("Credential kept changing while it was updated"))
}

/// `deleteCredential` in the settings module.
async fn delete_credential(
    requester: &HostRequester,
    locator: &CredentialLocator,
) -> Result<(), TransferError> {
    for _ in 0..ATTEMPTS {
        let current = credential_status(requester, locator).await?;
        let Some(basis) = current.as_ref().and_then(CredentialStatus::basis) else {
            return Ok(());
        };
        let input = CredentialVaultDeleteInput::new(basis);
        match requester.request::<CredentialVaultDelete>(&input).await? {
            CredentialMutationResult::Committed { .. } => return Ok(()),
            CredentialMutationResult::CredentialStale { .. } => continue,
            _ => return Err(failed("Runtime Host rejected the credential removal")),
        }
    }
    Err(failed("Credential kept changing while it was removed"))
}

/// `updateRuntimePolicy`: the mutation `build` makes of the policy just
/// read, again after it moved.
async fn update_policy(
    requester: &HostRequester,
    build: impl Fn(&Map<String, Value>) -> Value,
) -> Result<(), TransferError> {
    for _ in 0..ATTEMPTS {
        let (revision, policy) = query_policy(requester).await?;
        let operation: RuntimePolicyMutation = serde_json::from_value(build(&policy))
            .map_err(|error| failed(format!("invalid runtime policy change: {error}")))?;
        let input = RuntimePolicyMutateInput::new(revision, operation);
        if let RuntimePolicyMutateResult::Committed { .. } =
            requester.request::<RuntimePolicyMutate>(&input).await?
        {
            return Ok(());
        }
    }
    Err(failed("Runtime Policy update kept conflicting"))
}

// --- JavaScript's reading of the file's values

/// JavaScript's truthiness.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `{ ...base, ...patch }` over objects: the patch's keys replace the
/// base's in place, and a patch that is not an object adds nothing.
fn spread(base: Option<&Value>, patch: Option<&Value>) -> Map<String, Value> {
    let mut out = base.and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(patch) = patch.and_then(Value::as_object) {
        for (key, value) in patch {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `new URL(value).toString()` of a value that may not be text.
fn canonical_endpoint(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(canonical_url)
}

/// `matchesCredentialConnection`: the binding a backup gave a secret names
/// the connection's provider and endpoint.
fn matches_binding(binding: Option<&Value>, provider_type: &str, base_url: Option<&str>) -> bool {
    let Some(binding) = binding else {
        return false;
    };
    let target = host_protocol::canonical_effective_base_url(provider_type, base_url);
    binding.get("providerType").and_then(Value::as_str) == Some(provider_type)
        && target.is_some()
        && canonical_endpoint(binding.get("effectiveBaseUrl")) == target
}

// --- export

/// A secret the export read back, by its locator.
#[derive(Default)]
struct Exported {
    secrets: HashMap<String, String>,
    stale: bool,
    proxy_target: Option<Value>,
}

fn locator_key(locator: &CredentialLocator) -> String {
    serde_json::to_string(locator).unwrap_or_default()
}

/// `exportLocators`: each connection's key (or token) and request headers,
/// then the proxy's password and the Tavily key.
fn export_requests(
    catalog: &Catalog,
) -> Result<Vec<ConfigurationCredentialExportInput>, TransferError> {
    let mut requests = Vec::new();
    for connection in &catalog.connections {
        let target = connection.target()?;
        let locators = connection
            .credential_locator()?
            .into_iter()
            .chain([connection.request_headers_locator()]);
        for locator in locators {
            requests.push(ConfigurationCredentialExportInput::new(locator, Some(target.clone())));
        }
    }
    requests.push(ConfigurationCredentialExportInput::new(
        CredentialLocator::network_proxy_password(),
        None,
    ));
    requests.push(ConfigurationCredentialExportInput::new(tavily_locator(), None));
    Ok(requests)
}

/// `exportConfigurationCredentials`: stops at the first connection that
/// moved on.
async fn export_credentials(
    requester: &HostRequester,
    requests: Vec<ConfigurationCredentialExportInput>,
) -> Result<Exported, TransferError> {
    let mut exported = Exported::default();
    for request in requests {
        let answer = requester.request::<ConfigurationCredentialsExport>(&request).await?;
        if answer.connection_stale.is_some() {
            return Ok(Exported { stale: true, ..Exported::default() });
        }
        let Some(credential) = answer.credential else { continue };
        let is_proxy = matches!(credential.locator, CredentialLocator::NetworkProxy { .. });
        if is_proxy && credential.proxy_target.is_none() {
            return Err(failed("Runtime Host omitted the proxy credential target binding"));
        }
        if let Some(target) = &credential.proxy_target {
            exported.proxy_target = serde_json::to_value(target).ok();
        }
        let secret = credential
            .secret()
            .ok_or_else(|| failed("Runtime Host sent a secret that is not base64 text"))?;
        exported.secrets.insert(locator_key(&credential.locator), secret);
    }
    // A secret is never empty; one that were would be left out, as Desktop
    // leaves out what is not truthy.
    exported.secrets.retain(|_, secret| !secret.is_empty());
    Ok(exported)
}

/// The Host's half of Desktop's settings (`loadRuntimeHostSettingsWithoutLane`):
/// the policy's sections under Desktop's names, with the JEV and Tavily
/// keys shown as saved or not.
struct HostSettings {
    policy: Map<String, Value>,
    tavily: Option<CredentialStatus>,
    jev: Option<CredentialStatus>,
}

async fn read_settings(requester: &HostRequester) -> Result<HostSettings, TransferError> {
    let (_, policy) = query_policy(requester).await?;
    let tavily = credential_status(requester, &tavily_locator()).await?;
    let jev = credential_status(requester, &jev_locator()).await?;
    Ok(HostSettings { policy, tavily, jev })
}

impl HostSettings {
    /// `networkProxyCredentialTarget` of the proxy the policy sets.
    fn proxy_target(&self) -> Option<Value> {
        let proxy = self.policy.get("networkProxy")?;
        let host = proxy.get("host")?.as_str()?.trim().to_lowercase();
        Some(json!({
            "protocol": proxy.get("protocol")?,
            "host": host,
            "port": proxy.get("port")?,
            "username": proxy.get("username")?,
        }))
    }

    /// The settings a backup writes, in Desktop's order, with the secrets
    /// as the settings show them (the placeholder, or empty).
    fn value(&self) -> Map<String, Value> {
        let section = |key: &str| self.policy.get(key).cloned().unwrap_or(Value::Null);
        let saved =
            |status: &Option<CredentialStatus>| status.as_ref().is_some_and(|s| s.configured);
        let tavily = match &self.tavily {
            Some(status) if status.configured => json!({
                "apiKey": SENSITIVE_PLACEHOLDER,
                "credentialSource": "saved",
                "credentialVersion": status.revision,
                "credentialStatus": "untested",
                "credentialCheckedAt": shared::time::iso_time(status.updated_at.unwrap_or_default()),
            }),
            _ => json!({
                "apiKey": "",
                "credentialSource": "none",
                "credentialVersion": 0,
                "credentialStatus": "not_configured",
            }),
        };
        let mut web_search = spread(
            Some(&json!({"enabled": false, "defaultProvider": "model"})),
            self.policy.get("webSearch"),
        );
        web_search.insert("providers".into(), json!({"tavily": tavily}));
        let jev_enabled =
            self.policy.get("jev").and_then(|jev| jev.get("enabled")) == Some(&Value::Bool(true));
        let jev_key = if saved(&self.jev) { SENSITIVE_PLACEHOLDER } else { "" };
        let mut out = Map::new();
        out.insert("network".into(), json!({"proxy": section("networkProxy")}));
        out.insert("personalization".into(), section("personalization"));
        out.insert("webSearch".into(), Value::Object(web_search));
        out.insert("localMemory".into(), section("memory"));
        out.insert("workspaceInstructions".into(), section("workspaceInstructions"));
        out.insert("privacy".into(), section("privacy"));
        out.insert("jev".into(), json!({"enabled": jev_enabled, "apiKey": jev_key}));
        for key in ["chatDefaults", "externalAgents", "shell", "subagents"] {
            out.insert(key.into(), section(key));
        }
        out
    }

    /// `stripSettingsSecretsForExport`: no key, no password.
    fn stripped(&self) -> Value {
        let mut out = self.value();
        remove_path(&mut out, &["jev", "apiKey"]);
        remove_path(&mut out, &["network", "proxy", "password"]);
        remove_path(&mut out, &["webSearch", "providers", "tavily", "apiKey"]);
        Value::Object(out)
    }

    /// `restoreHostSettingsSecrets`: the proxy's password (with the proxy
    /// it belongs to) and the Tavily key as read back.
    fn restored(&self, exported: &Exported) -> Value {
        let mut out = self.value();
        let proxy_secret =
            exported.secrets.get(&locator_key(&CredentialLocator::network_proxy_password()));
        let tavily_secret = exported.secrets.get(&locator_key(&tavily_locator()));
        if let Some(Value::Object(proxy)) =
            out.get_mut("network").and_then(|network| network.get_mut("proxy"))
        {
            proxy.insert("password".into(), proxy_secret.cloned().unwrap_or_default().into());
            if let (Some(_), Some(target)) = (proxy_secret, &exported.proxy_target) {
                proxy.insert("credentialTarget".into(), target.clone());
            }
        }
        if let Some(Value::Object(tavily)) = out
            .get_mut("webSearch")
            .and_then(|web| web.get_mut("providers"))
            .and_then(|providers| providers.get_mut("tavily"))
        {
            tavily.insert("apiKey".into(), tavily_secret.cloned().unwrap_or_default().into());
        }
        Value::Object(out)
    }
}

fn remove_path(value: &mut Map<String, Value>, path: &[&str]) {
    let Some((last, parents)) = path.split_last() else { return };
    let mut at = value;
    for key in parents {
        match at.get_mut(*key) {
            Some(Value::Object(next)) => at = next,
            _ => return,
        }
    }
    at.remove(*last);
}

/// `projectHostSettingsSecrets`: a credentials-only backup's settings, the
/// secrets Desktop keeps there.
fn settings_secrets(exported: &Exported) -> Option<Value> {
    let proxy = exported.secrets.get(&locator_key(&CredentialLocator::network_proxy_password()));
    let tavily = exported.secrets.get(&locator_key(&tavily_locator()));
    if proxy.is_none() && tavily.is_none() {
        return None;
    }
    let mut out = Map::new();
    if let (Some(password), Some(target)) = (proxy, &exported.proxy_target) {
        out.insert(
            "network".into(),
            json!({"proxy": {"password": password, "credentialTarget": target}}),
        );
    }
    if let Some(key) = tavily {
        out.insert("webSearch".into(), json!({"providers": {"tavily": {"apiKey": key}}}));
    }
    Some(Value::Object(out))
}

/// `connectionCredentials`: each connection's secrets with the binding an
/// import checks them against.
fn connection_credentials(catalog: &Catalog, exported: &Exported) -> Result<Value, TransferError> {
    let mut out = Vec::new();
    for connection in &catalog.connections {
        if let Some(locator) = connection.credential_locator()?
            && let Some(secret) = exported.secrets.get(&locator_key(&locator))
        {
            let CredentialLocator::Connection { kind, .. } = &locator else { continue };
            out.push(json!({
                "slug": connection.slug(),
                "kind": kind,
                "value": secret,
                "connection": connection.binding()?,
            }));
        }
        if let Some(headers) =
            exported.secrets.get(&locator_key(&connection.request_headers_locator()))
        {
            out.push(json!({
                "slug": connection.slug(),
                "kind": "request_headers",
                "value": headers,
                "connection": connection.binding()?,
            }));
        }
    }
    Ok(Value::Array(out))
}

/// `readRuntimeHostMemoryDocument`: MEMORY.md's text, empty when there is
/// none or it cannot be read (blocked, safe mode).
async fn read_memory(requester: &HostRequester) -> Result<String, TransferError> {
    let document = MemoryDocumentName::Memory;
    let invalid = || failed("Runtime Host returned an invalid Memory document page");
    'attempt: for _ in 0..ATTEMPTS {
        let start = MemoryQueryInput::DocumentStart { document: document.clone() };
        let first = match requester.request::<MemoryQuery>(&start).await? {
            MemoryQueryResult::Missing { .. }
            | MemoryQueryResult::Blocked { .. }
            | MemoryQueryResult::SafeMode { .. } => return Ok(String::new()),
            MemoryQueryResult::DocumentPage(page)
                if page.document == document && page.offset == 0 =>
            {
                page
            }
            MemoryQueryResult::RevisionChanged { .. } => continue,
            _ => return Err(invalid()),
        };
        let mut bytes = first.chunk().ok_or_else(invalid)?;
        let mut next = first.next_cursor;
        while let Some(cursor) = next {
            let input = MemoryQueryInput::DocumentContinue {
                document: document.clone(),
                revision: first.revision.clone(),
                cursor,
            };
            match requester.request::<MemoryQuery>(&input).await? {
                MemoryQueryResult::DocumentPage(page) if page.revision == first.revision => {
                    bytes.extend(page.chunk().ok_or_else(invalid)?);
                    next = page.next_cursor;
                }
                MemoryQueryResult::RevisionChanged { .. } => continue 'attempt,
                _ => return Err(invalid()),
            }
        }
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    Err(failed("Memory kept changing while it was read"))
}

/// `gatherRuntimeHostConfig`: the chosen categories as a file. Secrets are
/// read back for the catalog as it stands, and read again from the start
/// when a connection (or the proxy the password belongs to) changed on the
/// way.
pub async fn export(
    requester: &HostRequester,
    categories: &[ConfigCategory],
    app_version: &str,
    exported_at: String,
) -> Result<ConfigBundle, TransferError> {
    let selected = |category| categories.contains(&category);
    let with_secrets = selected(ConfigCategory::Credentials);
    let with_settings = selected(ConfigCategory::Settings);
    let mut catalog = if selected(ConfigCategory::Connections) && !with_secrets {
        Some(read_catalog(requester).await?)
    } else {
        None
    };
    let mut exported = Exported::default();
    let mut settings = None;
    if with_secrets {
        for attempt in 0..ATTEMPTS {
            let read = read_catalog(requester).await?;
            exported = export_credentials(requester, export_requests(&read)?).await?;
            catalog = Some(read);
            if exported.stale {
                if attempt == ATTEMPTS - 1 {
                    return Err(failed(
                        "Connection targets kept changing while credentials were exported",
                    ));
                }
                continue;
            }
            if with_settings && let Some(target) = &exported.proxy_target {
                let read = read_settings(requester).await?;
                let current = read.proxy_target();
                settings = Some(read);
                if current.as_ref() != Some(target) {
                    if attempt == ATTEMPTS - 1 {
                        return Err(failed(
                            "Proxy target kept changing while credentials were exported",
                        ));
                    }
                    continue;
                }
            }
            if with_settings && settings.is_none() {
                settings = Some(read_settings(requester).await?);
            }
            break;
        }
    } else if with_settings {
        settings = Some(read_settings(requester).await?);
    }
    let mut data = Vec::new();
    if selected(ConfigCategory::Connections)
        && let Some(catalog) = &catalog
    {
        data.push((ConfigCategory::Connections, catalog.projected()));
    }
    if with_settings {
        let settings = settings.ok_or_else(|| failed("Settings snapshot was not gathered"))?;
        let value = if with_secrets { settings.restored(&exported) } else { settings.stripped() };
        data.push((ConfigCategory::Settings, value));
    } else if with_secrets && let Some(value) = settings_secrets(&exported) {
        data.push((ConfigCategory::Settings, value));
    }
    if with_secrets && let Some(catalog) = &catalog {
        data.push((ConfigCategory::Credentials, connection_credentials(catalog, &exported)?));
    }
    if selected(ConfigCategory::Memory) {
        data.push((ConfigCategory::Memory, read_memory(requester).await?.into()));
    }
    Ok(ConfigBundle::build(app_version, exported_at, data))
}

// --- import

/// `adaptRuntimeHostConfigImport`: the proxy's password in a file's settings
/// becomes the Host's write-only operation on it, and a file whose password
/// cannot be applied as written is refused before anything is written.
fn adapt_settings(bundle: &ConfigBundle) -> Result<Option<Value>, TransferError> {
    let malformed = || TransferError::File(ParseFailure::Malformed);
    let Some(settings) = bundle.get(ConfigCategory::Settings) else {
        return Ok(None);
    };
    let Some(proxy) = settings
        .as_object()
        .and_then(|settings| settings.get("network"))
        .and_then(Value::as_object)
        .and_then(|network| network.get("proxy"))
        .and_then(Value::as_object)
    else {
        return Ok(Some(settings.clone()));
    };
    let with_secrets = bundle.includes(ConfigCategory::Credentials);
    let password = proxy.get("password");
    let target = proxy.get("credentialTarget");
    let text = password.and_then(Value::as_str);
    if with_secrets && password.is_some() && text.is_none() {
        return Err(malformed());
    }
    let filled = with_secrets && text.is_some_and(|text| !text.is_empty());
    if filled && proxy.get("authEnabled") == Some(&Value::Bool(false)) {
        return Err(malformed());
    }
    if filled && target.is_none() {
        return Err(malformed());
    }
    let mut ordinary = proxy.clone();
    for key in ["password", "passwordConfigured", "credential", "credentialTarget"] {
        ordinary.remove(key);
    }
    if with_secrets && let Some(text) = text {
        let operation = if text.is_empty() {
            json!({"kind": "delete"})
        } else {
            let mut replace = json!({"kind": "replace", "secret": text});
            if let Some(target) = target {
                replace["expectedTarget"] =
                    normalized_proxy_target(target).ok_or_else(malformed)?;
            }
            replace
        };
        ordinary.insert("credential".into(), operation);
    }
    let mut adapted = settings.clone();
    adapted["network"]["proxy"] = Value::Object(ordinary);
    Ok(Some(adapted))
}

/// `normalizeNetworkProxyCredentialTarget`.
fn normalized_proxy_target(value: &Value) -> Option<Value> {
    let target = value.as_object()?;
    if target.keys().any(|key| !["protocol", "host", "port", "username"].contains(&key.as_str())) {
        return None;
    }
    let protocol = target.get("protocol")?.as_str()?;
    if !["http", "https", "socks5"].contains(&protocol) {
        return None;
    }
    let raw_host = target.get("host")?.as_str()?;
    if raw_host.chars().count() > 255
        || raw_host.chars().any(|c| matches!(c as u32, 0..=0x1f | 0x7f..=0x9f))
    {
        return None;
    }
    let host = raw_host.trim().to_lowercase();
    let port = target.get("port")?.as_u64().filter(|port| (1..=65_535).contains(port))?;
    let username = target.get("username")?.as_str().filter(|name| name.chars().count() <= 256)?;
    (!host.is_empty())
        .then(|| json!({"protocol": protocol, "host": host, "port": port, "username": username}))
}

/// A connection a file carries: the fields an import writes, as the file
/// has them.
struct Incoming<'a> {
    raw: &'a Map<String, Value>,
    slug: String,
    provider_type: String,
}

impl Incoming<'_> {
    fn field(&self, key: &str) -> Option<&Value> {
        self.raw.get(key)
    }

    fn base_url(&self) -> Option<&str> {
        self.field("baseUrl").and_then(Value::as_str).filter(|url| !url.is_empty())
    }

    fn name(&self) -> Result<String, TransferError> {
        self.field("name")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| failed(format!("imported connection {} has no name", self.slug)))
    }

    fn enabled(&self) -> Result<bool, TransferError> {
        self.field("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| failed(format!("imported connection {} has no enabled flag", self.slug)))
    }

    /// `reconcileConnectionAfterEnabledModelsChange`: the file's selection,
    /// trimmed and without repeats.
    fn enabled_model_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for id in self.field("enabledModelIds").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = id.as_str().map(str::trim).filter(|id| !id.is_empty())
                && !ids.iter().any(|seen| seen == id)
            {
                ids.push(id.to_owned());
            }
        }
        ids
    }

    fn model_overrides(&self) -> Result<Option<ModelOverrides>, TransferError> {
        match self.field("modelOverrides") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value.clone()).map(Some).map_err(|error| {
                failed(format!(
                    "imported connection {} has invalid model parameters: {error}",
                    self.slug
                ))
            }),
        }
    }

    fn overlay(&self) -> Option<Map<String, Value>> {
        self.field("requestBodyOverlay").and_then(Value::as_object).cloned()
    }
}

/// `planConnectionMerge`: which of a file's connections an import creates,
/// which it overwrites, and how many it skips (a slug the Host has, under
/// "Skip"; a custom connection whose protocol differs, which cannot change;
/// a provider this Host no longer offers). A repeated slug counts once.
struct MergePlan<'a> {
    create: Vec<Incoming<'a>>,
    overwrite: Vec<Incoming<'a>>,
    skipped: usize,
}

fn plan_merge<'a>(
    existing: &Catalog,
    incoming: &'a [Value],
    strategy: ConflictStrategy,
) -> Result<MergePlan<'a>, TransferError> {
    let mut seen = HashSet::new();
    let mut plan = MergePlan { create: Vec::new(), overwrite: Vec::new(), skipped: 0 };
    for connection in incoming {
        let raw =
            connection.as_object().ok_or_else(|| failed("imported connection is not an object"))?;
        let slug = raw.get("slug").and_then(Value::as_str).unwrap_or_default().to_owned();
        if !seen.insert(slug.clone()) {
            continue;
        }
        let provider_type =
            raw.get("providerType").and_then(Value::as_str).unwrap_or_default().to_owned();
        let offered = ProviderDefinition::find(&provider_type).is_some_and(|p| !p.is_retired());
        if !offered {
            plan.skipped += 1;
            continue;
        }
        let entry = Incoming { raw, slug, provider_type };
        match existing.by_slug(&entry.slug) {
            Some(current) => {
                let protocol_fixed = current.provider_type() == entry.provider_type
                    && current.header.get("defaultApiProtocol")
                        != entry.field("defaultApiProtocol");
                if strategy == ConflictStrategy::Overwrite && !protocol_fixed {
                    plan.overwrite.push(entry);
                } else {
                    plan.skipped += 1;
                }
            }
            None => plan.create.push(entry),
        }
    }
    Ok(plan)
}

/// The plan, then `saveConnection` for each connection it creates or
/// overwrites: the connections whose credentials the file may write.
async fn import_connections<'a>(
    requester: &HostRequester,
    incoming: &'a [Value],
    strategy: ConflictStrategy,
) -> Result<(ConnectionCounts, Vec<Incoming<'a>>), TransferError> {
    let existing = read_catalog(requester).await?;
    let plan = plan_merge(&existing, incoming, strategy)?;
    let counts = ConnectionCounts {
        created: plan.create.len(),
        overwritten: plan.overwrite.len(),
        skipped: plan.skipped,
    };
    let saved: Vec<Incoming<'a>> = plan.create.into_iter().chain(plan.overwrite).collect();
    for connection in &saved {
        save_connection(requester, connection).await?;
    }
    Ok((counts, saved))
}

/// `saveConnection`: a snapshot replaces what the Host has under the slug
/// (a connection of another provider is removed first), or becomes a new
/// connection.
async fn save_connection(
    requester: &HostRequester,
    connection: &Incoming<'_>,
) -> Result<(), TransferError> {
    let mut catalog = read_catalog(requester).await?;
    let mut existing = catalog.by_slug(&connection.slug).cloned();
    if let Some(current) =
        existing.as_ref().filter(|current| current.provider_type() != connection.provider_type)
    {
        let input = ConnectionCatalogRemoveInput::new(current.basis());
        match requester.request::<ConnectionCatalogRemove>(&input).await? {
            RemoveCatalogConnectionResult::Committed { .. } => {}
            other => {
                return Err(failed(format!("Unable to replace imported Connection: {other:?}")));
            }
        }
        catalog = read_catalog(requester).await?;
        existing = None;
    }
    let enabled_model_ids = connection.enabled_model_ids();
    if let Some(current) = existing {
        let mut changes = ConnectionCatalogEntryUpdate::new(
            connection.name()?,
            connection.base_url().map(str::to_owned),
            connection.enabled()?,
            enabled_model_ids,
        );
        // Snapshot replacement: what the file lacks is cleared.
        changes.model_overrides =
            connection.model_overrides()?.map_or(Nullable::Null, Nullable::Value);
        changes.request_body_overlay = connection.overlay().map_or(Nullable::Null, Nullable::Value);
        let input = ConnectionCatalogUpdateInput::new(current.basis(), changes);
        match requester.request::<ConnectionCatalogUpdate>(&input).await? {
            UpdateCatalogConnectionResult::Committed { .. } => Ok(()),
            other => Err(failed(format!("Unable to update imported Connection: {other:?}"))),
        }
    } else {
        let protocol: Option<ModelApiProtocol> = match connection.field("defaultApiProtocol") {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value(value.clone()).map_err(|error| {
                failed(format!(
                    "imported connection {} has an invalid protocol: {error}",
                    connection.slug
                ))
            })?),
        };
        let mut draft = ConnectionCatalogEntryDraft::new(
            connection.slug.clone(),
            connection.name()?,
            connection.provider_type.clone(),
            enabled_model_ids,
        )
        .with_base_url(connection.base_url().map(str::to_owned))
        .with_default_api_protocol(protocol);
        draft.enabled = connection.enabled()?;
        draft.model_overrides = connection.model_overrides()?;
        draft.request_body_overlay = connection.overlay();
        let input = ConnectionCatalogCreateInput::new(catalog.revision, draft);
        match requester.request::<ConnectionCatalogCreate>(&input).await? {
            CreateCatalogConnectionResult::Committed { .. } => Ok(()),
            other => Err(failed(format!("Unable to create imported Connection: {other:?}"))),
        }
    }
}

/// `validateProxyPatch`.
fn validate_proxy(proxy: &Value) -> Result<(), TransferError> {
    let Some(operation) = proxy.get("credential").filter(|op| truthy(Some(op))) else {
        return Ok(());
    };
    match operation.get("kind").and_then(Value::as_str) {
        Some("replace") => {
            let secret = operation.get("secret").and_then(Value::as_str).unwrap_or_default();
            if secret.is_empty() {
                return Err(failed("Proxy credential replacement requires a non-empty password"));
            }
            if proxy.get("authEnabled") == Some(&Value::Bool(false)) {
                return Err(failed(
                    "Cannot replace the proxy credential while authentication is disabled",
                ));
            }
            Ok(())
        }
        Some("delete") => Ok(()),
        _ => Err(failed("Unsupported proxy credential operation")),
    }
}

/// `updateNetworkProxy`: the file's proxy over the Host's, with its password
/// replaced, deleted (authentication off, or the file says so), or kept.
/// A password for another proxy is skipped: `1` skipped credential.
async fn update_proxy(requester: &HostRequester, patch: &Value) -> Result<usize, TransferError> {
    let (revision, policy) = query_policy(requester).await?;
    let locator = CredentialLocator::network_proxy_password();
    let credential = credential_status(requester, &locator).await?;
    let mut ordinary = patch.clone();
    if let Some(ordinary) = ordinary.as_object_mut() {
        for key in ["credential", "password", "passwordConfigured"] {
            ordinary.remove(key);
        }
    }
    let merged = Value::Object(spread(policy.get("networkProxy"), Some(&ordinary)));
    let network_proxy: NetworkProxyPolicy = serde_json::from_value(merged.clone())
        .map_err(|error| failed(format!("invalid network proxy: {error}")))?;
    let requested = patch.get("credential");
    let kind = requested.and_then(|op| op.get("kind")).and_then(Value::as_str);
    let operation = if kind == Some("replace") {
        serde_json::from_value::<NetworkProxyCredentialUpdate>(
            requested.cloned().unwrap_or_default(),
        )
        .map_err(|error| failed(format!("invalid proxy credential: {error}")))?
    } else if !truthy(merged.get("authEnabled")) || kind == Some("delete") {
        NetworkProxyCredentialUpdate::Delete
    } else {
        NetworkProxyCredentialUpdate::Keep
    };
    let expected = credential.as_ref().and_then(CredentialStatus::basis);
    let input = NetworkProxyUpdateInput::new(revision, expected, network_proxy, operation);
    match requester.request::<NetworkProxyUpdate>(&input).await? {
        NetworkProxyUpdateResult::Committed { .. } => Ok(0),
        NetworkProxyUpdateResult::ProxyTargetMismatch { .. } => Ok(1),
        NetworkProxyUpdateResult::RevisionConflict { .. } => {
            Err(failed("Runtime Host proxy policy changed while it was updated"))
        }
        _ => Err(failed("Runtime Host proxy credential changed while it was updated")),
    }
}

/// `{ kind, value: { ...policy[section], ...patch } }`.
fn merged(kind: &str, section: &str, patch: &Value) -> impl Fn(&Map<String, Value>) -> Value {
    let (kind, section, patch) = (kind.to_owned(), section.to_owned(), patch.clone());
    move |policy| json!({"kind": kind, "value": spread(policy.get(&section), Some(&patch))})
}

/// `applyHostPatchWithoutLane`: the file's settings the Host keeps, in
/// Desktop's order. Returns how many of the file's secrets were skipped (a
/// password saved for another proxy).
async fn apply_settings(requester: &HostRequester, patch: &Value) -> Result<usize, TransferError> {
    let field = |key: &str| patch.get(key);
    if let Some(proxy) = field("network").and_then(|network| network.get("proxy")) {
        validate_proxy(proxy)?;
    }
    let mut skipped = 0;
    if let Some(jev) = field("jev").filter(|jev| truthy(Some(jev))) {
        let key = jev.get("apiKey");
        if key.is_some_and(|key| !key.is_string()) {
            return Err(failed("JEV key in imported settings must be a string"));
        }
        let key = key.and_then(Value::as_str).filter(|key| *key != SENSITIVE_PLACEHOLDER);
        let removing = key.is_some_and(|key| key.trim().is_empty());
        match key.map(str::trim) {
            Some("") => delete_credential(requester, &jev_locator()).await?,
            Some(key) => set_credential(requester, &jev_locator(), key).await?,
            None => {}
        }
        if jev.get("enabled").is_some() || removing {
            let enabled = !removing && jev.get("enabled") == Some(&Value::Bool(true));
            update_policy(requester, |_| json!({"kind": "set_jev", "value": {"enabled": enabled}}))
                .await?;
        }
    }
    if let Some(proxy) =
        field("network").and_then(|network| network.get("proxy")).filter(|p| truthy(Some(p)))
    {
        skipped += update_proxy(requester, proxy).await?;
    }
    if let Some(personalization) = field("personalization") {
        let name = personalization.get("displayName");
        let tone = personalization.get("assistantTone");
        if name.is_some() || tone.is_some() {
            let mut patch = Map::new();
            if let Some(name) = name {
                patch.insert("displayName".into(), name.clone());
            }
            if let Some(tone) = tone {
                patch.insert("assistantTone".into(), tone.clone());
            }
            let patch = Value::Object(patch);
            update_policy(requester, merged("set_personalization", "personalization", &patch))
                .await?;
        }
    }
    for (key, kind, section) in [
        ("localMemory", "set_memory", "memory"),
        ("workspaceInstructions", "set_workspace_instructions", "workspaceInstructions"),
        ("privacy", "set_privacy", "privacy"),
        ("chatDefaults", "set_chat_defaults", "chatDefaults"),
    ] {
        if let Some(value) = field(key).filter(|value| truthy(Some(value))) {
            update_policy(requester, merged(kind, section, value)).await?;
        }
    }
    if let Some(agents) = field("externalAgents").filter(|value| truthy(Some(value))) {
        let agents = agents.clone();
        update_policy(requester, move |_| json!({"kind": "set_external_agents", "value": agents}))
            .await?;
    }
    if let Some(shell) = field("shell").filter(|value| truthy(Some(value))) {
        update_policy(requester, merged("set_shell", "shell", shell)).await?;
    }
    if let Some(web) = field("webSearch").filter(|value| truthy(Some(value))) {
        let mut patch = Map::new();
        for key in ["enabled", "defaultProvider"] {
            if let Some(value) = web.get(key) {
                patch.insert(key.into(), value.clone());
            }
        }
        let patch = Value::Object(patch);
        update_policy(requester, merged("set_web_search", "webSearch", &patch)).await?;
        let key = web.get("providers").and_then(|p| p.get("tavily")).and_then(|t| t.get("apiKey"));
        match key {
            None => {}
            Some(Value::String(key)) if key == SENSITIVE_PLACEHOLDER => {}
            Some(Value::String(key)) if key.is_empty() => {
                delete_credential(requester, &tavily_locator()).await?;
            }
            Some(Value::String(key)) => set_credential(requester, &tavily_locator(), key).await?,
            Some(_) => return Err(failed("Tavily key in imported settings must be a string")),
        }
    }
    if let Some(subagents) = field("subagents").filter(|value| truthy(Some(value))) {
        let subagents = subagents.clone();
        update_policy(requester, move |_| json!({"kind": "set_subagents", "value": subagents}))
            .await?;
    }
    Ok(skipped)
}

/// `VALID_CREDENTIAL_KINDS`.
const CREDENTIAL_KINDS: [&str; 7] = [
    "api_key",
    "oauth_token",
    "request_headers",
    "bot_token",
    "app_secret",
    "proxy_password",
    "tavily_api_key",
];

/// Where a file's connection secret may go: its slug, provider and
/// endpoint (the file's connection for one the import just wrote, the
/// Host's for a credentials-only file).
struct CredentialTarget {
    provider_type: String,
    base_url: Option<String>,
}

/// `saveConnectionCredential`: the secret to the connection the slug names
/// now, while it is still the one the binding and the target name.
async fn save_connection_credential(
    requester: &HostRequester,
    slug: &str,
    kind: &str,
    secret: &str,
    binding: Option<&Value>,
) -> Result<bool, TransferError> {
    let catalog = read_catalog(requester).await?;
    let Some(connection) = catalog.by_slug(slug) else {
        return Ok(false);
    };
    if !matches_binding(binding, connection.provider_type(), connection.base_url()) {
        return Ok(false);
    }
    let locator = if kind == "request_headers" {
        Some(connection.request_headers_locator())
    } else {
        connection.credential_locator()?
    };
    let Some(locator) = locator else {
        return Ok(false);
    };
    let CredentialLocator::Connection { kind: slot, .. } = &locator else {
        return Ok(false);
    };
    if serde_json::to_value(slot).ok().as_ref().and_then(Value::as_str) != Some(kind) {
        return Ok(false);
    }
    let current = credential_status(requester, &locator).await?;
    let basis = current.as_ref().and_then(CredentialStatus::basis);
    let input = CredentialVaultSetInput::new(locator, basis.as_ref(), secret)
        .with_expected_connection(connection.target()?);
    Ok(matches!(
        requester.request::<CredentialVaultSet>(&input).await?,
        CredentialMutationResult::Committed { .. }
    ))
}

/// `applyConfigImport`: the file's connections, then its settings, then its
/// credentials, then its MEMORY.md. A step the Host refuses stops the
/// import there; what was written before stays.
pub async fn import(
    requester: &HostRequester,
    bundle: &ConfigBundle,
    strategy: ConflictStrategy,
    locale: Locale,
) -> Result<ImportSummary, TransferError> {
    let settings = adapt_settings(bundle)?;
    let mut summary = ImportSummary::default();
    let mut targets: HashMap<String, CredentialTarget> = HashMap::new();
    let snapshot = bundle.get(ConfigCategory::Connections).and_then(Value::as_array);
    let secrets = bundle.get(ConfigCategory::Credentials).and_then(Value::as_array);
    if let Some(incoming) = snapshot {
        let (counts, saved) = import_connections(requester, incoming, strategy).await?;
        for connection in saved {
            let base_url = connection.field("baseUrl").and_then(Value::as_str).map(str::to_owned);
            targets.insert(
                connection.slug.clone(),
                CredentialTarget { provider_type: connection.provider_type.clone(), base_url },
            );
        }
        summary.connections = Some(counts);
    } else if !bundle.includes(ConfigCategory::Connections) && secrets.is_some() {
        let existing = read_catalog(requester).await?;
        for connection in &existing.connections {
            targets.insert(
                connection.slug().to_owned(),
                CredentialTarget {
                    provider_type: connection.provider_type().to_owned(),
                    base_url: connection.base_url().map(str::to_owned),
                },
            );
        }
    }
    let mut settings_skips = 0;
    if let Some(settings) = settings.filter(|settings| settings.is_object() || settings.is_array())
    {
        settings_skips = apply_settings(requester, &settings).await?;
        summary.settings = true;
    }
    if let Some(entries) = secrets {
        let mut counts = CredentialCounts { applied: 0, skipped: settings_skips };
        for entry in entries {
            let slug = entry.get("slug").and_then(Value::as_str);
            let value =
                entry.get("value").and_then(Value::as_str).filter(|value| !value.is_empty());
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .filter(|kind| CREDENTIAL_KINDS.contains(kind));
            let (Some(slug), Some(value), Some(kind)) = (slug, value, kind) else {
                continue;
            };
            let Some(target) = targets.get(slug) else {
                counts.skipped += 1;
                continue;
            };
            let binding = match entry.get("connection").filter(|binding| !binding.is_null()) {
                Some(binding) => Some(binding.clone()),
                None if snapshot.is_some() => {
                    host_protocol::canonical_effective_base_url(&target.provider_type, target.base_url.as_deref())
                        .map(|endpoint| json!({"providerType": target.provider_type, "effectiveBaseUrl": endpoint}))
                }
                None => None,
            };
            if !matches_binding(binding.as_ref(), &target.provider_type, target.base_url.as_deref())
            {
                counts.skipped += 1;
                continue;
            }
            if save_connection_credential(requester, slug, kind, value, binding.as_ref()).await? {
                counts.applied += 1;
            } else {
                counts.skipped += 1;
            }
        }
        summary.credentials = Some(counts);
    } else if settings_skips > 0 {
        summary.credentials = Some(CredentialCounts { applied: 0, skipped: settings_skips });
    }
    if let Some(Value::String(memory)) = bundle.get(ConfigCategory::Memory) {
        crate::memory_store::replace_document(requester, memory, locale)
            .await
            .map_err(TransferError::Memory)?;
        summary.memory = true;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_read_as_desktop_reads_it() {
        assert_eq!(ConfigBundle::parse("{"), Err(ParseFailure::NotJson));
        assert_eq!(ConfigBundle::parse("[]"), Err(ParseFailure::Malformed));
        assert_eq!(ConfigBundle::parse(r#"{"schemaVersion": "1"}"#), Err(ParseFailure::Malformed));
        assert_eq!(
            ConfigBundle::parse(r#"{"schemaVersion": 2, "includedData": []}"#),
            Err(ParseFailure::UnsupportedVersion)
        );
        assert_eq!(
            ConfigBundle::parse(r#"{"schemaVersion": 1, "includedData": ["themes"]}"#),
            Err(ParseFailure::Malformed)
        );
        let bundle = ConfigBundle::parse(
            r##"{"schemaVersion": 1, "exportedAt": "t", "appVersion": "v",
                "includedData": ["memory", "settings", "memory", "connections"],
                "data": {"memory": "# M", "connections": [], "credentials": [{"slug": "a"}]}}"##,
        )
        .expect("bundle");
        assert_eq!(
            bundle.included(),
            [ConfigCategory::Memory, ConfigCategory::Connections],
            "listed and carried, in the manifest's order; unlisted credentials are dropped"
        );
        assert_eq!(bundle.get(ConfigCategory::Credentials), None);
        assert_eq!((bundle.exported_at.as_str(), bundle.app_version.as_str()), ("t", "v"));
    }

    #[test]
    fn a_built_file_lists_its_categories_in_desktops_order() {
        let bundle = ConfigBundle::build(
            "1.0.0",
            "2026-09-29T00:00:00.000Z",
            vec![(ConfigCategory::Memory, json!("")), (ConfigCategory::Connections, json!([]))],
        );
        assert_eq!(bundle.included(), [ConfigCategory::Connections, ConfigCategory::Memory]);
        let file = bundle.to_file();
        assert!(file.ends_with("}\n"));
        assert!(file.starts_with("{\n  \"schemaVersion\": 1,\n  \"exportedAt\""), "{file}");
        assert_eq!(ConfigBundle::parse(&file).expect("reads back"), bundle);
    }

    #[test]
    fn a_proxy_password_needs_its_proxy_and_authentication() {
        let file = |settings: Value, included: &[&str]| {
            let mut data = json!({"settings": settings});
            if included.contains(&"credentials") {
                data["credentials"] = json!([]);
            }
            ConfigBundle::parse(
                &json!({"schemaVersion": 1, "includedData": included, "data": data}).to_string(),
            )
            .expect("bundle")
        };
        let target =
            json!({"protocol": "http", "host": " Proxy.Example ", "port": 8080, "username": "ada"});
        let adapted = adapt_settings(&file(
            json!({"network": {"proxy": {"authEnabled": true, "password": "pw", "credentialTarget": target,
                                          "passwordConfigured": true}}}),
            &["settings", "credentials"],
        ))
        .expect("adapted")
        .expect("settings");
        assert_eq!(
            adapted["network"]["proxy"],
            json!({"authEnabled": true, "credential": {"kind": "replace", "secret": "pw",
                   "expectedTarget": {"protocol": "http", "host": "proxy.example", "port": 8080,
                                      "username": "ada"}}})
        );
        for refused in [
            json!({"network": {"proxy": {"authEnabled": true, "password": "pw"}}}),
            json!({"network": {"proxy": {"authEnabled": false, "password": "pw", "credentialTarget": target}}}),
            json!({"network": {"proxy": {"password": 7}}}),
        ] {
            assert_eq!(
                adapt_settings(&file(refused, &["settings", "credentials"])),
                Err(TransferError::File(ParseFailure::Malformed))
            );
        }
        let cleared = adapt_settings(&file(
            json!({"network": {"proxy": {"password": ""}}}),
            &["settings", "credentials"],
        ))
        .expect("adapted")
        .expect("settings");
        assert_eq!(cleared["network"]["proxy"], json!({"credential": {"kind": "delete"}}));
        let without_secrets =
            adapt_settings(&file(json!({"network": {"proxy": {"password": "pw"}}}), &["settings"]))
                .expect("adapted")
                .expect("settings");
        assert_eq!(
            without_secrets["network"]["proxy"],
            json!({}),
            "a password is only read with credentials"
        );
    }

    #[test]
    fn a_merge_plan_skips_what_the_host_cannot_take() {
        let header = |index: u64, slug: &str, provider: &str, protocol: Option<&str>| {
            let mut item = json!({"kind": "connection", "connectionIndex": index,
                "connectionId": format!("c{index}"), "revision": 1, "slug": slug, "name": slug,
                "providerType": provider, "enabled": true, "enabledModelIdCount": 0,
                "modelCount": 0, "catalogEntryCount": 0});
            if let Some(protocol) = protocol {
                item["defaultApiProtocol"] = json!(protocol);
                item["baseUrl"] = json!("https://relay.example/v1");
            }
            item
        };
        let existing = assemble(
            3,
            None,
            2,
            vec![
                header(0, "relay", "custom", Some("openai-chat")),
                header(1, "anthropic", "anthropic", None),
            ],
        )
        .expect("catalog");
        let incoming = vec![
            json!({"slug": "relay", "providerType": "custom", "defaultApiProtocol": "anthropic-messages"}),
            json!({"slug": "anthropic", "providerType": "anthropic"}),
            json!({"slug": "anthropic", "providerType": "openai"}),
            json!({"slug": "free", "providerType": "opencode-free"}),
            json!({"slug": "gone", "providerType": "no-such-provider"}),
            json!({"slug": "fresh", "providerType": "deepseek"}),
        ];
        let slugs = |entries: &[Incoming<'_>]| -> Vec<String> {
            entries.iter().map(|entry| entry.slug.clone()).collect()
        };
        let overwrite =
            plan_merge(&existing, &incoming, ConflictStrategy::Overwrite).expect("plan");
        assert_eq!(slugs(&overwrite.create), ["fresh"]);
        assert_eq!(slugs(&overwrite.overwrite), ["anthropic"], "a custom protocol cannot change");
        assert_eq!(overwrite.skipped, 3, "relay's protocol, a retired and an unknown provider");
        let skip = plan_merge(&existing, &incoming, ConflictStrategy::Skip).expect("plan");
        assert_eq!(slugs(&skip.create), ["fresh"]);
        assert!(skip.overwrite.is_empty());
        assert_eq!(skip.skipped, 4);
        let odd = vec![json!("relay")];
        assert!(plan_merge(&existing, &odd, ConflictStrategy::Skip).is_err());
    }

    #[test]
    fn javascript_truthiness_and_spread() {
        assert!(!truthy(None) && !truthy(Some(&json!(0))) && !truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!({}))) && truthy(Some(&json!([]))) && truthy(Some(&json!("x"))));
        assert_eq!(
            spread(Some(&json!({"a": 1, "b": 2})), Some(&json!({"b": 3, "c": 4}))),
            json!({"a": 1, "b": 3, "c": 4}).as_object().cloned().expect("object")
        );
        assert_eq!(
            spread(Some(&json!({"a": 1})), Some(&json!(true))),
            json!({"a": 1}).as_object().cloned().expect("object")
        );
    }
}
