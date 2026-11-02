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
use maka_agent_facts::history::RowPosition;
use maka_agent_ports::session::history::Prompt;

const QUERY: &str = "SELECT source_sequence,item_index FROM transcript_directory
    WHERE session_id=?1 AND (source_sequence,item_index)<=(?2,?3) AND role='user'
    ORDER BY source_sequence DESC,item_index DESC LIMIT 1";

impl EventLog {
    /// Inclusive reading anchor, fenced to committed directory metadata.
    /// The partial index skips answer/tool bodies regardless of session size.
    pub async fn history_prompt(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
    ) -> Result<Option<Prompt>, StoreError> {
        self.validate_root()?;
        crate::sessions::validate_id(session)?;
        super::read::sql_number(through)?;
        if position.source_sequence > through {
            return Err(StoreError::InvalidTransition(
                "prompt anchor exceeds history fence".into(),
            ));
        }
        let (source_sequence, item_index) = super::read::sql_position(position)?;
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| Box::pin(async move {
                    super::directory::ensure(tx, &session, through).await?;
                    let row: Option<(i64,i64)> = sqlx::query_as(QUERY)
                        .bind(&session).bind(source_sequence).bind(item_index)
                        .fetch_optional(&mut *tx).await?;
                    let Some((source,item)) = row else { return Ok(None) };
                    let position = super::read::row_position(source,item)?;
                    super::bodycache::ensure(tx,&session,position).await?;
                    let text: String = sqlx::query_scalar("SELECT COALESCE(navigation_preview(COALESCE(json_extract(payload,'$.displayText'),json_extract(payload,'$.text'),''),4096),'[attachments]') FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                        .bind(&session).bind(source).bind(item).fetch_one(&mut *tx).await?;

                    Ok(Some(Prompt { position,text }))
                }))
            })
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Connection, params};
    #[test]
    fn preceding_prompt_uses_index_and_does_not_read_other_sessions_or_later_prompts() {
        let db = Connection::open_in_memory().unwrap();
        super::super::navigation::register(&db).unwrap();
        db.execute_batch(
            "CREATE TABLE transcript_directory(session_id TEXT, source_sequence INTEGER, item_index INTEGER, role TEXT);",
        )
        .unwrap();
        db.execute_batch("CREATE INDEX directory_user ON transcript_directory (session_id, source_sequence, item_index) WHERE role = 'user';").unwrap();
        for (session, sequence, role) in [
            ("a", 1, "user"),
            ("a", 2, "assistant"),
            ("b", 3, "user"),
            ("a", 4, "user"),
        ] {
            db.execute(
                "INSERT INTO transcript_directory VALUES(?1,?2,0,?3)",
                params![session, sequence, role],
            )
            .unwrap();
        }
        let plan: String = db
            .prepare(&format!("EXPLAIN QUERY PLAN {QUERY}"))
            .unwrap()
            .query_map(params!["a", 3, 0], |row| row.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            plan.contains("SEARCH transcript_directory") && plan.contains("INDEX directory_user"),
            "{plan}"
        );
        for (anchor, expected) in [(3, 1), (4, 4)] {
            let actual: (i64, i64) = db
                .query_row(QUERY, params!["a", anchor, 0], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap();
            assert_eq!(actual, (expected, 0));
        }
        db.execute(
            "INSERT INTO transcript_directory VALUES('a',4,300,?1)",
            params!["user"],
        )
        .unwrap();
        for (index, expected_index) in [(299, 0), (300, 300)] {
            let actual: (i64, i64) = db
                .query_row(QUERY, params!["a", 4, index], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .unwrap();
            assert_eq!(actual, (4, expected_index));
        }
    }
}
