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

use super::records::{advance, invalid, read_record, require_session};
use crate::StoreError;
use maka_agent_facts::artifact::ArtifactSource;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;

/// Copy an explicitly authorized attachment without materializing its BLOB in the Host.
/// The caller commits this together with the message that owns the destination.
pub(crate) fn copy_in_transaction(
    tx: &rusqlite::Connection,
    source: &AttachmentRef,
    destination: &AttachmentRef,
    turn: &str,
    created_at: u64,
) -> Result<(), StoreError> {
    let StorageRef::SessionFile {
        session_id: source_session,
        relative_path: source_id,
    } = &source.storage_ref
    else {
        return Err(invalid("Attachment source is not a Session Artifact"));
    };
    let StorageRef::SessionFile {
        session_id: target_session,
        relative_path: target_id,
    } = &destination.storage_ref
    else {
        return Err(invalid("Attachment destination is not a Session Artifact"));
    };
    let (mut artifact, digest) = read_record(tx, source_session, source_id)?
        .ok_or_else(|| invalid("Delegated attachment source no longer exists"))?;
    artifact.validate_attachment(source).map_err(invalid)?;
    if artifact.source == ArtifactSource::UserUpload && artifact.summary.as_ref() != Some(&digest) {
        return Err(StoreError::ArtifactConflict);
    }
    require_session(tx, target_session)?;
    artifact.session_id = target_session.clone();
    artifact.id = target_id.clone();
    artifact.turn_id = turn.into();
    artifact.created_at = created_at;
    artifact.validate().map_err(invalid)?;
    artifact.validate_attachment(destination).map_err(invalid)?;
    let encoded = serde_json::to_string(&artifact)?;
    if let Some((existing, target_digest)) = read_record(tx, target_session, target_id)? {
        if existing != artifact || target_digest != digest {
            return Err(StoreError::ArtifactConflict);
        }
        let same: bool = tx.prepare_cached("SELECT EXISTS(SELECT 1 FROM artifacts s JOIN artifacts t
             ON t.session_id = ?3 AND t.id = ?4 WHERE s.session_id = ?1 AND s.id = ?2
             AND (SELECT length(payload) FROM contents WHERE content_sha256=s.content_sha256) = ?5 AND s.content_sha256 = t.content_sha256)")?.query_row(rusqlite::params![source_session, source_id, target_session, target_id, artifact.size_bytes as i64], |row| row.get(0))?;
        return if same {
            Ok(())
        } else {
            Err(StoreError::ArtifactConflict)
        };
    }
    let inserted = tx.prepare_cached("INSERT INTO artifacts (session_id, id, created_at, record_json, content_sha256, canonical_at, lookup_digest)
         SELECT ?3, ?4, ?5, ?6, content_sha256, canonical_at, ?8 FROM artifacts JOIN contents USING(content_sha256)
         WHERE session_id = ?1 AND artifacts.id = ?2 AND length(payload) = ?7")?.execute(rusqlite::params![source_session, source_id, target_session, target_id, created_at as i64, encoded, artifact.size_bytes as i64, super::identity::artifact_lookup_digest(target_session, target_id).as_slice()])?
    ;
    if inserted != 1 {
        return Err(StoreError::ArtifactConflict);
    }
    advance(tx, target_session)
}

impl crate::EventLog {
    /// Idempotent immutable copy, authorized by Host at both endpoints. Payloads
    /// stay inside SQLite; even a 50 MiB attachment never crosses a V8 heap.
    pub async fn copy_plugin_attachment(
        &self,
        namespace: &maka_capabilities::storage::Namespace,
        request: maka_agent_ports::execution::CopyAttachment,
    ) -> Result<AttachmentRef, StoreError> {
        use sha2::{Digest, Sha256};
        request
            .validate()
            .map_err(|error| invalid(&error.to_string()))?;
        let identity = serde_json::to_vec(&(namespace.package(), namespace.scope(), &request))?;
        let id = format!("attachment-{}", hex::encode(Sha256::digest(identity)));
        let mut destination = request.attachment.clone();
        destination.storage_ref = StorageRef::SessionFile {
            session_id: request.target_session_id.clone(),
            relative_path: id.clone(),
        };
        self.connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                let created_at = match read_record(&tx, &request.target_session_id, &id)? {
                    Some((artifact, _)) => artifact.created_at,
                    None => std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|error| invalid(&error.to_string()))?
                        .as_millis()
                        .try_into()
                        .map_err(|_| invalid("clock overflow"))?,
                };
                copy_in_transaction(&tx, &request.attachment, &destination, &id, created_at)?;
                tx.commit().map_err(StoreError::CommitUnknown)?;
                Ok(destination)
            })
            .await
    }
}
