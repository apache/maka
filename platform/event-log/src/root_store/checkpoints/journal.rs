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

use super::*;
use sqlx::{Connection, SqliteConnection};

async fn binding(db: &mut SqliteConnection, request: &Request) -> Result<(), StoreError> {
    let scope: Option<String> =
        sqlx::query_scalar("SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?")
            .bind(&request.session_id)
            .fetch_optional(db)
            .await?;
    if let Some(scope) = scope
        && serde_json::from_str::<Scope>(&scope)? != request.scope
    {
        return Err(invalid("history checkpoint binding differs"));
    }
    Ok(())
}

async fn receipt(
    db: &mut SqliteConnection,
    request: &Request,
) -> Result<Option<Publication>, StoreError> {
    binding(db, request).await?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT request_json,publication_json FROM history_checkpoint_publications WHERE request_key=?")
        .bind(request.key()?).fetch_optional(db).await?;
    row.map(|(original, state)| {
        if serde_json::from_str::<Request>(&original)? != *request {
            return Err(invalid(
                "history checkpoint operation fingerprint or inputs differ",
            ));
        }
        Ok(serde_json::from_str(&state)?)
    })
    .transpose()
}

async fn head(db: &mut SqliteConnection, session: &str) -> Result<Option<Head>, StoreError> {
    let json: Option<String> =
        sqlx::query_scalar("SELECT head_json FROM history_checkpoint_heads WHERE session_id=?")
            .bind(session)
            .fetch_optional(db)
            .await?;
    json.map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

async fn write(
    db: &mut SqliteConnection,
    request: &Request,
    value: &Publication,
) -> Result<(), StoreError> {
    let changed = sqlx::query(
        "UPDATE history_checkpoint_publications SET publication_json=? WHERE request_key=?",
    )
    .bind(serde_json::to_string(value)?)
    .bind(request.key()?)
    .execute(db)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(invalid("checkpoint request missing"));
    }
    Ok(())
}

pub(super) async fn read(
    log: &EventLog,
    request: Request,
) -> Result<Option<Publication>, StoreError> {
    log.connection
        .read(move |db| Box::pin(async move { receipt(db, &request).await }))
        .await
}

pub(super) async fn read_head(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Option<Head>, StoreError> {
    log.connection
        .read(move |db| {
            Box::pin(async move {
                let mut tx = db.begin().await?;
                let bound: Option<String> = sqlx::query_scalar(
                    "SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?",
                )
                .bind(&session)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some(bound) = bound
                    && serde_json::from_str::<Scope>(&bound)? != scope
                {
                    return Err(invalid("history checkpoint binding differs"));
                }
                let value = head(&mut tx, &session).await?;
                tx.rollback().await?;
                Ok(value)
            })
        })
        .await
}

/// The claim linearizes retries. Only the caller that inserted it may capture.
pub(super) async fn claim(
    log: &EventLog,
    request: Request,
) -> Result<(Publication, bool), StoreError> {
    log.connection.run(move |db| Box::pin(async move {
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(value) = receipt(&mut tx, &request).await? {
            tx.rollback().await?;
            return Ok((value, false));
        }
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)")
            .bind(&request.session_id).fetch_one(&mut *tx).await?;
        if !exists { return Err(StoreError::SessionNotFound); }
        sqlx::query("INSERT INTO history_checkpoint_bindings VALUES(?,?) ON CONFLICT(session_id) DO NOTHING")
            .bind(&request.session_id).bind(serde_json::to_string(&request.scope)?).execute(&mut *tx).await?;
        let value = Publication { state: PublicationState::Capturing, cleanup_pending: true, cleanup_error: None };
        sqlx::query("INSERT INTO history_checkpoint_publications VALUES(?,?,?,?)")
            .bind(request.key()?).bind(&request.session_id)
            .bind(serde_json::to_string(&request)?).bind(serde_json::to_string(&value)?)
            .execute(&mut *tx).await?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        Ok((value, true))
    })).await
}

