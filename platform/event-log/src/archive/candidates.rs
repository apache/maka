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

use super::{PruneCandidate, PruneCandidates, PruneCursor, target};
use crate::{
    EventLog, StoreError,
    context::{read, safety, selection::Selection},
};
use maka_agent_facts::event::RuntimeEvent;
use sqlx::{Connection, SqliteConnection};

impl EventLog {
    pub async fn prepare_prune_candidates(
        &self,
        session: &str,
        current: Option<&str>,
        max_candidates: usize,
        max_bytes: usize,
        cursor: Option<&PruneCursor>,
    ) -> Result<PruneCandidates, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        if max_candidates > 10_000 || max_bytes > 32 * 1024 * 1024 {
            return Err(StoreError::PrefixTooLarge);
        }
        let (session, current) = (session.to_owned(), current.map(str::to_owned));
        let cursor = cursor.cloned();
        self.connection.read_interruptible(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            if let Some(id) = &current {
                let live: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM runtime_events o WHERE invocation_id=? AND kind='invocation_opened'
                    AND json_extract(event_json,'$.invocation.session_id')=? AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=o.invocation_id AND t.kind='invocation_ended'))")
                    .bind(id).bind(&session).fetch_one(&mut *tx).await?;
                if !live { return Err(StoreError::InvalidTransition("prune source invocation is not live".into())); }
                safety::settled_boundary(&mut tx, id, i64::MAX as u64).await?;
            }
            safety::require_safe(&mut tx, &session, current.as_deref()).await?;
            let mut output = PruneCandidates { candidates: Vec::new(), next: None };
            // The admission preflight checks safety without materializing history.
            if max_candidates > 0 {
                let selection = if let Some(id) = &current {
                    let json: String = sqlx::query_scalar("SELECT event_json FROM runtime_events WHERE invocation_id=? AND kind='invocation_opened'")
                        .bind(id).fetch_one(&mut *tx).await?;
                    let opening: RuntimeEvent = serde_json::from_str(&json)?;
                    Selection::for_opening(&mut tx, &opening).await?
                } else {
                    Selection::session(&session)
                };
                let baseline = read::latest_selected(&mut tx, &selection, i64::MAX as u64).await?;
                let covered = baseline.as_ref().map_or(0, |b| b.checkpoint.covered_through);
                let through = selection.high_water(&mut tx, i64::MAX as u64).await?;
                let mut cursor = cursor.unwrap_or(PruneCursor { through, after_sequence: covered });
                if cursor.after_sequence > cursor.through || cursor.through > through {
                    return Err(StoreError::InvalidTransition("invalid prune scan fence".into()));
                }
                cursor.after_sequence = cursor.after_sequence.max(covered);
                scan(&mut tx, &selection, cursor, max_candidates, max_bytes, &mut output).await?;
            }
            tx.commit().await?;
            Ok(output)
        })).await
    }
}

async fn scan(
    connection: &mut SqliteConnection,
    selection: &Selection,
    cursor: PruneCursor,
    max_candidates: usize,
    max_bytes: usize,
    output: &mut PruneCandidates,
) -> Result<(), StoreError> {
    let session = selection
        .session
        .as_deref()
        .expect("prune requires a Session");
    let filter = Selection::predicate("t", "?4");
    let archive_filter = Selection::archive_predicate("t", "a", "9223372036854775807", "?4");
    let branches = target::SOURCES.map(|source| format!(
        "SELECT t.sequence AS sequence,t.event_id,
           COALESCE(length(CAST(json_extract(t.event_json,'$.fact.outcome.model_projection') AS BLOB)),
                    length(CAST(json_extract(t.event_json,'$.fact.outcome.message') AS BLOB)),0)
         FROM ({source}) t CROSS JOIN runtime_events d
         WHERE d.invocation_id=t.invocation_id AND d.operation_id=t.operation_id AND d.kind='tool_dispatched'
           AND t.sequence>?1 AND t.sequence<=?3 AND t.owner_session_id=?2
           AND {filter} AND json_extract(d.event_json,'$.fact.call.origin.kind')='provider'
           AND NOT EXISTS(SELECT 1 FROM runtime_events a WHERE a.kind='tool_result_archived' AND CAST(json_extract(a.event_json,'$.fact.placeholder.identity.runtime_event_id') AS TEXT)=t.event_id AND {archive_filter})"
    ));
    let query = format!(
        "{} ORDER BY sequence LIMIT ?5",
        branches.join(" UNION ALL ")
    );
    let mut after = cursor.after_sequence as i64;
    let mut used = 0_usize;
    // Merge the indexed branches into bounded metadata, stopping at the page.
    // Keep the cursor at the last admitted result.
    let rows: Vec<(i64, String, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(query))
        .bind(after)
        .bind(session)
        .bind(cursor.through as i64)
        .bind(&selection.lineage)
        .bind((max_candidates + 1) as i64)
        .fetch_all(&mut *connection)
        .await?;
    for (sequence, id, bytes) in rows {
        if output.candidates.len() >= max_candidates
            || (!output.candidates.is_empty() && bytes as usize > max_bytes.saturating_sub(used))
        {
            output.next = Some(PruneCursor {
                through: cursor.through,
                after_sequence: after as u64,
            });
            break;
        }
        let target = target::read(connection, session, &id)
            .await?
            .ok_or(super::ArchiveError::Corrupt)?;
        let candidate = PruneCandidate {
            event_id: target.event_id,
            tool_call_id: target.call.tool_call_id,
            tool_name: target.name,
            projection: target.projection,
        };
        let measured = serde_json::to_vec(&(
            &candidate.event_id,
            &candidate.tool_call_id,
            &candidate.tool_name,
            &candidate.projection,
        ))?
        .len()
            + 128;
        // A batch budget must not prevent an individual large result from ever
        // being archived. Admit it alone and resume the scan on the next call.
        if !output.candidates.is_empty() && measured > max_bytes.saturating_sub(used) {
            output.next = Some(PruneCursor {
                through: cursor.through,
                after_sequence: after as u64,
            });
            break;
        }
        output.candidates.push(candidate);
        used += measured;
        after = sequence;
    }
    Ok(())
}
