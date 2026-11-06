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

//! Checkpoint membership retains canonical facts independently of live Sessions.
use crate::bundle::format::{Blob, Record, Writer};
use crate::{StoreError, bundle::Inventory};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqliteConnection};
use std::collections::BTreeSet;

struct Capture {
    pub inventory: Inventory,
    pub through: u64,
    events: Vec<u64>,
    sessions: Vec<Member>,
    artifacts: Vec<Artifact>,
    aliases: Vec<Alias>,
    metadata: Metadata,
}
#[derive(Clone, Serialize, Deserialize)]
struct Metadata {
    catalog: Vec<Record>,
    histories: Vec<Record>,
    accounting: Vec<Record>,
}
struct Member {
    session: String,
    copy_identity: String,
    events: Vec<(i64, bool, Option<i64>)>,
}
struct Artifact {
    session: String,
    id: String,
    record: String,
    digest: String,
    canonical_at: Option<i64>,
}
struct Alias {
    session: String,
    source_session: String,
    source_artifact: String,
    artifact: String,
}

pub(crate) fn owner_key(capture: &str, session: &str) -> String {
    format!("\0checkpoint\0{capture}\0{session}")
}

impl Capture {
    async fn read(
        db: &mut SqliteConnection,
        inventory: &Inventory,
        through: u64,
        closure: &crate::bundle::closure::Closure,
    ) -> Result<Self, StoreError> {
        let mut sessions = Vec::with_capacity(inventory.sessions.len());
        let mut artifacts = Vec::new();
        let mut aliases = Vec::new();
        for session in &inventory.sessions {
            let identity:Option<String>=sqlx::query_scalar("SELECT json_array(source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,bundle_digest,state) FROM session_history_copies WHERE session_id=?")
                .bind(&session.id).fetch_optional(&mut *db).await?;
            let events=sqlx::query_as("SELECT sequence,inherited,archive_sequence FROM session_history_events WHERE owner_session_id=? AND sequence<=? ORDER BY sequence")
                .bind(&session.id).bind(through as i64).fetch_all(&mut *db).await?;
            sessions.push(Member {
                session: session.id.clone(),
                copy_identity: identity.unwrap_or_default(),
                events,
            });
            let rows:Vec<(String,String,String,Option<i64>)>=sqlx::query_as("SELECT id,record_json,content_sha256,canonical_at FROM artifacts WHERE session_id=? ORDER BY id")
                .bind(&session.id).fetch_all(&mut *db).await?;
            artifacts.extend(
                rows.into_iter()
                    .map(|(id, record, digest, canonical_at)| Artifact {
                        session: session.id.clone(),
                        id,
                        record,
                        digest,
                        canonical_at,
                    }),
            );
            let rows:Vec<(String,String,String)>=sqlx::query_as("SELECT source_session_id,source_artifact_id,artifact_id FROM session_history_artifacts WHERE session_id=?")
                .bind(&session.id).fetch_all(&mut *db).await?;
            aliases.extend(
                rows.into_iter()
                    .map(|(source_session, source_artifact, artifact)| Alias {
                        session: session.id.clone(),
                        source_session,
                        source_artifact,
                        artifact,
                    }),
            );
        }
        Ok(Self {
            inventory: inventory.clone(),
            through,
            events: closure.events.iter().copied().collect(),
            sessions,
            artifacts,
            aliases,
            metadata: Metadata {
                catalog: crate::bundle::export::catalog(db, inventory).await?,
                histories: crate::bundle::export::histories(db, closure).await?,
                accounting: crate::bundle::export::accounting(db, closure).await?,
            },
        })
    }

