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
use crate::{CONTROL_KIND, CONTROL_METHODS, Result, SETTINGS_KIND, SETTINGS_METHODS};
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
        "draft_owner IS NULL AND json_type(context,'$.draft')='null' AND json_type(context,'$.sessionId')='null' AND json_type(context,'$.correlation')='object' AND json_extract(context,'$.correlation')=? AND ((json_extract(context,'$.endpoint')='settings' AND json_extract(context,'$.method') IN (SELECT value FROM json_each(?))) OR (json_extract(context,'$.endpoint')='agent' AND json_extract(context,'$.method')='updateGlobalInstructions') OR (json_extract(context,'$.endpoint')='setup' AND json_extract(context,'$.method')='discoverModels') OR (json_extract(context,'$.endpoint')='management' AND json_extract(context,'$.method') IN ('setEnabled','configure')) OR (json_extract(context,'$.endpoint')='authentication' AND json_extract(context,'$.method')='loginCredential'))"
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
    /// A known returned business outcome; absent is never proof that it did not run.
    pub receipt: Option<Receipt>,
}

/// Opened by the trusted launcher in the client's own data directory, never from guest input.
#[derive(Clone)]
pub struct Journal {
    pub(crate) pool: SqlitePool,
    writes: tokio::sync::mpsc::Sender<write::Pending>,
    #[cfg(test)]
    pub(crate) preparing: std::sync::Arc<tokio::sync::Notify>,
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

mod recovery;
mod write;

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
    pub(crate) async fn reserve(&self, operation: &Operation) -> Result<()> {
        self.write(write::Command::Reserve(write::Reservation::new(operation)?))
            .await
            .map(|_| ())
    }
    pub(crate) async fn reserve_settings(&self, operation: &Operation) -> Result<()> {
        self.write(write::Command::ReserveSettings(write::Reservation::new(
            operation,
        )?))
        .await
        .map(|_| ())
    }
    pub(crate) async fn prepared(&self, id: Uuid, reference: &RecoveryRef) -> Result<()> {
        #[cfg(test)]
        self.preparing.notify_one();
        self.write(write::Command::Prepared {
            id,
            reference: reference.clone(),
        })
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
        if !matches!(
            receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Returned { .. },
                ..
            }
        ) {
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
        Self::open_inner(
            path,
            #[cfg(test)]
            None,
        )
        .await
    }

