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

use crate::{StoreError, sequence_number};
use maka_presentation::{Content, Message, Row};
use rusqlite::Connection as RawConnection;

const COMPACTION: &str = r#"SELECT c.event_id, json_extract(c.event_json, '$.invocation.turn_id') AS turn_id,
           catalog_time(json_extract(c.event_json, '$.recorded_at')) AS adopted_at,
           CASE WHEN json_extract(opening.event_json, '$.fact.input.kind') = 'context_compact'
           THEN catalog_time(json_extract(opening.event_json, '$.recorded_at'))
           ELSE (SELECT catalog_time(json_extract(r.event_json, '$.recorded_at'))
            FROM event_log r INDEXED BY context_summary_round
            WHERE r.event_json IS NOT NULL AND r.invocation_id = c.invocation_id AND r.kind = 'model_requested'
              AND json_extract(r.event_json, '$.fact.purpose') = 'summary'
              AND r.sequence <= adopted.sequence
              AND json_extract(r.event_json, '$.fact.source_high_water') = json_extract(adopted.event_json, '$.fact.source_high_water')
              AND json_extract(r.event_json, '$.fact.source_digest') = json_extract(adopted.event_json, '$.fact.source_digest')
              AND NOT EXISTS (SELECT 1 FROM runtime_events boundary
                WHERE boundary.invocation_id = c.invocation_id AND boundary.sequence > r.sequence AND boundary.sequence < c.sequence
                  AND boundary.kind = 'context_checkpoint_recorded')
            ORDER BY r.sequence LIMIT 1) END AS started_at
         FROM runtime_events c JOIN runtime_events adopted
           ON adopted.invocation_id = c.invocation_id AND adopted.kind = 'model_requested'
           AND adopted.operation_id = json_extract(c.event_json, '$.fact.checkpoint.summary_step_id')
         LEFT JOIN runtime_events opening
           ON opening.invocation_id = c.invocation_id AND opening.kind = 'invocation_opened'
         WHERE c.sequence = ? AND c.kind = 'context_checkpoint_recorded'"#;

