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
use crate::bundle::format::{Blob, FrameSender, Record};
use crate::{StoreError, bundle::Inventory};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
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
    fn read(
        db: &Connection,
        inventory: &Inventory,
        through: u64,
        closure: &crate::bundle::closure::Closure,
    ) -> Result<Self, StoreError> {
        let mut sessions = Vec::with_capacity(inventory.sessions.len());
        let mut artifacts = Vec::new();
        let mut aliases = Vec::new();
        for session in &inventory.sessions {
            let identity:Option<String>=db.query_row("SELECT json_array(source_session_id,source_revision,through_sequence,observed_through,request_json,lineage_json,bundle_digest,state) FROM session_history_copies WHERE session_id=?", rusqlite::params![&session.id], |row| row.get(0)).optional()?;
            let events=db.prepare_cached("SELECT sequence,inherited,archive_sequence FROM session_history_events WHERE owner_session_id=? AND sequence<=? ORDER BY sequence")?.query_map(rusqlite::params![&session.id, through as i64], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?;
            sessions.push(Member {
                session: session.id.clone(),
                copy_identity: identity.unwrap_or_default(),
                events,
            });
            let rows:Vec<(String,String,String,Option<i64>)>=db.prepare_cached("SELECT id,record_json,content_sha256,canonical_at FROM artifacts WHERE session_id=? ORDER BY id")?.query_map(rusqlite::params![&session.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,)))?.collect::<Result<Vec<_>, _>>()?;
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
            let rows:Vec<(String,String,String)>=db.prepare_cached("SELECT source_session_id,source_artifact_id,artifact_id FROM session_history_artifacts WHERE session_id=?")?.query_map(rusqlite::params![&session.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?;
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
                catalog: crate::bundle::export::catalog(db, inventory)?,
                histories: crate::bundle::export::histories(db, closure)?,
                accounting: crate::bundle::export::accounting(db, closure)?,
            },
        })
    }

    fn store(&self, db: &Connection, key: &str) -> Result<(), StoreError> {
        if db.query_row(
            "SELECT EXISTS(SELECT 1 FROM history_snapshot_captures WHERE capture_key=?)",
            rusqlite::params![key],
            |row| row.get::<_, bool>(0),
        )? {
            return Ok(());
        }
        let descriptor = serde_json::to_vec(&self.metadata)?;
        let content = crate::content::put(
            db,
            &maka_agent_facts::artifact::content_digest(&descriptor),
            &descriptor,
        )?;
        db.execute("INSERT INTO history_snapshot_captures(capture_key,inventory,through_sequence,metadata_content_id) VALUES(?,?,?,?)", rusqlite::params![key, serde_json::to_string(&self.inventory)?, self.through as i64, content])?;
        for sequence in &self.events {
            let added=db.execute("INSERT INTO history_snapshot_events(capture_key,sequence) SELECT ?,sequence FROM event_log WHERE sequence=? AND event_header IS NOT NULL", rusqlite::params![key, *sequence as i64])?;
            if added != 1 {
                return Err(StoreError::MaterialCollected);
            }
        }
        for member in &self.sessions {
            db.execute("INSERT INTO history_snapshot_sessions(capture_key,session_id,owner_key,copy_identity) VALUES(?,?,?,?)", rusqlite::params![key, &member.session, owner_key(key,&member.session), &member.copy_identity])?;
            for (sequence, inherited, archive) in &member.events {
                db.execute("INSERT INTO history_snapshot_members(capture_key,session_id,sequence,inherited,archive_sequence) VALUES(?,?,?,?,?)", rusqlite::params![key, &member.session, sequence, inherited, archive])?;
            }
        }
        for artifact in &self.artifacts {
            db.execute("INSERT INTO history_snapshot_artifacts(capture_key,session_id,id,record_json,content_sha256,canonical_at) VALUES(?,?,?,?,?,?)", rusqlite::params![key, &artifact.session, &artifact.id, &artifact.record, &artifact.digest, artifact.canonical_at])?;
        }
        for alias in &self.aliases {
            db.execute("INSERT INTO history_snapshot_aliases(capture_key,session_id,source_session_id,source_artifact_id,artifact_id) VALUES(?,?,?,?,?)", rusqlite::params![key, &alias.session, &alias.source_session, &alias.source_artifact, &alias.artifact])?;
        }
        Ok(())
    }
}

pub(crate) fn publish(db: &Connection, capture: &str, digest: &str) -> Result<(), StoreError> {
    let added=db.execute("INSERT INTO history_snapshots(digest,capture_key) SELECT ?,capture_key FROM history_snapshot_captures WHERE capture_key=? ON CONFLICT(digest) DO NOTHING", rusqlite::params![digest, capture])?;
    if added == 0
        && !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM history_snapshots WHERE digest=?)",
            rusqlite::params![digest],
            |row| row.get::<_, bool>(0),
        )?
    {
        return Err(StoreError::MaterialCollected);
    }
    release_unpublished(db, capture)?;
    Ok(())
}

