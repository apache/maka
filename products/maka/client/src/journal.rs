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

//! Client-owned correlation and original receipts, independent of UI nodes.
use crate::{CONTROL_KIND, CONTROL_METHODS, Result, SETTINGS_KIND, SETTINGS_METHODS, ServiceOwner};
use maka_plugin_core::operation::OperationResult;
use maka_plugin_core::{
    composition::InstanceId,
    deployment::DeploymentRef,
    operation::{OperationOutcome, Receipt, RecoveryRef},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow, SqliteSynchronous},
};
use std::path::Path;
use uuid::Uuid;

// Keep admission and pending observations on the same immutable Settings owner.
macro_rules! settings_owner_sql {
    () => {
        "draft_owner IS NULL AND json_type(context,'$.draft')='null' AND json_type(context,'$.sessionId')='null' AND json_type(context,'$.correlation')='object' AND json_extract(context,'$.correlation') IN (SELECT value FROM json_each(?)) AND ((json_extract(context,'$.endpoint')='settings' AND json_extract(context,'$.method') IN (SELECT value FROM json_each(?))) OR (json_extract(context,'$.endpoint')='agent' AND json_extract(context,'$.method') IN ('updateGlobalInstructions','selectWorkspace','manageMcpServer','createPreset','updatePreset','deletePreset')) OR (json_extract(context,'$.endpoint')='skills' AND json_extract(context,'$.method') IN ('install','update','delete')) OR (json_extract(context,'$.endpoint')='setup' AND json_extract(context,'$.method')='discoverModels') OR (json_extract(context,'$.endpoint')='management' AND json_extract(context,'$.method') IN ('setEnabled','configure','configureBatch')) OR (json_extract(context,'$.endpoint')='authentication' AND json_extract(context,'$.method')='loginCredential'))"
    };
}

/// One user attempt. Neither this observation nor its original reference grants access.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientOperation")]
pub struct Operation {
    pub id: Uuid,
    pub host: DeploymentRef,
    pub endpoint: String,
    pub method: String,
    pub session_id: Option<String>,
    pub correlation: Value,
    #[serde(default)]
    pub draft: Option<DraftReference>,
    #[serde(default)]
    pub upload: Option<UploadReference>,
    /// Durable fence proving that this attempt did not dispatch.
    pub abandoned: bool,
    /// Present only after original preparation has been durably recorded.
    pub reference: Option<RecoveryRef>,
    /// A terminal business outcome; absent is never proof that it did not run.
    pub receipt: Option<Receipt>,
}

/// Opened by the trusted launcher in the client's own data directory, never from guest input.
#[derive(Clone)]
pub struct Journal {
    pub(crate) pool: SqlitePool,
    writes: tokio::sync::mpsc::Sender<write::Pending>,
    path: std::path::PathBuf,
}

/// Stable product owner, independent of endpoint aliases, VM instances and UI nodes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientDraftKey")]
pub struct DraftKey {
    pub state_domain: String,
    pub deployment: Uuid,
    pub namespace: InstanceId,
    pub export: String,
    pub session_id: String,
    pub editor_id: String,
}
impl DraftKey {
    pub(crate) fn new(
        host: &DeploymentRef,
        namespace: &InstanceId,
        export: &str,
        session: &str,
        editor: &str,
    ) -> Result<Self> {
        if [session, editor]
            .iter()
            .any(|name| name.is_empty() || name.chars().any(char::is_control))
        {
            return Err("invalid draft session or editor identity".into());
        }
        Ok(Self {
            state_domain: host.state_domain.clone(),
            deployment: host.deployment,
            namespace: namespace.clone(),
            export: export.into(),
            session_id: session.into(),
            editor_id: editor.into(),
        })
    }
    pub(crate) fn matches(&self, original: &RecoveryRef) -> bool {
        self.state_domain == original.source.state_domain
            && self.deployment == original.source.deployment
            && self.namespace == original.namespace
            && self.export == original.export
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientDraft")]
pub struct Draft {
    pub revision: u64,
    pub text: String,
    pub attachments: Vec<DraftAttachment>,
    #[serde(default)]
    pub quotes: Vec<maka_agent_facts::input::QuoteRef>,
}

/// A send owns this frozen content after the editor moves to its next draft.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendSnapshot {
    pub draft: Draft,
    pub selection: Value,
}

/// Display metadata for an immutable Host upload in this exact draft owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientDraftAttachment")]
pub struct DraftAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes: u64,
}

