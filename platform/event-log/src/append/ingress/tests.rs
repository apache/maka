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

use super::*;
use crate::EventLog;
use maka_agent_facts::{
    event::{EventWrite, Fact, Invocation, InvocationOutcome},
    input::InvocationInput,
    model::ModelEvent,
};
use sqlx::Connection;

fn opening(id: &str) -> RuntimeEvent {
    let mut event = RuntimeEvent::new(
        Invocation {
            session_id: "session".into(),
            turn_id: id.into(),
            run_id: id.into(),
            invocation_id: id.into(),
        },
        Fact::InvocationOpened {
            configuration: None,
            input: InvocationInput::Message {
                source_messages: vec![],
                content: "question".into(),
                request_fingerprint: None,
            },
        },
    );
    event.id = id.into();
    event
}
fn closed(id: &str) -> Vec<EventWrite> {
    let opened = opening(id);
    let ended = RuntimeEvent::new(
        opened.invocation.clone(),
        Fact::InvocationEnded {
            outcome: InvocationOutcome::Completed,
        },
    );
    vec![
        EventWrite::plain(opened).unwrap(),
        EventWrite::plain(ended).unwrap(),
    ]
}
fn counts(path: &std::path::Path) -> Vec<i64> {
    let db = rusqlite::Connection::open(path).unwrap();
    [
        "event_log",
        "context_source_prefixes",
        "context_source_lineages",
        "context_semantic_heads",
        "context_semantic_frontiers",
        "context_semantic_rows",
        "context_semantic_fragments",
        "context_obligations",
        "context_safety_heads",
        "context_execution_steps",
        "context_execution_work",
        "context_independent_tools",
    ]
    .iter()
    .map(|table| {
        db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    })
    .collect()
}

#[tokio::test]
async fn autocommit_is_rejected_before_any_canonical_insert() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    let error = log
        .connection
        .run(|db| {
            Box::pin(async move {
                let event = opening("unowned");
                insert(
                    db,
                    &event,
                    serde_json::to_string(&event)?,
                    Position::Admitted,
                )
                .await
            })
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("requires an existing transaction")
    );
    log.close().await.unwrap();
    assert_eq!(counts(&path), vec![0; 12]);
}

#[tokio::test]
async fn projection_faults_roll_back_canonical_and_prior_batch_events_before_reopen() {
    for (name, trigger) in [
        (
            "source",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_source_prefixes WHEN NEW.kind='session' AND NEW.owner='session' AND NEW.sequence=3 BEGIN SELECT RAISE(ABORT,'source fault'); END;",
        ),
        (
            "obligation",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_obligations WHEN NEW.kind='invocation' AND NEW.opened_at=3 BEGIN SELECT RAISE(ABORT,'obligation fault'); END;",
        ),
        (
            "semantic",
            "CREATE TEMP TRIGGER ingress_fault BEFORE INSERT ON context_semantic_fragment_pieces WHEN NEW.source_sequence=3 BEGIN SELECT RAISE(ABORT,'semantic fault'); END;",
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.sqlite");
        let log = EventLog::open(&path).await.unwrap();
        log.connection
            .run(move |db| {
                Box::pin(async move {
                    sqlx::raw_sql(trigger).execute(db).await?;
                    Ok(())
                })
            })
            .await
            .unwrap();
        let mut events = closed("first");
        events.extend(closed("second"));
        assert!(log.append_batch(&events).await.is_err(), "{name}");
        log.close().await.unwrap();
        assert_eq!(counts(&path), vec![0; 12], "{name}");
        let reopened = EventLog::open(&path).await.unwrap();
        assert_eq!(reopened.append_batch(&events).await.unwrap(), [1, 2, 3, 4]);
        reopened.close().await.unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM context_source_prefixes", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            8
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM context_semantic_frontiers", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}

#[tokio::test]
async fn explicit_import_sequence_is_captured_before_projection_inserts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("events.sqlite");
    let log = EventLog::open(&path).await.unwrap();
    log.connection.run(|db| Box::pin(async move {
        let mut tx = db.begin().await?;
        let first = opening("imported");
        assert_eq!(insert(&mut tx, &first, serde_json::to_string(&first)?, Position::Imported(Some(41))).await?, 41);
        let end = RuntimeEvent::new(first.invocation.clone(), Fact::InvocationEnded { outcome: InvocationOutcome::Completed });
        assert_eq!(insert(&mut tx, &end, serde_json::to_string(&end)?, Position::Imported(Some(42))).await?, 42);
        let prefix: i64 = sqlx::query_scalar("SELECT MAX(sequence) FROM context_source_prefixes WHERE kind='invocation' AND owner='imported'").fetch_one(&mut *tx).await?;
        assert_eq!(prefix, 42, "each import event publishes its proof before the next event");
        let safety:i64=sqlx::query_scalar("SELECT through_sequence FROM context_safety_heads WHERE session_id='session'").fetch_one(&mut *tx).await?;
        assert_eq!(safety,42,"import projects safety at the captured canonical sequence");
        assert!(!sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM context_obligations WHERE invocation_id='imported')").fetch_one(&mut *tx).await?);
        tx.commit().await?;
        let mut earlier_invocation = opening("imported");
        earlier_invocation.id = "earlier-invocation".into();
        earlier_invocation.invocation.session_id = "other-session".into();
        earlier_invocation.fact = Fact::ModelObserved {
            step_id: "earlier-step".into(),
            event: ModelEvent::PartDelta {
                id: "part".into(),
                text: "a".into(),
                provider_options: None,
            },
        };
        for earlier in [opening("earlier-session"), earlier_invocation] {
            let mut tx = db.begin().await?;
            let error = insert(
                &mut tx,
                &earlier,
                serde_json::to_string(&earlier)?,
                Position::Imported(Some(40)),
            )
            .await
            .expect_err("imports cannot append behind either owner prefix");
            assert!(matches!(error, StoreError::Sqlite(rusqlite::Error::InvalidParameterName(ref reason))
                if reason == "source append is not monotonic"));
            tx.rollback().await?;
        }
        let sequences: Vec<i64> = sqlx::query_scalar("SELECT sequence FROM event_log ORDER BY sequence")
            .fetch_all(&mut *db).await?;
        assert_eq!(sequences, [41, 42], "rejected imports retain no canonical event");
        Ok(())
    })).await.unwrap();
    log.close().await.unwrap();
    let reopened = EventLog::open(&path).await.unwrap();
    reopened.close().await.unwrap();
}
