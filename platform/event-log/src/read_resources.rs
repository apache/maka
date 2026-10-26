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

use crate::{EventLog, StoreError};
use maka_agent_facts::read::ResourceAddress;
use sqlx::Connection;

impl EventLog {
    /// Resolve a locator in the reader's visible namespace, never across Sessions.
    /// Content reads retain their own evidence and authorization checks.
    pub async fn resolve_read_resource(
        &self,
        session: &str,
        address: ResourceAddress,
    ) -> Result<Option<ResourceAddress>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        address
            .canonical_path()
            .map_err(|error| StoreError::InvalidTransition(error.into()))?;
        let (query, column) = match &address {
            ResourceAddress::Attachment(_) => (
                "SELECT id FROM artifacts WHERE session_id=?1
                 AND json_extract(record_json,'$.source')='user_upload'",
                "id",
            ),
            ResourceAddress::Task(_) => (
                "SELECT id FROM shell_runs WHERE session_id=?1
                 AND json_extract(record_json,'$.visibility')='model'",
                "id",
            ),
            ResourceAddress::ToolResult(_) => (
                "SELECT t.event_id FROM runtime_events t
                 WHERE t.kind='tool_settled'
                   AND (t.event_session=?1 OR EXISTS(
                       SELECT 1 FROM session_history_members h
                       WHERE h.session_id=?1 AND h.sequence=t.sequence))
                   AND json_extract(t.event_json,'$.fact.outcome.kind') IN ('succeeded','failed')
                   AND EXISTS(SELECT 1 FROM runtime_events d
                       WHERE d.invocation_id=t.invocation_id AND d.operation_id=t.operation_id
                         AND d.kind='tool_dispatched'
                         AND json_extract(d.event_json,'$.fact.call.origin.kind')='provider')",
                "t.event_id",
            ),
        };
        let session = session.to_owned();
        self.connection
            .run(move |connection| {
                Box::pin(async move {
                    let mut tx = connection.begin().await?;
                    for exact in [true, false] {
                        if !exact && address.id().contains('\0') {
                            return Ok(None);
                        }
                        let upper = (!exact).then(|| prefix_upper(address.id())).flatten();
                        let predicate = match (exact, upper.is_some()) {
                            (true, _) => format!("{column} = ?2"),
                            (false, true) => format!("{column} >= ?2 AND {column} < ?3"),
                            (false, false) => format!("{column} >= ?2"),
                        };
                        let sql = format!("{query} AND {predicate} ORDER BY {column} LIMIT 2");
                        let mut read =
                            sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.as_str()))
                                .bind(&session)
                                .bind(address.id());
                        if let Some(upper) = &upper {
                            read = read.bind(upper);
                        }
                        let matches = read.fetch_all(&mut *tx).await?;
                        match matches.len() {
                            0 => {}
                            1 => {
                                return Ok(Some(
                                    address.with_id(matches.into_iter().next().unwrap()),
                                ));
                            }
                            _ => return Err(StoreError::AmbiguousReadResource),
                        }
                    }
                    Ok(None)
                })
            })
            .await
    }
}

// UTF-8 byte order agrees with scalar order. Explicit bounds retain the prefix
// index range with fixed query plans, including IDs containing GLOB metacharacters.
fn prefix_upper(prefix: &str) -> Option<String> {
    for (offset, character) in prefix.char_indices().rev() {
        let next = match character {
            '\u{10ffff}' => continue,
            '\u{d7ff}' => '\u{e000}',
            _ => char::from_u32(u32::from(character) + 1)
                .expect("nonterminal Unicode scalar has a successor"),
        };
        let mut upper = prefix[..offset].to_owned();
        upper.push(next);
        return Some(upper);
    }
    None
}

#[cfg(test)]
mod tests;
