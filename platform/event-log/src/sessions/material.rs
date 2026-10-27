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
use maka_agent_facts::artifact::content_digest;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::event::ToolOutcome;
use maka_agent_facts::model::ModelEvent;
use maka_agent_facts::tool_call::RejectionKind;
use maka_agent_facts::tool_call::ToolRejection;
use serde_json::{Value, json};
use sqlx::Connection;

// Walk only reverse references of one retired Session, including archive writers.
// UNION deduplicates diamonds; active owners short-circuit the search.
// CROSS JOIN keeps each recursive owner ahead of its indexed prefix lookup.
const RETAINED: &str = "
WITH RECURSIVE owners(id) AS (
    VALUES(?1)
    UNION
    SELECT h.session_id FROM owners o
      CROSS JOIN context_source_prefixes p ON p.kind='session' AND p.owner=o.id
      JOIN session_history_members h ON h.sequence=p.sequence
    UNION
    SELECT h.session_id FROM owners o
      CROSS JOIN context_source_prefixes p ON p.kind='session' AND p.owner=o.id
      JOIN session_history_members h ON h.archive_sequence=p.sequence
    UNION
    SELECT h.session_id FROM owners o
      CROSS JOIN context_source_prefixes p ON p.kind='session' AND p.owner=o.id
      JOIN session_revision_sources h ON h.sequence=p.sequence
)
SELECT EXISTS(SELECT 1 FROM owners CROSS JOIN session_control ON session_control.id=owners.id)";

#[derive(Debug, PartialEq, Eq)]
pub enum MaterialCollection {
    Done,
    Retained(String),
    Collected,
}

impl EventLog {
    /// One Session and at most eight bodies per writer job. Advance the scan
    /// past Retained Sessions; retry the same cursor after Collected.
    /// Proof, payload retirement and body removal share the canonical writer.
    pub async fn collect_session_material(
        &self,
        after: Option<&str>,
    ) -> Result<MaterialCollection, StoreError> {
        self.validate_root()?;
        let after = after.map(str::to_owned);
        let prepared = self.prepared.clone();
        self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
            let session: Option<String> = sqlx::query_scalar(
                "SELECT DISTINCT e.event_session FROM event_log e INDEXED BY event_material_owner
                 WHERE e.event_json IS NOT NULL AND e.event_session IS NOT NULL
                 AND (?1 IS NULL OR e.event_session>?1) AND (
                   EXISTS(SELECT 1 FROM session_retirements r WHERE r.session_id=e.event_session
                     AND r.remove_session=1 AND r.completed=1)
                   OR (NOT EXISTS(SELECT 1 FROM session_control WHERE id=e.event_session)
                     AND EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id)))
                 ORDER BY e.event_session LIMIT 1"
            ).bind(after).fetch_optional(&mut *tx).await?;
            let Some(session) = session else {
                tx.rollback().await?;
                let free: i64 = sqlx::query_scalar("PRAGMA freelist_count").fetch_one(&mut *connection).await?;
                if free == 0 { return Ok(MaterialCollection::Done); }
                let incremental: i64 = sqlx::query_scalar("PRAGMA auto_vacuum").fetch_one(&mut *connection).await?;
                if incremental != 2 { return Err(StoreError::UnsupportedDatabase); }
                sqlx::query("PRAGMA incremental_vacuum(128)").execute(connection).await?;
                return Ok(MaterialCollection::Collected);
            };
            // A previously collected body proves this owner set was already
            // released. All owners were removed, so none can publish new copies.
            let released: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM context_source_prefixes p
                 JOIN event_log e ON e.sequence=p.sequence
                 WHERE p.kind='session' AND p.owner=? AND e.event_json IS NULL)"
            ).bind(&session).fetch_one(&mut *tx).await?;
            if !released && sqlx::query_scalar::<_, bool>(RETAINED)
                .bind(&session).fetch_one(&mut *tx).await?
            {
                return Ok(MaterialCollection::Retained(session));
            }
            // No live owner remains. Retained facts/membership, not UI metadata,
            // remain the material-collection authority; descendants were checked above.
            // Also covers imported owners that never had a local retirement.
            crate::context::prepared::gc::retire_owner(&mut tx,&session).await?;
            crate::context::semantic::gc::retire_owner(&mut tx,&session).await?;
            for table in ["transcript_directory", "transcript_failures", "transcript_cache.rows", "transcript_cache.text"] {
                let sql = format!("DELETE FROM {table} WHERE session_id=?");
                sqlx::query(sqlx::AssertSqlSafe(sql.as_str())).bind(&session).execute(&mut *tx).await?;
            }
            let rows: Vec<(i64, String, String)> = sqlx::query_as(
                "SELECT sequence,event_id,event_json FROM event_log WHERE event_session=?
                 AND event_json IS NOT NULL ORDER BY sequence LIMIT 8"
            ).bind(session).fetch_all(&mut *tx).await?;
            for (sequence,id,body) in rows {
                let event: RuntimeEvent = serde_json::from_str(&body)?;
                let proof = retained(&event);
                crate::context::semantic::gc::collect_event(&mut tx,crate::sequence_number(sequence)?).await?;
                sqlx::query("DELETE FROM tool_result_payloads WHERE event_id=?")
                    .bind(&id).execute(&mut *tx).await?;
                let surface: Option<String> = sqlx::query_scalar(
                    "DELETE FROM model_request_compositions WHERE event_id=? RETURNING digest"
                ).bind(&id).fetch_optional(&mut *tx).await?;
                if let Some(surface) = surface {
                    sqlx::query("DELETE FROM request_compositions WHERE digest=?1
                        AND NOT EXISTS (SELECT 1 FROM model_request_compositions WHERE digest=?1)")
                        .bind(surface).execute(&mut *tx).await?;
                }
                sqlx::query("UPDATE event_log SET retained_json=?, body_digest=?, event_json=NULL WHERE event_id=?")
                    .bind(serde_json::to_string(&proof)?).bind(content_digest(body.as_bytes()))
                    .bind(&id).execute(&mut *tx).await?;
            }
            tx.commit().await.map_err(StoreError::CommitUnknown)?;
            prepared.wake();
            Ok(MaterialCollection::Collected)
        })).await
    }
}