    async fn store(&self, db: &mut SqliteConnection, key: &str) -> Result<(), StoreError> {
        if sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM history_snapshot_captures WHERE capture_key=?)",
        )
        .bind(key)
        .fetch_one(&mut *db)
        .await?
        {
            return Ok(());
        }
        let descriptor = serde_json::to_vec(&self.metadata)?;
        let content = crate::content::put(
            db,
            &maka_agent_facts::artifact::content_digest(&descriptor),
            &descriptor,
        )
        .await?;
        sqlx::query("INSERT INTO history_snapshot_captures(capture_key,inventory,through_sequence,metadata_content_id) VALUES(?,?,?,?)")
            .bind(key).bind(serde_json::to_string(&self.inventory)?).bind(self.through as i64).bind(content).execute(&mut *db).await?;
        for sequence in &self.events {
            let added=sqlx::query("INSERT INTO history_snapshot_events(capture_key,sequence) SELECT ?,sequence FROM event_log WHERE sequence=? AND event_header IS NOT NULL")
                .bind(key).bind(*sequence as i64).execute(&mut *db).await?.rows_affected();
            if added != 1 {
                return Err(StoreError::MaterialCollected);
            }
        }
        for member in &self.sessions {
            sqlx::query("INSERT INTO history_snapshot_sessions(capture_key,session_id,owner_key,copy_identity) VALUES(?,?,?,?)")
                .bind(key).bind(&member.session).bind(owner_key(key,&member.session)).bind(&member.copy_identity).execute(&mut *db).await?;
            for (sequence, inherited, archive) in &member.events {
                sqlx::query("INSERT INTO history_snapshot_members(capture_key,session_id,sequence,inherited,archive_sequence) VALUES(?,?,?,?,?)")
                    .bind(key).bind(&member.session).bind(sequence).bind(inherited).bind(archive).execute(&mut *db).await?;
            }
        }
        for artifact in &self.artifacts {
            sqlx::query("INSERT INTO history_snapshot_artifacts(capture_key,session_id,id,record_json,content_sha256,canonical_at) VALUES(?,?,?,?,?,?)")
                .bind(key).bind(&artifact.session).bind(&artifact.id).bind(&artifact.record).bind(&artifact.digest).bind(artifact.canonical_at).execute(&mut *db).await?;
        }
        for alias in &self.aliases {
            sqlx::query("INSERT INTO history_snapshot_aliases(capture_key,session_id,source_session_id,source_artifact_id,artifact_id) VALUES(?,?,?,?,?)")
                .bind(key).bind(&alias.session).bind(&alias.source_session).bind(&alias.source_artifact).bind(&alias.artifact).execute(&mut *db).await?;
        }
        Ok(())
    }
}

pub(crate) async fn publish(
    db: &mut SqliteConnection,
    capture: &str,
    digest: &str,
) -> Result<(), StoreError> {
    let added=sqlx::query("INSERT INTO history_snapshots(digest,capture_key) SELECT ?,capture_key FROM history_snapshot_captures WHERE capture_key=? ON CONFLICT(digest) DO NOTHING")
        .bind(digest).bind(capture).execute(&mut *db).await?.rows_affected();
    if added == 0
        && !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM history_snapshots WHERE digest=?)",
        )
        .bind(digest)
        .fetch_one(&mut *db)
        .await?
    {
        return Err(StoreError::MaterialCollected);
    }
    release_unpublished(db, capture).await?;
    Ok(())
}

/// A failed publication or a deduplication hit owns no independent snapshot.
pub(crate) async fn release_unpublished(
    db: &mut SqliteConnection,
    key: &str,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM history_snapshot_captures WHERE capture_key=? AND NOT EXISTS(SELECT 1 FROM history_snapshots s WHERE s.capture_key=history_snapshot_captures.capture_key)")
        .bind(key).execute(db).await?;
    Ok(())
}

