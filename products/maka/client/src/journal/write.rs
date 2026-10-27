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

//! Serial durable journal writes, grouped without changing their commit boundaries.
use super::{
    Draft, DraftAttachment, DraftEdit, DraftKey, DraftReference, Operation, accepted_send,
    decode_operation, encode_operation, error, uploaded_attachment, validate_upload,
};
use crate::{Result, SETTINGS_KIND, SETTINGS_METHODS};
use maka_plugin_core::{
    deployment::DeploymentRef,
    operation::{OperationCleanup, OperationOutcome, Receipt, RecoveryRef},
};
use sqlx::{Row, SqliteConnection, SqlitePool};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

pub(super) struct Reservation {
    id: String,
    domain: String,
    deployment: String,
    context: String,
    draft_owner: Option<String>,
}
impl Reservation {
    pub(super) fn new(operation: &Operation) -> Result<Self> {
        let context = encode_operation(operation)?;
        let draft_owner = operation
            .draft
            .as_ref()
            .map(|draft| &draft.key)
            .or_else(|| operation.upload.as_ref().map(|upload| &upload.key))
            .map(serde_json::to_string)
            .transpose()
            .map_err(error)?;
        Ok(Self {
            id: operation.id.to_string(),
            domain: operation.host.state_domain.clone(),
            deployment: operation.host.deployment.to_string(),
            context,
            draft_owner,
        })
    }
}

pub(super) enum Command {
    SaveDraft {
        key: DraftKey,
        expected: Option<u64>,
        edit: DraftEdit,
    },
    Reserve(Reservation),
    ReserveSettings(Reservation),
    Prepared {
        id: Uuid,
        reference: RecoveryRef,
    },
    Abandon {
        host: DeploymentRef,
        id: Uuid,
    },
    AbandonUndispatched {
        host: DeploymentRef,
        id: Uuid,
        reference: RecoveryRef,
    },
    Observe {
        id: Uuid,
        draft: Option<DraftReference>,
        receipt: Receipt,
    },
}
pub(super) enum Output {
    Unit,
    Draft(Draft),
    Operation(Box<Operation>),
}
pub(super) struct Pending {
    pub command: Command,
    pub reply: oneshot::Sender<Result<Output>>,
}
impl Command {
    async fn execute(self, connection: &mut SqliteConnection) -> Result<Output> {
        match self {
            Self::SaveDraft {
                key,
                expected,
                edit,
            } => save_draft(connection, &key, expected, edit)
                .await
                .map(Output::Draft),
            Self::Reserve(reservation) => reserve(connection, reservation)
                .await
                .map(|()| Output::Unit),
            Self::ReserveSettings(reservation) => reserve_settings(connection, reservation)
                .await
                .map(|()| Output::Unit),
            Self::Prepared { id, reference } => prepared(connection, id, &reference)
                .await
                .map(|()| Output::Unit),
            Self::Abandon { host, id } => abandon(connection, &host, id)
                .await
                .map(|operation| Output::Operation(Box::new(operation))),
            Self::AbandonUndispatched {
                host,
                id,
                reference,
            } => abandon_undispatched(connection, &host, id, &reference)
                .await
                .map(|()| Output::Unit),
            Self::Observe { id, draft, receipt } => {
                observe(connection, id, draft.as_ref(), &receipt)
                    .await
                    .map(|()| Output::Unit)
            }
        }
    }
}
// Match SQLx SQLite's existing default worker command budget. Waiting callers
// retain ownership until handoff; accepted commands survive observer cancellation.
pub(super) const COMMAND_BUFFER_SIZE: usize = 50;

