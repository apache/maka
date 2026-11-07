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
    format::{Copy, FrameSender, Record, Valuation},
};
use crate::{EventLog, StoreError, sequence_number};
use rusqlite::{Connection, OptionalExtension};
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
        crate::sessions::validate_id(root)?;
        let (root, expected) = (root.to_owned(), expected_subtree_digest.to_owned());
        let (mut writer, frames) = super::format::FrameSender::channel();
        let producer = self.connection.read(move |db| {
            Ok((|| -> Result<Inventory, BundleError> {
                let tx = rusqlite::Transaction::new_unchecked(
                    db,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let inventory = super::inventory(&tx, &root)?;
                inventory.verify_confirmation(&expected)?;
                require_idle(&tx, &inventory)?;
                let through = sequence_number(tx.query_row(
                    "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                    [],
                    |row| row.get(0),
                )?)?;
                let closure = Closure::capture(&tx, &inventory, through)?;
                writer.record(&Record::Header {
                    inventory: inventory.clone(),
                    source_high_water: through,
                })?;
                for record in catalog(&tx, &inventory)? {
                    writer.record(&record)?;
                }
                for record in histories(&tx, &closure)? {
                    writer.record(&record)?;
                }
                events(&tx, &closure.events, &mut writer)?;
                super::blobs::export(&tx, &inventory, &closure, &mut writer)?;
                for record in accounting(&tx, &closure)? {
                    writer.record(&record)?;
                }
                tx.rollback()?;
                writer.complete()?;
                Ok(inventory)
            })())
        });
        let consumer = super::format::write_frames(output, frames);
        let (inventory, written) = tokio::join!(producer, consumer);
        let (output, bytes, digest) = match written {
            Ok(written) => written,
            Err(error) => {
                if matches!(&error, StoreError::Io(cause) if cause.kind() == std::io::ErrorKind::UnexpectedEof)
                {
                    inventory??;
                }
                return Err(error.into());
            }
        };
        let inventory = inventory??;
        Ok((
            output,
            BundleSummary {
                inventory,
                bytes,
                digest,
            },
        ))
    }
}

pub(crate) fn events(
    db: &Connection,
    events: &std::collections::BTreeSet<u64>,
    writer: &mut FrameSender,
) -> Result<(), StoreError> {
    // Batch only identities; stream each joined body in the caller's snapshot.
    // The batch size bounds query parameters, never the accepted event size.
    let mut selected = events.iter();
    loop {
        let batch: Vec<u64> = selected.by_ref().take(128).copied().collect();
        if batch.is_empty() {
            return Ok(());
        }
        let mut statement = db.prepare_cached(&format!(
            "SELECT e.sequence,e.event_header,{} FROM runtime_events e {}
             WHERE e.sequence IN(SELECT value FROM json_each(?)) ORDER BY e.sequence",
            crate::canonical::COLUMNS,
            crate::canonical::JOINS,
        ))?;
        let mut rows = statement.query([serde_json::to_string(&batch)?])?;
        let mut count = 0;
        while let Some(row) = rows.next()? {
            let json = crate::canonical::json(row)?.into_owned();
            writer.record(&Record::Event {
                sequence: sequence_number(row.get("sequence")?)?,
                json,
            })?;
            count += 1;
        }
        if count != batch.len() {
            return Err(StoreError::InvalidTransition("missing bundle event".into()));
        }
    }
}

pub(crate) fn require_idle(db: &Connection, inventory: &Inventory) -> Result<(), StoreError> {
    for session in &inventory.sessions {
        if crate::sessions::has_active_invocation(db, &session.id)? {
            return Err(StoreError::SessionBusy);
        }
        let busy: bool = db
            .prepare_cached(
                "SELECT EXISTS(SELECT 1 FROM message_admissions WHERE session_id=?1)
             OR EXISTS(SELECT 1 FROM session_processes WHERE session_id=?1 AND cleaned=0)",
            )?
            .query_row(rusqlite::params![&session.id], |row| row.get(0))?;
        if busy {
            return Err(StoreError::SessionBusy);
        }
    }
    Ok(())
}

pub(crate) fn history_cut(db: &Connection, session: &str) -> Result<String, StoreError> {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut statement = db.prepare_cached(
        "SELECT sequence FROM runtime_events WHERE event_session=?1
         UNION SELECT sequence FROM session_history_members WHERE session_id=?1 ORDER BY sequence",
    )?;
    let mut rows = statement.query([session])?;
    while let Some(row) = rows.next()? {
        hash.update(sequence_number(row.get(0)?)?.to_le_bytes());
    }
    Ok(hex::encode(hash.finalize()))
}