    async fn open_inner(
        path: &Path,
        #[cfg(test)] contention: Option<&tokio::sync::Notify>,
    ) -> Result<Self> {
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
                        #[cfg(test)]
                        if busy && let Some(contention) = contention {
                            contention.notify_one();
                        }
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
            sqlx::query("CREATE INDEX IF NOT EXISTS operations_pending ON operations(domain,deployment,draft_owner) WHERE receipt IS NULL AND abandoned=0")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating pending operations index: {error}"))?;
            for index in recovery::INDEXES {
                sqlx::query(index).execute(&mut *transaction).await
                    .map_err(|error| format!("client journal creating recovery index: {error}"))?;
            }
            sqlx::query("CREATE TABLE IF NOT EXISTS drafts (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]')")
                .execute(&mut *transaction).await.map_err(|error| format!("client journal creating drafts table: {error}"))?;
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
            #[cfg(test)]
            preparing: std::sync::Arc::new(tokio::sync::Notify::new()),
        })
    }
    pub(crate) async fn load_draft(&self, key: &DraftKey) -> Result<Option<Draft>> {
        let row = sqlx::query("SELECT revision,CASE WHEN consumed=1 THEN '' ELSE text END AS text,CASE WHEN consumed=1 THEN '[]' ELSE attachments END AS attachments FROM drafts WHERE owner=?")
            .bind(serde_json::to_string(key).map_err(error)?)
            .fetch_optional(&self.pool)
            .await
            .map_err(error)?;
        row.map(|row| {
            Ok(Draft {
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
    pub(crate) async fn pending_controls(&self, host: &DeploymentRef) -> Result<Vec<Operation>> {
        let correlation = serde_json::json!({"kind": CONTROL_KIND}).to_string();
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
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_terminals(
        &self,
        host: &DeploymentRef,
        session: &str,
    ) -> Result<Vec<Operation>> {
        let rows = sqlx::query(recovery::TERMINALS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(session)
            .bind(serde_json::json!({"kind":"terminal"}).to_string())
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
    pub(crate) async fn pending_settings(&self, host: &DeploymentRef) -> Result<Vec<Operation>> {
        let rows = sqlx::query(recovery::SETTINGS)
            .bind(&host.state_domain)
            .bind(host.deployment.to_string())
            .bind(serde_json::json!({"kind": SETTINGS_KIND}).to_string())
            .bind(serde_json::to_string(&SETTINGS_METHODS).map_err(error)?)
            .fetch_all(&self.pool)
            .await
            .map_err(error)?;
        rows.into_iter().map(decode_operation).collect()
    }
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
    serde_json::to_string(operation).map_err(error)
}
fn decode_operation(row: SqliteRow) -> Result<Operation> {
    let mut operation: Operation =
        serde_json::from_str(row.try_get("context").map_err(error)?).map_err(error)?;
    operation.reference = row
        .try_get::<Option<&str>, _>("reference")
        .map_err(error)?
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?;
    operation.receipt = row
        .try_get::<Option<&str>, _>("receipt")
        .map_err(error)?
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?;
    operation.abandoned = row.try_get::<i64, _>("abandoned").map_err(error)? != 0;
    Ok(operation)
}
fn accepted_send(receipt: &Receipt, session: &str) -> bool {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
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
                .get("invocationId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty()),
            Some("queued") => value
                .get("revision")
                .and_then(Value::as_u64)
                .is_some_and(|revision| revision <= 9_007_199_254_740_991),
            _ => false,
        }
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
    let Some(Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
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

#[cfg(test)]
mod tests {
    use super::*;
    use maka_plugin_core::operation::OperationCleanup;
    use sqlx::{Connection, SqliteConnection};

    #[tokio::test]
    async fn reopened_terminal_recovery_lists_every_unsettled_original_for_its_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("client.db");
        let journal = Journal::open(&path).await.unwrap();
        let host = DeploymentRef {
            state_domain: "a".repeat(64),
            deployment: Uuid::from_u128(1),
            revision: 1,
        };
        let mut expected = Vec::new();
        for id in 1..=132 {
            let operation = Operation {
                id: Uuid::from_u128(id),
                host: host.clone(),
                endpoint: "terminal".into(),
                method: "start".into(),
                session_id: Some(if id == 130 { "other" } else { "session" }.into()),
                correlation: serde_json::json!({"kind":"terminal"}),
                draft: None,
                upload: None,
                abandoned: false,
                reference: None,
                receipt: None,
            };
            journal.reserve(&operation).await.unwrap();
            match id {
                130 => {}
                131 => {
                    journal.abandon(&host, operation.id).await.unwrap();
                }
                132 => {
                    journal
                        .observe(
                            &operation,
                            &Receipt::Recorded {
                                outcome: OperationOutcome::Returned {
                                    value: serde_json::json!({"kind":"started"}),
                                },
                                cleanup: OperationCleanup::Confirmed,
                            },
                        )
                        .await
                        .unwrap();
                }
                _ => expected.push(operation.id),
            }
        }
        journal.pool.close().await;
        let journal = Journal::open(&path).await.unwrap();
        let pending = journal.pending_terminals(&host, "session").await.unwrap();
        expected.reverse();
        assert_eq!(
            pending
                .iter()
                .map(|operation| operation.id)
                .collect::<Vec<_>>(),
            expected
        );
        journal.pool.close().await;
    }

    async fn seeded_journal() -> (tempfile::TempDir, std::path::PathBuf, DraftKey) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("client.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::query("CREATE TABLE drafts (owner TEXT PRIMARY KEY, revision INTEGER NOT NULL, text TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, attachments TEXT NOT NULL DEFAULT '[]')").execute(&pool).await.unwrap();
        let key = DraftKey {
            state_domain: "original-host".into(),
            deployment: Uuid::from_u128(1),
            namespace: InstanceId(vec![Uuid::from_u128(2)]),
            export: "Agent".into(),
            session_id: "original-session".into(),
            editor_id: "composer".into(),
        };
        sqlx::query("INSERT INTO drafts(owner,revision,text) VALUES (?,7,'original unsent text')")
            .bind(serde_json::to_string(&key).unwrap())
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        (directory, path, key)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_open_preserves_the_existing_draft_and_revision() {
        let (_directory, path, key) = seeded_journal().await;
        let (first, second) = tokio::join!(Journal::open(&path), Journal::open(&path));
        let (first, second) = (first.unwrap(), second.unwrap());
        let loaded = first.load_draft(&key).await.unwrap().unwrap();
        assert_eq!(
            (
                loaded.revision,
                loaded.text.as_str(),
                loaded.attachments.len()
            ),
            (7, "original unsent text", 0)
        );
        first
            .save_draft(&key, Some(7), "edited after reopening".to_owned().into())
            .await
            .unwrap();
        assert_eq!(
            second.load_draft(&key).await.unwrap().unwrap().text,
            "edited after reopening"
        );
        assert!(
            second
                .save_draft(&key, Some(7), "stale scope".to_owned().into())
                .await
                .is_err()
        );
    }

    async fn seeded_journal_with_reader() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        DraftKey,
        SqliteConnection,
    ) {
        let (directory, path, key) = seeded_journal().await;
        let mut reader =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
                .await
                .unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut reader)
            .await
            .unwrap();
        assert_eq!(mode, "delete");
        sqlx::query("BEGIN").execute(&mut reader).await.unwrap();
        let revision: i64 = sqlx::query_scalar("SELECT revision FROM drafts")
            .fetch_one(&mut reader)
            .await
            .unwrap();
        assert_eq!(revision, 7);

        (directory, path, key, reader)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn open_waits_for_a_real_reader_before_loading_the_existing_draft() {
        let (_directory, path, key, mut reader) = seeded_journal_with_reader().await;
        let contention = tokio::sync::Notify::new();
        let opening = Journal::open_inner(&path, Some(&contention));
        tokio::pin!(opening);
        let observed = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            tokio::select! {
                biased;
                () = contention.notified() => None,
                result = &mut opening => Some(result),
            }
        })
        .await;
        // Release even when startup returned an unexpected non-contention error.
        let rollback = sqlx::query("ROLLBACK").execute(&mut reader).await;
        let closed = reader.close().await;
        rollback.unwrap();
        closed.unwrap();
        let result = match observed.expect("startup did not report contention or finish") {
            Some(result) => result,
            None => opening.await,
        };
        let first = result.expect("startup must resume after the real reader releases its lock");
        let second = Journal::open(&path).await.unwrap();
        let loaded = first.load_draft(&key).await.unwrap().unwrap();
        assert_eq!(
            (
                loaded.revision,
                loaded.text.as_str(),
                loaded.attachments.len()
            ),
            (7, "original unsent text", 0)
        );
        let edited = first
            .save_draft(&key, Some(7), "edited after reopening".into())
            .await
            .unwrap();
        assert_eq!(edited.revision, 8);
        let stale = second.save_draft(&key, Some(7), "stale scope".into()).await;
        let loaded = second.load_draft(&key).await.unwrap().unwrap();
        for journal in [&first, &second] {
            let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                .fetch_one(&journal.pool)
                .await
                .unwrap();
            let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
                .fetch_one(&journal.pool)
                .await
                .unwrap();
            assert_eq!((mode.as_str(), synchronous), ("wal", 2));
        }
        first.pool.close().await;
        second.pool.close().await;
        assert!(stale.is_err());
        assert_eq!(
            (
                loaded.revision,
                loaded.text.as_str(),
                loaded.attachments.len()
            ),
            (8, "edited after reopening", 0)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_contended_open_leaves_the_original_draft_reopenable() {
        let (_directory, path, key, mut reader) = seeded_journal_with_reader().await;
        let contention = tokio::sync::Notify::new();
        let mut opening = Box::pin(Journal::open_inner(&path, Some(&contention)));
        let observed = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            tokio::select! {
                biased;
                () = contention.notified() => Ok(()),
                result = &mut opening => Err(result.err()),
            }
        })
        .await;
        drop(opening);
        let rollback = sqlx::query("ROLLBACK").execute(&mut reader).await;
        let closed = reader.close().await;
        rollback.unwrap();
        closed.unwrap();
        observed
            .expect("startup did not report contention")
            .expect("startup returned before cancellation");
        let journal = Journal::open(&path).await.unwrap();
        let draft = journal.load_draft(&key).await.unwrap().unwrap();
        journal.pool.close().await;
        assert_eq!(
            (draft.revision, draft.text.as_str(), draft.attachments.len()),
            (7, "original unsent text", 0)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn contended_open_exhausts_its_budget_without_losing_the_original_draft() {
        let (_directory, path, key, mut reader) = seeded_journal_with_reader().await;
        let started = tokio::time::Instant::now();
        let result = Journal::open(&path).await;
        let elapsed = started.elapsed();
        let rollback = sqlx::query("ROLLBACK").execute(&mut reader).await;
        let closed = reader.close().await;
        rollback.unwrap();
        closed.unwrap();
        let cause = result
            .err()
            .expect("held reader must prevent WAL admission");
        assert!(
            cause.contains("client journal enabling WAL:") && cause.contains("(code: 5)"),
            "{cause}"
        );
        assert!(elapsed >= SqlitePoolOptions::new().get_acquire_timeout());
        let journal = Journal::open(&path).await.unwrap();
        let draft = journal.load_draft(&key).await.unwrap().unwrap();
        journal.pool.close().await;
        assert_eq!(
            (draft.revision, draft.text.as_str(), draft.attachments.len()),
            (7, "original unsent text", 0)
        );
    }

    #[tokio::test]
    async fn schema_failure_keeps_its_stage_and_releases_the_startup_transaction() {
        let (_directory, path, _key) = seeded_journal().await;
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
                .await
                .unwrap();
        sqlx::query("CREATE TABLE operations (id TEXT PRIMARY KEY)")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        let cause = Journal::open(&path)
            .await
            .err()
            .expect("invalid schema must fail");
        assert!(
            cause.contains("client journal creating pending operations index:")
                && cause.contains("(code: 1)"),
            "{cause}"
        );
        let mut connection =
            SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
                .await
                .unwrap();
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut connection)
            .await
            .unwrap();
        let row = sqlx::query("SELECT revision,text FROM drafts")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        sqlx::query("ROLLBACK")
            .execute(&mut connection)
            .await
            .unwrap();
        connection.close().await.unwrap();
        assert_eq!(
            (row.get::<i64, _>("revision"), row.get::<&str, _>("text")),
            (7, "original unsent text")
        );
    }
}