pub(super) async fn prepare(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
) -> Result<(), StoreError> {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                let mut value = receipt(&mut tx, &request)
                    .await?
                    .ok_or_else(|| invalid("checkpoint claim missing"))?;
                if value.state != PublicationState::Capturing {
                    return Err(invalid("checkpoint is not capturing"));
                }
                value.state = PublicationState::Prepared { manifest };
                write(&mut tx, &request, &value).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)
            })
        })
        .await
}

/// Head and domain receipt share this transaction. Host operation settlement is separate.
pub(super) async fn commit(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
) -> Result<Publication, StoreError> {
    log.connection.run(move |db| Box::pin(async move {
        let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
        let mut value = receipt(&mut tx, &request).await?.ok_or_else(|| invalid("checkpoint claim missing"))?;
        match &value.state {
            PublicationState::Published { .. } | PublicationState::Conflict { .. } => {
                tx.rollback().await?;
                return Ok(value);
            }
            PublicationState::Prepared { manifest: original } if original == &manifest => {}
            _ => return Err(invalid("checkpoint prepared material differs")),
        }
        let actual = head(&mut tx, &request.session_id).await?.map(|head| head.revision);
        if actual != request.publication.expected_revision {
            value.state = PublicationState::Conflict { actual };
        } else {
            let head = Head { revision: Revision(uuid::Uuid::new_v4()), manifest };
            sqlx::query("INSERT INTO history_checkpoint_heads VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET head_json=excluded.head_json")
                .bind(&request.session_id).bind(serde_json::to_string(&head)?).execute(&mut *tx).await?;
            value.state = PublicationState::Published { head };
            boundary("head_written");
        }
        write(&mut tx, &request, &value).await?;
        tx.commit().await.map_err(StoreError::CommitUnknown)?;
        Ok(value)
    })).await
}

pub(super) async fn interrupt(log: &EventLog, request: Request) -> Result<(), StoreError> {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                let mut value = receipt(&mut tx, &request)
                    .await?
                    .ok_or_else(|| invalid("checkpoint claim missing"))?;
                if value.state == PublicationState::Capturing {
                    value.state = PublicationState::Interrupted;
                    write(&mut tx, &request, &value).await?;
                }
                tx.commit().await.map_err(StoreError::CommitUnknown)
            })
        })
        .await
}

pub(super) async fn record_cleanup(
    log: &EventLog,
    request: Request,
    cause: Option<String>,
) -> Result<(), StoreError> {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                let mut value = receipt(&mut tx, &request)
                    .await?
                    .ok_or_else(|| invalid("checkpoint claim missing"))?;
                value.cleanup_pending = cause.is_some();
                value.cleanup_error = cause;
                write(&mut tx, &request, &value).await?;
                tx.commit().await.map_err(StoreError::CommitUnknown)
            })
        })
        .await
}

pub(super) async fn unavailable(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
    cause: String,
) -> Result<Publication, StoreError> {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                let mut value = receipt(&mut tx, &request)
                    .await?
                    .ok_or_else(|| invalid("checkpoint claim missing"))?;
                if value.state
                    == (PublicationState::Prepared {
                        manifest: manifest.clone(),
                    })
                {
                    value.state = PublicationState::Unavailable { manifest, cause };
                    write(&mut tx, &request, &value).await?;
                }
                tx.commit().await.map_err(StoreError::CommitUnknown)?;
                Ok(value)
            })
        })
        .await
}

/// Startup-only bounded pages, before service admission. No caller can add requests.
pub(super) async fn pending(
    log: &EventLog,
    after: String,
) -> Result<Vec<(String, Request, Publication)>, StoreError> {
    log.connection.read(move |db| Box::pin(async move {
        let rows: Vec<(String,String,String)> = sqlx::query_as(
            "SELECT request_key,request_json,publication_json FROM history_checkpoint_publications
             WHERE request_key>? AND (json_extract(publication_json,'$.state.kind') IN ('capturing','prepared')
              OR json_extract(publication_json,'$.cleanup_pending')=1) ORDER BY request_key LIMIT 64")
            .bind(after).fetch_all(db).await?;
        rows.into_iter().map(|(key,request,value)| Ok((key,serde_json::from_str(&request)?,serde_json::from_str(&value)?))).collect()
    })).await
}
