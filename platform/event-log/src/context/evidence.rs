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

use super::selection::Selection;
use super::{SourceEvidence, invalid};
use crate::{StoreError, sequence_number};

mod roots;
pub(crate) use roots::{RootDigest, record, register};

/// The same scoped identity as complete prefix(), using committed source progress.
pub(super) fn evidence(
    connection: &rusqlite::Connection,
    session: &str,
    through: u64,
) -> Result<SourceEvidence, StoreError> {
    selected(connection, &Selection::session(session), through)
}

pub(crate) fn selected(
    connection: &rusqlite::Connection,
    selection: &Selection,
    through: u64,
) -> Result<SourceEvidence, StoreError> {
    let digest = digests(connection, selection, &[through])?
        .pop()
        .expect("one requested prefix");
    Ok(SourceEvidence {
        scope: selection.scope.clone(),
        high_water: through,
        digest,
    })
}

/// Resolve exact selected source boundaries from indexed durable prefixes.
/// Each boundary must select a complete row (or the empty prefix at zero).
pub(super) fn digests(
    connection: &rusqlite::Connection,
    selection: &Selection,
    throughs: &[u64],
) -> Result<Vec<String>, StoreError> {
    if selection.session.is_none() {
        return Err(invalid("context requires a Session"));
    }
    let mut result = Vec::with_capacity(throughs.len());
    let scope = serde_json::to_vec(&selection.scope)?;
    for through in throughs {
        let cut = i64::try_from(*through).map_err(|_| invalid("source cut overflow"))?;
        let digest: String = connection
            .prepare_cached("SELECT context_source_identity(?,?,?,?)")?
            .query_row(
                rusqlite::params![&selection.session, &selection.lineage, &scope, cut],
                |row| row.get(0),
            )?;
        result.push(
            serde_json::from_str::<Result<String, String>>(&digest)?
                .map_err(StoreError::InvalidTransition)?,
        );
    }
    Ok(result)
}

pub(super) fn high_water(
    connection: &rusqlite::Connection,
    session: &str,
    before: i64,
) -> Result<u64, StoreError> {
    Selection::session(session).high_water(connection, sequence_number(before.saturating_sub(1))?)
}
