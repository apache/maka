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

//! Cleanup follows the established Session-retirement/material-retention owner.
//! A copied row owns metadata only; its immutable payload remains with the
//! canonical source until the existing reverse-reference collector releases it.
use crate::StoreError;
use sqlx::SqliteConnection;

pub(crate) async fn retire_owner(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<(), StoreError> {
    for statement in [
        "DELETE FROM context_semantic_rows WHERE owner_session_id=?",
        "DELETE FROM context_semantic_changes WHERE owner_session_id=?",
        "DELETE FROM context_semantic_cuts WHERE owner_session_id=?",
        "DELETE FROM context_semantic_frontiers WHERE session_id=?",
        "DELETE FROM context_semantic_checkpoints WHERE session_id=?",
    ] {
        sqlx::query(statement)
            .bind(session)
            .execute(&mut *connection)
            .await?;
    }
    sqlx::query("INSERT INTO context_semantic_heads(session_id,through_sequence,unavailable_at,unavailable_reason) VALUES(?,0,0,'semantic owner retired') ON CONFLICT(session_id) DO UPDATE SET unavailable_at=0,unavailable_reason='semantic owner retired'")
        .bind(session).execute(&mut *connection).await?;
    // Retain context_semantic_copies' tiny completed marker. A removed owner
    // must not be rehydrated by an accidental later metadata access.
    Ok(())
}

/// Called only after the canonical collector proves there is no live owner,
/// including copied/revision/archived references to this source material.
pub(crate) async fn collect_event(
    connection: &mut SqliteConnection,
    sequence: u64,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM context_semantic_fragment_pieces WHERE source_sequence=?")
        .bind(sequence as i64)
        .execute(&mut *connection)
        .await?;
    sqlx::query("DELETE FROM context_semantic_fragments WHERE source_sequence=?")
        .bind(sequence as i64)
        .execute(connection)
        .await?;
    Ok(())
}