/// Minimal original fields used by accounting and terminal proof. This is not
/// a RuntimeEvent and must never enter replay, input projection or recovery.
fn retained(event: &RuntimeEvent) -> Value {
    let fact = match &event.fact {
        Fact::MessageImported { source, .. } => json!({"source":source}),
        Fact::InvocationOpened { configuration, .. } => json!({
            "configuration": configuration.as_ref().map(|config| json!({"model": config.model}))
        }),
        Fact::ModelRequested {
            step_id,
            model_id,
            purpose,
            ..
        } => json!({"step_id":step_id,"model_id":model_id,"purpose":purpose}),
        Fact::ModelCompleted { step_id, output } => {
            json!({"step_id":step_id,"output":{"usage":output.usage}})
        }
        Fact::ModelInterrupted {
            step_id,
            status,
            diagnostic,
            model_failure,
        } => {
            let mut material = json!({"step_id":step_id,"status":status});
            if let Some(diagnostic) = diagnostic {
                material["diagnostic"] = json!(diagnostic);
            }
            if let Some(cause) = model_failure {
                material["model_failure"] = json!(cause);
            }
            material
        }
        Fact::ModelObserved {
            step_id,
            event: ModelEvent::Finished { usage, .. },
        } => json!({"step_id":step_id,"event":{"kind":"finished","data":{"usage":usage}}}),
        Fact::ToolDispatched { call, name, .. } => json!({"call":call,"name":name}),
        Fact::ToolRejected {
            call, name, reason, ..
        } => {
            let kind = match reason {
                ToolRejection::Unavailable => RejectionKind::Unavailable,
                ToolRejection::InvalidInput { .. } => RejectionKind::InvalidInput,
                ToolRejection::PolicyDenied { .. } => RejectionKind::PolicyDenied,
                ToolRejection::PreparationFailed { .. } => RejectionKind::PreparationFailed,
                ToolRejection::ExclusiveConflict => RejectionKind::ExclusiveConflict,
                ToolRejection::Cancelled => RejectionKind::Cancelled,
            };
            json!({"call":call,"name":name,"reason":{"kind":kind}})
        }
        Fact::ToolSettled { outcome, .. } => json!({"outcome":{"kind":match outcome {
            ToolOutcome::Succeeded { .. } => "succeeded",
            ToolOutcome::Failed { .. } => "failed",
            ToolOutcome::Unknown { .. } => "unknown",
        }}}),
        Fact::InvocationEnded { outcome } => {
            let outcome = match outcome {
                InvocationOutcome::Completed => json!({"kind":"completed"}),
                InvocationOutcome::Failed {
                    class,
                    model_failure,
                    ..
                } => {
                    let mut material = json!({"kind":"failed","class":class});
                    if let Some(cause) = model_failure {
                        material["model_failure"] = json!(cause);
                    }
                    material
                }
                InvocationOutcome::Cancelled { source } => {
                    json!({"kind":"cancelled","source":source})
                }
                InvocationOutcome::HandoffPaused { pause } => {
                    json!({"kind":"handoff_paused","pause":{"intent":pause.intent}})
                }
                InvocationOutcome::ContextCompactFinished { outcome } => {
                    json!({"kind":"context_compact_finished","outcome":outcome})
                }
            };
            json!({"outcome":outcome})
        }
        Fact::ExecutorStarted { .. }
        | Fact::ExecutorObserved { .. }
        | Fact::ExecutorCompleted { .. }
        | Fact::MessageSteered { .. }
        | Fact::ContextCheckpointRecorded { .. }
        | Fact::ContextCompactionWaiting
        | Fact::ToolResultArchived { .. }
        | Fact::ModelObserved { .. }
        | Fact::ToolOperationObserved { .. }
        | Fact::ToolNotified { .. } => json!({}),
    };
    json!({"id":event.id,"invocation":event.invocation,"recorded_at":event.recorded_at,"fact":fact})
}

