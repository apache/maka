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
use maka_agent_facts::history::media::MediaManifest;

impl EventLog {
    /// Commit small exact counters, fingerprints and resource decisions. No
    /// serialized Message body is retained; wire encoding is the second phase.
    pub async fn put_prepared_group(
        &self,
        build: &PreparedBuild,
        group: &PreparedGroup,
        messages: Vec<Message>,
        breakdown: PreparedContextBreakdown,
        manifest: MediaManifest,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.selection.session)?;
        if measure::prompt_breakdown(&messages) != breakdown {
            return Err(invalid("prepared group accounting mismatch"));
        }
        let mut refs = Vec::with_capacity(messages.len());
        for message in &messages {
            let mut digest = HashWriter(Sha256::new());
            serde_json::to_writer(&mut digest, message)?;
            refs.push(MessageRef {
                id: hex::encode(digest.0.finalize()),
                assistant: matches!(message, Message::Assistant { .. }),
                breakdown: measure::prompt_breakdown(std::slice::from_ref(message)),
            });
        }
        let dependencies = dependencies::extract(&messages);
        let needed = dependencies::needed(&messages);
        let index_bytes = dependencies
            .iter()
            .map(|(_, id)| id.len().saturating_mul(2).saturating_add(256))
            .chain(
                needed
                    .iter()
                    .map(|id| id.len().saturating_mul(2).saturating_add(256)),
            )
            .fold(0usize, usize::saturating_add);
        drop(messages);
        let lease = build.lease.clone();
        let id = build.id.clone();
        let sequence = group_number(group)?;
        self.prepared_store()?.run(move |connection, in_flight|Box::pin(async move {
            let mut tx=connection.begin().await?;
            require_build_session(&mut tx, expected_session.as_deref(), &scope_id).await?;
            assembly::require_discovered(&mut tx,assembly::Kind::Logical,&id).await?;
            let dirty:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_dirty WHERE build_id=? AND group_sequence=?)").bind(&id).bind(sequence as i64).fetch_one(&mut *tx).await?;
            if !dirty {return Err(invalid("prepared group was not selected for rendering"));}
            let mut ref_batch=refs::RefBatch::default();
            let group=Group{wire_id:None,wire_bytes:0,index_bytes,dependencies:needed,members:members(&mut tx,&id,sequence).await?,messages:refs,breakdown,manifest};
            let content=tree::save_group(&mut tx,&mut ref_batch,&group).await?;
            for call_id in &group.dependencies {
                sqlx::query("INSERT OR IGNORE INTO context_prepared_mcp_refs(content_id,call_id,group_sequence) VALUES(?,?,?)")
                    .bind(&content).bind(call_id).bind(sequence as i64).execute(&mut *tx).await?;
            }

            for (message_index,call_id) in dependencies {
                sqlx::query("INSERT OR IGNORE INTO context_prepared_mcp_ids(content_id,call_id,message_index,group_sequence) VALUES(?,?,?,?)")
                    .bind(&content).bind(call_id).bind(message_index as i64).bind(sequence as i64).execute(&mut *tx).await?;
            }

            assembly::stage(&mut tx,&mut ref_batch,in_flight,assembly::Kind::Logical,&id,sequence,&content).await?;
            ref_batch.flush(&mut tx).await?;
            tx.commit().await.map_err(StoreError::CommitUnknown)?;lease.wake();Ok(())
        })).await
    }
}
struct HashWriter(Sha256);
impl std::io::Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