pub(super) fn start(pool: SqlitePool) -> mpsc::Sender<Pending> {
    let (sender, receiver) = mpsc::channel(COMMAND_BUFFER_SIZE);
    tokio::spawn(run(pool, receiver));
    sender
}
async fn run(pool: SqlitePool, mut receiver: mpsc::Receiver<Pending>) {
    while let Some(first) = receiver.recv().await {
        // Freeze the ready queue: continuous arrival must not postpone commit.
        let ready = receiver.len();
        let mut batch = Vec::with_capacity(ready + 1);
        batch.push(first);
        for _ in 0..ready {
            if let Ok(pending) = receiver.try_recv() {
                batch.push(pending);
            }
        }
        commit_batch(&pool, batch).await;
    }
}
async fn commit_batch(pool: &SqlitePool, batch: Vec<Pending>) {
    let (commands, replies): (Vec<_>, Vec<_>) = batch
        .into_iter()
        .map(|pending| (pending.command, pending.reply))
        .unzip();
    let mut prepared = Vec::with_capacity(commands.len());
    let result: Result<()> = async {
        let mut connection = pool.acquire().await.map_err(error)?;
        let mut transaction = sqlx::Connection::begin_with(&mut *connection, "BEGIN IMMEDIATE")
            .await
            .map_err(error)?;
        let writing: Result<()> = async {
            for command in commands {
                sqlx::query("SAVEPOINT journal_command")
                    .execute(&mut *transaction)
                    .await
                    .map_err(error)?;
                let result = command.execute(&mut transaction).await;
                if let Err(cause) = &result {
                    sqlx::query("ROLLBACK TO journal_command")
                        .execute(&mut *transaction)
                        .await
                        .map_err(|rollback| {
                            format!("{cause}; rolling back journal command: {rollback}")
                        })?;
                }
                sqlx::query("RELEASE journal_command")
                    .execute(&mut *transaction)
                    .await
                    .map_err(error)?;
                prepared.push(result);
            }
            Ok(())
        }
        .await;
        if let Err(cause) = writing {
            return match transaction.rollback().await {
                Ok(()) => Err(cause),
                Err(rollback) => Err(format!("{cause}; rolling back journal writes: {rollback}")),
            };
        }
        transaction
            .commit()
            .await
            .map_err(|cause| format!("client journal committing writes: {cause}"))
    }
    .await;
    match result {
        Ok(()) => {
            for (reply, value) in replies.into_iter().zip(prepared) {
                let _ = reply.send(value);
            }
        }
        Err(cause) => {
            for reply in replies {
                let _ = reply.send(Err(cause.clone()));
            }
        }
    }
}

