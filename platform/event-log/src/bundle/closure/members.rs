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

use super::Closure;
use crate::{StoreError, sequence_number};
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::BTreeSet;

impl Closure {
    /// Follow only this member's flattened ownership chain. Do not expose a
    /// proof-only parent's complete conversation, catalog or private artifacts.
    pub(super) fn member(
        &mut self,
        db: &Connection,
        session: &str,
        sequence: u64,
    ) -> Result<(), StoreError> {
        let owner: String = db
            .prepare_cached("SELECT event_session FROM runtime_events WHERE sequence=?")?
            .query_row(params![sequence as i64], |row| row.get(0))?;
        let mut current = session.to_owned();
        let mut seen = BTreeSet::new();
        while current != owner {
            if !seen.insert(current.clone()) {
                return Err(invalid("bundle member ownership contains a cycle"));
            }
            if self.members.contains_key(&(current.clone(), sequence)) {
                return Ok(());
            }
            let row: Option<(String, Option<i64>)> = db.prepare_cached("SELECT c.source_session_id,h.archive_sequence FROM session_history_copies c
                 JOIN session_history_members h ON h.session_id=c.session_id WHERE c.session_id=? AND h.sequence=?")?.query_row(params![&current, sequence as i64], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
            let (source, archive) =
                row.ok_or_else(|| invalid("bundle member is outside its declared source history"))?;
            self.copies.insert(current.clone());
            self.members.insert(
                (current, sequence),
                archive.map(sequence_number).transpose()?,
            );
            self.add(sequence)?;
            if let Some(archive) = archive {
                self.add(sequence_number(archive)?)?;
            }
            current = source;
        }
        Ok(())
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
