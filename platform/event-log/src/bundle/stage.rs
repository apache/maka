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
use crate::StoreError;
use maka_agent_facts::artifact::content_digest;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tokio::io::AsyncRead;

static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./src/bundle/migrations");

pub(super) async fn payload(
    staged: &mut SqliteConnection,
    number: i64,
    descriptor: &Blob,
) -> Result<Vec<u8>, StoreError> {
    let length = usize::try_from(descriptor.bytes()).map_err(|_| StoreError::PrefixTooLarge)?;
    let mut payload = Vec::new();
    while payload.len() < length {
        let chunk: Vec<u8> =
            sqlx::query_scalar("SELECT payload FROM chunks WHERE frame=? AND offset=?")
                .bind(number)
                .bind(payload.len() as i64)
                .fetch_one(&mut *staged)
                .await?;
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
/// Dropping it also closes SQLite's automatically deleted temporary database.
pub struct StagedBundle {
    pub(super) database: SqliteConnection,
    pub(super) summary: BundleSummary,
    history_validated: bool,
}

impl StagedBundle {
    pub async fn read<R: AsyncRead + Unpin>(input: R) -> Result<Self, BundleError> {
        // An empty SQLite filename creates a private, disk-backed temporary
        // database whose lifetime belongs to the connection, including Drop.
        let mut database = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename("")
                .create_if_missing(true)
                .pragma("temp_store", "FILE")
                .pragma("page_size", "4096")
                .pragma("cache_size", "-4096")
                .pragma("max_page_count", "393216"),
        )
        .await
        .map_err(StoreError::from)?;
        let result = async {
            MIGRATIONS.run_direct(None, &mut database, false).await?;
            let mut reader = Reader::new(input).await?;
            let mut tx = database.begin().await?;
            let mut number = 0i64;
            loop {
                let record = reader.next().await?;
                if matches!(record, Record::End { .. }) {
                    break;
                }
                number += 1;
                sqlx::query("INSERT INTO frames(number,record_json) VALUES(?,?)")
                    .bind(number)
                    .bind(serde_json::to_string(&record)?)
                    .execute(&mut *tx)
                    .await?;
                if matches!(record, Record::Blob(_)) {
                    let mut offset = 0i64;
                    while let Some(bytes) = reader.blob_chunk().await? {
                        let size = bytes.len() as i64;
                        sqlx::query("INSERT INTO chunks(frame,offset,payload) VALUES(?,?,?)")
                            .bind(number)
                            .bind(offset)
                            .bind(bytes)
                            .execute(&mut *tx)
                            .await?;
                        offset += size;
                    }
                }
            }
            let summary = reader.summary()?;
            tx.commit().await?;
            Ok::<_, StoreError>(summary)
        }
        .await;
        match result {
            Ok(summary) => Ok(Self {
                database,
                summary,
                history_validated: false,
            }),
            Err(error) => {
                database.close().await.map_err(StoreError::from)?;
                Err(error.into())
            }
        }
    }

    pub fn summary(&self) -> &BundleSummary {
        &self.summary
    }

    /// Source metadata is untrusted historical data, not destination authority.
    /// Read one configuration at a time rather than materializing the catalog.
    pub async fn configuration<T: serde::de::DeserializeOwned>(
        &mut self,
        session: &str,
    ) -> Result<T, BundleError> {
        let json: String = sqlx::query_scalar(
            "SELECT record_json FROM frames WHERE kind='session' AND json_extract(record_json,'$.id')=?",
        )
        .bind(session)
        .fetch_one(&mut self.database)
        .await
        .map_err(StoreError::from)?;
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
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM frames WHERE kind='blob' AND json_extract(record_json,'$.resource')='artifact'",
        )
        .fetch_one(&mut self.database)
        .await
        .map_err(StoreError::from)?;
        crate::sequence_number(count).map_err(Into::into)
    }

    /// Validate original history before any position or proof relocation. This
    /// does not bind destination workspaces, grant execution or publish Sessions.
    pub async fn validate_history(&mut self) -> Result<(), BundleError> {
        // Staged source bytes are private and immutable after read. Callers may
        // validate before acquiring destination admission without repeating it.
        if !self.history_validated {
            super::validation::validate(&mut self.database).await?;
            self.history_validated = true;
        }
        Ok(())
    }

    /// Await physical cleanup when the caller needs a completed teardown.
    pub async fn close(self) -> Result<(), BundleError> {
        self.database.close().await.map_err(StoreError::from)?;
        Ok(())
    }
}