async fn save_draft(
    connection: &mut SqliteConnection,
    key: &DraftKey,
    expected: Option<u64>,
    edit: DraftEdit,
) -> Result<Draft> {
    if expected.is_some_and(|revision| revision == 0 || revision >= 9_007_199_254_740_991) {
        return Err("invalid draft revision".into());
    }
    let attachments = serde_json::to_string(&edit.attachments).map_err(error)?;
    if edit
        .attachments
        .iter()
        .any(|attachment| attachment.id.is_empty() || attachment.name.is_empty())
        || edit
            .attachments
            .iter()
            .enumerate()
            .any(|(index, attachment)| {
                edit.attachments[..index]
                    .iter()
                    .any(|other| other.id == attachment.id)
            })
    {
        return Err("invalid draft attachments".into());
    }
    let encoded_key = serde_json::to_string(key).map_err(error)?;
    // A save queued before a send receipt may still follow its consumption
    // at this same revision, as text edits already can. Keep its verified
    // metadata available for that CAS; consumed load still returns [].
    let previous: Option<String> =
        sqlx::query_scalar("SELECT attachments FROM drafts WHERE owner=?")
            .bind(&encoded_key)
            .fetch_optional(&mut *connection)
            .await
            .map_err(error)?;
    let mut admitted: Vec<DraftAttachment> = previous
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?
        .unwrap_or_default();
    for id in &edit.settled_uploads {
        let row = sqlx::query("SELECT context,reference,receipt,abandoned FROM operations WHERE id=? AND domain=? AND deployment=? AND draft_owner=?")
                .bind(id.to_string()).bind(&key.state_domain).bind(key.deployment.to_string())
                .bind(&encoded_key).fetch_optional(&mut *connection).await.map_err(error)?
                .ok_or("original attachment upload not found for this draft")?;
        let original = decode_operation(row)?;
        validate_upload(&original, key)?;
        let attachment = uploaded_attachment(&original)?;
        if let Some(attachment) = attachment {
            admitted.push(attachment);
        }
        sqlx::query("UPDATE operations SET upload_adopted=1 WHERE id=?")
            .bind(id.to_string())
            .execute(&mut *connection)
            .await
            .map_err(error)?;
    }
    if edit
        .attachments
        .iter()
        .any(|attachment| !admitted.contains(attachment))
    {
        return Err("draft attachment differs from its original upload receipt".into());
    }
    let row = if let Some(revision) = expected {
            sqlx::query("UPDATE drafts SET revision=revision+1,text=?,attachments=?,consumed=0 WHERE owner=? AND revision=? RETURNING revision,text,attachments")
                .bind(edit.text).bind(attachments).bind(encoded_key).bind(revision as i64)
                .fetch_optional(&mut *connection).await.map_err(error)?
        } else {
            sqlx::query("INSERT INTO drafts (owner,revision,text,attachments) VALUES (?,1,?,?) ON CONFLICT DO NOTHING RETURNING revision,text,attachments")
                .bind(encoded_key).bind(edit.text).bind(attachments)
                .fetch_optional(&mut *connection).await.map_err(error)?
        }.ok_or("draft revision conflicts with a newer saved value")?;
    let draft = Draft {
        revision: row.try_get::<i64, _>("revision").map_err(error)? as u64,
        text: row.try_get("text").map_err(error)?,
        attachments: serde_json::from_str(row.try_get("attachments").map_err(error)?)
            .map_err(error)?,
    };
    Ok(draft)
}

async fn reserve(connection: &mut SqliteConnection, reservation: Reservation) -> Result<()> {
    let inserted = sqlx::query(
            "INSERT OR IGNORE INTO operations (id,domain,deployment,context,draft_owner) VALUES (?,?,?,?,?)",
        )
        .bind(reservation.id)
        .bind(&reservation.domain)
        .bind(&reservation.deployment)
        .bind(reservation.context)
        .bind(reservation.draft_owner)
        .execute(&mut *connection)
        .await
        .map_err(error)?;
    if inserted.rows_affected() != 1 {
        return Err("client operation already exists; recover the original attempt".into());
    }
    Ok(())
}

async fn reserve_settings(
    connection: &mut SqliteConnection,
    reservation: Reservation,
) -> Result<()> {
    let inserted = sqlx::query(concat!(
            "INSERT OR IGNORE INTO operations (id,domain,deployment,context,draft_owner) SELECT ?,?,?,?,NULL WHERE NOT EXISTS (SELECT 1 FROM operations WHERE domain=? AND deployment=? AND ",
            settings_owner_sql!(),
            " AND receipt IS NULL AND abandoned=0)"
        ))
            .bind(reservation.id)
            .bind(&reservation.domain)
            .bind(&reservation.deployment)
            .bind(reservation.context)
            .bind(&reservation.domain)
            .bind(&reservation.deployment)
            .bind(serde_json::json!({"kind": SETTINGS_KIND}).to_string())
            .bind(serde_json::to_string(&SETTINGS_METHODS).map_err(error)?)
            .execute(&mut *connection)
            .await
            .map_err(error)?;
    if inserted.rows_affected() != 1 {
        return Err("settings operation already exists or has an unresolved original".into());
    }
    Ok(())
}

async fn prepared(
    connection: &mut SqliteConnection,
    id: Uuid,
    reference: &RecoveryRef,
) -> Result<()> {
    let encoded = serde_json::to_string(reference).map_err(error)?;
    let updated = sqlx::query(
        "UPDATE operations SET reference=? WHERE id=? AND reference IS NULL AND abandoned=0",
    )
    .bind(encoded)
    .bind(id.to_string())
    .execute(&mut *connection)
    .await
    .map_err(error)?;
    if updated.rows_affected() != 1 {
        return Err("original client preparation was already recorded or is unavailable".into());
    }
    Ok(())
}