/// A failed publication or a deduplication hit owns no independent snapshot.
pub(crate) fn release_unpublished(db: &Connection, key: &str) -> Result<(), StoreError> {
    db.execute("DELETE FROM history_snapshot_captures WHERE capture_key=? AND NOT EXISTS(SELECT 1 FROM history_snapshots s WHERE s.capture_key=history_snapshot_captures.capture_key)", rusqlite::params![key])?;
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
                let tx = Transaction::new_unchecked(db, TransactionBehavior::Immediate)?;
                let inventory =
                    crate::bundle::inventory(&tx, &session).map_err(|error| match error {
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
                crate::bundle::require_idle(&tx, &inventory)?;
                let through = crate::sequence_number(tx.query_row(
                    "SELECT COALESCE(MAX(sequence),0) FROM event_log",
                    rusqlite::params![],
                    |row| row.get(0),
                )?)?;
                let closure = crate::bundle::closure::Closure::capture(&tx, &inventory, through)?;
                Capture::read(&tx, &inventory, through, &closure)?.store(&tx, &key)?;
                tx.commit().map_err(StoreError::CommitUnknown)
            })
            .await
    }

    pub(crate) async fn export_snapshot<W: tokio::io::AsyncWrite + Unpin + Send + 'static>(
        &self,
        key: String,
        output: W,
    ) -> Result<(W, crate::bundle::BundleSummary), StoreError> {
        let (mut writer, frames) = FrameSender::channel();
        let producer = self.connection.read(move |db| {
            let tx = Transaction::new_unchecked(db, TransactionBehavior::Deferred)?;
                let (inventory,through,metadata):(String,i64,Vec<u8>)=tx.query_row("SELECT s.inventory,s.through_sequence,c.payload FROM history_snapshot_captures s JOIN contents c ON c.id=s.metadata_content_id WHERE s.capture_key=?", rusqlite::params![&key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,))).optional()?.ok_or(StoreError::MaterialCollected)?;
                let inventory:Inventory=serde_json::from_str(&inventory)?;
                let metadata:Metadata=serde_json::from_slice(&metadata)?;
                writer.record(&Record::Header {inventory:inventory.clone(),source_high_water:crate::sequence_number(through)?})?;
                for record in metadata.catalog.iter().chain(&metadata.histories) { writer.record(record)?; }
                let events:Vec<i64>=tx.prepare_cached("SELECT sequence FROM history_snapshot_events WHERE capture_key=? ORDER BY sequence")?.query_map(rusqlite::params![&key], |row| row.get(0))?.collect::<Result<Vec<_>, _>>()?;
                let events=events.into_iter().map(crate::sequence_number).collect::<Result<BTreeSet<_>,_>>()?;
                crate::bundle::export::events(&tx,&events,&mut writer)?;
                crate::bundle::blobs::export_events(&tx,&events,&mut writer)?;
                for session in &inventory.sessions {
                    let rows:Vec<(String,String,Option<i64>)>=tx.prepare_cached("SELECT record_json,content_sha256,canonical_at FROM history_snapshot_artifacts WHERE capture_key=? AND session_id=? ORDER BY id")?.query_map(rusqlite::params![&key, &session.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?;
                    for (record,digest,_frozen_at) in rows {
                        let metadata=serde_json::from_str(&record)?;
                        let frozen_at=crate::bundle::blobs::snapshot_witness(&tx,&key,&metadata)?;
                        crate::bundle::blobs::transfer(&tx,Blob::Artifact { metadata,digest,frozen_at },&mut writer)?;
                    }
                    let aliases:Vec<(String,String,String)>=tx.prepare_cached("SELECT source_session_id,source_artifact_id,artifact_id FROM history_snapshot_aliases WHERE capture_key=? AND session_id=? ORDER BY source_session_id,source_artifact_id")?.query_map(rusqlite::params![&key, &session.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,)))?.collect::<Result<Vec<_>, _>>()?;
                    for (source_session,source_artifact,artifact) in aliases { writer.record(&Record::HistoryArtifact {session:session.id.clone(),source_session,source_artifact,artifact})?; }
                }
                for record in &metadata.accounting { writer.record(record)?; }
            tx.rollback()?;
            writer.complete()?;
            Ok(inventory)
        });
        let consumer = crate::bundle::format::write_frames(output, frames);
        let (inventory, written) = tokio::join!(producer, consumer);
        let (output, bytes, digest) = match written {
            Ok(written) => written,
            Err(error) => {
                if matches!(&error, StoreError::Io(cause) if cause.kind() == std::io::ErrorKind::UnexpectedEof)
                {
                    inventory?;
                }
                return Err(error);
            }
        };
        let inventory = inventory?;
        Ok((
            output,
            crate::bundle::BundleSummary {
                inventory,
                bytes,
                digest,
            },
        ))
    }
}