pub(crate) fn catalog(db: &Connection, inventory: &Inventory) -> Result<Vec<Record>, StoreError> {
    let mut records = Vec::new();
    for session in &inventory.sessions {
        let (created, updated, archived, configuration, parent): (
            i64,
            i64,
            bool,
            String,
            Option<String>,
        ) = db
            .prepare_cached(
                "SELECT created_at,updated_at,archived,configuration,
               COALESCE((SELECT authority_session_id FROM plugin_sessions WHERE session_id=live.id),
                 (SELECT parent_session_id FROM session_bundle_members WHERE session_id=live.id))
             FROM session_control live WHERE id=?",
            )?
            .query_row(rusqlite::params![&session.id], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?;
        records.push(Record::Session {
            id: session.id.clone(),
            parent: parent.filter(|id| inventory.sessions.iter().any(|s| s.id == *id)),
            created_at: sequence_number(created)?,
            updated_at: sequence_number(updated)?,
            archived,
            configuration: serde_json::from_str(&configuration)?,
        });
    }
    Ok(records)
}

pub(crate) fn histories(db: &Connection, closure: &Closure) -> Result<Vec<Record>, StoreError> {
    let mut records = Vec::new();
    for session in &closure.copies {
        let (request, through, observed, lineage, state): (String,i64,i64,String,String) = db.prepare_cached(
            "SELECT request_json,through_sequence,observed_through,lineage_json,state FROM session_history_copies WHERE session_id=?"
        )?.query_row(rusqlite::params![session], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,)))?;
        records.push(Record::Copy(Copy {
            request: serde_json::from_str(&request)?,
            through: sequence_number(through)?,
            observed_through: sequence_number(observed)?,
            lineage: serde_json::from_str(&lineage)?,
            state: state
                .parse()
                .map_err(|error: &str| StoreError::InvalidTransition(error.into()))?,
        }));
    }
    for ((session, sequence), archive_sequence) in &closure.members {
        records.push(Record::Member {
            session: session.clone(),
            sequence: *sequence,
            archive_sequence: *archive_sequence,
        });
    }
    for (session, sequence) in &closure.revisions {
        records.push(Record::RevisionSource {
            session: session.clone(),
            sequence: *sequence,
        });
    }
    Ok(records)
}

pub(crate) fn accounting(db: &Connection, closure: &Closure) -> Result<Vec<Record>, StoreError> {
    let mut records = Vec::new();
    for sequence in &closure.events {
        let row: Option<(String, String, Option<String>, Option<f64>)> = db
            .prepare_cached(
                "SELECT a.request_id,a.quote_json,v.usage_json,v.usd FROM event_log e
             JOIN model_accounting a ON a.request_id=e.event_id
             LEFT JOIN model_valuations v ON v.request_id=a.request_id WHERE e.sequence=?",
            )?
            .query_row(rusqlite::params![*sequence as i64], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .optional()?;
        if let Some((event_id, quote, usage, usd)) = row {
            // A proof-only request need not include its later completion. Its
            // future usage is not evidence belonging to this transfer.
            let witness = super::accounting::witness(db, &event_id)?;
            let usage = usage.filter(|_| witness.is_some_and(|n| closure.events.contains(&n)));
            records.push(Record::Accounting {
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
            });
        }
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        pin::Pin,
        task::{Context, Poll},
        time::Duration,
    };

    struct FailingOutput;

    impl AsyncWrite for FailingOutput {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "output rejected",
            )))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    async fn fixture() -> (tempfile::TempDir, EventLog, Inventory) {
        let directory = tempfile::tempdir().unwrap();
        let log = EventLog::open(&directory.path().join("source.sqlite"))
            .await
            .unwrap();
        log.create_session("source", "source", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let inventory = log.preview_bundle("source").await.unwrap();
        (directory, log, inventory)
    }

    #[tokio::test]
    async fn output_failure_releases_snapshot_and_preserves_its_cause() {
        let (_directory, log, inventory) = fixture().await;
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            log.export_bundle("source", &inventory.subtree_digest, FailingOutput),
        )
        .await
        .expect("failed output must release the snapshot producer");
        assert!(
            matches!(result, Err(BundleError::Store(StoreError::Io(error))) if error.kind() == io::ErrorKind::PermissionDenied)
        );
        tokio::time::timeout(Duration::from_secs(5), log.close())
            .await
            .expect("failed export must release its reader")
            .unwrap();
    }

    #[tokio::test]
    async fn failed_producer_does_not_complete_a_partial_bundle() {
        let (_directory, log, inventory) = fixture().await;
        let (normal, summary) = log
            .export_bundle("source", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        let inspected = crate::bundle::inspect(normal.as_slice()).await.unwrap();
        assert_eq!(inspected.digest, summary.digest);

        let (mut writer, frames) = FrameSender::channel();
        let producer = log.connection.read(move |db| {
            let tx =
                rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Deferred)?;
            writer.record(&Record::Header {
                inventory: inventory.clone(),
                source_high_water: 0,
            })?;
            for record in catalog(&tx, &inventory)? {
                writer.record(&record)?;
            }
            tx.rollback()?;
            Err::<(), _>(StoreError::SessionBusy)
        });
        let mut partial = Vec::new();
        let consumer = crate::bundle::format::write_frames(&mut partial, frames);
        let (produced, written) = tokio::join!(producer, consumer);
        assert!(matches!(produced, Err(StoreError::SessionBusy)));
        assert!(
            matches!(written, Err(StoreError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof)
        );
        assert!(crate::bundle::inspect(partial.as_slice()).await.is_err());
        log.close().await.unwrap();
    }
}
