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
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};

fn binding(db: &Connection, request: &Request) -> Result<(), StoreError> {
    let scope: Option<String> = db
        .query_row(
            "SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?",
            rusqlite::params![&request.session_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(scope) = scope
        && serde_json::from_str::<Scope>(&scope)? != request.scope
    {
        return Err(invalid("history checkpoint binding differs"));
    }
    Ok(())
}

fn receipt(db: &Connection, request: &Request) -> Result<Option<Publication>, StoreError> {
    binding(db, request)?;
    let row: Option<(String, String)> = db.query_row("SELECT request_json,publication_json FROM history_checkpoint_publications WHERE request_key=?", rusqlite::params![request.key()?], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
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

fn head(db: &Connection, session: &str) -> Result<Option<Head>, StoreError> {
    let json: Option<String> = db
        .query_row(
            "SELECT head_json FROM history_checkpoint_heads WHERE session_id=?",
            rusqlite::params![session],
            |row| row.get(0),
        )
        .optional()?;
    json.map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
}

fn write(db: &Connection, request: &Request, value: &Publication) -> Result<(), StoreError> {
    let changed = db.execute(
        "UPDATE history_checkpoint_publications SET publication_json=? WHERE request_key=?",
        rusqlite::params![serde_json::to_string(value)?, request.key()?],
    )?;
    if changed != 1 {
        return Err(invalid("checkpoint request missing"));
    }
    Ok(())
}

pub(super) async fn read(
    log: &EventLog,
    request: Request,
) -> Result<Option<Publication>, StoreError> {
    log.connection.read(move |db| receipt(db, &request)).await
}

pub(super) async fn original(
    log: &EventLog,
    request: Request,
) -> Result<Option<PublicationRequest>, StoreError> {
    log.connection
        .read(move |db| {
            binding(db, &request)?;
            let original: Option<String> = db
                .query_row(
                    "SELECT request_json FROM history_checkpoint_publications WHERE request_key=?",
                    rusqlite::params![request.key()?],
                    |row| row.get(0),
                )
                .optional()?;
            original
                .map(|json| {
                    let original: Request = serde_json::from_str(&json)?;
                    if original.scope != request.scope
                        || original.session_id != request.session_id
                        || original.publication.fingerprint != request.publication.fingerprint
                        || original.publication.expected_revision
                            != request.publication.expected_revision
                        || original.publication.confirmed_subtree_digest
                            != request.publication.confirmed_subtree_digest
                        || original
                            .publication
                            .workspace
                            .as_ref()
                            .map(|v| v.consistency)
                            != request
                                .publication
                                .workspace
                                .as_ref()
                                .map(|v| v.consistency)
                    {
                        return Err(invalid("checkpoint operation inputs differ"));
                    }
                    Ok(original.publication)
                })
                .transpose()
        })
        .await
}

pub(super) async fn read_head(
    log: &EventLog,
    scope: Scope,
    session: String,
) -> Result<Option<Head>, StoreError> {
    log.connection
        .read(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
            let bound: Option<String> = tx
                .query_row(
                    "SELECT scope_json FROM history_checkpoint_bindings WHERE session_id=?",
                    rusqlite::params![&session],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(bound) = bound
                && serde_json::from_str::<Scope>(&bound)? != scope
            {
                return Err(invalid("history checkpoint binding differs"));
            }
            let value = head(&tx, &session)?;
            tx.rollback()?;
            Ok(value)
        })
        .await
}

/// The claim linearizes retries. Only the caller that inserted it may capture.
pub(super) async fn claim(
    log: &EventLog,
    request: Request,
) -> Result<(Publication, bool), StoreError> {
    log.connection.run(move |db| {
        let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
        if let Some(value) = receipt(&tx, &request)? {
            tx.rollback()?;
            return Ok((value, false));
        }
        let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_control WHERE id=?)", rusqlite::params![&request.session_id], |row| row.get(0))?;
        if !exists { return Err(StoreError::SessionNotFound); }
        tx.execute("INSERT INTO history_checkpoint_bindings VALUES(?,?) ON CONFLICT(session_id) DO NOTHING", rusqlite::params![&request.session_id, serde_json::to_string(&request.scope)?])?;
        let value = Publication { state: PublicationState::Capturing, cleanup_pending: true, cleanup_error: None };
        tx.execute("INSERT INTO history_checkpoint_publications VALUES(?,?,?,?)", rusqlite::params![request.key()?, &request.session_id, serde_json::to_string(&request)?, serde_json::to_string(&value)?])?;
        tx.commit().map_err(StoreError::CommitUnknown)?;
        Ok((value, true))
    }).await
}

pub(super) async fn prepare(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
) -> Result<(), StoreError> {
    log.connection
        .run(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let mut value =
                receipt(&tx, &request)?.ok_or_else(|| invalid("checkpoint claim missing"))?;
            if value.state != PublicationState::Capturing {
                return Err(invalid("checkpoint is not capturing"));
            }
            value.state = PublicationState::Prepared { manifest };
            write(&tx, &request, &value)?;
            tx.commit().map_err(StoreError::CommitUnknown)
        })
        .await
}

/// Head and domain receipt share this transaction. Host operation settlement is separate.
pub(super) async fn commit(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
) -> Result<Publication, StoreError> {
    let notice = log.commits.notice();
    log.connection.run(move |db| {
        let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
        let mut value = receipt(&tx, &request)?.ok_or_else(|| invalid("checkpoint claim missing"))?;
        match &value.state {
            PublicationState::Published { .. } | PublicationState::Conflict { .. } => {
                tx.rollback()?;
                return Ok(value);
            }
            PublicationState::Prepared { manifest: original } if original == &manifest => {}
            _ => return Err(invalid("checkpoint prepared material differs")),
        }
        let actual = head(&tx, &request.session_id)?.map(|head| head.revision);
        if actual != request.publication.expected_revision {
            value.state = PublicationState::Conflict { actual };
            crate::snapshots::release_unpublished(&tx,&request.key()?)?;
        } else {
            let head = Head { revision: Revision(uuid::Uuid::new_v4()), manifest };
            tx.execute("INSERT INTO history_checkpoint_heads VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET head_json=excluded.head_json", rusqlite::params![&request.session_id, serde_json::to_string(&head)?])?;
            value.state = PublicationState::Published { head };
            boundary("head_written");
        }
        if let PublicationState::Published { head } = &value.state {
            crate::snapshots::publish(&tx,&request.key()?,&head.manifest.digest)?;
        }
        write(&tx, &request, &value)?;
        tx.commit().map_err(StoreError::CommitUnknown)?;
                notice.material_released();
        Ok(value)
    }).await
}

pub(super) async fn interrupt(log: &EventLog, request: Request) -> Result<(), StoreError> {
    let notice = log.commits.notice();
    log.connection
        .run(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let mut value =
                receipt(&tx, &request)?.ok_or_else(|| invalid("checkpoint claim missing"))?;
            if value.state == PublicationState::Capturing {
                value.state = PublicationState::Interrupted;
                crate::snapshots::release_unpublished(&tx, &request.key()?)?;
                write(&tx, &request, &value)?;
            }
            tx.commit().map_err(StoreError::CommitUnknown)?;
            notice.material_released();
            Ok(())
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
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let mut value =
                receipt(&tx, &request)?.ok_or_else(|| invalid("checkpoint claim missing"))?;
            value.cleanup_pending = cause.is_some();
            value.cleanup_error = cause;
            write(&tx, &request, &value)?;
            tx.commit().map_err(StoreError::CommitUnknown)
        })
        .await
}

pub(super) async fn unavailable(
    log: &EventLog,
    request: Request,
    manifest: ObjectRef,
    cause: String,
) -> Result<Publication, StoreError> {
    let notice = log.commits.notice();
    log.connection
        .run(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
            let mut value =
                receipt(&tx, &request)?.ok_or_else(|| invalid("checkpoint claim missing"))?;
            if value.state
                == (PublicationState::Prepared {
                    manifest: manifest.clone(),
                })
            {
                value.state = PublicationState::Unavailable { manifest, cause };
                crate::snapshots::release_unpublished(&tx, &request.key()?)?;
                write(&tx, &request, &value)?;
            }
            tx.commit().map_err(StoreError::CommitUnknown)?;
            notice.material_released();
            Ok(value)
        })
        .await
}

/// Startup-only bounded pages, before service admission. No caller can add requests.
pub(super) async fn pending(
    log: &EventLog,
    after: String,
) -> Result<Vec<(String, Request, Publication)>, StoreError> {
    log.connection.read(move |db| {
        let rows: Vec<(String,String,String)> = db.prepare_cached("SELECT request_key,request_json,publication_json FROM history_checkpoint_publications
             WHERE request_key>? AND (json_extract(publication_json,'$.state.kind') IN ('capturing','prepared')
              OR json_extract(publication_json,'$.cleanup_pending')=1) ORDER BY request_key LIMIT 64")?.query_map(rusqlite::params![after], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(key,request,value)| Ok((key,serde_json::from_str(&request)?,serde_json::from_str(&value)?))).collect()
    }).await
}