#[cfg(test)]
mod cursor_tests {
    use super::*;
    use maka_agent_facts::event::{EventWrite, Invocation, InvocationInput};

    #[tokio::test]
    async fn observation_cursor_and_pages_exclude_newer_retained_proof() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.create_session("source", "create", &json!({}), 1)
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: "source".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        let opened = RuntimeEvent::new(
            invocation.clone(),
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    source_messages: vec![],
                    content: "live original".into(),
                    request_fingerprint: None,
                },
            },
        );
        let ended = RuntimeEvent::new(
            invocation,
            Fact::InvocationEnded {
                outcome: InvocationOutcome::Completed,
            },
        );
        assert_eq!(
            log.append_batch(&[
                EventWrite::plain(opened).unwrap(),
                EventWrite::plain(ended.clone()).unwrap()
            ])
            .await
            .unwrap(),
            [1, 2]
        );
        // Exercise the query boundary independently of collection's traversal
        // order: the newest own fact has proof but no live body.
        let proof = serde_json::to_string(&retained(&ended)).unwrap();
        let digest = content_digest(serde_json::to_string(&ended).unwrap().as_bytes());
        log.connection.run(move |db| Box::pin(async move {
            sqlx::query("UPDATE event_log SET retained_json=?,body_digest=?,event_json=NULL WHERE sequence=2")
                .bind(proof).bind(digest).execute(db).await?;
            Ok(())
        })).await.unwrap();
        for _ in 0..2 {
            let versions = log
                .observation_versions(&["source".into(), "missing".into()])
                .await
                .unwrap();
            assert_eq!(versions.len(), 1);
            assert_eq!(versions["source"].event, 1);
            let page = log.session_events("source", 0, 2, 64, 65536).await.unwrap();
            assert_eq!(
                page.events.iter().map(|e| e.sequence).collect::<Vec<_>>(),
                [1]
            );
            assert_eq!(page.through_sequence, 2);
            assert!(page.next_after.is_none());
        }
        log.close().await.unwrap();
        let log = EventLog::open(&path).await.unwrap();
        assert_eq!(
            log.observation_versions(&["source".into()]).await.unwrap()["source"].event,
            1
        );
        assert_eq!(
            log.session_events("source", 1, 2, 64, 65536)
                .await
                .unwrap()
                .events
                .len(),
            0
        );
        assert!(matches!(
            log.prefix(100, 65536).await,
            Err(StoreError::MaterialCollected)
        ));
        assert!(matches!(
            log.scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: "source".into()
                },
                100,
                65536,
            )
            .await,
            Err(StoreError::MaterialCollected)
        ));
        let other = RuntimeEvent::new(
            Invocation {
                session_id: "other".into(),
                turn_id: "other-turn".into(),
                run_id: "other-run".into(),
                invocation_id: "other-invocation".into(),
            },
            Fact::InvocationOpened {
                configuration: None,
                input: InvocationInput::Message {
                    content: "independent".into(),
                    request_fingerprint: None,
                    source_messages: vec![],
                },
            },
        );
        log.append(&EventWrite::plain(other.clone()).unwrap())
            .await
            .unwrap();
        let prefix = log
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session { id: "other".into() },
                100,
                65536,
            )
            .await
            .unwrap();
        assert_eq!(prefix.events.len(), 1);
        assert_eq!(prefix.events[0].event, other);

        let collected_queries: Vec<_> = log
            .sqlite_resource_stats()
            .await
            .unwrap()
            .writer
            .statements
            .into_iter()
            .filter_map(|statement| statement.sql)
            .filter(|sql| {
                (sql.contains("context_source_prefixes p") && sql.contains("e.event_json IS NULL"))
                    || sql.contains("event_log INDEXED BY invocation_sequence")
            })
            .collect();
        assert_eq!(
            collected_queries.len(),
            2,
            "Global and Session use separate indexed predicates"
        );
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    for sql in collected_queries {
                        let session = sql.contains("p.owner=?");
                        let explain = format!("EXPLAIN QUERY PLAN {sql}");
                        let mut query = sqlx::query(sqlx::AssertSqlSafe(explain.as_str()));
                        if session {
                            query = query.bind("source");
                        }
                        let plan: Vec<String> = query
                            .fetch_all(&mut *db)
                            .await?
                            .into_iter()
                            .map(|row| sqlx::Row::get(&row, 3))
                            .collect();
                        if session {
                            assert!(
                                plan.iter().any(|step| step
                                    .contains("SEARCH p USING PRIMARY KEY (kind=? AND owner=?)")),
                                "{plan:?}"
                            );
                            assert!(
                                plan.iter().any(|step| step.contains("SEARCH e USING INTEGER PRIMARY KEY")),
                                "{plan:?}"
                            );
                        } else {
                            assert!(
                                plan.iter().any(|step| step.contains("USING INDEX invocation_sequence")),
                                "{plan:?}"
                            );
                        }
                    }
                    let explain = format!("EXPLAIN QUERY PLAN {RETAINED}");
                    let plan: Vec<String> = sqlx::query(sqlx::AssertSqlSafe(explain.as_str()))
                        .bind("source")
                        .fetch_all(db)
                        .await?
                        .into_iter()
                        .map(|row| sqlx::Row::get(&row, 3))
                        .collect();
                    for index in [
                        "history_source_owners",
                        "archive_source_owners",
                        "revision_source_owners",
                    ] {
                        assert!(
                            plan.iter().any(|step| step.contains(index)),
                            "{index}: {plan:?}"
                        );
                    }
                    assert!(
                        plan.iter()
                            .any(|step| step
                                .contains("SEARCH p USING PRIMARY KEY (kind=? AND owner=?)")),
                        "{plan:?}"
                    );
                    Ok(())
                })
            })
            .await
            .unwrap();
        log.close().await.unwrap();
    }
}
