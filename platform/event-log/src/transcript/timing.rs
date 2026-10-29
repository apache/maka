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

use crate::StoreError;
use maka_agent_ports::session::history::TurnFinished;
use maka_agent_ports::session::history::TurnOutcome;
use maka_agent_ports::session::history::TurnTiming;
#[cfg(test)]
use sqlx::SqliteConnection;
use sqlx::sqlite::SqliteWorkerConnection;

// Two scalar index seeks, regardless of the size of a Turn's transcript. Start
// follows original sequence order, not the wall clock (which can move backward).
const SQL: &str = "WITH first AS (
    SELECT timestamp AS at FROM transcript_directory
    WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
      AND state_status = 'running'
    ORDER BY source_sequence, item_index LIMIT 1
), last AS (
    SELECT timestamp AS at,
        state_status AS status FROM transcript_directory
    WHERE session_id = ?1 AND turn_id = ?2 AND source_sequence <= ?3
      AND role = 'turn_state'
    ORDER BY source_sequence DESC, item_index DESC LIMIT 1
) SELECT first.at, last.at, last.status FROM first, last";

#[cfg(test)]
pub(super) async fn read(
    tx: &mut SqliteConnection,
    session: &str,
    turn: &str,
    through: i64,
) -> Result<Option<TurnTiming>, StoreError> {
    let session = session.to_owned();
    let turn = turn.to_owned();
    crate::connection::worker_query(tx, move |worker| {
        Box::pin(async move { read_on_worker(worker, &session, &turn, through).await })
    })
    .await
}

pub(super) async fn read_on_worker(
    tx: &mut SqliteWorkerConnection<'_>,
    session: &str,
    turn: &str,
    through: i64,
) -> Result<Option<TurnTiming>, StoreError> {
    let row: Option<(Option<i64>, Option<i64>, String)> = sqlx::query_as(SQL)
        .bind(session)
        .bind(turn)
        .bind(through)
        .fetch_optional(tx)
        .await?;
    let Some((Some(start), Some(last), status)) = row else {
        return Ok(None);
    };
    const MAX: i64 = (1 << 53) - 1;
    if !(0..=MAX).contains(&start) || !(start..=MAX).contains(&last) {
        return Ok(None);
    }
    let outcome = match status.as_str() {
        "running" => None,
        "completed" => Some(TurnOutcome::Completed),
        "failed" => Some(TurnOutcome::Failed),
        "aborted" => Some(TurnOutcome::Aborted),
        _ => return Ok(None),
    };
    Ok(Some(TurnTiming {
        started_at: start as u64,
        finished: outcome.map(|outcome| TurnFinished {
            at: last as u64,
            outcome,
        }),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Row};

    #[tokio::test]
    async fn turn_boundaries_are_scoped_fenced_and_do_not_restart_at_handoff_or_tail() {
        let mut db = SqliteConnection::connect(":memory:").await.unwrap();
        crate::transcript::bodycache::initialize(&mut db)
            .await
            .unwrap();
        for (session, turn, sequence, status, at) in [
            ("a", "t", 1, "running", 1000),
            ("a", "t", 2, "running", 2000),
            ("a", "t", 3, "completed", 69000),
            ("b", "t", 11, "running", 900),
            ("b", "t", 13, "failed", 99000),
            ("a", "other", 21, "running", 500),
            ("a", "other", 23, "aborted", 90000),
            ("a", "missing", 33, "completed", 5000),
            ("a", "backward", 41, "running", 5000),
            ("a", "backward", 42, "completed", 4999),
        ] {
            sqlx::query("INSERT INTO transcript_directory (session_id,turn_id,source_sequence,item_index,message_id,timestamp,role,has_thinking,state_status,context_eligible) VALUES (?,?,?,0,?,?,'turn_state',0,?,?6='failed')")
                .bind(session).bind(turn).bind(sequence).bind(format!("{turn}-{sequence}")).bind(at).bind(status)
                .execute(&mut db)
                .await
                .unwrap();
        }
        sqlx::query("WITH RECURSIVE tail(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM tail WHERE n<4096) INSERT INTO transcript_directory (session_id,turn_id,source_sequence,item_index,message_id,timestamp,role,has_thinking,context_eligible) SELECT 'a','t',100+n,0,'tail-'||n,100000+n,'tool_call',0,1 FROM tail")
            .execute(&mut db)
            .await
            .unwrap();
        let active = read(&mut db, "a", "t", 2).await.unwrap().unwrap();
        assert_eq!(active.started_at, 1000);
        assert_eq!(active.finished, None);
        let done = read(&mut db, "a", "t", 3).await.unwrap().unwrap();
        assert_eq!(done.started_at, 1000);
        assert_eq!(
            done.finished,
            Some(TurnFinished {
                at: 69000,
                outcome: TurnOutcome::Completed
            })
        );
        assert_eq!(read(&mut db, "a", "t", 2).await.unwrap(), Some(active));
        // Later rows in other sessions/Turns cannot change this completed Turn.
        assert_eq!(
            read(&mut db, "a", "t", 42).await.unwrap().as_ref(),
            Some(&done)
        );
        assert_eq!(read(&mut db, "a", "t", 4196).await.unwrap(), Some(done));
        for (session, turn, through, outcome) in [
            ("b", "t", 13, TurnOutcome::Failed),
            ("a", "other", 23, TurnOutcome::Aborted),
        ] {
            assert_eq!(
                read(&mut db, session, turn, through)
                    .await
                    .unwrap()
                    .unwrap()
                    .finished
                    .unwrap()
                    .outcome,
                outcome
            );
        }
        for (turn, through) in [("absent", 42), ("missing", 33), ("backward", 42)] {
            assert_eq!(read(&mut db, "a", turn, through).await.unwrap(), None);
        }
        let sql = format!("EXPLAIN QUERY PLAN {SQL}");
        let plan = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()))
            .bind("a")
            .bind("t")
            .bind(4196i64)
            .fetch_all(&mut db)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.get::<String, _>(3))
            .collect::<Vec<_>>()
            .join("\n");
        let state_seeks = plan
            .lines()
            .filter(|line| {
                line.starts_with("SEARCH transcript_directory ")
                    && line.contains(
                        "INDEX directory_state (session_id=? AND turn_id=? AND source_sequence<?)",
                    )
            })
            .count();
        assert_eq!(state_seeks, 2, "{plan}");
        assert!(!plan.contains("USE TEMP B-TREE"), "{plan}");
    }
}
