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
    BundleError, BundleSummary,
    format::{Blob, Record},
    reader::Reader,
};
use crate::{
    StoreError,
    connection::{ConnectionAuthority, OpenOptions, OwnedConnection},
};
use maka_agent_facts::artifact::content_digest;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use tokio::io::AsyncRead;

fn initialize(database: &mut Connection) -> Result<(), StoreError> {
    database.execute_batch(include_str!("migrations/0001_staging.sql"))?;
    Ok(())
}

fn initialize_temporary(database: &mut Connection) -> Result<(), StoreError> {
    database.execute_batch(
        "PRAGMA temp_store=FILE; PRAGMA page_size=4096; PRAGMA cache_size=-4096;
         PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;",
    )?;
    initialize(database)
}

pub(super) fn payload(
    staged: &Connection,
    number: i64,
    descriptor: &Blob,
) -> Result<Vec<u8>, StoreError> {
    let length = usize::try_from(descriptor.bytes()).map_err(|_| StoreError::PrefixTooLarge)?;
    let mut payload = Vec::new();
    let mut statement =
        staged.prepare_cached("SELECT payload FROM chunks WHERE frame=? AND offset=?")?;
    while payload.len() < length {
        let chunk: Vec<u8> =
            statement.query_row(params![number, payload.len() as i64], |row| row.get(0))?;
        if chunk.is_empty() || chunk.len() > length - payload.len() {
            return Err(StoreError::InvalidTransition(
                "staged blob length differs".into(),
            ));
        }
        payload
            .try_reserve(chunk.len())
            .map_err(std::io::Error::other)?;
        payload.extend_from_slice(&chunk);
    }
    if content_digest(&payload) != descriptor.digest() {
        return Err(StoreError::InvalidTransition(
            "staged blob digest differs".into(),
        ));
    }
    Ok(payload)
}

/// Private decoded transfer, not yet accepted history. Only Host-authored SQL
/// opens this staging database; input never supplies a SQLite file or schema.
/// Its actor owns SQLite's automatically deleted temporary database.
pub struct StagedBundle {
    pub(super) database: OwnedConnection,
    pub(super) summary: BundleSummary,
    history_validated: bool,
}

impl StagedBundle {
    pub async fn read<R: AsyncRead + Unpin>(input: R) -> Result<Self, BundleError> {
        let database = OwnedConnection::open(
            OpenOptions::temporary(),
            ConnectionAuthority::Temporary,
            initialize_temporary,
        )
        .await?;
        let result = async {
            let mut reader = Reader::new(input).await?;
            let mut number = 0i64;
            loop {
                let record = reader.next().await?;
                if matches!(record, Record::End { .. }) {
                    break;
                }
                number += 1;
                let json = serde_json::to_string(&record)?;
                database
                    .run(move |db| {
                        db.execute(
                            "INSERT INTO frames(number,record_json) VALUES(?,?)",
                            params![number, json],
                        )?;
                        Ok(())
                    })
                    .await?;
                if matches!(record, Record::Blob(_)) {
                    let mut offset = 0i64;
                    while let Some(bytes) = reader.blob_chunk().await? {
                        let size = bytes.len() as i64;
                        database
                            .run(move |db| {
                                db.execute(
                                    "INSERT INTO chunks(frame,offset,payload) VALUES(?,?,?)",
                                    params![number, offset, bytes],
                                )?;
                                Ok(())
                            })
                            .await?;
                        offset += size;
                    }
                }
            }
            reader.summary()
        }
        .await;
        match result {
            Ok(summary) => Ok(Self {
                database,
                summary,
                history_validated: false,
            }),
            Err(error) => {
                database.shutdown().await?;
                Err(error.into())
            }
        }
    }

