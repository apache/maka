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

use super::ArchiveError;
use crate::{
    StoreError,
    context::{SourceEvidence, selection::Selection},
};
use sha2::{Digest, Sha256};
use sqlx::SqliteConnection;

pub(crate) async fn digest_selected(
    connection: &mut SqliteConnection,
    selection: &Selection,
    source: &SourceEvidence,
    before: u64,
) -> Result<String, StoreError> {
    let session = selection.session.as_deref().ok_or(ArchiveError::Corrupt)?;
    let mut hash = Sha256::new();
    hash.update(b"maka.effective-context.v2\0");
    hash.update(source.digest.as_bytes());
    let copied: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT hash FROM context_archive_copy_prefixes
        WHERE owner=? AND target_sequence<=? ORDER BY target_sequence DESC LIMIT 1",
    )
    .bind(session)
    .bind(source.high_water as i64)
    .fetch_optional(&mut *connection)
    .await?;
    hash.update(copied.unwrap_or_else(|| Sha256::digest(b"maka.archive.copy.v2\0").to_vec()));
    // Source roots already bind every selected archive admitted at/before the
    // source cut. Only later overlays need their own identity here. This keeps
    // source.high_water independent of the exclusive archive fence.
    let writer = Selection::predicate("a", "?4");
    let target = Selection::predicate("a", "?4")
        .replace("a.sequence", "a.target_sequence")
        .replace("a.invocation_id", "a.target_invocation_id");
    let query = format!(
        "SELECT a.sequence,a.hash FROM context_archive_records a
        WHERE a.session_id=?1 AND a.sequence>?2 AND a.sequence<?3 AND a.target_sequence<=?2
          AND {writer} AND {target} AND a.sequence>?5 ORDER BY a.sequence LIMIT 128"
    );
    let mut after = source.high_water as i64;
    loop {
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(sqlx::AssertSqlSafe(query.clone()))
            .bind(session)
            .bind(source.high_water as i64)
            .bind(before as i64)
            .bind(&selection.lineage)
            .bind(after)
            .fetch_all(&mut *connection)
            .await?;
        if rows.is_empty() {
            break;
        }
        for (sequence, identity) in rows {
            hash.update(sequence.to_be_bytes());
            hash.update(identity);
            after = sequence;
        }
    }
    Ok(format!("sha256:{}", hex::encode(hash.finalize())))
}

pub(crate) async fn affected_after(
    connection: &mut SqliteConnection,
    selection: &Selection,
    coverage: u64,
    after: u64,
) -> Result<bool, StoreError> {
    let writer = Selection::predicate("a", "?4");
    let target = Selection::predicate("a", "?4")
        .replace("a.sequence", "a.target_sequence")
        .replace("a.invocation_id", "a.target_invocation_id");
    Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT EXISTS(SELECT 1 FROM context_archive_records a WHERE a.session_id=?1
         AND a.sequence>?2 AND a.target_sequence<=?3 AND {writer} AND {target})"
    )))
    .bind(&selection.session)
    .bind(after as i64)
    .bind(coverage as i64)
    .bind(&selection.lineage)
    .fetch_one(connection)
    .await?)
}

pub(crate) async fn validate_summary(
    connection: &mut SqliteConnection,
    source: &SourceEvidence,
    expected: &str,
    requested: u64,
) -> Result<(), StoreError> {
    let selection = Selection::resolve(connection, &source.scope).await?;
    if selection.session.is_none() {
        return Err(ArchiveError::Corrupt.into());
    }
    if affected_after(connection, &selection, source.high_water, requested).await? {
        return Err(StoreError::InvalidTransition(
            "summary effective source changed after its request".into(),
        ));
    }
    if digest_selected(connection, &selection, source, requested).await? == expected {
        Ok(())
    } else {
        Err(StoreError::InvalidTransition(
            "summary effective source digest mismatch".into(),
        ))
    }
}