impl StagedBundle {
    /// Every Session identity carried by historical dependencies is reserved too,
    /// even when it is not a published member of the imported catalog.
    pub(crate) async fn family_members(&mut self) -> Result<Vec<String>, StoreError> {
        use maka_agent_facts::session::Lineage;
        use std::collections::BTreeSet;
        let mut members = BTreeSet::new();
        let mut after = 0i64;
        loop {
            let row: Option<(i64, String)> = sqlx::query_as(
                "SELECT number,record_json FROM frames WHERE number>? ORDER BY number LIMIT 1",
            )
            .bind(after)
            .fetch_optional(&mut self.database)
            .await?;
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
    }

    /// Root files are opened only by an independent OwnedConnection actor. The
    /// observer may disappear at any await without releasing physical custody.
    pub(crate) async fn persist(
        self,
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
    ) -> Result<(), StoreError> {
        self.persist_owned(path, root, |_| Box::pin(async { Ok(()) }))
            .await
    }

    async fn persist_owned(
        mut self,
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
        before_copy: impl for<'a> FnOnce(
            &'a mut SqliteConnection,
        )
            -> crate::connection::BoxFuture<'a, Result<(), StoreError>>
        + Send
        + 'static,
    ) -> Result<(), StoreError> {
        if !self.history_validated {
            return Err(StoreError::InvalidTransition(
                "unvalidated bundle stage".into(),
            ));
        }
        root.validate_current()?;
        // A UUID stage never overwrites another durable command's input.
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        let path = path.to_owned();
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Full);
        let owner = root
            .open(options, move |destination| {
                Box::pin(async move {
                    let copied = async {
                        MIGRATIONS.run_direct(None, destination, false).await?;
                        before_copy(destination).await?;
                        let mut tx = destination.begin_with("BEGIN IMMEDIATE").await?;
                        copy_contents(&mut self.database, &mut tx).await?;
                        sqlx::query("CREATE TABLE root_stage_summary(json TEXT NOT NULL)")
                            .execute(&mut *tx)
                            .await?;
                        let summary = serde_json::to_string(&(
                            &self.summary.inventory,
                            self.summary.bytes,
                            &self.summary.digest,
                        ))?;
                        sqlx::query("INSERT INTO root_stage_summary VALUES(?)")
                            .bind(summary)
                            .execute(&mut *tx)
                            .await?;
                        tx.commit().await.map_err(StoreError::CommitUnknown)
                    }
                    .await;
                    let closed = self.database.close().await.map_err(StoreError::from);
                    copied.and(closed)
                })
            })
            .await?;
        // Cancellation here drops only ingress. The original actor retains Root
        // through actual sqlite3_close, including a blocked worker or close failure.
        owner.shutdown().await?;
        root.validate_current()?;
        std::fs::File::open(&path)?.sync_all()?;
        std::fs::File::open(
            path.parent()
                .ok_or_else(|| StoreError::InvalidTransition("stage has no directory".into()))?,
        )?
        .sync_all()?;
        Ok(())
    }

    pub(crate) async fn reopen(
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
    ) -> Result<Self, StoreError> {
        Self::reopen_owned(path, root, |_| Box::pin(async { Ok(()) })).await
    }

    async fn reopen_owned(
        path: &std::path::Path,
        root: crate::root_store::StageOwner,
        before_copy: impl for<'a> FnOnce(
            &'a mut SqliteConnection,
        )
            -> crate::connection::BoxFuture<'a, Result<(), StoreError>>
        + Send
        + 'static,
    ) -> Result<Self, StoreError> {
        let owner = root
            .open(
                SqliteConnectOptions::new().filename(path).read_only(true),
                |_| Box::pin(async { Ok(()) }),
            )
            .await?;
        let copied = owner
            .run(move |source| {
                Box::pin(async move {
                    before_copy(source).await?;
                    let mut database = SqliteConnection::connect_with(
                        &SqliteConnectOptions::new()
                            .filename("")
                            .create_if_missing(true)
                            .pragma("temp_store", "FILE")
                            .pragma("cache_size", "-4096"),
                    )
                    .await?;
                    let copied = async {
                        MIGRATIONS.run_direct(None, &mut database, false).await?;
                        let json: String =
                            sqlx::query_scalar("SELECT json FROM root_stage_summary")
                                .fetch_one(&mut *source)
                                .await?;
                        let (inventory, bytes, digest) = serde_json::from_str(&json)?;
                        let mut tx = database.begin().await?;
                        copy_contents(source, &mut tx).await?;
                        tx.commit().await?;
                        Ok::<_, StoreError>(BundleSummary {
                            inventory,
                            bytes,
                            digest,
                        })
                    }
                    .await;
                    match copied {
                        Ok(summary) => Ok(Self {
                            database,
                            summary,
                            history_validated: false,
                        }),
                        Err(error) => {
                            database.close().await?;
                            Err(error)
                        }
                    }
                })
            })
            .await;
        let closed = owner.shutdown().await;
        match (copied, closed) {
            (Ok(staged), Ok(())) => Ok(staged),
            (_, Err(error)) | (Err(error), _) => Err(error),
        }
    }
}

/// Bounded transfer: durable Root SQL stays on its original owned actor; only
/// anonymous staging databases cross actor boundaries. Derived scratch is rebuilt.
async fn copy_contents(
    source: &mut SqliteConnection,
    destination: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let mut after = 0i64;
    loop {
        let row: Option<(i64, String)> = sqlx::query_as(
            "SELECT number,record_json FROM frames WHERE number>? ORDER BY number LIMIT 1",
        )
        .bind(after)
        .fetch_optional(&mut *source)
        .await?;
        let Some((number, json)) = row else { break };
        sqlx::query("INSERT INTO frames(number,record_json) VALUES(?,?)")
            .bind(number)
            .bind(json)
            .execute(&mut *destination)
            .await?;
        let mut offset = -1i64;
        loop {
            let chunk: Option<(i64, Vec<u8>)> = sqlx::query_as("SELECT offset,payload FROM chunks WHERE frame=? AND offset>? ORDER BY offset LIMIT 1")
                .bind(number).bind(offset).fetch_optional(&mut *source).await?;
            let Some((position, payload)) = chunk else {
                break;
            };
            sqlx::query("INSERT INTO chunks(frame,offset,payload) VALUES(?,?,?)")
                .bind(number)
                .bind(position)
                .bind(payload)
                .execute(&mut *destination)
                .await?;
            offset = position;
        }
        after = number;
    }
    Ok(())
}

#[cfg(test)]
#[path = "stage_custody_tests.rs"]
mod custody_tests;