    pub(crate) async fn history_cut(&mut self, session: &str) -> Result<String, StoreError> {
        let session = session.to_owned();
        self.database.run(move |db| {
            use sha2::{Digest, Sha256};
            let mut hash = Sha256::new();
            let mut statement = db.prepare_cached(
                "SELECT sequence FROM (
                    SELECT CAST(json_extract(record_json,'$.sequence') AS INTEGER) AS sequence
                    FROM frames
                    WHERE kind='member' AND json_extract(record_json,'$.session')=?1
                    UNION
                    SELECT source_sequence AS sequence
                    FROM frames
                    WHERE kind='event'
                      AND json_extract(json_extract(record_json,'$.json'),'$.invocation.session_id')=?1
                ) ORDER BY sequence",
            )?;
            let mut rows = statement.query([session])?;
            while let Some(row) = rows.next()? {
                hash.update(crate::sequence_number(row.get(0)?)?.to_le_bytes());
            }
            Ok(hex::encode(hash.finalize()))
        }).await
    }

    pub fn summary(&self) -> &BundleSummary {
        &self.summary
    }

    /// Source metadata is untrusted historical data, not destination authority.
    pub async fn configuration<T: serde::de::DeserializeOwned>(
        &mut self,
        session: &str,
    ) -> Result<T, BundleError> {
        let session = session.to_owned();
        let json: String = self.database.run(move |db| {
            Ok(db.prepare_cached(
                "SELECT record_json FROM frames WHERE kind='session' AND json_extract(record_json,'$.id')=?",
            )?.query_row([session], |row| row.get(0))?)
        }).await?;
        let Record::Session { configuration, .. } =
            serde_json::from_str(&json).map_err(StoreError::from)?
        else {
            unreachable!()
        };
        serde_json::from_value(configuration)
            .map_err(StoreError::from)
            .map_err(Into::into)
    }

    pub async fn artifact_count(&mut self) -> Result<u64, BundleError> {
        let count: i64 = self.database.run(|db| {
            Ok(db.query_row(
                "SELECT COUNT(*) FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource')='artifact'",
                [], |row| row.get(0),
            )?)
        }).await?;
        crate::sequence_number(count).map_err(Into::into)
    }

    /// Validate original history before any position or proof relocation.
    pub async fn validate_history(&mut self) -> Result<(), BundleError> {
        if !self.history_validated {
            self.database
                .run(|db| super::validation::validate(db))
                .await?;
            self.history_validated = true;
        }
        Ok(())
    }

    /// Await physical cleanup when the caller needs a completed teardown.
    pub async fn close(self) -> Result<(), BundleError> {
        self.database.shutdown().await?;
        Ok(())
    }

    /// Reserve historical dependencies even outside the published catalog.
    pub(crate) async fn family_members(&mut self) -> Result<Vec<String>, StoreError> {
        self.database.run(|db| {
        use maka_agent_facts::session::Lineage;
        use std::collections::BTreeSet;
        let mut members = BTreeSet::new();
        let mut after = 0i64;
        loop {
            let row: Option<(i64, String)> = db.prepare_cached("SELECT number,record_json FROM frames WHERE number>? ORDER BY number LIMIT 1")?
                .query_row([after], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let Some((number, json)) = row else { break };
            match serde_json::from_str(&json)? {
                Record::Session { id, parent, .. } => {
                    members.insert(id);
                    members.extend(parent);
                }
                Record::Copy(copy) => {
                    members.insert(copy.request.source_session_id);
                    members.insert(copy.request.target_session_id);
                    match copy.lineage {
                        Lineage::Branch { origin } => {
                            members.insert(origin.parent_session_id);
                        }
                        Lineage::Revision {
                            root_session_id,
                            parent_session_id,
                            branch,
                            ..
                        } => {
                            members.insert(root_session_id);
                            members.insert(parent_session_id);
                            if let Some(branch) = branch {
                                members.insert(branch.parent_session_id);
                            }
                        }
                    }
                }
                Record::Event { json, .. } => {
                    let event: maka_agent_facts::event::RuntimeEvent = serde_json::from_str(&json)?;
                    members.insert(event.invocation.session_id);
                }
                Record::HistoryArtifact {
                    session,
                    source_session,
                    ..
                } => {
                    members.insert(session);
                    members.insert(source_session);
                }
                Record::Member { session, .. } | Record::RevisionSource { session, .. } => {
                    members.insert(session);
                }
                Record::Blob(Blob::Artifact { metadata, .. }) => {
                    members.insert(metadata.session_id);
                }
                _ => {}
            }
            after = number;
        }
        Ok(members.into_iter().collect())

        }).await
    }

    pub(crate) async fn persist(
        self,
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
    ) -> Result<(), StoreError> {
        self.persist_owned(path, root, |_| Ok(())).await
    }

    async fn persist_owned(
        self,
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
        before_copy: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
    ) -> Result<(), StoreError> {
        if !self.history_validated {
            return Err(StoreError::InvalidTransition(
                "unvalidated bundle stage".into(),
            ));
        }
        root.validate_current()?;
        let source = self.database.into_temporary_connection().await?;
        let summary = serde_json::to_string(&(
            self.summary.inventory,
            self.summary.bytes,
            self.summary.digest,
        ))?;
        let path = path.to_owned();
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await?;
        let owner = root
            .open(OpenOptions::file(&path), move |destination| {
                destination
                    .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;")?;
                initialize(destination)?;
                before_copy(destination)?;
                let tx = Transaction::new_unchecked(destination, TransactionBehavior::Immediate)?;
                copy_contents(&source, &tx)?;
                tx.execute_batch("CREATE TABLE root_stage_summary(json TEXT NOT NULL)")?;
                tx.execute("INSERT INTO root_stage_summary VALUES(?)", [summary])?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                source
                    .close()
                    .map_err(|(_, error)| StoreError::from(error))?;
                Ok(())
            })
            .await?;
        let sync_root = root.clone();
        owner
            .run(move |_| {
                sync_root.validate_current()?;
                std::fs::File::open(&path)?.sync_all()?;
                std::fs::File::open(path.parent().ok_or_else(|| {
                    StoreError::InvalidTransition("stage has no directory".into())
                })?)?
                .sync_all()?;
                Ok(())
            })
            .await?;
        owner.shutdown().await?;
        root.validate_current()?;
        Ok(())
    }

    pub(crate) async fn reopen(
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
    ) -> Result<Self, StoreError> {
        Self::reopen_owned(path, root, |_| Ok(())).await
    }

    async fn reopen_owned(
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
        before_copy: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
    ) -> Result<Self, StoreError> {
        let owner = root
            .open(OpenOptions::file(path).read_only(true), |_| Ok(()))
            .await?;
        let copied = owner
            .run(move |source| {
                before_copy(source)?;
                let mut database = Connection::open("")?;
                initialize_temporary(&mut database)?;
                let json: String =
                    source
                        .query_row("SELECT json FROM root_stage_summary", [], |row| row.get(0))?;
                let (inventory, bytes, digest) = serde_json::from_str(&json)?;
                let tx = Transaction::new_unchecked(&database, TransactionBehavior::Deferred)?;
                copy_contents(source, &tx)?;
                tx.commit()?;
                Ok((
                    database,
                    BundleSummary {
                        inventory,
                        bytes,
                        digest,
                    },
                ))
            })
            .await;
        let closed = owner.shutdown().await;
        let (database, summary) = match (copied, closed) {
            (Ok(value), Ok(())) => value,
            (_, Err(error)) | (Err(error), _) => return Err(error),
        };
        let database = OwnedConnection::from_temporary_connection(database).await?;
        Ok(Self {
            database,
            summary,
            history_validated: false,
        })
    }
}

fn copy_contents(source: &Connection, destination: &Connection) -> Result<(), StoreError> {
    let mut frames =
        source.prepare_cached("SELECT number,record_json FROM frames ORDER BY number")?;
    let mut chunks =
        source.prepare_cached("SELECT offset,payload FROM chunks WHERE frame=? ORDER BY offset")?;
    let mut insert_frame =
        destination.prepare_cached("INSERT INTO frames(number,record_json) VALUES(?,?)")?;
    let mut insert_chunk =
        destination.prepare_cached("INSERT INTO chunks(frame,offset,payload) VALUES(?,?,?)")?;
    let mut rows = frames.query([])?;
    while let Some(row) = rows.next()? {
        let number: i64 = row.get(0)?;
        let json: String = row.get(1)?;
        insert_frame.execute(params![number, json])?;
        let mut rows = chunks.query([number])?;
        while let Some(row) = rows.next()? {
            let position: i64 = row.get(0)?;
            let payload: Vec<u8> = row.get(1)?;
            insert_chunk.execute(params![number, position, payload])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod custody_tests;