/// Project adoption metadata without hydrating the private summary body.
pub(super) fn project(db: &RawConnection, sequence: i64) -> Result<Row, StoreError> {
    use maka_agent_facts::history::RowPosition;
    let (id, turn, adopted, started): (String, String, i64, i64) =
        db.prepare_cached(COMPACTION)?
            .query_row([sequence], |row| {
                Ok((
                    row.get("event_id")?,
                    row.get("turn_id")?,
                    row.get("adopted_at")?,
                    row.get("started_at")?,
                ))
            })?;
    let ts = sequence_number(adopted)?;
    let started = sequence_number(started)?;
    Ok(Row {
        position: RowPosition {
            source_sequence: sequence_number(sequence)?,
            item_index: 0,
        },
        message: Message {
            id,
            turn_id: turn,
            ts,
            content: Content::ContextCompacted {
                duration_ms: ts.saturating_sub(started),
            },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::{ConnectOptions, Connection, SqliteConnection};
    use std::time::{Duration, UNIX_EPOCH};

    #[tokio::test]
    async fn concurrent_main_does_not_end_summary_timing_but_new_source_does() {
        for new_source in [false, true] {
            let mut db = SqliteConnection::connect(":memory:").await.unwrap();
            crate::sqlite_functions::register(&mut db).await.unwrap();
            sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
                kind != "trigger"
            })))
            .execute(&mut db)
            .await
            .unwrap();
            for (sequence, at, kind, step, fact) in [
                (
                    1,
                    1000,
                    "model_requested",
                    "summary",
                    json!({"purpose":"summary","source_high_water":1,"source_digest":"source"}),
                ),
                (
                    2,
                    1500,
                    "model_requested",
                    "main",
                    json!({"purpose":"main","source_high_water":2,"source_digest":"main"}),
                ),
                (
                    3,
                    3000,
                    "model_requested",
                    "retry",
                    json!({"purpose":"summary","source_high_water":if new_source {2} else {1},"source_digest":if new_source {"new-source"} else {"source"}}),
                ),
                (
                    4,
                    5500,
                    "context_checkpoint_recorded",
                    "",
                    json!({"checkpoint":{"summary_step_id":"retry"}}),
                ),
            ] {
                let value = json!({"invocation":{"turn_id":"turn"}, "recorded_at":UNIX_EPOCH + Duration::from_millis(at), "fact":fact});
                crate::canonical_insert::insert(crate::canonical_insert::Record {
                    sequence: Some(sequence),
                    event_id: &format!("event-{sequence}"),
                    invocation_id: Some("invocation"),
                    kind,
                    operation_id: Some(step),
                    json: &value.to_string(),
                })
                .execute(&mut db)
                .await
                .unwrap();
            }
            let row = db
                .run_on_worker(|handle| {
                    // SAFETY: callback-local non-owning wrapper, no handle-backed result.
                    let borrowed = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                    project(&borrowed, 4)
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(row.message.id, "event-4");
            assert_eq!(row.message.ts, 5500);
            assert_eq!(
                row.message.content,
                Content::ContextCompacted {
                    duration_ms: if new_source { 2500 } else { 4500 }
                }
            );
        }
    }

    async fn projection_work(old_rounds: i64) -> usize {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let mut db = sqlx::sqlite::SqliteConnectOptions::new()
            .in_memory(true)
            .query_planner_stability(true)
            .connect()
            .await
            .unwrap();
        crate::sqlite_functions::register(&mut db).await.unwrap();
        // The real ledger schema supplies competing indexes; reducers are not
        // needed when measuring projection of already admitted history.
        sqlx::raw_sql(sqlx::AssertSqlSafe(crate::schema::fixture(|kind, _| {
            kind != "trigger"
        })))
        .execute(&mut db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        crate::connection::worker_query(&mut tx, move |worker| Box::pin(async move {
        for round in 1..=old_rounds {
            for (sequence, id, kind, operation, fact) in [
                (round * 3 - 2, format!("summary-{round:08}"), "model_requested", Some(format!("summary-{round:08}")),
                    json!({"purpose":"summary","source_high_water":round*3-3,"source_digest":format!("source-{round:08}")})),
                (round * 3 - 1, format!("main-{round:08}"), "model_requested", Some(format!("main-{round:08}")), json!({"purpose":"main"})),
                (round * 3, format!("checkpoint-{round:08}"), "context_checkpoint_recorded", None,
                    json!({"checkpoint":{"summary_step_id":format!("summary-{round:08}")}})),
            ] {
                let json = json!({"invocation":{"session_id":"session"},"fact":fact}).to_string();
                crate::canonical_insert::insert(crate::canonical_insert::Record {
                    sequence: Some(sequence), event_id: &id, invocation_id: Some("invocation"),
                    kind, operation_id: operation.as_deref(), json: &json,
                }).execute(&mut *worker).await?;
            }
        }
        Ok(())
        })).await.unwrap();
        tx.commit().await.unwrap();
        let base = old_rounds * 3;
        crate::canonical_insert::insert(crate::canonical_insert::Record {
            sequence: Some(base + 1),
            event_id: "collected",
            invocation_id: Some("invocation"),
            kind: "model_requested",
            operation_id: Some("collected"),
            json: "{}",
        })
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query("UPDATE event_log SET event_json=NULL,retained_json='{}',body_digest='collected' WHERE sequence=?")
            .bind(base + 1).execute(&mut db).await.unwrap();
        for (offset, at, kind, step, fact) in [
            (
                2,
                500,
                "model_requested",
                "other-digest",
                json!({"purpose":"summary","source_high_water":base,"source_digest":"other","source_scope":{"kind":"session","id":"session"}}),
            ),
            (
                3,
                1000,
                "model_requested",
                "old-matching",
                json!({"purpose":"summary","source_high_water":base,"source_digest":"target","source_scope":{"kind":"root"}}),
            ),
            (
                4,
                1500,
                "context_checkpoint_recorded",
                "",
                json!({"checkpoint":{"summary_step_id":"old-matching"}}),
            ),
            (
                5,
                2000,
                "model_requested",
                "first-target",
                json!({"purpose":"summary","source_high_water":base,"source_digest":"target","source_scope":{"kind":"session","id":"session"}}),
            ),
            (
                6,
                2500,
                "model_requested",
                "concurrent-main",
                json!({"purpose":"main","source_high_water":base,"source_digest":"target"}),
            ),
            (
                7,
                3000,
                "model_requested",
                "retry-target",
                json!({"purpose":"summary","source_high_water":base,"source_digest":"target","source_scope":{"kind":"session","id":"session"}}),
            ),
            (
                8,
                5500,
                "context_checkpoint_recorded",
                "",
                json!({"checkpoint":{"summary_step_id":"retry-target"}}),
            ),
        ] {
            let value = json!({"invocation":{"session_id":"session","turn_id":"turn"},
                "recorded_at":UNIX_EPOCH + Duration::from_millis(at),"fact":fact});
            crate::canonical_insert::insert(crate::canonical_insert::Record {
                sequence: Some(base + offset),
                event_id: &format!("target-{offset}"),
                invocation_id: Some("invocation"),
                kind,
                operation_id: (!step.is_empty()).then_some(step),
                json: &value.to_string(),
            })
            .execute(&mut db)
            .await
            .unwrap();
        }
        let steps = Arc::new(AtomicUsize::new(0));
        let observed = steps.clone();
        db.lock_handle()
            .await
            .unwrap()
            .set_progress_handler(1, move || {
                observed.fetch_add(1, Ordering::Relaxed);
                true
            });
        let row = db
            .run_on_worker(move |handle| {
                // SAFETY: callback-local non-owning use; no SQLite-backed value escapes.
                let borrowed = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                project(&borrowed, base + 8)
            })
            .await
            .unwrap()
            .unwrap();
        db.lock_handle().await.unwrap().remove_progress_handler();
        assert_eq!(row.message.id, "target-8");
        assert_eq!(row.position.source_sequence, (base + 8) as u64);
        assert_eq!(row.message.ts, 5500);
        assert_eq!(
            row.message.content,
            Content::ContextCompacted { duration_ms: 3500 }
        );
        steps.load(Ordering::Relaxed)
    }

    #[tokio::test]
    async fn adopted_summary_timing_seeks_its_round_instead_of_older_history() {
        let small = projection_work(1000).await;
        let large = projection_work(20_000).await;
        eprintln!("compaction projection VM steps: rounds1000={small}, rounds20000={large}");
        assert!(
            small > 0 && large < small * 2,
            "twenty times more old rounds must not cause a summary-history sweep: {small} -> {large}"
        );
    }
}