async fn abandon(
    connection: &mut SqliteConnection,
    host: &DeploymentRef,
    id: Uuid,
) -> Result<Operation> {
    sqlx::query("UPDATE operations SET abandoned=1 WHERE id=? AND domain=? AND deployment=? AND reference IS NULL AND receipt IS NULL")
            .bind(id.to_string()).bind(&host.state_domain).bind(host.deployment.to_string())
            .execute(&mut *connection).await.map_err(error)?;
    let row = sqlx::query("SELECT context,reference,receipt,abandoned FROM operations WHERE id=? AND domain=? AND deployment=?")
            .bind(id.to_string()).bind(&host.state_domain).bind(host.deployment.to_string())
            .fetch_optional(&mut *connection).await.map_err(error)?
            .ok_or("original client operation not found for this Host")?;
    decode_operation(row)
}

async fn abandon_undispatched(
    connection: &mut SqliteConnection,
    host: &DeploymentRef,
    id: Uuid,
    reference: &RecoveryRef,
) -> Result<()> {
    // The prepare observer may have disappeared before its reference write.
    // This same fence also rejects that write if it arrives after the abort.
    let updated = sqlx::query("UPDATE operations SET abandoned=1 WHERE id=? AND domain=? AND deployment=? AND (reference IS NULL OR reference=?) AND receipt IS NULL")
            .bind(id.to_string()).bind(&host.state_domain).bind(host.deployment.to_string())
            .bind(serde_json::to_string(reference).map_err(error)?)
            .execute(&mut *connection).await.map_err(error)?;
    if updated.rows_affected() != 1 {
        return Err("original undispatched preparation is unavailable".into());
    }
    Ok(())
}

async fn observe(
    connection: &mut SqliteConnection,
    id: Uuid,
    draft: Option<&DraftReference>,
    receipt: &Receipt,
) -> Result<()> {
    let Receipt::Recorded {
        outcome: OperationOutcome::Returned { .. },
        ..
    } = receipt
    else {
        // A failed observer and an absent/unresolved journal cannot erase a returned result.
        return Ok(());
    };
    let row = sqlx::query("SELECT receipt FROM operations WHERE id=?")
        .bind(id.to_string())
        .fetch_one(&mut *connection)
        .await
        .map_err(error)?;
    let previous: Option<Receipt> = row
        .try_get::<Option<&str>, _>("receipt")
        .map_err(error)?
        .map(serde_json::from_str)
        .transpose()
        .map_err(error)?;
    let mut next = receipt.clone();
    if let Some(Receipt::Recorded {
        outcome: before,
        cleanup: previous_cleanup,
    }) = previous
    {
        let Receipt::Recorded { outcome, cleanup } = &mut next else {
            unreachable!()
        };
        if before != *outcome {
            return Err("original operation returned conflicting receipts".into());
        }
        if previous_cleanup == OperationCleanup::Confirmed {
            *cleanup = previous_cleanup;
        }
    }
    sqlx::query("UPDATE operations SET receipt=? WHERE id=?")
        .bind(serde_json::to_string(&next).map_err(error)?)
        .bind(id.to_string())
        .execute(&mut *connection)
        .await
        .map_err(error)?;
    if let Some(draft) = draft
        && accepted_send(&next, &draft.key.session_id)
    {
        // Receipt and conditional draft clearing are one durable product
        // transition. A later edit or unknown outcome cannot clear this text.
        sqlx::query("UPDATE drafts SET consumed=1,text='' WHERE owner=? AND revision=?")
            .bind(serde_json::to_string(&draft.key).map_err(error)?)
            .bind(draft.revision as i64)
            .execute(&mut *connection)
            .await
            .map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