/// One complete editor revision, including the upload receipts it has handled.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientDraftEdit")]
pub struct DraftEdit {
    pub text: String,
    #[serde(default)]
    pub quotes: Vec<maka_agent_facts::input::QuoteRef>,
    #[serde(default)]
    pub attachments: Vec<DraftAttachment>,
    #[serde(default)]
    pub settled_uploads: Vec<Uuid>,
}
impl From<String> for DraftEdit {
    fn from(text: String) -> Self {
        Self {
            text,
            ..Self::default()
        }
    }
}
impl From<&str> for DraftEdit {
    fn from(text: &str) -> Self {
        text.to_owned().into()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientUploadReference")]
pub struct UploadReference {
    pub key: DraftKey,
    pub name: String,
    pub bytes: usize,
    pub digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "ClientDraftReference")]
pub struct DraftReference {
    pub key: DraftKey,
    pub revision: u64,
}

#[cfg(test)]
mod quote_tests;
mod recovery;
mod workspaces;
mod write;
pub use workspaces::RecentWorkspace;

impl Journal {
    async fn write(&self, command: write::Command) -> Result<write::Output> {
        let (reply, received) = tokio::sync::oneshot::channel();
        self.writes
            .send(write::Pending { command, reply })
            .await
            .map_err(|_| "client journal writer stopped".to_owned())?;
        received
            .await
            .map_err(|_| "client journal writer stopped before replying".to_owned())?
    }
    pub(crate) async fn save_draft(
        &self,
        key: &DraftKey,
        expected: Option<u64>,
        edit: DraftEdit,
    ) -> Result<Draft> {
        let write::Output::Draft(draft) = self
            .write(write::Command::SaveDraft {
                key: key.clone(),
                expected,
                edit,
            })
            .await?
        else {
            unreachable!("draft command returns a draft")
        };
        Ok(draft)
    }
    // The stable file coordinates preparation across independent shell processes.
    // Each lease opens its own descriptor; never replace or unlink this lock file.
    pub(crate) async fn preparation_lease(&self, exclusive: bool) -> Result<Option<std::fs::File>> {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let mut path = path.canonicalize().map_err(error)?.into_os_string();
            path.push(".preparations.lock");
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
                .map_err(error)?;
            if exclusive {
                match file.try_lock() {
                    Ok(()) => {}
                    Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
                    Err(std::fs::TryLockError::Error(cause)) => return Err(error(cause)),
                }
            } else {
                file.lock_shared().map_err(error)?;
            }
            Ok(Some(file))
        })
        .await
        .map_err(error)?
    }
    pub(crate) async fn reserve(&self, operation: &Operation) -> Result<()> {
        self.write(write::Command::Reserve(write::Reservation::new(operation)?))
            .await
            .map(|_| ())
    }
    pub(crate) async fn reserve_send(&self, operation: &Operation) -> Result<()> {
        let draft = operation
            .draft
            .clone()
            .ok_or("send requires a draft owner")?;
        self.write(write::Command::ReserveSend {
            reservation: write::Reservation::new(operation)?,
            draft,
        })
        .await
        .map(|_| ())
    }
    pub(crate) async fn retry_send(&self, original: Uuid, operation: &Operation) -> Result<()> {
        self.write(write::Command::RetrySend {
            original,
            reservation: write::Reservation::new(operation)?,
        })
        .await
        .map(|_| ())
    }
    pub(crate) async fn dismiss_send(&self, id: Uuid) -> Result<()> {
        self.write(write::Command::DismissSend(id))
            .await
            .map(|_| ())
    }
    pub(crate) async fn reserve_settings(&self, operation: &Operation) -> Result<()> {
        self.write(write::Command::ReserveSettings {
            reservation: write::Reservation::new(operation)?,
            correlation: operation.correlation.clone(),
        })
        .await
        .map(|_| ())
    }
    pub(crate) async fn prepared(&self, id: Uuid, reference: &RecoveryRef) -> Result<()> {
        self.write(write::Command::Prepared {
            id,
            reference: reference.clone(),
        })
        .await
        .map(|_| ())
    }
    pub(crate) async fn dismiss_control(&self, id: Uuid) -> Result<()> {
        self.write(write::Command::DismissControl(id))
            .await
            .map(|_| ())
    }
    pub(crate) async fn abandon(&self, host: &DeploymentRef, id: Uuid) -> Result<Operation> {
        let write::Output::Operation(operation) = self
            .write(write::Command::Abandon {
                host: host.clone(),
                id,
            })
            .await?
        else {
            unreachable!("abandon command returns an operation")
        };
        Ok(*operation)
    }
    pub(crate) async fn abandon_undispatched(
        &self,
        host: &DeploymentRef,
        id: Uuid,
        reference: &RecoveryRef,
    ) -> Result<()> {
        self.write(write::Command::AbandonUndispatched {
            host: host.clone(),
            id,
            reference: reference.clone(),
        })
        .await
        .map(|_| ())
    }
    pub(crate) async fn observe(&self, operation: &Operation, receipt: &Receipt) -> Result<()> {
        if !matches!(receipt, Receipt::Recorded { .. }) {
            return Ok(());
        }
        self.write(write::Command::Observe {
            id: operation.id,
            draft: operation.draft.clone(),
            receipt: receipt.clone(),
        })
        .await
        .map(|_| ())
    }

    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .command_buffer_size(write::COMMAND_BUFFER_SIZE)
            .query_planner_stability(true)
            .synchronous(SqliteSynchronous::Full);
        let pool_options = SqlitePoolOptions::new().max_connections(1);
        // WAL admission shares the pool's existing startup budget. In-flight
        // SQLite calls and acknowledged cleanup may finish after that budget.
        let deadline = tokio::time::Instant::now() + pool_options.get_acquire_timeout();
        let pool = pool_options.connect_lazy_with(options);
        let mut connection = match pool.acquire().await {
            Ok(connection) => connection,
            Err(error) => {
                pool.close().await;
                return Err(format!("client journal opening SQLite connection: {error}"));
            }
        };
        let startup: Result<()> = async {
            // Mode changes precede the schema transaction and use SQLite's file
            // locks, including between independent client processes.
            loop {
                match sqlx::query_scalar::<_, String>("PRAGMA journal_mode=WAL")
                    .fetch_one(&mut *connection)
                    .await
                {
                    Ok(mode) if mode == "wal" => break,
                    Ok(mode) => return Err(format!("client journal enabling WAL: SQLite returned {mode}")),
                    Err(error) => {
                        let busy = error.as_database_error()
                            .and_then(|error| error.code())
                            .and_then(|code| code.parse::<i32>().ok())
                            .is_some_and(|code| code & 0xff == 5);

                        if busy {
                            tokio::task::yield_now().await;
                        }
                        if !busy || tokio::time::Instant::now() >= deadline {
                            return Err(format!("client journal enabling WAL: {error}"));
                        }
                    }
                }
            }
            // Serialize schema creation across independent client scopes.
            let mut transaction = sqlx::Connection::begin_with(&mut *connection, "BEGIN IMMEDIATE")
                .await
                .map_err(|error| format!("client journal beginning schema transaction: {error}"))?;
            sqlx::query("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, domain TEXT NOT NULL, deployment TEXT NOT NULL, context TEXT NOT NULL, draft_owner TEXT, reference TEXT, receipt TEXT, abandoned INTEGER NOT NULL DEFAULT 0, upload_adopted INTEGER NOT NULL DEFAULT 0)")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating operations table: {error}"))?;
            sqlx::query("CREATE TABLE IF NOT EXISTS dismissed_controls (operation TEXT PRIMARY KEY REFERENCES operations(id))")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating dismissed controls table: {error}"))?;
            sqlx::query("CREATE TABLE IF NOT EXISTS pending_sends (operation TEXT PRIMARY KEY REFERENCES operations(id), owner TEXT NOT NULL)")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating pending sends table: {error}"))?;
            sqlx::query("CREATE INDEX IF NOT EXISTS pending_sends_owner ON pending_sends(owner)")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal indexing pending sends: {error}"))?;
            for (name, index, remove) in recovery::INDEXES {
                let previous: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
                    .bind(name).fetch_optional(&mut *transaction).await.map_err(error)?;
                if previous.as_ref().is_some_and(|sql| *sql != index.replace(" IF NOT EXISTS", "")) {
                    sqlx::query(remove)
                        .execute(&mut *transaction).await.map_err(error)?;
                }
                sqlx::query(index).execute(&mut *transaction).await
                    .map_err(|error| format!("client journal creating recovery index: {error}"))?;
            }
            sqlx::query("CREATE TABLE IF NOT EXISTS drafts (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]')")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating drafts table: {error}"))?;
            sqlx::query("CREATE TABLE IF NOT EXISTS recent_workspaces (owner TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .execute(&mut *transaction).await.map_err(error)?;
            sqlx::query(include_str!("../migrations/202611100001_draft_quotes.sql"))
                .execute(&mut *transaction).await.map_err(error)?;
            transaction
                .commit()
                .await
                .map_err(|error| format!("client journal committing schema transaction: {error}"))?;
            Ok(())
        }.await;
        if let Err(cause) = startup {
            let closed = connection.close().await;
            pool.close().await;
            return Err(match closed {
                Ok(()) => cause,
                Err(cleanup) => format!("{cause}; closing startup connection: {cleanup}"),
            });
        }
        drop(connection);
        let writes = write::start(pool.clone());
        Ok(Self {
            pool,
            writes,
            path: path.to_owned(),
        })
    }
    pub(crate) async fn load_draft(&self, key: &DraftKey) -> Result<Option<Draft>> {
        let row = sqlx::query("SELECT d.revision,CASE WHEN d.consumed=1 THEN '' ELSE d.text END AS text,CASE WHEN d.consumed=1 THEN '[]' ELSE d.attachments END AS attachments,CASE WHEN d.consumed=1 THEN '[]' ELSE COALESCE(q.quotes,'[]') END AS quotes FROM drafts d LEFT JOIN draft_quotes q ON q.owner=d.owner AND q.revision=d.revision WHERE d.owner=?")
            .bind(serde_json::to_string(key).map_err(error)?)
            .fetch_optional(&self.pool)
            .await
            .map_err(error)?;
        row.map(|row| {
            Ok(Draft {
                quotes: serde_json::from_str(row.try_get("quotes").map_err(error)?)
                    .map_err(error)?,
                revision: row.try_get::<i64, _>("revision").map_err(error)? as u64,
                text: row.try_get("text").map_err(error)?,
                attachments: serde_json::from_str(row.try_get("attachments").map_err(error)?)
                    .map_err(error)?,
            })
        })
        .transpose()
    }

    pub(crate) async fn load(&self, host: &DeploymentRef, id: Uuid) -> Result<Operation> {
        self.find(host, id)
            .await?
            .ok_or_else(|| "original client operation not found for this Host".into())
    }
    pub(crate) async fn find(&self, host: &DeploymentRef, id: Uuid) -> Result<Option<Operation>> {
        let row = sqlx::query("SELECT context,reference,receipt,abandoned FROM operations WHERE id=? AND domain=? AND deployment=?")
            .bind(id.to_string()).bind(&host.state_domain).bind(host.deployment.to_string())
            .fetch_optional(&self.pool).await.map_err(error)?;
        row.map(decode_operation).transpose()
    }

    pub(crate) async fn pending(
        &self,
        host: &DeploymentRef,
        key: &DraftKey,
    ) -> Result<Vec<Operation>> {
        let rows = sqlx::query(recovery::DRAFTS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::to_string(key).map_err(error)?)
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_uploads(
        &self,
        host: &DeploymentRef,
        key: &DraftKey,
    ) -> Result<Vec<Operation>> {
        let rows = sqlx::query(recovery::UPLOADS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::to_string(key).map_err(error)?)
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        let operations = rows
            .into_iter()
            .map(decode_operation)
            .collect::<Result<Vec<_>>>()?;
        for operation in &operations {
            validate_upload(operation, key)?;
        }
        Ok(operations)
    }
    pub(crate) async fn pending_controls(
        &self,
        host: &DeploymentRef,
        owner: &ServiceOwner,
    ) -> Result<Vec<Operation>> {
        let correlation = serde_json::json!({"kind": CONTROL_KIND, "owner": owner}).to_string();
        let rows = sqlx::query(recovery::CONTROLS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::to_string(&CONTROL_METHODS).map_err(error)?)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .bind(&correlation)
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_terminals(
        &self,
        host: &DeploymentRef,
        session: &str,
        owner: &ServiceOwner,
    ) -> Result<Vec<Operation>> {
        let rows = sqlx::query(recovery::TERMINALS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(session)
            .bind(serde_json::json!({"kind":"terminal", "owner":owner}).to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_ui(
        &self,
        host: &DeploymentRef,
        instance: &InstanceId,
    ) -> Result<Vec<Operation>> {
        let rows = sqlx::query("SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND json_extract(context,'$.correlation.kind')='ui' AND json_extract(context,'$.correlation.instance')=? AND (receipt IS NULL OR json_extract(receipt,'$.outcome.kind') IN ('unresolved','unknown') OR json_extract(receipt,'$.cleanup.kind') != 'confirmed') AND abandoned=0 ORDER BY rowid DESC")
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::to_string(instance).map_err(error)?)
            .fetch_all(&self.pool).await.map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_settings(
        &self,
        host: &DeploymentRef,
        owners: &[ServiceOwner],
    ) -> Result<Vec<Operation>> {
        let correlations: Vec<_> = owners
            .iter()
            .map(|owner| serde_json::json!({"kind": SETTINGS_KIND, "owner": owner}))
            .collect();
        let rows = sqlx::query(recovery::SETTINGS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::to_string(&correlations).map_err(error)?)
            .bind(serde_json::to_string(&SETTINGS_METHODS).map_err(error)?)
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextRef<'a> {
    id: Uuid,
    host: &'a DeploymentRef,
    endpoint: &'a str,
    method: &'a str,
    session_id: Option<&'a str>,
    correlation: &'a Value,
    draft: Option<&'a DraftReference>,
    upload: Option<&'a UploadReference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredContext {
    id: Uuid,
    host: DeploymentRef,
    endpoint: String,
    method: String,
    session_id: Option<String>,
    correlation: Value,
    draft: Option<DraftReference>,
    upload: Option<UploadReference>,
}

fn encode_operation(operation: &Operation) -> Result<String> {
    if operation.id.is_nil()
        || operation
            .session_id
            .as_ref()
            .is_some_and(|id| id.is_empty())
    {
        return Err("invalid client operation identity".into());
    }
    maka_plugin_core::json::exact_numbers(&operation.correlation)?;
    serde_json::to_string(&ContextRef {
        id: operation.id,
        host: &operation.host,
        endpoint: &operation.endpoint,
        method: &operation.method,
        session_id: operation.session_id.as_deref(),
        correlation: &operation.correlation,
        draft: operation.draft.as_ref(),
        upload: operation.upload.as_ref(),
    })
    .map_err(error)
}
fn decode_operation(row: SqliteRow) -> Result<Operation> {
    let context: StoredContext =
        serde_json::from_str(row.try_get("context").map_err(error)?).map_err(error)?;
    let reference = row
        .try_get::<Option<&str>, _>("reference")
        .map_err(error)?
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?;
    let receipt = row
        .try_get::<Option<&str>, _>("receipt")
        .map_err(error)?
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?;
    let abandoned = row.try_get::<i64, _>("abandoned").map_err(error)? != 0;
    Ok(Operation {
        id: context.id,
        host: context.host,
        endpoint: context.endpoint,
        method: context.method,
        session_id: context.session_id,
        correlation: context.correlation,
        draft: context.draft,
        upload: context.upload,
        abandoned,
        reference,
        receipt,
    })
}
fn accepted_send(receipt: &Receipt, session: &str) -> bool {
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = receipt
    else {
        return false;
    };
    value.get("sessionId").and_then(Value::as_str) == Some(session)
        && value
            .get("messageId")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        && match value.get("kind").and_then(Value::as_str) {
            Some("started") => value
                .get("runId")
                .and_then(Value::as_str)
                .is_some_and(|id| Uuid::parse_str(id).is_ok_and(|id| !id.is_nil())),
            Some("queued") => value
                .get("revision")
                .and_then(Value::as_u64)
                .is_some_and(|revision| revision <= 9_007_199_254_740_991),
            _ => false,
        }
}

pub(crate) fn queued_send(operation: &Operation) -> Option<(&str, u64)> {
    let receipt = operation.receipt.as_ref()?;
    if !accepted_send(receipt, operation.session_id.as_deref()?) {
        return None;
    }
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    } = receipt
    else {
        return None;
    };
    (value["kind"] == "queued").then(|| {
        (
            value["messageId"]
                .as_str()
                .expect("accepted queued message identity"),
            value["revision"]
                .as_u64()
                .expect("accepted queued message revision"),
        )
    })
}

pub(crate) fn retryable_send(operation: &Operation) -> bool {
    operation.abandoned
        || matches!(
            &operation.receipt,
            Some(Receipt::Recorded {
                outcome: OperationOutcome::NotExecuted { .. },
                ..
            })
        )
        || matches!(&operation.receipt,
            Some(Receipt::Recorded {
                outcome: OperationOutcome::Returned { result: OperationResult::Success { value } }, ..
            }) if matches!(value.get("kind").and_then(Value::as_str), Some("rejected" | "not_your_worker")))
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub(crate) fn validate_upload(operation: &Operation, key: &DraftKey) -> Result<()> {
    if operation.draft.is_some()
        || operation.endpoint != "agent"
        || operation.method != "uploadAttachment"
        || operation.session_id.as_deref() != Some(&key.session_id)
        || operation.upload.as_ref().map(|upload| &upload.key) != Some(key)
        || operation.host.state_domain != key.state_domain
        || operation.host.deployment != key.deployment
        || operation
            .reference
            .as_ref()
            .is_some_and(|reference| !key.matches(reference))
    {
        return Err("original attachment upload belongs to another draft owner".into());
    }
    Ok(())
}

pub(crate) fn uploaded_attachment(operation: &Operation) -> Result<Option<DraftAttachment>> {
    if operation.abandoned {
        return Ok(None);
    }
    if matches!(
        &operation.receipt,
        Some(Receipt::Recorded {
            outcome: OperationOutcome::Unknown { .. },
            ..
        })
    ) {
        return Ok(None);
    }
    match &operation.receipt {
        Some(Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            ..
        }) => return Err(format!("attachment upload failed: {diagnostic}")),
        Some(Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            ..
        }) => return Ok(None),
        _ => {}
    }
    let Some(Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        ..
    }) = &operation.receipt
    else {
        return Err("original attachment upload is unresolved; recover its receipt".into());
    };
    if value["kind"] == "rejected" {
        return Ok(None);
    }
    let upload = operation.upload.as_ref().ok_or("missing upload owner")?;
    let value = value
        .get("attachment")
        .filter(|_| value["kind"] == "uploaded")
        .ok_or("unexpected attachment upload result")?;
    if value["sessionId"] != upload.key.session_id {
        return Err("attachment upload returned another session".into());
    }
    let attachment: DraftAttachment = serde_json::from_value(serde_json::json!({
        "id":value["id"],"name":value["name"],"mimeType":value["mimeType"],"bytes":value["bytes"]
    }))
    .map_err(error)?;
    if attachment.id.is_empty() || attachment.bytes != upload.bytes as u64 {
        return Err("attachment upload receipt differs from the original file".into());
    }
    Ok(Some(attachment))
}
