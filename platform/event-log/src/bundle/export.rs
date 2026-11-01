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

use super::{
    BundleError, Inventory,
    closure::Closure,
    format::{Copy, Record, Valuation, Writer},
};
use crate::{EventLog, StoreError, sequence_number};
use futures_util::TryStreamExt;
use sqlx::{Connection, Row, SqliteConnection};
use tokio::io::AsyncWrite;

/// Inventory and checksum of a complete uncompressed transfer, not permission
/// to import or proof that its historical claims are valid.
#[derive(Debug)]
pub struct BundleSummary {
    pub inventory: Inventory,
    pub bytes: u64,
    pub digest: String,
}

impl EventLog {
    pub async fn export_bundle<W: AsyncWrite + Unpin + Send + 'static>(
        &self,
        root: &str,
        expected_subtree_digest: &str,
        output: W,
    ) -> Result<(W, BundleSummary), BundleError> {
        self.validate_root()?;
        crate::sessions::validate_id(root)?;
        let (root, expected) = (root.to_owned(), expected_subtree_digest.to_owned());
        self.connection
            .read(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin().await?;
                    let result = async {
                        let inventory = super::inventory(&mut tx, &root).await?;
                        inventory.verify_confirmation(&expected)?;
                        require_idle(&mut tx, &inventory).await?;
                        let through = sequence_number(
                            sqlx::query_scalar::<_, i64>(
                                "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                            )
                            .fetch_one(&mut *tx)
                            .await
                            .map_err(StoreError::from)?,
                        )?;
                        let closure = Closure::capture(&mut tx, &inventory, through).await?;
                        let mut writer = Writer::new(output).await?;
                        writer
                            .record(&Record::Header {
                                inventory: inventory.clone(),
                                source_high_water: through,
                            })
                            .await?;
                        catalog(&mut tx, &inventory, &mut writer).await?;
                        histories(&mut tx, &closure, &mut writer).await?;
                        events(&mut tx, &closure, &mut writer).await?;
                        super::blobs::export(&mut tx, &inventory, &closure, &mut writer).await?;
                        accounting(&mut tx, &closure, &mut writer).await?;
                        let (output, bytes, digest) = writer.finish().await?;
                        Ok((
                            output,
                            BundleSummary {
                                inventory,
                                bytes,
                                digest,
                            },
                        ))
                    }
                    .await;
                    tx.rollback().await?;
                    Ok(result)
                })
            })
            .await?
    }
}

async fn events<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    closure: &Closure,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    // Batch only identities; stream each joined body in the caller's snapshot.
    // The batch size bounds query parameters, never the accepted event size.
    let mut selected = closure.events.iter();
    loop {
        let batch: Vec<u64> = selected.by_ref().take(128).copied().collect();
        if batch.is_empty() {
            return Ok(());
        }
        let mut rows = sqlx::query(sqlx::AssertSqlSafe(format!(
            "SELECT e.sequence,e.event_header,{} FROM runtime_events e {}
             WHERE e.sequence IN(SELECT value FROM json_each(?)) ORDER BY e.sequence",
            crate::canonical::COLUMNS,
            crate::canonical::JOINS
        )))
        .bind(serde_json::to_string(&batch)?)
        .fetch(&mut *db);
        let mut count = 0;
        while let Some(row) = rows.try_next().await? {
            let json = crate::canonical::json(&row)?.into_owned();
            writer
                .record(&Record::Event {
                    sequence: sequence_number(row.try_get("sequence")?)?,
                    json,
                })
                .await?;
            count += 1;
        }
        if count != batch.len() {
            return Err(StoreError::InvalidTransition("missing bundle event".into()));
        }
    }
}

async fn require_idle(db: &mut SqliteConnection, inventory: &Inventory) -> Result<(), StoreError> {
    for session in &inventory.sessions {
        if crate::sessions::has_active_invocation(db, &session.id).await? {
            return Err(StoreError::SessionBusy);
        }
        let busy: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_processes WHERE session_id=?1 AND cleaned=0)",
        )
        .bind(&session.id)
        .fetch_one(&mut *db)
        .await?;
        if busy {
            return Err(StoreError::SessionBusy);
        }
    }
    Ok(())
}

async fn catalog<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    inventory: &Inventory,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    for session in &inventory.sessions {
        let (created, updated, archived, configuration, parent): (
            i64,
            i64,
            bool,
            String,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT created_at,updated_at,archived,configuration,
               COALESCE((SELECT authority_session_id FROM plugin_sessions WHERE session_id=live.id),
                 (SELECT parent_session_id FROM session_bundle_members WHERE session_id=live.id))
             FROM session_control live WHERE id=?",
        )
        .bind(&session.id)
        .fetch_one(&mut *db)
        .await?;
        writer
            .record(&Record::Session {
                id: session.id.clone(),
                parent: parent.filter(|id| inventory.sessions.iter().any(|s| s.id == *id)),
                created_at: sequence_number(created)?,
                updated_at: sequence_number(updated)?,
                archived,
                configuration: serde_json::from_str(&configuration)?,
            })
            .await?;
    }
    Ok(())
}

async fn histories<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    closure: &Closure,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    for session in &closure.copies {
        let (request, through, observed, lineage, state): (String,i64,i64,String,String) = sqlx::query_as(
            "SELECT request_json,through_sequence,observed_through,lineage_json,state FROM session_history_copies WHERE session_id=?"
        ).bind(session).fetch_one(&mut *db).await?;
        writer
            .record(&Record::Copy(Copy {
                request: serde_json::from_str(&request)?,
                through: sequence_number(through)?,
                observed_through: sequence_number(observed)?,
                lineage: serde_json::from_str(&lineage)?,
                state: state
                    .parse()
                    .map_err(|error: &str| StoreError::InvalidTransition(error.into()))?,
            }))
            .await?;
    }
    for ((session, sequence), archive_sequence) in &closure.members {
        writer
            .record(&Record::Member {
                session: session.clone(),
                sequence: *sequence,
                archive_sequence: *archive_sequence,
            })
            .await?;
    }
    for (session, sequence) in &closure.revisions {
        writer
            .record(&Record::RevisionSource {
                session: session.clone(),
                sequence: *sequence,
            })
            .await?;
    }
    Ok(())
}

async fn accounting<W: AsyncWrite + Unpin>(
    db: &mut SqliteConnection,
    closure: &Closure,
    writer: &mut Writer<W>,
) -> Result<(), StoreError> {
    for sequence in &closure.events {
        let row: Option<(String, String, Option<String>, Option<f64>)> = sqlx::query_as(
            "SELECT a.request_id,a.quote_json,v.usage_json,v.usd FROM event_log e
             JOIN model_accounting a ON a.request_id=e.event_id
             LEFT JOIN model_valuations v ON v.request_id=a.request_id WHERE e.sequence=?",
        )
        .bind(*sequence as i64)
        .fetch_optional(&mut *db)
        .await?;
        if let Some((event_id, quote, usage, usd)) = row {
            // A proof-only request need not include its later completion. Its
            // future usage is not evidence belonging to this transfer.
            let witness = super::accounting::witness(db, &event_id).await?;
            let usage = usage.filter(|_| witness.is_some_and(|n| closure.events.contains(&n)));
            writer
                .record(&Record::Accounting {
                    event_id,
                    quote: serde_json::from_str(&quote)?,
                    valuation: usage
                        .map(|usage| {
                            Ok::<_, serde_json::Error>(Valuation {
                                usage: serde_json::from_str(&usage)?,
                                usd,
                            })
                        })
                        .transpose()?,
                })
                .await?;
        }
    }
    Ok(())
}