impl crate::EventLog {
    pub(crate) async fn capture_snapshot(
        &self,
        key: String,
        session: String,
        expected: String,
    ) -> Result<(), StoreError> {
        self.connection
            .run(move |db| {
                Box::pin(async move {
                    let mut tx = db.begin_with("BEGIN IMMEDIATE").await?;
                    let inventory =
                        crate::bundle::inventory(&mut tx, &session)
                            .await
                            .map_err(|error| match error {
                                crate::bundle::BundleError::Store(error) => error,
                                crate::bundle::BundleError::CandidateSetStale => {
                                    StoreError::SessionConflict
                                }
                            })?;
                    inventory
                        .verify_confirmation(&expected)
                        .map_err(|error| match error {
                            crate::bundle::BundleError::Store(error) => error,
                            crate::bundle::BundleError::CandidateSetStale => {
                                StoreError::InvalidTransition(
                                    "confirmed checkpoint subtree changed".into(),
                                )
                            }
                        })?;
                    crate::bundle::require_idle(&mut tx, &inventory).await?;
                    let through = crate::sequence_number(
                        sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
                            .fetch_one(&mut *tx)
                            .await?,
                    )?;
                    let closure =
                        crate::bundle::closure::Closure::capture(&mut tx, &inventory, through)
                            .await?;
                    Capture::read(&mut tx, &inventory, through, &closure)
                        .await?
                        .store(&mut tx, &key)
                        .await?;
                    tx.commit().await.map_err(StoreError::CommitUnknown)
                })
            })
            .await
    }

    pub(crate) async fn export_snapshot<W: tokio::io::AsyncWrite + Unpin + Send + 'static>(
        &self,
        key: String,
        output: W,
    ) -> Result<(W, crate::bundle::BundleSummary), StoreError> {
        self.connection.read(move |db|Box::pin(async move {
            let mut tx=db.begin().await?;
            let result=async {
                let (inventory,through,metadata):(String,i64,Vec<u8>)=sqlx::query_as("SELECT s.inventory,s.through_sequence,c.payload FROM history_snapshot_captures s JOIN contents c ON c.id=s.metadata_content_id WHERE s.capture_key=?")
                    .bind(&key).fetch_optional(&mut *tx).await?.ok_or(StoreError::MaterialCollected)?;
                let inventory:Inventory=serde_json::from_str(&inventory)?;
                let metadata:Metadata=serde_json::from_slice(&metadata)?;
                let mut writer=Writer::new(output).await?;
                writer.record(&Record::Header {inventory:inventory.clone(),source_high_water:crate::sequence_number(through)?}).await?;
                for record in metadata.catalog.iter().chain(&metadata.histories) { writer.record(record).await?; }
                let events:Vec<i64>=sqlx::query_scalar("SELECT sequence FROM history_snapshot_events WHERE capture_key=? ORDER BY sequence").bind(&key).fetch_all(&mut *tx).await?;
                let events=events.into_iter().map(crate::sequence_number).collect::<Result<BTreeSet<_>,_>>()?;
                crate::bundle::export::events(&mut tx,&events,&mut writer).await?;
                crate::bundle::blobs::export_events(&mut tx,&events,&mut writer).await?;
                for session in &inventory.sessions {
                    let rows:Vec<(String,String,Option<i64>)>=sqlx::query_as("SELECT record_json,content_sha256,canonical_at FROM history_snapshot_artifacts WHERE capture_key=? AND session_id=? ORDER BY id")
                        .bind(&key).bind(&session.id).fetch_all(&mut *tx).await?;
                    for (record,digest,_frozen_at) in rows {
                        let metadata=serde_json::from_str(&record)?;
                        let frozen_at=crate::bundle::blobs::snapshot_witness(&mut tx,&key,&metadata).await?;
                        crate::bundle::blobs::transfer(&mut tx,Blob::Artifact { metadata,digest,frozen_at },&mut writer).await?;
                    }
                    let aliases:Vec<(String,String,String)>=sqlx::query_as("SELECT source_session_id,source_artifact_id,artifact_id FROM history_snapshot_aliases WHERE capture_key=? AND session_id=? ORDER BY source_session_id,source_artifact_id")
                        .bind(&key).bind(&session.id).fetch_all(&mut *tx).await?;
                    for (source_session,source_artifact,artifact) in aliases { writer.record(&Record::HistoryArtifact {session:session.id.clone(),source_session,source_artifact,artifact}).await?; }
                }
                for record in &metadata.accounting { writer.record(record).await?; }
                let (output,bytes,digest)=writer.finish().await?;
                Ok((output,crate::bundle::BundleSummary{inventory,bytes,digest}))
            }.await;
            tx.rollback().await?;
            result
        })).await
    }
}
